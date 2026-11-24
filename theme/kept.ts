// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The host's canvas colors (theme.set, bridge/ext/theme-i.ts): their check,
// the theme file the engine reads, and the copy the island keeps on its own
// origin so every frame of the page boots in them. localStorage is
// partitioned by the top level site, so every island frame one page holds
// reads the same copy; the symbol, footprint and drawing sheet editors, whose
// engine switch takes no theme at run time, boot in the colors the schematic
// or board frame last took. A kept value that does not read as a theme is
// removed.

/** A theme as received: a plain object whose every section is a plain object. */
export type ThemeJson = Record<string, Record<string, unknown>>;

/** The key of the kept copy in the island origin's localStorage. */
export const KEPT_KEY = 'cc.island.theme';
/** The kept theme's name at boot: `<name>.json` under the engine's colors folder, selected in place of the palette. */
export const KEPT_THEME = 'cc-host-theme-0';
/** A theme's JSON: at most this many bytes. */
export const MAX_THEME_BYTES = 256 * 1024;
/** The deepest nesting a theme takes (the palette's own is 2: board.copper, gerbview.layers). */
const MAX_DEPTH = 4;
const KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** A section's value: strings, finite numbers and booleans, nested plain objects to MAX_DEPTH, no arrays or null. */
function sectionValue(v: unknown, depth: number): boolean {
  if (typeof v === 'string') return v.length <= 256;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'boolean') return true;
  if (!isPlain(v) || depth >= MAX_DEPTH) return false;
  return Object.entries(v).every(([k, x]) => KEY_RE.test(k) && sectionValue(x, depth + 1));
}

/**
 * A theme read closed: a plain object of at least one section, every section a
 * plain object, at most MAX_THEME_BYTES of JSON. Answers it, or null.
 */
export function readTheme(c: unknown): ThemeJson | null {
  if (!isPlain(c)) return null;
  const entries = Object.entries(c);
  if (entries.length === 0) return null;
  if (!entries.every(([k, v]) => KEY_RE.test(k) && isPlain(v) && sectionValue(v, 1))) return null;
  let text: string;
  try { text = JSON.stringify(c); } catch { return null; }
  if (new TextEncoder().encode(text).byteLength > MAX_THEME_BYTES) return null;
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

/** The storage the kept copy lives in: the island origin's localStorage, null where it cannot be reached. */
export type KeptStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export function islandStore(): KeptStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The kept theme, null when none is kept; a kept value that does not read as a theme is removed. Never throws. */
export function readKept(store: KeptStore | null = islandStore()): ThemeJson | null {
  if (store == null) return null;
  try {
    const raw = store.getItem(KEPT_KEY);
    if (raw == null) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    const t = readTheme(parsed);
    if (t == null) store.removeItem(KEPT_KEY);
    return t;
  } catch {
    return null;
  }
}

/** Keeps the theme (null removes the kept copy). Never throws: a store that refuses keeps nothing. */
export function keepTheme(colors: ThemeJson | null, store: KeptStore | null = islandStore()): void {
  if (store == null) return;
  try {
    if (colors == null) store.removeItem(KEPT_KEY);
    else store.setItem(KEPT_KEY, JSON.stringify(colors));
  } catch { /* a full or blocked store keeps nothing */ }
}
