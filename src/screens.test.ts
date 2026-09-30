// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { describe, expect, it } from 'vitest';
import { barMode, cleanDetail } from './screens';

describe('the loading bar', () => {
  it('sweeps with no number, fills below 1 and sweeps again once complete', () => {
    expect(barMode(undefined)).toBe('sweep');
    expect(barMode(Number.NaN)).toBe('sweep');
    expect(barMode(0)).toBe('fill');
    expect(barMode(0.5)).toBe('fill');
    expect(barMode(1)).toBe('settle');
    expect(barMode(1.2)).toBe('settle');   // a loader that over-reports still settles
  });
});

describe('cleanDetail', () => {
  it('renders no en or em dash', () => {
    expect(cleanDetail('a \u2013 b \u2014 c')).not.toMatch(/[\u2013\u2014]/);
  });
});
