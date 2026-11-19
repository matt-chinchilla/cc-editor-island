// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-find-e-i (PROTOCOL.md find, find.replace): KiCad's own Find over the live
// document, the schematic or the board, through our engine's run 15 export
// kicadFind (pcbjam cc_e10_dispatch.inc, unit st-find-e-e), and KiCad's own
// Find and Replace in a schematic through kicadSchReplace (cc_e10_sch.inc), ONE
// commit "Find and Replace" (one undo step). The run writes its records under
// a fresh /tmp/cc-replace/<n>/, removed after the answer. KiCad's own Find,
// Find and Replace, Search panel, Find Next, Find Previous and Replace and Find
// Next are held (ev.held) so the host opens its own Find card. Feature
// detected: on an engine without the exports the caps are not listed and each
// op answers unsupported naming the first missing export.
import { fail, hasAll, isObj, ok, refused, type Answer, type ExtUnit, type HeldRow, type ResponderCtx } from './contract';

/** The engine export find reads (a synchronous read of the live document). */
export const FIND_EXPORTS = ['kicadFind'] as const;
/** The engine exports find.replace needs (the run is queued on the apply coroutine, so the wait reads kicadCollabBusy). */
export const REPLACE_EXPORTS = ['kicadSchReplace', 'kicadCollabBusy'] as const;
/** The caps a host gates its doors on. */
export const FIND_CAP = 'find';
export const REPLACE_CAP = 'replace';

/** KiCad's own find actions (common/tool/actions.cpp), held in a sch and a pcb frame. */
export const FIND = 'common.Interactive.find';
export const FIND_AND_REPLACE = 'common.Interactive.findAndReplace';
export const SEARCH = 'common.Interactive.search';
export const FIND_NEXT = 'common.Interactive.findNext';
export const FIND_PREVIOUS = 'common.Interactive.findPrevious';
export const REPLACE_AND_FIND_NEXT = 'common.Interactive.replaceAndFindNext';

const row = (action: string, frames: readonly ('sch' | 'pcb')[], cap: string): HeldRow =>
  Object.freeze({ action, frames: Object.freeze([...frames]), cap });
/** The held rows: the replace actions in a sch frame only (a board has no replace here). */
export const FIND_ROWS: readonly HeldRow[] = Object.freeze([
  row(FIND, ['sch', 'pcb'], FIND_CAP),
  row(FIND_AND_REPLACE, ['sch'], REPLACE_CAP),
  row(SEARCH, ['sch', 'pcb'], FIND_CAP),
  row(FIND_NEXT, ['sch', 'pcb'], FIND_CAP),
  row(FIND_PREVIOUS, ['sch', 'pcb'], FIND_CAP),
  row(REPLACE_AND_FIND_NEXT, ['sch'], REPLACE_CAP),
]);

/** The face objects' flags, exactly these booleans (7.1 FindArgs). */
export const SCH_FACE = ['refs', 'values', 'fields', 'hidden', 'pins', 'labels', 'nets', 'thisSheet', 'selected'] as const;
export const PCB_FACE = ['refs', 'values', 'texts', 'nets', 'markers'] as const;
/** A hit's kinds (7.1 Hit). */
export const HIT_KINDS = ['symbol', 'field', 'pin', 'label', 'text', 'net', 'footprint', 'marker', 'other'] as const;
/** At most this many hits, `truncated` past that; at most this many targets of a replace. */
export const HITS_MAX = 4096;
/** The find text: 1 to 256 code points; the replacement 0 to 256. */
export const TEXT_MAX = 256;
/** The engine cuts a hit's ref, field and text at 1,024 code points. */
export const HIT_STRING_MAX = 1024;
/** Where the replace writes its records (the engine takes no other run folder). */
export const REPLACE_ROOT = '/tmp/cc-replace';
/** The message of bad_args when the engine refused a regular expression it cannot compile. */
export const BAD_PATTERN = 'find: the regular expression does not compile';
/** The bound of one replace when the bridge's timing names none. */
const REPLACE_MS = 30_000;
const SHEET_PATH_MAX = 4096;
const RECORD = '.cc-replace.json';
const REPORT = 'replace.json';
const FRAME_REFUSAL = 'find runs in a sch or pcb frame';
const REPLACE_FRAME_REFUSAL = 'a replace runs in a sch frame';

export type HitKind = (typeof HIT_KINDS)[number];
export type Face = 'sch' | 'pcb';
export interface FindArgs {
  text: string; matchCase: boolean; wholeWord: boolean; wildcards: boolean; regex: boolean;
  sch?: Record<(typeof SCH_FACE)[number], boolean>;
  pcb?: Record<(typeof PCB_FACE)[number], boolean>;
}
export interface Hit { uuid: string; sheetPath: string; kind: HitKind; ref: string; field: string; text: string; start: number; length: number }
export interface FindResult { hits: Hit[]; truncated: boolean }
export interface ReplaceArgs { find: FindArgs; with: string; targets: 'all' | Hit[] }
export interface ReplaceReport { replaced: number; skipped: number; depth: number }
export type ReplaceDone = { report: ReplaceReport } | { error: 'no_match' } | { error: 'bad' };

const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
};
const codePoints = (s: string): number => [...s].length;
const utf8Bytes = (s: string): number => new TextEncoder().encode(s).byteLength;
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isText = (v: unknown, min: number, max: number): v is string =>
  typeof v === 'string' && !v.includes('\0') && codePoints(v) >= min && codePoints(v) <= max;
const isHitString = (v: unknown): v is string => typeof v === 'string' && codePoints(v) <= HIT_STRING_MAX;

function readFace(v: unknown, keys: readonly string[]): Record<string, boolean> | null {
  if (!isObj(v) || !exactKeys(v, keys)) return null;
  const out: Record<string, boolean> = {};
  for (const k of keys) {
    if (typeof v[k] !== 'boolean') return null;
    out[k] = v[k] as boolean;
  }
  return out;
}

/**
 * 7.1's FindArgs read closed: exactly `text` (1 to 256 code points, no NUL),
 * `matchCase`, `wholeWord`, `wildcards`, `regex` (booleans) and ONE face
 * object, `sch` (its nine booleans) or `pcb` (its five). Null for anything
 * else. Which face a frame takes is the op's check.
 */
export function parseFindArgs(args: unknown): FindArgs | null {
  if (!isObj(args)) return null;
  const face: Face | null = Object.prototype.hasOwnProperty.call(args, 'sch') ? 'sch' : Object.prototype.hasOwnProperty.call(args, 'pcb') ? 'pcb' : null;
  if (face == null || !exactKeys(args, ['text', 'matchCase', 'wholeWord', 'wildcards', 'regex', face])) return null;
  const { text, matchCase, wholeWord, wildcards, regex } = args;
  if (!isText(text, 1, TEXT_MAX)) return null;
  if (typeof matchCase !== 'boolean' || typeof wholeWord !== 'boolean' || typeof wildcards !== 'boolean' || typeof regex !== 'boolean') return null;
  const flags = readFace(args[face], face === 'sch' ? SCH_FACE : PCB_FACE);
  if (flags == null) return null;
  return { text, matchCase, wholeWord, wildcards, regex, [face]: flags } as FindArgs;
}

/** The face FindArgs carries. */
export const faceOf = (a: FindArgs): Face => (a.sch != null ? 'sch' : 'pcb');

/** One Hit read closed (the eight keys, a lowercase uuid, the strings within the engine's cuts, whole counts), or null. */
export function readHit(v: unknown): Hit | null {
  if (!isObj(v) || !exactKeys(v, ['uuid', 'sheetPath', 'kind', 'ref', 'field', 'text', 'start', 'length'])) return null;
  const { uuid, sheetPath, kind, ref, field, text, start, length } = v;
  if (typeof uuid !== 'string' || !UUID_RE.test(uuid)) return null;
  if (typeof sheetPath !== 'string' || utf8Bytes(sheetPath) > SHEET_PATH_MAX) return null;
  if (typeof kind !== 'string' || !(HIT_KINDS as readonly string[]).includes(kind)) return null;
  if (!isHitString(ref) || !isHitString(field) || !isHitString(text)) return null;
  if (!isCount(start) || !isCount(length)) return null;
  return { uuid, sheetPath, kind: kind as HitKind, ref, field, text, start, length };
}

/** kicadFind's answer read closed: `{ hits (at most 4,096 Hit), truncated }`, null for any other shape. */
export function readFindResult(raw: string): FindResult | null {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!isObj(v) || !exactKeys(v, ['hits', 'truncated']) || typeof v.truncated !== 'boolean') return null;
  if (!Array.isArray(v.hits) || v.hits.length > HITS_MAX) return null;
  const hits: Hit[] = [];
  for (const h of v.hits) {
    const hit = readHit(h);
    if (hit == null) return null;
    hits.push(hit);
  }
  return { hits, truncated: v.truncated };
}

/**
 * find.replace's args: exactly `{ find, with, targets }`: FindArgs whose face
 * is `sch`, the replacement (0 to 256 code points, no NUL), and `"all"` or
 * 1 to 4,096 Hits as find answered them. Null for anything else.
 */
export function parseReplaceArgs(args: unknown): ReplaceArgs | null {
  if (!isObj(args) || !exactKeys(args, ['find', 'with', 'targets'])) return null;
  const find = parseFindArgs(args.find);
  if (find == null || faceOf(find) !== 'sch') return null;
  if (!isText(args.with, 0, TEXT_MAX)) return null;
  const t = args.targets;
  if (t === 'all') return { find, with: args.with, targets: 'all' };
  if (!Array.isArray(t) || t.length < 1 || t.length > HITS_MAX) return null;
  const targets: Hit[] = [];
  for (const h of t) {
    const hit = readHit(h);
    if (hit == null) return null;
    targets.push(hit);
  }
  return { find, with: args.with, targets };
}

/**
 * The replace's records read closed. `done` is `.cc-replace.json`, written
 * LAST (`{ error, message }`, error "" or "no_match"); `report` is
 * `replace.json` (`{ replaced, skipped, depth }`). Null while the done record
 * is not there yet; `{ error: 'bad' }` for any other shape.
 */
export function readReplaceDone(done: Uint8Array | null, report: Uint8Array | null): ReplaceDone | null {
  if (done == null) return null;
  const json = (b: Uint8Array): unknown => { try { return JSON.parse(new TextDecoder().decode(b)); } catch { return undefined; } };
  const d = json(done);
  if (!isObj(d) || !exactKeys(d, ['error', 'message']) || typeof d.message !== 'string') return { error: 'bad' };
  if (d.error !== '' && d.error !== 'no_match') return { error: 'bad' };
  if (report == null) return { error: 'bad' };
  const r = json(report);
  if (!isObj(r) || !exactKeys(r, ['replaced', 'skipped', 'depth']) || !isCount(r.replaced) || !isCount(r.skipped) || !isCount(r.depth)) return { error: 'bad' };
  if (d.error === 'no_match') return r.replaced === 0 ? { error: 'no_match' } : { error: 'bad' };
  if (r.replaced === 0) return { error: 'bad' };
  return { report: { replaced: r.replaced, skipped: r.skipped, depth: r.depth } };
}

/** The gate of the frame's own document: the schematic's or the board's checks, the same order. */
const gateFor = (ctx: ResponderCtx, op: string, exports: readonly string[]) =>
  (ctx.frame === 'sch' ? ctx.schematicGate(op, exports) : ctx.boardGate(op, exports));

/**
 * find (a sch or a pcb frame, a document open): the args (bad_args, the face
 * the frame's), then the gate (the engine's export, a document open, busy),
 * then KiCad's own matching over the live document. A read: answered during
 * a check. The engine answers "" for a regular expression it cannot compile.
 */
function find(args: unknown, ctx: ResponderCtx): Answer {
  const op = 'find';
  const a = parseFindArgs(args);
  if (a == null || faceOf(a) !== ctx.frame) return fail('bad_args', op);
  const g = gateFor(ctx, op, FIND_EXPORTS);
  if (refused(g)) return g;
  let raw: string;
  try {
    raw = String((g.mod.kicadFind as (json: string) => unknown)(JSON.stringify(a)) ?? '');
  } catch (err) {
    return fail('island_error', err instanceof Error ? err.message : String(err));
  }
  if (raw === '') return a.regex ? fail('bad_args', BAD_PATTERN) : fail('island_error', 'the engine refused the find');
  const result = readFindResult(raw);
  if (result == null) return fail('island_error', 'the engine answered hits of another shape');
  return ok({ hits: result.hits, truncated: result.truncated });
}

/**
 * find.replace (a sch frame, a schematic open): the args (bad_args), the
 * frame, the gate, then the run queued with a fresh /tmp/cc-replace/<n>/ and
 * its records read once the apply queue is empty; the folder is removed
 * whatever the answer. Every target is found again first (one no longer
 * matching is counted in `skipped`); ONE commit; the responder's own
 * ev.edited follows once the depth moved. Nothing replaced answers no_match.
 */
async function replace(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const op = 'find.replace';
  const a = parseReplaceArgs(args);
  if (a == null) return fail('bad_args', op);
  if (ctx.frame !== 'sch') return fail('unsupported', REPLACE_FRAME_REFUSAL);
  const g = ctx.schematicGate(op, REPLACE_EXPORTS);
  if (refused(g)) return g;
  let dir: string;
  try {
    dir = ctx.freshRunFolder(REPLACE_ROOT);
  } catch (err) {
    return fail('island_error', err instanceof Error ? err.message : String(err));
  }
  try {
    const run = Number(dir.slice(dir.lastIndexOf('/') + 1));
    const t0 = Date.now();
    let thrown: string | null = null;
    const got = await ctx.queuedRun(op, dir, ctx.timing.replaceMs ?? REPLACE_MS,
      () => {
        try {
          return (g.mod.kicadSchReplace as (json: string) => unknown)(JSON.stringify({ run, dir, find: a.find, with: a.with, targets: a.targets }));
        } catch (err) {
          thrown = err instanceof Error ? err.message : String(err);
          return false;
        }
      },
      () => readReplaceDone(ctx.readBytes(`${dir}/${RECORD}`), ctx.readBytes(`${dir}/${REPORT}`)));
    if (thrown != null) return fail('island_error', thrown);
    if (!('done' in got)) return got;
    const done = got.done;
    if ('report' in done) {
      ctx.log(op, `${done.report.replaced} replaced`, `${done.report.skipped} skipped`, `${Date.now() - t0} ms`);
      return ok({ replaced: done.report.replaced, skipped: done.report.skipped });
    }
    if (done.error === 'no_match') return fail('no_match', op);
    return fail('island_error', 'the engine answered a replace of another shape');
  } finally {
    ctx.dropRunFolder(dir);
  }
}

export default {
  unit: 'st-find-e-i',
  frames: ['sch', 'pcb'],
  frameRefusal: FRAME_REFUSAL,
  capNames: [FIND_CAP, REPLACE_CAP],
  caps: (mod, frame) => {
    const out: string[] = [];
    if ((frame === 'sch' || frame === 'pcb') && hasAll(mod, FIND_EXPORTS)) out.push(FIND_CAP);
    if (frame === 'sch' && hasAll(mod, [...FIND_EXPORTS, ...REPLACE_EXPORTS])) out.push(REPLACE_CAP);
    return out;
  },
  held: FIND_ROWS.map((h) => h.action),
  heldRows: FIND_ROWS,
  ops: {
    find: { run: find, passesCheck: true },
    'find.replace': { run: replace },
  },
} satisfies ExtUnit;
