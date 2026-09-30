// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { describe, expect, it, vi } from 'vitest';
import { installWindowOpenWrapper } from './window-open';

describe('installWindowOpenWrapper', () => {
  it('turns a KiCad docs url into a help topic and opens nothing', () => {
    const win = { open: vi.fn() } as unknown as Window;
    const help = vi.fn();
    const w = installWindowOpenWrapper(win, help);
    expect(win.open('https://go.kicad.org/docs/10.0/en/getting_started_in_kicad/', '_blank')).toBeNull();
    expect(help).toHaveBeenCalledWith('getting_started_in_kicad');
    expect(win.open('https://go.kicad.org/forum', '_blank')).toBeNull();
    expect(win.open('https://evil.example', '_blank')).toBeNull();
    expect(help).toHaveBeenCalledTimes(1);
    expect(w.attempts()).toBe(3);
  });

  it('reports every non-help attempt with the running count', () => {
    const win = { open: vi.fn() } as unknown as Window;
    const help = vi.fn();
    const blocked = vi.fn();
    installWindowOpenWrapper(win, help, blocked);
    win.open('https://go.kicad.org/forum', '_blank');
    win.open('https://go.kicad.org/docs/10.0/en/pcbnew/', '_blank');
    win.open('https://evil.example', '_blank');
    expect(help).toHaveBeenCalledWith('pcbnew');
    expect(blocked.mock.calls).toEqual([[1], [3]]);
  });

  it('cannot be put back by a later assignment', () => {
    const original = vi.fn();
    const win = { open: original } as unknown as Window;
    installWindowOpenWrapper(win, vi.fn());
    try { (win as { open: unknown }).open = original; } catch { /* strict mode throws on a read-only property */ }
    expect(win.open('https://evil.example')).toBeNull();
    expect(original).not.toHaveBeenCalled();
  });
});
