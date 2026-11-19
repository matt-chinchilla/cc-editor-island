// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The generator's PROTOCOL.md assembly (scripts/ext/gen.mjs): a unit's parts go
// where the markers say, tagged with the unit, and a second run changes nothing.
import { describe, expect, it } from 'vitest';
// @ts-expect-error a plain ES module of the scripts folder, with no types
import { assembleProtocol, PARTS, readFragment, readFragments, readProtocol, ROWS_MARK, SECTIONS_BEGIN, SECTIONS_END } from '../../scripts/ext/gen.mjs';
// @ts-expect-error a plain ES module of the scripts folder, with no types
import { fixturePath, heldRowOf } from '../../scripts/ext/manifest.mjs';

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

describe('the generator at the join', () => {
  // The built in PROTOCOL.md: the checkout's file with every unit part taken out
  // (once the join has run gen:ext the file holds the landed units' parts).
  const protocol = assembleProtocol(readProtocol(), []) as string;
  const frag = (unit: string, text: string) => ({ unit, ...readFragment(unit, text) });

  it('adds a code once: a code the table holds, or an earlier unit gave, is not added again', () => {
    const out = assembleProtocol(protocol, [
      frag('a-i', '<!-- part: codes -->\n| `block_failed` | first |\n| `not_found` | again |'),
      frag('b-i', '<!-- part: codes -->\n| `block_failed` | second |'),
    ]) as string;
    const rows = out.split('\n').filter((l) => l.includes('<!-- ext:'));
    expect(rows).toEqual(['| `block_failed` | first <!-- ext:a-i --> |']);
    expect(assembleProtocol(out, [])).toBe(protocol);
  });

  it('puts a unit note at the end of an op section that ships, its family heading when it has none of its own', () => {
    const out = assembleProtocol(protocol, [frag('n-i', '<!-- part: notes sim.run -->\n- a run note\n<!-- part: notes settings.set -->\n- a set note')]) as string;
    const lines = out.split('\n');
    const at = (text: string) => lines.findIndex((l) => l === text);
    const sim = lines.findIndex((l) => l.startsWith('### The simulator'));
    const settings = lines.findIndex((l) => l.startsWith('### settings.get and settings.set'));
    expect(at('- a run note <!-- ext:n-i -->')).toBeGreaterThan(sim);
    expect(at('- a set note <!-- ext:n-i -->')).toBeGreaterThan(settings);
    expect(lines.slice(settings + 1, at('- a set note <!-- ext:n-i -->')).some((l) => l.startsWith('### '))).toBe(false);
    expect(assembleProtocol(out, [])).toBe(protocol);
    expect(() => readFragment('n-i', '<!-- part: notes sim.run -->\nnot an item')).toThrow(/list items/);
    expect(() => assembleProtocol(protocol, [frag('n-i', '<!-- part: notes no.such -->\n- x')])).toThrow(/no section/);
  });

  it('reads a fixture entry with or without the island prefix as a path of this repository', () => {
    expect(fixturePath('island:tests/fixtures/fpedit-small/')).toBe('tests/fixtures/fpedit-small/');
    expect(fixturePath('tests/fixtures/sheet-pins/ (two sheets)')).toBe('tests/fixtures/sheet-pins/');
  });

  it('reads a held entry note as its row', () => {
    expect(heldRowOf('common.Control.saveAs (fpedit, under fpedit)')).toEqual({ action: 'common.Control.saveAs', frames: ['fpedit'], cap: 'fpedit' });
    expect(heldRowOf('eeschema.EditorControl.importGraphics (sch, under importGraphics; symedit already holds it)')).toEqual({ action: 'eeschema.EditorControl.importGraphics', frames: ['sch'], cap: 'importGraphics' });
    expect(heldRowOf('pcbnew.EditorControl.exportSTEP')).toBeNull();
  });
});
