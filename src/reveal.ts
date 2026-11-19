// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The canvas only boot's reveal (spec D16: KiCad's menu bar, toolbars, panes and
// status bar never show). KiCad comes up with its chrome laid out and painted
// under the island's loading screen; kicadSetChrome(false) hides it and lays
// the frame out again before it returns, but the engine draws its new layout
// only on a later turn of its own loop. Until then the stage canvas still holds
// the old picture: the toolbars, the Properties, Schematic Hierarchy and
// Selection Filter panes and the status bar. Hiding the screen in the same task
// showed that picture for as long as the loop was held back: the host's
// project.open, and on production the second engine's boot on the same thread
// (measured 2026-11-17 in the GPU window, the island frame at 4x CPU: 4.5 s on
// the local pair, cc22 the same). The screen now stays until the engine has
// painted after the hide, and then, for a document, until its first WebGL
// frame: between the two the stage is wx's own empty window, beige, KiCad's
// look and not ours (owner 2026-11-17: nothing of KiCad's before his engine).
//
// Engine run 15 boots canvas only (boot-e1): main.ts sets the start-up input
// BOOT_INPUT on window.kicadBoot before the engine's scripts load, the frame is
// created with its chrome already hidden (never laid out or painted), the
// empty drawing area is painted in the palette's background, never wx's beige,
// and kicadSetChrome paints before it returns. Such an engine says so with the
// marker kicadBootCanvasOnly; with it no chrome is waited out: a frame opening
// a document keeps the screen until that document's first drawn frame, and a
// frame with nothing to open shows its canvas only stage (revealCanvasOnly).
// Without it (an older engine, run 14 and before) every wait below stands as
// it was.

/** What the reveal reads and does; main.ts gives it the document, the engine and the responder. */
export interface RevealDeps {
  /** The engine's own read of its chrome (kicadChromeShown); null when this engine has no such read. */
  chromeShown(): boolean | null;
  /** The engine booted canvas only (its marker kicadBootCanvasOnly answers true); false for an older engine. */
  canvasOnly(): boolean;
  /** kicadSetChrome(false), and what else runs in the same task before the engine's loop turns (the focus click). */
  hideChrome(): void;
  /**
   * Calls `painted` the first time the engine draws on its stage canvas after
   * this call returns. False when the stage cannot be watched (no 2D stage).
   * The returned function stops the watch.
   */
  watchPaint(painted: () => void): (() => void) | false;
  /**
   * Calls `drew` the first time the engine draws on the default framebuffer of
   * the WebGL canvas on show (its picture, composited at the next frame).
   * False when there is no WebGL to watch. The returned function stops the watch.
   */
  watchGl(drew: () => void): (() => void) | false;
  /** A document is open in the frame (responder.hasDocument). */
  hasDocument(): boolean;
  /** A request is in flight (responder.busy): an open on its way to the engine. */
  busy(): boolean;
  /** Runs `cb` at the next animation frame, so what was drawn is composited with the hide. */
  nextFrame(cb: () => void): void;
  /** A one shot timer; returns its cancel. */
  timer(cb: () => void, ms: number): () => void;
  /** The clock the waits are measured on, in ms. */
  now(): number;
  /** Hides the island's screen (main.ts skips it when a fatal screen or a teardown took the stage). */
  reveal(): void;
}

/**
 * How the screen came down: for an engine that boots canvas only, at its
 * canvas only stage when nothing is opened (`canvas`) or at the first WebGL
 * frame drawn with its document held (`drawn`); for an older engine on the first
 * WebGL frame (`drawn`), after the canvas only paint in a frame with no WebGL
 * to watch (`painted`), after that paint in a frame that holds no document and
 * is asked for none (`no_document`); or at a bound.
 */
export type RevealWay = 'canvas' | 'drawn' | 'painted' | 'no_document' | 'bound';

/**
 * The engine's start-up input (boot-e1), set on window.kicadBoot before the
 * engine's scripts load: boot with KiCad's chrome already hidden. An engine
 * before run 15 never reads it.
 */
export const BOOT_INPUT: Readonly<{ chrome: false }> = Object.freeze({ chrome: false });

/** Sets the start-up input on the frame's window, before the engine boots. */
export function setBootInput(win: object): void {
  (win as { kicadBoot?: unknown }).kicadBoot = { ...BOOT_INPUT };
}

/**
 * The engine's marker kicadBootCanvasOnly: true only when the export is there
 * and answers true (it read the input, its empty drawing area is the drawing's
 * background, its kicadSetChrome paints before it returns). Anything else,
 * a missing export or a throw included, is an older engine.
 */
export function bootsCanvasOnly(mod: unknown): boolean {
  if (mod == null || typeof mod !== 'object') return false;
  const fn = (mod as Record<string, unknown>).kicadBootCanvasOnly;
  if (typeof fn !== 'function') return false;
  try { return (fn as () => unknown).call(mod) === true; } catch { return false; }
}

/**
 * The longest the screen waits for the engine's canvas only paint. The paint
 * always comes (the hide changed the layout, so the whole frame is invalid);
 * the bound is there for an engine that never draws again.
 */
export const REVEAL_BOUND_MS = 20_000;

/**
 * After the canvas only paint, the longest the screen waits for the first
 * WebGL frame of a document that is open or on its way. Measured 2026-11-17 in
 * the GPU window on the example (the paint to the first frame): 0 to 0.25 s
 * at full speed, 1.4 to 3.0 s with the island at 4x CPU; the bound is about
 * two and a half times the slowest, for a context lost or never made.
 */
export const DOCUMENT_BOUND_MS = 8_000;

/**
 * After the canvas only paint, how long a frame with no document and no
 * request in flight stays covered before it shows its empty stage: a host
 * opens its document right after ev.ready, before the paint in every start
 * measured, so this only waits out an open sent a moment late. An engine that
 * boots canvas only shows its first canvas frame in the task that sends
 * ev.ready, before any open can arrive, so there this wait is how the frame
 * learns whether a document is coming (300 ms was too short: the harness's
 * Glasgow opens, fetched after ev.ready, came later, and the stage showed
 * empty before the drawing). No chrome is waited out there: that engine
 * never painted any.
 */
export const NO_DOCUMENT_GRACE_MS = 1_000;

/** How often the reveal reads the frame's document and requests while it waits for the first frame. */
export const REVEAL_POLL_MS = 100;

/**
 * Hides KiCad's chrome, then the island's screen once the engine has drawn its
 * canvas only layout and, for a document, its first WebGL frame in our
 * palette. Before that frame the stage is wx's own empty window, beige.
 * Resolves with how the screen came down.
 */
export function hideChromeThenReveal(deps: RevealDeps, boundMs: number = REVEAL_BOUND_MS): Promise<RevealWay> {
  // Read before the hide: a chrome that never showed was never painted.
  let shown: boolean | null = null;
  try { shown = deps.chromeShown(); } catch { shown = null; }
  // An engine that booted canvas only, and whose chrome is still held: nothing
  // of KiCad's was ever painted, so its first canvas frame is ours to show.
  let canvasOnly = false;
  if (shown === false) { try { canvasOnly = deps.canvasOnly() === true; } catch { canvasOnly = false; } }
  if (canvasOnly) return revealCanvasOnly(deps, boundMs);
  try { deps.hideChrome(); } catch { /* chrome stays; the page can still send chrome.show */ }
  return new Promise<RevealWay>((resolve) => {
    let done = false;
    const stops: Array<() => void> = [];
    const finish = (way: RevealWay): void => {
      if (done) return;
      done = true;
      for (const stop of stops.splice(0)) stop();
      deps.reveal();
      resolve(way);
    };
    // The first WebGL frame on show covers the whole stage, stale picture or
    // not: from the hide on it ends the wait, on the frame after it.
    let glDrew = false;
    const stopGl = deps.watchGl(() => {
      if (done || glDrew) return;
      glDrew = true;
      deps.nextFrame(() => finish('drawn'));
    });
    if (stopGl !== false) stops.push(stopGl);

    const afterPaint = (): void => {
      if (done || glDrew) return;
      if (stopGl === false) { finish('painted'); return; }
      const since = deps.now();
      let idleSince: number | null = null;
      const poll = (): void => {
        if (done || glDrew) return;
        const now = deps.now();
        let open = true;
        try { open = deps.hasDocument() || deps.busy(); } catch { open = true; }
        if (open) idleSince = null;
        else if (idleSince == null) idleSince = now;
        if (idleSince != null && now - idleSince >= NO_DOCUMENT_GRACE_MS) { finish('no_document'); return; }
        if (now - since >= DOCUMENT_BOUND_MS) { finish('bound'); return; }
        stops.push(deps.timer(poll, REVEAL_POLL_MS));
      };
      poll();
    };

    if (shown === false) { afterPaint(); return; }
    let painted = false;
    const stopPaint = deps.watchPaint(() => {
      if (done || painted) return;
      painted = true;
      deps.nextFrame(afterPaint);
    });
    if (stopPaint === false) { afterPaint(); return; }
    stops.push(stopPaint);
    stops.push(deps.timer(() => { if (!painted) finish('bound'); }, boundMs));
  });
}

/**
 * The reveal of an engine that boots canvas only (owner: a heavy load always
 * shows its loading animation, never a blank stage). The watches are armed
 * before the hide, so the paint kicadSetChrome(false) makes before it returns
 * is the first canvas frame (else the engine's next paint or WebGL frame).
 * Then: a frame that is opening a document (a request in flight or a document
 * held, within NO_DOCUMENT_GRACE_MS of that frame) keeps the screen until the
 * first WebGL frame drawn with the document held, and lifts it on the frame
 * after, with no further wait; a frame with nothing to open shows its canvas
 * only stage at NO_DOCUMENT_GRACE_MS. An open that ends with no document lifts
 * it then.
 */
function revealCanvasOnly(deps: RevealDeps, boundMs: number): Promise<RevealWay> {
  return new Promise<RevealWay>((resolve) => {
    let done = false;
    const stops: Array<() => void> = [];
    const finish = (way: RevealWay): void => {
      if (done) return;
      done = true;
      for (const stop of stops.splice(0)) stop();
      deps.reveal();
      resolve(way);
    };
    const read = (f: () => boolean): boolean => { try { return f(); } catch { return false; } };

    // The document's first frame: a WebGL frame on the stage drawn with the
    // document held. A frame drawn before (the empty stage, before the open
    // arrived or while its files are staged) is no document's, so the watch
    // goes on.
    let drawn = false;
    const watchDocument = (): void => {
      const stop = deps.watchGl(() => {
        if (done || drawn) return;
        if (read(() => deps.hasDocument())) {
          drawn = true;
          deps.nextFrame(() => finish('drawn'));
        } else {
          watchDocument();
        }
      });
      if (stop !== false) stops.push(stop);
    };

    const afterCanvas = (): void => {
      if (done) return;
      const since = deps.now();
      let openedAt: number | null = null;
      // Armed now, not when a poll first sees the open: the open holds the
      // thread, and its first frame is drawn before a poll could run.
      watchDocument();
      const poll = (): void => {
        if (done || drawn) return;
        const now = deps.now();
        const doc = read(() => deps.hasDocument());
        const busy = read(() => deps.busy());
        if (openedAt == null && (doc || busy)) openedAt = now;
        if (openedAt != null) {
          if (!doc && !busy) { finish('no_document'); return; }   // the open ended with nothing held
          if (now - openedAt >= DOCUMENT_BOUND_MS) { finish('bound'); return; }
        } else if (now - since >= NO_DOCUMENT_GRACE_MS) {
          finish('canvas');
          return;
        }
        stops.push(deps.timer(poll, REVEAL_POLL_MS));
      };
      poll();
    };

    let hiding = true;
    let seen = false;
    const canvasStops: Array<() => void> = [];
    const canvasFrame = (): void => {
      if (done || seen) return;
      seen = true;
      for (const stop of canvasStops.splice(0)) stop();
      if (!hiding) afterCanvas();
    };
    const stopPaint = deps.watchPaint(canvasFrame);
    if (stopPaint !== false) canvasStops.push(stopPaint);
    const stopGl = deps.watchGl(canvasFrame);
    if (stopGl !== false) canvasStops.push(stopGl);
    try { deps.hideChrome(); } catch { /* the hold stays; the page can still send chrome.show */ }
    hiding = false;
    // The hide painted (whole now that it returned), or there is nothing to watch.
    if (seen || (stopPaint === false && stopGl === false)) { seen = true; afterCanvas(); return; }
    stops.push(() => { for (const stop of canvasStops.splice(0)) stop(); });
    stops.push(deps.timer(() => { if (!seen) finish('bound'); }, boundMs));
  });
}

/** The 2D calls wx.js paints the stage with (wx/wasm's wxDC); any one of them is a paint. */
export const STAGE_PAINT_CALLS = ['fillRect', 'clearRect', 'strokeRect', 'fill', 'stroke', 'fillText', 'strokeText', 'drawImage', 'putImageData'] as const;

/**
 * Watches the stage canvas's own 2D context (wx.js draws every window of the
 * top frame into #canvas): each paint call is wrapped on the context object
 * itself, never on the prototype, and put back at the first call or at stop.
 */
export function watchStagePaint(ctx: CanvasRenderingContext2D | null, painted: () => void): (() => void) | false {
  if (ctx == null) return false;
  const target = ctx as unknown as Record<string, unknown>;
  const wrapped: string[] = [];
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    for (const name of wrapped) delete target[name];
  };
  for (const name of STAGE_PAINT_CALLS) {
    const original = target[name];
    if (typeof original !== 'function') continue;
    if (Object.prototype.hasOwnProperty.call(target, name)) continue;   // never stack on another wrapper
    target[name] = function (this: unknown, ...args: unknown[]) {
      stop();
      painted();
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
    wrapped.push(name);
  }
  return wrapped.length > 0 ? stop : false;
}

/** The WebGL calls that draw (a clear alone is no picture). */
export const GL_DRAW_CALLS = ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements'] as const;

/** The part of a WebGL context the watch reads. */
interface GlLike { canvas: unknown; FRAMEBUFFER_BINDING: number; getParameter(p: number): unknown }

/**
 * Watches the WebGL contexts' draw calls (wrapped on the prototypes given,
 * put back at the first hit or at stop) for one into the default framebuffer
 * (the picture, not an offscreen layer) of a canvas `isStage` accepts.
 */
export function watchStageGl(protos: ReadonlyArray<object | null | undefined>, isStage: (canvas: unknown) => boolean, drew: () => void): (() => void) | false {
  const restore: Array<() => void> = [];
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    for (const r of restore.splice(0)) r();
  };
  for (const proto of protos) {
    if (proto == null) continue;
    const target = proto as Record<string, unknown>;
    for (const name of GL_DRAW_CALLS) {
      const original = target[name];
      if (typeof original !== 'function') continue;
      target[name] = function (this: GlLike, ...args: unknown[]) {
        const result = (original as (...a: unknown[]) => unknown).apply(this, args);
        if (!stopped) {
          let hit = false;
          try { hit = this.getParameter(this.FRAMEBUFFER_BINDING) == null && isStage(this.canvas); } catch { hit = false; }
          if (hit) { stop(); drew(); }
        }
        return result;
      };
      restore.push(() => { target[name] = original; });
    }
  }
  return restore.length > 0 ? stop : false;
}
