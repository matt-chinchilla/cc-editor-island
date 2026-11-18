// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The drawing sheet editor's items, defaults, preview, append and picture ops
// (PROTOCOL.md "The drawing sheet editor: items, defaults, preview, append and
// pictures"): the open sheet's items read and changed by uuid, its defaults
// (line width, text size and thickness, margins), the page and title block it
// is previewed on, another sheet appended to it, and a picture armed for KiCad's
// Place Bitmaps tool, all through our engine's dsedit exports (pcbjam cc/main
// wasm/bindings/dsedit_embind.cpp, engine run 15) with no KiCad window. Each
// change is queued on the editor's apply coroutine as ONE undo step and answers
// before it runs, so the island waits for the queue to empty and reads it back.
//
// This module holds the closed parsers of the ops' args, the closed readers of
// the engine's records (spec section 7; any other shape is an island_error),
// the cores of the ten ops and installDsEditAsk, the slot KiCad's Place Bitmaps
// asks through (ev.dsedit). bridge/ext/ds-i2.ts wires them to the responder;
// every op passes ds-i1's gate (bridge/dsedit.ts dsGate) first.
import { fail, isObj, noArgs, ok, type Answer, type ResponderCtx } from './ext/contract';
import { callDsBool, callDsText, dsGate, dsReadBack, DS_MESSAGE_MAX, DS_RECORD_MAX, DS_TEXT_MAX_BYTES, utf8Bytes, type DsEditState } from './dsedit';
import { isText } from './symedit';
import { UUID_RE } from './symbol';

/** The marker export: the engine asks the page before KiCad's file dialog for a picture (K-DS1). */
export const DSEDIT_ASK_EXPORT = 'kicadHostDsEdit';
/** The pseudo-cap a ds frame lists when the engine asks the page for a picture (ev.dsedit). */
export const DSEDIT_HELD_CAP = 'dseditHeld';
/** The event the picture ask goes out as, and its keys. */
export const DSEDIT_EVENT = 'ev.dsedit';
export const DSEDIT_EVENT_KEYS = ['ask', 'uuid', 'isNew'] as const;

/** The kinds of a sheet's items, KiCad's own. */
export const DS_KINDS = ['line', 'rect', 'text', 'polygon', 'bitmap'] as const;
export type DsKind = typeof DS_KINDS[number];
/** The corner of the page's margins a point is measured from (KiCad's file tokens; rbcorner the default). */
export const DS_CORNERS = ['rbcorner', 'rtcorner', 'lbcorner', 'ltcorner'] as const;
export type DsCorner = typeof DS_CORNERS[number];
/** The pages an item is drawn on. */
export const DS_PAGE_OPTIONS = ['all', 'page1only', 'notonpage1'] as const;
export type DsPages = typeof DS_PAGE_OPTIONS[number];
export const DS_H_JUSTIFY = ['left', 'center', 'right'] as const;
export const DS_V_JUSTIFY = ['top', 'center', 'bottom'] as const;
/** KiCad's paper names (PAGE_INFO's types, as GetTypeAsString spells them). */
export const DS_PAPERS = ['A5', 'A4', 'A3', 'A2', 'A1', 'A0', 'A', 'B', 'C', 'D', 'E', 'GERBER', 'User', 'USLetter', 'USLegal', 'USLedger'] as const;

/** The engine's bounds (dsedit_embind.cpp, after KiCad's properties pane and its page settings). */
export const DS_BOUNDS = Object.freeze({
  uuids: 4096, setUuids: 512, newItems: 64, kinds: 5,
  position: 10_000, repeat: 500, lineWidth: 10, labelStep: 100_000, rotation: 360,
  textSize: 100, textSizeMin: 0.01, textThickness: 5, margin: 1_000, ppi: 100_000,
  itemText: 4096, pageMin: 25.4, pageMax: 3048, pngBytes: 4 * 1024 * 1024, comments: 9,
});

export interface DsPoint { x: number; y: number; corner: DsCorner }
interface DsCommon { kind: DsKind; uuid: string; name: string; comment: string; pages: DsPages; start: DsPoint; repeat: number; step: [number, number] }
export interface DsLine extends DsCommon { kind: 'line' | 'rect'; end: DsPoint; lineWidth: number }
export interface DsText extends DsCommon {
  kind: 'text'; text: string; labelStep: number; font: string; bold: boolean; italic: boolean; color: string;
  hJustify: typeof DS_H_JUSTIFY[number]; vJustify: typeof DS_V_JUSTIFY[number]; rotation: number;
  size: [number, number]; maxLength: number; maxHeight: number; lineWidth: number;
}
export interface DsPolygon extends DsCommon { kind: 'polygon'; rotation: number; lineWidth: number; outlines: number; points: number }
export interface DsBitmap extends DsCommon { kind: 'bitmap'; ppi: number; width: number; height: number }
export type DsItem = DsLine | DsText | DsPolygon | DsBitmap;
/** A partial of one kind's editable keys. */
export type DsItemSet = Record<string, unknown>;
export interface DsDefaults { lineWidth: number; textSize: [number, number]; textThickness: number; margins: { left: number; right: number; top: number; bottom: number } }
export interface DsPreview {
  paper: string; portrait: boolean; width: number; height: number;
  title: string; date: string; revision: string; company: string; comments: string[];
}
/** ev.dsedit's payload: what KiCad's frame would have asked a window of. */
export interface DsEditAsk { ask: 'image'; uuid: string; isNew: boolean }

const COMMON_KEYS = ['kind', 'uuid', 'name', 'comment', 'pages', 'start', 'repeat', 'step'] as const;
/** Each kind's record keys past the common ones (spec 7.2). */
const KIND_KEYS: Readonly<Record<DsKind, readonly string[]>> = {
  line: ['end', 'lineWidth'],
  rect: ['end', 'lineWidth'],
  text: ['text', 'labelStep', 'font', 'bold', 'italic', 'color', 'hJustify', 'vJustify', 'rotation', 'size', 'maxLength', 'maxHeight', 'lineWidth'],
  polygon: ['rotation', 'lineWidth', 'outlines', 'points'],
  bitmap: ['ppi', 'width', 'height'],
};
/** The keys a set may carry for each kind (never kind, uuid, a polygon's outlines or points, a bitmap's width or height). */
const SET_COMMON = ['name', 'comment', 'pages', 'start', 'repeat', 'step'] as const;
const SET_KEYS: Readonly<Record<DsKind, readonly string[]>> = {
  line: [...SET_COMMON, 'end', 'lineWidth'],
  rect: [...SET_COMMON, 'end', 'lineWidth'],
  text: [...SET_COMMON, ...KIND_KEYS.text],
  polygon: [...SET_COMMON, 'rotation', 'lineWidth'],
  bitmap: [...SET_COMMON, 'ppi'],
};
const SET_ANY: readonly string[] = [...new Set(Object.values(SET_KEYS).flat())];
const DEFAULTS_KEYS = ['lineWidth', 'textSize', 'textThickness', 'margins'] as const;
const MARGIN_KEYS = ['left', 'right', 'top', 'bottom'] as const;
const PREVIEW_KEYS = ['paper', 'portrait', 'width', 'height', 'title', 'date', 'revision', 'company', 'comments'] as const;
const TITLE_KEYS = ['title', 'date', 'revision', 'company'] as const;
const COLOR_RE = /^(?:#[0-9a-f]{8})?$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
// A lone surrogate or a NUL has no UTF-8 spelling the engine could take.
const UNSPELLABLE_RE = /\0|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const inRange = (v: unknown, min: number, max: number): v is number => isNum(v) && v >= min && v <= max;
const isInt = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const oneOf = <T extends string>(v: unknown, all: readonly T[]): v is T => typeof v === 'string' && (all as readonly string[]).includes(v);
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
const isRecordText = (v: unknown, max = DS_RECORD_MAX): v is string => typeof v === 'string' && [...v].length <= max;
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => own.includes(k));
};
const within = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).every((k) => keys.includes(k));
const isPair = (v: unknown, min: number, max: number): v is [number, number] => Array.isArray(v) && v.length === 2 && inRange(v[0], min, max) && inRange(v[1], min, max);
const isPoint = (v: unknown, bound: number): v is DsPoint =>
  isObj(v) && exactKeys(v, ['x', 'y', 'corner']) && inRange(v.x, -bound, bound) && inRange(v.y, -bound, bound) && oneOf(v.corner, DS_CORNERS);

function parseJson(text: unknown): unknown {
  if (typeof text !== 'string' || text === '') return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

/** A list of `min` to `max` lower case uuids, none twice; null otherwise. */
function uuidList(v: unknown, min: number, max: number): string[] | null {
  if (!Array.isArray(v) || v.length < min || v.length > max || !v.every(isUuid)) return null;
  return new Set(v).size === v.length ? [...(v as string[])] : null;
}

// ── the engine's records, read closed ──────────────────────────────────────────────────

/** One item of kicadDsEditItemsGet read closed: every key of its kind and no other (spec 7.2). Null for any other shape. */
export function readDsItem(v: unknown): DsItem | null {
  if (!isObj(v) || !oneOf(v.kind, DS_KINDS)) return null;
  const kind = v.kind;
  if (!exactKeys(v, [...COMMON_KEYS, ...KIND_KEYS[kind]])) return null;
  const big = Number.MAX_VALUE;
  if (!isUuid(v.uuid) || !isRecordText(v.name) || !isRecordText(v.comment) || !oneOf(v.pages, DS_PAGE_OPTIONS)) return null;
  if (!isPoint(v.start, big) || !isInt(v.repeat, 0, Number.MAX_SAFE_INTEGER) || !isPair(v.step, -big, big)) return null;
  const common = { kind, uuid: v.uuid, name: v.name, comment: v.comment, pages: v.pages, start: { ...v.start }, repeat: v.repeat, step: [v.step[0], v.step[1]] as [number, number] };
  switch (kind) {
    case 'line':
    case 'rect':
      if (!isPoint(v.end, big) || !isNum(v.lineWidth)) return null;
      return { ...common, kind, end: { ...v.end }, lineWidth: v.lineWidth };
    case 'text':
      if (!isRecordText(v.text, DS_BOUNDS.itemText) || !isInt(v.labelStep, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER) || !isRecordText(v.font)) return null;
      if (!isBool(v.bold) || !isBool(v.italic) || typeof v.color !== 'string' || !COLOR_RE.test(v.color)) return null;
      if (!oneOf(v.hJustify, DS_H_JUSTIFY) || !oneOf(v.vJustify, DS_V_JUSTIFY) || !isNum(v.rotation) || !isPair(v.size, -big, big)) return null;
      if (!isNum(v.maxLength) || !isNum(v.maxHeight) || !isNum(v.lineWidth)) return null;
      return {
        ...common, kind, text: v.text, labelStep: v.labelStep, font: v.font, bold: v.bold, italic: v.italic, color: v.color,
        hJustify: v.hJustify, vJustify: v.vJustify, rotation: v.rotation, size: [v.size[0], v.size[1]],
        maxLength: v.maxLength, maxHeight: v.maxHeight, lineWidth: v.lineWidth,
      };
    case 'polygon':
      if (!isNum(v.rotation) || !isNum(v.lineWidth) || !isInt(v.outlines, 0, Number.MAX_SAFE_INTEGER) || !isInt(v.points, 0, Number.MAX_SAFE_INTEGER)) return null;
      return { ...common, kind, rotation: v.rotation, lineWidth: v.lineWidth, outlines: v.outlines, points: v.points };
    case 'bitmap':
      if (!isInt(v.ppi, 0, Number.MAX_SAFE_INTEGER) || !isInt(v.width, 0, Number.MAX_SAFE_INTEGER) || !isInt(v.height, 0, Number.MAX_SAFE_INTEGER)) return null;
      return { ...common, kind, ppi: v.ppi, width: v.width, height: v.height };
  }
  return null;
}

/** kicadDsEditItemsGet's answer read closed: exactly `{ items }`, each item closed. Null for "" or any other shape. */
export function readDsItems(text: unknown): DsItem[] | null {
  const v = parseJson(text);
  if (!isObj(v) || !exactKeys(v, ['items']) || !Array.isArray(v.items)) return null;
  const out: DsItem[] = [];
  for (const raw of v.items) {
    const item = readDsItem(raw);
    if (item == null) return null;
    out.push(item);
  }
  return out;
}

/** kicadDsEditDefaultsGet's answer read closed (spec 7.3). Null for "" or any other shape. */
export function readDsDefaults(text: unknown): DsDefaults | null {
  const v = parseJson(text);
  if (!isObj(v) || !exactKeys(v, DEFAULTS_KEYS)) return null;
  if (!isNum(v.lineWidth) || !isPair(v.textSize, -Number.MAX_VALUE, Number.MAX_VALUE) || !isNum(v.textThickness)) return null;
  const m = v.margins;
  if (!isObj(m) || !exactKeys(m, MARGIN_KEYS) || !MARGIN_KEYS.every((k) => isNum(m[k]))) return null;
  return {
    lineWidth: v.lineWidth, textSize: [v.textSize[0], v.textSize[1]], textThickness: v.textThickness,
    margins: { left: m.left as number, right: m.right as number, top: m.top as number, bottom: m.bottom as number },
  };
}

/** kicadDsEditPreviewGet's answer read closed (spec 7.4): the page and the title block, nine comments. Null for "" or any other shape. */
export function readDsPreview(text: unknown): DsPreview | null {
  const v = parseJson(text);
  if (!isObj(v) || !exactKeys(v, PREVIEW_KEYS)) return null;
  if (!oneOf(v.paper, DS_PAPERS) || !isBool(v.portrait) || !isNum(v.width) || !isNum(v.height)) return null;
  if (!TITLE_KEYS.every((k) => isRecordText(v[k]))) return null;
  if (!Array.isArray(v.comments) || v.comments.length !== DS_BOUNDS.comments || !v.comments.every((c) => isRecordText(c))) return null;
  return {
    paper: v.paper, portrait: v.portrait, width: v.width, height: v.height,
    title: v.title as string, date: v.date as string, revision: v.revision as string, company: v.company as string, comments: [...v.comments] as string[],
  };
}

/** kicadDsEditAppend's answer read closed: `{ error, message, added }` (added only with no error). Null for "" or any other shape. */
export function readDsAppendAnswer(text: unknown): { error: '' | 'unreadable' | 'too_large'; message: string; added: string[] } | null {
  const v = parseJson(text);
  if (!isObj(v) || !within(v, ['error', 'message', 'added']) || !oneOf(v.error, ['', 'unreadable', 'too_large'] as const)) return null;
  if (v.message !== undefined && !isRecordText(v.message, DS_MESSAGE_MAX)) return null;
  const message = typeof v.message === 'string' ? v.message : '';
  if (v.error !== '') return v.added === undefined ? { error: v.error, message, added: [] } : null;
  const added = uuidList(v.added, 0, Number.MAX_SAFE_INTEGER);
  return added == null ? null : { error: '', message, added };
}

// ── args ───────────────────────────────────────────────────────────────────────────────

/** One key of a DsItemSet against the engine's bounds (the properties pane's). */
function setValueFits(key: string, v: unknown): boolean {
  const b = DS_BOUNDS;
  switch (key) {
    case 'name':
    case 'comment':
    case 'font': return isText(v, 0, DS_RECORD_MAX);
    case 'pages': return oneOf(v, DS_PAGE_OPTIONS);
    case 'start':
    case 'end': return isPoint(v, b.position);
    case 'repeat': return isInt(v, 1, b.repeat);
    case 'step': return isPair(v, -b.position, b.position);
    case 'lineWidth': return inRange(v, 0, b.lineWidth);
    case 'text': return isText(v, 0, b.itemText, true);
    case 'labelStep': return isInt(v, -b.labelStep, b.labelStep);
    case 'bold':
    case 'italic': return isBool(v);
    case 'color': return typeof v === 'string' && COLOR_RE.test(v);
    case 'hJustify': return oneOf(v, DS_H_JUSTIFY);
    case 'vJustify': return oneOf(v, DS_V_JUSTIFY);
    case 'rotation': return inRange(v, -b.rotation, b.rotation);
    case 'size': return isPair(v, 0, b.textSize);
    case 'maxLength':
    case 'maxHeight': return inRange(v, 0, b.position);
    case 'ppi': return isInt(v, 1, b.ppi);
    default: return false;
  }
}

/** A DsItemSet: a non empty object whose every key is one some kind may set, each value in its bounds. Null otherwise. */
export function parseDsItemSet(v: unknown): DsItemSet | null {
  if (!isObj(v) || Object.keys(v).length === 0) return null;
  for (const [k, value] of Object.entries(v)) if (!SET_ANY.includes(k) || !setValueFits(k, value)) return null;
  return { ...v };
}

/** Whether every key of a set is one `kind` may set. */
export const setFitsKind = (set: DsItemSet, kind: DsKind): boolean => Object.keys(set).every((k) => SET_KEYS[kind].includes(k));

/** dsedit.items.get's args: `{ uuids?: string[1..4096], kinds?: DsKind[1..5] }`, none twice. */
export function parseDsItemsGetArgs(args: unknown): { uuids?: string[]; kinds?: DsKind[] } | null {
  if (args === undefined) return {};
  if (!isObj(args) || !within(args, ['uuids', 'kinds'])) return null;
  const out: { uuids?: string[]; kinds?: DsKind[] } = {};
  if (args.uuids !== undefined) {
    const u = uuidList(args.uuids, 1, DS_BOUNDS.uuids);
    if (u == null) return null;
    out.uuids = u;
  }
  if (args.kinds !== undefined) {
    const k = args.kinds;
    if (!Array.isArray(k) || k.length < 1 || k.length > DS_BOUNDS.kinds || !k.every((x) => oneOf(x, DS_KINDS)) || new Set(k).size !== k.length) return null;
    out.kinds = [...k] as DsKind[];
  }
  return out;
}

/** dsedit.items.set's args: exactly `{ uuids: string[1..512], set: DsItemSet }`. */
export function parseDsItemsSetArgs(args: unknown): { uuids: string[]; set: DsItemSet } | null {
  if (!isObj(args) || !exactKeys(args, ['uuids', 'set'])) return null;
  const uuids = uuidList(args.uuids, 1, DS_BOUNDS.setUuids);
  const set = parseDsItemSet(args.set);
  return uuids == null || set == null ? null : { uuids, set };
}

/** Decoded bytes of a strict base64 string, or null. */
function base64Bytes(s: string): number | null {
  if (!BASE64_RE.test(s)) return null;
  return (s.length / 4) * 3 - (s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0);
}

/** Whether a strict base64 string holds a PNG of 8 bytes to 4 MiB (its signature read). */
export function isPngBase64(v: unknown): v is string {
  if (typeof v !== 'string' || v === '') return false;
  const n = base64Bytes(v);
  if (n == null || n < PNG_SIGNATURE.length || n > DS_BOUNDS.pngBytes) return false;
  let head: string;
  try { head = atob(v.slice(0, 12)); } catch { return false; }
  return PNG_SIGNATURE.every((byte, i) => head.charCodeAt(i) === byte);
}

/** Whether bytes start with PNG's signature. */
export const isPngBytes = (b: Uint8Array): boolean => b.byteLength >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, i) => b[i] === byte);

/**
 * One DsNewItem: a whole line or rect (10 keys), a whole text (21 keys), or a
 * bitmap's common keys, `ppi` and `png` (base64 of a PNG of at most 4 MiB);
 * `uuid` the page's own lower case uuid. A polygon is never added (KiCad has
 * no polygon tool; polygons arrive by dsedit.append). Null for anything else.
 */
export function parseDsNewItem(v: unknown): Record<string, unknown> | null {
  if (!isObj(v) || !oneOf(v.kind, DS_KINDS) || v.kind === 'polygon') return null;
  const kind = v.kind;
  const keys = kind === 'bitmap' ? [...COMMON_KEYS, 'ppi', 'png'] : [...COMMON_KEYS, ...KIND_KEYS[kind]];
  if (!exactKeys(v, keys) || !isUuid(v.uuid)) return null;
  if (kind === 'bitmap' && !isPngBase64(v.png)) return null;
  for (const k of keys) {
    if (k === 'kind' || k === 'uuid' || k === 'png') continue;
    if (!setValueFits(k, v[k])) return null;
  }
  return { ...v };
}

/** dsedit.items.add's args: exactly `{ items: DsNewItem[1..64] }`, no uuid twice. */
export function parseDsItemsAddArgs(args: unknown): { items: Record<string, unknown>[] } | null {
  if (!isObj(args) || !exactKeys(args, ['items']) || !Array.isArray(args.items)) return null;
  if (args.items.length < 1 || args.items.length > DS_BOUNDS.newItems) return null;
  const items: Record<string, unknown>[] = [];
  for (const raw of args.items) {
    const item = parseDsNewItem(raw);
    if (item == null) return null;
    items.push(item);
  }
  return new Set(items.map((i) => i.uuid)).size === items.length ? { items } : null;
}

/** dsedit.items.remove's args: exactly `{ uuids: string[1..4096] }`, none twice. */
export function parseDsItemsRemoveArgs(args: unknown): { uuids: string[] } | null {
  if (!isObj(args) || !exactKeys(args, ['uuids'])) return null;
  const uuids = uuidList(args.uuids, 1, DS_BOUNDS.uuids);
  return uuids == null ? null : { uuids };
}

/** dsedit.defaults.set's args: exactly `{ set }`, a non empty partial of DsDefaults, the margins whole when given. */
export function parseDsDefaultsSetArgs(args: unknown): { set: Partial<DsDefaults> } | null {
  if (!isObj(args) || !exactKeys(args, ['set'])) return null;
  const s = args.set;
  if (!isObj(s) || Object.keys(s).length === 0 || !within(s, DEFAULTS_KEYS)) return null;
  const b = DS_BOUNDS;
  if (s.lineWidth !== undefined && !inRange(s.lineWidth, 0, b.lineWidth)) return null;
  if (s.textSize !== undefined && !isPair(s.textSize, b.textSizeMin, b.textSize)) return null;
  if (s.textThickness !== undefined && !inRange(s.textThickness, 0, b.textThickness)) return null;
  if (s.margins !== undefined) {
    const m = s.margins;
    if (!isObj(m) || !exactKeys(m, MARGIN_KEYS) || !MARGIN_KEYS.every((k) => inRange(m[k], 0, b.margin))) return null;
  }
  return { set: JSON.parse(JSON.stringify(s)) as Partial<DsDefaults> };
}

/**
 * dsedit.preview.set's args: exactly `{ set }`, a non empty partial of
 * DsPreview: `paper` one of KiCad's names, `width` and `height` together
 * (25.4 to 3,048 mm), `portrait` a boolean, the title block's four texts and
 * exactly nine comments, each 0 to 1,024 characters with no control
 * character. Whether the sizes or the orientation fit the paper is read
 * against the page the editor holds (dsPreviewSet).
 */
export function parseDsPreviewSetArgs(args: unknown): { set: Partial<DsPreview> } | null {
  if (!isObj(args) || !exactKeys(args, ['set'])) return null;
  const s = args.set;
  if (!isObj(s) || Object.keys(s).length === 0 || !within(s, PREVIEW_KEYS)) return null;
  if (s.paper !== undefined && !oneOf(s.paper, DS_PAPERS)) return null;
  if (s.portrait !== undefined && !isBool(s.portrait)) return null;
  if ((s.width === undefined) !== (s.height === undefined)) return null;
  if (s.width !== undefined && (!inRange(s.width, DS_BOUNDS.pageMin, DS_BOUNDS.pageMax) || !inRange(s.height, DS_BOUNDS.pageMin, DS_BOUNDS.pageMax))) return null;
  for (const k of TITLE_KEYS) if (s[k] !== undefined && !isText(s[k], 0, DS_RECORD_MAX)) return null;
  if (s.comments !== undefined && (!Array.isArray(s.comments) || s.comments.length !== DS_BOUNDS.comments || !s.comments.every((c) => isText(c, 0, DS_RECORD_MAX)))) return null;
  return { set: JSON.parse(JSON.stringify(s)) as Partial<DsPreview> };
}

/** dsedit.append's args: exactly `{ text }`, a document of any length (past 8 MiB the op answers too_large). */
export function parseDsAppendArgs(args: unknown): { text: string } | null {
  if (!isObj(args) || !exactKeys(args, ['text']) || typeof args.text !== 'string' || args.text === '' || UNSPELLABLE_RE.test(args.text)) return null;
  return { text: args.text };
}

/**
 * dsedit.image.arm's args: exactly `{ bytes, name }`, `bytes` a Uint8Array
 * holding a PNG (its signature read; any length here, past 4 MiB the op
 * answers too_large) or empty to disarm, `name` the picture's file name, 0 to
 * 1,024 characters with no control character.
 */
export function parseDsImageArmArgs(args: unknown): { bytes: Uint8Array; name: string } | null {
  if (!isObj(args) || !exactKeys(args, ['bytes', 'name']) || !(args.bytes instanceof Uint8Array) || !isText(args.name, 0, DS_RECORD_MAX)) return null;
  if (args.bytes.byteLength > 0 && !isPngBytes(args.bytes)) return null;
  return { bytes: args.bytes, name: args.name };
}

/** Base64 of bytes (chunked: a 4 MiB picture never builds one huge argument list). */
export function toBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.byteLength; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

// ── what a read back must show ─────────────────────────────────────────────────────────

/** Two numbers as the engine keeps them (doubles in millimeters, degrees): equal within a part in a million. */
const near = (a: number, b: number, tol = 1e-6): boolean => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
function same(key: string, want: unknown, got: unknown): boolean {
  if (key === 'ppi') return isNum(want) && isNum(got) && Math.abs(want - got) <= 1;   // KiCad keeps a scale and answers the ppi truncated
  if (isNum(want)) return isNum(got) && near(want, got);
  if (Array.isArray(want)) return Array.isArray(got) && got.length === want.length && want.every((w, i) => same(key, w, got[i]));
  if (isObj(want)) return isObj(got) && Object.keys(want).every((k) => same(k, want[k], got[k]));
  return want === got;
}

/**
 * Whether an item shows every key of a set. A font named by its face is
 * resolved by KiCad's font lookup (a face the engine lacks becomes its own
 * fallback), so only KiCad's own font ("") is compared.
 */
export function itemShows(item: DsItem, set: DsItemSet): boolean {
  const rec = item as unknown as Record<string, unknown>;
  return Object.entries(set).every(([k, v]) => (k === 'font' ? v !== '' || rec.font === '' : same(k, v, rec[k])));
}

/** Whether the defaults show every key of a set. */
export const defaultsShow = (d: DsDefaults, set: Partial<DsDefaults>): boolean =>
  Object.entries(set).every(([k, v]) => same(k, v, (d as unknown as Record<string, unknown>)[k]));

/** Whether the preview shows every key of a set (a page size within 0.05 mm: KiCad keeps it in mils). */
export const previewShows = (p: DsPreview, set: Partial<DsPreview>): boolean =>
  Object.entries(set).every(([k, v]) => {
    const got = (p as unknown as Record<string, unknown>)[k];
    return k === 'width' || k === 'height' ? isNum(v) && isNum(got) && Math.abs(v - got) <= 0.05 : same(k, v, got);
  });

// ── the ops ────────────────────────────────────────────────────────────────────────────

type Gate = { mod: Record<string, unknown>; state: DsEditState };
const gated = (g: Answer | Gate): g is Answer => 'ok' in g;
/** How long a queued change may take to show (the bridge's symedit wait, about 5 s). */
const changeMs = (ctx: ResponderCtx): number => ctx.timing.symeditMs ?? 5_000;
const itemsShape = (op: string): Answer => fail('island_error', `${op}: the engine answered items of another shape`);
const itemsAnswer = (items: DsItem[]): Answer => ok({ items: items as unknown as Record<string, unknown>[] });
/** The items of `uuids` the sheet holds now, in the sheet's order; null for an answer of another shape. */
const itemsOf = (mod: Record<string, unknown>, uuids: string[]): DsItem[] | null =>
  readDsItems(callDsText(mod, 'kicadDsEditItemsGet', JSON.stringify({ uuids })));

/** dsedit.items.get: the open sheet's items in KiCad's draw order, those of `uuids` and `kinds` when given (an id the sheet does not hold is left out). */
export function dsItemsGet(args: unknown, ctx: ResponderCtx): Answer {
  const op = 'dsedit.items.get';
  const a = parseDsItemsGetArgs(args);
  if (a == null) return fail('bad_args', op);
  const g = dsGate(ctx, op, true);
  if (gated(g)) return g;
  const items = readDsItems(callDsText(g.mod, 'kicadDsEditItemsGet', JSON.stringify(a)));
  return items == null ? itemsShape(op) : itemsAnswer(items);
}

/**
 * dsedit.items.set: one set on every item of `uuids`, ONE undo step. Every
 * uuid must be one the sheet holds and every key one each item's kind has
 * (bad_args naming the first that is not); the answer is the items read back
 * once each shows every key, else not_applied.
 */
export async function dsItemsSet(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const op = 'dsedit.items.set';
  const a = parseDsItemsSetArgs(args);
  if (a == null) return fail('bad_args', op);
  const g = dsGate(ctx, op, true);
  if (gated(g)) return g;
  const { mod } = g;
  const before = itemsOf(mod, a.uuids);
  if (before == null) return itemsShape(op);
  const missing = a.uuids.find((u) => !before.some((i) => i.uuid === u));
  if (missing != null) return fail('bad_args', `${op}: ${missing} is not on the sheet`);
  const misfit = before.find((i) => !setFitsKind(a.set, i.kind));
  if (misfit != null) return fail('bad_args', `${op}: a ${misfit.kind} has no ${Object.keys(a.set).find((k) => !SET_KEYS[misfit.kind].includes(k))}`);
  if (!callDsBool(mod, 'kicadDsEditItemsSet', JSON.stringify({ uuids: a.uuids, set: a.set }))) return fail('not_applied', op);
  const after = await dsReadBack(ctx, changeMs(ctx), () => {
    const now = itemsOf(mod, a.uuids);
    return now != null && now.length === a.uuids.length && now.every((i) => itemShows(i, a.set)) ? now : null;
  });
  return after == null ? fail('not_applied', op) : itemsAnswer(after);
}

/**
 * dsedit.items.add: whole new items, each with the page's own uuid, ONE undo
 * step. A uuid the sheet holds already is refused (bad_args); the answer is
 * the new items read back once the sheet holds every one, else not_applied.
 */
export async function dsItemsAdd(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const op = 'dsedit.items.add';
  const a = parseDsItemsAddArgs(args);
  if (a == null) return fail('bad_args', op);
  const g = dsGate(ctx, op, true);
  if (gated(g)) return g;
  const { mod } = g;
  const uuids = a.items.map((i) => i.uuid as string);
  const taken = itemsOf(mod, uuids);
  if (taken == null) return itemsShape(op);
  if (taken.length > 0) return fail('bad_args', `${op}: ${taken[0].uuid} is on the sheet already`);
  if (!callDsBool(mod, 'kicadDsEditItemsAdd', JSON.stringify({ items: a.items }))) return fail('not_applied', op);
  const after = await dsReadBack(ctx, changeMs(ctx), () => {
    const now = itemsOf(mod, uuids);
    return now != null && now.length === uuids.length ? now : null;
  });
  return after == null ? fail('not_applied', op) : itemsAnswer(after);
}

/**
 * dsedit.items.remove: the items of `uuids` taken off the sheet, ONE undo
 * step (KiCad's own delete). Every uuid must be one the sheet holds (bad_args
 * naming the first that is not); the answer is `{ removed }` once the sheet
 * holds none of them, else not_applied (an item KiCad is placing is never
 * removed).
 */
export async function dsItemsRemove(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const op = 'dsedit.items.remove';
  const a = parseDsItemsRemoveArgs(args);
  if (a == null) return fail('bad_args', op);
  const g = dsGate(ctx, op, true);
  if (gated(g)) return g;
  const { mod } = g;
  const held = itemsOf(mod, a.uuids);
  if (held == null) return itemsShape(op);
  const missing = a.uuids.find((u) => !held.some((i) => i.uuid === u));
  if (missing != null) return fail('bad_args', `${op}: ${missing} is not on the sheet`);
  if (!callDsBool(mod, 'kicadDsEditItemsRemove', JSON.stringify({ uuids: a.uuids }))) return fail('not_applied', op);
  const gone = await dsReadBack(ctx, changeMs(ctx), () => {
    const now = itemsOf(mod, a.uuids);
    return now != null && now.length === 0 ? true : null;
  });
  return gone == null ? fail('not_applied', op) : ok({ removed: a.uuids });
}

const readDefaultsNow = (mod: Record<string, unknown>): DsDefaults | null => readDsDefaults(callDsText(mod, 'kicadDsEditDefaultsGet'));
const readPreviewNow = (mod: Record<string, unknown>): DsPreview | null => readDsPreview(callDsText(mod, 'kicadDsEditPreviewGet'));
const recordAnswer = (r: DsDefaults | DsPreview): Answer => ok(r as unknown as Record<string, unknown>);

/** dsedit.defaults.get: the sheet's defaults (spec 7.3). */
export function dsDefaultsGet(args: unknown, ctx: ResponderCtx): Answer {
  const op = 'dsedit.defaults.get';
  if (!noArgs(args)) return fail('bad_args', op);
  const g = dsGate(ctx, op, true);
  if (gated(g)) return g;
  const d = readDefaultsNow(g.mod);
  return d == null ? fail('island_error', `${op}: the engine answered defaults of another shape`) : recordAnswer(d);
}

/** dsedit.defaults.set: a partial of the defaults, ONE undo step; the answer is the defaults read back once they show it, else not_applied. */
export async function dsDefaultsSet(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const op = 'dsedit.defaults.set';
  const a = parseDsDefaultsSetArgs(args);
  if (a == null) return fail('bad_args', op);
  const g = dsGate(ctx, op, true);
  if (gated(g)) return g;
  const { mod } = g;
  if (!callDsBool(mod, 'kicadDsEditDefaultsSet', JSON.stringify(a))) return fail('not_applied', op);
  const after = await dsReadBack(ctx, changeMs(ctx), () => {
    const now = readDefaultsNow(mod);
    return now != null && defaultsShow(now, a.set) ? now : null;
  });
  return after == null ? fail('not_applied', op) : recordAnswer(after);
}

/** dsedit.preview.get: the page and title block the sheet is previewed on (spec 7.4). */
export function dsPreviewGet(args: unknown, ctx: ResponderCtx): Answer {
  const op = 'dsedit.preview.get';
  if (!noArgs(args)) return fail('bad_args', op);
  const g = dsGate(ctx, op, true);
  if (gated(g)) return g;
  const p = readPreviewNow(g.mod);
  return p == null ? fail('island_error', `${op}: the engine answered a preview of another shape`) : recordAnswer(p);
}

/**
 * dsedit.preview.set: a partial of the preview, ONE undo step (KiCad's page
 * settings with no dialog). Sizes only for a User paper, the orientation only
 * for the others (the paper the set names, else the one the editor holds:
 * bad_args otherwise); the answer is the preview read back once it shows the
 * set, else not_applied.
 */
export async function dsPreviewSet(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const op = 'dsedit.preview.set';
  const a = parseDsPreviewSetArgs(args);
  if (a == null) return fail('bad_args', op);
  const g = dsGate(ctx, op, true);
  if (gated(g)) return g;
  const { mod } = g;
  const now = readPreviewNow(mod);
  if (now == null) return fail('island_error', `${op}: the engine answered a preview of another shape`);
  const user = (a.set.paper ?? now.paper) === 'User';
  if (a.set.width !== undefined && !user) return fail('bad_args', `${op}: a size is set only on a User paper`);
  if (a.set.portrait !== undefined && user) return fail('bad_args', `${op}: a User paper takes its orientation from its size`);
  if (!callDsBool(mod, 'kicadDsEditPreviewSet', JSON.stringify(a))) return fail('not_applied', op);
  const after = await dsReadBack(ctx, changeMs(ctx), () => {
    const p = readPreviewNow(mod);
    return p != null && previewShows(p, a.set) ? p : null;
  });
  return after == null ? fail('not_applied', op) : recordAnswer(after);
}

/**
 * dsedit.append: another sheet's items added to the open one, ONE undo step
 * (KiCad's Append Existing Drawing Sheet, from text). KiCad's own parser reads
 * the text first: unreadable with KiCad's line and nothing changed. Past 8 MiB:
 * too_large. The answer is `{ added }`, the new items' uuids, once the sheet
 * holds every one, else not_applied.
 */
export async function dsAppend(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const op = 'dsedit.append';
  const a = parseDsAppendArgs(args);
  if (a == null) return fail('bad_args', op);
  const g = dsGate(ctx, op, true);
  if (gated(g)) return g;
  const { mod } = g;
  if (utf8Bytes(a.text) > DS_TEXT_MAX_BYTES) return fail('too_large', op);
  const said = readDsAppendAnswer(callDsText(mod, 'kicadDsEditAppend', JSON.stringify(a)));
  if (said == null) return fail('island_error', `${op}: the engine answered an append of another shape`);
  if (said.error === 'unreadable') return fail('unreadable', said.message !== '' ? said.message : op);
  if (said.error !== '') return fail(said.error, op);
  const added = said.added;
  const shown = await dsReadBack(ctx, changeMs(ctx), () => {
    if (added.length === 0) return true;
    const now = itemsOf(mod, added);
    return now != null && now.length === added.length ? true : null;
  });
  return shown == null ? fail('not_applied', op) : ok({ added });
}

/**
 * dsedit.image.arm: a PNG held for KiCad's next Place Bitmaps press, which
 * places it in place of KiCad's file dialog (empty bytes disarm). Past 4 MiB:
 * too_large. KiCad's own picture reader must take it (not_applied otherwise).
 */
export function dsImageArm(args: unknown, ctx: ResponderCtx): Answer {
  const op = 'dsedit.image.arm';
  const a = parseDsImageArmArgs(args);
  if (a == null) return fail('bad_args', op);
  const g = dsGate(ctx, op, true);
  if (gated(g)) return g;
  if (a.bytes.byteLength > DS_BOUNDS.pngBytes) return fail('too_large', op);
  const png = a.bytes.byteLength === 0 ? '' : toBase64(a.bytes);
  return callDsBool(g.mod, 'kicadDsEditArmImage', JSON.stringify({ png, name: a.name })) ? ok() : fail('not_applied', op);
}

// ── the picture ask (ev.dsedit) ────────────────────────────────────────────────────────

/** The window slot the drawing sheet editor calls (CcAskHostDsEdit). */
export type DsEditAskWindow = { kicadHostDsEdit?: { onRequest?: (json: unknown) => boolean } };
/** The frame's request is at most this long. */
const MAX_DSEDIT_REQUEST = 1024;

/** The frame's request read closed: a JSON string of exactly `{ ask: "image", uuid: "", isNew: true }`. Null for any other shape. */
export function readDsEditAsk(json: unknown): DsEditAsk | null {
  if (typeof json !== 'string' || json.length > MAX_DSEDIT_REQUEST) return null;
  const v = parseJson(json);
  if (!isObj(v) || !exactKeys(v, DSEDIT_EVENT_KEYS)) return null;
  if (v.ask !== 'image' || v.uuid !== '' || v.isNew !== true) return null;
  return { ask: 'image', uuid: '', isNew: true };
}

/**
 * Takes the drawing sheet editor's slot (ev.dsedit): KiCad's Place Bitmaps
 * with nothing armed asks the page for a picture and places nothing, with no
 * dialog. Each request the gate admits (after ev.ready, a sheet open) is handed
 * to `send` once and answered true; anything else, or a throwing `send`,
 * answers false (the frame still opens no window). The stop clears the slot
 * when it is still this one.
 */
export function installDsEditAsk(w: DsEditAskWindow, opts: { admit: () => boolean; send: (a: DsEditAsk) => void }): () => void {
  const slot = {
    onRequest: (json: unknown): boolean => {
      try {
        if (!opts.admit()) return false;
        const a = readDsEditAsk(json);
        if (a == null) return false;
        opts.send(a);
        return true;
      } catch {
        return false;
      }
    },
  };
  w.kicadHostDsEdit = slot;
  return () => { if (w.kicadHostDsEdit === slot) delete w.kicadHostDsEdit; };
}
