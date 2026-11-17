// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { describe, expect, it } from 'vitest';
import { footprintExchangeJson, parseFootprintExchangeArgs, parseSymbolExchangeArgs, readExchangeReport, symbolExchangeJson } from './exchange';

const U = 'aaaaaaaa-0000-4000-8000-000000000001';
const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const SYM = { mode: 'change', targets: [{ uuid: U, sheetPath: '/' }], libId: 'Device:R_Small', fields: 'all', options: { resetText: true, resetCustomPower: false }, preview: true };
const FP = { mode: 'update', match: { ref: 'R*' }, libId: '', options: { reset3D: true }, preview: false };

describe('symbols.exchange args', () => {
  it('takes a change to a named symbol and an update from each part\'s own source', () => {
    expect(parseSymbolExchangeArgs(SYM)).toEqual(SYM);
    expect(parseSymbolExchangeArgs({ ...SYM, mode: 'update', libId: '', fields: ['Value', 'MPN', 'MPN'], options: {} })?.fields).toEqual(['Value', 'MPN']);
    expect(JSON.parse(symbolExchangeJson(2, '/tmp/cc-exchange/2', parseSymbolExchangeArgs(SYM)!))).toEqual({ run: 2, dir: '/tmp/cc-exchange/2', ...SYM });
  });

  it('refuses each other shape', () => {
    for (const a of [undefined, {}, { ...SYM, extra: 1 }, { ...SYM, mode: 'swap' }, { ...SYM, libId: '' }, { ...SYM, mode: 'update' }, { ...SYM, libId: 'R' },
      { ...SYM, targets: [] }, { ...SYM, targets: [{ uuid: U, sheetPath: '/' }, { uuid: U, sheetPath: '/' }] }, { ...SYM, fields: [] }, { ...SYM, fields: 'some' },
      { ...SYM, options: { resetFootprint: true } }, { ...SYM, options: { resetText: 1 } }, { ...SYM, preview: 'yes' }]) {
      expect(parseSymbolExchangeArgs(a), JSON.stringify(a)).toBeNull();
    }
  });
});

describe('footprints.exchange args', () => {
  it('takes each match', () => {
    expect(parseFootprintExchangeArgs(FP)).toEqual(FP);
    for (const match of [{ all: true }, { uuids: [U] }, { value: '10k' }, { libId: 'Resistor_SMD:R_0603_1608Metric' }]) {
      expect(parseFootprintExchangeArgs({ ...FP, match })?.match).toEqual(match);
    }
    const change = { ...FP, mode: 'change', libId: 'Resistor_SMD:R_0805_2012Metric' };
    expect(JSON.parse(footprintExchangeJson(1, '/tmp/cc-exchange/1', parseFootprintExchangeArgs(change)!))).toEqual({ run: 1, dir: '/tmp/cc-exchange/1', ...change });
  });

  it('refuses each other shape', () => {
    for (const a of [undefined, { ...FP, match: {} }, { ...FP, match: { all: false } }, { ...FP, match: { all: true, ref: 'R*' } }, { ...FP, match: { uuids: [] } },
      { ...FP, match: { ref: '' } }, { ...FP, match: { ref: 'a\tb' } }, { ...FP, mode: 'change' }, { ...FP, libId: 'X:Y' }, { ...FP, options: { resetText: true } }, { ...FP, preview: 0 }]) {
      expect(parseFootprintExchangeArgs(a), JSON.stringify(a)).toBeNull();
    }
  });
});

describe('the exchange report', () => {
  const row = { uuid: U, sheetPath: '/', ref: 'R1', from: 'Device:R', to: 'Device:R_Small', status: 'changed' };
  const report = (o: Record<string, unknown> = {}) => ({ preview: true, rows: [row], applied: 1, truncated: false, depth: 3, ...o });

  it('reads a schematic report with sheet paths and a board report without', () => {
    expect(readExchangeReport(enc(report()), 'sch')).toEqual(report());
    const { sheetPath: _drop, ...board } = row;
    expect(readExchangeReport(enc(report({ rows: [{ ...board, status: 'locked' }] })), 'pcb')?.rows[0]).toEqual({ ...board, status: 'locked' });
  });

  it('refuses each other shape', () => {
    for (const [r, f] of [[report({ x: 1 }), 'sch'], [report({ rows: [{ ...row, status: 'odd' }] }), 'sch'], [report(), 'pcb'], [report({ rows: [{ ...row, sheetPath: undefined }] }), 'sch'],
      [report({ applied: -1 }), 'sch'], [report({ preview: 1 }), 'sch']] as const) {
      expect(readExchangeReport(enc(r), f), JSON.stringify(r)).toBeNull();
    }
    expect(readExchangeReport(null, 'sch')).toBeNull();
  });
});
