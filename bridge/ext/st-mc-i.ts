// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-mc-i (PROTOCOL.md board.multichannel): KiCad's multichannel tool without
// its dialogs, through our engine's run 15 exports kicadMultichannel (the
// read: the rule area candidates and the board's placement rule areas, or
// KiCad's topology verdict per target against a reference area) and
// kicadMultichannelApply (rule areas made, or a layout repeated, each as ONE
// commit on the apply coroutine, a preview reverted; pcbjam cc_e13_pcb.inc,
// unit st-mc-e). The run writes its records under a fresh
// /tmp/cc-multichannel/<n>/, removed after the answer. KiCad's own Generate
// Placement Rule Areas and Repeat Layout are held (ev.held) so the host opens
// its own page. Feature detected: on an engine without the exports the cap is
// not listed and the op answers unsupported naming the first one missing.
import { fail, hasAll, isObj, ok, refused, type Answer, type ExtUnit, type HeldRow, type ResponderCtx } from './contract';

/** The engine exports board.multichannel needs (the apply is queued on the apply coroutine, so the wait reads kicadCollabBusy). */
export const MULTICHANNEL_EXPORTS = ['kicadMultichannel', 'kicadMultichannelApply', 'kicadCollabBusy'] as const;
/** The cap a host gates the page on. */
export const MULTICHANNEL_CAP = 'multichannel';
/** KiCad's own Generate Placement Rule Areas and Repeat Layout, held in a pcb frame. */
export const GENERATE_AREAS = 'pcbnew.Multichannel.generatePlacementRuleAreas';
export const REPEAT_LAYOUT = 'pcbnew.Multichannel.repeatLayout';
export const MULTICHANNEL_ROWS: readonly HeldRow[] = Object.freeze([GENERATE_AREAS, REPEAT_LAYOUT].map((action) =>
  Object.freeze({ action, frames: Object.freeze(['pcb'] as const), cap: MULTICHANNEL_CAP })));

/** Where the engine's apply writes its records (it takes no other run folder). */
export const MULTICHANNEL_ROOT = '/tmp/cc-multichannel';
/** At most this many area keys or target areas in one request. */
export const MAX_NAMED = 4096;
/** An area key of at most this many characters. */
export const KEY_MAX = 4096;
/** The repeat options KiCad's Repeat Layout dialog offers and the engine takes (group the items is refused on repeat by engine run 15). */
export const REPEAT_OPTIONS = ['copyRouting', 'connectedRoutingOnly', 'copyPlacement', 'copyOtherItems', 'includeLockedItems'] as const;
/** The sources KiCad names a placement rule area by. */
export const SOURCES = ['sheet', 'componentClass', 'group', 'designBlock'] as const;
/** The bound of one apply when the bridge's timing names none. */
const MULTICHANNEL_MS = 60_000;
const MESSAGE_MAX = 1024;
const RECORD = '.cc-multichannel.json';
const REPORT = 'multichannel.json';
const FRAME_REFUSAL = 'a multichannel op runs in a pcb frame';
const OP = 'board.multichannel';

export type RepeatOption = typeof REPEAT_OPTIONS[number];
export type Source = typeof SOURCES[number];
export type RepeatOptions = Partial<Record<RepeatOption, boolean>> & { anchor?: string };
export type MultichannelArgs =
  | { op: 'areas' }
  | { op: 'check'; ref: string }
  | { op: 'generate'; areas: string[]; replaceExisting: boolean; groupItems?: boolean }
  | { op: 'repeat'; ref: string; targets: string[]; options: RepeatOptions; preview: boolean };

/** A candidate KiCad would make a rule area for; `key` is what generate takes, `zone` the existing area holding exactly its parts or "". */
export interface AreaRow { key: string; name: string; source: Source; sheetPath: string; parts: number; exists: boolean; zone: string }
/** A placement rule area of the board. */
export interface RuleAreaRow { zone: string; name: string; source: Source; sourceName: string; parts: number }
export interface AreasRead { areas: AreaRow[]; ruleAreas: RuleAreaRow[]; canGenerate: boolean }
/** KiCad's verdict for one target area against the reference. */
export interface CheckRow { zone: string; name: string; parts: number; matched: number; ok: boolean; message: string; reasons: string[] }
export interface GenerateRow { key: string; name: string; parts: number; ok: boolean; reasons: string[]; skipped: '' | 'exists' | 'empty'; zone?: string }
export interface RepeatRow { zone: string; name: string; parts: number; ok: boolean; reasons: string[] }
/** The answer of an apply (PROTOCOL.md MultichannelReport). */
export interface MultichannelReport { preview: boolean; areas: GenerateRow[] | RepeatRow[]; applied: number; depth: number }
export type ApplyDone =
  | { report: MultichannelReport }
  | { error: 'not_found' | 'too_few' | 'copy_failed' | 'no_board' | 'failed'; message: string }
  | { error: 'bad' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
};
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isSource = (v: unknown): v is Source => typeof v === 'string' && (SOURCES as readonly string[]).includes(v);
const isLines = (v: unknown): v is string[] => Array.isArray(v) && v.every((l) => typeof l === 'string');
const isKey = (v: unknown): v is string => typeof v === 'string' && v !== '' && v.length <= KEY_MAX;

/** A list of 1 to 4,096 distinct strings each passing `each`; null otherwise. */
function distinct(v: unknown, each: (s: unknown) => s is string): string[] | null {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_NAMED || !v.every(each)) return null;
  return new Set(v).size === v.length ? [...(v as string[])] : null;
}

/**
 * board.multichannel's args, read closed: exactly `{ op: "areas" }`;
 * `{ op: "check", ref }` (a zone uuid, lower case); `{ op: "generate", areas,
 * replaceExisting, groupItems? }` (1 to 4,096 distinct candidate keys);
 * `{ op: "repeat", ref, targets, options, preview }` (1 to 4,096 distinct
 * zone uuids, none the ref; options any of the five booleans and `anchor`, a
 * footprint uuid or ""). Null for anything else, `groupItems` in a repeat's
 * options included (the engine refuses it there).
 */
export function parseMultichannelArgs(args: unknown): MultichannelArgs | null {
  if (!isObj(args)) return null;
  switch (args.op) {
    case 'areas':
      return exactKeys(args, ['op']) ? { op: 'areas' } : null;
    case 'check':
      return exactKeys(args, ['op', 'ref']) && isUuid(args.ref) ? { op: 'check', ref: args.ref } : null;
    case 'generate': {
      const withGroup = Object.prototype.hasOwnProperty.call(args, 'groupItems');
      if (!exactKeys(args, withGroup ? ['op', 'areas', 'replaceExisting', 'groupItems'] : ['op', 'areas', 'replaceExisting'])) return null;
      const areas = distinct(args.areas, isKey);
      if (areas == null || typeof args.replaceExisting !== 'boolean') return null;
      if (withGroup && typeof args.groupItems !== 'boolean') return null;
      return withGroup
        ? { op: 'generate', areas, replaceExisting: args.replaceExisting, groupItems: args.groupItems as boolean }
        : { op: 'generate', areas, replaceExisting: args.replaceExisting };
    }
    case 'repeat': {
      if (!exactKeys(args, ['op', 'ref', 'targets', 'options', 'preview'])) return null;
      if (!isUuid(args.ref) || typeof args.preview !== 'boolean' || !isObj(args.options)) return null;
      const targets = distinct(args.targets, isUuid);
      if (targets == null || targets.includes(args.ref)) return null;
      const options: RepeatOptions = {};
      for (const [k, v] of Object.entries(args.options)) {
        if (k === 'anchor') {
          if (v !== '' && !isUuid(v)) return null;
          options.anchor = v as string;
        } else if ((REPEAT_OPTIONS as readonly string[]).includes(k) && typeof v === 'boolean') {
          options[k as RepeatOption] = v;
        } else {
          return null;
        }
      }
      return { op: 'repeat', ref: args.ref, targets, options, preview: args.preview };
    }
    default:
      return null;
  }
}

const parseJson = (s: string): unknown => { try { return JSON.parse(s); } catch { return undefined; } };

/** The read `{ op: "areas" }` answered by the engine, read closed; null for any other shape. */
export function readAreas(text: string): AreasRead | null {
  const r = parseJson(text);
  if (!isObj(r) || !exactKeys(r, ['areas', 'ruleAreas', 'canGenerate']) || typeof r.canGenerate !== 'boolean') return null;
  if (!Array.isArray(r.areas) || !Array.isArray(r.ruleAreas)) return null;
  const areas: AreaRow[] = [];
  for (const a of r.areas as unknown[]) {
    if (!isObj(a) || !exactKeys(a, ['key', 'name', 'source', 'sheetPath', 'parts', 'exists', 'zone'])) return null;
    if (!isKey(a.key) || typeof a.name !== 'string' || !isSource(a.source) || typeof a.sheetPath !== 'string' || !isCount(a.parts) || typeof a.exists !== 'boolean') return null;
    if (a.exists ? !isUuid(a.zone) : a.zone !== '') return null;
    areas.push({ key: a.key, name: a.name, source: a.source, sheetPath: a.sheetPath, parts: a.parts, exists: a.exists, zone: a.zone as string });
  }
  const ruleAreas: RuleAreaRow[] = [];
  for (const a of r.ruleAreas as unknown[]) {
    if (!isObj(a) || !exactKeys(a, ['zone', 'name', 'source', 'sourceName', 'parts'])) return null;
    if (!isUuid(a.zone) || typeof a.name !== 'string' || !isSource(a.source) || typeof a.sourceName !== 'string' || !isCount(a.parts)) return null;
    ruleAreas.push({ zone: a.zone, name: a.name, source: a.source, sourceName: a.sourceName, parts: a.parts });
  }
  return { areas, ruleAreas, canGenerate: r.canGenerate };
}

/** The read `{ op: "check", ref }` answered by the engine, read closed: the rows, `not_found` for an unknown ref, null for any other shape. */
export function readChecks(text: string): { checks: CheckRow[] } | { error: 'not_found' } | null {
  const r = parseJson(text);
  if (!isObj(r) || !exactKeys(r, ['checks', 'error']) || !Array.isArray(r.checks)) return null;
  if (r.error === 'not_found') return r.checks.length === 0 ? { error: 'not_found' } : null;
  if (r.error !== '') return null;
  const checks: CheckRow[] = [];
  for (const c of r.checks as unknown[]) {
    if (!isObj(c) || !exactKeys(c, ['zone', 'name', 'parts', 'matched', 'ok', 'message', 'reasons'])) return null;
    if (!isUuid(c.zone) || typeof c.name !== 'string' || !isCount(c.parts) || !isCount(c.matched) || typeof c.ok !== 'boolean' || typeof c.message !== 'string' || !isLines(c.reasons)) return null;
    checks.push({ zone: c.zone, name: c.name, parts: c.parts, matched: c.matched, ok: c.ok, message: c.message, reasons: [...c.reasons] });
  }
  return { checks };
}

const SKIPS = ['', 'exists', 'empty'] as const;
function generateRow(a: unknown): GenerateRow | null {
  if (!isObj(a)) return null;
  const withZone = Object.prototype.hasOwnProperty.call(a, 'zone');
  if (!exactKeys(a, withZone ? ['key', 'name', 'parts', 'ok', 'reasons', 'skipped', 'zone'] : ['key', 'name', 'parts', 'ok', 'reasons', 'skipped'])) return null;
  if (!isKey(a.key) || typeof a.name !== 'string' || !isCount(a.parts) || typeof a.ok !== 'boolean' || !isLines(a.reasons)) return null;
  if (typeof a.skipped !== 'string' || !(SKIPS as readonly string[]).includes(a.skipped)) return null;
  if (withZone !== a.ok || (withZone && !isUuid(a.zone))) return null;
  const row: GenerateRow = { key: a.key, name: a.name, parts: a.parts, ok: a.ok, reasons: [...a.reasons], skipped: a.skipped as GenerateRow['skipped'] };
  if (withZone) row.zone = a.zone as string;
  return row;
}
function repeatRow(a: unknown): RepeatRow | null {
  if (!isObj(a) || !exactKeys(a, ['zone', 'name', 'parts', 'ok', 'reasons'])) return null;
  if (!isUuid(a.zone) || typeof a.name !== 'string' || !isCount(a.parts) || typeof a.ok !== 'boolean' || !isLines(a.reasons)) return null;
  return { zone: a.zone, name: a.name, parts: a.parts, ok: a.ok, reasons: [...a.reasons] };
}

const ERRORS = ['not_found', 'too_few', 'copy_failed', 'no_board', 'failed'] as const;

/**
 * The run's records read closed. `done` is `.cc-multichannel.json`, written
 * LAST (`{ code: 0 | 1, error }`); `report` is `multichannel.json` (`{ op,
 * preview, areas, applied, depth, error, message }`, rows of the op's own
 * form). Null while the done record is not there yet; `{ error: 'bad' }` for
 * any other shape or a report of another op or preview.
 */
export function readApplyDone(done: Uint8Array | null, report: Uint8Array | null, op: 'generate' | 'repeat', preview: boolean): ApplyDone | null {
  if (done == null) return null;
  const json = (b: Uint8Array): unknown => parseJson(new TextDecoder().decode(b));
  const d = json(done);
  if (!isObj(d) || !exactKeys(d, ['code', 'error']) || (d.code !== 0 && d.code !== 1) || typeof d.error !== 'string') return { error: 'bad' };
  if ((d.code === 0) !== (d.error === '') || report == null) return { error: 'bad' };
  const r = json(report);
  if (!isObj(r) || !exactKeys(r, ['op', 'preview', 'areas', 'applied', 'depth', 'error', 'message'])) return { error: 'bad' };
  if (r.op !== op || r.preview !== (op === 'repeat' && preview) || r.error !== d.error || typeof r.message !== 'string') return { error: 'bad' };
  if (d.code === 1) {
    if (!(ERRORS as readonly string[]).includes(d.error)) return { error: 'bad' };
    return { error: d.error as typeof ERRORS[number], message: r.message };
  }
  if (!isCount(r.applied) || !isCount(r.depth) || !Array.isArray(r.areas)) return { error: 'bad' };
  if (op === 'generate') {
    const rows = (r.areas as unknown[]).map(generateRow);
    if (rows.some((x) => x == null)) return { error: 'bad' };
    return { report: { preview: false, areas: rows as GenerateRow[], applied: r.applied, depth: r.depth } };
  }
  const rows = (r.areas as unknown[]).map(repeatRow);
  if (rows.some((x) => x == null)) return { error: 'bad' };
  return { report: { preview, areas: rows as RepeatRow[], applied: r.applied, depth: r.depth } };
}

/** KiCad's line as the host reads it: the first line only, no run folder named, at most 1,024 characters; `fallback` when KiCad gave none. */
export function multichannelLine(message: string, fallback: string): string {
  const line = (message.split(/\r?\n/)[0] ?? '').replace(/\/tmp\/cc-[a-z0-9-]+\/\d+\/?/g, '').trim();
  return line === '' ? fallback : [...line].slice(0, MESSAGE_MAX).join('');
}

/** The two reads: synchronous, nothing changed. */
function read(a: { op: 'areas' } | { op: 'check'; ref: string }, mod: Record<string, unknown>): Answer {
  let text: unknown;
  try {
    text = (mod.kicadMultichannel as (json: string) => unknown)(JSON.stringify(a));
  } catch (err) {
    return fail('island_error', err instanceof Error ? err.message : String(err));
  }
  if (typeof text !== 'string') return fail('island_error', 'the engine answered a multichannel read of another shape');
  if (text === '') return fail('not_applied', OP);
  if (a.op === 'areas') {
    const r = readAreas(text);
    return r == null ? fail('island_error', 'the engine answered areas of another shape') : ok({ ...r });
  }
  const c = readChecks(text);
  if (c == null) return fail('island_error', 'the engine answered checks of another shape');
  if ('error' in c) return fail('not_found', a.ref);
  return ok({ checks: c.checks });
}

/** The apply: a fresh run folder, the run queued, its records read once the apply queue is empty; the folder removed whatever the answer. */
async function apply(a: Extract<MultichannelArgs, { op: 'generate' | 'repeat' }>, mod: Record<string, unknown>, ctx: ResponderCtx): Promise<Answer> {
  let dir: string;
  try {
    dir = ctx.freshRunFolder(MULTICHANNEL_ROOT);
  } catch (err) {
    return fail('island_error', err instanceof Error ? err.message : String(err));
  }
  try {
    const run = Number(dir.slice(dir.lastIndexOf('/') + 1));
    const preview = a.op === 'repeat' && a.preview;
    const t0 = Date.now();
    let thrown: string | null = null;
    const got = await ctx.queuedRun(OP, dir, ctx.timing.multichannelMs ?? MULTICHANNEL_MS,
      () => {
        try {
          return (mod.kicadMultichannelApply as (json: string) => unknown)(JSON.stringify({ run, dir, ...a }));
        } catch (err) {
          thrown = err instanceof Error ? err.message : String(err);
          return false;
        }
      },
      () => readApplyDone(ctx.readBytes(`${dir}/${RECORD}`), ctx.readBytes(`${dir}/${REPORT}`), a.op, preview));
    if (thrown != null) return fail('island_error', thrown);
    if (!('done' in got)) return got;
    const done = got.done;
    if ('report' in done) {
      ctx.log(OP, a.op, preview ? 'preview' : 'apply', `${done.report.applied} applied`, `${Date.now() - t0} ms`);
      return ok({ ...done.report });
    }
    switch (done.error) {
      case 'not_found': return fail('not_found', multichannelLine(done.message, OP));
      case 'too_few': return fail('too_few', multichannelLine(done.message, 'KiCad finds fewer than two areas to make'));
      case 'copy_failed': return fail('copy_failed', multichannelLine(done.message, 'KiCad could not copy the layout'));
      case 'no_board': return fail('not_ready', OP);
      case 'failed': return fail('island_error', multichannelLine(done.message, 'the multichannel run failed'));
      default: return fail('island_error', 'the engine answered a multichannel record of another shape');
    }
  } finally {
    ctx.dropRunFolder(dir);
  }
}

/**
 * board.multichannel (a pcb frame, a board open): the checks (bad_args, then
 * the board gate: the frame, the engine's exports, a board open, busy). The
 * reads are answered during a board.check or sheet.check; an apply then
 * answers busy. An apply that moved the undo depth is reported by the
 * responder's own ev.edited.
 */
async function multichannel(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const a = parseMultichannelArgs(args);
  if (a == null) return fail('bad_args', OP);
  const g = ctx.boardGate(OP, MULTICHANNEL_EXPORTS);
  if (refused(g)) return g;
  if (a.op === 'areas' || a.op === 'check') return read(a, g.mod);
  if (ctx.checking()) return fail('busy', OP);
  return apply(a, g.mod, ctx);
}

export default {
  unit: 'st-mc-i',
  frames: ['pcb'],
  frameRefusal: FRAME_REFUSAL,
  capNames: [MULTICHANNEL_CAP],
  caps: (mod, frame) => (frame === 'pcb' && hasAll(mod, MULTICHANNEL_EXPORTS) ? [MULTICHANNEL_CAP] : []),
  held: [GENERATE_AREAS, REPEAT_LAYOUT],
  heldRows: [...MULTICHANNEL_ROWS],
  ops: {
    'board.multichannel': { passesCheck: true, run: multichannel },
  },
} satisfies ExtUnit;
