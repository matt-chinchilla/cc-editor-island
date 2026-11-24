// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The footprint editor's frame, its common part (PROTOCOL.md "The footprint
// editor: an fpedit frame and the fpedit ops"): KiCad's own
// FOOTPRINT_EDIT_FRAME booted with ?frame=fpedit, canvas only, driven through
// our engine's fpedit exports (pcbjam wasm/bindings/fpedit_embind.cpp, engine
// run 15). A footprint is opened from its text with no library row of
// KiCad's, or made new with no library, taken back as text by KiCad's own
// formatter, and marked saved once the page wrote it. KiCad's own save path
// is never used.
//
// This module holds the frame's names, the closed parsers of the core ops'
// args, the closed readers of the engine's answers (any other shape is an
// island_error), the gate every fpedit op passes (fpEditGate, which the
// other fpedit units import), the frame's reads (state, undo depth,
// selection) and the cores of fpedit.open, fpedit.new, fpedit.state,
// fpedit.take, fpedit.markSaved and select in an fpedit frame.
// bridge/ext/fp-i1.ts wires them to the responder.
import { fail, hasAll, isObj, noArgs, ok, type Answer, type ResponderCtx } from '../ext/contract';
import { parseSelectArgs } from '../selection';
import { isText, isToken } from '../symedit';
import { UUID_RE } from '../symbol';

/** The frame's name and its boot token. */
export const FPEDIT_FRAME = 'fpedit';
/**
 * The engine exports the footprint editor needs (FP spec 11, every row under
 * the cap `fpedit`), the apply queue probe last: the cap and every op's gate
 * ask for all of them, so a host that sees `fpedit` has the whole editor.
 */
export const FPEDIT_EXPORTS = [
  'kicadFpEditOpen', 'kicadFpEditNew', 'kicadFpEditState', 'kicadFpEditTake', 'kicadFpEditMarkSaved',
  'kicadFpEditItemsGet', 'kicadFpEditItemsSet', 'kicadFpEditItemsAdd', 'kicadFpEditItemsRemove',
  'kicadFpEditFootprintGet', 'kicadFpEditFootprintSet', 'kicadFpEditPadDefaultsGet', 'kicadFpEditPadDefaultsSet',
  'kicadFpEditEnumerate', 'kicadFpEditSelection', 'kicadFpEditSelect',
  'kicadFpEditCheck', 'kicadFpEditCleanup', 'kicadFpEditEmbed', 'kicadFpEditPlotSvg',
  'kicadCollabBusy',
] as const;
/** The pseudo-cap an fpedit frame lists when the engine has every export above. */
export const FPEDIT_CAP = 'fpedit';
/** What an fpedit op answers in any other frame. */
export const FPEDIT_FRAME_ONLY = 'a footprint edits in an fpedit frame';
/** What an fpedit frame answers for a built in op that reads, saves or edits a document. */
export const FPEDIT_REFUSAL = 'a footprint editor opens footprints, not documents';
/**
 * The built in ops an fpedit frame runs (FP spec 6.1); every other built in
 * op answers FPEDIT_REFUSAL there: project.open, project.import,
 * project.save, project.plot, board.*, footprint.models, place, layers.*
 * (the footprint's layers come from fpedit.footprint.get) and the rest.
 */
export const FPEDIT_WORKS: readonly string[] = Object.freeze([
  'project.write', 'project.libs', 'lib.index', 'lib.item', 'lib.prefetch',
  'key.press', 'keys.claim', 'chrome.show', 'view.fit', 'select', 'shutdown',
]);
/** The built in pseudo-caps an fpedit frame may list (FP spec 6.1); every unit's own caps are its own. */
export const FPEDIT_PSEUDO_CAPS: readonly string[] = Object.freeze(['heldKeys', 'hostKeys', 'observeKeys', 'write', 'projectLibs']);

/** One footprint's text is at most this many bytes of UTF-8 (the engine's bound, 8 MiB). */
export const FP_TEXT_MAX_BYTES = 8 * 1024 * 1024;
/** A record's string is at most this many characters, unless named (FP spec 7). */
export const FP_RECORD_MAX = 1024;
/** The doors a footprint comes through: the design's own set, a placed part, or a new one. */
export const FP_MODES = ['library', 'placed', 'new'] as const;
export type FpMode = typeof FP_MODES[number];
/** A footprint's type: KiCad's SMD and through hole attributes, or neither. */
export const FP_TYPES = ['smd', 'through_hole', 'unspecified'] as const;
export type FpType = typeof FP_TYPES[number];

/** The editor's state (FP spec 7.1). */
export interface FpEditState {
  /** The island's own token for the last open, "" before any. */
  token: string;
  open: boolean;
  /** The footprint's name, "" with none open. */
  name: string;
  /** The nickname it opened under ("" for none), never a row of KiCad's table. */
  lib: string;
  mode: FpMode;
  modified: boolean;
  /** The undo depth. */
  depth: number;
  padCount: number;
  type: FpType;
  /** KiCad's pad edit mode (a custom pad taken apart) is on. */
  padEditMode: boolean;
}
export interface FpOpenArgs { text: string; name: string; lib: string; mode: FpMode; discard: boolean }
export interface FpNewArgs { name: string; lib: string; type: FpType; discard: boolean }
export interface FpTaken { name: string; text: string }

const STATE_KEYS = ['token', 'open', 'name', 'lib', 'mode', 'modified', 'depth', 'padCount', 'type', 'padEditMode'] as const;

const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isInt = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const isRecordText = (v: unknown, max = FP_RECORD_MAX): v is string => typeof v === 'string' && [...v].length <= max;
const oneOf = <T extends string>(v: unknown, all: readonly T[]): v is T => typeof v === 'string' && (all as readonly string[]).includes(v);
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => own.includes(k));
};
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
 * fpedit.open's args: exactly `{ text, name, lib, mode, discard }`. `text`
 * one footprint document, any length (past 8 MiB the op answers too_large),
 * no NUL; `name` 1 to 1,024 characters and `lib` 0 to 1,024, no control
 * character (the name and nickname it opens under, never a row of the
 * engine's table); `mode` `library`, `placed` or `new`; `discard` a boolean.
 * Null for anything else.
 */
export function parseFpOpenArgs(args: unknown): FpOpenArgs | null {
  if (!isObj(args) || !exactKeys(args, ['text', 'name', 'lib', 'mode', 'discard'])) return null;
  const { text, name, lib, mode, discard } = args;
  if (typeof text !== 'string' || text === '' || UNSPELLABLE_RE.test(text)) return null;
  if (!isText(name, 1, FP_RECORD_MAX) || !isText(lib, 0, FP_RECORD_MAX) || !oneOf(mode, FP_MODES) || !isBool(discard)) return null;
  return { text, name, lib, mode, discard };
}

/** fpedit.new's args: exactly `{ name, lib, type, discard }`, `name` and `lib` as open's, `type` smd, through_hole or unspecified. */
export function parseFpNewArgs(args: unknown): FpNewArgs | null {
  if (!isObj(args) || !exactKeys(args, ['name', 'lib', 'type', 'discard'])) return null;
  const { name, lib, type, discard } = args;
  if (!isText(name, 1, FP_RECORD_MAX) || !isText(lib, 0, FP_RECORD_MAX) || !oneOf(type, FP_TYPES) || !isBool(discard)) return null;
  return { name, lib, type, discard };
}

/** fpedit.markSaved's args: exactly `{ token }`, the token the state carries. */
export function parseFpMarkSavedArgs(args: unknown): { token: string } | null {
  if (!isObj(args) || !exactKeys(args, ['token']) || !isToken(args.token)) return null;
  return { token: args.token };
}

/** kicadFpEditOpen's argument: exactly `{ text, name, lib, mode, discard, token }`. */
export const fpOpenJson = (a: FpOpenArgs, token: string): string =>
  JSON.stringify({ text: a.text, name: a.name, lib: a.lib, mode: a.mode, discard: a.discard, token });
/** kicadFpEditNew's argument: exactly `{ name, lib, type, discard, token }`. */
export const fpNewJson = (a: FpNewArgs, token: string): string =>
  JSON.stringify({ name: a.name, lib: a.lib, type: a.type, discard: a.discard, token });

// ── the engine's answers ───────────────────────────────────────────────────────────────

/** kicadFpEditState's answer read closed (FP spec 7.1), or null for "" (no footprint editor) or any other shape. */
export function readFpEditState(text: unknown): FpEditState | null {
  const v = parseJson(text);
  if (!isObj(v) || !exactKeys(v, STATE_KEYS)) return null;
  if (typeof v.token !== 'string' || !(v.token === '' || isToken(v.token)) || !isBool(v.open) || !isRecordText(v.name) || !isRecordText(v.lib)) return null;
  if (!oneOf(v.mode, FP_MODES) || !isBool(v.modified) || !isInt(v.depth, 0, Number.MAX_SAFE_INTEGER)) return null;
  if (!isInt(v.padCount, 0, Number.MAX_SAFE_INTEGER) || !oneOf(v.type, FP_TYPES) || !isBool(v.padEditMode)) return null;
  return {
    token: v.token, open: v.open, name: v.name, lib: v.lib, mode: v.mode, modified: v.modified, depth: v.depth,
    padCount: v.padCount, type: v.type, padEditMode: v.padEditMode,
  };
}

/** kicadFpEditTake's answer read closed: `{ name, text }`, the text one `(footprint ...)` of 1 byte to 8 MiB. Null for "" or any other shape. */
export function readFpTaken(text: unknown): FpTaken | null {
  const v = parseJson(text);
  if (!isObj(v) || !exactKeys(v, ['name', 'text']) || !isRecordText(v.name) || v.name === '') return null;
  if (typeof v.text !== 'string' || !/^[ \t\r\n]*\(footprint[ \t\r\n"]/.test(v.text) || utf8Bytes(v.text) > FP_TEXT_MAX_BYTES) return null;
  return { name: v.name, text: v.text };
}

/** kicadFpEditSelection's answer: the selected items' uuids, `{ uuids }` (the house shape) or a bare list; null for any other shape. */
export function readFpSelection(text: unknown): string[] | null {
  const v = parseJson(text);
  const list = Array.isArray(v) ? v : isObj(v) && exactKeys(v, ['uuids']) ? v.uuids : null;
  if (!Array.isArray(list) || !list.every((u) => typeof u === 'string' && UUID_RE.test(u))) return null;
  return [...list] as string[];
}

/** The uuids of kicadFpEditItemsGet's items (fp-i2a reads the items whole); null for any other shape. */
export function readFpItemUuids(text: unknown): string[] | null {
  const v = parseJson(text);
  if (!isObj(v) || !Array.isArray(v.items)) return null;
  const out: string[] = [];
  for (const item of v.items) {
    if (!isObj(item) || typeof item.uuid !== 'string' || !UUID_RE.test(item.uuid)) return null;
    out.push(item.uuid);
  }
  return out;
}

/** A fresh token for one open: 1 to 64 printable characters (the engine echoes it in the state; markSaved names it). */
export function makeFpToken(): string {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return `f${Array.from(a, (x) => x.toString(16).padStart(2, '0')).join('')}`;
}

// ── the engine, read and called ────────────────────────────────────────────────────────

/** One engine call that answers a string or a boolean; a throw reads as the refusal ("" or false). */
export function callFpText(mod: Record<string, unknown>, name: string, ...args: unknown[]): string {
  try { return String((mod[name] as (...a: unknown[]) => unknown)(...args) ?? ''); } catch { return ''; }
}
export function callFpBool(mod: Record<string, unknown>, name: string, ...args: unknown[]): boolean {
  try { return (mod[name] as (...a: unknown[]) => unknown)(...args) === true; } catch { return false; }
}

/** The editor's state now, null when the engine lacks the exports or answers another shape. */
export function fpStateOf(mod: Record<string, unknown> | null | undefined): FpEditState | null {
  if (mod == null || !hasAll(mod, FPEDIT_EXPORTS)) return null;
  return readFpEditState(callFpText(mod, 'kicadFpEditState'));
}

/** A footprint is open in the editor (the frame's documentOpen): ev.held and ev.selected are admitted only then. */
export const fpFootprintOpen = (mod: Record<string, unknown> | null | undefined): boolean => fpStateOf(mod)?.open === true;

/**
 * Engines whose next undo depth reads are the first after an open or a new,
 * with the depth the open left: ev.edited's baseline starts again there (the
 * open clears the undo list), so an open is never reported as an edit. The
 * first read answers null (the responder drops its old baseline), the second
 * the open's own depth (the new baseline), never the depth read then: an edit
 * made before that poll ran (a tool pressed right after the open) is still
 * reported by the read after it.
 */
const freshOpens = new WeakMap<object, { reset: boolean; depth: number }>();

/** ev.edited's undo depth in an fpedit frame: kicadFpEditState().depth while a footprint is open, null otherwise; right after an open null, then the open's depth. */
export function fpUndoDepth(mod: Record<string, unknown> | null | undefined): number | null {
  if (mod == null) return null;
  const fresh = freshOpens.get(mod);
  if (fresh != null) {
    if (fresh.reset) { fresh.reset = false; return null; }
    freshOpens.delete(mod);
    return fresh.depth;
  }
  const s = fpStateOf(mod);
  return s?.open === true ? s.depth : null;
}

/** ev.selected's read in an fpedit frame: kicadFpEditSelection() as a bare uuid list (fpPaths empty), "" when unread. */
export function fpSelectionRead(mod: Record<string, unknown> | null | undefined): string {
  if (mod == null || !hasAll(mod, FPEDIT_EXPORTS)) return '';
  const uuids = readFpSelection(callFpText(mod, 'kicadFpEditSelection'));
  return uuids == null ? '' : JSON.stringify(uuids);
}

export type FpGate = Answer | { mod: Record<string, unknown>; state: FpEditState };
/** Whether a gate refused (its answer), else it passed with the engine and the state. */
export const fpGated = (g: FpGate): g is Answer => 'ok' in g;

/**
 * The checks every fpedit op makes after its args, in order, every one before
 * any effect: the frame's kind (unsupported outside an fpedit frame), the
 * engine (not_ready before it is up; unsupported naming the first missing
 * export), busy while a load is parked or a popup menu or a dialog is up,
 * then (with `open`) a footprint open (no_footprint). The other fpedit
 * units' ops pass the same gate.
 */
export function fpEditGate(ctx: ResponderCtx, op: string, open: boolean): FpGate {
  if ((ctx.frame as string) !== FPEDIT_FRAME) return fail('unsupported', FPEDIT_FRAME_ONLY);
  const mod = ctx.win() == null ? null : ctx.mod();
  if (mod == null) return fail('not_ready', op);
  for (const name of FPEDIT_EXPORTS) if (typeof mod[name] !== 'function') return fail('unsupported', name);
  if (ctx.engineBusy() || ctx.keysBlocked()) return fail('busy', op);
  const state = readFpEditState(callFpText(mod, 'kicadFpEditState'));
  if (state == null) return fail('island_error', 'the engine answered a state of another shape');
  if (open && !state.open) return fail('no_footprint', op);
  return { mod, state };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** How long a queued change may take to show (the bridge's editor wait, about 5 s). */
export const fpChangeMs = (ctx: ResponderCtx): number => ctx.timing.symeditMs ?? 5_000;

/**
 * Waits for a queued change: the apply queue empty and `read` giving a value
 * (it answers null until the change shows), at most `ms`. Null when it never did.
 */
export async function fpReadBack<T>(ctx: ResponderCtx, ms: number, read: () => T | null): Promise<T | null> {
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

const stateAnswer = (s: FpEditState): Answer => ok(s as unknown as Record<string, unknown>);

// ── the ops ────────────────────────────────────────────────────────────────────────────

/**
 * fpedit.open and fpedit.new: past the gate, held_edits when the open
 * footprint holds changes and `discard` is false; then the engine's call with
 * a fresh token (false: nothing queued, `refused` answers), and the answer is
 * the state once the engine shows the token open.
 */
async function fpOpening(ctx: ResponderCtx, op: string, discard: boolean, call: (mod: Record<string, unknown>, token: string) => boolean, refused: () => Answer, check?: (s: FpEditState) => Answer | null): Promise<Answer> {
  const g = fpEditGate(ctx, op, false);
  if (fpGated(g)) return g;
  const { mod, state } = g;
  const early = check?.(state);
  if (early != null) return early;
  if (state.open && state.modified && !discard) return fail('held_edits', op);
  const token = makeFpToken();
  const t0 = Date.now();
  if (!call(mod, token)) return refused();
  const after = await fpReadBack(ctx, fpChangeMs(ctx), () => {
    const now = readFpEditState(callFpText(mod, 'kicadFpEditState'));
    return now != null && now.open && now.token === token ? now : null;
  });
  if (after == null) return fail('not_applied', op);
  freshOpens.set(mod, { reset: true, depth: after.depth });
  ctx.log(op, after.name, after.padCount, `${Date.now() - t0} ms`);
  return stateAnswer(after);
}

/**
 * fpedit.open: one footprint from its text, with no library row of KiCad's
 * and no tree sync, undo cleared, unmodified, fitted to the view. too_large
 * past 8 MiB of text; unreadable when KiCad's own parser reads no footprint
 * from it (nothing changed).
 */
export function fpOpen(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const op = 'fpedit.open';
  const a = parseFpOpenArgs(args);
  if (a == null) return Promise.resolve(fail('bad_args', op));
  return fpOpening(ctx, op, a.discard, (mod, token) => callFpBool(mod, 'kicadFpEditOpen', fpOpenJson(a, token)),
    () => fail('unreadable', `${op}: the text holds no footprint KiCad reads`),
    () => (utf8Bytes(a.text) > FP_TEXT_MAX_BYTES ? fail('too_large', op) : null));
}

/** fpedit.new: KiCad's CreateNewFootprint with no library, typed smd, through hole or unspecified, then as open. */
export function fpNew(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const op = 'fpedit.new';
  const a = parseFpNewArgs(args);
  if (a == null) return Promise.resolve(fail('bad_args', op));
  return fpOpening(ctx, op, a.discard, (mod, token) => callFpBool(mod, 'kicadFpEditNew', fpNewJson(a, token)),
    () => fail('bad_args', `${op}: KiCad refused the new footprint`));
}

/** fpedit.state: the editor's state, a footprint open or not. */
export function fpState(args: unknown, ctx: ResponderCtx): Answer {
  const op = 'fpedit.state';
  if (!noArgs(args)) return fail('bad_args', op);
  const g = fpEditGate(ctx, op, false);
  return fpGated(g) ? g : stateAnswer(g.state);
}

/** fpedit.take: the open footprint as library text by KiCad's own formatter, uuids and embedded files kept, `{ name, text }`. A read. */
export function fpTake(args: unknown, ctx: ResponderCtx): Answer {
  const op = 'fpedit.take';
  if (!noArgs(args)) return fail('bad_args', op);
  const g = fpEditGate(ctx, op, true);
  if (fpGated(g)) return g;
  const taken = readFpTaken(callFpText(g.mod, 'kicadFpEditTake'));
  if (taken == null) return fail('island_error', 'the engine answered a footprint of another shape');
  return ok({ name: taken.name, text: taken.text });
}

/** fpedit.markSaved: clears the modified flag once the host wrote what it took (bad_args when `token` is not the state's). No undo step. */
export function fpMarkSaved(args: unknown, ctx: ResponderCtx): Answer {
  const op = 'fpedit.markSaved';
  const a = parseFpMarkSavedArgs(args);
  if (a == null) return fail('bad_args', op);
  const g = fpEditGate(ctx, op, true);
  if (fpGated(g)) return g;
  if (g.state.token !== a.token) return fail('bad_args', `${op}: the token is not the open footprint's`);
  if (!callFpBool(g.mod, 'kicadFpEditMarkSaved', a.token)) return fail('not_applied', op);
  const after = readFpEditState(callFpText(g.mod, 'kicadFpEditState'));
  return after == null ? fail('island_error', 'the engine answered a state of another shape') : stateAnswer(after);
}

/**
 * select in an fpedit frame (PROTOCOL.md select): the footprint's own items
 * by uuid through kicadFpEditSelect (footprint paths select nothing), an id
 * the footprint does not hold selecting nothing; the answer once the editor
 * holds exactly the items found. `zoom` fits the view to them.
 */
export async function fpSelect(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const op = 'select';
  const a = parseSelectArgs(args);
  if (a == null) return fail('bad_args', op);
  const g = fpEditGate(ctx, op, true);
  if (fpGated(g)) return g;
  const { mod } = g;
  const held = a.uuids.length === 0 ? [] : readFpItemUuids(callFpText(mod, 'kicadFpEditItemsGet', JSON.stringify({ uuids: a.uuids })));
  if (held == null) return fail('island_error', 'the engine answered items of another shape');
  const found = a.uuids.filter((u) => held.includes(u));
  if (!callFpBool(mod, 'kicadFpEditSelect', JSON.stringify({ uuids: found, zoom: a.zoom && found.length > 0 }))) return fail('not_applied', op);
  const want = new Set(found);
  const done = await fpReadBack(ctx, ctx.timing.selectMs ?? 2_000, () => {
    const now = readFpSelection(callFpText(mod, 'kicadFpEditSelection'));
    return now != null && now.length === want.size && now.every((u) => want.has(u)) ? true : null;
  });
  return done == null ? fail('not_applied', op) : ok();
}
