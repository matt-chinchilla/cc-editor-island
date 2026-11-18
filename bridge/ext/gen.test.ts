// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The generator's PROTOCOL.md assembly (scripts/ext/gen.mjs): a unit's parts go
// where the markers say, tagged with the unit, and a second run changes nothing.
import { describe, expect, it } from 'vitest';
// @ts-expect-error a plain ES module of the scripts folder, with no types
import { assembleProtocol, PARTS, readFragment, readFragments, ROWS_MARK, SECTIONS_BEGIN, SECTIONS_END } from '../../scripts/ext/gen.mjs';

const FRAGMENT = [
  '<!-- Copyright (C) 2026 Circuit Center Inc -->',
  '<!-- SPDX-License-Identifier: MIT -->',
  '<!-- part: requests -->',
  '| `x.op` | `{ a: number }` | `{}` |',
  '<!-- part: codes -->',
  '| `x_failed` | `x.op`: it failed. |',
  '<!-- part: events -->',
  '- `ev.x { a: number }` (the `x` cap) when it happens.',
  '<!-- part: section -->',
  '### x.op',
  'Does x.',
].join('\n');

describe('the PROTOCOL.md assembly', () => {
  const protocol = Object.values(import.meta.glob('../../PROTOCOL.md', { query: '?raw', import: 'default', eager: true }))[0] as string;

  it('has every marker once in PROTOCOL.md, and reads this checkout\'s unit parts into a PROTOCOL.md that a second run keeps', () => {
    for (const part of PARTS as string[]) expect(protocol.split((ROWS_MARK as (p: string) => string)(part)).length).toBe(2);
    expect(protocol.split(SECTIONS_BEGIN).length).toBe(2);
    expect(protocol.split(SECTIONS_END).length).toBe(2);
    const fragments = readFragments();
    const once = assembleProtocol(protocol, fragments);
    expect(assembleProtocol(once, fragments)).toBe(once);
  });

  it('puts each part after its table or list and the section between the markers, tagged, once however often it runs', () => {
    const bare = assembleProtocol(protocol, []);
    const f = { unit: 'x-i', ...readFragment('x-i', FRAGMENT) };
    const once = assembleProtocol(bare, [f]);
    expect(assembleProtocol(once, [f])).toBe(once);
    expect(assembleProtocol(once, [])).toBe(bare);
    const lines = once.split('\n');
    const row = lines.indexOf('| `x.op` | `{ a: number }` | `{}` <!-- ext:x-i --> |');
    expect(lines[row - 1]).toMatch(/^\| `sim\.release` \|/);
    expect(lines[lines.indexOf('| `x_failed` | `x.op`: it failed. <!-- ext:x-i --> |') - 1]).toMatch(/^\| `save_failed` \|/);
    expect(lines[lines.indexOf('- `ev.x { a: number }` (the `x` cap) when it happens. <!-- ext:x-i -->') - 1]).toMatch(/^- `ev\.closing \{\}`/);
    const begin = lines.indexOf(SECTIONS_BEGIN);
    expect(lines.slice(begin + 1, begin + 5)).toEqual(['', '### x.op', 'Does x.', '']);
    expect(lines[begin + 5]).toBe(SECTIONS_END);
    expect(once).not.toContain('Circuit Center Inc -->');
  });

  it('refuses a fragment of another shape', () => {
    expect(() => readFragment('y-i', 'stray text\n<!-- part: section -->')).toThrow(/before the first part marker/);
    expect(() => readFragment('y-i', '<!-- part: requests -->\nnot a row')).toThrow(/table rows/);
    expect(() => readFragment('y-i', '<!-- part: other -->')).toThrow(/no part/);
  });
});
