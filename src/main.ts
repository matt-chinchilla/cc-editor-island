// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The island entry (spec section 4): refuse to boot at top level or on an
// unknown host, post cc.hello BEFORE the engine boots, wrap window.open
// BEFORE wx.js loads, probe the browser, boot the one frame, wait for the
// engine's frame, then hand the window to the responder. The engine is
// released by the shutdown op or on pagehide (teardown.ts).
//
// OOM: the loader's createOomWatch is deliberately NOT started. Its recovery
// reloads this frame in place with ?oomRetry=N (or opens a new tab under
// ?oomStrategy=newtab) behind the host's back, and it keys its retry chain on
// localStorage, which a cross-origin frame gets partitioned. An out-of-memory
// here ends at the fatal screen with ev.state {phase:'fatal', detail:'memory'};
// the host owns the frame and decides whether to reload it.
import { probeCapabilities } from '../loader/src/preflight/capabilities';
import { looksLikeOom } from '../loader/src/recovery/oom-watch';
import { bootKicadTool } from '../loader/src/wasm/boot';
import { staticLibsSource } from '../loader/src/wasm/libs/static-source';
import { startResponder } from '../bridge/responder';
import { seedsFor } from '../theme/seeds';
import { engineBase } from './assets';
import { parentOriginFor, parseBoot } from './cc-config';
import { cleanDetail, hideScreens, showScreen } from './screens';
import { statusFatal } from './status';
import { FRAME_TOKEN, frameToTool, type Frame } from './types';
import { installQuitHandler } from './quit';
import { installEngineTeardown, isShutdownError, teardownOnPagehide } from './teardown';
import { bootHeartbeat } from './boot-heartbeat';
import { installUnloadQuiet } from './unload-quiet';
import { installWindowOpenWrapper } from './window-open';

declare const __ISLAND_TAG__: string;      // define'd by vite.config.ts from PIN.json
declare const __KICAD_VERSION__: string;   // define'd by vite.config.ts

/** How long the engine may take, after its scripts ran, to show its editor frame. */
const ENGINE_UP_TIMEOUT_MS = 180_000;
/**
 * The fatal details the island emits and renders: its own closed words. Engine
 * and loader text (error messages, status lines) goes to the console only.
 */
type FatalCode = 'memory' | 'crash' | 'boot_failed' | 'engine_timeout' | 'no_container' | 'webgl_lost';
/** Uncaught errors that mean the wasm instance is gone (the loader's fatal-screen set). */
const TERMINAL = /RuntimeError|\babort(ed)?\b|\bindex out of bounds|indirect call signature|memory access out of bounds|unreachable executed|null function or function signature/i;

/** kicadWebOpenTool receives a tool name, sometimes a path, sometimes with .exe. */
function frameForTool(raw: string): Frame | null {
  const base = (raw.replace(/\\/g, '/').split('/').pop() ?? raw).replace(/\.exe$/i, '');
  if (base === 'pcbnew') return 'pcb';
  if (base === 'eeschema') return 'sch';
  return null;
}

/** The runtime is initialised and a KiCad frame is on screen (the open flow's own readiness test). */
async function engineUp(win: ToolWindow, timeoutMs: number, cancelled: () => boolean): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    if (cancelled()) return false;
    const frames = win.wxElementRegistry?.findAll({ visible: true }) ?? [];
    if (win.FS != null && frames.some((e) => /Frame$/.test(e.typeName) || e.name.endsWith('Frame'))) return true;
    if (performance.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function main(): Promise<void> {
  if (window.top === window) { showScreen('toplevel'); return; }
  const parent = parentOriginFor(location.hostname, location.port);
  if (parent == null) { showScreen('toplevel'); return; }
  const { frame, theme } = parseBoot(location.search);
  document.documentElement.classList.toggle('dark', theme === 'night');

  // Before the engine's scripts load: every park of its scheduler also waits on
  // the teardown's kill switch, so the frame's realm can be released (teardown.ts).
  const teardown = installEngineTeardown(window);
  // Hello goes out now, before anything heavy; events queue until the port connects.
  const responder = startResponder({ parentOrigin: parent, page: window, onShutdown: () => teardown.shutdown() });
  const popups = installWindowOpenWrapper(
    window,
    (topic) => responder.emit({ type: 'ev.help', topic }),
    (attempts) => responder.popupBlocked(attempts),
  );

  let fatal = false;
  const die = (code: FatalCode, raw?: string): void => {
    if (fatal || teardown.started()) return;
    fatal = true;
    if (raw != null && raw !== '') console.error('[editor] fatal', raw);
    showScreen('fatal', code);
    responder.emit({ type: 'ev.state', phase: 'fatal', detail: code });
  };
  const loaderStatus = (text: string): void => {
    const code = statusFatal(text);
    if (code != null) die(code, text);
    else console.debug('[status]', text);
  };
  const onUncaught = (text: string): void => {
    if (teardown.started()) return;
    if (looksLikeOom(text)) die('memory', text);
    else if (TERMINAL.test(text)) die('crash', text);
  };
  window.addEventListener('error', (e) => isShutdownError(e.error) || onUncaught(e.error instanceof Error ? e.error.message : String(e.message ?? '')));
  window.addEventListener('unhandledrejection', (e) => isShutdownError(e.reason) || onUncaught(e.reason instanceof Error ? e.reason.message : String(e.reason ?? '')));
  let closed = false;
  const closing = (): void => {
    if (closed) return;
    closed = true;
    responder.emit({ type: 'ev.closing' });
  };
  window.addEventListener('pagehide', closing);
  // Then the frame lets go of the engine (ev.closing above is already on the port).
  teardownOnPagehide(window, teardown);
  window.addEventListener('pagehide', (e) => { if (!e.persisted) responder.close(); });
  // File > Quit destroyed the editor's frame: tell the host, show the fatal
  // screen, navigate nowhere. Installed before the engine's own unload handler.
  installQuitHandler(window, () => {
    // The teardown's unwinding destroys the editor's frame too: that is no Quit.
    if (teardown.started()) return;
    closing();
    if (fatal) return;
    fatal = true;
    showScreen('fatal');
  });
  // After the quit latch (it must still see an unload) and before the engine's
  // scripts load: while the responder says the host is about to reload the frame
  // (just after its own save, or after a forget), the engine's leave prompt is stopped.
  installUnloadQuiet(window);

  showScreen('preflight');
  responder.emit({ type: 'ev.state', phase: 'preflight' });
  const report = probeCapabilities();
  if (report.fatal.length > 0) {
    // The screen explains in the probe's own sentences; the host gets the stable codes.
    showScreen('blocked', cleanDetail(report.fatal.map((i) => `${i.title}. ${i.detail}`).join(' ')));
    responder.emit({ type: 'ev.state', phase: 'blocked', detail: report.fatal.map((i) => i.code).join(' ') });
    return;
  }

  showScreen('loading');
  responder.emit({ type: 'ev.state', phase: 'booting' });
  // While the engine loads, booting repeats with the whole percent as its
  // detail (one event every 2 s at most): the host's ready bound restarts on each.
  const heartbeat = bootHeartbeat();
  // KiCad's own Switch items ask for the other frame; the page decides, the frame never navigates.
  window.kicadWebOpenTool = (toolName: string) => {
    const f = frameForTool(toolName);
    if (f == null) return false;
    responder.emit({ type: 'ev.openTool', frame: f });
    return true;
  };

  // wx.js addresses the stage by id: #main-window is its top-level window (it
  // owns the canvas) and #window-container parents every child window.
  const container = document.getElementById('main-window');
  if (container == null) { die('no_container'); return; }
  try {
    await bootKicadTool({
      tool: frameToTool(frame),
      base: engineBase(),
      container,
      frame: FRAME_TOKEN[frame],
      dark: theme === 'night',
      seeds: seedsFor(theme),
      libsSource: staticLibsSource(),
      log: (m) => console.debug('[editor]', m),
      // Loader and engine status lines stay in the console; the loading animation
      // and the booting heartbeat are fed by onProgress alone. The one line that
      // means the editor is gone (WebGL context lost) becomes the closed fatal
      // code; its text is still only logged.
      onStatus: (text) => loaderStatus(text),
      onProgress: (loaded, total) => {
        if (fatal || teardown.started() || !(total > 0)) return;
        showScreen('loading', undefined, loaded / total);
        const detail = heartbeat(loaded, total, performance.now());
        if (detail != null) responder.emit({ type: 'ev.state', phase: 'booting', detail });
      },
      onAbort: (what) => die(looksLikeOom(what) ? 'memory' : 'boot_failed', what),
    });
    if (!(await engineUp(window as ToolWindow, ENGINE_UP_TIMEOUT_MS, () => teardown.started()))) die('engine_timeout');
  } catch (err) {
    die('boot_failed', err instanceof Error ? err.message : String(err));
  }
  if (fatal || teardown.started()) return;
  hideScreens();
  responder.engineReady(window as ToolWindow, { tag: __ISLAND_TAG__, kicad: __KICAD_VERSION__ }, popups);
}

void main();
