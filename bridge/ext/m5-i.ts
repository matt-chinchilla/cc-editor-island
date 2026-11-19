// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// m5-i (PROTOCOL.md sch.item.get, sch.item.set, sch.image.place and
// ev.schItem): every schematic item that is not a symbol, read and changed
// with no KiCad window, through engine run 15's exports (pcbjam cc_e8_sch.inc,
// unit m5-e). sch.item.get reads records closed per kind (./m5-i/records.ts);
// sch.item.set checks a partial of one kind's keys against the items read
// first, then queues ONE commit "Edit" (a label kind change by KiCad's own
// change label kind, a sheet file change by KiCad's sheet file steps with the
// page's answer) under a fresh /tmp/cc-schitems/<n>/ and answers the items
// read back once its record is there; sch.image.place hands a picture to
// KiCad's own image tool, where it hangs on the pointer. ev.schItem is KiCad's
// schematic editor asking the page before an item's window
// (window.kicadHostSchItem, the marker kicadHostSchItems). Feature detected:
// on an engine without the exports neither cap is listed, each op answers
// unsupported naming the first missing export, and KiCad's windows open as
// before.
import { fail, hasAll, isObj, ok, refused, type Answer, type ExtUnit, type ResponderCtx } from './contract';
import { SHEET_PATH_RE, UUID_RE } from '../symbol';
import {
  PNG_SET_MAX, READ_ONLY_KINDS, SHEET_FILE_ERRORS, base64Bytes, parseSchItemGetArgs, parseSchItemSetArgs, readSchItems, readSchItemsDone,
  schItemSetMisfit, type AskedItem, type SchItemRecord, type SchItemsDone,
} from './m5-i/records';

/** What sch.item.get and sch.item.set need of the engine (the apply queue probe last) and the marker the asks need. */
export const SCH_ITEM_EXPORTS = ['kicadSchItemGet', 'kicadSchItemSet', 'kicadHostSchItems', 'kicadCollabBusy'] as const;
/** What sch.image.place needs: the engine's call and the selection read that shows the picture on the pointer. */
export const SCH_IMAGE_EXPORTS = ['kicadSchPlaceImage', 'kicadCollabGetSelection'] as const;
export const SCH_ITEM_CAP = 'schItem';
export const SCH_IMAGE_CAP = 'schImagePlace';
export const SCH_ITEM_EVENT = 'ev.schItem';
export const SCH_ITEM_EVENT_KEYS = ['uuid', 'sheetPath', 'kind', 'isNew'] as const;
/** The engine's run folders: the set's records and the pictures it reads. */
export const ITEMS_ROOT = '/tmp/cc-schitems';
export const IMAGE_ROOT = '/tmp/cc-schimage';
const RECORD = 'items.json';
/** A picture placed is at most this large. */
export const IMAGE_MAX = 4 * 1024 * 1024;
/** A picture's file name is 1 to this many characters. */
export const IMAGE_NAME_MAX = 255;
/** The answer a set of an existing file with no fileMode gets (spec 4.3). */
export const FILE_MODE_REQUIRED = 'fileMode is required: the file exists';
const FRAME_REFUSAL = 'a schematic edits in a sch frame';
/** The wait for a set's record and for a picture to reach the pointer, when the bridge's timing names none. */
const SET_MS = 5_000;
const PLACE_MS = 10_000;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

// ── ev.schItem ─────────────────────────────────────────────────────────────────────────

/** The kinds KiCad's schematic editor asks about (CcSchItemKind): a symbol, a table, a field, a pin, a no connect and a marker never ask. */
export const SCH_ASK_KINDS = ['label', 'wire', 'line', 'busEntry', 'junction', 'text', 'textbox', 'shape', 'ruleArea', 'image', 'sheet', 'sheetPin', 'group'] as const;
export type SchAskKind = typeof SCH_ASK_KINDS[number];
/** The kinds a drawing tool asks about as it makes them (isNew), each with its new uuid; a new picture asks with the nil uuid. */
export const SCH_NEW_ASK_KINDS: readonly SchAskKind[] = ['label', 'text', 'textbox', 'sheet', 'sheetPin'];
/** ev.schItem's payload. */
export interface SchItemAsk { uuid: string; sheetPath: string; kind: SchAskKind; isNew: boolean }
/** The window slot the schematic editor calls (CcAskHostSchItem). */
export type SchItemAskWindow = { kicadHostSchItem?: { onRequest?: (json: unknown) => boolean } };
const MAX_REQUEST = 8192;

/**
 * The editor's request read closed: a JSON string of exactly `{ kind, uuid,
 * sheetPath, isNew }`, `sheetPath` KiCad's path of the sheet shown. An item
 * asks with its lower case uuid; a new label, text, text box, sheet or sheet
 * pin with its new uuid and isNew true; a new picture with the nil uuid and
 * isNew true. Null for any other shape, which leaves it to KiCad's window.
 */
export function readSchItemAsk(json: unknown): SchItemAsk | null {
  if (typeof json !== 'string' || json.length > MAX_REQUEST) return null;
  let v: unknown;
  try { v = JSON.parse(json); } catch { return null; }
  if (!isObj(v) || Object.keys(v).length !== 4) return null;
  const { kind, uuid, sheetPath, isNew } = v;
  if (typeof kind !== 'string' || !(SCH_ASK_KINDS as readonly string[]).includes(kind) || typeof isNew !== 'boolean') return null;
  if (typeof uuid !== 'string' || !UUID_RE.test(uuid) || typeof sheetPath !== 'string' || !SHEET_PATH_RE.test(sheetPath)) return null;
  const k = kind as SchAskKind;
  const nil = uuid === NIL_UUID;
  const fits = isNew ? (k === 'image' ? nil : !nil && SCH_NEW_ASK_KINDS.includes(k)) : !nil;
  return fits ? { uuid, sheetPath, kind: k, isNew } : null;
}

/**
 * Takes the editor's slot: each request the gate admits (after ev.ready, a
 * schematic open) that reads closed is handed to `send` once and answered
 * true, so KiCad opens no window (a new item goes down as the window's OK
 * would place it, a new picture's tool ends); anything else, or a throwing
 * `send`, answers false and KiCad's window opens as before. The stop clears
 * the slot when it is still this one.
 */
export function installSchItemAsk(w: SchItemAskWindow, opts: { admit: () => boolean; send: (a: SchItemAsk) => void }): () => void {
  const slot = {
    onRequest: (json: unknown): boolean => {
      try {
        if (!opts.admit()) return false;
        const a = readSchItemAsk(json);
        if (a == null) return false;
        opts.send(a);
        return true;
      } catch {
        return false;
      }
    },
  };
  w.kicadHostSchItem = slot;
  return () => { if (w.kicadHostSchItem === slot) delete w.kicadHostSchItem; };
}

// ── the engine's reads ─────────────────────────────────────────────────────────────────

const callText = (mod: Record<string, unknown>, name: string, arg: string): string => {
  const r = (mod[name] as (a: string) => unknown)(arg);
  return typeof r === 'string' ? r : '';
};

/** The records of `items` as the engine reads them now, null for an answer of another shape (or "", an open in flight). */
function getItems(mod: Record<string, unknown>, items: readonly AskedItem[]): SchItemRecord[] | null {
  return readSchItems(callText(mod, 'kicadSchItemGet', JSON.stringify({ items })), items.length);
}

/** The record answering `a`: its uuid, on its sheet path when one was asked. */
const answering = (records: readonly SchItemRecord[], a: AskedItem): SchItemRecord | undefined =>
  records.find((r) => r.uuid === a.uuid && (a.sheetPath === '' || r.sheetPath === a.sheetPath));

const dirOf = (abs: string): string => abs.slice(0, Math.max(0, abs.lastIndexOf('/')));
/** `rel` joined to `dir`, its "." and empty steps dropped ("..": refused by the args). */
function joinPath(dir: string, rel: string): string {
  const parts: string[] = [];
  for (const p of `${dir}/${rel}`.split('/')) if (p !== '' && p !== '.') parts.push(p);
  return `/${parts.join('/')}`;
}

/**
 * The folder of the file the sheet at `path` shows (KiCad resolves a sheet
 * file name against it): the root's is the opened schematic's folder; any
 * other is found from the sheet that holds it, one level at a time. Null when
 * a level does not read.
 */
function screenDir(ctx: ResponderCtx, mod: Record<string, unknown>, path: string, depth = 0): string | null {
  if (path === '/') {
    const opened = ctx.opened();
    return opened == null ? null : dirOf(opened);
  }
  const steps = path.split('/').filter((s) => s !== '');
  if (steps.length === 0 || depth > 64) return null;
  const sheet = steps.pop() as string;
  const parent = `/${steps.map((s) => `${s}/`).join('')}`;
  const r = getItems(mod, [{ uuid: sheet, sheetPath: parent }])?.[0];
  if (r == null || r.kind !== 'sheet') return null;
  const dir = screenDir(ctx, mod, parent, depth + 1);
  return dir == null ? null : dirOf(joinPath(dir, r.file));
}

// ── the ops ────────────────────────────────────────────────────────────────────────────

/** sch.item.get: the records of the items asked, in the order asked, an item the schematic does not hold left out. A read. */
export function schItemGet(args: unknown, ctx: ResponderCtx): Answer {
  const op = 'sch.item.get';
  const a = parseSchItemGetArgs(args);
  if (a == null) return fail('bad_args', op);
  const g = ctx.schematicGate(op, SCH_ITEM_EXPORTS);
  if (refused(g)) return g;
  let text: string;
  try { text = callText(g.mod, 'kicadSchItemGet', JSON.stringify({ items: a.items })); } catch (err) { return fail('island_error', err instanceof Error ? err.message : String(err)); }
  if (text === '') return fail('busy', op);
  const items = readSchItems(text, a.items.length);
  return items == null ? fail('island_error', 'the engine answered items of another shape') : ok({ items });
}

/**
 * sch.item.set: the args read closed, the gate, then the items read first
 * (not_found naming the first the schematic does not hold), all of the kind
 * named (bad_args), the set fitting each (bad_args naming why), a picture past
 * 4 MiB too_large, a sheet file that exists asked without fileMode bad_args.
 * Then ONE commit queued in a fresh run folder; its record read, the folder
 * removed whatever the answer; a sheet file step KiCad refuses answers
 * sheet_file with KiCad's word, nothing changed. The answer is the items read
 * back (a label KiCad converted under its new uuid), `renamed` and `replaced`.
 * An ev.edited follows when the undo depth moved.
 */
export async function schItemSet(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const op = 'sch.item.set';
  const a = parseSchItemSetArgs(args);
  if (a == null) {
    if (isObj(args) && typeof args.kind === 'string' && (READ_ONLY_KINDS as readonly string[]).includes(args.kind)) return fail('bad_args', `${op}: a ${args.kind} is read only here`);
    return fail('bad_args', op);
  }
  const g = ctx.schematicGate(op, SCH_ITEM_EXPORTS);
  if (refused(g)) return g;
  const { mod } = g;
  let before: SchItemRecord[] | null;
  try { before = getItems(mod, a.items); } catch (err) { return fail('island_error', err instanceof Error ? err.message : String(err)); }
  if (before == null) return fail('island_error', 'the engine answered items of another shape');
  const held: SchItemRecord[] = [];
  for (const it of a.items) {
    const r = answering(before, it);
    if (r == null) return fail('not_found', it.uuid);
    held.push(r);
  }
  const why = schItemSetMisfit(a.kind, a.set, held);
  if (why != null) return fail('bad_args', `${op}: ${why}`);
  if (typeof a.set.png === 'string' && (base64Bytes(a.set.png) ?? 0) > PNG_SET_MAX) return fail('too_large', op);
  if (typeof a.set.file === 'string' && a.fileMode == null) {
    const sheet = held[0];
    if (sheet.kind === 'sheet' && sheet.file !== a.set.file) {
      const dir = screenDir(ctx, mod, sheet.sheetPath);
      if (dir == null) return fail('island_error', 'the sheet\'s folder does not read');
      if (ctx.readBytes(joinPath(dir, a.set.file)) != null) return fail('bad_args', FILE_MODE_REQUIRED);
    }
  }
  let dir: string;
  try { dir = ctx.freshRunFolder(ITEMS_ROOT); } catch (err) { return fail('island_error', err instanceof Error ? err.message : String(err)); }
  try {
    const run = Number(dir.slice(dir.lastIndexOf('/') + 1));
    const items = held.map((r) => ({ uuid: r.uuid, sheetPath: r.sheetPath }));
    const body: Record<string, unknown> = { run, dir, items, kind: a.kind, set: a.set };
    if (a.fileMode != null) body.fileMode = a.fileMode;
    const t0 = Date.now();
    let said: unknown = null;
    let thrown: string | null = null;
    const got = await ctx.queuedRun<SchItemsDone | 'bad'>(op, dir, ctx.timing.schItemsMs ?? SET_MS,
      () => {
        try { said = (mod.kicadSchItemSet as (json: string) => unknown)(JSON.stringify(body)); } catch (err) { thrown = err instanceof Error ? err.message : String(err); said = false; }
        return said;
      },
      () => readSchItemsDone(ctx.readBytes(`${dir}/${RECORD}`)));
    if (thrown != null) return fail('island_error', thrown);
    if (said !== true) {
      // Past every check here, KiCad refuses only a label kind or a sheet file off the sheet shown.
      return fail('bad_args', 'labelKind' in a.set || 'file' in a.set ? `${op}: a label kind or a sheet file changes only on the sheet shown` : op);
    }
    if (!('done' in got)) return got;
    if (got.done === 'bad') return fail('island_error', 'the engine answered a record of another shape');
    const done = got.done;
    if (done.error != null) {
      if ((SHEET_FILE_ERRORS as readonly string[]).includes(done.error)) return fail('sheet_file', done.error);
      return fail(done.error === 'not_found' ? 'not_found' : 'island_error', `${op}: ${done.error}`);
    }
    if (done.applied !== items.length) return fail('not_applied', `${op}: KiCad applied ${done.applied} of ${items.length}`);
    const swap = new Map(done.replaced.map((p) => [p.from, p.to]));
    const now = items.map((it) => ({ uuid: swap.get(it.uuid) ?? it.uuid, sheetPath: it.sheetPath }));
    const after = getItems(mod, now);
    if (after == null) return fail('island_error', 'the engine answered items of another shape');
    const read = now.map((it) => answering(after, it));
    if (read.some((r) => r == null)) return fail('not_applied', op);
    ctx.log(op, a.kind, Object.keys(a.set).join(' '), `${items.length} items`, `${Date.now() - t0} ms`);
    return ok({ items: read as SchItemRecord[], renamed: done.renamed, replaced: done.replaced });
  } finally {
    ctx.dropRunFolder(dir);
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** A PNG or a JPEG, by its first bytes. */
export function isPictureBytes(b: Uint8Array): boolean {
  if (b.byteLength >= 8 && PNG_SIGNATURE.every((x, i) => b[i] === x)) return true;
  return b.byteLength >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}
// eslint-disable-next-line no-control-regex
const NAME_BAD_RE = /[\u0000-\u001f\u007f/\\]/;

/**
 * sch.image.place's args: exactly `{ name, bytes }`, `name` the picture's file
 * name (1 to 255 characters, no slash, backslash or control character, never
 * "." or ".."), `bytes` a Uint8Array holding a PNG or a JPEG (any length here:
 * past 4 MiB the op answers too_large). Null for anything else.
 */
export function parseSchImagePlaceArgs(args: unknown): { name: string; bytes: Uint8Array } | null {
  if (!isObj(args) || Object.keys(args).length !== 2 || !(args.bytes instanceof Uint8Array) || typeof args.name !== 'string') return null;
  const { name, bytes } = args;
  const n = [...name].length;
  if (n < 1 || n > IMAGE_NAME_MAX || NAME_BAD_RE.test(name) || name === '.' || name === '..' || !isPictureBytes(bytes)) return null;
  return { name, bytes };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** The selection's uuids, null when it does not read. */
function selectionOf(mod: Record<string, unknown>): string[] | null {
  try {
    const v: unknown = JSON.parse(String((mod.kicadCollabGetSelection as () => unknown)()));
    return Array.isArray(v) && v.every((u) => typeof u === 'string') ? (v as string[]) : null;
  } catch { return null; }
}

/**
 * sch.image.place: the picture written into a fresh /tmp/cc-schimage/<n>/,
 * handed to KiCad's own image tool, and answered `{}` once it hangs on the
 * pointer (the selection holds a uuid it did not hold); the reader's click
 * places it as KiCad's one undo step, Esc drops it, and the responder watches
 * it meanwhile as it watches a place (every gate answers busy). not_applied
 * when KiCad cannot read the picture, busy when its tool never takes it.
 */
export async function schImagePlace(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const op = 'sch.image.place';
  const a = parseSchImagePlaceArgs(args);
  if (a == null) return fail('bad_args', op);
  const g = ctx.schematicGate(op, SCH_IMAGE_EXPORTS);
  if (refused(g)) return g;
  if (a.bytes.byteLength > IMAGE_MAX) return fail('too_large', op);
  const FS = ctx.fs();
  if (FS == null) return fail('not_ready', op);
  const { mod } = g;
  let dir: string;
  try { dir = ctx.freshRunFolder(IMAGE_ROOT); } catch (err) { return fail('island_error', err instanceof Error ? err.message : String(err)); }
  try {
    const path = `${dir}/${a.name}`;
    FS.writeFile(path, a.bytes);
    const before = selectionOf(mod);
    if (before == null) return fail('island_error', 'the selection does not read');
    let said: unknown;
    try { said = (mod.kicadSchPlaceImage as (json: string) => unknown)(JSON.stringify({ path })); } catch (err) { return fail('island_error', err instanceof Error ? err.message : String(err)); }
    if (said !== true) return fail('not_applied', `${op}: KiCad cannot read the picture`);
    const end = Date.now() + (ctx.timing.placeMs ?? PLACE_MS);
    for (;;) {
      if (ctx.closed()) return fail('island_error', 'the frame closed');
      const fresh = (selectionOf(mod) ?? []).find((u) => !before.includes(u));
      if (fresh != null) {
        ctx.placeStart(fresh);
        ctx.log(op, a.bytes.byteLength);
        return ok();
      }
      if (Date.now() >= end) return fail('busy', `${op}: the editor did not take the picture`);
      await sleep(ctx.timing.placePollMs ?? 25);
    }
  } finally {
    ctx.dropRunFolder(dir);
  }
}

export default {
  unit: 'm5-i',
  frames: ['sch'],
  frameRefusal: FRAME_REFUSAL,
  capNames: [SCH_ITEM_CAP, SCH_IMAGE_CAP],
  caps: (mod, frame) => {
    if (frame !== 'sch') return [];
    const caps: string[] = [];
    if (hasAll(mod, SCH_ITEM_EXPORTS)) caps.push(SCH_ITEM_CAP);
    if (hasAll(mod, SCH_IMAGE_EXPORTS)) caps.push(SCH_IMAGE_CAP);
    return caps;
  },
  events: { [SCH_ITEM_EVENT]: SCH_ITEM_EVENT_KEYS },
  ops: {
    'sch.item.get': { passesCheck: true, run: schItemGet },
    'sch.item.set': { run: schItemSet },
    'sch.image.place': { run: schImagePlace },
  },
  // KiCad's schematic editor asks the page before an item's window (ev.schItem),
  // once per request, after ev.ready while a schematic is open; it opens no window.
  install(ctx) {
    const w = ctx.win();
    if (ctx.frame !== 'sch' || w == null || !ctx.has(SCH_ITEM_EXPORTS)) return undefined;
    return installSchItemAsk(w as unknown as SchItemAskWindow, {
      admit: () => ctx.admit(),
      send: (q) => ctx.emitExt(SCH_ITEM_EVENT, { uuid: q.uuid, sheetPath: q.sheetPath, kind: q.kind, isNew: q.isNew }),
    });
  },
} satisfies ExtUnit;
