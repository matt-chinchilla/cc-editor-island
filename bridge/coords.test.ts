// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { describe, expect, it, vi } from 'vitest';
import { COORDS_CLASS, COORDS_START, CoordsChip, coordsText, UNITS_PER_MM, worldAt, type CoordsWindow } from './coords';

describe('worldAt', () => {
  const v = { cx: 1485011, cy: 1050036, scale: 0.00021626361431251764, w: 560, h: 809 };
  it('the middle of the drawing is the view\'s center', () => {
    expect(worldAt(v, 280, 404.5)).toEqual({ x: 1485011, y: 1050036 });
  });
  it('a pixel is one over the scale, right and down growing', () => {
    const p = worldAt(v, 281, 405.5);
    expect(p.x - v.cx).toBeCloseTo(1 / v.scale, 6);
    expect(p.y - v.cy).toBeCloseTo(1 / v.scale, 6);
    expect(worldAt(v, 0, 0).x).toBeLessThan(v.cx);
  });
  it('agrees with the engine\'s own report of a pointer (measured 2026-11-12, the example\'s schematic) within a pixel', () => {
    // The pointer at 186 by 269 px of the drawing; the engine reported 1050356.28, 425797.84.
    const p = worldAt(v, 186, 269);
    expect(Math.abs(p.x - 1050356.28)).toBeLessThan(1 / v.scale);
    expect(Math.abs(p.y - 425797.84)).toBeLessThan(1 / v.scale);
  });
});

describe('coordsText', () => {
  it('prints millimeters to two decimals as the viewing drawing does', () => {
    expect(coordsText(775000, 973600, 'sch')).toBe('77.50, 97.36 mm');
    expect(coordsText(90000000, 95500000, 'pcb')).toBe('90.00, 95.50 mm');
    expect(coordsText(-12345, 5, 'sch')).toBe('-1.23, 0.00 mm');
  });
  it('never prints a signed zero', () => {
    expect(coordsText(-1, -0, 'pcb')).toBe('0.00, 0.00 mm');
  });
  it('a schematic counts 100 nm steps and a board nanometers', () => {
    expect(UNITS_PER_MM).toEqual({ sch: 1e4, pcb: 1e6 });
  });
});

/** A frame with one drawing surface, 560 by 809 px at 1, 1, and an engine viewing a schematic. */
function fakeFrame() {
  const vp = { cx: 1485011, cy: 1050036, scale: 0.0002, w: 560, h: 809 };
  const listeners = new Map<string, Array<(e: Event) => void>>();
  const frames: Array<() => void> = [];
  const surface = { id: 'glcanvas-1', className: 'gl-canvas', width: 1260, height: 1820, style: {}, getBoundingClientRect: () => ({ left: 1, top: 1, width: 560, height: 809 }) };
  const chip = { className: '', textContent: null as string | null, hidden: false, attrs: {} as Record<string, string>, gone: false, setAttribute(n: string, val: string) { this.attrs[n] = val; }, remove() { this.gone = true; } };
  const reads = { n: 0 };
  const win = {
    Module: { kicadCollabGetViewport: () => { reads.n++; return JSON.stringify(vp); } },
    document: {
      createElement: () => chip,
      body: { appendChild: vi.fn() },
      querySelectorAll: (sel: string) => (sel === 'canvas.gl-canvas' ? [surface] : []),
      getElementById: () => null,
    },
    addEventListener: (type: string, fn: (e: Event) => void) => { listeners.set(type, [...(listeners.get(type) ?? []), fn]); },
    removeEventListener: (type: string, fn: (e: Event) => void) => { listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn)); },
    requestAnimationFrame: (fn: () => void) => frames.push(fn),
    cancelAnimationFrame: vi.fn(),
  };
  const fire = (type: string, e: object = {}): void => { for (const fn of listeners.get(type) ?? []) fn(e as Event); };
  const frame = (): void => { for (const fn of frames.splice(0)) fn(); };
  // wx.js gives the GL canvas pointer-events: none, so a move's target is the root canvas, never the drawing.
  const move = (x: number, y: number): void => fire('pointermove', { clientX: x, clientY: y, target: { id: 'canvas' } });
  return { vp, win: win as unknown as CoordsWindow, surface, chip, reads, frames, listeners, fire, frame, move };
}

describe('CoordsChip', () => {
  it('starts as the viewing drawing\'s chip does, and is never read out', () => {
    const f = fakeFrame();
    const c = new CoordsChip(f.win, { frame: 'sch', live: () => true });
    expect(c.start()).toBe(true);
    expect(f.chip.className).toBe(COORDS_CLASS);
    expect(f.chip.textContent).toBe(COORDS_START);
    expect(f.chip.attrs['aria-hidden']).toBe('true');
    expect(c.start()).toBe(true);
  });

  it('does not start without the engine\'s viewport export', () => {
    const f = fakeFrame();
    (f.win as { Module?: unknown }).Module = {};
    expect(new CoordsChip(f.win, { frame: 'sch', live: () => true }).start()).toBe(false);
    expect(f.listeners.size).toBe(0);
  });

  it('prints the place under the pointer, the middle of the drawing being the view\'s center', () => {
    const f = fakeFrame();
    new CoordsChip(f.win, { frame: 'sch', live: () => true }).start();
    f.move(281, 405.5);
    expect(f.chip.textContent).toBe(COORDS_START);
    f.frame();
    expect(f.chip.textContent).toBe('148.50, 105.00 mm');
    // 100 px right at 0.0002 px a unit is 500,000 units, 50 mm.
    f.move(381, 405.5);
    f.frame();
    expect(f.chip.textContent).toBe('198.50, 105.00 mm');
  });

  it('reads the engine once a frame however many moves arrive, and the resting place wins', () => {
    const f = fakeFrame();
    new CoordsChip(f.win, { frame: 'sch', live: () => true }).start();
    for (let i = 0; i < 12; i++) f.move(100 + i * 10, 200);
    expect(f.frames.length).toBe(1);
    f.frame();
    expect(f.reads.n).toBe(1);
    // The last move, 210 px: 209 px of the drawing, 71 left of the middle.
    expect(f.chip.textContent).toBe(coordsText(f.vp.cx - 71 / f.vp.scale, f.vp.cy + (199 - 404.5) / f.vp.scale, 'sch'));
  });

  it('keeps its text while the pointer is off the drawing\'s rectangle', () => {
    const f = fakeFrame();
    new CoordsChip(f.win, { frame: 'pcb', live: () => true }).start();
    f.move(281, 405.5);
    f.frame();
    const text = f.chip.textContent;
    const reads = f.reads.n;
    f.move(0.5, 400);
    f.frame();
    f.move(300, 811);
    f.frame();
    expect(f.chip.textContent).toBe(text);
    expect(f.reads.n).toBe(reads);
  });

  it('asks the engine nothing while it is busy, hidden under a menu or beside KiCad\'s own status bar', () => {
    const f = fakeFrame();
    let live = false;
    const c = new CoordsChip(f.win, { frame: 'sch', live: () => live });
    c.start();
    f.move(281, 405.5);
    f.frame();
    expect(f.reads.n).toBe(0);
    live = true;
    c.cover(true);
    expect(f.chip.hidden).toBe(true);
    f.move(300, 405.5);
    f.frame();
    expect(f.reads.n).toBe(0);
    c.cover(false);
    c.chromeShown(true);
    expect(f.chip.hidden).toBe(true);
    f.move(300, 405.5);
    f.frame();
    expect(f.reads.n).toBe(0);
    c.chromeShown(false);
    expect(f.chip.hidden).toBe(false);
    f.move(300, 405.5);
    f.frame();
    expect(f.reads.n).toBe(1);
  });

  it('reads again after a wheel turn or a key, at once and once more later, since the view may move under a still pointer', () => {
    vi.useFakeTimers();
    try {
      const f = fakeFrame();
      new CoordsChip(f.win, { frame: 'sch', live: () => true }).start();
      f.fire('wheel');
      expect(f.frames.length).toBe(0);   // no pointer seen yet
      f.move(281, 405.5);
      f.frame();
      f.vp.cx += 100000;                 // the view panned 10 mm under the pointer
      f.fire('keyup');
      f.frame();
      expect(f.chip.textContent).toBe('158.50, 105.00 mm');
      f.vp.cx += 100000;
      vi.advanceTimersByTime(200);
      f.frame();
      expect(f.chip.textContent).toBe('168.50, 105.00 mm');
    } finally { vi.useRealTimers(); }
  });

  it('stop takes the chip off the page and the listeners with it', () => {
    const f = fakeFrame();
    const c = new CoordsChip(f.win, { frame: 'sch', live: () => true });
    c.start();
    c.stop();
    expect(f.chip.gone).toBe(true);
    expect([...f.listeners.values()].every((l) => l.length === 0)).toBe(true);
    f.move(281, 405.5);
    expect(f.frames.length).toBe(0);
  });
});
