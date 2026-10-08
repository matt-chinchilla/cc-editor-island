// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The place op's engine half (PICKER.md, PROTOCOL.md place): the blob goes to
// the engine's kicadPlaceImportedItem, which queues it on the editor's apply
// coroutine and answers {ok: true} before it is parsed; the item hangs off the
// pointer once the editor's placement tool has selected it (a uuid the
// selection did not hold), and a blob the editor refuses is only logged
// ("[import-item] ..." on the console). So the answer waits for one or the
// other. Then the placement is watched until the click commits it (the undo
// depth rises) or the reader cancels it: KiCad's schematic placement tool
// drops the item on Escape but stays armed, and its next click would open
// KiCad's own chooser (measured 2026-10-07), so a canceled schematic placement
// gets a second Escape, which leaves the tool. A board's placement (the move
// tool) ends with its Escape.
import type { KeyPress } from '../src/keys';
import type { Frame } from '../src/types';

export type PlaceWindow = Pick<ToolWindow, 'Module'> & { console?: Console };

export interface PlaceTiming {
  /** How often the selection is read while the placement starts, and how long the editor may take to take the item. */
  placePollMs: number;
  placeMs: number;
  /** How often a hanging placement is read, and how long a cancel may take. */
  placeWatchMs: number;
  placeCancelMs: number;
}

export const ESCAPE: KeyPress = { key: 'Escape', code: 'Escape', ctrl: false, shift: false, alt: false };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The selection's uuids (kicadCollabGetSelection), or null when the export is missing, throws or answers no list of strings. */
export function selection(w: PlaceWindow): string[] | null {
  const mod = w.Module as { kicadCollabGetSelection?: () => unknown } | undefined;
  const read = mod?.kicadCollabGetSelection;
  if (typeof read !== 'function') return null;
  try {
    const v: unknown = JSON.parse(String(read.call(mod)));
    return Array.isArray(v) && v.every((u) => typeof u === 'string') ? (v as string[]) : null;
  } catch { return null; }
}

/** The engine's own lines about a placement it refused (the apply coroutine's logs). */
const REFUSED = /^\[import-item\] |^\[pcbjam collab\] apply body (threw|died)/;

/** Keeps the engine's refusal lines while a placement starts; `stop` puts the console back. */
export function tapRefusals(w: PlaceWindow): { first(): string | null; stop(): void } {
  const c = w.console as unknown as Record<string, unknown> | undefined;
  let first: string | null = null;
  const put: Array<{ key: string; orig: unknown; wrap: unknown }> = [];
  if (c != null) {
    for (const key of ['log', 'error']) {
      const orig = c[key];
      if (typeof orig !== 'function') continue;
      const wrap = function (this: unknown, ...args: unknown[]): unknown {
        try { if (first == null && typeof args[0] === 'string' && REFUSED.test(args[0])) first = args[0].slice(0, 200); } catch { /* the tap never breaks a console call */ }
        return (orig as (...a: unknown[]) => unknown).apply(this, args);
      };
      c[key] = wrap;
      put.push({ key, orig, wrap });
    }
  }
  return {
    first: () => first,
    stop: () => { if (c != null) for (const p of put) if (c[p.key] === p.wrap) c[p.key] = p.orig; },
  };
}

export type PlaceOutcome = { ok: true; uuid: string } | { ok: false; code: 'busy' | 'island_error' | 'unsupported'; message: string };

/**
 * Hands `sexpr` to kicadPlaceImportedItem and waits until the item hangs off
 * the pointer (the selection holds a uuid it did not hold before the call):
 * `busy` when the engine says a load is in flight, or when it never takes the
 * item within timing.placeMs (its placement tool was already in use);
 * `island_error` when it refuses the blob or the frame closes.
 */
export async function placeBlob(w: PlaceWindow, sexpr: string, opts: { timing: PlaceTiming; closed: () => boolean }): Promise<PlaceOutcome> {
  const mod = w.Module as { kicadPlaceImportedItem?: (s: string) => unknown } | undefined;
  const place = mod?.kicadPlaceImportedItem;
  if (typeof place !== 'function') return { ok: false, code: 'unsupported', message: 'kicadPlaceImportedItem' };
  const before = selection(w);
  if (before == null) return { ok: false, code: 'unsupported', message: 'kicadCollabGetSelection' };
  const tap = tapRefusals(w);
  try {
    let raw: unknown;
    try { raw = place.call(mod, sexpr); } catch (err) { return { ok: false, code: 'island_error', message: `kicadPlaceImportedItem threw: ${String(err)}`.slice(0, 200) }; }
    let answer: { ok?: unknown; error?: unknown } = {};
    try { const v: unknown = JSON.parse(String(raw)); if (typeof v === 'object' && v !== null) answer = v as typeof answer; } catch { /* judged below */ }
    if (answer.ok !== true) {
      const why = typeof answer.error === 'string' ? answer.error.slice(0, 200) : 'the engine refused the item';
      return { ok: false, code: /open in flight/i.test(why) ? 'busy' : 'island_error', message: why };
    }
    const end = Date.now() + opts.timing.placeMs;
    for (;;) {
      if (opts.closed()) return { ok: false, code: 'island_error', message: 'the frame closed' };
      const refused = tap.first();
      if (refused != null) return { ok: false, code: 'island_error', message: refused };
      const fresh = (selection(w) ?? []).find((u) => !before.includes(u));
      if (fresh != null) return { ok: true, uuid: fresh };
      if (Date.now() >= end) return { ok: false, code: 'busy', message: 'the editor did not take the item' };
      await sleep(opts.timing.placePollMs);
    }
  } finally {
    tap.stop();
  }
}

/**
 * The placement the island started, from the answer to its end: committed
 * (the undo depth moved), or canceled (its item left the selection with the
 * depth unchanged, read twice in a row), after which a schematic gets the
 * second Escape that leaves KiCad's placement tool.
 */
export class PlacementWatch {
  private current: { uuid: string; depth: number | null; missing: number } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly w: PlaceWindow,
    private readonly opts: {
      frame: Frame;
      timing: PlaceTiming;
      /** The open document's undo depth, or null. */
      depth: () => number | null;
      /** A popup menu or a dialog is up: no key is pressed meanwhile. */
      blocked: () => boolean;
      press: (k: KeyPress) => void;
    },
  ) {}

  /** A placement hangs off the pointer: `uuid` is its item, read with the undo depth at that moment. */
  start(uuid: string): void {
    this.stop();
    this.current = { uuid, depth: this.opts.depth(), missing: 0 };
    this.timer = setInterval(() => this.tick(), this.opts.timing.placeWatchMs);
  }

  stop(): void {
    this.current = null;
    if (this.timer != null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Whether the item still hangs: in the selection, with the depth unchanged. */
  hanging(): boolean {
    const c = this.current;
    if (c == null) return false;
    const d = this.opts.depth();
    if (c.depth != null && d != null && d !== c.depth) return false;
    return (selection(this.w) ?? []).includes(c.uuid);
  }

  /** One read: the end of a committed placement, or the Escape a canceled schematic placement still needs. */
  tick(): void {
    const c = this.current;
    if (c == null) return;
    const d = this.opts.depth();
    if (c.depth != null && d != null && d !== c.depth) { this.stop(); return; }
    if ((selection(this.w) ?? []).includes(c.uuid)) { c.missing = 0; return; }
    c.missing += 1;
    if (c.missing < 2 || this.opts.blocked()) return;
    this.stop();
    if (this.opts.frame === 'sch') this.opts.press(ESCAPE);
  }

  /**
   * Drops a placement that still hangs, before another one starts (the
   * editor takes one at a time): Escape, then, once the item has left the
   * selection, a schematic's second Escape. False when it would not go
   * within timing.placeCancelMs; true when nothing hung or it went.
   */
  async cancel(): Promise<boolean> {
    const c = this.current;
    if (c == null) return true;
    if (!this.hanging()) {
      this.tick();
      this.tick();   // a placement already canceled gets its second Escape now
      this.stop();
      return true;
    }
    this.stop();
    this.opts.press(ESCAPE);
    const end = Date.now() + this.opts.timing.placeCancelMs;
    while ((selection(this.w) ?? []).includes(c.uuid)) {
      if (Date.now() >= end) return false;
      await sleep(this.opts.timing.placePollMs);
    }
    if (this.opts.frame === 'sch') this.opts.press(ESCAPE);
    await sleep(this.opts.timing.placePollMs);
    return true;
  }
}
