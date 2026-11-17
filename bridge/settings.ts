// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// settings.get and settings.set (PROTOCOL.md): the design's setup, one section
// at a time, read and changed with no Board Setup or Schematic Setup window,
// through our engine's kicadSettingsGet and kicadSettingsSet (engine run 14,
// dispatched to the frame's own editor). Project-file sections travel as
// KiCad's own JSON keys and are set as patches; the board's layers, stackup,
// finish, page and custom rules and the schematic's page, variants and bus
// aliases by their own setters. A set queues on the apply coroutine and
// answers before it runs; the run writes settings.json, then
// .cc-settings.json LAST. KiCad never undoes a setting: no undo step.

import { jsonOf } from './symbols';

/** The engine exports the two ops need: the read, the set, the apply queue probe. */
export const SETTINGS_EXPORTS = ['kicadSettingsGet', 'kicadSettingsSet', 'kicadCollabBusy'] as const;
/** Each set writes into a fresh folder under this one, outside the project folder. */
export const SETTINGS_ROOT = '/tmp/cc-settings';
export const SETTINGS_REPORT = 'settings.json';
export const SETTINGS_DONE = '.cc-settings.json';
/** A set's value: at most this many bytes of JSON (the engine's bound). */
export const MAX_SETTINGS_BYTES = 1 << 20;
/** customRules' text: at most this many bytes of UTF-8 (the engine's bound). */
export const MAX_RULES_BYTES = 256 * 1024;
/** A section read: at most this many bytes of JSON. */
export const MAX_SECTION_BYTES = 8 << 20;
/** At most this many parse errors in one answer. */
export const MAX_RULE_ERRORS = 1024;

/** The sections each frame holds (properties spec 7.4; the engine's own lists). */
export const SCH_SECTIONS: readonly string[] = ['netClasses', 'textVariables', 'variants', 'page', 'schFormatting', 'fieldTemplates', 'busAliases', 'ercSeverities', 'pinMap'];
export const PCB_SECTIONS: readonly string[] = ['netClasses', 'textVariables', 'variants', 'page', 'layers', 'stackup', 'finish', 'textDefaults', 'constraints',
  'predefinedSizes', 'teardrops', 'checkSeverities', 'customRules'];
/** The sections both drawings hold (one copy in each engine): a host sets them in both. */
export const SHARED_SECTIONS: readonly string[] = ['netClasses', 'textVariables'];
/** The sections a pcb frame reads and never sets: the board takes variants through Update the board. */
export const PCB_READ_ONLY: readonly string[] = ['variants'];
/** Project-file sections: a patch never deletes a key, so no null anywhere. */
const PROJECT_FILE_SECTIONS: readonly string[] = ['netClasses', 'schFormatting', 'fieldTemplates', 'ercSeverities', 'pinMap', 'textDefaults', 'constraints',
  'predefinedSizes', 'teardrops', 'checkSeverities'];
/** The variant actions: exactly one per set. */
const VARIANT_ACTIONS = ['add', 'copy', 'rename', 'delete', 'describe', 'current'] as const;

export type SettingsFrame = 'sch' | 'pcb';
export interface SettingsGetArgs { section: string }
export interface SettingsSetArgs { section: string; value: Record<string, unknown>; dryRun?: boolean }
export interface RuleError { line: number; column: number; message: string }
export interface SettingsRecord { value: Record<string, unknown>; errors?: RuleError[]; wouldRemove?: number }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPlain = (v: unknown): v is Record<string, unknown> => isObj(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).length === keys.length && keys.every((k) => own(o, k));
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const utf8Bytes = (s: string): number => new TextEncoder().encode(s).byteLength;
const isName = (v: unknown): v is string => typeof v === 'string' && v !== '' && [...v].length <= 128 && !CONTROL_RE.test(v);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** A JSON value with no null anywhere, and nothing JSON cannot carry. */
function plainJson(v: unknown, nulls: boolean, depth = 0): boolean {
  if (depth > 32) return false;
  if (v === null) return nulls;
  if (typeof v === 'boolean' || typeof v === 'string') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every((x) => plainJson(x, nulls, depth + 1));
  if (isPlain(v)) return Object.values(v).every((x) => plainJson(x, nulls, depth + 1));
  return false;
}

/** Where a section lives: the frames that hold it. */
export function sectionFrames(section: string): SettingsFrame[] {
  return (['sch', 'pcb'] as const).filter((f) => (f === 'sch' ? SCH_SECTIONS : PCB_SECTIONS).includes(section));
}

/** settings.get's args: exactly `{ section }`, a section either frame holds; null otherwise. */
export function parseSettingsGetArgs(args: unknown): SettingsGetArgs | null {
  if (!isObj(args) || !exactKeys(args, ['section']) || typeof args.section !== 'string' || sectionFrames(args.section).length === 0) return null;
  return { section: args.section };
}

/** A variant action: exactly one of add, copy, rename, delete, describe, current. */
function isVariantAction(v: Record<string, unknown>): boolean {
  const keys = Object.keys(v);
  if (keys.length !== 1 || !(VARIANT_ACTIONS as readonly string[]).includes(keys[0])) return false;
  const x = v[keys[0]];
  switch (keys[0]) {
    case 'add': case 'delete': return isName(x);
    case 'current': return x === '' || isName(x);
    case 'copy': case 'rename': return Array.isArray(x) && x.length === 2 && isName(x[0]) && isName(x[1]) && x[0] !== x[1];
    case 'describe': return Array.isArray(x) && x.length === 2 && isName(x[0]) && typeof x[1] === 'string' && [...x[1]].length <= 1024;
  }
  return false;
}

/**
 * settings.set's args: exactly `{ section, value }` and an optional boolean
 * `dryRun`; `value` a plain object of at most 1 MiB of JSON with at least one
 * key, no null in a project-file section's patch, and each other section's
 * own shape: one variant action, `{ text }` for the custom rules (at most 256
 * KiB), `{ aliases }` for the bus aliases, names to text or null (removed) for
 * the text variables. Null for anything else.
 */
export function parseSettingsSetArgs(args: unknown): SettingsSetArgs | null {
  if (!isObj(args) || !Object.keys(args).every((k) => k === 'section' || k === 'value' || k === 'dryRun') || !own(args, 'section') || !own(args, 'value')) return null;
  const { section, value } = args;
  if (typeof section !== 'string' || sectionFrames(section).length === 0) return null;
  if (own(args, 'dryRun') && typeof args.dryRun !== 'boolean') return null;
  if (!isPlain(value) || Object.keys(value).length === 0 || !plainJson(value, true)) return null;
  if (utf8Bytes(JSON.stringify(value)) > MAX_SETTINGS_BYTES) return null;
  if (PROJECT_FILE_SECTIONS.includes(section) && !plainJson(value, false)) return null;
  switch (section) {
    case 'variants': if (!isVariantAction(value)) return null; break;
    case 'customRules': if (!exactKeys(value, ['text']) || typeof value.text !== 'string' || utf8Bytes(value.text) > MAX_RULES_BYTES) return null; break;
    case 'busAliases': if (!exactKeys(value, ['aliases']) || !Array.isArray(value.aliases)) return null; break;
    case 'textVariables':
      if (!Object.entries(value).every(([k, t]) => isName(k) && (t === null || (typeof t === 'string' && [...t].length <= 1024)))) return null;
      break;
  }
  const out: SettingsSetArgs = { section, value: { ...value } };
  if (typeof args.dryRun === 'boolean') out.dryRun = args.dryRun;
  return out;
}

/** The args as kicadSettingsSet reads them, with the run's folder. */
export const settingsSetJson = (run: number, dir: string, a: SettingsSetArgs): string =>
  JSON.stringify(a.dryRun === undefined ? { run, dir, section: a.section, value: a.value } : { run, dir, section: a.section, value: a.value, dryRun: a.dryRun });

/**
 * kicadSettingsGet's answer: the section as one JSON object (KiCad's own keys
 * for a project-file section; read tolerantly by the host), at most 8 MiB;
 * null for the empty answer and any other shape.
 */
export function readSection(text: unknown): Record<string, unknown> | null {
  if (typeof text !== 'string' || text === '' || text.length > MAX_SECTION_BYTES) return null;
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  return isPlain(v) && plainJson(v, true) ? v : null;
}

/** The codes a set's record may carry. */
export const SETTINGS_ERRORS = ['island_error', 'bad_args', 'rules_invalid'] as const;

/** settings.json read closed: `{ value, errors?, wouldRemove? }`; null otherwise. */
export function readSettingsRecord(bytes: Uint8Array | null): SettingsRecord | null {
  const v = jsonOf(bytes);
  if (!isObj(v) || !own(v, 'value') || !Object.keys(v).every((k) => k === 'value' || k === 'errors' || k === 'wouldRemove')) return null;
  if (!isPlain(v.value) || !plainJson(v.value, true)) return null;
  const out: SettingsRecord = { value: v.value };
  if (own(v, 'errors')) {
    if (!Array.isArray(v.errors) || v.errors.length === 0 || v.errors.length > MAX_RULE_ERRORS) return null;
    const errors: RuleError[] = [];
    for (const e of v.errors as unknown[]) {
      if (!isObj(e) || !exactKeys(e, ['line', 'column', 'message']) || !count(e.line) || !count(e.column) || typeof e.message !== 'string' || [...e.message].length > 512) return null;
      errors.push({ line: e.line, column: e.column, message: e.message });
    }
    out.errors = errors;
  }
  if (own(v, 'wouldRemove')) {
    if (!count(v.wouldRemove)) return null;
    out.wouldRemove = v.wouldRemove;
  }
  return out;
}

/** The custom rules file KiCad reads beside a board: the board's stem with `.kicad_dru`. */
export const rulesPathOf = (board: string): string | null => (board.endsWith('.kicad_pcb') ? `${board.slice(0, -'.kicad_pcb'.length)}.kicad_dru` : null);
