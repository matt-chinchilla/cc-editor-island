// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// Show Footprint Associations held (PROTOCOL.md ev.held): KiCad's Inspect >
// Show Footprint Associations (pcb_actions.cpp, run by
// BOARD_INSPECTION_TOOL::ShowFootprintLinks) opens DIALOG_FOOTPRINT_ASSOCIATIONS,
// a window of KiCad's own. The host's Linked to block of the board form stands
// in its place (the footprint's source and the schematic part it belongs to),
// so the island holds the action and the frame sends ev.held { action } for
// the host to open its board form on that block.
//
// The row waits on boardFootprints, the cap of board.footprints, which the
// Linked to block reads: it ships with the island and is listed on the
// engine's own export (kicadBoardFootprints), so a host that cannot read the
// links never has KiCad's window taken from it.
import type { ExtUnit, HeldRow } from './contract';

/** KiCad's Show Footprint Associations (pcb_actions.cpp). */
export const LINKS_ACTION = 'pcbnew.InspectionTool.ShowFootprintAssociations';
/** The cap of board.footprints, which the host's Linked to block reads. */
export const LINKS_CAP = 'boardFootprints';

/** This unit's held row, in a pcb frame under boardFootprints. */
export const ST_LINKS_ROWS: readonly HeldRow[] = Object.freeze([
  Object.freeze({ action: LINKS_ACTION, frames: Object.freeze(['pcb']), cap: LINKS_CAP }),
] as HeldRow[]);

export default {
  unit: 'st-links-i',
  held: ST_LINKS_ROWS.map((r) => r.action),
  heldRows: ST_LINKS_ROWS,
} satisfies ExtUnit;
