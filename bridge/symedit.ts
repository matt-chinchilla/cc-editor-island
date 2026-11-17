// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The symedit.* ops (PROTOCOL.md "The symbol editor"): KiCad's own symbol
// editor (SYMBOL_EDIT_FRAME, booted with ?frame=symedit) driven with no KiCad
// window, through our engine's symedit exports (pcbjam cc/main
// wasm/bindings/symedit_embind.cpp; engine run 14). A symbol is opened from
// its text with no library row (the engine's host mode), every change is ONE
// commit on the editor's apply coroutine (one undo step), and the page takes
// the symbol back as text and writes the design's file itself: KiCad's own
// library save is never used.
//
// This module holds the closed parsers of the ops' args (each refuses any
// other key, type or bound before anything reaches the engine), the closed
// readers of the engine's answers (any other shape is an island_error), and
// the read back checks. The responder holds the gates and the waits.
import { UUID_RE } from './symbol';

/** The engine exports the symedit ops need, the apply queue probe last. */
export const SYMEDIT_EXPORTS = [
  'kicadSymEditOpen', 'kicadSymEditNew', 'kicadSymEditState', 'kicadSymEditTake', 'kicadSymEditMarkSaved',
  'kicadSymEditItemsGet', 'kicadSymEditItemsSet', 'kicadSymEditItemsAdd', 'kicadSymEditItemsRemove',
  'kicadSymEditSymbolGet', 'kicadSymEditSymbolSet', 'kicadSymEditShow', 'kicadSymEditSelection',
  'kicadSymEditSelect', 'kicadSymEditCheck', 'kicadSymEditPlotSvg', 'kicadCollabBusy',
] as const;
/** The pseudo-cap a symedit frame lists when the engine has every export above. */
export const SYMEDIT_CAP = 'symedit';
/** The marker export of an engine whose symbol editor asks the page before its dialogs (kicad cc/main K3). */
export const SYMEDIT_ASK_EXPORT = 'kicadHostSymEdit';
/** The pseudo-cap a symedit frame lists when the engine has the marker: ev.symedit is sent. */
export const SYMEDIT_HELD_CAP = 'symeditHeld';

/** A symbol document is at most this many bytes of UTF-8 (the engine's DOC_MAX_BYTES, 4 MiB). */
export const DOC_MAX_BYTES = 4 * 1024 * 1024;
/** A string of a record or an arg is at most this many characters, unless named. */
export const TEXT_MAX = 1024;
/** Positions are at most this many millimeters from the symbol's origin; sizes at most SIZE_MAX_MM. */
export const POSITION_MAX_MM = 50_000;
export const SIZE_MAX_MM = 1000;
/** A stroke is at most this wide, in millimeters (the engine's bound). */
export const STROKE_MAX_MM = 100;
/** KiCad letters units A to ZZ. */
export const UNITS_MAX = 702;
/** At most this many body styles named. */
export const BODY_STYLES_MAX = 64;
/** At most this many uuids in one request, new items in one add, points in one shape, alternates on one pin. */
export const UUIDS_MAX = 4096;
export const NEW_ITEMS_MAX = 512;
export const POINTS_MAX = 4096;
export const ALTERNATES_MAX = 64;
/** At most this many fields, filters, jumper groups (and pins in each) in one symbol. */
export const LIST_MAX = 256;
/** The pin name offset is 0 to this many millimeters. */
export const PIN_NAME_OFFSET_MAX = 50;
/** A page token: 1 to 64 printable ASCII characters (the island makes one per open). */
const TOKEN_RE = /^[\x20-\x7e]{1,64}$/;
/** The run folder of symedit.svg, and the plot's own record (written last). */
export const SVG_ROOT = '/tmp/cc-svg';
export const SVG_FILE = 'symbol.svg';
export const SVG_DONE = '.cc-svg.json';
/** symedit.svg answers at most this many bytes. */
export const SVG_MAX_BYTES = 4 * 1024 * 1024;
/** KiCad's rounding when it reads a length back (4 decimals, the engine's mmOf), with room for the float. */
const LENGTH_SLACK = 0.0001 + 1e-9;

export const ITEM_KINDS = ['pin', 'field', 'text', 'textbox', 'shape'] as const;
export type ItemKind = typeof ITEM_KINDS[number];
export const PIN_TYPES = ['input', 'output', 'bidirectional', 'tri_state', 'passive', 'free', 'unspecified',
  'power_in', 'power_out', 'open_collector', 'open_emitter', 'no_connect'] as const;
export type PinType = typeof PIN_TYPES[number];
export const PIN_SHAPES = ['line', 'inverted', 'clock', 'inverted_clock', 'input_low', 'clock_low', 'output_low',
  'edge_clock_high', 'non_logic'] as const;
export type PinShape = typeof PIN_SHAPES[number];
export const ORIENTATIONS = ['right', 'left', 'up', 'down'] as const;
export type Orientation = typeof ORIENTATIONS[number];
export const H_JUSTIFY = ['left', 'center', 'right'] as const;
export const V_JUSTIFY = ['top', 'center', 'bottom'] as const;
export const SHAPES = ['rectangle', 'circle', 'arc', 'polyline', 'bezier'] as const;
export type ShapeName = typeof SHAPES[number];
export const LINE_STYLES = ['default', 'solid', 'dash', 'dot', 'dash_dot', 'dash_dot_dot'] as const;
/** The record's four fills, then the hatches KiCad 10 also stores (the engine reads and writes them by these names). */
export const FILL_TYPES = ['none', 'outline', 'background', 'color', 'hatch', 'reverse_hatch', 'cross_hatch'] as const;
export const MODES = ['library', 'placed', 'new'] as const;
export const BODY_MODES = ['one', 'demorgan', 'named'] as const;
export const POWERS = ['none', 'global', 'local'] as const;
export const FIELD_KINDS = ['reference', 'value', 'footprint', 'datasheet', 'description', 'user'] as const;
/** The checker's codes (kicad cc/main K2, symbol_checker.cpp); `other` for a code a later engine adds. */
export const FINDING_CODES = ['empty_reference', 'reference_prefix_digit', 'duplicate_pin', 'power_units', 'power_pins',
  'power_pin_type', 'power_pin_hidden', 'hidden_power_pin', 'off_grid_pin', 'circle_zero_radius', 'rectangle_zero_size', 'other'] as const;
export type FindingCode = typeof FINDING_CODES[number];

export interface Stroke { width: number; style: typeof LINE_STYLES[number]; color: string }
export interface Fill { type: typeof FILL_TYPES[number]; color: string }
export interface BodyStyles { mode: typeof BODY_MODES[number]; names: string[] }
export interface SymEditState {
  token: string; open: boolean; name: string; lib: string; mode: typeof MODES[number];
  modified: boolean; depth: number; unit: number; unitCount: number; bodyStyle: number;
  bodyStyles: BodyStyles; parent: string; syncedPins: boolean;
}
interface ItemBase { uuid: string; unit: number; bodyStyle: number }
export interface Alternate { name: string; type: PinType; shape: PinShape }
export interface Pin extends ItemBase {
  kind: 'pin'; number: string; name: string; type: PinType; shape: PinShape; x: number; y: number;
  orientation: Orientation; length: number; nameSize: number; numberSize: number; visible: boolean; alternates: Alternate[];
}
interface TextKeys {
  text: string; x: number; y: number; angle: 0 | 90; size: number; bold: boolean; italic: boolean;
  hJustify: typeof H_JUSTIFY[number]; vJustify: typeof V_JUSTIFY[number]; visible: boolean;
}
export interface Text extends ItemBase, TextKeys { kind: 'text' | 'field'; name: string; showName: boolean }
export interface TextBox extends ItemBase, TextKeys { kind: 'textbox'; x2: number; y2: number; stroke: Stroke; fill: Fill; margins: [number, number, number, number] }
export interface Shape extends ItemBase { kind: 'shape'; shape: ShapeName; points: Array<[number, number]>; stroke: Stroke; fill: Fill }
export type SymItem = Pin | Text | TextBox | Shape;
export interface SymbolField { name: string; value: string; visible: boolean; kind: typeof FIELD_KINDS[number] }
export interface SymbolProps {
  name: string; refPrefix: string; value: string; footprint: string; datasheet: string; description: string;
  keywords: string; fpFilters: string[]; fields: SymbolField[];
  unitCount: number; unitsInterchangeable: boolean; unitNames: Record<string, string>;
  bodyStyles: BodyStyles; power: typeof POWERS[number]; pinNameOffset: number;
  showPinNames: boolean; showPinNumbers: boolean; pinNamesInside: boolean;
  inBom: boolean; onBoard: boolean; inSim: boolean; inPosFiles: boolean;
  jumpers: { duplicateNumbersAreJumpers: boolean; groups: string[][] };
  parent: string;
}
export interface SymFinding {
  code: FindingCode; severity: 'warning' | 'info'; pins: string[]; unit: number; bodyStyle: number;
  x: number | null; y: number | null; uuids: string[];
}
export interface Taken { name: string; text: string; parent: string }

export interface OpenArgs { text: string; name: string; lib: string; mode: 'library' | 'placed'; unit: number; bodyStyle: number; discard: boolean }
export interface NewArgs {
  name: string; lib: string; parentText: string; parent: string; refPrefix: string; unitCount: number;
  unitsInterchangeable: boolean; bodyStyles: 'one' | 'demorgan'; power: typeof POWERS[number]; pinNameOffset: number;
  showPinNames: boolean; showPinNumbers: boolean; pinNamesInside: boolean; inBom: boolean; onBoard: boolean; inSim: boolean;
  keepParentFields: boolean; discard: boolean;
}
export interface ItemsGetArgs { uuids?: string[]; kinds?: ItemKind[]; unit: number; bodyStyle: number }
export type ItemSet = Record<string, unknown>;
export interface ItemsSetArgs { uuids: string[]; set: ItemSet }
export interface ItemsAddArgs { items: Array<Record<string, unknown> & { kind: ItemKind; uuid: string }> }
export interface ShowArgs { unit: number; bodyStyle: number }
export type SymbolSet = Record<string, unknown>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const has = (o: Record<string, unknown>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => has(o, k));
};
const within = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).every((k) => keys.includes(k));
const oneOf = <T extends string>(v: unknown, all: readonly T[]): v is T => typeof v === 'string' && (all as readonly string[]).includes(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isInt = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const inRange = (v: unknown, min: number, max: number): v is number => isNum(v) && v >= min && v <= max;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
// A NUL, or a lone surrogate (no UTF-8 spelling: the engine's UTF-8 read refuses it).
const UNSPELLABLE_RE = /\0|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
// Any control character; a text's line break is the one let through where `lines` allows it.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_BUT_LF_RE = /[\u0000-\u0009\u000b-\u001f\u007f]/;
const COLOR_RE = /^(?:#[0-9a-f]{8})?$/;

/** Text of `min` to `max` characters (code points, as the engine counts) with a UTF-8 spelling and no control character (a line break only with `lines`). */
export function isText(v: unknown, min = 0, max = TEXT_MAX, lines = false): v is string {
  if (typeof v !== 'string' || UNSPELLABLE_RE.test(v) || (lines ? CONTROL_BUT_LF_RE : CONTROL_RE).test(v)) return false;
  const n = [...v].length;
  return n >= min && n <= max;
}
/** A record's string: at most `max` characters, any character the engine wrote. */
const isRecordText = (v: unknown, max = TEXT_MAX): v is string => typeof v === 'string' && [...v].length <= max;
const utf8Bytes = (s: string): number => new TextEncoder().encode(s).byteLength;
/** A symbol document: a string of 1 byte to DOC_MAX_BYTES of UTF-8. */
const isDocument = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= DOC_MAX_BYTES && !UNSPELLABLE_RE.test(v) && utf8Bytes(v) <= DOC_MAX_BYTES;
export const isToken = (v: unknown): v is string => typeof v === 'string' && TOKEN_RE.test(v);
/** A list of `min` to `max` lower case uuids, none twice. */
function uuidList(v: unknown, min: number, max: number): string[] | null {
  if (!Array.isArray(v) || v.length < min || v.length > max || !v.every(isUuid)) return null;
  return new Set(v).size === v.length ? [...(v as string[])] : null;
}

// ── args ───────────────────────────────────────────────────────────────────────────────

const OPEN_KEYS = ['text', 'name', 'lib', 'mode', 'unit', 'bodyStyle', 'discard'] as const;

/**
 * symedit.open's args: `{ text, name, lib, mode, unit?, bodyStyle?, discard }`.
 * `text` a symbol document of at most 4 MiB holding `name` (the engine reads
 * it), `name` and `lib` 1 to 1,024 characters with no control character (the
 * nickname the symbol opens under, never a row of the engine's table), `mode`
 * `library` or `placed`, `unit` 1 to 702 and `bodyStyle` 1 to 64 (1 when
 * absent; the engine clamps them to the symbol's), `discard` a boolean. Null
 * for anything else.
 */
export function parseOpenArgs(args: unknown): OpenArgs | null {
  if (!isObj(args) || !within(args, OPEN_KEYS)) return null;
  if (!['text', 'name', 'lib', 'mode', 'discard'].every((k) => has(args, k))) return null;
  const { text, name, lib, mode, discard } = args;
  const unit = args.unit ?? 1;
  const bodyStyle = args.bodyStyle ?? 1;
  if (!isDocument(text) || !isText(name, 1) || !isText(lib, 1) || (mode !== 'library' && mode !== 'placed') || !isBool(discard)) return null;
  if (!isInt(unit, 1, UNITS_MAX) || !isInt(bodyStyle, 1, BODY_STYLES_MAX)) return null;
  return { text, name, lib, mode, unit, bodyStyle, discard };
}

const NEW_KEYS = ['name', 'lib', 'parentText', 'parent', 'refPrefix', 'unitCount', 'unitsInterchangeable', 'bodyStyles', 'power',
  'pinNameOffset', 'showPinNames', 'showPinNumbers', 'pinNamesInside', 'inBom', 'onBoard', 'inSim', 'keepParentFields', 'discard'] as const;
const NEW_BOOLS = ['unitsInterchangeable', 'showPinNames', 'showPinNumbers', 'pinNamesInside', 'inBom', 'onBoard', 'inSim', 'keepParentFields', 'discard'] as const;

/**
 * symedit.new's args, exactly its eighteen keys (the New Symbol dialog's
 * fields): `parent` is `""` with `parentText` `""`, or a name inside
 * `parentText`, a symbol document, which is then required. Null for anything else.
 */
export function parseNewArgs(args: unknown): NewArgs | null {
  if (!isObj(args) || !exactKeys(args, NEW_KEYS)) return null;
  const a = args;
  if (!isText(a.name, 1) || !isText(a.lib, 1) || !isText(a.parent) || !isText(a.refPrefix)) return null;
  if (typeof a.parentText !== 'string' || (a.parentText === '') !== (a.parent === '') || (a.parentText !== '' && !isDocument(a.parentText))) return null;
  if (!isInt(a.unitCount, 1, UNITS_MAX) || (a.bodyStyles !== 'one' && a.bodyStyles !== 'demorgan') || !oneOf(a.power, POWERS)) return null;
  if (!inRange(a.pinNameOffset, 0, PIN_NAME_OFFSET_MAX) || !NEW_BOOLS.every((k) => isBool(a[k]))) return null;
  return { ...(a as unknown as NewArgs) };
}

/** symedit.markSaved's args: exactly `{ token }`, the token the state carries. */
export function parseMarkSavedArgs(args: unknown): { token: string } | null {
  if (!isObj(args) || !exactKeys(args, ['token']) || !isToken(args.token)) return null;
  return { token: args.token };
}

/**
 * symedit.items.get's args: `{ uuids?, kinds?, unit, bodyStyle }`: 1 to 4,096
 * uuids, none twice; 1 to 5 kinds, none twice; `unit` and `bodyStyle` whole
 * numbers of at least 0 (0 = every unit, every body style). Null for anything else.
 */
export function parseItemsGetArgs(args: unknown): ItemsGetArgs | null {
  if (!isObj(args) || !within(args, ['uuids', 'kinds', 'unit', 'bodyStyle']) || !has(args, 'unit') || !has(args, 'bodyStyle')) return null;
  if (!isInt(args.unit, 0, UNITS_MAX) || !isInt(args.bodyStyle, 0, BODY_STYLES_MAX)) return null;
  const out: ItemsGetArgs = { unit: args.unit, bodyStyle: args.bodyStyle };
  if (has(args, 'uuids')) {
    const uuids = uuidList(args.uuids, 1, UUIDS_MAX);
    if (uuids == null) return null;
    out.uuids = uuids;
  }
  if (has(args, 'kinds')) {
    const k = args.kinds;
    if (!Array.isArray(k) || k.length < 1 || k.length > ITEM_KINDS.length || !k.every((x) => oneOf(x, ITEM_KINDS)) || new Set(k).size !== k.length) return null;
    out.kinds = [...k] as ItemKind[];
  }
  return out;
}

/** The keys a set may carry for each kind (never `kind` or `uuid`), as the engine's editableKeys. */
export const EDITABLE_KEYS: Readonly<Record<ItemKind, readonly string[]>> = Object.freeze({
  pin: ['unit', 'bodyStyle', 'number', 'name', 'type', 'shape', 'x', 'y', 'orientation', 'length', 'nameSize', 'numberSize', 'visible', 'alternates'],
  field: ['name', 'text', 'x', 'y', 'angle', 'size', 'bold', 'italic', 'hJustify', 'vJustify', 'visible', 'showName'],
  text: ['unit', 'bodyStyle', 'text', 'x', 'y', 'angle', 'size', 'bold', 'italic', 'hJustify', 'vJustify', 'visible'],
  textbox: ['unit', 'bodyStyle', 'text', 'x', 'y', 'angle', 'size', 'bold', 'italic', 'hJustify', 'vJustify', 'visible', 'x2', 'y2', 'stroke', 'fill', 'margins'],
  shape: ['unit', 'bodyStyle', 'points', 'stroke', 'fill'],
});

function isStroke(v: unknown): boolean {
  return isObj(v) && exactKeys(v, ['width', 'style', 'color']) && inRange(v.width, 0, STROKE_MAX_MM) && oneOf(v.style, LINE_STYLES) && typeof v.color === 'string' && COLOR_RE.test(v.color);
}
function isFill(v: unknown): boolean {
  return isObj(v) && exactKeys(v, ['type', 'color']) && oneOf(v.type, FILL_TYPES) && typeof v.color === 'string' && COLOR_RE.test(v.color);
}
function isPoint(v: unknown): boolean {
  return Array.isArray(v) && v.length === 2 && v.every((n) => inRange(n, -POSITION_MAX_MM, POSITION_MAX_MM));
}
function isAlternates(v: unknown): boolean {
  if (!Array.isArray(v) || v.length > ALTERNATES_MAX) return false;
  const names = new Set<string>();
  for (const a of v) {
    if (!isObj(a) || !exactKeys(a, ['name', 'type', 'shape']) || !isText(a.name, 1) || !oneOf(a.type, PIN_TYPES) || !oneOf(a.shape, PIN_SHAPES)) return false;
    if (names.has(a.name)) return false;
    names.add(a.name);
  }
  return true;
}

/** Each key a set may carry, with its type and bounds (the engine's readItemSet). */
const SET_VALUE: Readonly<Record<string, (v: unknown) => boolean>> = Object.freeze({
  unit: (v: unknown) => isInt(v, 0, UNITS_MAX),
  bodyStyle: (v: unknown) => isInt(v, 0, BODY_STYLES_MAX),
  number: (v: unknown) => isText(v),
  name: (v: unknown) => isText(v),
  text: (v: unknown) => isText(v, 0, TEXT_MAX, true),
  type: (v: unknown) => oneOf(v, PIN_TYPES),
  shape: (v: unknown) => oneOf(v, PIN_SHAPES),
  orientation: (v: unknown) => oneOf(v, ORIENTATIONS),
  x: (v: unknown) => inRange(v, -POSITION_MAX_MM, POSITION_MAX_MM),
  y: (v: unknown) => inRange(v, -POSITION_MAX_MM, POSITION_MAX_MM),
  x2: (v: unknown) => inRange(v, -POSITION_MAX_MM, POSITION_MAX_MM),
  y2: (v: unknown) => inRange(v, -POSITION_MAX_MM, POSITION_MAX_MM),
  length: (v: unknown) => inRange(v, 0, SIZE_MAX_MM),
  nameSize: (v: unknown) => inRange(v, 0, SIZE_MAX_MM),
  numberSize: (v: unknown) => inRange(v, 0, SIZE_MAX_MM),
  size: (v: unknown) => inRange(v, 0, SIZE_MAX_MM),
  visible: isBool,
  bold: isBool,
  italic: isBool,
  showName: isBool,
  angle: (v: unknown) => v === 0 || v === 90,
  hJustify: (v: unknown) => oneOf(v, H_JUSTIFY),
  vJustify: (v: unknown) => oneOf(v, V_JUSTIFY),
  stroke: isStroke,
  fill: isFill,
  margins: (v: unknown) => Array.isArray(v) && v.length === 4 && v.every((n) => inRange(n, 0, SIZE_MAX_MM)),
  points: (v: unknown) => Array.isArray(v) && v.length >= 2 && v.length <= POINTS_MAX && v.every(isPoint),
  alternates: isAlternates,
});
const ANY_KIND_KEY = new Set(Object.values(EDITABLE_KEYS).flat());

/** An ItemSet: a non-empty object of keys some kind takes, each in its type and bounds; null for anything else. */
export function parseItemSet(v: unknown): ItemSet | null {
  if (!isObj(v) || Object.keys(v).length === 0) return null;
  for (const [k, value] of Object.entries(v)) {
    if (!ANY_KIND_KEY.has(k) || !SET_VALUE[k](value)) return null;
  }
  return { ...v };
}

/** symedit.items.set's args: exactly `{ uuids, set }`, 1 to 4,096 uuids none twice and an ItemSet; null for anything else. */
export function parseItemsSetArgs(args: unknown): ItemsSetArgs | null {
  if (!isObj(args) || !exactKeys(args, ['uuids', 'set'])) return null;
  const uuids = uuidList(args.uuids, 1, UUIDS_MAX);
  const set = parseItemSet(args.set);
  return uuids == null || set == null ? null : { uuids, set };
}

/** The keys a new item of each kind carries in full besides `kind` and `uuid` (and a shape's `shape`), as the engine's hasFullKeys. */
export function newItemKeys(kind: ItemKind): string[] {
  const keys = [...EDITABLE_KEYS[kind]];
  if (kind === 'field') keys.push('unit', 'bodyStyle');
  if (kind === 'text') keys.push('name', 'showName');
  return keys;
}

/** The point count a shape takes: 2 corners, a center and a point on the circle, an arc's start, middle and end, 2 or more for a line, a curve's 4 controls. */
export function pointsFit(shape: ShapeName, n: number): boolean {
  if (shape === 'rectangle' || shape === 'circle') return n === 2;
  if (shape === 'arc') return n === 3;
  if (shape === 'bezier') return n === 4;
  return n >= 2 && n <= POINTS_MAX;
}

/**
 * symedit.items.add's args: exactly `{ items }`, 1 to 512 new items, each a
 * full item of its kind (every key the kind takes and no other; a shape also
 * its `shape` with the points it takes) with a lower case uuid no other new
 * item holds; a new field a user field (unit and body style 0, a name), a new
 * text no name and no shown name. Null for anything else.
 */
export function parseItemsAddArgs(args: unknown): ItemsAddArgs | null {
  if (!isObj(args) || !exactKeys(args, ['items']) || !Array.isArray(args.items)) return null;
  if (args.items.length < 1 || args.items.length > NEW_ITEMS_MAX) return null;
  const uuids = new Set<string>();
  const fieldNames = new Set<string>();
  const items: ItemsAddArgs['items'] = [];
  for (const it of args.items as unknown[]) {
    if (!isObj(it) || !oneOf(it.kind, ITEM_KINDS) || !isUuid(it.uuid) || uuids.has(it.uuid)) return null;
    uuids.add(it.uuid);
    const kind = it.kind;
    const keys = ['kind', 'uuid', ...newItemKeys(kind), ...(kind === 'shape' ? ['shape'] : [])];
    if (!exactKeys(it, keys)) return null;
    const rest: Record<string, unknown> = {};
    for (const k of newItemKeys(kind)) rest[k] = it[k];
    if (parseItemSet(rest) == null) return null;
    if (kind === 'pin' && (!isText(it.number) || !isText(it.name))) return null;
    if (kind === 'shape' && (!oneOf(it.shape, SHAPES) || !pointsFit(it.shape, (it.points as unknown[]).length))) return null;
    if (kind === 'field') {
      if (it.unit !== 0 || it.bodyStyle !== 0 || !isText(it.name, 1)) return null;
      const lower = (it.name as string).toLowerCase();
      if (fieldNames.has(lower)) return null;
      fieldNames.add(lower);
    }
    if (kind === 'text' && (it.name !== '' || it.showName !== false)) return null;
    items.push({ ...it, kind, uuid: it.uuid });
  }
  return { items };
}

/** symedit.items.remove's args: exactly `{ uuids }`, 1 to 4,096 uuids none twice; null for anything else. */
export function parseItemsRemoveArgs(args: unknown): { uuids: string[] } | null {
  if (!isObj(args) || !exactKeys(args, ['uuids'])) return null;
  const uuids = uuidList(args.uuids, 1, UUIDS_MAX);
  return uuids == null ? null : { uuids };
}

/** symedit.show's args: exactly `{ unit, bodyStyle }`, each a whole number of at least 1; null for anything else. */
export function parseShowArgs(args: unknown): ShowArgs | null {
  if (!isObj(args) || !exactKeys(args, ['unit', 'bodyStyle'])) return null;
  if (!isInt(args.unit, 1, UNITS_MAX) || !isInt(args.bodyStyle, 1, BODY_STYLES_MAX)) return null;
  return { unit: args.unit, bodyStyle: args.bodyStyle };
}

const SYMBOL_TEXT_KEYS = ['refPrefix', 'value', 'footprint', 'datasheet', 'description', 'keywords'] as const;
const SYMBOL_BOOL_KEYS = ['unitsInterchangeable', 'showPinNames', 'showPinNumbers', 'pinNamesInside', 'inBom', 'onBoard', 'inSim', 'inPosFiles'] as const;
/** The field each of the five mandatory fields' own keys names. */
const KEY_FIELD: Readonly<Record<string, string>> = Object.freeze({ refPrefix: 'Reference', value: 'Value', footprint: 'Footprint', datasheet: 'Datasheet', description: 'Description' });
const SYMBOL_SET_KEYS = ['name', ...SYMBOL_TEXT_KEYS, 'fpFilters', 'fields', 'addField', 'removeField', 'unitCount', ...SYMBOL_BOOL_KEYS,
  'unitNames', 'bodyStyles', 'power', 'pinNameOffset', 'jumpers', 'fromParent', 'flatten'] as const;

function isBodyStylesSet(v: unknown): boolean {
  if (!isObj(v) || !exactKeys(v, ['mode', 'names']) || !Array.isArray(v.names) || v.names.length > BODY_STYLES_MAX || !v.names.every((n) => isText(n, 1))) return false;
  if (v.mode === 'named') return v.names.length >= 2;
  return (v.mode === 'one' || v.mode === 'demorgan') && v.names.length === 0;
}

/**
 * symedit.symbol.set's args: exactly `{ set }`, a SymbolSet of at least one
 * key (spec 7.3), each in its type and bounds, a field changed once (by its
 * own key or in `fields`, never both, never both removed and changed, never
 * removed and added again in any casing). The bounds the symbol itself sets (a
 * field it lacks, a jumper group naming a pin it lacks, `fromParent` or
 * `flatten` on a root symbol) are the engine's to refuse. Null for anything else.
 */
export function parseSymbolSetArgs(args: unknown): { set: SymbolSet } | null {
  if (!isObj(args) || !exactKeys(args, ['set']) || !isObj(args.set)) return null;
  const s = args.set;
  if (Object.keys(s).length === 0 || !within(s, SYMBOL_SET_KEYS)) return null;
  const named = new Set<string>();
  if (has(s, 'name') && !isText(s.name, 1)) return null;
  for (const k of SYMBOL_TEXT_KEYS) {
    if (!has(s, k)) continue;
    if (!isText(s[k])) return null;
    if (k in KEY_FIELD) named.add(KEY_FIELD[k]);
  }
  if (has(s, 'fpFilters') && !(Array.isArray(s.fpFilters) && s.fpFilters.length <= LIST_MAX && s.fpFilters.every((f) => isText(f, 1)))) return null;
  if (has(s, 'fields')) {
    if (!Array.isArray(s.fields) || s.fields.length > LIST_MAX) return null;
    for (const f of s.fields as unknown[]) {
      if (!isObj(f) || !within(f, ['name', 'value', 'visible']) || !isText(f.name, 1) || Object.keys(f).length < 2) return null;
      if (has(f, 'value') && !isText(f.value)) return null;
      if (has(f, 'visible') && !isBool(f.visible)) return null;
      if (named.has(f.name)) return null;
      named.add(f.name);
    }
  }
  if (has(s, 'addField')) {
    const a = s.addField;
    if (!isObj(a) || !exactKeys(a, ['name', 'value', 'visible']) || !isText(a.name, 1) || !isText(a.value) || !isBool(a.visible)) return null;
  }
  if (has(s, 'removeField')) {
    if (!isText(s.removeField, 1) || named.has(s.removeField)) return null;
    if (isObj(s.addField) && (s.addField.name as string).toLowerCase() === s.removeField.toLowerCase()) return null;
  }
  if (has(s, 'unitCount') && !isInt(s.unitCount, 1, UNITS_MAX)) return null;
  for (const k of SYMBOL_BOOL_KEYS) if (has(s, k) && !isBool(s[k])) return null;
  if (has(s, 'unitNames')) {
    const u = s.unitNames;
    if (!isObj(u) || Object.keys(u).length > UNITS_MAX) return null;
    const units = isInt(s.unitCount, 1, UNITS_MAX) ? s.unitCount : UNITS_MAX;
    for (const [k, name] of Object.entries(u)) {
      if (!/^[1-9][0-9]{0,2}$/.test(k) || Number(k) > units || !isText(name, 1)) return null;
    }
  }
  if (has(s, 'bodyStyles') && !isBodyStylesSet(s.bodyStyles)) return null;
  if (has(s, 'power') && !oneOf(s.power, POWERS)) return null;
  if (has(s, 'pinNameOffset') && !inRange(s.pinNameOffset, 0, PIN_NAME_OFFSET_MAX)) return null;
  if (has(s, 'jumpers')) {
    const j = s.jumpers;
    if (!isObj(j) || Object.keys(j).length === 0 || !within(j, ['duplicateNumbersAreJumpers', 'groups'])) return null;
    if (has(j, 'duplicateNumbersAreJumpers') && !isBool(j.duplicateNumbersAreJumpers)) return null;
    if (has(j, 'groups') && !(Array.isArray(j.groups) && j.groups.length <= LIST_MAX
      && j.groups.every((g) => Array.isArray(g) && g.length <= LIST_MAX && g.every((p) => isText(p, 1))))) return null;
  }
  if (has(s, 'fromParent')) {
    const f = s.fromParent;
    const flags = ['resetEmpty', 'resetVisibility', 'resetEffects', 'resetPositions', 'removeExtra'];
    if (!isObj(f) || !exactKeys(f, ['fields', ...flags]) || !flags.every((k) => isBool(f[k]))) return null;
    const ok = f.fields === 'all' || (Array.isArray(f.fields) && f.fields.length >= 1 && f.fields.length <= LIST_MAX && f.fields.every((n) => isText(n, 1)));
    if (!ok) return null;
  }
  if (has(s, 'flatten') && s.flatten !== true) return null;
  return { set: { ...s } };
}

// ── the engine's answers, read closed ───────────────────────────────────────────────────

function parseJson(text: unknown): unknown {
  if (typeof text !== 'string' || text === '') return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}
function readBodyStyles(v: unknown): BodyStyles | null {
  if (!isObj(v) || !exactKeys(v, ['mode', 'names']) || !oneOf(v.mode, BODY_MODES) || !Array.isArray(v.names)) return null;
  if (v.names.length > BODY_STYLES_MAX || !v.names.every((n) => isRecordText(n))) return null;
  return { mode: v.mode, names: [...v.names] as string[] };
}

const STATE_KEYS = ['token', 'open', 'name', 'lib', 'mode', 'modified', 'depth', 'unit', 'unitCount', 'bodyStyle', 'bodyStyles', 'parent', 'syncedPins'];

/** kicadSymEditState's answer read closed (spec 7.1): null for "" (no symbol editor frame) or any other shape. */
export function readState(text: unknown): SymEditState | null {
  const v = parseJson(text);
  if (!isObj(v) || !exactKeys(v, STATE_KEYS)) return null;
  if (typeof v.token !== 'string' || !(v.token === '' || isToken(v.token)) || !isBool(v.open) || !isRecordText(v.name) || !isRecordText(v.lib)) return null;
  if (!oneOf(v.mode, MODES) || !isBool(v.modified) || !isInt(v.depth, 0, Number.MAX_SAFE_INTEGER)) return null;
  if (!isInt(v.unit, 1, UNITS_MAX) || !isInt(v.unitCount, 1, UNITS_MAX) || !isInt(v.bodyStyle, 1, BODY_STYLES_MAX)) return null;
  const bodyStyles = readBodyStyles(v.bodyStyles);
  if (bodyStyles == null || !isRecordText(v.parent) || !isBool(v.syncedPins)) return null;
  return {
    token: v.token, open: v.open, name: v.name, lib: v.lib, mode: v.mode, modified: v.modified, depth: v.depth,
    unit: v.unit, unitCount: v.unitCount, bodyStyle: v.bodyStyle, bodyStyles, parent: v.parent, syncedPins: v.syncedPins,
  };
}

const readStroke = (v: unknown): Stroke | null => (isStroke(v) ? { ...(v as unknown as Stroke) } : null);
const readFill = (v: unknown): Fill | null => (isFill(v) ? { ...(v as unknown as Fill) } : null);
const isPos = (v: unknown): v is number => inRange(v, -POSITION_MAX_MM, POSITION_MAX_MM);
const isSize = (v: unknown): v is number => inRange(v, 0, SIZE_MAX_MM);

function textKeysOk(v: Record<string, unknown>): boolean {
  return isRecordText(v.text) && isPos(v.x) && isPos(v.y) && (v.angle === 0 || v.angle === 90) && isSize(v.size) && isBool(v.bold) && isBool(v.italic)
    && oneOf(v.hJustify, H_JUSTIFY) && oneOf(v.vJustify, V_JUSTIFY) && isBool(v.visible);
}

const PIN_KEYS = ['kind', 'uuid', 'unit', 'bodyStyle', 'number', 'name', 'type', 'shape', 'x', 'y', 'orientation', 'length', 'nameSize', 'numberSize', 'visible', 'alternates'];
const TEXT_KEYS = ['kind', 'uuid', 'unit', 'bodyStyle', 'name', 'text', 'x', 'y', 'angle', 'size', 'bold', 'italic', 'hJustify', 'vJustify', 'visible', 'showName'];
const TEXTBOX_KEYS = ['kind', 'uuid', 'unit', 'bodyStyle', 'text', 'x', 'y', 'angle', 'size', 'bold', 'italic', 'hJustify', 'vJustify', 'visible', 'x2', 'y2', 'stroke', 'fill', 'margins'];
const SHAPE_KEYS = ['kind', 'uuid', 'unit', 'bodyStyle', 'shape', 'points', 'stroke', 'fill'];

/** One item of kicadSymEditItemsGet's answer, read closed (spec 7.2); null for any other shape. */
export function readItem(v: unknown): SymItem | null {
  if (!isObj(v) || !isUuid(v.uuid) || !isInt(v.unit, 0, UNITS_MAX) || !isInt(v.bodyStyle, 0, BODY_STYLES_MAX)) return null;
  const base = { uuid: v.uuid, unit: v.unit, bodyStyle: v.bodyStyle };
  switch (v.kind) {
    case 'pin': {
      if (!exactKeys(v, PIN_KEYS) || !isRecordText(v.number) || !isRecordText(v.name) || !oneOf(v.type, PIN_TYPES) || !oneOf(v.shape, PIN_SHAPES)) return null;
      if (!isPos(v.x) || !isPos(v.y) || !oneOf(v.orientation, ORIENTATIONS) || !isSize(v.length) || !isSize(v.nameSize) || !isSize(v.numberSize) || !isBool(v.visible)) return null;
      if (!Array.isArray(v.alternates) || v.alternates.length > ALTERNATES_MAX) return null;
      const alternates: Alternate[] = [];
      for (const a of v.alternates as unknown[]) {
        if (!isObj(a) || !exactKeys(a, ['name', 'type', 'shape']) || !isRecordText(a.name) || !oneOf(a.type, PIN_TYPES) || !oneOf(a.shape, PIN_SHAPES)) return null;
        alternates.push({ name: a.name, type: a.type, shape: a.shape });
      }
      return {
        kind: 'pin', ...base, number: v.number, name: v.name, type: v.type, shape: v.shape, x: v.x, y: v.y, orientation: v.orientation,
        length: v.length, nameSize: v.nameSize, numberSize: v.numberSize, visible: v.visible, alternates,
      };
    }
    case 'field':
    case 'text':
      if (!exactKeys(v, TEXT_KEYS) || !isRecordText(v.name) || !textKeysOk(v) || !isBool(v.showName)) return null;
      return {
        kind: v.kind, ...base, name: v.name as string, text: v.text as string, x: v.x as number, y: v.y as number, angle: v.angle as 0 | 90,
        size: v.size as number, bold: v.bold as boolean, italic: v.italic as boolean, hJustify: v.hJustify as Text['hJustify'],
        vJustify: v.vJustify as Text['vJustify'], visible: v.visible as boolean, showName: v.showName,
      };
    case 'textbox': {
      if (!exactKeys(v, TEXTBOX_KEYS) || !textKeysOk(v) || !isPos(v.x2) || !isPos(v.y2)) return null;
      const stroke = readStroke(v.stroke);
      const fill = readFill(v.fill);
      if (stroke == null || fill == null || !Array.isArray(v.margins) || v.margins.length !== 4 || !v.margins.every(isSize)) return null;
      return {
        kind: 'textbox', ...base, text: v.text as string, x: v.x as number, y: v.y as number, angle: v.angle as 0 | 90, size: v.size as number,
        bold: v.bold as boolean, italic: v.italic as boolean, hJustify: v.hJustify as Text['hJustify'], vJustify: v.vJustify as Text['vJustify'],
        visible: v.visible as boolean, x2: v.x2, y2: v.y2, stroke, fill, margins: [...v.margins] as [number, number, number, number],
      };
    }
    case 'shape': {
      if (!exactKeys(v, SHAPE_KEYS) || !oneOf(v.shape, SHAPES) || !Array.isArray(v.points) || v.points.length > POINTS_MAX || !v.points.every(isPoint)) return null;
      const stroke = readStroke(v.stroke);
      const fill = readFill(v.fill);
      if (stroke == null || fill == null) return null;
      return { kind: 'shape', ...base, shape: v.shape, points: (v.points as number[][]).map((p) => [p[0], p[1]] as [number, number]), stroke, fill };
    }
    default:
      return null;
  }
}

/** kicadSymEditItemsGet's answer (`{"items":[...]}`) read closed: null for "" or any other shape, or an answer naming a uuid twice. */
export function readItems(text: unknown): SymItem[] | null {
  const v = parseJson(text);
  if (!isObj(v) || !exactKeys(v, ['items']) || !Array.isArray(v.items)) return null;
  const out: SymItem[] = [];
  const seen = new Set<string>();
  for (const it of v.items as unknown[]) {
    const item = readItem(it);
    if (item == null || seen.has(item.uuid)) return null;
    seen.add(item.uuid);
    out.push(item);
  }
  return out;
}

const PROPS_KEYS = ['name', 'refPrefix', 'value', 'footprint', 'datasheet', 'description', 'keywords', 'fpFilters', 'fields', 'unitCount',
  'unitsInterchangeable', 'unitNames', 'bodyStyles', 'power', 'pinNameOffset', 'showPinNames', 'showPinNumbers', 'pinNamesInside',
  'inBom', 'onBoard', 'inSim', 'inPosFiles', 'jumpers', 'parent'];

/** kicadSymEditSymbolGet's answer read closed (spec 7.3): null for "" or any other shape. */
export function readSymbolProps(text: unknown): SymbolProps | null {
  const v = parseJson(text);
  if (!isObj(v) || !exactKeys(v, PROPS_KEYS)) return null;
  for (const k of ['name', ...SYMBOL_TEXT_KEYS, 'parent']) if (!isRecordText(v[k])) return null;
  if (!Array.isArray(v.fpFilters) || v.fpFilters.length > LIST_MAX || !v.fpFilters.every((f) => isRecordText(f))) return null;
  if (!Array.isArray(v.fields) || v.fields.length > LIST_MAX) return null;
  const fields: SymbolField[] = [];
  for (const f of v.fields as unknown[]) {
    if (!isObj(f) || !exactKeys(f, ['name', 'value', 'visible', 'kind']) || !isRecordText(f.name) || !isRecordText(f.value) || !isBool(f.visible) || !oneOf(f.kind, FIELD_KINDS)) return null;
    fields.push({ name: f.name, value: f.value, visible: f.visible, kind: f.kind });
  }
  if (!isInt(v.unitCount, 1, UNITS_MAX) || !isBool(v.unitsInterchangeable) || !isObj(v.unitNames)) return null;
  const unitNames: Record<string, string> = {};
  for (const [k, n] of Object.entries(v.unitNames)) {
    if (!/^[1-9][0-9]{0,2}$/.test(k) || !isRecordText(n)) return null;
    unitNames[k] = n;
  }
  const bodyStyles = readBodyStyles(v.bodyStyles);
  if (bodyStyles == null || !oneOf(v.power, POWERS) || !inRange(v.pinNameOffset, 0, SIZE_MAX_MM)) return null;
  for (const k of ['showPinNames', 'showPinNumbers', 'pinNamesInside', 'inBom', 'onBoard', 'inSim', 'inPosFiles']) if (!isBool(v[k])) return null;
  const j = v.jumpers;
  if (!isObj(j) || !exactKeys(j, ['duplicateNumbersAreJumpers', 'groups']) || !isBool(j.duplicateNumbersAreJumpers) || !Array.isArray(j.groups) || j.groups.length > LIST_MAX) return null;
  if (!j.groups.every((g) => Array.isArray(g) && g.length <= LIST_MAX && g.every((p) => isRecordText(p)))) return null;
  return {
    name: v.name as string, refPrefix: v.refPrefix as string, value: v.value as string, footprint: v.footprint as string,
    datasheet: v.datasheet as string, description: v.description as string, keywords: v.keywords as string,
    fpFilters: [...v.fpFilters] as string[], fields, unitCount: v.unitCount, unitsInterchangeable: v.unitsInterchangeable, unitNames,
    bodyStyles, power: v.power, pinNameOffset: v.pinNameOffset, showPinNames: v.showPinNames as boolean, showPinNumbers: v.showPinNumbers as boolean,
    pinNamesInside: v.pinNamesInside as boolean, inBom: v.inBom as boolean, onBoard: v.onBoard as boolean, inSim: v.inSim as boolean,
    inPosFiles: v.inPosFiles as boolean,
    jumpers: { duplicateNumbersAreJumpers: j.duplicateNumbersAreJumpers, groups: (j.groups as string[][]).map((g) => [...g]) },
    parent: v.parent as string,
  };
}

/** kicadSymEditTake's answer read closed: `{ name, text, parent }`, `text` a document of at most 4 MiB; null for "" or any other shape. */
export function readTaken(text: unknown): Taken | null {
  const v = parseJson(text);
  if (!isObj(v) || !exactKeys(v, ['name', 'text', 'parent']) || !isRecordText(v.name) || v.name === '' || !isDocument(v.text) || !isRecordText(v.parent)) return null;
  return { name: v.name, text: v.text, parent: v.parent };
}

/**
 * kicadSymEditCheck's answer read closed (spec 7.4): `{ grid, findings }`,
 * the grid in millimeters; a code the island does not know reads as `other`
 * (a later engine's). Null for "" or any other shape.
 */
export function readFindings(text: unknown): { grid: number; findings: SymFinding[] } | null {
  const v = parseJson(text);
  if (!isObj(v) || !exactKeys(v, ['grid', 'findings']) || !inRange(v.grid, 0, SIZE_MAX_MM) || !Array.isArray(v.findings)) return null;
  const findings: SymFinding[] = [];
  for (const f of v.findings as unknown[]) {
    if (!isObj(f) || !exactKeys(f, ['code', 'severity', 'pins', 'unit', 'bodyStyle', 'x', 'y', 'uuids'])) return null;
    if (typeof f.code !== 'string' || (f.severity !== 'warning' && f.severity !== 'info')) return null;
    if (!Array.isArray(f.pins) || f.pins.length > UUIDS_MAX || !f.pins.every((p) => isRecordText(p))) return null;
    if (!isInt(f.unit, 0, UNITS_MAX) || !isInt(f.bodyStyle, 0, BODY_STYLES_MAX)) return null;
    if (!(f.x === null || isPos(f.x)) || !(f.y === null || isPos(f.y)) || (f.x === null) !== (f.y === null)) return null;
    if (!Array.isArray(f.uuids) || f.uuids.length > UUIDS_MAX || !f.uuids.every(isUuid)) return null;
    const code: FindingCode = oneOf(f.code, FINDING_CODES) ? f.code : 'other';
    findings.push({ code, severity: f.severity, pins: [...f.pins] as string[], unit: f.unit, bodyStyle: f.bodyStyle, x: f.x as number | null, y: f.y as number | null, uuids: [...f.uuids] as string[] });
  }
  return { grid: v.grid, findings };
}

/** .cc-svg.json read closed: `{ error: "" | "plot_failed" }`; null when absent or of any other shape. */
export function readSvgDone(bytes: Uint8Array | null): { error: '' | 'plot_failed' } | null {
  if (bytes == null) return null;
  let v: unknown;
  try { v = JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; }
  if (!isObj(v) || !exactKeys(v, ['error']) || (v.error !== '' && v.error !== 'plot_failed')) return null;
  return { error: v.error };
}

/** The selection read (`{"uuids":[...]}`) closed: the uuids in KiCad's order; null for "" or any other shape. */
export function readSelection(text: unknown): string[] | null {
  const v = parseJson(text);
  if (!isObj(v) || !exactKeys(v, ['uuids']) || !Array.isArray(v.uuids) || !v.uuids.every(isUuid)) return null;
  return [...v.uuids] as string[];
}

// ── read backs and misfits ─────────────────────────────────────────────────────────────

const near = (a: unknown, b: unknown): boolean => isNum(a) && isNum(b) && Math.abs(a - b) <= LENGTH_SLACK;
function sameValue(want: unknown, got: unknown): boolean {
  if (isNum(want)) return near(want, got);
  if (Array.isArray(want)) return Array.isArray(got) && got.length === want.length && want.every((w, i) => sameValue(w, got[i]));
  if (isObj(want)) return isObj(got) && Object.keys(want).every((k) => sameValue(want[k], got[k]));
  return want === got;
}
const byName = (a: Alternate, b: Alternate): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** Whether an item read back shows every key of the set (lengths within KiCad's rounding; a pin's alternates as a set, by name). */
export function showsItemSet(set: ItemSet, item: SymItem): boolean {
  const got = item as unknown as Record<string, unknown>;
  return Object.entries(set).every(([k, want]) => {
    if (k === 'alternates' && item.kind === 'pin') return sameValue([...(want as Alternate[])].sort(byName), [...item.alternates].sort(byName));
    return sameValue(want, got[k]);
  });
}

/**
 * Why the items refuse the set, or null when it fits (bad_args with this as
 * the message): a key no item of that kind takes, a mandatory field's name, a
 * field's name over several items, a shape's point count its shape does not take.
 */
export function itemSetMisfit(set: ItemSet, items: readonly SymItem[]): string | null {
  for (const item of items) {
    for (const k of Object.keys(set)) if (!EDITABLE_KEYS[item.kind].includes(k)) return `${k} does not fit a ${item.kind}`;
    if (item.kind === 'field' && has(set, 'name')) {
      if (MANDATORY.includes(item.name)) return `${item.name} keeps its name`;
      if (set.name === '') return 'a field needs a name';
      if (items.length !== 1) return 'a field is renamed one at a time';
    }
    if (item.kind === 'shape' && has(set, 'points') && !pointsFit(item.shape, (set.points as unknown[]).length)) return `a ${item.shape} takes another count of points`;
  }
  return null;
}
const MANDATORY = ['Reference', 'Value', 'Footprint', 'Datasheet', 'Description'];

/** Whether the symbol read back shows the set: every key it can be read by (`fromParent` is the engine's to apply, and shows once the commit ran). */
export function showsSymbolSet(set: SymbolSet, p: SymbolProps): boolean {
  const field = (name: string) => p.fields.find((f) => f.name === name);
  for (const [k, want] of Object.entries(set)) {
    switch (k) {
      case 'fields':
        for (const f of want as Array<{ name: string; value?: string; visible?: boolean }>) {
          const got = field(f.name);
          if (got == null || (f.value !== undefined && got.value !== f.value) || (f.visible !== undefined && got.visible !== f.visible)) return false;
        }
        break;
      case 'addField': {
        const a = want as { name: string; value: string; visible: boolean };
        const got = field(a.name);
        if (got == null || got.value !== a.value || got.visible !== a.visible) return false;
        break;
      }
      case 'removeField':
        if (field(want as string) != null) return false;
        break;
      case 'unitNames':
        if (!Object.entries(want as Record<string, string>).every(([u, n]) => p.unitNames[u] === n)) return false;
        break;
      case 'jumpers': {
        const j = want as { duplicateNumbersAreJumpers?: boolean; groups?: string[][] };
        if (j.duplicateNumbersAreJumpers !== undefined && p.jumpers.duplicateNumbersAreJumpers !== j.duplicateNumbersAreJumpers) return false;
        const norm = (gs: string[][]) => gs.map((g) => [...new Set(g)].sort().join('\n')).sort();
        if (j.groups !== undefined && !sameValue(norm(j.groups), norm(p.jumpers.groups))) return false;
        break;
      }
      case 'pinNameOffset':
        // An offset reads back only while the names sit inside (KiCad's own rule: an offset of 0 is outside).
        if (p.pinNamesInside && !near(want, p.pinNameOffset)) return false;
        break;
      case 'value':
        // A power symbol's value is its name (the dialog's rule).
        if (p.power === 'none' && p.value !== want) return false;
        break;
      case 'fromParent':
        break;
      case 'flatten':
        if (p.parent !== '') return false;
        break;
      default:
        if (!sameValue(want, (p as unknown as Record<string, unknown>)[k])) return false;
    }
  }
  return true;
}

// ── what the island hands the engine ──────────────────────────────────────────────────

/** kicadSymEditOpen's args: the op's, with the token the island made for this open. */
export const openJson = (a: OpenArgs, token: string): string =>
  JSON.stringify({ text: a.text, name: a.name, lib: a.lib, mode: a.mode, unit: a.unit, bodyStyle: a.bodyStyle, discard: a.discard, token });
/** kicadSymEditNew's args: the op's, with the token. */
export const newJson = (a: NewArgs, token: string): string => JSON.stringify({ ...a, token });

/** A fresh page token for one open (the engine echoes it in the state; markSaved names it). */
export function makeToken(): string {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return `t${Array.from(a, (x) => x.toString(16).padStart(2, '0')).join('')}`;
}
