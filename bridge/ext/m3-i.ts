// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// Board commands (PROTOCOL.md board.vertices.get and board.vertices.set, the
// canvas commands addendum 6): the board's own windows asked of the host in
// place of KiCad's, and a board item's corners read and moved one at a time.
//
// Engine run 15 asks the prompt host (m1x-i) in place of three of KiCad's
// windows: `convert` (the conversion settings of Create Polygon, Zone, Rule
// Area and Lines from a selection; unit m3-e1), `outset` (Create Outsets;
// m3-e1) and `zoneSettings` (a NEW zone's settings, copper, non copper or rule
// area; m3-e2). This unit declares those asks and reads their records closed.
//
// Engine run 15 (unit m3-e3) adds kicadBoardVerticesGet and
// kicadBoardVerticesSet in a board frame: the corners of a zone, a rule area or
// a polygon shape, as KiCad's vertex editor pane lists them, and one corner
// moved per call, one undo step ("Edit Vertex"), answered at once with the
// item read back. Engine fix e10-3 (builds T9 and later) serves the footprint
// editor frame the same way, the item of the open footprint. KiCad's Edit
// Corners (that pane, KiCad chrome) is held under the cap vertices in both
// frames: the frame sends ev.held and the host opens its Corners block over
// board.vertices.get.
//
// Build T17 (engine item 1): a move made at once trapped (SuspendError) while
// the item was selected, as KiCad's commit then runs the selection's tools.
// From T17 the engine checks the args and the corner at once, answers a
// corner already there with the record as before, and otherwise queues the
// move on the frame's tool coroutine and answers exactly {"queued":true}: the
// island waits for the apply queue, then reads the item back.
import { fail, hasAll, ok, refused, type Answer, type ExtUnit, type HeldRow, type ResponderCtx } from './contract';
import { BOARD_ASK_READERS, BOARD_ASKS } from './m3-i/asks';
import { cornerAt, lineOf, parseVerticesGet, parseVerticesSet, readVertices, type VertexRecord } from './m3-i/vertices';

/** The pseudo-cap: the engine reads and moves a board item's corners with no window. */
export const VERTICES_CAP = 'vertices';
/** The engine exports the cap and the ops need (engine run 15, unit m3-e3). */
export const VERTICES_EXPORTS = ['kicadBoardVerticesGet', 'kicadBoardVerticesSet'] as const;
/** The frames whose engine reads corners: the board, and the footprint editor (engine fix e10-3). */
export const VERTICES_FRAMES = ['pcb', 'fpedit'] as const;
const FPEDIT = 'fpedit';
/** KiCad's Edit Corners, held: the host opens the board form's Corners block. */
export const EDIT_VERTICES = 'pcbnew.InteractiveEdit.editVertices';
/**
 * The row names the board and the footprint editor, as KiCad's menus show
 * Edit Corners in both; the cap is listed in each where the engine has both
 * exports, so the action is held there exactly as on the board.
 */
export const M3_HELD_ROWS: readonly HeldRow[] = Object.freeze([
  Object.freeze({ action: EDIT_VERTICES, frames: Object.freeze(['pcb', 'fpedit']), cap: VERTICES_CAP }),
]);

type Engine = (json: string) => unknown;

/** The engine's record of `uuid`'s corners; null when it holds no item of corners by that uuid; an answer on a fault. */
function readNow(op: string, mod: Record<string, unknown>, uuid: string): VertexRecord | null | Answer {
  let raw: unknown;
  try { raw = (mod.kicadBoardVerticesGet as Engine)(JSON.stringify({ uuid })); } catch { return fail('island_error', op); }
  if (raw === '' || raw == null) return null;
  return readVertices(raw, uuid) ?? fail('island_error', `${op}: the engine answered another shape`);
}
const isAnswer = (v: unknown): v is Answer => typeof v === 'object' && v !== null && 'ok' in v;

/** How long the island waits for a queued move (build T17) to run. */
export const QUEUED_MOVE_MS = 5000;

/** The engine's answer for a move queued on the frame's tool coroutine (build T17): exactly `{"queued":true}`. */
export function isQueuedAnswer(raw: unknown): boolean {
  if (typeof raw !== 'string' || raw.length > 64) return false;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return false; }
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 1 && (v as { queued?: unknown }).queued === true;
}

/**
 * The checks both ops make after their args, each before any effect. In a pcb
 * frame the board gate. In an fpedit frame the same checks in the same order
 * over the footprint editor: the engine up (not_ready), each export
 * (unsupported naming the first missing), a footprint open (not_ready), busy
 * while a load is parked, a popup menu or a dialog is up, or a placed item
 * hangs off the pointer.
 */
function cornersGate(op: string, ctx: ResponderCtx): Answer | { mod: Record<string, unknown> } {
  if ((ctx.frame as string) !== FPEDIT) {
    const g = ctx.boardGate(op, VERTICES_EXPORTS);
    return refused(g) ? g : { mod: g.mod };
  }
  const mod = ctx.win() == null ? null : ctx.mod();
  if (mod == null) return fail('not_ready', op);
  for (const name of VERTICES_EXPORTS) if (typeof mod[name] !== 'function') return fail('unsupported', name);
  if (!ctx.admit()) return fail('not_ready', op);
  if (ctx.engineBusy() || ctx.keysBlocked() || ctx.placeHanging()) return fail('busy', op);
  return { mod };
}

export default {
  unit: 'm3-i',
  frames: [...VERTICES_FRAMES],
  frameRefusal: 'board corners are read in a pcb or an fpedit frame',
  capNames: [VERTICES_CAP],
  caps: (mod, frame) => ((VERTICES_FRAMES as readonly string[]).includes(frame) && hasAll(mod, VERTICES_EXPORTS) ? [VERTICES_CAP] : []),
  held: M3_HELD_ROWS.map((r) => r.action),
  heldRows: M3_HELD_ROWS,
  asks: [...BOARD_ASKS],
  askReaders: BOARD_ASK_READERS,
  ops: {
    'board.vertices.get': {
      // A read: answered during a sheet or board check too.
      passesCheck: true,
      run(args, ctx: ResponderCtx) {
        const op = 'board.vertices.get';
        const a = parseVerticesGet(args);
        if (a == null) return fail('bad_args', op);
        const g = cornersGate(op, ctx);
        if (isAnswer(g)) return g;
        const r = readNow(op, g.mod, a.uuid);
        if (r == null) return fail('not_found', a.uuid);
        if (isAnswer(r)) return r;
        return ok({ ...r });
      },
    },
    'board.vertices.set': {
      async run(args, ctx: ResponderCtx) {
        const op = 'board.vertices.set';
        const s = parseVerticesSet(args);
        if (s == null) return fail('bad_args', op);
        const g = cornersGate(op, ctx);
        if (isAnswer(g)) return g;
        // The corner must be one the item holds: read it first, so a wrong
        // index is the host's fault, named, and the engine is never asked.
        const before = readNow(op, g.mod, s.uuid);
        if (before == null) return fail('not_found', s.uuid);
        if (isAnswer(before)) return before;
        const line = lineOf(before, s.outline, s.hole);
        if (line == null) return fail('bad_args', `${op}: the item has no outline ${s.outline} hole ${s.hole}`);
        if (s.index >= line.points.length) return fail('bad_args', `${op}: the outline has no corner ${s.index}`);
        let raw: unknown;
        try { raw = (g.mod.kicadBoardVerticesSet as Engine)(JSON.stringify(s)); } catch { return fail('island_error', op); }
        if (raw === '' || raw == null) return fail('not_applied', op);
        let after: VertexRecord | null;
        if (isQueuedAnswer(raw)) {
          // Queued (build T17): the move runs as the apply queue empties; then the item read back.
          if (!(await ctx.applyIdle(QUEUED_MOVE_MS))) return fail('not_applied', op);
          const read = readNow(op, g.mod, s.uuid);
          if (read == null) return fail('not_found', s.uuid);
          if (isAnswer(read)) return read;
          after = read;
        } else after = readVertices(raw, s.uuid);
        if (after == null) return fail('island_error', `${op}: the engine answered another shape`);
        // The read back must hold the corner where it was sent.
        if (!cornerAt(after, s)) return fail('not_applied', op);
        return ok({ ...after });
      },
    },
  },
} satisfies ExtUnit;
