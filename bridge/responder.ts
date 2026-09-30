// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The island side of cc-editor/1 (PROTOCOL.md). Hello goes to the one
// parent origin; only the first connect from window.parent with our nonce
// is accepted; every request and its args pass a closed check; events carry
// exactly the keys PROTOCOL.md lists; the engine is reached only through
// the exports the loader's global.d.ts declares (Module) and MEMFS.
import { registerSaveHook, SAVE_COMMITTED } from '../loader/src/wasm/save-flow';
import { parseBoot } from '../src/cc-config';
import { normalizePath, openStaged, PROJECT_ROOT, stageProject, type StagedProject } from '../src/stage';
import type { Frame } from '../src/types';

declare const __ISLAND_ID__: string;   // define'd by vite.config.ts from PIN.json

export type IslandEvent =
  | { type: 'ev.state'; phase: string; detail?: string }
  | { type: 'ev.ready'; caps: string[]; engine: { tag: string; kicad: string } }
  | { type: 'ev.saved'; path: string; bytes: Uint8Array }
  | { type: 'ev.openTool'; frame: Frame }
  | { type: 'ev.help'; topic: string }
  | { type: 'ev.closing' };

export interface Responder {
  emit(ev: IslandEvent): void;
  engineReady(win: ToolWindow, engine: { tag: string; kicad: string }, help: { attempts(): number }): void;
}

type Answer = { ok: true; result: Record<string, unknown> } | { ok: false; code: string; message: string };

/** The one project slug: the save hook reports paths relative to memfsProjectDir(SLUG). */
const SLUG = 'cc';
const MAX_QUEUED = 256;
const MAX_FILES = 4096;
const MAX_NAME = 255;
const APPLY_TIMEOUT_MS = 30_000;
const OPS = new Set(['project.open', 'project.save', 'project.forget', 'chrome.show', 'readonly']);
const EXT: Record<Frame, string> = { sch: '.kicad_sch', pcb: '.kicad_pcb' };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(o).every((k) => allowed.includes(k));
const ok = (result: Record<string, unknown> = {}): Answer => ({ ok: true, result });
const fail = (code: string, message: string): Answer => ({ ok: false, code, message });
/** A request with no args: absent, or an empty object. */
const noArgs = (args: unknown): boolean => args === undefined || (isObj(args) && Object.keys(args).length === 0);

function randomNonce(): string {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (x) => x.toString(16).padStart(2, '0')).join('');
}

function withTimeout<T>(value: T | Promise<T>, ms: number): Promise<T | 'timeout'> {
  return Promise.race([Promise.resolve(value), new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))]);
}

/** Removes a MEMFS directory and everything under it. */
function removeTree(FS: EmscriptenFS, dir: string): void {
  if (!FS.analyzePath(dir).exists) return;
  for (const name of FS.readdir(dir)) {
    if (name === '.' || name === '..') continue;
    const p = `${dir}/${name}`;
    if (FS.isDir(FS.stat(p).mode)) removeTree(FS, p); else FS.unlink(p);
  }
  FS.rmdir(dir);
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

export function startResponder(opts: { parentOrigin: string; page: Window }): Responder {
  const { parentOrigin, page } = opts;
  const nonce = randomNonce();
  const root = `${PROJECT_ROOT}/${SLUG}`;
  let port: MessagePort | null = null;
  let chain: Promise<void> = Promise.resolve();
  const queued: IslandEvent[] = [];
  let win: ToolWindow | null = null;
  let frame: Frame = 'sch';
  let staged: StagedProject | null = null;
  let opened: string | null = null;

  /** Rebuilds each event with exactly its protocol keys; saved bytes travel as a transferred copy. */
  const emit = (ev: IslandEvent): void => {
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
      case 'ev.closing':
        port.postMessage({ type: ev.type });
        return;
    }
  };

  const reply = (id: number, a: Answer): void => {
    port?.postMessage(a.ok ? { id, ok: true, result: a.result } : { id, ok: false, error: { code: a.code, message: a.message } });
  };

  const onConnect = (e: MessageEvent): void => {
    if (port != null || e.origin !== parentOrigin || e.source !== page.parent) return;
    const d: unknown = e.data;
    if (!isObj(d) || !onlyKeys(d, ['type', 'nonce']) || d.type !== 'cc.connect' || d.nonce !== nonce) return;
    const p = e.ports?.[0];
    if (p == null) return;
    port = p;
    page.removeEventListener('message', onConnect);
    port.onmessage = (m) => { chain = chain.then(() => handle(m.data)); };
    for (const ev of queued.splice(0)) emit(ev);
  };
  page.addEventListener('message', onConnect);
  page.parent.postMessage({ type: 'cc.hello', proto: 1, nonce, island: __ISLAND_ID__ }, parentOrigin);

  async function handle(data: unknown): Promise<void> {
    if (!isObj(data) || typeof data.id !== 'number' || !Number.isSafeInteger(data.id) || typeof data.op !== 'string') return;
    const { id, op } = data;
    if (!OPS.has(op)) return reply(id, fail('unknown_op', op));
    if (!onlyKeys(data, ['id', 'op', 'args'])) return reply(id, fail('bad_args', op));
    try {
      reply(id, await run(op, data.args));
    } catch (err) {
      reply(id, fail('island_error', err instanceof Error ? err.message : String(err)));
    }
  }

  async function run(op: string, args: unknown): Promise<Answer> {
    switch (op) {
      case 'project.open': return projectOpen(args);
      case 'project.save': return noArgs(args) ? projectSave() : fail('bad_args', op);
      case 'project.forget': {
        if (!noArgs(args)) return fail('bad_args', op);
        if (win?.FS != null) removeTree(win.FS, root);
        staged = null;
        opened = null;
        return ok();
      }
      case 'chrome.show': return toggle(op, args, 'kicadSetChrome');
      case 'readonly': return toggle(op, args, 'kicadSetReadOnly');
    }
    return fail('unknown_op', op);
  }

  async function projectOpen(a: unknown): Promise<Answer> {
    const op = 'project.open';
    if (!isObj(a) || !onlyKeys(a, ['name', 'files', 'open'])) return fail('bad_args', op);
    if (typeof a.name !== 'string' || a.name.length > MAX_NAME || !Array.isArray(a.files) || a.files.length > MAX_FILES) return fail('bad_args', op);
    if (a.open !== undefined && typeof a.open !== 'string') return fail('bad_args', op);
    const files: Array<{ path: string; bytes: Uint8Array }> = [];
    for (const f of a.files as unknown[]) {
      if (!isObj(f) || !onlyKeys(f, ['path', 'bytes']) || typeof f.path !== 'string' || !(f.bytes instanceof Uint8Array)) return fail('bad_args', op);
      files.push({ path: f.path, bytes: f.bytes });
    }
    if (win?.FS == null) return fail('not_ready', op);
    emit({ type: 'ev.state', phase: 'staging' });
    removeTree(win.FS, root);   // every open starts from an empty project folder
    opened = null;
    staged = stageProject(win, SLUG, files);
    const target = typeof a.open === 'string' ? a.open : defaultOpen(staged.written, frame);
    if (target == null) return fail('nothing_to_open', `no ${EXT[frame]} file`);
    emit({ type: 'ev.state', phase: 'opening' });
    const how = await openStaged(win, staged, target, (m) => console.debug('[open]', m));
    if (how === 'failed') return fail('open_failed', target);
    opened = normalizePath(target);
    return ok({ opened, dropped: staged.dropped });
  }

  /** A MEMFS path inside the project folder as a project-relative path, else null. */
  function relInRoot(abs: string): string | null {
    return abs.startsWith(`${root}/`) ? normalizePath(abs.slice(root.length + 1)) : null;
  }

  /**
   * kicadSaveSchematic writes the sheet the editor is SHOWING (the current
   * sheet), so it is saved to that sheet's own file, never over the root.
   * Without the sheet tree (an older build) the opened file is the target.
   */
  async function schematicTarget(w: ToolWindow, fallback: string): Promise<string | null> {
    const tree = w.Module?.kicadSheetsGetTree;
    if (typeof tree !== 'function') return fallback;
    let state: unknown;
    try { state = JSON.parse(String((await tree()) || 'null')); } catch { return fallback; }
    if (!isObj(state) || typeof state.current !== 'string' || !Array.isArray(state.sheets)) return fallback;
    const row = (state.sheets as unknown[]).find((s) => isObj(s) && s.path === state.current);
    if (!isObj(row) || typeof row.file !== 'string' || row.file === '') return fallback;
    return relInRoot(row.file);
  }

  async function projectSave(): Promise<Answer> {
    const op = 'project.save';
    const w = win;
    if (w?.FS == null || staged == null || opened == null) return fail('not_ready', op);
    const name = frame === 'pcb' ? 'kicadSaveBoard' : 'kicadSaveSchematic';
    const save = w.Module?.[name];
    if (typeof save !== 'function') return fail('unsupported', name);
    const target = frame === 'pcb' ? opened : await schematicTarget(w, opened);
    if (target == null) return fail('save_failed', 'the shown sheet is outside the project');
    const abs = `${root}/${target}`;
    // The save exports swallow every failure and write nothing, and the target
    // already holds the staged bytes. So the file is taken away first (its path
    // stays the one the engine holds) and only bytes the engine wrote back count;
    // a save that wrote nothing puts the previous bytes back and fails.
    const before = readBytes(w.FS, abs);
    try { if (before != null) w.FS.unlink(abs); } catch { return fail('save_failed', target); }
    try { await save(abs); } catch { /* judged by the file below */ }
    const bytes = readBytes(w.FS, abs);
    if (bytes == null || bytes.byteLength === 0) {
      try { if (before != null) w.FS.writeFile(abs, before); } catch { /* the answer is save_failed either way */ }
      return fail('save_failed', target);
    }
    emit({ type: 'ev.saved', path: target, bytes });
    return ok({ path: target });
  }

  async function toggle(op: string, args: unknown, name: 'kicadSetChrome' | 'kicadSetReadOnly'): Promise<Answer> {
    if (!isObj(args) || !onlyKeys(args, ['on']) || typeof args.on !== 'boolean') return fail('bad_args', op);
    if (win == null) return fail('not_ready', op);
    const fn = win.Module?.[name];
    if (typeof fn !== 'function') return fail('unsupported', name);
    // The binding answers false until the frame exists, and may answer through a
    // Promise when it queued behind a live open. Anything but true fails closed.
    const applied = await withTimeout<unknown>(fn(args.on), APPLY_TIMEOUT_MS);
    return applied === true ? ok() : fail('not_applied', op);
  }

  let ready = false;
  return {
    emit,
    engineReady(w, engine, help) {
      if (ready) return;
      ready = true;
      win = w;
      frame = parseBoot(page.location.search).frame;
      // Ctrl+S inside the editor: the fork's save chokepoints call
      // window.kicadCollab.onSave(absPath) after the bytes hit MEMFS; the hook
      // reads them back and hands us the project-relative path.
      registerSaveHook(w, {
        slug: SLUG,
        log: (m) => console.debug('[save]', m),
        onStatus: () => undefined,
        saveBytes: async (relPath, bytes) => {
          const path = normalizePath(relPath);
          if (path == null) return { kind: 'not-committed' };
          emit({ type: 'ev.saved', path, bytes });
          return SAVE_COMMITTED;
        },
      });
      const mod: Record<string, unknown> = w.Module ?? {};
      const caps = Object.keys(mod).filter((k) => /^kicad[A-Za-z0-9]*$/.test(k) && typeof mod[k] === 'function').sort();
      const n = help.attempts();
      if (n > 0) emit({ type: 'ev.state', phase: 'booting', detail: `${n} popup attempts blocked` });
      emit({ type: 'ev.ready', caps, engine });
    },
  };
}
