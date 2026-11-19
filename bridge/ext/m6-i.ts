// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// Placement cards and the selection filter (PROTOCOL.md selectFilter.get and
// selectFilter.set, the canvas commands addendum 7).
//
// Engine run 15 asks the prompt host (m1x-i) in place of six of KiCad's
// placement windows: `moveExact` (Move Exactly), `offset` (Interactive
// Offset's entry), `filterSelection` (Filter Selected Items) and
// `findFootprint` (Get and Move Footprint), modal (unit m6-e1), and `array`
// (Create Array) and `positionRelative` (Position Relative), modeless, with
// KiCad's own pickers behind prompt.pick (unit m6-e2). This unit declares
// those asks and reads their records closed.
//
// Engine run 15 (unit m6-e3) adds kicadSelectionFilterGet and
// kicadSelectionFilterSet in the merged image: KiCad's Selection Filter
// pane's switches read and written with no window (the pane is KiCad chrome,
// never shown), the schematic's ten and the board's twelve. Each engine holds
// its own, as KiCad does per editor; no undo step, no modified flag.
import { fail, hasAll, ok, refused, type Answer, type ExtUnit, type Gated, type ResponderCtx } from './contract';
import { PLACEMENT_ASK_READERS, PLACEMENT_ASKS } from './m6-i/asks';
import { filterHolds, isNoFilterArgs, parseFilterSet, readFilter, type Filter, type FilterFrame } from './m6-i/selectFilter';

/** The pseudo-cap: the engine reads and writes the selection filter with no window. */
export const SELECT_FILTER_CAP = 'selectFilter';
/** The engine exports the cap and the ops need (engine run 15, unit m6-e3). */
export const SELECT_FILTER_EXPORTS = ['kicadSelectionFilterGet', 'kicadSelectionFilterSet'] as const;
/** The frames that hold a selection filter (the footprint editor's engine reads none). */
export const SELECT_FILTER_FRAMES = ['sch', 'pcb'] as const;

const isFilterFrame = (frame: string): frame is FilterFrame => (SELECT_FILTER_FRAMES as readonly string[]).includes(frame);

/** The frame's own gate: the schematic's in a sch frame, the board's in a pcb frame. */
function gate(op: string, ctx: ResponderCtx): Gated {
  return ctx.frame === 'pcb' ? ctx.boardGate(op, SELECT_FILTER_EXPORTS) : ctx.schematicGate(op, SELECT_FILTER_EXPORTS);
}

/** The engine's filter now; an answer on a fault. */
function readNow(op: string, mod: Record<string, unknown>, frame: FilterFrame): Filter | Answer {
  let raw: unknown;
  try { raw = (mod.kicadSelectionFilterGet as () => unknown)(); } catch { return fail('island_error', op); }
  return readFilter(raw, frame) ?? fail('island_error', `${op}: the engine answered another shape`);
}
const isAnswer = (v: unknown): v is Answer => typeof v === 'object' && v !== null && 'ok' in v && typeof (v as { ok: unknown }).ok === 'boolean';

export default {
  unit: 'm6-i',
  frames: [...SELECT_FILTER_FRAMES],
  frameRefusal: 'the selection filter is read in a sch or pcb frame',
  capNames: [SELECT_FILTER_CAP],
  caps: (mod, frame) => (isFilterFrame(frame) && hasAll(mod, SELECT_FILTER_EXPORTS) ? [SELECT_FILTER_CAP] : []),
  asks: [...PLACEMENT_ASKS],
  askReaders: PLACEMENT_ASK_READERS,
  ops: {
    'selectFilter.get': {
      // A read: answered during a sheet or board check too.
      passesCheck: true,
      run(args, ctx: ResponderCtx) {
        const op = 'selectFilter.get';
        if (!isNoFilterArgs(args)) return fail('bad_args', op);
        const g = gate(op, ctx);
        if (refused(g)) return g;
        const frame = ctx.frame as FilterFrame;
        const r = readNow(op, g.mod, frame);
        if (isAnswer(r)) return r;
        return ok({ frame, filter: r });
      },
    },
    'selectFilter.set': {
      run(args, ctx: ResponderCtx) {
        const op = 'selectFilter.set';
        if (!isFilterFrame(ctx.frame)) return fail('unsupported', 'the selection filter is read in a sch or pcb frame');
        const frame = ctx.frame;
        const set = parseFilterSet(args, frame);
        if (set == null) return fail('bad_args', op);
        const g = gate(op, ctx);
        if (refused(g)) return g;
        let done: unknown;
        try { done = (g.mod.kicadSelectionFilterSet as (json: string) => unknown)(JSON.stringify(set)); } catch { return fail('island_error', op); }
        if (done !== true && done !== 1) return fail('not_applied', op);
        const after = readNow(op, g.mod, frame);
        if (isAnswer(after)) return after;
        // The read back must hold every switch where it was set.
        if (!filterHolds(after, set)) return fail('not_applied', op);
        return ok({ frame, filter: after });
      },
    },
  },
} satisfies ExtUnit;
