// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// Releasing the engine before the frame goes away.
//
// The engine runs KiCad's main loop and its tool coroutines as JSPI
// activations, each on its own suspended wasm stack: main parks on a
// requestAnimationFrame promise every frame, a coroutine parks on its resume.
// V8 visits every suspended wasm stack as a GC root ("(Stack roots)" in a heap
// snapshot: the frames' WasmTrustedInstanceData and the frame's NativeContext),
// and a stack is released only when its activation finishes. Once the frame
// is removed (or navigated) its document never runs another animation frame
// or timer, so those promises never settle, the stacks stay suspended, and the
// removed frame's whole realm stays reachable: its document and its 530 MB
// wasm memory, one per boot.
//
// So every park of the wx scheduler (the engine's one suspension seam, the
// pre-js globalThis.__wxScheduler) also waits on a kill switch. shutdown()
// rejects it while the document is still alive: each parked activation
// resumes through the scheduler's own turnstile with that error, unwinds and
// finishes, and its stack is freed. Then the scheduler stops, the pthreads are
// terminated, the timers and frames the page can still reach are cancelled,
// the WebGL contexts are lost, the engine globals are dropped and the stage
// is cleared. Removing the frame after the answer frees its realm; so does
// removing it without the op, since pagehide starts the same teardown and the
// unwinding runs in microtasks before the document goes.
//
// A trapped (terminal) instance keeps its parks: the scheduler refuses to
// resume into a damaged module by design, and so does this.

/** The error every parked activation resumes with; recognised to keep it off the console. */
export const SHUTDOWN_ERROR = 'IslandShutdown';
/** How long shutdown() waits for the parked activations to unwind. */
export const UNWIND_TIMEOUT_MS = 3000;
/**
 * Parks after the kill that are refused at once. An activation that catches
 * the error and parks again gets refused again; past this many it is left
 * parked for good, so a catch-and-retry loop can never spin the page.
 */
export const MAX_PARKS_AFTER_KILL = 64;
/** How many of the newest timer and frame ids shutdown() cancels (the oldest are the repeating ones). */
const ID_SWEEP = 20_000;

interface ParkRecord { id: unknown }

/** The parts of the engine's wx scheduler this module touches (kicad_editor.js pre-js). */
export interface WxScheduler {
  _suspendOn(p: Promise<unknown>, kind: string, token: number): Promise<unknown>;
  libctxSuspend?(id: number, p: Promise<unknown>, sp: number): Promise<unknown>;
  shutdown?(why: string): void;
  _suspended: Map<unknown, ParkRecord>;
  _resumeReady: unknown[];
  _windowLive: ParkRecord | null;
  dead?: boolean;
  terminal?: boolean;
}

type TeardownWindow = Window & {
  __wxScheduler?: WxScheduler;
  PThread?: { terminateAllThreads?: () => void };
  [key: string]: unknown;
};

export interface EngineTeardown {
  /** Runs once; later calls answer the first run's promise. */
  shutdown(): Promise<void>;
  /** True once shutdown() has started. */
  started(): boolean;
}

export class IslandShutdownError extends Error {
  constructor() {
    super('the island was shut down');
    this.name = SHUTDOWN_ERROR;
  }
}

export function isShutdownError(v: unknown): boolean {
  return v instanceof Error && v.name === SHUTDOWN_ERROR;
}

/** The globals the island and the engine leave on the window. */
const ENGINE_GLOBALS = ['Module', 'FS', 'wxElementRegistry', 'kicadWebOpenTool'] as const;

/**
 * Installs the kill switch. Must run before the engine's scripts load: the
 * scheduler is wrapped the moment the glue assigns globalThis.__wxScheduler.
 */
export function installEngineTeardown(win: Window): EngineTeardown {
  const w = win as TeardownWindow;
  let reject: (e: Error) => void = () => undefined;
  const kill = new Promise<never>((_, r) => { reject = r; });
  kill.catch(() => undefined);
  let killed = false;
  let parksAfterKill = 0;
  let scheduler: WxScheduler | undefined;

  /** A park's promise raced with the kill switch; past the cap a refused park waits forever. */
  const guard = (p: Promise<unknown>): Promise<unknown> => {
    if (killed && ++parksAfterKill > MAX_PARKS_AFTER_KILL) return new Promise(() => undefined);
    return Promise.race([p, kill]);
  };
  const wrap = (s: WxScheduler): WxScheduler => {
    const suspendOn = s._suspendOn;
    s._suspendOn = function (p, kind, token) { return suspendOn.call(this, guard(p), kind, token); };
    const libctxSuspend = s.libctxSuspend;
    if (typeof libctxSuspend === 'function') {
      s.libctxSuspend = function (id, p, sp) { return libctxSuspend.call(this, id, guard(p), sp); };
    }
    return s;
  };
  if (w.__wxScheduler != null) scheduler = wrap(w.__wxScheduler);
  Object.defineProperty(w, '__wxScheduler', {
    configurable: true,
    enumerable: true,
    get: () => scheduler,
    set: (s: WxScheduler | undefined) => { scheduler = s == null ? s : wrap(s); },
  });

  // The kill's error surfaces as an unhandled rejection where an activation's
  // own promise had no handler (main's): expected, so it stays off the console.
  win.addEventListener('unhandledrejection', (e) => { if (isShutdownError(e.reason)) e.preventDefault(); });
  win.addEventListener('error', (e) => { if (isShutdownError(e.error)) e.preventDefault(); });

  async function unwind(s: WxScheduler): Promise<void> {
    if (s.terminal === true || s.dead === true) return;
    const deadline = Date.now() + UNWIND_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
      if (s._suspended.size === 0 && s._resumeReady.length === 0) {
        // main is untracked: its finished window is never ended by the
        // scheduler (no completion hook), so it is cleared here.
        s._windowLive = null;
        return;
      }
      // Same: an untracked activation that unwound leaves its window armed
      // and blocks the turnstile for the next resume.
      if (s._windowLive != null && !s._suspended.has(s._windowLive.id) && s._resumeReady.length > 0) s._windowLive = null;
    }
    console.warn('[editor] shutdown: parked activations left', s._suspended.size);
  }

  function cancelTimersAndFrames(): void {
    const top = Number(win.setTimeout(() => undefined, 0));
    for (let id = Math.max(1, top - ID_SWEEP); id <= top; id++) { win.clearTimeout(id); win.clearInterval(id); }
    // The repeating ones are set at script load, so the oldest ids are swept as well.
    for (let id = 1; id <= Math.min(ID_SWEEP, top); id++) win.clearInterval(id);
    if (typeof win.requestAnimationFrame === 'function') {
      const frame = win.requestAnimationFrame(() => undefined);
      for (let id = Math.max(1, frame - ID_SWEEP); id <= frame; id++) win.cancelAnimationFrame(id);
    }
  }

  /** The engine's WebGL contexts (Emscripten's GL registry) give their GPU resources back now. */
  function loseWebGlContexts(): void {
    const gl = w.GL as { contexts?: Record<string, { GLctx?: WebGLRenderingContext | WebGL2RenderingContext } | null> } | undefined;
    for (const c of Object.values(gl?.contexts ?? {})) {
      try { c?.GLctx?.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* already lost */ }
    }
  }

  function dropGlobals(): void {
    for (const k of ENGINE_GLOBALS) {
      // The glue declares some with var (not deletable): those are emptied instead.
      try { if (!delete w[k]) w[k] = undefined; } catch { try { w[k] = undefined; } catch { /* read-only */ } }
    }
  }

  // Held from before the boot: the engine may re-label the stage's elements.
  const stage = ['main-window', 'window-container'].map((id) => (win.document as Document | undefined)?.getElementById(id) ?? null);
  function clearStage(): void {
    for (const el of stage) el?.replaceChildren();
  }

  let run: Promise<void> | null = null;
  return {
    started: () => run != null,
    shutdown() {
      run ??= (async () => {
        // From here every park is refused, also those of an engine that is
        // still booting (its scheduler is wrapped when the glue installs it).
        killed = true;
        reject(new IslandShutdownError());
        const s = scheduler;
        if (s != null) {
          await unwind(s);
          try { s.shutdown?.('island shutdown'); } catch (err) { console.debug('[editor] scheduler shutdown', err); }
        }
        try { w.PThread?.terminateAllThreads?.(); } catch (err) { console.debug('[editor] pthreads', err); }
        loseWebGlContexts();
        cancelTimersAndFrames();
        dropGlobals();
        clearStage();
      })();
      return run;
    },
  };
}

/**
 * Runs the teardown when the frame is unloaded for good (removed, or navigated
 * away). A pagehide into the back/forward cache (persisted) keeps the engine:
 * the host page may come back to it.
 */
export function teardownOnPagehide(win: Window, t: EngineTeardown): void {
  win.addEventListener('pagehide', (e) => {
    if ((e as PageTransitionEvent).persisted === true) return;
    void t.shutdown();
  });
}
