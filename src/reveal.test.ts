// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { describe, expect, it } from 'vitest';
import main from './main.ts?raw';
import { hideChromeThenReveal, REVEAL_BOUND_MS, STAGE_PAINT_CALLS, watchStagePaint, type RevealDeps } from './reveal';

/** A fake engine and stage: the hide is recorded, paints and frames are run by hand. */
function fakeStage(opts: { shown?: boolean | null; watchable?: boolean; paintsInsideHide?: boolean } = {}) {
  const log: string[] = [];
  let painted: (() => void) | null = null;
  let watching = false;
  const frames: Array<() => void> = [];
  let timer: { cb: () => void; ms: number } | null = null;
  const deps: RevealDeps = {
    chromeShown: () => (opts.shown === undefined ? true : opts.shown),
    hideChrome: () => {
      log.push('hide');
      // A paint inside the hide's own task (the synchronous size event) is not the new layout.
      if (opts.paintsInsideHide && watching) painted?.();
    },
    watchPaint: (cb) => {
      if (opts.watchable === false) return false;
      watching = true;
      painted = cb;
      log.push('watch');
      return () => { watching = false; log.push('unwatch'); };
    },
    nextFrame: (cb) => { frames.push(cb); },
    timer: (cb, ms) => { timer = { cb, ms }; return () => { timer = null; log.push('untimer'); }; },
    reveal: () => { log.push('reveal'); },
  };
  return {
    deps,
    log,
    /** The engine's loop turns and paints the stage. */
    paint: () => { if (watching) painted?.(); },
    frame: () => { const f = frames.shift(); f?.(); },
    fireTimer: () => timer?.cb(),
    timerMs: () => timer?.ms ?? null,
  };
}

describe('hideChromeThenReveal', () => {
  it('keeps the screen up after the hide until the engine has painted, then reveals on the next frame', async () => {
    const s = fakeStage();
    const done = hideChromeThenReveal(s.deps);
    // The regression (2026-11-17): the screen came down in the hide's own task,
    // over a stage still holding KiCad's chrome as last painted.
    expect(s.log).toEqual(['hide', 'watch']);
    s.frame();                       // frames pass while the engine's loop is held
    expect(s.log).not.toContain('reveal');
    s.paint();
    expect(s.log).not.toContain('reveal');   // composited with the hide, not before the paint lands
    s.frame();
    await expect(done).resolves.toBe('painted');
    expect(s.log).toEqual(['hide', 'watch', 'unwatch', 'untimer', 'reveal']);
  });

  it('watches only after the hide returned, so a paint inside the hide does not count', async () => {
    const s = fakeStage({ paintsInsideHide: true });
    const done = hideChromeThenReveal(s.deps);
    s.frame();
    expect(s.log).not.toContain('reveal');
    s.paint();
    s.frame();
    await expect(done).resolves.toBe('painted');
  });

  it('reveals at once when the chrome never showed (nothing of it was painted)', async () => {
    const s = fakeStage({ shown: false });
    await expect(hideChromeThenReveal(s.deps)).resolves.toBe('at_once');
    expect(s.log).toEqual(['hide', 'reveal']);
  });

  it('waits for a paint when the engine cannot say (no kicadChromeShown)', async () => {
    const s = fakeStage({ shown: null });
    const done = hideChromeThenReveal(s.deps);
    expect(s.log).toEqual(['hide', 'watch']);
    s.paint();
    s.frame();
    await expect(done).resolves.toBe('painted');
  });

  it('reveals at once when the stage cannot be watched', async () => {
    const s = fakeStage({ watchable: false });
    await expect(hideChromeThenReveal(s.deps)).resolves.toBe('at_once');
    expect(s.log).toEqual(['hide', 'reveal']);
  });

  it('reveals at its bound when no paint ever comes, once', async () => {
    const s = fakeStage();
    const done = hideChromeThenReveal(s.deps);
    expect(s.timerMs()).toBe(REVEAL_BOUND_MS);
    s.fireTimer();
    await expect(done).resolves.toBe('bound');
    s.paint();
    s.frame();
    expect(s.log.filter((l) => l === 'reveal')).toHaveLength(1);
  });

  it('still reveals when the hide throws', async () => {
    const s = fakeStage();
    s.deps.hideChrome = () => { throw new Error('engine'); };
    const done = hideChromeThenReveal(s.deps);
    s.paint();
    s.frame();
    await expect(done).resolves.toBe('painted');
  });
});

/** A stand in for a CanvasRenderingContext2D: the paint calls live on its prototype, as in a browser. */
function fakeContext() {
  const calls: string[] = [];
  class Ctx {}
  for (const name of STAGE_PAINT_CALLS) {
    (Ctx.prototype as Record<string, unknown>)[name] = function () { calls.push(name); return name; };
  }
  (Ctx.prototype as Record<string, unknown>).measureText = () => ({ width: 1 });
  return { ctx: new Ctx() as unknown as CanvasRenderingContext2D, calls, proto: Ctx.prototype };
}

describe('watchStagePaint', () => {
  it('reports the first paint call once, still draws it, and puts the context back', () => {
    const { ctx, calls, proto } = fakeContext();
    let seen = 0;
    const stop = watchStagePaint(ctx, () => { seen++; });
    expect(stop).not.toBe(false);
    expect((ctx as unknown as { fillRect: () => string }).fillRect()).toBe('fillRect');
    (ctx as unknown as { drawImage: () => void }).drawImage();
    expect(seen).toBe(1);
    expect(calls).toEqual(['fillRect', 'drawImage']);
    for (const name of STAGE_PAINT_CALLS) expect(Object.prototype.hasOwnProperty.call(ctx, name)).toBe(false);
    expect((proto as Record<string, unknown>).fillRect).toBeTypeOf('function');
  });

  it('a measure is not a paint', () => {
    const { ctx } = fakeContext();
    let seen = 0;
    watchStagePaint(ctx, () => { seen++; });
    (ctx as unknown as { measureText: () => unknown }).measureText();
    expect(seen).toBe(0);
  });

  it('stop puts the context back with no paint seen', () => {
    const { ctx } = fakeContext();
    let seen = 0;
    const stop = watchStagePaint(ctx, () => { seen++; });
    if (stop) stop();
    (ctx as unknown as { fillRect: () => void }).fillRect();
    expect(seen).toBe(0);
    expect(Object.prototype.hasOwnProperty.call(ctx, 'fillRect')).toBe(false);
  });

  it('cannot watch a stage with no 2D context', () => {
    expect(watchStagePaint(null, () => {})).toBe(false);
  });
});

describe('main.ts', () => {
  // The boot's order is the fix: the screen never comes down in the hide's own task.
  it('hides the screen only through the reveal', () => {
    const calls = main.match(/hideScreens\(\)/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(main).toMatch(/reveal: \(\) => \{[^}]*hideScreens\(\)/);
    expect(main).not.toMatch(/kicadSetChrome\?\.\(false\);[^\n]*\n[^\n]*\n?\s*hideScreens\(\)/);
  });
});
