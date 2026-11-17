// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// symbols.exchange and footprints.exchange (PROTOCOL.md): KiCad's Change
// Symbols and Update Symbols from Library, and its Change Footprints and
// Update Footprints from Library, with their reset options, run with no KiCad
// dialog through our engine's kicadSymbolsExchange (a sch frame) and
// kicadFootprintsExchange (a pcb frame), engine run 14. A preview lists the
// rows and changes nothing; an apply is ONE commit. Each queues on the
// editor's apply coroutine and answers before it runs; the run writes
// exchange.json, then .cc-exchange.json LAST, in its folder.

import { UUID_RE, SHEET_PATH_RE, REF_MAX, TEXT_MAX, FIELD_NAME_MAX, isFootprintId } from './symbol';
import { instanceKey, jsonOf, MAX_SYMBOL_ROWS, type Instance } from './symbols';

/** The engine exports each op needs: its exchange, the apply queue probe. */
export const SYMBOL_EXCHANGE_EXPORTS = ['kicadSymbolsExchange', 'kicadCollabBusy'] as const;
export const FOOTPRINT_EXCHANGE_EXPORTS = ['kicadFootprintsExchange', 'kicadCollabBusy'] as const;
/** Each run writes into a fresh folder under this one, outside the project folder. */
export const EXCHANGE_ROOT = '/tmp/cc-exchange';
export const EXCHANGE_REPORT = 'exchange.json';
export const EXCHANGE_DONE = '.cc-exchange.json';
/** At most this many footprints a `uuids` match names (the engine's bound). */
export const MAX_MATCH_UUIDS = 8192;
/** At most this many field names a symbols.exchange resets. */
export const MAX_EXCHANGE_FIELDS = 256;

/** KiCad's Change Symbols dialog's checkboxes (the spec's eight and two of KiCad's the spec lacks). */
export const SYMBOL_OPTIONS = ['removeExtra', 'resetEmpty', 'resetText', 'resetVisibility', 'resetEffects', 'resetPositions',
  'resetAttributes', 'resetPins', 'resetPinTextVisibility', 'resetCustomPower'] as const;
/** KiCad's Change Footprints dialog's checkboxes. */
export const FOOTPRINT_OPTIONS = ['removeExtraTexts', 'resetTextLayers', 'resetTextEffects', 'resetTextPositions', 'resetTextContent',
  'resetFabrication', 'resetClearances', 'reset3D'] as const;

export type ExchangeMode = 'update' | 'change';
export interface SymbolExchangeArgs {
  mode: ExchangeMode; targets: Instance[]; libId: string; fields: 'all' | string[];
  options: Partial<Record<(typeof SYMBOL_OPTIONS)[number], boolean>>; preview: boolean;
}
export type FootprintMatch = { all: true } | { uuids: string[] } | { ref: string } | { value: string } | { libId: string };
export interface FootprintExchangeArgs {
  mode: ExchangeMode; match: FootprintMatch; libId: string;
  options: Partial<Record<(typeof FOOTPRINT_OPTIONS)[number], boolean>>; preview: boolean;
}
export type ExchangeStatus = 'changed' | 'same' | 'missing' | 'locked';
export interface ExchangeRow { uuid: string; sheetPath?: string; ref: string; from: string; to: string; status: ExchangeStatus }
export interface ExchangeReport { preview: boolean; rows: ExchangeRow[]; applied: number; truncated: boolean; depth: number }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).length === keys.length && keys.every((k) => own(o, k));
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const isText = (v: unknown, max = TEXT_MAX): v is string => typeof v === 'string' && [...v].length <= max;
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
/** A library id as LIB_ID reads one, both halves present: what a change names. */
const isLibId = (v: unknown): v is string => typeof v === 'string' && v !== '' && isFootprintId(v);
/** A glob of 1 to 256 characters with no control character. */
const isGlob = (v: unknown): v is string => typeof v === 'string' && !CONTROL_RE.test(v) && [...v].length >= 1 && [...v].length <= 256;

/** The options object: only the dialog's names, each a boolean. */
function readOptions<K extends string>(v: unknown, names: readonly K[]): Partial<Record<K, boolean>> | null {
  if (!isObj(v)) return null;
  const out: Partial<Record<K, boolean>> = {};
  for (const [k, on] of Object.entries(v)) {
    if (!(names as readonly string[]).includes(k) || typeof on !== 'boolean') return null;
    out[k as K] = on;
  }
  return out;
}

/** `libId`: "" for an update (each part's own source), `lib:name` for a change. */
const libIdFits = (mode: ExchangeMode, v: unknown): v is string => (mode === 'update' ? v === '' : isLibId(v));

/**
 * symbols.exchange's args: exactly `{ mode, targets, libId, fields, options,
 * preview }`: 1 to 4,096 instances, none twice; `fields` "all" or 1 to 256
 * field names; `options` the dialog's names, each a boolean. Null for anything else.
 */
export function parseSymbolExchangeArgs(args: unknown): SymbolExchangeArgs | null {
  if (!isObj(args) || !exactKeys(args, ['mode', 'targets', 'libId', 'fields', 'options', 'preview'])) return null;
  const { mode, preview } = args;
  if ((mode !== 'update' && mode !== 'change') || typeof preview !== 'boolean' || !libIdFits(mode, args.libId)) return null;
  if (!Array.isArray(args.targets) || args.targets.length < 1 || args.targets.length > MAX_SYMBOL_ROWS) return null;
  const targets: Instance[] = [];
  const seen = new Set<string>();
  for (const t of args.targets as unknown[]) {
    if (!isObj(t) || !exactKeys(t, ['uuid', 'sheetPath']) || typeof t.uuid !== 'string' || !UUID_RE.test(t.uuid) || typeof t.sheetPath !== 'string' || !SHEET_PATH_RE.test(t.sheetPath)) return null;
    const i = { uuid: t.uuid, sheetPath: t.sheetPath };
    if (seen.has(instanceKey(i))) return null;
    seen.add(instanceKey(i));
    targets.push(i);
  }
  let fields: 'all' | string[];
  if (args.fields === 'all') fields = 'all';
  else if (Array.isArray(args.fields) && args.fields.length >= 1 && args.fields.length <= MAX_EXCHANGE_FIELDS
    && (args.fields as unknown[]).every((f) => typeof f === 'string' && f !== '' && !CONTROL_RE.test(f) && isText(f, FIELD_NAME_MAX))) fields = [...new Set(args.fields as string[])];
  else return null;
  const options = readOptions(args.options, SYMBOL_OPTIONS);
  if (options == null) return null;
  return { mode, targets, libId: args.libId, fields, options, preview };
}

/** The args as kicadSymbolsExchange reads them, with the run's folder. */
export const symbolExchangeJson = (run: number, dir: string, a: SymbolExchangeArgs): string =>
  JSON.stringify({ run, dir, mode: a.mode, targets: a.targets, libId: a.libId, fields: a.fields, options: a.options, preview: a.preview });

function readMatch(v: unknown): FootprintMatch | null {
  if (!isObj(v) || Object.keys(v).length !== 1) return null;
  if (own(v, 'all')) return v.all === true ? { all: true } : null;
  if (own(v, 'uuids')) {
    const u = v.uuids;
    if (!Array.isArray(u) || u.length < 1 || u.length > MAX_MATCH_UUIDS || !(u as unknown[]).every((x) => typeof x === 'string' && UUID_RE.test(x))) return null;
    return { uuids: [...new Set(u as string[])] };
  }
  if (own(v, 'ref')) return isGlob(v.ref) ? { ref: v.ref } : null;
  if (own(v, 'value')) return isGlob(v.value) ? { value: v.value } : null;
  if (own(v, 'libId')) return isLibId(v.libId) ? { libId: v.libId } : null;
  return null;
}

/**
 * footprints.exchange's args: exactly `{ mode, match, libId, options,
 * preview }`; `match` exactly one of `all: true`, `uuids` (1 to 8,192), a
 * `ref` or `value` glob, a `libId`. Null for anything else.
 */
export function parseFootprintExchangeArgs(args: unknown): FootprintExchangeArgs | null {
  if (!isObj(args) || !exactKeys(args, ['mode', 'match', 'libId', 'options', 'preview'])) return null;
  const { mode, preview } = args;
  if ((mode !== 'update' && mode !== 'change') || typeof preview !== 'boolean' || !libIdFits(mode, args.libId)) return null;
  const match = readMatch(args.match);
  const options = readOptions(args.options, FOOTPRINT_OPTIONS);
  if (match == null || options == null) return null;
  return { mode, match, libId: args.libId, options, preview };
}

/** The args as kicadFootprintsExchange reads them, with the run's folder. */
export const footprintExchangeJson = (run: number, dir: string, a: FootprintExchangeArgs): string =>
  JSON.stringify({ run, dir, mode: a.mode, match: a.match, libId: a.libId, options: a.options, preview: a.preview });

const STATUSES: readonly string[] = ['changed', 'same', 'missing', 'locked'];

/**
 * exchange.json read closed: 7.3's ExchangeReport, a schematic row with its
 * `sheetPath`, a board row without; null for anything else.
 */
export function readExchangeReport(bytes: Uint8Array | null, frame: 'sch' | 'pcb'): ExchangeReport | null {
  const v = jsonOf(bytes);
  if (!isObj(v) || !exactKeys(v, ['preview', 'rows', 'applied', 'truncated', 'depth'])) return null;
  if (typeof v.preview !== 'boolean' || !count(v.applied) || typeof v.truncated !== 'boolean' || !count(v.depth)) return null;
  if (!Array.isArray(v.rows) || v.rows.length > MAX_SYMBOL_ROWS) return null;
  const rows: ExchangeRow[] = [];
  const keys = frame === 'sch' ? ['uuid', 'sheetPath', 'ref', 'from', 'to', 'status'] : ['uuid', 'ref', 'from', 'to', 'status'];
  for (const r of v.rows as unknown[]) {
    if (!isObj(r) || !exactKeys(r, keys) || typeof r.uuid !== 'string' || !UUID_RE.test(r.uuid)) return null;
    if (!isText(r.ref, REF_MAX) || !isText(r.from) || !isText(r.to) || typeof r.status !== 'string' || !STATUSES.includes(r.status)) return null;
    const row: ExchangeRow = { uuid: r.uuid, ref: r.ref, from: r.from, to: r.to, status: r.status as ExchangeStatus };
    if (frame === 'sch') {
      if (typeof r.sheetPath !== 'string' || !SHEET_PATH_RE.test(r.sheetPath)) return null;
      row.sheetPath = r.sheetPath;
    }
    rows.push(row);
  }
  return { preview: v.preview, rows, applied: v.applied, truncated: v.truncated, depth: v.depth };
}
