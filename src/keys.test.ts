// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The suite runs in node (no DOM package in this repository), so the window,
// the document, the canvas and the three event classes are small stand-ins
// built on node's own Event and EventTarget.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { focusCanvas, focusCanvasQuietly, focusFrameOnPress, KEY_CODE_RE, keyPressOfHotkey, parseKeyPress, pressKey } from './keys';

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
  it('knows the codes the engine turns into a key KiCad can name, and nothing else', () => {
    const known = ['KeyA', 'KeyZ', 'Digit0', 'Digit9', 'F1', 'F12', 'F13', 'F19', 'F24', 'Escape', 'Home', 'End', 'Insert', 'Delete', 'Backspace', 'Enter', 'Space', 'Tab',
      'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Comma', 'Period', 'Semicolon', 'Quote', 'BracketLeft', 'BracketRight',
      'Backquote', 'Backslash', 'Minus', 'Equal', 'Numpad0', 'Numpad9', 'NumpadAdd', 'NumpadSubtract', 'NumpadMultiply', 'NumpadDivide', 'NumpadEnter'];
    for (const c of known) expect(KEY_CODE_RE.test(c), c).toBe(true);
    // Slash is absent from the engine's table; NumpadDecimal is a key KiCad's "Num Pad ." is not; the rest name no key KiCad binds.
    for (const c of ['Slash', 'NumpadDecimal', 'NumpadEqual', 'NumpadComma', 'IntlBackslash', 'F25', 'F0', 'MetaLeft', 'ShiftLeft', 'ContextMenu', 'key', 'Key', 'Arrow', 'Numpad', '']) expect(KEY_CODE_RE.test(c), c).toBe(false);
  });
  it('accepts the new keys by their browser names and still refuses a key outside the list', () => {
    expect(parseKeyPress({ key: ',', code: 'Comma', ctrl: true })).toEqual({ key: ',', code: 'Comma', ctrl: true, shift: false, alt: false });
    expect(parseKeyPress({ key: 'ArrowUp', code: 'ArrowUp' })).toEqual({ key: 'ArrowUp', code: 'ArrowUp', ctrl: false, shift: false, alt: false });
    expect(parseKeyPress({ key: 'Tab', code: 'Tab', shift: true })).toEqual({ key: 'Tab', code: 'Tab', ctrl: false, shift: true, alt: false });
    for (const key of ['End', 'Insert', 'PageUp', 'PageDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'F24']) expect(parseKeyPress({ key, code: key }), key).not.toBeNull();
    expect(parseKeyPress({ key: '7', code: 'Numpad7' })).not.toBeNull();
    expect(parseKeyPress({ key: 'Enter', code: 'NumpadEnter' })).not.toBeNull();
    expect(parseKeyPress({ key: '/', code: 'Slash' })).toBeNull();
    expect(parseKeyPress({ key: '.', code: 'NumpadDecimal' })).toBeNull();
    expect(parseKeyPress({ key: 'F25', code: 'F25' })).toBeNull();
    expect(parseKeyPress({ key: 'Up', code: 'ArrowUp' })).toBeNull();
    expect(parseKeyPress({ key: 'PgUp', code: 'PageUp' })).toBeNull();
  });
});

describe('keyPressOfHotkey', () => {
  const k = (key: string, code: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) =>
    ({ key, code, ctrl: mods.ctrl ?? false, shift: mods.shift ?? false, alt: mods.alt ?? false });

  it('turns each of KiCad\'s key names into the code the engine reads for it', () => {
    const cases: Array<[string, ReturnType<typeof k>]> = [
      ['H', k('h', 'KeyH')], ['Shift+R', k('R', 'KeyR', { shift: true })], ['Ctrl+Alt+Shift+K', k('K', 'KeyK', { ctrl: true, shift: true, alt: true })],
      ['Ctrl+Alt+7', k('7', 'Digit7', { ctrl: true, alt: true })], ['Ctrl+Alt+F1', k('F1', 'F1', { ctrl: true, alt: true })], ['F24', k('F24', 'F24')],
      ['Ctrl+Shift+Home', k('Home', 'Home', { ctrl: true, shift: true })], ['End', k('End', 'End')], ['Ins', k('Insert', 'Insert')],
      ['Esc', k('Escape', 'Escape')], ['Del', k('Delete', 'Delete')], ['Shift+Del', k('Delete', 'Delete', { shift: true })],
      ['Back', k('Backspace', 'Backspace')], ['Alt+Back', k('Backspace', 'Backspace', { alt: true })], ['Return', k('Enter', 'Enter')],
      ['Tab', k('Tab', 'Tab')], ['Shift+Tab', k('Tab', 'Tab', { shift: true })], ['Space', k(' ', 'Space')], ['Shift+Space', k(' ', 'Space', { shift: true })],
      ['PgUp', k('PageUp', 'PageUp')], ['PgDn', k('PageDown', 'PageDown')],
      ['Up', k('ArrowUp', 'ArrowUp')], ['Down', k('ArrowDown', 'ArrowDown')], ['Ctrl+Left', k('ArrowLeft', 'ArrowLeft', { ctrl: true })], ['Alt+Right', k('ArrowRight', 'ArrowRight', { alt: true })],
      ['Num Pad 0', k('0', 'Numpad0')], ['Num Pad 9', k('9', 'Numpad9')], ['Num Pad +', k('+', 'NumpadAdd')], ['Num Pad -', k('-', 'NumpadSubtract')],
      ['Num Pad *', k('*', 'NumpadMultiply')], ['Num Pad /', k('/', 'NumpadDivide')], ['Num Pad Enter', k('Enter', 'NumpadEnter')],
      // The punctuation of KiCad's default chords, and the characters a US layout types with Shift.
      ['Ctrl+,', k(',', 'Comma', { ctrl: true })], ['Ctrl+Shift+.', k('.', 'Period', { ctrl: true, shift: true })], ['`', k('`', 'Backquote')],
      ['Alt+`', k('`', 'Backquote', { alt: true })], ['\\', k('\\', 'Backslash')], ["'", k("'", 'Quote')], ['-', k('-', 'Minus')], ['Ctrl+-', k('-', 'Minus', { ctrl: true })],
      ['=', k('=', 'Equal')], [';', k(';', 'Semicolon')], ['[', k('[', 'BracketLeft')], [']', k(']', 'BracketRight')],
      ['{', k('{', 'BracketLeft', { shift: true })], ['}', k('}', 'BracketRight', { shift: true })], ['<', k('<', 'Comma', { shift: true })],
      ['Alt+<', k('<', 'Comma', { shift: true, alt: true })], ['Ctrl+<', k('<', 'Comma', { ctrl: true, shift: true })], ['~', k('~', 'Backquote', { shift: true })],
      ['+', k('+', 'Equal', { shift: true })], ['Ctrl++', k('+', 'Equal', { ctrl: true, shift: true })], ['|', k('|', 'Backslash', { shift: true })],
      ['_', k('_', 'Minus', { shift: true })], [':', k(':', 'Semicolon', { shift: true })], ['"', k('"', 'Quote', { shift: true })], ['>', k('>', 'Period', { shift: true })],
      ['!', k('!', 'Digit1', { shift: true })], ['(', k('(', 'Digit9', { shift: true })], [')', k(')', 'Digit0', { shift: true })],
    ];
    for (const [name, want] of cases) expect(keyPressOfHotkey(name), name).toEqual(want);
  });

  it('answers null for a name key.press cannot carry', () => {
    for (const name of ['/', '?', 'Ctrl+/', 'Num Pad .', 'Num Pad F1', 'Num Pad F4', 'Meta+A', 'Win+A', 'Super+A', 'AltGr+A', 'Cmd+A', 'Option+A',
      'F25', 'Click', 'DblClick', 'Wheel', 'Ctrl+', 'Shift+', '', 'Ctrl+Foo', 'constructor', 'toString', 'é', 'Ctrl+Alt+\u00e9']) expect(keyPressOfHotkey(name), name).toBeNull();
  });

  it('carries every chord of the seeded hotkey files, both columns', () => {
    const files = import.meta.glob(['../theme/user.hotkeys', '../theme/symedit.hotkeys', '../theme/hotkeys/*.hotkeys'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['../theme/user.hotkeys', '../theme/symedit.hotkeys']));
    const chords: string[] = [];
    for (const text of Object.values(files)) {
      for (const line of text.split('\n')) {
        const [action, ...keys] = line.split('\t');
        if (action === undefined || action.trim() === '') continue;
        for (const chord of keys) if (chord !== '') chords.push(chord);
      }
    }
    expect(chords.length).toBeGreaterThan(100);
    const refused = chords.filter((c) => keyPressOfHotkey(c) == null);
    expect(refused).toEqual([]);
    for (const c of chords) expect(parseKeyPress(keyPressOfHotkey(c)), c).toEqual(keyPressOfHotkey(c));
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

describe('focusCanvasQuietly', () => {
  it('presses the root canvas with the middle button only: the keyboard focus comes back, and no left click changes the selection', () => {
    const canvas = Object.assign(new EventTarget(), {
      id: 'canvas',
      getBoundingClientRect: () => ({ left: 10, top: 20, width: 1000, height: 600, right: 1010, bottom: 620 }),
    });
    const doc = { getElementById: (id: string) => (id === canvas.id ? canvas : null) } as unknown as Document;
    const seen: Array<[string, number, number]> = [];
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'auxclick']) canvas.addEventListener(t, (e) => { seen.push([e.type, (e as MouseEvent).button, (e as MouseEvent).buttons]); });
    expect(focusCanvasQuietly(doc)).toBe(true);
    expect(seen).toEqual([['pointerdown', 1, 4], ['mousedown', 1, 4], ['pointerup', 1, 0], ['mouseup', 1, 0]]);
    expect(focusCanvasQuietly({ getElementById: () => null } as unknown as Document)).toBe(false);
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
