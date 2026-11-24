// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The kept host colors (theme/kept.ts): kept, forgotten, a bad kept value
// removed, and every boot seeded with them in place of the palette, the
// drawing sheet editor's theme laid over them.
import { describe, expect, it } from 'vitest';
import { KEPT_KEY, KEPT_THEME, keepTheme, readKept, readTheme, type KeptStore } from './kept';
import { seedsFor } from './seeds';
import { SHEET_THEME, sheetThemeOf } from './sheet-theme';
import palette from './colors/circuitcenter.json?raw';

function memory(init: Record<string, string> = {}): KeptStore & { map: Map<string, string> } {
  const map = new Map(Object.entries(init));
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); }, removeItem: (k) => { map.delete(k); } };
}
const WHITE = { schematic: { background: 'rgb(255, 255, 255)' }, board: { background: 'rgb(255, 255, 255)', worksheet: 'rgb(9, 9, 9)', page_limits: 'rgb(8, 8, 8)' }, meta: { name: 'White', version: 5 } };

describe('the kept colors', () => {
  it('keeps a theme, reads it back, and null forgets it', () => {
    const m = memory();
    expect(readKept(m)).toBeNull();
    keepTheme(WHITE, m);
    expect(m.map.get(KEPT_KEY)).toBe(JSON.stringify(WHITE));
    expect(readKept(m)).toEqual(WHITE);
    keepTheme(null, m);
    expect(m.map.has(KEPT_KEY)).toBe(false);
    expect(readKept(m)).toBeNull();
  });

  it('removes a kept value that does not parse or does not read as a theme', () => {
    for (const bad of ['{', 'null', '[]', '"x"', '{}', '{"schematic":"red"}', '{"schematic":{"background":null}}']) {
      const m = memory({ [KEPT_KEY]: bad });
      expect(readKept(m), bad).toBeNull();
      expect(m.map.has(KEPT_KEY), bad).toBe(false);
    }
  });

  it('never throws: no store, a store that throws', () => {
    expect(readKept(null)).toBeNull();
    keepTheme(WHITE, null);
    const throwing: KeptStore = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('full'); }, removeItem: () => { throw new Error('denied'); } };
    expect(readKept(throwing)).toBeNull();
    expect(() => keepTheme(WHITE, throwing)).not.toThrow();
    expect(readTheme(WHITE)).toEqual(WHITE);
  });

  it('seeds the kept theme and selects it, the drawing sheet editor\'s theme laid over it, and the palette with none kept', () => {
    const s = seedsFor('day', WHITE);
    expect(s.colorTheme).toBe(KEPT_THEME);
    const kept = s.colors.find((c) => c.name === `${KEPT_THEME}.json`);
    expect(JSON.parse(kept!.json).schematic.background).toBe('rgb(255, 255, 255)');
    const sheet = JSON.parse(s.colors.find((c) => c.name === `${SHEET_THEME}.json`)!.json);
    expect(sheet.schematic.background).toBe('rgb(255, 255, 255)');
    expect(sheet.schematic.worksheet).toBe('rgb(9, 9, 9)');
    expect(sheet.schematic.page_limits).toBe('rgb(8, 8, 8)');
    expect(seedsFor('night').colorTheme).toBe('circuitcenter');
    expect(seedsFor('night').colors.map((c) => c.name)).not.toContain(`${KEPT_THEME}.json`);
  });

  it('with nothing kept, seeds byte for byte as before: the palette selected, the sheet theme laid over the palette', () => {
    for (const theme of ['day', 'night'] as const) {
      expect(seedsFor(theme, null)).toEqual(seedsFor(theme));
      expect(seedsFor(theme).colors.find((c) => c.name === `${SHEET_THEME}.json`)!.json).toBe(sheetThemeOf(palette));
      expect(seedsFor(theme).colors[0].json).toBe(palette);
    }
  });

  it('keeps the footprint and symbol editors\' origin axes on, in their settings files only', () => {
    expect(seedsFor('day').settings).toEqual({ 'fpedit.json': { window: { grid: { axes_enabled: true } } }, 'symbol_editor.json': { window: { grid: { axes_enabled: true } } } });
  });
});
