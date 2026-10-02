// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { describe, expect, it, vi } from 'vitest';
import { classifyPixels, drawingSurface, FitWatch, readViewport, settleView, surfaceKey, type Sample, type ViewTiming } from './view';

const timing: ViewTiming = { viewPollMs: 2, viewStableMs: 12, viewSettleMs: 400 };

/**
 * An engine's view: KiCad keeps its scale when the drawing resizes, and Home
 * fits the board (100 mm by 50 mm at the origin) to the drawing's size.
 */
function fakeView(w = 1280, h = 800) {
  const vp = { cx: 0, cy: 0, scale: 1e-5, w, h };
  const fits: Array<{ w: number; h: number }> = [];
  const win = { Module: { kicadCollabGetViewport: () => JSON.stringify(vp) } };
  const fit = (): void => { vp.scale = Math.min(vp.w / 100e6, vp.h / 50e6) * 0.9; vp.cx = 50e6; vp.cy = 25e6; fits.push({ w: vp.w, h: vp.h }); };
  return { vp, win, fits, fit };
}

/** RGBA pixels: `n` of one colour, then `m` of another. */
function pixels(n: number, a: number[], m = 0, b: number[] = a): Uint8Array {
  const out = new Uint8Array((n + m) * 4);
  for (let i = 0; i < n + m; i++) out.set(i < n ? a : b, i * 4);
  return out;
}

describe('readViewport', () => {
  it('reads the engine\'s viewport, and null without the export or for anything unusable', () => {
    expect(readViewport({ Module: { kicadCollabGetViewport: () => '{"cx":1.5,"cy":-2,"scale":2e-5,"w":1279,"h":799}' } })).toEqual({ cx: 1.5, cy: -2, scale: 2e-5, w: 1279, h: 799 });
    expect(readViewport({})).toBeNull();
    for (const bad of ['', 'null', '{', '{"cx":1,"cy":2,"scale":0,"w":1,"h":1}', '{"cx":"1","cy":2,"scale":1,"w":1,"h":1}', '{"cx":1,"cy":2,"scale":1,"w":1}']) {
      expect(readViewport({ Module: { kicadCollabGetViewport: () => bad } })).toBeNull();
    }
    expect(readViewport({ Module: { kicadCollabGetViewport: () => { throw new Error('gone'); } } })).toBeNull();
  });
});

describe('classifyPixels', () => {
  const BG = [0, 16, 35, 255];
  it('a picture of one colour, or a transparent one, is blank; a drawn board is not', () => {
    expect(classifyPixels(pixels(2560, BG)).blank).toBe(true);
    expect(classifyPixels(pixels(2560, [0, 0, 0, 0])).blank).toBe(true);
    // The wx window fill the frame shows where no GL canvas is (measured on the site: 212, 208, 200).
    expect(classifyPixels(pixels(2560, [212, 208, 200, 255])).blank).toBe(true);
    // A few stray pixels (grid dots) stay blank; a board that covers a share of the picture is drawn.
    expect(classifyPixels(pixels(2540, BG, 20, [132, 132, 132, 255])).blank).toBe(true);
    expect(classifyPixels(pixels(1800, BG, 760, [54, 64, 77, 255])).blank).toBe(false);
    expect(classifyPixels(new Uint8Array(0)).blank).toBe(true);
  });

  it('the signature follows the picture and ignores one-step noise', () => {
    const a = classifyPixels(pixels(1800, [0, 16, 35, 255], 760, [54, 64, 77, 255]));
    expect(classifyPixels(pixels(1800, [1, 17, 34, 255], 760, [55, 65, 76, 255])).sig).toBe(a.sig);
    expect(classifyPixels(pixels(1700, [0, 16, 35, 255], 860, [54, 64, 77, 255])).sig).not.toBe(a.sig);
  });
});

describe('drawingSurface and surfaceKey', () => {
  const gl = (id: string, width: number, height: number, display = 'block', lost = false) => ({ id, className: 'gl-canvas', width, height, style: { display }, getContext: (t: string) => (t === 'webgl2' ? { isContextLost: () => lost } : null) });
  const doc = (gls: unknown[], root: unknown = { id: 'canvas', width: 1280, height: 800 }) => ({ querySelectorAll: (sel: string) => (sel === 'canvas.gl-canvas' ? gls : []), getElementById: (id: string) => (id === 'canvas' ? root : null) });

  it('is the largest GL canvas wx.js shows, else the root canvas the software renderer draws into', () => {
    expect(drawingSurface(doc([gl('glcanvas-1', 881, 129, 'none'), gl('glcanvas-2', 1279, 799)]))?.id).toBe('glcanvas-2');
    expect(drawingSurface(doc([gl('glcanvas-1', 881, 129), gl('glcanvas-2', 1279, 799)]))?.id).toBe('glcanvas-2');
    expect(drawingSurface(doc([gl('glcanvas-1', 881, 129, 'none')]))?.id).toBe('canvas');
    expect(drawingSurface(doc([], null))).toBeNull();
    expect(drawingSurface(undefined)).toBeNull();
  });

  it('changes when the surface is replaced, resized or its GL context is lost', () => {
    expect(surfaceKey(doc([gl('glcanvas-2', 1279, 799)]))).toBe('glcanvas-2:1279x799');
    expect(surfaceKey(doc([gl('glcanvas-2', 1099, 799)]))).toBe('glcanvas-2:1099x799');
    expect(surfaceKey(doc([gl('glcanvas-2', 1279, 799, 'block', true)]))).toBe('glcanvas-2:1279x799:lost');
    expect(surfaceKey(doc([gl('glcanvas-3', 1279, 799)]))).toBe('glcanvas-3:1279x799');
    expect(surfaceKey(doc([]))).toBe('canvas:1280x800');
    expect(surfaceKey(doc([], null))).toBe('none');
  });
});

describe('settleView', () => {
  const drawn: Sample = { blank: false, sig: 'board' };
  const deps = (v: ReturnType<typeof fakeView>, o: { sample?: () => Sample | null; ready?: () => boolean; surface?: () => string } = {}) => ({
    timing, fit: v.fit, closed: () => false, ready: o.ready ?? (() => true), sample: o.sample ?? (() => drawn), surface: o.surface ?? (() => 's'),
  });

  it('fits once the drawing\'s size has held, then answers painted when two readbacks agree and show a board', async () => {
    const v = fakeView(1211, 878);
    let reads = 0;
    // Blank until the fit has been drawn, then the board.
    const sample = (): Sample => { reads++; return v.fits.length === 0 || reads < 4 ? { blank: true, sig: 'empty' } : drawn; };
    // The host lays its page out again while the import settles: 1211 px wide, then 1103.
    setTimeout(() => { v.vp.w = 1103; }, 5);
    expect(await settleView(v.win, deps(v, { sample }))).toBe('painted');
    expect(v.fits).toEqual([{ w: 1103, h: 878 }]);
  });

  it('starts over when the size changes after its fit, and fits at the new size', async () => {
    const v = fakeView(1211, 878);
    const fit = v.fit;
    // The resize lands just after the first fit, as the site's did.
    v.fit = () => { fit(); if (v.fits.length === 1) setTimeout(() => { v.vp.w = 1103; }, 1); };
    expect(await settleView(v.win, deps(v))).toBe('painted');
    expect(v.fits).toEqual([{ w: 1211, h: 878 }, { w: 1103, h: 878 }]);
  });

  it('a replaced drawing surface (a lost GL context) holds the fit back until it is stable', async () => {
    const v = fakeView();
    let key = 'glcanvas-2:1279x799';
    setTimeout(() => { key = 'glcanvas-2:1279x799:lost'; }, 4);
    setTimeout(() => { key = 'canvas:1280x800'; }, 9);
    let fitAt = '';
    const fit = v.fit;
    v.fit = () => { fitAt = key; fit(); };
    expect(await settleView(v.win, deps(v, { surface: () => key }))).toBe('painted');
    expect(fitAt).toBe('canvas:1280x800');
  });

  it('presses nothing while the engine cannot take a key, answers fitted without a readback, and unsupported without a viewport', async () => {
    const v = fakeView();
    let ready = false;
    setTimeout(() => { ready = true; }, 40);
    const t0 = Date.now();
    expect(await settleView(v.win, deps(v, { ready: () => ready, sample: () => null }))).toBe('fitted');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
    expect(v.fits).toHaveLength(1);
    const fit = vi.fn();
    expect(await settleView({}, { ...deps(v), fit })).toBe('unsupported');
    expect(fit).not.toHaveBeenCalled();
  });

  it('answers timeout when the picture never shows a board, or the size never holds, and closed when the frame goes', async () => {
    const v = fakeView();
    expect(await settleView(v.win, { ...deps(v, { sample: () => ({ blank: true, sig: 'x' }) }), timing: { ...timing, viewSettleMs: 60 } })).toBe('timeout');
    const w = fakeView();
    const grow = setInterval(() => { w.vp.w += 1; }, 1);
    expect(await settleView(w.win, { ...deps(w), timing: { ...timing, viewSettleMs: 60 } })).toBe('timeout');
    clearInterval(grow);
    expect(w.fits).toEqual([]);
    let closed = false;
    setTimeout(() => { closed = true; }, 5);
    expect(await settleView(v.win, { ...deps(v, { ready: () => false }), closed: () => closed })).toBe('closed');
  });
});

describe('FitWatch', () => {
  function watch(v = fakeView(), o: { ready?: () => boolean } = {}) {
    let key = 'glcanvas-2';
    const fit = vi.fn(v.fit);
    const fw = new FitWatch(v.win, { timing, ready: o.ready ?? (() => true), fit, surface: () => key });
    return { v, fw, fit, setKey: (k: string) => { key = k; } };
  }

  it('fits again once a resize has held for viewStableMs, at the new size, once', () => {
    const { v, fw, fit } = watch();
    v.fit();
    fw.arm();
    expect(fw.holds()).toBe(true);
    expect(fw.tick(0)).toBe(false);
    v.vp.w = 1103;
    expect(fw.holds()).toBe(false);
    expect(fw.tick(100)).toBe(false);      // the change is seen
    v.vp.w = 1100;
    expect(fw.tick(105)).toBe(false);      // and changes again: the wait restarts
    expect(fw.tick(110)).toBe(false);
    expect(fw.tick(117)).toBe(true);       // held 12 ms
    expect(fit).toHaveBeenCalledTimes(1);
    expect(v.fits.at(-1)).toEqual({ w: 1100, h: 800 });
    expect(fw.holds()).toBe(true);
    expect(fw.tick(200)).toBe(false);
    expect(fit).toHaveBeenCalledTimes(1);
  });

  it('fits again when the drawing surface is replaced, and waits while the engine cannot take a key', () => {
    let ready = false;
    const { fw, fit, setKey } = watch(fakeView(), { ready: () => ready });
    fw.arm();
    setKey('canvas');
    expect(fw.tick(0)).toBe(false);
    expect(fw.tick(50)).toBe(false);       // held, but a dialog is up
    ready = true;
    expect(fw.tick(60)).toBe(true);
    expect(fit).toHaveBeenCalledTimes(1);
  });

  it('does nothing once the reader steered, and an arm without a fit fits as soon as the size holds', () => {
    const { v, fw, fit } = watch();
    fw.arm();
    fw.disarm();
    v.vp.w = 900;
    expect(fw.holds()).toBe(false);
    for (const t of [0, 20, 40]) expect(fw.tick(t)).toBe(false);
    expect(fit).not.toHaveBeenCalled();
    fw.arm(false);
    expect(fw.holds()).toBe(false);
    expect(fw.tick(100)).toBe(false);
    expect(fw.tick(120)).toBe(true);
    expect(v.fits.at(-1)).toEqual({ w: 900, h: 800 });
  });

  it('never arms without a viewport', () => {
    const fit = vi.fn();
    const fw = new FitWatch({}, { timing, ready: () => true, fit, surface: () => 'x' });
    fw.arm();
    expect(fw.holds()).toBe(false);
    expect(fw.tick(0)).toBe(false);
    expect(fw.tick(100)).toBe(false);
    expect(fit).not.toHaveBeenCalled();
  });
});
