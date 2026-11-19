// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The item records of a footprint's items (FP spec 7.2), frame neutral: the
// footprint editor's fpedit.items ops read them here, and the board form's new
// kinds read the same records (M4). Each reader checks a record closed: every
// key the kind takes and no other, each in its type and bounds, a string at
// most 1,024 characters unless named, a number finite, a uuid lower case,
// a layer a KiCad layer name. Any other shape reads as null (the op answers
// island_error). The keys are the engine's, as its kind rows write them
// (engine run 15, pcbjam wasm/bindings cc_item_pad.h, cc_item_text.h and
// cc_item_shape.h): the pad from DIALOG_PAD_PROPERTIES (with the dialog's
// unconnected layers, teardrop, backdrill and post machining), the field,
// text, text box, table and barcode (its type the key `symbology`) from their
// KiCad dialogs, the shape (with its fill, corner radius and solder mask), the
// dimension, the zone (a rule area or a zone on no copper layer), the picture
// (`bytes` its PNG's own size, `locked` in the board frame) and the point.
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
export const SYMBOLOGIES = ['code39', 'code128', 'datamatrix', 'qr', 'microqr'] as const;
export const FILLS = ['none', 'solid', 'hatch', 'reverse_hatch', 'cross_hatch'] as const;
export const DIM_TYPES = ['aligned', 'orthogonal', 'center', 'radial', 'leader'] as const;
export const DIM_ARROWS = ['inward', 'outward'] as const;
export const DIM_UNITS = ['inch', 'mils', 'mm', 'auto'] as const;
export const DIM_UNITS_FORMATS = ['none', 'bare', 'paren'] as const;
export const DIM_TEXT_POSITIONS = ['outside', 'inline', 'manual'] as const;
export const DIM_ORIENTATIONS = ['horizontal', 'vertical'] as const;
export const DIM_TEXT_BORDERS = ['none', 'rectangle', 'circle', 'roundrect'] as const;
export const ZONE_BORDER_STYLES = ['none', 'edge', 'full'] as const;
export const PLACEMENT_SOURCES = ['sheet', 'componentClass', 'group', 'designBlock'] as const;
/** A barcode's text (the engine's bound). */
export const BARCODE_TEXT_MAX = 4096;
/** A dimension's precision: KiCad's list, 0 to 9. */
export const DIM_PRECISION_MAX = 9;
/** A rule area's hatch pitch on a set (KiCad's ZONE_BORDER_HATCH_MINDIST_MM and MAXDIST_MM). */
export const HATCH_PITCH_MIN_MM = 0.1;
export const HATCH_PITCH_MAX_MM = 2;

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
  rowSeparators: boolean; colSeparators: boolean; separatorsWidth: number | null; separatorsStyle: typeof LINE_STYLES[number];
  rows: number; cols: number; colWidths: number[]; rowHeights: number[];
}
/** A barcode: its type is the key `symbology` (`kind` is the item record's own), its margin [x, y]. */
export interface BarcodeItemRecord {
  kind: 'barcode'; uuid: string; text: string; layer: string; locked: boolean; x: number; y: number; width: number; height: number;
  textSize: number; angle: number; knockout: boolean; margin: Point; showText: boolean; symbology: typeof SYMBOLOGIES[number];
  errorCorrection: typeof ERROR_CORRECTIONS[number];
}
/** A shape: `filled` is `fill` as a yes or no; `cornerRadius` on a rectangle only; `solderMaskMargin` null for the board's. */
export interface ShapeItemRecord {
  kind: 'shape'; uuid: string; layer: string; shape: typeof SHAPE_NAMES[number]; points: Point[]; width: number;
  style: typeof LINE_STYLES[number]; filled: boolean; fill: typeof FILLS[number]; locked: boolean; cornerRadius?: number;
  hasSolderMask: boolean; solderMaskMargin: number | null;
}
/** A dimension: the keys its type has (height and extensionHeight aligned and orthogonal, orientation orthogonal, leaderLength radial, textBorder leader). */
export interface DimensionItemRecord {
  kind: 'dimension'; uuid: string; dimType: typeof DIM_TYPES[number]; layer: string; start: Point; end: Point;
  height?: number; extensionHeight?: number; orientation?: typeof DIM_ORIENTATIONS[number]; leaderLength?: number;
  textBorder?: typeof DIM_TEXT_BORDERS[number]; override: boolean; value: string; prefix: string; suffix: string;
  arrowDirection: typeof DIM_ARROWS[number]; units: typeof DIM_UNITS[number]; unitsFormat: typeof DIM_UNITS_FORMATS[number];
  precision: number; suppressZeroes: boolean; textPosition: typeof DIM_TEXT_POSITIONS[number]; textPos: Point; keepAligned: boolean;
  angle: number; size: Point; thickness: number; bold: boolean; italic: boolean; hJustify: typeof H_JUSTIFY[number]; mirrored: boolean;
  font: string; lineThickness: number; arrowLength: number; extensionOffset: number; locked: boolean;
}
/** A zone of the footprint: a rule area (its rule keys) or a zone on no copper layer; `points` its main outline. */
export interface ZoneItemRecord {
  kind: 'zone'; uuid: string; ruleArea: boolean; name: string; layers: string[]; locked: boolean; points: Point[];
  borderStyle: typeof ZONE_BORDER_STYLES[number]; hatchPitch: number; noTracks?: boolean; noVias?: boolean; noPads?: boolean;
  noCopperPour?: boolean; noFootprints?: boolean; placement?: boolean; placementSource?: typeof PLACEMENT_SOURCES[number]; placementName?: string;
}
/** A reference picture: `bytes` its PNG's own size, `png` (base64) while that is at most 64 KiB; `locked` in the board frame only. */
export interface ImageItemRecord { kind: 'image'; uuid: string; x: number; y: number; scale: number; layer: string; bytes: number; png?: string; locked?: boolean }
export interface PointItemRecord { kind: 'point'; uuid: string; x: number; y: number; layer: string; size: number; locked: boolean }
export type ItemRecord = PadRecord | TextItemRecord | TextboxItemRecord | TableItemRecord | BarcodeItemRecord | ShapeItemRecord
  | DimensionItemRecord | ZoneItemRecord | ImageItemRecord | PointItemRecord;

/** The kinds this file reads: every kind of the engine's item table. */
export const READABLE_KINDS: readonly ItemRecordKind[] = Object.freeze([...ITEM_RECORD_KINDS]);

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
  rowSeparators: isBool, colSeparators: isBool, separatorsWidth: orNull(isSize), separatorsStyle: oneOf(LINE_STYLES),
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
  text: (v) => isText(v, 0, BARCODE_TEXT_MAX), layer: isLayerName, locked: isBool, x: isPos, y: isPos, width: isSize, height: isSize,
  textSize: isSize, angle: isAngle, knockout: isBool, margin: pair(isSize), showText: isBool, symbology: oneOf(SYMBOLOGIES),
  errorCorrection: oneOf(ERROR_CORRECTIONS),
});

// ── the shapes and the picture ─────────────────────────────────────────────────────────

/** The point count a shape takes: a segment, a rectangle or a circle (center, a point on it) 2, an arc 3, a curve 4, a polygon 3 or more. */
export function shapePointsFit(shape: typeof SHAPE_NAMES[number], n: number): boolean {
  if (shape === 'segment' || shape === 'rect' || shape === 'circle') return n === 2;
  if (shape === 'arc') return n === 3;
  if (shape === 'bezier') return n === 4;
  return n >= 3 && n <= POINTS_MAX;
}
/** A shape's keys; a rectangle's add its corner radius. */
const SHAPE_KEYS: Readonly<Record<string, Check>> = Object.freeze({
  layer: isLayerName, shape: oneOf(SHAPE_NAMES), points: listOf(isPoint, 2, POINTS_MAX), width: isSize,
  style: oneOf(LINE_STYLES), filled: isBool, fill: oneOf(FILLS), locked: isBool, hasSolderMask: isBool, solderMaskMargin: orNull(isSigned),
});
const RECT_KEYS: Readonly<Record<string, Check>> = Object.freeze({ ...SHAPE_KEYS, cornerRadius: isSize });
/** `filled` given beside `fill` agrees with it. */
const fillAgrees = (o: Record<string, unknown>): boolean => !has(o, 'filled') || !has(o, 'fill') || o.filled === (o.fill !== 'none');

// ── the dimension, the zone and the point ──────────────────────────────────────────────

const DIM_BASE: Readonly<Record<string, Check>> = Object.freeze({
  dimType: oneOf(DIM_TYPES), layer: isLayerName, start: isPoint, end: isPoint, override: isBool, value: line, prefix: line, suffix: line,
  arrowDirection: oneOf(DIM_ARROWS), units: oneOf(DIM_UNITS), unitsFormat: oneOf(DIM_UNITS_FORMATS), precision: isInt(0, DIM_PRECISION_MAX),
  suppressZeroes: isBool, textPosition: oneOf(DIM_TEXT_POSITIONS), textPos: isPoint, keepAligned: isBool, angle: isAngle, size: textSize,
  thickness: inRange(0, TEXT_SIZE_MAX_MM), bold: isBool, italic: isBool, hJustify: oneOf(H_JUSTIFY), mirrored: isBool, font: line,
  lineThickness: isSize, arrowLength: isSize, extensionOffset: isSize, locked: isBool,
});
/** The keys only some dimension types have. */
const DIM_OWN: Readonly<Record<typeof DIM_TYPES[number], Readonly<Record<string, Check>>>> = Object.freeze({
  aligned: { height: isPos, extensionHeight: isSize },
  orthogonal: { height: isPos, extensionHeight: isSize, orientation: oneOf(DIM_ORIENTATIONS) },
  center: {},
  radial: { leaderLength: isSize },
  leader: { textBorder: oneOf(DIM_TEXT_BORDERS) },
});
const dimKeys = (type: unknown): Readonly<Record<string, Check>> | null =>
  (oneOf(DIM_TYPES)(type) ? { ...DIM_BASE, ...DIM_OWN[type as typeof DIM_TYPES[number]] } : null);
/** Every dimension key: a set names those of its item's type. */
const DIM_ALL: Readonly<Record<string, Check>> = Object.freeze(Object.assign({}, DIM_BASE, ...Object.values(DIM_OWN), { font: (v: unknown) => isText(v, 1, 256) }));

const ZONE_KEYS: Readonly<Record<string, Check>> = Object.freeze({
  ruleArea: isBool, name: line, layers: layerList, locked: isBool,
  points: (v) => listOf(isPoint, 0, POINTS_MAX)(v) && ((v as unknown[]).length === 0 || (v as unknown[]).length >= 3),
  borderStyle: oneOf(ZONE_BORDER_STYLES), hatchPitch: isSize,
});
const RULE_AREA_KEYS: Readonly<Record<string, Check>> = Object.freeze({
  ...ZONE_KEYS, noTracks: isBool, noVias: isBool, noPads: isBool, noCopperPour: isBool, noFootprints: isBool, placement: isBool,
  placementSource: oneOf(PLACEMENT_SOURCES), placementName: line,
});
/** A zone set or add: at least one layer, a whole outline of 3 points or more, the hatch pitch in KiCad's bounds. */
const ZONE_SET: Readonly<Record<string, Check>> = Object.freeze({
  ...RULE_AREA_KEYS, layers: listOf(isLayerName, 1, LAYERS_MAX, true), points: listOf(isPoint, 3, POINTS_MAX),
  hatchPitch: inRange(HATCH_PITCH_MIN_MM, HATCH_PITCH_MAX_MM),
});

const POINT_KEYS: Readonly<Record<string, Check>> = Object.freeze({
  x: isPos, y: isPos, layer: isLayerName, size: (v) => isSize(v) && (v as number) > 0, locked: isBool,
});
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** The PNG signature as base64 begins. */
const PNG_BASE64_HEAD = 'iVBORw0KGgo';
/** The decoded size of a base64 text. */
export const base64Bytes = (s: string): number => (s.length / 4) * 3 - (s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0);
/** A PNG as base64 of at most `max` bytes decoded. */
export const isPngBase64 = (max: number): Check => (v) =>
  typeof v === 'string' && v.length > 0 && v.length <= Math.ceil(max / 3) * 4 && BASE64_RE.test(v) && v.startsWith(PNG_BASE64_HEAD) && base64Bytes(v) <= max;
/** A picture set (`png` on an add only, `grayscale` true the editor's one shot Convert to grayscale, `locked` in the board frame). */
const IMAGE_SET: Readonly<Record<string, Check>> = Object.freeze({
  x: isPos, y: isPos, scale: inRange(Number.MIN_VALUE, 1000), layer: isLayerName, png: isPngBase64(IMAGE_ADD_MAX_BYTES),
  grayscale: (v) => v === true, locked: isBool,
});
/** Keys a set may carry that no record holds back (a one shot action). */
const ACTION_KEYS: Readonly<Partial<Record<ItemRecordKind, readonly string[]>>> = Object.freeze({ image: ['grayscale'] });
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
 * primitives; a table's cells are rows by cols; a shape's `filled` agrees
 * with its `fill` and a rectangle alone carries `cornerRadius`; a dimension
 * the keys of its type; a rule area its rule keys; a picture its PNG's size in
 * `bytes` and `png` (base64) while that is at most 64 KiB. Null for any other
 * shape.
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
      if (!fits(rest, rest.shape === 'rect' ? RECT_KEYS : SHAPE_KEYS, true) || !fillAgrees(rest)) return null;
      if (!shapePointsFit(rest.shape as typeof SHAPE_NAMES[number], (rest.points as unknown[]).length)) return null;
      return record<ShapeItemRecord>(k, uuid, rest);
    case 'dimension': {
      const keys = dimKeys(rest.dimType);
      return keys != null && fits(rest, keys, true) ? record<DimensionItemRecord>(k, uuid, rest) : null;
    }
    case 'zone':
      return fits(rest, rest.ruleArea === true ? RULE_AREA_KEYS : ZONE_KEYS, true) ? record<ZoneItemRecord>(k, uuid, rest) : null;
    case 'point':
      return fits(rest, POINT_KEYS, true) ? record<PointItemRecord>(k, uuid, rest) : null;
    case 'image': {
      const { png, bytes, locked, ...place } = rest;
      if (!fits(place, IMAGE_READ, true) || (locked !== undefined && !isBool(locked))) return null;
      if (!Number.isSafeInteger(bytes) || (bytes as number) < 0) return null;
      if (png !== undefined) {
        if (!isPngBase64(IMAGE_GET_MAX_BYTES)(png) || bytes !== base64Bytes(png as string)) return null;
      } else if (!((bytes as number) > IMAGE_GET_MAX_BYTES || bytes === 0)) {
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
  shape: RECT_KEYS,
  dimension: DIM_ALL,
  zone: ZONE_SET,
  image: IMAGE_SET,
  point: POINT_KEYS,
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
  if (kind === 'shape' && !fillAgrees(set)) return null;
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
  dimension: ['dimType', 'layer', 'start', 'end'],
  zone: ['layers', 'points'],
  image: ['layer', 'png'],
  point: ['layer'],
});

/**
 * A new item read closed: its `kind` (a readable kind), its page made lower
 * case `uuid`, the keys its kind needs (NEW_ITEM_NEEDS) and any other key a
 * set of the kind takes. A new field may start with an empty text and its
 * name never empty; a new table's cells, when given, rows by cols of its
 * widths and heights; a picture's png at most 4 MiB decoded; a dimension the
 * keys of its type, its start not its end; a zone a rule area. Null for
 * anything else.
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
  if (kind === 'shape') {
    if (!shapePointsFit(rest.shape as typeof SHAPE_NAMES[number], (rest.points as unknown[]).length) || !fillAgrees(rest)) return null;
    if (has(rest, 'cornerRadius') && rest.shape !== 'rect') return null;
  }
  if (kind === 'dimension') {
    const keys = dimKeys(rest.dimType);
    if (keys == null || !fits(rest, { ...keys, font: DIM_ALL.font }, false) || sameValue(rest.start, rest.end)) return null;
  }
  if (kind === 'zone' && has(rest, 'ruleArea') && rest.ruleArea !== true) return null;
  if (kind === 'table' && has(rest, 'cells')) {
    const c = rest.cells as unknown[][];
    if (c.length !== (rest.rowHeights as unknown[]).length || c[0].length !== (rest.colWidths as unknown[]).length) return null;
  }
  return { ...structuredClone(rest), kind, uuid: value.uuid as string };
}

/**
 * Why `set` does not fit `items`, or null: a key one of them lacks (a set over
 * several items carries only keys every one has; a one shot action key such as
 * a picture's grayscale excepted), a shape's or a dimension's type or a zone's
 * rule area changed (each fixed, as KiCad's dialog keeps it), a shape's new
 * points of another count, a dimension's text position given while its text
 * is not placed by hand (a leader's always is).
 */
export function itemSetMisfit(set: Record<string, unknown>, items: readonly ItemRecord[]): string | null {
  for (const item of items) {
    const own = item as unknown as Record<string, unknown>;
    const actions = ACTION_KEYS[item.kind] ?? [];
    for (const k of Object.keys(set)) if (!has(own, k) && !actions.includes(k)) return `${k} does not fit a ${item.kind}`;
    for (const k of ['shape', 'dimType', 'ruleArea']) if (has(set, k) && set[k] !== own[k]) return `a ${item.kind} keeps its ${k}`;
    if (item.kind === 'shape' && has(set, 'points') && !has(set, 'shape') && !shapePointsFit(item.shape, (set.points as unknown[]).length)) {
      return `a ${item.shape} takes another count of points`;
    }
    if (item.kind === 'dimension' && has(set, 'textPos') && item.dimType !== 'leader' && (set.textPosition ?? item.textPosition) !== 'manual') {
      return 'textPos takes a manual text position';
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
  const actions = ACTION_KEYS[item.kind] ?? [];
  return Object.entries(set).every(([k, want]) => actions.includes(k) || sameValue(want, got[k], k));
}
