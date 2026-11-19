// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-rescue-i (PROTOCOL.md sch.rescue): Keep a copy of missing symbols. A
// preview lists KiCad's rescue candidates (the parts whose source the design
// names but cannot reach) through engine run 15's kicadSchRescue (pcbjam
// cc_e9_sch.inc, unit st-rescue-e), with nothing changed; an apply runs
// kicadSchRescueApply on the chosen names: the design's own copies are written
// into `<stem>-rescue.kicad_sym` with its sym-lib-table row in the project
// folder and the parts relinked as ONE commit "Rescue Symbols" (one undo
// step). The two files the engine wrote reach the host as ev.saved before the
// answer. KiCad's own Rescue Symbols and Remap Legacy Library Symbols are held
// (ev.held) so the host opens its own card. Feature detected: on an engine
// without the exports the cap is not listed and the op answers unsupported
// naming the first one missing.
import { readLines } from '../annotate';
import { fail, hasAll, isObj, ok, refused, type Answer, type ExtUnit, type HeldRow, type ResponderCtx } from './contract';

/** The engine exports sch.rescue needs (the apply is queued on the apply coroutine, so the wait reads kicadCollabBusy). */
export const RESCUE_EXPORTS = ['kicadSchRescue', 'kicadSchRescueApply', 'kicadCollabBusy'] as const;
/** The cap a host gates Keep a copy on. */
export const RESCUE_CAP = 'rescue';

/** KiCad's own Rescue Symbols and Remap Legacy Library Symbols (eeschema/tools/sch_actions.cpp), held in a sch frame. */
export const RESCUE_SYMBOLS = 'eeschema.EditorControl.rescueSymbols';
export const REMAP_SYMBOLS = 'eeschema.EditorControl.remapSymbols';
const row = (action: string): HeldRow => Object.freeze({ action, frames: Object.freeze(['sch'] as const), cap: RESCUE_CAP });
export const RESCUE_ROWS: readonly HeldRow[] = Object.freeze([row(RESCUE_SYMBOLS), row(REMAP_SYMBOLS)]);

/** Where the apply's run writes its records (the engine reads no other folder). */
export const RESCUE_ROOT = '/tmp/cc-rescue';
/** At most this many candidates in a preview, and names in an apply (the engine's own bound). */
export const NAMES_MAX = 4096;
/** A name, and every string of a candidate, is at most this many bytes of UTF-8. */
export const NAME_BYTES_MAX = 1024;
/** The message of a failed write the engine gave without a line of its own. */
export const UNWRITTEN = 'KiCad could not write the rescued symbols';
/** The bound of a preview read and of one apply when the bridge's timing names none. */
const RESCUE_MS = 60_000;
const LINE_MAX = 1024;
const DONE = '.cc-rescue.json';
const REPORT = 'rescue.json';
const FRAME_REFUSAL = 'a rescue runs in a sch frame';

export type RescueArgs = { preview: true } | { names: string[] };
/** One candidate (PROTOCOL.md RescueCandidate). */
export interface RescueCandidate { name: string; libId: string; uses: number; rescuedAs: string }
/** The apply's report read closed: `files` the absolute paths the engine wrote. */
export interface RescueReport { rescued: number; symbols: number; depth: number; files: string[] }
export type RescueDone = { report: RescueReport } | { error: 'rescue_unknown' } | { error: 'rescue_failed'; message: string } | { error: 'bad' };

const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
};
const utf8Bytes = (s: string): number => new TextEncoder().encode(s).byteLength;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isText = (v: unknown, min: number): v is string =>
  typeof v === 'string' && v.length >= min && !CONTROL_RE.test(v) && utf8Bytes(v) <= NAME_BYTES_MAX;
const json = (b: Uint8Array | string): unknown => {
  try { return JSON.parse(typeof b === 'string' ? b : new TextDecoder().decode(b)); } catch { return undefined; }
};

/**
 * sch.rescue's args: exactly `{ preview: true }`, or exactly `{ names }`: 1 to
 * 4,096 names, each 1 to 1,024 bytes of UTF-8 with no control character (a
 * candidate's `libId`, or its `name` when no other candidate shares it).
 * Null for anything else.
 */
export function parseRescueArgs(args: unknown): RescueArgs | null {
  if (!isObj(args)) return null;
  if (exactKeys(args, ['preview'])) return args.preview === true ? { preview: true } : null;
  if (!exactKeys(args, ['names']) || !Array.isArray(args.names)) return null;
  const names = args.names as unknown[];
  if (names.length < 1 || names.length > NAMES_MAX || !names.every((n) => isText(n, 1))) return null;
  return { names: [...(names as string[])] };
}

/** kicadSchRescue's answer read closed: `{ candidates }` of at most 4,096, null for any other shape (an empty answer included). */
export function readCandidates(text: unknown): RescueCandidate[] | null {
  if (typeof text !== 'string' || text === '') return null;
  const v = json(text);
  if (!isObj(v) || !exactKeys(v, ['candidates']) || !Array.isArray(v.candidates) || v.candidates.length > NAMES_MAX) return null;
  const out: RescueCandidate[] = [];
  for (const c of v.candidates as unknown[]) {
    if (!isObj(c) || !exactKeys(c, ['name', 'libId', 'uses', 'rescuedAs'])) return null;
    if (!isText(c.name, 1) || !isText(c.libId, 1) || !isCount(c.uses) || !isText(c.rescuedAs, 1)) return null;
    out.push({ name: c.name, libId: c.libId, uses: c.uses, rescuedAs: c.rescuedAs });
  }
  return out;
}

/**
 * The apply's records read closed. `done` is `.cc-rescue.json`, written LAST
 * (`{ error, message, lines }`); `report` is `rescue.json` (`{ run, rescued,
 * symbols, files, depth, lines }`, of THIS run). Null while the done record is
 * not there yet; `{ error: 'bad' }` for any other shape.
 */
export function readRescueDone(done: Uint8Array | null, report: Uint8Array | null, run: number): RescueDone | null {
  if (done == null) return null;
  const d = json(done);
  if (!isObj(d) || !exactKeys(d, ['error', 'message', 'lines']) || typeof d.message !== 'string' || readLines(d.lines) == null) return { error: 'bad' };
  if (d.error === 'rescue_unknown') return { error: 'rescue_unknown' };
  if (d.error === 'rescue_failed') return { error: 'rescue_failed', message: d.message };
  if (d.error !== '' || report == null) return { error: 'bad' };
  const r = json(report);
  if (!isObj(r) || !exactKeys(r, ['run', 'rescued', 'symbols', 'files', 'depth', 'lines']) || r.run !== run || readLines(r.lines) == null) return { error: 'bad' };
  if (!isCount(r.rescued) || !isCount(r.symbols) || !isCount(r.depth)) return { error: 'bad' };
  if (!Array.isArray(r.files) || r.files.length > 2 || !r.files.every((f) => typeof f === 'string' && f.startsWith('/') && !CONTROL_RE.test(f))) return { error: 'bad' };
  return { report: { rescued: r.rescued, symbols: r.symbols, depth: r.depth, files: [...(r.files as string[])] } };
}

/**
 * The files the engine wrote, as project paths: each one inside `root`, no
 * `.` or `..` segment, once. A path outside the project folder is never named.
 */
export function savedPaths(files: readonly string[], root: string): string[] {
  const out: string[] = [];
  for (const abs of files) {
    if (!abs.startsWith(`${root}/`)) continue;
    const rel = abs.slice(root.length + 1);
    if (rel === '' || rel.split('/').some((p) => p === '' || p === '.' || p === '..') || out.includes(rel)) continue;
    out.push(rel);
  }
  return out;
}

/** KiCad's line as the host reads it: the first line, no run folder named, at most 1,024 characters; ours when KiCad gave none. */
export function rescueLine(message: string): string {
  const line = (message.split(/\r?\n/)[0] ?? '').replace(/\/tmp\/cc-[a-z0-9-]+\/\d+\/?/g, '').trim();
  return line === '' ? UNWRITTEN : [...line].slice(0, LINE_MAX).join('');
}

/** The preview: the engine's read of the candidates, bounded (the read may wait on a symbol fetch). Nothing changes. */
async function preview(op: string, mod: Record<string, unknown>, ctx: ResponderCtx): Promise<Answer> {
  let got: unknown;
  try {
    got = await ctx.withTimeout((mod.kicadSchRescue as (json: string) => unknown)('{}'), ctx.timing.rescueMs ?? RESCUE_MS);
  } catch (err) {
    return fail('island_error', err instanceof Error ? err.message : String(err));
  }
  if (got === 'timeout') return fail('not_applied', op);
  const candidates = readCandidates(got);
  if (candidates == null) return fail('island_error', 'the engine answered rescue candidates of another shape');
  ctx.log(op, 'preview', `${candidates.length} candidates`);
  return ok({ candidates });
}

/** The apply: queued in a fresh run folder, its records read once the apply queue is empty, the files it wrote sent as ev.saved. */
async function apply(op: string, names: string[], mod: Record<string, unknown>, ctx: ResponderCtx): Promise<Answer> {
  if (ctx.fs() == null) return fail('island_error', 'the engine has no file system');
  let dir: string;
  try { dir = ctx.freshRunFolder(RESCUE_ROOT); } catch (err) { return fail('island_error', err instanceof Error ? err.message : String(err)); }
  try {
    const run = Number(dir.slice(dir.lastIndexOf('/') + 1));
    const t0 = Date.now();
    let thrown: string | null = null;
    const got = await ctx.queuedRun(op, dir, ctx.timing.rescueMs ?? RESCUE_MS,
      () => {
        try {
          return (mod.kicadSchRescueApply as (json: string) => unknown)(JSON.stringify({ run, dir, names }));
        } catch (err) {
          thrown = err instanceof Error ? err.message : String(err);
          return false;
        }
      },
      () => readRescueDone(ctx.readBytes(`${dir}/${DONE}`), ctx.readBytes(`${dir}/${REPORT}`), run));
    if (thrown != null) return fail('island_error', thrown);
    if (!('done' in got)) return got;
    const done = got.done;
    if ('report' in done) {
      const saved: string[] = [];
      for (const path of savedPaths(done.report.files, ctx.root)) {
        const bytes = ctx.readBytes(`${ctx.root}/${path}`);
        if (bytes == null) continue;
        ctx.emit({ type: 'ev.saved', path, bytes });
        saved.push(path);
      }
      ctx.log(op, 'apply', `${done.report.rescued} rescued`, `${done.report.symbols} relinked`, `${Date.now() - t0} ms`);
      return ok({ rescued: done.report.rescued, symbols: done.report.symbols, depth: done.report.depth, saved });
    }
    if (done.error === 'rescue_unknown') return fail('not_found', 'a name matches no rescue candidate');
    if (done.error === 'rescue_failed') return fail('island_error', rescueLine(done.message));
    return fail('island_error', 'the engine answered a rescue of another shape');
  } finally {
    ctx.dropRunFolder(dir);
  }
}

/**
 * sch.rescue (a sch frame, a schematic open): the checks (bad_args, then the
 * schematic gate: the frame, the engine's exports, a schematic open, busy),
 * then the preview or the apply. An apply that moved the undo depth is
 * reported by the responder's own ev.edited.
 */
async function rescue(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const op = 'sch.rescue';
  const a = parseRescueArgs(args);
  if (a == null) return fail('bad_args', op);
  const g = ctx.schematicGate(op, RESCUE_EXPORTS);
  if (refused(g)) return g;
  return 'preview' in a ? preview(op, g.mod, ctx) : apply(op, a.names, g.mod, ctx);
}

export default {
  unit: 'st-rescue-i',
  frames: ['sch'],
  frameRefusal: FRAME_REFUSAL,
  capNames: [RESCUE_CAP],
  caps: (mod, frame) => (frame === 'sch' && hasAll(mod, RESCUE_EXPORTS) ? [RESCUE_CAP] : []),
  held: [RESCUE_SYMBOLS, REMAP_SYMBOLS],
  heldRows: [...RESCUE_ROWS],
  ops: {
    'sch.rescue': { run: rescue },
  },
} satisfies ExtUnit;
