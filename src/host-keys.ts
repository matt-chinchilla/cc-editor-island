// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The host's keys (PROTOCOL.md keys.claim and ev.key): Alt is the workspace's
// key everywhere, plain letters on the drawing are KiCad's (owner, 2026-11-10).
//
// While the reader's keyboard focus is inside this frame the host page sees no
// key at all, so the host claims a set of Alt chords and the frame hands those
// presses to it: a keydown with Alt held (Ctrl and Meta not) whose code and
// Shift state match a claimed chord is canceled and stopped in the capture
// phase on the window, before any of the engine's own listeners can read it,
// and reported once; its keypress, its keyup and its auto-repeats are canceled
// and stopped too, so KiCad never sees half a chord, and the browser never
// acts on it (Alt+F opens Chrome's menu otherwise). Everything else reaches
// KiCad exactly as before, and with no claim nothing is touched.
//
// Order: the engine registers its key listeners at boot through Emscripten's
// JSEvents.registerOrRemoveHandler (target.addEventListener(type, handler,
// useCapture), on the window or the document), and wx-dom.js adds capture
// listeners on the document. A capture listener on the window runs before all
// of them (the window is the first stop of the capture path), and among the
// window's own capture listeners the earlier registration runs first; the
// responder installs this one before the engine's scripts load (main.ts calls
// startResponder before bootKicadTool).
import { isIslandKey } from './keys';

/** One claimed chord: Alt held with this key, with or without Shift; Ctrl and Meta never. */
export interface Chord { code: string; shift: boolean }

/** The codes a chord may name: letters, digits and the punctuation keys of a US layout. */
export const HOST_KEY_CODE_RE = /^(Key[A-Z]|Digit[0-9]|Slash|Period|Comma|Semicolon|Quote|BracketLeft|BracketRight|Backslash|Minus|Equal|Backquote)$/;
/** The most chords one claim carries. */
export const MAX_CHORDS = 64;

/**
 * The Alt chords KiCad 10 binds by default, which the frame never takes from
 * it: every `DefaultHotkey( MD_ALT + ... )` of the editors the engine runs
 * whose key the claim grammar can name (the arrow and Backspace chords cannot
 * be named), at the tree engine run 11 was built from (kicad cc/main ffe73d65):
 * common/tool/actions.cpp Alt+1, Alt+2, Alt+3, Alt+4; eeschema/tools/sch_actions.cpp
 * Alt+3, Alt+S; pcbnew/tools/pcb_actions.cpp Alt+Z, Alt+S, Alt+`;
 * pcbnew/router/router_tool.cpp Alt+Shift+V, Alt+< (Shift and the Comma key on
 * a US layout), Alt+W.
 */
export const KICAD_ALT_CHORDS: readonly Chord[] = Object.freeze([
  { code: 'KeyS', shift: false },
  { code: 'KeyW', shift: false },
  { code: 'KeyZ', shift: false },
  { code: 'Digit1', shift: false },
  { code: 'Digit2', shift: false },
  { code: 'Digit3', shift: false },
  { code: 'Digit4', shift: false },
  { code: 'Backquote', shift: false },
  { code: 'Comma', shift: true },
  { code: 'KeyV', shift: true },
].map((c) => Object.freeze(c)));

const chordId = (code: string, shift: boolean): string => `${shift ? 'S+' : ''}${code}`;
const KICAD_IDS: ReadonlySet<string> = new Set(KICAD_ALT_CHORDS.map((c) => chordId(c.code, c.shift)));
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** keys.claim's args, read closed: `{ chords: [{ code, shift? }] }`; null refuses the whole claim. */
export function parseKeysClaim(args: unknown): Chord[] | null {
  if (!isObj(args) || !Object.keys(args).every((k) => k === 'chords')) return null;
  const list = args.chords;
  if (!Array.isArray(list) || list.length > MAX_CHORDS) return null;
  const out: Chord[] = [];
  for (const c of list) {
    if (!isObj(c) || !Object.keys(c).every((k) => k === 'code' || k === 'shift')) return null;
    if (typeof c.code !== 'string' || !HOST_KEY_CODE_RE.test(c.code)) return null;
    if (c.shift !== undefined && typeof c.shift !== 'boolean') return null;
    out.push({ code: c.code, shift: c.shift === true });
  }
  return out;
}

/** The chords split: the ones the frame takes, and KiCad's own, each once, in the order asked. */
export function claimChords(chords: readonly Chord[]): { claimed: Chord[]; refused: Chord[] } {
  const seen = new Set<string>();
  const claimed: Chord[] = [];
  const refused: Chord[] = [];
  for (const c of chords) {
    const id = chordId(c.code, c.shift);
    if (seen.has(id)) continue;
    seen.add(id);
    (KICAD_IDS.has(id) ? refused : claimed).push({ code: c.code, shift: c.shift });
  }
  return { claimed, refused };
}

/** The fields of a key event this filter reads. */
type KeyLike = Event & { code?: unknown; altKey?: unknown; shiftKey?: unknown; ctrlKey?: unknown; metaKey?: unknown; repeat?: unknown };

export interface HostKeys {
  /** Replaces the whole claimed set (KiCad's own chords are dropped from it); answers the split. */
  claim(chords: readonly Chord[]): { claimed: Chord[]; refused: Chord[] };
  /** Removes the listeners: every key is KiCad's again. */
  stop(): void;
}

/**
 * Installs the capture listeners on the frame's window. `onKey` is called once
 * per claimed press (never for a repeat); a throw there is the host side's and
 * still leaves the chord kept from the engine. The island's own synthetic keys
 * (pressKey, key.press) are never touched.
 */
export function installHostKeys(win: Pick<Window, 'addEventListener' | 'removeEventListener'>, opts: { onKey(chord: Chord): void }): HostKeys {
  let claimed = new Set<string>();
  /** The codes whose keydown was taken and whose keyup has not come yet. */
  const held = new Set<string>();
  const swallow = (e: Event): void => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const codeOf = (e: KeyLike): string => (typeof e.code === 'string' ? e.code : '');
  const onDown = (e: Event): void => {
    if (isIslandKey(e)) return;
    const k = e as KeyLike;
    const code = codeOf(k);
    // A repeat of a press already taken stays taken, whatever the modifiers say now.
    if (k.repeat === true && held.has(code)) { swallow(e); return; }
    held.delete(code);
    if (k.altKey !== true || k.ctrlKey === true || k.metaKey === true) return;
    if (!claimed.has(chordId(code, k.shiftKey === true))) return;
    swallow(e);
    held.add(code);
    if (k.repeat === true) return;
    try { opts.onKey({ code, shift: k.shiftKey === true }); } catch { /* the chord stays the host's */ }
  };
  const onPress = (e: Event): void => {
    if (!isIslandKey(e) && held.has(codeOf(e as KeyLike))) swallow(e);
  };
  const onUp = (e: Event): void => {
    if (isIslandKey(e)) return;
    const code = codeOf(e as KeyLike);
    if (!held.delete(code)) return;
    swallow(e);
  };
  const capture = { capture: true };
  win.addEventListener('keydown', onDown, capture);
  win.addEventListener('keypress', onPress, capture);
  win.addEventListener('keyup', onUp, capture);
  return {
    claim(chords) {
      const split = claimChords(chords);
      claimed = new Set(split.claimed.map((c) => chordId(c.code, c.shift)));
      return split;
    },
    stop() {
      claimed = new Set();
      held.clear();
      win.removeEventListener('keydown', onDown, capture);
      win.removeEventListener('keypress', onPress, capture);
      win.removeEventListener('keyup', onUp, capture);
    },
  };
}
