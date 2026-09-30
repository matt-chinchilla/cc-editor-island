// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { describe, expect, it, vi } from 'vitest';
import { installQuitHandler } from './quit';

function fakeWin() {
  const listeners = new Map<string, Array<() => void>>();
  const win = {
    addEventListener: (t: string, h: () => void) => { listeners.set(t, [...(listeners.get(t) ?? []), h]); },
    fire: (t: string) => { for (const h of listeners.get(t) ?? []) h(); },
  };
  return win as unknown as Window & { fire(t: string): void };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('installQuitHandler', () => {
  it('runs onQuit once, in a later task, when the editor quits', async () => {
    const win = fakeWin();
    const onQuit = vi.fn();
    installQuitHandler(win, onQuit);
    win.wxAppTopWindowClosed?.();
    expect(onQuit).not.toHaveBeenCalled();   // never inside the wasm destructor
    win.wxAppTopWindowClosed?.();
    await tick();
    expect(onQuit).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when the frame closes because the page unloads', async () => {
    for (const ev of ['beforeunload', 'pagehide']) {
      const win = fakeWin();
      const onQuit = vi.fn();
      installQuitHandler(win, onQuit);
      win.fire(ev);
      win.wxAppTopWindowClosed?.();
      await tick();
      expect(onQuit).not.toHaveBeenCalled();
    }
  });
});
