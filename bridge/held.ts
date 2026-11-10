// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// ev.held (PROTOCOL.md): a KiCad hotkey whose window the host replaces, held in
// the engine and handed to the host.
//
// Our engine (kicad cc/main ACTION_MANAGER::RunHotKey, engine run 12) asks the
// page before it runs a hotkey's action: just before each RunAction of the
// chosen context or global action it calls
// window.kicadHostAction.onRequest(json) with `{action: <the action's name>}`.
// A truthy answer takes the key (the action does not run, so its window never
// opens); anything falsy, or a throw, lets KiCad run it as before. Only keys
// pass there: KiCad's own menus (behind chrome.show) still reach the action.
// The engine never decides which actions are held: this table does, so a
// later island holds more with no engine build. The engine says it asks with
// the marker export kicadHostActions.
import type { Frame } from '../src/types';

/** The marker export of an engine whose editors ask the page before a hotkey's action. */
export const HELD_EXPORT = 'kicadHostActions';
/** The pseudo-cap ev.ready lists when the engine has the marker. */
export const HELD_KEYS_CAP = 'heldKeys';
/** The engine's request is at most this long. */
const MAX_REQUEST = 1024;
/** A KiCad action name: dotted words ("pcbnew.DRCTool.runDRC"), at most 128 characters. */
const ACTION_RE = /^(?=.{1,128}$)[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/;

export interface HeldAction { action: string; frames: readonly Frame[]; cap: string }

/**
 * The actions the island holds, each in its frames and only while ev.ready
 * listed the cap the host's replacement needs (engine run A's design, 6.2):
 * Update PCB from Schematic (F8), the design rules and electrical rules
 * checkers and Annotate Schematic (our seeded chords), KiCad's 3D viewer
 * (Alt+3), the hierarchy, appearance and properties panes, and the datasheet.
 */
export const HELD_ACTIONS: readonly HeldAction[] = Object.freeze([
  { action: 'common.Control.updatePcbFromSchematic', frames: ['sch', 'pcb'], cap: 'boardUpdate' },
  { action: 'pcbnew.DRCTool.runDRC', frames: ['pcb'], cap: 'drc' },
  { action: 'eeschema.InspectionTool.runERC', frames: ['sch'], cap: 'check' },
  { action: 'eeschema.EditorControl.annotate', frames: ['sch'], cap: 'annotate' },
  { action: 'common.Control.show3DViewer', frames: ['pcb'], cap: HELD_KEYS_CAP },
  { action: 'eeschema.EditorTool.showHierarchy', frames: ['sch'], cap: HELD_KEYS_CAP },
  { action: 'pcbnew.Control.showLayersManager', frames: ['pcb'], cap: HELD_KEYS_CAP },
  { action: 'common.Control.showProperties', frames: ['sch', 'pcb'], cap: HELD_KEYS_CAP },
  { action: 'common.Control.showDatasheet', frames: ['sch'], cap: HELD_KEYS_CAP },
].map((h) => Object.freeze({ ...h, frames: Object.freeze([...h.frames]) as readonly Frame[] })));

/** The window slot the engine calls. */
export type HeldWindow = { kicadHostAction?: { onRequest?: (json: unknown) => boolean } };

/** The engine's request read closed: the action's name, or null for any other shape (KiCad then runs the action). */
export function readHeldRequest(json: unknown): string | null {
  if (typeof json !== 'string' || json.length > MAX_REQUEST) return null;
  let v: unknown;
  try { v = JSON.parse(json); } catch { return null; }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const keys = Object.keys(v);
  const action = (v as Record<string, unknown>).action;
  if (keys.length !== 1 || typeof action !== 'string' || !ACTION_RE.test(action)) return null;
  return action;
}

/** Whether the island holds `action` in this frame with these caps. */
export function heldTaken(action: string, frame: Frame, caps: readonly string[]): boolean {
  const h = HELD_ACTIONS.find((x) => x.action === action);
  return h != null && h.frames.includes(frame) && caps.includes(h.cap);
}

/**
 * Takes the engine's slot: a held action the gate admits is answered true and
 * handed to `send` once per press (an auto repeat of the key, `repeating`, is
 * taken too, so KiCad never opens the window, but sends nothing); every other
 * request false, so KiCad runs it. A throwing `send` answers false.
 */
export function installHeld(w: HeldWindow, opts: { frame: Frame; caps: readonly string[]; admit: () => boolean; repeating: () => boolean; send: (action: string) => void }): void {
  const caps = [...opts.caps];
  w.kicadHostAction = {
    onRequest: (json: unknown): boolean => {
      try {
        if (!opts.admit()) return false;
        const action = readHeldRequest(json);
        if (action == null || !heldTaken(action, opts.frame, caps)) return false;
        if (!opts.repeating()) opts.send(action);
        return true;
      } catch {
        return false;
      }
    },
  };
}
