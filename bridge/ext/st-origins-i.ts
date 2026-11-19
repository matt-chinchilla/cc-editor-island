// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-origins-i (PROTOCOL.md settings.get and settings.set, the origins
// section): the board's grid origin and its drill and place origin, read and
// set with no KiCad window. Engine run 15 (st-origins-e) registers the board
// section origins in kicadSettingsGet and kicadSettingsSet: the value is
// { grid_origin: { x, y }, aux_origin: { x, y } } in mm (KiCad's own names, the
// aux origin being the drill and place origin), a set names either or both,
// each exactly { x, y } within 1000 mm either way, and { x: 0, y: 0 } is
// KiCad's Reset. Like every setting, a set makes no undo step. The cap
// settings:origins is listed in a pcb frame exactly when the engine's
// kicadSettingsSections() names origins in its board half, so on engine run 14
// it is not. Under it KiCad's three origin actions (the grid origin dialog,
// its reset and the drill origin's reset) are held in the pcb frame: the host
// opens its own Origins fold instead. The schematic's grid origin reset is
// not held (the schematic has no Origins fold).
import { hasAll, isObj, type ExtUnit, type HeldRow, type SettingsSection } from './contract';

/** The engine marker that lists the settings sections it takes (engine run 15). */
export const SECTIONS_EXPORT = 'kicadSettingsSections';
/** The run 14 exports a settings op calls. */
const SETTINGS_CALLS = ['kicadSettingsGet', 'kicadSettingsSet'] as const;

export const ORIGINS = 'origins';
export const ORIGINS_CAP = `settings:${ORIGINS}`;
/** The value's two keys, KiCad's own (the board's design settings). */
export const GRID_ORIGIN = 'grid_origin';
export const AUX_ORIGIN = 'aux_origin';
/** Each coordinate within this many mm of the page origin, either way (the engine's bound). */
export const MAX_ORIGIN_MM = 1000;

/** KiCad's three origin actions the Origins fold replaces, held in the pcb frame. */
export const EDIT_GRID_ORIGIN = 'common.Control.editGridOrigin';
export const GRID_RESET_ORIGIN = 'common.Control.gridResetOrigin';
export const DRILL_RESET_ORIGIN = 'pcbnew.EditorControl.drillResetOrigin';

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** One origin: exactly { x, y }, each a finite number of mm within MAX_ORIGIN_MM either way. */
export function isOrigin(v: unknown): boolean {
  if (!isObj(v)) return false;
  const keys = Object.keys(v);
  if (keys.length !== 2 || !own(v, 'x') || !own(v, 'y')) return false;
  return [v.x, v.y].every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= MAX_ORIGIN_MM);
}

/**
 * A set's value read closed: grid_origin, aux_origin or both, each one origin.
 * The common checks (a plain object with a key at least) come first, in
 * bridge/settings.ts.
 */
export function originsFit(value: Readonly<Record<string, unknown>>): boolean {
  return Object.entries(value).every(([k, v]) => (k === GRID_ORIGIN || k === AUX_ORIGIN) && isOrigin(v));
}

/** The section as bridge/settings.ts takes it beside the built ins: a board setting the pcb frame reads and sets. */
export const ORIGINS_SECTIONS: Readonly<Record<string, SettingsSection>> = Object.freeze({
  [ORIGINS]: Object.freeze({ frames: Object.freeze(['pcb'] as const), check: originsFit }),
});

/**
 * The board sections the engine says it takes: kicadSettingsSections() answers
 * `{ board: [names], schematic: [names] }`. Null when the engine has no such
 * marker or answers another shape (a throw included).
 */
export function boardSections(mod: Record<string, unknown> | null | undefined): string[] | null {
  const read = mod?.[SECTIONS_EXPORT];
  if (typeof read !== 'function') return null;
  let v: unknown;
  try { v = JSON.parse(String((read as () => unknown)())); } catch { return null; }
  if (!isObj(v) || !Array.isArray(v.board) || !v.board.every((s) => typeof s === 'string')) return null;
  return v.board as string[];
}

/** The cap, in a pcb frame of an engine whose board half names origins. */
export function originsCaps(mod: Record<string, unknown> | null | undefined, frame: string): string[] {
  if (frame !== 'pcb' || mod == null || !hasAll(mod, SETTINGS_CALLS)) return [];
  return boardSections(mod)?.includes(ORIGINS) === true ? [ORIGINS_CAP] : [];
}

/** The held rows: KiCad's three origin actions, in the pcb frame only, under the cap. */
export const ORIGINS_ROWS: readonly HeldRow[] = Object.freeze(
  [EDIT_GRID_ORIGIN, GRID_RESET_ORIGIN, DRILL_RESET_ORIGIN].map((action) =>
    Object.freeze({ action, frames: Object.freeze(['pcb'] as const), cap: ORIGINS_CAP })),
);

export default {
  unit: 'st-origins-i',
  capNames: [ORIGINS_CAP],
  caps: (mod, frame) => originsCaps(mod, frame),
  settingsSections: ORIGINS_SECTIONS,
  held: [EDIT_GRID_ORIGIN, GRID_RESET_ORIGIN, DRILL_RESET_ORIGIN],
  heldRows: ORIGINS_ROWS,
} satisfies ExtUnit;
