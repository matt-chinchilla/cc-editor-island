// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// KiCad's hotkeys from our own JS. The engine's Emscripten key path reads
// `key` and `code` from any keydown that reaches the window and never checks
// isTrusted (spike 2026-10-01), so a page-side tool can fire a KiCad hotkey
// through the bridge. Keys are delivered to the wx window that holds keyboard
// focus; after boot that is a panel (sch) or the appearance search box (pcb),
// so focusCanvas() clicks the root canvas once, as a real click would.

export interface KeyPress { key: string; code: string; ctrl: boolean; shift: boolean; alt: boolean }

/**
 * The codes a key.press may carry, a closed list: each is a DOM code the
 * engine's wx layer (wxWidgets src/wasm/keyboard.cpp, kKeyTranslationEntries)
 * turns into the key code one of KiCad's hotkey names stands for
 * (common/hotkeys_basic.cpp, hotkeyNameList, and any single character). The
 * engine reads only `code` from a keydown (`key` only from a keypress, which
 * the island never sends), so a code outside its table reaches KiCad as no
 * key at all. Left out on purpose: Slash (absent from the engine's table, so
 * KiCad's "/" and "?" cannot be pressed from here), NumpadDecimal (the engine
 * makes it WXK_NUMPAD_DECIMAL, KiCad's "Num Pad ." is WXK_NUMPAD_SEPARATOR),
 * NumpadEqual and NumpadComma (KiCad names neither), and the modifier keys.
 */
export const KEY_CODE_RE = /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4])|Escape|Home|End|Insert|Delete|Backspace|Enter|Space|Tab|PageUp|PageDown|Arrow(Up|Down|Left|Right)|Comma|Period|Semicolon|Quote|BracketLeft|BracketRight|Backquote|Backslash|Minus|Equal|Numpad[0-9]|Numpad(Add|Subtract|Multiply|Divide|Enter))$/;
/** The key a key.press names: one character, or the browser's name of a key that types none. */
const KEY_RE = /^(.|F([1-9]|1[0-9]|2[0-4])|Escape|Home|End|Insert|Delete|Backspace|Enter|Tab|PageUp|PageDown|Arrow(Up|Down|Left|Right))$/;
const FIELDS = ['key', 'code', 'ctrl', 'shift', 'alt'];

export function parseKeyPress(args: unknown): KeyPress | null {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null;
  const a = args as Record<string, unknown>;
  if (!Object.keys(a).every((k) => FIELDS.includes(k))) return null;
  if (typeof a.key !== 'string' || !KEY_RE.test(a.key) || typeof a.code !== 'string' || !KEY_CODE_RE.test(a.code)) return null;
  const flag = (v: unknown): boolean | null => (v === undefined ? false : typeof v === 'boolean' ? v : null);
  const ctrl = flag(a.ctrl), shift = flag(a.shift), alt = flag(a.alt);
  if (ctrl == null || shift == null || alt == null) return null;
  return { key: a.key, code: a.code, ctrl, shift, alt };
}

/** KiCad's names of keys that type no character, as the browser names them (key, code). */
const KICAD_NAMED: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  Esc: ['Escape', 'Escape'], Del: ['Delete', 'Delete'], Tab: ['Tab', 'Tab'], Back: ['Backspace', 'Backspace'],
  Ins: ['Insert', 'Insert'], Home: ['Home', 'Home'], End: ['End', 'End'], PgUp: ['PageUp', 'PageUp'], PgDn: ['PageDown', 'PageDown'],
  Up: ['ArrowUp', 'ArrowUp'], Down: ['ArrowDown', 'ArrowDown'], Left: ['ArrowLeft', 'ArrowLeft'], Right: ['ArrowRight', 'ArrowRight'],
  Return: ['Enter', 'Enter'], Space: [' ', 'Space'],
  'Num Pad +': ['+', 'NumpadAdd'], 'Num Pad -': ['-', 'NumpadSubtract'], 'Num Pad *': ['*', 'NumpadMultiply'],
  'Num Pad /': ['/', 'NumpadDivide'], 'Num Pad Enter': ['Enter', 'NumpadEnter'],
});

/** The punctuation keys of a US layout: the character each types, unshifted and with Shift. */
const PUNCTUATION: readonly (readonly [string, string, string])[] = [
  ['Comma', ',', '<'], ['Period', '.', '>'], ['Semicolon', ';', ':'], ['Quote', "'", '"'], ['BracketLeft', '[', '{'],
  ['BracketRight', ']', '}'], ['Backquote', '`', '~'], ['Backslash', '\\', '|'], ['Minus', '-', '_'], ['Equal', '=', '+'],
];
const SHIFTED_DIGITS = ')!@#$%^&*(';

/**
 * One of KiCad's hotkey names ("Ctrl+Alt+Shift+K", "Shift+R", "Ctrl+,", "{",
 * "PgUp", "Num Pad 7", as a .hotkeys file writes them) as the key.press that
 * presses it on a US layout, or null when key.press cannot carry it: the
 * Meta, Win, Super, AltGr, Cmd and Option modifiers, "/" and "?", "Num Pad .",
 * "Num Pad F1" to "Num Pad F4", and any name KiCad does not know. A character
 * a US layout types with Shift ("{", "<", "~", "+") carries Shift. A letter
 * is the lowercase key unless Shift is held, as a keyboard sends it.
 */
export function keyPressOfHotkey(name: string): KeyPress | null {
  let rest = name;
  let ctrl = false, shift = false, alt = false;
  for (;;) {
    if (rest.startsWith('Ctrl+') && rest.length > 5) { ctrl = true; rest = rest.slice(5); }
    else if (rest.startsWith('Alt+') && rest.length > 4) { alt = true; rest = rest.slice(4); }
    else if (rest.startsWith('Shift+') && rest.length > 6) { shift = true; rest = rest.slice(6); }
    else break;
  }
  const make = (key: string, code: string, shifted = false): KeyPress | null =>
    parseKeyPress({ key, code, ctrl, shift: shift || shifted, alt });
  const named = Object.hasOwn(KICAD_NAMED, rest) ? KICAD_NAMED[rest] : undefined;
  if (named != null) return make(named[0], named[1]);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(rest)) return make(rest, rest);
  const pad = /^Num Pad ([0-9])$/.exec(rest);
  if (pad != null) return make(pad[1], `Numpad${pad[1]}`);
  if (rest.length !== 1) return null;
  if (/^[A-Za-z]$/.test(rest)) { const up = rest.toUpperCase(); return make(shift ? up : up.toLowerCase(), `Key${up}`); }
  if (/^[0-9]$/.test(rest)) return make(rest, `Digit${rest}`);
  const digit = SHIFTED_DIGITS.indexOf(rest);
  if (digit >= 0) return make(rest, `Digit${digit}`, true);
  for (const [code, plain, shifted] of PUNCTUATION) {
    if (rest === plain) return make(plain, code);
    if (rest === shifted) return make(shifted, code, true);
  }
  if (rest === ' ') return make(' ', 'Space');
  return null;
}

/**
 * The key events the island itself dispatches (pressKey): the host keys'
 * filter (host-keys.ts) never takes one, so a key.press of a claimed chord
 * still reaches KiCad.
 */
const islandKeys = new WeakSet<Event>();

/** Whether this key event is one the island dispatched itself. */
export function isIslandKey(e: Event): boolean {
  return islandKeys.has(e);
}

export function pressKey(win: Window, k: KeyPress): void {
  const init: KeyboardEventInit = { key: k.key, code: k.code, ctrlKey: k.ctrl, shiftKey: k.shift, altKey: k.alt, bubbles: true, cancelable: true };
  for (const type of ['keydown', 'keyup']) {
    const e = new KeyboardEvent(type, init);
    islandKeys.add(e);
    win.dispatchEvent(e);
  }
}

/** A synthetic click near the canvas's right edge (clear of any item): wx moves keyboard focus to the canvas. */
export function focusCanvas(doc: Document): boolean {
  const canvas = doc.getElementById('canvas');
  if (canvas == null) return false;
  const r = canvas.getBoundingClientRect();
  const init: MouseEventInit = { clientX: r.left + r.width - 8, clientY: r.top + r.height - 8, button: 0, buttons: 1, bubbles: true, cancelable: true };
  for (const type of ['pointerdown', 'mousedown']) canvas.dispatchEvent(type === 'pointerdown' ? new PointerEvent(type, { ...init, pointerId: 1, isPrimary: true }) : new MouseEvent(type, init));
  const up: MouseEventInit = { ...init, buttons: 0 };
  for (const type of ['pointerup', 'mouseup', 'click']) canvas.dispatchEvent(type === 'pointerup' ? new PointerEvent(type, { ...up, pointerId: 1, isPrimary: true }) : new MouseEvent(type, up));
  return true;
}

/**
 * A synthetic middle-button press near the canvas's corner: wx moves keyboard
 * focus to the canvas as a click does, but a middle press selects nothing and,
 * with no drag, pans nothing. For after an op whose engine run moved wx's
 * focus away (engine run 12: opening the hidden schematic editor for a board
 * check's comparison or a board update leaves every later key unread), where
 * focusCanvas's left click would clear the selection the op left.
 */
export function focusCanvasQuietly(doc: Document): boolean {
  const canvas = doc.getElementById('canvas');
  if (canvas == null) return false;
  const r = canvas.getBoundingClientRect();
  const init: MouseEventInit = { clientX: r.left + r.width - 8, clientY: r.top + r.height - 8, button: 1, buttons: 4, bubbles: true, cancelable: true };
  canvas.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerId: 1, isPrimary: true }));
  canvas.dispatchEvent(new MouseEvent('mousedown', init));
  const up: MouseEventInit = { ...init, buttons: 0 };
  canvas.dispatchEvent(new PointerEvent('pointerup', { ...up, pointerId: 1, isPrimary: true }));
  canvas.dispatchEvent(new MouseEvent('mouseup', up));
  return true;
}

/**
 * A real press anywhere in the frame gives the frame the browser's keyboard
 * focus. The engine cancels mousedown, so the browser never moves focus into
 * the frame by itself: after a press on one of the host page's controls, a
 * press in the drawing left focus on that control, and KiCad's hotkeys went
 * to the page (review M5, 2026-10-01). Taking focus also blurs the host's
 * window, which closes the host's popovers through the blur they already
 * listen for (review P2). Synthetic presses (the boot's focusCanvas) never
 * take focus: the frame must not steal it from the page on its own. Both
 * pointerdown and pointerup count, as a touch press activates the frame only
 * on its pointerup. Answers the function that removes the listeners.
 */
export function focusFrameOnPress(win: Pick<Window, 'addEventListener' | 'removeEventListener' | 'focus'> & { document: Pick<Document, 'hasFocus'> }): () => void {
  const onPress = (e: Event): void => {
    if (!e.isTrusted || win.document.hasFocus()) return;
    win.focus();
  };
  for (const type of ['pointerdown', 'pointerup']) win.addEventListener(type, onPress, true);
  return () => { for (const type of ['pointerdown', 'pointerup']) win.removeEventListener(type, onPress, true); };
}
