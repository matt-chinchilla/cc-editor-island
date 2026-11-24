// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The Lab Sheet seeds: the three canvas color themes, the toolbar layouts, the
// hotkeys and the kicad_common.json keys the island writes before main().
import palette from './colors/circuitcenter.json?raw';
import light from './colors/circuitcenter-light.json?raw';
import dark from './colors/circuitcenter-dark.json?raw';
import pcb from './toolbars/pcbnew-toolbars.json?raw';
import sch from './toolbars/eeschema-toolbars.json?raw';
import hotkeys from './user.hotkeys?raw';
import symeditHotkeys from './symedit.hotkeys?raw';
import type { Seeds } from '../loader/src/wasm/boot';
import { SHEET_THEME, sheetThemeOf } from './sheet-theme';
import type { Theme } from '../src/types';
import { KEPT_THEME, themeFileText, type ThemeJson } from './kept';

/**
 * The wave units' own chords (theme/hotkeys/<unit>.hotkeys, KiCad's hotkeys
 * format, one file per unit; written by the ST-PRESS run, theme/pencil/README.md),
 * seeded after the ledger in file name order. None today.
 */
const UNIT_HOTKEYS: string = Object.entries(import.meta.glob('./hotkeys/*.hotkeys', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
  .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  .map(([, text]) => (text.endsWith('\n') || text === '' ? text : `${text}\n`))
  .join('');

/**
 * The seeds for a boot by day or night. With `kept` (the host's canvas colors
 * the island kept, theme/kept.ts) they are seeded as one more theme and
 * selected in place of the palette, and the drawing sheet editor's theme is
 * laid over them in place of the palette.
 */
export function seedsFor(theme: Theme, kept: ThemeJson | null = null): Seeds {
  const keptText = kept == null ? null : themeFileText(kept);
  return {
    // The one palette the viewer draws with, by day and by night (spec D16); the
    // two Lab Sheet themes stay seeded for a later theme switch.
    colors: [
      { name: 'circuitcenter.json', json: palette },
      { name: 'circuitcenter-light.json', json: light },
      { name: 'circuitcenter-dark.json', json: dark },
      // The drawing sheet editor's own: the palette with the drawing sheet in a color that shows (sheet-theme.ts).
      { name: `${SHEET_THEME}.json`, json: sheetThemeOf(keptText ?? palette) },
      ...(keptText == null ? [] : [{ name: `${KEPT_THEME}.json`, json: keptText }]),
    ],
    colorTheme: keptText == null ? 'circuitcenter' : KEPT_THEME,
    toolbars: [{ name: 'pcbnew-toolbars.json', json: pcb }, { name: 'eeschema-toolbars.json', json: sch }],
    // The symbol editor's own chords follow the pencil-tools ledger: Ctrl+Alt+Shift
    // and a digit, which neither the ledger's pool nor KiCad's defaults use.
    hotkeys: hotkeys + symeditHotkeys + UNIT_HOTKEYS,
    common: {
      appearance: { icon_theme: theme === 'night' ? 1 : 0, toolbar_icon_size: 24, use_icons_in_menus: true },
      api: { enable_server: false },
      // No hotkey feedback: KiCad's cycle keys (H's inactive layer modes, the layer
      // pair, the grid) otherwise flash a switcher window of its own over the canvas
      // (measured for H on Glasgow, engine run 14, the wave 2 chord e2e).
      input: { hotkey_feedback: false },
      // No anti-aliasing (0): the default supersampling (2) renders the full-frame canvas
      // at twice its size each way on every repaint, and SMAA (1) has the engine drop its
      // GL canvas for the software renderer (measured 2026-10-01, task F1 report).
      graphics: { antialiasing_mode: 0 },
    },
  };
}
