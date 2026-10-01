// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { describe, expect, it, vi } from 'vitest';
import { installEngineTeardown, isShutdownError, MAX_PARKS_AFTER_KILL, SHUTDOWN_ERROR, teardownOnPagehide, type WxScheduler } from './teardown';

const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/**
 * The wx scheduler's park contract, reduced: a park waits on its promise and
 * resumes the activation with that promise's outcome; the activation is
 * listed in _suspended while it waits.
 */
function fakeScheduler(opts: { terminal?: boolean } = {}) {
  let seq = 0;
  const s = {
    _suspended: new Map<unknown, { id: unknown }>(),
    _resumeReady: [] as unknown[],
    _windowLive: null as { id: unknown } | null,
    dead: false,
    terminal: opts.terminal === true,
    shutdown: vi.fn(function (this: { dead: boolean }) { this.dead = true; }),
    _suspendOn(p: Promise<unknown>) {
      const rec = { id: ++seq };
      s._suspended.set(rec.id, rec);
      // A trapped instance takes the wake but never resumes the activation (its pump is frozen).
      if (s.terminal) { p.catch(() => undefined); return new Promise(() => undefined); }
      return p.then((v) => { s._suspended.delete(rec.id); return v; }, (e) => { s._suspended.delete(rec.id); throw e; });
    },
    libctxSuspend(id: number, p: Promise<unknown>) {
      const rec = { id: `lc${id}` };
      s._suspended.set(rec.id, rec);
      return p.then((v) => { s._suspended.delete(rec.id); return v; }, (e) => { s._suspended.delete(rec.id); throw e; });
    },
  };
  return s;
}

function fakeWindow() {
  const listeners = new Map<string, Array<(e: unknown) => void>>();
  let timer = 0;
  let frame = 0;
  const cleared: number[] = [];
  const cancelled: number[] = [];
  const main = { replaceChildren: vi.fn() };
  const container = { replaceChildren: vi.fn() };
  const loseContext = vi.fn();
  const win = {
    addEventListener: (t: string, h: (e: unknown) => void) => { listeners.set(t, [...(listeners.get(t) ?? []), h]); },
    dispatch: (t: string, e: unknown) => { for (const h of listeners.get(t) ?? []) h(e); },
    setTimeout: (fn: () => void, ms: number) => { setTimeout(fn, ms); return ++timer; },
    clearTimeout: (id: number) => { cleared.push(id); },
    clearInterval: (id: number) => { cleared.push(id); },
    requestAnimationFrame: () => ++frame,
    cancelAnimationFrame: (id: number) => { cancelled.push(id); },
    document: { getElementById: (id: string) => (id === 'main-window' ? main : id === 'window-container' ? container : null) },
    PThread: { terminateAllThreads: vi.fn() },
    GL: { contexts: { 1: { GLctx: { getExtension: (n: string) => (n === 'WEBGL_lose_context' ? { loseContext } : null) } }, 2: null } },
    Module: { kicadOpenFile: () => undefined },
    FS: {},
    wxElementRegistry: {},
    kicadWebOpenTool: () => true,
  };
  return { win: win as unknown as Window & { __wxScheduler?: WxScheduler; dispatch: (t: string, e: unknown) => void } & Record<string, unknown>, cleared, cancelled, main, container, loseContext, bump: (n: number) => { timer += n; frame += n; } };
}

/** V8's own collector, exposed for the retention check (the node modules load by name: the type check has no node types). */
async function forceGc(): Promise<() => void> {
  const [v8, vm] = ['node:v8', 'node:vm'];
  const { setFlagsFromString } = (await import(/* @vite-ignore */ v8)) as { setFlagsFromString(flags: string): void };
  const { runInNewContext } = (await import(/* @vite-ignore */ vm)) as { runInNewContext(code: string): unknown };
  setFlagsFromString('--expose-gc');
  return runInNewContext('gc') as () => void;
}

describe('installEngineTeardown', () => {
  it('a live editor keeps nothing per park: a thousand self-settling parks leave no waiting rejecter and no retained promise', async () => {
    const { win } = fakeWindow();
    const t = installEngineTeardown(win);
    const s = fakeScheduler();
    // What the scheduler receives for each park: the guarded promise.
    const finalized = { n: 0 };
    const registry = new FinalizationRegistry(() => { finalized.n++; });
    const suspendOn = s._suspendOn;
    s._suspendOn = (p: Promise<unknown>) => { registry.register(p, null); return suspendOn(p); };
    win.__wxScheduler = s as unknown as WxScheduler;
    const N = 1000;
    for (let i = 0; i < N; i++) {
      // A frame park: it waits, then its frame comes.
      await expect(win.__wxScheduler!._suspendOn(new Promise((r) => setTimeout(() => r(i), 0)), 'frame', 0)).resolves.toBe(i);
    }
    expect(t.pendingParks()).toBe(0);
    // Every guarded promise is collectable once its park settled: none is held
    // by a promise that lives until the shutdown (a race against one would be).
    const gc = await forceGc();
    for (let round = 0; round < 20 && finalized.n < N; round++) { gc(); await settle(5); }
    expect(finalized.n).toBe(N);
    // The teardown is still live and still works.
    expect(t.started()).toBe(false);
  });

  it('shutdown still unwinds a park that is waiting, and empties the waiting set', async () => {
    const { win } = fakeWindow();
    const t = installEngineTeardown(win);
    const s = fakeScheduler();
    win.__wxScheduler = s as unknown as WxScheduler;
    for (let i = 0; i < 10; i++) await s._suspendOn(Promise.resolve(i));
    const parked = expect(s._suspendOn(new Promise(() => undefined))).rejects.toMatchObject({ name: SHUTDOWN_ERROR });
    expect(t.pendingParks()).toBe(1);
    await t.shutdown();
    await parked;
    expect(t.pendingParks()).toBe(0);
    expect(s._suspended.size).toBe(0);
  });

  it('wraps the scheduler the glue installs, and shutdown resumes every parked activation with the shutdown error', async () => {
    const { win } = fakeWindow();
    const t = installEngineTeardown(win);
    const s = fakeScheduler();
    win.__wxScheduler = s as unknown as WxScheduler;   // what the glue's pre-js does
    expect(win.__wxScheduler).toBe(s);
    const main = s._suspendOn(new Promise(() => undefined));          // main, parked on an animation frame that never comes
    const coroutine = s.libctxSuspend(2, new Promise(() => undefined));
    const outcomes = Promise.allSettled([main, coroutine]);
    expect(s._suspended.size).toBe(2);
    expect(t.started()).toBe(false);
    await t.shutdown();
    expect(t.started()).toBe(true);
    const [a, b] = await outcomes;
    expect(a.status).toBe('rejected');
    expect(b.status).toBe('rejected');
    expect(isShutdownError((a as PromiseRejectedResult).reason)).toBe(true);
    expect((a as PromiseRejectedResult).reason.name).toBe(SHUTDOWN_ERROR);
    expect(s._suspended.size).toBe(0);
    expect(s.shutdown).toHaveBeenCalledTimes(1);
  });

  it('a park that settles on its own before the shutdown resumes normally', async () => {
    const { win } = fakeWindow();
    installEngineTeardown(win);
    const s = fakeScheduler();
    win.__wxScheduler = s as unknown as WxScheduler;
    await expect(s._suspendOn(Promise.resolve(7))).resolves.toBe(7);
  });

  it('after the kill a park is refused at once, and past the cap it waits forever so a retry loop cannot spin', async () => {
    const { win } = fakeWindow();
    const t = installEngineTeardown(win);
    const s = fakeScheduler();
    win.__wxScheduler = s as unknown as WxScheduler;
    await t.shutdown();
    for (let i = 0; i < MAX_PARKS_AFTER_KILL; i++) {
      await expect(s._suspendOn(new Promise(() => undefined))).rejects.toMatchObject({ name: SHUTDOWN_ERROR });
    }
    let settled = false;
    void s._suspendOn(Promise.resolve(1)).finally(() => { settled = true; });
    await settle(10);
    expect(settled).toBe(false);
  });

  it('an engine still booting at the shutdown has its parks refused once its scheduler arrives', async () => {
    const { win } = fakeWindow();
    const t = installEngineTeardown(win);
    await t.shutdown();
    const s = fakeScheduler();
    win.__wxScheduler = s as unknown as WxScheduler;
    await expect(s._suspendOn(new Promise(() => undefined))).rejects.toMatchObject({ name: SHUTDOWN_ERROR });
  });

  it('releases the rest: pthreads, WebGL contexts, timers and frames, the engine globals and the stage', async () => {
    const { win, cleared, cancelled, main, container, loseContext, bump } = fakeWindow();
    bump(30);
    const t = installEngineTeardown(win);
    win.__wxScheduler = fakeScheduler() as unknown as WxScheduler;
    await t.shutdown();
    expect((win.PThread as { terminateAllThreads: () => void }).terminateAllThreads).toHaveBeenCalledTimes(1);
    expect(loseContext).toHaveBeenCalledTimes(1);
    for (const id of [1, 15, 30]) expect(cleared).toContain(id);
    for (const id of [1, 15, 30]) expect(cancelled).toContain(id);
    for (const k of ['Module', 'FS', 'wxElementRegistry', 'kicadWebOpenTool']) expect(win[k]).toBeUndefined();
    expect(main.replaceChildren).toHaveBeenCalledTimes(1);
    expect(container.replaceChildren).toHaveBeenCalledTimes(1);
  });

  it('runs once: a second shutdown answers the first run', async () => {
    const { win } = fakeWindow();
    const t = installEngineTeardown(win);
    const s = fakeScheduler();
    win.__wxScheduler = s as unknown as WxScheduler;
    const a = t.shutdown();
    const b = t.shutdown();
    expect(b).toBe(a);
    await a;
    expect(s.shutdown).toHaveBeenCalledTimes(1);
  });

  it('a trapped instance is not resumed: no wait for its parks, the rest is still released', async () => {
    const { win } = fakeWindow();
    const t = installEngineTeardown(win);
    const s = fakeScheduler({ terminal: true });
    win.__wxScheduler = s as unknown as WxScheduler;
    void s._suspendOn(new Promise(() => undefined));
    const t0 = Date.now();
    await t.shutdown();
    expect(Date.now() - t0).toBeLessThan(500);
    expect(s._suspended.size).toBe(1);
    expect((win.PThread as { terminateAllThreads: () => void }).terminateAllThreads).toHaveBeenCalled();
  });

  it('keeps the shutdown error off the console', () => {
    const { win } = fakeWindow();
    installEngineTeardown(win);
    const ours = { reason: Object.assign(new Error('x'), { name: SHUTDOWN_ERROR }), preventDefault: vi.fn() };
    const other = { reason: new Error('RuntimeError: unreachable'), preventDefault: vi.fn() };
    win.dispatch('unhandledrejection', ours);
    win.dispatch('unhandledrejection', other);
    expect(ours.preventDefault).toHaveBeenCalled();
    expect(other.preventDefault).not.toHaveBeenCalled();
  });
});

/**
 * The scheduler's turnstile, reduced: one resume at a time, and only while no
 * window is armed. A coroutine's end hook ends its window; main is untracked,
 * so its window stays armed after it unwinds (the case unwind() resets with a timer).
 */
function turnstileScheduler() {
  type Rec = { id: unknown; libctx?: boolean };
  type Gate = { reject: (e: unknown) => void };
  const s = {
    _suspended: new Map<unknown, Rec>(),
    _resumeReady: [] as Array<{ rec: Rec; gate: Gate; err: unknown }>,
    _windowLive: null as Rec | null,
    dead: false,
    terminal: false,
    shutdown: vi.fn(),
    resumed: [] as unknown[],
    pump() {
      if (s._windowLive != null) return;
      const next = s._resumeReady.shift();
      if (next == null) return;
      s._suspended.delete(next.rec.id);
      s._windowLive = next.rec;
      s.resumed.push(next.rec.id);
      next.gate.reject(next.err);          // the activation resumes with the error and unwinds
      if (next.rec.libctx === true) { s._windowLive = null; queueMicrotask(() => s.pump()); }
    },
    park(rec: Rec, p: Promise<unknown>): Promise<unknown> {
      s._suspended.set(rec.id, rec);
      return new Promise((_, reject) => {
        p.then(() => undefined, (err: unknown) => { s._resumeReady.push({ rec, gate: { reject }, err }); queueMicrotask(() => s.pump()); });
      });
    },
    _suspendOn(p: Promise<unknown>) { return s.park({ id: -1 }, p); },
    libctxSuspend(id: number, p: Promise<unknown>) { return s.park({ id: `lc${id}`, libctx: true }, p); },
  };
  return s;
}

describe('teardownOnPagehide', () => {
  it('in a frame being removed (no timer runs again) the kill alone unwinds both parks in microtasks; the timed steps never run', async () => {
    vi.useFakeTimers();
    try {
      const { win } = fakeWindow();
      const t = installEngineTeardown(win);
      teardownOnPagehide(win, t);
      const s = turnstileScheduler();
      win.__wxScheduler = s as unknown as WxScheduler;
      // The engine's order: the coroutine parked on its resume, then main on this frame.
      const outcomes = Promise.allSettled([
        win.__wxScheduler!.libctxSuspend!(2, new Promise(() => undefined), 0),
        win.__wxScheduler!._suspendOn(new Promise(() => undefined), 'frame', 0),
      ]);
      expect(t.pendingParks()).toBe(2);
      win.dispatch('pagehide', { persisted: false });
      let settled: PromiseSettledResult<unknown>[] | null = null;
      void outcomes.then((r) => { settled = r; });
      for (let i = 0; i < 50; i++) await Promise.resolve();   // microtasks only: timers are frozen
      expect(settled).not.toBeNull();
      expect(settled!.map((r) => r.status)).toEqual(['rejected', 'rejected']);
      expect(settled!.every((r) => isShutdownError((r as PromiseRejectedResult).reason))).toBe(true);
      expect(s.resumed).toEqual(['lc2', -1]);
      expect(s._suspended.size).toBe(0);
      expect(t.pendingParks()).toBe(0);
      // What waits on a timer did not run: the scheduler stop and the release after it.
      expect(s.shutdown).not.toHaveBeenCalled();
      expect((win.PThread as { terminateAllThreads: () => void }).terminateAllThreads).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('tears down when the frame goes for good, never on a pagehide into the back/forward cache', () => {
    const { win } = fakeWindow();
    const t = { shutdown: vi.fn(async () => undefined), started: () => false, pendingParks: () => 0 };
    teardownOnPagehide(win, t);
    win.dispatch('pagehide', { persisted: true });
    expect(t.shutdown).not.toHaveBeenCalled();
    win.dispatch('pagehide', { persisted: false });
    expect(t.shutdown).toHaveBeenCalledTimes(1);
  });
});
