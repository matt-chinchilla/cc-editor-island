// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-mw-i (PROTOCOL.md microwave.arm): the values of KiCad's microwave tools
// given before the press, so Gap, Stub, Arc stub, Line and Shape place with no
// KiCad window. Our engine's run 15 export kicadMicrowaveArm (unit st-mw-e)
// holds ONE pending arm; the start of any microwave action consumes it and only
// a matching shape uses it, and the tool ends after one placement. The host
// arms, then presses the row's chord (key.press), as the pencil case does.
// Feature detected: on an engine without the export the cap microwave is not
// listed and the op answers unsupported naming it.
import { fail, hasAll, isObj, ok, refused, type Answer, type ExtUnit, type ResponderCtx } from './contract';

/** The engine export the arm needs. */
export const MICROWAVE_EXPORTS = ['kicadMicrowaveArm'] as const;
/** The cap a host gates its Microwave rows on. */
export const MICROWAVE_CAP = 'microwave';
/** The engine's bounds: a value over 0 and at most 500 mm, an angle 0 to 180 degrees. */
export const VALUE_MAX_MM = 500;
export const ANGLE_MAX_DEG = 180;
/** A shape file: 2 to 2,048 points, each size component nonzero and at most 500 mm, every point times the size within 1,000 mm. */
export const POINTS_MIN = 2;
export const POINTS_MAX = 2048;
export const SIZE_MAX_MM = 500;
export const EXTENT_MAX_MM = 1000;
export const POLYGON_KINDS = ['plain', 'symmetrical', 'mirrored'] as const;
const OP = 'microwave.arm';
const FRAME_REFUSAL = 'a board op runs in a pcb frame';

export type PolygonKind = typeof POLYGON_KINDS[number];
/** One arm, as the engine takes it. `polygon.points` are the shape file's fractions, `size` the scale in mm. */
export type MicrowaveArm =
  | { shape: 'line' | 'gap' | 'stub'; value: number }
  | { shape: 'arcStub'; value: number; angle?: number }
  | { shape: 'polygon'; polygon: { points: Array<[number, number]>; kind: PolygonKind; size: [number, number] } };

const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
};
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isValue = (v: unknown): v is number => isNum(v) && v > 0 && v <= VALUE_MAX_MM;
const isPair = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]);

/**
 * microwave.arm's args read closed, the engine's own bounds: `{ shape, value }`
 * for line, gap and stub; `{ shape: 'arcStub', value, angle? }`; `{ shape:
 * 'polygon', polygon: { points, kind, size } }`. Answers the arm to send, or
 * null for anything else (an extra key, a wrong type, a bound broken).
 */
export function parseArm(args: unknown): MicrowaveArm | null {
  if (!isObj(args)) return null;
  const shape = args.shape;
  if (shape === 'line' || shape === 'gap' || shape === 'stub') {
    if (!exactKeys(args, ['shape', 'value']) || !isValue(args.value)) return null;
    return { shape, value: args.value };
  }
  if (shape === 'arcStub') {
    const withAngle = Object.prototype.hasOwnProperty.call(args, 'angle');
    if (!exactKeys(args, withAngle ? ['shape', 'value', 'angle'] : ['shape', 'value']) || !isValue(args.value)) return null;
    if (!withAngle) return { shape, value: args.value };
    const angle = args.angle;
    if (!isNum(angle) || angle < 0 || angle > ANGLE_MAX_DEG) return null;
    return { shape, value: args.value, angle };
  }
  if (shape === 'polygon') {
    if (!exactKeys(args, ['shape', 'polygon'])) return null;
    const p = args.polygon;
    if (!isObj(p) || !exactKeys(p, ['points', 'kind', 'size'])) return null;
    const { points, kind, size } = p;
    if (typeof kind !== 'string' || !(POLYGON_KINDS as readonly string[]).includes(kind)) return null;
    if (!isPair(size) || size.some((s) => s === 0 || Math.abs(s) > SIZE_MAX_MM)) return null;
    if (!Array.isArray(points) || points.length < POINTS_MIN || points.length > POINTS_MAX) return null;
    const read: Array<[number, number]> = [];
    for (const pt of points) {
      if (!isPair(pt)) return null;
      if (Math.abs(pt[0] * size[0]) > EXTENT_MAX_MM || Math.abs(pt[1] * size[1]) > EXTENT_MAX_MM) return null;
      read.push([pt[0], pt[1]]);
    }
    return { shape, polygon: { points: read, kind: kind as PolygonKind, size: [size[0], size[1]] } };
  }
  return null;
}

/**
 * microwave.arm: the checks in order (the args, the frame, the engine, a board
 * open, busy), then one call of kicadMicrowaveArm. The engine answers false
 * when it cannot arm now (an open in flight, a dialog showing): that is busy,
 * and its earlier arm stands.
 */
function arm(args: unknown, ctx: ResponderCtx): Answer {
  const a = parseArm(args);
  if (a == null) return fail('bad_args', OP);
  const g = ctx.boardGate(OP, MICROWAVE_EXPORTS);
  if (refused(g)) return g;
  let armed: unknown;
  try {
    armed = (g.mod.kicadMicrowaveArm as (json: string) => unknown)(JSON.stringify(a));
  } catch {
    return fail('island_error', 'the engine could not arm the microwave tool');
  }
  if (armed === true) return ok({});
  if (armed === false) return fail('busy', OP);
  return fail('island_error', 'the engine answered the arm with another shape');
}

export default {
  unit: 'st-mw-i',
  frames: ['pcb'],
  frameRefusal: FRAME_REFUSAL,
  capNames: [MICROWAVE_CAP],
  caps: (mod, frame) => (frame === 'pcb' && hasAll(mod, MICROWAVE_EXPORTS) ? [MICROWAVE_CAP] : []),
  ops: {
    'microwave.arm': { run: arm },
  },
} satisfies ExtUnit;
