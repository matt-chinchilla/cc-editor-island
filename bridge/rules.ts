// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// board.rules (PROTOCOL.md): the rules KiCad applies to one board item, or
// between two, read with no KiCad window through our engine's
// kicadResolveRules (engine run 14): KiCad's own Constraints Resolution
// (BOARD_INSPECTION_TOOL::InspectConstraints) for one item and Clearance
// Resolution (its reportClearance) for two, answered as records. A
// synchronous read, as board.explain is.

import { UUID_RE, TEXT_MAX } from './symbol';
import { CONDITION_MAX, LAYER_RE, type RuleSource } from './boardCheck';

/** The engine export the op needs. */
export const RULES_EXPORTS = ['kicadResolveRules'] as const;
/** At most this many records and notes in one answer (the engine's own bounds). */
export const MAX_RULES = 128;
export const MAX_RULE_NOTES = 32;

export type RuleConstraint =
  | 'clearance' | 'hole_clearance' | 'hole_to_hole' | 'edge_clearance' | 'track_width' | 'track_angle'
  | 'track_segment_length' | 'connection_width' | 'via_diameter' | 'annular_width' | 'hole_size'
  | 'text_height' | 'text_thickness' | 'max_uncoupled' | 'assertion'
  | 'physical_clearance' | 'physical_hole_clearance' | 'silk_clearance' | 'courtyard_clearance' | 'diff_pair_gap'
  | 'zone_connection' | 'thermal_relief_gap' | 'thermal_spoke_width' | 'min_resolved_spokes'
  | 'solder_mask_expansion' | 'solder_paste_abs_margin' | 'solder_paste_rel_margin' | 'disallow';
export type RuleUnit = 'mm' | 'deg' | 'percent' | 'count' | 'none';
export type RuleVerdict = '' | 'solid' | 'thermal' | 'thermal_tht' | 'none' | 'allowed' | 'disallowed' | 'pass' | 'fail';
export interface RuleRecord {
  constraint: RuleConstraint; unit: RuleUnit;
  min: number | null; opt: number | null; max: number | null;
  verdict: RuleVerdict; source: RuleSource | 'sameNet'; name: string; condition: string; layer: string;
  items: Array<{ uuid: string; netclass: string }>;
}
export interface RulesArgs { a: string; b?: string }
export type RulesAnswer = { rules: RuleRecord[]; notes: string[] } | { error: 'not_found' | 'rules_invalid' };

/** Each constraint's unit: `mm` unless named here. */
const UNITS: Readonly<Record<string, RuleUnit>> = Object.freeze({
  track_angle: 'deg', solder_paste_rel_margin: 'percent', min_resolved_spokes: 'count',
  zone_connection: 'none', disallow: 'none', assertion: 'none',
});
/** The verdicts a constraint may carry: `""` alone unless named here. */
const VERDICTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  zone_connection: ['', 'solid', 'thermal', 'thermal_tht', 'none'],
  disallow: ['allowed', 'disallowed'],
  assertion: ['pass', 'fail'],
});
const CONSTRAINTS: readonly string[] = [
  'clearance', 'hole_clearance', 'hole_to_hole', 'edge_clearance', 'track_width', 'track_angle',
  'track_segment_length', 'connection_width', 'via_diameter', 'annular_width', 'hole_size',
  'text_height', 'text_thickness', 'max_uncoupled', 'assertion',
  'physical_clearance', 'physical_hole_clearance', 'silk_clearance', 'courtyard_clearance', 'diff_pair_gap',
  'zone_connection', 'thermal_relief_gap', 'thermal_spoke_width', 'min_resolved_spokes',
  'solder_mask_expansion', 'solder_paste_abs_margin', 'solder_paste_rel_margin', 'disallow',
];
const SOURCES: readonly string[] = ['board', 'netclass', 'custom', 'keepout', 'local', 'netTie', 'tuning', 'other', 'sameNet'];
const RECORD_KEYS = ['constraint', 'unit', 'min', 'opt', 'max', 'verdict', 'source', 'name', 'condition', 'layer', 'items'] as const;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
};
const isText = (v: unknown, max = TEXT_MAX): v is string => typeof v === 'string' && [...v].length <= max;
const numOrNull = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v));
const cut = (s: string, max = TEXT_MAX): string => (s.length <= max ? s : [...s].slice(0, max).join(''));

/** board.rules' args: exactly `{ a }` or `{ a, b }`, lowercase uuids, `b` not `a`; null for anything else. */
export function parseRulesArgs(args: unknown): RulesArgs | null {
  if (!isObj(args)) return null;
  const keys = Object.keys(args);
  if (!keys.every((k) => k === 'a' || k === 'b') || typeof args.a !== 'string' || !UUID_RE.test(args.a)) return null;
  if (!Object.prototype.hasOwnProperty.call(args, 'b')) return { a: args.a };
  if (typeof args.b !== 'string' || !UUID_RE.test(args.b) || args.b === args.a) return null;
  return { a: args.a, b: args.b };
}

/** The args as kicadResolveRules reads them: `{ a, b }`, `b` `""` for one item. */
export const rulesJson = (a: RulesArgs): string => JSON.stringify({ a: a.a, b: a.b ?? '' });

function readRecord(v: unknown): RuleRecord | null {
  if (!isObj(v) || !exactKeys(v, RECORD_KEYS) || typeof v.constraint !== 'string' || !CONSTRAINTS.includes(v.constraint)) return null;
  const unit = UNITS[v.constraint] ?? 'mm';
  if (v.unit !== unit || !numOrNull(v.min) || !numOrNull(v.opt) || !numOrNull(v.max)) return null;
  if (unit === 'none' && (v.min !== null || v.opt !== null || v.max !== null)) return null;
  if (typeof v.verdict !== 'string' || !(VERDICTS[v.constraint] ?? ['']).includes(v.verdict)) return null;
  if (typeof v.source !== 'string' || !SOURCES.includes(v.source) || !isText(v.name) || !isText(v.condition, CONDITION_MAX)) return null;
  if (typeof v.layer !== 'string' || !(v.layer === '' || LAYER_RE.test(v.layer))) return null;
  if (!Array.isArray(v.items) || v.items.length < 1 || v.items.length > 2) return null;
  const items: RuleRecord['items'] = [];
  for (const it of v.items as unknown[]) {
    if (!isObj(it) || !exactKeys(it, ['uuid', 'netclass']) || typeof it.uuid !== 'string' || !UUID_RE.test(it.uuid) || !isText(it.netclass)) return null;
    items.push({ uuid: it.uuid, netclass: it.netclass });
  }
  return {
    constraint: v.constraint as RuleConstraint, unit, min: v.min, opt: v.opt, max: v.max,
    verdict: v.verdict as RuleVerdict, source: v.source as RuleRecord['source'], name: v.name, condition: v.condition, layer: v.layer, items,
  };
}

/**
 * kicadResolveRules' answer read closed: the records and notes, or the
 * engine's own error (`not_found`, `rules_invalid`); null for the empty
 * answer and any other shape.
 */
export function readRules(text: unknown): RulesAnswer | null {
  if (typeof text !== 'string' || text === '') return null;
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (!isObj(v) || !exactKeys(v, ['rules', 'notes', 'error']) || !Array.isArray(v.rules) || !Array.isArray(v.notes)) return null;
  if (v.error !== '' && v.error !== 'not_found' && v.error !== 'rules_invalid') return null;
  if (v.rules.length > MAX_RULES || v.notes.length > MAX_RULE_NOTES || !(v.notes as unknown[]).every((n) => typeof n === 'string')) return null;
  if (v.error !== '') return v.rules.length === 0 ? { error: v.error } : null;
  const rules: RuleRecord[] = [];
  for (const r of v.rules as unknown[]) {
    const rec = readRecord(r);
    if (rec == null) return null;
    rules.push(rec);
  }
  return { rules, notes: (v.notes as string[]).map((n) => cut(n)) };
}
