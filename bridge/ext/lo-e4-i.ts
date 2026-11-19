// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// lo-e4-i (PROTOCOL.md board.padNets and sch.renameNets): net names from the
// board back onto the schematic, KiCad's own Update Schematic from PCB net
// name pass with no KiCad window. board.padNets reads every footprint pad's
// net in a pcb frame through our engine's run 15 export kicadBoardPadNets
// (pcbjam cc_e8_pcb.inc, unit lo-e4-e); sch.renameNets hands those pads to
// kicadSchRenameNets in a sch frame (cc_e8_sch.inc): a preview lists the
// renames with nothing changed, an apply is ONE commit "Update net names"
// (one undo step, reported by the responder's own ev.edited once the depth
// moved). The run writes its record under a fresh /tmp/cc-renameNets/<n>/,
// removed after the answer. Feature detected: on an engine without the
// exports neither cap is listed and each op answers unsupported naming its
// first missing export.
import { fail, hasAll, isObj, noArgs, ok, refused, type Answer, type ExtUnit, type ResponderCtx } from './contract';

/** The engine export board.padNets reads (a synchronous read). */
export const PAD_NETS_EXPORTS = ['kicadBoardPadNets'] as const;
/** The engine exports sch.renameNets needs (the run is queued on the apply coroutine, so the wait reads kicadCollabBusy). */
export const RENAME_NETS_EXPORTS = ['kicadSchRenameNets', 'kicadCollabBusy'] as const;
/** The caps a host gates the doors on. */
export const PAD_NETS_CAP = 'boardPadNets';
export const RENAME_NETS_CAP = 'renameNets';
/** The engine's run folders (it reads no other root). */
export const RENAME_ROOT = '/tmp/cc-renameNets';
/** At most this many pads, read or handed in (the engine's own bound). */
export const PADS_MAX = 32_768;
/** A reference, a pad number or a net name: 1 to 1,024 characters (code points), no control character. */
export const TEXT_MAX = 1024;
/** The bound of one run when the bridge's timing names none. */
const RENAME_MS = 60_000;
const RECORD = 'renameNets.json';
const FRAME_REFUSAL = 'board.padNets runs in a pcb frame, sch.renameNets in a sch frame';

/** One pad and its net, as kicadBoardPadNets reads it and kicadSchRenameNets takes it. */
export interface PadNet { ref: string; pad: string; net: string }
export type RenameOutcome = 'rename' | 'add' | 'refused';
/** One pin whose schematic net name differs from its pad's (PROTOCOL.md RenameNetsRow). */
export interface RenameNetsRow { ref: string; pin: string; from: string; to: string; sheetPath: string; outcome: RenameOutcome; label?: string }
/** sch.renameNets's answer. */
export interface RenameNetsReport { preview: boolean; rows: RenameNetsRow[]; applied: number; truncated: boolean; depth: number }
export interface RenameNetsArgs { preview: boolean; pads: PadNet[] }

const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
};
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
/** A string of `min` to TEXT_MAX code points with no control character. */
const isText = (v: unknown, min = 1): v is string => {
  if (typeof v !== 'string' || CONTROL_RE.test(v)) return false;
  const n = [...v].length;
  return n >= min && n <= TEXT_MAX;
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One pad row read closed: exactly `{ ref, pad, net }`, each a text. Null otherwise. */
function readPad(v: unknown): PadNet | null {
  if (!isObj(v) || !exactKeys(v, ['ref', 'pad', 'net'])) return null;
  if (!isText(v.ref) || !isText(v.pad) || !isText(v.net)) return null;
  return { ref: v.ref, pad: v.pad, net: v.net };
}

/**
 * kicadBoardPadNets's answer read closed: `{ pads: [{ ref, pad, net }], truncated }`,
 * at most 32,768 rows. A row whose reference or pad number is empty can name no
 * symbol pin, so it is left out (a paste only pad carries no number); any other
 * row of another shape refuses the whole answer. Null for anything else.
 */
export function readPadNets(text: unknown): { pads: PadNet[]; truncated: boolean } | null {
  if (typeof text !== 'string' || text === '') return null;
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (!isObj(v) || !exactKeys(v, ['pads', 'truncated']) || typeof v.truncated !== 'boolean' || !Array.isArray(v.pads) || v.pads.length > PADS_MAX) return null;
  const pads: PadNet[] = [];
  for (const p of v.pads) {
    if (isObj(p) && exactKeys(p, ['ref', 'pad', 'net']) && (p.ref === '' || p.pad === '') && typeof p.net === 'string') continue;
    const row = readPad(p);
    if (row == null) return null;
    pads.push(row);
  }
  return { pads, truncated: v.truncated };
}

/**
 * sch.renameNets's args: exactly `{ preview, pads }`: a boolean and 1 to
 * 32,768 pads, each exactly `{ ref, pad, net }` of 1 to 1,024 characters with
 * no control character (board.padNets's rows). Null for anything else.
 */
export function parseRenameNetsArgs(args: unknown): RenameNetsArgs | null {
  if (!isObj(args) || !exactKeys(args, ['preview', 'pads'])) return null;
  if (typeof args.preview !== 'boolean' || !Array.isArray(args.pads) || args.pads.length < 1 || args.pads.length > PADS_MAX) return null;
  const pads: PadNet[] = [];
  for (const p of args.pads) {
    const row = readPad(p);
    if (row == null) return null;
    pads.push(row);
  }
  return { preview: args.preview, pads };
}

/** One record row read closed: `label` (a uuid) only with an outcome that names a label. */
function readRow(v: unknown): RenameNetsRow | null {
  if (!isObj(v)) return null;
  const keys = ['ref', 'pin', 'from', 'to', 'sheetPath', 'outcome'];
  const withLabel = Object.prototype.hasOwnProperty.call(v, 'label');
  if (!exactKeys(v, withLabel ? [...keys, 'label'] : keys)) return null;
  if (!isText(v.ref) || !isText(v.pin) || !isText(v.from, 0) || !isText(v.to) || typeof v.sheetPath !== 'string' || !v.sheetPath.startsWith('/') || CONTROL_RE.test(v.sheetPath)) return null;
  if (v.outcome !== 'rename' && v.outcome !== 'add' && v.outcome !== 'refused') return null;
  const row: RenameNetsRow = { ref: v.ref, pin: v.pin, from: v.from, to: v.to, sheetPath: v.sheetPath, outcome: v.outcome };
  if (withLabel) {
    if (typeof v.label !== 'string' || !UUID_RE.test(v.label) || v.outcome === 'refused') return null;
    row.label = v.label;
  }
  return row;
}

/**
 * The run's record `renameNets.json` (written LAST) read closed: exactly
 * `{ preview, rows, applied, truncated, depth }`, `preview` the asked one, at
 * most as many rows as pads handed in, `applied` 0 on a preview and at most
 * the rows that were not refused on an apply. Null while the record is not
 * there yet; `'bad'` for any other shape.
 */
export function readRenameNetsRecord(bytes: Uint8Array | null, preview: boolean, pads: number): RenameNetsReport | 'bad' | null {
  if (bytes == null) return null;
  let v: unknown;
  try { v = JSON.parse(new TextDecoder().decode(bytes)); } catch { return 'bad'; }
  if (!isObj(v) || !exactKeys(v, ['preview', 'rows', 'applied', 'truncated', 'depth'])) return 'bad';
  if (v.preview !== preview || typeof v.truncated !== 'boolean' || !isCount(v.applied) || !isCount(v.depth)) return 'bad';
  if (!Array.isArray(v.rows) || v.rows.length > pads) return 'bad';
  const rows: RenameNetsRow[] = [];
  for (const r of v.rows) {
    const row = readRow(r);
    if (row == null) return 'bad';
    rows.push(row);
  }
  const doable = rows.filter((r) => r.outcome !== 'refused').length;
  if (preview ? v.applied !== 0 : v.applied > doable) return 'bad';
  return { preview, rows, applied: v.applied, truncated: v.truncated, depth: v.depth };
}

/**
 * board.padNets (a pcb frame, a board open): the checks (bad_args, then the
 * board gate: the frame, the engine's export, a board open, busy), then the
 * engine's synchronous read. A read: answered during a check.
 */
function padNets(args: unknown, ctx: ResponderCtx): Answer {
  const op = 'board.padNets';
  if (!noArgs(args)) return fail('bad_args', op);
  const g = ctx.boardGate(op, PAD_NETS_EXPORTS);
  if (refused(g)) return g;
  let text: unknown;
  try { text = (g.mod.kicadBoardPadNets as () => unknown)(); } catch (err) { return fail('island_error', err instanceof Error ? err.message : String(err)); }
  // The engine answers "" while a load is in flight.
  if (text === '') return fail('busy', op);
  const read = readPadNets(text);
  if (read == null) return fail('island_error', 'the engine answered pad nets of another shape');
  return ok({ pads: read.pads, truncated: read.truncated });
}

/**
 * sch.renameNets (a sch frame, a schematic open): the checks (bad_args, then
 * the schematic gate), then the run queued with a fresh run folder and its
 * record read once the apply queue is empty. The folder is removed whatever
 * the answer. An apply that moved the undo depth is reported by the
 * responder's own ev.edited.
 */
async function renameNets(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const op = 'sch.renameNets';
  const a = parseRenameNetsArgs(args);
  if (a == null) return fail('bad_args', op);
  const g = ctx.schematicGate(op, RENAME_NETS_EXPORTS);
  if (refused(g)) return g;
  let dir: string;
  try { dir = ctx.freshRunFolder(RENAME_ROOT); } catch (err) { return fail('island_error', err instanceof Error ? err.message : String(err)); }
  try {
    const run = Number(dir.slice(dir.lastIndexOf('/') + 1));
    const t0 = Date.now();
    let thrown: string | null = null;
    const got = await ctx.queuedRun(op, dir, ctx.timing.renameNetsMs ?? RENAME_MS,
      () => {
        try {
          return (g.mod.kicadSchRenameNets as (json: string) => unknown)(JSON.stringify({ run, dir, preview: a.preview, pads: a.pads }));
        } catch (err) {
          thrown = err instanceof Error ? err.message : String(err);
          return false;
        }
      },
      () => readRenameNetsRecord(ctx.readBytes(`${dir}/${RECORD}`), a.preview, a.pads.length));
    if (thrown != null) return fail('island_error', thrown);
    if (!('done' in got)) return got;
    if (got.done === 'bad') return fail('island_error', 'the engine answered net renames of another shape');
    const r = got.done;
    ctx.log(op, a.preview ? 'preview' : 'apply', `${r.rows.length} rows`, `${Date.now() - t0} ms`);
    return ok({ preview: r.preview, rows: r.rows, applied: r.applied, truncated: r.truncated, depth: r.depth });
  } finally {
    ctx.dropRunFolder(dir);
  }
}

export default {
  unit: 'lo-e4-i',
  frames: ['pcb', 'sch'],
  frameRefusal: FRAME_REFUSAL,
  capNames: [PAD_NETS_CAP, RENAME_NETS_CAP],
  caps: (mod, frame) => {
    if (frame === 'pcb' && hasAll(mod, PAD_NETS_EXPORTS)) return [PAD_NETS_CAP];
    if (frame === 'sch' && hasAll(mod, RENAME_NETS_EXPORTS)) return [RENAME_NETS_CAP];
    return [];
  },
  ops: {
    'board.padNets': { passesCheck: true, run: padNets },
    'sch.renameNets': { run: renameNets },
  },
} satisfies ExtUnit;
