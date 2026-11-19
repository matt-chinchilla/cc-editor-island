// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The auto-placer's working state (PROTOCOL.md ev.autoplace, cap autoplace).
//
// KiCad's Place Off-Board Footprints and Place Selected Footprints
// (pcbnew.Autoplacer.autoplaceOffboard, autoplaceSelected) have no default key:
// theme/user.hotkeys seeds a chord for each, and a host's pencil case presses
// that chord through key.press. On our engine from run 15 (marker
// kicadAutoplaceQuiet, kicad pcbnew/autorouter/autoplace_tool.cpp under
// __EMSCRIPTEN__) the auto-placer runs with no progress window, so the frame
// tells the host itself while it works: key.press of one of the two chords sends
// ev.autoplace { working: true } before the key reaches KiCad, and
// { working: false } once the run is over, read every 250 ms after the press:
// the engine's apply queue is empty (kicadCollabBusy) and either the undo depth
// moved (the run's one undo step "Autoplace Footprints") or a short settle went
// by with nothing changed (no part to place, or KiCad's info bar refusing a
// board with no outline). A press that is refused (a dialog up, bad args) sends
// { working: false } at once. A second press while one run is watched joins it.
import hotkeysText from '../../theme/user.hotkeys?raw';
import { parseKeyPress, type KeyPress } from '../../src/keys';
import { hasAll, type Answer, type ExtUnit, type ResponderCtx } from './contract';

/** The cap ev.ready lists in a pcb frame when the auto-placer runs with no window of KiCad's. */
export const AUTOPLACE_CAP = 'autoplace';
/** The event: the frame's auto-placer is working, or done. */
export const AUTOPLACE_EVENT = 'ev.autoplace';
/** The engine's marker (st-ap-e) and the apply queue's probe the watch reads. */
export const AUTOPLACE_EXPORTS = ['kicadAutoplaceQuiet', 'kicadCollabBusy'] as const;
/** KiCad's two actions (pcbnew/tools/pcb_actions.cpp PCB_ACTIONS::autoplaceOffboardComponents, autoplaceSelectedComponents). */
export const AUTOPLACE_ACTIONS = ['pcbnew.Autoplacer.autoplaceOffboard', 'pcbnew.Autoplacer.autoplaceSelected'] as const;

/** The watch's pace: the poll, the settle with nothing changed, the bound of one run (the unit tests shorten them). */
export const apTiming = { pollMs: 250, settleTicks: 4, maxMs: 600_000 };

/** A KeyPress as one comparable token. */
const token = (k: KeyPress): string => `${k.ctrl ? 'C' : ''}${k.alt ? 'A' : ''}${k.shift ? 'S' : ''}:${k.code}`;

/**
 * The chords a hotkeys text (KiCad's format: action, key, second key, tab
 * separated) gives the two auto-place actions, as key.press tokens; a key
 * key.press cannot carry is left out.
 */
export function autoplaceChords(text: string): ReadonlySet<string> {
  const out = new Set<string>();
  for (const line of text.split('\n')) {
    const [action, ...keys] = line.replace(/\r$/, '').split('\t');
    if (!(AUTOPLACE_ACTIONS as readonly string[]).includes(action)) continue;
    for (const name of keys) {
      const k = name === '' ? null : chordOf(name);
      if (k != null) out.add(token(k));
    }
  }
  return out;
}

/** A KiCad hotkey name with modifiers (Ctrl+Alt+L) as a KeyPress, the letter and digit keys only (the seeded chords). */
function chordOf(name: string): KeyPress | null {
  const parts = name.split('+');
  const last = parts.pop() ?? '';
  if (!parts.every((p) => p === 'Ctrl' || p === 'Alt' || p === 'Shift')) return null;
  const shift = parts.includes('Shift');
  const code = /^[A-Za-z]$/.test(last) ? `Key${last.toUpperCase()}` : /^[0-9]$/.test(last) ? `Digit${last}` : null;
  if (code == null) return null;
  const key = /^[A-Za-z]$/.test(last) ? (shift ? last.toUpperCase() : last.toLowerCase()) : last;
  return parseKeyPress({ key, code, ctrl: parts.includes('Ctrl'), alt: parts.includes('Alt'), shift });
}

/** The seeded chords of the two actions (theme/user.hotkeys). */
export const SEEDED_CHORDS: ReadonlySet<string> = autoplaceChords(hotkeysText);

/** Whether a key.press's args press one of the auto-place chords. */
export function isAutoplacePress(args: unknown, chords: ReadonlySet<string> = SEEDED_CHORDS): boolean {
  const k = parseKeyPress(args);
  return k != null && chords.has(token(k));
}

/** The open document's undo depth through the engine, null when unknown. */
function depthOf(mod: Record<string, unknown> | null): number | null {
  const read = mod?.kicadCollabTestUndoDepth;
  if (typeof read !== 'function') return null;
  try {
    const d: unknown = read.call(mod);
    return typeof d === 'number' && Number.isSafeInteger(d) && d >= 0 ? d : null;
  } catch { return null; }
}

/** The apply queue's probe; a throw reads as idle (the watch must end). */
function busyOf(mod: Record<string, unknown> | null): boolean {
  const probe = mod?.kicadCollabBusy;
  if (typeof probe !== 'function') return false;
  try { return probe.call(mod) === true; } catch { return false; }
}

/** One responder's watch: at most one run watched at a time. */
interface Watch { timer: ReturnType<typeof setTimeout> | null; working: boolean }
const watches = new WeakMap<ResponderCtx, Watch>();
const watchOf = (ctx: ResponderCtx): Watch => {
  let w = watches.get(ctx);
  if (w == null) { w = { timer: null, working: false }; watches.set(ctx, w); }
  return w;
};

function stopWatch(w: Watch): void {
  if (w.timer != null) clearTimeout(w.timer);
  w.timer = null;
  w.working = false;
}

function done(ctx: ResponderCtx, w: Watch): void {
  stopWatch(w);
  if (!ctx.closed()) ctx.emitExt(AUTOPLACE_EVENT, { working: false });
}

/** Reads the engine every apTiming.pollMs until the run is over. */
function follow(ctx: ResponderCtx, w: Watch, before: number | null): void {
  const started = Date.now();
  let quiet = 0;
  const tick = (): void => {
    w.timer = null;
    if (ctx.closed()) { stopWatch(w); return; }
    const mod = ctx.mod();
    if (Date.now() - started >= apTiming.maxMs) { done(ctx, w); return; }
    if (!busyOf(mod)) {
      const now = depthOf(mod);
      if (before != null && now != null && now !== before) { done(ctx, w); return; }
      quiet += 1;
      if (quiet >= apTiming.settleTicks) { done(ctx, w); return; }
    } else {
      quiet = 0;
    }
    w.timer = setTimeout(tick, apTiming.pollMs);
  };
  w.timer = setTimeout(tick, apTiming.pollMs);
}

/** key.press, widened: an auto-place chord in a frame that lists the cap is watched. */
async function keyPress(args: unknown, ctx: ResponderCtx, next: (args: unknown) => Promise<Answer>): Promise<Answer> {
  if (ctx.frame !== 'pcb' || !ctx.caps().includes(AUTOPLACE_CAP) || !isAutoplacePress(args)) return next(args);
  const w = watchOf(ctx);
  if (w.working) return next(args);   // joins the run already watched
  const before = depthOf(ctx.mod());
  w.working = true;
  // Before the key: the auto-placer may hold the frame's thread until it is done.
  ctx.emitExt(AUTOPLACE_EVENT, { working: true });
  let answer: Answer;
  try { answer = await next(args); } catch (e) { done(ctx, w); throw e; }
  if (!answer.ok) { done(ctx, w); return answer; }
  follow(ctx, w, before);
  return answer;
}

export default {
  unit: 'st-ap-i',
  capNames: [AUTOPLACE_CAP],
  caps: (mod, frame) => (frame === 'pcb' && hasAll(mod, AUTOPLACE_EXPORTS) ? [AUTOPLACE_CAP] : []),
  events: { [AUTOPLACE_EVENT]: ['working'] },
  opsWidened: { 'key.press': keyPress },
  install(ctx) {
    return () => { const w = watches.get(ctx); if (w != null) stopWatch(w); };
  },
} satisfies ExtUnit;
