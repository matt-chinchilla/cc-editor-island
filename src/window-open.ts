// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// wx.js opens every external link with window.open(url, '_blank') (its
// openUrl); the engine's Help menu goes through it. Installed BEFORE wx.js
// loads: a KiCad docs url becomes ev.help, everything else opens nothing.
// The property is made read-only so no later script can put the real one back.
const KICAD_DOCS = /^https:\/\/go\.kicad\.org\/docs\/(?:[^/]+\/)*([a-z0-9_-]{1,64})\/?$/;

export function installWindowOpenWrapper(win: Window, onHelp: (topic: string) => void): { attempts(): number } {
  let attempts = 0;
  const open = ((url?: string | URL) => {
    attempts += 1;
    const m = url == null ? null : KICAD_DOCS.exec(String(url));
    if (m != null) onHelp(m[1]);
    return null;
  }) as typeof win.open;
  try {
    Object.defineProperty(win, 'open', { value: open, writable: false, configurable: false });
  } catch {
    win.open = open;
  }
  return { attempts: () => attempts };
}
