// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The pointer's place on the drawing, printed in the frame's bottom left corner
// as the host's viewing drawing prints it ("77.50, 97.36 mm"), so the readout
// stays where it was when the host goes from viewing to editing.
//
// KiCad prints the cursor's place in its status bar, which the canvas-only
// editor hides. The engine's own presence report (window.kicadCollab.onCursor)
// is no source for it: it emits on the leading edge of a 50 ms throttle, so the
// place the pointer comes to rest at is never reported (measured 2026-11-12 on
// the local pair: after a six-step move the last report was the first step's).
// The chip works the place out itself, from the frame's own pointer moves
// through the engine's viewport (kicadCollabGetViewport: the view's center in
// the engine's units and its scale in CSS px per unit; measured to agree with
// the engine's report within a pixel), at most once a frame.
import type { Frame } from '../src/types';
import { drawingSurface, readViewport, type Viewport, type ViewWindow } from './view';

/** The engine's units in a millimeter: a schematic's 100 nm steps, a board's nanometers. */
export const UNITS_PER_MM: Readonly<Record<Frame, number>> = Object.freeze({ sch: 1e4, pcb: 1e6 });
/** What the chip prints before the pointer has been on the drawing (the viewing drawing's own first text). */
export const COORDS_START = '0.00, 0.00 mm';
/** The chip's class (src/theme.css). */
export const COORDS_CLASS = 'cc-coords';
/** A wheel turn or a key may move the view under a still pointer: the place is read again this long after. */
const LATE_MS = 150;

/** A point of the drawing surface (CSS px from its top left corner) in the engine's units. */
export function worldAt(v: Viewport, px: number, py: number): { x: number; y: number } {
  return { x: v.cx + (px - v.w / 2) / v.scale, y: v.cy + (py - v.h / 2) / v.scale };
}

/** Two decimals, and never a signed zero. */
function fixed(mm: number): string {
  const s = mm.toFixed(2);
  return s === '-0.00' ? '0.00' : s;
}

/** A place in the engine's units as the chip prints it: `77.50, 97.36 mm`. */
export function coordsText(x: number, y: number, frame: Frame): string {
  const per = UNITS_PER_MM[frame];
  return `${fixed(x / per)}, ${fixed(y / per)} mm`;
}

type Rect = { left: number; top: number; width: number; height: number };
type ChipElement = { className: string; textContent: string | null; hidden: boolean; setAttribute: (name: string, value: string) => void; remove: () => void };
type ChipDocument = { createElement?: (tag: string) => unknown; body?: { appendChild?: (el: never) => unknown } | null };
type Listen = (type: string, fn: (e: Event) => void, opts?: boolean | { capture?: boolean; passive?: boolean }) => void;

export type CoordsWindow = ViewWindow & {
  addEventListener?: Listen;
  removeEventListener?: Listen;
  requestAnimationFrame?: (fn: () => void) => number;
  cancelAnimationFrame?: (id: number) => void;
};

/** The events after which the view may have moved under a still pointer. */
const LATE_EVENTS = ['wheel', 'keyup'] as const;

/**
 * The chip. `live` says whether the engine may be asked for its viewport now
 * (not while an import or a save runs). The chip keeps its last text while the
 * pointer is off the drawing, as the viewing drawing's does.
 */
export class CoordsChip {
  private el: ChipElement | null = null;
  /** The pointer's last place, in the frame's client px. */
  private at: { x: number; y: number } | null = null;
  private frameId: number | null = null;
  private late: ReturnType<typeof setTimeout> | null = null;
  private covered = false;
  private chrome = false;
  private text = COORDS_START;

  constructor(private readonly w: CoordsWindow, private readonly opts: { frame: Frame; live: () => boolean }) {}

  /** Adds the chip to the page and listens for the pointer. False without the engine's viewport export or a page to draw on. */
  start(): boolean {
    if (this.el != null) return true;
    const doc = this.w.document as ChipDocument | undefined;
    if (typeof this.w.Module?.kicadCollabGetViewport !== 'function' || typeof doc?.createElement !== 'function' || typeof doc.body?.appendChild !== 'function') return false;
    const el = doc.createElement('output') as ChipElement;
    el.className = COORDS_CLASS;
    // Its text changes with every move: never read out.
    el.setAttribute('aria-hidden', 'true');
    el.textContent = this.text;
    doc.body.appendChild(el as never);
    this.el = el;
    this.w.addEventListener?.('pointermove', this.onMove, { capture: true, passive: true });
    for (const type of LATE_EVENTS) this.w.addEventListener?.(type, this.onLater, { capture: true, passive: true });
    return true;
  }

  /** A KiCad menu or dialog is over the drawing (or gone again): the chip gives way to it. */
  cover(open: boolean): void {
    this.covered = open;
    this.show();
  }

  /** KiCad's own chrome is shown (or hidden again): its status bar prints the place itself. */
  chromeShown(shown: boolean): void {
    this.chrome = shown;
    this.show();
  }

  /** Stops for good: the chip leaves the page and nothing more is read. */
  stop(): void {
    this.w.removeEventListener?.('pointermove', this.onMove, { capture: true });
    for (const type of LATE_EVENTS) this.w.removeEventListener?.(type, this.onLater, { capture: true });
    if (this.frameId != null) this.w.cancelAnimationFrame?.(this.frameId);
    this.frameId = null;
    if (this.late != null) clearTimeout(this.late);
    this.late = null;
    this.el?.remove();
    this.el = null;
    this.at = null;
  }

  private show(): void {
    if (this.el != null) this.el.hidden = this.covered || this.chrome;
  }

  private readonly onMove = (e: Event): void => {
    const p = e as Partial<PointerEvent>;
    if (typeof p.clientX !== 'number' || typeof p.clientY !== 'number') return;
    this.at = { x: p.clientX, y: p.clientY };
    this.schedule();
  };

  private readonly onLater = (): void => {
    if (this.at == null) return;
    this.schedule();
    if (this.late != null) clearTimeout(this.late);
    this.late = setTimeout(() => { this.late = null; this.schedule(); }, LATE_MS);
  };

  private schedule(): void {
    if (this.frameId != null || this.el == null) return;
    const raf = this.w.requestAnimationFrame;
    if (typeof raf !== 'function') { this.read(); return; }
    this.frameId = raf.call(this.w, () => { this.frameId = null; this.read(); });
  }

  /**
   * Prints the place under the pointer. Nothing is read while the chip is
   * hidden, the engine is busy or the pointer is off the drawing. The drawing
   * is told by its rectangle, never by the event's target: wx.js gives its GL
   * canvas `pointer-events: none` and every press and move lands on the root
   * canvas under it (measured 2026-11-12).
   */
  private read(): void {
    const { el, at } = this;
    if (el == null || at == null || this.covered || this.chrome || !this.opts.live()) return;
    const surface = drawingSurface(this.w.document) as { getBoundingClientRect?: () => Rect } | null;
    const rect = surface?.getBoundingClientRect?.();
    if (rect == null || !(rect.width > 0 && rect.height > 0)) return;
    const px = at.x - rect.left;
    const py = at.y - rect.top;
    if (px < 0 || py < 0 || px > rect.width || py > rect.height) return;
    const v = readViewport(this.w);
    if (v == null) return;
    // The viewport's size is the drawing's in the engine's own px: the pointer is scaled to it.
    const world = worldAt(v, px * (v.w / rect.width), py * (v.h / rect.height));
    const text = coordsText(world.x, world.y, this.opts.frame);
    if (text === this.text) return;
    this.text = text;
    el.textContent = text;
  }
}
