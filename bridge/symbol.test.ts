// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { describe, expect, it } from 'vitest';
import { isFootprintId, misfit, parseSymbolGetArgs, parseSymbolSet, parseSymbolSetArgs, readSymbolSheet, sameOrientation, showsSet, symbolSetJson, type SymbolSheet } from './symbol';

const U1 = '00000000-0000-0000-0000-00005aca0321';
const SUB = '/00000000-0000-0000-0000-00005c7b59b0/00000000-0000-0000-0000-00005c9e337e/';

/** Glasgow's U1 as engine run 10's kicadSymbolGet answers it (2026-11-07, the GPU window), its user fields cut to two. */
const SHEET: SymbolSheet = {
  uuid: U1, sheetPath: '/', sheetName: 'glasgow',
  ref: 'U1', value: 'CY7C68013A-56LTX',
  footprint: 'Package_DFN_QFN:Cypress_QFN-56-1EP_8x8mm_P0.5mm_EP6.22x6.22mm_ThermalVias',
  libId: 'glasgow:CY7C68013A-56LTX',
  fields: [
    { name: 'Reference', value: 'U1', shown: true, kind: 'reference' },
    { name: 'Value', value: 'CY7C68013A-56LTX', shown: true, kind: 'value' },
    { name: 'Footprint', value: 'Package_DFN_QFN:Cypress_QFN-56-1EP_8x8mm_P0.5mm_EP6.22x6.22mm_ThermalVias', shown: false, kind: 'footprint' },
    { name: 'Datasheet', value: 'http://www.cypress.com/file/138911/download', shown: false, kind: 'datasheet' },
    { name: 'Description', value: '', shown: true, kind: 'description' },
    { name: 'Mfg', value: 'Cypress', shown: false, kind: 'user' },
    { name: 'MPN', value: 'CY7C68013A-56LTXC', shown: false, kind: 'user' },
  ],
  inBom: true, onBoard: true, inSim: true, dnp: false,
  rotation: 0, mirror: 'none', x: 90.17, y: 97.79,
  unit: 1, units: 1, bodyStyle: 1, bodyStyles: 1,
  filters: ['*QFN*56*'],
};
const json = (o: unknown) => JSON.stringify(o);

describe('symbol.get args', () => {
  it('takes a lower case uuid and an optional sheet path in project.open\'s form', () => {
    expect(parseSymbolGetArgs({ uuid: U1 })).toEqual({ uuid: U1 });
    expect(parseSymbolGetArgs({ uuid: U1, sheetPath: '/' })).toEqual({ uuid: U1, sheetPath: '/' });
    expect(parseSymbolGetArgs({ uuid: U1, sheetPath: SUB })).toEqual({ uuid: U1, sheetPath: SUB });
  });

  it('refuses anything else', () => {
    for (const a of [undefined, null, [], U1, {}, { uuid: U1.toUpperCase() }, { uuid: `${U1}0` }, { uuid: 'x' }, { uuid: U1, extra: 1 },
      { uuid: U1, sheetPath: '' }, { uuid: U1, sheetPath: SUB.slice(0, -1) }, { uuid: U1, sheetPath: SUB.toUpperCase() }, { uuid: U1, sheetPath: 1 },
      { uuid: U1, sheetPath: `/${`${U1}/`.repeat(65)}` }]) {
      expect(parseSymbolGetArgs(a)).toBeNull();
    }
    expect(parseSymbolGetArgs({ uuid: U1, sheetPath: `/${`${U1}/`.repeat(64)}` })).not.toBeNull();
  });
});

describe('symbol.set args', () => {
  const ok = (set: unknown) => parseSymbolSetArgs({ uuid: U1, sheetPath: '/', set });

  it('takes exactly a uuid, a sheet path and a set, and hands kicadSymbolSet the same three', () => {
    const a = ok({ value: '100R' });
    expect(a).toEqual({ uuid: U1, sheetPath: '/', set: { value: '100R' } });
    expect(JSON.parse(symbolSetJson(a!))).toEqual({ uuid: U1, sheetPath: '/', set: { value: '100R' } });
    for (const args of [{ uuid: U1, set: { value: 'x' } }, { uuid: U1, sheetPath: '/', set: { value: 'x' }, extra: 1 }, { uuid: U1, sheetPath: '', set: { value: 'x' } },
      { uuid: U1.toUpperCase(), sheetPath: '/', set: { value: 'x' } }, { uuid: U1, sheetPath: '/' }, null, []]) {
      expect(parseSymbolSetArgs(args)).toBeNull();
    }
  });

  it('takes every key spec 11.2 names, at its bounds', () => {
    const every = {
      ref: 'R'.repeat(64), value: 'v'.repeat(1024), footprint: 'Resistor_SMD:R_0402_1005Metric',
      fields: [{ name: 'Datasheet', value: '' }, { name: 'Mfg', shown: true }, { name: 'MPN', value: 'x', shown: false }],
      addField: { name: 'N'.repeat(128), value: '', shown: false }, removeField: 'Tolerance',
      inBom: false, onBoard: false, inSim: false, dnp: true,
      rotation: 270, mirror: 'y', x: -50_000, y: 50_000, unit: 676, bodyStyle: 2,
    };
    expect(parseSymbolSet(every)).toEqual(every);
    expect(parseSymbolSet({ footprint: '' })).toEqual({ footprint: '' });
    expect(parseSymbolSet({ fields: Array.from({ length: 64 }, (_, i) => ({ name: `F${i}`, shown: true })) })).not.toBeNull();
    // Code points count, as the engine counts them: 64 emoji are a 64 character designator.
    expect(parseSymbolSet({ ref: '\u{1f600}'.repeat(64) })).not.toBeNull();
    for (const rotation of [0, 90, 180, 270]) expect(parseSymbolSet({ rotation })).toEqual({ rotation });
    for (const mirror of ['none', 'x', 'y']) expect(parseSymbolSet({ mirror })).toEqual({ mirror });
  });

  it('refuses each key past its type or bound, one at a time', () => {
    const bad: unknown[] = [
      {}, [], null, { other: 1 },
      { ref: '' }, { ref: 'R'.repeat(65) }, { ref: 'R\n1' }, { ref: 'R\u0000' }, { ref: 1 }, { ref: '\ud800' },
      { value: 'v'.repeat(1025) }, { value: 1 }, { value: 'a\u0000b' },
      { footprint: 'nolib' }, { footprint: ':name' }, { footprint: 'lib:' }, { footprint: 'a:b:c' }, { footprint: 'a:b\n' }, { footprint: 'a:'.padEnd(1025, 'b') },
      { fields: [] }, { fields: {} }, { fields: Array.from({ length: 65 }, (_, i) => ({ name: `F${i}`, shown: true })) },
      { fields: [{ name: 'Mfg' }] }, { fields: [{ name: '', value: 'x' }] }, { fields: [{ name: 'N'.repeat(129), value: 'x' }] },
      { fields: [{ name: 'Mfg', value: 1 }] }, { fields: [{ name: 'Mfg', shown: 'yes' }] }, { fields: [{ name: 'Mfg', value: 'x', other: 1 }] },
      { fields: [{ name: 'Mfg', value: 'x' }, { name: 'Mfg', shown: true }] },
      { fields: [{ name: 'Reference', value: '' }] }, { fields: [{ name: 'Reference', value: 'R'.repeat(65) }] }, { fields: [{ name: 'Footprint', value: 'nolib' }] },
      { addField: { name: 'X', value: 'y' } }, { addField: { name: '', value: 'y', shown: true } }, { addField: { name: 'X\t', value: 'y', shown: true } },
      { addField: { name: 'X', value: 'y', shown: 1 } }, { addField: { name: 'X', value: 'y', shown: true, more: 1 } }, { addField: 'X' },
      { removeField: '' }, { removeField: 'N'.repeat(129) }, { removeField: 1 },
      { inBom: 'true' }, { onBoard: 1 }, { inSim: null }, { dnp: 0 },
      { rotation: 45 }, { rotation: '90' }, { rotation: 360 }, { rotation: 90.5 },
      { mirror: 'z' }, { mirror: 'X' }, { mirror: true },
      { x: Number.NaN }, { x: Number.POSITIVE_INFINITY }, { y: 50_000.1 }, { x: '1' },
      { unit: 0 }, { unit: 677 }, { unit: 1.5 }, { unit: '1' },
      { bodyStyle: 0 }, { bodyStyle: 3 }, { bodyStyle: '2' },
      // One change per thing.
      { ref: 'R1', fields: [{ name: 'Reference', shown: true }] },
      { value: 'x', fields: [{ name: 'Value', shown: true }] },
      { footprint: 'a:b', fields: [{ name: 'Footprint', shown: false }] },
      { removeField: 'Mfg', fields: [{ name: 'Mfg', shown: true }] },
      { removeField: 'Tolerance', addField: { name: 'tolerance', value: '1%', shown: true } },
    ];
    for (const set of bad) expect(parseSymbolSet(set), JSON.stringify(set)).toBeNull();
  });

  it('a footprint id is "lib:name" or empty', () => {
    expect(isFootprintId('')).toBe(true);
    expect(isFootprintId('Device:R')).toBe(true);
    for (const v of ['Device', 'Device:', ':R', 'a:b:c', 1, null]) expect(isFootprintId(v)).toBe(false);
  });
});

describe('the engine\'s sheet', () => {
  it('reads the engine\'s JSON whole, and nothing else', () => {
    expect(readSymbolSheet(json(SHEET))).toEqual(SHEET);
    expect(readSymbolSheet('')).toBeNull();
    expect(readSymbolSheet('{')).toBeNull();
    expect(readSymbolSheet(undefined)).toBeNull();
    const { filters: _f, ...noFilters } = SHEET;
    expect(readSymbolSheet(json(noFilters))).toBeNull();
    for (const bad of [
      { ...SHEET, extra: 1 }, { ...SHEET, uuid: U1.toUpperCase() }, { ...SHEET, sheetPath: '' }, { ...SHEET, ref: 1 },
      { ...SHEET, fields: [{ name: 'Reference', value: 'U1', shown: true }] }, { ...SHEET, fields: [{ name: 'Reference', value: 'U1', shown: true, kind: 'other' }] },
      { ...SHEET, fields: [{ name: '', value: 'U1', shown: true, kind: 'user' }] },
      { ...SHEET, dnp: 'no' }, { ...SHEET, rotation: 45 }, { ...SHEET, mirror: 'z' }, { ...SHEET, x: null },
      { ...SHEET, unit: 2 }, { ...SHEET, units: 0 }, { ...SHEET, bodyStyle: 2 }, { ...SHEET, bodyStyles: 3 }, { ...SHEET, filters: [1] },
    ]) expect(readSymbolSheet(json(bad)), JSON.stringify(bad).slice(0, 80)).toBeNull();
  });
});

describe('the read back', () => {
  const after = (o: Partial<SymbolSheet>): SymbolSheet => ({ ...SHEET, ...o });

  it('shows a change when every key asked for reads as asked', () => {
    expect(showsSet({ value: 'x' }, SHEET, after({ value: 'x' }))).toBe(true);
    expect(showsSet({ value: 'x' }, SHEET, SHEET)).toBe(false);
    expect(showsSet({ ref: 'U9' }, SHEET, after({ ref: 'U9' }))).toBe(true);
    expect(showsSet({ footprint: '' }, SHEET, after({ footprint: '' }))).toBe(true);
    expect(showsSet({ dnp: true, inBom: false }, SHEET, after({ dnp: true }))).toBe(false);
    expect(showsSet({ dnp: true, inBom: false }, SHEET, after({ dnp: true, inBom: false }))).toBe(true);
    expect(showsSet({ x: 92.71, y: 1.23456 }, SHEET, after({ x: 92.71, y: 1.2346 }))).toBe(true);
    expect(showsSet({ x: 92.71 }, SHEET, after({ x: 92.72 }))).toBe(false);
    expect(showsSet({ unit: 1 }, SHEET, SHEET)).toBe(true);
  });

  it('reads fields by KiCad\'s own name: a value, a visibility, a new field, a removed one', () => {
    const mfg = SHEET.fields.map((f) => (f.name === 'Mfg' ? { ...f, value: 'Infineon', shown: true } : f));
    expect(showsSet({ fields: [{ name: 'Mfg', value: 'Infineon', shown: true }] }, SHEET, after({ fields: mfg }))).toBe(true);
    expect(showsSet({ fields: [{ name: 'Mfg', shown: false }] }, SHEET, after({ fields: mfg }))).toBe(false);
    expect(showsSet({ fields: [{ name: 'mfg', value: 'Infineon' }] }, SHEET, after({ fields: mfg }))).toBe(false);
    const added = [...SHEET.fields, { name: 'Tolerance', value: '1%', shown: true, kind: 'user' as const }];
    expect(showsSet({ addField: { name: 'Tolerance', value: '1%', shown: true } }, SHEET, after({ fields: added }))).toBe(true);
    expect(showsSet({ addField: { name: 'Tolerance', value: '1%', shown: false } }, SHEET, after({ fields: added }))).toBe(false);
    expect(showsSet({ removeField: 'Mfg' }, SHEET, after({ fields: SHEET.fields.filter((f) => f.name !== 'Mfg') }))).toBe(true);
    expect(showsSet({ removeField: 'Mfg' }, SHEET, SHEET)).toBe(false);
  });

  it('reads an orientation in KiCad\'s spelling: a mirror across Y is the mirror across X turned 180 degrees more', () => {
    expect(sameOrientation({ rotation: 90, mirror: 'y' }, { rotation: 270, mirror: 'x' })).toBe(true);
    expect(sameOrientation({ rotation: 270, mirror: 'y' }, { rotation: 90, mirror: 'x' })).toBe(true);
    expect(sameOrientation({ rotation: 90, mirror: 'none' }, { rotation: 270, mirror: 'none' })).toBe(false);
    expect(sameOrientation({ rotation: 0, mirror: 'x' }, { rotation: 0, mirror: 'none' })).toBe(false);
    // engine run 10 on Glasgow's U1: rotation 90, then mirror y alone, read back as 270 mirror x.
    const turned = after({ rotation: 90 });
    expect(showsSet({ mirror: 'y' }, turned, after({ rotation: 270, mirror: 'x' }))).toBe(true);
    // The half not asked for keeps its reading.
    expect(showsSet({ rotation: 180 }, after({ mirror: 'x' }), after({ rotation: 180, mirror: 'x' }))).toBe(true);
    expect(showsSet({ rotation: 180 }, after({ mirror: 'x' }), after({ rotation: 180 }))).toBe(false);
  });
});

describe('the bounds a symbol sets', () => {
  it('names why a set cannot apply to this symbol, or nothing', () => {
    expect(misfit({ value: 'x' }, SHEET)).toBeNull();
    expect(misfit({ fields: [{ name: 'Mfg', shown: true }, { name: 'Reference', shown: false }] }, SHEET)).toBeNull();
    expect(misfit({ fields: [{ name: 'Tolerance', shown: true }] }, SHEET)).toBe('no field Tolerance');
    expect(misfit({ removeField: 'Tolerance' }, SHEET)).toBe('no field Tolerance');
    expect(misfit({ removeField: 'Datasheet' }, SHEET)).toBe('Datasheet is not a user field');
    expect(misfit({ removeField: 'MPN' }, SHEET)).toBeNull();
    expect(misfit({ addField: { name: 'mpn', value: '', shown: false } }, SHEET)).toBe('mpn is taken');
    expect(misfit({ addField: { name: 'value', value: '', shown: false } }, SHEET)).toBe('value is taken');
    expect(misfit({ addField: { name: 'Tolerance', value: '1%', shown: true } }, SHEET)).toBeNull();
    expect(misfit({ unit: 2 }, SHEET)).toBe('unit 2 of 1');
    expect(misfit({ unit: 5 }, { ...SHEET, units: 8 })).toBeNull();
    expect(misfit({ bodyStyle: 2 }, SHEET)).toBe('the symbol has one drawing');
    expect(misfit({ bodyStyle: 2 }, { ...SHEET, bodyStyles: 2 })).toBeNull();
  });
});
