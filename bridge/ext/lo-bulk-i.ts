// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// Edit in bulk's doors (PROTOCOL.md ev.held): KiCad's Change Symbol, Update
// Symbol, Change Footprint and Update Footprint items (each in its one item
// and its whole design form) and the Zone manager open windows of KiCad's own
// (DIALOG_CHANGE_SYMBOLS, DIALOG_EXCHANGE_FOOTPRINTS, DIALOG_ZONE_MANAGER).
// The host's Edit in bulk pages stand in their place, so the island holds the
// nine actions and the frame sends ev.held { action } for the host to open its
// page: Refresh and swap for the eight Change and Update items, Copper areas
// for the Zone manager.
//
// Each row waits on the cap of the op the host's page runs: symbolExchange
// (symbols.exchange) in a sch frame, footprintExchange (footprints.exchange)
// and boardEdit (board.edit) in a pcb frame. Those caps ship with the island
// and are listed on the engine's own exports, so a host that cannot run the
// page never has KiCad's window taken from it. The doors table
// (contextMenuDoors.json, m1-i) names all nine as held and reads this unit's
// rows through the held union.
import type { ExtUnit, HeldRow } from './contract';

/** The cap of symbols.exchange, which the host's Refresh and swap runs in a schematic. */
export const SYMBOL_EXCHANGE_CAP = 'symbolExchange';
/** The cap of footprints.exchange, which the host's Refresh and swap runs on a board. */
export const FOOTPRINT_EXCHANGE_CAP = 'footprintExchange';
/** The cap of board.edit, which the host's Copper areas page runs. */
export const BOARD_EDIT_CAP = 'boardEdit';

/** The four symbol actions (KiCad's sch_actions.cpp), each opening DIALOG_CHANGE_SYMBOLS. */
export const SYMBOL_ACTIONS: readonly string[] = Object.freeze([
  'eeschema.InteractiveEdit.changeSymbol',
  'eeschema.InteractiveEdit.changeSymbols',
  'eeschema.InteractiveEdit.updateSymbol',
  'eeschema.InteractiveEdit.updateSymbols',
]);
/** The four footprint actions (KiCad's pcb_actions.cpp), each opening DIALOG_EXCHANGE_FOOTPRINTS. */
export const FOOTPRINT_ACTIONS: readonly string[] = Object.freeze([
  'pcbnew.GlobalEdit.changeFootprint',
  'pcbnew.GlobalEdit.changeFootprints',
  'pcbnew.GlobalEdit.updateFootprint',
  'pcbnew.GlobalEdit.updateFootprints',
]);
/** KiCad's Zone manager (pcb_actions.cpp), opening DIALOG_ZONE_MANAGER. */
export const ZONES_MANAGER = 'pcbnew.Control.zonesManager';

/** This unit's held rows, each in its frame under its cap. */
export const LO_BULK_ROWS: readonly HeldRow[] = Object.freeze([
  ...SYMBOL_ACTIONS.map((action) => ({ action, frames: ['sch'], cap: SYMBOL_EXCHANGE_CAP })),
  ...FOOTPRINT_ACTIONS.map((action) => ({ action, frames: ['pcb'], cap: FOOTPRINT_EXCHANGE_CAP })),
  { action: ZONES_MANAGER, frames: ['pcb'], cap: BOARD_EDIT_CAP },
].map((r) => Object.freeze({ ...r, frames: Object.freeze([...r.frames]) })) as HeldRow[]);

export default {
  unit: 'lo-bulk-i',
  held: LO_BULK_ROWS.map((r) => r.action),
  heldRows: LO_BULK_ROWS,
} satisfies ExtUnit;
