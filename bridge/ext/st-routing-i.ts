// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-routing-i (PROTOCOL.md settings.get and settings.set, the router and
// layer pair sections): KiCad's interactive router settings, its current track,
// via and differential pair sizes, and its layer pairs, read and set with no
// KiCad window. Engine run 15 (st-routing-e) registers the board sections
// router and layerPairs in kicadSettingsGet and kicadSettingsSet; each cap
// settings:<section> is listed in a pcb frame exactly when the engine's
// kicadSettingsSections() names the section in its board half, so on engine
// run 14 neither is. KiCad's three router windows (Interactive Router Settings,
// Set Layer Pair, Differential Pair Dimensions) are held in the pcb frame under
// the cap of the section that replaces each: the host opens its own Routing
// fold instead.
import { hasAll, isObj, type ExtUnit, type HeldRow, type SettingsSection } from './contract';

/** The engine marker that lists the settings sections it takes (engine run 15). */
export const SECTIONS_EXPORT = 'kicadSettingsSections';
/** The run 14 exports a settings op calls. */
const SETTINGS_CALLS = ['kicadSettingsGet', 'kicadSettingsSet'] as const;

export const ROUTER = 'router';
export const LAYER_PAIRS = 'layerPairs';
export const ROUTER_CAP = `settings:${ROUTER}`;
export const LAYER_PAIRS_CAP = `settings:${LAYER_PAIRS}`;

/** KiCad's router windows the host's Routing fold replaces. */
export const SETTINGS_DIALOG = 'pcbnew.InteractiveRouter.SettingsDialog';
export const SELECT_LAYER_PAIR = 'pcbnew.InteractiveRouter.SelectLayerPair';
export const DIFF_PAIR_DIALOG = 'pcbnew.InteractiveRouter.DiffPairDialog';

/** KiCad's own switches of the router (`tools.pns`, PNS::ROUTING_SETTINGS). */
export const ROUTER_SWITCHES: readonly string[] = Object.freeze([
  'remove_loops', 'smart_pads', 'shove_vias', 'suggest_finish', 'follow_mouse', 'free_angle_mode', 'snap_to_tracks', 'snap_to_pads',
  'optimize_dragged_track', 'auto_posture', 'fix_all_segments',
]);
/** The router's choices, each 0 to 2: mode (highlight collisions, shove, walk around) and effort (low, medium, full). */
export const ROUTER_CHOICES: readonly string[] = Object.freeze(['mode', 'effort']);

/**
 * The current sizes a set may name, per object (mm). The current figures
 * (`width`, `diameter`, `drill`, `gap`, `viaGap`) are read only: a get carries
 * them, a set never does.
 */
export const CURRENT_SIZES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  currentTrack: Object.freeze(['customWidth']),
  currentVia: Object.freeze(['customDiameter', 'customDrill']),
  currentDiffPair: Object.freeze(['customWidth', 'customGap', 'customViaGap']),
});
/** The engine's bounds of a custom size, in mm. */
export const CUSTOM_MM_MIN = 0.001;
export const CUSTOM_MM_MAX = 100;

/** The most saved layer pairs one set carries (the engine's bound). */
export const MAX_LAYER_PAIRS = 256;
/** The longest name of a saved layer pair, in characters. */
export const MAX_PAIR_NAME = 128;
/** A copper layer by its file name: F.Cu, In1.Cu to In30.Cu, B.Cu. */
const COPPER_RE = /^(?:F|B|In(?:[1-9]|[12][0-9]|30))\.Cu$/;

const isIndex = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isCustomMm = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v >= CUSTOM_MM_MIN && v <= CUSTOM_MM_MAX;
const isCopper = (v: unknown): v is string => typeof v === 'string' && COPPER_RE.test(v);

/** One current object of a set: at least one key, each `index`, `custom` or one of its custom sizes. */
function currentFits(sizes: readonly string[], v: unknown): boolean {
  if (!isObj(v)) return false;
  const entries = Object.entries(v);
  return entries.length > 0 && entries.every(([k, x]) =>
    (k === 'index' && isIndex(x)) || (k === 'custom' && typeof x === 'boolean') || (sizes.includes(k) && isCustomMm(x)));
}

/**
 * A router set's value read closed: mode and effort an integer 0 to 2, each
 * switch a boolean, each current object closed on its settable keys. The
 * common checks (a plain object with a key at least) come first, in
 * bridge/settings.ts; the engine checks an index against the board's lists.
 */
export function routerFits(value: Readonly<Record<string, unknown>>): boolean {
  return Object.entries(value).every(([k, v]) => {
    if (ROUTER_CHOICES.includes(k)) return v === 0 || v === 1 || v === 2;
    if (ROUTER_SWITCHES.includes(k)) return typeof v === 'boolean';
    const sizes = Object.hasOwn(CURRENT_SIZES, k) ? CURRENT_SIZES[k] : undefined;
    return sizes != null && currentFits(sizes, v);
  });
}

/** Two different copper layers by file name, closed on `extra` more keys. */
function pairFits(v: unknown, extra: readonly string[]): boolean {
  if (!isObj(v)) return false;
  if (!Object.keys(v).every((k) => k === 'top' || k === 'bottom' || extra.includes(k))) return false;
  return isCopper(v.top) && isCopper(v.bottom) && v.top !== v.bottom;
}

/** One saved pair: `top`, `bottom`, an optional `enabled` and an optional `name` of at most 128 characters. */
function savedPairFits(v: unknown): boolean {
  if (!pairFits(v, ['enabled', 'name']) || !isObj(v)) return false;
  if (Object.hasOwn(v, 'enabled') && typeof v.enabled !== 'boolean') return false;
  return !Object.hasOwn(v, 'name') || (typeof v.name === 'string' && [...v.name].length <= MAX_PAIR_NAME);
}

/**
 * A layer pairs set's value read closed: `pairs` (the whole saved list, at
 * most 256 rows) and `current` (`{ top, bottom }`), either or both. The
 * engine checks that each layer is one the board enables.
 */
export function layerPairsFits(value: Readonly<Record<string, unknown>>): boolean {
  return Object.entries(value).every(([k, v]) => {
    if (k === 'pairs') return Array.isArray(v) && v.length <= MAX_LAYER_PAIRS && v.every(savedPairFits);
    if (k === 'current') return pairFits(v, []);
    return false;
  });
}

/** The two sections as bridge/settings.ts takes them beside the built ins. */
export const ROUTING_SECTIONS: Readonly<Record<string, SettingsSection>> = Object.freeze({
  [ROUTER]: { frames: ['pcb'], check: routerFits },
  [LAYER_PAIRS]: { frames: ['pcb'], check: layerPairsFits },
});

/**
 * The board sections the engine takes: kicadSettingsSections() answers
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

/** The caps of this unit the running engine and frame take, in a fixed order. */
export function routingCaps(mod: Record<string, unknown> | null | undefined, frame: string): string[] {
  if (frame !== 'pcb' || mod == null || !hasAll(mod, SETTINGS_CALLS)) return [];
  const names = boardSections(mod);
  if (names == null) return [];
  return [ROUTER, LAYER_PAIRS].filter((s) => names.includes(s)).map((s) => `settings:${s}`);
}

/** The held rows: each router window in the pcb frame, under the cap of the section that replaces it. */
export const ROUTING_ROWS: readonly HeldRow[] = Object.freeze([
  Object.freeze({ action: SETTINGS_DIALOG, frames: Object.freeze(['pcb'] as const), cap: ROUTER_CAP }),
  Object.freeze({ action: SELECT_LAYER_PAIR, frames: Object.freeze(['pcb'] as const), cap: LAYER_PAIRS_CAP }),
  Object.freeze({ action: DIFF_PAIR_DIALOG, frames: Object.freeze(['pcb'] as const), cap: ROUTER_CAP }),
]);

export default {
  unit: 'st-routing-i',
  capNames: [ROUTER_CAP, LAYER_PAIRS_CAP],
  caps: (mod, frame) => routingCaps(mod, frame),
  settingsSections: ROUTING_SECTIONS,
  held: [SETTINGS_DIALOG, SELECT_LAYER_PAIR, DIFF_PAIR_DIALOG],
  heldRows: ROUTING_ROWS,
} satisfies ExtUnit;
