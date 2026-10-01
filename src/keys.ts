// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// KiCad's hotkeys from our own JS. The engine's Emscripten key path reads
// `key` and `code` from any keydown that reaches the window and never checks
// isTrusted (spike 2026-10-01), so a page-side tool can fire a KiCad hotkey
// through the bridge. Keys are delivered to the wx window that holds keyboard
// focus; after boot that is a panel (sch) or the appearance search box (pcb),
// so focusCanvas() clicks the root canvas once, as a real click would.

export interface KeyPress { key: string; code: string; ctrl: boolean; shift: boolean; alt: boolean }

/** The codes KiCad's default hotkeys use. Nothing else is accepted. */
export const KEY_CODE_RE = /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-2])|Escape|Home|Delete|Backspace|Enter|Space)$/;
const KEY_RE = /^(.|F([1-9]|1[0-2])|Escape|Home|Delete|Backspace|Enter)$/;
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

export function pressKey(win: Window, k: KeyPress): void {
  const init: KeyboardEventInit = { key: k.key, code: k.code, ctrlKey: k.ctrl, shiftKey: k.shift, altKey: k.alt, bubbles: true, cancelable: true };
  win.dispatchEvent(new KeyboardEvent('keydown', init));
  win.dispatchEvent(new KeyboardEvent('keyup', init));
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
