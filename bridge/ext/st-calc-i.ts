// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// Calculator Tools opens the host's Calculator tab (PROTOCOL.md ev.openTool,
// cap openCalculator): KiCad's PCB Calculator is a separate program, which the
// browser build cannot start, so the host's own calculator stands in for it.
//
// Two ways reach it, both with no KiCad window. KiCad's Tools > Calculator
// Tools runs COMMON_CONTROL::Execute(PCB_CALCULATOR_EXE), whose ExecuteFile
// hands the tool's name to window.kicadWebOpenTool: the host tool below maps
// pcb_calculator to "calculator" (src/frames.ts hostToolFor), so the frame
// sends ev.openTool { frame: "calculator" } and boots nothing. A key bound to
// the action (it has no default key) is held as every held row is, through the
// engine's slot since run 12 (marker kicadHostActions), and sends
// ev.held { action }; on an engine whose menus ask the slot too (run 15,
// heldMenus) the menu item is held the same way.
import { hasAll, type ExtUnit, type HeldRow } from './contract';

/** The cap ev.ready lists when the frame hands Calculator Tools to the host. */
export const OPEN_CALCULATOR_CAP = 'openCalculator';
/** KiCad's action (common/tool/actions.cpp ACTIONS::showCalculatorTools). */
export const SHOW_CALCULATOR_TOOLS = 'common.Control.showCalculatorTools';
/** The tool name KiCad hands to kicadWebOpenTool (PCB_CALCULATOR_EXE) and the host's name for it. */
export const CALCULATOR_TOOL = 'pcb_calculator';
export const CALCULATOR_FRAME = 'calculator';
/** Run 12's marker: the engine asks the page before a key's action (bridge/held.ts HELD_EXPORT). */
const HOST_ACTIONS_EXPORT = 'kicadHostActions';

/** The frames whose Tools menu holds Calculator Tools. */
const CALC_FRAMES = ['sch', 'pcb'] as const;

export const ST_CALC_ROWS: readonly HeldRow[] = Object.freeze([
  Object.freeze({ action: SHOW_CALCULATOR_TOOLS, frames: Object.freeze([...CALC_FRAMES]), cap: OPEN_CALCULATOR_CAP }),
]);

export default {
  unit: 'st-calc-i',
  capNames: [OPEN_CALCULATOR_CAP],
  caps: (mod, frame) => ((CALC_FRAMES as readonly string[]).includes(frame) && hasAll(mod, [HOST_ACTIONS_EXPORT]) ? [OPEN_CALCULATOR_CAP] : []),
  held: [SHOW_CALCULATOR_TOOLS],
  heldRows: ST_CALC_ROWS,
  hostTools: { [CALCULATOR_TOOL]: CALCULATOR_FRAME },
} satisfies ExtUnit;
