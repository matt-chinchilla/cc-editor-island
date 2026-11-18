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
// painted after the hide.

/** What the reveal reads and does; main.ts gives it the document and the engine. */
export interface RevealDeps {
  /** The engine's own read of its chrome (kicadChromeShown); null when this engine has no such read. */
  chromeShown(): boolean | null;
  /** kicadSetChrome(false), and what else runs in the same task before the engine's loop turns (the focus click). */
  hideChrome(): void;
  /**
   * Calls `painted` the first time the engine draws on its stage canvas after
   * this call returns. False when the stage cannot be watched (no 2D stage).
   * The returned function stops the watch.
   */
  watchPaint(painted: () => void): (() => void) | false;
  /** Runs `cb` at the next animation frame, so what was drawn is composited with the hide. */
  nextFrame(cb: () => void): void;
  /** A one shot timer; returns its cancel. */
  timer(cb: () => void, ms: number): () => void;
  /** Hides the island's screen (main.ts skips it when a fatal screen or a teardown took the stage). */
  reveal(): void;
}

/** How the screen came down: at once (no chrome was ever painted, or the stage cannot be watched), after the engine painted, or at the bound. */
export type RevealWay = 'at_once' | 'painted' | 'bound';

/**
 * The longest the screen waits for the engine's paint. The paint always comes
 * (the hide changed the layout, so the whole frame is invalid); the bound is
 * there for an engine that never draws again, and gives the old behavior.
 */
export const REVEAL_BOUND_MS = 20_000;

/**
 * Hides KiCad's chrome, then the island's screen once the engine has drawn its
 * canvas only layout. Resolves with how the screen came down.
 */
export function hideChromeThenReveal(deps: RevealDeps, boundMs: number = REVEAL_BOUND_MS): Promise<RevealWay> {
  // Read before the hide: a chrome that never showed was never painted.
  let shown: boolean | null = null;
  try { shown = deps.chromeShown(); } catch { shown = null; }
  try { deps.hideChrome(); } catch { /* chrome stays; the page can still send chrome.show */ }
  if (shown === false) {
    deps.reveal();
    return Promise.resolve('at_once');
  }
  return new Promise<RevealWay>((resolve) => {
    let done = false;
    let stopWatch: (() => void) | false = false;
    let stopTimer: (() => void) | null = null;
    const finish = (way: RevealWay): void => {
      if (done) return;
      done = true;
      if (stopWatch !== false) stopWatch();
      stopTimer?.();
      deps.reveal();
      resolve(way);
    };
    stopWatch = deps.watchPaint(() => {
      if (done) return;
      deps.nextFrame(() => finish('painted'));
    });
    if (stopWatch === false) { finish('at_once'); return; }
    stopTimer = deps.timer(() => finish('bound'), boundMs);
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
