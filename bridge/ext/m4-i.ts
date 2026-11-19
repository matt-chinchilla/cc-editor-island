// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// Board item properties (properties addendum 3.3, engine run 15's m4-e):
// board.item.get widened with `full` (an item of the record kinds answers its
// BoardRecordSheet in place of `{ kind: "other" }`), board.item.set widened
// with the record form `{ uuids, kind, set }` (ONE undo step "Edit" over every
// item, through kicadBoardItemRecordsSet in a run folder under
// /tmp/cc-boarditems/), board.tuning.get and board.tuning.set (the tuning
// tool's live settings, no undo step), board.image.place (KiCad's own
// reference image tool with the reader's picture, on the pointer), the event
// ev.boardItem (KiCad asks the page before a board item's dialog,
// window.kicadHostBoardItem) and the held Ctrl+L of the tuning tool
// (pcbnew.LengthTuner.Settings). Every part is feature detected on the
// engine's exports: on an engine without them (run 14) no cap is listed, the
// new ops answer unsupported naming the first missing export, `full` is
// ignored and the record form answers unsupported.
import { fail, hasAll, isObj, ok, refused, type Answer, type ExtUnit, type ResponderCtx } from './contract';
import { MAX_GET_UUIDS } from '../boardItem';
import { UUID_RE } from '../symbol';
import { itemSetMisfit, type ItemRecord } from '../itemRecords';
import {
  BOARD_SET_KINDS, readBoardRecords, readBoardRecordSet, readsKind, readTuningSettings,
  type BoardRecordKind, type BoardRecordSheet, type TuningSettings,
} from './m4-i/records';

/** The board frame: every op and the event live there. */
export const BOARD_FRAME = 'pcb';
export const FRAME_REFUSAL = 'a board item op runs in a pcb frame';

/** The caps of the unit. */
export const BOARD_ITEM_KINDS_CAP = 'boardItemKinds';
export const BOARD_TUNING_CAP = 'boardTuning';
export const BOARD_IMAGE_PLACE_CAP = 'boardImagePlace';

/** The exports each cap needs (the run A board item read and the apply queue probe beside the records). */
export const RECORD_EXPORTS = ['kicadHostBoardItems', 'kicadBoardItemRecords', 'kicadBoardItemRecordsSet', 'kicadBoardItemGet', 'kicadCollabBusy'] as const;
/** The record form's gate: its own export named first when missing. */
export const RECORD_SET_EXPORTS = ['kicadBoardItemRecordsSet', 'kicadBoardItemRecords', 'kicadCollabBusy'] as const;
export const TUNING_EXPORTS = ['kicadBoardTuningGet', 'kicadBoardTuningSet', 'kicadCollabBusy'] as const;
export const IMAGE_EXPORTS = ['kicadBoardPlaceImage', 'kicadCollabBusy'] as const;

/** The held action: the tuning tool's settings key (KiCad's pcb_actions.cpp, default Ctrl+L). */
export const LENGTH_TUNER_SETTINGS = 'pcbnew.LengthTuner.Settings';

/** The run folders of the record sets and the tuning sets (the engine takes no other). */
export const BOARD_ITEMS_ROOT = '/tmp/cc-boarditems';
/** The staging folders of a picture (the engine takes no other). */
export const STAGE_ROOT = '/tmp/cc-stage';
/** The records' set takes 1 to this many uuids (the engine's bound). */
export const SET_UUIDS_MAX = 4096;
/** A picture of at most 4 MiB. */
export const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
/** A picture's file name, at most this many bytes of UTF-8. */
const FILE_NAME_MAX = 255;
/** The bound of a set's read back when the bridge's timing names none (about 5 s). */
const SET_MS = 5_000;
/** The engine's request is at most this long. */
const ASK_MAX = 1024;

/** What KiCad asks the page about before a board item's dialog (engine run 15, m4-e). */
export const BOARD_ITEM_ASK_KINDS = [
  'pad', 'shape', 'dimension', 'textbox', 'table', 'tablecell', 'barcode', 'image', 'zone', 'point', 'target', 'group', 'tuning', 'text',
] as const;
export type BoardItemAskKind = typeof BOARD_ITEM_ASK_KINDS[number];
/** The kinds a tool makes and asks about with `isNew` true. */
const NEW_KINDS: readonly BoardItemAskKind[] = ['text', 'textbox', 'table', 'barcode', 'image'];
/** ev.boardItem's payload. */
export interface BoardItemAsk { kind: BoardItemAskKind; uuid: string; isNew: boolean }
/** The window slot the engine calls (CcAskHostBoardItem). */
type AskWindow = { kicadHostBoardItem?: { onRequest?: (json: unknown) => boolean } };

const has = (o: Record<string, unknown>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => has(o, k));
};
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const utf8Bytes = (s: string): number => new TextEncoder().encode(s).byteLength;
const setMs = (ctx: ResponderCtx): number => ctx.timing.boardItemMs ?? SET_MS;
const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The engine's records of `uuids`, its answer as text ("" for a throw). */
function recordsText(mod: Record<string, unknown>, uuids: readonly string[]): string {
  try {
    const r = (mod.kicadBoardItemRecords as (json: string) => unknown)(JSON.stringify({ uuids }));
    return typeof r === 'string' ? r : '';
  } catch {
    return '';
  }
}

/** The engine up with the exports, in the board frame. */
const engineHas = (ctx: ResponderCtx, names: readonly string[]): boolean => ctx.frame === BOARD_FRAME && hasAll(ctx.mod(), names);

// ── ev.boardItem ───────────────────────────────────────────────────────────────────────

/**
 * The engine's request read closed: a JSON string of exactly `{ kind, uuid,
 * isNew }`; `uuid` a lower case uuid, or "" for the tuning tool's own settings
 * (kind `tuning`, not new) and for a picture about to be chosen (kind `image`,
 * new); `isNew` only for a kind a tool makes. Null for any other shape, which
 * leaves the request to KiCad's dialog.
 */
export function readBoardItemAsk(json: unknown): BoardItemAsk | null {
  if (typeof json !== 'string' || json.length > ASK_MAX) return null;
  let v: unknown;
  try { v = JSON.parse(json); } catch { return null; }
  if (!isObj(v) || !exactKeys(v, ['kind', 'uuid', 'isNew']) || typeof v.isNew !== 'boolean') return null;
  if (typeof v.kind !== 'string' || !(BOARD_ITEM_ASK_KINDS as readonly string[]).includes(v.kind)) return null;
  const kind = v.kind as BoardItemAskKind;
  if (v.isNew && !NEW_KINDS.includes(kind)) return null;
  const empty = (kind === 'tuning' && !v.isNew) || (kind === 'image' && v.isNew);
  if (typeof v.uuid !== 'string' || !(isUuid(v.uuid) || (empty && v.uuid === ''))) return null;
  if (kind === 'image' && v.isNew && v.uuid !== '') return null;
  return { kind, uuid: v.uuid, isNew: v.isNew };
}

/**
 * Takes the engine's slot: each request admitted (ev.ready went out listing
 * boardItemKinds, a board open) that reads closed is sent as ev.boardItem
 * once and answered true, so KiCad's dialog does not open; anything else, or a
 * throw, answers false and KiCad's dialog opens as before.
 */
export function installBoardItemAsk(ctx: ResponderCtx): (() => void) | void {
  if (ctx.frame !== BOARD_FRAME) return;
  const w = ctx.win() as unknown as AskWindow | null;
  if (w == null) return;
  const slot = {
    onRequest: (json: unknown): boolean => {
      try {
        if (ctx.closed() || !ctx.admit() || !ctx.caps().includes(BOARD_ITEM_KINDS_CAP)) return false;
        const a = readBoardItemAsk(json);
        if (a == null) return false;
        ctx.emitExt('ev.boardItem', { uuid: a.uuid, kind: a.kind, isNew: a.isNew });
        return true;
      } catch {
        return false;
      }
    },
  };
  w.kicadHostBoardItem = slot;
  return () => { if (w.kicadHostBoardItem === slot) delete w.kicadHostBoardItem; };
}

// ── board.item.get, full ───────────────────────────────────────────────────────────────

/**
 * The full form's args: exactly `{ uuids, full: true }`, `uuids` as the op
 * takes them (1 to 512 lower case, a repeat kept once); null for anything else.
 */
export function parseFullGetArgs(args: Record<string, unknown>): { uuids: string[] } | null {
  if (!exactKeys(args, ['uuids', 'full']) || args.full !== true || !Array.isArray(args.uuids)) return null;
  if (args.uuids.length < 1 || args.uuids.length > MAX_GET_UUIDS || !args.uuids.every(isUuid)) return null;
  return { uuids: [...new Set(args.uuids as string[])] };
}

/**
 * Today's items and the records merged in the order asked: a uuid with a
 * record answers its record; the others answer what today's read answered for
 * them (a field or a pad of a footprint answered as its footprint once), each
 * at its place, and anything left at the end.
 */
export function mergeInOrder(asked: readonly string[], records: readonly BoardRecordSheet[], today: ReadonlyArray<Record<string, unknown>>): Array<Record<string, unknown>> {
  const byUuid = new Map(records.map((r) => [r.uuid, r]));
  const askedSet = new Set(asked);
  const out: Array<Record<string, unknown>> = [];
  const sent = new Set<string>();
  const push = (it: Record<string, unknown>): void => {
    const u = String(it.uuid);
    if (sent.has(u)) return;
    sent.add(u);
    out.push(it);
  };
  let i = 0;
  for (const u of asked) {
    const rec = byUuid.get(u);
    if (rec != null) { push(rec as unknown as Record<string, unknown>); continue; }
    const next = today[i];
    if (next != null && (next.uuid === u || !askedSet.has(String(next.uuid)))) { push(next); i++; }
  }
  for (; i < today.length; i++) push(today[i]);
  return out;
}

/**
 * board.item.get widened: without `full` the op as it ships. With `full`
 * (only on an engine with the records, cap boardItemKinds; elsewhere `full`
 * is dropped and the op answers as it ships): the board gate, the records of
 * every uuid asked (an item of a kind this island does not read stays as
 * today's read gives it), then today's read of the rest.
 */
export async function boardItemGetFull(args: unknown, ctx: ResponderCtx, next: (args: unknown) => Promise<Answer>): Promise<Answer> {
  if (!isObj(args) || !has(args, 'full')) return next(args);
  const op = 'board.item.get';
  const a = parseFullGetArgs(args);
  if (a == null) return fail('bad_args', op);
  if (!engineHas(ctx, RECORD_EXPORTS)) return next({ uuids: a.uuids });
  const g = ctx.boardGate(op, RECORD_EXPORTS);
  if (refused(g)) return g;
  const read = readBoardRecords(recordsText(g.mod, a.uuids), a.uuids);
  if (read == null) return fail('island_error', 'the engine answered records of another shape');
  if (read.unread.length > 0) ctx.log(op, 'unread records', read.unread.join(' '));
  const recorded = new Set(read.sheets.map((s) => s.uuid));
  const rest = a.uuids.filter((u) => !recorded.has(u));
  let today: Array<Record<string, unknown>> = [];
  if (rest.length > 0) {
    const got = await next({ uuids: rest });
    if (!got.ok) return got;
    today = Array.isArray(got.result.items) ? (got.result.items as Array<Record<string, unknown>>) : [];
  }
  return ok({ items: mergeInOrder(a.uuids, read.sheets, today) });
}

// ── board.item.set, the record form ────────────────────────────────────────────────────

export interface RecordSetArgs { uuids: string[]; kind: BoardRecordKind; set: Record<string, unknown> }

/**
 * The record form's args: exactly `{ uuids, kind, set }`, 1 to 4,096 lower
 * case uuids none twice, `kind` a record kind but the table cell (M12's), and
 * `set` that kind's keys (readBoardRecordSet). Null for anything else; a kind
 * this island reads no record of is answered by its own refusal first.
 */
export function parseRecordSetArgs(args: Record<string, unknown>): RecordSetArgs | null {
  if (!exactKeys(args, ['uuids', 'kind', 'set']) || !Array.isArray(args.uuids)) return null;
  if (args.uuids.length < 1 || args.uuids.length > SET_UUIDS_MAX || !args.uuids.every(isUuid) || new Set(args.uuids).size !== args.uuids.length) return null;
  if (typeof args.kind !== 'string' || !BOARD_SET_KINDS.includes(args.kind as BoardRecordKind)) return null;
  const kind = args.kind as BoardRecordKind;
  const set = readBoardRecordSet(kind, args.set);
  return set == null ? null : { uuids: [...(args.uuids as string[])], kind, set };
}

/** `items.json` of a record set read closed for run `run`: `{ run, applied, depth }`; null while absent or of another shape. */
export function readItemsRecord(bytes: Uint8Array | null, run: number): { applied: boolean; depth: number } | null {
  if (bytes == null) return null;
  let v: unknown;
  try { v = JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; }
  if (!isObj(v) || !exactKeys(v, ['run', 'applied', 'depth']) || v.run !== run || typeof v.applied !== 'boolean') return null;
  if (!Number.isSafeInteger(v.depth) || (v.depth as number) < 0) return null;
  return { applied: v.applied, depth: v.depth as number };
}

/** The run number of a run folder (its last segment). */
const runOf = (dir: string): number => Number(dir.slice(dir.lastIndexOf('/') + 1));

/** Why the set does not fit the items read (a key one lacks, a pad's net the board does not hold), or null. */
export function recordSetMisfit(a: RecordSetArgs, sheets: readonly BoardRecordSheet[]): string | null {
  for (const s of sheets) if (s.item.kind !== a.kind) return `${s.uuid} is not a ${a.kind}`;
  if (has(a.set, 'net')) {
    const net = a.set.net as string;
    if (net !== '' && sheets.some((s) => !s.netChoices.includes(net))) return `the board has no net ${net}`;
  }
  if (a.kind === 'group' || a.kind === 'target' || a.kind === 'tuning') return null;
  const { net: _n, ...rest } = a.set;
  void _n;
  if (Object.keys(rest).length === 0) return null;
  return itemSetMisfit(rest, sheets.map((s) => s.item as ItemRecord));
}

/**
 * board.item.set widened: the record form `{ uuids, kind, set }` (any other
 * form is the op as it ships). The checks in order: the args (bad_args), a
 * kind this island reads no record of (unsupported), the board gate (the
 * frame, the exports: unsupported naming the first missing one, a board open,
 * busy), every item read (not_found names the first the board lacks), all of
 * `kind` and fitting the set (bad_args). Then one run of
 * kicadBoardItemRecordsSet in a fresh folder: the engine refusing the set
 * (KiCad's own rules) answers bad_args; once items.json says it applied, the
 * answer is the items read back (ONE undo step; an ev.edited follows); a run
 * whose commit was reverted answers bad_args, one never recorded not_applied.
 */
export async function boardItemSetRecords(args: unknown, ctx: ResponderCtx, next: (args: unknown) => Promise<Answer>): Promise<Answer> {
  if (!isObj(args) || !has(args, 'uuids') || !has(args, 'kind')) return next(args);
  const op = 'board.item.set';
  const a = parseRecordSetArgs(args);
  if (a == null) {
    const k = args.kind;
    if (typeof k === 'string' && BOARD_SET_KINDS.includes(k as BoardRecordKind) && !readsKind(k as BoardRecordKind)) {
      return fail('unsupported', `${op}: this island reads no ${k} record`);
    }
    return fail('bad_args', op);
  }
  const g = ctx.boardGate(op, RECORD_SET_EXPORTS);
  if (refused(g)) return g;
  const before = readBoardRecords(recordsText(g.mod, a.uuids), a.uuids);
  if (before == null) return fail('island_error', 'the engine answered records of another shape');
  if (before.unread.length > 0) return fail('island_error', `the engine answered a record this island cannot read: ${before.unread[0]}`);
  const held = new Map(before.sheets.map((s) => [s.uuid, s]));
  const missing = a.uuids.find((u) => !held.has(u));
  if (missing != null) return fail('not_found', missing);
  const sheets = a.uuids.map((u) => held.get(u) as BoardRecordSheet);
  const why = recordSetMisfit(a, sheets);
  if (why != null) return fail('bad_args', `${op}: ${why}`);
  const FS = ctx.fs();
  if (FS == null) return fail('island_error', 'the engine has no file system');
  let dir: string;
  try { dir = ctx.freshRunFolder(BOARD_ITEMS_ROOT); } catch (err) { return fail('island_error', describe(err)); }
  try {
    const run = runOf(dir);
    const t0 = Date.now();
    let queued: unknown = null;
    let thrown: string | null = null;
    const got = await ctx.queuedRun(op, dir, setMs(ctx),
      () => {
        try {
          queued = (g.mod.kicadBoardItemRecordsSet as (json: string) => unknown)(JSON.stringify({ run, dir, uuids: a.uuids, kind: a.kind, set: a.set }));
        } catch (err) {
          thrown = describe(err);
          queued = false;
        }
        return queued;
      },
      () => readItemsRecord(ctx.readBytes(`${dir}/items.json`), run));
    if (thrown != null) return fail('island_error', thrown);
    if (queued !== true) return fail('bad_args', op);
    if (!('done' in got)) return got;
    if (!got.done.applied) return fail('bad_args', op);
    const after = readBoardRecords(recordsText(g.mod, a.uuids), a.uuids);
    if (after == null || after.unread.length > 0 || after.sheets.length !== a.uuids.length) return fail('island_error', 'the engine answered records of another shape');
    const byUuid = new Map(after.sheets.map((s) => [s.uuid, s]));
    ctx.log(op, a.kind, a.uuids.length, Object.keys(a.set).join(' '), `${Date.now() - t0} ms`);
    return ok({ items: a.uuids.map((u) => byUuid.get(u)) });
  } finally {
    ctx.dropRunFolder(dir);
  }
}

// ── board.tuning.get, board.tuning.set ─────────────────────────────────────────────────

/** kicadBoardTuningGet's answer: the settings, 'none' when no tuning tool runs (""), null for another shape. */
export function readLiveTuning(text: unknown): TuningSettings | 'none' | null {
  if (text === '') return 'none';
  if (typeof text !== 'string') return null;
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  return readTuningSettings(v);
}

const liveTuning = (mod: Record<string, unknown>): TuningSettings | 'none' | null => {
  try { return readLiveTuning((mod.kicadBoardTuningGet as () => unknown)()); } catch { return null; }
};

/** board.tuning.get: no args; the tuning tool's live settings, no_tuning while no tuning tool runs. */
export function boardTuningGet(args: unknown, ctx: ResponderCtx): Answer {
  const op = 'board.tuning.get';
  if (!(args === undefined || (isObj(args) && Object.keys(args).length === 0))) return fail('bad_args', op);
  const g = ctx.boardGate(op, TUNING_EXPORTS);
  if (refused(g)) return g;
  const live = liveTuning(g.mod);
  if (live == null) return fail('island_error', 'the engine answered tuning settings of another shape');
  if (live === 'none') return fail('no_tuning', op);
  return ok({ settings: live });
}

/** `tuning.json` of a tuning set read closed for run `run`: `{ run, settings }`; null while absent or of another shape. */
export function readTuningRecord(bytes: Uint8Array | null, run: number): TuningSettings | null {
  if (bytes == null) return null;
  let v: unknown;
  try { v = JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; }
  if (!isObj(v) || !exactKeys(v, ['run', 'settings']) || v.run !== run) return null;
  return readTuningSettings(v.settings);
}

/**
 * board.tuning.set: exactly `{ set }` (readTuningSet's keys). The board gate,
 * then no_tuning while no tuning tool runs; the set is handed to the tool's
 * loop, which applies it as its dialog's OK (no undo step) and records the
 * settings it then holds: the answer. bad_args when the engine refuses it,
 * no_tuning when the tool ended before it applied, else not_applied.
 */
export async function boardTuningSet(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const op = 'board.tuning.set';
  if (!isObj(args) || !exactKeys(args, ['set'])) return fail('bad_args', op);
  const set = readBoardRecordSet('tuning', args.set);
  if (set == null) return fail('bad_args', op);
  const g = ctx.boardGate(op, TUNING_EXPORTS);
  if (refused(g)) return g;
  const live = liveTuning(g.mod);
  if (live == null) return fail('island_error', 'the engine answered tuning settings of another shape');
  if (live === 'none') return fail('no_tuning', op);
  if (ctx.fs() == null) return fail('island_error', 'the engine has no file system');
  let dir: string;
  try { dir = ctx.freshRunFolder(BOARD_ITEMS_ROOT); } catch (err) { return fail('island_error', describe(err)); }
  try {
    const run = runOf(dir);
    let queued: unknown = null;
    let thrown: string | null = null;
    const got = await ctx.queuedRun(op, dir, setMs(ctx),
      () => {
        try {
          queued = (g.mod.kicadBoardTuningSet as (json: string) => unknown)(JSON.stringify({ run, dir, set }));
        } catch (err) {
          thrown = describe(err);
          queued = false;
        }
        return queued;
      },
      () => readTuningRecord(ctx.readBytes(`${dir}/tuning.json`), run));
    if (thrown != null) return fail('island_error', thrown);
    if (queued !== true) return liveTuning(g.mod) === 'none' ? fail('no_tuning', op) : fail('bad_args', op);
    if (!('done' in got)) return liveTuning(g.mod) === 'none' ? fail('no_tuning', op) : got;
    return ok({ settings: got.done });
  } finally {
    ctx.dropRunFolder(dir);
  }
}

// ── board.image.place ──────────────────────────────────────────────────────────────────

/** A picture's kind by its first bytes: a PNG or a JPEG, else null. */
export function pictureKind(bytes: Uint8Array): 'png' | 'jpg' | null {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.byteLength >= png.length && png.every((b, i) => bytes[i] === b)) return 'png';
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  return null;
}

/** board.image.place's args: exactly `{ name, bytes }`, a file name (no folder, no control character) and a PNG or JPEG of at most 4 MiB by its content; null for anything else. */
export function parseImagePlaceArgs(args: unknown): { name: string; bytes: Uint8Array; ext: 'png' | 'jpg' } | null {
  if (!isObj(args) || !exactKeys(args, ['name', 'bytes'])) return null;
  const { name, bytes } = args;
  if (typeof name !== 'string' || name === '' || /[/\\]/.test(name) || CONTROL_RE.test(name) || utf8Bytes(name) > FILE_NAME_MAX) return null;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > IMAGE_MAX_BYTES) return null;
  const ext = pictureKind(bytes);
  return ext == null ? null : { name, bytes, ext };
}

/**
 * board.image.place: the args (bad_args), the board gate (no other tool may
 * run), the
 * picture staged under a fresh /tmp/cc-stage/<n>/, then KiCad's own reference
 * image tool runs with it (bad_args when KiCad refuses: another tool on its
 * stack, or a file it reads as no picture): the answer `{}` once the picture
 * hangs on the pointer; the reader's press places it ("Place Image", one undo step). The
 * staged file is removed after the answer (KiCad read it already).
 */
export async function boardImagePlace(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const op = 'board.image.place';
  const a = parseImagePlaceArgs(args);
  if (a == null) return fail('bad_args', op);
  const g = ctx.boardGate(op, IMAGE_EXPORTS);
  if (refused(g)) return g;
  const FS = ctx.fs();
  if (FS == null) return fail('island_error', 'the engine has no file system');
  let stage: string;
  try { stage = ctx.freshRunFolder(STAGE_ROOT); } catch (err) { return fail('island_error', describe(err)); }
  try {
    const path = `${stage}/picture.${a.ext}`;
    try { FS.writeFile(path, a.bytes); } catch (err) { return fail('island_error', describe(err)); }
    let placed: unknown;
    try { placed = (g.mod.kicadBoardPlaceImage as (json: string) => unknown)(JSON.stringify({ path })); } catch (err) { return fail('island_error', describe(err)); }
    if (placed !== true) return fail('bad_args', `${op}: KiCad placed no picture (another tool runs, or the file reads as no picture)`);
    if (!(await ctx.applyIdle(setMs(ctx)))) return fail('not_applied', op);
    ctx.log(op, a.ext, a.bytes.byteLength);
    return ok({});
  } finally {
    ctx.dropRunFolder(stage);
  }
}

// ── the unit ───────────────────────────────────────────────────────────────────────────

export default {
  unit: 'm4-i',
  frames: [BOARD_FRAME],
  frameRefusal: FRAME_REFUSAL,
  capNames: [BOARD_ITEM_KINDS_CAP, BOARD_TUNING_CAP, BOARD_IMAGE_PLACE_CAP],
  caps: (mod, frame) => {
    if (frame !== BOARD_FRAME) return [];
    const out: string[] = [];
    if (hasAll(mod, RECORD_EXPORTS)) out.push(BOARD_ITEM_KINDS_CAP);
    if (hasAll(mod, TUNING_EXPORTS)) out.push(BOARD_TUNING_CAP);
    if (hasAll(mod, IMAGE_EXPORTS)) out.push(BOARD_IMAGE_PLACE_CAP);
    return out;
  },
  held: [LENGTH_TUNER_SETTINGS],
  heldRows: [{ action: LENGTH_TUNER_SETTINGS, frames: [BOARD_FRAME], cap: BOARD_ITEM_KINDS_CAP }],
  events: { 'ev.boardItem': ['uuid', 'kind', 'isNew'] },
  ops: {
    'board.tuning.get': { run: boardTuningGet, passesCheck: true },
    'board.tuning.set': { run: boardTuningSet },
    'board.image.place': { run: boardImagePlace },
  },
  opsWidened: {
    'board.item.get': boardItemGetFull,
    'board.item.set': boardItemSetRecords,
  },
  install: installBoardItemAsk,
} satisfies ExtUnit;
