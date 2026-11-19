// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// i-block-layout (PROTOCOL.md block.applyLayout, board.preview, board.update):
// KiCad's Apply Design Block Layout over chosen groups with no KiCad window,
// and Update PCB from Schematic's two group boxes, Keep groups and Apply block
// layouts.
//
// Engine run 15 (unit e-block-layout, lane e7) adds
// kicadDesignBlockApplyLayout(json): exactly { run, dir, uuids } with dir a
// run folder under /tmp/cc-blocklayout/ and uuids 1 to 256 distinct lower case
// uuids, each checked at once to be a group (else false). True means queued:
// on the apply coroutine KiCad's own apply runs as ONE commit (one undo step)
// and the record <dir>/.cc-block-layout.json { applied, failures, lines } is
// written LAST. The group's block row must already be loaded in the engine
// (project.libs). It also widens kicadUpdateBoardFromSchematic to nine keys
// (transferGroups, applyDesignBlockLayouts) under the marker
// kicadBoardUpdateGroups, the report then carrying `layouts`. Feature
// detected: on an engine without them (run 14) block.applyLayout answers
// unsupported naming the export, a board.preview or board.update sending the
// group boxes answers unsupported naming the marker, and the cap blockLayouts
// is not listed.
import { readLayouts, sendsGroupKeys, parseBoardPreviewArgs, parseBoardUpdateArgs, BOARD_UPDATE_EXPORTS, type BoardLayouts } from '../boardUpdate';
import { fail, hasAll, isObj, ok, refused, type Answer, type ExtUnit, type ResponderCtx, type Widen } from './contract';

/** The engine exports block.applyLayout needs: the apply, the apply queue probe the wait reads. */
export const BLOCK_LAYOUT_EXPORTS = ['kicadDesignBlockApplyLayout', 'kicadCollabBusy'] as const;
/** The engine's marker for the update's two group boxes. */
export const UPDATE_GROUPS_MARKER = 'kicadBoardUpdateGroups';
/** What the cap blockLayouts says: both halves answer. */
export const BLOCK_LAYOUT_CAP_EXPORTS = [...BLOCK_LAYOUT_EXPORTS, ...BOARD_UPDATE_EXPORTS, UPDATE_GROUPS_MARKER] as const;
export const BLOCK_LAYOUT_CAP = 'blockLayouts';
/** The engine's run folders (it refuses any other root). */
export const BLOCK_LAYOUT_ROOT = '/tmp/cc-blocklayout';
/** The run's record, written last. */
export const BLOCK_LAYOUT_RECORD = '.cc-block-layout.json';
/** 1 to this many groups per apply, as the engine takes them. */
export const MAX_LAYOUT_GROUPS = 256;
/** The bound of one apply when the bridge's timing names none (the update's own bound: five times the slowest measured case, at least 30 s). */
const BLOCK_LAYOUT_MS = 30_000;
/** At most this many of KiCad's lines are read from a record. */
const LINES_MAX = 64;
const LINE_MAX = 1024;
const OP = 'block.applyLayout';
const FRAME_REFUSAL = 'a design block layout is applied in a pcb frame';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface BlockLayoutRecord extends BoardLayouts { lines: string[] }

/** block.applyLayout's args read closed: exactly `{ uuids }`, 1 to 256 distinct lower case uuids. Null for any other shape. */
export function parseApplyLayoutArgs(args: unknown): { uuids: string[] } | null {
  if (!isObj(args) || Object.keys(args).length !== 1 || !Array.isArray(args.uuids)) return null;
  const uuids = args.uuids as unknown[];
  if (uuids.length < 1 || uuids.length > MAX_LAYOUT_GROUPS) return null;
  if (!uuids.every((u) => typeof u === 'string' && UUID_RE.test(u))) return null;
  if (new Set(uuids).size !== uuids.length) return null;
  return { uuids: [...uuids] as string[] };
}

/**
 * `.cc-block-layout.json` read closed: exactly `{ applied, failures, lines }`,
 * the layouts as bridge/boardUpdate.ts reads them, `lines` strings (cut to 64
 * lines of 1,024 characters). Null while the record is not there yet; `'bad'`
 * for any other shape.
 */
export function readBlockLayoutRecord(bytes: Uint8Array | null): BlockLayoutRecord | 'bad' | null {
  if (bytes == null) return null;
  let v: unknown;
  try { v = JSON.parse(new TextDecoder().decode(bytes)); } catch { return 'bad'; }
  if (!isObj(v)) return 'bad';
  const own = Object.keys(v);
  if (own.length !== 3 || !('applied' in v) || !('failures' in v) || !('lines' in v)) return 'bad';
  const layouts = readLayouts({ applied: v.applied, failures: v.failures });
  if (layouts == null) return 'bad';
  if (!Array.isArray(v.lines) || !v.lines.every((l) => typeof l === 'string')) return 'bad';
  const lines = (v.lines as string[]).slice(0, LINES_MAX).map((l) => (l.length <= LINE_MAX ? l : [...l].slice(0, LINE_MAX).join('')));
  return { ...layouts, lines };
}

/**
 * block.applyLayout (a pcb frame, a board open): the checks (bad_args; the
 * frame; the gate: the engine's exports, a document open, busy), then KiCad's
 * Apply Design Block Layout queued over the groups with a fresh run folder
 * and its record read once the apply queue is empty. The answer is
 * `{ applied, failures }`. A run that applied nothing and names no failure
 * (no group asked is linked to a block) answers `block_failed` with KiCad's
 * first line; the engine refusing a uuid that names no group answers
 * `block_failed` too. The folder is removed whatever the answer.
 */
export async function applyLayout(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const a = parseApplyLayoutArgs(args);
  if (a == null) return fail('bad_args', OP);
  if (ctx.frame !== 'pcb') return fail('unsupported', FRAME_REFUSAL);
  const g = ctx.boardGate(OP, BLOCK_LAYOUT_EXPORTS);
  if (refused(g)) return g;
  let dir: string;
  try { dir = ctx.freshRunFolder(BLOCK_LAYOUT_ROOT); } catch (err) { return fail('island_error', err instanceof Error ? err.message : String(err)); }
  try {
    const run = Number(dir.slice(dir.lastIndexOf('/') + 1));
    const t0 = Date.now();
    let thrown: string | null = null;
    let queued: unknown = null;
    const got = await ctx.watchedRun(OP, dir, ctx.timing.blockLayoutMs ?? BLOCK_LAYOUT_MS,
      () => {
        try {
          queued = (g.mod.kicadDesignBlockApplyLayout as (json: string) => unknown)(JSON.stringify({ run, dir, uuids: a.uuids }));
        } catch (err) {
          thrown = err instanceof Error ? err.message : String(err);
          queued = false;
        }
        return queued;
      },
      () => readBlockLayoutRecord(ctx.readBytes(`${dir}/${BLOCK_LAYOUT_RECORD}`)));
    if (thrown != null) return fail('island_error', thrown);
    // The engine checks every uuid at once: false after the gate passed means one names no group of the board.
    if (queued === false) return fail('block_failed', 'a uuid names no group of the board');
    if (!('done' in got)) return got;
    if (got.dialog != null) return fail('block_failed', got.dialog);
    if (got.done === 'bad') return fail('island_error', 'the engine answered a layout record of another shape');
    const { applied, failures, lines } = got.done;
    if (applied === 0 && failures.length === 0) return fail('block_failed', lines.find((l) => l.trim() !== '') ?? OP);
    ctx.log(OP, `${a.uuids.length} groups`, `${applied} applied`, `${failures.length} failures`, `${Date.now() - t0} ms`);
    return ok({ applied, failures });
  } finally {
    ctx.dropRunFolder(dir);
  }
}

/**
 * board.preview and board.update widened: args sending a group box are read
 * by the shared readers (bad_args for `applyBlockLayouts` without
 * `transferGroups`, or true beside it false); with Keep groups on the engine
 * must carry the marker (the board gate with it: `unsupported` naming
 * kicadBoardUpdateGroups on engine run 14), and the op as it ships then runs
 * the nine keys and answers `layouts`. Keep groups off, or args without the
 * boxes, go to the op as it ships.
 */
const widenUpdate = (op: 'board.preview' | 'board.update'): Widen => async (args, ctx, next) => {
  if (!sendsGroupKeys(args)) return next(args);
  const a = op === 'board.preview' ? parseBoardPreviewArgs(args) : parseBoardUpdateArgs(args);
  if (a == null) return fail('bad_args', op);
  if (a.groups == null) return next(args);
  const g = ctx.boardGate(op, [...BOARD_UPDATE_EXPORTS, UPDATE_GROUPS_MARKER]);
  if (refused(g)) return g;
  const answer = await next(args);
  if (answer.ok && !isObj(answer.result.layouts)) return fail('island_error', 'the update report carried no layouts');
  return answer;
};

export default {
  unit: 'i-block-layout',
  frames: ['pcb'],
  frameRefusal: FRAME_REFUSAL,
  capNames: [BLOCK_LAYOUT_CAP],
  caps: (mod, frame) => (frame === 'pcb' && hasAll(mod, BLOCK_LAYOUT_CAP_EXPORTS) ? [BLOCK_LAYOUT_CAP] : []),
  ops: {
    'block.applyLayout': { run: applyLayout },
  },
  opsWidened: {
    'board.preview': widenUpdate('board.preview'),
    'board.update': widenUpdate('board.update'),
  },
} satisfies ExtUnit;
