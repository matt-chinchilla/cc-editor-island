// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// footprint.models (PROTOCOL.md): one footprint's 3D model lines replaced as
// one undo step, through our engine's kicadFootprintSetModels (pcbjam cc/main
// 466a85a). The spike of 2026-10-27 is why an export: the engine's collab apply
// replaces a footprint by its uuid but commits SKIP_UNDO, so the reader's Undo
// could not take a model change back. The export queues a BOARD_COMMIT on the
// editor's apply coroutine and answers before it runs, so the answer here waits
// for the apply queue to empty and for the footprint's own text (the engine's
// kicadCollabTestItemBlob) to name the models sent.
import { headOf, listsOf, readSexpr, type SNode } from '../src/sexpr';

/** The engine exports the op needs: the edit, the read back, the apply queue probe. */
export const MODEL_EXPORTS = ['kicadFootprintSetModels', 'kicadCollabTestItemBlob', 'kicadCollabBusy'] as const;
/** At most this many models on one footprint. */
export const MAX_MODELS = 64;
/** The longest model path. */
export const MAX_MODEL_PATH = 1024;
/** No offset, rotation or scale component past this, in magnitude. */
export const MAX_MODEL_NUMBER = 10_000;

export type Vec3 = [number, number, number];
export interface Model { path: string; offset: Vec3; rotate: Vec3; scale: Vec3 }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(o).every((k) => allowed.includes(k));

/** An offset, rotation or scale: three finite numbers of at most MAX_MODEL_NUMBER in magnitude; `fallback` when absent. */
function vec3(v: unknown, fallback: Vec3): Vec3 | null {
  if (v === undefined) return [...fallback];
  if (!Array.isArray(v) || v.length !== 3) return null;
  if (!v.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= MAX_MODEL_NUMBER)) return null;
  return [v[0], v[1], v[2]];
}

/** footprint.models' args: `{ uuid, models }`, nothing else; null for anything else. */
export function parseModelsArgs(args: unknown): { uuid: string; models: Model[] } | null {
  if (!isObj(args) || !onlyKeys(args, ['uuid', 'models'])) return null;
  if (typeof args.uuid !== 'string' || !UUID_RE.test(args.uuid)) return null;
  if (!Array.isArray(args.models) || args.models.length > MAX_MODELS) return null;
  const models: Model[] = [];
  for (const m of args.models as unknown[]) {
    if (!isObj(m) || !onlyKeys(m, ['path', 'offset', 'rotate', 'scale'])) return null;
    if (typeof m.path !== 'string' || m.path.length === 0 || m.path.length > MAX_MODEL_PATH || CONTROL.test(m.path)) return null;
    const offset = vec3(m.offset, [0, 0, 0]);
    const rotate = vec3(m.rotate, [0, 0, 0]);
    const scale = vec3(m.scale, [1, 1, 1]);
    if (offset == null || rotate == null || scale == null) return null;
    models.push({ path: m.path, offset, rotate, scale });
  }
  return { uuid: args.uuid, models };
}

/** The list as kicadFootprintSetModels reads it: a JSON array of { path, offset, rotate, scale }. */
export const modelsJson = (models: readonly Model[]): string =>
  JSON.stringify(models.map((m) => ({ path: m.path, offset: m.offset, rotate: m.rotate, scale: m.scale })));

/** `(offset (xyz x y z))` in a model line: the three numbers, or null. */
function xyz(model: SNode[], head: string): Vec3 | null {
  const list = listsOf(model, head)[0];
  const inner = list == null ? null : listsOf(list, 'xyz')[0];
  if (inner == null || inner.length !== 4) return null;
  const n = inner.slice(1).map((v) => (typeof v === 'string' ? Number(v) : NaN));
  return n.every(Number.isFinite) ? [n[0], n[1], n[2]] : null;
}

/**
 * The model lines of a footprint's text (the engine's clipboard text of one
 * footprint), in order: null when the text is not one footprint. A line
 * without an offset, rotation or scale reads KiCad's default for it.
 */
export function readModels(text: string): Model[] | null {
  const tree = readSexpr(text);
  if (tree == null || headOf(tree) !== 'footprint') return null;
  return listsOf(tree, 'model').flatMap((m) => {
    if (typeof m[1] !== 'string') return [];
    return [{ path: m[1], offset: xyz(m, 'offset') ?? [0, 0, 0], rotate: xyz(m, 'rotate') ?? [0, 0, 0], scale: xyz(m, 'scale') ?? [1, 1, 1] }];
  });
}

/** KiCad writes a model line's numbers short (FormatDouble2Str): a component reads back within this. */
const TOLERANCE = 1e-6;
const near = (a: number, b: number): boolean => Math.abs(a - b) <= TOLERANCE * Math.max(1, Math.abs(a), Math.abs(b));
const sameVec = (a: Vec3, b: Vec3): boolean => a.every((v, i) => near(v, b[i]));

/** Whether the footprint's model lines are the ones sent, in order. */
export function sameModels(got: readonly Model[], sent: readonly Model[]): boolean {
  return got.length === sent.length && got.every((g, i) => g.path === sent[i].path && sameVec(g.offset, sent[i].offset) && sameVec(g.rotate, sent[i].rotate) && sameVec(g.scale, sent[i].scale));
}
