// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The chrome watch behind an open's answer (PROTOCOL.md project.open). Loading
// a file can bring KiCad's menu bar back a moment after the load settled (a
// menu bar in 2 of 14 e2e runs, 2026-10-01). project.open used to watch for it
// before it answered, so every open answered about 1.5 s late (measured
// 2026-11-13: 1.50 to 1.64 s in 107 boots, the engine idle throughout). The
// answer no longer waits: the frame hides the chrome once, answers with what is
// visible then, and this watch runs on behind the answer for the same window,
// hiding the chrome each time it shows. An engine that holds its own hidden
// chrome (kicadChromeShown, our engine from run 9) is never watched: it hides
// again inside the call that showed it, before a frame is drawn.

/** What the watch reads and does; the responder owns every one of them. */
export interface ChromeWatchDeps {
  /** Any of KiCad's own chrome is on screen. */
  visible(): boolean;
  /** Hides it. Resolves once the engine answered or its bound passed. */
  hide(): Promise<unknown>;
  /** The watch is over now: the frame closed, the chrome is meant shown, or the engine stopped. */
  ended(): boolean;
  /** How long one window lasts, and how often the chrome is read within it, in ms. */
  settleMs(): number;
  pollMs(): number;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/**
 * One watch for the frame. `start` begins a window; a start while one runs
 * gives that watch a whole window again, so there are never two.
 */
export class ChromeWatch {
  /** When the running watch's window ends; 0 while none runs. */
  private until = 0;

  constructor(private readonly deps: ChromeWatchDeps) {}

  get running(): boolean {
    return this.until !== 0;
  }

  start(): void {
    const { deps } = this;
    if (deps.ended()) return;
    const running = this.running;
    this.until = deps.now() + deps.settleMs();
    if (!running) void this.run();
  }

  private async run(): Promise<void> {
    const { deps } = this;
    try {
      while (!deps.ended() && deps.now() < this.until) {
        await deps.sleep(deps.pollMs());
        if (deps.ended()) break;
        if (deps.visible()) await deps.hide();
      }
    } catch {
      // A hide that threw ends this watch; chrome.show is still the host's.
    } finally {
      this.until = 0;
    }
  }
}
