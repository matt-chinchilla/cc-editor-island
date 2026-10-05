// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The island side of cc-editor/1 (PROTOCOL.md). Hello goes to the one
// parent origin; only the first connect from window.parent with our nonce
// is accepted; every request and its args pass a closed check; events carry
// exactly the keys PROTOCOL.md lists; the engine is reached only through
// the exports the loader's global.d.ts declares (Module) and MEMFS.
import { registerSaveHook, SAVE_COMMITTED, type SaveHookHandle } from '../loader/src/wasm/save-flow';
import { parseBoot } from '../src/cc-config';
import { focusCanvas, parseKeyPress, pressKey, type KeyPress } from '../src/keys';
import { normalizePath, openStaged, PROJECT_ROOT, stageLocalSettings, stageProject, type StagedProject } from '../src/stage';
import type { Frame } from '../src/types';
import { quietClear, quietFor, quietForever } from '../src/unload-quiet';
import { driveImport, importable, importTarget } from './import';
import { dialogUp, dismissPopups, keysBlocked, watchMenus } from './modal';
import { FitWatch, sampleDrawing, settleView, surfaceKey } from './view';

declare const __ISLAND_ID__: string;   // define'd by vite.config.ts from PIN.json

export type IslandEvent =
  | { type: 'ev.state'; phase: string; detail?: string }
  | { type: 'ev.ready'; caps: string[]; engine: { tag: string; kicad: string } }
  | { type: 'ev.saved'; path: string; bytes: Uint8Array }
  | { type: 'ev.openTool'; frame: Frame }
  | { type: 'ev.help'; topic: string }
  | { type: 'ev.menu'; open: boolean }
  | { type: 'ev.edited'; depth: number }
  | { type: 'ev.closing' };

export interface Responder {
  emit(ev: IslandEvent): void;
  engineReady(win: ToolWindow, engine: { tag: string; kicad: string }, help: { attempts(): number }): void;
  /** A window.open the wrapper refused; after ev.ready each one is reported as ev.state popup. */
  popupBlocked(attempts: number): void;
  /**
   * The bridge's part of the teardown (the frame is going away): the save hook
   * stops, the leave prompt stays quiet, the port closes and nothing else is
   * answered or emitted. Idempotent.
   */
  close(): void;
}

type Answer = { ok: true; result: Record<string, unknown> } | { ok: false; code: string; message: string };

/** The engine window with the save callback slot the fork calls (save-flow.ts's SaveHookWindow). */
type CollabWindow = ToolWindow & { kicadCollab?: { onSave?: (absPath: string) => void } };

/** MEMFS's errno for a busy directory (the engine's working directory). */
const EBUSY = 10;
/** MEMFS's errno for removing a directory that still holds an entry. */
const ENOTEMPTY = 55;
/** How long after a host-driven save the engine's leave prompt stays quiet (the host reloads the frame next). */
const SAVE_QUIET_MS = 10_000;
/** The one project slug: the save hook reports paths relative to memfsProjectDir(SLUG). */
const SLUG = 'cc';
const MAX_QUEUED = 256;
const MAX_FILES = 4096;
const MAX_NAME = 255;
/** project.import's format hint: a short string the island may ignore. */
const MAX_FORMAT = 64;
/**
 * The bridge's waits, in ms: the bound on each engine call (so no call can
 * hold the serial request chain, shutdown included), project.open's chrome
 * re-hide and project.save's save-all. Measured on the local pair (2026-10-01): a Ctrl+S in the Glasgow
 * schematic reported its first file 20 to 160 ms after the key and its last
 * (four files, 1.3 MB) within 110 ms of the first. The unit tests shorten them.
 */
export const timing = {
  /** How long an engine call may take before it counts as unanswered (not_applied, save_failed, island_error). */
  applyMs: 30_000,
  /** After an open, how long the chrome is watched for KiCad showing it again. */
  chromeSettleMs: 1_500,
  chromePollMs: 100,
  /** A save-all that reported no file by then failed (the key never reached the editor). */
  firstSaveMs: 8_000,
  /** Once every expected file is in, how long no further file may arrive. */
  saveSettleMs: 150,
  /** Without the full expected set, how long a pause ends the save-all. */
  saveQuietMs: 2_000,
  /** The save-all's ceiling, whatever arrives. */
  saveAllMs: 20_000,
  savePollMs: 25,
  /** After a save closed a popup menu, the pause before its key (the menu's opener resumes first). Unmeasured. */
  dismissMs: 100,
  /**
   * project.import (bridge/import.ts): the whole import's bound, from the open
   * call to the converted board's save; how often its dialogs are read; how long
   * nothing may show once the open resolved (the log report followed within
   * about 10 ms, spike 2026-10-02); the pause between two presses in one dialog;
   * how long the layer mapping may stay up after OK before it counts as refused;
   * and, on expiry, how long dialogs are closed before the answer.
   */
  importMs: 60_000,
  importPollMs: 100,
  importQuietMs: 500,
  importStepMs: 250,
  importRefusedMs: 2_000,
  importCloseMs: 5_000,
  /**
   * The view (bridge/view.ts): how often the drawing is read; how long its
   * size must hold before a fit (the host lays its page out again after an
   * import answers); how long an import waits for its fitted board to be
   * painted before it answers all the same (a large board's repaint took 4 s
   * of the main thread on the site, SwiftShader, 2026-10-02).
   */
  viewPollMs: 200,
  viewStableMs: 300,
  viewSettleMs: 10_000,
  /**
   * ev.edited (PROTOCOL.md): how often the open document's undo depth is read,
   * while no dialog is up, no load is parked and no request is in flight.
   */
  editPollMs: 500,
};
/** KiCad's Zoom to Fit. */
const HOME_KEY: KeyPress = { key: 'Home', code: 'Home', ctrl: false, shift: false, alt: false };
/** A real one of these in the frame is the reader steering the view: a fit no longer holds. */
const STEER_EVENTS = ['wheel', 'pointerdown', 'keydown'] as const;
/** KiCad's own Save (eeschema's Ctrl+S): every sheet of the schematic and the project file. */
const SAVE_KEY: KeyPress = { key: 's', code: 'KeyS', ctrl: true, shift: false, alt: false };
/** KiCad's window chrome as the element registry names it (measured with chrome.show on, 2026-10-01). */
const CHROME_RE = /^wx(MenuBar|AuiToolBar|ToolBar|StatusBar)$|InfoBar/i;
const OPS = new Set(['project.open', 'project.import', 'project.save', 'project.forget', 'chrome.show', 'readonly', 'shutdown', 'key.press', 'view.fit', 'sheet.tree', 'sheet.enter', 'layers.get', 'layers.visible', 'layers.active']);
/** A sheet path as the engine reports it: "/" then one UUID and a slash per level. */
const SHEET_PATH_RE = /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/)*$/;
const EXT: Record<Frame, string> = { sch: '.kicad_sch', pcb: '.kicad_pcb' };

const popupNote = (n: number): string => `${n} popup attempts blocked`;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(o).every((k) => allowed.includes(k));
const ok = (result: Record<string, unknown> = {}): Answer => ({ ok: true, result });
const fail = (code: string, message: string): Answer => ({ ok: false, code, message });
/** A request with no args: absent, or an empty object. */
const noArgs = (args: unknown): boolean => args === undefined || (isObj(args) && Object.keys(args).length === 0);
/** A KiCad layer id: an integer 0 to 127. */
const isLayerId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 127;
/** The last segment of a MEMFS path: the engine's absolute paths never leave the frame. */
const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function randomNonce(): string {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (x) => x.toString(16).padStart(2, '0')).join('');
}

function withTimeout<T>(value: T | Promise<T>, ms: number): Promise<T | 'timeout'> {
  return Promise.race([Promise.resolve(value), new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))]);
}

/**
 * Removes everything under a MEMFS directory, then the directory itself when
 * MEMFS allows it. KiCad changes into the opened project's folder (or the
 * subfolder of it the opened file sits in), and MEMFS refuses to remove its
 * working directory (EBUSY); that folder stays, empty, and so does each folder
 * above it, which then refuses with ENOTEMPTY. Answers whether such a busy
 * folder was kept at or below `dir`; any other MEMFS failure is thrown.
 */
function removeTree(FS: EmscriptenFS, dir: string): boolean {
  if (!FS.analyzePath(dir).exists) return false;
  let keptBusy = false;
  for (const name of FS.readdir(dir)) {
    if (name === '.' || name === '..') continue;
    const p = `${dir}/${name}`;
    if (FS.isDir(FS.stat(p).mode)) keptBusy = removeTree(FS, p) || keptBusy; else FS.unlink(p);
  }
  try {
    FS.rmdir(dir);
  } catch (err) {
    const errno = isObj(err) ? err.errno : undefined;
    if (errno === EBUSY) return true;
    // Not empty only because a busy folder below it was kept: that is expected.
    if (errno === ENOTEMPTY && keptBusy) return true;
    throw err;
  }
  return keptBusy;
}

/**
 * A thrown value as an island_error message. MEMFS throws ErrnoError objects
 * that are not Errors (name "ErrnoError", a numeric errno, sometimes a code);
 * they read as "<code or name> errno <n>" rather than "[object Object]".
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (isObj(err) && typeof err.errno === 'number') {
    const label = typeof err.code === 'string' && err.code !== '' ? err.code : typeof err.name === 'string' && err.name !== '' ? err.name : null;
    return label == null ? `errno ${err.errno}` : `${label} errno ${err.errno}`;
  }
  return String(err);
}

/** A MEMFS file's bytes, or null when it is absent or unreadable. */
function readBytes(FS: EmscriptenFS, abs: string): Uint8Array | null {
  try {
    if (!FS.analyzePath(abs).exists) return null;
    const b = FS.readFile(abs, { encoding: 'binary' });
    return b instanceof Uint8Array ? b : null;
  } catch { return null; }
}

/** The file KiCad should open when the host names none: the project's root sheet or board. */
function defaultOpen(written: string[], frame: Frame): string | undefined {
  const pro = written.find((p) => p.endsWith('.kicad_pro'));
  if (pro != null) {
    const twin = `${pro.slice(0, -'.kicad_pro'.length)}${EXT[frame]}`;
    if (written.includes(twin)) return twin;
  }
  return written.find((p) => p.endsWith(EXT[frame]));
}

export function startResponder(opts: {
  parentOrigin: string;
  page: Window;
  /** The engine's teardown, run by the shutdown op before it answers (src/teardown.ts). */
  onShutdown?: () => Promise<void>;
}): Responder {
  const { parentOrigin, page, onShutdown } = opts;
  const nonce = randomNonce();
  const root = `${PROJECT_ROOT}/${SLUG}`;
  let port: MessagePort | null = null;
  let chain: Promise<void> = Promise.resolve();
  const queued: IslandEvent[] = [];
  let win: ToolWindow | null = null;
  const frame: Frame = parseBoot(page.location.search).frame;
  let staged: StagedProject | null = null;
  let opened: string | null = null;
  /**
   * The display settings the island staged beside the document (src/stage.ts
   * stageLocalSettings): engine state, not the design, so a save of it is never
   * reported. Null when the host sent its own.
   */
  let displaySettings: string | null = null;
  /** The Ctrl+S hook: live only between a successful project.open and the next open or forget. */
  let saveHook: { handle: SaveHookHandle; filter: (absPath: string) => void } | null = null;
  /**
   * Whether KiCad's chrome is meant to show. The frame boots with it hidden
   * (src/main.ts, spec D16); chrome.show changes it for this boot.
   */
  let chromeOn = false;

  /** While a host save-all runs: every path its ev.saved carried, in order, with when it arrived. */
  let collecting: Array<{ path: string; at: number }> | null = null;
  /** Stops the popup menu and dialog watch (ev.menu); set by engineReady. */
  let stopMenus: (() => void) | null = null;
  /** Keeps a fitted view fitted until the reader steers (bridge/view.ts); set by engineReady. */
  let fitWatch: FitWatch | null = null;
  /** Stops the fit watch's reads and its steering listeners; set by engineReady. */
  let stopFitWatch: (() => void) | null = null;

  /** Set by the shutdown op or close(): from then on nothing is answered or emitted. */
  let closed = false;
  /** A project.import is running: every request but shutdown answers busy until it answers. */
  let importing = false;
  /** A shutdown request passed its checks: the port closes once it is answered. */
  let shutdownStarted = false;
  /** Requests received and not yet answered: the chain's queue and the one it runs (ev.edited reads nothing meanwhile). */
  let inFlight = 0;
  /**
   * ev.edited's last value: the open document's undo depth as last read, or
   * null until the first read after an open, an import or a forget. That first
   * read is the baseline and is never sent: opening a document is no edit.
   */
  let editDepth: number | null = null;
  /** Stops the undo depth poll (ev.edited); set by engineReady when the engine has the export. */
  let stopEdits: (() => void) | null = null;

  /** Rebuilds each event with exactly its protocol keys; saved bytes travel as a transferred copy. */
  const emit = (ev: IslandEvent): void => {
    if (closed) return;
    if (port == null) {
      if (queued.length >= MAX_QUEUED) queued.shift();
      queued.push(ev);
      return;
    }
    switch (ev.type) {
      case 'ev.state':
        port.postMessage(typeof ev.detail === 'string' ? { type: ev.type, phase: ev.phase, detail: ev.detail } : { type: ev.type, phase: ev.phase });
        return;
      case 'ev.ready':
        port.postMessage({ type: ev.type, caps: [...ev.caps], engine: { tag: ev.engine.tag, kicad: ev.engine.kicad } });
        return;
      case 'ev.saved': {
        const bytes = ev.bytes.slice();   // never detach a buffer the engine or the save hook still holds
        port.postMessage({ type: ev.type, path: ev.path, bytes }, [bytes.buffer]);
        return;
      }
      case 'ev.openTool':
        port.postMessage({ type: ev.type, frame: ev.frame });
        return;
      case 'ev.help':
        port.postMessage({ type: ev.type, topic: ev.topic });
        return;
      case 'ev.menu':
        port.postMessage({ type: ev.type, open: ev.open });
        return;
      case 'ev.edited':
        port.postMessage({ type: ev.type, depth: ev.depth });
        return;
      case 'ev.closing':
        port.postMessage({ type: ev.type });
        return;
    }
  };

  const reply = (id: number, a: Answer): void => {
    if (closed) return;
    port?.postMessage(a.ok ? { id, ok: true, result: a.result } : { id, ok: false, error: { code: a.code, message: a.message } });
  };

  const onConnect = (e: MessageEvent): void => {
    if (closed || port != null || e.origin !== parentOrigin || e.source !== page.parent) return;
    const d: unknown = e.data;
    if (!isObj(d) || !onlyKeys(d, ['type', 'nonce']) || d.type !== 'cc.connect' || d.nonce !== nonce) return;
    const p = e.ports?.[0];
    if (p == null) return;
    port = p;
    page.removeEventListener('message', onConnect);
    port.onmessage = (m) => {
      // A handler that rejects answers island_error for its own request; the
      // chain itself never rejects, so every later request is still answered.
      // A request is in flight from its arrival to its answer (ev.edited waits).
      inFlight += 1;
      const next = (): Promise<void> => handle(m.data)
        .catch((err: unknown) => answerIslandError(m.data, err))
        .finally(() => { inFlight -= 1; });
      chain = chain.then(next, next);
    };
    for (const ev of queued.splice(0)) emit(ev);
  };
  page.addEventListener('message', onConnect);
  page.parent.postMessage({ type: 'cc.hello', proto: 1, nonce, island: __ISLAND_ID__ }, parentOrigin);

  function answerIslandError(data: unknown, err: unknown): void {
    if (!isObj(data) || typeof data.id !== 'number' || !Number.isSafeInteger(data.id)) return;
    try { reply(data.id, fail('island_error', describeError(err))); } catch { /* the port is gone */ }
  }

  async function handle(data: unknown): Promise<void> {
    if (closed) return;
    if (!isObj(data) || typeof data.id !== 'number' || !Number.isSafeInteger(data.id) || typeof data.op !== 'string') return;
    const { id, op } = data;
    if (!OPS.has(op)) return reply(id, fail('unknown_op', op));
    if (!onlyKeys(data, ['id', 'op', 'args'])) return reply(id, fail('bad_args', op));
    // An import runs off the request chain (it may take a minute): what arrives
    // meanwhile is answered at once, busy, except a shutdown, which ends it.
    if (importing && op !== 'shutdown') return reply(id, fail('busy', op));
    if (op === 'project.import') return startImport(id, data.args);
    try {
      reply(id, await run(op, data.args));
    } catch (err) {
      reply(id, fail('island_error', describeError(err)));
    }
    // The shutdown answer is the last message on the port, whatever the teardown answered.
    if (shutdownStarted) close();
  }

  /** The document and the save hook are dropped and the engine's leave prompt is stopped for good. */
  function stopBridge(): void {
    stopEdits?.();
    stopEdits = null;
    editDepth = null;
    stopMenus?.();
    stopMenus = null;
    stopFitWatch?.();
    stopFitWatch = null;
    fitWatch = null;
    staged = null;
    opened = null;
    displaySettings = null;
    stopSaveHook();
    quietForever();
  }

  function close(): void {
    if (closed) return;
    stopBridge();
    closed = true;
    queued.length = 0;
    page.removeEventListener('message', onConnect);
    if (port != null) {
      port.onmessage = null;
      port.close();
    }
  }

  /**
   * The engine is still loading a file (open_gate.h's counter, the probe the
   * loader's open flow polls). A second open or a save sent then would queue
   * behind the parked load, so both answer busy and the host retries.
   */
  function engineBusy(): boolean {
    const mod = win?.Module as { kicadOpenFileBusy?: () => unknown } | undefined;
    const probe = mod?.kicadOpenFileBusy;
    if (typeof probe !== 'function') return false;
    try { return probe.call(mod) === true; } catch { return false; }
  }

  /**
   * The open document's undo depth (KiCad's undo command count, read through
   * the engine's kicadCollabTestUndoDepth): null when the export is missing,
   * throws, or answers anything but a whole number of at least 0 (it answers
   * -1 while no editor frame is up).
   */
  function undoDepth(w: ToolWindow): number | null {
    const mod = w.Module as { kicadCollabTestUndoDepth?: () => unknown } | undefined;
    const read = mod?.kicadCollabTestUndoDepth;
    if (typeof read !== 'function') return null;
    try {
      const depth = read.call(mod);
      return typeof depth === 'number' && Number.isSafeInteger(depth) && depth >= 0 ? depth : null;
    } catch { return null; }
  }

  /**
   * ev.edited's baseline after a load: the depth it left, read only when the
   * poll runs. A load still parked on a KiCad dialog (the file-version confirm
   * on an older file: the open answers while kicadOpenFileBusy holds) has not
   * reset the undo list yet, so no baseline is read then: null, and the first
   * read that passes the poll's busy and dialog gates takes it.
   */
  function editBaseline(w: ToolWindow): number | null {
    if (stopEdits == null || engineBusy() || dialogUp(w, true)) return null;
    return undoDepth(w);
  }

  /**
   * One ev.edited read (PROTOCOL.md): only while a document is open, no
   * request is in flight (an import included), no load is parked and no dialog
   * is up, progress dialogs included. The first read after an open, an import
   * or a forget is the baseline; a later read that differs is sent.
   */
  function pollEdits(w: ToolWindow): void {
    if (closed || opened == null || staged == null || importing || inFlight > 0 || collecting != null) return;
    if (engineBusy() || dialogUp(w, true)) return;
    const depth = undoDepth(w);
    if (depth == null) return;
    if (editDepth == null) { editDepth = depth; return; }
    if (depth === editDepth) return;
    editDepth = depth;
    emit({ type: 'ev.edited', depth });
  }

  async function run(op: string, args: unknown): Promise<Answer> {
    if ((op === 'project.open' || op === 'project.save') && engineBusy()) return fail('busy', 'the engine is busy');
    switch (op) {
      case 'project.open': return projectOpen(args);
      case 'project.save': return noArgs(args) ? projectSave() : fail('bad_args', op);
      case 'project.forget': {
        if (!noArgs(args)) return fail('bad_args', op);
        // The host dropped the document whatever the wipe below answers: the
        // bridge forgets it first, and no leave prompt is raised for it again
        // until the next successful project.open.
        staged = null;
        opened = null;
        displaySettings = null;
        editDepth = null;   // the next document's first read is its baseline
        fitWatch?.disarm();
        stopSaveHook();   // a Ctrl+S in the still-shown document emits nothing from here on
        quietForever();
        if (win?.FS != null) removeTree(win.FS, root);
        return ok();
      }
      case 'shutdown': {
        if (!noArgs(args)) return fail('bad_args', op);
        shutdownStarted = true;
        stopBridge();
        await onShutdown?.();
        return ok();
      }
      case 'chrome.show': return toggle(op, args, 'kicadSetChrome');
      case 'readonly': return toggle(op, args, 'kicadSetReadOnly');
      case 'key.press': return keyPress(args);
      // KiCad's Zoom to Fit is its Home hotkey; through keyPress, so a dialog that is up answers busy.
      case 'view.fit': return noArgs(args) ? keyPress({ key: 'Home', code: 'Home' }, op) : fail('bad_args', op);
      case 'sheet.tree': return noArgs(args) ? sheetTree() : fail('bad_args', op);
      case 'sheet.enter': return sheetEnter(args);
      case 'layers.get': return noArgs(args) ? layersGet() : fail('bad_args', op);
      case 'layers.visible': return layersVisible(args);
      case 'layers.active': return layersActive(args);
    }
    return fail('unknown_op', op);
  }

  async function projectOpen(a: unknown): Promise<Answer> {
    const op = 'project.open';
    if (!isObj(a) || !onlyKeys(a, ['name', 'files', 'open'])) return fail('bad_args', op);
    if (typeof a.name !== 'string' || a.name.length > MAX_NAME || !Array.isArray(a.files) || a.files.length > MAX_FILES) return fail('bad_args', op);
    // The explicit target must be this frame's own kind: a .kicad_sch opened in
    // the pcb frame would have project.save write a board into it.
    if (a.open !== undefined && (typeof a.open !== 'string' || !a.open.endsWith(EXT[frame]))) return fail('bad_args', op);
    const files: Array<{ path: string; bytes: Uint8Array }> = [];
    for (const f of a.files as unknown[]) {
      if (!isObj(f) || !onlyKeys(f, ['path', 'bytes']) || typeof f.path !== 'string' || !(f.bytes instanceof Uint8Array)) return fail('bad_args', op);
      files.push({ path: f.path, bytes: f.bytes });
    }
    if (win?.FS == null) return fail('not_ready', op);
    emit({ type: 'ev.state', phase: 'staging' });
    // The previous project is gone from here on, even if the wipe below fails.
    staged = null;
    opened = null;
    displaySettings = null;
    editDepth = null;
    fitWatch?.disarm();
    stopSaveHook();
    removeTree(win.FS, root);   // every open starts from an empty project folder
    staged = stageProject(win, SLUG, files);
    const target = typeof a.open === 'string' ? a.open : defaultOpen(staged.written, frame);
    if (target == null) return fail('nothing_to_open', `no ${EXT[frame]} file`);
    // Before the load, which reads them: KiCad draws the board as the viewer does.
    displaySettings = stageLocalSettings(win, staged, target);
    emit({ type: 'ev.state', phase: 'opening' });
    const w = win;
    const how = await openStaged(w, staged, target, (m) => console.debug('[open]', m));
    if (how === 'failed') {
      // A load that did not settle may still have shown the menu bar.
      await settleChrome(w);
      return fail('open_failed', target);
    }
    opened = normalizePath(target);
    startSaveHook(w);   // a fresh hook lifetime for this document
    editDepth = editBaseline(w);   // the depth the load left (null while it is parked): ev.edited's baseline, never sent
    quietClear();   // a new document: the engine's leave prompt guards it again
    // Loading a file shows the menu bar again, and an infobar when the file is
    // from an older KiCad (e2e 2026-10-01): the hidden chrome is put back and
    // watched, since KiCad can show it again after the load settled (a menu bar
    // in 2 of 14 e2e runs). A refusal leaves the chrome up and the open stands:
    // the answer's chrome says so, and the host sends chrome.show again.
    const chrome = await settleChrome(w);
    return ok({ opened, dropped: staged.dropped, chrome });
  }

  /**
   * project.import's checks, in order: the args (bad_args), the frame's kind
   * (a sch frame answers unsupported), the engine (not_ready, unsupported
   * without the open or the board save), then busy while a load is parked or a
   * dialog or a popup menu is up (nothing is changed). Answers the checked
   * request, or the refusal.
   */
  function importCheck(a: unknown): Answer | { w: ToolWindow; FS: EmscriptenFS; open: string; files: Array<{ path: string; bytes: Uint8Array }> } {
    const op = 'project.import';
    if (!isObj(a) || !onlyKeys(a, ['name', 'files', 'open', 'format'])) return fail('bad_args', op);
    if (typeof a.name !== 'string' || a.name.length > MAX_NAME || !Array.isArray(a.files) || a.files.length > MAX_FILES) return fail('bad_args', op);
    if (typeof a.open !== 'string' || !importable(a.open)) return fail('bad_args', op);
    if (a.format !== undefined && (typeof a.format !== 'string' || a.format.length > MAX_FORMAT)) return fail('bad_args', op);
    const files: Array<{ path: string; bytes: Uint8Array }> = [];
    for (const f of a.files as unknown[]) {
      if (!isObj(f) || !onlyKeys(f, ['path', 'bytes']) || typeof f.path !== 'string' || !(f.bytes instanceof Uint8Array)) return fail('bad_args', op);
      files.push({ path: f.path, bytes: f.bytes });
    }
    if (frame !== 'pcb') return fail('unsupported', 'project.import needs a pcb frame');
    const w = win;
    if (w?.FS == null) return fail('not_ready', op);
    if (typeof w.Module?.kicadOpenFile !== 'function') return fail('unsupported', 'kicadOpenFile');
    if (typeof w.Module?.kicadSaveBoard !== 'function') return fail('unsupported', 'kicadSaveBoard');
    if (engineBusy() || keysBlocked(w)) return fail('busy', op);
    return { w, FS: w.FS, open: a.open, files };
  }

  /** Starts a checked import off the request chain; its answer is sent when it ends. */
  function startImport(id: number, args: unknown): void {
    const checked = importCheck(args);
    if ('ok' in checked) return reply(id, checked);
    importing = true;
    void projectImport(checked)
      .catch((err: unknown) => fail('island_error', describeError(err)))
      .then((a) => {
        importing = false;
        reply(id, a);
      });
  }

  /**
   * A foreign board, converted (PROTOCOL.md project.import): staged as
   * project.open stages, opened through the engine's own open with its dialogs
   * answered (bridge/import.ts), then saved through the engine as
   * <stem>.kicad_pcb beside the source, which becomes the frame's document.
   */
  async function projectImport(a: { w: ToolWindow; FS: EmscriptenFS; open: string; files: Array<{ path: string; bytes: Uint8Array }> }): Promise<Answer> {
    const { w, FS } = a;
    const deadline = Date.now() + timing.importMs;
    emit({ type: 'ev.state', phase: 'staging' });
    // The previous project is gone from here on, as for project.open.
    staged = null;
    opened = null;
    displaySettings = null;
    editDepth = null;
    fitWatch?.disarm();
    stopSaveHook();
    removeTree(FS, root);
    const project = stageProject(w, SLUG, a.files);
    staged = project;
    const source = normalizePath(a.open);
    if (source == null || !project.written.includes(source)) return fail('open_failed', a.open);
    // KiCad's open loads the project named after the source, its settings included.
    displaySettings = stageLocalSettings(w, project, source);
    const target = importTarget(source);
    if (target == null) return fail('open_failed', `no path for the converted board of ${source}`);
    emit({ type: 'ev.state', phase: 'opening' });
    const drove = await driveImport(w, `${root}/${source}`, { deadline, timing, closed: () => closed, engineBusy });
    if (closed) return fail('import_failed', 'the frame closed');
    if (!drove.ok) {
      await settleChrome(w);   // a load that ran may have shown the menu bar
      return fail('import_failed', drove.message);
    }
    // A new document: the leave prompt guards it again, until the save below
    // hands the host its bytes (saveBoard quiets it for SAVE_QUIET_MS).
    quietClear();
    const left = deadline - Date.now();
    const saved = left > 0 ? await saveBoard(w, FS, target, Math.min(timing.applyMs, left)) : fail('save_failed', target);
    if (closed) return fail('import_failed', 'the frame closed');
    if (!saved.ok) {
      await settleChrome(w);
      return fail('import_failed', `the converted board was not saved (${target})`);
    }
    opened = target;
    startSaveHook(w);   // from here on the converted board is the document, as after project.open
    editDepth = editBaseline(w);   // the converted board's depth: ev.edited's baseline, never sent
    const chrome = await settleChrome(w);
    // The importer's dialogs took wx's keyboard focus and left it off the
    // drawing (e2e 2026-10-02: key.press F1 no longer zoomed): the boot's own
    // synthetic focus click puts it back. It never takes the browser's focus.
    if (!closed && !keysBlocked(w)) {
      try { focusCanvas(w.document); } catch { /* the user's next press in the drawing focuses it */ }
    }
    // The answer waits for the converted board fitted at the drawing's settled
    // size and painted, so a fit the host sends with it changes nothing; the
    // watch keeps it fitted through the host's own layout after the answer.
    const t0 = Date.now();
    const view = await settleView(w, {
      timing,
      ready: () => !engineBusy() && !keysBlocked(w),
      fit: () => pressKey(w, HOME_KEY),
      closed: () => closed,
      sample: () => sampleDrawing(w.document),
      surface: () => surfaceKey(w.document),
    });
    if (closed) return fail('import_failed', 'the frame closed');
    console.debug('[import] view', view, `${Date.now() - t0} ms`);
    if (view !== 'unsupported') fitWatch?.arm(view === 'painted' || view === 'fitted');
    return ok({ opened: target, dropped: project.dropped, warnings: drove.warnings, chrome });
  }

  /** Any of KiCad's window chrome is on screen. */
  function chromeVisible(w: ToolWindow): boolean {
    try { return (w.wxElementRegistry?.findAll({ visible: true }) ?? []).some((e) => CHROME_RE.test(e.typeName)); } catch { return false; }
  }

  /**
   * While the chrome is meant hidden: hides it, then watches it for
   * timing.chromeSettleMs and hides it again each time it shows. Answers
   * whether any of it is still visible at the end (with the chrome meant
   * shown, whether it is).
   */
  async function settleChrome(w: ToolWindow): Promise<boolean> {
    if (chromeOn) return chromeVisible(w);
    await withTimeout<unknown>(callChrome(w, false), timing.applyMs);
    const end = Date.now() + timing.chromeSettleMs;
    while (!closed && !chromeOn && Date.now() < end) {
      await sleep(timing.chromePollMs);
      if (!chromeOn && chromeVisible(w)) await withTimeout<unknown>(callChrome(w, false), timing.applyMs);
    }
    return chromeVisible(w);
  }

  /**
   * Ctrl+S inside the editor: the fork's save chokepoints call
   * window.kicadCollab.onSave(absPath) after the bytes hit MEMFS; the loader's
   * hook reads them back and hands us the project-relative path. The hook also
   * takes a bare file in the projects home (a blank editor's Save-As) as part
   * of the project; the island does not: only a path under the staged root
   * reaches the hook, anything else is logged and ignored.
   */
  function startSaveHook(tool: ToolWindow): void {
    stopSaveHook();
    const w = tool as CollabWindow;
    const handle = registerSaveHook(w, {
      slug: SLUG,
      log: (m) => console.debug('[save]', m),
      onStatus: () => undefined,
      saveBytes: async (relPath, bytes) => {
        const path = normalizePath(relPath);
        if (staged == null || path == null) return { kind: 'not-committed' };
        emit({ type: 'ev.saved', path, bytes });
        collecting?.push({ path, at: Date.now() });
        return SAVE_COMMITTED;
      },
    });
    const inner = w.kicadCollab?.onSave;
    const filter = (absPath: string): void => {
      if (typeof absPath !== 'string' || !absPath.startsWith(`${root}/`) || staged == null) {
        console.debug('[save] ignoring a save outside the project folder', absPath);
        return;
      }
      if (displaySettings != null && absPath === `${root}/${displaySettings}`) {
        console.debug('[save] ignoring the display settings the island staged', absPath);
        return;
      }
      inner?.(absPath);
    };
    w.kicadCollab = { ...w.kicadCollab, onSave: filter };
    saveHook = { handle, filter };
  }

  /** Ends the hook's lifetime: its queued saves are dropped and the engine's save callback is removed. */
  function stopSaveHook(): void {
    if (saveHook == null) return;
    const { handle, filter } = saveHook;
    saveHook = null;
    handle.stop();
    const w = win as CollabWindow | null;
    if (w?.kicadCollab?.onSave === filter) delete w.kicadCollab.onSave;
  }

  /** A MEMFS path inside the project folder as a project-relative path, else null. */
  function relInRoot(abs: string): string | null {
    return abs.startsWith(`${root}/`) ? normalizePath(abs.slice(root.length + 1)) : null;
  }

  /**
   * The engine's sheet tree for a schematic save, read once: null without the
   * export (an older build), when it never answers within timing.applyMs, or
   * when it is not a tree.
   */
  async function readSheetTree(w: ToolWindow): Promise<{ current: unknown; sheets: unknown[] } | null> {
    const tree = w.Module?.kicadSheetsGetTree;
    if (typeof tree !== 'function') return null;
    let state: unknown;
    try {
      const text = await withTimeout<unknown>(tree(), timing.applyMs);
      if (text === 'timeout') return null;
      state = JSON.parse(String(text || 'null'));
    } catch { return null; }
    if (!isObj(state) || !Array.isArray(state.sheets)) return null;
    return { current: state.current, sheets: state.sheets as unknown[] };
  }

  /**
   * The file of the sheet the editor is SHOWING (the current sheet): the
   * project.save answer's `path`. Without the sheet tree (an older build) the
   * opened file; null when the shown sheet lies outside the project.
   */
  function schematicTarget(state: { current: unknown; sheets: unknown[] } | null, fallback: string): string | null {
    if (state == null || typeof state.current !== 'string') return fallback;
    const row = state.sheets.find((s) => isObj(s) && s.path === state.current);
    if (!isObj(row) || typeof row.file !== 'string' || row.file === '') return fallback;
    return relInRoot(row.file);
  }

  async function projectSave(): Promise<Answer> {
    const op = 'project.save';
    const w = win;
    if (w?.FS == null || staged == null || opened == null) return fail('not_ready', op);
    return frame === 'pcb' ? saveBoard(w, w.FS, opened) : saveSchematic(w, opened);
  }

  /** The board through kicadSaveBoard: the one file the frame shows. `ms` bounds the engine call. */
  async function saveBoard(w: ToolWindow, FS: EmscriptenFS, target: string, ms = timing.applyMs): Promise<Answer> {
    const save = w.Module?.kicadSaveBoard;
    if (typeof save !== 'function') return fail('unsupported', 'kicadSaveBoard');
    const abs = `${root}/${target}`;
    // The save exports swallow every failure and write nothing, and the target
    // already holds the staged bytes. So the file is taken away first (its path
    // stays the one the engine holds) and only bytes the engine wrote back count;
    // a save that wrote nothing puts the previous bytes back and fails. A save
    // that never answers is judged the same way after timing.applyMs, so the
    // request chain moves on.
    const before = readBytes(FS, abs);
    try { if (before != null) FS.unlink(abs); } catch { return fail('save_failed', target); }
    try { await withTimeout<unknown>(save(abs), ms); } catch { /* judged by the file below */ }
    const bytes = readBytes(FS, abs);
    if (bytes == null || bytes.byteLength === 0) {
      try { if (before != null) FS.writeFile(abs, before); } catch { /* the answer is save_failed either way */ }
      return fail('save_failed', target);
    }
    emit({ type: 'ev.saved', path: target, bytes });
    quietFor(SAVE_QUIET_MS);   // the host has the bytes and may reload the frame now
    return ok({ path: target, saved: [target] });
  }

  /**
   * The schematic through KiCad's own Save, the Ctrl+S path: it writes every
   * sheet file of the hierarchy and the project file, each reported by the
   * save hook as ev.saved (kicadSaveSchematic writes only the sheet on screen,
   * so edits on any other sheet would be lost). The answer waits until every
   * sheet file and the project file are in, then a short pause with nothing
   * more; without the sheet list it waits for a longer pause. `path` names the
   * sheet the editor is showing, for hosts older than `saved`.
   */
  async function saveSchematic(w: ToolWindow, fallback: string): Promise<Answer> {
    const op = 'project.save';
    // A dialog refuses first, and nothing is pressed while one is up (the
    // protocol's promise): a popup over a dialog stays as it is. Otherwise a
    // popup menu holds no edits: it is closed as Escape closes it, and the
    // parked chain that opened it is let go before the key. A menu bar popup
    // takes no Escape and refuses like a dialog: the key would land in it.
    if (dialogUp(w, false)) return fail('busy', op);
    if (dismissPopups(w)) await sleep(timing.dismissMs);
    if (keysBlocked(w)) return fail('busy', op);
    const tree = await readSheetTree(w);
    const shown = schematicTarget(tree, fallback) ?? fallback;
    const expected = expectedSaves(tree, fallback);
    const got: Array<{ path: string; at: number }> = [];
    collecting = got;
    const start = Date.now();
    try {
      pressKey(w, SAVE_KEY);
      for (;;) {
        await sleep(timing.savePollMs);
        const now = Date.now();
        if (closed || now - start >= timing.saveAllMs) break;
        if (got.length === 0) {
          if (now - start >= timing.firstSaveMs) break;
          continue;
        }
        const idle = now - got[got.length - 1].at;
        const all = expected != null && [...expected].every((p) => got.some((g) => g.path === p));
        if (idle >= (all ? timing.saveSettleMs : timing.saveQuietMs)) break;
      }
      // The hook hands a file saved twice in a row over a microtask later: drain it.
      await sleep(0);
    } finally {
      collecting = null;
    }
    const saved = [...new Set(got.map((g) => g.path))];
    if (saved.length === 0) return fail('save_failed', 'the editor saved nothing');
    quietFor(SAVE_QUIET_MS);   // the host has the bytes and may reload the frame now
    return ok({ path: shown, saved });
  }

  /**
   * The files KiCad's Save writes: every sheet file the engine's sheet tree
   * names (inside the project) and the root's .kicad_pro when it was staged.
   * Null without a usable sheet tree.
   */
  function expectedSaves(state: { current: unknown; sheets: unknown[] } | null, fallback: string): Set<string> | null {
    if (state == null) return null;
    const files = new Set<string>();
    let rootFile = fallback;
    for (const row of state.sheets) {
      if (!isObj(row) || typeof row.file !== 'string') continue;
      const rel = relInRoot(row.file);
      if (rel == null) continue;
      files.add(rel);
      if (row.path === '/') rootFile = rel;
    }
    if (files.size === 0) return null;
    const pro = `${rootFile.slice(0, -'.kicad_sch'.length)}.kicad_pro`;
    if (rootFile.endsWith('.kicad_sch') && staged?.written.includes(pro)) files.add(pro);
    return files;
  }

  async function toggle(op: string, args: unknown, name: 'kicadSetChrome' | 'kicadSetReadOnly'): Promise<Answer> {
    if (!isObj(args) || !onlyKeys(args, ['on']) || typeof args.on !== 'boolean') return fail('bad_args', op);
    if (win == null) return fail('not_ready', op);
    const fn = win.Module?.[name];
    if (typeof fn !== 'function') return fail('unsupported', name);
    // The binding answers false until the frame exists, and may answer through a
    // Promise when it queued behind a live open. Anything but true fails closed.
    const applied = await withTimeout<unknown>(fn(args.on), timing.applyMs);
    if (applied !== true) return fail('not_applied', op);
    if (name === 'kicadSetChrome') chromeOn = args.on;
    return ok();
  }

  /** kicadSetChrome's own answer, or undefined when the export is missing, throws or rejects. */
  async function callChrome(w: ToolWindow, on: boolean): Promise<unknown> {
    const fn = w.Module?.kicadSetChrome;
    if (typeof fn !== 'function') return undefined;
    try { return await fn(on); } catch { return undefined; }
  }

  /**
   * A KiCad hotkey from the host (spec D16). Refused while a popup menu or a
   * dialog is up: the key would land in it. Never clicks: the boot put wx keyboard focus on the
   * canvas once (src/main.ts), and a click in a drawing tool would place a point.
   */
  function keyPress(args: unknown, op = 'key.press'): Answer {
    const k = parseKeyPress(args);
    if (k == null) return fail('bad_args', op);
    const w = win;
    if (w == null) return fail('not_ready', op);
    if (keysBlocked(w)) return fail('busy', op);
    if (op !== 'view.fit') {
      // A host's key may zoom, pan or start a tool: the reader is steering.
      fitWatch?.disarm();
      pressKey(w, k);
      return ok();
    }
    // Fitted already at this size (the island's own fit after an import, or a
    // fit the watch kept): pressing again would only repaint the same view.
    if (fitWatch?.holds() !== true) pressKey(w, k);
    fitWatch?.arm();
    return ok();
  }

  /**
   * The engine's JSON export, parsed. 'unsupported' when the export is missing
   * or answers nothing (the other frame's kind: a pcb frame has no sheet tree,
   * a sch frame no layers); null when it throws or answers something unparsable.
   */
  async function engineJson(name: 'kicadSheetsGetTree' | 'kicadLayersGetState'): Promise<Record<string, unknown> | null | 'unsupported'> {
    const fn = win?.Module?.[name];
    if (typeof fn !== 'function') return 'unsupported';
    let text: unknown;
    try { text = await withTimeout<unknown>(fn(), timing.applyMs); } catch { return null; }
    if (text === 'timeout') return null;
    if (typeof text !== 'string' || text === '') return 'unsupported';
    try { const v: unknown = JSON.parse(text); return isObj(v) ? v : null; } catch { return null; }
  }

  /** The schematic's sheets, each with its file's base name (the engine's absolute path stays here). */
  async function sheetTree(): Promise<Answer> {
    const op = 'sheet.tree';
    if (win == null) return fail('not_ready', op);
    const state = await engineJson('kicadSheetsGetTree');
    if (state === 'unsupported') return fail('unsupported', 'kicadSheetsGetTree');
    if (state == null || typeof state.current !== 'string' || !Array.isArray(state.sheets)) return fail('island_error', op);
    const sheets = (state.sheets as unknown[]).flatMap((s) => {
      if (!isObj(s) || typeof s.path !== 'string' || typeof s.name !== 'string') return [];
      return [{
        path: s.path,
        name: s.name,
        page: String(s.page ?? ''),
        depth: typeof s.depth === 'number' ? s.depth : 0,
        parent: typeof s.parent === 'string' ? s.parent : '',
        file: typeof s.file === 'string' ? baseName(s.file) : '',
      }];
    });
    return ok({ current: state.current, sheets });
  }

  async function sheetEnter(args: unknown): Promise<Answer> {
    const op = 'sheet.enter';
    if (!isObj(args) || !onlyKeys(args, ['path']) || typeof args.path !== 'string' || !SHEET_PATH_RE.test(args.path)) return fail('bad_args', op);
    if (win == null) return fail('not_ready', op);
    const fn = win.Module?.kicadSheetsEnter;
    if (typeof fn !== 'function') return fail('unsupported', 'kicadSheetsEnter');
    const applied = await withTimeout<unknown>(fn(args.path), timing.applyMs);
    return applied === true ? ok() : fail('not_applied', op);
  }

  async function layersGet(): Promise<Answer> {
    const op = 'layers.get';
    if (win == null) return fail('not_ready', op);
    const state = await engineJson('kicadLayersGetState');
    if (state === 'unsupported') return fail('unsupported', 'kicadLayersGetState');
    if (state == null || typeof state.active !== 'number' || !Array.isArray(state.layers)) return fail('island_error', op);
    const layers = (state.layers as unknown[]).flatMap((l) => {
      if (!isObj(l) || !isLayerId(l.id) || typeof l.name !== 'string' || typeof l.canonical !== 'string') return [];
      return [{ id: l.id, name: l.name, canonical: l.canonical, color: typeof l.color === 'string' ? l.color : '', visible: l.visible === true, copper: l.copper === true }];
    });
    return ok({ active: state.active, layers });
  }

  /** A layer setter: answers {} only when the engine confirms, like chrome.show. */
  async function layerCall(op: string, name: 'kicadLayersSetVisible' | 'kicadLayersSetActive', call: (fn: (...a: unknown[]) => unknown) => unknown): Promise<Answer> {
    if (win == null) return fail('not_ready', op);
    const fn = win.Module?.[name];
    if (typeof fn !== 'function') return fail('unsupported', name);
    const applied = await withTimeout<unknown>(call(fn as (...a: unknown[]) => unknown), timing.applyMs);
    return applied === true ? ok() : fail('not_applied', op);
  }

  function layersVisible(args: unknown): Promise<Answer> {
    const op = 'layers.visible';
    if (!isObj(args) || !onlyKeys(args, ['id', 'visible']) || !isLayerId(args.id) || typeof args.visible !== 'boolean') return Promise.resolve(fail('bad_args', op));
    return layerCall(op, 'kicadLayersSetVisible', (fn) => fn(args.id, args.visible));
  }

  function layersActive(args: unknown): Promise<Answer> {
    const op = 'layers.active';
    if (!isObj(args) || !onlyKeys(args, ['id']) || !isLayerId(args.id)) return Promise.resolve(fail('bad_args', op));
    return layerCall(op, 'kicadLayersSetActive', (fn) => fn(args.id));
  }

  let ready = false;
  return {
    emit,
    engineReady(w, engine, help) {
      if (ready) return;
      ready = true;
      win = w;
      // Popup menus and dialogs over the canvas: the host hides what it draws there.
      stopMenus = watchMenus(w, (open) => emit({ type: 'ev.menu', open }));
      // A fitted view stays fitted through resizes and a replaced drawing
      // surface until the reader steers (bridge/view.ts). The fit watch reads
      // nothing while an import or a save runs (the import fits for itself).
      const watch = new FitWatch(w, { timing, ready: () => !engineBusy() && !keysBlocked(w), fit: () => pressKey(w, HOME_KEY), surface: () => surfaceKey(w.document) });
      fitWatch = watch;
      const timer = setInterval(() => { if (!closed && !importing && collecting == null) watch.tick(); }, timing.viewPollMs);
      const steer = (e: Event): void => { if (e.isTrusted) watch.disarm(); };
      const listens = typeof w.addEventListener === 'function';
      if (listens) for (const t of STEER_EVENTS) w.addEventListener(t, steer, true);
      stopFitWatch = () => {
        clearInterval(timer);
        if (listens) for (const t of STEER_EVENTS) w.removeEventListener(t, steer, true);
      };
      // The Ctrl+S hook is registered by each successful project.open (startSaveHook).
      const mod: Record<string, unknown> = w.Module ?? {};
      const caps = Object.keys(mod).filter((k) => /^kicad[A-Za-z0-9]*$/.test(k) && typeof mod[k] === 'function').sort();
      // ev.edited: polled only when the engine has the undo depth export at
      // boot; an older build is never polled and nothing is said about it.
      if (typeof mod.kicadCollabTestUndoDepth === 'function') {
        const edits = setInterval(() => pollEdits(w), timing.editPollMs);
        stopEdits = () => clearInterval(edits);
      }
      const n = help.attempts();
      if (n > 0) emit({ type: 'ev.state', phase: 'booting', detail: popupNote(n) });
      emit({ type: 'ev.ready', caps, engine });
    },
    popupBlocked(attempts) {
      // Before ev.ready the count travels once, in the booting note above.
      if (ready) emit({ type: 'ev.state', phase: 'popup', detail: popupNote(attempts) });
    },
    close,
  };
}
