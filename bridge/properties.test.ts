// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { describe, expect, it, vi } from 'vitest';
import { installProperties, readPropertiesRequest, type PropertiesWindow } from './properties';

const U = '0b9b3c55-6d0e-4c6c-9e86-2f3f1d6f7a01';
const S = '1c8a2d44-5e1f-4b7b-8f75-3e2e0c5e6b02';
const req = (o: Record<string, unknown>) => JSON.stringify(o);

describe("the engine's properties request", () => {
  it('reads a symbol and its sheet path in symbol.set\'s form, the field name dropped', () => {
    expect(readPropertiesRequest(req({ type: 'symbol', uuid: U, sheetPath: '/' }))).toEqual({ uuid: U, sheetPath: '/' });
    expect(readPropertiesRequest(req({ type: 'symbol', uuid: U, sheetPath: `/${S}/`, field: 'Reference' }))).toEqual({ uuid: U, sheetPath: `/${S}/` });
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
    installProperties(w, { admit: () => open, send });
    const ask = (j: unknown) => w.kicadProperties?.onRequest?.(j);
    expect(ask(req({ type: 'symbol', uuid: U, sheetPath: '/' }))).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ uuid: U, sheetPath: '/' });
    expect(ask(req({ type: 'sheet', uuid: U, sheetPath: '/' }))).toBe(false);
    open = false;
    expect(ask(req({ type: 'symbol', uuid: U, sheetPath: '/' }))).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    const w2: PropertiesWindow = {};
    installProperties(w2, { admit: () => { throw new Error('x'); }, send });
    expect(w2.kicadProperties?.onRequest?.(req({ type: 'symbol', uuid: U, sheetPath: '/' }))).toBe(false);
    const w3: PropertiesWindow = {};
    installProperties(w3, { admit: () => true, send: () => { throw new Error('x'); } });
    expect(w3.kicadProperties?.onRequest?.(req({ type: 'symbol', uuid: U, sheetPath: '/' }))).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
