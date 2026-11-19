// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// paste.special (PROTOCOL.md, small tools spec 6.1): KiCad's own Paste Special
// with the host's choice and no KiCad window (engine run 15's
// kicadPasteSpecial, unit st-paste-e). The engine reads exactly { mode,
// clearNets }: mode "unique" gives the pasted parts new designators, "keep"
// keeps them, "remove" clears them; clearNets (a board only) pastes a board
// clip with no net names. It runs KiCad's paste action with that choice in
// place of DIALOG_PASTE_SPECIAL: the items hang off the pointer and a press
// commits them as ONE undo step.
//
// The answer comes once the items hang off the pointer (the selection holds a
// uuid it did not hold before the call), with place's own timing; the paste
// is then joined to place's watch, so every gate answers busy until a click
// lands it or Esc leaves nothing.
//
// KiCad's own Paste Special (Ctrl+Shift+V and its menu item) is held under the
// cap pasteSpecial in a sch and a pcb frame, so it sends ev.held and opens
// nothing; the host opens its own choices. Everything is feature detected: on
// an engine without kicadPasteSpecial no frame lists pasteSpecial and the op
// answers unsupported naming it.
import { fail, hasAll, isObj, ok, refused, type Answer, type ExtUnit, type ResponderCtx } from './contract';
import { selection } from '../place';

/** The engine export and the op. */
export const PASTE_SPECIAL_EXPORT = 'kicadPasteSpecial';
export const PASTE_SPECIAL_OP = 'paste.special';
/** The pseudo-cap a frame that pastes with a choice lists. */
export const PASTE_SPECIAL_CAP = 'pasteSpecial';
/** The exports a frame needs: the paste and the selection read that tells the items hang. */
export const PASTE_SPECIAL_EXPORTS = [PASTE_SPECIAL_EXPORT, 'kicadCollabGetSelection'] as const;
/** KiCad's Paste Special action (common/tool/actions.cpp), held in both frames. */
export const HELD_PASTE_SPECIAL = 'common.Interactive.pasteSpecial';
export const PASTE_SPECIAL_FRAME_ONLY = 'a paste runs in a sch or pcb frame';
/** The three designator choices of KiCad's dialog, as the engine names them. */
export const PASTE_MODES = ['unique', 'keep', 'remove'] as const;
export type PasteMode = typeof PASTE_MODES[number];
/** How long KiCad may take to put the items on the pointer, unless the bridge's timing says placeMs (place's own bound). */
export const PASTE_SPECIAL_MS = 10_000;
/** How often the selection is read meanwhile, unless the bridge's timing says placePollMs. */
export const PASTE_SPECIAL_POLL_MS = 25;

export interface PasteSpecialArgs { mode: PasteMode; clearNets: boolean }

/**
 * paste.special's args read closed: `mode` (one of PASTE_MODES) and an
 * optional boolean `clearNets` (false when absent). Null for any other key or
 * type. Whether clearNets fits the frame is checked after.
 */
export function parsePasteSpecialArgs(args: unknown): PasteSpecialArgs | null {
  if (!isObj(args)) return null;
  const keys = Object.keys(args);
  if (!keys.includes('mode') || !keys.every((k) => k === 'mode' || k === 'clearNets')) return null;
  const { mode, clearNets } = args;
  if (typeof mode !== 'string' || !(PASTE_MODES as readonly string[]).includes(mode)) return null;
  if (keys.includes('clearNets') && typeof clearNets !== 'boolean') return null;
  return { mode: mode as PasteMode, clearNets: clearNets === true };
}

/**
 * paste.special: the checks in run A's order (the args, the frame, the engine,
 * a document open, busy), then kicadPasteSpecial called with exactly { mode,
 * clearNets }. The answer is {} once the items hang off the pointer; busy when
 * the engine refuses the call (it cannot paste now); not_applied when KiCad
 * put nothing on the pointer within the bound (the clipboard holds nothing
 * KiCad pastes); island_error when the frame closed.
 */
export async function pasteSpecial(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const op = PASTE_SPECIAL_OP;
  const a = parsePasteSpecialArgs(args);
  if (a == null) return fail('bad_args', op);
  const frame = ctx.frame as string;
  if (frame !== 'sch' && frame !== 'pcb') return fail('unsupported', PASTE_SPECIAL_FRAME_ONLY);
  if (frame === 'sch' && a.clearNets) return fail('bad_args', `${op}: clearNets is a board choice`);
  const g = frame === 'pcb' ? ctx.boardGate(op, PASTE_SPECIAL_EXPORTS) : ctx.schematicGate(op, PASTE_SPECIAL_EXPORTS);
  if (refused(g)) return g;
  const { w, mod } = g;
  const before = selection(w);
  if (before == null) return fail('unsupported', 'kicadCollabGetSelection');
  const t0 = Date.now();
  let taken: unknown = false;
  try { taken = (mod[PASTE_SPECIAL_EXPORT] as (json: string) => unknown)(JSON.stringify({ mode: a.mode, clearNets: a.clearNets })); } catch { taken = false; }
  if (taken !== true) return fail('busy', `${op}: the editor cannot paste now`);
  const ms = ctx.timing.placeMs ?? PASTE_SPECIAL_MS;
  const poll = ctx.timing.placePollMs ?? PASTE_SPECIAL_POLL_MS;
  const end = Date.now() + ms;
  for (;;) {
    if (ctx.closed()) return fail('island_error', 'the frame closed');
    const fresh = (selection(w) ?? []).find((u) => !before.includes(u));
    if (fresh != null) {
      ctx.placeStart(fresh);
      ctx.log(op, a.mode, a.clearNets ? 'clearNets' : '', 'on the pointer', `${Date.now() - t0} ms`);
      return ok({});
    }
    if (Date.now() >= end) return fail('not_applied', `${op}: KiCad put nothing on the pointer (the clipboard holds nothing it pastes)`);
    await new Promise((r) => setTimeout(r, poll));
  }
}

export default {
  unit: 'st-paste-i',
  frames: ['sch', 'pcb'],
  frameRefusal: PASTE_SPECIAL_FRAME_ONLY,
  ops: { [PASTE_SPECIAL_OP]: { run: pasteSpecial } },
  capNames: [PASTE_SPECIAL_CAP],
  caps: (mod, frame) => ((frame === 'sch' || frame === 'pcb') && hasAll(mod, PASTE_SPECIAL_EXPORTS) ? [PASTE_SPECIAL_CAP] : []),
  held: [HELD_PASTE_SPECIAL],
  heldRows: [{ action: HELD_PASTE_SPECIAL, frames: ['sch', 'pcb'], cap: PASTE_SPECIAL_CAP }],
} satisfies ExtUnit;
