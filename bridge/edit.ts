// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// sch.edit and board.edit (PROTOCOL.md): KiCad's global edits run with no KiCad
// dialog through our engine's kicadSchEdit (a sch frame: Edit Text and Graphics
// Properties) and kicadBoardEdit (a pcb frame: Edit Track and Via Properties,
// Edit Text and Graphics Properties, Edit Teardrops, Swap Layers, Global
// Deletions, Cleanup Tracks and Vias, Remove Unused Pads, Cleanup Graphics,
// Repair Board, Geographical Reannotate and the copper areas' priorities),
// engine run 14. A preview lists the rows and changes nothing; an apply is ONE
// commit named for the op. Each queues on the editor's apply coroutine and
// answers before it runs; the run writes edit.json, then .cc-edit.json LAST.

import { UUID_RE, TEXT_MAX } from './symbol';
import { LAYER_RE } from './boardCheck';
import { jsonOf, MAX_SYMBOL_ROWS } from './symbols';
import { readLines } from './annotate';

/** The engine exports each op needs: its edit, the apply queue probe. */
export const SCH_EDIT_EXPORTS = ['kicadSchEdit', 'kicadCollabBusy'] as const;
export const BOARD_EDIT_EXPORTS = ['kicadBoardEdit', 'kicadCollabBusy'] as const;
/** Each run writes into a fresh folder under this one, outside the project folder. */
export const EDIT_ROOT = '/tmp/cc-edit';
export const EDIT_REPORT = 'edit.json';
export const EDIT_DONE = '.cc-edit.json';
/** At most this many notes in an answer. */
export const MAX_EDIT_NOTES = 200;

/** A key's kind, as the engine reads it (pcbjam cc/main cc_rules_pcb.inc and cc_rules_sch.inc). */
type Kind =
  | { k: 'bool' }
  | { k: 'mm'; min: number; max: number; open?: true }
  | { k: 'size'; min: number; max: number }
  | { k: 'int'; min: number; max: number }
  | { k: 'text'; min: number; max: number }
  | { k: 'enum'; of: readonly string[] }
  | { k: 'layer' } | { k: 'uuids' } | { k: 'nets' } | { k: 'layerMap' } | { k: 'zones' };
type Keys = Readonly<Record<string, Kind>>;
interface OpSpec { filter: Keys; set: Keys; ok: (filter: Record<string, unknown>, set: Record<string, unknown>) => boolean }

const B: Kind = { k: 'bool' };
const mm = (min: number, max: number): Kind => ({ k: 'mm', min, max });
const text = (min: number, max: number): Kind => ({ k: 'text', min, max });
const NET_FILTER: Keys = { nets: { k: 'nets' }, netClass: text(1, 256), layer: { k: 'layer' }, uuids: { k: 'uuids' }, selected: B };
const anyOn = (o: Record<string, unknown>, keys: readonly string[]): boolean => keys.some((k) => o[k] === true);
const some = (o: Record<string, unknown>): boolean => Object.keys(o).length > 0;
const none = (o: Record<string, unknown>): boolean => Object.keys(o).length === 0;

/**
 * The eleven board ops, each with its filter's and set's keys (properties spec
 * 7.5, with KiCad's own dialog controls the engine also takes, BUILD-NOTES-
 * rules.md) and what the op needs to run at all.
 */
export const BOARD_OPS: Readonly<Record<string, OpSpec>> = Object.freeze({
  tracksVias: {
    filter: { ...NET_FILTER, tracks: B, vias: B, throughVias: B, microVias: B, blindVias: B, buriedVias: B, trackWidth: mm(0.001, 100), viaSize: mm(0.001, 100) },
    set: { width: { k: 'size', min: 0.001, max: 100 }, viaDiameter: { k: 'size', min: 0.001, max: 100 }, viaDrill: { k: 'size', min: 0.001, max: 100 }, layer: { k: 'layer' },
      annularRings: { k: 'enum', of: ['keepAll', 'removeExceptStartAndEnd', 'removeAll', 'startEndOnly'] } },
    ok: (f, s) => anyOn(f, ['tracks', 'vias']) && some(s),
  },
  textGraphics: {
    filter: { references: B, values: B, otherFields: B, texts: B, graphics: B, dimensions: B, boardItems: B, footprintItems: B, selected: B,
      layer: { k: 'layer' }, refGlob: text(1, 256), footprintGlob: text(1, 512), uuids: { k: 'uuids' } },
    set: { layer: { k: 'layer' }, visible: B, bold: B, italic: B, keepUpright: B, knockout: B, autoThickness: B, defaults: B,
      height: mm(0.001, 250), width: mm(0.001, 250), thickness: mm(0.001, 50), lineWidth: mm(0.001, 50) },
    ok: (f, s) => anyOn(f, ['references', 'values', 'otherFields', 'texts', 'graphics', 'dimensions']) && some(s),
  },
  teardrops: {
    filter: { ...NET_FILTER, roundPads: B, rectPads: B, vias: B, trackToTrack: B, pthPads: B, smdPads: B, existing: B },
    set: { on: B, curved: B, allowTwoTracks: B, preferZoneConnection: B, lengthRatio: { k: 'mm', min: 0, max: 10, open: true },
      widthRatio: { k: 'mm', min: 0, max: 10, open: true }, maxLength: mm(0, 100), maxWidth: mm(0, 100) },
    ok: (f, s) => anyOn(f, ['roundPads', 'rectPads', 'vias', 'trackToTrack']) && some(s),
  },
  swapLayers: { filter: {}, set: { map: { k: 'layerMap' } }, ok: (f, s) => none(f) && s.map !== undefined },
  deleteGlobal: {
    filter: { zones: B, teardrops: B, texts: B, graphics: B, footprints: B, tracks: B, vias: B, outline: B, markers: B, all: B, locked: B, unlocked: B, layer: { k: 'layer' } },
    set: {},
    ok: (f, s) => none(s) && anyOn(f, ['zones', 'teardrops', 'texts', 'graphics', 'footprints', 'tracks', 'vias', 'outline', 'markers', 'all']),
  },
  cleanupTracks: {
    filter: NET_FILTER,
    set: { mergeCollinear: B, removeDangling: B, removeShorts: B, redundantVias: B, tracksInPads: B, danglingVias: B, refillZones: B },
    ok: (_f, s) => some(s),
  },
  unusedPads: { filter: { uuids: { k: 'uuids' } }, set: { vias: B, pads: B, keepOuter: B, remove: B }, ok: (_f, s) => anyOn(s, ['vias', 'pads']) },
  cleanupGraphics: { filter: {}, set: { mergeRects: B, fixOutline: B, deleteRedundant: B, tolerance: mm(0, 10) }, ok: (_f, s) => anyOn(s, ['mergeRects', 'fixOutline', 'deleteRedundant']) },
  repair: { filter: {}, set: {}, ok: () => true },
  reannotate: {
    filter: {},
    set: { order: { k: 'int', min: 0, max: 7 }, round: mm(0.001, 100), by: { k: 'enum', of: ['footprint', 'reference'] },
      frontStart: { k: 'int', min: 0, max: 1_000_000 }, backStart: { k: 'int', min: 0, max: 1_000_000 }, frontPrefix: text(0, 32), backPrefix: text(0, 32),
      removePrefix: B, removeFrontPrefix: B, removeBackPrefix: B, skipLocked: B, scope: { k: 'enum', of: ['all', 'selected', 'front', 'back'] },
      uuids: { k: 'uuids' }, exclude: text(0, 4096) },
    ok: () => true,
  },
  zoneOrder: { filter: {}, set: { order: { k: 'zones' } }, ok: (_f, s) => s.order !== undefined },
});

/** The schematic's one op, Edit Text and Graphics Properties (with KiCad's other targets and filters). */
export const SCH_OPS: Readonly<Record<string, OpSpec>> = Object.freeze({
  textGraphics: {
    filter: { references: B, values: B, otherFields: B, labels: B, sheetTitles: B, sheetPins: B, texts: B, wires: B, buses: B, graphics: B,
      sheetFields: B, sheetBorders: B, labelFields: B, selected: B, power: B,
      sheetPath: text(1, 256), refGlob: text(1, 256), symbolGlob: text(1, 256), fieldGlob: text(1, 256), netGlob: text(1, 256) },
    set: { size: mm(0.0254, 254), lineWidth: mm(0, 25.4), junctionSize: mm(0, 25.4), bold: B, italic: B, visible: B, showFieldNames: B,
      hAlign: { k: 'enum', of: ['left', 'center', 'right'] }, vAlign: { k: 'enum', of: ['top', 'center', 'bottom'] },
      lineStyle: { k: 'enum', of: ['default', 'solid', 'dash', 'dot', 'dashDot', 'dashDotDot'] } },
    ok: (f, s) => anyOn(f, ['references', 'values', 'otherFields', 'labels', 'sheetTitles', 'sheetPins', 'texts', 'wires', 'buses', 'graphics', 'sheetFields', 'sheetBorders', 'labelFields']) && some(s),
  },
});

export interface EditArgs { op: string; preview: boolean; filter: Record<string, unknown>; set: Record<string, unknown> }
export interface EditRow { uuid: string; kind: string; words: string; from?: string; to?: string; symbolPath?: string }
export interface EditReport { op: string; preview: boolean; rows: EditRow[]; count: number; truncated: boolean; depth: number; notes: string[] }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).length === keys.length && keys.every((k) => own(o, k));
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const UNSPELLABLE_RE = /\0|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const isUuids = (v: unknown, max = MAX_SYMBOL_ROWS): v is string[] =>
  Array.isArray(v) && v.length >= 1 && v.length <= max && (v as unknown[]).every((u) => typeof u === 'string' && UUID_RE.test(u));

function fits(kind: Kind, v: unknown): boolean {
  switch (kind.k) {
    case 'bool': return typeof v === 'boolean';
    case 'mm': return typeof v === 'number' && Number.isFinite(v) && (kind.open ? v > kind.min : v >= kind.min) && v <= kind.max;
    case 'size': return v === 'netclass' || (typeof v === 'number' && Number.isFinite(v) && v >= kind.min && v <= kind.max);
    case 'int': return typeof v === 'number' && Number.isSafeInteger(v) && v >= kind.min && v <= kind.max;
    case 'text': {
      if (typeof v !== 'string' || CONTROL_RE.test(v) || UNSPELLABLE_RE.test(v)) return false;
      const n = [...v].length;
      return n >= kind.min && n <= kind.max;
    }
    case 'enum': return typeof v === 'string' && kind.of.includes(v);
    case 'layer': return typeof v === 'string' && LAYER_RE.test(v);
    case 'uuids': return isUuids(v);
    case 'nets': return Array.isArray(v) && v.length >= 1 && v.length <= MAX_SYMBOL_ROWS && (v as unknown[]).every((n) => fits(text(1, 512), n));
    case 'layerMap': return isObj(v) && Object.keys(v).length >= 1 && Object.entries(v).every(([from, to]) => LAYER_RE.test(from) && typeof to === 'string' && LAYER_RE.test(to));
    case 'zones': return isUuids(v) && new Set(v).size === v.length;
  }
}

function readKeys(v: unknown, keys: Keys): Record<string, unknown> | null {
  if (!isObj(v)) return null;
  for (const [k, x] of Object.entries(v)) if (!own(keys, k) || !fits(keys[k], x)) return null;
  return { ...v };
}

/**
 * sch.edit's or board.edit's args: exactly `{ op, preview, filter, set }`,
 * `op` one of the frame's ops, its filter's and set's keys each of the kind
 * the engine reads, and what the op needs to run at all (a target named, a
 * change named). Null for anything else.
 */
export function parseEditArgs(args: unknown, ops: Readonly<Record<string, OpSpec>>): EditArgs | null {
  if (!isObj(args) || !exactKeys(args, ['op', 'preview', 'filter', 'set'])) return null;
  if (typeof args.op !== 'string' || !own(ops, args.op) || typeof args.preview !== 'boolean') return null;
  const spec = ops[args.op];
  const filter = readKeys(args.filter, spec.filter);
  const set = readKeys(args.set, spec.set);
  if (filter == null || set == null || !spec.ok(filter, set)) return null;
  return { op: args.op, preview: args.preview, filter, set };
}

/** The args as kicadSchEdit and kicadBoardEdit read them, with the run's folder. */
export const editJson = (run: number, dir: string, a: EditArgs): string =>
  JSON.stringify({ run, dir, op: a.op, preview: a.preview, filter: a.filter, set: a.set });

/** The kinds a row names: KiCad's item kinds, the schematic's and the board's. */
export const SCH_KINDS: readonly string[] = ['reference', 'value', 'sheetName', 'field', 'sheetPin', 'sheet', 'label', 'text', 'junction', 'wire', 'bus', 'graphic'];
export const BOARD_KINDS: readonly string[] = ['track', 'arc', 'via', 'pad', 'footprint', 'zone', 'field', 'text', 'shape', 'marker', 'group', 'dimension', 'item'];
/** A footprint's schematic path (KIID_PATH), or "" for none. */
const SYMBOL_PATH_RE = /^(\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}){1,65}$/;
export const isSymbolPath = (v: unknown): v is string => v === '' || (typeof v === 'string' && SYMBOL_PATH_RE.test(v));
const isText = (v: unknown, max = TEXT_MAX): v is string => typeof v === 'string' && [...v].length <= max;
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** The codes an edit's record may carry. */
export const EDIT_ERRORS = ['island_error', 'duplicate_designator'] as const;

/**
 * edit.json read closed: 7.5's EditReport (rows of at most 4,096, `count` the
 * whole), the op and the preview as asked, and the run's lines (reannotate's
 * parts that keep their designators) as notes; null for anything else. A
 * board row's uuid is "" when KiCad's cleaner names no item.
 */
export function readEditReport(bytes: Uint8Array | null, frame: 'sch' | 'pcb', asked: EditArgs): EditReport | null {
  const v = jsonOf(bytes);
  if (!isObj(v)) return null;
  const keys = ['op', 'preview', 'rows', 'count', 'truncated', 'depth'];
  if (!(exactKeys(v, keys) || (frame === 'pcb' && exactKeys(v, [...keys, 'lines'])))) return null;
  if (v.op !== asked.op || v.preview !== asked.preview || !count(v.count) || typeof v.truncated !== 'boolean' || !count(v.depth)) return null;
  if (!Array.isArray(v.rows) || v.rows.length > MAX_SYMBOL_ROWS || v.rows.length > v.count) return null;
  const kinds = frame === 'sch' ? SCH_KINDS : BOARD_KINDS;
  const rows: EditRow[] = [];
  for (const r of v.rows as unknown[]) {
    if (!isObj(r) || !own(r, 'uuid') || !own(r, 'kind') || !own(r, 'words')) return null;
    const extra = Object.keys(r).filter((k) => k !== 'uuid' && k !== 'kind' && k !== 'words');
    if (!extra.every((k) => k === 'from' || k === 'to' || (frame === 'pcb' && k === 'symbolPath'))) return null;
    if (own(r, 'from') !== own(r, 'to')) return null;
    if (typeof r.uuid !== 'string' || !(UUID_RE.test(r.uuid) || (frame === 'pcb' && r.uuid === ''))) return null;
    if (typeof r.kind !== 'string' || !kinds.includes(r.kind) || !isText(r.words, 256)) return null;
    const row: EditRow = { uuid: r.uuid, kind: r.kind, words: r.words };
    if (own(r, 'from')) {
      if (!isText(r.from) || !isText(r.to)) return null;
      row.from = r.from as string;
      row.to = r.to as string;
    }
    if (own(r, 'symbolPath')) {
      if (!isSymbolPath(r.symbolPath) || r.symbolPath === '') return null;
      row.symbolPath = r.symbolPath;
    }
    rows.push(row);
  }
  let notes: string[] = [];
  if (own(v, 'lines')) {
    const lines = readLines(v.lines);
    if (lines == null) return null;
    notes = lines.slice(0, MAX_EDIT_NOTES).map((l) => [...l.text].slice(0, TEXT_MAX).join(''));
  }
  return { op: v.op as string, preview: v.preview as boolean, rows, count: v.count, truncated: v.truncated, depth: v.depth, notes };
}
