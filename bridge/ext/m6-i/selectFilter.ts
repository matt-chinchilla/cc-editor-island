// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The selection filter (the canvas commands addendum 7): KiCad's Selection
// Filter panes' switches, one per kind and the locked items, as engine run 15
// reads and writes them (kicadSelectionFilterGet, kicadSelectionFilterSet;
// unit m6-e3) from PCB_SELECTION_TOOL::GetFilter() and
// SCH_SELECTION_TOOL::GetFilter(). Pure: the shapes only.

/** The board's switches (PCB_SELECTION_FILTER_OPTIONS), in KiCad's order. */
export const BOARD_FILTER_KEYS = [
  'lockedItems', 'footprints', 'text', 'tracks', 'vias', 'pads', 'graphics', 'zones', 'keepouts', 'dimensions', 'points', 'otherItems',
] as const;
/** The schematic's switches (SCH_SELECTION_FILTER_OPTIONS), in KiCad's order. */
export const SCH_FILTER_KEYS = ['lockedItems', 'symbols', 'text', 'wires', 'labels', 'pins', 'graphics', 'images', 'ruleAreas', 'otherItems'] as const;

/** The frames that hold a selection filter. */
export type FilterFrame = 'sch' | 'pcb';
export type Filter = Record<string, boolean>;

/** The frame's switches. */
export const filterKeys = (frame: FilterFrame): readonly string[] => (frame === 'pcb' ? BOARD_FILTER_KEYS : SCH_FILTER_KEYS);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The engine's read (JSON text): exactly the frame's switches, each a boolean, in KiCad's order; null for anything else. */
export function readFilter(raw: unknown, frame: FilterFrame): Filter | null {
  if (typeof raw !== 'string' || raw === '' || raw.length > 4096) return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!isObj(v)) return null;
  const keys = filterKeys(frame);
  if (Object.keys(v).length !== keys.length) return null;
  const out: Filter = {};
  for (const k of keys) {
    if (typeof v[k] !== 'boolean') return null;
    out[k] = v[k] as boolean;
  }
  return out;
}

/** selectFilter.get's args: none. */
export const isNoFilterArgs = (args: unknown): boolean => args == null || (isObj(args) && Object.keys(args).length === 0);

/**
 * selectFilter.set's args: exactly `{ filter }`, `filter` one or more of the
 * frame's switches, each a boolean (the others are kept). Null for anything
 * else: no switch, an unknown one (the other editor's too), a non boolean.
 */
export function parseFilterSet(args: unknown, frame: FilterFrame): Filter | null {
  if (!isObj(args) || Object.keys(args).length !== 1 || !isObj(args.filter)) return null;
  const f = args.filter;
  const keys = filterKeys(frame);
  const names = Object.keys(f);
  if (names.length === 0 || !names.every((k) => keys.includes(k) && typeof f[k] === 'boolean')) return null;
  const out: Filter = {};
  for (const k of keys) if (k in f) out[k] = f[k] as boolean;
  return out;
}

/** The read back holds every switch where it was set. */
export const filterHolds = (read: Filter, set: Filter): boolean => Object.entries(set).every(([k, v]) => read[k] === v);
