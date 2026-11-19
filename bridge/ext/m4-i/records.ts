// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The board item records of unit m4-i (properties addendum 3.4 and 3.5, as
// engine run 15's kicadBoardItemRecords writes them): the BoardRecordSheet
// around one item, the board only records (group, target, tuning pattern),
// the tuning tool's live settings, and the closed readers of each set the
// record form of board.item.set takes. The footprint editor's item kinds
// (pad, shape, text box, table, barcode, picture) are read by
// bridge/itemRecords.ts, the same readers the footprint editor's ops use;
// a kind that file has no reader for is reported as unread, never passed on.
import { LAYER_RE, NET_MAX } from '../../boardCheck';
import { ITEM_RECORD_KINDS, READABLE_KINDS, readItemRecord, readItemSet, type ItemRecord, type ItemRecordKind } from '../../itemRecords';
import { UUID_RE } from '../../symbol';

/** The kinds of a board record (addendum 3.4): the footprint editor's records, then the board only ones. */
export const BOARD_RECORD_KINDS = [
  'pad', 'shape', 'dimension', 'textbox', 'table', 'barcode', 'image', 'zone', 'point', 'tablecell', 'group', 'tuning', 'target',
] as const;
export type BoardRecordKind = typeof BOARD_RECORD_KINDS[number];
/** The kinds a board record carries that the footprint editor's records give. */
export const FP_BOARD_KINDS = ['pad', 'shape', 'dimension', 'textbox', 'table', 'barcode', 'image', 'zone', 'point'] as const;
/** The board only kinds this file reads (a table cell is never answered by the engine: M12's commands own it). */
export const BOARD_ONLY_KINDS = ['group', 'target', 'tuning'] as const;
/** The kinds the record form of board.item.set takes: every record kind but the table cell. */
export const BOARD_SET_KINDS: readonly BoardRecordKind[] = Object.freeze(BOARD_RECORD_KINDS.filter((k) => k !== 'tablecell'));

/** A string of a record at most this many characters unless named (FP 7's rule). */
export const RECORD_STRING_MAX = 1024;
/** A pad's net choices: at most this many nets. */
export const NET_CHOICES_MAX = 65_536;
/** A tuning target, a length (mm) or a delay (ps), at most this (the engine's bound). */
export const TUNING_TARGET_MAX = 2000;
/** A tuning amplitude or spacing (mm), at most this. */
export const TUNING_LENGTH_MAX = 1000;
/** A target mark's size floor (1 mil, the dialog's) and ceiling, in mm. */
export const TARGET_SIZE_MIN = 0.0254;
export const TARGET_SIZE_MAX = 1000;
/** A target mark's position bound, in mm. */
export const TARGET_POSITION_MAX = 2000;

export interface BoardGroup { kind: 'group'; uuid: string; name: string; locked: boolean; members: number; designBlock: string }
export interface BoardTarget { kind: 'target'; uuid: string; layer: string; x: number; y: number; shape: 'plus' | 'x'; size: number; width: number }
export interface TuningRange { min: number | null; opt: number | null; max: number | null }
export interface TuningSettings {
  mode: 'single' | 'diffPair' | 'skew';
  minAmplitude: number; maxAmplitude: number; spacing: number; cornerStyle: 'chamfer' | 'round'; cornerRadiusPercent: number; singleSided: boolean;
  timeDomain: boolean; overrideCustomRules: boolean;
  target: TuningRange;
  fromRules: TuningRange | null;
}
export interface TuningPattern extends TuningSettings { kind: 'tuning'; uuid: string; layer: string }
export type BoardRecordItem = ItemRecord | BoardGroup | BoardTarget | TuningPattern;
export interface BoardRecordSheet {
  kind: 'record';
  uuid: string;
  parent: string;
  parentRef: string;
  net: string | null;
  netChoices: string[];
  item: BoardRecordItem;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const has = (o: Record<string, unknown>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => has(o, k));
};
const within = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).every((k) => keys.includes(k));
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const inRange = (v: unknown, lo: number, hi: number): v is number => isNum(v) && v >= lo && v <= hi;
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isString = (v: unknown, max = RECORD_STRING_MAX): v is string => typeof v === 'string' && [...v].length <= max;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
const isLayer = (v: unknown): v is string => typeof v === 'string' && LAYER_RE.test(v);
/** A net's name as the records spell it: at most NET_MAX characters, no control character ("" is no net). */
export const isNetName = (v: unknown): v is string => isString(v, NET_MAX) && !CONTROL_RE.test(v as string);

// ── the board only records ─────────────────────────────────────────────────────────────

const GROUP_KEYS = ['kind', 'uuid', 'name', 'locked', 'members', 'designBlock'];
const TARGET_KEYS = ['kind', 'uuid', 'layer', 'x', 'y', 'shape', 'size', 'width'];
const SETTINGS_KEYS = [
  'mode', 'minAmplitude', 'maxAmplitude', 'spacing', 'cornerStyle', 'cornerRadiusPercent', 'singleSided', 'timeDomain', 'overrideCustomRules', 'target', 'fromRules',
];
const PATTERN_KEYS = [...SETTINGS_KEYS, 'kind', 'uuid', 'layer'];
const MODES = ['single', 'diffPair', 'skew'] as const;
const CORNERS = ['chamfer', 'round'] as const;

/** A group's record read closed. */
export function readGroup(v: unknown): BoardGroup | null {
  if (!isObj(v) || !exactKeys(v, GROUP_KEYS) || v.kind !== 'group' || !isUuid(v.uuid)) return null;
  if (!isString(v.name) || !isBool(v.locked) || !Number.isSafeInteger(v.members) || (v.members as number) < 0 || !isString(v.designBlock)) return null;
  return { kind: 'group', uuid: v.uuid, name: v.name, locked: v.locked, members: v.members as number, designBlock: v.designBlock };
}

/** A target mark's record read closed. */
export function readTarget(v: unknown): BoardTarget | null {
  if (!isObj(v) || !exactKeys(v, TARGET_KEYS) || v.kind !== 'target' || !isUuid(v.uuid) || !isLayer(v.layer)) return null;
  if (!isNum(v.x) || !isNum(v.y) || (v.shape !== 'plus' && v.shape !== 'x') || !inRange(v.size, 0, Number.MAX_VALUE) || !inRange(v.width, 0, Number.MAX_VALUE)) return null;
  return { kind: 'target', uuid: v.uuid, layer: v.layer, x: v.x, y: v.y, shape: v.shape, size: v.size, width: v.width };
}

/** A target, or the rules' range: exactly `{ min, opt, max }`, each a finite number or null. */
function readRange(v: unknown): TuningRange | null {
  if (!isObj(v) || !exactKeys(v, ['min', 'opt', 'max'])) return null;
  const n = (x: unknown): x is number | null => x === null || isNum(x);
  if (!n(v.min) || !n(v.opt) || !n(v.max)) return null;
  return { min: v.min, opt: v.opt, max: v.max };
}

/** The settings keys of a value already checked to hold exactly them. */
function settingsOf(v: Record<string, unknown>): TuningSettings | null {
  if (!(MODES as readonly unknown[]).includes(v.mode) || !(CORNERS as readonly unknown[]).includes(v.cornerStyle)) return null;
  if (!inRange(v.minAmplitude, 0, Number.MAX_VALUE) || !inRange(v.maxAmplitude, 0, Number.MAX_VALUE) || !inRange(v.spacing, 0, Number.MAX_VALUE)) return null;
  if (!Number.isSafeInteger(v.cornerRadiusPercent) || !inRange(v.cornerRadiusPercent, 0, 100)) return null;
  if (!isBool(v.singleSided) || !isBool(v.timeDomain) || !isBool(v.overrideCustomRules)) return null;
  const target = readRange(v.target);
  const fromRules = v.fromRules === null ? null : readRange(v.fromRules);
  if (target == null || (v.fromRules !== null && fromRules == null)) return null;
  return {
    mode: v.mode as TuningSettings['mode'], minAmplitude: v.minAmplitude, maxAmplitude: v.maxAmplitude, spacing: v.spacing,
    cornerStyle: v.cornerStyle as TuningSettings['cornerStyle'], cornerRadiusPercent: v.cornerRadiusPercent as number, singleSided: v.singleSided,
    timeDomain: v.timeDomain, overrideCustomRules: v.overrideCustomRules, target, fromRules,
  };
}

/** The tuning tool's live settings (kicadBoardTuningGet's answer, a value already parsed) read closed. */
export function readTuningSettings(v: unknown): TuningSettings | null {
  return isObj(v) && exactKeys(v, SETTINGS_KEYS) ? settingsOf(v) : null;
}

/** A placed tuning pattern's record read closed: the settings its dialog shows, its kind, uuid and layer. */
export function readTuningPattern(v: unknown): TuningPattern | null {
  if (!isObj(v) || !exactKeys(v, PATTERN_KEYS) || v.kind !== 'tuning' || !isUuid(v.uuid) || !isLayer(v.layer)) return null;
  const s = settingsOf(v);
  return s == null ? null : { ...s, kind: 'tuning', uuid: v.uuid, layer: v.layer };
}

// ── the sheet ──────────────────────────────────────────────────────────────────────────

const SHEET_KEYS = ['kind', 'uuid', 'parent', 'parentRef', 'net', 'netChoices', 'item'];

/** The item of a sheet read by its own kind: null for a kind with no reader here or a record of another shape. */
export function readRecordItem(v: unknown): BoardRecordItem | null {
  if (!isObj(v) || typeof v.kind !== 'string') return null;
  switch (v.kind) {
    case 'group': return readGroup(v);
    case 'target': return readTarget(v);
    case 'tuning': return readTuningPattern(v);
    default:
      if (!(FP_BOARD_KINDS as readonly string[]).includes(v.kind)) return null;
      return readItemRecord(v.kind, v);
  }
}

/** Why a sheet is not passed on: `shape` for a sheet of another shape, `unread` for an item this island has no reader of. */
export type SheetRead = { sheet: BoardRecordSheet } | { unread: string } | { shape: true };

/**
 * One BoardRecordSheet read closed: exactly its keys, `uuid` its item's,
 * `parent` a footprint's uuid or "", a pad's `net` a name ("" for none) and
 * its `netChoices` the board's nets, every other kind's `net` null and
 * `netChoices` empty. The item through its kind's reader: a record this
 * island cannot read (a kind with no reader in bridge/itemRecords.ts, or keys
 * that reader does not know) is `unread`, never passed on.
 */
export function readRecordSheet(v: unknown): SheetRead {
  if (!isObj(v) || !exactKeys(v, SHEET_KEYS) || v.kind !== 'record' || !isUuid(v.uuid)) return { shape: true };
  if (!(v.parent === '' || isUuid(v.parent)) || !isString(v.parentRef) || !isObj(v.item) || v.item.uuid !== v.uuid) return { shape: true };
  if (!Array.isArray(v.netChoices) || v.netChoices.length > NET_CHOICES_MAX || !v.netChoices.every(isNetName)) return { shape: true };
  const kind = v.item.kind;
  if (typeof kind !== 'string' || !(BOARD_RECORD_KINDS as readonly string[]).includes(kind)) return { shape: true };
  if (kind === 'pad' ? !isNetName(v.net) : v.net !== null || v.netChoices.length > 0) return { shape: true };
  const item = readRecordItem(v.item);
  if (item == null) return { unread: v.uuid };
  return {
    sheet: {
      kind: 'record', uuid: v.uuid, parent: v.parent as string, parentRef: v.parentRef, net: v.net as string | null,
      netChoices: [...(v.netChoices as string[])], item,
    },
  };
}

/** kicadBoardItemRecords' answer read: the sheets by uuid in the engine's order and the uuids it answered that this island leaves unread; null for any other shape. */
export interface RecordsRead { sheets: BoardRecordSheet[]; unread: string[] }

/**
 * kicadBoardItemRecords' answer (`{"items":[...]}`) read closed against the
 * uuids asked: every sheet one of them, none twice. Null for "" (the engine's
 * answer to args it does not take) and any other shape.
 */
export function readBoardRecords(text: unknown, asked: readonly string[]): RecordsRead | null {
  if (typeof text !== 'string' || text === '') return null;
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (!isObj(v) || !exactKeys(v, ['items']) || !Array.isArray(v.items) || v.items.length > asked.length) return null;
  const sheets: BoardRecordSheet[] = [];
  const unread: string[] = [];
  const seen = new Set<string>();
  for (const it of v.items as unknown[]) {
    const r = readRecordSheet(it);
    if ('shape' in r) return null;
    const uuid = 'sheet' in r ? r.sheet.uuid : r.unread;
    if (seen.has(uuid) || !asked.includes(uuid)) return null;
    seen.add(uuid);
    if ('sheet' in r) sheets.push(r.sheet); else unread.push(uuid);
  }
  return { sheets, unread };
}

// ── the sets ───────────────────────────────────────────────────────────────────────────

/** A group set: `name` (no control character), `locked`, `designBlock` ("lib:name" or "", KiCad parses it). */
export function readGroupSet(set: Record<string, unknown>): boolean {
  if (!within(set, ['name', 'locked', 'designBlock'])) return false;
  if (has(set, 'name') && !(isString(set.name) && !CONTROL_RE.test(set.name as string))) return false;
  if (has(set, 'locked') && !isBool(set.locked)) return false;
  if (has(set, 'designBlock') && !(isString(set.designBlock) && !CONTROL_RE.test(set.designBlock as string))) return false;
  return true;
}

/** A target mark set: `shape`, `size` (1 mil to 1,000 mm), `width` (0 to 1,000 mm), `x`, `y` (within 2,000 mm), `layer`. */
export function readTargetSet(set: Record<string, unknown>): boolean {
  if (!within(set, ['shape', 'size', 'width', 'x', 'y', 'layer'])) return false;
  if (has(set, 'shape') && set.shape !== 'plus' && set.shape !== 'x') return false;
  if (has(set, 'size') && !inRange(set.size, TARGET_SIZE_MIN, TARGET_SIZE_MAX)) return false;
  if (has(set, 'width') && !inRange(set.width, 0, TARGET_SIZE_MAX)) return false;
  for (const k of ['x', 'y']) if (has(set, k) && !inRange(set[k], -TARGET_POSITION_MAX, TARGET_POSITION_MAX)) return false;
  if (has(set, 'layer') && !isLayer(set.layer)) return false;
  return true;
}

/**
 * A tuning set (the live tool's or a placed pattern's): any settings key but
 * `mode` and `fromRules`; amplitudes and spacing 0 to 1,000 mm; the corner
 * radius a whole percent; `target` whole, `{ min?, opt?, max? }` each 0 to
 * 2,000 or null, `min` and `max` only beside an `opt`.
 */
export function readTuningSet(set: Record<string, unknown>): boolean {
  const keys = ['minAmplitude', 'maxAmplitude', 'spacing', 'cornerStyle', 'cornerRadiusPercent', 'singleSided', 'timeDomain', 'overrideCustomRules', 'target'];
  if (!within(set, keys)) return false;
  for (const k of ['minAmplitude', 'maxAmplitude', 'spacing']) if (has(set, k) && !inRange(set[k], 0, TUNING_LENGTH_MAX)) return false;
  if (has(set, 'cornerRadiusPercent') && !(Number.isSafeInteger(set.cornerRadiusPercent) && inRange(set.cornerRadiusPercent, 0, 100))) return false;
  if (has(set, 'cornerStyle') && !(CORNERS as readonly unknown[]).includes(set.cornerStyle)) return false;
  for (const k of ['singleSided', 'timeDomain', 'overrideCustomRules']) if (has(set, k) && !isBool(set[k])) return false;
  if (has(set, 'target')) {
    const t = set.target;
    if (!isObj(t) || !within(t, ['min', 'opt', 'max'])) return false;
    for (const k of ['min', 'opt', 'max']) if (has(t, k) && t[k] !== null && !inRange(t[k], 0, TUNING_TARGET_MAX)) return false;
    const opt = has(t, 'opt') && t.opt !== null;
    for (const k of ['min', 'max']) if (has(t, k) && t[k] !== null && !opt) return false;
  }
  return true;
}

/**
 * The record form's set for `kind` read closed: a non empty object, never
 * `kind` or `uuid`; a footprint editor kind through bridge/itemRecords.ts's
 * set reader, a pad's `net` beside it; a board only kind through its own.
 * Null for anything else, and for a footprint editor kind with no reader there.
 */
export function readBoardRecordSet(kind: BoardRecordKind, set: unknown): Record<string, unknown> | null {
  if (!isObj(set) || Object.keys(set).length === 0 || has(set, 'kind') || has(set, 'uuid')) return null;
  switch (kind) {
    case 'group': return readGroupSet(set) ? structuredClone(set) : null;
    case 'target': return readTargetSet(set) ? structuredClone(set) : null;
    case 'tuning': return readTuningSet(set) ? structuredClone(set) : null;
    case 'tablecell': return null;
    default: {
      if (!readsKind(kind)) return null;
      const { net, ...rest } = set;
      if (has(set, 'net') && (kind !== 'pad' || !isNetName(net))) return null;
      if (Object.keys(rest).length === 0) return has(set, 'net') ? { net } : null;
      const read = readItemSet(kind as ItemRecordKind, rest);
      if (read == null) return null;
      return has(set, 'net') ? { ...read, net } : read;
    }
  }
}

/** Whether this island reads the records of a footprint editor kind (bridge/itemRecords.ts READABLE_KINDS), or reads a board only kind. */
export function readsKind(kind: BoardRecordKind): boolean {
  if ((BOARD_ONLY_KINDS as readonly string[]).includes(kind)) return true;
  return (ITEM_RECORD_KINDS as readonly string[]).includes(kind) && READABLE_KINDS.includes(kind as ItemRecordKind);
}
