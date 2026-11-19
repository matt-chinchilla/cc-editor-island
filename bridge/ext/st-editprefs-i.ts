// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-editprefs-i (PROTOCOL.md settings.get and settings.set, the editing and
// mouse sections): KiCad's Preferences pages for the schematic's editing
// options, the board's editing options and the mouse, read and set with no
// KiCad window. Engine run 15 (st-editprefs-e) registers the sections
// schEditing (sch), pcbEditing (pcb) and mouse (both frames, one object) in
// kicadSettingsGet and kicadSettingsSet; they are app settings, so a set makes
// no undo step, marks nothing modified and saves no file: the host keeps them
// per browser and sends them again after each boot. Each cap
// settings:<section> is listed exactly when the engine's kicadSettingsSections()
// names the section in the running frame's half, so on engine run 14 none is.
// KiCad's Preferences window itself (Ctrl+, and its menu item) is held in the
// sch and pcb frames under heldKeys: the host opens its own Editing fold
// instead (a symedit frame holds it already, bridge/held.ts).
import { hasAll, isObj, type ExtUnit, type HeldRow, type SettingsSection } from './contract';

/** The engine marker that lists the settings sections it takes (engine run 15). */
export const SECTIONS_EXPORT = 'kicadSettingsSections';
/** The run 14 exports a settings op calls (bridge/settings.ts SETTINGS_EXPORTS reads, without the busy probe). */
const SETTINGS_CALLS = ['kicadSettingsGet', 'kicadSettingsSet'] as const;

export const SCH_EDITING = 'schEditing';
export const PCB_EDITING = 'pcbEditing';
export const MOUSE = 'mouse';
export const SCH_EDITING_CAP = `settings:${SCH_EDITING}`;
export const PCB_EDITING_CAP = `settings:${PCB_EDITING}`;
export const MOUSE_CAP = `settings:${MOUSE}`;

/** KiCad's Preferences action, held in the sch and pcb frames. */
export const OPEN_PREFERENCES = 'common.SuiteControl.openPreferences';

/** One section's wire keys (KiCad's own dotted JSON paths) by kind: the engine checks each value's range. */
interface SectionKeys { bools: readonly string[]; numbers: readonly string[] }

/** PANEL_EDIT_OPTIONS' board half (PCBNEW_SETTINGS). */
export const PCB_EDITING_KEYS: SectionKeys = Object.freeze({
  bools: Object.freeze([
    'editing.flip_left_right', 'editing.esc_clears_net_highlight', 'editing.show_courtyard_collisions', 'editing.magnetic_graphics',
    'editing.ctrl_click_highlight', 'editing.auto_fill_zones', 'editing.allow_free_pads', 'pcb_display.ratsnest_footprint',
    'pcb_display.ratsnest_curved', 'pcb_display.show_page_borders',
  ]),
  numbers: Object.freeze([
    'editing.magnetic_pads', 'editing.magnetic_tracks', 'editing.track_drag_action', 'editing.arc_edit_mode', 'editing.pcb_angle_snap_mode',
    'editing.rotation_angle', 'pcb_display.ratsnest_thickness',
  ]),
});

/** PANEL_EESCHEMA_EDITING_OPTIONS (EESCHEMA_SETTINGS), the two sheet colors left out (colors stay the viewer's). */
export const SCH_EDITING_KEYS: SectionKeys = Object.freeze({
  bools: Object.freeze([
    'appearance.footprint_preview', 'system.never_show_rescue_dialog', 'autoplace_fields.enable', 'autoplace_fields.allow_rejustify',
    'autoplace_fields.align_to_grid', 'input.drag_is_move', 'drawing.auto_start_wires', 'input.esc_clears_net_highlight',
    'annotation.automatic', 'input.allow_unconstrained_pin_swaps',
  ]),
  numbers: Object.freeze([
    'drawing.new_power_symbols', 'drawing.line_mode', 'editing.arc_edit_mode', 'drawing.default_repeat_offset_x',
    'drawing.default_repeat_offset_y', 'drawing.repeat_label_increment',
  ]),
});

/** PANEL_MOUSE_SETTINGS (COMMON_SETTINGS). */
export const MOUSE_KEYS: SectionKeys = Object.freeze({
  bools: Object.freeze([
    'input.center_on_zoom', 'input.auto_pan', 'input.zoom_acceleration', 'input.zoom_speed_auto', 'input.horizontal_pan',
    'input.reverse_scroll_zoom', 'input.reverse_scroll_pan_h',
  ]),
  numbers: Object.freeze([
    'input.mouse_left', 'input.mouse_middle', 'input.mouse_right', 'input.motion_pan_modifier', 'input.scroll_modifier_zoom',
    'input.scroll_modifier_pan_h', 'input.scroll_modifier_pan_v', 'input.auto_pan_acceleration', 'input.zoom_speed',
  ]),
});

/**
 * A set's value read closed on the section's keys: every key one of the
 * section's, a boolean where KiCad keeps a switch and a finite number where it
 * keeps a number (the engine refuses a number outside what KiCad's panel
 * offers, bad_args). The common checks (a plain object with a key at least)
 * come first, in bridge/settings.ts.
 */
export function valueFits(keys: SectionKeys, value: Readonly<Record<string, unknown>>): boolean {
  return Object.entries(value).every(([k, v]) =>
    (keys.bools.includes(k) && typeof v === 'boolean') || (keys.numbers.includes(k) && typeof v === 'number' && Number.isFinite(v)));
}

/** The three sections as bridge/settings.ts takes them beside the built ins. */
export const EDITPREFS_SECTIONS: Readonly<Record<string, SettingsSection>> = Object.freeze({
  [SCH_EDITING]: { frames: ['sch'], check: (v) => valueFits(SCH_EDITING_KEYS, v) },
  [PCB_EDITING]: { frames: ['pcb'], check: (v) => valueFits(PCB_EDITING_KEYS, v) },
  [MOUSE]: { frames: ['sch', 'pcb'], check: (v) => valueFits(MOUSE_KEYS, v) },
});

/**
 * The sections the engine says the running frame takes: kicadSettingsSections()
 * answers `{ board: [names], schematic: [names] }`, a pcb frame reading its
 * board half and a sch frame its schematic half. Null when the engine has no
 * such marker, answers another shape (a throw included), or the frame is
 * neither.
 */
export function frameSections(mod: Record<string, unknown> | null | undefined, frame: string): string[] | null {
  const half = frame === 'pcb' ? 'board' : frame === 'sch' ? 'schematic' : null;
  const read = mod?.[SECTIONS_EXPORT];
  if (half == null || typeof read !== 'function') return null;
  let v: unknown;
  try { v = JSON.parse(String((read as () => unknown)())); } catch { return null; }
  if (!isObj(v)) return null;
  const list = v[half];
  if (!Array.isArray(list) || !list.every((s) => typeof s === 'string')) return null;
  return list as string[];
}

/** The caps of this unit the running engine and frame take, in a fixed order. */
export function editPrefsCaps(mod: Record<string, unknown> | null | undefined, frame: string): string[] {
  if (mod == null || !hasAll(mod, SETTINGS_CALLS)) return [];
  const names = frameSections(mod, frame);
  if (names == null) return [];
  const own = frame === 'pcb' ? PCB_EDITING : SCH_EDITING;
  const out: string[] = [];
  if (names.includes(own)) out.push(`settings:${own}`);
  if (names.includes(MOUSE)) out.push(MOUSE_CAP);
  return out;
}

/** The held row: KiCad's Preferences window, in both document frames, under the run 12 keys' cap. */
export const EDITPREFS_ROWS: readonly HeldRow[] = Object.freeze([
  Object.freeze({ action: OPEN_PREFERENCES, frames: Object.freeze(['sch', 'pcb'] as const), cap: 'heldKeys' }),
]);

export default {
  unit: 'st-editprefs-i',
  capNames: [SCH_EDITING_CAP, PCB_EDITING_CAP, MOUSE_CAP],
  caps: (mod, frame) => editPrefsCaps(mod, frame),
  settingsSections: EDITPREFS_SECTIONS,
  held: [OPEN_PREFERENCES],
  heldRows: EDITPREFS_ROWS,
} satisfies ExtUnit;
