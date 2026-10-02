// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The board's view once a fit was asked for (PROTOCOL.md view.fit and
// project.import): fitted at the drawing's settled size, painted before an
// import answers, and kept fitted until the reader steers.
//
// Measured on the site's local pair (SwiftShader, island b32cc7b, 2026-10-02):
// - The host lays its page out again after an import answers: the frame went
//   from 1211 to 1103 px wide. KiCad keeps its scale on a resize, so the fit
//   made at the old size showed the AHT20 board zoomed in, cut at the right.
// - The repaint of a large board took seconds of the frame's main thread (3.8 s
//   and 2.7 s for a 752 KB EasyEDA board), and the browser's GPU process then
//   crashed (exit 139). Both GL contexts were lost; the engine replaced its
//   GL canvas, then drew through the software renderer on #canvas, and showed
//   nothing until the next fit.
// So the fit is made once the drawing's size holds, the answer waits for a
// painted picture, and while the reader has not steered, a resize or a
// replaced drawing surface is fitted again.

/** The engine's view: its centre (nm), its scale (pixels per nm) and the drawing's size (px). */
export interface Viewport { cx: number; cy: number; scale: number; w: number; h: number }

/** The view's waits, in ms (the responder's timing holds them; the unit tests shorten them). */
export interface ViewTiming {
  /** How often the view and the drawing are read. */
  viewPollMs: number;
  /** How long the drawing's size (and its surface) must hold before a fit. */
  viewStableMs: number;
  /** How long an import waits for its fitted board to be painted before it answers all the same. */
  viewSettleMs: number;
}

export type ViewWindow = { Module?: { kicadCollabGetViewport?: () => unknown }; document?: unknown };

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The engine's viewport, or null without the export or when it answers nothing usable. */
export function readViewport(w: ViewWindow): Viewport | null {
  const get = w.Module?.kicadCollabGetViewport;
  if (typeof get !== 'function') return null;
  try {
    const v: unknown = JSON.parse(String(get.call(w.Module) ?? 'null'));
    if (typeof v !== 'object' || v === null) return null;
    const { cx, cy, scale, w: width, h } = v as Record<string, unknown>;
    if (!finite(cx) || !finite(cy) || !finite(scale) || !finite(width) || !finite(h) || scale <= 0) return null;
    return { cx, cy, scale, w: width, h };
  } catch { return null; }
}

type CanvasLike = { id?: string; width: number; height: number; style?: { display?: string }; className?: string; getContext?: (type: string) => unknown };
type DocLike = { querySelectorAll?: (sel: string) => ArrayLike<unknown>; getElementById?: (id: string) => unknown; createElement?: (tag: string) => unknown };

/**
 * The element the board is drawn into: the largest GL canvas wx.js shows
 * (`canvas.gl-canvas`), else the root canvas (#canvas), which the engine's
 * software renderer draws into once its GL canvas is gone.
 */
export function drawingSurface(doc: unknown): CanvasLike | null {
  const d = doc as DocLike | undefined;
  let best: CanvasLike | null = null;
  try {
    for (const c of Array.from((d?.querySelectorAll?.('canvas.gl-canvas') ?? []) as ArrayLike<CanvasLike>)) {
      if (c.style?.display === 'none' || !(c.width > 0 && c.height > 0)) continue;
      if (best == null || c.width * c.height > best.width * best.height) best = c;
    }
    if (best != null) return best;
    const root = d?.getElementById?.('canvas') as CanvasLike | null | undefined;
    return root != null && root.width > 0 && root.height > 0 ? root : null;
  } catch { return null; }
}

/**
 * The surface as the fit watch compares it: which element, its size, and
 * whether its GL context is lost (the GPU process went). A change means the
 * picture must be drawn again.
 */
export function surfaceKey(doc: unknown): string {
  const s = drawingSurface(doc);
  if (s == null) return 'none';
  let lost = false;
  if (/gl-canvas/.test(s.className ?? '')) {
    try { lost = (s.getContext?.('webgl2') as { isContextLost?: () => boolean } | null | undefined)?.isContextLost?.() === true; } catch { /* unreadable counts as not lost */ }
  }
  return `${s.id ?? ''}:${s.width}x${s.height}${lost ? ':lost' : ''}`;
}

/** A small readback of a picture: `blank` when it shows nothing but one colour, `sig` changes when the picture does. */
export interface Sample { blank: boolean; sig: string }

const SAMPLE_W = 64;
const SAMPLE_H = 40;
/** A pixel counts as drawn when it differs from the picture's commonest colour by more than this (sum over r, g, b). */
const DRAWN_DIFF = 24;
/** A picture is blank when fewer than this share of its pixels are drawn, or this share or more are transparent. */
const DRAWN_SHARE = 0.02;
const CLEAR_SHARE = 0.9;

/** Classifies RGBA pixels (4 bytes each): blank, and a signature of the picture. */
export function classifyPixels(px: ArrayLike<number>): Sample {
  const n = Math.floor(px.length / 4);
  if (n === 0) return { blank: true, sig: '' };
  const counts = new Map<number, number>();
  let clear = 0;
  for (let i = 0; i < n; i++) {
    if (px[i * 4 + 3] < 250) clear++;
    // Quantised to 5 bits a channel: the signature and the commonest colour ignore one-step noise.
    const k = ((px[i * 4] >> 3) << 10) | ((px[i * 4 + 1] >> 3) << 5) | (px[i * 4 + 2] >> 3);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let top = 0;
  let topN = -1;
  for (const [k, c] of counts) if (c > topN) { top = k; topN = c; }
  const tr = ((top >> 10) & 31) << 3, tg = ((top >> 5) & 31) << 3, tb = (top & 31) << 3;
  let drawn = 0;
  let sig = 0x811c9dc5;
  for (let i = 0; i < n; i++) {
    const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
    if (Math.abs(r - tr) + Math.abs(g - tg) + Math.abs(b - tb) > DRAWN_DIFF) drawn++;
    sig = Math.imul(sig ^ (((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)), 0x01000193) >>> 0;
  }
  return { blank: clear >= n * CLEAR_SHARE || drawn < n * DRAWN_SHARE, sig: `${n}:${sig.toString(16)}` };
}

let scratch: { getImageData(x: number, y: number, w: number, h: number): { data: ArrayLike<number> }; drawImage(src: unknown, x: number, y: number, w: number, h: number): void; clearRect(x: number, y: number, w: number, h: number): void } | null = null;

/**
 * The drawing, read back small: the surface scaled into a 64 by 40 canvas.
 * The engine's GL contexts keep their drawing buffer (preserveDrawingBuffer,
 * measured), so the picture on screen is what is read. Null when there is no
 * surface or no way to read it (no DOM).
 */
export function sampleDrawing(doc: unknown): Sample | null {
  const src = drawingSurface(doc);
  if (src == null) return null;
  try {
    if (scratch == null) {
      const c = (doc as DocLike).createElement?.('canvas') as { width: number; height: number; getContext(t: string, o?: unknown): unknown } | undefined;
      if (c == null) return null;
      c.width = SAMPLE_W;
      c.height = SAMPLE_H;
      scratch = c.getContext('2d', { willReadFrequently: true }) as typeof scratch;
      if (scratch == null) return null;
    }
    scratch.clearRect(0, 0, SAMPLE_W, SAMPLE_H);
    scratch.drawImage(src, 0, 0, SAMPLE_W, SAMPLE_H);
    return classifyPixels(scratch.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data);
  } catch { return null; }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const sameSize = (a: Viewport | null, b: Viewport | null): boolean => a != null && b != null && a.w === b.w && a.h === b.h;
const sameView = (a: Viewport | null, b: Viewport | null): boolean => sameSize(a, b) && a!.cx === b!.cx && a!.cy === b!.cy && a!.scale === b!.scale;

export interface SettleDeps {
  timing: ViewTiming;
  /** The engine can take a key: no load parked, no dialog or popup menu up. */
  ready(): boolean;
  /** Presses KiCad's Zoom to Fit (Home). */
  fit(): void;
  /** The frame is going away. */
  closed(): boolean;
  /** The picture, read back; null when it cannot be read. */
  sample(): Sample | null;
  /** The surface as surfaceKey reads it. */
  surface(): string;
}

export type SettleResult = 'painted' | 'fitted' | 'unsupported' | 'timeout' | 'closed';

/**
 * Fits the board once the drawing's size and surface have held for
 * viewStableMs, then waits until it is painted: the view holds, and two
 * readbacks in a row agree and show more than one colour (without a readback,
 * the view holding after the fit is taken as painted: 'fitted'). A size that
 * changes meanwhile starts it over. Bounded by viewSettleMs. 'unsupported'
 * when the engine reports no viewport.
 */
export async function settleView(w: ViewWindow, d: SettleDeps): Promise<SettleResult> {
  const t = d.timing;
  if (readViewport(w) == null) return 'unsupported';
  const end = Date.now() + t.viewSettleMs;
  for (;;) {
    // The drawing's size and surface hold, and the engine can take the key.
    let vp = readViewport(w);
    let key = d.surface();
    let since = Date.now();
    for (;;) {
      if (d.closed()) return 'closed';
      if (Date.now() >= end) return 'timeout';
      await sleep(t.viewPollMs);
      const now = readViewport(w);
      const k = d.surface();
      if (!sameSize(now, vp) || k !== key) { vp = now; key = k; since = Date.now(); continue; }
      if (Date.now() - since >= t.viewStableMs && d.ready()) break;
    }
    d.fit();
    // Painted: the view holds and the picture is drawn and still.
    let prevView: Viewport | null = null;
    let prevSig: string | null = null;
    let restart = false;
    for (;;) {
      if (d.closed()) return 'closed';
      if (Date.now() >= end) return 'timeout';
      await sleep(t.viewPollMs);
      const now = readViewport(w);
      if (!sameSize(now, vp) || d.surface() !== key) { restart = true; break; }
      const s = d.sample();
      if (sameView(now, prevView)) {
        if (s == null) return 'fitted';
        if (!s.blank && s.sig === prevSig) return 'painted';
      }
      prevView = now;
      prevSig = s?.sig ?? null;
    }
    if (!restart) return 'timeout';
  }
}

/**
 * Keeps a fitted view fitted: armed by a fit (the island's own after an
 * import, a host's view.fit), disarmed when the reader steers (a real wheel,
 * pointer press or key in the frame, or a host's key.press). While armed,
 * each tick reads the drawing's size and surface; once a change has held for
 * viewStableMs and the engine can take a key, it fits again.
 */
export class FitWatch {
  private armed = false;
  /** The drawing's size and surface the view was last fitted at; null when it was never fitted (a fit is due). */
  private size: { w: number; h: number } | null = null;
  private key = '';
  /** A change seen and not yet fitted: when it was first seen, and what it was. */
  private pending: { at: number; w: number; h: number; key: string } | null = null;

  constructor(private readonly w: ViewWindow, private readonly d: Pick<SettleDeps, 'timing' | 'ready' | 'fit' | 'surface'>) {}

  /** Watches from now: `fitted` when the view was just fitted at the drawing's current size, else a fit is due once the size holds. */
  arm(fitted = true): void {
    const vp = readViewport(this.w);
    this.armed = vp != null;
    this.size = vp != null && fitted ? { w: vp.w, h: vp.h } : null;
    this.key = this.d.surface();
    this.pending = null;
  }

  disarm(): void {
    this.armed = false;
    this.pending = null;
  }

  /** The view is fitted at the drawing's current size and surface: a fit now would change nothing. */
  holds(): boolean {
    if (!this.armed || this.size == null) return false;
    const vp = readViewport(this.w);
    return vp != null && vp.w === this.size.w && vp.h === this.size.h && this.d.surface() === this.key;
  }

  /** One read; answers whether it fitted again. */
  tick(now = Date.now()): boolean {
    if (!this.armed) return false;
    const vp = readViewport(this.w);
    if (vp == null) return false;
    const key = this.d.surface();
    if (this.size != null && vp.w === this.size.w && vp.h === this.size.h && key === this.key) { this.pending = null; return false; }
    // Each further change restarts the wait: the fit comes once the change has held.
    const p = this.pending;
    if (p == null || p.w !== vp.w || p.h !== vp.h || p.key !== key) { this.pending = { at: now, w: vp.w, h: vp.h, key }; return false; }
    if (now - p.at < this.d.timing.viewStableMs || !this.d.ready()) return false;
    this.d.fit();
    this.size = { w: vp.w, h: vp.h };
    this.key = key;
    this.pending = null;
    return true;
  }
}
