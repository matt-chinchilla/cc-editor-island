// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { describe, expect, it } from 'vitest';
import { seedsFor } from './seeds';

describe('the seeds', () => {
  it.each(['day', 'night'] as const)('select the one viewer palette by %s', (theme) => {
    const s = seedsFor(theme);
    expect(s.colorTheme).toBe('circuitcenter');
    const names = s.colors.map((c) => c.name);
    expect(names).toEqual(['circuitcenter.json', 'circuitcenter-light.json', 'circuitcenter-dark.json']);
    const t = JSON.parse(s.colors[0].json);
    expect(t.meta).toEqual({ name: 'Circuit Center', version: 5 });
    expect(t.schematic.background).toBe('rgb(245, 244, 239)');
    expect(t.board.background).toBe('rgb(0, 16, 35)');
    expect(t.board.copper.f).toBe('rgb(200, 52, 52)');
  });
});
