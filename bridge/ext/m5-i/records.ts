// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The schematic item records of sch.item.get and sch.item.set (m5-i,
// PROTOCOL.md): every non symbol item of a schematic read closed per kind as
// engine run 15's kicadSchItemGet writes it (unit m5-e, Y down, millimeters),
// and each kind's set read closed as kicadSchItemSet takes it. A text, a text
// box, a shape, a rule area and a table cell are read and set through the
// symbol editor's own readers (bridge/symedit.ts readItem, parseItemSet,
// itemSetMisfit), never a copy of them.
import { isObj } from '../contract';
import {
  EDITABLE_KEYS, LINE_STYLES, POSITION_MAX_MM, SIZE_MAX_MM,
  isText, itemSetMisfit, parseItemSet, readItem,
  type Shape, type SymItem, type Text, type TextBox,
} from '../../symedit';
import { SHEET_PATH_RE, UUID_RE } from '../../symbol';

/** Every kind a record names (spec 4.4). */
export const SCH_ITEM_KINDS = [
  'label', 'wire', 'line', 'busEntry', 'junction', 'text', 'textbox', 'shape', 'ruleArea',
  'image', 'sheet', 'sheetPin', 'table', 'tableCell', 'group',
] as const;
export type SchItemKind = typeof SCH_ITEM_KINDS[number];
/** The kinds read here and never set: the table forms are another unit's (RULINGS 2). */
export const READ_ONLY_KINDS: readonly SchItemKind[] = ['table', 'tableCell'];
export const LABEL_KINDS = ['local', 'global', 'hierarchical', 'directive'] as const;
export type LabelKind = typeof LABEL_KINDS[number];
export const PORT_SHAPES = ['input', 'output', 'bidirectional', 'tri_state', 'passive'] as const;
export type PortShape = typeof PORT_SHAPES[number];
export const FLAG_SHAPES = ['dot', 'round', 'diamond', 'rectangle'] as const;
export type FlagShape = typeof FLAG_SHAPES[number];
export const LABEL_ORIENTATIONS = ['right', 'up', 'left', 'down'] as const;
export const SIDES = ['left', 'right', 'top', 'bottom'] as const;
export const FILE_MODES = ['useExisting', 'rename'] as const;
export type FileMode = typeof FILE_MODES[number];
type LineStyle = typeof LINE_STYLES[number];

/**
 * A text, text box or table cell's text read by sch.item.get, at most this
 * many characters. KiCad sets no length on a schematic text (EDA_TEXT, its
 * file reader and its dialogs take any), so the read takes the island's
 * bound for a long KiCad text, fp-i3's FP_PROPS_LONG_MAX; a set still takes
 * the engine's own 1,024 (TEXT_MAX).
 */
export const SCH_TEXT_READ_MAX = 16_384;
/** Items of one get (the engine's GET_MAX) and of one set (SET_MAX). */
export const GET_MAX = 512;
export const SET_MAX = 4096;
/** Fields of one label or sheet, read or set. */
export const FIELDS_MAX = 32;
/** A picture's bytes a set may carry, decoded. */
export const PNG_SET_MAX = 4 * 1024 * 1024;
/** A sheet's page number is 1 to 64 characters. */
export const PAGE_MAX = 64;

export interface SchBase { uuid: string; sheetPath: string }
export interface LabelField { name: string; value: string; visible: boolean; x: number; y: number }
export interface SheetField { name: string; value: string; visible: boolean }
export interface Stroke { width: number; style: LineStyle; color: string }
export interface SchLabel extends SchBase {
  kind: 'label'; labelKind: LabelKind; text: string; x: number; y: number; orientation: typeof LABEL_ORIENTATIONS[number];
  size: number; bold: boolean; italic: boolean; color: string; shape: PortShape | FlagShape | null; pinLength: number | null;
  fields: LabelField[];
}
export interface SchWire extends SchBase { kind: 'wire'; bus: boolean; points: [[number, number], [number, number]]; width: number; style: LineStyle; color: string }
export interface SchLine extends SchBase { kind: 'line'; points: [[number, number], [number, number]]; width: number; style: LineStyle; color: string }
export interface SchBusEntry extends SchBase { kind: 'busEntry'; x: number; y: number; size: [number, number]; width: number; style: LineStyle; color: string }
export interface SchJunction extends SchBase { kind: 'junction'; x: number; y: number; diameter: number; color: string }
/** The symbol editor's Text with unit 0, bodyStyle 0, plus the sheet path and the text's color. */
export type SchText = Omit<Text, 'kind'> & SchBase & { kind: 'text'; color: string };
export type SchTextBox = Omit<TextBox, 'kind'> & SchBase & { kind: 'textbox'; color: string };
export type SchShape = Omit<Shape, 'kind'> & SchBase & { kind: 'shape' };
export type SchRuleArea = Omit<Shape, 'kind'> & SchBase & { kind: 'ruleArea' };
export interface SchImage extends SchBase { kind: 'image'; x: number; y: number; scale: number; bytes: number; png: string | null }
export interface SchSheet extends SchBase {
  kind: 'sheet'; name: string; file: string; page: string; x: number; y: number; size: [number, number];
  borderWidth: number; borderColor: string; fillColor: string; inBom: boolean; onBoard: boolean; inSim: boolean; dnp: boolean;
  fields: SheetField[]; pins: number;
}
export interface SchSheetPin extends SchBase { kind: 'sheetPin'; sheet: string; name: string; shape: PortShape; side: typeof SIDES[number]; size: number; x: number; y: number }
export interface SchTable extends SchBase {
  kind: 'table'; rows: number; cols: number; cells: string[][];
  borderExternal: boolean; borderHeader: boolean; border: Stroke; separatorsRows: boolean; separatorsCols: boolean; separators: Stroke;
  colWidths: number[]; rowHeights: number[];
}
export type SchTableCell = Omit<TextBox, 'kind'> & SchBase & { kind: 'tableCell'; color: string; table: string; row: number; col: number; rowSpan: number; colSpan: number };
export interface SchGroup extends SchBase { kind: 'group'; name: string; members: number; designBlock: string }
export type SchItemRecord = SchLabel | SchWire | SchLine | SchBusEntry | SchJunction | SchText | SchTextBox | SchShape | SchRuleArea
  | SchImage | SchSheet | SchSheetPin | SchTable | SchTableCell | SchGroup;

/** One item asked for: its uuid and the sheet path it sits on ("" the sheet shown). */
export interface AskedItem { uuid: string; sheetPath: string }
export interface SchItemSetArgs { items: AskedItem[]; kind: SchItemKind; set: Record<string, unknown>; fileMode?: FileMode }

// ── small readers ───────────────────────────────────────────────────────────────────────

const has = (o: Record<string, unknown>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => has(o, k));
};
const oneOf = <T extends string>(v: unknown, all: readonly T[]): v is T => typeof v === 'string' && (all as readonly string[]).includes(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const inRange = (v: unknown, min: number, max: number): v is number => isNum(v) && v >= min && v <= max;
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isPos = (v: unknown): v is number => inRange(v, -POSITION_MAX_MM, POSITION_MAX_MM);
const isLength = (v: unknown): v is number => inRange(v, 0, POSITION_MAX_MM);
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
/** "" for KiCad's unspecified color, else #rrggbbaa. */
const COLOR_RE = /^(?:#[0-9a-f]{8})?$/;
const isColor = (v: unknown): v is string => typeof v === 'string' && COLOR_RE.test(v);
const isPoint = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every(isPos);
const isPair = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every(isNum);
const isRecordString = (v: unknown): v is string => typeof v === 'string';
// Base64 as wxBase64Decode takes it: the alphabet, padded to whole quads (no group repeated: a 4 MiB picture is one long string).
const BASE64_CHARS_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const isBase64 = (v: string): boolean => v.length % 4 === 0 && BASE64_CHARS_RE.test(v);

function readStroke(v: unknown): Stroke | null {
  if (!isObj(v) || !exactKeys(v, ['width', 'style', 'color']) || !inRange(v.width, 0, POSITION_MAX_MM) || !oneOf(v.style, LINE_STYLES) || !isColor(v.color)) return null;
  return { width: v.width, style: v.style, color: v.color };
}

/** A record's sheet path as the engine writes it (KiCad's PathAsString). */
const isRecordPath = (v: unknown): v is string => typeof v === 'string' && SHEET_PATH_RE.test(v);

/** An asked sheet path: "" (the sheet shown) or a path in symbol.set's grammar. */
export const isAskedPath = (v: unknown): v is string => v === '' || (typeof v === 'string' && SHEET_PATH_RE.test(v));

// ── the records ────────────────────────────────────────────────────────────────────────

const LABEL_KEYS = ['kind', 'uuid', 'sheetPath', 'labelKind', 'text', 'x', 'y', 'orientation', 'size', 'bold', 'italic', 'color', 'shape', 'pinLength', 'fields'];
const WIRE_KEYS = ['kind', 'uuid', 'sheetPath', 'bus', 'points', 'width', 'style', 'color'];
const LINE_KEYS = ['kind', 'uuid', 'sheetPath', 'points', 'width', 'style', 'color'];
const BUS_ENTRY_KEYS = ['kind', 'uuid', 'sheetPath', 'x', 'y', 'size', 'width', 'style', 'color'];
const JUNCTION_KEYS = ['kind', 'uuid', 'sheetPath', 'x', 'y', 'diameter', 'color'];
const IMAGE_KEYS = ['kind', 'uuid', 'sheetPath', 'x', 'y', 'scale', 'bytes', 'png'];
const SHEET_KEYS = ['kind', 'uuid', 'sheetPath', 'name', 'file', 'page', 'x', 'y', 'size', 'borderWidth', 'borderColor', 'fillColor',
  'inBom', 'onBoard', 'inSim', 'dnp', 'fields', 'pins'];
const SHEET_PIN_KEYS = ['kind', 'uuid', 'sheetPath', 'sheet', 'name', 'shape', 'side', 'size', 'x', 'y'];
const TABLE_KEYS = ['kind', 'uuid', 'sheetPath', 'rows', 'cols', 'cells', 'borderExternal', 'borderHeader', 'border',
  'separatorsRows', 'separatorsCols', 'separators', 'colWidths', 'rowHeights'];
const GROUP_KEYS = ['kind', 'uuid', 'sheetPath', 'name', 'members', 'designBlock'];
const CELL_KEYS = ['table', 'row', 'col', 'rowSpan', 'colSpan'];

function readLabelFields(v: unknown): LabelField[] | null {
  if (!Array.isArray(v) || v.length > FIELDS_MAX) return null;
  const out: LabelField[] = [];
  for (const f of v as unknown[]) {
    if (!isObj(f) || !exactKeys(f, ['name', 'value', 'visible', 'x', 'y']) || !isRecordString(f.name) || !isRecordString(f.value) || !isBool(f.visible) || !isPos(f.x) || !isPos(f.y)) return null;
    out.push({ name: f.name, value: f.value, visible: f.visible, x: f.x, y: f.y });
  }
  return out;
}

function readSheetFields(v: unknown): SheetField[] | null {
  if (!Array.isArray(v) || v.length > FIELDS_MAX) return null;
  const out: SheetField[] = [];
  for (const f of v as unknown[]) {
    if (!isObj(f) || !exactKeys(f, ['name', 'value', 'visible']) || !isRecordString(f.name) || !isRecordString(f.value) || !isBool(f.visible)) return null;
    out.push({ name: f.name, value: f.value, visible: f.visible });
  }
  return out;
}

/**
 * A record of the symbol editor's kinds read by the symbol editor's own
 * reader (readItem): the record less its sheet path and the keys `extra`
 * names, as `as`; unit and bodyStyle must be 0 on a schematic.
 */
function viaSymEdit(v: Record<string, unknown>, as: 'text' | 'textbox' | 'shape', extra: readonly string[]): SymItem | null {
  const rest: Record<string, unknown> = {};
  for (const [k, value] of Object.entries(v)) if (k !== 'sheetPath' && !extra.includes(k)) rest[k] = value;
  rest.kind = as;
  // The text itself is read here, to SCH_TEXT_READ_MAX: the symbol editor's reader bounds it to its set's 1,024.
  const text = rest.text;
  if (typeof text === 'string') {
    if ([...text].length > SCH_TEXT_READ_MAX) return null;
    rest.text = '';
  }
  const item = readItem(rest);
  if (item == null || item.kind !== as || item.unit !== 0 || item.bodyStyle !== 0) return null;
  return typeof text === 'string' && 'text' in item ? { ...item, text } : item;
}

/** One record of kicadSchItemGet's answer read closed for its kind (spec 4.4 and the engine's added keys); null for any other shape. */
export function readSchItem(v: unknown): SchItemRecord | null {
  if (!isObj(v) || !oneOf(v.kind, SCH_ITEM_KINDS) || !isUuid(v.uuid) || !isRecordPath(v.sheetPath)) return null;
  const base = { uuid: v.uuid, sheetPath: v.sheetPath };
  switch (v.kind) {
    case 'label': {
      if (!exactKeys(v, LABEL_KEYS) || !oneOf(v.labelKind, LABEL_KINDS) || !isRecordString(v.text) || !isPos(v.x) || !isPos(v.y)) return null;
      if (!oneOf(v.orientation, LABEL_ORIENTATIONS) || !isLength(v.size) || !isBool(v.bold) || !isBool(v.italic) || !isColor(v.color)) return null;
      const lk = v.labelKind;
      const shapeFits = lk === 'local' ? v.shape === null : lk === 'directive' ? oneOf(v.shape, FLAG_SHAPES) : oneOf(v.shape, PORT_SHAPES);
      const lengthFits = lk === 'directive' ? isLength(v.pinLength) : v.pinLength === null;
      const fields = readLabelFields(v.fields);
      if (!shapeFits || !lengthFits || fields == null) return null;
      return {
        kind: 'label', ...base, labelKind: lk, text: v.text, x: v.x, y: v.y, orientation: v.orientation, size: v.size, bold: v.bold, italic: v.italic,
        color: v.color, shape: v.shape as SchLabel['shape'], pinLength: v.pinLength as number | null, fields,
      };
    }
    case 'wire':
    case 'line': {
      if (!exactKeys(v, v.kind === 'wire' ? WIRE_KEYS : LINE_KEYS) || (v.kind === 'wire' && !isBool(v.bus))) return null;
      if (!Array.isArray(v.points) || v.points.length !== 2 || !v.points.every(isPoint)) return null;
      const stroke = readStroke({ width: v.width, style: v.style, color: v.color });
      if (stroke == null) return null;
      const points = (v.points as Array<[number, number]>).map((p) => [p[0], p[1]]) as [[number, number], [number, number]];
      return v.kind === 'wire' ? { kind: 'wire', ...base, bus: v.bus as boolean, points, ...stroke } : { kind: 'line', ...base, points, ...stroke };
    }
    case 'busEntry': {
      if (!exactKeys(v, BUS_ENTRY_KEYS) || !isPos(v.x) || !isPos(v.y) || !isPair(v.size)) return null;
      const stroke = readStroke({ width: v.width, style: v.style, color: v.color });
      return stroke == null ? null : { kind: 'busEntry', ...base, x: v.x, y: v.y, size: [v.size[0], v.size[1]], ...stroke };
    }
    case 'junction':
      if (!exactKeys(v, JUNCTION_KEYS) || !isPos(v.x) || !isPos(v.y) || !isLength(v.diameter) || !isColor(v.color)) return null;
      return { kind: 'junction', ...base, x: v.x, y: v.y, diameter: v.diameter, color: v.color };
    case 'text': {
      if (!isColor(v.color)) return null;
      const t = viaSymEdit(v, 'text', ['color']);
      if (t == null || t.kind !== 'text') return null;
      return { ...t, ...base, kind: 'text', color: v.color };
    }
    case 'textbox': {
      if (!isColor(v.color)) return null;
      const t = viaSymEdit(v, 'textbox', ['color']);
      if (t == null || t.kind !== 'textbox') return null;
      return { ...t, ...base, kind: 'textbox', color: v.color };
    }
    case 'tableCell': {
      if (!isColor(v.color) || !isUuid(v.table) || !isCount(v.row) || !isCount(v.col) || !isCount(v.rowSpan) || !isCount(v.colSpan)) return null;
      const t = viaSymEdit(v, 'textbox', ['color', ...CELL_KEYS]);
      if (t == null || t.kind !== 'textbox') return null;
      return { ...t, ...base, kind: 'tableCell', color: v.color, table: v.table, row: v.row, col: v.col, rowSpan: v.rowSpan, colSpan: v.colSpan };
    }
    case 'shape':
    case 'ruleArea': {
      const s = viaSymEdit(v, 'shape', []);
      if (s == null || s.kind !== 'shape') return null;
      return v.kind === 'shape' ? { ...s, ...base, kind: 'shape' } : { ...s, ...base, kind: 'ruleArea' };
    }
    case 'image':
      if (!exactKeys(v, IMAGE_KEYS) || !isPos(v.x) || !isPos(v.y) || !isNum(v.scale) || v.scale <= 0 || !isCount(v.bytes)) return null;
      if (v.png !== null && !(typeof v.png === 'string' && v.png !== '' && isBase64(v.png))) return null;
      return { kind: 'image', ...base, x: v.x, y: v.y, scale: v.scale, bytes: v.bytes, png: v.png };
    case 'sheet': {
      if (!exactKeys(v, SHEET_KEYS) || !isRecordString(v.name) || !isRecordString(v.file) || !isRecordString(v.page) || !isPos(v.x) || !isPos(v.y)) return null;
      if (!Array.isArray(v.size) || v.size.length !== 2 || !v.size.every(isLength) || !isLength(v.borderWidth) || !isColor(v.borderColor) || !isColor(v.fillColor)) return null;
      if (!isBool(v.inBom) || !isBool(v.onBoard) || !isBool(v.inSim) || !isBool(v.dnp) || !isCount(v.pins)) return null;
      const fields = readSheetFields(v.fields);
      if (fields == null) return null;
      return {
        kind: 'sheet', ...base, name: v.name, file: v.file, page: v.page, x: v.x, y: v.y, size: [v.size[0] as number, v.size[1] as number],
        borderWidth: v.borderWidth, borderColor: v.borderColor, fillColor: v.fillColor, inBom: v.inBom, onBoard: v.onBoard, inSim: v.inSim, dnp: v.dnp,
        fields, pins: v.pins,
      };
    }
    case 'sheetPin':
      if (!exactKeys(v, SHEET_PIN_KEYS) || !(v.sheet === '' || isUuid(v.sheet)) || !isRecordString(v.name) || !oneOf(v.shape, PORT_SHAPES)) return null;
      if (!oneOf(v.side, SIDES) || !isLength(v.size) || !isPos(v.x) || !isPos(v.y)) return null;
      return { kind: 'sheetPin', ...base, sheet: v.sheet as string, name: v.name, shape: v.shape, side: v.side, size: v.size, x: v.x, y: v.y };
    case 'table': {
      if (!exactKeys(v, TABLE_KEYS) || !isCount(v.rows) || !isCount(v.cols)) return null;
      const { rows, cols } = v;
      if (!Array.isArray(v.cells) || v.cells.length !== rows) return null;
      if (!v.cells.every((r) => Array.isArray(r) && r.length === cols && r.every(isRecordString))) return null;
      if (!Array.isArray(v.colWidths) || v.colWidths.length !== cols || !v.colWidths.every(isLength)) return null;
      if (!Array.isArray(v.rowHeights) || v.rowHeights.length !== rows || !v.rowHeights.every(isLength)) return null;
      const border = readStroke(v.border);
      const separators = readStroke(v.separators);
      if (border == null || separators == null || !isBool(v.borderExternal) || !isBool(v.borderHeader) || !isBool(v.separatorsRows) || !isBool(v.separatorsCols)) return null;
      return {
        kind: 'table', ...base, rows, cols, cells: (v.cells as string[][]).map((r) => [...r]),
        borderExternal: v.borderExternal, borderHeader: v.borderHeader, border, separatorsRows: v.separatorsRows, separatorsCols: v.separatorsCols, separators,
        colWidths: [...(v.colWidths as number[])], rowHeights: [...(v.rowHeights as number[])],
      };
    }
    case 'group':
      if (!exactKeys(v, GROUP_KEYS) || !isRecordString(v.name) || !isCount(v.members) || !isRecordString(v.designBlock)) return null;
      return { kind: 'group', ...base, name: v.name, members: v.members, designBlock: v.designBlock };
    default:
      return null;
  }
}

/**
 * kicadSchItemGet's answer read closed: exactly `{ items }`, each a record
 * of its kind, at most as many as were asked. Null for "" or any other shape.
 */
export function readSchItems(text: unknown, asked: number): SchItemRecord[] | null {
  if (typeof text !== 'string' || text === '') return null;
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (!isObj(v) || !exactKeys(v, ['items']) || !Array.isArray(v.items) || v.items.length > asked) return null;
  const out: SchItemRecord[] = [];
  for (const it of v.items as unknown[]) {
    const r = readSchItem(it);
    if (r == null) return null;
    out.push(r);
  }
  return out;
}

// ── args ───────────────────────────────────────────────────────────────────────────────

/** A list of `min` to `max` asked items, each exactly `{ uuid, sheetPath }`, no item twice (with `uniqueUuids`, no uuid twice). */
function readAsked(v: unknown, min: number, max: number, uniqueUuids: boolean): AskedItem[] | null {
  if (!Array.isArray(v) || v.length < min || v.length > max) return null;
  const out: AskedItem[] = [];
  const seen = new Set<string>();
  for (const a of v as unknown[]) {
    if (!isObj(a) || !exactKeys(a, ['uuid', 'sheetPath']) || !isUuid(a.uuid) || !isAskedPath(a.sheetPath)) return null;
    const key = uniqueUuids ? a.uuid : `${a.uuid} ${a.sheetPath}`;
    if (seen.has(key)) return null;
    seen.add(key);
    out.push({ uuid: a.uuid, sheetPath: a.sheetPath });
  }
  return out;
}

/** sch.item.get's args: exactly `{ items }`, 1 to 512 asked items, none twice. Null for anything else. */
export function parseSchItemGetArgs(args: unknown): { items: AskedItem[] } | null {
  if (!isObj(args) || !exactKeys(args, ['items'])) return null;
  const items = readAsked(args.items, 1, GET_MAX, false);
  return items == null ? null : { items };
}

/** The keys each kind's set may carry (the engine's schEditableKeys; the symbol editor's kinds through EDITABLE_KEYS, plus a text's color). */
export const SCH_EDITABLE_KEYS: Readonly<Record<SchItemKind, readonly string[]>> = Object.freeze({
  label: ['labelKind', 'text', 'x', 'y', 'orientation', 'size', 'bold', 'italic', 'color', 'shape', 'pinLength', 'fields'],
  wire: ['points', 'width', 'style', 'color'],
  line: ['points', 'width', 'style', 'color'],
  busEntry: ['width', 'style', 'color'],
  junction: ['diameter', 'color'],
  text: [...EDITABLE_KEYS.text, 'color'],
  textbox: [...EDITABLE_KEYS.textbox, 'color'],
  shape: [...EDITABLE_KEYS.shape],
  ruleArea: [...EDITABLE_KEYS.shape],
  image: ['x', 'y', 'scale', 'png'],
  sheet: ['name', 'file', 'page', 'x', 'y', 'size', 'borderWidth', 'borderColor', 'fillColor', 'inBom', 'onBoard', 'inSim', 'dnp', 'fields'],
  sheetPin: ['name', 'shape', 'side', 'size'],
  table: [],
  tableCell: [],
  group: ['name'],
});

/** A set's fields: at most 32 of `{ name, value?, visible? }`, names 1 to 1,024 characters, none twice. */
function isFieldsSet(v: unknown): boolean {
  if (!Array.isArray(v) || v.length > FIELDS_MAX) return false;
  const names = new Set<string>();
  for (const f of v as unknown[]) {
    if (!isObj(f) || !has(f, 'name') || !Object.keys(f).every((k) => k === 'name' || k === 'value' || k === 'visible')) return false;
    if (!isText(f.name, 1) || names.has(f.name)) return false;
    if (has(f, 'value') && !isText(f.value)) return false;
    if (has(f, 'visible') && !isBool(f.visible)) return false;
    names.add(f.name);
  }
  return true;
}

/** A sheet file name: relative, ending .kicad_sch, no "..", no backslash, no control character. */
export function isSheetFile(v: unknown): v is string {
  return isText(v, 1) && v.toLowerCase().endsWith('.kicad_sch') && !v.includes('..') && !v.includes('\\') && !v.startsWith('/') && !/^[A-Za-z]:/.test(v);
}

/** The decoded length of well formed base64, null for anything else. */
export function base64Bytes(v: unknown): number | null {
  if (typeof v !== 'string' || v === '' || !isBase64(v)) return null;
  const pad = v.endsWith('==') ? 2 : v.endsWith('=') ? 1 : 0;
  return (v.length / 4) * 3 - pad;
}

/** Each key of the engine's own kinds, its type and bounds (readSchSet). */
const SET_VALUE: Readonly<Record<string, (v: unknown, kind: SchItemKind) => boolean>> = Object.freeze({
  labelKind: (v: unknown) => oneOf(v, LABEL_KINDS),
  text: (v: unknown) => isText(v),
  name: (v: unknown, kind: SchItemKind) => isText(v, kind === 'group' ? 0 : 1),
  page: (v: unknown) => isText(v, 1, PAGE_MAX),
  file: isSheetFile,
  x: isPos,
  y: isPos,
  size: (v: unknown, kind: SchItemKind) => (kind === 'sheet'
    ? Array.isArray(v) && v.length === 2 && v.every((n) => inRange(n, 0, POSITION_MAX_MM) && n > 0)
    : inRange(v, 0, SIZE_MAX_MM) && v > 0),
  width: (v: unknown) => inRange(v, 0, SIZE_MAX_MM),
  diameter: (v: unknown) => inRange(v, 0, SIZE_MAX_MM),
  pinLength: (v: unknown) => inRange(v, 0, SIZE_MAX_MM),
  borderWidth: (v: unknown) => inRange(v, 0, SIZE_MAX_MM),
  scale: (v: unknown) => inRange(v, 0.001, 1000),
  orientation: (v: unknown) => oneOf(v, LABEL_ORIENTATIONS),
  bold: isBool,
  italic: isBool,
  inBom: isBool,
  onBoard: isBool,
  inSim: isBool,
  dnp: isBool,
  color: isColor,
  borderColor: isColor,
  fillColor: isColor,
  style: (v: unknown) => oneOf(v, LINE_STYLES),
  shape: (v: unknown, kind: SchItemKind) => (kind === 'sheetPin' ? oneOf(v, PORT_SHAPES) : oneOf(v, PORT_SHAPES) || oneOf(v, FLAG_SHAPES)),
  side: (v: unknown) => oneOf(v, SIDES),
  points: (v: unknown) => Array.isArray(v) && v.length === 2 && v.every(isPoint),
  fields: isFieldsSet,
  // Any length here: past 4 MiB decoded the op answers too_large.
  png: (v: unknown) => base64Bytes(v) != null,
});

/** The symbol editor's kinds: a set of their keys read by parseItemSet, a text's color beside it. */
const SYMEDIT_KIND: Partial<Record<SchItemKind, 'text' | 'textbox' | 'shape'>> = { text: 'text', textbox: 'textbox', shape: 'shape', ruleArea: 'shape' };

/** One kind's set read closed: a non empty partial of that kind's editable keys, each in its type and bounds. Null for anything else (a table's or a table cell's set too). */
export function readSchItemSet(kind: SchItemKind, v: unknown): Record<string, unknown> | null {
  if (!isObj(v) || Object.keys(v).length === 0) return null;
  const allowed = SCH_EDITABLE_KEYS[kind];
  if (allowed.length === 0 || !Object.keys(v).every((k) => allowed.includes(k))) return null;
  const as = SYMEDIT_KIND[kind];
  if (as != null) {
    const { color, ...rest } = v;
    if (has(v, 'color') && !isColor(color)) return null;
    if (Object.keys(rest).length > 0) {
      const sym = parseItemSet(rest);
      if (sym == null || !Object.keys(sym).every((k) => EDITABLE_KEYS[as].includes(k))) return null;
      if ((has(sym, 'unit') && sym.unit !== 0) || (has(sym, 'bodyStyle') && sym.bodyStyle !== 0)) return null;
    }
    return { ...v };
  }
  for (const [k, value] of Object.entries(v)) if (!SET_VALUE[k]?.(value, kind)) return null;
  return { ...v };
}

/** sch.item.set's args: exactly `{ items, kind, set, fileMode? }`: 1 to 4,096 items, no uuid twice; `fileMode` only with a sheet's `file`. Null for anything else. */
export function parseSchItemSetArgs(args: unknown): SchItemSetArgs | null {
  if (!isObj(args) || !Object.keys(args).every((k) => ['items', 'kind', 'set', 'fileMode'].includes(k))) return null;
  if (!has(args, 'items') || !has(args, 'kind') || !has(args, 'set') || !oneOf(args.kind, SCH_ITEM_KINDS)) return null;
  const items = readAsked(args.items, 1, SET_MAX, true);
  const set = readSchItemSet(args.kind, args.set);
  if (items == null || set == null) return null;
  const out: SchItemSetArgs = { items, kind: args.kind, set };
  if (has(args, 'fileMode')) {
    if (args.kind !== 'sheet' || !has(set, 'file') || !oneOf(args.fileMode, FILE_MODES)) return null;
    out.fileMode = args.fileMode;
  }
  return out;
}

/** The record of a symbol editor kind as the symbol editor's reader gives it (for itemSetMisfit). */
function asSymItem(r: SchItemRecord): SymItem | null {
  if (r.kind === 'shape' || r.kind === 'ruleArea') return { ...r, kind: 'shape' } as unknown as SymItem;
  if (r.kind === 'text' || r.kind === 'textbox') return r as unknown as SymItem;
  return null;
}

/**
 * Why the items refuse the set, or null when it fits (bad_args with this as
 * the message), checked before anything is sent as the engine applies it per
 * item: a label shape the label's kind (after the set) has no word for, a
 * flag length on a label that is not a directive, a shape's point count its
 * shape does not take, a file change on more than one sheet.
 */
export function schItemSetMisfit(kind: SchItemKind, set: Record<string, unknown>, items: readonly SchItemRecord[]): string | null {
  if (kind === 'sheet' && has(set, 'file') && items.length !== 1) return 'a sheet file changes one sheet at a time';
  for (const item of items) {
    if (item.kind !== kind) return 'the items are of more than one kind';
    if (item.kind === 'label') {
      const ends = (set.labelKind as LabelKind | undefined) ?? item.labelKind;
      if (has(set, 'shape')) {
        if (ends === 'local') return 'a local label takes no shape';
        if (ends === 'directive' ? !oneOf(set.shape, FLAG_SHAPES) : !oneOf(set.shape, PORT_SHAPES)) return `a ${ends} label takes another shape`;
      }
      if (has(set, 'pinLength') && ends !== 'directive') return 'only a directive label has a flag length';
    }
    const sym = asSymItem(item);
    if (sym != null) {
      const { color: _c, ...rest } = set;
      void _c;
      if (Object.keys(rest).length > 0) {
        const why = itemSetMisfit(rest, [sym]);
        if (why != null) return why;
      }
    }
  }
  return null;
}

/** items.json, the set's record (written LAST): `{ applied, depth, renamed, replaced, error? }`. */
export interface SchItemsDone { applied: number; depth: number; renamed: Array<{ from: string; to: string }>; replaced: Array<{ from: string; to: string }>; error: string | null }

function readPairs(v: unknown, check: (s: unknown) => boolean): Array<{ from: string; to: string }> | null {
  if (!Array.isArray(v)) return null;
  const out: Array<{ from: string; to: string }> = [];
  for (const p of v as unknown[]) {
    if (!isObj(p) || !exactKeys(p, ['from', 'to']) || !check(p.from) || !check(p.to)) return null;
    out.push({ from: p.from as string, to: p.to as string });
  }
  return out;
}

/** items.json read closed: null while it is not there yet, 'bad' for any other shape. */
export function readSchItemsDone(bytes: Uint8Array | null): SchItemsDone | 'bad' | null {
  if (bytes == null) return null;
  let v: unknown;
  try { v = JSON.parse(new TextDecoder().decode(bytes)); } catch { return 'bad'; }
  if (!isObj(v)) return 'bad';
  const withError = has(v, 'error');
  if (!exactKeys(v, withError ? ['applied', 'depth', 'renamed', 'replaced', 'error'] : ['applied', 'depth', 'renamed', 'replaced'])) return 'bad';
  if (!isCount(v.applied) || !isCount(v.depth) || (withError && !(typeof v.error === 'string' && /^[a-z_]{1,32}$/.test(v.error)))) return 'bad';
  const renamed = readPairs(v.renamed, isRecordString);
  const replaced = readPairs(v.replaced, isUuid);
  if (renamed == null || replaced == null) return 'bad';
  return { applied: v.applied, depth: v.depth, renamed, replaced, error: withError ? (v.error as string) : null };
}

/** The sheet file words the engine's ccChangeSheetFile answers (K-SHEETFILE). */
export const SHEET_FILE_ERRORS = ['args', 'normalize', 'case_clash', 'in_use', 'exists', 'copy', 'save', 'load', 'recursion'] as const;
