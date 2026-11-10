// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// board.check and board.explain (PROTOCOL.md): KiCad's design rules check of
// the board with no KiCad dialog, and the rule behind one of its findings,
// through our engine's kicadCheckBoard and kicadExplainViolation (engine run
// 12). The check queues the DRC job's body on the editor's apply coroutine;
// the run writes its report (drc.json, the findings as records) and then
// .cc-drc.json LAST, so the answer waits for the apply queue to empty and for
// that file, then reads the report. The explain is a synchronous read of one
// mark: KiCad's own BOARD_INSPECTION_TOOL::InspectDRCError, answered as data.

import { UUID_RE, TEXT_MAX } from './symbol';
import { readLines, type RunLine } from './annotate';

/** The engine exports board.check needs: the check, the apply queue probe. */
export const BOARD_CHECK_EXPORTS = ['kicadCheckBoard', 'kicadCollabBusy'] as const;
/** The engine export board.explain needs. */
export const EXPLAIN_EXPORTS = ['kicadExplainViolation'] as const;
/** Each run writes into a fresh folder under this one, outside the project folder. */
export const BOARD_CHECK_ROOT = '/tmp/cc-drc';
/** The run's own record, written last. */
export const BOARD_CHECK_DONE = '.cc-drc.json';
/** The run's report, beside the record. */
export const BOARD_CHECK_REPORT = 'drc.json';
/** At most this many findings listed over the three lists together; past it the counts still total and `truncated` is set. */
export const MAX_FINDINGS = 4096;
/** At most this many items listed for one finding. */
export const MAX_FINDING_ITEMS = 64;
/** At most this many rule keys the run left out, and the board's settings turn off. */
export const MAX_SKIPPED = 8;
export const MAX_IGNORED = 128;
/** A net name is at most this long; a custom rule's condition at most this. */
export const NET_MAX = 512;
export const CONDITION_MAX = 2048;

/** A layer's canonical KiCad name ("F.Cu", "In1.Cu", "B.SilkS", "Edge.Cuts"), at most 32 characters. */
export const LAYER_RE = /^[A-Za-z0-9][A-Za-z0-9._]{0,31}$/;
/** KiCad's rule keys (drc_item.cpp): lower case words joined by "_" (and "generic-warning", "generic-error"). */
export const RULE_KEY_RE = /^[a-z0-9_-]{1,64}$/;

export type RuleSource = 'board' | 'netclass' | 'custom' | 'keepout' | 'local' | 'netTie' | 'tuning' | 'other';
const RULE_SOURCES: readonly string[] = ['board', 'netclass', 'custom', 'keepout', 'local', 'netTie', 'tuning', 'other'];
export type DrcItemKind = 'pad' | 'track' | 'arc' | 'via' | 'zone' | 'footprint' | 'field' | 'text' | 'shape' | 'outline' | 'hole' | 'other';
const ITEM_KINDS: readonly string[] = ['pad', 'track', 'arc', 'via', 'zone', 'footprint', 'field', 'text', 'shape', 'outline', 'hole', 'other'];
export type ParityRun = 'yes' | 'off' | 'no_schematic' | 'not_annotated' | 'unreadable';
const PARITY_RUNS: readonly string[] = ['yes', 'off', 'no_schematic', 'not_annotated', 'unreadable'];

export interface DrcItem { uuid: string; kind: DrcItemKind; ref: string; pad: string; net: string; layer: string; parent: string; description: string }
export interface DrcFinding {
  marker: string; type: string; severity: 'error' | 'warning'; excluded: boolean; comment: string;
  layer: string; x: number; y: number; items: DrcItem[];
  rule: { source: RuleSource; name: string } | null; actual: number | null; message: string;
}
export interface BoardCheckResult {
  violations: DrcFinding[]; unconnected: DrcFinding[]; parity: DrcFinding[];
  parityRun: ParityRun; filled: boolean; skipped: string[]; ignored: string[];
  errors: number; warnings: number; excludedCount: number; depth: number;
  truncated?: true;
}
export interface BoardCheckArgs { fill: boolean; parity: boolean; allTrackErrors: boolean }
export interface BoardCheckDone { code: number; error: '' | 'rules_invalid'; message: string; lines: RunLine[] }

export type ConstraintKind =
  | 'clearance' | 'hole_clearance' | 'hole_to_hole' | 'edge_clearance' | 'track_width' | 'track_angle'
  | 'track_segment_length' | 'connection_width' | 'via_diameter' | 'annular_width' | 'hole_size'
  | 'text_height' | 'text_thickness' | 'max_uncoupled' | 'assertion';
export interface ExplainResult {
  constraint: ConstraintKind; unit: 'mm' | 'deg';
  min: number | null; opt: number | null; max: number | null;
  source: RuleSource; name: string; condition: string; layer: string;
  items: Array<{ uuid: string; netclass: string }>;
}

/**
 * KiCad's rule keys its own BOARD_INSPECTION_TOOL::InspectDRCError explains,
 * each to the constraint it evaluates (pcbnew/tools/board_inspection_tool.cpp,
 * the case list of InspectDRCError at kicad cc/main ffe73d65). The page offers
 * Why only for these.
 */
export const EXPLAINED_TYPES: Readonly<Record<string, ConstraintKind>> = Object.freeze({
  clearance: 'clearance',
  hole_clearance: 'hole_clearance',
  hole_to_hole: 'hole_to_hole',
  copper_edge_clearance: 'edge_clearance',
  track_width: 'track_width',
  track_angle: 'track_angle',
  track_segment_length: 'track_segment_length',
  connection_width: 'connection_width',
  via_diameter: 'via_diameter',
  annular_width: 'annular_width',
  drill_out_of_range: 'hole_size',
  microvia_drill_out_of_range: 'hole_size',
  text_height: 'text_height',
  text_thickness: 'text_thickness',
  diff_pair_uncoupled_length_too_long: 'max_uncoupled',
  assertion_failure: 'assertion',
});
const CONSTRAINTS: readonly string[] = [...new Set(Object.values(EXPLAINED_TYPES))];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Exactly these keys, no more and no fewer. */
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
};
/** A text cut to `max` code points. */
const cut = (s: string, max = TEXT_MAX): string => (s.length <= max ? s : [...s].slice(0, max).join(''));
const isText = (v: unknown, max = TEXT_MAX): v is string => typeof v === 'string' && [...v].length <= max;
const isLayer = (v: unknown): v is string => typeof v === 'string' && LAYER_RE.test(v);
const isLayerOrNone = (v: unknown): v is string => v === '' || isLayer(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v: unknown): v is number | null => v === null || isNum(v);
const isRuleKey = (v: unknown): v is string => typeof v === 'string' && RULE_KEY_RE.test(v);
const parseJson = (bytes: Uint8Array | string): unknown => {
  try { return JSON.parse(typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes)); } catch { return undefined; }
};

/** board.check's args: exactly `{ fill, parity, allTrackErrors }`, each a boolean; null for anything else. */
export function parseBoardCheckArgs(args: unknown): BoardCheckArgs | null {
  if (!isObj(args) || !exactKeys(args, ['fill', 'parity', 'allTrackErrors'])) return null;
  if (typeof args.fill !== 'boolean' || typeof args.parity !== 'boolean' || typeof args.allTrackErrors !== 'boolean') return null;
  return { fill: args.fill, parity: args.parity, allTrackErrors: args.allTrackErrors };
}

/** The args as kicadCheckBoard reads them: `{ run, dir, fill, parity, allTrackErrors }`. */
export const boardCheckJson = (run: number, dir: string, a: BoardCheckArgs): string =>
  JSON.stringify({ run, dir, fill: a.fill, parity: a.parity, allTrackErrors: a.allTrackErrors });

/** .cc-drc.json's bytes read closed: null when absent or of any other shape. */
export function readBoardCheckDone(bytes: Uint8Array | null): BoardCheckDone | null {
  if (bytes == null) return null;
  const v = parseJson(bytes);
  if (!isObj(v) || !exactKeys(v, ['code', 'error', 'message', 'lines'])) return null;
  if (!Number.isSafeInteger(v.code) || (v.error !== '' && v.error !== 'rules_invalid') || typeof v.message !== 'string') return null;
  const lines = readLines(v.lines);
  return lines == null ? null : { code: v.code as number, error: v.error, message: cut(v.message), lines };
}

const ITEM_KEYS = ['uuid', 'kind', 'ref', 'pad', 'net', 'layer', 'parent', 'description'] as const;
function readItem(v: unknown): DrcItem | null {
  if (!isObj(v) || !exactKeys(v, ITEM_KEYS)) return null;
  if (typeof v.uuid !== 'string' || !UUID_RE.test(v.uuid) || typeof v.kind !== 'string' || !ITEM_KINDS.includes(v.kind)) return null;
  if (!isText(v.ref) || !isText(v.pad) || !isText(v.net, NET_MAX) || !isLayerOrNone(v.layer)) return null;
  if (typeof v.parent !== 'string' || !(v.parent === '' || UUID_RE.test(v.parent)) || typeof v.description !== 'string') return null;
  return { uuid: v.uuid, kind: v.kind as DrcItemKind, ref: v.ref, pad: v.pad, net: v.net, layer: v.layer, parent: v.parent, description: cut(v.description) };
}

const FINDING_KEYS = ['marker', 'type', 'severity', 'excluded', 'comment', 'layer', 'x', 'y', 'items', 'rule', 'actual', 'message'] as const;
function readFinding(v: unknown): DrcFinding | null {
  if (!isObj(v) || !exactKeys(v, FINDING_KEYS)) return null;
  if (typeof v.marker !== 'string' || !UUID_RE.test(v.marker) || !isRuleKey(v.type)) return null;
  if ((v.severity !== 'error' && v.severity !== 'warning') || typeof v.excluded !== 'boolean' || typeof v.comment !== 'string') return null;
  if (!isLayerOrNone(v.layer) || !isNum(v.x) || !isNum(v.y) || !Array.isArray(v.items) || !numOrNull(v.actual) || typeof v.message !== 'string') return null;
  let rule: DrcFinding['rule'] = null;
  if (v.rule !== null) {
    const r = v.rule;
    if (!isObj(r) || !exactKeys(r, ['source', 'name']) || typeof r.source !== 'string' || !RULE_SOURCES.includes(r.source) || !isText(r.name)) return null;
    rule = { source: r.source as RuleSource, name: r.name };
  }
  const items: DrcItem[] = [];
  for (const it of v.items as unknown[]) {
    const item = readItem(it);
    if (item == null) return null;
    if (items.length < MAX_FINDING_ITEMS) items.push(item);
  }
  return {
    marker: v.marker, type: v.type, severity: v.severity, excluded: v.excluded, comment: cut(v.comment),
    layer: v.layer, x: v.x, y: v.y, items, rule, actual: v.actual, message: cut(v.message),
  };
}

const REPORT_KEYS = ['violations', 'unconnected', 'parity', 'parityRun', 'filled', 'skipped', 'ignored', 'errors', 'warnings', 'excludedCount', 'depth'] as const;

/**
 * drc.json (kicadCheckBoard's report: section 7.2's BoardCheckResult without
 * `truncated`) read closed into board.check's answer. Excluded findings are
 * listed, flagged. The counts are the island's own, over every finding of the
 * three lists (errors and warnings not excluded; excludedCount the excluded
 * ones), so they total past any cap: at most MAX_FINDINGS are listed, in the
 * lists' order (violations, then unconnected, then parity), and past that
 * `truncated` is set. Null for a report of any other shape.
 */
export function readDrcReport(bytes: Uint8Array | null): BoardCheckResult | null {
  if (bytes == null) return null;
  const v = parseJson(bytes);
  if (!isObj(v) || !exactKeys(v, REPORT_KEYS)) return null;
  if (typeof v.parityRun !== 'string' || !PARITY_RUNS.includes(v.parityRun) || typeof v.filled !== 'boolean') return null;
  if (!Array.isArray(v.skipped) || v.skipped.length > MAX_SKIPPED || !v.skipped.every(isRuleKey)) return null;
  if (!Array.isArray(v.ignored) || v.ignored.length > MAX_IGNORED || !v.ignored.every(isRuleKey)) return null;
  if (!isCount(v.errors) || !isCount(v.warnings) || !isCount(v.excludedCount) || !isCount(v.depth)) return null;
  let errors = 0, warnings = 0, excludedCount = 0, listed = 0, truncated = false;
  const lists: Record<'violations' | 'unconnected' | 'parity', DrcFinding[]> = { violations: [], unconnected: [], parity: [] };
  for (const name of ['violations', 'unconnected', 'parity'] as const) {
    const raw = v[name];
    if (!Array.isArray(raw)) return null;
    for (const x of raw as unknown[]) {
      const f = readFinding(x);
      if (f == null) return null;
      if (name === 'unconnected' && f.type !== 'unconnected_items') return null;
      if (f.excluded) excludedCount += 1; else if (f.severity === 'error') errors += 1; else warnings += 1;
      if (listed >= MAX_FINDINGS) { truncated = true; continue; }
      listed += 1;
      lists[name].push(f);
    }
  }
  const result: BoardCheckResult = {
    ...lists, parityRun: v.parityRun as ParityRun, filled: v.filled,
    skipped: [...v.skipped] as string[], ignored: [...v.ignored] as string[],
    errors, warnings, excludedCount, depth: v.depth,
  };
  return truncated ? { ...result, truncated: true } : result;
}

/** board.explain's args: exactly `{ marker }`, a lower case uuid; null for anything else. */
export function parseExplainArgs(args: unknown): { marker: string } | null {
  if (!isObj(args) || !exactKeys(args, ['marker']) || typeof args.marker !== 'string' || !UUID_RE.test(args.marker)) return null;
  return { marker: args.marker };
}

const EXPLAIN_KEYS = ['constraint', 'unit', 'min', 'opt', 'max', 'source', 'name', 'condition', 'layer', 'items'] as const;

/**
 * kicadExplainViolation's answer read closed: `{ rule }` for a resolved
 * constraint, `{ none: true }` when KiCad names no single rule for the mark's
 * code, `{ none: true, rulesInvalid: true }` when the board's custom rules do
 * not compile; null for any other shape (the empty answer, no such mark,
 * included: the responder answers that not_found before it reads).
 */
export function readExplain(text: unknown): { rule: ExplainResult } | { none: true; rulesInvalid?: true } | null {
  if (typeof text !== 'string' || text === '') return null;
  const v = parseJson(text);
  if (!isObj(v)) return null;
  if (v.constraint === 'none') {
    if (exactKeys(v, ['constraint'])) return { none: true };
    if (exactKeys(v, ['constraint', 'error']) && v.error === 'rules_invalid') return { none: true, rulesInvalid: true };
    return null;
  }
  if (!exactKeys(v, EXPLAIN_KEYS) || typeof v.constraint !== 'string' || !CONSTRAINTS.includes(v.constraint)) return null;
  if ((v.unit !== 'mm' && v.unit !== 'deg') || !numOrNull(v.min) || !numOrNull(v.opt) || !numOrNull(v.max)) return null;
  if (typeof v.source !== 'string' || !RULE_SOURCES.includes(v.source) || !isText(v.name) || !isText(v.condition, CONDITION_MAX) || !isLayerOrNone(v.layer)) return null;
  if (!Array.isArray(v.items) || v.items.length > 2) return null;
  const items: ExplainResult['items'] = [];
  for (const it of v.items as unknown[]) {
    if (!isObj(it) || !exactKeys(it, ['uuid', 'netclass']) || typeof it.uuid !== 'string' || !UUID_RE.test(it.uuid) || !isText(it.netclass)) return null;
    items.push({ uuid: it.uuid, netclass: it.netclass });
  }
  return {
    rule: {
      constraint: v.constraint as ConstraintKind, unit: v.unit, min: v.min, opt: v.opt, max: v.max,
      source: v.source as RuleSource, name: v.name, condition: v.condition, layer: v.layer, items,
    },
  };
}
