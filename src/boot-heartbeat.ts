// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The loading heartbeat (ruling I25c). The host bounds the boot by inactivity:
// it restarts its ready timer on every ev.state before ev.ready. A single
// `booting` event would let a slow engine fetch time out while the bar still
// moves, so while the engine loads the island repeats `booting` with the
// whole percent loaded as its detail (digits only, the island's own
// string), at most once every HEARTBEAT_MS.

/** The least time between two heartbeat events. */
export const HEARTBEAT_MS = 2000;

/**
 * A throttle over the loader's onProgress(loaded, total): each call answers the
 * detail to emit now (a whole percent, 0 to 100, as digits) or null. The first
 * tick with a known total is emitted; after that one per interval. Neither the
 * first nor the 100 percent tick is promised to the host.
 */
export function bootHeartbeat(intervalMs: number = HEARTBEAT_MS): (loaded: number, total: number, now: number) => string | null {
  let last = Number.NEGATIVE_INFINITY;
  return (loaded, total, now) => {
    if (!(total > 0) || !Number.isFinite(loaded) || !Number.isFinite(now)) return null;
    if (now - last < intervalMs) return null;
    last = now;
    return String(Math.min(100, Math.max(0, Math.floor((loaded / total) * 100))));
  };
}
