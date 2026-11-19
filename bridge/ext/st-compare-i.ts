// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-compare-i (PROTOCOL.md item.compare): a placed symbol or a footprint
// compared with its source, the item of the same name in the library its
// nickname names, through our engine's run 15 export kicadCompareWithSource
// (pcbjam cc_e10_dispatch.inc, unit st-compare-e): KiCad's own Compare Symbol
// with Library and Compare Footprint with Library, every difference a coded
// finding (K-DIFF). A source that cannot be read is the success answer's
// status noSource, never an error. KiCad's own two compare actions are held
// (ev.held) so the host opens its own Compare block. Feature detected: on an
// engine without the export the cap is not listed and the op answers
// unsupported naming the export.
//
// The source may not be in the frame yet (a set of the hosted mirror is
// fetched on its first use), and the engine loads it inside the call. A load
// parks, so an engine that can wait there registers the export to park and
// answers through a Promise, as kicadSchRescue does; the op waits for it,
// bounded. An engine whose export answers at once is read the same way.
import { fail, hasAll, isObj, ok, refused, type Answer, type ExtUnit, type HeldRow, type ResponderCtx } from './contract';
import { SHEET_PATH_RE, UUID_RE } from '../symbol';

/** The engine export item.compare reads (a read in the frame's own editor: its text, or a Promise of it while the source loads). */
export const COMPARE_EXPORTS = ['kicadCompareWithSource'] as const;
/** How long the engine may take over one compare (its source may be fetched first): under the host's own 30 s wait. */
export const COMPARE_MS = 25_000;
const TIMEOUT_REFUSAL = 'the engine did not answer the compare within the time limit';
/** The cap a host gates its Compare block on. */
export const COMPARE_CAP = 'compare';

/** KiCad's own compare actions (pcbnew/tools/pcb_actions.cpp, eeschema/tools/sch_actions.cpp). */
export const DIFF_FOOTPRINT = 'pcbnew.InspectionTool.DiffFootprint';
export const DIFF_SYMBOL = 'eeschema.InspectionTool.diffSymbol';

const row = (action: string, frames: readonly ('sch' | 'pcb')[]): HeldRow =>
  Object.freeze({ action, frames: Object.freeze([...frames]), cap: COMPARE_CAP });
/** The held rows: each action in the frame of its own editor. */
export const COMPARE_ROWS: readonly HeldRow[] = Object.freeze([
  row(DIFF_FOOTPRINT, ['pcb']),
  row(DIFF_SYMBOL, ['sch']),
]);

/**
 * The finding codes (spec 7.4's DiffCode, extended by engine run 15's lane
 * notes with the footprint codes KiCad's FootprintNeedsUpdate reports). The
 * engine never sends text or model; they stay in the list as 7.4 names them.
 */
export const DIFF_CODES = [
  'power', 'unitCount', 'graphicCount', 'graphic', 'pinExtra', 'pin', 'pinMissing', 'fieldExtra', 'field', 'fieldMissing',
  'fpFilters', 'keywords', 'pinNameOffset', 'showPinNames', 'showPinNumbers', 'excludeSim', 'excludeBom', 'excludeBoard',
  'excludePos', 'pad', 'padCount', 'shape', 'text', 'model', 'attributes', 'other',
  'boardStackup', 'dnp', 'stackup', 'override', 'netTie', 'barcodeCount', 'barcode', 'ruleAreaCount', 'ruleArea',
] as const;
/** The answer's statuses. */
export const STATUSES = ['same', 'differs', 'noSource'] as const;
/** At most this many findings in one answer. */
export const FINDINGS_MAX = 512;
/** The engine's strings (source, pin, field) are at most this many code points. */
export const STRING_MAX = 1024;
const FRAME_REFUSAL = 'item.compare runs in a sch or pcb frame';

export type DiffCode = (typeof DIFF_CODES)[number];
export type CompareStatus = (typeof STATUSES)[number];
export interface CompareArgs { uuid: string; sheetPath?: string }
export interface Finding { code: DiffCode; uuid: string | null; pin: string; field: string }
export interface CompareResult { status: CompareStatus; source: string; findings: Finding[] }

const has = (o: Record<string, unknown>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(o).length === keys.length && keys.every((k) => has(o, k));
const isString = (v: unknown): v is string => typeof v === 'string' && !v.includes('\0') && [...v].length <= STRING_MAX;

/**
 * item.compare's args read closed for `frame`: exactly `{ uuid }` or
 * `{ uuid, sheetPath }` in a sch frame (symbol.get's grammar: a lowercase
 * uuid, a sheet path in project.open's form), exactly `{ uuid }` in a pcb
 * frame (a footprint has no sheet path). Null for anything else.
 */
export function parseCompareArgs(args: unknown, frame: string): CompareArgs | null {
  if (!isObj(args) || typeof args.uuid !== 'string' || !UUID_RE.test(args.uuid)) return null;
  if (exactKeys(args, ['uuid'])) return { uuid: args.uuid };
  if (frame !== 'sch' || !exactKeys(args, ['uuid', 'sheetPath'])) return null;
  if (typeof args.sheetPath !== 'string' || !SHEET_PATH_RE.test(args.sheetPath)) return null;
  return { uuid: args.uuid, sheetPath: args.sheetPath };
}

/** One finding read closed (`code`, `uuid` lowercase or null, `pin`, `field`), or null. */
export function readFinding(v: unknown): Finding | null {
  if (!isObj(v) || !exactKeys(v, ['code', 'uuid', 'pin', 'field'])) return null;
  const { code, uuid, pin, field } = v;
  if (typeof code !== 'string' || !(DIFF_CODES as readonly string[]).includes(code)) return null;
  if (uuid !== null && (typeof uuid !== 'string' || !UUID_RE.test(uuid))) return null;
  if (!isString(pin) || !isString(field)) return null;
  return { code: code as DiffCode, uuid, pin, field };
}

/**
 * kicadCompareWithSource's answer read closed: `{ status, source, findings }`
 * with a known status, the source's LIB_ID text, at most 512 findings. Null
 * for any other shape (the engine's "" included: the op reads that first).
 */
export function readCompareResult(raw: string): CompareResult | null {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!isObj(v) || !exactKeys(v, ['status', 'source', 'findings'])) return null;
  if (typeof v.status !== 'string' || !(STATUSES as readonly string[]).includes(v.status)) return null;
  if (!isString(v.source) || !Array.isArray(v.findings) || v.findings.length > FINDINGS_MAX) return null;
  const findings: Finding[] = [];
  for (const f of v.findings) {
    const finding = readFinding(f);
    if (finding == null) return null;
    findings.push(finding);
  }
  return { status: v.status as CompareStatus, source: v.source, findings };
}

/** The gate of the frame's own document: the schematic's or the board's checks, the same order. */
const gateFor = (ctx: ResponderCtx, op: string) =>
  (ctx.frame === 'sch' ? ctx.schematicGate(op, COMPARE_EXPORTS) : ctx.boardGate(op, COMPARE_EXPORTS));

/**
 * item.compare (a sch or a pcb frame, a document open): the args (bad_args),
 * then the gate (the engine's export, a document open, busy), then the
 * engine's own compare. The engine answers "" for an item the document does
 * not hold (or a placed symbol with no copy of its own): not_found. A source
 * absent, disabled or gone is the answer's status noSource. The engine's
 * answer is awaited (it parks while a source loads), at most COMPARE_MS; a
 * throw, a rejection or no answer in that time is island_error. A read:
 * answered during a check.
 */
async function compare(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const op = 'item.compare';
  const a = parseCompareArgs(args, ctx.frame);
  if (a == null) return fail('bad_args', op);
  const g = gateFor(ctx, op);
  if (refused(g)) return g;
  let got: unknown;
  try {
    got = await ctx.withTimeout((g.mod.kicadCompareWithSource as (json: string) => unknown)(JSON.stringify(a)), ctx.timing.compareMs ?? COMPARE_MS);
  } catch (err) {
    return fail('island_error', err instanceof Error ? err.message : String(err));
  }
  if (got === 'timeout') return fail('island_error', TIMEOUT_REFUSAL);
  const raw = String(got ?? '');
  if (raw === '') return fail('not_found', a.sheetPath === undefined ? a.uuid : `${a.uuid} on ${a.sheetPath}`);
  const result = readCompareResult(raw);
  if (result == null) return fail('island_error', 'the engine answered a compare of another shape');
  return ok({ status: result.status, source: result.source, findings: result.findings });
}

export default {
  unit: 'st-compare-i',
  frames: ['sch', 'pcb'],
  frameRefusal: FRAME_REFUSAL,
  capNames: [COMPARE_CAP],
  caps: (mod, frame) => ((frame === 'sch' || frame === 'pcb') && hasAll(mod, COMPARE_EXPORTS) ? [COMPARE_CAP] : []),
  held: COMPARE_ROWS.map((h) => h.action),
  heldRows: COMPARE_ROWS,
  ops: {
    'item.compare': { run: compare, passesCheck: true },
  },
} satisfies ExtUnit;
