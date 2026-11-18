// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The notices census of the files new to wave 2 (scripts/notices.mjs
// censusNewFiles): each starts with the notice, or carries it in a .license
// sidecar, and none names an agent, an AI tool or model, or a session.
import { describe, expect, it } from 'vitest';
// @ts-expect-error a plain ES module of the scripts folder, with no types
import { AGENT_RE, censusNewFiles } from '../scripts/notices.mjs';

describe('the files new to wave 2', () => {
  it('each carries the notice and names no agent, tool, model or session', () => {
    expect(censusNewFiles()).toEqual([]);
  });

  it('knows the names it refuses', () => {
    const re = AGENT_RE as RegExp;
    // Spelled in pieces, so this file names none of them itself.
    const name = ['Cla', 'ude'].join('');
    for (const bad of [`Written by ${name}`, ['Co', 'Authored', 'By: someone'].join('-'), `see ${name.toLowerCase()}.ai/code/x`, `a ${'sess'}ion_01J9gUpC8CT6`]) expect(re.test(bad)).toBe(true);
    for (const fine of ['the cursor sits here', 'opens the symbol editor', 'a hotkey session of KiCad']) expect(re.test(fine)).toBe(false);
  });
});
