// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// i-block-place (PROTOCOL.md block.place): a design block's files, as the page
// keeps them, placed into the open design by KiCad's own placement with no
// KiCad window: the block hangs off the pointer, a press puts it down as ONE
// undo step, Escape drops it, and one block hangs at a time.
//
// Engine run 15 (units e-block-place, lane e7, and e-block-place-sch, lane e8)
// adds kicadDesignBlockPlace(json): exactly { dir, name, asSheet,
// keepAnnotations, asGroup } plus the optional nickname (RULINGS 26), dir a
// run folder under /tmp/cc-block/ holding <name>.kicad_block/. The block is
// read at once; false when it cannot be read or holds no file for the frame.
// Then on the apply coroutine KiCad's placeDesignBlock runs with the host's
// block: the contents (a board's layout, or a schematic's items) are selected
// and hang off the pointer; a schematic block placed as a sheet hangs as the
// sheet's box, which is in no selection, and its press copies the block's
// schematic beside the project from the run folder. So the folder of a
// contents placement is removed once the items hang, and the folder of a
// sheet placement stays until the next block.place (whose fresh run folder
// clears it). Feature detected: on an engine without the export (run 14) the
// op answers unsupported naming it and the cap blocks is not listed.
import { fail, hasAll, isObj, ok, type Answer, type ExtUnit, type ResponderCtx } from './contract';
import { isBlockName } from './i-block-save';
import { ESCAPE } from '../place';

/** What the op needs of the engine: the placement, the selection it reads, the apply queue probe. */
export const BLOCK_PLACE_EXPORTS = ['kicadDesignBlockPlace', 'kicadCollabGetSelection', 'kicadCollabBusy'] as const;
/** What the cap needs: the design block exports of engine run 15, the place and the save. */
export const BLOCKS_CAP_EXPORTS = ['kicadDesignBlockPlace', 'kicadDesignBlockSave'] as const;
export const BLOCKS_CAP = 'blocks';
/** The engine's run folders (it refuses any other root). */
export const BLOCK_PLACE_ROOT = '/tmp/cc-block';
/** The block's files together, in UTF-8 bytes. */
export const BLOCK_FILES_MAX = 32 * 1024 * 1024;
/** A design block table row's nickname: 1 to this many characters (code points). */
export const NICKNAME_MAX = 120;
/** How long the editor may take to take the block, when the bridge's timing names none. */
const PLACE_MS = 10_000;
const POLL_MS = 25;
const OP = 'block.place';
const FRAME_REFUSAL = 'a design block is placed in a sch or pcb frame';
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export interface BlockFileIn { path: string; text: string }
export interface BlockPlaceArgs {
  name: string;
  files: BlockFileIn[];
  asSheet: boolean;
  keepAnnotations: boolean;
  asGroup: boolean;
  nickname?: string;
}

/** A design block table row's nickname as KiCad's LIB_ID takes one: 1 to 120 code points, no colon, no control character. */
export function isNickname(v: unknown): v is string {
  if (typeof v !== 'string' || v === '' || v.includes(':') || CONTROL_RE.test(v)) return false;
  return [...v].length <= NICKNAME_MAX;
}

/** The file names a block of `name` may hold: its schematic, its layout, its description. */
export const blockFilePaths = (name: string): string[] => [`${name}.kicad_sch`, `${name}.kicad_pcb`, `${name}.json`];

/**
 * block.place's args read closed: exactly `{ name, files, asSheet,
 * keepAnnotations, asGroup }` plus an optional `nickname`; `files` 1 to 3
 * entries of exactly `{ path, text }`, each path one of the block's own file
 * names (blockFilePaths), none twice. Null for any other shape. The size and
 * the frame's file are checked after.
 */
export function parseBlockPlaceArgs(args: unknown): BlockPlaceArgs | null {
  if (!isObj(args)) return null;
  const keys = Object.prototype.hasOwnProperty.call(args, 'nickname')
    ? ['name', 'files', 'asSheet', 'keepAnnotations', 'asGroup', 'nickname']
    : ['name', 'files', 'asSheet', 'keepAnnotations', 'asGroup'];
  const own = Object.keys(args);
  if (own.length !== keys.length || !keys.every((k) => Object.prototype.hasOwnProperty.call(args, k))) return null;
  const { name, files, asSheet, keepAnnotations, asGroup } = args;
  if (!isBlockName(name)) return null;
  if (typeof asSheet !== 'boolean' || typeof keepAnnotations !== 'boolean' || typeof asGroup !== 'boolean') return null;
  if (!Array.isArray(files) || files.length < 1 || files.length > 3) return null;
  const allowed = blockFilePaths(name);
  const seen = new Set<string>();
  const out: BlockFileIn[] = [];
  for (const f of files) {
    if (!isObj(f) || Object.keys(f).length !== 2 || typeof f.path !== 'string' || typeof f.text !== 'string') return null;
    if (!allowed.includes(f.path) || seen.has(f.path)) return null;
    seen.add(f.path);
    out.push({ path: f.path, text: f.text });
  }
  const a: BlockPlaceArgs = { name, files: out, asSheet, keepAnnotations, asGroup };
  if (keys.length === 6) {
    if (!isNickname(args.nickname)) return null;
    a.nickname = args.nickname;
  }
  return a;
}

/** The file a frame places from: `<name>.kicad_sch` or `<name>.kicad_pcb`; null for another frame. */
export function frameFileOf(frame: string, name: string): string | null {
  if (frame === 'sch') return `${name}.kicad_sch`;
  if (frame === 'pcb') return `${name}.kicad_pcb`;
  return null;
}

/** The call kicadDesignBlockPlace reads: five keys, the sixth only with a nickname. */
export function engineCall(dir: string, a: BlockPlaceArgs): Record<string, unknown> {
  const call: Record<string, unknown> = { dir, name: a.name, asSheet: a.asSheet, keepAnnotations: a.keepAnnotations, asGroup: a.asGroup };
  if (a.nickname != null) call.nickname = a.nickname;
  return call;
}

/** A schematic block placed as a sheet: its box hangs in no selection, so this unit keeps it (read with the undo depth at the answer). */
interface SheetBox { depth: number | null }
const sheetBoxes = new WeakMap<ResponderCtx, SheetBox>();

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function depthOf(mod: Record<string, unknown>): number | null {
  const read = mod.kicadCollabTestUndoDepth;
  if (typeof read !== 'function') return null;
  try {
    const d = (read as () => unknown).call(mod);
    return typeof d === 'number' && Number.isSafeInteger(d) && d >= 0 ? d : null;
  } catch { return null; }
}

function selectionOf(mod: Record<string, unknown>): string[] | null {
  try {
    const v: unknown = JSON.parse(String((mod.kicadCollabGetSelection as () => unknown)()));
    return Array.isArray(v) && v.every((u) => typeof u === 'string') ? (v as string[]) : null;
  } catch { return null; }
}

/**
 * Drops a sheet box of ours that may still hang: two Escapes (the box, then
 * the tool), as a schematic placement is left. A box whose press already
 * committed (the undo depth moved) is left alone.
 */
async function dropSheetBox(ctx: ResponderCtx, mod: Record<string, unknown>): Promise<void> {
  const box = sheetBoxes.get(ctx);
  if (box == null) return;
  sheetBoxes.delete(ctx);
  const d = depthOf(mod);
  if (box.depth != null && d != null && d !== box.depth) return;
  const poll = ctx.timing.placePollMs ?? POLL_MS;
  ctx.pressKey(ESCAPE);
  await sleep(poll);
  ctx.pressKey(ESCAPE);
  await sleep(poll);
}

/**
 * block.place (a sch or pcb frame, a document open): the checks (bad_args;
 * too_large past 32 MiB; unsupported in another frame; bad_args when the
 * frame's own file is not among the files; the engine: not_ready,
 * unsupported naming the first missing export; not_ready with no document;
 * busy while a load is parked, a popup menu or a dialog is up), then the
 * item or block still hanging dropped first (busy when it would not go),
 * the files written under a fresh /tmp/cc-block/<n>/<name>.kicad_block/,
 * the engine called, and `{}` answered once the block hangs off the pointer.
 */
export async function blockPlace(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const a = parseBlockPlaceArgs(args);
  if (a == null) return fail('bad_args', OP);
  const bytes = a.files.map((f) => ({ path: f.path, data: new TextEncoder().encode(f.text) }));
  if (bytes.reduce((n, f) => n + f.data.byteLength, 0) > BLOCK_FILES_MAX) return fail('too_large', OP);
  const frame = ctx.frame as string;
  const own = frameFileOf(frame, a.name);
  if (own == null) return fail('unsupported', FRAME_REFUSAL);
  if (!a.files.some((f) => f.path === own)) return fail('bad_args', `${OP}: a block placed in a ${frame} frame needs ${own}`);
  if (ctx.win() == null) return fail('not_ready', OP);
  const mod = ctx.mod() ?? {};
  for (const name of BLOCK_PLACE_EXPORTS) if (typeof mod[name] !== 'function') return fail('unsupported', name);
  if (!ctx.hasDocument()) return fail('not_ready', OP);
  if (ctx.engineBusy() || ctx.keysBlocked()) return fail('busy', OP);
  // One at a time: an item or a block of ours still hanging is dropped first.
  if (!(await ctx.placeCancel())) return fail('busy', 'the previous item still hangs off the pointer');
  await dropSheetBox(ctx, mod);
  if (ctx.closed()) return fail('island_error', 'the frame closed');
  const FS = ctx.fs();
  if (FS == null) return fail('not_ready', OP);
  let dir: string;
  try {
    dir = ctx.freshRunFolder(BLOCK_PLACE_ROOT);
    const folder = `${dir}/${a.name}.kicad_block`;
    FS.mkdirTree(folder);
    for (const f of bytes) FS.writeFile(`${folder}/${f.path}`, f.data);
  } catch (err) {
    return fail('island_error', err instanceof Error ? err.message : String(err));
  }
  let keep = false;
  try {
    const before = selectionOf(mod);
    if (before == null) return fail('island_error', 'the selection does not read');
    const t0 = Date.now();
    let said: unknown;
    try {
      said = (mod.kicadDesignBlockPlace as (json: string) => unknown)(JSON.stringify(engineCall(dir, a)));
    } catch (err) {
      return fail('island_error', err instanceof Error ? err.message : String(err));
    }
    if (said !== true) return fail('not_applied', `${OP}: KiCad did not take the block`);
    const ms = ctx.timing.placeMs ?? PLACE_MS;
    if (frame === 'sch' && a.asSheet) {
      // The sheet's box hangs in no selection: the block is up once the apply queue has run KiCad's tool.
      keep = true;
      sheetBoxes.set(ctx, { depth: depthOf(mod) });
      if (!(await ctx.applyIdle(ms))) return fail('not_applied', `${OP}: the editor did not take the block`);
      sheetBoxes.set(ctx, { depth: depthOf(mod) });
      ctx.log(OP, 'sheet', `${Date.now() - t0} ms`);
      return ok();
    }
    const end = Date.now() + ms;
    for (;;) {
      if (ctx.closed()) return fail('island_error', 'the frame closed');
      const fresh = (selectionOf(mod) ?? []).find((u) => !before.includes(u));
      if (fresh != null) {
        ctx.placeStart(fresh);
        ctx.log(OP, frame, a.asGroup ? 'group' : 'items', `${Date.now() - t0} ms`);
        return ok();
      }
      if (Date.now() >= end) return fail('busy', `${OP}: the editor did not take the block`);
      await sleep(ctx.timing.placePollMs ?? POLL_MS);
    }
  } finally {
    if (!keep) ctx.dropRunFolder(dir);
  }
}

export default {
  unit: 'i-block-place',
  frames: ['sch', 'pcb'],
  frameRefusal: FRAME_REFUSAL,
  capNames: [BLOCKS_CAP],
  caps: (mod, frame) => ((frame === 'sch' || frame === 'pcb') && hasAll(mod, BLOCKS_CAP_EXPORTS) ? [BLOCKS_CAP] : []),
  ops: {
    'block.place': { run: blockPlace },
  },
} satisfies ExtUnit;
