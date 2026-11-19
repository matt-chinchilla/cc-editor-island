// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-len-e-i (PROTOCOL.md board.nets): the board's nets with their lengths,
// read in a pcb frame by our engine's run 15 export kicadNetReport (unit
// st-len-e-e) with no KiCad window. Each row holds the figures of KiCad's own
// Net Inspector (LENGTH_DELAY_CALCULATION with the inspector's optimizations:
// vias, merged tracks, tracks inside pads trimmed), so a length is KiCad's
// routed length and not the plain sum of the segments. A read: answered during
// a check. Feature detected: on an engine without the export the cap
// netReport is not listed and the op answers unsupported naming it.
import { fail, hasAll, isObj, noArgs, ok, refused, type Answer, type ExtUnit, type ResponderCtx } from './contract';

/** The engine export the read needs (a synchronous read of the board's connectivity). */
export const NET_EXPORTS = ['kicadNetReport'] as const;
/** The cap a host gates its Lengths door on. */
export const NET_CAP = 'netReport';
/** At most this many names in one request (the engine's bound). */
export const NAMES_MAX = 8192;
/** A name: 1 to 1,024 UTF-8 bytes (the engine's bound). */
export const NAME_MAX_BYTES = 1024;
const OP = 'board.nets';
const FRAME_REFUSAL = 'a board op runs in a pcb frame';
const TEXT_MAX_BYTES = 4096;

export interface LayerLength { layer: string; length: number }
/** One net's figures (mm; delay in picoseconds, null when the board gives no delay). */
export interface NetLengthRow {
  name: string;
  netClass: string;
  length: number;
  byLayer: LayerLength[];
  vias: number;
  viaLength: number;
  pads: number;
  dieLength: number;
  delay: number | null;
}

const ROW_KEYS = ['name', 'netClass', 'length', 'byLayer', 'vias', 'viaLength', 'pads', 'dieLength', 'delay'] as const;
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
};
const utf8Bytes = (s: string): number => new TextEncoder().encode(s).byteLength;
const isText = (v: unknown, maxBytes: number): v is string => typeof v === 'string' && !v.includes('\0') && utf8Bytes(v) <= maxBytes;
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isMeasure = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * board.nets' args: none (every net but the unconnected one, in KiCad's net
 * code order), or exactly `{ nets }`, 1 to 8,192 names of 1 to 1,024 UTF-8
 * bytes each (a name matches the board's stored name or its unescaped form; a
 * name the board lacks is left out of the answer). Answers the names to send,
 * null for no names, or 'bad' for anything else.
 */
export function parseNetsArgs(args: unknown): string[] | null | 'bad' {
  if (noArgs(args)) return null;
  if (!isObj(args) || !exactKeys(args, ['nets'])) return 'bad';
  const n = args.nets;
  if (!Array.isArray(n) || n.length < 1 || n.length > NAMES_MAX) return 'bad';
  for (const name of n) {
    if (typeof name !== 'string' || name.length === 0 || name.includes('\0') || utf8Bytes(name) > NAME_MAX_BYTES) return 'bad';
  }
  return [...n] as string[];
}

/** One row of the engine's answer read closed, or null. */
export function readNetRow(v: unknown): NetLengthRow | null {
  if (!isObj(v) || !exactKeys(v, ROW_KEYS)) return null;
  const { name, netClass, length, byLayer, vias, viaLength, pads, dieLength, delay } = v;
  if (!isText(name, TEXT_MAX_BYTES) || name === '' || !isText(netClass, TEXT_MAX_BYTES)) return null;
  if (!isMeasure(length) || !isMeasure(viaLength) || !isMeasure(dieLength) || !isCount(vias) || !isCount(pads)) return null;
  if (delay !== null && !(typeof delay === 'number' && Number.isFinite(delay))) return null;
  if (!Array.isArray(byLayer)) return null;
  const layers: LayerLength[] = [];
  for (const l of byLayer) {
    if (!isObj(l) || !exactKeys(l, ['layer', 'length'])) return null;
    if (!isText(l.layer, TEXT_MAX_BYTES) || l.layer === '' || !isMeasure(l.length)) return null;
    layers.push({ layer: l.layer, length: l.length });
  }
  return { name, netClass, length, byLayer: layers, vias, viaLength, pads, dieLength, delay };
}

/** kicadNetReport's answer read closed: exactly `{ nets: NetLengthRow[] }`, null for any other shape (a net twice included). */
export function readNetReport(raw: unknown): NetLengthRow[] | null {
  if (typeof raw !== 'string') return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!isObj(v) || !exactKeys(v, ['nets']) || !Array.isArray(v.nets)) return null;
  const rows: NetLengthRow[] = [];
  const seen = new Set<string>();
  for (const r of v.nets) {
    const row = readNetRow(r);
    if (row == null || seen.has(row.name)) return null;
    seen.add(row.name);
    rows.push(row);
  }
  return rows;
}

/**
 * board.nets: the checks in order (the args, the frame, the engine, a board
 * open, busy), then one call of kicadNetReport. The engine answers "" while
 * an open is in flight or the board has no connectivity yet: that is busy.
 */
function nets(args: unknown, ctx: ResponderCtx): Answer {
  const names = parseNetsArgs(args);
  if (names === 'bad') return fail('bad_args', OP);
  const g = ctx.boardGate(OP, NET_EXPORTS);
  if (refused(g)) return g;
  let raw: unknown;
  try {
    raw = (g.mod.kicadNetReport as (json: string) => unknown)(JSON.stringify(names == null ? {} : { nets: names }));
  } catch {
    return fail('island_error', 'the engine could not read the nets');
  }
  if (raw === '') return fail('busy', OP);
  const rows = readNetReport(raw);
  if (rows == null) return fail('island_error', 'the engine answered nets of another shape');
  return ok({ nets: rows });
}

export default {
  unit: 'st-len-e-i',
  frames: ['pcb'],
  frameRefusal: FRAME_REFUSAL,
  capNames: [NET_CAP],
  caps: (mod, frame) => (frame === 'pcb' && hasAll(mod, NET_EXPORTS) ? [NET_CAP] : []),
  ops: {
    'board.nets': { run: nets, passesCheck: true },
  },
} satisfies ExtUnit;
