// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The island's half of the fast part picker (PICKER.md): the closed checks of
// the lib.index, lib.item, lib.prefetch and place requests, the library reads
// they make (through the mirror source, never the engine: nothing here asks
// KiCad to enumerate a library), the place keys the island takes from KiCad
// (A and P in a schematic, A on a board) and hands to the host as ev.pick, and
// the quiet warm-up that fetches the frame's search index and the common
// libraries once the frame has been idle for a moment after ev.ready.
import type { Frame } from './types';

export type PickKind = 'symbol' | 'footprint';
export interface KeyPick { kind: PickKind; power?: true }

/** lib.prefetch takes at most this many library nicknames at once. */
export const MAX_PREFETCH = 16;
/** The longest library nickname or item name the ops take. */
export const MAX_NAME = 255;

/**
 * The library reads the picker makes. The mirror source has them all (the
 * search index and prefetch arrive with the ccl2 client); a source without
 * `getSearchIndex` answers no index, and one without `prefetch` is warmed
 * by reading the library's item list (which loads its bundle).
 */
export interface PickerLibs {
  listLibs(kind?: string): Promise<Array<{ id: string; name: string }>>;
  listItems?(libId: string): Promise<unknown>;
  getItemBody(libId: string, kind: string, name: string): Promise<string | null>;
  getSearchIndex?(kind: PickKind): Promise<string | null>;
  prefetch?(id: string): Promise<void>;
}

/** The common libraries the quiet warm-up fetches, by kind (PICKER.md). */
export const COMMON_LIBS: Record<PickKind, readonly string[]> = {
  symbol: ['Device', 'power', 'Connector', 'Connector_Generic', 'Switch', 'LED', 'Diode', 'Transistor_FET', 'Transistor_BJT', 'Regulator_Linear'],
  footprint: ['Resistor_SMD', 'Capacitor_SMD', 'LED_SMD', 'Diode_SMD', 'Package_TO_SOT_SMD', 'Connector_PinHeader_2.54mm'],
};

/** The kind of item a frame places: symbols in a schematic, footprints on a board. */
export const kindOf = (frame: Frame): PickKind => (frame === 'pcb' ? 'footprint' : 'symbol');

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(o).every((k) => allowed.includes(k));
const CONTROL = /[\u0000-\u001f\u007f]/;
/** A library nickname or an item name: a non-empty string of at most MAX_NAME characters with no control character. */
export const isName = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_NAME && !CONTROL.test(v);
const isKind = (v: unknown): v is PickKind => v === 'symbol' || v === 'footprint';

/** lib.index's args: `{ kind }`, nothing else. */
export function parseIndexArgs(args: unknown): { kind: PickKind } | null {
  if (!isObj(args) || !onlyKeys(args, ['kind']) || !isKind(args.kind)) return null;
  return { kind: args.kind };
}

/** lib.item's and place's args: `{ kind, lib, name }`, nothing else. */
export function parseItemArgs(args: unknown): { kind: PickKind; lib: string; name: string } | null {
  if (!isObj(args) || !onlyKeys(args, ['kind', 'lib', 'name']) || !isKind(args.kind) || !isName(args.lib) || !isName(args.name)) return null;
  return { kind: args.kind, lib: args.lib, name: args.name };
}

/** lib.prefetch's args: `{ kind, libs }`, libs an array of at most MAX_PREFETCH nicknames. */
export function parsePrefetchArgs(args: unknown): { kind: PickKind; libs: string[] } | null {
  if (!isObj(args) || !onlyKeys(args, ['kind', 'libs']) || !isKind(args.kind)) return null;
  if (!Array.isArray(args.libs) || args.libs.length > MAX_PREFETCH || !args.libs.every(isName)) return null;
  return { kind: args.kind, libs: [...(args.libs as string[])] };
}

/**
 * Library nicknames to the source's library ids, read once per kind from the
 * source's own list (the mirror's `sym.<nick>` and `fp.<nick>`, the example
 * library's own id). A list that fails is not kept: the next read asks again.
 */
export function libIds(source: Pick<PickerLibs, 'listLibs'>): (kind: PickKind, nick: string) => Promise<string | null> {
  const maps = new Map<PickKind, Promise<Map<string, string>>>();
  return async (kind, nick) => {
    let p = maps.get(kind);
    if (p == null) {
      p = source.listLibs(kind).then((libs) => new Map(libs.map((l) => [l.name, l.id])));
      maps.set(kind, p);
      p.catch(() => { if (maps.get(kind) === p) maps.delete(kind); });
    }
    return (await p).get(nick) ?? null;
  };
}

/** Warms one library: the source's own prefetch, else a read of its item list. Never rejects. */
export async function warmLibrary(source: PickerLibs, id: string): Promise<void> {
  try {
    if (typeof source.prefetch === 'function') await source.prefetch(id);
    else if (typeof source.listItems === 'function') await source.listItems(id);
  } catch { /* best-effort: the library still loads when it is placed */ }
}

/** The fields of a key event the place-key filter reads. */
export interface KeyLike { key?: string; code?: string; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean }

/**
 * The pick a key asks for in this frame, or null: A (a symbol) and P (a power
 * symbol) in a schematic, A (a footprint) on a board, as KiCad's own place
 * keys are, with no modifier held. The character decides (KiCad matches its
 * letter hotkeys by character, so A on an AZERTY keyboard is the key that
 * types a), whichever case it types in (Caps Lock).
 */
export function pickFor(frame: Frame, e: KeyLike): KeyPick | null {
  if (e.ctrlKey === true || e.shiftKey === true || e.altKey === true || e.metaKey === true) return null;
  const k = typeof e.key === 'string' && e.key.length === 1 ? e.key.toLowerCase() : '';
  if (k === 'a') return { kind: kindOf(frame) };
  if (k === 'p' && frame === 'sch') return { kind: 'symbol', power: true };
  return null;
}

/** An element that takes typed text: an input of a text-like type, a textarea, a select or an editable element. */
export function takesText(el: unknown): boolean {
  if (typeof el !== 'object' || el === null) return false;
  const e = el as { tagName?: unknown; type?: unknown; isContentEditable?: unknown };
  if (e.isContentEditable === true) return true;
  const tag = typeof e.tagName === 'string' ? e.tagName.toUpperCase() : '';
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = typeof e.type === 'string' ? e.type.toLowerCase() : 'text';
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image', 'hidden'].includes(type);
}

export interface PickKeysOptions {
  frame: Frame;
  /**
   * Whether a place key may be taken now: the engine is up and nothing of
   * KiCad's own is over its canvas (no dialog, no popup menu, no other window
   * such as KiCad's footprint chooser). Read for every keydown of A or P.
   */
  open(): boolean;
  /** The document's focused element (a text field of KiCad's takes its keys). */
  focused(): unknown;
  onPick(pick: KeyPick): void;
}

/**
 * Takes the frame's place keys from KiCad: capture-phase listeners on the
 * window, installed before the engine's scripts load so they run before
 * KiCad's own. A keydown that `pickFor` names, while `open()` holds and no
 * text field has the focus, is cancelled and stopped (KiCad's chooser never
 * opens) and `onPick` is called once per press (a held key's repeats are
 * swallowed too, unreported); the matching keypress and keyup are swallowed
 * as well, so KiCad never sees half a key. Answers the remover.
 */
export function installPickKeys(win: Pick<Window, 'addEventListener' | 'removeEventListener'>, opts: PickKeysOptions): () => void {
  /** The codes (or keys) whose keydown was taken and whose keyup has not come yet. */
  const held = new Set<string>();
  const id = (e: KeyLike): string => (typeof e.code === 'string' && e.code !== '' ? e.code : `key:${String(e.key ?? '').toLowerCase()}`);
  const swallow = (e: Event): void => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const onDown = (e: Event): void => {
    const k = e as Event & KeyLike & { repeat?: boolean; target?: unknown };
    const pick = pickFor(opts.frame, k);
    if (pick == null) return;
    // A repeat of a key already taken; a keydown that is no repeat starts a new
    // press (a keyup lost to a focus change leaves no key held for good).
    if (k.repeat === true && held.has(id(k))) { swallow(e); return; }
    held.delete(id(k));
    if (takesText(k.target) || takesText(opts.focused()) || !opts.open()) return;
    swallow(e);
    held.add(id(k));
    if (k.repeat !== true) opts.onPick(pick);
  };
  const onPress = (e: Event): void => { if (held.has(id(e as Event & KeyLike))) swallow(e); };
  const onUp = (e: Event): void => {
    const k = id(e as Event & KeyLike);
    if (!held.has(k)) return;
    held.delete(k);
    swallow(e);
  };
  const capture = { capture: true };
  win.addEventListener('keydown', onDown, capture);
  win.addEventListener('keypress', onPress, capture);
  win.addEventListener('keyup', onUp, capture);
  return () => {
    win.removeEventListener('keydown', onDown, capture);
    win.removeEventListener('keypress', onPress, capture);
    win.removeEventListener('keyup', onUp, capture);
  };
}

/** The quiet warm-up's waits, in ms (the unit tests shorten them). */
export const warmTiming = {
  /** How long no request may have been in flight before the warm-up starts. */
  quietMs: 1_500,
  /** How often that is checked. */
  pollMs: 250,
  /** The idle callback's own bound: the warm-up starts by then even on a busy page. */
  idleMs: 2_000,
};

export interface QuietWarmUpOptions {
  frame: Frame;
  source: PickerLibs;
  /** Stops the warm-up between steps (the shutdown op, pagehide). */
  signal: AbortSignal;
  /** A request is in flight: the warm-up waits until none has been for warmTiming.quietMs. */
  busy(): boolean;
  log?(msg: string): void;
  /** Test seam: the browser's idle callback (requestIdleCallback, else a timer). */
  idle?(timeoutMs: number): Promise<void>;
}

function browserIdle(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o: { timeout: number }) => unknown }).requestIdleCallback;
    if (typeof ric === 'function') ric(() => resolve(), { timeout: timeoutMs });
    else setTimeout(resolve, 0);
  });
}

/**
 * The quiet warm-up (PICKER.md): once no request has been in flight for
 * warmTiming.quietMs and the browser is idle, the frame's search index (a
 * schematic's symbol index, a board's footprint index) and then the common
 * libraries of its kind that the source has, one at a time. Nothing is shown
 * and nothing is sent to the host. Never rejects; stops between steps once
 * `signal` aborts. Resolves with the library ids it warmed (the tests read them).
 */
export async function quietWarmUp(opts: QuietWarmUpOptions): Promise<string[]> {
  const { source, signal } = opts;
  const idle = opts.idle ?? browserIdle;
  const warmed: string[] = [];
  let quietSince: number | null = null;
  while (!signal.aborted) {
    if (opts.busy()) quietSince = null;
    else quietSince ??= Date.now();
    if (quietSince != null && Date.now() - quietSince >= warmTiming.quietMs) break;
    await new Promise((r) => setTimeout(r, warmTiming.pollMs));
  }
  if (signal.aborted) return warmed;
  await idle(warmTiming.idleMs);
  if (signal.aborted) return warmed;
  const kind = kindOf(opts.frame);
  const t0 = Date.now();
  if (typeof source.getSearchIndex === 'function') {
    try { await source.getSearchIndex(kind); } catch { /* the host's lib.index asks again */ }
  }
  const idOf = libIds(source);
  for (const nick of COMMON_LIBS[kind]) {
    if (signal.aborted) break;
    let id: string | null = null;
    try { id = await idOf(kind, nick); } catch { break; }
    if (id == null) continue;
    await warmLibrary(source, id);
    warmed.push(id);
  }
  opts.log?.(`[libs] quiet ${kind} warm-up ${signal.aborted ? 'stopped' : 'done'}: ${warmed.length} libraries in ${Date.now() - t0} ms`);
  return warmed;
}
