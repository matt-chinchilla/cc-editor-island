// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// symbol.get and symbol.set (PROTOCOL.md): one symbol's fields, flags and
// drawing read and changed by uuid with no KiCad dialog, through our engine's
// kicadSymbolGet and kicadSymbolSet (pcbjam cc/main e8b2abe; engine run 10
// serves them). The get is a synchronous read of the editor's own document
// (unsaved edits included); the set queues ONE commit on the editor's apply
// coroutine (one undo step) and answers before it runs, so the island waits for
// the apply queue to empty and reads the symbol back.

/** The engine exports the ops need: the read, the write, the apply queue probe. */
export const SYMBOL_EXPORTS = ['kicadSymbolGet', 'kicadSymbolSet', 'kicadCollabBusy'] as const;

/** A uuid as KiCad spells it: lower case 8-4-4-4-12 hexadecimal digits. */
export const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const UUID_RE = new RegExp(`^${UUID}$`);
/** A sheet path in project.open's form: "/" for the root, then one uuid and a slash per level, at most 64 levels. */
export const SHEET_PATH_RE = new RegExp(`^/(?:${UUID}/){0,64}$`);

/** The bounds the engine reads a set against (Editing window spec 11.2). */
export const REF_MAX = 64;
export const TEXT_MAX = 1024;
export const FIELD_NAME_MAX = 128;
export const SET_FIELDS_MAX = 64;
export const POSITION_MAX_MM = 50_000;
/** KiCad letters units A to ZZ: a sheet never names more. */
export const UNITS_MAX = 676;
/** At most this many fields taken from one answer, and this many footprint filters. */
export const SHEET_FIELDS_MAX = 256;
export const FILTERS_MAX = 256;

export type FieldKind = 'reference' | 'value' | 'footprint' | 'datasheet' | 'description' | 'user';
export type Rotation = 0 | 90 | 180 | 270;
export type Mirror = 'none' | 'x' | 'y';
export interface SymbolField { name: string; value: string; shown: boolean; kind: FieldKind }
/**
 * symbol.get's and symbol.set's answer, the engine's JSON read closed: the
 * Editing window spec's SymbolSheet (6.2) and `filters`, the footprint filters
 * of the symbol's own definition (KiCad's chooser ranks the footprints they
 * match first).
 */
export interface SymbolSheet {
  uuid: string; sheetPath: string; sheetName: string;
  ref: string; value: string; footprint: string; libId: string;
  fields: SymbolField[];
  inBom: boolean; onBoard: boolean; inSim: boolean; dnp: boolean;
  rotation: Rotation; mirror: Mirror;
  x: number; y: number;
  unit: number; units: number;
  bodyStyle: 1 | 2; bodyStyles: 1 | 2;
  filters: string[];
}
export interface FieldSet { name: string; value?: string; shown?: boolean }
export interface SymbolSet {
  ref?: string; value?: string; footprint?: string;
  fields?: FieldSet[];
  addField?: { name: string; value: string; shown: boolean };
  removeField?: string;
  inBom?: boolean; onBoard?: boolean; inSim?: boolean; dnp?: boolean;
  rotation?: Rotation; mirror?: Mirror;
  x?: number; y?: number;
  unit?: number; bodyStyle?: 1 | 2;
}
export interface SymbolGetArgs { uuid: string; sheetPath?: string }
export interface SymbolSetArgs { uuid: string; sheetPath: string; set: SymbolSet }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keysWithin = (o: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(o).every((k) => allowed.includes(k));
const FIELD_KINDS: readonly string[] = ['reference', 'value', 'footprint', 'datasheet', 'description', 'user'];
const ROTATIONS: readonly unknown[] = [0, 90, 180, 270];
const MIRRORS: readonly unknown[] = ['none', 'x', 'y'];
// A NUL, or a lone surrogate (no UTF-8 spelling: the engine's UTF-8 read refuses it).
const UNSPELLABLE_RE = /\0|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** Text of `min` to `max` characters (code points, as the engine counts) with a UTF-8 spelling. */
function bounded(v: unknown, min: number, max: number): v is string {
  if (typeof v !== 'string' || UNSPELLABLE_RE.test(v)) return false;
  const n = [...v].length;
  return n >= min && n <= max;
}
/** As bounded, with no control character (a designator, a new field's name). */
const named = (v: unknown, min: number, max: number): v is string => bounded(v, min, max) && !CONTROL_RE.test(v);
/** A footprint as KiCad's LIB_ID reads one: "lib:name", both halves present; or '' for none. */
export function isFootprintId(v: unknown): v is string {
  if (!bounded(v, 0, TEXT_MAX)) return false;
  if (v === '') return true;
  if (CONTROL_RE.test(v)) return false;
  const colon = v.indexOf(':');
  return colon > 0 && colon < v.length - 1 && !v.slice(colon + 1).includes(':');
}

/** symbol.get's args: `{ uuid, sheetPath? }`; null for anything else. */
export function parseSymbolGetArgs(args: unknown): SymbolGetArgs | null {
  if (!isObj(args) || !keysWithin(args, ['uuid', 'sheetPath']) || typeof args.uuid !== 'string' || !UUID_RE.test(args.uuid)) return null;
  if (args.sheetPath === undefined) return { uuid: args.uuid };
  if (typeof args.sheetPath !== 'string' || !SHEET_PATH_RE.test(args.sheetPath)) return null;
  return { uuid: args.uuid, sheetPath: args.sheetPath };
}

function parseFieldSet(v: unknown): FieldSet | null {
  if (!isObj(v) || !keysWithin(v, ['name', 'value', 'shown']) || !bounded(v.name, 1, FIELD_NAME_MAX)) return null;
  if (v.value === undefined && v.shown === undefined) return null;
  if (v.value !== undefined && !bounded(v.value, 0, TEXT_MAX)) return null;
  if (v.shown !== undefined && typeof v.shown !== 'boolean') return null;
  const out: FieldSet = { name: v.name };
  if (v.value !== undefined) out.value = v.value as string;
  if (v.shown !== undefined) out.shown = v.shown as boolean;
  // The designator and the footprint keep their own rules when set by name.
  if (out.name === 'Reference' && out.value !== undefined && !named(out.value, 1, REF_MAX)) return null;
  if (out.name === 'Footprint' && out.value !== undefined && !isFootprintId(out.value)) return null;
  return out;
}

const SET_KEYS = ['ref', 'value', 'footprint', 'fields', 'addField', 'removeField', 'inBom', 'onBoard', 'inSim', 'dnp', 'rotation', 'mirror', 'x', 'y', 'unit', 'bodyStyle'] as const;

/** A set as spec 11.2 bounds it, at least one key; null for any other key, type or bound, and for one thing changed twice. */
export function parseSymbolSet(set: unknown): SymbolSet | null {
  if (!isObj(set) || Object.keys(set).length === 0 || !keysWithin(set, SET_KEYS)) return null;
  const out: SymbolSet = {};
  for (const key of Object.keys(set) as Array<(typeof SET_KEYS)[number]>) {
    const v = set[key];
    switch (key) {
      case 'ref': if (!named(v, 1, REF_MAX)) return null; out.ref = v; break;
      case 'value': if (!bounded(v, 0, TEXT_MAX)) return null; out.value = v; break;
      case 'footprint': if (!isFootprintId(v)) return null; out.footprint = v; break;
      case 'fields': {
        if (!Array.isArray(v) || v.length === 0 || v.length > SET_FIELDS_MAX) return null;
        const fields: FieldSet[] = [];
        for (const f of v as unknown[]) {
          const field = parseFieldSet(f);
          if (field == null || fields.some((g) => g.name === field.name)) return null;
          fields.push(field);
        }
        out.fields = fields;
        break;
      }
      case 'addField':
        if (!isObj(v) || Object.keys(v).length !== 3 || !keysWithin(v, ['name', 'value', 'shown'])) return null;
        if (!named(v.name, 1, FIELD_NAME_MAX) || !bounded(v.value, 0, TEXT_MAX) || typeof v.shown !== 'boolean') return null;
        out.addField = { name: v.name, value: v.value, shown: v.shown };
        break;
      case 'removeField': if (!bounded(v, 1, FIELD_NAME_MAX)) return null; out.removeField = v; break;
      case 'inBom': case 'onBoard': case 'inSim': case 'dnp':
        if (typeof v !== 'boolean') return null;
        out[key] = v;
        break;
      case 'rotation': if (!ROTATIONS.includes(v)) return null; out.rotation = v as Rotation; break;
      case 'mirror': if (!MIRRORS.includes(v)) return null; out.mirror = v as Mirror; break;
      case 'x': case 'y':
        if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > POSITION_MAX_MM) return null;
        out[key] = v;
        break;
      case 'unit': if (!Number.isSafeInteger(v) || (v as number) < 1 || (v as number) > UNITS_MAX) return null; out.unit = v as number; break;
      case 'bodyStyle': if (v !== 1 && v !== 2) return null; out.bodyStyle = v; break;
    }
  }
  // One change per thing (the engine's rule): a field by its own key and in fields, removed and changed, removed and added.
  const inFields = new Set((out.fields ?? []).map((f) => f.name));
  if ((out.ref !== undefined && inFields.has('Reference')) || (out.value !== undefined && inFields.has('Value')) || (out.footprint !== undefined && inFields.has('Footprint'))) return null;
  if (out.removeField !== undefined && (inFields.has(out.removeField) || (out.addField != null && out.addField.name.toLowerCase() === out.removeField.toLowerCase()))) return null;
  return out;
}

/** symbol.set's args: exactly `{ uuid, sheetPath, set }`; null for anything else. */
export function parseSymbolSetArgs(args: unknown): SymbolSetArgs | null {
  if (!isObj(args) || Object.keys(args).length !== 3 || !keysWithin(args, ['uuid', 'sheetPath', 'set'])) return null;
  if (typeof args.uuid !== 'string' || !UUID_RE.test(args.uuid) || typeof args.sheetPath !== 'string' || !SHEET_PATH_RE.test(args.sheetPath)) return null;
  const set = parseSymbolSet(args.set);
  return set == null ? null : { uuid: args.uuid, sheetPath: args.sheetPath, set };
}

/** The args as kicadSymbolSet reads them. */
export const symbolSetJson = (a: SymbolSetArgs): string => JSON.stringify({ uuid: a.uuid, sheetPath: a.sheetPath, set: a.set });

const SHEET_KEYS = ['uuid', 'sheetPath', 'sheetName', 'ref', 'value', 'footprint', 'libId', 'fields', 'inBom', 'onBoard', 'inSim', 'dnp', 'rotation', 'mirror', 'x', 'y', 'unit', 'units', 'bodyStyle', 'bodyStyles', 'filters'];
const isText = (v: unknown): v is string => typeof v === 'string';

/**
 * kicadSymbolGet's answer read closed: null for the empty answer (no such
 * symbol) and for JSON of any other shape. The engine's own texts are passed
 * as they are; only the shape is checked.
 */
export function readSymbolSheet(text: unknown): SymbolSheet | null {
  if (typeof text !== 'string' || text === '') return null;
  let r: unknown;
  try { r = JSON.parse(text); } catch { return null; }
  if (!isObj(r) || Object.keys(r).length !== SHEET_KEYS.length || !keysWithin(r, SHEET_KEYS)) return null;
  if (!isText(r.uuid) || !UUID_RE.test(r.uuid) || !isText(r.sheetPath) || !SHEET_PATH_RE.test(r.sheetPath)) return null;
  if (![r.sheetName, r.ref, r.value, r.footprint, r.libId].every(isText)) return null;
  if (!Array.isArray(r.fields) || r.fields.length > SHEET_FIELDS_MAX) return null;
  const fields: SymbolField[] = [];
  for (const f of r.fields as unknown[]) {
    if (!isObj(f) || Object.keys(f).length !== 4 || !keysWithin(f, ['name', 'value', 'shown', 'kind'])) return null;
    if (!isText(f.name) || f.name === '' || !isText(f.value) || typeof f.shown !== 'boolean' || !FIELD_KINDS.includes(f.kind as string)) return null;
    fields.push({ name: f.name, value: f.value, shown: f.shown, kind: f.kind as FieldKind });
  }
  if (![r.inBom, r.onBoard, r.inSim, r.dnp].every((v) => typeof v === 'boolean')) return null;
  if (!ROTATIONS.includes(r.rotation) || !MIRRORS.includes(r.mirror)) return null;
  if (typeof r.x !== 'number' || !Number.isFinite(r.x) || typeof r.y !== 'number' || !Number.isFinite(r.y)) return null;
  const units = r.units, unit = r.unit;
  if (!Number.isSafeInteger(units) || (units as number) < 1 || (units as number) > UNITS_MAX) return null;
  if (!Number.isSafeInteger(unit) || (unit as number) < 1 || (unit as number) > (units as number)) return null;
  if ((r.bodyStyles !== 1 && r.bodyStyles !== 2) || (r.bodyStyle !== 1 && r.bodyStyle !== 2) || r.bodyStyle > r.bodyStyles) return null;
  if (!Array.isArray(r.filters) || r.filters.length > FILTERS_MAX || !r.filters.every(isText)) return null;
  return {
    uuid: r.uuid, sheetPath: r.sheetPath, sheetName: r.sheetName as string,
    ref: r.ref as string, value: r.value as string, footprint: r.footprint as string, libId: r.libId as string,
    fields,
    inBom: r.inBom as boolean, onBoard: r.onBoard as boolean, inSim: r.inSim as boolean, dnp: r.dnp as boolean,
    rotation: r.rotation as Rotation, mirror: r.mirror as Mirror,
    x: r.x, y: r.y,
    unit: unit as number, units: units as number,
    bodyStyle: r.bodyStyle, bodyStyles: r.bodyStyles,
    filters: [...(r.filters as string[])],
  };
}

/**
 * An orientation in one spelling: KiCad decomposes a transform with a mirror
 * across Y as the mirror across X turned 180 degrees more (a set of mirror y at
 * 90 reads back as mirror x at 270), so both spell the same drawing.
 */
export function sameOrientation(a: { rotation: Rotation; mirror: Mirror }, b: { rotation: Rotation; mirror: Mirror }): boolean {
  const canon = (o: { rotation: Rotation; mirror: Mirror }): string => (o.mirror === 'y' ? `${(o.rotation + 180) % 360} x` : `${o.rotation} ${o.mirror}`);
  return canon(a) === canon(b);
}

/** Positions read back rounded to 4 decimals (mm) from the engine's nanometers. */
const sameMm = (asked: number, got: number): boolean => Math.abs(asked - got) <= 0.00015;

/**
 * Does the read back show every change the set asked for? `before` is the
 * sheet read before the set: the half of an orientation not asked for keeps
 * its reading there.
 */
export function showsSet(set: SymbolSet, before: SymbolSheet, after: SymbolSheet): boolean {
  const field = (name: string): SymbolField | undefined => after.fields.find((f) => f.name === name);
  if (set.ref !== undefined && after.ref !== set.ref) return false;
  if (set.value !== undefined && after.value !== set.value) return false;
  if (set.footprint !== undefined && after.footprint !== set.footprint) return false;
  for (const f of set.fields ?? []) {
    const got = field(f.name);
    if (got == null || (f.value !== undefined && got.value !== f.value) || (f.shown !== undefined && got.shown !== f.shown)) return false;
  }
  if (set.addField != null) {
    const got = field(set.addField.name);
    if (got == null || got.value !== set.addField.value || got.shown !== set.addField.shown) return false;
  }
  if (set.removeField !== undefined && field(set.removeField) != null) return false;
  for (const k of ['inBom', 'onBoard', 'inSim', 'dnp'] as const) if (set[k] !== undefined && after[k] !== set[k]) return false;
  if (set.rotation !== undefined || set.mirror !== undefined) {
    const asked = { rotation: set.rotation ?? before.rotation, mirror: set.mirror ?? before.mirror };
    if (!sameOrientation(asked, after)) return false;
  }
  if (set.x !== undefined && !sameMm(set.x, after.x)) return false;
  if (set.y !== undefined && !sameMm(set.y, after.y)) return false;
  if (set.unit !== undefined && after.unit !== set.unit) return false;
  if (set.bodyStyle !== undefined && after.bodyStyle !== set.bodyStyle) return false;
  return true;
}

/**
 * Why a set cannot apply to this symbol, or null when it can: the bounds that
 * depend on the symbol itself (spec 11.2), read against the sheet before the
 * set. A field changed or removed must exist (by KiCad's own name, in its
 * casing), a removed one must be a user field, a new field's name must be
 * unused in any casing, the unit within the symbol's units and the drawing
 * within its drawings.
 */
export function misfit(set: SymbolSet, before: SymbolSheet): string | null {
  const has = (name: string): SymbolField | undefined => before.fields.find((f) => f.name === name);
  for (const f of set.fields ?? []) if (has(f.name) == null) return `no field ${f.name}`;
  if (set.removeField !== undefined) {
    const f = has(set.removeField);
    if (f == null) return `no field ${set.removeField}`;
    if (f.kind !== 'user') return `${set.removeField} is not a user field`;
  }
  if (set.addField != null) {
    const name = set.addField.name.toLowerCase();
    if (before.fields.some((f) => f.name.toLowerCase() === name)) return `${set.addField.name} is taken`;
  }
  if (set.unit !== undefined && set.unit > before.units) return `unit ${set.unit} of ${before.units}`;
  if (set.bodyStyle !== undefined && set.bodyStyle > before.bodyStyles) return 'the symbol has one drawing';
  return null;
}
