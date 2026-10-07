// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The island's libraries: KiCad's library mirror on this origin (LIBRARY.md),
// read through the loader's mirror source. When its manifest cannot be read at
// boot the island boots on the built-in example library instead, so an island
// shipped before its library still opens designs; that is logged, never fatal,
// and never reaches the host (no event, no state).
//
// Nothing is fetched until KiCad asks (LIBRARY.md "The client", measured
// 2026-10-07): neither frame enumerates a library at boot, but a chooser (the
// symbol chooser, the power chooser, the footprint chooser) enumerates EVERY
// library of its kind, one bridge crossing at a time, and appears only when
// the last one is in. So the first enumerate of a kind starts that kind's
// warm-up, several bundles at a time; the serialized crossings that follow
// each wait only for their own bundle, which the warm-up already has in
// flight. The gate holds nothing, so a crossing is never slower than without it.
import { mirrorLibsSource, type MirrorLibsSource } from '../loader/src/wasm/libs/mirror-source';
import type { LibPresyncProgress, LibsSource } from '../loader/src/wasm/libs/source';
import { staticLibsSource } from '../loader/src/wasm/libs/static-source';

/** Bundles fetched at once by the warm-up (PCBJam's presync uses 8). */
export const WARM_UP_CONCURRENCY = 8;

/** The tag directory of the mirror, on the island origin. */
export function libsBase(tag: string): string {
  return `/libs/${encodeURIComponent(tag)}/`;
}

export interface LibsChoice {
  source: LibsSource;
  /** The mirror source when its manifest was read, null on the example library. */
  mirror: MirrorLibsSource | null;
}

/** The mirror when its manifest reads, else the example library. Never rejects. */
export async function chooseLibs(mirror: MirrorLibsSource, log: (msg: string) => void, fallback: () => LibsSource = staticLibsSource): Promise<LibsChoice> {
  try {
    await mirror.ready();
    return { source: mirror, mirror };
  } catch (err) {
    log(`[libs] the library mirror could not be read (${err instanceof Error ? err.message : String(err)}); booting on the built-in example library`);
    return { source: fallback(), mirror: null };
  }
}

/** Starts the manifest read now (it runs beside the browser probe) and resolves with the source boot uses. */
export function islandLibs(tag: string, log: (msg: string) => void): Promise<LibsChoice> {
  return chooseLibs(mirrorLibsSource({ base: libsBase(tag), tag, log }), log);
}

/**
 * The provider's enumerate gate for the mirror: the first enumerate of a kind
 * starts `presync` for that kind (once per kind per session); every call
 * resolves at once. The warm-up never rejects and stops between bundles once
 * `signal` aborts. `onSettled` (tests) hears each kind's warm-up end.
 */
export function warmUpOnEnumerate(
  source: Pick<LibsSource, 'presync'>,
  log: (msg: string) => void,
  signal?: AbortSignal,
  onSettled?: (kind: string) => void,
): (kind: string) => Promise<void> {
  const started = new Set<string>();
  return (kind) => {
    if (!started.has(kind) && source.presync != null && !(signal?.aborted ?? false)) {
      started.add(kind);
      const t0 = performance.now();
      let last: LibPresyncProgress | null = null;
      void source
        .presync({ kind, concurrency: WARM_UP_CONCURRENCY, signal, onProgress: (p) => { last = p; } })
        .catch(() => undefined)
        .then(() => {
          const p = last as LibPresyncProgress | null;
          log(`[libs] ${kind} warm-up ${signal?.aborted ? 'stopped' : 'done'}: ${p?.done ?? 0} of ${p?.total ?? 0} libraries in ${Math.round(performance.now() - t0)} ms`);
          onSettled?.(kind);
        });
    }
    return Promise.resolve();
  };
}
