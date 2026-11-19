// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// A board item's corners (the canvas commands addendum 6.1, KiCad's vertex
// editor pane read and written one corner at a time), as engine run 15's
// kicadBoardVerticesGet and kicadBoardVerticesSet answer them (unit m3-e3):
// the args of board.vertices.get and board.vertices.set checked closed, and
// the engine's record read closed. Pure: no window, no engine.
import { POSITION_MAX_MM, UUID_RE } from '../../symbol';

/** The kinds of an item with corners: a copper zone, a zone on no copper layer, a rule area, a polygon shape. */
export const VERTEX_KINDS = ['copper', 'nonCopper', 'ruleArea', 'polygon'] as const;
export type VertexKind = (typeof VERTEX_KINDS)[number];
/** A record lists at most this many outlines with their holes, and at most this many corners in all. */
export const OUTLINES_MAX = 4096;
export const POINTS_MAX = 262_144;
/** KiCad keeps a corner in whole nanometers: a corner read back is the one sent within this (mm). */
export const CORNER_SLACK_MM = 0.000_001 + 1e-9;

export interface Corner { x: number; y: number }
/** One closed line of the item: `hole` -1 for an outline itself, else the hole's index in that outline. */
export interface VertexLine { outline: number; hole: number; points: Corner[] }
export interface VertexRecord { uuid: string; kind: VertexKind; outlines: VertexLine[] }
export interface VertexSet { uuid: string; outline: number; hole: number; index: number; x: number; y: number }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exact = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const k = Object.keys(o);
  return k.length === keys.length && keys.every((x) => k.includes(x));
};
const isCount = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const isPos = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= POSITION_MAX_MM;
/** A uuid as the host may write it, lowercased; null for anything else. */
const uuidOf = (v: unknown): string | null => (typeof v === 'string' && UUID_RE.test(v.toLowerCase()) ? v.toLowerCase() : null);

/** board.vertices.get's args: exactly `{ uuid }`; null for any other shape. */
export function parseVerticesGet(args: unknown): { uuid: string } | null {
  if (!isObj(args) || !exact(args, ['uuid'])) return null;
  const uuid = uuidOf(args.uuid);
  return uuid == null ? null : { uuid };
}

/** board.vertices.set's args: exactly `{ uuid, outline, hole, index, x, y }` (mm); null for any other shape. */
export function parseVerticesSet(args: unknown): VertexSet | null {
  if (!isObj(args) || !exact(args, ['uuid', 'outline', 'hole', 'index', 'x', 'y'])) return null;
  const uuid = uuidOf(args.uuid);
  const { outline, hole, index, x, y } = args;
  if (uuid == null || !isCount(outline, 0, OUTLINES_MAX) || !isCount(hole, -1, OUTLINES_MAX) || !isCount(index, 0, POINTS_MAX)) return null;
  if (!isPos(x) || !isPos(y)) return null;
  return { uuid, outline, hole, index, x, y };
}

/**
 * The engine's record, JSON text: `{ uuid, kind, outlines: [{ outline, hole,
 * points: [{ x, y }] }] }`, the uuid the one asked, each line at least three
 * corners, the lines in the engine's order (each outline then its holes).
 * Null for "" (the engine's answer for no such item) and any other shape.
 */
export function readVertices(text: unknown, asked: string): VertexRecord | null {
  if (typeof text !== 'string' || text === '') return null;
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (!isObj(v) || !exact(v, ['uuid', 'kind', 'outlines']) || v.uuid !== asked) return null;
  if (typeof v.kind !== 'string' || !(VERTEX_KINDS as readonly string[]).includes(v.kind)) return null;
  if (!Array.isArray(v.outlines) || v.outlines.length > OUTLINES_MAX) return null;
  const outlines: VertexLine[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const o of v.outlines) {
    if (!isObj(o) || !exact(o, ['outline', 'hole', 'points'])) return null;
    if (!isCount(o.outline, 0, OUTLINES_MAX) || !isCount(o.hole, -1, OUTLINES_MAX) || !Array.isArray(o.points) || o.points.length < 3) return null;
    const key = `${o.outline} ${o.hole}`;
    if (seen.has(key)) return null;
    seen.add(key);
    total += o.points.length;
    if (total > POINTS_MAX) return null;
    const points: Corner[] = [];
    for (const p of o.points) {
      if (!isObj(p) || !exact(p, ['x', 'y']) || !isPos(p.x) || !isPos(p.y)) return null;
      points.push({ x: p.x, y: p.y });
    }
    outlines.push({ outline: o.outline, hole: o.hole, points });
  }
  return { uuid: v.uuid, kind: v.kind as VertexKind, outlines };
}

/** The line a set names, null when the record holds none. */
export const lineOf = (r: VertexRecord, outline: number, hole: number): VertexLine | null =>
  r.outlines.find((l) => l.outline === outline && l.hole === hole) ?? null;

/** Whether the record holds the set's corner at the set's place (KiCad's nanometers). */
export function cornerAt(r: VertexRecord, s: VertexSet): boolean {
  const p = lineOf(r, s.outline, s.hole)?.points[s.index];
  return p != null && Math.abs(p.x - s.x) <= CORNER_SLACK_MM && Math.abs(p.y - s.y) <= CORNER_SLACK_MM;
}
