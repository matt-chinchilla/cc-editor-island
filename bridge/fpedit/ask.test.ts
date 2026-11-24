// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The footprint editor's asks read closed and the slot that takes them
// (bridge/fpedit/ask.ts): every form KiCad sends, nothing else, once per
// request, only while the gate admits, and the slot cleared by its stop.
import { describe, expect, it, vi } from 'vitest';
import {
  FPEDIT_ASKS, FPEDIT_FRAME_ASKS, FPEDIT_ITEM_ASKS, FPEDIT_NEW_ASKS, installFpEditAsk, readFpEditAsk, readFpEditNotice, type FpEditAskWindow,
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

  it('reads a group ask (engine fix e3-1) as an item ask: its uuid, never new, never ""', () => {
    expect(FPEDIT_ITEM_ASKS).toContain('group');
    expect(readFpEditAsk(req('group', U, false))).toEqual({ ask: 'group', uuid: U, isNew: false });
    expect(readFpEditAsk(req('group', '', false))).toBeNull();
    expect(readFpEditAsk(req('group', U, true))).toBeNull();
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

/** Build T17 (engine item 5): the footprint editor tells the page when its pad numbering loop ends. */
describe('readFpEditNotice', () => {
  it('reads exactly { notice: "enumerateEnd", kept }', () => {
    expect(readFpEditNotice('{"notice":"enumerateEnd","kept":true}')).toEqual({ notice: 'enumerateEnd', kept: true });
    expect(readFpEditNotice('{"notice":"enumerateEnd","kept":false}')).toEqual({ notice: 'enumerateEnd', kept: false });
  });

  it('refuses every other shape: another notice, kept not a boolean, a key more or less, not JSON, not a string, too long', () => {
    for (const bad of [
      '{"notice":"other","kept":true}', '{"notice":"enumerateEnd","kept":1}', '{"notice":"enumerateEnd"}',
      '{"notice":"enumerateEnd","kept":true,"x":1}', '{"kept":true}', 'enumerateEnd', '[]', 'null', '',
      `{"notice":"enumerateEnd","kept":true${' '.repeat(300)}}`,
    ]) expect(readFpEditNotice(bad), bad).toBeNull();
    expect(readFpEditNotice({ notice: 'enumerateEnd', kept: true })).toBeNull();
  });
});

describe('the slot\'s onNotice', () => {
  it('hands each closed notice to `notice` once, after the gate admits; any other shape, a closed gate or a throw is dropped', () => {
    const w: FpEditAskWindow = {};
    const gate = { open: false };
    const notice = vi.fn();
    installFpEditAsk(w, { admit: () => gate.open, send: vi.fn(), notice });
    const say = (text: unknown) => w.kicadHostFpEdit?.onNotice?.(text);
    say('{"notice":"enumerateEnd","kept":true}');
    gate.open = true;
    say('{"notice":"enumerateEnd","kept":false}');
    say('{"notice":"enumerateEnd","kept":"no"}');
    expect(notice.mock.calls).toEqual([[{ notice: 'enumerateEnd', kept: false }]]);
    installFpEditAsk(w, { admit: () => true, send: vi.fn(), notice: () => { throw new Error('host gone'); } });
    expect(() => say('{"notice":"enumerateEnd","kept":true}')).not.toThrow();
  });

  it('without `notice` the slot has no onNotice, so the engine finds no function and says nothing', () => {
    const w: FpEditAskWindow = {};
    installFpEditAsk(w, { admit: () => true, send: vi.fn() });
    expect(w.kicadHostFpEdit?.onNotice).toBeUndefined();
  });
});
