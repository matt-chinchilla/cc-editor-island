// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The owner's spelling (2026-10-08, "I am not british"): American spelling,
// never a British one, in any tracked file of the island that is ours (code,
// comments, docs, tests). The patterns live in src/spelling.mjs.
import { describe, expect, it } from 'vitest';
import { britishSpellings } from './spelling.mjs';

describe('the island spells the owner’s way', () => {
  it('has no British spelling in any tracked file of ours', () => {
    expect(britishSpellings()).toEqual([]);
  });
});
