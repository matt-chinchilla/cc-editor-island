// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-open-foreign-i in the registry: loaded with no broken rule, adding no op,
// cap, event or held row (its widening of project.import is bridge/import.ts).
import { describe, expect, it } from 'vitest';
import { buildRegistry } from './registry';
import unit from './st-open-foreign-i';

describe('st-open-foreign-i', () => {
  it('loads with no problem and claims nothing of the protocol', () => {
    const reg = buildRegistry({ './st-open-foreign-i.ts': { default: unit } }, {}, {});
    expect(reg.problems).toEqual([]);
    expect(reg.units.map((u) => u.unit)).toEqual(['st-open-foreign-i']);
    expect(reg.ops.size).toBe(0);
    expect(reg.events.size).toBe(0);
  });
});
