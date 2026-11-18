// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The item records of a footprint's items (FP spec 7.2), frame neutral: the
// footprint editor's fpedit.items ops read them here, and the board form's new
// kinds read the same records (M4). Each reader checks a record closed: every
// key the kind takes and no other, each in its type and bounds, a string at
// most 1,024 characters unless named, a number finite, a uuid lower case,
// a layer a KiCad layer name. Any other shape reads as null (the op answers
// island_error). The keys are the engine's, as its kind rows write them:
// the pad from DIALOG_PAD_PROPERTIES (with the dialog's unconnected layers,
// teardrop, backdrill and post machining), the field, text, text box, table
// and barcode from their KiCad dialogs, the shape and the picture from FP
// spec 7.2. The dimension, the rule area and the point have no reader yet:
// their keys are written by the engine's shape kinds, which this file
// mirrors once they exist.
import { LAYER_RE } from './boardCheck';
import { UUID_RE } from './symbol';
import { isText } from './symedit';

/** The kind names of the engine's item table, in its order. */
export const ITEM_RECORD_KINDS = ['pad', 'field', 'text', 'textbox', 'shape', 'dimension', 'zone', 'table', 'barcode', 'image', 'point'] as const;
export type ItemRecordKind = typeof ITEM_RECORD_KINDS[number];

/** A string of a record: at most 1,024 characters. */
export const RECORD_TEXT_MAX = 1024;
/** A multi line text (a text outside a footprint, a text box, a table cell): at most 8,192 characters. */
export const RECORD_LINES_MAX = 8192;
/** Positions: at most 50 m from the origin, in mm. */
export const POSITION_MAX_MM = 50_000;
/** Sizes, widths and margins: at most 1 m, in mm. */
export const SIZE_MAX_MM = 1000;
/** KiCad's text sizes (eda_text.h TEXT_MIN_SIZE_MM, TEXT_MAX_SIZE_MM). */
export const TEXT_SIZE_MIN_MM = 0.001;
export const TEXT_SIZE_MAX_MM = 250;
/** Angles in degrees, either way round. */
export const ANGLE_MAX = 360;
/** A custom pad's primitives. */
export const PRIMITIVES_MAX = 512;
/** Points of one shape or primitive. */
export const POINTS_MAX = 4096;
/** Layers of one item. */
export const LAYERS_MAX = 256;
/** A pad's per layer shapes (every copper layer but F.Cu). */
export const LAYER_SHAPES_MAX = 32;
/** A pad's die delay, in ps (the pad dialog's range). */
export const DIE_DELAY_MAX_PS = 2000;
/** A table's rows and columns. */
export const TABLE_LINES_MAX = 64;
/** A picture's PNG on add, decoded: at most 4 MiB. */
export const IMAGE_ADD_MAX_BYTES = 4 * 1024 * 1024;
/** A picture's PNG on get: past 64 KiB the record carries its size in bytes and no png. */
export const IMAGE_GET_MAX_BYTES = 64 * 1024;
/** A table, a teardrop: ratios KiCad keeps (a fraction, never past 100). */
const RATIO_MAX = 100;

export const PAD_TYPES = ['smd', 'th', 'npth', 'conn', 'aperture'] as const;
export const PADSTACK_MODES = ['normal', 'front_inner_back', 'custom'] as const;
export const PAD_SHAPES = ['circle', 'rect', 'oval', 'trapezoid', 'roundrect', 'chamfered_rect', 'custom'] as const;
export const PAD_ANCHORS = ['circle', 'rect'] as const;
export const CHAMFER_CORNERS = ['tl', 'tr', 'bl', 'br'] as const;
export const PRIM_SHAPES = ['line', 'arc', 'rect', 'circle', 'polygon', 'bezier'] as const;
export const DRILL_SHAPES = ['circle', 'oval'] as const;
export const ZONE_CONNECTIONS = ['inherit', 'none', 'thermal', 'solid'] as const;
export const CUSTOM_ZONE_SHAPES = ['outline', 'convexhull'] as const;
export const PAD_PROPERTIES = ['none', 'bga', 'fiducial_global', 'fiducial_local', 'testpoint', 'heatsink', 'castellated', 'mechanical', 'pressfit'] as const;
export const UNCONNECTED_LAYERS = ['keep_all', 'remove_except_start_and_end', 'remove_all'] as const;
export const POST_MACHINING_MODES = ['none', 'countersink', 'counterbore'] as const;
export const H_JUSTIFY = ['left', 'center', 'right'] as const;
export const V_JUSTIFY = ['top', 'center', 'bottom'] as const;
export const LINE_STYLES = ['solid', 'dash', 'dot', 'dash_dot', 'dash_dot_dot'] as const;
export const SHAPE_NAMES = ['segment', 'rect', 'arc', 'circle', 'polygon', 'bezier'] as const;
export const ERROR_CORRECTIONS = ['L', 'M', 'Q', 'H'] as const;

export type Point = [number, number];
export interface PadPrimRecord { shape: typeof PRIM_SHAPES[number]; points: Point[]; width: number; filled: boolean }
export interface PadShapeRecord {
  shape: typeof PAD_SHAPES[number]; size: Point; offset: Point; delta: Point; roundRatio: number; chamferRatio: number;
  chamferCorners: Array<typeof CHAMFER_CORNERS[number]>; anchor: typeof PAD_ANCHORS[number]; primitives: PadPrimRecord[];
}
export interface PadDrillRecord { shape: typeof DRILL_SHAPES[number]; size: Point }
export interface PadTeardropRecord {
  enabled: boolean; useTwoTracks: boolean; preferZoneConnection: boolean; maxLength: number; maxWidth: number;
  lengthRatio: number; widthRatio: number; curved: boolean; sizeFilterRatio: number;
}
export interface PadBackdrillSide { size: number; end: string | null }
export interface PadPostMachiningSide { mode: typeof POST_MACHINING_MODES[number]; size: number; depth: number; angle: number }
export interface PadRecord {
  kind: 'pad'; uuid: string; number: string; pinName: string; pinType: string; type: typeof PAD_TYPES[number];
  x: number; y: number; angle: number; locked: boolean; padstack: typeof PADSTACK_MODES[number]; copper: PadShapeRecord;
  layerShapes: Array<{ layer: string; copper: PadShapeRecord }>; drill: PadDrillRecord | null; layers: string[];
  dieLength: number; dieDelay: number; clearance: number | null; maskMargin: number | null; pasteMargin: number | null;
  pasteRatio: number | null; zoneConnection: typeof ZONE_CONNECTIONS[number]; customZoneShape: typeof CUSTOM_ZONE_SHAPES[number];
  thermalSpokeWidth: number | null; thermalGap: number | null; thermalAngle: number; property: typeof PAD_PROPERTIES[number];
  unconnectedLayers: typeof UNCONNECTED_LAYERS[number]; teardrop: PadTeardropRecord;
  backdrill: { front: PadBackdrillSide | null; back: PadBackdrillSide | null };
  postMachining: { front: PadPostMachiningSide; back: PadPostMachiningSide };
}
/** The text keys a field, a text and a text box share. */
export interface TextStyleRecord {
  layer: string; angle: number; size: Point; thickness: number; autoThickness: boolean; bold: boolean; italic: boolean;
  mirrored: boolean; hJustify: typeof H_JUSTIFY[number]; vJustify: typeof V_JUSTIFY[number]; knockout: boolean; font: string;
}
/** A field (`visible`, `keepUpright`) or a text (`keepUpright` inside a footprint, `locked` outside one; `name` ""). */
export interface TextItemRecord extends TextStyleRecord {
  kind: 'field' | 'text'; uuid: string; name: string; text: string; x: number; y: number;
  visible?: boolean; keepUpright?: boolean; locked?: boolean;
}
export interface TextboxItemRecord extends TextStyleRecord {
  kind: 'textbox'; uuid: string; text: string; points: Point[]; locked: boolean; border: boolean; borderWidth: number;
  borderStyle: typeof LINE_STYLES[number];
}
export interface TableItemRecord {
  kind: 'table'; uuid: string; x: number; y: number; layer: string; locked: boolean; cells: Array<Array<string | null>>;
  borderExternal: boolean; borderHeader: boolean; borderWidth: number | null; borderStyle: typeof LINE_STYLES[number];
  rowSeparators: boolean; colSeparators: boolean; separatorsWidth: number; separatorsStyle: typeof LINE_STYLES[number];
  rows: number; cols: number; colWidths: number[]; rowHeights: number[];
}
/** A barcode; its symbology has no key yet (the engine writes it under `kind`, which the item's own kind overwrites). */
export interface BarcodeItemRecord {
  kind: 'barcode'; uuid: string; text: string; layer: string; locked: boolean; x: number; y: number; width: number; height: number;
  textSize: number; angle: number; knockout: boolean; margin: number; showText: boolean; errorCorrection: typeof ERROR_CORRECTIONS[number];
}
export interface ShapeItemRecord {
  kind: 'shape'; uuid: string; layer: string; shape: typeof SHAPE_NAMES[number]; points: Point[]; width: number;
  style: typeof LINE_STYLES[number]; filled: boolean; locked: boolean;
}
/** A reference picture: `png` base64 while it is at most 64 KiB, else `bytes` its size and no png. */
export interface ImageItemRecord { kind: 'image'; uuid: string; x: number; y: number; scale: number; layer: string; png?: string; bytes?: number }
export type ItemRecord = PadRecord | TextItemRecord | TextboxItemRecord | TableItemRecord | BarcodeItemRecord | ShapeItemRecord | ImageItemRecord;

/** The kinds this file reads; the others read as null until their keys are mirrored here. */
export const READABLE_KINDS: readonly ItemRecordKind[] = Object.freeze(['pad', 'field', 'text', 'textbox', 'shape', 'table', 'barcode', 'image']);

// ── checks ─────────────────────────────────────────────────────────────────────────────

type Check = (v: unknown) => boolean;
export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const has = (o: Record<string, unknown>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => has(o, k));
};
const within = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).every((k) => keys.includes(k));
const oneOf = <T extends string>(all: readonly T[]): Check => (v) => typeof v === 'string' && (all as readonly string[]).includes(v);
const isBool: Check = (v) => typeof v === 'boolean';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const inRange = (min: number, max: number): Check => (v) => isNum(v) && v >= min && v <= max;
const isInt = (min: number, max: number): Check => (v) => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const orNull = (c: Check): Check => (v) => v === null || c(v);
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
export const isLayerName = (v: unknown): v is string => typeof v === 'string' && LAYER_RE.test(v);
const isPos = inRange(-POSITION_MAX_MM, POSITION_MAX_MM);
const isSize = inRange(0, SIZE_MAX_MM);
const isSigned = inRange(-SIZE_MAX_MM, SIZE_MAX_MM);
const isAngle = inRange(-ANGLE_MAX, ANGLE_MAX);
const line: Check = (v) => isText(v, 0, RECORD_TEXT_MAX);
const lines: Check = (v) => isText(v, 0, RECORD_LINES_MAX, true);
const pair = (c: Check): Check => (v) => Array.isArray(v) && v.length === 2 && c(v[0]) && c(v[1]);
const isPoint = pair(isPos);
const textSize = pair(inRange(TEXT_SIZE_MIN_MM, TEXT_SIZE_MAX_MM));
/** A list of `min` to `max` items each passing `c`, none twice when `unique`. */
const listOf = (c: Check, min: number, max: number, unique = false): Check => (v) =>
  Array.isArray(v) && v.length >= min && v.length <= max && v.every(c) && (!unique || new Set(v).size === v.length);
const layerList = listOf(isLayerName, 0, LAYERS_MAX, true);

/** Each key of `checks` present in `o` passes its check; `full` asks every key, `o` holding no other either way. */
function fits(o: unknown, checks: Readonly<Record<string, Check>>, full: boolean): o is Record<string, unknown> {
  if (!isObj(o)) return false;
  const keys = Object.keys(checks);
  if (full ? !exactKeys(o, keys) : !within(o, keys)) return false;
  return Object.entries(o).every(([k, v]) => checks[k](v));
}

// ── the pad ────────────────────────────────────────────────────────────────────────────

/** The point count a primitive takes: a line or a rectangle 2, an arc 3 (start, middle, end), a circle 2 (center, a point on it), a curve 4, a polygon 3 or more. */
export function primPointsFit(shape: typeof PRIM_SHAPES[number], n: number): boolean {
  if (shape === 'line' || shape === 'rect' || shape === 'circle') return n === 2;
  if (shape === 'arc') return n === 3;
  if (shape === 'bezier') return n === 4;
  return n >= 3 && n <= POINTS_MAX;
}
const PRIM_CHECKS: Readonly<Record<string, Check>> = Object.freeze({
  shape: oneOf(PRIM_SHAPES), points: listOf(isPoint, 2, POINTS_MAX), width: isSize, filled: isBool,
});
const isPrim: Check = (v) => fits(v, PRIM_CHECKS, true) && primPointsFit(v.shape as typeof PRIM_SHAPES[number], (v.points as unknown[]).length);
const PAD_SHAPE_CHECKS: Readonly<Record<string, Check>> = Object.freeze({
  shape: oneOf(PAD_SHAPES),
  size: pair(isSize),
  offset: pair(isSigned),
  delta: pair(isSigned),
  roundRatio: inRange(0, 0.5),
  chamferRatio: inRange(0, 0.5),
  chamferCorners: listOf(oneOf(CHAMFER_CORNERS), 0, 4, true),
  anchor: oneOf(PAD_ANCHORS),
  primitives: listOf(isPrim, 0, PRIMITIVES_MAX),
});
/** A pad shape: whole on a read (primitives only on a custom shape), any of its keys on a set. */
const padShape = (full: boolean): Check => (v) => {
  if (!fits(v, PAD_SHAPE_CHECKS, full)) return false;
  return !full || v.shape === 'custom' || (v.primitives as unknown[]).length === 0;
};
const layerShapes = (full: boolean): Check => (v) => {
  if (!Array.isArray(v) || v.length > LAYER_SHAPES_MAX) return false;
  const seen = new Set<string>();
  for (const e of v) {
    if (!isObj(e) || !exactKeys(e, ['layer', 'copper']) || !isLayerName(e.layer) || e.layer === 'F.Cu' || seen.has(e.layer)) return false;
    if (!padShape(full)(e.copper)) return false;
    seen.add(e.layer);
  }
  return true;
};
const DRILL_CHECKS: Readonly<Record<string, Check>> = Object.freeze({ shape: oneOf(DRILL_SHAPES), size: pair(isSize) });
const TEARDROP_CHECKS: Readonly<Record<string, Check>> = Object.freeze({
  enabled: isBool, useTwoTracks: isBool, preferZoneConnection: isBool, maxLength: isSize, maxWidth: isSize,
  lengthRatio: inRange(0, RATIO_MAX), widthRatio: inRange(0, RATIO_MAX), curved: isBool, sizeFilterRatio: inRange(0, RATIO_MAX),
});
const BACKDRILL_SIDE: Check = orNull((v) => fits(v, { size: isSize, end: orNull(isLayerName) }, true));
const POST_SIDE: Check = (v) => fits(v, { mode: oneOf(POST_MACHINING_MODES), size: isSize, depth: isSize, angle: inRange(0, 180) }, true);
/** Backdrill and post machining: both sides on a read, either on a set, a side always whole. */
const sides = (side: Check, full: boolean): Check => (v) => fits(v, { front: side, back: side }, full) && Object.keys(v).length > 0;

const padChecks = (full: boolean): Readonly<Record<string, Check>> => ({
  number: line, pinName: line, pinType: line,
  type: oneOf(PAD_TYPES),
  x: isPos, y: isPos, angle: isAngle, locked: isBool,
  padstack: oneOf(PADSTACK_MODES),
  copper: padShape(full),
  layerShapes: layerShapes(full),
  drill: orNull((v) => fits(v, DRILL_CHECKS, true)),
  layers: layerList,
  dieLength: isSize,
  dieDelay: inRange(0, DIE_DELAY_MAX_PS),
  clearance: orNull(isSigned), maskMargin: orNull(isSigned), pasteMargin: orNull(isSigned),
  pasteRatio: orNull(inRange(-1, 1)),
  zoneConnection: oneOf(ZONE_CONNECTIONS),
  customZoneShape: oneOf(CUSTOM_ZONE_SHAPES),
  thermalSpokeWidth: orNull(isSize), thermalGap: orNull(isSize),
  thermalAngle: isAngle,
  property: oneOf(PAD_PROPERTIES),
  unconnectedLayers: oneOf(UNCONNECTED_LAYERS),
  teardrop: (v) => fits(v, TEARDROP_CHECKS, full),
  backdrill: sides(BACKDRILL_SIDE, full),
  postMachining: sides(POST_SIDE, full),
});
const PAD_READ = Object.freeze(padChecks(true));
const PAD_SET = Object.freeze(padChecks(false));

// ── the texts ──────────────────────────────────────────────────────────────────────────

const TEXT_STYLE: Readonly<Record<string, Check>> = Object.freeze({
  layer: isLayerName, angle: isAngle, size: textSize, thickness: isSize, autoThickness: isBool, bold: isBool, italic: isBool,
  mirrored: isBool, hJustify: oneOf(H_JUSTIFY), vJustify: oneOf(V_JUSTIFY), knockout: isBool, font: line,
});
/** A field: a name, a single line, shown or not, kept upright or not. */
const FIELD_KEYS: Readonly<Record<string, Check>> = Object.freeze({ ...TEXT_STYLE, name: line, text: line, x: isPos, y: isPos, visible: isBool, keepUpright: isBool });
/** A text inside a footprint (a single line, kept upright or not) and one outside a footprint (lines, locked or not). */
const FP_TEXT_KEYS: Readonly<Record<string, Check>> = Object.freeze({ ...TEXT_STYLE, name: line, text: line, x: isPos, y: isPos, keepUpright: isBool });
const BOARD_TEXT_KEYS: Readonly<Record<string, Check>> = Object.freeze({ ...TEXT_STYLE, name: line, text: lines, x: isPos, y: isPos, locked: isBool });
/** A text box: a cardinal box reads [start, end], a rotated one its four corners. */
const TEXTBOX_KEYS: Readonly<Record<string, Check>> = Object.freeze({
  ...TEXT_STYLE, text: lines, points: (v) => listOf(isPoint, 2, 4)(v) && (v as unknown[]).length !== 3, locked: isBool,
  border: isBool, borderWidth: isSize, borderStyle: oneOf(LINE_STYLES),
});
const cells: Check = (v) => Array.isArray(v) && v.length >= 1 && v.length <= TABLE_LINES_MAX
  && v.every((row) => Array.isArray(row) && row.length >= 1 && row.length <= TABLE_LINES_MAX && row.every(orNull(lines)) && row.length === (v[0] as unknown[]).length);
const TABLE_KEYS: Readonly<Record<string, Check>> = Object.freeze({
  x: isPos, y: isPos, layer: isLayerName, locked: isBool, cells,
  borderExternal: isBool, borderHeader: isBool, borderWidth: orNull(isSize), borderStyle: oneOf(LINE_STYLES),
  rowSeparators: isBool, colSeparators: isBool, separatorsWidth: isSize, separatorsStyle: oneOf(LINE_STYLES),
  rows: isInt(1, TABLE_LINES_MAX), cols: isInt(1, TABLE_LINES_MAX),
  colWidths: listOf(inRange(0, SIZE_MAX_MM), 1, TABLE_LINES_MAX), rowHeights: listOf(inRange(0, SIZE_MAX_MM), 1, TABLE_LINES_MAX),
});
/** A table read whole: its cells rows by cols, a width per column and a height per row. */
function tableAgrees(v: Record<string, unknown>): boolean {
  const rows = v.rows as number;
  const cols = v.cols as number;
  return (v.cells as unknown[][]).length === rows && (v.cells as unknown[][])[0].length === cols
    && (v.colWidths as unknown[]).length === cols && (v.rowHeights as unknown[]).length === rows;
}
const BARCODE_KEYS: Readonly<Record<string, Check>> = Object.freeze({
  text: line, layer: isLayerName, locked: isBool, x: isPos, y: isPos, width: isSize, height: isSize, textSize: isSize,
  angle: isAngle, knockout: isBool, margin: isSize, showText: isBool, errorCorrection: oneOf(ERROR_CORRECTIONS),
});

// ── the shapes and the picture ─────────────────────────────────────────────────────────

/** The point count a shape takes: a segment, a rectangle or a circle (center, a point on it) 2, an arc 3, a curve 4, a polygon 3 or more. */
export function shapePointsFit(shape: typeof SHAPE_NAMES[number], n: number): boolean {
  if (shape === 'segment' || shape === 'rect' || shape === 'circle') return n === 2;
  if (shape === 'arc') return n === 3;
  if (shape === 'bezier') return n === 4;
  return n >= 3 && n <= POINTS_MAX;
}
const SHAPE_KEYS: Readonly<Record<string, Check>> = Object.freeze({
  layer: isLayerName, shape: oneOf(SHAPE_NAMES), points: listOf(isPoint, 2, POINTS_MAX), width: isSize,
  style: oneOf(LINE_STYLES), filled: isBool, locked: isBool,
});
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** The PNG signature as base64 begins. */
const PNG_BASE64_HEAD = 'iVBORw0KGgo';
/** The decoded size of a base64 text. */
export const base64Bytes = (s: string): number => (s.length / 4) * 3 - (s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0);
/** A PNG as base64 of at most `max` bytes decoded. */
export const isPngBase64 = (max: number): Check => (v) =>
  typeof v === 'string' && v.length > 0 && v.length <= Math.ceil(max / 3) * 4 && BASE64_RE.test(v) && v.startsWith(PNG_BASE64_HEAD) && base64Bytes(v) <= max;
const IMAGE_SET: Readonly<Record<string, Check>> = Object.freeze({
  x: isPos, y: isPos, scale: inRange(Number.MIN_VALUE, 1000), layer: isLayerName, png: isPngBase64(IMAGE_ADD_MAX_BYTES),
});
const IMAGE_READ: Readonly<Record<string, Check>> = Object.freeze({
  x: isPos, y: isPos, scale: inRange(Number.MIN_VALUE, 1000), layer: isLayerName,
});

// ── the readers ────────────────────────────────────────────────────────────────────────

/** The record's own keys less kind and uuid, null when it lacks either or names another kind. */
function body(kind: ItemRecordKind, value: unknown): Record<string, unknown> | null {
  if (!isObj(value) || value.kind !== kind || !isUuid(value.uuid)) return null;
  const { kind: _k, uuid: _u, ...rest } = value;
  void _k; void _u;
  return rest;
}
const record = <T>(kind: ItemRecordKind, uuid: unknown, rest: Record<string, unknown>): T => ({ kind, uuid, ...structuredClone(rest) }) as T;

/**
 * One item record of `kind` read closed: `value` carries `kind` (that kind)
 * and its lower case `uuid` and exactly the keys the kind takes. A field
 * carries `visible` and `keepUpright`; a text `keepUpright` inside a footprint
 * or `locked` outside one (lines only there); a custom pad shape alone carries
 * primitives; a table's cells are rows by cols; a picture carries `png`
 * (base64, at most 64 KiB decoded) or `bytes` past that. Null for a kind with
 * no reader (dimension, zone, point) and for any other shape.
 */
export function readItemRecord(kind: ItemRecordKind | string, value: unknown): ItemRecord | null {
  if (!(ITEM_RECORD_KINDS as readonly string[]).includes(kind)) return null;
  const k = kind as ItemRecordKind;
  const rest = body(k, value);
  if (rest == null) return null;
  const uuid = (value as Record<string, unknown>).uuid;
  switch (k) {
    case 'pad': {
      if (!fits(rest, PAD_READ, true)) return null;
      if (rest.padstack === 'normal' && (rest.layerShapes as unknown[]).length > 0) return null;
      return record<PadRecord>(k, uuid, rest);
    }
    case 'field':
      return fits(rest, FIELD_KEYS, true) && isText(rest.name, 1, RECORD_TEXT_MAX) ? record<TextItemRecord>(k, uuid, rest) : null;
    case 'text':
      if (!(fits(rest, FP_TEXT_KEYS, true) || fits(rest, BOARD_TEXT_KEYS, true)) || rest.name !== '') return null;
      return record<TextItemRecord>(k, uuid, rest);
    case 'textbox':
      return fits(rest, TEXTBOX_KEYS, true) ? record<TextboxItemRecord>(k, uuid, rest) : null;
    case 'table':
      return fits(rest, TABLE_KEYS, true) && tableAgrees(rest) ? record<TableItemRecord>(k, uuid, rest) : null;
    case 'barcode':
      return fits(rest, BARCODE_KEYS, true) ? record<BarcodeItemRecord>(k, uuid, rest) : null;
    case 'shape':
      if (!fits(rest, SHAPE_KEYS, true) || !shapePointsFit(rest.shape as typeof SHAPE_NAMES[number], (rest.points as unknown[]).length)) return null;
      return record<ShapeItemRecord>(k, uuid, rest);
    case 'image': {
      const { png, bytes, ...place } = rest;
      if (!fits(place, IMAGE_READ, true)) return null;
      if (png !== undefined) {
        if (!isPngBase64(IMAGE_GET_MAX_BYTES)(png) || (bytes !== undefined && bytes !== base64Bytes(png as string))) return null;
      } else if (!(Number.isSafeInteger(bytes) && (bytes as number) > IMAGE_GET_MAX_BYTES)) {
        return null;
      }
      return record<ImageItemRecord>(k, uuid, rest);
    }
    default:
      return null;
  }
}

/** The keys a set or a new item of each readable kind may carry, with their checks (a pad's nested keys partial). */
const SET_CHECKS: Readonly<Partial<Record<ItemRecordKind, Readonly<Record<string, Check>>>>> = Object.freeze({
  pad: PAD_SET,
  field: FIELD_KEYS,
  text: Object.freeze({ ...FP_TEXT_KEYS, ...BOARD_TEXT_KEYS }),
  textbox: TEXTBOX_KEYS,
  table: TABLE_KEYS,
  barcode: BARCODE_KEYS,
  shape: SHAPE_KEYS,
  image: IMAGE_SET,
});

/** The keys a set of `kind` may name (never kind or uuid), empty for a kind with no reader. */
export const itemSetKeys = (kind: ItemRecordKind): string[] => Object.keys(SET_CHECKS[kind] ?? {});

/**
 * A set of `kind` read closed: a non empty object of keys the kind takes, each
 * in its type and bounds; a pad's `copper`, each `layerShapes` entry's copper
 * and `teardrop` partial, `primitives` and `layerShapes` replacing what they
 * name, a backdrill or post machining side whole; a text never empty; a table
 * with no cells (its rows, cols, widths and heights are KiCad's to compare).
 * Null for anything else.
 */
export function readItemSet(kind: ItemRecordKind, set: unknown): Record<string, unknown> | null {
  const checks = SET_CHECKS[kind];
  if (checks == null || !isObj(set) || Object.keys(set).length === 0 || has(set, 'kind') || has(set, 'uuid')) return null;
  if (!fits(set, checks, false)) return null;
  if (has(set, 'text') && set.text === '') return null;
  if (kind === 'shape' && has(set, 'points') && has(set, 'shape') && !shapePointsFit(set.shape as typeof SHAPE_NAMES[number], (set.points as unknown[]).length)) return null;
  if (kind === 'image' && has(set, 'png')) return null;
  return structuredClone(set);
}

/** The keys a new item of each kind must carry besides kind and uuid (the engine builds the rest as KiCad's tools make the item). */
export const NEW_ITEM_NEEDS: Readonly<Partial<Record<ItemRecordKind, readonly string[]>>> = Object.freeze({
  pad: [],
  field: ['name', 'layer'],
  text: ['text', 'layer'],
  textbox: ['text', 'layer', 'points'],
  table: ['layer', 'colWidths', 'rowHeights'],
  barcode: ['layer'],
  shape: ['layer', 'shape', 'points'],
  image: ['layer', 'png'],
});

/**
 * A new item read closed: its `kind` (a readable kind), its page made lower
 * case `uuid`, the keys its kind needs (NEW_ITEM_NEEDS) and any other key a
 * set of the kind takes. A new field may start with an empty text and its
 * name never empty; a new table's cells, when given, rows by cols of its
 * widths and heights; a picture's png at most 4 MiB decoded. Null for anything else.
 */
export function readNewItem(value: unknown): (Record<string, unknown> & { kind: ItemRecordKind; uuid: string }) | null {
  if (!isObj(value) || typeof value.kind !== 'string' || !(ITEM_RECORD_KINDS as readonly string[]).includes(value.kind) || !isUuid(value.uuid)) return null;
  const kind = value.kind as ItemRecordKind;
  const checks = SET_CHECKS[kind];
  const needs = NEW_ITEM_NEEDS[kind];
  if (checks == null || needs == null) return null;
  const { kind: _k, uuid: _u, ...rest } = value;
  void _k; void _u;
  if (!needs.every((k) => has(rest, k)) || !fits(rest, checks, false)) return null;
  if (has(rest, 'text') && rest.text === '' && kind !== 'field') return null;
  if (kind === 'field' && !isText(rest.name, 1, RECORD_TEXT_MAX)) return null;
  if (kind === 'shape' && !shapePointsFit(rest.shape as typeof SHAPE_NAMES[number], (rest.points as unknown[]).length)) return null;
  if (kind === 'table' && has(rest, 'cells')) {
    const c = rest.cells as unknown[][];
    if (c.length !== (rest.rowHeights as unknown[]).length || c[0].length !== (rest.colWidths as unknown[]).length) return null;
  }
  return { ...structuredClone(rest), kind, uuid: value.uuid as string };
}

/** Why `set` does not fit `items` (a key one of them lacks: a set over several items carries only keys every one has), or null. */
export function itemSetMisfit(set: Record<string, unknown>, items: readonly ItemRecord[]): string | null {
  for (const item of items) {
    for (const k of Object.keys(set)) if (!has(item as unknown as Record<string, unknown>, k)) return `${k} does not fit a ${item.kind}`;
    if (item.kind === 'shape' && has(set, 'points') && !has(set, 'shape') && !shapePointsFit(item.shape, (set.points as unknown[]).length)) {
      return `a ${item.shape} takes another count of points`;
    }
  }
  return null;
}

/** A length within KiCad's rounding (1 nm), an angle within a thousandth of a degree. */
const LENGTH_SLACK = 1e-6 + 1e-9;
const ANGLE_SLACK = 1e-3;
const normalAngle = (a: number): number => {
  const r = ((a % 360) + 360) % 360;
  return r > 180 ? r - 360 : r;
};
const ANGLE_KEYS = new Set(['angle', 'thermalAngle']);
/** Lists KiCad keeps in its own order: compared as sets. */
const SET_LIKE_KEYS = new Set(['layers', 'chamferCorners']);
function sameValue(want: unknown, got: unknown, key = ''): boolean {
  if (SET_LIKE_KEYS.has(key) && Array.isArray(want)) {
    if (!Array.isArray(got)) return false;
    const g = new Set(got as unknown[]);
    return want.length === g.size && want.every((w) => g.has(w));
  }
  if (isNum(want)) {
    if (!isNum(got)) return false;
    if (ANGLE_KEYS.has(key)) {
      const d = Math.abs(normalAngle(want) - normalAngle(got));
      return Math.min(d, 360 - d) <= ANGLE_SLACK;
    }
    return Math.abs(want - got) <= LENGTH_SLACK;
  }
  if (Array.isArray(want)) return Array.isArray(got) && got.length === want.length && want.every((w, i) => sameValue(w, got[i], key));
  if (isObj(want)) return isObj(got) && Object.keys(want).every((k) => sameValue(want[k], got[k], k));
  return want === got;
}

/**
 * Whether an item read back shows every key of `set`: each value (a nested
 * pad shape or teardrop by the keys given, a length within KiCad's rounding,
 * an angle by its direction; layers and a pad's chamfer corners as sets).
 */
export function showsItemSet(set: Record<string, unknown>, item: ItemRecord): boolean {
  const got = item as unknown as Record<string, unknown>;
  return Object.entries(set).every(([k, want]) => sameValue(want, got[k], k));
}
