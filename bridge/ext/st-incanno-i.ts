// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// sheet.increment (PROTOCOL.md): KiCad's Increment Annotations From with no
// window, by engine run 15's kicadSchIncrementAnnotations (the body of
// SCH_EDITOR_CONTROL::IncrementAnnotations after its dialog): every part whose
// designator has the first designator's prefix and a number at or above its
// number moves up by `by`, on the shown sheet or every sheet, in ONE commit
// (one undo step, the responder's own ev.edited after it; none when nothing
// matched). Cap incrementAnnotations in a sch frame, feature detected; under
// it KiCad's own Increment Annotations From is held (ev.held) for the host's
// page. On an engine without the export the op answers unsupported naming it
// and nothing is held.
import { fail, hasAll, isObj, onlyKeys, ok, refused, type Answer, type ExtUnit, type ResponderCtx } from './contract';

/** The engine exports sheet.increment calls: the shift, the apply queue it waits on, the undo depth it reads. */
export const INCREMENT_EXPORTS = ['kicadSchIncrementAnnotations', 'kicadCollabBusy', 'kicadCollabTestUndoDepth'] as const;
export const INCREMENT_CAP = 'incrementAnnotations';
/** KiCad's Increment Annotations From, held in a sch frame under the cap. */
export const INCREMENT_ACTION = 'eeschema.EditorControl.incrementAnnotations';
/** The engine's apply queue is waited for at most this long when the bridge names no incrementMs. */
export const INCREMENT_MS = 30_000;
/** The engine's bound on `by` (KiCad's dialog spins 1 to 64; the engine takes up to 100,000). */
export const INCREMENT_BY_MAX = 100_000;

export interface IncrementArgs { first: string; by: number; allSheets: boolean }

const OP = 'sheet.increment';
// A prefix that ends in a character other than a digit, then the number: R10, U3, J_12.
const SPLIT = /^(.*\D)(\d+)$/;
const hasControl = (s: string): boolean => [...s].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);

/** The args read closed: exactly first (a prefix and a number, 2 to 64 characters), by (1 to 100,000) and allSheets; null for anything else. */
export function readIncrementArgs(args: unknown): IncrementArgs | null {
  if (!isObj(args) || !onlyKeys(args, ['first', 'by', 'allSheets'])) return null;
  const { first, by, allSheets } = args;
  if (typeof first !== 'string' || first.length < 2 || first.length > 64 || hasControl(first) || first.trim() !== first || !SPLIT.test(first)) return null;
  if (typeof by !== 'number' || !Number.isSafeInteger(by) || by < 1 || by > INCREMENT_BY_MAX) return null;
  if (typeof allSheets !== 'boolean') return null;
  return { first, by, allSheets };
}

function depthOf(mod: Record<string, unknown>): number | null {
  try {
    const d = (mod.kicadCollabTestUndoDepth as () => unknown).call(mod);
    return typeof d === 'number' && Number.isSafeInteger(d) && d >= 0 ? d : null;
  } catch { return null; }
}

/**
 * sheet.increment: the checks, in order, every one before any effect: the
 * args (bad_args), then the schematic gate (unsupported in another frame,
 * not_ready before ev.ready, unsupported naming the first missing export,
 * not_ready with no schematic open, busy while a load is parked, a popup
 * menu or a dialog is up, or a placed item hangs off the pointer). Then the
 * engine's shift: anything but true answers not_applied; else the answer
 * waits for the apply queue to empty (not_applied past the limit) and reads
 * the undo depth: `{ shifted, depth }`, shifted true when the depth moved.
 */
export async function sheetIncrement(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const a = readIncrementArgs(args);
  if (a == null) return fail('bad_args', OP);
  const g = ctx.schematicGate(OP, INCREMENT_EXPORTS);
  if (refused(g)) return g;
  const before = depthOf(g.mod);
  if (before == null) return fail('island_error', 'the engine answered an undo depth of another shape');
  const t0 = Date.now();
  let queued: unknown;
  try {
    queued = await (g.mod.kicadSchIncrementAnnotations as (json: string) => unknown)(JSON.stringify({ first: a.first, by: a.by, allSheets: a.allSheets }));
  } catch (err) {
    return fail('island_error', err instanceof Error ? err.message : String(err));
  }
  if (queued !== true) return fail('not_applied', OP);
  if (!(await ctx.applyIdle(ctx.timing.incrementMs ?? INCREMENT_MS))) return fail('not_applied', OP);
  const depth = depthOf(g.mod);
  if (depth == null) return fail('island_error', 'the engine answered an undo depth of another shape');
  ctx.log('[sheet]', OP, a.first, `+${a.by}`, a.allSheets ? 'all sheets' : 'this sheet', `${Date.now() - t0} ms`);
  return ok({ shifted: depth !== before, depth });
}

export default {
  unit: 'st-incanno-i',
  frames: ['sch'],
  frameRefusal: 'designators shift in a sch frame',
  capNames: [INCREMENT_CAP],
  caps: (mod, frame) => (frame === 'sch' && hasAll(mod, INCREMENT_EXPORTS) ? [INCREMENT_CAP] : []),
  held: [INCREMENT_ACTION],
  heldRows: [{ action: INCREMENT_ACTION, frames: ['sch'], cap: INCREMENT_CAP }],
  ops: {
    'sheet.increment': { run: sheetIncrement },
  },
} satisfies ExtUnit;
