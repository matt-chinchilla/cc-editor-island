// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { describe, expect, it } from 'vitest';
import { parentOriginFor, parseBoot } from './cc-config';

describe('parentOriginFor', () => {
  it('maps prod and the local pair, and refuses unknown hosts', () => {
    expect(parentOriginFor('editor.circuitcenter.ai', '')).toBe('https://circuitcenter.ai');
    expect(parentOriginFor('editor.localhost', '')).toBe('http://localhost');
    expect(parentOriginFor('editor.localhost', '4174')).toBe('http://localhost:4173');
    // The old pair host was folded into plain localhost (2026-10-26): it boots nothing.
    expect(parentOriginFor('editor.circuitcenter.localhost', '')).toBeNull();
    expect(parentOriginFor('evil.example', '')).toBeNull();
  });
});
describe('parseBoot', () => {
  it('defaults to the schematic by day and accepts only the known values', () => {
    expect(parseBoot('')).toEqual({ frame: 'sch', theme: 'day' });
    expect(parseBoot('?frame=pcb&theme=night')).toEqual({ frame: 'pcb', theme: 'night' });
    expect(parseBoot('?frame=x&theme=y')).toEqual({ frame: 'sch', theme: 'day' });
  });
});
