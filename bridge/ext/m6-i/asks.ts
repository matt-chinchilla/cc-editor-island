// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The placement asks of the prompt host (the canvas commands addendum 7), as
// engine run 15 sends their records (units m6-e1 and m6-e2), read closed:
// `moveExact` (Move Exactly), `offset` (Interactive Offset's entry after its
// two clicks), `array` (Create Array, modeless), `positionRelative` (Position
// Relative, modeless), `filterSelection` (Filter Selected Items) and
// `findFootprint` (Get and Move Footprint). A record of another shape is not
// read, so KiCad's own dialog shows (the prompt host takes an ask only when
// its record reads). Pure: no window, no engine.

/** The asks this unit declares (ev.prompt's `ask`). */
export const PLACEMENT_ASKS = ['moveExact', 'offset', 'array', 'positionRelative', 'filterSelection', 'findFootprint'] as const;
export type PlacementAsk = (typeof PLACEMENT_ASKS)[number];

/** Move Exactly's rotation anchors (ROTATION_ANCHOR), as the engine names them. */
export const MOVE_ANCHORS = ['item', 'selectionCenter', 'userOrigin', 'drillOrigin'] as const;
/** Position Relative's anchor kinds (ANCHOR_TYPE). */
export const RELATIVE_ANCHORS = ['item', 'point', 'gridOrigin', 'userOrigin'] as const;
/** An array axis's numbering (ARRAY_AXIS::NUMBERING_TYPE). */
export const NUMBERING_TYPES = ['numeric', 'hex', 'alphaShort', 'alphaFull'] as const;
/** Filter Selected Items' boxes, KiCad's OPTIONS names. */
export const FILTER_SELECTION_KEYS = [
  'includeFootprints', 'includeLockedFootprints', 'includeTracks', 'includeVias',
  'includeZones', 'includeItemsOnTechLayers', 'includeBoardOutlineLayer', 'includePcbTexts',
] as const;

/** A length or a coordinate of these records, in mm, at most this in magnitude (KiCad's board is a little over 2,147 mm a side). */
export const LENGTH_MAX_MM = 10_000;
/** An angle of these records, in degrees, at most this in magnitude. */
export const ANGLE_MAX_DEG = 1_000_000;
/** A text of these records (an axis start, an anchor label, a reference), at most this many characters. */
export const TEXT_MAX = 1_024;
/** Get and Move Footprint's list, at most this many references. */
export const REFERENCES_MAX = 100_000;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exact = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const k = Object.keys(o);
  return k.length === keys.length && keys.every((x) => k.includes(x));
};
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isLength = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= LENGTH_MAX_MM;
const isAngle = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= ANGLE_MAX_DEG;
/** A whole number the dialog's own text field held (KiCad's long). */
const isWhole = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.length <= TEXT_MAX;
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);

/**
 * `moveExact`: `{ x, y, rotation, anchor, anchors }`. `x`, `y` the move in mm
 * (Cartesian), `rotation` degrees, `anchors` the rotation anchors the dialog
 * offers in its order, each once (`drillOrigin` only in the board editor),
 * `anchor` the chosen one, one of `anchors`.
 */
export function readMoveExact(r: unknown): Record<string, unknown> | null {
  if (!isObj(r) || !exact(r, ['x', 'y', 'rotation', 'anchor', 'anchors'])) return null;
  const { x, y, rotation, anchor, anchors } = r;
  if (!isLength(x) || !isLength(y) || !isAngle(rotation)) return null;
  if (!Array.isArray(anchors) || anchors.length === 0 || !anchors.every((a) => oneOf(MOVE_ANCHORS, a)) || new Set(anchors).size !== anchors.length) return null;
  if (!oneOf(MOVE_ANCHORS, anchor) || !anchors.includes(anchor)) return null;
  return { x, y, rotation, anchor, anchors: [...anchors] as string[] };
}

/** `offset`: `{ x, y }`, the vector between Interactive Offset's two clicks, in mm. */
export function readOffset(r: unknown): Record<string, unknown> | null {
  if (!isObj(r) || !exact(r, ['x', 'y']) || !isLength(r.x) || !isLength(r.y)) return null;
  return { x: r.x, y: r.y };
}

/** An array axis: `{ type, start, step }`, `start` the text of the first number or letters. */
function readAxis(a: unknown): Record<string, unknown> | null {
  if (!isObj(a) || !exact(a, ['type', 'start', 'step'])) return null;
  if (!oneOf(NUMBERING_TYPES, a.type) || !isText(a.start) || !isWhole(a.step)) return null;
  return { type: a.type, start: a.start, step: a.step };
}

const GRID_KEYS = [
  'nx', 'ny', 'dx', 'dy', 'offsetX', 'offsetY', 'centered', 'stagger', 'staggerRows', 'horizontalThenVertical',
  'reverseNumberingAlternate', 'numberingStartSpecified', 'numbering2d', 'primary', 'secondary',
] as const;

function readGrid(g: unknown): Record<string, unknown> | null {
  if (!isObj(g) || !exact(g, GRID_KEYS)) return null;
  if (!isWhole(g.nx) || !isWhole(g.ny) || !isWhole(g.stagger)) return null;
  if (!isLength(g.dx) || !isLength(g.dy) || !isLength(g.offsetX) || !isLength(g.offsetY)) return null;
  for (const k of ['centered', 'staggerRows', 'horizontalThenVertical', 'reverseNumberingAlternate', 'numberingStartSpecified', 'numbering2d'] as const) {
    if (!isBool(g[k])) return null;
  }
  const primary = readAxis(g.primary);
  const secondary = readAxis(g.secondary);
  if (primary == null || secondary == null) return null;
  const out: Record<string, unknown> = {};
  for (const k of GRID_KEYS) out[k] = g[k];
  return { ...out, primary, secondary };
}

const CIRCULAR_KEYS = ['centerX', 'centerY', 'angle', 'angleOffset', 'clockwise', 'count', 'rotateItems', 'numberingStartSpecified', 'axis'] as const;

function readCircular(c: unknown): Record<string, unknown> | null {
  if (!isObj(c) || !exact(c, CIRCULAR_KEYS)) return null;
  if (!isLength(c.centerX) || !isLength(c.centerY) || !isAngle(c.angle) || !isAngle(c.angleOffset) || !isWhole(c.count)) return null;
  if (!isBool(c.clockwise) || !isBool(c.rotateItems) || !isBool(c.numberingStartSpecified)) return null;
  const axis = readAxis(c.axis);
  if (axis == null) return null;
  const out: Record<string, unknown> = {};
  for (const k of CIRCULAR_KEYS) out[k] = c[k];
  return { ...out, axis };
}

/**
 * `array` (modeless): `{ shape, arrangeSelection, uniqueReferences,
 * padNumbering, grid, circular }`, what Create Array's controls hold: `shape`
 * `grid` or `circular` (the tab shown), `padNumbering` true only in the
 * footprint editor, `grid` and `circular` each tab's fields (lengths mm, the
 * center in board coordinates, angles degrees, counts and steps whole
 * numbers), an axis `{ type, start, step }`.
 */
export function readArray(r: unknown): Record<string, unknown> | null {
  if (!isObj(r) || !exact(r, ['shape', 'arrangeSelection', 'uniqueReferences', 'padNumbering', 'grid', 'circular'])) return null;
  if (r.shape !== 'grid' && r.shape !== 'circular') return null;
  if (!isBool(r.arrangeSelection) || !isBool(r.uniqueReferences) || !isBool(r.padNumbering)) return null;
  const grid = readGrid(r.grid);
  const circular = readCircular(r.circular);
  if (grid == null || circular == null) return null;
  return { shape: r.shape, arrangeSelection: r.arrangeSelection, uniqueReferences: r.uniqueReferences, padNumbering: r.padNumbering, grid, circular };
}

/**
 * `positionRelative` (modeless): `{ anchor: { kind, x, y, label }, x, y }`.
 * `anchor.kind` `item`, `point`, `gridOrigin` or `userOrigin`, its `x`, `y`
 * in mm, `label` KiCad's anchor text verbatim; `x`, `y` the offset in mm.
 */
export function readPositionRelative(r: unknown): Record<string, unknown> | null {
  if (!isObj(r) || !exact(r, ['anchor', 'x', 'y']) || !isLength(r.x) || !isLength(r.y)) return null;
  const a = r.anchor;
  if (!isObj(a) || !exact(a, ['kind', 'x', 'y', 'label']) || !oneOf(RELATIVE_ANCHORS, a.kind) || !isLength(a.x) || !isLength(a.y) || !isText(a.label)) return null;
  return { anchor: { kind: a.kind, x: a.x, y: a.y, label: a.label }, x: r.x, y: r.y };
}

/** `filterSelection`: the eight `include*` boxes of Filter Selected Items, booleans. */
export function readFilterSelection(r: unknown): Record<string, unknown> | null {
  if (!isObj(r) || !exact(r, FILTER_SELECTION_KEYS) || !FILTER_SELECTION_KEYS.every((k) => isBool(r[k]))) return null;
  const out: Record<string, unknown> = {};
  for (const k of FILTER_SELECTION_KEYS) out[k] = r[k];
  return out;
}

/** `findFootprint`: `{ references }`, the reference of each entry of Get and Move Footprint's list, in its order. */
export function readFindFootprint(r: unknown): Record<string, unknown> | null {
  if (!isObj(r) || !exact(r, ['references'])) return null;
  const refs = r.references;
  if (!Array.isArray(refs) || refs.length > REFERENCES_MAX || !refs.every(isText)) return null;
  return { references: [...refs] as string[] };
}

/** Each declared ask's closed record reader (ExtUnit.askReaders). */
export const PLACEMENT_ASK_READERS: Readonly<Record<PlacementAsk, (record: unknown) => Record<string, unknown> | null>> = {
  moveExact: readMoveExact,
  offset: readOffset,
  array: readArray,
  positionRelative: readPositionRelative,
  filterSelection: readFilterSelection,
  findFootprint: readFindFootprint,
};
