// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { describe, expect, it } from 'vitest';
import { bootHeartbeat, HEARTBEAT_MS } from './boot-heartbeat';

describe('bootHeartbeat', () => {
  it('emits the first tick, then at most one every two seconds', () => {
    expect(HEARTBEAT_MS).toBe(2000);
    const beat = bootHeartbeat();
    const out: Array<[number, string]> = [];
    // A 22 MB engine fetch reported every 50 ms for 9 s.
    for (let t = 0; t <= 9000; t += 50) {
      const d = beat(Math.min(22e6, (t / 9000) * 22e6), 22e6, t);
      if (d != null) out.push([t, d]);
    }
    expect(out.map(([t]) => t)).toEqual([0, 2000, 4000, 6000, 8000]);
    expect(out.map(([, d]) => d)).toEqual(['0', '22', '44', '66', '88']);
  });

  it('the detail is a whole percent in digits only, clamped to 0 to 100', () => {
    const beat = bootHeartbeat(0);
    expect(beat(1, 3, 0)).toBe('33');
    expect(beat(2, 3, 1)).toBe('66');
    expect(beat(3, 3, 2)).toBe('100');
    expect(beat(5, 3, 3)).toBe('100');
    expect(beat(-1, 3, 4)).toBe('0');
    for (const d of ['33', '66', '100', '0']) expect(d).toMatch(/^\d{1,3}$/);
  });

  it('stays silent without a known total, and an unknown total does not use up the interval', () => {
    const beat = bootHeartbeat();
    expect(beat(10, 0, 0)).toBeNull();
    expect(beat(10, Number.NaN, 10)).toBeNull();
    expect(beat(Number.NaN, 100, 20)).toBeNull();
    expect(beat(10, 100, 30)).toBe('10');
    expect(beat(20, 100, 30 + HEARTBEAT_MS - 1)).toBeNull();
    expect(beat(20, 100, 30 + HEARTBEAT_MS)).toBe('20');
  });
});
