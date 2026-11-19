// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The board asks of the prompt host (the canvas commands addendum 6.1), as
// engine run 15 sends their records (units m3-e1 and m3-e2), read closed:
// `convert` (KiCad's conversion settings dialog), `outset` (Create Outsets)
// and `zoneSettings` (a NEW zone's settings: copper, non copper, rule area).
// A record of another shape is not read, so KiCad's own dialog shows (the
// prompt host takes an ask only when its record reads). Pure: no window, no
// engine.
import { LAYER_RE } from '../../boardCheck';
import { readBoardItems, type ZoneSheet } from '../../boardItem';
import { readItemRecord, type ZoneItemRecord } from '../../itemRecords';

/** The asks this unit declares (ev.prompt's `ask`). */
export const BOARD_ASKS = ['convert', 'outset', 'zoneSettings'] as const;
export type BoardAsk = (typeof BOARD_ASKS)[number];

/** The conversion strategies, in KiCad's radio button order (CONVERT_STRATEGY). */
export const CONVERT_STRATEGIES = ['copyLineWidth', 'centerline', 'boundingHull'] as const;
/** The kinds of a new zone, by the KiCad dialog that would show. */
export const ZONE_KINDS = ['copper', 'nonCopper', 'ruleArea'] as const;
/** A length of these dialogs, in mm, at most this. */
export const LENGTH_MAX_MM = 1000;
/** The layers an outset may offer, at most this many (KiCad's whole layer set is 128 and some). */
export const OUTSET_LAYERS_MAX = 256;
/** A nil uuid: the shared readers take a real uuid, a new zone's record carries "". */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exact = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const k = Object.keys(o);
  return k.length === keys.length && keys.every((x) => k.includes(x));
};
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isLength = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= LENGTH_MAX_MM;
/** An outset distance: KiCad's field takes a negative one (an inset). */
const isSigned = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= LENGTH_MAX_MM;
const isLayer = (v: unknown): v is string => typeof v === 'string' && LAYER_RE.test(v);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);

const CONVERT_KEYS = ['strategies', 'strategy', 'gap', 'lineWidth', 'deleteOriginals'] as const;

/**
 * `convert`: `{ strategies, strategy, gap, lineWidth, deleteOriginals }`.
 * `strategies` the radio buttons the dialog shows, in KiCad's order, each
 * once (`[]` for Create Lines, which shows none); `strategy` the selected one,
 * which KiCad's settings may set to one the dialog hides; lengths in mm.
 */
export function readConvert(r: unknown): Record<string, unknown> | null {
  if (!isObj(r) || !exact(r, CONVERT_KEYS)) return null;
  const { strategies, strategy, gap, lineWidth, deleteOriginals } = r;
  if (!Array.isArray(strategies) || !strategies.every((s) => oneOf(CONVERT_STRATEGIES, s))) return null;
  // In KiCad's order, none twice.
  const at = strategies.map((s) => CONVERT_STRATEGIES.indexOf(s as (typeof CONVERT_STRATEGIES)[number]));
  if (!at.every((n, i) => i === 0 || n > at[i - 1])) return null;
  if (!oneOf(CONVERT_STRATEGIES, strategy) || !isLength(gap) || !isLength(lineWidth) || !isBool(deleteOriginals)) return null;
  return { strategies: [...strategies], strategy, gap, lineWidth, deleteOriginals };
}

const OUTSET_KEYS = [
  'outsetDistance', 'roundCorners', 'useSourceLayers', 'useSourceWidths', 'layer', 'layers', 'lineWidth', 'gridRounding', 'deleteSourceItems',
] as const;

/**
 * `outset`: `{ outsetDistance, roundCorners, useSourceLayers, useSourceWidths,
 * layer, layers, lineWidth, gridRounding, deleteSourceItems }`
 * (OUTSET_ROUTINE::PARAMETERS): lengths in mm, `layer` the selected layer's
 * canonical name, `layers` the ones the dialog offers (the board's enabled
 * layers in KiCad's order, each once), `gridRounding` a length or null (Round
 * to grid off).
 */
export function readOutset(r: unknown): Record<string, unknown> | null {
  if (!isObj(r) || !exact(r, OUTSET_KEYS)) return null;
  const { outsetDistance, roundCorners, useSourceLayers, useSourceWidths, layer, layers, lineWidth, gridRounding, deleteSourceItems } = r;
  if (!isSigned(outsetDistance) || !isBool(roundCorners) || !isBool(useSourceLayers) || !isBool(useSourceWidths) || !isBool(deleteSourceItems)) return null;
  if (!isLayer(layer) || !Array.isArray(layers) || layers.length > OUTSET_LAYERS_MAX || !layers.every(isLayer) || new Set(layers).size !== layers.length) return null;
  if (!isLength(lineWidth) || !(gridRounding === null || isLength(gridRounding))) return null;
  return {
    outsetDistance, roundCorners, useSourceLayers, useSourceWidths, layer, layers: [...layers] as string[], lineWidth, gridRounding, deleteSourceItems,
  };
}

/** A copper zone's sheet: wave 1's zone sheet (board.item.get's `zone` keys) with `uuid` "". */
function readCopperSheet(s: unknown): ZoneSheet | null {
  if (!isObj(s) || s.uuid !== '') return null;
  // The shared reader takes a real uuid: read under the nil one, then give "" back.
  const read = readBoardItems(JSON.stringify({ items: [{ ...s, uuid: NIL_UUID }] }));
  const z = read?.length === 1 ? read[0] : null;
  return z != null && z.kind === 'zone' ? { ...z, uuid: '' } : null;
}

/** A non copper zone's or a rule area's sheet: the zone item record (the properties addendum's, M4's) with `uuid` "". */
function readZoneRecord(s: unknown, ruleArea: boolean): ZoneItemRecord | null {
  if (!isObj(s) || s.uuid !== '' || s.ruleArea !== ruleArea) return null;
  const z = readItemRecord('zone', { ...s, uuid: NIL_UUID }) as ZoneItemRecord | null;
  return z != null ? { ...z, uuid: '' } : null;
}

/**
 * `zoneSettings`: `{ kind, sheet }`, asked for a NEW zone (drawn, made by
 * Convert, or Duplicate Zone onto Layer). `copper`: wave 1's zone sheet with
 * `uuid` ""; `nonCopper` and `ruleArea`: the zone item record of the
 * properties addendum (`ruleArea` false and true), `uuid` "".
 */
export function readZoneSettings(r: unknown): Record<string, unknown> | null {
  if (!isObj(r) || !exact(r, ['kind', 'sheet']) || !oneOf(ZONE_KINDS, r.kind)) return null;
  const sheet = r.kind === 'copper' ? readCopperSheet(r.sheet) : readZoneRecord(r.sheet, r.kind === 'ruleArea');
  return sheet == null ? null : { kind: r.kind, sheet };
}

/** Each declared ask's closed record reader (ExtUnit.askReaders). */
export const BOARD_ASK_READERS: Readonly<Record<BoardAsk, (record: unknown) => Record<string, unknown> | null>> = {
  convert: readConvert,
  outset: readOutset,
  zoneSettings: readZoneSettings,
};
