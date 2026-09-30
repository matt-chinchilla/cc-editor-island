// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The Lab Sheet seeds: the two canvas colour themes, the toolbar layouts, the
// hotkeys and the kicad_common.json keys the island writes before main().
import light from './colors/circuitcenter-light.json?raw';
import dark from './colors/circuitcenter-dark.json?raw';
import pcb from './toolbars/pcbnew-toolbars.json?raw';
import sch from './toolbars/eeschema-toolbars.json?raw';
import hotkeys from './user.hotkeys?raw';
import type { Seeds } from '../loader/src/wasm/boot';
import type { Theme } from '../src/types';

export function seedsFor(theme: Theme): Seeds {
  return {
    colors: [{ name: 'circuitcenter-light.json', json: light }, { name: 'circuitcenter-dark.json', json: dark }],
    colorTheme: theme === 'night' ? 'circuitcenter-dark' : 'circuitcenter-light',
    toolbars: [{ name: 'pcbnew-toolbars.json', json: pcb }, { name: 'eeschema-toolbars.json', json: sch }],
    hotkeys,
    common: { appearance: { icon_theme: theme === 'night' ? 1 : 0, toolbar_icon_size: 24, use_icons_in_menus: true }, api: { enable_server: false } },
  };
}
