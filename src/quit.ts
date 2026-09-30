// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// File > Quit: the wx port calls window.wxAppTopWindowClosed() when the app's
// main frame is destroyed. It also closes that frame while the page unloads
// (its beforeunload handler), so the hook latches off as soon as any unload is
// under way; the listener goes in before the engine boots, so it runs first.
// The island never navigates: onQuit runs once, in a fresh task, out of the
// frame's destructor.
export function installQuitHandler(win: Window, onQuit: () => void): void {
  let latched = false;
  const latch = (): void => { latched = true; };
  win.addEventListener('beforeunload', latch, { capture: true });
  win.addEventListener('pagehide', latch);
  win.wxAppTopWindowClosed = () => {
    if (latched) return;
    latched = true;
    setTimeout(onQuit, 0);
  };
}
