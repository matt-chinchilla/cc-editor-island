// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// fp-i3 (FP spec 6.2, 7.3, 7.4): the open footprint's own properties, its
// embedded files, KiCad's footprint checker, Tidy (Cleanup Graphics and
// Repair Footprint) and an SVG of the footprint, in the footprint editor's
// frame, through our engine's run 15 exports (pcbjam cc_e5_fpedit.inc, units
// fp-e5 and fp-e6): kicadFpEditFootprintGet and Set, kicadFpEditEmbed,
// kicadFpEditCheck, kicadFpEditCleanup and kicadFpEditPlotSvg. Every op passes
// fp-i1's gate (fpEditGate), so it is feature detected on the whole fpedit
// export set: on an engine without it each op answers unsupported naming the
// first missing export. The records are read closed: any other shape is an
// island_error.
import { fail, isObj, noArgs, ok, type Answer, type ExtUnit, type ResponderCtx } from './contract';
import {
  FPEDIT_FRAME, FPEDIT_FRAME_ONLY, FP_TYPES, callFpBool, callFpText, fpChangeMs, fpEditGate, fpGated, fpReadBack, readFpEditState,
  type FpType,
} from '../fpedit/common';
import { isLayerName, isUuid, LAYERS_MAX } from '../itemRecords';
import { isText, readSvgDone } from '../symedit';

// ── names and bounds ───────────────────────────────────────────────────────────────────

/** A record's string is at most this many characters (FP spec 7), but the texts named below. */
export const FP_PROPS_TEXT_MAX = 1024;
/** The footprint's description and keywords and a field's value, as a footprint file may hold them, read up to this many characters (a set takes FP_PROPS_TEXT_MAX). */
export const FP_PROPS_LONG_MAX = 16_384;
/** Fields, net tie groups and jumper groups of one footprint (the engine's FIELDS_MAX, GROUPS_MAX). */
export const FP_FIELDS_MAX = 256;
export const FP_GROUPS_MAX = 256;
/** Pad numbers in one jumper group (the engine's UUIDS_MAX). */
export const FP_GROUP_PADS_MAX = 4096;
/** Model lines of one footprint (FootprintProps.models) and a model path's characters. */
export const FP_MODELS_MAX = 32;
export const FP_MODEL_PATH_MAX = 1024;
/** Embedded files of one footprint as the get lists them. */
export const FP_EMBEDDED_MAX = 1024;
/** A margin or clearance a set takes, in mm (the engine's MARGIN_MAX_MM), and a model's offset (MODEL_OFFSET_MAX_MM). */
export const FP_MARGIN_MAX_MM = 100;
export const FP_MODEL_OFFSET_MAX_MM = 1000;

/** fpedit.embed writes the file under a fresh folder of EMBED_ROOT (the engine reads only there), at most 25 MiB. */
export const EMBED_ROOT = '/tmp/cc-embed';
export const EMBED_MAX_BYTES = 25 * 1024 * 1024;
/** An embedded file's name: 1 to 255 characters, no slash or backslash, never "." or "..". */
export const EMBED_NAME_MAX = 255;
export const EMBED_TYPES = ['model', 'datasheet', 'font', 'other'] as const;
export type EmbedType = typeof EMBED_TYPES[number];

/** fpedit.svg's run folder, its file and its record (written last). */
export const FP_SVG_ROOT = '/tmp/cc-svg';
export const FP_SVG_FILE = 'footprint.svg';
export const FP_SVG_DONE = '.cc-svg.json';
/** fpedit.svg answers at most this many bytes. */
export const FP_SVG_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The checker's codes the run 15 build answers (KiCad's settings keys,
 * drc_item.cpp): the page words these and shows `message` for any other.
 */
export const FP_CHECK_CODES = [
  'malformed_courtyard', 'missing_courtyard', 'footprint_type_mismatch', 'padstack', 'padstack_invalid',
  'through_hole_pad_without_hole', 'holes_co_located', 'hole_to_hole', 'shorting_items', 'footprint', 'silk_over_copper',
] as const;
/** At most this many findings in one answer, and a finding's message in characters (the engine cuts at 4,096 bytes). */
export const FP_FINDINGS_MAX = 65_536;
export const FP_FINDING_MESSAGE_MAX = 4096;
/** Tidy's codes: Cleanup Graphics' four kinds, `other` for any the engine does not name. */
export const FP_CLEANUP_CODES = ['null_graphic', 'duplicate_graphic', 'lines_to_rect', 'merge_pad', 'other'] as const;
export type FpCleanupCode = typeof FP_CLEANUP_CODES[number];
/** At most this many Tidy items in one answer. */
export const FP_CLEANUP_ITEMS_MAX = 65_536;

const ZONE_CONNECTIONS = ['inherit', 'none', 'thermal', 'solid'] as const;
type ZoneConnection = typeof ZONE_CONNECTIONS[number];
const FIELD_KINDS = ['reference', 'value', 'datasheet', 'description', 'user'] as const;
type FieldKind = typeof FIELD_KINDS[number];

// ── the records (FP spec 7.3, 7.4) ─────────────────────────────────────────────────────

export type Vec3 = [number, number, number];
export interface Model3D { path: string; offset: Vec3; rotate: Vec3; scale: Vec3; opacity: number; show: boolean }
export interface FootprintField { name: string; value: string; visible: boolean; layer: string; kind: FieldKind }
export interface FootprintProps {
  name: string; description: string; keywords: string;
  fields: FootprintField[];
  type: FpType; boardOnly: boolean; excludeFromPos: boolean; excludeFromBom: boolean; dnp: boolean;
  allowMissingCourtyard: boolean; allowSolderMaskBridges: boolean;
  clearance: number | null; maskMargin: number | null; pasteMargin: number | null; pasteRatio: number | null;
  zoneConnection: ZoneConnection;
  netTieGroups: string[]; jumpers: { duplicateNumbersAreJumpers: boolean; groups: string[][] };
  privateLayers: string[]; customStackup: { on: boolean; copperLayers: number }; userLayerNames: Record<string, string>;
  models: Model3D[];
  embedded: Array<{ name: string; type: EmbedType; bytes: number }>;
}
export interface FieldPatch { name: string; value?: string; visible?: boolean; layer?: string }
export interface NewField { name: string; value: string; visible: boolean; layer: string }
export type FootprintSet = Partial<Omit<FootprintProps, 'fields' | 'embedded'>> & {
  fields?: FieldPatch[]; addField?: NewField; removeField?: string;
};
export interface FpFinding {
  code: string; severity: 'error' | 'warning'; message: string; uuids: string[]; pads: string[]; x: number | null; y: number | null;
}
export interface FpCleanupItem { code: FpCleanupCode; uuids: string[] }
export interface FpCleanup { items: FpCleanupItem[]; repaired: number }
export interface FpCleanupArgs { mergeRects: boolean; deleteRedundant: boolean; mergePads: boolean; repair: boolean; dryRun: boolean }
export type FpEmbedArgs = { name: string; type: EmbedType; bytes: Uint8Array } | { remove: string };

const PROPS_KEYS = [
  'name', 'description', 'keywords', 'fields', 'type', 'boardOnly', 'excludeFromPos', 'excludeFromBom', 'dnp',
  'allowMissingCourtyard', 'allowSolderMaskBridges', 'clearance', 'maskMargin', 'pasteMargin', 'pasteRatio', 'zoneConnection',
  'netTieGroups', 'jumpers', 'privateLayers', 'customStackup', 'userLayerNames', 'models', 'embedded',
] as const;
const SET_KEYS = [
  'name', 'description', 'keywords', 'fields', 'addField', 'removeField', 'type', 'boardOnly', 'excludeFromPos', 'excludeFromBom', 'dnp',
  'allowMissingCourtyard', 'allowSolderMaskBridges', 'clearance', 'maskMargin', 'pasteMargin', 'pasteRatio', 'zoneConnection',
  'netTieGroups', 'jumpers', 'privateLayers', 'customStackup', 'userLayerNames', 'models',
] as const;
const MODEL_KEYS = ['path', 'offset', 'rotate', 'scale', 'opacity', 'show'] as const;
const FIELD_KEYS = ['name', 'value', 'visible', 'layer'] as const;
const CLEANUP_KEYS = ['mergeRects', 'deleteRedundant', 'mergePads', 'repair', 'dryRun'] as const;
const BOOL_KEYS = ['boardOnly', 'excludeFromPos', 'excludeFromBom', 'dnp', 'allowMissingCourtyard', 'allowSolderMaskBridges'] as const;
const LENGTH_KEYS = ['clearance', 'maskMargin', 'pasteMargin'] as const;

const has = (o: Record<string, unknown>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const within = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).every((k) => keys.includes(k));
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).length === keys.length && within(o, keys);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const inRange = (v: unknown, min: number, max: number): v is number => isNum(v) && v >= min && v <= max;
const isInt = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const oneOf = <T extends string>(v: unknown, all: readonly T[]): v is T => typeof v === 'string' && (all as readonly string[]).includes(v);
/** A string the engine wrote: at most `max` characters, any character. */
const isRecordText = (v: unknown, max = FP_PROPS_TEXT_MAX): v is string => typeof v === 'string' && [...v].length <= max;
const isVec3 = (v: unknown, min = -Infinity, max = Infinity): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((x) => inRange(x, min, max));
/** A list of `min` to `max` entries each passing `c`, or null. */
function listOf<T>(v: unknown, max: number, c: (x: unknown) => x is T, min = 0): T[] | null {
  return Array.isArray(v) && v.length >= min && v.length <= max && v.every(c) ? [...(v as T[])] : null;
}

function parseJson(text: unknown): unknown {
  if (typeof text !== 'string' || text === '') return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

function readModel(v: unknown, set: boolean): Model3D | null {
  if (!isObj(v) || !exactKeys(v, MODEL_KEYS)) return null;
  const pathOk = set ? isText(v.path, 0, FP_MODEL_PATH_MAX) : isRecordText(v.path, FP_MODEL_PATH_MAX);
  if (!pathOk || !isBool(v.show)) return null;
  const offsetOk = set ? isVec3(v.offset, -FP_MODEL_OFFSET_MAX_MM, FP_MODEL_OFFSET_MAX_MM) : isVec3(v.offset);
  const rotateOk = set ? isVec3(v.rotate, -360, 360) : isVec3(v.rotate);
  const scaleOk = set ? isVec3(v.scale, 0.0001, 10_000) : isVec3(v.scale);
  if (!offsetOk || !rotateOk || !scaleOk || !inRange(v.opacity, 0, 1)) return null;
  return {
    path: v.path as string, offset: (v.offset as Vec3).slice() as Vec3, rotate: (v.rotate as Vec3).slice() as Vec3, scale: (v.scale as Vec3).slice() as Vec3,
    opacity: v.opacity, show: v.show,
  };
}

/** A layer name list, none twice. */
function layerList(v: unknown): string[] | null {
  const l = listOf(v, LAYERS_MAX, isLayerName);
  return l != null && new Set(l).size === l.length ? l : null;
}

function readUserLayerNames(v: unknown): Record<string, string> | null {
  if (!isObj(v) || Object.keys(v).length > LAYERS_MAX) return null;
  const out: Record<string, string> = {};
  for (const [k, name] of Object.entries(v)) {
    if (!isLayerName(k) || !isRecordText(name)) return null;
    out[k] = name;
  }
  return out;
}

/**
 * kicadFpEditFootprintGet's answer read closed (FP spec 7.3): exactly the
 * FootprintProps keys, each of its type and bound; null for "" (no footprint)
 * and any other shape. `pasteRatio` is KiCad's own fraction (-1 to 1, not the
 * dialog's percent), `embedded[].bytes` the decompressed size.
 */
export function readFootprintProps(text: unknown): FootprintProps | null {
  const v = parseJson(text);
  if (!isObj(v) || !exactKeys(v, PROPS_KEYS)) return null;
  if (!isRecordText(v.name) || !isRecordText(v.description, FP_PROPS_LONG_MAX) || !isRecordText(v.keywords, FP_PROPS_LONG_MAX)) return null;
  if (!Array.isArray(v.fields) || v.fields.length > FP_FIELDS_MAX) return null;
  const fields: FootprintField[] = [];
  for (const f of v.fields as unknown[]) {
    if (!isObj(f) || !exactKeys(f, ['name', 'value', 'visible', 'layer', 'kind'])) return null;
    if (typeof f.name !== 'string' || f.name === '' || !isRecordText(f.name) || !isRecordText(f.value, FP_PROPS_LONG_MAX)) return null;
    if (!isBool(f.visible) || !isLayerName(f.layer) || !oneOf(f.kind, FIELD_KINDS)) return null;
    fields.push({ name: f.name, value: f.value, visible: f.visible, layer: f.layer, kind: f.kind });
  }
  if (!oneOf(v.type, FP_TYPES) || !BOOL_KEYS.every((k) => isBool(v[k]))) return null;
  if (!LENGTH_KEYS.every((k) => v[k] === null || isNum(v[k])) || !(v.pasteRatio === null || isNum(v.pasteRatio))) return null;
  if (!oneOf(v.zoneConnection, ZONE_CONNECTIONS)) return null;
  const netTieGroups = listOf(v.netTieGroups, FP_GROUPS_MAX, (x): x is string => isRecordText(x));
  if (netTieGroups == null) return null;
  const j = v.jumpers;
  if (!isObj(j) || !exactKeys(j, ['duplicateNumbersAreJumpers', 'groups']) || !isBool(j.duplicateNumbersAreJumpers)) return null;
  const groups = listOf(j.groups, FP_GROUPS_MAX, (g): g is string[] => listOf(g, FP_GROUP_PADS_MAX, (n): n is string => typeof n === 'string' && n !== '' && isRecordText(n)) != null);
  if (groups == null) return null;
  const privateLayers = layerList(v.privateLayers);
  if (privateLayers == null) return null;
  const cs = v.customStackup;
  if (!isObj(cs) || !exactKeys(cs, ['on', 'copperLayers']) || !isBool(cs.on) || !isInt(cs.copperLayers, 0, 64)) return null;
  const userLayerNames = readUserLayerNames(v.userLayerNames);
  if (userLayerNames == null) return null;
  if (!Array.isArray(v.models) || v.models.length > FP_MODELS_MAX) return null;
  const models: Model3D[] = [];
  for (const m of v.models as unknown[]) {
    const model = readModel(m, false);
    if (model == null) return null;
    models.push(model);
  }
  if (!Array.isArray(v.embedded) || v.embedded.length > FP_EMBEDDED_MAX) return null;
  const embedded: FootprintProps['embedded'] = [];
  for (const e of v.embedded as unknown[]) {
    if (!isObj(e) || !exactKeys(e, ['name', 'type', 'bytes']) || typeof e.name !== 'string' || e.name === '' || !isRecordText(e.name, EMBED_NAME_MAX)) return null;
    if (!oneOf(e.type, EMBED_TYPES) || !isInt(e.bytes, 0, Number.MAX_SAFE_INTEGER)) return null;
    embedded.push({ name: e.name, type: e.type, bytes: e.bytes });
  }
  return {
    name: v.name, description: v.description, keywords: v.keywords, fields,
    type: v.type, boardOnly: v.boardOnly as boolean, excludeFromPos: v.excludeFromPos as boolean, excludeFromBom: v.excludeFromBom as boolean,
    dnp: v.dnp as boolean, allowMissingCourtyard: v.allowMissingCourtyard as boolean, allowSolderMaskBridges: v.allowSolderMaskBridges as boolean,
    clearance: v.clearance as number | null, maskMargin: v.maskMargin as number | null, pasteMargin: v.pasteMargin as number | null,
    pasteRatio: v.pasteRatio as number | null, zoneConnection: v.zoneConnection,
    netTieGroups, jumpers: { duplicateNumbersAreJumpers: j.duplicateNumbersAreJumpers, groups: groups.map((g) => [...g]) },
    privateLayers, customStackup: { on: cs.on, copperLayers: cs.copperLayers }, userLayerNames, models, embedded,
  };
}

/**
 * kicadFpEditCheck's answer read closed (FP spec 7.4): `{ findings }`, each
 * exactly `{ code, severity, message, uuids, pads, x, y }` (code a settings
 * key of lowercase letters, digits and underscores; x and y both numbers or
 * both null, null for a finding on the footprint itself). Null for "" and any
 * other shape.
 */
export function readFpFindings(text: unknown): FpFinding[] | null {
  const v = parseJson(text);
  if (!isObj(v) || !exactKeys(v, ['findings']) || !Array.isArray(v.findings) || v.findings.length > FP_FINDINGS_MAX) return null;
  const out: FpFinding[] = [];
  for (const f of v.findings as unknown[]) {
    if (!isObj(f) || !exactKeys(f, ['code', 'severity', 'message', 'uuids', 'pads', 'x', 'y'])) return null;
    if (typeof f.code !== 'string' || !/^[a-z0-9_]{1,64}$/.test(f.code) || (f.severity !== 'error' && f.severity !== 'warning')) return null;
    if (!isRecordText(f.message, FP_FINDING_MESSAGE_MAX)) return null;
    const uuids = listOf(f.uuids, 3, isUuid);
    const pads = listOf(f.pads, 3, (p): p is string => isRecordText(p));
    if (uuids == null || pads == null) return null;
    const point = f.x === null && f.y === null;
    if (!point && !(isNum(f.x) && isNum(f.y))) return null;
    out.push({ code: f.code, severity: f.severity, message: f.message, uuids, pads, x: point ? null : f.x as number, y: point ? null : f.y as number });
  }
  return out;
}

/** kicadFpEditCleanup's answer read closed: `{ items: [{ code, uuids }], repaired }`; null for "" (refused) and any other shape. */
export function readFpCleanup(text: unknown): FpCleanup | null {
  const v = parseJson(text);
  if (!isObj(v) || !exactKeys(v, ['items', 'repaired']) || !isInt(v.repaired, 0, Number.MAX_SAFE_INTEGER)) return null;
  if (!Array.isArray(v.items) || v.items.length > FP_CLEANUP_ITEMS_MAX) return null;
  const items: FpCleanupItem[] = [];
  for (const it of v.items as unknown[]) {
    if (!isObj(it) || !exactKeys(it, ['code', 'uuids']) || !oneOf(it.code, FP_CLEANUP_CODES)) return null;
    const uuids = listOf(it.uuids, 4096, isUuid);
    if (uuids == null) return null;
    items.push({ code: it.code, uuids });
  }
  return { items, repaired: v.repaired };
}

// ── args ───────────────────────────────────────────────────────────────────────────────

const isLength = (min: number, max: number) => (v: unknown): boolean => v === null || inRange(v, min, max);

/**
 * fpedit.footprint.set's `set` read closed (FP spec 7.3 FootprintSet, the
 * engine's own bounds): at least one key, every key known; `fields` patches
 * by name (none twice), `addField` every key, `removeField` a name; lengths in
 * mm or null (the board's), clearance 0 to 100, margins -100 to 100,
 * pasteRatio -1 to 1 or null; `customStackup` an even 2 to 32 copper count;
 * `models` at most 32 lines within KiCad's bounds. Null for anything else.
 * What only the footprint can tell (a mandatory field, a pad number, a layer
 * in use) is the engine's to refuse.
 */
export function parseFootprintSet(v: unknown): FootprintSet | null {
  if (!isObj(v) || Object.keys(v).length === 0 || !within(v, SET_KEYS)) return null;
  const out: FootprintSet = {};
  if (has(v, 'name')) { if (!isText(v.name, 1, FP_PROPS_TEXT_MAX)) return null; out.name = v.name; }
  if (has(v, 'description')) { if (!isText(v.description, 0, FP_PROPS_TEXT_MAX, true)) return null; out.description = v.description; }
  if (has(v, 'keywords')) { if (!isText(v.keywords, 0, FP_PROPS_TEXT_MAX)) return null; out.keywords = v.keywords; }
  if (has(v, 'fields')) {
    if (!Array.isArray(v.fields) || v.fields.length > FP_FIELDS_MAX) return null;
    const seen = new Set<string>();
    const fields: FieldPatch[] = [];
    for (const f of v.fields as unknown[]) {
      if (!isObj(f) || !within(f, FIELD_KEYS) || !isText(f.name, 1, FP_PROPS_TEXT_MAX) || seen.has(f.name)) return null;
      seen.add(f.name);
      const p: FieldPatch = { name: f.name };
      if (has(f, 'value')) { if (!isText(f.value, 0, FP_PROPS_TEXT_MAX)) return null; p.value = f.value; }
      if (has(f, 'visible')) { if (!isBool(f.visible)) return null; p.visible = f.visible; }
      if (has(f, 'layer')) { if (!isLayerName(f.layer)) return null; p.layer = f.layer; }
      fields.push(p);
    }
    out.fields = fields;
  }
  if (has(v, 'addField')) {
    const f = v.addField;
    if (!isObj(f) || !exactKeys(f, FIELD_KEYS) || !isText(f.name, 1, FP_PROPS_TEXT_MAX) || !isText(f.value, 0, FP_PROPS_TEXT_MAX)) return null;
    if (!isBool(f.visible) || !isLayerName(f.layer)) return null;
    out.addField = { name: f.name, value: f.value, visible: f.visible, layer: f.layer };
  }
  if (has(v, 'removeField')) { if (!isText(v.removeField, 1, FP_PROPS_TEXT_MAX)) return null; out.removeField = v.removeField; }
  if (has(v, 'type')) { if (!oneOf(v.type, FP_TYPES)) return null; out.type = v.type; }
  for (const k of BOOL_KEYS) if (has(v, k)) { if (!isBool(v[k])) return null; out[k] = v[k] as boolean; }
  if (has(v, 'clearance')) { if (!isLength(0, FP_MARGIN_MAX_MM)(v.clearance)) return null; out.clearance = v.clearance as number | null; }
  for (const k of ['maskMargin', 'pasteMargin'] as const) {
    if (has(v, k)) { if (!isLength(-FP_MARGIN_MAX_MM, FP_MARGIN_MAX_MM)(v[k])) return null; out[k] = v[k] as number | null; }
  }
  if (has(v, 'pasteRatio')) { if (!isLength(-1, 1)(v.pasteRatio)) return null; out.pasteRatio = v.pasteRatio as number | null; }
  if (has(v, 'zoneConnection')) { if (!oneOf(v.zoneConnection, ZONE_CONNECTIONS)) return null; out.zoneConnection = v.zoneConnection; }
  if (has(v, 'netTieGroups')) {
    const g = listOf(v.netTieGroups, FP_GROUPS_MAX, (x): x is string => isText(x, 0, FP_PROPS_TEXT_MAX));
    if (g == null) return null;
    out.netTieGroups = g;
  }
  if (has(v, 'jumpers')) {
    const j = v.jumpers;
    if (!isObj(j) || !exactKeys(j, ['duplicateNumbersAreJumpers', 'groups']) || !isBool(j.duplicateNumbersAreJumpers)) return null;
    const groups = listOf(j.groups, FP_GROUPS_MAX, (g): g is string[] => listOf(g, FP_GROUP_PADS_MAX, (n): n is string => isText(n, 1, FP_PROPS_TEXT_MAX)) != null);
    if (groups == null) return null;
    out.jumpers = { duplicateNumbersAreJumpers: j.duplicateNumbersAreJumpers, groups: groups.map((g) => [...g]) };
  }
  if (has(v, 'privateLayers')) {
    const l = layerList(v.privateLayers);
    if (l == null) return null;
    out.privateLayers = l;
  }
  if (has(v, 'customStackup')) {
    const c = v.customStackup;
    if (!isObj(c) || !exactKeys(c, ['on', 'copperLayers']) || !isBool(c.on) || !isInt(c.copperLayers, 2, 32) || c.copperLayers % 2 !== 0) return null;
    out.customStackup = { on: c.on, copperLayers: c.copperLayers };
  }
  if (has(v, 'userLayerNames')) {
    const n = readUserLayerNames(v.userLayerNames);
    if (n == null) return null;
    out.userLayerNames = n;
  }
  if (has(v, 'models')) {
    if (!Array.isArray(v.models) || v.models.length > FP_MODELS_MAX) return null;
    const models: Model3D[] = [];
    for (const m of v.models as unknown[]) {
      const model = readModel(m, true);
      if (model == null) return null;
      models.push(model);
    }
    out.models = models;
  }
  return out;
}

/** fpedit.footprint.set's args: exactly `{ set }`, a FootprintSet; null for anything else. */
export function parseFootprintSetArgs(args: unknown): { set: FootprintSet } | null {
  if (!isObj(args) || !exactKeys(args, ['set'])) return null;
  const set = parseFootprintSet(args.set);
  return set == null ? null : { set };
}

const isEmbedName = (v: unknown): v is string => isText(v, 1, EMBED_NAME_MAX) && v !== '.' && v !== '..' && !/[/\\]/.test(v);

/**
 * fpedit.embed's args: exactly `{ name, type, bytes }` (a name of 1 to 255
 * characters, no slash or backslash, never "." or ".."; `type` model,
 * datasheet, font or other; the file's bytes, a Uint8Array of 1 byte to
 * 25 MiB), or exactly `{ remove }` (a name). Null for anything else.
 */
export function parseFpEmbedArgs(args: unknown): FpEmbedArgs | null {
  if (!isObj(args)) return null;
  if (exactKeys(args, ['remove'])) return isEmbedName(args.remove) ? { remove: args.remove } : null;
  if (!exactKeys(args, ['name', 'type', 'bytes']) || !isEmbedName(args.name) || !oneOf(args.type, EMBED_TYPES)) return null;
  const { bytes } = args;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > EMBED_MAX_BYTES) return null;
  return { name: args.name, type: args.type, bytes };
}

/** fpedit.cleanup's args: exactly `{ mergeRects, deleteRedundant, mergePads, repair, dryRun }`, every one a boolean; null for anything else. */
export function parseFpCleanupArgs(args: unknown): FpCleanupArgs | null {
  if (!isObj(args) || !exactKeys(args, CLEANUP_KEYS) || !CLEANUP_KEYS.every((k) => isBool(args[k]))) return null;
  return {
    mergeRects: args.mergeRects as boolean, deleteRedundant: args.deleteRedundant as boolean, mergePads: args.mergePads as boolean,
    repair: args.repair as boolean, dryRun: args.dryRun as boolean,
  };
}

// ── read backs ─────────────────────────────────────────────────────────────────────────

/** KiCad's lengths come back in whole nanometers and its ratios to six places: values this near are the same. */
const SLACK = 1e-4 + 1e-9;
const near = (a: number | null, b: number | null): boolean => (a === null || b === null ? a === b : Math.abs(a - b) <= SLACK);
const nearVec = (a: Vec3, b: Vec3): boolean => a.every((x, i) => near(x, b[i]));
const sameSet = (a: readonly string[], b: readonly string[]): boolean => new Set(a).size === new Set(b).size && a.every((x) => b.includes(x));
const groupKey = (g: readonly string[]): string => JSON.stringify([...new Set(g)].sort());
const sameGroups = (a: readonly string[][], b: readonly string[][]): boolean =>
  a.length === b.length && JSON.stringify(a.map(groupKey).sort()) === JSON.stringify(b.map(groupKey).sort());
const sameModel = (a: Model3D, b: Model3D): boolean =>
  a.path === b.path && a.show === b.show && near(a.opacity, b.opacity) && nearVec(a.offset, b.offset) && nearVec(a.rotate, b.rotate) && nearVec(a.scale, b.scale);
const sameNames = (a: Record<string, string>, b: Record<string, string>): boolean =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, n]) => b[k] === n);

/**
 * Whether `props` shows every key of `set`: each given value read back (lengths
 * and ratios to KiCad's rounding, layer and group lists as sets, net tie
 * groups without the empty ones KiCad drops), a patched field by its name, the
 * added field present, the removed one gone.
 */
export function showsFootprintSet(set: FootprintSet, props: FootprintProps): boolean {
  for (const k of ['name', 'description', 'keywords', 'type', 'zoneConnection', ...BOOL_KEYS] as const) {
    if (set[k] !== undefined && set[k] !== props[k]) return false;
  }
  for (const k of [...LENGTH_KEYS, 'pasteRatio'] as const) if (set[k] !== undefined && !near(set[k] as number | null, props[k])) return false;
  for (const p of set.fields ?? []) {
    const f = props.fields.find((x) => x.name === p.name);
    if (f == null || (p.value !== undefined && p.value !== f.value) || (p.visible !== undefined && p.visible !== f.visible) || (p.layer !== undefined && p.layer !== f.layer)) return false;
  }
  if (set.addField != null) {
    const a = set.addField;
    if (!props.fields.some((f) => f.name === a.name && f.value === a.value && f.visible === a.visible && f.layer === a.layer)) return false;
  }
  if (set.removeField != null && props.fields.some((f) => f.name === set.removeField)) return false;
  if (set.netTieGroups != null) {
    const want = set.netTieGroups.filter((g) => g !== '');
    if (want.length !== props.netTieGroups.length || want.some((g, i) => g !== props.netTieGroups[i])) return false;
  }
  if (set.jumpers != null && (set.jumpers.duplicateNumbersAreJumpers !== props.jumpers.duplicateNumbersAreJumpers || !sameGroups(set.jumpers.groups, props.jumpers.groups))) return false;
  if (set.privateLayers != null && !sameSet(set.privateLayers, props.privateLayers)) return false;
  if (set.customStackup != null && (set.customStackup.on !== props.customStackup.on || (set.customStackup.on && set.customStackup.copperLayers !== props.customStackup.copperLayers))) return false;
  if (set.userLayerNames != null && !sameNames(set.userLayerNames, props.userLayerNames)) return false;
  if (set.models != null && (set.models.length !== props.models.length || set.models.some((m, i) => !sameModel(m, props.models[i])))) return false;
  return true;
}

// ── the ops ────────────────────────────────────────────────────────────────────────────

const propsOf = (mod: Record<string, unknown>): FootprintProps | null => readFootprintProps(callFpText(mod, 'kicadFpEditFootprintGet'));
const depthOf = (mod: Record<string, unknown>): number | null => readFpEditState(callFpText(mod, 'kicadFpEditState'))?.depth ?? null;
const propsAnswer = (p: FootprintProps): Answer => ok(p as unknown as Record<string, unknown>);
const SHAPE_ERROR = 'the engine answered footprint properties of another shape';

/** fpedit.footprint.get: the open footprint's properties as KiCad's footprint properties dialog shows them. A read. */
export function fpFootprintGet(args: unknown, ctx: ResponderCtx): Answer {
  const op = 'fpedit.footprint.get';
  if (!noArgs(args)) return fail('bad_args', op);
  const g = fpEditGate(ctx, op, true);
  if (fpGated(g)) return g;
  const props = propsOf(g.mod);
  return props == null ? fail('island_error', SHAPE_ERROR) : propsAnswer(props);
}

/**
 * fpedit.footprint.set: the set read closed (bad_args); `userLayerNames` is
 * the editor's and read only (bad_args unless it equals the get's); the
 * engine's own refusals (a mandatory field, a pad number the footprint lacks,
 * a layer in use) answer bad_args, nothing queued. Then ONE commit "Footprint
 * properties", and the answer is the properties read back once they show every
 * key, or the undo step the set made, else not_applied.
 */
export async function fpFootprintSet(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const op = 'fpedit.footprint.set';
  const a = parseFootprintSetArgs(args);
  if (a == null) return fail('bad_args', op);
  const g = fpEditGate(ctx, op, true);
  if (fpGated(g)) return g;
  const { mod, state } = g;
  const before = propsOf(mod);
  if (before == null) return fail('island_error', SHAPE_ERROR);
  if (a.set.userLayerNames != null && !sameNames(a.set.userLayerNames, before.userLayerNames)) {
    return fail('bad_args', `${op}: userLayerNames is the editor's and read only`);
  }
  const t0 = Date.now();
  if (!callFpBool(mod, 'kicadFpEditFootprintSet', JSON.stringify({ set: a.set }))) return fail('bad_args', op);
  const after = await fpReadBack(ctx, fpChangeMs(ctx), () => {
    const now = propsOf(mod);
    if (now == null) return null;
    if (showsFootprintSet(a.set, now)) return now;
    const d = depthOf(mod);
    return d != null && d > state.depth ? now : null;
  });
  if (after == null) return fail('not_applied', op);
  ctx.log(op, Object.keys(a.set).join(' '), `${Date.now() - t0} ms`);
  return propsAnswer(after);
}

/**
 * fpedit.embed: `{ name, type, bytes }` writes the file under a fresh
 * /tmp/cc-embed/<n>/ and embeds it in the footprint (KiCad's own
 * EMBEDDED_FILES, compressed and hashed; a file of that name replaced), ONE
 * commit "Embed a file"; `{ remove }` takes one out (not_found naming it when
 * the footprint embeds no such file), ONE commit "Remove an embedded file".
 * The answer is the properties once `embedded` shows it, the folder removed.
 */
export async function fpEmbed(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const op = 'fpedit.embed';
  const a = parseFpEmbedArgs(args);
  if (a == null) return fail('bad_args', op);
  const g = fpEditGate(ctx, op, true);
  if (fpGated(g)) return g;
  const { mod } = g;
  const before = propsOf(mod);
  if (before == null) return fail('island_error', SHAPE_ERROR);
  if ('remove' in a) {
    const name = a.remove;
    if (!before.embedded.some((e) => e.name === name)) return fail('not_found', name);
    if (!callFpBool(mod, 'kicadFpEditEmbed', JSON.stringify({ remove: name }))) return fail('not_applied', op);
    const after = await fpReadBack(ctx, fpChangeMs(ctx), () => {
      const now = propsOf(mod);
      return now != null && !now.embedded.some((e) => e.name === name) ? now : null;
    });
    return after == null ? fail('not_applied', op) : propsAnswer(after);
  }
  const FS = ctx.fs();
  if (FS == null) return fail('island_error', 'the engine has no file system');
  let dir: string;
  try {
    dir = ctx.freshRunFolder(EMBED_ROOT);
    FS.writeFile(`${dir}/${a.name}`, a.bytes);
  } catch (err) {
    return fail('island_error', err instanceof Error ? err.message : String(err));
  }
  const t0 = Date.now();
  try {
    if (!callFpBool(mod, 'kicadFpEditEmbed', JSON.stringify({ path: `${dir}/${a.name}`, name: a.name, type: a.type }))) {
      return fail('bad_args', `${op}: KiCad refused the file`);
    }
    const size = a.bytes.byteLength;
    const after = await fpReadBack(ctx, fpChangeMs(ctx), () => {
      const now = propsOf(mod);
      return now != null && now.embedded.some((e) => e.name === a.name && e.type === a.type && e.bytes === size) ? now : null;
    });
    if (after == null) return fail('not_applied', op);
    ctx.log(op, a.type, `${size} bytes`, `${Date.now() - t0} ms`);
    return propsAnswer(after);
  } finally {
    ctx.dropRunFolder(dir);
  }
}

/** fpedit.check: KiCad's footprint checker over the open footprint, `{ findings }` in its order. A read. */
export function fpCheck(args: unknown, ctx: ResponderCtx): Answer {
  const op = 'fpedit.check';
  if (!noArgs(args)) return fail('bad_args', op);
  const g = fpEditGate(ctx, op, true);
  if (fpGated(g)) return g;
  const findings = readFpFindings(callFpText(g.mod, 'kicadFpEditCheck'));
  return findings == null ? fail('island_error', 'the engine answered findings of another shape') : ok({ findings });
}

/**
 * fpedit.cleanup: KiCad's Cleanup Graphics (and, with `repair`, Repair
 * Footprint's renewal of duplicate uuids) over the open footprint. The answer
 * `{ items, repaired }` is what a dry run finds; without `dryRun` the same
 * runs as ONE commit "Tidy footprint" and the answer comes once it shows (the
 * undo depth one more), none when nothing is found.
 */
export async function fpCleanup(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const op = 'fpedit.cleanup';
  const a = parseFpCleanupArgs(args);
  if (a == null) return fail('bad_args', op);
  const g = fpEditGate(ctx, op, true);
  if (fpGated(g)) return g;
  const { mod, state } = g;
  const raw = callFpText(mod, 'kicadFpEditCleanup', JSON.stringify(a));
  if (raw === '') return fail('not_applied', op);
  const found = readFpCleanup(raw);
  if (found == null) return fail('island_error', 'the engine answered a tidy of another shape');
  if (!a.dryRun) {
    const changes = found.items.length > 0 || found.repaired > 0;
    const done = await fpReadBack(ctx, fpChangeMs(ctx), () => {
      if (!changes) return true;
      const d = depthOf(mod);
      return d != null && d > state.depth ? true : null;
    });
    if (done == null) return fail('not_applied', op);
  }
  return ok({ items: found.items, repaired: found.repaired });
}

/**
 * fpedit.svg: the open footprint's shown layers plotted by KiCad's own SVG
 * plotter into a fresh /tmp/cc-svg/<n>/, its record (.cc-svg.json) written
 * last; the answer is the file's bytes (transferred, at most 4 MiB), the
 * folder removed. plot_failed when KiCad wrote no SVG.
 */
export async function fpSvg(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const op = 'fpedit.svg';
  if (!noArgs(args)) return fail('bad_args', op);
  const g = fpEditGate(ctx, op, true);
  if (fpGated(g)) return g;
  const { mod } = g;
  let dir: string;
  try { dir = ctx.freshRunFolder(FP_SVG_ROOT); } catch (err) { return fail('island_error', err instanceof Error ? err.message : String(err)); }
  const t0 = Date.now();
  const run = await ctx.queuedRun(op, dir, ctx.timing.svgMs ?? 30_000,
    () => callFpBool(mod, 'kicadFpEditPlotSvg', JSON.stringify({ dir })),
    () => readSvgDone(ctx.readBytes(`${dir}/${FP_SVG_DONE}`)));
  if (!('done' in run)) return run;
  const bytes = ctx.readBytes(`${dir}/${FP_SVG_FILE}`);
  ctx.dropRunFolder(dir);
  if (run.done.error !== '' || bytes == null || bytes.byteLength === 0) return fail('plot_failed', 'KiCad wrote no SVG');
  if (bytes.byteLength > FP_SVG_MAX_BYTES) return fail('island_error', 'the SVG is larger than the protocol carries');
  const own = bytes.slice();
  ctx.log(op, `${own.byteLength} bytes`, `${Date.now() - t0} ms`);
  return { ok: true, result: { bytes: own }, transfer: [own.buffer as ArrayBuffer] };
}

export default {
  unit: 'fp-i3',
  frames: [FPEDIT_FRAME],
  frameRefusal: FPEDIT_FRAME_ONLY,
  ops: {
    'fpedit.footprint.get': { run: fpFootprintGet, passesCheck: true },
    'fpedit.footprint.set': { run: fpFootprintSet },
    'fpedit.embed': { run: fpEmbed },
    'fpedit.check': { run: fpCheck, passesCheck: true },
    'fpedit.cleanup': { run: fpCleanup },
    'fpedit.svg': { run: fpSvg },
  },
} satisfies ExtUnit;
