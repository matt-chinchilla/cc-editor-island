// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The owner's spelling (2026-10-08, "I am not british"): "color", never the
// British spelling with a u, in any form, in any tracked file of the island
// (code, comments, docs, tests).
import { describe, expect, it } from 'vitest';
import { britishSpellings } from './spelling.mjs';

describe('the island spells color the owner’s way', () => {
  it('has no British spelling of color in any tracked file', () => {
    expect(britishSpellings()).toEqual([]);
  });
});
