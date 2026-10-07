// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The picker's search indexes (PICKER.md section 1): sym-index.json and
// fp-search.json. A derived symbol takes desc, keys and fp from the nearest
// symbol up its extends chain that has them; units and power are the root's;
// pins are the distinct pin numbers over every unit of the chain, stacked
// numbers expanded. Rows are sorted by lib then name in code point order, and
// the same sources give the same bytes.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildMirror, verifyMirror } from '../../scripts/libs/mirror.mjs';
import { expandStackedPins, footprintFacts, symbolFacts, symbolRow, symIndexText } from '../../scripts/libs/search-index.mjs';
import { readBytes, readStoredJson, removeDir, sha256, tempDir, writeTree } from './kit.mjs';

const TAG = '10.0.4';
const HEADER = '\t(version 20251024)\n\t(generator "kicad_symbol_editor")\n\t(generator_version "10.0")\n';
const lib = (block: string) => `(kicad_symbol_lib\n${HEADER}\t${block}\n)\n`;
const prop = (key: string, value: string) => `\n\t\t(property "${key}" "${value}"\n\t\t\t(at 0 0 0)\n\t\t)`;
const pin = (number: string) => `\n\t\t\t(pin passive line\n\t\t\t\t(at 0 0 0)\n\t\t\t\t(length 2.54)\n\t\t\t\t(name "~"\n\t\t\t\t\t(effects\n\t\t\t\t\t\t(font\n\t\t\t\t\t\t\t(size 1.27 1.27)\n\t\t\t\t\t\t)\n\t\t\t\t\t)\n\t\t\t\t)\n\t\t\t\t(number "${number}"\n\t\t\t\t\t(effects\n\t\t\t\t\t\t(font\n\t\t\t\t\t\t\t(size 1.27 1.27)\n\t\t\t\t\t\t)\n\t\t\t\t\t)\n\t\t\t\t)\n\t\t\t)`;
const unit = (name: string, u: number, style: number, pins: string[]) => `\n\t\t(symbol "${name}_${u}_${style}"${pins.map(pin).join('')}\n\t\t)`;
const symbol = (name: string, body: string) => `(symbol "${name}"${body}\n\t)`;

/** A dual op amp: units 1 and 2, the supply pins in unit 3, a DeMorgan body style repeating unit 1's pins, a common unit 0 drawing. */
const DUAL = symbol('Dual', [
  prop('Reference', 'U'),
  prop('Value', 'Dual'),
  prop('Footprint', 'Package_SO:SOIC-8'),
  prop('Description', 'Dual op amp, \\"rail to rail\\"'),
  prop('ki_keywords', 'dual opamp'),
  unit('Dual', 0, 1, []),
  unit('Dual', 1, 1, ['1', '2', '3']),
  unit('Dual', 1, 2, ['1', '2', '3']),
  unit('Dual', 2, 1, ['5', '6', '7']),
  unit('Dual', 3, 1, ['4', '8']),
].join(''));
/** Derived from Dual: its own description, an empty keyword list (inherits), no footprint (inherits). */
const DUAL_A = symbol('Dual_A', `\n\t\t(extends "Dual")${prop('Value', 'Dual_A')}${prop('Description', 'The A grade')}${prop('ki_keywords', '')}`);
/** Derived from Dual_A: no description (Dual_A's, the nearest), its own keywords. */
const DUAL_AB = symbol('Dual_AB', `\n\t\t(extends "Dual_A")${prop('Value', 'Dual_AB')}${prop('ki_keywords', 'grade AB')}`);
/** A power symbol, KiCad 10 style, and one derived from it (power comes from the root). */
const VCC = symbol('VCC', `\n\t\t(power global)${prop('Value', 'VCC')}${prop('Description', 'Power symbol')}${unit('VCC', 0, 1, [])}${unit('VCC', 1, 1, ['1'])}`);
const VDD = symbol('VDD', `\n\t\t(extends "VCC")${prop('Value', 'VDD')}`);
/** An old-style power flag and a pin drawn directly in the top symbol (unit 0 of the old format). */
const OLD_PWR = symbol('Old_PWR', `\n\t\t(power)${pin('1')}`);
/** Stacked pin numbers (KiCad 10) and an unnumbered pin: [1,15,38,39] is four, [A1-A3] three, "" none. */
const STACKED = symbol('Stacked', `${unit('Stacked', 1, 1, ['[1,15,38,39]', '[A1-A3]', '2', '15', '', '[9-7]'])}`);

let dir: string;
let mirror: string;
let symbolsSrc: string;
let footprintsSrc: string;
beforeAll(async () => {
  dir = tempDir('cc-libs-index');
  symbolsSrc = `${dir}/kicad-symbols`;
  footprintsSrc = `${dir}/kicad-footprints`;
  writeTree(symbolsSrc, {
    'LICENSE.md': 'symbols\n',
    'abc.kicad_symdir/Dual.kicad_sym': lib(DUAL),
    'abc.kicad_symdir/Dual_A.kicad_sym': lib(DUAL_A),
    'abc.kicad_symdir/Dual_AB.kicad_sym': lib(DUAL_AB),
    'abc.kicad_symdir/Stacked.kicad_sym': lib(STACKED),
    'Zpower.kicad_symdir/VCC.kicad_sym': lib(VCC),
    'Zpower.kicad_symdir/VDD.kicad_sym': lib(VDD),
    'Zpower.kicad_symdir/Old_PWR.kicad_sym': lib(OLD_PWR),
    // Names in code point order: "Z" < "a" < "é" (JavaScript's sort agrees here; the bundle test covers where it does not).
    'Zpower.kicad_symdir/é.kicad_sym': lib(symbol('é', prop('Description', 'e acute'))),
    'Zpower.kicad_symdir/a.kicad_sym': lib(symbol('a', '')),
  });
  writeTree(footprintsSrc, {
    'LICENSE.md': 'footprints\n',
    'Pkg.pretty/SOIC-8.kicad_mod': '(footprint "SOIC-8"\n\t(version 20260206)\n\t(generator "pcbnew")\n\t(layer "F.Cu")\n\t(descr "SOIC, 8 Pin, \\"narrow\\"")\n\t(tags "SOIC SO")\n'
      + [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `\t(pad "${n}" smd rect\n\t\t(at 0 0)\n\t\t(size 1 1)\n\t\t(layers "F.Cu")\n\t)\n`).join('') + ')\n',
    'Pkg.pretty/Bare.kicad_mod': '(footprint "Bare"\n\t(version 20260206)\n\t(layer "F.Cu")\n)\n',
  });
  mirror = (await buildMirror({ symbolsSrc, footprintsSrc, out: `${dir}/out`, tag: TAG })).dir;
});
afterAll(() => removeDir(dir));

describe('sym-index.json', () => {
  it('holds one row per symbol, sorted by lib then name in code point order', () => {
    const idx = readStoredJson(mirror, 'sym-index.json');
    expect(Object.keys(idx)).toEqual(['schema', 'tag', 'fields', 'rows']);
    expect(idx.rows.map((r: string[]) => `${r[0]}:${r[1]}`)).toEqual([
      'Zpower:Old_PWR', 'Zpower:VCC', 'Zpower:VDD', 'Zpower:a', 'Zpower:é',
      'abc:Dual', 'abc:Dual_A', 'abc:Dual_AB', 'abc:Stacked',
    ]);
  });

  it('inherits desc, keys and fp from the nearest symbol up the chain that has them, and takes units and power from the root', () => {
    const rows = Object.fromEntries(readStoredJson(mirror, 'sym-index.json').rows.map((r: unknown[]) => [r[1], r]));
    expect(rows.Dual).toEqual(['abc', 'Dual', 'Dual op amp, "rail to rail"', 'dual opamp', 'Package_SO:SOIC-8', 8, 3, 0]);
    // Its own description; the empty keyword list and the absent footprint come from Dual.
    expect(rows.Dual_A).toEqual(['abc', 'Dual_A', 'The A grade', 'dual opamp', 'Package_SO:SOIC-8', 8, 3, 0]);
    // Two levels down: the description is Dual_A's (the nearest), not the root's.
    expect(rows.Dual_AB).toEqual(['abc', 'Dual_AB', 'The A grade', 'grade AB', 'Package_SO:SOIC-8', 8, 3, 0]);
    expect(rows.VCC).toEqual(['Zpower', 'VCC', 'Power symbol', '', '', 1, 1, 1]);
    expect(rows.VDD).toEqual(['Zpower', 'VDD', 'Power symbol', '', '', 1, 1, 1]);
    expect(rows.Old_PWR).toEqual(['Zpower', 'Old_PWR', '', '', '', 1, 1, 1]);
    expect(rows.a).toEqual(['Zpower', 'a', '', '', '', 0, 1, 0]);
    expect(rows['é']).toEqual(['Zpower', 'é', 'e acute', '', '', 0, 1, 0]);
    // [1,15,38,39] + [A1-A3] + 2 (15 again, "" none, [9-7] is not a range KiCad reads, so itself).
    expect(rows.Stacked[5]).toBe(4 + 3 + 1 + 1);
  });

  it('is what verifyMirror recomputes from the bundles, and the same bytes from the same sources', async () => {
    expect(verifyMirror(mirror).indexes['sym-index.json'].rows).toBe(9);
    const again = await buildMirror({ symbolsSrc, footprintsSrc, out: `${dir}/again`, tag: TAG, concurrency: 1 });
    for (const name of ['sym-index.json.gz', 'fp-search.json.gz']) expect(sha256(readBytes(`${again.dir}/${name}`)), name).toBe(sha256(readBytes(`${mirror}/${name}`)));
    // Row order does not depend on the order rows were gathered in.
    const rows = readStoredJson(mirror, 'sym-index.json').rows;
    expect(symIndexText(TAG, [...rows].reverse())).toBe(JSON.stringify(readStoredJson(mirror, 'sym-index.json')));
  });
});

describe('fp-search.json', () => {
  it('holds each footprint\'s descr, tags and unique pad count, empty strings where it has none', () => {
    expect(readStoredJson(mirror, 'fp-search.json')).toEqual({
      schema: 1, tag: TAG, fields: ['lib', 'name', 'desc', 'tags', 'pads'],
      rows: [['Pkg', 'Bare', '', '', 0], ['Pkg', 'SOIC-8', 'SOIC, 8 Pin, "narrow"', 'SOIC SO', 8]],
    });
  });
});

describe('the row rules', () => {
  it('reads a block\'s own facts, null where a property is absent', () => {
    const f = symbolFacts(DUAL_A);
    expect(f).toMatchObject({ name: 'Dual_A', extends: 'Dual', desc: 'The A grade', keys: '', fp: null, power: false, units: 1 });
    expect([...f.pins]).toEqual([]);
    expect([...symbolFacts(DUAL).pins].sort()).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    expect(symbolFacts(DUAL).units).toBe(3);
  });

  it('unions the pins of every symbol of the chain', () => {
    const base = symbolFacts(symbol('B', unit('B', 1, 1, ['1', '2'])));
    const derived = { ...symbolFacts(symbol('D', '\n\t\t(extends "B")')), pins: new Set(['2', '3']) };
    expect(symbolRow('L', [base, derived])[5]).toBe(3);
  });

  it('expands KiCad\'s stacked pin notation as ExpandStackedPinNotation does', () => {
    expect(expandStackedPins('7')).toEqual(['7']);
    expect(expandStackedPins('[1,15, 38,39]')).toEqual(['1', '15', '38', '39']);
    expect(expandStackedPins('[1-3,7]')).toEqual(['1', '2', '3', '7']);
    expect(expandStackedPins('[A1-A3]')).toEqual(['A1', 'A2', 'A3']);
    expect(expandStackedPins('[A1-B3]')).toEqual(['[A1-B3]']);   // prefixes differ: invalid, itself
    expect(expandStackedPins('[3-1]')).toEqual(['[3-1]']);       // descending: invalid, itself
    expect(expandStackedPins('[,]')).toEqual(['[,]']);           // nothing in it: itself
    expect(expandStackedPins('[A-B]')).toEqual(['[A-B]']);       // no numbers: invalid, itself
  });

  it('reads a footprint\'s descr and tags with KiCad\'s lexer rules', () => {
    expect(footprintFacts('(footprint "X"\n\t(descr "a \\x41 \\"q\\"")\n\t(tags "t1 t2")\n)\n')).toEqual({ desc: 'a A "q"', tags: 't1 t2' });
    expect(footprintFacts('(module X\n\t(fp_text user "(descr \\"no\\")")\n)\n')).toEqual({ desc: '', tags: '' });
  });
});
