// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The suite runs in node (no DOM package in this repository), so the window,
// the document, the canvas and the three event classes are small stand-ins
// built on node's own Event and EventTarget.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { focusCanvas, focusFrameOnPress, KEY_CODE_RE, parseKeyPress, pressKey } from './keys';

/** An Event subclass that keeps every init field (key, code, clientX, ...) on the instance. */
const eventClass = () => class extends Event {
  constructor(type: string, init: Record<string, unknown> = {}) {
    const { bubbles, cancelable, composed, ...rest } = init as EventInit & Record<string, unknown>;
    super(type, { bubbles, cancelable, composed });
    Object.assign(this, rest);
  }
};
beforeAll(() => {
  vi.stubGlobal('KeyboardEvent', eventClass());
  vi.stubGlobal('MouseEvent', eventClass());
  vi.stubGlobal('PointerEvent', eventClass());
});
afterAll(() => { vi.unstubAllGlobals(); });

describe('parseKeyPress', () => {
  it('accepts a key with its code and the three modifiers', () => {
    expect(parseKeyPress({ key: 'w', code: 'KeyW' })).toEqual({ key: 'w', code: 'KeyW', ctrl: false, shift: false, alt: false });
    expect(parseKeyPress({ key: 'X', code: 'KeyX', ctrl: true, shift: true })).toEqual({ key: 'X', code: 'KeyX', ctrl: true, shift: true, alt: false });
    expect(parseKeyPress({ key: 'Home', code: 'Home' })).toEqual({ key: 'Home', code: 'Home', ctrl: false, shift: false, alt: false });
  });
  it('refuses an unknown key, an unknown code, a long key, an extra field and a non-boolean modifier', () => {
    expect(parseKeyPress({ key: 'w', code: 'Mouse1' })).toBeNull();
    expect(parseKeyPress({ key: 'ww', code: 'KeyW' })).toBeNull();
    expect(parseKeyPress({ key: 'w', code: 'KeyW', meta: true })).toBeNull();
    expect(parseKeyPress({ key: 'w', code: 'KeyW', ctrl: 1 })).toBeNull();
    expect(parseKeyPress({ key: 'w' })).toBeNull();
    expect(parseKeyPress('w')).toBeNull();
  });
  it('knows the codes KiCad\'s default hotkeys use and nothing else', () => {
    for (const c of ['KeyA', 'KeyZ', 'Digit0', 'Digit9', 'F1', 'F12', 'Escape', 'Home', 'Delete', 'Backspace', 'Enter', 'Space']) expect(KEY_CODE_RE.test(c)).toBe(true);
    for (const c of ['F13', 'Tab', 'MetaLeft', 'key', 'ArrowUp', 'Key', '']) expect(KEY_CODE_RE.test(c)).toBe(false);
  });
});

describe('pressKey', () => {
  it('dispatches keydown then keyup on the window with key, code and modifiers', () => {
    const seen: string[] = [];
    const win = new EventTarget() as unknown as Window;
    const on = (e: Event) => { const k = e as KeyboardEvent; seen.push(`${e.type}:${k.key}:${k.code}:${k.ctrlKey ? 'c' : ''}${k.shiftKey ? 's' : ''}${k.altKey ? 'a' : ''}:${k.bubbles}`); };
    win.addEventListener('keydown', on);
    win.addEventListener('keyup', on);
    pressKey(win, { key: 'X', code: 'KeyX', ctrl: true, shift: true, alt: false });
    expect(seen).toEqual(['keydown:X:KeyX:cs:true', 'keyup:X:KeyX:cs:true']);
  });
});

describe('focusCanvas', () => {
  it('clicks the root canvas with the five pointer and mouse events, at a point inside it', () => {
    const canvas = Object.assign(new EventTarget(), {
      id: 'canvas',
      getBoundingClientRect: () => ({ left: 10, top: 20, width: 1000, height: 600, right: 1010, bottom: 620 }),
    });
    let attached = true;
    const doc = { getElementById: (id: string) => (attached && id === canvas.id ? canvas : null) } as unknown as Document;
    const types: string[] = [];
    const xs = new Set<number>();
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) canvas.addEventListener(t, (e) => { types.push(e.type); xs.add((e as MouseEvent).clientX); });
    expect(focusCanvas(doc)).toBe(true);
    expect(types).toEqual(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
    expect([...xs]).toEqual([10 + 1000 - 8]);   // 8 px inside the right edge
    attached = false;
    expect(focusCanvas(doc)).toBe(false);
  });
});

describe('focusFrameOnPress', () => {
  /** A frame window whose listeners the test calls with its own event objects (node cannot make a trusted event). */
  function frameWindow(focused: boolean) {
    const listeners = new Map<string, (e: Event) => void>();
    const win = {
      focused,
      focus: vi.fn(() => { win.focused = true; }),
      document: { hasFocus: () => win.focused },
      addEventListener: vi.fn((t: string, h: (e: Event) => void, capture?: boolean) => { expect(capture).toBe(true); listeners.set(t, h); }),
      removeEventListener: vi.fn((t: string) => { listeners.delete(t); }),
    };
    const press = (type: string, isTrusted: boolean) => listeners.get(type)?.({ type, isTrusted } as Event);
    return { win, press, listeners };
  }

  it('focuses the frame on a real press when the page holds focus, once', () => {
    const { win, press } = frameWindow(false);
    focusFrameOnPress(win);
    press('pointerdown', true);
    expect(win.focus).toHaveBeenCalledTimes(1);
    press('pointerup', true);
    press('pointerdown', true);
    expect(win.focus).toHaveBeenCalledTimes(1);   // the frame already has it
  });

  it('a touch press focuses on its pointerup', () => {
    const { win, press } = frameWindow(false);
    focusFrameOnPress(win);
    press('pointerup', true);
    expect(win.focus).toHaveBeenCalledTimes(1);
  });

  it('never takes focus for a synthetic press, and stops when removed', () => {
    const { win, press, listeners } = frameWindow(false);
    const stop = focusFrameOnPress(win);
    press('pointerdown', false);
    press('pointerup', false);
    expect(win.focus).not.toHaveBeenCalled();
    stop();
    expect(listeners.size).toBe(0);
  });
});
