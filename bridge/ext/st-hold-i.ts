// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// KiCad never shows (PROTOCOL.md ev.held, cap heldMenus): KiCad's menu,
// toolbar and key presses that would open a window of KiCad's with nothing of
// ours in its place are held, and the frame sends ev.held { action }.
//
// Engine run 15 (kicad cc/main K-HOLD) asks the page through run 12's
// hostHoldsAction for every menu item and toolbar button a press resolves to,
// as keys have asked since run 12, and asks for the 45 Set Language items as
// one name of ours, cc.Control.setLanguage (a wx menu range, no tool action).
// The engine says it asks with the marker export kicadHeldMenus; on an engine
// without it (run 14) the cap is not listed, so the language row is never
// taken, and the other rows are met only by a key, as every held row is.
//
// The rows here hold only what no door of the wave owns: Set Language, Remote
// Symbols' panel, Refresh Plugins, Open Plugin Directory and the scripting
// console (Python and IPC are out of the product: their menus do nothing).
// Each door unit holds its own actions in its own file; the doors table
// (m1-i) reads the union through ctx.heldRows().
import { hasAll, type ExtUnit, type HeldRow } from './contract';

/** The marker export of an engine whose menus and toolbars ask the page as keys do (engine run 15, K-HOLD). */
export const HELD_MENUS_EXPORT = 'kicadHeldMenus';
/** The cap ev.ready lists when the engine has the marker. */
export const HELD_MENUS_CAP = 'heldMenus';
/** Run 12's marker: the engine asks the page at all (bridge/held.ts HELD_EXPORT). */
const HOST_ACTIONS_EXPORT = 'kicadHostActions';
/** The name of ours the engine asks for any of KiCad's Set Language items. */
export const SET_LANGUAGE = 'cc.Control.setLanguage';

/** The frames whose menus the engine holds. */
const MENU_FRAMES = ['sch', 'pcb', 'symedit'] as const;

/** This unit's held rows, each in its frames under its cap. */
export const ST_HOLD_ROWS: readonly HeldRow[] = Object.freeze([
  { action: SET_LANGUAGE, frames: ['sch', 'pcb', 'symedit'], cap: HELD_MENUS_CAP },
  { action: 'eeschema.RemoteSymbols.showPanel', frames: ['sch'], cap: 'heldKeys' },
  { action: 'common.API.pluginsReload', frames: ['sch', 'pcb'], cap: 'heldKeys' },
  { action: 'pcbnew.ScriptingTool.pluginsShowFolder', frames: ['pcb'], cap: 'heldKeys' },
  { action: 'pcbnew.Control.showPythonConsole', frames: ['pcb'], cap: 'heldKeys' },
].map((r) => Object.freeze({ ...r, frames: Object.freeze([...r.frames]) })));

export default {
  unit: 'st-hold-i',
  capNames: [HELD_MENUS_CAP],
  // Both markers: K-HOLD asks through run 12's slot, so a menu is held only
  // where keys are.
  caps: (mod, frame) => ((MENU_FRAMES as readonly string[]).includes(frame) && hasAll(mod, [HELD_MENUS_EXPORT, HOST_ACTIONS_EXPORT]) ? [HELD_MENUS_CAP] : []),
  held: ST_HOLD_ROWS.map((r) => r.action),
  heldRows: ST_HOLD_ROWS,
} satisfies ExtUnit;
