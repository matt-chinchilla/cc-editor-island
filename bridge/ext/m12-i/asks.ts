// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The table asks of the prompt host (the canvas commands addendum 8): KiCad's
// Table Properties and Table Cell Properties dialogs, in the schematic and the
// board, as the engine sends their records (engine run 15, unit m12-e), read
// closed. Pure: no window, no engine.

/** The asks this unit declares (ev.prompt's `ask`). */
export const TABLE_ASKS = ['table', 'tableCell'] as const;
export type TableAsk = (typeof TABLE_ASKS)[number];

/** A stroke's styles, in KiCad's lineTypeNames order. */
export const STROKE_STYLES = ['solid', 'dash', 'dot', 'dashdot', 'dashdotdot'] as const;
/** A cell's alignments, in KiCad's words. */
export const H_ALIGNS = ['left', 'center', 'right'] as const;
export const V_ALIGNS = ['top', 'center', 'bottom'] as const;
/** A schematic cell's fill modes. */
export const FILL_MODES = ['none', 'color'] as const;

/** Bounds of a record: past them the record is not ours to show. */
export const MAX_ROWS = 1024;
export const MAX_COLS = 1024;
export const MAX_CELLS = 65_536;
export const MAX_CELL_TEXT = 65_536;
export const MAX_SELECTED = 4096;
const MAX_FONT = 256;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exact = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const k = Object.keys(o);
  return k.length === keys.length && keys.every((x) => k.includes(x));
};
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const count = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= max;
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);

/** A KiCad uuid as the engine writes it (KIID's text, lowercase). */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A layer's canonical name (`F.SilkS`, `User.Drawings`), or "" in a schematic. */
const LAYER_RE = /^[A-Za-z0-9_.]{1,64}$/;
/** A color: `#rrggbbaa`, or "" for none (the board's strokes always ""). */
const COLOR_RE = /^#[0-9a-f]{8}$/;
const isColor = (v: unknown): v is string => typeof v === 'string' && (v === '' || COLOR_RE.test(v));
/** A width in mm, null when the stroke has none. */
const isWidth = (v: unknown): v is number | null => v === null || (finite(v) && v >= 0);

/** A stroke block: `{ <switches>, width, color, style }`, every key once. */
function readStroke(s: unknown, switches: readonly [string, string]): Record<string, unknown> | null {
  if (!isObj(s) || !exact(s, [...switches, 'width', 'color', 'style'])) return null;
  if (typeof s[switches[0]] !== 'boolean' || typeof s[switches[1]] !== 'boolean') return null;
  if (!isWidth(s.width) || !isColor(s.color) || !oneOf(STROKE_STYLES, s.style)) return null;
  return { [switches[0]]: s[switches[0]], [switches[1]]: s[switches[1]], width: s.width, color: s.color, style: s.style };
}

/**
 * `table`: `{ uuid, rows, cols, cells, border, separators, layer, locked }`;
 * `cells` the grid's text row by row, a covered cell null; `border`
 * `{ external, header, width, color, style }`; `separators`
 * `{ rows, cols, width, color, style }`; `layer` "" in a schematic.
 */
export function readTable(r: unknown): Record<string, unknown> | null {
  if (!isObj(r) || !exact(r, ['uuid', 'rows', 'cols', 'cells', 'border', 'separators', 'layer', 'locked'])) return null;
  const { uuid, rows, cols, cells, layer, locked } = r;
  if (typeof uuid !== 'string' || !UUID_RE.test(uuid)) return null;
  if (!count(rows, MAX_ROWS) || !count(cols, MAX_COLS) || rows * cols > MAX_CELLS) return null;
  if (!Array.isArray(cells) || cells.length !== rows) return null;
  const grid: Array<Array<string | null>> = [];
  for (const row of cells) {
    if (!Array.isArray(row) || row.length !== cols) return null;
    if (!row.every((c) => c === null || (typeof c === 'string' && c.length <= MAX_CELL_TEXT))) return null;
    grid.push([...(row as Array<string | null>)]);
  }
  const border = readStroke(r.border, ['external', 'header']);
  const separators = readStroke(r.separators, ['rows', 'cols']);
  if (border == null || separators == null) return null;
  if (typeof layer !== 'string' || (layer !== '' && !LAYER_RE.test(layer)) || typeof locked !== 'boolean') return null;
  return { uuid, rows, cols, cells: grid, border, separators, layer, locked };
}

/** The keys of a `tableCell` record, every one always present. */
export const TABLE_CELL_KEYS = ['uuids', 'text', 'font', 'bold', 'italic', 'hAlign', 'vAlign', 'margins', 'size', 'width', 'height', 'thickness', 'autoThickness', 'textColor', 'fill'] as const;

const nullOr = (v: unknown, test: (x: unknown) => boolean): boolean => v === null || test(v);
const isLength = (v: unknown): boolean => finite(v) && v >= 0;

/** A cell's margins: null when the cells differ as a whole, else each side a length or null. */
function readMargins(m: unknown): Record<string, number | null> | null | undefined {
  if (m === null) return null;
  if (!isObj(m) || !exact(m, ['left', 'right', 'top', 'bottom'])) return undefined;
  for (const k of ['left', 'right', 'top', 'bottom']) if (!nullOr(m[k], finite)) return undefined;
  return { left: m.left as number | null, right: m.right as number | null, top: m.top as number | null, bottom: m.bottom as number | null };
}

/** A schematic cell's fill: null when the cells differ as a whole, else `{ mode, color }`, each null when they differ. */
function readFill(f: unknown): Record<string, string | null> | null | undefined {
  if (f === null) return null;
  if (!isObj(f) || !exact(f, ['mode', 'color'])) return undefined;
  if (!nullOr(f.mode, (x) => oneOf(FILL_MODES, x)) || !nullOr(f.color, isColor)) return undefined;
  return { mode: f.mode as string | null, color: f.color as string | null };
}

/**
 * `tableCell`: `{ uuids, text, font, bold, italic, hAlign, vAlign, margins,
 * size, width, height, thickness, autoThickness, textColor, fill }`, every key
 * present; a value is null where the selected cells differ or where it does
 * not apply in this editor (`size`, `textColor`, `fill` on the board; `width`,
 * `height`, `thickness`, `autoThickness` in the schematic).
 */
export function readTableCell(r: unknown): Record<string, unknown> | null {
  if (!isObj(r) || !exact(r, TABLE_CELL_KEYS)) return null;
  const { uuids } = r;
  if (!Array.isArray(uuids) || uuids.length === 0 || uuids.length > MAX_SELECTED) return null;
  if (!uuids.every((u) => typeof u === 'string' && UUID_RE.test(u)) || new Set(uuids).size !== uuids.length) return null;
  if (!nullOr(r.text, (x) => typeof x === 'string' && x.length <= MAX_CELL_TEXT)) return null;
  if (!nullOr(r.font, (x) => typeof x === 'string' && x.length <= MAX_FONT)) return null;
  for (const k of ['bold', 'italic', 'autoThickness']) if (!nullOr(r[k], (x) => typeof x === 'boolean')) return null;
  if (!nullOr(r.hAlign, (x) => oneOf(H_ALIGNS, x)) || !nullOr(r.vAlign, (x) => oneOf(V_ALIGNS, x))) return null;
  for (const k of ['size', 'width', 'height', 'thickness']) if (!nullOr(r[k], isLength)) return null;
  if (!nullOr(r.textColor, isColor)) return null;
  const margins = readMargins(r.margins);
  const fill = readFill(r.fill);
  if (margins === undefined || fill === undefined) return null;
  return {
    uuids: [...uuids], text: r.text, font: r.font, bold: r.bold, italic: r.italic, hAlign: r.hAlign, vAlign: r.vAlign, margins,
    size: r.size, width: r.width, height: r.height, thickness: r.thickness, autoThickness: r.autoThickness, textColor: r.textColor, fill,
  };
}

/** Each declared ask's closed record reader (ExtUnit.askReaders). */
export const TABLE_ASK_READERS: Readonly<Record<TableAsk, (record: unknown) => Record<string, unknown> | null>> = {
  table: readTable,
  tableCell: readTableCell,
};

/** kicadTableCsv's answer: `{ name, text }`, null for anything else. */
export const MAX_CSV = 16 * 1024 * 1024;
const NAME_RE = /^[^/\\\0]{1,255}$/;
export function readCsv(raw: unknown): { name: string; text: string } | null {
  if (typeof raw !== 'string' || raw === '' || raw.length > MAX_CSV + 1024) return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!isObj(v) || !exact(v, ['name', 'text'])) return null;
  if (typeof v.name !== 'string' || !NAME_RE.test(v.name) || typeof v.text !== 'string' || v.text.length > MAX_CSV) return null;
  return { name: v.name, text: v.text };
}
