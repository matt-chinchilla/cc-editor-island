// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { describe, expect, it } from 'vitest';
import { seedsFor } from './seeds';
import { SHEET_THEME, sheetThemeOf } from './sheet-theme';
import ledger from './user.hotkeys?raw';
import symedit from './symedit.hotkeys?raw';
import defaultsJson from './pencil-tools.defaults.json?raw';
import { poolsOf } from './pencil-tools.gen.mjs';

describe('the seeds', () => {
  it.each(['day', 'night'] as const)('select the one viewer palette by %s', (theme) => {
    const s = seedsFor(theme);
    expect(s.colorTheme).toBe('circuitcenter');
    const names = s.colors.map((c) => c.name);
    expect(names).toEqual(['circuitcenter.json', 'circuitcenter-light.json', 'circuitcenter-dark.json', 'circuitcenter-sheet.json']);
    const t = JSON.parse(s.colors[0].json);
    expect(t.meta).toEqual({ name: 'Circuit Center', version: 5 });
    // The viewer's Witch Hazel: its schematic paper, the black its board canvas
    // clears to, its front copper.
    expect(t.schematic.background).toBe('rgb(19, 18, 24)');
    expect(t.board.background).toBe('rgb(0, 0, 0)');
    expect(t.board.copper.f).toBe('rgb(226, 114, 153)');
  });

  it('carry the drawing sheet editor\'s theme: the palette with the drawing sheet in a color that shows', () => {
    // The palette paints schematic.worksheet transparent (no page frame on a schematic),
    // and that one color is what KiCad's drawing sheet editor draws every item of a sheet
    // in (DS_RENDER_SETTINGS::LoadColors): with the palette itself a sheet's lines and
    // texts showed only while selected.
    const s = seedsFor('day');
    const palette = JSON.parse(s.colors[0].json);
    const sheet = JSON.parse(s.colors.find((c) => c.name === `${SHEET_THEME}.json`)!.json);
    expect(palette.schematic.worksheet).toBe('rgba(0, 0, 0, 0)');
    expect(sheet.schematic.worksheet).toBe('rgb(100, 190, 203)');
    expect(sheet.schematic.worksheet).toBe(palette.board.worksheet);
    expect(sheet.schematic.page_limits).toBe(palette.board.page_limits);
    expect(sheet.meta).toEqual({ name: 'Circuit Center sheet', version: palette.meta.version });
    // Everything else is the viewer's palette, key for key.
    const rest = (t: { schematic: Record<string, unknown> }) => ({ ...t, meta: null, schematic: { ...t.schematic, worksheet: null, page_limits: null } });
    expect(rest(sheet)).toEqual(rest(palette));
    // The editors of a design keep the palette.
    expect(s.colorTheme).toBe('circuitcenter');
    expect(sheetThemeOf('not json')).toBe('not json');
  });

  it('turn the anti-aliasing off, so the full-frame canvas keeps up with the cursor', () => {
    const s = seedsFor('day');
    expect(s.common.graphics).toEqual({ antialiasing_mode: 0 });
    // The keys the stage 1c seeds carry are still there beside it.
    expect(s.common.api).toEqual({ enable_server: false });
    // KiCad's own switcher window never flashes over the canvas on a cycle key.
    expect(s.common.input).toEqual({ hotkey_feedback: false });
    expect((s.common.appearance as { toolbar_icon_size: number }).toolbar_icon_size).toBe(24);
  });

  it('carry the symbol editor\'s chords after the ledger, each on a chord nothing else of the schematic\'s pool takes', () => {
    const lines = (t: string) => t.split('\n').filter((l) => l !== '').map((l) => l.split('\t'));
    expect(seedsFor('day').hotkeys).toBe(ledger + symedit);
    const own = lines(symedit);
    expect(own).toHaveLength(10);
    // The pool is per editor (pencil-tools.gen.mjs poolsOf): a board or drawing sheet action may hold the same chord.
    const sch = (action: string): boolean => poolsOf(action).includes('sch');
    const taken = new Set([
      ...lines(ledger).filter(([a]) => sch(a!)).flatMap(([, k, k2]) => [k, k2]).filter((k) => k),
      ...Object.entries(JSON.parse(defaultsJson) as Record<string, string | null>).filter(([a, k]) => k != null && sch(a)).map(([, k]) => k!),
    ]);
    const actions = new Set(lines(ledger).map(([a]) => a));
    for (const [action, key, secondary] of own) {
      expect(key, action).toMatch(/^Ctrl\+Alt\+Shift\+[0-9]$/);
      expect(taken.has(key!), key).toBe(false);
      expect(actions.has(action!), action).toBe(false);
      // Rotate clockwise keeps KiCad's own Shift+R beside its chord: a host's
      // key.press of a Shift and letter alone does not reach KiCad.
      expect(secondary).toBe(action === 'eeschema.InteractiveEdit.rotateCW' ? 'Shift+R' : '');
    }
    expect(new Set(own.map(([, k]) => k)).size).toBe(own.length);
  });
});
