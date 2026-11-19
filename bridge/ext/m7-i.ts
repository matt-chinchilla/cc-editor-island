// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// m7-i (PROTOCOL.md settings.get, settings.set and board.tuningSolve): the
// Setup panels KiCad's two Setup windows still held, read and set with no
// KiCad window, and the Tuning Profiles panel's "work out" for one row.
//
// Eight sections join settings.get and settings.set (engine run 15, unit
// m7-e): zoneDefaults, zoneHatchOffsets, boardFormatting, tuningPatterns,
// componentClasses and tuningProfiles in a pcb frame, annotation and
// bomPresets in a sch frame; the schematic reads componentClasses and never
// sets it (the board editor owns the classes). Each value is checked closed
// here before the engine sees it, the engine reading it whole once more. The
// engine says it takes a section by naming it in kicadSettingsSections()
// (its board half for a pcb frame, its schematic half for a sch frame): the
// cap settings:<section> is listed exactly then, and on any other engine a
// read or a set of the section answers unsupported naming what is missing.
//
// board.tuningSolve calls kicadTuningSolve: the width, the gap or the delay
// KiCad works out for a target impedance over the board's stackup. A read:
// no record, no undo step, nothing changed.
import { fail, hasAll, isObj, ok, refused, type Answer, type ExtUnit, type ResponderCtx, type SettingsSection } from './contract';
import { parseSettingsGetArgs, parseSettingsSetArgs, type ExtraSections } from '../settings';

/** The engine marker that lists the settings sections it takes (engine run 15). */
export const SECTIONS_EXPORT = 'kicadSettingsSections';
/** The export board.tuningSolve calls (engine run 15, merged image only). */
export const SOLVE_EXPORTS = ['kicadTuningSolve'] as const;
/** The cap a host gates its Work out press on. */
export const SOLVE_CAP = 'tuningSolve';

export const BOARD_SECTIONS = ['zoneDefaults', 'zoneHatchOffsets', 'boardFormatting', 'tuningPatterns', 'componentClasses', 'tuningProfiles'] as const;
export const SCHEMATIC_SECTIONS = ['annotation', 'bomPresets', 'componentClasses'] as const;
export const M7_SECTIONS = ['zoneDefaults', 'zoneHatchOffsets', 'boardFormatting', 'tuningPatterns', 'componentClasses', 'tuningProfiles', 'annotation', 'bomPresets'] as const;
export type M7Section = (typeof M7_SECTIONS)[number];
/** The caps, one per section. */
export const M7_CAPS = M7_SECTIONS.map((s) => `settings:${s}`);

/** KiCad's 17 zone default keys (project board.design_settings.defaults.zones). */
export const ZONE_DEFAULT_KEYS = [
  'min_clearance', 'min_thickness', 'fill_mode', 'hatch_thickness', 'hatch_gap', 'hatch_orientation', 'hatch_smoothing_level',
  'hatch_smoothing_value', 'border_display_style', 'border_hatch_pitch', 'thermal_relief_gap', 'thermal_relief_spoke_width',
  'pad_connection', 'corner_smoothing', 'corner_radius', 'remove_islands', 'min_island_area',
] as const;
export const FORMATTING_FLAGS = ['applyToFields', 'applyToText', 'applyToShapes', 'applyToDimensions', 'applyToBarcodes'] as const;
export const FORMATTING_RATIOS = ['dashRatio', 'gapRatio'] as const;
export const TUNING_PATTERN_KEYS = ['single_track_defaults', 'diff_pair_defaults', 'diff_pair_skew_defaults'] as const;
export const TUNING_PATTERN_FIELDS = ['min_amplitude', 'max_amplitude', 'spacing', 'corner_style', 'corner_radius_percentage', 'single_sided'] as const;
export const COMPONENT_CLASS_KEYS = ['sheet_component_classes.enabled', 'assignments'] as const;
/** KiCad's seven condition names; a key is one of them, alone or with -<n>. */
export const CONDITION_TYPES = ['REFERENCE', 'FOOTPRINT', 'SIDE', 'ROTATION', 'FOOTPRINT_FIELD', 'CUSTOM', 'SHEET_NAME'] as const;
export const ANNOTATION_KEYS = ['annotation.sort_order', 'annotation.method', 'annotate_start_num', 'reuse_designators'] as const;
export const BOM_KEYS = ['bom_presets', 'bom_fmt_presets', 'bom_settings', 'bom_fmt_settings'] as const;
/** The engine's bounds. */
export const MAX_ASSIGNMENTS = 4096;
export const MAX_PROFILES = 256;
export const MAX_PRESETS = 1024;
export const MAX_COPPER_LAYERS = 32;
export const MAX_LENGTH_MM = 1000;
export const MAX_START_NUM = 999_999;
export const MAX_IMPEDANCE = 1e6;

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const plain = (v: unknown): v is Record<string, unknown> =>
  isObj(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const keysIn = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).every((k) => keys.includes(k));
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).length === keys.length && keys.every((k) => own(o, k));
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const atLeast0 = (v: unknown): v is number => finite(v) && v >= 0;
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
/** A copper layer's canonical name: F.Cu, In1.Cu to In30.Cu, B.Cu. */
export const COPPER_RE = /^(F|B|In([1-9]|[12][0-9]|30))\.Cu$/;
const copper = (v: unknown): v is string => typeof v === 'string' && COPPER_RE.test(v);

/** zoneDefaults: KiCad's keys, numbers only, none negative but hatch_orientation. */
export function zoneDefaultsOk(v: Readonly<Record<string, unknown>>): boolean {
  return keysIn(v, ZONE_DEFAULT_KEYS) && Object.entries(v).every(([k, x]) => (k === 'hatch_orientation' ? finite(x) : atLeast0(x)));
}

/** zoneHatchOffsets: exactly `{ layers }`, each `{ layer, offset: [x, y] | null }`, a copper layer once, within 1,000 mm. */
export function zoneHatchOffsetsOk(v: Readonly<Record<string, unknown>>): boolean {
  if (!exactKeys(v, ['layers']) || !Array.isArray(v.layers) || v.layers.length > MAX_COPPER_LAYERS) return false;
  const seen = new Set<string>();
  for (const row of v.layers) {
    if (!plain(row) || !exactKeys(row, ['layer', 'offset']) || !copper(row.layer) || seen.has(row.layer)) return false;
    seen.add(row.layer);
    const o = row.offset;
    if (o === null) continue;
    if (!Array.isArray(o) || o.length !== 2 || !o.every((x) => finite(x) && Math.abs(x) <= MAX_LENGTH_MM)) return false;
  }
  return true;
}

/** boardFormatting: the five switches and the two ratios, over 0 and at most 1,000. */
export function boardFormattingOk(v: Readonly<Record<string, unknown>>): boolean {
  return keysIn(v, [...FORMATTING_FLAGS, ...FORMATTING_RATIOS]) && Object.entries(v).every(([k, x]) =>
    ((FORMATTING_FLAGS as readonly string[]).includes(k) ? typeof x === 'boolean' : finite(x) && x > 0 && x <= MAX_LENGTH_MM));
}

/** tuningPatterns: any of the three objects, each a patch of its six keys. */
export function tuningPatternsOk(v: Readonly<Record<string, unknown>>): boolean {
  if (!keysIn(v, TUNING_PATTERN_KEYS)) return false;
  return Object.values(v).every((p) => plain(p) && Object.keys(p).length > 0 && keysIn(p, TUNING_PATTERN_FIELDS) && Object.entries(p).every(([k, x]) => {
    switch (k) {
      case 'corner_style': return x === 0 || x === 1;
      case 'corner_radius_percentage': return integer(x) && x >= 0 && x <= 100;
      case 'single_sided': return typeof x === 'boolean';
      default: return atLeast0(x) && x <= MAX_LENGTH_MM;
    }
  }));
}

/** One condition key: one of KiCad's seven names, alone or with -<n>. */
export const conditionKeyOk = (k: string): boolean => {
  const dash = k.indexOf('-');
  const type = dash < 0 ? k : k.slice(0, dash);
  return (CONDITION_TYPES as readonly string[]).includes(type) && (dash < 0 || /^[0-9]+$/.test(k.slice(dash + 1)));
};

/** componentClasses: the sheet switch and the assignments, each closed. */
export function componentClassesOk(v: Readonly<Record<string, unknown>>): boolean {
  if (!keysIn(v, COMPONENT_CLASS_KEYS)) return false;
  if (own(v, 'sheet_component_classes.enabled') && typeof v['sheet_component_classes.enabled'] !== 'boolean') return false;
  if (!own(v, 'assignments')) return true;
  const list = v.assignments;
  if (!Array.isArray(list) || list.length > MAX_ASSIGNMENTS) return false;
  return list.every((a) => plain(a) && exactKeys(a, ['component_class', 'conditions_operator', 'conditions'])
    && typeof a.component_class === 'string' && a.component_class !== ''
    && (a.conditions_operator === 'ALL' || a.conditions_operator === 'ANY')
    && plain(a.conditions) && Object.entries(a.conditions).every(([k, c]) => conditionKeyOk(k) && plain(c)
      && keysIn(c, ['primary', 'secondary']) && Object.values(c).every((s) => typeof s === 'string')));
}

/** tuningProfiles: exactly `{ tuning_profiles_impedance_geometric }`, a list of profiles (KiCad's JSON, read whole by the engine). */
export function tuningProfilesOk(v: Readonly<Record<string, unknown>>): boolean {
  const list = v.tuning_profiles_impedance_geometric;
  return exactKeys(v, ['tuning_profiles_impedance_geometric']) && Array.isArray(list) && list.length <= MAX_PROFILES && list.every((p) => plain(p));
}

/** annotation: sort order 0 or 1, method 0 to 2, start 0 to 999,999, reuse a switch. */
export function annotationOk(v: Readonly<Record<string, unknown>>): boolean {
  return keysIn(v, ANNOTATION_KEYS) && Object.entries(v).every(([k, x]) => {
    switch (k) {
      case 'annotation.sort_order': return x === 0 || x === 1;
      case 'annotation.method': return x === 0 || x === 1 || x === 2;
      case 'annotate_start_num': return integer(x) && x >= 0 && x <= MAX_START_NUM;
      default: return typeof x === 'boolean';
    }
  });
}

/** bomPresets: the two preset lists (each replaced whole) and the two current settings objects. */
export function bomPresetsOk(v: Readonly<Record<string, unknown>>): boolean {
  return keysIn(v, BOM_KEYS) && Object.entries(v).every(([k, x]) => (k === 'bom_presets' || k === 'bom_fmt_presets'
    ? Array.isArray(x) && x.length <= MAX_PRESETS && x.every((p) => plain(p))
    : plain(x)));
}

/** The eight sections as settings.get and settings.set take them. */
export const M7_SETTINGS_SECTIONS: Readonly<Record<M7Section, SettingsSection>> = {
  zoneDefaults: { frames: ['pcb'], projectFile: true, check: zoneDefaultsOk },
  zoneHatchOffsets: { frames: ['pcb'], check: zoneHatchOffsetsOk },
  boardFormatting: { frames: ['pcb'], projectFile: true, check: boardFormattingOk },
  tuningPatterns: { frames: ['pcb'], projectFile: true, check: tuningPatternsOk },
  componentClasses: { frames: ['pcb', 'sch'], projectFile: true, check: componentClassesOk },
  tuningProfiles: { frames: ['pcb'], projectFile: true, check: tuningProfilesOk },
  annotation: { frames: ['sch'], projectFile: true, check: annotationOk },
  bomPresets: { frames: ['sch'], projectFile: true, check: bomPresetsOk },
};
const EXTRA: ExtraSections = new Map(Object.entries(M7_SETTINGS_SECTIONS));
const isM7 = (s: unknown): s is M7Section => typeof s === 'string' && (M7_SECTIONS as readonly string[]).includes(s);

/**
 * The sections the engine says it takes in this frame's kind:
 * kicadSettingsSections() answers `{ board: [names], schematic: [names] }`.
 * Null when the engine has no such marker or answers another shape.
 */
export function engineSections(mod: Record<string, unknown> | null | undefined, frame: string): string[] | null {
  const read = mod?.[SECTIONS_EXPORT];
  if (typeof read !== 'function' || (frame !== 'pcb' && frame !== 'sch')) return null;
  let v: unknown;
  try { v = JSON.parse(String((read as () => unknown)())); } catch { return null; }
  const half = isObj(v) ? v[frame === 'pcb' ? 'board' : 'schematic'] : null;
  return Array.isArray(half) && half.every((s) => typeof s === 'string') ? (half as string[]) : null;
}

/** The caps to list: settings:<section> for each of the eight sections this frame holds and the engine names, and tuningSolve. */
export function m7Caps(mod: Record<string, unknown> | null | undefined, frame: string): string[] {
  const named = engineSections(mod, frame) ?? [];
  const caps = M7_SECTIONS.filter((s) => (M7_SETTINGS_SECTIONS[s].frames as readonly string[]).includes(frame) && named.includes(s)).map((s) => `settings:${s}`);
  if (frame === 'pcb' && hasAll(mod, SOLVE_EXPORTS)) caps.push(SOLVE_CAP);
  return caps;
}

/**
 * The engine's refusal for a section of this unit, or null to go on: in a
 * frame that holds the section with the engine up, unsupported naming the
 * marker when it is missing (run 14) or the section when the marker does not
 * list it. Any other state goes on to the op, which answers it.
 */
function engineRefusal(section: M7Section, ctx: ResponderCtx): Answer | null {
  if (!(M7_SETTINGS_SECTIONS[section].frames as readonly string[]).includes(ctx.frame)) return null;
  const mod = ctx.mod();
  if (mod == null) return null;
  if (typeof mod[SECTIONS_EXPORT] !== 'function') return fail('unsupported', SECTIONS_EXPORT);
  if (!(engineSections(mod, ctx.frame) ?? []).includes(section)) return fail('unsupported', section);
  return null;
}

/** The widening of settings.get: a read of one of the eight sections, checked against the engine first. */
export async function widenSettingsGet(args: unknown, ctx: ResponderCtx, next: (args: unknown) => Promise<Answer>): Promise<Answer> {
  if (!isObj(args) || !isM7(args.section)) return next(args);
  const a = parseSettingsGetArgs(args, EXTRA);
  if (a == null) return fail('bad_args', 'settings.get');
  return engineRefusal(a.section as M7Section, ctx) ?? next(args);
}

/**
 * The widening of settings.set: a set of one of the eight sections is read
 * closed (bad_args), then in a sch frame componentClasses is refused (the
 * board editor sets the classes), then the engine is checked; then the op as
 * it ships makes its own checks and the set.
 */
export async function widenSettingsSet(args: unknown, ctx: ResponderCtx, next: (args: unknown) => Promise<Answer>): Promise<Answer> {
  if (!isObj(args) || !isM7(args.section)) return next(args);
  const a = parseSettingsSetArgs(args, EXTRA);
  if (a == null) return fail('bad_args', 'settings.set');
  if (ctx.frame === 'sch' && a.section === 'componentClasses') return fail('unsupported', 'the schematic reads componentClasses and never sets it');
  return engineRefusal(a.section as M7Section, ctx) ?? next(a);
}

export interface TuningSolveArgs {
  type: 'single' | 'differential';
  impedance: number;
  signalLayer: string;
  topRef?: string;
  bottomRef?: string;
  solveFor: 'width' | 'gap' | 'delay';
  width?: number;
  gap?: number;
}
export interface TuningSolveAnswer { width: number | null; gap: number | null; delay: number | null; problem: string }
const SOLVE_KEYS = ['type', 'impedance', 'signalLayer', 'topRef', 'bottomRef', 'solveFor', 'width', 'gap'] as const;
const PROBLEM_MAX = 2048;

/**
 * board.tuningSolve's args read closed: `type` single or differential,
 * `impedance` ohms over 0 (at most 1e6), `signalLayer` and the optional
 * `topRef` and `bottomRef` copper layer names, `solveFor` width, gap or delay,
 * the optional `width` and `gap` in mm over 0 (at most 1,000). A gap, asked or
 * given, is a pair's only. Null for anything else.
 */
export function parseSolveArgs(args: unknown): TuningSolveArgs | null {
  if (!plain(args) || !keysIn(args, SOLVE_KEYS)) return null;
  const { type, impedance, signalLayer, topRef, bottomRef, solveFor, width, gap } = args;
  if (type !== 'single' && type !== 'differential') return null;
  if (!finite(impedance) || impedance <= 0 || impedance > MAX_IMPEDANCE) return null;
  if (!copper(signalLayer)) return null;
  if (solveFor !== 'width' && solveFor !== 'gap' && solveFor !== 'delay') return null;
  const out: TuningSolveArgs = { type, impedance, signalLayer, solveFor };
  for (const [k, l] of [['topRef', topRef], ['bottomRef', bottomRef]] as const) {
    if (!own(args, k)) continue;
    if (!copper(l)) return null;
    out[k] = l;
  }
  for (const [k, m] of [['width', width], ['gap', gap]] as const) {
    if (!own(args, k)) continue;
    if (!finite(m) || m <= 0 || m > MAX_LENGTH_MM) return null;
    out[k] = m;
  }
  if (type === 'single' && (solveFor === 'gap' || own(args, 'gap'))) return null;
  return out;
}

/** kicadTuningSolve's answer read closed: exactly `{ width, gap, delay, problem }`; null for "" and any other shape. */
export function readSolve(raw: unknown): TuningSolveAnswer | null {
  if (typeof raw !== 'string' || raw === '') return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!plain(v) || !exactKeys(v, ['width', 'gap', 'delay', 'problem'])) return null;
  const num = (x: unknown) => x === null || finite(x);
  if (!num(v.width) || !num(v.gap) || !num(v.delay) || typeof v.problem !== 'string' || v.problem.length > PROBLEM_MAX) return null;
  return { width: v.width as number | null, gap: v.gap as number | null, delay: v.delay as number | null, problem: v.problem };
}

/**
 * board.tuningSolve: the checks in order (the args, then as every board op:
 * the frame, the engine, a board open, busy), then one call of
 * kicadTuningSolve. The engine answers "" for args it does not take (a layer
 * the board does not enable, a reference that is no copper layer): bad_args.
 */
function tuningSolve(args: unknown, ctx: ResponderCtx): Answer {
  const op = 'board.tuningSolve';
  const a = parseSolveArgs(args);
  if (a == null) return fail('bad_args', op);
  const g = ctx.boardGate(op, SOLVE_EXPORTS);
  if (refused(g)) return g;
  let raw: unknown;
  try { raw = (g.mod.kicadTuningSolve as (json: string) => unknown)(JSON.stringify(a)); } catch { return fail('island_error', 'the engine could not work out the row'); }
  if (raw === '') return fail('bad_args', op);
  const answer = readSolve(raw);
  if (answer == null) return fail('island_error', 'the engine answered a solve of another shape');
  return ok({ ...answer });
}

export default {
  unit: 'm7-i',
  frames: ['pcb', 'sch'],
  frameRefusal: 'a board op runs in a pcb frame',
  opsWidened: { 'settings.get': widenSettingsGet, 'settings.set': widenSettingsSet },
  settingsSections: M7_SETTINGS_SECTIONS,
  capNames: [...M7_CAPS, SOLVE_CAP],
  caps: m7Caps,
  ops: {
    'board.tuningSolve': { run: tuningSolve, passesCheck: true },
  },
} satisfies ExtUnit;
