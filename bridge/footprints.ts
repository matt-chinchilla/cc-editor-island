// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// board.footprints (PROTOCOL.md): every footprint of the board with its
// designator, value, library id, schematic path, side, flags and user fields
// under the board's current variant, read with no KiCad window through our
// engine's kicadBoardFootprints (engine run 14). A synchronous read: what the
// page compares with symbols.get to carry the board's changes back to the
// schematic (properties spec 3.6).

import { UUID_RE, REF_MAX, TEXT_MAX, FIELD_NAME_MAX } from './symbol';
import { isSymbolPath } from './edit';
import { ROW_FIELDS_MAX, VARIANT_MAX, type TableField } from './symbols';

/** The engine export the op needs. */
export const FOOTPRINTS_EXPORTS = ['kicadBoardFootprints'] as const;
/** At most this many footprints in one answer (the engine's bound). */
export const MAX_FOOTPRINTS = 8192;

export interface FootprintRow {
  uuid: string; ref: string; value: string; libId: string; symbolPath: string;
  side: 'front' | 'back'; locked: boolean; dnp: boolean; inBom: boolean; inPos: boolean; boardOnly: boolean;
  fields: TableField[];
}
export interface BoardFootprints { footprints: FootprintRow[]; variant: string; truncated: boolean }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).length === keys.length && keys.every((k) => own(o, k));
const isText = (v: unknown, max = TEXT_MAX): v is string => typeof v === 'string' && [...v].length <= max;
const ROW_KEYS = ['uuid', 'ref', 'value', 'libId', 'symbolPath', 'side', 'locked', 'dnp', 'inBom', 'inPos', 'boardOnly', 'fields'] as const;
const FLAGS = ['locked', 'dnp', 'inBom', 'inPos', 'boardOnly'] as const;

function readRow(v: unknown): FootprintRow | null {
  if (!isObj(v) || !exactKeys(v, ROW_KEYS) || typeof v.uuid !== 'string' || !UUID_RE.test(v.uuid)) return null;
  if (!isText(v.ref, REF_MAX) || !isText(v.value) || !isText(v.libId) || !isSymbolPath(v.symbolPath)) return null;
  if (v.side !== 'front' && v.side !== 'back') return null;
  for (const f of FLAGS) if (typeof v[f] !== 'boolean') return null;
  if (!Array.isArray(v.fields) || v.fields.length > ROW_FIELDS_MAX) return null;
  const fields: TableField[] = [];
  for (const f of v.fields as unknown[]) {
    if (!isObj(f) || !exactKeys(f, ['name', 'value', 'shown']) || !isText(f.name, FIELD_NAME_MAX) || !isText(f.value) || typeof f.shown !== 'boolean') return null;
    fields.push({ name: f.name, value: f.value, shown: f.shown });
  }
  return {
    uuid: v.uuid, ref: v.ref, value: v.value, libId: v.libId, symbolPath: v.symbolPath, side: v.side,
    locked: v.locked as boolean, dnp: v.dnp as boolean, inBom: v.inBom as boolean, inPos: v.inPos as boolean, boardOnly: v.boardOnly as boolean, fields,
  };
}

/**
 * kicadBoardFootprints' answer read closed: `{ footprints, variant, truncated }`,
 * at most 8,192 rows, no uuid twice; null for the empty answer and any other shape.
 */
export function readBoardFootprints(text: unknown): BoardFootprints | null {
  if (typeof text !== 'string' || text === '') return null;
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (!isObj(v) || !exactKeys(v, ['footprints', 'variant', 'truncated']) || !Array.isArray(v.footprints) || v.footprints.length > MAX_FOOTPRINTS) return null;
  if (!isText(v.variant, VARIANT_MAX) || typeof v.truncated !== 'boolean') return null;
  const footprints: FootprintRow[] = [];
  const seen = new Set<string>();
  for (const r of v.footprints as unknown[]) {
    const row = readRow(r);
    if (row == null || seen.has(row.uuid)) return null;
    seen.add(row.uuid);
    footprints.push(row);
  }
  return { footprints, variant: v.variant, truncated: v.truncated };
}
