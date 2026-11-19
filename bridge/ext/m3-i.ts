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
// item read back. KiCad's Edit Corners (that pane, KiCad chrome) is held under
// the cap vertices: the frame sends ev.held and the host opens the board
// form's Corners block over board.vertices.get.
import { fail, hasAll, ok, refused, type Answer, type ExtUnit, type HeldRow, type ResponderCtx } from './contract';
import { BOARD_ASK_READERS, BOARD_ASKS } from './m3-i/asks';
import { cornerAt, lineOf, parseVerticesGet, parseVerticesSet, readVertices, type VertexRecord } from './m3-i/vertices';

/** The pseudo-cap: the engine reads and moves a board item's corners with no window. */
export const VERTICES_CAP = 'vertices';
/** The engine exports the cap and the ops need (engine run 15, unit m3-e3). */
export const VERTICES_EXPORTS = ['kicadBoardVerticesGet', 'kicadBoardVerticesSet'] as const;
/** KiCad's Edit Corners, held: the host opens the board form's Corners block. */
export const EDIT_VERTICES = 'pcbnew.InteractiveEdit.editVertices';
/**
 * The row names the board and the footprint editor, as KiCad's menus show
 * Edit Corners in both; the cap is listed only where the engine reads corners
 * (a board frame: in the footprint editor kicadBoardVerticesGet answers ""),
 * so in the footprint editor the row waits and no door is offered there.
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

export default {
  unit: 'm3-i',
  frames: ['pcb'],
  frameRefusal: 'board corners are read in a pcb frame',
  capNames: [VERTICES_CAP],
  caps: (mod, frame) => (frame === 'pcb' && hasAll(mod, VERTICES_EXPORTS) ? [VERTICES_CAP] : []),
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
        const g = ctx.boardGate(op, VERTICES_EXPORTS);
        if (refused(g)) return g;
        const r = readNow(op, g.mod, a.uuid);
        if (r == null) return fail('not_found', a.uuid);
        if (isAnswer(r)) return r;
        return ok({ ...r });
      },
    },
    'board.vertices.set': {
      run(args, ctx: ResponderCtx) {
        const op = 'board.vertices.set';
        const s = parseVerticesSet(args);
        if (s == null) return fail('bad_args', op);
        const g = ctx.boardGate(op, VERTICES_EXPORTS);
        if (refused(g)) return g;
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
        const after = readVertices(raw, s.uuid);
        if (after == null) return fail('island_error', `${op}: the engine answered another shape`);
        // The read back must hold the corner where it was sent.
        if (!cornerAt(after, s)) return fail('not_applied', op);
        return ok({ ...after });
      },
    },
  },
} satisfies ExtUnit;
