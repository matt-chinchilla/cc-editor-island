// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The loader's status lines stay in the console (owner rulings R15 and I7):
// none reaches the screen or the host as text. One of them means the editor
// is gone: the browser dropped the canvas's WebGL context (a GPU reset, a
// driver crash), which leaves a frozen canvas. That one is mapped to the
// island's own closed fatal code; the line itself is still only logged.
export type StatusFatal = 'webgl_lost';

/** boot.ts's line from the canvas's webglcontextlost listener. */
const WEBGL_LOST = /^WebGL context lost\b/;

/** The fatal code a loader status line stands for, or null for an ordinary status line. */
export function statusFatal(text: string): StatusFatal | null {
  return WEBGL_LOST.test(text) ? 'webgl_lost' : null;
}
