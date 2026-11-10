// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The suite runs in node (no DOM package in this repository): the frame's
// window is node's own EventTarget, and KeyboardEvent a stand-in Event that
// keeps every init field, as in keys.test.ts.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { claimChords, HOST_KEY_CODE_RE, installHostKeys, KICAD_ALT_CHORDS, MAX_CHORDS, parseKeysClaim, type Chord } from './host-keys';
import { pressKey } from './keys';

beforeAll(() => {
  vi.stubGlobal('KeyboardEvent', class extends Event {
    constructor(type: string, init: Record<string, unknown> = {}) {
      const { bubbles, cancelable, composed, ...rest } = init as EventInit & Record<string, unknown>;
      super(type, { bubbles, cancelable, composed });
      Object.assign(this, rest);
    }
  });
});
afterAll(() => { vi.unstubAllGlobals(); });

type Init = { code: string; key?: string; altKey?: boolean; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; repeat?: boolean };
const key = (type: string, o: Init): Event => new KeyboardEvent(type, { key: o.key ?? 'x', bubbles: true, cancelable: true, altKey: true, ...o } as KeyboardEventInit);

/**
 * A frame window with the host keys installed first, then a stand-in for the
 * engine's own listeners registered the way Emscripten's
 * JSEvents.registerOrRemoveHandler registers them at boot
 * (target.addEventListener(type, handler, useCapture)), once with capture and
 * once without. `engine` records what reached KiCad.
 */
function frame() {
  const win = new EventTarget() as unknown as Window;
  const sent: Chord[] = [];
  const keys = installHostKeys(win, { onKey: (c) => sent.push(c) });
  const engine: string[] = [];
  for (const useCapture of [true, false]) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      win.addEventListener(type, (e) => { const k = e as KeyboardEvent; engine.push(`${useCapture ? 'cap' : 'bub'}:${type}:${k.code}${k.shiftKey ? '+s' : ''}`); }, useCapture);
    }
  }
  const fire = (type: string, o: Init): Event => { const e = key(type, o); win.dispatchEvent(e); return e; };
  return { win, keys, sent, engine, fire };
}

describe('parseKeysClaim', () => {
  it('reads a list of chords, shift absent meaning without Shift', () => {
    expect(parseKeysClaim({ chords: [] })).toEqual([]);
    expect(parseKeysClaim({ chords: [{ code: 'KeyM' }, { code: 'Slash', shift: true }, { code: 'Digit5', shift: false }] }))
      .toEqual([{ code: 'KeyM', shift: false }, { code: 'Slash', shift: true }, { code: 'Digit5', shift: false }]);
  });

  it('refuses the whole claim: a non-object, a non-array, an extra field, a bad code, a non-boolean shift, too many chords', () => {
    for (const bad of [
      undefined, null, 1, 'KeyM', [], {}, { chords: 'KeyM' }, { chords: null }, { chords: [], other: 1 },
      { chords: [{ code: 'KeyM', alt: true }] }, { chords: [{ code: 'keyM' }] }, { chords: [{ code: 'F1' }] }, { chords: [{ code: 'ArrowUp' }] },
      { chords: [{ code: 'KeyM' }, { code: '' }] }, { chords: [{ code: 'KeyM', shift: 1 }] }, { chords: ['KeyM'] }, { chords: [null] },
      { chords: Array.from({ length: MAX_CHORDS + 1 }, () => ({ code: 'KeyM' })) },
    ]) expect(parseKeysClaim(bad), JSON.stringify(bad)?.slice(0, 60)).toBeNull();
    expect(parseKeysClaim({ chords: Array.from({ length: MAX_CHORDS }, () => ({ code: 'KeyM' })) })).toHaveLength(MAX_CHORDS);
  });

  it('knows the letter, digit and punctuation codes and nothing else', () => {
    for (const c of ['KeyA', 'KeyZ', 'Digit0', 'Digit9', 'Slash', 'Period', 'Comma', 'Semicolon', 'Quote', 'BracketLeft', 'BracketRight', 'Backslash', 'Minus', 'Equal', 'Backquote']) expect(HOST_KEY_CODE_RE.test(c), c).toBe(true);
    for (const c of ['F1', 'Escape', 'Space', 'Enter', 'Numpad1', 'AltLeft', 'Key', 'Digit', 'IntlBackslash', 'slash', '']) expect(HOST_KEY_CODE_RE.test(c), c).toBe(false);
  });
});

describe("KiCad's own Alt chords", () => {
  it('are exactly the default Alt hotkeys of KiCad 10 the claim grammar can name', () => {
    const named = KICAD_ALT_CHORDS.map((c) => `${c.shift ? 'Shift+' : ''}${c.code}`).sort();
    expect(named).toEqual(['Backquote', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'KeyS', 'KeyW', 'KeyZ', 'Shift+Comma', 'Shift+KeyV'].sort());
    for (const c of KICAD_ALT_CHORDS) expect(HOST_KEY_CODE_RE.test(c.code)).toBe(true);
  });

  it('claimChords keeps the rest, refuses those in the order asked, each chord once', () => {
    const { claimed, refused } = claimChords([
      { code: 'KeyM', shift: false }, { code: 'KeyS', shift: false }, { code: 'KeyS', shift: true }, { code: 'Comma', shift: true },
      { code: 'Comma', shift: false }, { code: 'KeyM', shift: false }, { code: 'Digit1', shift: false }, { code: 'KeyS', shift: false },
    ]);
    expect(claimed).toEqual([{ code: 'KeyM', shift: false }, { code: 'KeyS', shift: true }, { code: 'Comma', shift: false }]);
    expect(refused).toEqual([{ code: 'KeyS', shift: false }, { code: 'Comma', shift: true }, { code: 'Digit1', shift: false }]);
  });
});

describe('installHostKeys', () => {
  it('with nothing claimed, every key reaches the engine and nothing is sent', () => {
    const f = frame();
    const e = f.fire('keydown', { code: 'KeyM' });
    f.fire('keyup', { code: 'KeyM' });
    expect(e.defaultPrevented).toBe(false);
    expect(f.sent).toEqual([]);
    expect(f.engine).toEqual(['cap:keydown:KeyM', 'bub:keydown:KeyM', 'cap:keyup:KeyM', 'bub:keyup:KeyM']);
  });

  it('a claimed Alt chord is sent once and canceled before the engine\'s listeners, its keypress and keyup too', () => {
    const f = frame();
    f.keys.claim([{ code: 'KeyM', shift: false }]);
    const down = f.fire('keydown', { code: 'KeyM', key: 'µ' });
    const press = f.fire('keypress', { code: 'KeyM' });
    const up = f.fire('keyup', { code: 'KeyM', altKey: false });   // Alt let go first: the keyup is still the chord's
    expect(f.sent).toEqual([{ code: 'KeyM', shift: false }]);
    expect([down.defaultPrevented, press.defaultPrevented, up.defaultPrevented]).toEqual([true, true, true]);
    expect(f.engine).toEqual([]);
  });

  it('swallows the auto-repeats of a held chord, sending nothing more', () => {
    const f = frame();
    f.keys.claim([{ code: 'Slash', shift: true }]);
    f.fire('keydown', { code: 'Slash', shiftKey: true });
    f.fire('keydown', { code: 'Slash', shiftKey: true, repeat: true });
    f.fire('keydown', { code: 'Slash', shiftKey: true, repeat: true });
    f.fire('keyup', { code: 'Slash', shiftKey: true });
    expect(f.sent).toEqual([{ code: 'Slash', shift: true }]);
    expect(f.engine).toEqual([]);
  });

  it('a repeat that arrives first (the press began outside the frame) is swallowed and not sent', () => {
    const f = frame();
    f.keys.claim([{ code: 'KeyM', shift: false }]);
    f.fire('keydown', { code: 'KeyM', repeat: true });
    f.fire('keyup', { code: 'KeyM' });
    expect(f.sent).toEqual([]);
    expect(f.engine).toEqual([]);
  });

  it('leaves to KiCad: a plain key, Ctrl or Meta held, the other Shift state, an unclaimed Alt chord', () => {
    const f = frame();
    f.keys.claim([{ code: 'KeyM', shift: false }]);
    for (const o of [
      { code: 'KeyM', altKey: false }, { code: 'KeyM', ctrlKey: true }, { code: 'KeyM', metaKey: true },
      { code: 'KeyM', shiftKey: true }, { code: 'KeyN' },
    ] as Init[]) {
      const e = f.fire('keydown', o);
      f.fire('keyup', o);
      expect(e.defaultPrevented, JSON.stringify(o)).toBe(false);
    }
    expect(f.sent).toEqual([]);
    expect(f.engine.filter((l) => l.startsWith('cap:keydown'))).toEqual(['cap:keydown:KeyM', 'cap:keydown:KeyM', 'cap:keydown:KeyM', 'cap:keydown:KeyM+s', 'cap:keydown:KeyN']);
  });

  it("the island's own key.press of a claimed chord still reaches the engine, and is never sent", () => {
    const f = frame();
    f.keys.claim([{ code: 'KeyM', shift: false }]);
    pressKey(f.win, { key: 'm', code: 'KeyM', ctrl: false, shift: false, alt: true });
    expect(f.sent).toEqual([]);
    expect(f.engine).toEqual(['cap:keydown:KeyM', 'bub:keydown:KeyM', 'cap:keyup:KeyM', 'bub:keyup:KeyM']);
  });

  it('a new claim replaces the old one whole; an empty claim claims nothing', () => {
    const f = frame();
    f.keys.claim([{ code: 'KeyM', shift: false }]);
    f.keys.claim([{ code: 'KeyN', shift: false }]);
    f.fire('keydown', { code: 'KeyM' });
    f.fire('keyup', { code: 'KeyM' });
    f.fire('keydown', { code: 'KeyN' });
    f.fire('keyup', { code: 'KeyN' });
    f.keys.claim([]);
    f.fire('keydown', { code: 'KeyN' });
    f.fire('keyup', { code: 'KeyN' });
    expect(f.sent).toEqual([{ code: 'KeyN', shift: false }]);
    expect(f.engine.filter((l) => l.startsWith('cap:'))).toEqual(['cap:keydown:KeyM', 'cap:keyup:KeyM', 'cap:keydown:KeyN', 'cap:keyup:KeyN']);
  });

  it('a chord held while the claim changes keeps its keyup from the engine', () => {
    const f = frame();
    f.keys.claim([{ code: 'KeyM', shift: false }]);
    f.fire('keydown', { code: 'KeyM' });
    f.keys.claim([]);
    f.fire('keyup', { code: 'KeyM' });
    expect(f.engine).toEqual([]);
  });

  it('never claims a chord of KiCad\'s even when handed one, and stop() gives every key back', () => {
    const f = frame();
    f.keys.claim([{ code: 'KeyS', shift: false }, { code: 'KeyM', shift: false }]);
    f.fire('keydown', { code: 'KeyS' });
    f.keys.stop();
    f.fire('keydown', { code: 'KeyM' });
    expect(f.sent).toEqual([]);
    expect(f.engine).toEqual(['cap:keydown:KeyS', 'bub:keydown:KeyS', 'cap:keydown:KeyM', 'bub:keydown:KeyM']);
  });

  it('a throwing onKey still keeps the chord from the engine', () => {
    const win = new EventTarget() as unknown as Window;
    const keys = installHostKeys(win, { onKey: () => { throw new Error('x'); } });
    const engine: string[] = [];
    win.addEventListener('keydown', (e) => engine.push((e as KeyboardEvent).code), true);
    keys.claim([{ code: 'KeyM', shift: false }]);
    const e = key('keydown', { code: 'KeyM' });
    expect(() => win.dispatchEvent(e)).not.toThrow();
    expect(e.defaultPrevented).toBe(true);
    expect(engine).toEqual([]);
  });

  it('listens in the capture phase on the window, for keydown, keypress and keyup', () => {
    const calls: Array<[string, unknown]> = [];
    const win = { addEventListener: (t: string, _h: unknown, o: unknown) => calls.push([t, o]), removeEventListener: () => {} };
    installHostKeys(win, { onKey: () => {} });
    expect(calls.map(([t]) => t).sort()).toEqual(['keydown', 'keypress', 'keyup']);
    for (const [, o] of calls) expect(o === true || (typeof o === 'object' && o !== null && (o as { capture?: boolean }).capture === true)).toBe(true);
  });
});
