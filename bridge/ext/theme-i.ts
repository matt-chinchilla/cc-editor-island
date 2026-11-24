// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// theme.set (PROTOCOL.md): the running frame repaints in the canvas colors the
// host sends, live, with the document and the view kept. The host sends a
// whole KiCad color theme (the shape of theme/colors/circuitcenter.json); the
// island writes it into the engine's colors folder under a fresh name and
// switches to it through the engine's kicadSetColorTheme, the path KiCad's own
// Preferences dialog takes (pcbjam wasm/bindings/pcbjam_theme.h: the frame's
// app settings take the name, then CommonSettingsChanged reloads the colors
// into the painter and recaches the view). KiCad loads a theme it has not met
// from its file on demand (SETTINGS_MANAGER::GetColorSettings) and keeps it by
// name, and the engine skips a switch to the name it holds, so every set takes
// a name of its own; the file before it is removed once the new one shows.
// null brings the palette back (the seeded circuitcenter theme).
//
// Whether a frame takes the switch is one rule, switchesIn: the engine's
// switch (engine build T18b) reaches the schematic and board editors only
// (kicad_editor_embind.cpp setColorTheme: pcbFrame() and schFrame() are the
// top window as PCB_EDIT_FRAME or SCH_EDIT_FRAME), so the cap is listed in a
// sch and a pcb frame and every other frame answers theme_frame. Every set
// that applied is kept on the island's origin (theme/kept.ts) and every frame
// boots in the kept colors (theme/seeds.ts), so the symbol, footprint and
// drawing sheet editors open in the host's colors.
//
// A burst (a color picker) is coalesced: the op is answered off the request
// queue, every set joins one wait, and the island applies the newest set only,
// one switch at a time; every set that waited is answered with that switch's
// outcome.
import { fail, hasAll, isObj, ok, onlyKeys, type Answer, type ExtUnit, type ResponderCtx } from './contract';
import type { Frame } from '../../src/types';
import { KEPT_THEME, keepTheme, readTheme, themeFileText, type ThemeJson } from '../../theme/kept';

export { MAX_THEME_BYTES, themeFileText, type ThemeJson } from '../../theme/kept';
/** The engine exports theme.set calls: the switch, and the apply queue it waits on. */
export const THEME_EXPORTS = ['kicadSetColorTheme', 'kicadCollabBusy'] as const;
export const THEME_CAP = 'theme';
export const THEME_OP = 'theme.set';
/** The frames whose editor the engine's switch reaches (engine build T18b: the schematic and board editors). */
export const SWITCH_FRAMES: readonly string[] = ['sch', 'pcb'];
/** The seeded palette's name (theme/seeds.ts colorTheme): what null brings back. */
export const PALETTE_THEME = 'circuitcenter';
/** The stem of every theme the host sent: `<stem><n>.json` under the colors folder (n 0 is the kept theme a boot selects). */
export const LIVE_STEM = 'cc-host-theme-';
/** The engine's apply queue is waited for at most this long when the bridge names no themeMs. */
export const THEME_MS = 15_000;
/** The answer of a set that applied (the contract's shape). */
const THEME_OK = { ok: true };
/** After the switch the answer waits this long at most for the engine's frame to paint. */
const PAINT_MS = 250;

/** The one rule: this engine switches the canvas colors of a running frame of this kind. */
export function switchesIn(mod: Record<string, unknown> | null | undefined, frame: Frame | string): boolean {
  return SWITCH_FRAMES.includes(frame) && hasAll(mod, THEME_EXPORTS);
}

/**
 * theme.set's args read closed: `{ colors }`, where colors is null or a theme
 * (theme/kept.ts readTheme). Answers the colors (null for the palette), or
 * undefined for args it refuses.
 */
export function parseThemeArgs(args: unknown): ThemeJson | null | undefined {
  if (!isObj(args) || Object.getPrototypeOf(args) !== Object.prototype || !onlyKeys(args, ['colors']) || !Object.prototype.hasOwnProperty.call(args, 'colors')) return undefined;
  if (args.colors === null) return null;
  return readTheme(args.colors) ?? undefined;
}

interface Waiter { resolve(a: Answer): void }
interface Pending { colors: ThemeJson | null; waiters: Waiter[] }
interface ThemeState {
  /** The set waiting for its switch (the newest one; every older one waiting joined it). */
  pending: Pending | null;
  /** A switch runs now. */
  running: boolean;
  /** The theme name the frame shows when it is the host's, null while it shows the palette. */
  live: string | null;
  /** The last fresh number given. */
  seq: number;
}

const STATES = new WeakMap<ResponderCtx, ThemeState>();
/** The frame's state, made at its first set: a frame that booted in the kept theme shows the host's colors. */
async function stateOf(ctx: ResponderCtx): Promise<ThemeState> {
  let s = STATES.get(ctx);
  if (s == null) {
    let booted = false;
    try { booted = ctx.fs()?.analyzePath(`${await colorsDir()}/${KEPT_THEME}.json`).exists === true; } catch { booted = false; }
    s = STATES.get(ctx) ?? { pending: null, running: false, live: booted ? KEPT_THEME : null, seq: 0 };
    STATES.set(ctx, s);
  }
  return s;
}

const themeMs = (ctx: ResponderCtx): number => ctx.timing.themeMs ?? THEME_MS;

/** The engine's colors folder (the loader's config dir), read at request time: the loader's constants reach src/frames.ts. */
async function colorsDir(): Promise<string> {
  const { KICAD_CONFIG_DIR } = await import('../../loader/src/wasm/constants');
  return `${KICAD_CONFIG_DIR}/colors`;
}

/** Two frames of the engine's window, at most PAINT_MS: the switch's repaint reaches the screen. */
async function painted(ctx: ResponderCtx): Promise<void> {
  const w = ctx.win() as unknown as { requestAnimationFrame?: (fn: () => void) => number } | null;
  const raf = w?.requestAnimationFrame;
  if (typeof raf !== 'function') return;
  const frame = () => new Promise<void>((r) => { try { raf.call(w, () => r()); } catch { r(); } });
  await ctx.withTimeout(frame().then(frame), PAINT_MS);
}

/** Waits until no request on the queue is in flight, at most `ms`: false when one still is. */
async function queueIdle(ctx: ResponderCtx, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  const poll = ctx.timing.applyPollMs ?? 20;
  while (ctx.inFlight() > 0) {
    if (ctx.closed() || Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, poll));
  }
  return true;
}

/**
 * One switch: the checks that need the engine now (busy while a request on
 * the queue stays in flight past the time limit, a load is parked, an import
 * or a check runs, or a popup menu or a dialog is up),
 * then the file, the engine's switch, its apply queue emptied and a paint.
 */
async function applyOne(colors: ThemeJson | null, ctx: ResponderCtx, s: ThemeState): Promise<Answer> {
  const op = THEME_OP;
  if (ctx.closed()) return fail('not_ready', op);
  const mod = ctx.mod();
  const fs = ctx.fs();
  if (mod == null || fs == null || !ctx.ready()) return fail('not_ready', op);
  const missing = THEME_EXPORTS.find((n) => typeof mod[n] !== 'function');
  if (missing != null) return fail('unsupported', missing);
  // Behind every request on the queue that came before it (a set sent after an open shows on the opened drawing).
  if (!(await queueIdle(ctx, themeMs(ctx)))) return fail('busy', op);
  if (ctx.engineBusy() || ctx.importing() || ctx.checking() || ctx.keysBlocked()) return fail('busy', op);
  // The palette while it shows: nothing to switch (a switch would only rebuild KiCad's hidden menus).
  if (colors == null && s.live == null) {
    keepTheme(null);
    return ok(THEME_OK);
  }
  const before = s.live;
  let name = PALETTE_THEME;
  let dir = '';
  if (colors != null) {
    s.seq += 1;
    name = `${LIVE_STEM}${s.seq}`;
    try {
      dir = await colorsDir();
      fs.mkdirTree(dir);
      fs.writeFile(`${dir}/${name}.json`, themeFileText(colors));
    } catch (err) {
      return fail('island_error', err instanceof Error ? err.message : String(err));
    }
  }
  const t0 = Date.now();
  try {
    (mod.kicadSetColorTheme as (n: string) => unknown)(name);
  } catch (err) {
    return fail('island_error', err instanceof Error ? err.message : String(err));
  }
  if (!(await ctx.applyIdle(themeMs(ctx)))) return fail('not_applied', op);
  s.live = colors == null ? null : name;
  // Kept for every frame's next boot (the editors the switch does not reach open in it); null forgets it.
  keepTheme(colors);
  await painted(ctx);
  // The theme before this one is in KiCad's memory by name; its file is no longer read.
  if (before != null && before !== s.live) {
    try {
      const d = dir || (await colorsDir());
      if (fs.analyzePath(`${d}/${before}.json`).exists) fs.unlink(`${d}/${before}.json`);
    } catch { /* a file left behind is only a file */ }
  }
  ctx.log('[theme]', colors == null ? 'palette' : name, `${Date.now() - t0} ms`);
  return ok(THEME_OK);
}

/** Runs the newest waiting set until none waits; one runner at a time. */
async function drain(ctx: ResponderCtx, s: ThemeState): Promise<void> {
  if (s.running) return;
  s.running = true;
  try {
    while (s.pending != null) {
      const p = s.pending;
      s.pending = null;
      let answer: Answer;
      try { answer = await applyOne(p.colors, ctx, s); } catch (err) { answer = fail('island_error', err instanceof Error ? err.message : String(err)); }
      for (const w of p.waiters) w.resolve(answer);
    }
  } finally {
    s.running = false;
  }
}

/**
 * theme.set: the args first (bad_args), then the engine (not_ready before
 * ev.ready, unsupported naming the first missing export), then the frame
 * (theme_frame where the engine's switch does not reach). The set then waits
 * for its switch: a set that arrives while another waits replaces it, and
 * both are answered with the newest one's outcome.
 */
export async function themeSet(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const op = THEME_OP;
  const colors = parseThemeArgs(args);
  if (colors === undefined) return fail('bad_args', op);
  if (!ctx.ready()) return fail('not_ready', op);
  const mod = ctx.mod();
  const missing = THEME_EXPORTS.find((n) => mod == null || typeof mod[n] !== 'function');
  if (missing != null) return fail('unsupported', missing);
  if (!switchesIn(mod, ctx.frame)) return fail('theme_frame', `the canvas colors of a ${ctx.frame} frame change at its next boot`);
  const s = await stateOf(ctx);
  return new Promise<Answer>((resolve) => {
    const waiters = s.pending?.waiters ?? [];
    waiters.push({ resolve });
    s.pending = { colors, waiters };
    void drain(ctx, s);
  });
}

export default {
  unit: 'theme-i',
  capNames: [THEME_CAP],
  caps: (mod, frame) => (switchesIn(mod, frame) ? [THEME_CAP] : []),
  ops: {
    // Off the request queue: a burst must be seen whole to keep only its newest set.
    [THEME_OP]: { run: themeSet, now: true },
  },
} satisfies ExtUnit;
