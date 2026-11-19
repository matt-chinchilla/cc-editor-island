// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// i-block-save (PROTOCOL.md block.save): a sheet, a selection, a whole board
// or a group linked to a design block written as a design block's file by
// KiCad's own writers with no KiCad window, for the page to keep beside the
// block's description (the page writes <name>.json and the library row).
//
// Engine run 15 (unit e-block-save, lane e7) adds kicadDesignBlockSave(json):
// exactly { run, dir, name, scope, sheetPath? } with dir a run folder under
// /tmp/cc-blocksave/. True means queued: on the apply coroutine K-B3's body
// writes <dir>/<name>.kicad_block/<name>.kicad_sch (a sch frame) or
// .kicad_pcb (a pcb frame), then the record <dir>/.cc-block.json
// { code, lines } LAST (code 0 written, 1 refused or failed, the lines
// KiCad's own messages). Nothing in the design changes: no commit, no undo
// step, no modified flag, the selection not grouped. Feature detected: on an
// engine without the export (run 14) the op answers unsupported naming it.
import { fail, isObj, ok, refused, type Answer, type ExtUnit, type ResponderCtx } from './contract';
import { SHEET_PATH_RE } from '../symbol';

/** The engine exports the op needs: the write, the apply queue probe the wait reads. */
export const BLOCK_SAVE_EXPORTS = ['kicadDesignBlockSave', 'kicadCollabBusy'] as const;
/** The engine's run folders (it refuses any other root). */
export const BLOCK_SAVE_ROOT = '/tmp/cc-blocksave';
/** The run's record, written last. */
export const BLOCK_SAVE_RECORD = '.cc-block.json';
/** A block's name: 1 to this many characters (code points), as the engine takes it. */
export const BLOCK_NAME_MAX = 120;
/** The scopes each frame writes. */
export const SCH_SCOPES = ['sheet', 'selection'] as const;
export const PCB_SCOPES = ['board', 'selection', 'linkedGroup'] as const;
export type BlockScope = 'sheet' | 'selection' | 'board' | 'linkedGroup';
/** The bound of one run when the bridge's timing names none (a whole board is the slowest write). */
const BLOCK_SAVE_MS = 60_000;
/** At most this many of KiCad's lines are read from a record. */
const LINES_MAX = 64;
const LINE_MAX = 1024;
const OP = 'block.save';
const FRAME_REFUSAL = 'a design block is saved in a sch or pcb frame';
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export interface BlockSaveArgs { scope: BlockScope; name: string; sheetPath?: string }
export interface BlockFile { path: string; text: string }
export interface BlockSaveRecord { code: number; lines: string[] }

/** A block name as the engine takes it: 1 to 120 code points, none of / \ : or a control character, never . or .. */
export function isBlockName(v: unknown): v is string {
  if (typeof v !== 'string' || v === '' || v === '.' || v === '..') return false;
  if (/[/\\:]/.test(v) || CONTROL_RE.test(v)) return false;
  return [...v].length <= BLOCK_NAME_MAX;
}

/**
 * block.save's args read closed: exactly `{ scope, name }`, plus `sheetPath`
 * (project.open's sheet path form) when and only when `scope` is `sheet`.
 * Null for any other shape. The frame's own scopes are checked after.
 */
export function parseBlockSaveArgs(args: unknown): BlockSaveArgs | null {
  if (!isObj(args)) return null;
  const scope = args.scope;
  if (scope !== 'sheet' && scope !== 'selection' && scope !== 'board' && scope !== 'linkedGroup') return null;
  const keys = scope === 'sheet' ? ['scope', 'name', 'sheetPath'] : ['scope', 'name'];
  const own = Object.keys(args);
  if (own.length !== keys.length || !keys.every((k) => Object.prototype.hasOwnProperty.call(args, k))) return null;
  if (!isBlockName(args.name)) return null;
  if (scope !== 'sheet') return { scope, name: args.name };
  if (typeof args.sheetPath !== 'string' || !SHEET_PATH_RE.test(args.sheetPath)) return null;
  return { scope, name: args.name, sheetPath: args.sheetPath };
}

/** The scopes a frame writes, or null for a frame that writes none. */
export function scopesOf(frame: string): readonly BlockScope[] | null {
  if (frame === 'sch') return SCH_SCOPES;
  if (frame === 'pcb') return PCB_SCOPES;
  return null;
}

/**
 * `.cc-block.json` read closed: exactly `{ code, lines }`, `code` 0 or 1,
 * `lines` strings (cut to 64 lines of 1,024 characters). Null while the
 * record is not there yet; `'bad'` for any other shape.
 */
export function readBlockSaveRecord(bytes: Uint8Array | null): BlockSaveRecord | 'bad' | null {
  if (bytes == null) return null;
  let v: unknown;
  try { v = JSON.parse(new TextDecoder().decode(bytes)); } catch { return 'bad'; }
  if (!isObj(v)) return 'bad';
  const own = Object.keys(v);
  if (own.length !== 2 || !('code' in v) || !('lines' in v)) return 'bad';
  if (v.code !== 0 && v.code !== 1) return 'bad';
  if (!Array.isArray(v.lines) || !v.lines.every((l) => typeof l === 'string')) return 'bad';
  const lines = (v.lines as string[]).slice(0, LINES_MAX).map((l) => (l.length <= LINE_MAX ? l : [...l].slice(0, LINE_MAX).join('')));
  return { code: v.code, lines };
}

/** The file a run writes for a frame: `<name>.kicad_sch` or `<name>.kicad_pcb`. */
export const blockFileName = (frame: 'sch' | 'pcb', name: string): string => `${name}.kicad_${frame}`;

/**
 * block.save (a sch or pcb frame, a document open): the checks (bad_args;
 * unsupported for a scope the frame does not write; the frame's gate: the
 * engine's exports, a document open, busy), then the run queued with a fresh
 * run folder and the record read once the apply queue is empty. Code 0: the
 * written file answered as `{ files: [{ path, text }] }`; code 1:
 * `block_failed` with KiCad's first line. The folder is removed whatever the
 * answer.
 */
export async function blockSave(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const a = parseBlockSaveArgs(args);
  if (a == null) return fail('bad_args', OP);
  const frame = ctx.frame as string;
  const scopes = scopesOf(frame);
  if (scopes == null) return fail('unsupported', FRAME_REFUSAL);
  if (!scopes.includes(a.scope)) return fail('unsupported', `scope ${a.scope} is saved in a ${frame === 'sch' ? 'pcb' : 'sch'} frame`);
  const g = frame === 'pcb' ? ctx.boardGate(OP, BLOCK_SAVE_EXPORTS) : ctx.schematicGate(OP, BLOCK_SAVE_EXPORTS);
  if (refused(g)) return g;
  let dir: string;
  try { dir = ctx.freshRunFolder(BLOCK_SAVE_ROOT); } catch (err) { return fail('island_error', err instanceof Error ? err.message : String(err)); }
  try {
    const run = Number(dir.slice(dir.lastIndexOf('/') + 1));
    const t0 = Date.now();
    let thrown: string | null = null;
    const call = a.sheetPath == null
      ? { run, dir, name: a.name, scope: a.scope }
      : { run, dir, name: a.name, scope: a.scope, sheetPath: a.sheetPath };
    const got = await ctx.queuedRun(OP, dir, ctx.timing.blockSaveMs ?? BLOCK_SAVE_MS,
      () => {
        try {
          return (g.mod.kicadDesignBlockSave as (json: string) => unknown)(JSON.stringify(call));
        } catch (err) {
          thrown = err instanceof Error ? err.message : String(err);
          return false;
        }
      },
      () => readBlockSaveRecord(ctx.readBytes(`${dir}/${BLOCK_SAVE_RECORD}`)));
    if (thrown != null) return fail('island_error', thrown);
    if (!('done' in got)) return got;
    if (got.done === 'bad') return fail('island_error', 'the engine answered a block record of another shape');
    if (got.done.code !== 0) return fail('block_failed', got.done.lines.find((l) => l.trim() !== '') ?? OP);
    const path = blockFileName(frame as 'sch' | 'pcb', a.name);
    const bytes = ctx.readBytes(`${dir}/${a.name}.kicad_block/${path}`);
    if (bytes == null) return fail('island_error', `the engine wrote no ${path}`);
    const files: BlockFile[] = [{ path, text: new TextDecoder().decode(bytes) }];
    ctx.log(OP, a.scope, `${bytes.byteLength} bytes`, `${Date.now() - t0} ms`);
    return ok({ files });
  } finally {
    ctx.dropRunFolder(dir);
  }
}

export default {
  unit: 'i-block-save',
  frames: ['sch', 'pcb'],
  frameRefusal: FRAME_REFUSAL,
  ops: {
    'block.save': { run: blockSave },
  },
} satisfies ExtUnit;
