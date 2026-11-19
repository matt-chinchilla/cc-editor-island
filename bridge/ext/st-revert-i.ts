// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The File card's doors (spec 4.6, PE40): KiCad's New, Open, Save As, Save a
// Copy and Revert would each open a file window of KiCad's over a project the
// host owns. The host stands in their place (New and Open open Open another
// with Exit's unsaved rule, Save As and Save a Copy are Save a copy, Revert is
// Revert to saved), so the five actions are held in a sch and a pcb frame under
// heldKeys and the frame sends ev.held { action } (PROTOCOL.md ev.held). A key
// reaches a row on every engine with run 12's slot; a menu item reaches it
// where the engine asks for menus too (st-hold-i's heldMenus, engine run 15).
// Open Recent has no action name in KiCad (a wx menu range), so no row holds it.
import type { ExtUnit, HeldRow } from './contract';

/** KiCad's actions for File > New, Open, Save As, Save a Copy and Revert (common/tool/actions.cpp). */
export const NEW = 'common.Control.new';
export const OPEN = 'common.Control.open';
export const SAVE_AS = 'common.Control.saveAs';
export const SAVE_COPY = 'common.Control.saveCopy';
export const REVERT = 'common.Control.revert';

/** This unit's held rows, one per action, each in both editors' frames. */
export const ST_REVERT_ROWS: readonly HeldRow[] = Object.freeze(
  [NEW, OPEN, SAVE_AS, SAVE_COPY, REVERT].map((action) =>
    Object.freeze({ action, frames: Object.freeze(['sch', 'pcb'] as const), cap: 'heldKeys' })),
);

export default {
  unit: 'st-revert-i',
  held: ST_REVERT_ROWS.map((r) => r.action),
  heldRows: ST_REVERT_ROWS,
} satisfies ExtUnit;
