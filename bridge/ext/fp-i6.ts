// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// fp-i6 (FP spec 6.2, "Ops, events, held keys"): the footprint editor's held
// actions and the board's footprint doors. In an fpedit frame, under fp-i1's
// cap fpedit, every action whose window of KiCad's the host's footprint editor
// page replaces (its saves, the panes, the footprint's own windows, the pad
// windows, the cleanup and text windows, the picture and drawing imports, the
// wizards) is held, and the frame sends ev.held { action } in its place; in a
// pcb frame, under fp-i4's cap footprintEdit, KiCad's Edit Footprint, Edit
// Library Footprint and Footprint Editor are held, so the host opens its own
// footprint editor. The engine asks (kicad cc/main ACTION_MANAGER::RunHotKey,
// engine run 12, and the menus of K-HOLD on run 15); this table alone decides.
// The unit adds no op, cap, event or frame: each row waits on the cap of the
// unit whose op the host's page runs, so a host that cannot run the page never
// has KiCad's window taken from it. Every name is copied from KiCad's
// common/tool/actions.cpp and pcbnew/tools/pcb_actions.cpp.
import type { ExtUnit, HeldRow } from './contract';
import { FPEDIT_CAP, FPEDIT_FRAME } from '../fpedit/common';
import { FOOTPRINT_EDIT_CAP } from './fp-i4';

/** The actions held in an fpedit frame under fpedit, in FP spec 6.2's order. */
export const FPEDIT_HELD_ACTIONS: readonly string[] = Object.freeze([
  'common.Control.save',
  'common.Control.saveAs',
  'common.Control.revert',
  'common.Control.print',
  'common.Control.quit',
  'common.Interactive.find',
  'common.Control.showDatasheet',
  'common.Control.showProperties',
  'common.Control.showLibraryTree',
  'common.Control.show3DViewer',
  'common.Control.showFootprintBrowser',
  'common.Control.newLibrary',
  'common.Control.addLibrary',
  'pcbnew.ModuleEditor.newFootprint',
  'pcbnew.ModuleEditor.createFootprint',
  'pcbnew.ModuleEditor.editFootprint',
  'pcbnew.ModuleEditor.duplicateFootprint',
  'pcbnew.ModuleEditor.renameFootprint',
  'pcbnew.ModuleEditor.deleteFootprint',
  'pcbnew.ModuleEditor.cutFootprint',
  'pcbnew.ModuleEditor.copyFootprint',
  'pcbnew.ModuleEditor.pasteFootprint',
  'pcbnew.ModuleEditor.importFootprint',
  'pcbnew.ModuleEditor.exportFootprint',
  'pcbnew.ModuleEditor.footprintProperties',
  'pcbnew.ModuleEditor.padTable',
  'pcbnew.ModuleEditor.checkFootprint',
  'pcbnew.ModuleEditor.loadFootprintFromBoard',
  'pcbnew.ModuleEditor.saveFootprintToBoard',
  'pcbnew.ModuleEditor.repairFootprint',
  'pcbnew.EditorControl.EditLibFpInFpEditor',
  'pcbnew.Control.previousFootprint',
  'pcbnew.Control.nextFootprint',
  'pcbnew.PadTool.defaultPadProperties',
  'pcbnew.PadTool.enumeratePads',
  'pcbnew.PadTool.PushPadSettings',
  'pcbnew.GlobalEdit.cleanupGraphics',
  'pcbnew.GlobalEdit.editTextAndGraphics',
  // A pencil press of these two arrives as ev.held too: the host opens its
  // Add a picture and Import a drawing doors (units fp-s6 and fp-s13).
  'pcbnew.InteractiveDrawing.placeImportedGraphics',
  'pcbnew.InteractiveDrawing.placeReferenceImage',
  'pcbnew.FpWizard.showWizards',
]);

/** The actions held in a pcb frame under footprintEdit: the board's doors into the footprint editor. */
export const BOARD_FOOTPRINT_DOORS: readonly string[] = Object.freeze([
  'pcbnew.EditorControl.EditFpInFpEditor',
  'pcbnew.EditorControl.EditLibFpInFpEditor',
  'common.Control.showFootprintEditor',
]);

/** This unit's held rows: each in its frame under its cap. */
export const FP_I6_ROWS: readonly HeldRow[] = Object.freeze([
  ...FPEDIT_HELD_ACTIONS.map((action) => Object.freeze({ action, frames: Object.freeze([FPEDIT_FRAME]), cap: FPEDIT_CAP })),
  ...BOARD_FOOTPRINT_DOORS.map((action) => Object.freeze({ action, frames: Object.freeze(['pcb']), cap: FOOTPRINT_EDIT_CAP })),
]);

export default {
  unit: 'fp-i6',
  held: [...new Set(FP_I6_ROWS.map((r) => r.action))],
  heldRows: FP_I6_ROWS,
} satisfies ExtUnit;
