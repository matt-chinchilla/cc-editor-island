// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The footprint editor's asks read closed and the slot that takes them
// (bridge/fpedit/ask.ts): every form KiCad sends, nothing else, once per
// request, only while the gate admits, and the slot cleared by its stop.
import { describe, expect, it, vi } from 'vitest';
import {
  FPEDIT_ASKS, FPEDIT_FRAME_ASKS, FPEDIT_ITEM_ASKS, FPEDIT_NEW_ASKS, installFpEditAsk, readFpEditAsk, type FpEditAskWindow,
} from './ask';

const U = '0f0e0d0c-0b0a-4000-8000-000000000001';
const req = (ask: string, uuid: string, isNew: boolean): string => JSON.stringify({ ask, uuid, isNew });

describe('readFpEditAsk', () => {
  it('reads every item ask with its uuid, every frame ask with "", and the new items KiCad places', () => {
    for (const ask of FPEDIT_ITEM_ASKS) expect(readFpEditAsk(req(ask, U, false)), ask).toEqual({ ask, uuid: U, isNew: false });
    for (const ask of FPEDIT_FRAME_ASKS) expect(readFpEditAsk(req(ask, '', false)), ask).toEqual({ ask, uuid: '', isNew: false });
    for (const ask of FPEDIT_NEW_ASKS) expect(readFpEditAsk(req(ask, U, true)), ask).toEqual({ ask, uuid: U, isNew: true });
    expect(readFpEditAsk(req('image', '', true))).toEqual({ ask: 'image', uuid: '', isNew: true });
    expect(new Set(FPEDIT_ASKS).size).toBe(FPEDIT_ITEM_ASKS.length + FPEDIT_FRAME_ASKS.length);
  });

  it('refuses every other form: a frame ask with a uuid, an item ask with none, a new pad, an upper case uuid, a key more or less', () => {
    for (const bad of [
      req('footprint', U, false), req('padDefaults', U, false), req('pad', '', false), req('pushPad', '', false),
      req('pad', U, true), req('shape', U, true), req('image', U, true), req('enumerate', '', true), req('text', '', true),
      req('pad', U.toUpperCase(), false), req('pin', U, false), req('symbol', '', false),
      JSON.stringify({ ask: 'pad', uuid: U }), JSON.stringify({ ask: 'pad', uuid: U, isNew: false, field: 'x' }),
      JSON.stringify({ ask: 'pad', uuid: U, isNew: 0 }), '{', '', '[]', 'null',
      req('pad', U, false) + ' '.repeat(1100),
    ]) expect(readFpEditAsk(bad), bad.slice(0, 80)).toBeNull();
    expect(readFpEditAsk({ ask: 'pad', uuid: U, isNew: false })).toBeNull();
  });
});

describe('installFpEditAsk', () => {
  it('takes each admitted request once and answers true; a refused shape, a closed gate or a throw answers false', () => {
    const w: FpEditAskWindow = {};
    const gate = { open: false };
    const send = vi.fn();
    installFpEditAsk(w, { admit: () => gate.open, send });
    const press = (json: string) => w.kicadHostFpEdit?.onRequest?.(json);
    expect(press(req('pad', U, false))).toBe(false);
    gate.open = true;
    expect(press(req('pad', U, false))).toBe(true);
    expect(press(req('footprint', '', false))).toBe(true);
    expect(press(req('pad', '', false))).toBe(false);
    expect(send.mock.calls).toEqual([[{ ask: 'pad', uuid: U, isNew: false }], [{ ask: 'footprint', uuid: '', isNew: false }]]);
    const throws = installFpEditAsk(w, { admit: () => true, send: () => { throw new Error('host gone'); } });
    expect(press(req('pad', U, false))).toBe(false);
    throws();
    expect(w.kicadHostFpEdit).toBeUndefined();
  });

  it('takes only the asks it is given (another frame\'s use), and its stop leaves a later slot in place', () => {
    const w: FpEditAskWindow = {};
    const send = vi.fn();
    const stop = installFpEditAsk(w, { admit: () => true, send, asks: ['graphics'] });
    expect(w.kicadHostFpEdit?.onRequest?.(req('pad', U, false))).toBe(false);
    expect(w.kicadHostFpEdit?.onRequest?.(req('graphics', '', false))).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const later = { onRequest: () => true };
    w.kicadHostFpEdit = later;
    stop();
    expect(w.kicadHostFpEdit).toBe(later);
  });
});
