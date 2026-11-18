// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The doors table (bridge/ext/contextMenuDoors.json, written by
// scripts/context-menu-doors.mjs from KiCad at the engine's pin): every action
// a canvas menu of KiCad's can show that opens a window of KiCad's own, and
// the door of ours that answers it. Held rows are read in the held union at
// run time (the built ins and every unit's heldRows), never copied here.
import { heldTaken, type HeldAction } from '../../held';
import type { Frame } from '../../../src/types';
import TABLE from '../contextMenuDoors.json';
import type { Door } from './menu';

/** One row of the table. `door`: held, prompt:<ask>, form:<cap>, run or none. */
export interface DoorRow { action: string; door: string; opens: string; menus: string[]; why: string }
/** The cap the prompt host lists (m1x-i): a prompt door shows only with it. */
export const PROMPTS_CAP = 'prompts';
/** The door grammar. */
export const DOOR_RE = /^(?:held|run|none|prompt:[a-z][A-Za-z]*|form:[a-z][A-Za-z0-9]*)$/;

export const DOOR_ROWS: readonly DoorRow[] = (TABLE as { rows: DoorRow[] }).rows;
const BY_ACTION = new Map(DOOR_ROWS.map((r) => [r.action, r]));

/** The table's row of an action, if it has one. */
export function doorRow(action: string): DoorRow | undefined {
  return BY_ACTION.get(action);
}

/**
 * An action's door in this frame now, null when it has none (it is then left
 * out of our menu, and action.run refuses it): a held action first (the
 * union, its cap listed); then the table's row; an action the table does not
 * name opens no window of KiCad's, so it runs.
 */
export function doorOf(action: string, frame: Frame, caps: readonly string[], held: readonly HeldAction[]): Door | null {
  if (heldTaken(action, frame, caps, held)) return 'held';
  const row = BY_ACTION.get(action);
  if (row == null || row.door === 'run') return 'run';
  if (row.door.startsWith('prompt:')) return caps.includes(PROMPTS_CAP) ? 'prompt' : null;
  if (row.door.startsWith('form:')) return caps.includes(row.door.slice('form:'.length)) ? 'run' : null;
  // held (not held in this frame, or its cap not listed) and none: no door here.
  return null;
}
