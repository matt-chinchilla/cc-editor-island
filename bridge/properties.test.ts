// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { describe, expect, it, vi } from 'vitest';
import { installProperties, readPropertiesRequest, type PropertiesWindow } from './properties';

const U = '0b9b3c55-6d0e-4c6c-9e86-2f3f1d6f7a01';
const S = '1c8a2d44-5e1f-4b7b-8f75-3e2e0c5e6b02';
const req = (o: Record<string, unknown>) => JSON.stringify(o);

describe("the engine's properties request", () => {
  it('reads a symbol and its sheet path in symbol.set\'s form, with the field KiCad named (1 to 128 characters)', () => {
    expect(readPropertiesRequest(req({ type: 'symbol', uuid: U, sheetPath: '/' }))).toEqual({ type: 'symbol', uuid: U, sheetPath: '/' });
    expect(readPropertiesRequest(req({ type: 'symbol', uuid: U, sheetPath: `/${S}/`, field: 'Reference' }))).toEqual({ type: 'symbol', uuid: U, sheetPath: `/${S}/`, field: 'Reference' });
    expect(readPropertiesRequest(req({ type: 'symbol', uuid: U, sheetPath: '/', field: 'MPN' }), 'sch')).toEqual({ type: 'symbol', uuid: U, sheetPath: '/', field: 'MPN' });
  });

  it('takes the symbol whole when its field name is empty or past 128 characters: the form opens on the symbol', () => {
    expect(readPropertiesRequest(req({ type: 'symbol', uuid: U, sheetPath: '/', field: '' }))).toEqual({ type: 'symbol', uuid: U, sheetPath: '/' });
    expect(readPropertiesRequest(req({ type: 'symbol', uuid: U, sheetPath: '/', field: 'f'.repeat(129) }))).toEqual({ type: 'symbol', uuid: U, sheetPath: '/' });
    expect(readPropertiesRequest(req({ type: 'symbol', uuid: U, sheetPath: '/', field: 'f'.repeat(128) }))).toMatchObject({ field: 'f'.repeat(128) });
  });

  it('reads a board item\'s request in a pcb frame: its uuid and kind, a field name dropped (the form opens on the footprint)', () => {
    for (const kind of ['footprint', 'track', 'arc', 'via', 'zone', 'text', 'marker']) {
      expect(readPropertiesRequest(req({ type: 'board', uuid: U, kind }), 'pcb')).toEqual({ type: 'board', uuid: U, kind });
    }
    expect(readPropertiesRequest(req({ type: 'board', uuid: U, kind: 'footprint', field: 'Reference' }), 'pcb')).toEqual({ type: 'board', uuid: U, kind: 'footprint' });
    for (const bad of [
      req({ type: 'board', uuid: U, kind: 'pad' }), req({ type: 'board', uuid: U }), req({ type: 'board', uuid: 'U3', kind: 'footprint' }),
      req({ type: 'board', uuid: U, kind: 'footprint', field: 3 }), req({ type: 'board', uuid: U, kind: 'footprint', extra: 1 }),
    ]) expect(readPropertiesRequest(bad, 'pcb'), bad).toBeNull();
  });

  it('reads each frame\'s own kind only: a board request in a sch frame, a symbol in a pcb frame, are KiCad\'s', () => {
    expect(readPropertiesRequest(req({ type: 'board', uuid: U, kind: 'footprint' }), 'sch')).toBeNull();
    expect(readPropertiesRequest(req({ type: 'board', uuid: U, kind: 'footprint' }))).toBeNull();
    expect(readPropertiesRequest(req({ type: 'symbol', uuid: U, sheetPath: '/' }), 'pcb')).toBeNull();
  });

  it('refuses anything else', () => {
    for (const bad of [
      undefined, null, 1, {}, '', '{', '[]', 'x'.repeat(9000),
      req({ type: 'label', uuid: U, sheetPath: '/' }),
      req({ uuid: U, sheetPath: '/' }),
      req({ type: 'symbol', uuid: U.toUpperCase(), sheetPath: '/' }),
      req({ type: 'symbol', uuid: 'R1', sheetPath: '/' }),
      req({ type: 'symbol', uuid: U }),
      req({ type: 'symbol', uuid: U, sheetPath: '' }),
      req({ type: 'symbol', uuid: U, sheetPath: `/${S}` }),
      req({ type: 'symbol', uuid: U, sheetPath: 'root' }),
      req({ type: 'symbol', uuid: U, sheetPath: '/', field: 3 }),
    ]) expect(readPropertiesRequest(bad), String(bad).slice(0, 60)).toBeNull();
  });

  it('answers true and sends once only when admitted and read; false otherwise, a throw included', () => {
    const w: PropertiesWindow = {};
    let open = true;
    const send = vi.fn();
    installProperties(w, { frame: 'sch', admit: () => open, send });
    const ask = (j: unknown) => w.kicadProperties?.onRequest?.(j);
    expect(ask(req({ type: 'symbol', uuid: U, sheetPath: '/' }))).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ type: 'symbol', uuid: U, sheetPath: '/' });
    expect(ask(req({ type: 'sheet', uuid: U, sheetPath: '/' }))).toBe(false);
    open = false;
    expect(ask(req({ type: 'symbol', uuid: U, sheetPath: '/' }))).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    const w2: PropertiesWindow = {};
    installProperties(w2, { frame: 'sch', admit: () => { throw new Error('x'); }, send });
    expect(w2.kicadProperties?.onRequest?.(req({ type: 'symbol', uuid: U, sheetPath: '/' }))).toBe(false);
    const w3: PropertiesWindow = {};
    installProperties(w3, { frame: 'sch', admit: () => true, send: () => { throw new Error('x'); } });
    expect(w3.kicadProperties?.onRequest?.(req({ type: 'symbol', uuid: U, sheetPath: '/' }))).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('in a pcb frame sends a board item\'s request and refuses a symbol\'s', () => {
    const w: PropertiesWindow = {};
    const send = vi.fn();
    installProperties(w, { frame: 'pcb', admit: () => true, send });
    expect(w.kicadProperties?.onRequest?.(req({ type: 'board', uuid: U, kind: 'marker' }))).toBe(true);
    expect(w.kicadProperties?.onRequest?.(req({ type: 'symbol', uuid: U, sheetPath: '/' }))).toBe(false);
    expect(send.mock.calls).toEqual([[{ type: 'board', uuid: U, kind: 'marker' }]]);
  });
});
