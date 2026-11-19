// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// Copy the drawing (the File card, spec 4.6): KiCad's Export Drawing to
// Clipboard (File > Export > Drawing to Clipboard) would copy through wx's
// clipboard, which never reaches the browser's. The host's Copy the drawing
// stands in its place, so the action is held in a schematic frame under
// heldKeys and the frame sends ev.held { action } (PROTOCOL.md ev.held). A key
// holds it on every engine with run 12's slot; the menu item is held where the
// engine asks for menus too (st-hold-i's heldMenus, engine run 15). KiCad's
// table gives the action no default chord.
import type { ExtUnit, HeldRow } from './contract';

/** KiCad's action for Export Drawing to Clipboard. */
export const DRAW_SHEET_ON_CLIPBOARD = 'eeschema.EditorControl.drawSheetOnClipboard';

/** This unit's held row. */
export const ST_COPYDRAW_ROWS: readonly HeldRow[] = Object.freeze([
  Object.freeze({ action: DRAW_SHEET_ON_CLIPBOARD, frames: Object.freeze(['sch'] as const), cap: 'heldKeys' }),
]);

export default {
  unit: 'st-copydraw-i',
  held: ST_COPYDRAW_ROWS.map((r) => r.action),
  heldRows: ST_COPYDRAW_ROWS,
} satisfies ExtUnit;
