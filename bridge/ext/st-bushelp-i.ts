// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// Show Bus Syntax Help, held (PROTOCOL.md ev.held): KiCad's Inspect > Show Bus
// Syntax Help would open an HTML window of KiCad's. In a sch frame the frame
// takes the action and sends ev.held { action }; the host opens its own help
// card on how bus names are written in its place, and no window of KiCad's
// opens.
//
// The row stands under the built in pseudo-cap heldKeys (the door is the
// host's own page, no engine export of its own): a key reaches it on every
// engine that asks the page (run 12 on); the menu item reaches it on an engine
// whose menus ask as keys do (run 15, cap heldMenus, unit st-hold-i).
import type { ExtUnit, HeldRow } from './contract';

/** KiCad's action name (eeschema/tools/sch_actions.cpp, SCH_ACTIONS::showBusSyntaxHelp). */
export const SHOW_BUS_SYNTAX_HELP = 'eeschema.InspectionTool.showBusSyntaxHelp';

/** This unit's one held row: the schematic frame, under heldKeys. */
export const ST_BUSHELP_ROWS: readonly HeldRow[] = Object.freeze([
  Object.freeze({ action: SHOW_BUS_SYNTAX_HELP, frames: Object.freeze(['sch'] as const), cap: 'heldKeys' }),
]);

export default {
  unit: 'st-bushelp-i',
  held: ST_BUSHELP_ROWS.map((r) => r.action),
  heldRows: ST_BUSHELP_ROWS,
} satisfies ExtUnit;
