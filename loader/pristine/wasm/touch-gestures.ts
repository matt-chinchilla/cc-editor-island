/**
 * Mobile touch gestures for the editor canvas (features/mobile).
 *
 * The wx wasm layer consumes mouse/wheel only; its own touch mapping turns a
 * single finger into a LEFT-button drag (rubber-band select) and drops
 * multi-touch entirely. This module translates touches into the editor's
 * proven input paths instead:
 *
 *   one-finger drag → synthetic middle-button drag  (WX_VIEW_CONTROLS pan)
 *   two-finger pinch → synthetic wheel at the pinch centroid (zoom-to-cursor)
 *   quick tap        → synthetic left click          (selection)
 *
 * `TouchGestureRecognizer` is the pure state machine (unit-tested); it takes
 * the ACTIVE touch list (the shape of `TouchEvent.touches`) plus a timestamp
 * per event and emits abstract actions. `installTouchGestures` is the thin DOM
 * shim that feeds it and dispatches the synthetic events (covered by the
 * mobile e2e specs).
 */

export interface TouchPt {
  id: number;
  x: number;
  y: number;
}

export type GestureAction =
  | { kind: "pan-start"; x: number; y: number }
  | { kind: "pan-move"; x: number; y: number }
  | { kind: "pan-end"; x: number; y: number }
  | { kind: "zoom"; cx: number; cy: number; deltaY: number }
  | { kind: "tap"; x: number; y: number };

export interface RecognizerOptions {
  /** Max press duration for a tap (ms). */
  tapMaxMs?: number;
  /** Max finger travel for a tap (px); beyond it the touch becomes a pan. */
  tapMaxDist?: number;
  /** Wheel detents (×120 deltaY) emitted per doubling of the pinch distance. */
  zoomSensitivity?: number;
  /** Emit a zoom only once the accumulated |deltaY| reaches this (sub-threshold
   *  movement keeps accumulating — it is never dropped). */
  minWheelDelta?: number;
}

type State =
  | { mode: "idle" }
  | {
      mode: "single";
      startX: number;
      startY: number;
      startT: number;
      x: number;
      y: number;
      panning: boolean;
    }
  | { mode: "pinch"; lastEmitDist: number };

const dist = (a: TouchPt, b: TouchPt) => Math.hypot(a.x - b.x, a.y - b.y);

export class TouchGestureRecognizer {
  private readonly tapMaxMs: number;
  private readonly tapMaxDist: number;
  private readonly zoomSensitivity: number;
  private readonly minWheelDelta: number;
  private state: State = { mode: "idle" };

  constructor(opts: RecognizerOptions = {}) {
    this.tapMaxMs = opts.tapMaxMs ?? 300;
    this.tapMaxDist = opts.tapMaxDist ?? 10;
    this.zoomSensitivity = opts.zoomSensitivity ?? 3;
    this.minWheelDelta = opts.minWheelDelta ?? 15;
  }

  /** Feed the current active-touch list (TouchEvent.touches) for any touch event. */
  update(touches: TouchPt[], timeMs: number): GestureAction[] {
    const out: GestureAction[] = [];
    const s = this.state;

    const [a, b] = touches;
    if (a && b) {
      // Pinch uses the first two fingers; extras are ignored.
      const d = dist(a, b);
      if (s.mode === "pinch") {
        const pending = -this.zoomSensitivity * 120 * Math.log2(d / s.lastEmitDist);
        if (Math.abs(pending) >= this.minWheelDelta) {
          out.push({
            kind: "zoom",
            cx: (a.x + b.x) / 2,
            cy: (a.y + b.y) / 2,
            deltaY: pending,
          });
          s.lastEmitDist = d;
        }
      } else {
        if (s.mode === "single" && s.panning)
          out.push({ kind: "pan-end", x: s.x, y: s.y });
        this.state = { mode: "pinch", lastEmitDist: d };
      }
      return out;
    }

    if (a) {
      const p = a;
      if (s.mode === "single") {
        if (s.panning) {
          out.push({ kind: "pan-move", x: p.x, y: p.y });
        } else if (dist(p, { id: 0, x: s.startX, y: s.startY }) > this.tapMaxDist) {
          // Promote the pending tap to a pan, anchored at the ORIGINAL touch
          // point so no movement is lost.
          s.panning = true;
          out.push({ kind: "pan-start", x: s.startX, y: s.startY });
          out.push({ kind: "pan-move", x: p.x, y: p.y });
        }
        s.x = p.x;
        s.y = p.y;
      } else if (s.mode === "pinch") {
        // One finger lifted mid-pinch: hand off to a pan from the survivor
        // (immediately — a release here must not read as a tap).
        this.state = {
          mode: "single",
          startX: p.x,
          startY: p.y,
          startT: timeMs,
          x: p.x,
          y: p.y,
          panning: true,
        };
        out.push({ kind: "pan-start", x: p.x, y: p.y });
      } else {
        this.state = {
          mode: "single",
          startX: p.x,
          startY: p.y,
          startT: timeMs,
          x: p.x,
          y: p.y,
          panning: false,
        };
      }
      return out;
    }

    // all fingers lifted
    if (s.mode === "single") {
      if (s.panning) {
        out.push({ kind: "pan-end", x: s.x, y: s.y });
      } else if (timeMs - s.startT <= this.tapMaxMs) {
        // never panned ⇒ total travel stayed within tapMaxDist
        out.push({ kind: "tap", x: s.startX, y: s.startY });
      }
    }
    this.state = { mode: "idle" };
    return out;
  }

  /** touchcancel: end any active pan, drop everything else. */
  cancel(): GestureAction[] {
    const s = this.state;
    this.state = { mode: "idle" };
    if (s.mode === "single" && s.panning)
      return [{ kind: "pan-end", x: s.x, y: s.y }];
    return [];
  }
}

/**
 * Wire the recognizer to the Emscripten input canvas, translating actions into
 * synthetic mouse/wheel events on it. MUST be installed in preRun (before the
 * wasm app registers its own listeners): at-target listeners fire in
 * registration order, so only an earlier registration lets
 * stopImmediatePropagation() suppress the wx layer's single-finger→LEFT-drag
 * touch mapping. Returns an uninstaller.
 */
export function installTouchGestures(
  canvas: HTMLElement,
  opts: RecognizerOptions = {},
): () => void {
  const recognizer = new TouchGestureRecognizer(opts);
  canvas.style.touchAction = "none"; // keep the browser's own pan/zoom off the canvas

  const mouse = (
    type: string,
    x: number,
    y: number,
    button: number,
    buttons: number,
  ) => {
    canvas.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        screenX: x,
        screenY: y,
        button,
        buttons,
      }),
    );
  };

  const apply = (actions: GestureAction[]) => {
    for (const a of actions) {
      switch (a.kind) {
        case "pan-start":
          // Settle the cursor before pressing — the GAL needs a motion event
          // at the press point first (mirrors the wx layer's own synthetic
          // MOTION-before-press in TouchCallback).
          mouse("mousemove", a.x, a.y, 0, 0);
          mouse("mousedown", a.x, a.y, 1, 4); // middle button = pan
          break;
        case "pan-move":
          mouse("mousemove", a.x, a.y, 1, 4);
          break;
        case "pan-end":
          mouse("mouseup", a.x, a.y, 1, 0);
          break;
        case "zoom":
          mouse("mousemove", a.cx, a.cy, 0, 0);
          canvas.dispatchEvent(
            new WheelEvent("wheel", {
              bubbles: true,
              cancelable: true,
              clientX: a.cx,
              clientY: a.cy,
              deltaY: a.deltaY,
              deltaMode: 0, // pixel mode, matching real browser wheels (±120/detent)
            }),
          );
          break;
        case "tap":
          mouse("mousemove", a.x, a.y, 0, 0);
          mouse("mousedown", a.x, a.y, 0, 1);
          mouse("mouseup", a.x, a.y, 0, 0);
          break;
      }
    }
  };

  const pts = (e: TouchEvent): TouchPt[] =>
    Array.from(e.touches).map((t) => ({
      id: t.identifier,
      x: t.clientX,
      y: t.clientY,
    }));

  const swallow = (e: TouchEvent) => {
    // Keep the event from the wx layer's touch handlers AND from generating
    // browser mouse-compat events — we synthesize our own.
    e.stopImmediatePropagation();
    if (e.cancelable) e.preventDefault();
  };

  const onTouch = (e: TouchEvent) => {
    swallow(e);
    apply(recognizer.update(pts(e), e.timeStamp));
  };
  const onCancel = (e: TouchEvent) => {
    swallow(e);
    apply(recognizer.cancel());
  };

  const listen = { capture: true, passive: false } as AddEventListenerOptions;
  canvas.addEventListener("touchstart", onTouch, listen);
  canvas.addEventListener("touchmove", onTouch, listen);
  canvas.addEventListener("touchend", onTouch, listen);
  canvas.addEventListener("touchcancel", onCancel, listen);
  return () => {
    canvas.removeEventListener("touchstart", onTouch, listen);
    canvas.removeEventListener("touchmove", onTouch, listen);
    canvas.removeEventListener("touchend", onTouch, listen);
    canvas.removeEventListener("touchcancel", onCancel, listen);
  };
}
