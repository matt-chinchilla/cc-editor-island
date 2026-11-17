// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { describe, expect, it } from 'vitest';
import { seedsFor } from './seeds';
import ledger from './user.hotkeys?raw';
import symedit from './symedit.hotkeys?raw';
import defaultsJson from './pencil-tools.defaults.json?raw';

describe('the seeds', () => {
  it.each(['day', 'night'] as const)('select the one viewer palette by %s', (theme) => {
    const s = seedsFor(theme);
    expect(s.colorTheme).toBe('circuitcenter');
    const names = s.colors.map((c) => c.name);
    expect(names).toEqual(['circuitcenter.json', 'circuitcenter-light.json', 'circuitcenter-dark.json']);
    const t = JSON.parse(s.colors[0].json);
    expect(t.meta).toEqual({ name: 'Circuit Center', version: 5 });
    // The viewer's Witch Hazel: its schematic paper, the black its board canvas
    // clears to, its front copper.
    expect(t.schematic.background).toBe('rgb(19, 18, 24)');
    expect(t.board.background).toBe('rgb(0, 0, 0)');
    expect(t.board.copper.f).toBe('rgb(226, 114, 153)');
  });

  it('turn the anti-aliasing off, so the full-frame canvas keeps up with the cursor', () => {
    const s = seedsFor('day');
    expect(s.common.graphics).toEqual({ antialiasing_mode: 0 });
    // The keys the stage 1c seeds carry are still there beside it.
    expect(s.common.api).toEqual({ enable_server: false });
    expect((s.common.appearance as { toolbar_icon_size: number }).toolbar_icon_size).toBe(24);
  });

  it('carry the symbol editor\'s chords after the ledger, each on a chord nothing else takes', () => {
    const lines = (t: string) => t.split('\n').filter((l) => l !== '').map((l) => l.split('\t'));
    expect(seedsFor('day').hotkeys).toBe(ledger + symedit);
    const own = lines(symedit);
    expect(own).toHaveLength(10);
    const taken = new Set([...lines(ledger).map(([, k]) => k), ...Object.values(JSON.parse(defaultsJson) as Record<string, string | null>).filter((k): k is string => k != null)]);
    const actions = new Set(lines(ledger).map(([a]) => a));
    for (const [action, key, secondary] of own) {
      expect(key, action).toMatch(/^Ctrl\+Alt\+Shift\+[0-9]$/);
      expect(taken.has(key!), key).toBe(false);
      expect(actions.has(action!), action).toBe(false);
      expect(secondary).toBe('');
    }
    expect(new Set(own.map(([, k]) => k)).size).toBe(own.length);
  });
});
