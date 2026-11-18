// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The drawing sheet editor's frame ops (PROTOCOL.md "The drawing sheet editor:
// a ds frame and the dsedit ops"): KiCad's own PL_EDITOR_FRAME booted with
// ?frame=ds, canvas only, driven through our engine's dsedit exports (pcbjam
// cc/main wasm/bindings/dsedit_embind.cpp, engine run 15). A sheet is opened
// from its text (or KiCad's default or empty sheet) with no file of KiCad's
// named, taken back as text by KiCad's own formatter, marked saved once the
// page wrote it, and shown on page 1 or the other pages with the title block
// filled in or as typed. KiCad's own save path is never used.
//
// This module holds the closed parsers of the ops' args, the closed readers of
// the engine's answers (any other shape is an island_error), the gate every
// dsedit op passes (ds-i2's ops reuse it) and the cores of dsedit.open,
// dsedit.state, dsedit.take, dsedit.markSaved, dsedit.show and select in a ds
// frame. bridge/ext/ds-i1.ts wires them to the responder.
import { fail, hasAll, isObj, noArgs, ok, type Answer, type ResponderCtx } from './ext/contract';
import { parseSelectArgs } from './selection';
import { isText, isToken } from './symedit';
import { UUID_RE } from './symbol';

/** The frame's name and its boot token. */
export const DS_FRAME = 'ds';
/** The engine exports a ds frame's editor needs (spec 5.2), the apply queue probe last: the cap and every op's gate ask for all of them. */
export const DSEDIT_EXPORTS = [
  'kicadDsEditOpen', 'kicadDsEditState', 'kicadDsEditTake', 'kicadDsEditMarkSaved',
  'kicadDsEditItemsGet', 'kicadDsEditItemsSet', 'kicadDsEditItemsAdd', 'kicadDsEditItemsRemove',
  'kicadDsEditDefaultsGet', 'kicadDsEditDefaultsSet', 'kicadDsEditPreviewGet', 'kicadDsEditPreviewSet',
  'kicadDsEditShow', 'kicadDsEditSelection', 'kicadDsEditSelect', 'kicadDsEditAppend', 'kicadDsEditArmImage',
  'kicadCollabBusy',
] as const;
/** The pseudo-cap a ds frame lists when the engine has every export above. */
export const DSEDIT_CAP = 'dsedit';
/** What a dsedit op answers in any other frame. */
export const DS_FRAME_ONLY = 'a drawing sheet edits in a ds frame';
/** What a ds frame answers for a built in op that reads, saves or edits a document. */
export const DS_REFUSAL = 'a drawing sheet editor opens drawing sheets, not documents';
/** The built in ops a ds frame runs (spec 6.1); every other built in op answers DS_REFUSAL there. */
export const DS_WORKS: readonly string[] = Object.freeze(['key.press', 'keys.claim', 'chrome.show', 'view.fit', 'select', 'shutdown']);
/**
 * The frame's actions held for the host in a ds frame under `dsedit` (spec
 * 6.2; each name copied from KiCad's pagelayout_editor/tools/pl_actions.cpp
 * and common/tool/actions.cpp): new, open, the saves, print and plot, quit,
 * the design inspector, the page preview settings, Append Existing Drawing
 * Sheet, and KiCad's preferences and hotkey list (held, nothing of ours).
 */
export const DS_HELD: readonly string[] = Object.freeze([
  'common.Control.new',
  'common.Control.open',
  'common.Control.save',
  'common.Control.saveAs',
  'common.Control.print',
  'common.Control.plot',
  'common.Control.quit',
  'plEditor.EditorControl.ShowInspector',
  'plEditor.EditorControl.PreviewSettings',
  'plEditor.InteractiveEdit.appendWorksheet',
  'common.SuiteControl.openPreferences',
  'common.SuiteControl.listHotKeys',
]);

/** A sheet's text is at most this many bytes of UTF-8 (the engine's bound, 8 MiB). */
export const DS_TEXT_MAX_BYTES = 8 * 1024 * 1024;
/** A record's string is at most this many characters, unless named (spec 7). */
export const DS_RECORD_MAX = 1024;
/** KiCad's message for a sheet it cannot read is at most this many characters. */
export const DS_MESSAGE_MAX = 4096;
/** The pages a sheet shows: page 1, or every other page. */
export const DS_PAGES = [1, 2] as const;
/** Where an open takes its sheet from: the text given, KiCad's default sheet, or an empty one. */
export const DS_SOURCES = ['text', 'default', 'empty'] as const;
export type DsSource = typeof DS_SOURCES[number];

/** The editor's state (spec 7.1). */
export interface DsEditState {
  /** The island's own token for the last open, "" before any. */
  token: string;
  open: boolean;
  /** The sheet's path in the design, "" before any open. */
  name: string;
  modified: boolean;
  /** The undo depth. */
  depth: number;
  /** Page 1 or the other pages. */
  page: 1 | 2;
  /** The title block filled in (KiCad's preview mode), or its names as typed (edit mode). */
  values: boolean;
  /** The sheet's item count. */
  items: number;
}
export interface DsOpenArgs { source: DsSource; text: string; name: string; discard: boolean }
export interface DsShowArgs { page: 1 | 2; values: boolean }
export interface DsTaken { name: string; text: string }
/** The engine's answer to an open: "" when it took the sheet, else why not, with KiCad's own line for an unreadable one. */
export interface DsOpenAnswer { error: '' | 'unreadable' | 'held_edits' | 'too_large'; message: string }

const STATE_KEYS = ['token', 'open', 'name', 'modified', 'depth', 'page', 'values', 'items'] as const;
const OPEN_ERRORS = ['', 'unreadable', 'held_edits', 'too_large'] as const;

const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isInt = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const isRecordText = (v: unknown, max = DS_RECORD_MAX): v is string => typeof v === 'string' && [...v].length <= max;
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => own.includes(k));
};
const within = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).every((k) => keys.includes(k));
/** UTF-8 bytes of a string. */
export const utf8Bytes = (s: string): number => new TextEncoder().encode(s).byteLength;
// A lone surrogate or a NUL has no UTF-8 spelling the engine could take.
const UNSPELLABLE_RE = /\0|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

function parseJson(text: unknown): unknown {
  if (typeof text !== 'string' || text === '') return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

// ── args ───────────────────────────────────────────────────────────────────────────────

/**
 * dsedit.open's args: `{ source, text?, name, discard }`. `source` `text`,
 * `default` (KiCad's built in sheet) or `empty`; `text` (only with `text`,
 * then required) a `kicad_wks` or legacy `page_layout` document, any length
 * (past 8 MiB the op answers too_large); `name` the sheet's path in the
 * design, 1 to 1,024 characters with no control character (the frame's title
 * only: nothing is ever written there); `discard` a boolean. Null for anything else.
 */
export function parseDsOpenArgs(args: unknown): DsOpenArgs | null {
  if (!isObj(args) || !within(args, ['source', 'text', 'name', 'discard'])) return null;
  const { source, text, name, discard } = args;
  if (!(DS_SOURCES as readonly unknown[]).includes(source) || !isText(name, 1, DS_RECORD_MAX) || !isBool(discard)) return null;
  if (source === 'text') {
    if (typeof text !== 'string' || text === '' || UNSPELLABLE_RE.test(text)) return null;
    return { source, text, name, discard };
  }
  if (text !== undefined) return null;
  return { source: source as DsSource, text: '', name, discard };
}

/** dsedit.markSaved's args: exactly `{ token }`, the token the state carries. */
export function parseDsMarkSavedArgs(args: unknown): { token: string } | null {
  if (!isObj(args) || !exactKeys(args, ['token']) || !isToken(args.token)) return null;
  return { token: args.token };
}

/** dsedit.show's args: exactly `{ page, values }`, `page` 1 (page 1) or 2 (the other pages), `values` a boolean. */
export function parseDsShowArgs(args: unknown): DsShowArgs | null {
  if (!isObj(args) || !exactKeys(args, ['page', 'values'])) return null;
  if ((args.page !== 1 && args.page !== 2) || !isBool(args.values)) return null;
  return { page: args.page, values: args.values };
}

/** kicadDsEditOpen's argument: exactly `{ source, text, name, discard, token }`, `text` only for a text open. */
export function dsOpenJson(a: DsOpenArgs, token: string): string {
  return JSON.stringify(a.source === 'text'
    ? { source: a.source, text: a.text, name: a.name, discard: a.discard, token }
    : { source: a.source, name: a.name, discard: a.discard, token });
}

// ── the engine's answers ───────────────────────────────────────────────────────────────

/** kicadDsEditState's answer read closed (spec 7.1), or null for "" or any other shape. */
export function readDsState(text: unknown): DsEditState | null {
  const v = parseJson(text);
  if (!isObj(v) || !exactKeys(v, STATE_KEYS)) return null;
  if (typeof v.token !== 'string' || !(v.token === '' || isToken(v.token)) || !isBool(v.open) || !isRecordText(v.name)) return null;
  if (!isBool(v.modified) || !isInt(v.depth, 0, Number.MAX_SAFE_INTEGER) || (v.page !== 1 && v.page !== 2)) return null;
  if (!isBool(v.values) || !isInt(v.items, 0, Number.MAX_SAFE_INTEGER)) return null;
  return { token: v.token, open: v.open, name: v.name, modified: v.modified, depth: v.depth, page: v.page, values: v.values, items: v.items };
}

/** kicadDsEditOpen's answer read closed: `{ error }` and, for an unreadable sheet, KiCad's `message`. Null for any other shape. */
export function readDsOpenAnswer(text: unknown): DsOpenAnswer | null {
  const v = parseJson(text);
  if (!isObj(v) || !within(v, ['error', 'message']) || !(OPEN_ERRORS as readonly unknown[]).includes(v.error)) return null;
  if (v.message !== undefined && !isRecordText(v.message, DS_MESSAGE_MAX)) return null;
  return { error: v.error as DsOpenAnswer['error'], message: typeof v.message === 'string' ? v.message : '' };
}

/** kicadDsEditTake's answer read closed: `{ name, text }`, the text a document of 1 byte to 8 MiB. Null for any other shape. */
export function readDsTaken(text: unknown): DsTaken | null {
  const v = parseJson(text);
  if (!isObj(v) || !exactKeys(v, ['name', 'text']) || !isRecordText(v.name)) return null;
  if (typeof v.text !== 'string' || v.text === '' || utf8Bytes(v.text) > DS_TEXT_MAX_BYTES) return null;
  return { name: v.name, text: v.text };
}

/** kicadDsEditSelection's answer: the selected items' uuids, `{ uuids }` (the house shape) or a bare list; null for any other shape. */
export function readDsSelection(text: unknown): string[] | null {
  const v = parseJson(text);
  const list = Array.isArray(v) ? v : isObj(v) && exactKeys(v, ['uuids']) ? v.uuids : null;
  if (!Array.isArray(list) || !list.every((u) => typeof u === 'string' && UUID_RE.test(u))) return null;
  return [...list] as string[];
}

/** The uuids of kicadDsEditItemsGet's items (ds-i2 reads the items whole); null for any other shape. */
export function readDsItemUuids(text: unknown): string[] | null {
  const v = parseJson(text);
  if (!isObj(v) || !Array.isArray(v.items)) return null;
  const out: string[] = [];
  for (const item of v.items) {
    if (!isObj(item) || typeof item.uuid !== 'string' || !UUID_RE.test(item.uuid)) return null;
    out.push(item.uuid);
  }
  return out;
}

/** Whether the state shows what dsedit.show asked. */
export const dsShows = (s: DsEditState, a: DsShowArgs): boolean => s.page === a.page && s.values === a.values;

/** A fresh token for one open: 1 to 64 printable characters. */
export function makeDsToken(): string {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return `d${Array.from(a, (x) => x.toString(16).padStart(2, '0')).join('')}`;
}

// ── the engine, read and called ────────────────────────────────────────────────────────

/** One engine call that answers a string or a boolean; a throw reads as the refusal ("" or false). */
export function callDsText(mod: Record<string, unknown>, name: string, ...args: unknown[]): string {
  try { return String((mod[name] as (...a: unknown[]) => unknown)(...args) ?? ''); } catch { return ''; }
}
export function callDsBool(mod: Record<string, unknown>, name: string, ...args: unknown[]): boolean {
  try { return (mod[name] as (...a: unknown[]) => unknown)(...args) === true; } catch { return false; }
}

/** The editor's state now, null when the engine lacks the exports or answers another shape. */
export function dsStateOf(mod: Record<string, unknown> | null | undefined): DsEditState | null {
  if (mod == null || !hasAll(mod, DSEDIT_EXPORTS)) return null;
  return readDsState(callDsText(mod, 'kicadDsEditState'));
}

/** A sheet is open in the editor (the frame's documentOpen): ev.held and ev.selected are admitted only then. */
export const dsSheetOpen = (mod: Record<string, unknown> | null | undefined): boolean => dsStateOf(mod)?.open === true;

/**
 * Engines whose next undo depth read is the first after an open: ev.edited's
 * baseline starts again there (the open clears the undo list), so an open is
 * never reported as an edit.
 */
const freshOpens = new WeakSet<object>();

/** ev.edited's undo depth in a ds frame: the editor's own while a sheet is open, null otherwise and once right after an open. */
export function dsUndoDepth(mod: Record<string, unknown> | null | undefined): number | null {
  if (mod == null) return null;
  if (freshOpens.has(mod)) { freshOpens.delete(mod); return null; }
  const s = dsStateOf(mod);
  return s?.open === true ? s.depth : null;
}

/** ev.selected's read in a ds frame: the editor's selection as a bare uuid list (fpPaths empty), "" when unread. */
export function dsSelectionRead(mod: Record<string, unknown> | null | undefined): string {
  if (mod == null || !hasAll(mod, DSEDIT_EXPORTS)) return '';
  const uuids = readDsSelection(callDsText(mod, 'kicadDsEditSelection'));
  return uuids == null ? '' : JSON.stringify(uuids);
}

/**
 * The checks every dsedit op makes after its args, in order, every one before
 * any effect: the frame's kind (unsupported outside a ds frame), the engine
 * (not_ready before it is up; unsupported naming the first missing export),
 * busy while a load is parked or a popup menu or a dialog is up, then (with
 * `open`) a sheet open (no_sheet).
 */
export function dsGate(ctx: ResponderCtx, op: string, open: boolean): Answer | { mod: Record<string, unknown>; state: DsEditState } {
  if (ctx.frame !== DS_FRAME) return fail('unsupported', DS_FRAME_ONLY);
  const mod = ctx.win() == null ? null : ctx.mod();
  if (mod == null) return fail('not_ready', op);
  for (const name of DSEDIT_EXPORTS) if (typeof mod[name] !== 'function') return fail('unsupported', name);
  if (ctx.engineBusy() || ctx.keysBlocked()) return fail('busy', op);
  const state = readDsState(callDsText(mod, 'kicadDsEditState'));
  if (state == null) return fail('island_error', 'the engine answered a state of another shape');
  if (open && !state.open) return fail('no_sheet', op);
  return { mod, state };
}

const gated = (g: Answer | { mod: Record<string, unknown>; state: DsEditState }): g is Answer => 'ok' in g;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** How long a queued change may take to show (the bridge's symedit wait, about 5 s). */
const changeMs = (ctx: ResponderCtx): number => ctx.timing.symeditMs ?? 5_000;

/**
 * Waits for a queued change: the apply queue empty and `read` giving a value
 * (it answers null until the change shows), at most `ms`. Null when it never did.
 */
export async function dsReadBack<T>(ctx: ResponderCtx, ms: number, read: () => T | null): Promise<T | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (ctx.closed()) return null;
    if (await ctx.applyIdle(Math.max(0, deadline - Date.now()))) {
      const got = read();
      if (got != null) return got;
    }
    if (Date.now() >= deadline) return null;
    await sleep(ctx.timing.applyPollMs ?? 10);
  }
}

const stateAnswer = (s: DsEditState): Answer => ok(s as unknown as Record<string, unknown>);

// ── the ops ────────────────────────────────────────────────────────────────────────────

/**
 * dsedit.open: past the gate, too_large past 8 MiB of text, held_edits when
 * the open sheet holds changes and `discard` is false; then the engine's open
 * with a fresh token (KiCad's own parser reads the text into a scratch model
 * first: unreadable with KiCad's line, nothing changed), and the answer is the
 * state once the engine shows the token open.
 */
export async function dsOpen(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const op = 'dsedit.open';
  const a = parseDsOpenArgs(args);
  if (a == null) return fail('bad_args', op);
  const g = dsGate(ctx, op, false);
  if (gated(g)) return g;
  const { mod, state } = g;
  if (a.source === 'text' && utf8Bytes(a.text) > DS_TEXT_MAX_BYTES) return fail('too_large', op);
  if (state.open && state.modified && !a.discard) return fail('held_edits', op);
  const token = makeDsToken();
  const t0 = Date.now();
  const said = readDsOpenAnswer(callDsText(mod, 'kicadDsEditOpen', dsOpenJson(a, token)));
  if (said == null) return fail('island_error', 'the engine answered an open of another shape');
  if (said.error === 'unreadable') return fail('unreadable', said.message !== '' ? said.message : op);
  if (said.error !== '') return fail(said.error, op);
  const after = await dsReadBack(ctx, changeMs(ctx), () => {
    const now = readDsState(callDsText(mod, 'kicadDsEditState'));
    return now != null && now.open && now.token === token ? now : null;
  });
  if (after == null) return fail('not_applied', op);
  freshOpens.add(mod);
  ctx.log('dsedit.open', a.source, after.items, `${Date.now() - t0} ms`);
  return stateAnswer(after);
}

/** dsedit.state: the editor's state, a sheet open or not. */
export function dsState(args: unknown, ctx: ResponderCtx): Answer {
  const op = 'dsedit.state';
  if (!noArgs(args)) return fail('bad_args', op);
  const g = dsGate(ctx, op, false);
  return gated(g) ? g : stateAnswer(g.state);
}

/** dsedit.take: the open sheet as a kicad_wks document by KiCad's own formatter, `{ name, text }`. A read. */
export function dsTake(args: unknown, ctx: ResponderCtx): Answer {
  const op = 'dsedit.take';
  if (!noArgs(args)) return fail('bad_args', op);
  const g = dsGate(ctx, op, true);
  if (gated(g)) return g;
  const taken = readDsTaken(callDsText(g.mod, 'kicadDsEditTake'));
  if (taken == null) return fail('island_error', 'the engine answered a sheet of another shape');
  return ok({ name: taken.name, text: taken.text });
}

/** dsedit.markSaved: clears the modified flag once the host wrote what it took (bad_args when `token` is not the state's). No undo step. */
export function dsMarkSaved(args: unknown, ctx: ResponderCtx): Answer {
  const op = 'dsedit.markSaved';
  const a = parseDsMarkSavedArgs(args);
  if (a == null) return fail('bad_args', op);
  const g = dsGate(ctx, op, true);
  if (gated(g)) return g;
  if (g.state.token !== a.token) return fail('bad_args', `${op}: the token is not the open sheet's`);
  if (!callDsBool(g.mod, 'kicadDsEditMarkSaved', a.token)) return fail('not_applied', op);
  const after = readDsState(callDsText(g.mod, 'kicadDsEditState'));
  return after == null ? fail('island_error', 'the engine answered a state of another shape') : stateAnswer(after);
}

/** dsedit.show: page 1 or the other pages, the title block's values or its names; no undo step, not a modification. */
export async function dsShow(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const op = 'dsedit.show';
  const a = parseDsShowArgs(args);
  if (a == null) return fail('bad_args', op);
  const g = dsGate(ctx, op, true);
  if (gated(g)) return g;
  const { mod } = g;
  if (!callDsBool(mod, 'kicadDsEditShow', JSON.stringify(a))) return fail('not_applied', op);
  const after = await dsReadBack(ctx, changeMs(ctx), () => {
    const now = readDsState(callDsText(mod, 'kicadDsEditState'));
    return now != null && dsShows(now, a) ? now : null;
  });
  return after == null ? fail('not_applied', op) : stateAnswer(after);
}

/**
 * select in a ds frame (PROTOCOL.md select): the sheet's own items by uuid
 * (footprint paths select nothing), an id the sheet does not hold selecting
 * nothing; the answer once the editor holds exactly the items found. `zoom`
 * fits the view to them.
 */
export async function dsSelect(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const op = 'select';
  const a = parseSelectArgs(args);
  if (a == null) return fail('bad_args', op);
  const g = dsGate(ctx, op, true);
  if (gated(g)) return g;
  const { mod } = g;
  const held = a.uuids.length === 0 ? [] : readDsItemUuids(callDsText(mod, 'kicadDsEditItemsGet', JSON.stringify({ uuids: a.uuids })));
  if (held == null) return fail('island_error', 'the engine answered items of another shape');
  const found = a.uuids.filter((u) => held.includes(u));
  if (!callDsBool(mod, 'kicadDsEditSelect', JSON.stringify({ uuids: found, zoom: a.zoom && found.length > 0 }))) return fail('not_applied', op);
  const want = new Set(found);
  const done = await dsReadBack(ctx, ctx.timing.selectMs ?? 2_000, () => {
    const now = readDsSelection(callDsText(mod, 'kicadDsEditSelection'));
    return now != null && now.length === want.size && now.every((u) => want.has(u)) ? true : null;
  });
  return done == null ? fail('not_applied', op) : ok();
}
