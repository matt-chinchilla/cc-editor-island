// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMON_LIBS, installPickKeys, libIds, MAX_PREFETCH, parseIndexArgs, parseItemArgs, parsePrefetchArgs, pickFor, quietWarmUp, takesText, warmTiming, type PickerLibs } from './picker';

describe('the ops\' closed args', () => {
  it('lib.index takes { kind } and nothing else', () => {
    expect(parseIndexArgs({ kind: 'symbol' })).toEqual({ kind: 'symbol' });
    expect(parseIndexArgs({ kind: 'footprint' })).toEqual({ kind: 'footprint' });
    for (const bad of [undefined, null, [], {}, { kind: 'model3d' }, { kind: 'symbol', tag: '10.0.4' }]) expect(parseIndexArgs(bad)).toBeNull();
  });

  it('lib.item and place take { kind, lib, name }: names non-empty, at most 255 characters, no control character', () => {
    expect(parseItemArgs({ kind: 'symbol', lib: 'MCU_ST_STM32F1', name: 'STM32F103C8Tx' })).toEqual({ kind: 'symbol', lib: 'MCU_ST_STM32F1', name: 'STM32F103C8Tx' });
    expect(parseItemArgs({ kind: 'footprint', lib: 'Connector_PinHeader_2.54mm', name: 'PinHeader_1x02_P2.54mm_Vertical' })).not.toBeNull();
    expect(parseItemArgs({ kind: 'symbol', lib: 'L', name: 'x'.repeat(255) })).not.toBeNull();
    for (const bad of [
      { kind: 'symbol', lib: 'Device' },
      { kind: 'symbol', lib: '', name: 'R' },
      { kind: 'symbol', lib: 'Device', name: 'x'.repeat(256) },
      { kind: 'symbol', lib: 'Device', name: 'R\u0000' },
      { kind: 'symbol', lib: 'Dev\tice', name: 'R' },
      { kind: 'symbol', lib: 'Device', name: 'R', unit: 1 },
      { kind: 'part', lib: 'Device', name: 'R' },
      { kind: 'symbol', lib: ['Device'], name: 'R' },
    ]) expect(parseItemArgs(bad)).toBeNull();
  });

  it('lib.prefetch takes { kind, libs } with at most 16 nicknames', () => {
    expect(parsePrefetchArgs({ kind: 'symbol', libs: [] })).toEqual({ kind: 'symbol', libs: [] });
    expect(parsePrefetchArgs({ kind: 'footprint', libs: Array.from({ length: MAX_PREFETCH }, (_, i) => `L${i}`) })?.libs).toHaveLength(16);
    for (const bad of [
      { kind: 'symbol' },
      { kind: 'symbol', libs: 'Device' },
      { kind: 'symbol', libs: Array.from({ length: 17 }, (_, i) => `L${i}`) },
      { kind: 'symbol', libs: [''] },
      { kind: 'symbol', libs: ['Device'], priority: 'low' },
    ]) expect(parsePrefetchArgs(bad)).toBeNull();
  });
});

describe('the place keys', () => {
  it('are A (a symbol) and P (a power symbol) in a schematic, A (a footprint) on a board, with no modifier', () => {
    expect(pickFor('sch', { key: 'a', code: 'KeyA' })).toEqual({ kind: 'symbol' });
    expect(pickFor('sch', { key: 'p', code: 'KeyP' })).toEqual({ kind: 'symbol', power: true });
    expect(pickFor('pcb', { key: 'a', code: 'KeyA' })).toEqual({ kind: 'footprint' });
    expect(pickFor('pcb', { key: 'p', code: 'KeyP' })).toBeNull();
    for (const mod of ['ctrlKey', 'shiftKey', 'altKey', 'metaKey']) expect(pickFor('sch', { key: 'a', code: 'KeyA', [mod]: true })).toBeNull();
    for (const key of ['w', 'Enter', 'Escape', 'F1', '']) expect(pickFor('sch', { key, code: 'KeyW' })).toBeNull();
  });

  it('are read by the character typed, as KiCad matches its letter keys: Caps Lock\'s A, and the key that types a on AZERTY', () => {
    expect(pickFor('sch', { key: 'A', code: 'KeyA' })).toEqual({ kind: 'symbol' });
    expect(pickFor('sch', { key: 'a', code: 'KeyQ' })).toEqual({ kind: 'symbol' });
    expect(pickFor('sch', { key: 'q', code: 'KeyA' })).toBeNull();
  });

  it('are never taken from a text field', () => {
    for (const el of [{ tagName: 'INPUT' }, { tagName: 'input', type: 'search' }, { tagName: 'INPUT', type: 'number' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' }, { tagName: 'DIV', isContentEditable: true }]) expect(takesText(el)).toBe(true);
    for (const el of [null, undefined, 'INPUT', { tagName: 'INPUT', type: 'checkbox' }, { tagName: 'INPUT', type: 'range' }, { tagName: 'BUTTON' }, { tagName: 'CANVAS' }, { tagName: 'BODY' }]) expect(takesText(el)).toBe(false);
  });
});

describe('installPickKeys', () => {
  /** A key event as the browser makes it, on a real EventTarget (Node has no KeyboardEvent). */
  const key = (type: string, init: Record<string, unknown>): Event => Object.assign(new Event(type, { bubbles: true, cancelable: true }), { repeat: false, ...init });

  function setup(frame: 'sch' | 'pcb' = 'sch') {
    const win = new EventTarget();
    const state = { open: true, focused: null as unknown };
    const picks: unknown[] = [];
    const remove = installPickKeys(win as unknown as Window, { frame, open: () => state.open, focused: () => state.focused, onPick: (p) => picks.push(p) });
    // KiCad's own listeners, added later (the engine's scripts load after the island's), capture and bubble.
    const kicad: string[] = [];
    for (const capture of [true, false]) for (const type of ['keydown', 'keypress', 'keyup']) win.addEventListener(type, (e) => kicad.push(`${e.type}:${(e as Event & { key: string }).key}`), capture);
    return { win, state, picks, kicad, remove };
  }

  it('swallows a place key\'s keydown, keypress and keyup before KiCad\'s own listeners, and picks once per press', () => {
    const { win, picks, kicad } = setup();
    const down = key('keydown', { key: 'a', code: 'KeyA' });
    win.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    win.dispatchEvent(key('keydown', { key: 'a', code: 'KeyA', repeat: true }));
    win.dispatchEvent(key('keypress', { key: 'a', code: 'KeyA' }));
    win.dispatchEvent(key('keyup', { key: 'a', code: 'KeyA' }));
    expect(kicad).toEqual([]);
    expect(picks).toEqual([{ kind: 'symbol' }]);
    win.dispatchEvent(key('keydown', { key: 'p', code: 'KeyP' }));
    win.dispatchEvent(key('keyup', { key: 'p', code: 'KeyP' }));
    expect(picks).toEqual([{ kind: 'symbol' }, { kind: 'symbol', power: true }]);
    expect(kicad).toEqual([]);
  });

  it('leaves KiCad every other key, a place key with a modifier, and its keyup', () => {
    const { win, picks, kicad } = setup();
    win.dispatchEvent(key('keydown', { key: 'w', code: 'KeyW' }));
    win.dispatchEvent(key('keyup', { key: 'w', code: 'KeyW' }));
    win.dispatchEvent(key('keydown', { key: 'a', code: 'KeyA', ctrlKey: true }));
    win.dispatchEvent(key('keyup', { key: 'a', code: 'KeyA', ctrlKey: true }));
    expect(picks).toEqual([]);
    expect(kicad).toEqual(['keydown:w', 'keydown:w', 'keyup:w', 'keyup:w', 'keydown:a', 'keydown:a', 'keyup:a', 'keyup:a']);
  });

  it('leaves the key to KiCad while something of KiCad\'s is up or a text field has the focus', () => {
    const { win, state, picks, kicad } = setup('pcb');
    state.open = false;
    win.dispatchEvent(key('keydown', { key: 'a', code: 'KeyA' }));
    state.open = true;
    state.focused = { tagName: 'INPUT', type: 'text' };
    win.dispatchEvent(key('keydown', { key: 'a', code: 'KeyA' }));
    state.focused = null;
    win.dispatchEvent(key('keydown', { key: 'a', code: 'KeyA' }));
    expect(picks).toEqual([{ kind: 'footprint' }]);
    expect(kicad.filter((k) => k === 'keydown:a')).toHaveLength(4);
  });

  it('a press whose keyup was lost (the focus moved away) does not swallow the next press unreported', () => {
    const { win, picks } = setup();
    win.dispatchEvent(key('keydown', { key: 'a', code: 'KeyA' }));
    win.dispatchEvent(key('keydown', { key: 'a', code: 'KeyA' }));
    expect(picks).toHaveLength(2);
  });

  it('answers a remover', () => {
    const { win, picks, kicad, remove } = setup();
    remove();
    win.dispatchEvent(key('keydown', { key: 'a', code: 'KeyA' }));
    expect(picks).toEqual([]);
    expect(kicad).toEqual(['keydown:a', 'keydown:a']);
  });
});

describe('libIds', () => {
  it('reads the source\'s list once per kind, and asks again after a failed read', async () => {
    let fail = true;
    const listLibs = vi.fn(async (kind?: string) => {
      if (fail) { fail = false; throw new Error('manifest'); }
      return kind === 'symbol' ? [{ id: 'sym.Device', name: 'Device' }] : [{ id: 'fp.Resistor_SMD', name: 'Resistor_SMD' }];
    });
    const idOf = libIds({ listLibs });
    await expect(idOf('symbol', 'Device')).rejects.toThrow('manifest');
    expect(await idOf('symbol', 'Device')).toBe('sym.Device');
    expect(await idOf('symbol', 'Nope')).toBeNull();
    expect(await idOf('footprint', 'Resistor_SMD')).toBe('fp.Resistor_SMD');
    expect(listLibs).toHaveBeenCalledTimes(3);
  });
});

describe('the quiet warm-up', () => {
  const saved = { ...warmTiming };
  beforeEach(() => { Object.assign(warmTiming, { quietMs: 30, pollMs: 5, idleMs: 10 }); });
  afterEach(() => { Object.assign(warmTiming, saved); });

  function source(opts: { index?: boolean; prefetch?: boolean } = {}) {
    const calls: string[] = [];
    const s: PickerLibs = {
      listLibs: async (kind) => (kind === 'symbol'
        ? [{ id: 'sym.power', name: 'power' }, { id: 'sym.Device', name: 'Device' }, { id: 'sym.MCU_ST_STM32F1', name: 'MCU_ST_STM32F1' }, { id: 'sym.LED', name: 'LED' }]
        : [{ id: 'fp.Resistor_SMD', name: 'Resistor_SMD' }, { id: 'fp.Package_QFP', name: 'Package_QFP' }]),
      listItems: async (id) => { calls.push(`list ${id}`); return []; },
      getItemBody: async () => null,
    };
    if (opts.index !== false) s.getSearchIndex = async (kind) => { calls.push(`index ${kind}`); return '{}'; };
    if (opts.prefetch !== false) s.prefetch = async (id) => { calls.push(`prefetch ${id}`); };
    return { s, calls };
  }

  it('waits until no request has been in flight for a moment and the browser is idle, then fetches the frame\'s index and its common libraries, one at a time', async () => {
    const { s, calls } = source();
    let busy = true;
    const idle = vi.fn(async () => undefined);
    const t0 = Date.now();
    const p = quietWarmUp({ frame: 'sch', source: s, signal: new AbortController().signal, busy: () => busy, idle });
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual([]);   // a request is in flight: nothing yet
    busy = false;
    const warmed = await p;
    expect(Date.now() - t0).toBeGreaterThanOrEqual(50 + 30 - 5);
    expect(idle).toHaveBeenCalledWith(10);
    // Index first, then the common libraries in their list's order, only those the source has.
    expect(calls).toEqual(['index symbol', 'prefetch sym.Device', 'prefetch sym.power', 'prefetch sym.LED']);
    expect(warmed).toEqual(['sym.Device', 'sym.power', 'sym.LED']);
    expect(COMMON_LIBS.symbol.slice(0, 2)).toEqual(['Device', 'power']);
  });

  it('a board warms its footprint index and libraries; a source without prefetch is warmed by its item list, and one without an index asks for none', async () => {
    const { s, calls } = source({ index: false, prefetch: false });
    expect(await quietWarmUp({ frame: 'pcb', source: s, signal: new AbortController().signal, busy: () => false, idle: async () => undefined })).toEqual(['fp.Resistor_SMD']);
    expect(calls).toEqual(['list fp.Resistor_SMD']);
  });

  it('stops between steps once aborted, and never starts when aborted while it waits', async () => {
    const a = source();
    const stop = new AbortController();
    a.s.prefetch = async (id) => { a.calls.push(`prefetch ${id}`); stop.abort(); };
    expect(await quietWarmUp({ frame: 'sch', source: a.s, signal: stop.signal, busy: () => false, idle: async () => undefined })).toEqual(['sym.Device']);
    expect(a.calls).toEqual(['index symbol', 'prefetch sym.Device']);
    const b = source();
    const early = new AbortController();
    const p = quietWarmUp({ frame: 'sch', source: b.s, signal: early.signal, busy: () => true, idle: async () => undefined });
    early.abort();
    expect(await p).toEqual([]);
    expect(b.calls).toEqual([]);
  });

  it('never rejects: a failing index and a failing library are passed over', async () => {
    const { s, calls } = source();
    s.getSearchIndex = async () => { throw new Error('offline'); };
    s.prefetch = async (id) => { calls.push(`prefetch ${id}`); throw new Error('offline'); };
    expect(await quietWarmUp({ frame: 'sch', source: s, signal: new AbortController().signal, busy: () => false, idle: async () => undefined })).toEqual(['sym.Device', 'sym.power', 'sym.LED']);
  });
});
