// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The board's 3D model lines (3D exports spec 7.1 and 8.3, PROTOCOL.md
// board.models, board.setModels and board.embedModels): the pure parts the
// unit bridge/ext/3d-i4.ts runs. Engine run 15's kicadBoardModels answers every
// footprint's model lines and the board's embedded files; kicadBoardSetModels
// replaces the lines of many footprints as ONE undo step; kicadBoardEmbedModels
// keeps the bodies of chosen lines inside the board, reading each body from a
// file the island writes into one fresh /tmp/cc-embed/<n>/. Here: the args read
// closed, the engine's read read closed, the read back rule, and the plan of
// the bodies to write (where each line's body comes from, its file name in the
// folder, the bounds), every check made before anything is written.
import { modelSource, projectRelative } from './occModels';

/** The engine exports of the three ops; kicadCollabBusy is the apply queue's probe the waits read. */
export const BOARD_MODELS_EXPORTS = ['kicadBoardModels', 'kicadBoardSetModels', 'kicadBoardEmbedModels'] as const;
export const BOARD_MODELS_WAIT = [...BOARD_MODELS_EXPORTS, 'kicadCollabBusy'] as const;
/** The cap a host gates the three ops on. */
export const BOARD_MODELS_CAP = 'boardModels';
/** The folder root kicadBoardEmbedModels reads its files from (the footprint editor's kicadFpEditEmbed rule). */
export const EMBED_ROOT = '/tmp/cc-embed';
/** The labels board.setModels pushes its undo step under. */
export const SET_LABELS: readonly string[] = ['Update model names', 'Change models'];
/** At most this many footprints or lines in one request. */
export const MAX_ITEMS = 4096;
/** At most this many model lines on one footprint; an embed index is below it. */
export const MAX_LINES = 64;
/** The longest model path. */
export const MAX_PATH = 1024;
/** One body at most 25 MiB, all of one request at most 512 MiB (the engine's own bounds). */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 512 * 1024 * 1024;

export type Vec3 = [number, number, number];
/** A model line as kicadBoardSetModels takes it (kicadBoardModels' ModelLine without `found`). */
export interface ModelLine { path: string; offset: Vec3; rotate: Vec3; scale: Vec3; opacity: number; show: boolean }
export type Found = 'embedded' | 'project' | 'staged' | 'missing';
/** One footprint of kicadBoardModels, as the island reads it. */
export interface BoardFootprint { uuid: string; ref: string; models: Array<ModelLine & { found: Found }>; kind: Record<string, unknown> }
export interface BoardModelsRead { footprints: BoardFootprint[]; embedded: Array<Record<string, unknown>> }
export interface SetModelsArgs { label: string; items: Array<{ uuid: string; models: ModelLine[] }> }
export interface EmbedModelsArgs { items: Array<{ uuid: string; index: number }> }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const LINE_KEYS = ['path', 'offset', 'rotate', 'scale', 'opacity', 'show'] as const;
const FOUND: readonly string[] = ['embedded', 'project', 'staged', 'missing'];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
};
const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
const isPath = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_PATH && !CONTROL_RE.test(v);

/** A model line read closed: exactly its six keys (`found` as well when `withFound`), null for anything else. */
export function readModelLine(v: unknown, withFound = false): (ModelLine & { found?: Found }) | null {
  if (!isObj(v) || !exactKeys(v, withFound ? [...LINE_KEYS, 'found'] : LINE_KEYS)) return null;
  const { path, offset, rotate, scale, opacity, show } = v;
  if (!isPath(path) || !isVec3(offset) || !isVec3(rotate) || !isVec3(scale)) return null;
  if (typeof opacity !== 'number' || !Number.isFinite(opacity) || opacity < 0 || opacity > 1 || typeof show !== 'boolean') return null;
  const line: ModelLine & { found?: Found } = { path, offset: [...offset] as Vec3, rotate: [...rotate] as Vec3, scale: [...scale] as Vec3, opacity, show };
  if (withFound) {
    if (typeof v.found !== 'string' || !FOUND.includes(v.found)) return null;
    line.found = v.found as Found;
  }
  return line;
}

/**
 * board.setModels' args: exactly `{ label, items }`, the label one of
 * SET_LABELS, 1 to 4,096 items of exactly `{ uuid, models }` (a lowercase
 * uuid, no footprint twice, 0 to 64 lines each read closed). Null otherwise.
 */
export function parseSetModelsArgs(args: unknown): SetModelsArgs | null {
  if (!isObj(args) || !exactKeys(args, ['label', 'items'])) return null;
  const { label, items } = args;
  if (typeof label !== 'string' || !SET_LABELS.includes(label)) return null;
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_ITEMS) return null;
  const seen = new Set<string>();
  const out: SetModelsArgs['items'] = [];
  for (const it of items as unknown[]) {
    if (!isObj(it) || !exactKeys(it, ['uuid', 'models'])) return null;
    if (typeof it.uuid !== 'string' || !UUID_RE.test(it.uuid) || seen.has(it.uuid)) return null;
    seen.add(it.uuid);
    if (!Array.isArray(it.models) || it.models.length > MAX_LINES) return null;
    const models: ModelLine[] = [];
    for (const m of it.models as unknown[]) {
      const line = readModelLine(m);
      if (line == null) return null;
      models.push(line);
    }
    out.push({ uuid: it.uuid, models });
  }
  return { label, items: out };
}

/**
 * board.embedModels' args: exactly `{ items }`, 1 to 4,096 items of exactly
 * `{ uuid, index }` (a lowercase uuid, an index 0 to 63, no line twice). Null otherwise.
 */
export function parseEmbedModelsArgs(args: unknown): EmbedModelsArgs | null {
  if (!isObj(args) || !exactKeys(args, ['items'])) return null;
  const { items } = args;
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_ITEMS) return null;
  const seen = new Set<string>();
  const out: EmbedModelsArgs['items'] = [];
  for (const it of items as unknown[]) {
    if (!isObj(it) || !exactKeys(it, ['uuid', 'index'])) return null;
    const { uuid, index } = it;
    if (typeof uuid !== 'string' || !UUID_RE.test(uuid)) return null;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= MAX_LINES) return null;
    const key = `${uuid}:${index}`;
    if (seen.has(key)) return null;
    seen.add(key);
    out.push({ uuid, index });
  }
  return { items: out };
}

/**
 * kicadBoardModels' answer read closed enough to act on: `{ footprints,
 * embedded }`, each footprint a uuid, a reference, its lines (each read
 * closed, `found` included) and its kind record; null for `""` (no board, or
 * the engine busy) and for any other shape.
 */
export function readBoardModels(text: unknown): BoardModelsRead | null {
  if (typeof text !== 'string' || text === '') return null;
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (!isObj(v) || !exactKeys(v, ['footprints', 'embedded']) || !Array.isArray(v.footprints) || !Array.isArray(v.embedded)) return null;
  const footprints: BoardFootprint[] = [];
  for (const f of v.footprints as unknown[]) {
    if (!isObj(f) || typeof f.uuid !== 'string' || typeof f.ref !== 'string' || !Array.isArray(f.models) || !isObj(f.kind)) return null;
    const models: BoardFootprint['models'] = [];
    for (const m of f.models as unknown[]) {
      const line = readModelLine(m, true);
      if (line == null) return null;
      models.push(line as ModelLine & { found: Found });
    }
    footprints.push({ uuid: f.uuid, ref: f.ref, models, kind: f.kind });
  }
  if (!(v.embedded as unknown[]).every(isObj)) return null;
  return { footprints, embedded: v.embedded as Array<Record<string, unknown>> };
}

/** KiCad writes a model line's numbers short: a component reads back within this. */
const TOLERANCE = 1e-6;
const near = (a: number, b: number): boolean => Math.abs(a - b) <= TOLERANCE * Math.max(1, Math.abs(a), Math.abs(b));
const sameVec = (a: Vec3, b: Vec3): boolean => a.every((v, i) => near(v, b[i]));

/** Whether a footprint's lines are the ones sent, in order (`found` ignored). */
export function sameLines(got: readonly ModelLine[], sent: readonly ModelLine[]): boolean {
  return got.length === sent.length && got.every((g, i) => {
    const s = sent[i];
    return g.path === s.path && sameVec(g.offset, s.offset) && sameVec(g.rotate, s.rotate) && sameVec(g.scale, s.scale) && near(g.opacity, s.opacity) && g.show === s.show;
  });
}

/** The footprints of a read by uuid. */
export const footprintsByUuid = (read: BoardModelsRead): Map<string, BoardFootprint> => new Map(read.footprints.map((f) => [f.uuid, f]));

/**
 * The items of a set that read back as sent, and of those, how many differ
 * from what `before` held (the lines the request changed).
 */
export function readBack(before: BoardModelsRead, after: BoardModelsRead, items: SetModelsArgs['items']): { matched: number; changed: number } {
  const was = footprintsByUuid(before);
  const now = footprintsByUuid(after);
  let matched = 0;
  let changed = 0;
  for (const it of items) {
    const got = now.get(it.uuid);
    if (got == null || !sameLines(got.models, it.models)) continue;
    matched += 1;
    const old = was.get(it.uuid);
    if (old == null || !sameLines(old.models, it.models)) changed += 1;
  }
  return { matched, changed };
}

/** Where one line's body is read from: the model store (a library line), the project folder, with a STEP sibling as `alt` for VRML. */
export type BodySource = { kind: 'library'; ref: string } | { kind: 'project'; rel: string; alt: string | null };
/** One line to embed: its footprint and index, the line's names, and where its body comes from. */
export interface EmbedLine { uuid: string; index: number; ref: string; path: string; source: BodySource }

/** The name a refusal gives a line: its reference and its path, or its uuid and index when the board has no such line. */
export const lineName = (uuid: string, index: number, fp?: BoardFootprint): string => {
  const line = fp?.models[index];
  return fp == null || line == null ? `${uuid} line ${index}` : `${fp.ref} ${line.path}`;
};

const VRML_RE = /\.wrl$/i;
const stemOf = (p: string): string => p.replace(/\.[^./]*$/, '');

/**
 * The plan of the lines to embed, read against the board: each item must name
 * a line the board has, not inside the board already and not missing; its
 * body comes from the model store (a library line) or the project folder (a
 * project line; for a VRML line its STEP sibling, `.step` or `.stp`, as
 * `alt` when the project holds one, `exists` saying so). Answers the first
 * line refused by its name, or the plan.
 */
export function planEmbed(read: BoardModelsRead, items: EmbedModelsArgs['items'], exists: (rel: string) => boolean): { refused: string } | { lines: EmbedLine[] } {
  const fps = footprintsByUuid(read);
  const lines: EmbedLine[] = [];
  for (const { uuid, index } of items) {
    const fp = fps.get(uuid);
    const line = fp?.models[index];
    if (fp == null || line == null || line.found === 'embedded' || line.found === 'missing') return { refused: lineName(uuid, index, fp) };
    const s = modelSource(line.path);
    if (s.kind === 'library') {
      lines.push({ uuid, index, ref: fp.ref, path: line.path, source: { kind: 'library', ref: line.path } });
    } else if (s.kind === 'project') {
      let alt: string | null = null;
      if (VRML_RE.test(s.rel)) alt = [`${stemOf(s.rel)}.step`, `${stemOf(s.rel)}.stp`].find((r) => exists(r)) ?? null;
      lines.push({ uuid, index, ref: fp.ref, path: line.path, source: { kind: 'project', rel: s.rel, alt } });
    } else {
      return { refused: lineName(uuid, index, fp) };
    }
  }
  return { lines };
}

/**
 * The file names of the bodies in one embed folder: each body (by `key`)
 * keeps its own file name, and a second body of the same name takes `-2`,
 * `-3` and on before its extension, so no name in the folder is given twice.
 */
export class FolderNames {
  private readonly byKey = new Map<string, string>();
  private readonly used = new Set<string>();

  nameOf(key: string, path: string): string {
    const had = this.byKey.get(key);
    if (had != null) return had;
    const base = path.slice(path.replace(/\\/g, '/').lastIndexOf('/') + 1) || 'model';
    const dot = base.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ''];
    let name = base;
    for (let n = 2; this.used.has(name.toLowerCase()); n++) name = `${stem}-${n}${ext}`;
    this.used.add(name.toLowerCase());
    this.byKey.set(key, name);
    return name;
  }
}

/** A project relative path read for the project folder (bridge/occModels.ts projectRelative), re-exported for the unit. */
export { projectRelative };

/** kicadBoardEmbedModels' answer read closed: `{ embedded, names, bytes }`; null for `""` (refused) or any other shape. */
export function readEmbedAnswer(text: unknown): { embedded: number; names: string[]; bytes: number } | null {
  if (typeof text !== 'string' || text === '') return null;
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (!isObj(v) || !exactKeys(v, ['embedded', 'names', 'bytes'])) return null;
  const { embedded, names, bytes } = v;
  const count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  if (!count(embedded) || !count(bytes) || !Array.isArray(names) || !names.every((s) => typeof s === 'string')) return null;
  return { embedded, names: [...(names as string[])], bytes };
}
