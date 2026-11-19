// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// sheet.reload (PROTOCOL.md): the open schematic or board reads its drawing
// sheet again, by engine run 15's kicadDrawingSheetReload (KiCad's own reload
// of the sheet the document names, no window of KiCad's). The host sends it
// after project.write of a .kicad_wks, so every plot and print from then on
// carries the new sheet. It is no edit: no undo step, the modified flag and
// ev.edited untouched (the engine's). Cap sheetReload in a sch or pcb frame,
// feature detected; on an engine without the export the op answers
// unsupported naming it and the cap is not listed.
import { fail, hasAll, noArgs, ok, refused, type Answer, type ExtUnit, type ResponderCtx } from './contract';

/** The engine exports sheet.reload calls: the reload, and the apply queue it waits on. */
export const SHEET_RELOAD_EXPORTS = ['kicadDrawingSheetReload', 'kicadCollabBusy'] as const;
export const SHEET_RELOAD_CAP = 'sheetReload';
/** The engine's apply queue is waited for at most this long when the bridge names no sheetReloadMs. */
export const SHEET_RELOAD_MS = 30_000;

const reloadMs = (ctx: ResponderCtx): number => ctx.timing.sheetReloadMs ?? SHEET_RELOAD_MS;

/**
 * sheet.reload: the checks, in order, every one before any effect: the args
 * (none, bad_args), then the frame's gate (schematicGate in a sch frame,
 * boardGate in a pcb frame: not_ready before ev.ready, unsupported naming the
 * first missing export, not_ready with no document open, busy while a load is
 * parked, a popup menu or a dialog is up, or a placed item hangs off the
 * pointer). Then the engine's kicadDrawingSheetReload: anything but true
 * answers not_applied; else the answer waits for the engine's apply queue to
 * empty (not_applied past the time limit).
 */
export async function sheetReload(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const op = 'sheet.reload';
  if (!noArgs(args)) return fail('bad_args', op);
  const g = ctx.frame === 'pcb' ? ctx.boardGate(op, SHEET_RELOAD_EXPORTS) : ctx.schematicGate(op, SHEET_RELOAD_EXPORTS);
  if (refused(g)) return g;
  let queued: unknown;
  const t0 = Date.now();
  try {
    queued = await (g.mod.kicadDrawingSheetReload as () => unknown)();
  } catch (err) {
    return fail('island_error', err instanceof Error ? err.message : String(err));
  }
  if (queued !== true) return fail('not_applied', op);
  if (!(await ctx.applyIdle(reloadMs(ctx)))) return fail('not_applied', op);
  ctx.log('[sheet]', 'sheet.reload', `${Date.now() - t0} ms`);
  return ok();
}

export default {
  unit: 'i-sheetreload',
  frames: ['sch', 'pcb'],
  frameRefusal: 'a drawing sheet reloads in a sch or a pcb frame',
  capNames: [SHEET_RELOAD_CAP],
  caps: (mod, frame) => ((frame === 'sch' || frame === 'pcb') && hasAll(mod, SHEET_RELOAD_EXPORTS) ? [SHEET_RELOAD_CAP] : []),
  ops: {
    'sheet.reload': { run: sheetReload },
  },
} satisfies ExtUnit;
