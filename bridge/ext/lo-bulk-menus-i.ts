// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// Edit in bulk's other doors (PROTOCOL.md ev.held): the bulk edit items of
// KiCad's own Edit and Tools menus that lo-bulk-i's nine leave out. Each opens
// a window of KiCad's (DIALOG_GLOBAL_EDIT_TRACKS_AND_VIAS,
// DIALOG_GLOBAL_EDIT_TEXT_AND_GRAPHICS in both editors,
// DIALOG_GLOBAL_EDIT_TEARDROPS, DIALOG_SWAP_LAYERS, DIALOG_GLOBAL_DELETION,
// DIALOG_CLEANUP_TRACKS_AND_VIAS, DIALOG_UNUSED_PAD_LAYERS,
// DIALOG_CLEANUP_GRAPHICS, and Repair Board's result box) that a tool of the
// host's Edit in bulk page stands in place of. With KiCad's menus shown they
// opened KiCad's windows over the drawing (the smoke pass of 2026-11-19); the
// island holds the ten and the frame sends ev.held { action } for the host to
// open its tool.
//
// Each row waits on the cap of the op the host's tool runs: boardEdit
// (board.edit) in a pcb frame, schEdit (sch.edit) in a sch frame. Both caps
// ship with the island and are listed on the engine's own exports, so a host
// that cannot run the tool never has KiCad's window taken from it. Two of the
// board actions are also the footprint editor's (fp-i6 holds them in an
// fpedit frame); a row here names the pcb frame only.
import type { ExtUnit, HeldRow } from './contract';

/** The cap of board.edit, which the host's board tools run. */
export const BOARD_EDIT_CAP = 'boardEdit';
/** The cap of sch.edit, which the host's Text and lines runs in a schematic. */
export const SCH_EDIT_CAP = 'schEdit';

/** The nine board actions (KiCad's pcb_actions.cpp), in the order of KiCad's Edit menu, then its Tools menu. */
export const BOARD_ACTIONS: readonly string[] = Object.freeze([
  'pcbnew.GlobalEdit.editTracksAndVias',
  'pcbnew.GlobalEdit.editTextAndGraphics',
  'pcbnew.GlobalEdit.editTeardrops',
  'pcbnew.GlobalEdit.swapLayers',
  'pcbnew.GlobalEdit.globalDeletions',
  'pcbnew.GlobalEdit.cleanupTracksAndVias',
  'pcbnew.GlobalEdit.removeUnusedPads',
  'pcbnew.GlobalEdit.cleanupGraphics',
  'pcbnew.Control.repairBoard',
]);
/** The schematic's Edit Text and Graphics Properties (KiCad's sch_actions.cpp). */
export const SCH_ACTIONS: readonly string[] = Object.freeze([
  'eeschema.InteractiveEdit.editTextAndGraphics',
]);

/** This unit's held rows, each in its frame under its cap. */
export const LO_BULK_MENU_ROWS: readonly HeldRow[] = Object.freeze([
  ...BOARD_ACTIONS.map((action) => ({ action, frames: ['pcb'], cap: BOARD_EDIT_CAP })),
  ...SCH_ACTIONS.map((action) => ({ action, frames: ['sch'], cap: SCH_EDIT_CAP })),
].map((r) => Object.freeze({ ...r, frames: Object.freeze([...r.frames]) })) as HeldRow[]);

export default {
  unit: 'lo-bulk-menus-i',
  held: LO_BULK_MENU_ROWS.map((r) => r.action),
  heldRows: LO_BULK_MENU_ROWS,
} satisfies ExtUnit;
