// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { describe, expect, it } from 'vitest';
import {
  MAX_SYMBOL_ROWS, parseSymbolsGetArgs, parseSymbolsSet, parseSymbolsSetArgs, readRunError, readSymbolsRecord, readSymbolTable, symbolsGetJson,
  symbolsSetJson, type SymbolRow,
} from './symbols';

const U = 'aaaaaaaa-0000-4000-8000-000000000001';
const V = 'aaaaaaaa-0000-4000-8000-000000000002';
const S = `/${'bbbbbbbb-0000-4000-8000-000000000009'}/`;
const enc = (v: unknown) => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v));
const row = (o: Record<string, unknown> = {}): SymbolRow => ({
  uuid: U, sheetPath: '/', sheetName: 'Root', ref: 'R1', unit: 1, units: 1, libId: 'Device:R', value: '10k', footprint: 'Resistor_SMD:R_0603_1608Metric',
  fields: [{ name: 'Datasheet', value: '~', shown: false }, { name: 'MPN', value: 'RC0603', shown: false }],
  inBom: true, onBoard: true, inSim: true, inPos: true, dnp: false, sheetHeld: [], overrides: [], filters: ['R_*'], pins: 2, ...o,
} as SymbolRow);
const table = (o: Record<string, unknown> = {}) => JSON.stringify({ variant: '', variants: ['Lite', 'Pro'], rows: [row()], power: 3, truncated: false, depth: 4, ...o });

describe('symbols.get args', () => {
  it('takes every part, or the instances asked, under a variant', () => {
    expect(parseSymbolsGetArgs({ variant: '', scope: 'all' })).toEqual({ variant: '', scope: 'all' });
    expect(parseSymbolsGetArgs({ variant: 'Lite', items: [{ uuid: U, sheetPath: '/' }, { uuid: U, sheetPath: S }] })).toEqual({ variant: 'Lite', items: [{ uuid: U, sheetPath: '/' }, { uuid: U, sheetPath: S }] });
    expect(JSON.parse(symbolsGetJson({ variant: 'Pro', scope: 'all' }))).toEqual({ variant: 'Pro', scope: 'all' });
  });

  it('refuses each other shape', () => {
    for (const a of [undefined, {}, { scope: 'all' }, { variant: '' }, { variant: 1, scope: 'all' }, { variant: '', scope: 'some' },
      { variant: '', scope: 'all', items: [] }, { variant: '', items: [] }, { variant: '', items: [{ uuid: U }] },
      { variant: '', items: [{ uuid: U.toUpperCase(), sheetPath: '/' }] }, { variant: '', items: [{ uuid: U, sheetPath: '/' }, { uuid: U, sheetPath: '/' }] },
      { variant: 'a\nb', scope: 'all' }, { variant: 'x'.repeat(129), scope: 'all' },
      { variant: '', items: Array.from({ length: MAX_SYMBOL_ROWS + 1 }, (_, i) => ({ uuid: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`, sheetPath: '/' })) }]) {
      expect(parseSymbolsGetArgs(a), JSON.stringify(a)?.slice(0, 80)).toBeNull();
    }
  });
});

describe('symbols.set args', () => {
  it('takes the default variant\'s every key and a variant\'s values, flags and clears', () => {
    const set = { ref: 'R9', value: '4k7', footprint: 'Resistor_SMD:R_0805_2012Metric', fields: [{ name: 'MPN', value: 'X', shown: true }],
      addField: { name: 'Note', value: 'n', shown: false }, removeField: 'Old', inBom: false, onBoard: true, inSim: false, inPos: false, dnp: true };
    expect(parseSymbolsSetArgs({ variant: '', changes: [{ uuid: U, sheetPath: '/', set }] })).toEqual({ variant: '', changes: [{ uuid: U, sheetPath: '/', set }] });
    const lite = { value: '1k', fields: [{ name: 'MPN', value: 'Y' }], dnp: true, clear: ['footprint', 'inBom', 'Mfg'] };
    expect(parseSymbolsSetArgs({ variant: 'Lite', changes: [{ uuid: U, sheetPath: '/', set: lite }, { uuid: V, sheetPath: S, set: { clear: ['value'] } }] })?.changes).toHaveLength(2);
    expect(JSON.parse(symbolsSetJson(3, '/tmp/cc-symbols/3', { variant: '', changes: [{ uuid: U, sheetPath: '/', set: { dnp: true } }] })))
      .toEqual({ run: 3, dir: '/tmp/cc-symbols/3', variant: '', changes: [{ uuid: U, sheetPath: '/', set: { dnp: true } }] });
  });

  it('refuses under a variant what a variant cannot hold, and a clear outside one', () => {
    for (const set of [{ ref: 'R2' }, { addField: { name: 'N', value: '', shown: true } }, { removeField: 'MPN' }, { fields: [{ name: 'MPN', shown: true }] }, { fields: [{ name: 'Reference', value: 'R3' }] }]) {
      expect(parseSymbolsSet(set, 'Lite'), JSON.stringify(set)).toBeNull();
      expect(parseSymbolsSet(set, ''), JSON.stringify(set)).not.toBeNull();
    }
    expect(parseSymbolsSet({ clear: ['value'] }, '')).toBeNull();
    // Never set and cleared at once.
    for (const set of [{ value: '1', clear: ['value'] }, { dnp: true, clear: ['dnp'] }, { fields: [{ name: 'MPN', value: 'a' }], clear: ['MPN'] }, { footprint: '', clear: ['footprint'] }]) {
      expect(parseSymbolsSet(set, 'Lite'), JSON.stringify(set)).toBeNull();
    }
  });

  it('refuses each other shape', () => {
    const ok = { uuid: U, sheetPath: '/', set: { dnp: true } };
    for (const a of [undefined, {}, { variant: '' }, { variant: '', changes: [] }, { variant: '', changes: [ok], extra: 1 }, { variant: '', changes: [ok, ok] },
      { variant: '', changes: [{ ...ok, set: {} }] }, { variant: '', changes: [{ ...ok, set: { inPos: 'no' } }] }, { variant: '', changes: [{ ...ok, set: { rotation: 90 } }] },
      { variant: '', changes: [{ uuid: U, set: { dnp: true } }] }, { variant: '', changes: [{ ...ok, extra: 1 }] }, { variant: '', changes: [{ ...ok, set: { footprint: 'nocolon' } }] },
      { variant: '', changes: [{ ...ok, set: { ref: '' } }] }, { variant: '', changes: [{ ...ok, set: { value: '1', fields: [{ name: 'Value', value: '2' }] } }] }]) {
      expect(parseSymbolsSetArgs(a), JSON.stringify(a)).toBeNull();
    }
  });
});

describe('the engine\'s table and records', () => {
  it('reads a table closed, with a variant\'s overrides and a sheet\'s held flags', () => {
    expect(readSymbolTable(table())).toEqual(JSON.parse(table()));
    const r = row({ dnp: true, sheetHeld: ['dnp'], overrides: ['value', 'inBom', 'MPN'], unit: 2, units: 2 });
    expect(readSymbolTable(table({ variant: 'Pro', rows: [r] }))?.rows[0]).toEqual(r);
    expect(readSymbolTable(table({ rows: [], variants: [] }))).toEqual({ variant: '', variants: [], rows: [], power: 3, truncated: false, depth: 4 });
  });

  it('refuses a table of any other shape', () => {
    for (const bad of ['', 'x', '[]', undefined, table({ extra: 1 }), table({ depth: -1 }), table({ variants: [''] }), table({ power: 1.5 }),
      table({ rows: [{ ...row(), extra: 1 }] }), table({ rows: [row({ uuid: 'R1' })] }), table({ rows: [row({ sheetHeld: ['dnp', 'dnp'] })] }),
      table({ rows: [row({ sheetHeld: ['placed'] })] }), table({ rows: [row({ unit: 0 })] }), table({ rows: [row({ fields: [{ name: 'a', value: 'b' }] })] }),
      table({ rows: [row({ inPos: 'yes' })] }), table({ rows: [row({ overrides: [''] })] }), table({ rows: [row({ ref: 'R'.repeat(65) })] })]) {
      expect(readSymbolTable(bad), String(bad).slice(0, 100)).toBeNull();
    }
  });

  it('reads a set\'s record and a run\'s last file closed', () => {
    expect(readSymbolsRecord(enc({ applied: 263, depth: 5 }))).toEqual({ applied: 263, depth: 5 });
    expect(readSymbolsRecord(enc({ applied: 1 }))).toBeNull();
    expect(readSymbolsRecord(enc({ applied: 1, depth: 2, x: 1 }))).toBeNull();
    expect(readSymbolsRecord(null)).toBeNull();
    expect(readRunError(enc({ error: '', message: '' }), ['no_variant'])).toEqual({ error: '', message: '' });
    expect(readRunError(enc({ error: 'no_variant', message: 'gone' }), ['no_variant'])).toEqual({ error: 'no_variant', message: 'gone' });
    expect(readRunError(enc({ error: 'other', message: '' }), ['no_variant'])).toBeNull();
    expect(readRunError(enc({ error: '' }), [])).toBeNull();
    expect(readRunError(enc('not json'), [])).toBeNull();
  });
});
