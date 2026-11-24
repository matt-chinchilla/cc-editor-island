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
// The engine's switch reaches the schematic and board editors only
// (kicad_editor_embind.cpp setColorTheme: pcbFrame() and schFrame() are the
// top window as PCB_EDIT_FRAME or SCH_EDIT_FRAME), so the op and its cap live
// in a sch and a pcb frame; the symbol editor, footprint editor and drawing
// sheet editor frames answer unsupported.
//
// A burst (a color picker) is coalesced: the op is answered off the request
// queue, every set joins one wait, and the island applies the newest set only,
// one switch at a time; every set that waited is answered with that switch's
// outcome.
import { fail, hasAll, isObj, ok, onlyKeys, type Answer, type ExtUnit, type ResponderCtx } from './contract';

/** The engine exports theme.set calls: the switch, and the apply queue it waits on. */
export const THEME_EXPORTS = ['kicadSetColorTheme', 'kicadCollabBusy'] as const;
export const THEME_CAP = 'theme';
export const THEME_OP = 'theme.set';
/** The frames whose editor the engine's switch reaches. */
export const THEME_FRAMES = ['sch', 'pcb'] as const;
/** The seeded palette's name (theme/seeds.ts colorTheme): what null brings back. */
export const PALETTE_THEME = 'circuitcenter';
/** The stem of every theme the host sent: `<stem><n>.json` under the colors folder. */
export const LIVE_STEM = 'cc-host-theme-';
/** The engine's apply queue is waited for at most this long when the bridge names no themeMs. */
export const THEME_MS = 15_000;
/** A theme's JSON: at most this many bytes. */
export const MAX_THEME_BYTES = 256 * 1024;
/** The deepest nesting a theme takes (the palette's own is 2: board.copper, gerbview.layers). */
const MAX_DEPTH = 4;
/** After the switch the answer waits this long at most for the engine's frame to paint. */
const PAINT_MS = 250;

/** A theme as received: a plain object whose every section is a plain object. */
export type ThemeJson = Record<string, Record<string, unknown>>;

const isPlain = (v: unknown): v is Record<string, unknown> =>
  isObj(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

/** A section's value: strings, finite numbers and booleans, nested plain objects to MAX_DEPTH, no arrays or null. */
function sectionValue(v: unknown, depth: number): boolean {
  if (typeof v === 'string') return v.length <= 256;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'boolean') return true;
  if (!isPlain(v) || depth >= MAX_DEPTH) return false;
  return Object.entries(v).every(([k, x]) => KEY_RE.test(k) && sectionValue(x, depth + 1));
}

/**
 * theme.set's args read closed: `{ colors }`, where colors is null or a theme
 * (a plain object of at least one section, every section a plain object, at
 * most MAX_THEME_BYTES of JSON). Answers the colors (null for the palette),
 * or undefined for args it refuses.
 */
export function parseThemeArgs(args: unknown): ThemeJson | null | undefined {
  if (!isPlain(args) || !onlyKeys(args, ['colors']) || !Object.prototype.hasOwnProperty.call(args, 'colors')) return undefined;
  const c = args.colors;
  if (c === null) return null;
  if (!isPlain(c)) return undefined;
  const entries = Object.entries(c);
  if (entries.length === 0) return undefined;
  if (!entries.every(([k, v]) => KEY_RE.test(k) && isPlain(v) && sectionValue(v, 1))) return undefined;
  let text: string;
  try { text = JSON.stringify(c); } catch { return undefined; }
  if (new TextEncoder().encode(text).byteLength > MAX_THEME_BYTES) return undefined;
  return c as ThemeJson;
}

/**
 * The theme file the engine reads: the theme as received, its meta given the
 * palette's own when it names none (KiCad reads a theme with no version as a
 * version 0 file and migrates it).
 */
export function themeFileText(colors: ThemeJson): string {
  const meta = isPlain(colors.meta) ? colors.meta : {};
  return JSON.stringify({ ...colors, meta: { name: 'Circuit Center host theme', version: 5, ...meta } }, null, 2);
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
function stateOf(ctx: ResponderCtx): ThemeState {
  let s = STATES.get(ctx);
  if (s == null) {
    s = { pending: null, running: false, live: null, seq: 0 };
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
  if (colors == null && s.live == null) return ok();
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
  await painted(ctx);
  // The theme before this one is in KiCad's memory by name; its file is no longer read.
  if (before != null && before !== s.live) {
    try {
      const d = dir || (await colorsDir());
      if (fs.analyzePath(`${d}/${before}.json`).exists) fs.unlink(`${d}/${before}.json`);
    } catch { /* a file left behind is only a file */ }
  }
  ctx.log('[theme]', colors == null ? 'palette' : name, `${Date.now() - t0} ms`);
  return ok();
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
 * ev.ready, unsupported naming the first missing export). The set then waits
 * for its switch: a set that arrives while another waits replaces it, and
 * both are answered with the newest one's outcome.
 */
export function themeSet(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const op = THEME_OP;
  const colors = parseThemeArgs(args);
  if (colors === undefined) return Promise.resolve(fail('bad_args', op));
  if (!ctx.ready()) return Promise.resolve(fail('not_ready', op));
  const mod = ctx.mod();
  const missing = THEME_EXPORTS.find((n) => mod == null || typeof mod[n] !== 'function');
  if (missing != null) return Promise.resolve(fail('unsupported', missing));
  const s = stateOf(ctx);
  return new Promise<Answer>((resolve) => {
    const waiters = s.pending?.waiters ?? [];
    waiters.push({ resolve });
    s.pending = { colors, waiters };
    void drain(ctx, s);
  });
}

export default {
  unit: 'theme-i',
  frames: [...THEME_FRAMES],
  frameRefusal: 'the canvas colors change in a sch or a pcb frame',
  capNames: [THEME_CAP],
  caps: (mod, frame) => ((THEME_FRAMES as readonly string[]).includes(frame) && hasAll(mod, THEME_EXPORTS) ? [THEME_CAP] : []),
  ops: {
    // Off the request queue: a burst must be seen whole to keep only its newest set.
    [THEME_OP]: { run: themeSet, now: true },
  },
} satisfies ExtUnit;
