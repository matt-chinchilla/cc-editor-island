// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// board.item.get and board.item.set (PROTOCOL.md): a board item's properties
// read and changed by uuid with no KiCad dialog, through our engine's
// kicadBoardItemGet and kicadBoardItemSet (engine run 12). The get is a
// synchronous read of the board the editor holds (unsaved edits included); the
// set queues ONE BOARD_COMMIT on the editor's apply coroutine through KiCad's
// own property setters (one undo step) and answers before it runs, so the
// island waits for the apply queue to empty and reads the item back.

import { UUID, UUID_RE, TEXT_MAX, REF_MAX, POSITION_MAX_MM } from './symbol';
import { LAYER_RE, NET_MAX } from './boardCheck';

/** The engine exports the ops need: the read, the write, the apply queue probe. */
export const BOARD_ITEM_EXPORTS = ['kicadBoardItemGet', 'kicadBoardItemSet', 'kicadCollabBusy'] as const;
/** board.item.get asks for 1 to this many uuids; an answer lists at most as many items. */
export const MAX_GET_UUIDS = 512;
/** A board text is at most this long; a zone lists at most this many nets to choose from, and this many layers. */
export const BOARD_TEXT_MAX = 4096;
export const NET_CHOICES_MAX = 4096;
export const ZONE_LAYERS_MAX = 64;
/** A size (a width, a hole, a clearance) in millimeters lies in these bounds. */
export const SIZE_MIN_MM = 0.001;
export const SIZE_MAX_MM = 1000;
export const ROTATION_MAX = 360;
export const PRIORITY_MAX = 1_000_000;

/** A footprint's schematic path: one uuid per sheet level and the symbol's, each after a slash. */
const SYMBOL_PATH_RE = new RegExp(`^(?:/${UUID})+$`);
/** Any control character (C0 or DEL). */
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
/** A board text's control characters: every one but a line break and a tab. */
const TEXT_CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/;
/** KiCad's rounding when it reads a length back (4 decimals) and an angle (3 decimals), with room for the float. */
const LENGTH_SLACK = 0.00005 + 1e-9;
const ANGLE_SLACK = 0.0005 + 1e-9;

export type Side = 'front' | 'back';
export type PadConnection = 'thermal' | 'solid' | 'none' | 'thtThermal';
export type HAlign = 'left' | 'center' | 'right';
export type OtherType = 'pad' | 'shape' | 'dimension' | 'textbox' | 'table' | 'group' | 'image' | 'barcode' | 'rulearea' | 'marker' | 'other';

interface ItemBase { uuid: string; locked: boolean }
export interface FootprintSheet extends ItemBase {
  kind: 'footprint'; ref: string; value: string; libId: string; side: Side; x: number; y: number; rotation: number;
  inBom: boolean; inPos: boolean; dnp: boolean; boardOnly: boolean; variant: string; symbolPath: string;
}
export interface TrackSheet extends ItemBase { kind: 'track' | 'arc'; net: string; layer: string; width: number; length: number }
export interface ViaSheet extends ItemBase {
  kind: 'via'; net: string; x: number; y: number; diameter: number; drill: number;
  viaType: 'through' | 'blind' | 'buried' | 'micro'; top: string; bottom: string;
}
export interface ZoneSheet extends ItemBase {
  kind: 'zone'; name: string; net: string; layers: string[]; priority: number; clearance: number; minWidth: number;
  padConnection: PadConnection; thermalGap: number; spokeWidth: number; netChoices: string[];
}
export interface TextSheet extends ItemBase {
  kind: 'text'; text: string; layer: string; x: number; y: number; rotation: number; height: number; width: number; thickness: number;
  bold: boolean; italic: boolean; knockout: boolean; mirrored: boolean; hAlign: HAlign;
}
export interface OtherSheet { kind: 'other'; uuid: string; type: OtherType }
export type BoardItemSheet = FootprintSheet | TrackSheet | ViaSheet | ZoneSheet | TextSheet | OtherSheet;

/** One key, one value: the form commits one control at a time. */
export type BoardItemSet =
  | { x: number } | { y: number } | { rotation: number } | { locked: boolean }
  | { side: Side } | { inBom: boolean } | { inPos: boolean } | { dnp: boolean }
  | { ref: string } | { value: string }
  | { width: number } | { layer: string }
  | { diameter: number } | { drill: number }
  | { name: string } | { net: string } | { priority: number } | { clearance: number } | { minWidth: number }
  | { padConnection: PadConnection } | { thermalGap: number } | { spokeWidth: number }
  | { text: string } | { height: number } | { thickness: number } | { bold: boolean }
  | { italic: boolean } | { knockout: boolean } | { hAlign: HAlign };
export interface BoardItemSetArgs { uuid: string; set: BoardItemSet }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
};
const chars = (s: string): number => [...s].length;
const isText = (v: unknown, max = TEXT_MAX): v is string => typeof v === 'string' && chars(v) <= max;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isSize = (v: unknown): v is number => isNum(v) && v >= 0;
const isPos = (v: unknown): v is number => isNum(v) && Math.abs(v) <= POSITION_MAX_MM;
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isLayer = (v: unknown): v is string => typeof v === 'string' && LAYER_RE.test(v);
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
const oneOf = <T extends string>(v: unknown, all: readonly T[]): v is T => typeof v === 'string' && (all as readonly string[]).includes(v);
const SIDES = ['front', 'back'] as const;
const PAD_CONNECTIONS = ['thermal', 'solid', 'none', 'thtThermal'] as const;
const H_ALIGNS = ['left', 'center', 'right'] as const;
const VIA_TYPES = ['through', 'blind', 'buried', 'micro'] as const;
const OTHER_TYPES = ['pad', 'shape', 'dimension', 'textbox', 'table', 'group', 'image', 'barcode', 'rulearea', 'marker', 'other'] as const;

/** board.item.get's args: exactly `{ uuids }`, 1 to MAX_GET_UUIDS lower case uuids; null for anything else. */
export function parseBoardItemGetArgs(args: unknown): { uuids: string[] } | null {
  if (!isObj(args) || !exactKeys(args, ['uuids']) || !Array.isArray(args.uuids)) return null;
  if (args.uuids.length < 1 || args.uuids.length > MAX_GET_UUIDS || !args.uuids.every(isUuid)) return null;
  return { uuids: [...args.uuids] as string[] };
}

const FOOTPRINT_KEYS = ['kind', 'uuid', 'locked', 'ref', 'value', 'libId', 'side', 'x', 'y', 'rotation', 'inBom', 'inPos', 'dnp', 'boardOnly', 'variant', 'symbolPath'];
const TRACK_KEYS = ['kind', 'uuid', 'locked', 'net', 'layer', 'width', 'length'];
const VIA_KEYS = ['kind', 'uuid', 'locked', 'net', 'x', 'y', 'diameter', 'drill', 'viaType', 'top', 'bottom'];
const ZONE_KEYS = ['kind', 'uuid', 'locked', 'name', 'net', 'layers', 'priority', 'clearance', 'minWidth', 'padConnection', 'thermalGap', 'spokeWidth', 'netChoices'];
const TEXT_KEYS = ['kind', 'uuid', 'locked', 'text', 'layer', 'x', 'y', 'rotation', 'height', 'width', 'thickness', 'bold', 'italic', 'knockout', 'mirrored', 'hAlign'];
const OTHER_KEYS = ['kind', 'uuid', 'type'];

/** One item of kicadBoardItemGet's answer, read closed: null for any other shape. */
function readItem(v: unknown): BoardItemSheet | null {
  if (!isObj(v) || !isUuid(v.uuid)) return null;
  switch (v.kind) {
    case 'footprint': {
      if (!exactKeys(v, FOOTPRINT_KEYS) || !isBool(v.locked) || !isText(v.ref) || !isText(v.value) || !isText(v.libId) || !oneOf(v.side, SIDES)) return null;
      if (!isPos(v.x) || !isPos(v.y) || !isNum(v.rotation) || !(v.rotation > -180 && v.rotation <= 180)) return null;
      if (!isBool(v.inBom) || !isBool(v.inPos) || !isBool(v.dnp) || !isBool(v.boardOnly) || !isText(v.variant)) return null;
      if (typeof v.symbolPath !== 'string' || !(v.symbolPath === '' || SYMBOL_PATH_RE.test(v.symbolPath))) return null;
      return {
        kind: 'footprint', uuid: v.uuid, locked: v.locked, ref: v.ref, value: v.value, libId: v.libId, side: v.side, x: v.x, y: v.y,
        rotation: v.rotation, inBom: v.inBom, inPos: v.inPos, dnp: v.dnp, boardOnly: v.boardOnly, variant: v.variant, symbolPath: v.symbolPath,
      };
    }
    case 'track':
    case 'arc':
      if (!exactKeys(v, TRACK_KEYS) || !isBool(v.locked) || !isText(v.net, NET_MAX) || !isLayer(v.layer) || !isSize(v.width) || !isSize(v.length)) return null;
      return { kind: v.kind, uuid: v.uuid, locked: v.locked, net: v.net, layer: v.layer, width: v.width, length: v.length };
    case 'via':
      if (!exactKeys(v, VIA_KEYS) || !isBool(v.locked) || !isText(v.net, NET_MAX) || !isPos(v.x) || !isPos(v.y) || !isSize(v.diameter) || !isSize(v.drill)) return null;
      if (!oneOf(v.viaType, VIA_TYPES) || !isLayer(v.top) || !isLayer(v.bottom)) return null;
      return { kind: 'via', uuid: v.uuid, locked: v.locked, net: v.net, x: v.x, y: v.y, diameter: v.diameter, drill: v.drill, viaType: v.viaType, top: v.top, bottom: v.bottom };
    case 'zone': {
      if (!exactKeys(v, ZONE_KEYS) || !isBool(v.locked) || !isText(v.name) || !isText(v.net, NET_MAX)) return null;
      if (!Array.isArray(v.layers) || v.layers.length > ZONE_LAYERS_MAX || !v.layers.every(isLayer)) return null;
      if (!Number.isSafeInteger(v.priority) || (v.priority as number) < 0 || (v.priority as number) > PRIORITY_MAX) return null;
      if (!isSize(v.clearance) || !isSize(v.minWidth) || !oneOf(v.padConnection, PAD_CONNECTIONS) || !isSize(v.thermalGap) || !isSize(v.spokeWidth)) return null;
      if (!Array.isArray(v.netChoices) || v.netChoices.length > NET_CHOICES_MAX || !v.netChoices.every((n) => isText(n, NET_MAX))) return null;
      return {
        kind: 'zone', uuid: v.uuid, locked: v.locked, name: v.name, net: v.net, layers: [...v.layers] as string[], priority: v.priority as number,
        clearance: v.clearance, minWidth: v.minWidth, padConnection: v.padConnection, thermalGap: v.thermalGap, spokeWidth: v.spokeWidth,
        netChoices: [...v.netChoices] as string[],
      };
    }
    case 'text':
      if (!exactKeys(v, TEXT_KEYS) || !isBool(v.locked) || !isText(v.text, BOARD_TEXT_MAX) || !isLayer(v.layer) || !isPos(v.x) || !isPos(v.y)) return null;
      if (!isNum(v.rotation) || Math.abs(v.rotation) > ROTATION_MAX || !isSize(v.height) || !isSize(v.width) || !isSize(v.thickness)) return null;
      if (!isBool(v.bold) || !isBool(v.italic) || !isBool(v.knockout) || !isBool(v.mirrored) || !oneOf(v.hAlign, H_ALIGNS)) return null;
      return {
        kind: 'text', uuid: v.uuid, locked: v.locked, text: v.text, layer: v.layer, x: v.x, y: v.y, rotation: v.rotation, height: v.height,
        width: v.width, thickness: v.thickness, bold: v.bold, italic: v.italic, knockout: v.knockout, mirrored: v.mirrored, hAlign: v.hAlign,
      };
    case 'other':
      if (!exactKeys(v, OTHER_KEYS) || !oneOf(v.type, OTHER_TYPES)) return null;
      return { kind: 'other', uuid: v.uuid, type: v.type };
    default:
      return null;
  }
}

/**
 * kicadBoardItemGet's answer (`{"items":[...]}`) read closed: every item in
 * the order the engine listed it (the order asked; a uuid the board does not
 * hold left out, a field or a text inside a footprint answered as its
 * footprint once). Null for the empty answer or any other shape.
 */
export function readBoardItems(text: unknown): BoardItemSheet[] | null {
  if (typeof text !== 'string' || text === '') return null;
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (!isObj(v) || !exactKeys(v, ['items']) || !Array.isArray(v.items) || v.items.length > MAX_GET_UUIDS) return null;
  const out: BoardItemSheet[] = [];
  for (const it of v.items as unknown[]) {
    const item = readItem(it);
    if (item == null) return null;
    out.push(item);
  }
  return out;
}

/** Each key a set may carry, with its type and bounds. */
const SET_KEYS: Readonly<Record<string, (v: unknown) => boolean>> = Object.freeze({
  x: isPos,
  y: isPos,
  rotation: (v: unknown) => isNum(v) && Math.abs(v) <= ROTATION_MAX,
  locked: isBool,
  side: (v: unknown) => oneOf(v, SIDES),
  inBom: isBool,
  inPos: isBool,
  dnp: isBool,
  ref: (v: unknown) => typeof v === 'string' && chars(v) >= 1 && chars(v) <= REF_MAX && !CONTROL_RE.test(v),
  value: (v: unknown) => isText(v) && !CONTROL_RE.test(v),
  width: (v: unknown) => isNum(v) && v >= SIZE_MIN_MM && v <= SIZE_MAX_MM,
  layer: isLayer,
  diameter: (v: unknown) => isNum(v) && v >= SIZE_MIN_MM && v <= SIZE_MAX_MM,
  drill: (v: unknown) => isNum(v) && v >= SIZE_MIN_MM && v <= SIZE_MAX_MM,
  name: (v: unknown) => isText(v) && !CONTROL_RE.test(v),
  net: (v: unknown) => isText(v, NET_MAX) && !CONTROL_RE.test(v),
  priority: (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= PRIORITY_MAX,
  clearance: (v: unknown) => isNum(v) && v >= SIZE_MIN_MM && v <= SIZE_MAX_MM,
  minWidth: (v: unknown) => isNum(v) && v >= SIZE_MIN_MM && v <= SIZE_MAX_MM,
  padConnection: (v: unknown) => oneOf(v, PAD_CONNECTIONS),
  thermalGap: (v: unknown) => isNum(v) && v >= SIZE_MIN_MM && v <= SIZE_MAX_MM,
  spokeWidth: (v: unknown) => isNum(v) && v >= SIZE_MIN_MM && v <= SIZE_MAX_MM,
  text: (v: unknown) => isText(v, BOARD_TEXT_MAX) && !TEXT_CONTROL_RE.test(v),
  height: (v: unknown) => isNum(v) && v >= SIZE_MIN_MM && v <= SIZE_MAX_MM,
  thickness: (v: unknown) => isNum(v) && v >= SIZE_MIN_MM && v <= SIZE_MAX_MM,
  bold: isBool,
  italic: isBool,
  knockout: isBool,
  hAlign: (v: unknown) => oneOf(v, H_ALIGNS),
});

/** board.item.set's args: exactly `{ uuid, set }`, the set exactly one key in its type and bounds; null for anything else. */
export function parseBoardItemSetArgs(args: unknown): BoardItemSetArgs | null {
  if (!isObj(args) || !exactKeys(args, ['uuid', 'set']) || !isUuid(args.uuid) || !isObj(args.set)) return null;
  const keys = Object.keys(args.set);
  if (keys.length !== 1) return null;
  const check = Object.prototype.hasOwnProperty.call(SET_KEYS, keys[0]) ? SET_KEYS[keys[0]] : undefined;
  if (check == null || !check(args.set[keys[0]])) return null;
  return { uuid: args.uuid, set: { [keys[0]]: args.set[keys[0]] } as BoardItemSet };
}

/** The args as kicadBoardItemSet reads them: `{ uuid, set }`. */
export const boardItemSetJson = (a: BoardItemSetArgs): string => JSON.stringify({ uuid: a.uuid, set: a.set });

/** The keys each kind takes. */
const KIND_KEYS: Readonly<Record<Exclude<BoardItemSheet['kind'], 'other'>, readonly string[]>> = Object.freeze({
  footprint: ['x', 'y', 'rotation', 'locked', 'side', 'inBom', 'inPos', 'dnp', 'ref', 'value'],
  track: ['width', 'layer', 'locked'],
  arc: ['width', 'layer', 'locked'],
  via: ['x', 'y', 'locked', 'diameter', 'drill'],
  zone: ['name', 'net', 'priority', 'clearance', 'minWidth', 'padConnection', 'thermalGap', 'spokeWidth', 'locked'],
  text: ['x', 'y', 'rotation', 'locked', 'layer', 'text', 'height', 'width', 'thickness', 'bold', 'italic', 'knockout', 'hAlign'],
});
const KIND_WORDS: Readonly<Record<BoardItemSheet['kind'], string>> = Object.freeze({
  footprint: 'a footprint', track: 'a track', arc: 'an arc', via: 'a via', zone: 'a copper area', text: 'a text', other: 'an item',
});

const keyOf = (set: BoardItemSet): string => Object.keys(set)[0];
const valueOf = (set: BoardItemSet): unknown => (set as Record<string, unknown>)[keyOf(set)];

/**
 * Why the item itself refuses the set, or null when it fits (bad_args with
 * this as the message): a key of another kind; a footprint's designator or
 * value while it takes them from the schematic (it is not board only); a
 * track or arc off copper; a via's hole not smaller than the via; a zone's net
 * the board does not have. The board's enabled layers and every bound KiCad
 * keeps besides are the engine's to refuse.
 */
export function setMisfit(set: BoardItemSet, item: BoardItemSheet): string | null {
  const key = keyOf(set);
  const v = valueOf(set);
  if (item.kind === 'other') return `${item.type === 'other' ? 'an item' : `a ${item.type}`} does not change here`;
  if (!KIND_KEYS[item.kind].includes(key)) return `${key} does not fit ${KIND_WORDS[item.kind]}`;
  if (item.kind === 'footprint' && !item.boardOnly && (key === 'ref' || key === 'value')) {
    return `${item.ref} takes its ${key === 'ref' ? 'designator' : 'value'} from the schematic`;
  }
  if ((item.kind === 'track' || item.kind === 'arc') && key === 'layer' && !/\.Cu$/.test(v as string)) return 'a track runs on a copper layer';
  if (item.kind === 'via') {
    const diameter = key === 'diameter' ? (v as number) : item.diameter;
    const drill = key === 'drill' ? (v as number) : item.drill;
    if ((key === 'diameter' || key === 'drill') && drill >= diameter) return 'the hole must be smaller than the via';
  }
  if (item.kind === 'zone' && key === 'net' && v !== '' && !item.netChoices.includes(v as string)) return `the board has no net ${v as string}`;
  return null;
}

/** An angle in KiCad's range, -180 (excluded) to 180. */
const normalAngle = (a: number): number => {
  const r = ((a % 360) + 360) % 360;
  return r > 180 ? r - 360 : r;
};
const sameAngle = (a: number, b: number): boolean => {
  const d = Math.abs(normalAngle(a) - normalAngle(b));
  return Math.min(d, 360 - d) <= ANGLE_SLACK;
};

/** The item read back shows the set: its value, a length within KiCad's rounding, a rotation by its angle. */
export function showsBoardSet(set: BoardItemSet, item: BoardItemSheet): boolean {
  const key = keyOf(set);
  const want = valueOf(set);
  const got = (item as unknown as Record<string, unknown>)[key];
  if (got === undefined) return false;
  if (key === 'rotation') return typeof got === 'number' && sameAngle(want as number, got);
  if (typeof want === 'number' && key !== 'priority') return typeof got === 'number' && Math.abs(got - want) <= LENGTH_SLACK;
  return got === want;
}
