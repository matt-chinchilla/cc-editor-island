// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// symbols.get and symbols.set (PROTOCOL.md): every part's fields and flags in
// one table, read and changed with no KiCad window, through our engine's
// kicadSymbolsGet and kicadSymbolsSet (engine run 14, properties spec 5): the
// Symbol Fields Table's model with KiCad 10's design variants. The read is
// synchronous; the set queues ONE commit "Edit fields" on the editor's apply
// coroutine and answers before it runs; the run writes symbols.json, then
// .cc-symbols.json LAST, in its folder.

import { UUID_RE, SHEET_PATH_RE, REF_MAX, TEXT_MAX, FIELD_NAME_MAX, SET_FIELDS_MAX, isFootprintId } from './symbol';

/** The engine exports the two ops need: the read, the set, the apply queue probe. */
export const SYMBOLS_EXPORTS = ['kicadSymbolsGet', 'kicadSymbolsSet', 'kicadCollabBusy'] as const;
/** Each set writes into a fresh folder under this one, outside the project folder. */
export const SYMBOLS_ROOT = '/tmp/cc-symbols';
/** The set's report and its record, written last. */
export const SYMBOLS_REPORT = 'symbols.json';
export const SYMBOLS_DONE = '.cc-symbols.json';
/** At most this many instances asked, changed or answered in one request (the engine's bound). */
export const MAX_SYMBOL_ROWS = 4096;
/** A variant's name: at most this many characters (the engine's bound); "" is the default. */
export const VARIANT_MAX = 128;
/** At most this many fields of one row, footprint filters of one row, and variants of a design. */
export const ROW_FIELDS_MAX = 256;
export const ROW_FILTERS_MAX = 256;
export const MAX_VARIANTS = 1024;
/** At most this many overrides a set may clear. */
export const MAX_CLEAR = 512;

export type FlagKey = 'inBom' | 'onBoard' | 'inSim' | 'inPos' | 'dnp';
export const FLAG_KEYS: readonly FlagKey[] = ['inBom', 'onBoard', 'inSim', 'inPos', 'dnp'];
export interface TableField { name: string; value: string; shown: boolean }
export interface SymbolRow {
  uuid: string; sheetPath: string; sheetName: string;
  ref: string; unit: number; units: number;
  libId: string; value: string; footprint: string;
  fields: TableField[];
  inBom: boolean; onBoard: boolean; inSim: boolean; inPos: boolean; dnp: boolean;
  sheetHeld: FlagKey[];
  overrides: string[];
  filters: string[]; pins: number;
}
export interface SymbolTable { variant: string; variants: string[]; rows: SymbolRow[]; power: number; truncated: boolean; depth: number }
export interface Instance { uuid: string; sheetPath: string }
export type SymbolsGetArgs = { variant: string; scope: 'all' } | { variant: string; items: Instance[] };
export interface SymbolsSet {
  ref?: string; value?: string; footprint?: string;
  fields?: Array<{ name: string; value?: string; shown?: boolean }>;
  addField?: { name: string; value: string; shown: boolean }; removeField?: string;
  inBom?: boolean; onBoard?: boolean; inSim?: boolean; inPos?: boolean; dnp?: boolean;
  clear?: string[];
}
export interface SymbolsChange { uuid: string; sheetPath: string; set: SymbolsSet }
export interface SymbolsSetArgs { variant: string; changes: SymbolsChange[] }
export interface SymbolsRecord { applied: number; depth: number }
/** A run's last file: `error` "" on success, else the engine's code with its message. */
export interface RunError { error: string; message: string }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const keysWithin = (o: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(o).every((k) => allowed.includes(k));
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).length === keys.length && keys.every((k) => own(o, k));
/** UTF-16 that UTF-8 can spell (no lone surrogate, no NUL). */
const UNSPELLABLE_RE = /\0|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const bounded = (v: unknown, min: number, max: number): v is string => {
  if (typeof v !== 'string' || UNSPELLABLE_RE.test(v)) return false;
  const n = [...v].length;
  return n >= min && n <= max;
};
const named = (v: unknown, min: number, max: number): v is string => bounded(v, min, max) && !CONTROL_RE.test(v);
const isText = (v: unknown, max = TEXT_MAX): v is string => typeof v === 'string' && [...v].length <= max;
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
/** A variant's name as args carry it: "" for the default, else 1 to 128 characters with no control character. */
export const isVariant = (v: unknown): v is string => v === '' || named(v, 1, VARIANT_MAX);

/** One instance as args name it: exactly `{ uuid, sheetPath }`, KiCad's lower case spelling. */
function readInstance(v: unknown): Instance | null {
  if (!isObj(v) || !exactKeys(v, ['uuid', 'sheetPath'])) return null;
  if (typeof v.uuid !== 'string' || !UUID_RE.test(v.uuid) || typeof v.sheetPath !== 'string' || !SHEET_PATH_RE.test(v.sheetPath)) return null;
  return { uuid: v.uuid, sheetPath: v.sheetPath };
}
/** An instance's key: its sheet path and uuid (a reused sheet's symbol is one per path). */
export const instanceKey = (i: Instance): string => `${i.sheetPath}|${i.uuid}`;

/**
 * symbols.get's args: exactly `{ variant, scope: "all" }` or `{ variant,
 * items }`, 1 to 4,096 instances, none named twice; null for anything else.
 */
export function parseSymbolsGetArgs(args: unknown): SymbolsGetArgs | null {
  if (!isObj(args) || Object.keys(args).length !== 2 || !own(args, 'variant') || !isVariant(args.variant)) return null;
  if (own(args, 'scope')) return args.scope === 'all' ? { variant: args.variant, scope: 'all' } : null;
  if (!own(args, 'items') || !Array.isArray(args.items) || args.items.length < 1 || args.items.length > MAX_SYMBOL_ROWS) return null;
  const items: Instance[] = [];
  const seen = new Set<string>();
  for (const it of args.items as unknown[]) {
    const i = readInstance(it);
    if (i == null || seen.has(instanceKey(i))) return null;
    seen.add(instanceKey(i));
    items.push(i);
  }
  return { variant: args.variant, items };
}

/** The args as kicadSymbolsGet reads them. */
export const symbolsGetJson = (a: SymbolsGetArgs): string =>
  JSON.stringify('scope' in a ? { variant: a.variant, scope: 'all' } : { variant: a.variant, items: a.items });

const SET_KEYS = ['ref', 'value', 'footprint', 'fields', 'addField', 'removeField', 'inBom', 'onBoard', 'inSim', 'inPos', 'dnp', 'clear'] as const;

/**
 * One change's set (properties spec 7.1), at least one key, with symbol.set's
 * bounds for the keys they share; under a variant `ref`, `addField`,
 * `removeField` and a field's `shown` refuse (KiCad's variants hold values and
 * flags only, and a designator is the same in every variant), and `clear` is
 * the variant's alone and never names what the same set changes. Null for
 * anything else.
 */
export function parseSymbolsSet(set: unknown, variant: string): SymbolsSet | null {
  if (!isObj(set) || Object.keys(set).length === 0 || !keysWithin(set, SET_KEYS)) return null;
  const under = variant !== '';
  const out: SymbolsSet = {};
  for (const key of Object.keys(set) as Array<(typeof SET_KEYS)[number]>) {
    const v = set[key];
    switch (key) {
      case 'ref': if (under || !named(v, 1, REF_MAX)) return null; out.ref = v; break;
      case 'value': if (!bounded(v, 0, TEXT_MAX)) return null; out.value = v; break;
      case 'footprint': if (!isFootprintId(v)) return null; out.footprint = v; break;
      case 'fields': {
        if (!Array.isArray(v) || v.length === 0 || v.length > SET_FIELDS_MAX) return null;
        const fields: NonNullable<SymbolsSet['fields']> = [];
        for (const f of v as unknown[]) {
          if (!isObj(f) || !keysWithin(f, ['name', 'value', 'shown']) || !bounded(f.name, 1, FIELD_NAME_MAX)) return null;
          if (f.value === undefined && f.shown === undefined) return null;
          if (f.value !== undefined && !bounded(f.value, 0, TEXT_MAX)) return null;
          if (f.shown !== undefined && (typeof f.shown !== 'boolean' || under)) return null;
          if (fields.some((g) => g.name === f.name)) return null;
          if (f.name === 'Reference' && (under || (f.value !== undefined && !named(f.value, 1, REF_MAX)))) return null;
          if (f.name === 'Footprint' && f.value !== undefined && !isFootprintId(f.value)) return null;
          const field: { name: string; value?: string; shown?: boolean } = { name: f.name };
          if (f.value !== undefined) field.value = f.value as string;
          if (f.shown !== undefined) field.shown = f.shown as boolean;
          fields.push(field);
        }
        out.fields = fields;
        break;
      }
      case 'addField':
        if (under || !isObj(v) || !exactKeys(v, ['name', 'value', 'shown'])) return null;
        if (!named(v.name, 1, FIELD_NAME_MAX) || !bounded(v.value, 0, TEXT_MAX) || typeof v.shown !== 'boolean') return null;
        out.addField = { name: v.name, value: v.value, shown: v.shown };
        break;
      case 'removeField': if (under || !bounded(v, 1, FIELD_NAME_MAX)) return null; out.removeField = v; break;
      case 'inBom': case 'onBoard': case 'inSim': case 'inPos': case 'dnp':
        if (typeof v !== 'boolean') return null;
        out[key] = v;
        break;
      case 'clear': {
        if (!under || !Array.isArray(v) || v.length === 0 || v.length > MAX_CLEAR) return null;
        if (!(v as unknown[]).every((c) => bounded(c, 1, FIELD_NAME_MAX)) || new Set(v).size !== v.length) return null;
        out.clear = [...(v as string[])];
        break;
      }
    }
  }
  // One change per thing (the engine's rule): a field by its own key and in fields, removed and changed, removed and added.
  const inFields = new Set((out.fields ?? []).map((f) => f.name));
  if ((out.ref !== undefined && inFields.has('Reference')) || (out.value !== undefined && inFields.has('Value')) || (out.footprint !== undefined && inFields.has('Footprint'))) return null;
  if (out.removeField !== undefined && (inFields.has(out.removeField) || (out.addField != null && out.addField.name.toLowerCase() === out.removeField.toLowerCase()))) return null;
  // Never set and cleared at once.
  for (const c of out.clear ?? []) {
    const flag = (FLAG_KEYS as readonly string[]).includes(c);
    if ((flag && out[c as FlagKey] !== undefined) || (c === 'value' && out.value !== undefined) || (c === 'footprint' && out.footprint !== undefined) || inFields.has(c)) return null;
  }
  return out;
}

/**
 * symbols.set's args: exactly `{ variant, changes }`, 1 to 4,096 changes of
 * exactly `{ uuid, sheetPath, set }`, one per instance; null for anything else.
 */
export function parseSymbolsSetArgs(args: unknown): SymbolsSetArgs | null {
  if (!isObj(args) || !exactKeys(args, ['variant', 'changes']) || !isVariant(args.variant)) return null;
  if (!Array.isArray(args.changes) || args.changes.length < 1 || args.changes.length > MAX_SYMBOL_ROWS) return null;
  const changes: SymbolsChange[] = [];
  const seen = new Set<string>();
  for (const c of args.changes as unknown[]) {
    if (!isObj(c) || !exactKeys(c, ['uuid', 'sheetPath', 'set'])) return null;
    const i = readInstance({ uuid: c.uuid, sheetPath: c.sheetPath });
    if (i == null || seen.has(instanceKey(i))) return null;
    const set = parseSymbolsSet(c.set, args.variant);
    if (set == null) return null;
    seen.add(instanceKey(i));
    changes.push({ uuid: i.uuid, sheetPath: i.sheetPath, set });
  }
  return { variant: args.variant, changes };
}

/** The args as kicadSymbolsSet reads them: `{ run, dir, variant, changes }`. */
export const symbolsSetJson = (run: number, dir: string, a: SymbolsSetArgs): string =>
  JSON.stringify({ run, dir, variant: a.variant, changes: a.changes });

const ROW_KEYS = ['uuid', 'sheetPath', 'sheetName', 'ref', 'unit', 'units', 'libId', 'value', 'footprint', 'fields',
  'inBom', 'onBoard', 'inSim', 'inPos', 'dnp', 'sheetHeld', 'overrides', 'filters', 'pins'] as const;

function readRow(v: unknown): SymbolRow | null {
  if (!isObj(v) || !exactKeys(v, ROW_KEYS)) return null;
  if (typeof v.uuid !== 'string' || !UUID_RE.test(v.uuid) || typeof v.sheetPath !== 'string' || !SHEET_PATH_RE.test(v.sheetPath)) return null;
  if (!isText(v.sheetName) || !isText(v.ref, REF_MAX) || !isText(v.libId) || !isText(v.value) || !isText(v.footprint)) return null;
  if (!count(v.unit) || v.unit < 1 || !count(v.units) || v.units < 1 || !count(v.pins)) return null;
  for (const f of FLAG_KEYS) if (typeof v[f] !== 'boolean') return null;
  if (!Array.isArray(v.fields) || v.fields.length > ROW_FIELDS_MAX) return null;
  const fields: TableField[] = [];
  for (const f of v.fields as unknown[]) {
    if (!isObj(f) || !exactKeys(f, ['name', 'value', 'shown']) || !isText(f.name, FIELD_NAME_MAX) || !isText(f.value) || typeof f.shown !== 'boolean') return null;
    fields.push({ name: f.name, value: f.value, shown: f.shown });
  }
  const held = v.sheetHeld;
  if (!Array.isArray(held) || !(held as unknown[]).every((h) => typeof h === 'string' && (FLAG_KEYS as readonly string[]).includes(h)) || new Set(held).size !== held.length) return null;
  const overrides = v.overrides;
  if (!Array.isArray(overrides) || overrides.length > ROW_FIELDS_MAX + FLAG_KEYS.length || !(overrides as unknown[]).every((o) => typeof o === 'string' && o !== '' && isText(o, FIELD_NAME_MAX))) return null;
  const filters = v.filters;
  if (!Array.isArray(filters) || filters.length > ROW_FILTERS_MAX || !(filters as unknown[]).every((f) => isText(f, 256))) return null;
  return {
    uuid: v.uuid, sheetPath: v.sheetPath, sheetName: v.sheetName, ref: v.ref, unit: v.unit, units: v.units,
    libId: v.libId, value: v.value, footprint: v.footprint, fields,
    inBom: v.inBom as boolean, onBoard: v.onBoard as boolean, inSim: v.inSim as boolean, inPos: v.inPos as boolean, dnp: v.dnp as boolean,
    sheetHeld: [...(held as FlagKey[])], overrides: [...(overrides as string[])], filters: [...(filters as string[])], pins: v.pins,
  };
}

/**
 * kicadSymbolsGet's answer read closed: 7.1's SymbolTable (every row, field
 * and flag; at most 4,096 rows), null for the empty answer and any other shape.
 */
export function readSymbolTable(text: unknown): SymbolTable | null {
  if (typeof text !== 'string' || text === '') return null;
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (!isObj(v) || !exactKeys(v, ['variant', 'variants', 'rows', 'power', 'truncated', 'depth'])) return null;
  if (!isVariant(v.variant) || !Array.isArray(v.variants) || v.variants.length > MAX_VARIANTS || !(v.variants as unknown[]).every((n) => typeof n === 'string' && n !== '' && isText(n, VARIANT_MAX))) return null;
  if (!Array.isArray(v.rows) || v.rows.length > MAX_SYMBOL_ROWS || !count(v.power) || typeof v.truncated !== 'boolean' || !count(v.depth)) return null;
  const rows: SymbolRow[] = [];
  for (const r of v.rows as unknown[]) {
    const row = readRow(r);
    if (row == null) return null;
    rows.push(row);
  }
  return { variant: v.variant, variants: [...(v.variants as string[])], rows, power: v.power, truncated: v.truncated, depth: v.depth };
}

/** Bytes as JSON, or undefined when absent or unreadable. */
export function jsonOf(bytes: Uint8Array | null): unknown {
  if (bytes == null) return undefined;
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return undefined; }
}

/** A run's last file (`.cc-<name>.json`) read closed: `{ error, message }`, `error` one of `codes` or ""; null otherwise. */
export function readRunError(bytes: Uint8Array | null, codes: readonly string[]): RunError | null {
  const v = jsonOf(bytes);
  if (!isObj(v) || !exactKeys(v, ['error', 'message']) || typeof v.error !== 'string' || typeof v.message !== 'string') return null;
  if (v.error !== '' && !codes.includes(v.error)) return null;
  return { error: v.error, message: [...v.message].slice(0, TEXT_MAX).join('') };
}

/** The codes a set's record may carry. */
export const SYMBOLS_ERRORS = ['island_error', 'no_variant'] as const;

/** symbols.json read closed: `{ applied, depth }`; null otherwise. */
export function readSymbolsRecord(bytes: Uint8Array | null): SymbolsRecord | null {
  const v = jsonOf(bytes);
  if (!isObj(v) || !exactKeys(v, ['applied', 'depth']) || !count(v.applied) || typeof v.depth !== 'number' || !Number.isSafeInteger(v.depth) || v.depth < -1) return null;
  return { applied: v.applied, depth: v.depth };
}
