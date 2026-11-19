// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { describe, expect, it } from 'vitest';
import main from './main.ts?raw';
import {
  BOOT_INPUT, bootsCanvasOnly, DOCUMENT_BOUND_MS, GL_DRAW_CALLS, hideChromeThenReveal, NO_DOCUMENT_GRACE_MS, REVEAL_BOUND_MS, REVEAL_POLL_MS,
  setBootInput, STAGE_PAINT_CALLS, watchStageGl, watchStagePaint, type RevealDeps, type RevealWay,
} from './reveal';

interface StageOpts {
  shown?: boolean | null;
  /** The 2D stage can be watched. */
  watchable?: boolean;
  /** There is WebGL to watch. */
  gl?: boolean;
  document?: boolean;
  busy?: boolean;
  /** The engine's marker kicadBootCanvasOnly answers true (engine run 15); 'throws' when reading it throws. */
  canvasOnly?: boolean | 'throws';
  /** kicadSetChrome(false) paints before it returns (a run 15 engine on a shown frame, nothing parked). */
  paintsOnHide?: boolean;
}

/**
 * A fake engine, stage and responder on a fake clock: the hide is recorded,
 * paints, WebGL frames, animation frames and time are run by hand.
 */
function fakeStage(opts: StageOpts = {}) {
  const log: string[] = [];
  let clock = 0;
  let painted: (() => void) | null = null;
  let drew: (() => void) | null = null;
  const frames: Array<() => void> = [];
  let timers: Array<{ at: number; cb: () => void; live: boolean }> = [];
  const state = { document: opts.document ?? false, busy: opts.busy ?? false };
  const deps: RevealDeps = {
    chromeShown: () => (opts.shown === undefined ? true : opts.shown),
    canvasOnly: () => {
      log.push('marker');
      if (opts.canvasOnly === 'throws') throw new Error('no marker');
      return opts.canvasOnly === true;
    },
    hideChrome: () => { log.push('hide'); if (opts.paintsOnHide === true) painted?.(); },
    watchPaint: (cb) => {
      if (opts.watchable === false) return false;
      painted = cb;
      log.push('watch');
      return () => { painted = null; };
    },
    watchGl: (cb) => {
      if (opts.gl === false) return false;
      drew = cb;
      return () => { drew = null; };
    },
    hasDocument: () => state.document,
    busy: () => state.busy,
    nextFrame: (cb) => { frames.push(cb); },
    timer: (cb, ms) => { const t = { at: clock + ms, cb, live: true }; timers.push(t); return () => { t.live = false; }; },
    now: () => clock,
    reveal: () => { log.push('reveal'); },
  };
  let way: RevealWay | null = null;
  const done = hideChromeThenReveal(deps).then((w) => { way = w; return w; });
  return {
    log, state, done,
    way: () => way,
    revealed: () => log.includes('reveal'),
    /** Animation frames asked for and not yet run. */
    framesAsked: () => frames.length,
    /** The engine's loop turns and paints the 2D stage. */
    paint: () => painted?.(),
    /** The engine draws a WebGL frame on show. */
    glFrame: () => drew?.(),
    frame: () => { const f = frames.shift(); f?.(); },
    /** Time passes; due timers run in order. */
    advance: (ms: number) => {
      const end = clock + ms;
      for (;;) {
        const due = timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (due == null) break;
        clock = due.at;
        due.live = false;
        due.cb();
      }
      clock = end;
      timers = timers.filter((t) => t.live);
    },
  };
}

describe('hideChromeThenReveal: an engine that boots canvas only (its marker)', () => {
  const marker = { shown: false, canvasOnly: true } as const;

  it('arms its watches before the hide, and never lifts in the hide\'s task: it first waits for the host\'s open', () => {
    const s = fakeStage({ ...marker, paintsOnHide: true });
    expect(s.log).toEqual(['marker', 'watch', 'hide']);
    s.advance(NO_DOCUMENT_GRACE_MS - REVEAL_POLL_MS);
    expect(s.revealed()).toBe(false);
  });

  it('nothing to open: the canvas only stage once no open came within the grace', async () => {
    const s = fakeStage({ ...marker, paintsOnHide: true });
    s.advance(NO_DOCUMENT_GRACE_MS);
    await expect(s.done).resolves.toBe('canvas');
  });

  it('an open arriving late within the grace (the harness fetches its files after ev.ready) keeps the screen', () => {
    const s = fakeStage({ ...marker, paintsOnHide: true });
    s.advance(NO_DOCUMENT_GRACE_MS - 2 * REVEAL_POLL_MS);
    s.state.busy = true;
    s.advance(DOCUMENT_BOUND_MS - REVEAL_POLL_MS);
    expect(s.revealed()).toBe(false);
  });

  it('a document opening keeps the screen through the load, its frames of the empty stage included', () => {
    const s = fakeStage({ ...marker, paintsOnHide: true });
    s.advance(REVEAL_POLL_MS);
    s.state.busy = true;                  // the host's open arrived
    s.glFrame();                          // drawn while its files are staged, before the document is held
    s.frame();
    s.advance(DOCUMENT_BOUND_MS - REVEAL_POLL_MS);
    expect(s.revealed()).toBe(false);
  });

  it('a WebGL frame drawn with no open in flight and nothing held is no document\'s frame', async () => {
    const s = fakeStage({ ...marker, paintsOnHide: true });
    s.advance(REVEAL_POLL_MS);
    s.state.busy = true;
    s.advance(REVEAL_POLL_MS);            // the document watch is armed once the open is seen
    s.state.busy = false;                 // the open ended with nothing held
    s.glFrame();
    expect(s.framesAsked()).toBe(0);
    s.advance(REVEAL_POLL_MS);
    await expect(s.done).resolves.toBe('no_document');
  });

  it('then lifts on the frame after the first WebGL frame drawn with the document held, with no grace', async () => {
    const s = fakeStage({ ...marker, paintsOnHide: true });
    s.state.busy = true;
    s.advance(REVEAL_POLL_MS);
    s.state.document = true;
    s.state.busy = false;
    s.advance(REVEAL_POLL_MS);
    expect(s.revealed()).toBe(false);     // held, nothing drawn yet
    s.glFrame();
    expect(s.revealed()).toBe(false);     // composited first
    s.frame();
    await expect(s.done).resolves.toBe('drawn');
    expect(s.log.filter((l) => l === 'reveal')).toHaveLength(1);
  });

  it('watches from the canvas frame: an empty stage frame lifts nothing, the document\'s frame before any poll ran does', async () => {
    const s = fakeStage({ ...marker, paintsOnHide: true });
    s.glFrame();                          // the empty stage, nothing asked yet
    expect(s.framesAsked()).toBe(0);
    s.state.document = true;              // the open arrived and loaded, holding the thread: no poll ran
    s.glFrame();                          // its drawing
    s.frame();
    await expect(s.done).resolves.toBe('drawn');
  });

  it('an open in flight at the canvas frame is a document opening too', async () => {
    const s = fakeStage({ ...marker, paintsOnHide: true, busy: true });
    s.glFrame();
    s.advance(NO_DOCUMENT_GRACE_MS * 3);
    expect(s.revealed()).toBe(false);
    s.state.document = true;
    s.glFrame();
    s.frame();
    await expect(s.done).resolves.toBe('drawn');
  });

  it('an open that ends with nothing held lifts the screen then', async () => {
    const s = fakeStage({ ...marker, paintsOnHide: true });
    s.state.busy = true;
    s.advance(REVEAL_POLL_MS);
    s.state.busy = false;
    s.advance(REVEAL_POLL_MS);
    await expect(s.done).resolves.toBe('no_document');
  });

  it('a document that never draws: the bound', async () => {
    const s = fakeStage({ ...marker, paintsOnHide: true, busy: true });
    s.advance(DOCUMENT_BOUND_MS - REVEAL_POLL_MS);
    expect(s.revealed()).toBe(false);
    s.advance(REVEAL_POLL_MS);
    await expect(s.done).resolves.toBe('bound');
  });

  it('a paint the hide skipped (an engine call parked): the grace starts at the next paint', async () => {
    const s = fakeStage({ ...marker });
    s.advance(NO_DOCUMENT_GRACE_MS * 2);
    expect(s.revealed()).toBe(false);
    s.paint();
    s.advance(NO_DOCUMENT_GRACE_MS);
    await expect(s.done).resolves.toBe('canvas');
  });

  it('a WebGL frame before any 2D paint is the canvas frame too', async () => {
    const s = fakeStage({ ...marker });
    s.glFrame();
    s.advance(NO_DOCUMENT_GRACE_MS);
    await expect(s.done).resolves.toBe('canvas');
  });

  it('with nothing to watch, the grace runs from the hide', async () => {
    const s = fakeStage({ ...marker, watchable: false, gl: false });
    expect(s.log).toEqual(['marker', 'hide']);
    s.advance(NO_DOCUMENT_GRACE_MS);
    await expect(s.done).resolves.toBe('canvas');
  });

  it('reveals at the bound when the engine never draws', async () => {
    const s = fakeStage({ ...marker });
    s.advance(REVEAL_BOUND_MS - 1);
    expect(s.revealed()).toBe(false);
    s.advance(1);
    await expect(s.done).resolves.toBe('bound');
  });

  it('a marker with the chrome shown (the input was not read): every wait of an older engine stands', () => {
    const s = fakeStage({ shown: true, canvasOnly: true, document: true });
    expect(s.log).toEqual(['hide', 'watch']);
    s.paint();
    s.frame();
    s.advance(3_000);
    expect(s.revealed()).toBe(false);   // still waiting for the first WebGL frame
  });

  it('no marker, or a marker read that throws: the older engine\'s waits, untouched', async () => {
    for (const canvasOnly of [false, 'throws'] as const) {
      const s = fakeStage({ shown: false, canvasOnly, document: true, paintsOnHide: true });
      expect(s.log).toEqual(['marker', 'hide']);
      s.frame();
      s.advance(3_000);
      expect(s.revealed()).toBe(false);   // a design waits for its first WebGL frame, paint or none
      s.glFrame();
      s.frame();
      await expect(s.done).resolves.toBe('drawn');
    }
  });
});

describe('the start-up input and the marker read', () => {
  it('sets window.kicadBoot to { chrome: false }, a fresh object each boot', () => {
    const a: { kicadBoot?: unknown } = {};
    const b: { kicadBoot?: unknown } = {};
    setBootInput(a);
    setBootInput(b);
    expect(a.kicadBoot).toEqual({ chrome: false });
    expect(a.kicadBoot).not.toBe(b.kicadBoot);
    expect(Object.isFrozen(a.kicadBoot)).toBe(false);
    expect(BOOT_INPUT).toEqual({ chrome: false });
  });

  it('reads the marker only as the export answering exactly true', () => {
    expect(bootsCanvasOnly({ kicadBootCanvasOnly: () => true })).toBe(true);
    expect(bootsCanvasOnly({ kicadBootCanvasOnly: () => false })).toBe(false);
    expect(bootsCanvasOnly({ kicadBootCanvasOnly: () => 1 })).toBe(false);
    expect(bootsCanvasOnly({ kicadBootCanvasOnly: () => 'yes' })).toBe(false);
    expect(bootsCanvasOnly({ kicadBootCanvasOnly: true })).toBe(false);
    expect(bootsCanvasOnly({ kicadBootCanvasOnly: () => { throw new Error('trap'); } })).toBe(false);
    expect(bootsCanvasOnly({ kicadChromeShown: () => false })).toBe(false);   // run 14
    expect(bootsCanvasOnly(null)).toBe(false);
    expect(bootsCanvasOnly(undefined)).toBe(false);
  });

  it('calls the export on the engine module (embind binds no this, but a method may need it)', () => {
    const mod = { ok: true, kicadBootCanvasOnly(this: { ok: boolean }) { return this.ok; } };
    expect(bootsCanvasOnly(mod)).toBe(true);
  });
});

describe('hideChromeThenReveal: KiCad\'s chrome', () => {
  it('never lifts in the hide\'s own task, nor before the engine painted (the stale chrome, 2026-11-17)', () => {
    const s = fakeStage({ document: true });
    expect(s.log).toEqual(['hide', 'watch']);
    s.frame();
    s.advance(5_000);
    expect(s.revealed()).toBe(false);
  });

  it('reveals at the paint bound when the engine never paints again', async () => {
    const s = fakeStage();
    s.advance(REVEAL_BOUND_MS);
    await expect(s.done).resolves.toBe('bound');
    expect(s.log.filter((l) => l === 'reveal')).toHaveLength(1);
  });
});

describe('hideChromeThenReveal: the first WebGL frame (no beige)', () => {
  it('a design: stays up after the canvas only paint, the wx window still beige, until the first WebGL frame, composited', async () => {
    const s = fakeStage({ document: true });
    s.paint();
    s.frame();
    s.advance(3_000);                 // the open still loading at 4x CPU
    expect(s.revealed()).toBe(false);
    s.glFrame();
    expect(s.revealed()).toBe(false); // on the frame after the draw, not before it is composited
    s.frame();
    await expect(s.done).resolves.toBe('drawn');
  });

  it('an open in flight (no document yet) counts as a document', () => {
    const s = fakeStage({ busy: true });
    s.paint();
    s.frame();
    s.advance(NO_DOCUMENT_GRACE_MS * 3);
    expect(s.revealed()).toBe(false);
  });

  it('a first WebGL frame before the paint ends the wait too (it covers the whole stage)', async () => {
    const s = fakeStage({ document: true });
    s.glFrame();
    s.frame();
    await expect(s.done).resolves.toBe('drawn');
  });

  it('a frame with no document and nothing asked shows its stage after the grace', async () => {
    const s = fakeStage();
    s.paint();
    s.frame();
    s.advance(NO_DOCUMENT_GRACE_MS - REVEAL_POLL_MS);
    expect(s.revealed()).toBe(false);
    s.advance(REVEAL_POLL_MS);
    await expect(s.done).resolves.toBe('no_document');
  });

  it('an open arriving within the grace keeps the screen up for its first frame', async () => {
    const s = fakeStage();
    s.paint();
    s.frame();
    s.advance(NO_DOCUMENT_GRACE_MS / 2);
    s.state.busy = true;
    s.advance(NO_DOCUMENT_GRACE_MS * 2);
    s.state.busy = false;
    s.state.document = true;
    s.advance(NO_DOCUMENT_GRACE_MS * 2);
    expect(s.revealed()).toBe(false);
    s.glFrame();
    s.frame();
    await expect(s.done).resolves.toBe('drawn');
  });

  it('a document whose WebGL never draws (a context lost or never made) cannot hang the screen', async () => {
    const s = fakeStage({ document: true });
    s.paint();
    s.frame();
    s.advance(DOCUMENT_BOUND_MS - REVEAL_POLL_MS);
    expect(s.revealed()).toBe(false);
    s.advance(REVEAL_POLL_MS);
    await expect(s.done).resolves.toBe('bound');
  });

  it('with no WebGL to watch the canvas only paint is enough', async () => {
    const s = fakeStage({ gl: false, document: true });
    s.paint();
    s.frame();
    await expect(s.done).resolves.toBe('painted');
  });

  it('a chrome that never showed skips the paint and waits only for the first frame', async () => {
    const s = fakeStage({ shown: false, document: true });
    expect(s.log.filter((l) => l !== 'marker')).toEqual(['hide']);
    s.advance(1_000);
    expect(s.revealed()).toBe(false);
    s.glFrame();
    s.frame();
    await expect(s.done).resolves.toBe('drawn');
  });

  it('a stage that cannot be watched waits only for the first frame', async () => {
    const s = fakeStage({ watchable: false, document: true });
    s.glFrame();
    s.frame();
    await expect(s.done).resolves.toBe('drawn');
  });

  it('reveals once, whatever comes after', async () => {
    const s = fakeStage({ document: true });
    s.glFrame();
    s.frame();
    await s.done;
    s.paint();
    s.frame();
    s.advance(REVEAL_BOUND_MS * 2);
    expect(s.log.filter((l) => l === 'reveal')).toHaveLength(1);
  });

  it('the bounds are the measured ones', () => {
    // The paint to the first frame measured 0 to 0.25 s at full speed and 1.4 to 3.0 s at 4x CPU.
    expect(DOCUMENT_BOUND_MS).toBeGreaterThanOrEqual(2 * 3_000);
    expect(NO_DOCUMENT_GRACE_MS).toBeLessThanOrEqual(1_500);
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

  it('cannot watch a stage with no 2D context', () => {
    expect(watchStagePaint(null, () => {})).toBe(false);
  });
});

/** A stand in for a WebGL context class: draws recorded, the bound framebuffer settable. */
function fakeGl() {
  const calls: string[] = [];
  class Gl { FRAMEBUFFER_BINDING = 0x8ca6; fb: unknown = null; constructor(public canvas: unknown) {} getParameter(p: number) { return p === 0x8ca6 ? this.fb : null; } }
  const originals: Record<string, unknown> = {};
  for (const name of GL_DRAW_CALLS) {
    const f = function (this: Gl) { calls.push(name); };
    (Gl.prototype as unknown as Record<string, unknown>)[name] = f;
    originals[name] = f;
  }
  return { Gl, calls, originals };
}

describe('watchStageGl', () => {
  it('a draw into an offscreen framebuffer or on a hidden canvas is not the picture; one into the shown canvas is', () => {
    const { Gl, calls, originals } = fakeGl();
    const shown = { id: 'stage' };
    const hidden = { id: 'other' };
    let seen = 0;
    const stop = watchStageGl([Gl.prototype], (c) => c === shown, () => { seen++; });
    expect(stop).not.toBe(false);
    const gl = new Gl(shown) as unknown as { fb: unknown; drawElements(): void; drawArrays(): void };
    gl.fb = {};                       // KiCad's layers draw into framebuffers first
    gl.drawElements();
    (new Gl(hidden) as unknown as { drawArrays(): void }).drawArrays();
    expect(seen).toBe(0);
    gl.fb = null;                     // the composite onto the canvas
    gl.drawArrays();
    gl.drawArrays();
    expect(seen).toBe(1);
    expect(calls).toEqual(['drawElements', 'drawArrays', 'drawArrays', 'drawArrays']);
    for (const name of GL_DRAW_CALLS) expect((Gl.prototype as unknown as Record<string, unknown>)[name]).toBe(originals[name]);
  });

  it('stop puts the prototypes back with no draw seen; nothing to wrap is no watch', () => {
    const { Gl, originals } = fakeGl();
    const stop = watchStageGl([Gl.prototype, null, undefined], () => true, () => {});
    if (stop) stop();
    for (const name of GL_DRAW_CALLS) expect((Gl.prototype as unknown as Record<string, unknown>)[name]).toBe(originals[name]);
    expect(watchStageGl([undefined], () => true, () => {})).toBe(false);
  });
});

describe('main.ts', () => {
  it('sets the start-up input before the engine boots, and reads the marker for the reveal', () => {
    const input = main.indexOf('setBootInput(window);');
    const boot = main.indexOf('await bootKicadTool(');
    expect(input).toBeGreaterThan(0);
    expect(boot).toBeGreaterThan(input);
    expect(main.match(/setBootInput\(/g) ?? []).toHaveLength(1);
    expect(main).toMatch(/canvasOnly: \(\) => bootsCanvasOnly\(tool\.Module\)/);
  });

  // The boot's order is the fix: the screen never comes down in the hide's own task.
  it('hides the screen only through the reveal, which watches the 2D stage and the WebGL stage', () => {
    expect(main.match(/hideScreens\(\)/g) ?? []).toHaveLength(1);
    expect(main).toMatch(/reveal: \(\) => \{[^}]*hideScreens\(\)/);
    expect(main).toMatch(/watchGl: \(drew\) => watchStageGl\(/);
    expect(main).toMatch(/hasDocument: \(\) => responder\.hasDocument\(\)/);
  });
});
