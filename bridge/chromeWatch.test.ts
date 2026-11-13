// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChromeWatch } from './chromeWatch';

const SETTLE = 100;
const POLL = 10;

/**
 * A frame whose chrome the test shows and the watch hides: `hide` hides it
 * (unless `stuck`), `ended` is what the responder tells the watch (the frame
 * closed, the chrome meant shown, the engine stopped). `sleeping` counts the
 * waits pending at once: one watch never has two.
 */
function fakeFrame() {
  const f = { shown: false, stuck: false, ended: false, hides: 0, sleeping: 0, mostSleeping: 0, reads: 0 };
  const watch = new ChromeWatch({
    visible: () => { f.reads += 1; return f.shown; },
    hide: async () => { f.hides += 1; if (!f.stuck) f.shown = false; },
    ended: () => f.ended,
    settleMs: () => SETTLE,
    pollMs: () => POLL,
    sleep: (ms) => {
      f.sleeping += 1;
      f.mostSleeping = Math.max(f.mostSleeping, f.sleeping);
      return new Promise<void>((r) => setTimeout(() => { f.sleeping -= 1; r(); }, ms));
    },
    now: () => Date.now(),
  });
  return { f, watch };
}

describe('ChromeWatch', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('hides the chrome each time it shows inside the window, then ends by itself', async () => {
    const { f, watch } = fakeFrame();
    expect(watch.running).toBe(false);
    watch.start();
    expect(watch.running).toBe(true);
    await vi.advanceTimersByTimeAsync(25);
    expect(f.hides).toBe(0);   // nothing showed: nothing was hidden
    f.shown = true;
    await vi.advanceTimersByTimeAsync(POLL);
    expect(f.shown).toBe(false);
    expect(f.hides).toBe(1);
    f.shown = true;
    await vi.advanceTimersByTimeAsync(POLL);
    expect(f.hides).toBe(2);
    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(watch.running).toBe(false);
    // The window is over: what shows now is the host's to hide (chrome.show).
    const reads = f.reads;
    f.shown = true;
    await vi.advanceTimersByTimeAsync(5 * SETTLE);
    expect(f.hides).toBe(2);
    expect(f.reads).toBe(reads);
    expect(f.shown).toBe(true);
  });

  it('a start while one runs gives it a whole window again and never runs a second watch', async () => {
    const { f, watch } = fakeFrame();
    f.stuck = true;   // the bar stays up: every read hides again
    f.shown = true;
    watch.start();
    await vi.advanceTimersByTimeAsync(60);
    watch.start();
    watch.start();
    await vi.advanceTimersByTimeAsync(60);
    expect(watch.running).toBe(true);   // 120 ms after the first start: the second one's window
    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(watch.running).toBe(false);
    expect(f.mostSleeping).toBe(1);
    // One read every POLL from the first start to the last start's end, never twice as many.
    expect(f.hides).toBeGreaterThanOrEqual(15);
    expect(f.hides).toBeLessThanOrEqual(17);
  });

  it('ends at once when told to (the frame closed, the chrome meant shown, the engine stopped) and hides nothing after', async () => {
    const { f, watch } = fakeFrame();
    watch.start();
    await vi.advanceTimersByTimeAsync(15);
    f.ended = true;
    f.shown = true;   // chrome.show { on: true } showed it: it is the host's
    await vi.advanceTimersByTimeAsync(POLL);
    expect(watch.running).toBe(false);
    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(f.hides).toBe(0);
    expect(f.shown).toBe(true);
    // Never started while it is to end.
    watch.start();
    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(f.hides).toBe(0);
    expect(f.sleeping).toBe(0);
  });

  it('a hide that throws ends the watch quietly, and a later start watches again', async () => {
    const { f } = fakeFrame();
    let fail = true;
    const watch = new ChromeWatch({
      visible: () => f.shown,
      hide: async () => { if (fail) throw new Error('the engine is gone'); f.shown = false; },
      ended: () => false,
      settleMs: () => SETTLE,
      pollMs: () => POLL,
      sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
      now: () => Date.now(),
    });
    f.shown = true;
    watch.start();
    await vi.advanceTimersByTimeAsync(2 * POLL);
    expect(watch.running).toBe(false);
    expect(f.shown).toBe(true);
    fail = false;
    watch.start();
    await vi.advanceTimersByTimeAsync(2 * POLL);
    expect(f.shown).toBe(false);
    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(watch.running).toBe(false);
  });
});
