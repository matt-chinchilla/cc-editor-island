// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// 3d-i4 (PROTOCOL.md board.models, board.setModels and board.embedModels): the
// board's 3D model lines for the host's Models window, through engine run 15's
// kicadBoardModels, kicadBoardSetModels and kicadBoardEmbedModels (unit 3d-e5).
// board.models answers the engine's read; board.setModels replaces the lines of
// many footprints as ONE undo step and answers once the lines read back as
// sent; board.embedModels reads each chosen line's body itself (a library line
// through the model store, a project line from the project folder, a VRML
// line's STEP sibling as alt), writes the bodies into one fresh
// /tmp/cc-embed/<n>/ and has the engine keep them inside the board. Every
// check is made before anything is written. KiCad's own Update 3D model paths
// and Embed 3D models are held so the host opens its Models window. Feature
// detected: on an engine without the three exports the cap is not listed and
// each op answers unsupported naming the export.
import {
  BOARD_MODELS_CAP, BOARD_MODELS_EXPORTS, BOARD_MODELS_WAIT, EMBED_ROOT, FolderNames, MAX_FILE_BYTES, MAX_TOTAL_BYTES, parseEmbedModelsArgs, parseSetModelsArgs,
  planEmbed, readBack, readBoardModels, readEmbedAnswer, type BoardModelsRead, type EmbedLine,
} from '../boardModels';
import { fail, hasAll, noArgs, ok, refused, type Answer, type ExtUnit, type HeldRow, type ResponderCtx } from './contract';

export const UNIT = '3d-i4';
/** KiCad's Update 3D model paths and Embed 3D models, held in a pcb frame: the host's Models window opens in their place. */
export const MIGRATE_MODELS = 'pcbnew.GlobalEdit.migrate3DModels';
export const COLLECT_MODELS = 'pcbnew.EditorControl.collect3DModels';
export const HELD_ROWS: readonly HeldRow[] = Object.freeze([
  Object.freeze({ action: MIGRATE_MODELS, frames: Object.freeze(['pcb'] as const), cap: BOARD_MODELS_CAP }),
  Object.freeze({ action: COLLECT_MODELS, frames: Object.freeze(['pcb'] as const), cap: BOARD_MODELS_CAP }),
]);
/** The bound of one set or embed when the bridge's timing names none. */
export const BOARD_MODELS_MS = 30_000;
const FRAME_REFUSAL = 'the board\'s models are read in a pcb frame';

/** A model store body: the store file's path (its real extension) and its bytes (loader/src/wasm/libs/model-store.ts ensureModel). */
export interface StoreBody { path: string; bytes: Uint8Array }
export interface UnitDeps {
  /** The model store's ensureModel (3d-i2), null on an island without the model store. */
  ensure: () => ((ref: string) => Promise<StoreBody | null>) | null;
}

/** The model store's module (3d-i2), found by glob: absent on an island without it. */
export const MODEL_STORE = import.meta.glob<{ ensureModel?: unknown }>('../../loader/src/wasm/libs/model-store.ts', { eager: true });
export function storeEnsure(store: Record<string, { ensureModel?: unknown }> = MODEL_STORE): ((ref: string) => Promise<StoreBody | null>) | null {
  const mod = Object.values(store)[0];
  if (mod == null || typeof mod.ensureModel !== 'function') return null;
  const ensure = mod.ensureModel as (ref: string) => Promise<unknown>;
  return async (ref) => {
    let got: unknown;
    try { got = await ensure(ref); } catch { return null; }
    if (got == null || typeof got !== 'object') return null;
    const { path, bytes } = got as { path?: unknown; bytes?: unknown };
    return typeof path === 'string' && bytes instanceof Uint8Array ? { path, bytes } : null;
  };
}

const timeOf = (ctx: ResponderCtx): number => ctx.timing.boardModelsMs ?? BOARD_MODELS_MS;
const pollOf = (ctx: ResponderCtx): number => ctx.timing.applyPollMs ?? 50;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The engine's read now: the record, or null (`""`: no board or busy; another shape). */
function readNow(mod: Record<string, unknown>): BoardModelsRead | null {
  try { return readBoardModels((mod.kicadBoardModels as () => unknown)()); } catch { return null; }
}

/** The project folder: the open board's folder, else the root. */
function projectDirOf(ctx: ResponderCtx): string {
  const opened = ctx.opened();
  return opened != null && opened.includes('/') ? opened.slice(0, opened.lastIndexOf('/')) : ctx.root;
}

/** board.models: the engine's read as it is. */
function models(args: unknown, ctx: ResponderCtx): Answer {
  const op = 'board.models';
  if (!noArgs(args)) return fail('bad_args', op);
  const g = ctx.boardGate(op, BOARD_MODELS_EXPORTS);
  if (refused(g)) return g;
  let text: unknown;
  try { text = (g.mod.kicadBoardModels as () => unknown)(); } catch (err) { return fail('island_error', err instanceof Error ? err.message : String(err)); }
  if (text === '') return fail('busy', op);
  const read = readBoardModels(text);
  if (read == null) return fail('island_error', 'the engine answered models of another shape');
  return ok({ footprints: read.footprints, embedded: read.embedded });
}

/**
 * board.setModels: the checks (bad_args, the board gate, every uuid a
 * footprint's: not_found naming the first other), then ONE queued commit, and
 * the answer once the apply queue is empty and every footprint's lines read
 * back as sent: `{ changed }`, the footprints whose lines the request changed.
 * The responder's own ev.edited reports the new undo step.
 */
async function setModels(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const op = 'board.setModels';
  const a = parseSetModelsArgs(args);
  if (a == null) return fail('bad_args', op);
  const g = ctx.boardGate(op, BOARD_MODELS_WAIT);
  if (refused(g)) return g;
  const before = readNow(g.mod);
  if (before == null) return fail('busy', op);
  const have = new Set(before.footprints.map((f) => f.uuid));
  const missing = a.items.find((it) => !have.has(it.uuid));
  if (missing != null) return fail('not_found', missing.uuid);
  let queued: unknown;
  try { queued = (g.mod.kicadBoardSetModels as (json: string) => unknown)(JSON.stringify(a)); } catch (err) { return fail('island_error', err instanceof Error ? err.message : String(err)); }
  if (queued !== true) return fail('not_applied', op);
  const deadline = Date.now() + timeOf(ctx);
  let last: { matched: number; changed: number } | null = null;
  for (;;) {
    if (ctx.closed()) return fail('island_error', 'the frame closed');
    if (await ctx.applyIdle(Math.max(0, deadline - Date.now()))) {
      const after = readNow(g.mod);
      if (after != null) {
        last = readBack(before, after, a.items);
        if (last.matched === a.items.length) break;
      }
    }
    if (Date.now() >= deadline) {
      // A footprint gone by apply time pushes nothing: what did read back is the answer.
      if (last != null && last.matched > 0) break;
      return fail('not_applied', op);
    }
    await sleep(pollOf(ctx));
  }
  ctx.log(op, a.label, `${a.items.length} footprints`, `${last.changed} changed`);
  return ok({ changed: last.changed });
}

/** A file of the engine's file system as bytes, null when absent or unreadable. */
function fileBytes(ctx: ResponderCtx, abs: string): Uint8Array | null {
  try { return ctx.readBytes(abs); } catch { return null; }
}

interface Body { key: string; name: string; bytes: Uint8Array }

/**
 * Reads every planned line's body before anything is written: a library line
 * through the model store, a project line from the project folder (a VRML
 * line whose own file is absent reads its STEP sibling in its place). Each
 * body at most 25 MiB, all at most 512 MiB. Answers the first refusal, or the
 * engine's items with each body's folder file name and the distinct bodies.
 */
async function readBodies(lines: readonly EmbedLine[], ctx: ResponderCtx, deps: UnitDeps): Promise<Answer | { items: Array<{ uuid: string; index: number; file: string; alt?: string }>; bodies: Body[] }> {
  const op = 'board.embedModels';
  const projectDir = projectDirOf(ctx).replace(/\/+$/, '');
  const names = new FolderNames();
  const bodies = new Map<string, Body>();
  let total = 0;
  const ensure = deps.ensure();
  const add = (key: string, path: string, bytes: Uint8Array, line: EmbedLine): Answer | string => {
    const had = bodies.get(key);
    if (had != null) return had.name;
    if (bytes.byteLength === 0) return fail('bad_args', `${line.ref} ${line.path}`);
    if (bytes.byteLength > MAX_FILE_BYTES) return fail('too_large', `${line.ref} ${line.path}`);
    total += bytes.byteLength;
    if (total > MAX_TOTAL_BYTES) return fail('too_large', op);
    const body = { key, name: names.nameOf(key, path), bytes };
    bodies.set(key, body);
    return body.name;
  };
  const items: Array<{ uuid: string; index: number; file: string; alt?: string }> = [];
  const cache = new Map<string, Uint8Array | null>();
  const project = (rel: string): Uint8Array | null => {
    if (!cache.has(rel)) cache.set(rel, fileBytes(ctx, `${projectDir}/${rel}`));
    return cache.get(rel) ?? null;
  };
  for (const line of lines) {
    let file: string;
    let alt: string | undefined;
    if (line.source.kind === 'library') {
      const got = ensure == null ? null : await ensure(line.source.ref);
      if (got == null) return fail('bad_args', `${line.ref} ${line.path}`);
      const f = add(`library:${got.path}`, got.path, got.bytes, line);
      if (typeof f !== 'string') return f;
      file = f;
    } else {
      const { rel, alt: altRel } = line.source;
      let own = project(rel);
      let ownRel = rel;
      let altBytes = altRel == null ? null : project(altRel);
      if (own == null && altRel != null && altBytes != null) { own = altBytes; ownRel = altRel; altBytes = null; }
      if (own == null) return fail('bad_args', `${line.ref} ${line.path}`);
      const f = add(`project:${ownRel}`, ownRel, own, line);
      if (typeof f !== 'string') return f;
      file = f;
      if (altBytes != null && altRel != null) {
        const s = add(`project:${altRel}`, altRel, altBytes, line);
        if (typeof s !== 'string') return s;
        alt = s;
      }
    }
    items.push(alt == null ? { uuid: line.uuid, index: line.index, file } : { uuid: line.uuid, index: line.index, file, alt });
  }
  return { items, bodies: [...bodies.values()] };
}

/**
 * board.embedModels: the checks (bad_args, the board gate, each line on the
 * board, not inside it already, not missing, its body read and within the
 * bounds), then the bodies written into one fresh /tmp/cc-embed/<n>/ and the
 * engine's one commit queued; the answer `{ embedded, names, bytes }` once the
 * apply queue is empty. The folder is removed after every answer.
 */
async function embedModels(args: unknown, ctx: ResponderCtx, deps: UnitDeps): Promise<Answer> {
  const op = 'board.embedModels';
  const a = parseEmbedModelsArgs(args);
  if (a == null) return fail('bad_args', op);
  const g = ctx.boardGate(op, BOARD_MODELS_WAIT);
  if (refused(g)) return g;
  const read = readNow(g.mod);
  if (read == null) return fail('busy', op);
  const projectDir = projectDirOf(ctx).replace(/\/+$/, '');
  const plan = planEmbed(read, a.items, (rel) => fileBytes(ctx, `${projectDir}/${rel}`) != null);
  if ('refused' in plan) return fail('bad_args', plan.refused);
  const got = await readBodies(plan.lines, ctx, deps);
  if ('ok' in got) return got;
  const FS = ctx.fs();
  if (FS == null) return fail('island_error', 'the engine has no file system');
  let dir: string | null = null;
  try {
    const items = (() => {
      dir = ctx.freshRunFolder(EMBED_ROOT);
      for (const b of got.bodies) FS.writeFile(`${dir}/${b.name}`, b.bytes);
      return got.items.map((it) => (it.alt == null ? { ...it, file: `${dir}/${it.file}` } : { ...it, file: `${dir}/${it.file}`, alt: `${dir}/${it.alt}` }));
    })();
    let text: unknown;
    try { text = (g.mod.kicadBoardEmbedModels as (json: string) => unknown)(JSON.stringify({ items })); } catch (err) { return fail('island_error', err instanceof Error ? err.message : String(err)); }
    const answer = readEmbedAnswer(text);
    if (answer == null) return text === '' ? fail('not_applied', op) : fail('island_error', 'the engine answered an embedding of another shape');
    // The answer is given when the work is queued: it is the reader's once the apply queue is empty.
    if (!(await ctx.applyIdle(timeOf(ctx)))) return fail('not_applied', op);
    ctx.log(op, `${answer.embedded} embedded`, `${answer.bytes} bytes`);
    return ok({ embedded: answer.embedded, names: answer.names, bytes: answer.bytes });
  } catch (err) {
    return fail('island_error', err instanceof Error ? err.message : String(err));
  } finally {
    if (dir != null) ctx.dropRunFolder(dir);
  }
}

/** The unit, its sources given (the tests give their own). */
export function unitOf(deps: UnitDeps): ExtUnit {
  return {
    unit: UNIT,
    frames: ['pcb'],
    frameRefusal: FRAME_REFUSAL,
    capNames: [BOARD_MODELS_CAP],
    caps: (mod, frame) => (frame === 'pcb' && hasAll(mod, BOARD_MODELS_EXPORTS) ? [BOARD_MODELS_CAP] : []),
    held: [MIGRATE_MODELS, COLLECT_MODELS],
    heldRows: [...HELD_ROWS],
    ops: {
      'board.models': { passesCheck: true, run: models },
      'board.setModels': { run: setModels },
      'board.embedModels': { run: (args, ctx) => embedModels(args, ctx, deps) },
    },
  };
}

export default unitOf({ ensure: () => storeEnsure() }) satisfies ExtUnit;
