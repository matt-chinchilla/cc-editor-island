// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { memfsProjectDir } from '../loader/src/wasm/constants';
import { reportLines, tapEngineLog } from './import';
import { describeError, startResponder, timing } from './responder';
import { isQuiet, resetUnloadQuietForTest } from '../src/unload-quiet';

const PARENT = 'http://circuitcenter.localhost';
const ROOT = memfsProjectDir('cc');
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// The chrome watch after an open, the save-all's and the import's waits,
// shortened: an open answers about 30 ms after its load, a save-all about 25 ms
// after its last file.
beforeAll(() => {
  Object.assign(timing, { chromeSettleMs: 30, chromePollMs: 5, firstSaveMs: 60, saveSettleMs: 10, saveQuietMs: 40, saveAllMs: 300, savePollMs: 2, dismissMs: 5 });
  // An import's dialogs are read every 5 ms, pressed 10 ms apart, and it ends 20 ms after the last one went.
  Object.assign(timing, { importPollMs: 5, importQuietMs: 20, importStepMs: 10, importRefusedMs: 60, importCloseMs: 200 });
});
// No DOM in this suite: a KeyboardEvent stand-in that keeps every init field (key, code, ctrlKey, ...).
beforeEach(() => {
  vi.stubGlobal('KeyboardEvent', class extends Event {
    constructor(type: string, init: Record<string, unknown> = {}) {
      const { bubbles, cancelable, composed, ...rest } = init as EventInit & Record<string, unknown>;
      super(type, { bubbles, cancelable, composed });
      Object.assign(this, rest);
    }
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

function fakePage(search = '?frame=sch&theme=day') {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const parent = { postMessage: vi.fn() };
  const page = {
    parent,
    top: {},
    location: { search },
    addEventListener: (t: string, h: (e: unknown) => void) => { const s = listeners.get(t) ?? new Set(); s.add(h); listeners.set(t, s); },
    removeEventListener: (t: string, h: (e: unknown) => void) => listeners.get(t)?.delete(h),
    dispatch: (t: string, e: unknown) => { for (const h of listeners.get(t) ?? []) h(e); },
  };
  return { page: page as unknown as Window & { dispatch: (t: string, e: unknown) => void }, parent };
}

function connect(page: Window & { dispatch: (t: string, e: unknown) => void }, nonce: string) {
  const ch = new MessageChannel();
  const got: Array<Record<string, unknown>> = [];
  ch.port1.onmessage = (m) => got.push(m.data);
  page.dispatch('message', { origin: PARENT, source: page.parent, data: { type: 'cc.connect', nonce }, ports: [ch.port2] });
  return { port: ch.port1, got };
}

/** A MEMFS stand-in with the calls the island makes. */
function fakeFs() {
  const dirs = new Set<string>(['/']);
  /** Directories MEMFS refuses to remove (EBUSY): the engine's working directory. */
  const busy = new Set<string>();
  /** Directories whose removal fails some other way: errno per path. */
  const broken = new Map<string, number>();
  /** Files whose unlink leaves them in place, so their folder stays non-empty. */
  const pinned = new Set<string>();
  const files = new Map<string, Uint8Array>();
  const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';
  const FS = {
    mkdirTree(p: string) { let acc = ''; for (const s of p.split('/').filter(Boolean)) { acc += `/${s}`; dirs.add(acc); } },
    writeFile(p: string, data: Uint8Array | string) {
      if (!dirs.has(parentOf(p))) throw new Error(`ENOENT ${p}`);
      files.set(p, typeof data === 'string' ? new TextEncoder().encode(data) : data.slice());
    },
    readFile(p: string) { const f = files.get(p); if (!f) throw new Error(`ENOENT ${p}`); return f.slice(); },
    analyzePath(p: string) { return { exists: files.has(p) || dirs.has(p) }; },
    unlink(p: string) { if (!pinned.has(p)) files.delete(p); },
    readdir(p: string) {
      const names = new Set<string>(['.', '..']);
      for (const k of [...files.keys(), ...dirs]) if (k !== p && parentOf(k) === p) names.add(k.slice(p.length + 1));
      return [...names];
    },
    stat(p: string) { return { mode: dirs.has(p) ? 0o040755 : 0o100644 }; },
    isDir(mode: number) { return (mode & 0o170000) === 0o040000; },
    rmdir(p: string) {
      if (busy.has(p)) throw { errno: 10 };   // MEMFS throws an ErrnoError, not an Error
      if (broken.has(p)) throw { name: 'ErrnoError', errno: broken.get(p) };
      if (this.readdir(p).length > 2) throw { name: 'ErrnoError', errno: 55 };   // ENOTEMPTY
      dirs.delete(p);
    },
  };
  return { FS, files, dirs, busy, broken, pinned };
}

/**
 * A booted engine: a visible frame, the programmatic open and the save
 * exports. Its Ctrl+S (a keydown with ctrlKey and KeyS on its window) writes
 * every .kicad_sch and .kicad_pro file of the project a few ms later, each
 * reported to the save hook, as KiCad's own Save does (e2e 2026-10-01).
 */
function fakeEngine() {
  const { FS, files, dirs, busy, broken, pinned } = fakeFs();
  const opened: string[] = [];
  /** The KiCad dialogs the registry reports as visible (key.press answers busy while one is up). */
  const dialogs: Array<{ typeName: string; visible: boolean }> = [];
  /** KiCad's window chrome in the registry: kicadSetChrome(false) removes it, (true) shows the menu bar. */
  const chrome: Array<{ typeName: string; visible: boolean }> = [];
  /**
   * Whether a wx popup menu (.wx-menu-popup) is in the document. A context
   * menu closes on an Escape keydown reaching it (wx-dom.js's capture listener
   * on the document); a menu bar popup (escapeCloses false) does not.
   */
  const ui = { popup: false, escapeCloses: true };
  /**
   * Dialogs as wx.js shows them (an import's): a registry dialog with its parts
   * linked by parentId, a window div with its title bar, and the DOM buttons
   * wx-dom.js makes, whose click() runs the button's `on`. `clicks` records
   * every press as "<title>:<label>" ("<title>:×" for the title bar's close box).
   */
  const modals: FakeModal[] = [];
  const clicks: string[] = [];
  const showModal = (m: FakeModal): FakeModal => { modals.push(m); return m; };
  const hideModal = (m: FakeModal): void => { const i = modals.indexOf(m); if (i >= 0) modals.splice(i, 1); };
  const btnCentre = (m: FakeModal, i: number) => ({ x: m.x + 30 + 60 * i, y: m.y + m.h - 15 });
  const modalElements = () => modals.flatMap((m) => [
    { id: m.id, parentId: 'frame', typeName: 'wxDialog', name: 'dialog', label: '', visible: true, screenX: m.x, screenY: m.y, width: m.w, height: m.h, centerX: m.x + Math.floor(m.w / 2), centerY: m.y + Math.floor(m.h / 2) },
    ...m.buttons.map((b, i) => ({ id: `${m.id}.b${i}`, parentId: m.id, typeName: 'wxButton', name: 'button', label: b.label, visible: true, centerX: btnCentre(m, i).x, centerY: btnCentre(m, i).y })),
    ...(m.texts ?? []).map((t, i) => ({ id: `${m.id}.t${i}`, parentId: m.id, typeName: 'wxStaticText', name: 'staticText', label: t, visible: true })),
    ...(m.gauge ? [{ id: `${m.id}.g`, parentId: m.id, typeName: 'wxGauge', name: 'gauge', label: '', visible: true }] : []),
    ...(m.pane ? [{ id: `${m.id}.p`, parentId: m.id, typeName: 'wxGenericCollapsiblePane', name: 'collapsiblePane', label: '', visible: true }] : []),
  ]);
  const domButtons = () => modals.flatMap((m) => m.buttons.map((b, i) => ({
    textContent: b.label.replace(/&(.)/g, '$1'),
    getBoundingClientRect: () => ({ left: btnCentre(m, i).x - 25, top: btnCentre(m, i).y - 9, width: 50, height: 18 }),
    click: () => { clicks.push(`${m.title}:${b.label.replace(/&(.)/g, '$1')}`); b.on?.(); },
  })));
  const windowDivs = () => modals.map((m) => ({
    getBoundingClientRect: () => ({ left: m.x, top: m.y, width: m.w, height: m.h }),
    querySelector: (sel: string) => (sel === '.window-titlebar-text' ? { textContent: m.title } : sel === '.window-titlebar-close' ? { click: () => { clicks.push(`${m.title}:×`); (m.onClose ?? (() => hideModal(m)))(); } } : null),
  }));
  /** The frame's console: the engine's log target writes "[wxLog][LEVEL] text" lines to it. */
  const consoleOut: string[] = [];
  const engineConsole = Object.fromEntries((['log', 'info', 'warn', 'error', 'debug'] as const).map((k) => [k, (...a: unknown[]) => { consoleOut.push(`${k}: ${a.map(String).join(' ')}`); }])) as unknown as Console;
  const popupEl = {
    dispatchEvent: vi.fn((e: Event) => {
      if (e.type === 'keydown' && (e as KeyboardEvent).key === 'Escape' && (e as KeyboardEvent).code === 'Escape' && e.bubbles && ui.escapeCloses) ui.popup = false;
      return true;
    }),
  };
  /** The files Ctrl+S writes; by default every sheet and project file in the folder, in staging order. */
  const ctrlSFiles = (): string[] => [...files.keys()].filter((p) => /\.kicad_(sch|pro)$/.test(p));
  const ctrlS = vi.fn(() => {
    setTimeout(() => {
      for (const p of ctrlSFiles()) {
        FS.writeFile(p, `(saved ${p.slice(p.lastIndexOf('/') + 1)})`);
        win.kicadCollab?.onSave?.(p);
      }
    }, 5);
  });
  const Module = {
    kicadOpenFile: vi.fn((p: string) => { opened.push(p); }),
    kicadOpenFileBusy: () => false,
    kicadSaveSchematic: vi.fn((p: string) => { FS.writeFile(p, '(kicad_sch saved)'); }),
    kicadSaveBoard: vi.fn((p: string): unknown => { FS.writeFile(p, '(kicad_pcb saved)'); return undefined; }),
    kicadSheetsGetTree: vi.fn(() => JSON.stringify({ current: '/', sheets: [{ depth: 0, file: `${ROOT}/blink.kicad_sch`, name: 'blink', page: '1', parent: '', path: '/' }] })),
    kicadSheetsEnter: vi.fn((p: string) => p === '/' || p === '/00000000-0000-0000-0000-00005c7b59b0/'),
    kicadLayersGetState: vi.fn(() => JSON.stringify({ active: 0, layers: [
      { canonical: 'F.Cu', color: 'rgb(200, 52, 52)', copper: true, id: 0, name: 'F.Cu', visible: true },
      { canonical: 'B.Cu', color: 'rgb(77, 127, 196)', copper: true, id: 2, name: 'B.Cu', visible: true },
    ] })),
    kicadLayersSetVisible: vi.fn((id: number) => id === 0 || id === 2),
    kicadLayersSetActive: vi.fn((id: number) => id === 0 || id === 2),
    kicadSetChrome: vi.fn((on: boolean) => {
      chrome.length = 0;
      if (on) chrome.push({ typeName: 'wxMenuBar', visible: true });
      return true;
    }),
    kicadSetReadOnly: vi.fn(async () => true),
    notAnExport: 1,
  };
  const win = {
    FS,
    Module,
    wxElementRegistry: {
      findAll: (f: { type?: string; visible?: boolean } = {}) => [{ id: 'frame', typeName: 'SCH_EDIT_FRAME', name: 'SchematicFrame', visible: true }, ...dialogs, ...chrome, ...modalElements()]
        .filter((e) => (f.type == null || e.typeName === f.type) && (f.visible !== true || e.visible)),
      findByLabel: () => [],
    },
    document: {
      querySelector: (sel: string) => (ui.popup && sel === '.wx-menu-popup' ? popupEl : null),
      querySelectorAll: (sel: string) => (sel === 'button.wx-dom-control' ? domButtons() : sel === '[id^="window-"]' ? windowDivs() : []),
    },
    console: engineConsole,
    dispatchEvent: (e: Event) => {
      const k = e as KeyboardEvent;
      if (e.type === 'keydown' && k.ctrlKey && k.code === 'KeyS') ctrlS();
      return true;
    },
  } as unknown as ToolWindow & { kicadCollab?: { onSave?: (p: string) => void } };
  return { win, files, dirs, busy, broken, pinned, opened, Module, dialogs, chrome, ui, popupEl, ctrlS, modals, clicks, showModal, hideModal, consoleOut, engineConsole };
}

/** A dialog the fake engine shows: its box, its title, its buttons (in order), its static texts. */
interface FakeModal {
  id: string;
  title: string;
  x: number; y: number; w: number; h: number;
  buttons: Array<{ label: string; on?: () => void }>;
  texts?: string[];
  /** A gauge (KiCad's progress reporter shows one beside its Cancel). */
  gauge?: boolean;
  /** A collapsible details pane (a wxLog report of several lines). */
  pane?: boolean;
  /** What the title bar's close box does; by default the dialog goes. */
  onClose?: () => void;
}

const b = (s: string) => new TextEncoder().encode(s);

describe('startResponder', () => {
  it('posts hello to the parent origin with a nonce and accepts one connect carrying it', () => {
    const { page, parent } = fakePage();
    startResponder({ parentOrigin: PARENT, page });
    expect(parent.postMessage).toHaveBeenCalledTimes(1);
    const [hello, target] = parent.postMessage.mock.calls[0];
    expect(hello).toMatchObject({ type: 'cc.hello', proto: 1 });
    expect(Object.keys(hello).sort()).toEqual(['island', 'nonce', 'proto', 'type']);
    expect(typeof hello.nonce).toBe('string');
    expect(target).toBe(PARENT);
    const ch = new MessageChannel();
    const got: unknown[] = [];
    ch.port1.onmessage = (m) => got.push(m.data);
    page.dispatch('message', { origin: 'https://evil.example', source: page.parent, data: { type: 'cc.connect', nonce: hello.nonce }, ports: [ch.port2] });
    page.dispatch('message', { origin: PARENT, source: {}, data: { type: 'cc.connect', nonce: hello.nonce }, ports: [ch.port2] });
    page.dispatch('message', { origin: PARENT, source: page.parent, data: { type: 'cc.connect', nonce: 'wrong' }, ports: [ch.port2] });
    page.dispatch('message', { origin: PARENT, source: page.parent, data: { type: 'cc.connect', nonce: hello.nonce }, ports: [ch.port2] });
    ch.port1.postMessage({ id: 1, op: 'project.forget' });
    return new Promise<void>((r) => setTimeout(() => { expect(got).toEqual([{ id: 1, ok: true, result: {} }]); r(); }, 20));
  });

  it('never adopts a port from the wrong origin, the wrong source or the wrong nonce', async () => {
    const { page, parent } = fakePage();
    startResponder({ parentOrigin: PARENT, page });
    const nonce = parent.postMessage.mock.calls[0][0].nonce;
    const attempts = [
      { origin: 'https://evil.example', source: page.parent, nonce },
      { origin: PARENT, source: {}, nonce },
      { origin: PARENT, source: page.parent, nonce: 'wrong' },
    ];
    const heard: unknown[][] = [];
    for (const a of attempts) {
      const ch = new MessageChannel();
      const got: unknown[] = [];
      heard.push(got);
      ch.port1.onmessage = (m) => got.push(m.data);
      page.dispatch('message', { origin: a.origin, source: a.source, data: { type: 'cc.connect', nonce: a.nonce }, ports: [ch.port2] });
      ch.port1.postMessage({ id: 1, op: 'project.forget' });
    }
    const good = connect(page, nonce);
    good.port.postMessage({ id: 2, op: 'project.forget' });
    await settle();
    expect(heard).toEqual([[], [], []]);
    expect(good.got).toEqual([{ id: 2, ok: true, result: {} }]);
  });

  it('refuses a connect with an extra key and ignores every connect after the first', async () => {
    const { page, parent } = fakePage();
    startResponder({ parentOrigin: PARENT, page });
    const nonce = parent.postMessage.mock.calls[0][0].nonce;
    const extra = new MessageChannel();
    const extraGot: unknown[] = [];
    extra.port1.onmessage = (m) => extraGot.push(m.data);
    page.dispatch('message', { origin: PARENT, source: page.parent, data: { type: 'cc.connect', nonce, url: 'x' }, ports: [extra.port2] });
    const first = connect(page, nonce);
    const second = connect(page, nonce);
    extra.port1.postMessage({ id: 1, op: 'project.forget' });
    first.port.postMessage({ id: 2, op: 'project.forget' });
    second.port.postMessage({ id: 3, op: 'project.forget' });
    await settle();
    expect(extraGot).toEqual([]);
    expect(first.got).toEqual([{ id: 2, ok: true, result: {} }]);
    expect(second.got).toEqual([]);
  });

  it('answers unknown ops with an error and validates project.open args', async () => {
    const { page, parent } = fakePage();
    startResponder({ parentOrigin: PARENT, page });
    const nonce = parent.postMessage.mock.calls[0][0].nonce;
    const ch = new MessageChannel();
    const got: unknown[] = [];
    ch.port1.onmessage = (m) => got.push(m.data);
    page.dispatch('message', { origin: PARENT, source: page.parent, data: { type: 'cc.connect', nonce }, ports: [ch.port2] });
    ch.port1.postMessage({ id: 2, op: 'nope' });
    ch.port1.postMessage({ id: 3, op: 'project.open', args: { name: 'x', files: 'not-an-array' } });
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual([
      { id: 2, ok: false, error: { code: 'unknown_op', message: 'nope' } },
      { id: 3, ok: false, error: { code: 'bad_args', message: 'project.open' } },
    ]);
  });

  it('rejects unknown fields on requests and args, and answers not_ready before boot', async () => {
    const { page, parent } = fakePage();
    startResponder({ parentOrigin: PARENT, page });
    const { port, got } = connect(page, parent.postMessage.mock.calls[0][0].nonce);
    port.postMessage({ id: 1, op: 'readonly', args: { on: true }, extra: 1 });
    port.postMessage({ id: 2, op: 'chrome.show', args: { on: true, url: 'x' } });
    port.postMessage({ id: 3, op: 'project.open', args: { name: 'x', files: [{ path: 'a.kicad_sch', bytes: b('x'), url: 'y' }] } });
    port.postMessage({ id: 4, op: 'project.save', args: { path: 'x' } });
    port.postMessage({ id: 5, op: 'readonly', args: { on: true } });
    port.postMessage({ id: 6, op: 'project.open', args: { name: 'x', files: [] } });
    await settle();
    expect(got).toEqual([
      { id: 1, ok: false, error: { code: 'bad_args', message: 'readonly' } },
      { id: 2, ok: false, error: { code: 'bad_args', message: 'chrome.show' } },
      { id: 3, ok: false, error: { code: 'bad_args', message: 'project.open' } },
      { id: 4, ok: false, error: { code: 'bad_args', message: 'project.save' } },
      { id: 5, ok: false, error: { code: 'not_ready', message: 'readonly' } },
      { id: 6, ok: false, error: { code: 'not_ready', message: 'project.open' } },
    ]);
  });

  it('queues events until the port connects and sends each with exactly its keys', async () => {
    const { page, parent } = fakePage();
    const r = startResponder({ parentOrigin: PARENT, page });
    r.emit({ type: 'ev.state', phase: 'preflight' });
    r.emit({ type: 'ev.state', phase: 'booting', detail: 'Compiling' });
    r.emit({ type: 'ev.help', topic: 'getting_started_in_kicad' });
    const { got } = connect(page, parent.postMessage.mock.calls[0][0].nonce);
    r.emit({ type: 'ev.closing' });
    await settle();
    expect(got).toEqual([
      { type: 'ev.state', phase: 'preflight' },
      { type: 'ev.state', phase: 'booting', detail: 'Compiling' },
      { type: 'ev.help', topic: 'getting_started_in_kicad' },
      { type: 'ev.closing' },
    ]);
    expect(Object.keys(got[0])).toEqual(['type', 'phase']);
  });

  it('stages under the project root, opens, saves as events and forgets', async () => {
    const { page, parent } = fakePage('?frame=sch&theme=night');
    const r = startResponder({ parentOrigin: PARENT, page });
    const { port, got } = connect(page, parent.postMessage.mock.calls[0][0].nonce);
    const eng = fakeEngine();
    r.engineReady(eng.win, { tag: 'v0.2.3-cc1', kicad: '10.0' }, { attempts: () => 2 });
    await settle();
    expect(got).toEqual([
      { type: 'ev.state', phase: 'booting', detail: '2 popup attempts blocked' },
      { type: 'ev.ready', caps: ['kicadLayersGetState', 'kicadLayersSetActive', 'kicadLayersSetVisible', 'kicadOpenFile', 'kicadOpenFileBusy', 'kicadSaveBoard', 'kicadSaveSchematic', 'kicadSetChrome', 'kicadSetReadOnly', 'kicadSheetsEnter', 'kicadSheetsGetTree'], engine: { tag: 'v0.2.3-cc1', kicad: '10.0' } },
    ]);
    got.length = 0;

    port.postMessage({ id: 1, op: 'project.open', args: { name: 'Blink', files: [
      { path: 'blink.kicad_pro', bytes: b('{}') },
      { path: 'sub/power.kicad_sch', bytes: b('(kicad_sch power)') },
      { path: 'blink.kicad_sch', bytes: b('(kicad_sch)') },
      { path: '../../../../.config/kicad/kicad/10.0/kicad_common.json', bytes: b('{}') },
    ] } });
    await settle(100);
    expect(got).toEqual([
      { type: 'ev.state', phase: 'staging' },
      { type: 'ev.state', phase: 'opening' },
      { id: 1, ok: true, result: { opened: 'blink.kicad_sch', dropped: ['../../../../.config/kicad/kicad/10.0/kicad_common.json'], chrome: false } },
    ]);
    expect(eng.opened).toEqual([`${ROOT}/blink.kicad_sch`]);
    expect([...eng.files.keys()].every((k) => k.startsWith(`${ROOT}/`))).toBe(true);
    got.length = 0;

    // The host's save is KiCad's own Save (Ctrl+S): every sheet and the project
    // file arrive as ev.saved, and only then the answer, which lists them.
    port.postMessage({ id: 2, op: 'project.save' });
    await settle(100);
    expect(eng.ctrlS).toHaveBeenCalledTimes(1);
    expect(eng.Module.kicadSaveSchematic).not.toHaveBeenCalled();
    expect(got).toEqual([
      { type: 'ev.saved', path: 'blink.kicad_pro', bytes: b('(saved blink.kicad_pro)') },
      { type: 'ev.saved', path: 'sub/power.kicad_sch', bytes: b('(saved power.kicad_sch)') },
      { type: 'ev.saved', path: 'blink.kicad_sch', bytes: b('(saved blink.kicad_sch)') },
      { id: 2, ok: true, result: { path: 'blink.kicad_sch', saved: ['blink.kicad_pro', 'sub/power.kicad_sch', 'blink.kicad_sch'] } },
    ]);
    expect(got[0].bytes).toBeInstanceOf(Uint8Array);
    got.length = 0;

    // Ctrl+S inside the editor: the fork's chokepoint calls kicadCollab.onSave(absPath).
    eng.files.set(`${ROOT}/sub/power.kicad_sch`, b('(kicad_sch power edited)'));
    eng.win.kicadCollab?.onSave?.(`${ROOT}/sub/power.kicad_sch`);
    eng.win.kicadCollab?.onSave?.('/home/kicad/.config/kicad/kicad/10.0/kicad_common.json');
    await settle();
    expect(got).toEqual([{ type: 'ev.saved', path: 'sub/power.kicad_sch', bytes: b('(kicad_sch power edited)') }]);
    got.length = 0;

    port.postMessage({ id: 3, op: 'readonly', args: { on: true } });
    port.postMessage({ id: 4, op: 'chrome.show', args: { on: false } });
    port.postMessage({ id: 5, op: 'project.forget' });
    await settle();
    expect(eng.Module.kicadSetReadOnly).toHaveBeenCalledWith(true);
    expect(eng.Module.kicadSetChrome).toHaveBeenCalledWith(false);
    expect(got).toEqual([
      { id: 3, ok: true, result: {} },
      { id: 4, ok: true, result: {} },
      { id: 5, ok: true, result: {} },
    ]);
    expect([...eng.files.keys()]).toEqual([]);
    expect(eng.dirs.has(ROOT)).toBe(false);
  });

  it('opens over an opened project and forgets it while the engine holds the folder as its working directory', async () => {
    const { page, parent } = fakePage();
    const r = startResponder({ parentOrigin: PARENT, page });
    const { port, got } = connect(page, parent.postMessage.mock.calls[0][0].nonce);
    const eng = fakeEngine();
    r.engineReady(eng.win, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
    port.postMessage({ id: 1, op: 'project.open', args: { name: 'a', files: [
      { path: 'a.kicad_sch', bytes: b('(kicad_sch a)') }, { path: 'lib/a.kicad_sym', bytes: b('(kicad_symbol_lib)') },
    ] } });
    await settle(100);
    // KiCad changed into the opened project's folder, and wrote its lock file there.
    eng.busy.add(ROOT);
    eng.files.set(`${ROOT}/~a.kicad_sch.lck`, b('lock'));
    got.length = 0;
    port.postMessage({ id: 2, op: 'project.open', args: { name: 'b', files: [{ path: 'b.kicad_sch', bytes: b('(kicad_sch b)') }] } });
    await settle(100);
    expect(got.at(-1)).toEqual({ id: 2, ok: true, result: { opened: 'b.kicad_sch', dropped: [], chrome: false } });
    expect([...eng.files.keys()]).toEqual([`${ROOT}/b.kicad_sch`]);
    expect(eng.dirs.has(`${ROOT}/lib`)).toBe(false);
    got.length = 0;
    port.postMessage({ id: 3, op: 'project.forget' });
    await settle();
    expect(got).toEqual([{ id: 3, ok: true, result: {} }]);
    expect([...eng.files.keys()]).toEqual([]);
  });

  it('answers busy to project.open and project.save while the engine is still loading a file', async () => {
    const { page, parent } = fakePage();
    const r = startResponder({ parentOrigin: PARENT, page });
    const { port, got } = connect(page, parent.postMessage.mock.calls[0][0].nonce);
    const eng = fakeEngine();
    r.engineReady(eng.win, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
    port.postMessage({ id: 1, op: 'project.open', args: { name: 'x', files: [{ path: 'blink.kicad_sch', bytes: b('(kicad_sch)') }] } });
    await settle(100);
    got.length = 0;
    const mod = eng.Module as { kicadOpenFileBusy: () => boolean };
    mod.kicadOpenFileBusy = () => true;
    port.postMessage({ id: 2, op: 'project.save' });
    port.postMessage({ id: 3, op: 'project.open', args: { name: 'y', files: [{ path: 'other.kicad_sch', bytes: b('(kicad_sch other)') }] } });
    port.postMessage({ id: 4, op: 'project.forget' });
    await settle();
    expect(got).toEqual([
      { id: 2, ok: false, error: { code: 'busy', message: 'the engine is busy' } },
      { id: 3, ok: false, error: { code: 'busy', message: 'the engine is busy' } },
      { id: 4, ok: true, result: {} },
    ]);
    expect(eng.Module.kicadSaveSchematic).not.toHaveBeenCalled();
    expect(eng.opened).toEqual([`${ROOT}/blink.kicad_sch`]);
    // Once the load settles the same requests go through.
    mod.kicadOpenFileBusy = () => false;
    got.length = 0;
    port.postMessage({ id: 5, op: 'project.open', args: { name: 'y', files: [{ path: 'other.kicad_sch', bytes: b('(kicad_sch other)') }] } });
    await settle(100);
    expect(got.at(-1)).toEqual({ id: 5, ok: true, result: { opened: 'other.kicad_sch', dropped: [], chrome: false } });
  });

  it('quiets the engine leave prompt after a host save that emitted ev.saved, and after forget until the next successful open', async () => {
    resetUnloadQuietForTest();
    const { page, parent } = fakePage();
    const r = startResponder({ parentOrigin: PARENT, page });
    const { port, got } = connect(page, parent.postMessage.mock.calls[0][0].nonce);
    const eng = fakeEngine();
    r.engineReady(eng.win, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
    port.postMessage({ id: 1, op: 'project.open', args: { name: 'x', files: [{ path: 'blink.kicad_sch', bytes: b('(kicad_sch)') }] } });
    await settle(100);
    expect(isQuiet()).toBe(false);
    // A save that wrote nothing emits no ev.saved and leaves the prompt alone.
    eng.ctrlS.mockImplementationOnce(() => undefined);
    port.postMessage({ id: 2, op: 'project.save' });
    await settle(150);
    expect(got.at(-1)).toMatchObject({ id: 2, ok: false });
    expect(isQuiet()).toBe(false);
    // Ctrl+S inside the editor is the user's save, not the host's: no quiet either.
    eng.win.kicadCollab?.onSave?.(`${ROOT}/blink.kicad_sch`);
    await settle();
    expect(isQuiet()).toBe(false);
    port.postMessage({ id: 3, op: 'project.save' });
    await settle(100);
    expect(got.at(-1)).toEqual({ id: 3, ok: true, result: { path: 'blink.kicad_sch', saved: ['blink.kicad_sch'] } });
    expect(isQuiet()).toBe(true);
    expect(isQuiet(Date.now() + 9_000)).toBe(true);
    expect(isQuiet(Date.now() + 10_001)).toBe(false);
    port.postMessage({ id: 4, op: 'project.forget' });
    await settle();
    expect(isQuiet(Date.now() + 3_600_000)).toBe(true);
    // An open that fails leaves the quiet in place; a successful one clears it,
    // so the reopened document's edits get the engine's prompt again.
    port.postMessage({ id: 5, op: 'project.open', args: { name: 'y', files: [{ path: 'notes.txt', bytes: b('x') }] } });
    await settle(100);
    expect(got.at(-1)).toMatchObject({ id: 5, ok: false, error: { code: 'nothing_to_open' } });
    expect(isQuiet(Date.now() + 3_600_000)).toBe(true);
    port.postMessage({ id: 6, op: 'project.open', args: { name: 'y', files: [{ path: 'blink.kicad_sch', bytes: b('(kicad_sch)') }] } });
    await settle(100);
    expect(got.at(-1)).toEqual({ id: 6, ok: true, result: { opened: 'blink.kicad_sch', dropped: [], chrome: false } });
    expect(isQuiet()).toBe(false);
    resetUnloadQuietForTest();
  });

  it('ends the Ctrl+S hook on forget: a later save emits nothing until the next open registers a fresh hook', async () => {
    const { page, parent } = fakePage();
    const r = startResponder({ parentOrigin: PARENT, page });
    const { port, got } = connect(page, parent.postMessage.mock.calls[0][0].nonce);
    const eng = fakeEngine();
    r.engineReady(eng.win, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
    // Before any open there is no hook: the engine's callback slot is empty.
    expect(eng.win.kicadCollab?.onSave).toBeUndefined();
    port.postMessage({ id: 1, op: 'project.open', args: { name: 'x', files: [{ path: 'blink.kicad_sch', bytes: b('(kicad_sch)') }] } });
    await settle(100);
    const firstHook = eng.win.kicadCollab?.onSave;
    expect(typeof firstHook).toBe('function');
    port.postMessage({ id: 2, op: 'project.forget' });
    await settle();
    expect(eng.win.kicadCollab?.onSave).toBeUndefined();
    got.length = 0;
    // The engine still shows the document; Ctrl+S writes it back under the wiped root.
    eng.files.set(`${ROOT}/blink.kicad_sch`, b('(kicad_sch after forget)'));
    firstHook?.(`${ROOT}/blink.kicad_sch`);
    eng.win.kicadCollab?.onSave?.(`${ROOT}/blink.kicad_sch`);
    await settle();
    expect(got).toEqual([]);
    // The next open registers a fresh hook, and Ctrl+S emits again.
    port.postMessage({ id: 3, op: 'project.open', args: { name: 'y', files: [{ path: 'blink.kicad_sch', bytes: b('(kicad_sch y)') }] } });
    await settle(100);
    expect(eng.win.kicadCollab?.onSave).not.toBe(firstHook);
    got.length = 0;
    eng.files.set(`${ROOT}/blink.kicad_sch`, b('(kicad_sch y edited)'));
    eng.win.kicadCollab?.onSave?.(`${ROOT}/blink.kicad_sch`);
    await settle();
    expect(got).toEqual([{ type: 'ev.saved', path: 'blink.kicad_sch', bytes: b('(kicad_sch y edited)') }]);
  });

  it('emits ev.saved only for paths under the staged root: a bare Save-As file in the projects home is ignored', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const { page, parent } = fakePage();
    const r = startResponder({ parentOrigin: PARENT, page });
    const { port, got } = connect(page, parent.postMessage.mock.calls[0][0].nonce);
    const eng = fakeEngine();
    r.engineReady(eng.win, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
    port.postMessage({ id: 1, op: 'project.open', args: { name: 'x', files: [{ path: 'blink.kicad_sch', bytes: b('(kicad_sch)') }] } });
    await settle(100);
    got.length = 0;
    const home = ROOT.slice(0, ROOT.lastIndexOf('/'));
    eng.files.set(`${home}/copy.kicad_sch`, b('(kicad_sch copy)'));
    eng.win.kicadCollab?.onSave?.(`${home}/copy.kicad_sch`);
    eng.files.set(`${ROOT}2/blink.kicad_sch`, b('(kicad_sch sibling)'));
    eng.win.kicadCollab?.onSave?.(`${ROOT}2/blink.kicad_sch`);
    await settle();
    expect(got).toEqual([]);
    expect(debug.mock.calls.some((c) => String(c[1]) === `${home}/copy.kicad_sch`)).toBe(true);
    eng.win.kicadCollab?.onSave?.(`${ROOT}/blink.kicad_sch`);
    await settle();
    expect(got).toEqual([{ type: 'ev.saved', path: 'blink.kicad_sch', bytes: b('(kicad_sch)') }]);
    debug.mockRestore();
  });

  it('keeps only the busy working directory: any other rmdir failure answers island_error with its errno', async () => {
    const { page, parent } = fakePage();
    const r = startResponder({ parentOrigin: PARENT, page });
    const { port, got } = connect(page, parent.postMessage.mock.calls[0][0].nonce);
    const eng = fakeEngine();
    r.engineReady(eng.win, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
    port.postMessage({ id: 1, op: 'project.open', args: { name: 'x', files: [
      { path: 'blink.kicad_sch', bytes: b('(kicad_sch)') }, { path: 'lib/a.kicad_sym', bytes: b('(kicad_symbol_lib)') },
    ] } });
    await settle(100);
    got.length = 0;
    eng.broken.set(`${ROOT}/lib`, 63);
    port.postMessage({ id: 2, op: 'project.forget' });
    await settle();
    expect(got).toEqual([{ id: 2, ok: false, error: { code: 'island_error', message: 'ErrnoError errno 63' } }]);
    // The bridge forgot the project even though the wipe failed.
    got.length = 0;
    port.postMessage({ id: 3, op: 'project.save' });
    await settle();
    expect(got).toEqual([{ id: 3, ok: false, error: { code: 'not_ready', message: 'project.save' } }]);
    expect(eng.Module.kicadSaveSchematic).not.toHaveBeenCalled();
    eng.broken.clear();
    got.length = 0;
    port.postMessage({ id: 4, op: 'project.forget' });
    await settle();
    expect(got).toEqual([{ id: 4, ok: true, result: {} }]);
  });

  it('keeps a busy subfolder and its parents when the opened file sits in a subfolder, then forgets and opens again', async () => {
    const { page, parent } = fakePage();
    const r = startResponder({ parentOrigin: PARENT, page });
    const { port, got } = connect(page, parent.postMessage.mock.calls[0][0].nonce);
    const eng = fakeEngine();
    r.engineReady(eng.win, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
    port.postMessage({ id: 1, op: 'project.open', args: { name: 'a', open: 'proj/a.kicad_sch', files: [
      { path: 'proj/a.kicad_sch', bytes: b('(kicad_sch a)') }, { path: 'proj/lib/a.kicad_sym', bytes: b('(kicad_symbol_lib)') },
    ] } });
    await settle(100);
    expect(got.at(-1)).toEqual({ id: 1, ok: true, result: { opened: 'proj/a.kicad_sch', dropped: [], chrome: false } });
    // KiCad changed into the opened file's own folder, below the project root.
    eng.busy.add(`${ROOT}/proj`);
    got.length = 0;
    port.postMessage({ id: 2, op: 'project.forget' });
    await settle();
    expect(got).toEqual([{ id: 2, ok: true, result: {} }]);
    expect([...eng.files.keys()]).toEqual([]);
    expect(eng.dirs.has(`${ROOT}/proj`)).toBe(true);
    expect(eng.dirs.has(`${ROOT}/proj/lib`)).toBe(false);
    got.length = 0;
    port.postMessage({ id: 3, op: 'project.open', args: { name: 'b', files: [{ path: 'b.kicad_sch', bytes: b('(kicad_sch b)') }] } });
    await settle(100);
    expect(got.at(-1)).toEqual({ id: 3, ok: true, result: { opened: 'b.kicad_sch', dropped: [], chrome: false } });
    expect([...eng.files.keys()]).toEqual([`${ROOT}/b.kicad_sch`]);
    got.length = 0;
    port.postMessage({ id: 4, op: 'project.forget' });
    await settle();
    expect(got).toEqual([{ id: 4, ok: true, result: {} }]);
  });

  it('still answers island_error when a folder is not empty and nothing below it is busy', async () => {
    const { page, parent } = fakePage();
    const r = startResponder({ parentOrigin: PARENT, page });
    const { port, got } = connect(page, parent.postMessage.mock.calls[0][0].nonce);
    const eng = fakeEngine();
    r.engineReady(eng.win, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
    port.postMessage({ id: 1, op: 'project.open', args: { name: 'x', files: [{ path: 'blink.kicad_sch', bytes: b('(kicad_sch)') }] } });
    await settle(100);
    eng.pinned.add(`${ROOT}/blink.kicad_sch`);
    got.length = 0;
    port.postMessage({ id: 2, op: 'project.forget' });
    await settle();
    expect(got).toEqual([{ id: 2, ok: false, error: { code: 'island_error', message: 'ErrnoError errno 55' } }]);
  });

  it('describes MEMFS ErrnoErrors by code or name and errno, never as [object Object]', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
    expect(describeError({ name: 'ErrnoError', errno: 44 })).toBe('ErrnoError errno 44');
    expect(describeError({ name: 'ErrnoError', code: 'ENOENT', errno: 44 })).toBe('ENOENT errno 44');
    expect(describeError({ errno: 10 })).toBe('errno 10');
    expect(describeError('plain')).toBe('plain');
    expect(describeError({ some: 'object' })).toBe('[object Object]');
  });

  it('answers save_failed and emits nothing when the board save writes nothing', async () => {
    const { page, parent } = fakePage('?frame=pcb&theme=day');
    const r = startResponder({ parentOrigin: PARENT, page });
    const { port, got } = connect(page, parent.postMessage.mock.calls[0][0].nonce);
    const eng = fakeEngine();
    eng.Module.kicadSaveBoard.mockImplementation(() => undefined);   // the binding swallowed a failure
    r.engineReady(eng.win, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
    port.postMessage({ id: 1, op: 'project.open', args: { name: 'x', files: [{ path: 'blink.kicad_pcb', bytes: b('(kicad_pcb staged)') }] } });
    await settle(100);
    got.length = 0;
    port.postMessage({ id: 2, op: 'project.save' });
    await settle();
    expect(eng.Module.kicadSaveBoard).toHaveBeenCalledWith(`${ROOT}/blink.kicad_pcb`);
    expect(got).toEqual([{ id: 2, ok: false, error: { code: 'save_failed', message: 'blink.kicad_pcb' } }]);
    // The staged bytes are back where the engine expects its document.
    expect(eng.files.get(`${ROOT}/blink.kicad_pcb`)).toEqual(b('(kicad_pcb staged)'));
    // A save that throws after writing nothing fails the same way.
    eng.Module.kicadSaveBoard.mockImplementation(() => { throw new Error('boom'); });
    got.length = 0;
    port.postMessage({ id: 3, op: 'project.save' });
    await settle();
    expect(got).toEqual([{ id: 3, ok: false, error: { code: 'save_failed', message: 'blink.kicad_pcb' } }]);
    // A save that writes an empty file is a failure too.
    eng.Module.kicadSaveBoard.mockImplementation((p: string) => { eng.win.FS!.writeFile(p, new Uint8Array(0)); return undefined; });
    got.length = 0;
    port.postMessage({ id: 4, op: 'project.save' });
    await settle();
    expect(got).toEqual([{ id: 4, ok: false, error: { code: 'save_failed', message: 'blink.kicad_pcb' } }]);
    expect(eng.files.get(`${ROOT}/blink.kicad_pcb`)).toEqual(b('(kicad_pcb staged)'));
    // A save that never answers fails once the engine call's bound runs out, and the next request is answered.
    const applyMs = timing.applyMs;
    timing.applyMs = 40;
    try {
      eng.Module.kicadSaveBoard.mockImplementation(() => new Promise(() => undefined));
      got.length = 0;
      port.postMessage({ id: 5, op: 'project.save' });
      port.postMessage({ id: 6, op: 'readonly', args: { on: false } });
      await settle(120);
      expect(got).toEqual([
        { id: 5, ok: false, error: { code: 'save_failed', message: 'blink.kicad_pcb' } },
        { id: 6, ok: true, result: {} },
      ]);
    } finally { timing.applyMs = applyMs; }
    // A board save that writes answers the board alone: the frame shows one file.
    eng.Module.kicadSaveBoard.mockImplementation((p: string) => { eng.win.FS!.writeFile(p, '(kicad_pcb saved)'); return undefined; });
    got.length = 0;
    port.postMessage({ id: 7, op: 'project.save' });
    await settle();
    expect(got).toEqual([
      { type: 'ev.saved', path: 'blink.kicad_pcb', bytes: b('(kicad_pcb saved)') },
      { id: 7, ok: true, result: { path: 'blink.kicad_pcb', saved: ['blink.kicad_pcb'] } },
    ]);
    expect(eng.ctrlS).not.toHaveBeenCalled();
  });

  it('answers island_error when a handler rejects and still answers the next request', async () => {
    const { page, parent } = fakePage();
    startResponder({ parentOrigin: PARENT, page });
    const nonce = parent.postMessage.mock.calls[0][0].nonce;
    const ch = new MessageChannel();
    const got: unknown[] = [];
    ch.port1.onmessage = (m) => got.push(m.data);
    // The first two answers throw (the reply and the catch's own reply), so the
    // handler itself rejects; later posts go through.
    const real = ch.port2.postMessage.bind(ch.port2);
    let throws = 2;
    ch.port2.postMessage = ((...a: Parameters<MessagePort['postMessage']>) => {
      if (throws > 0) { throws -= 1; throw new Error('clone failed'); }
      return real(...(a as [unknown]));
    }) as MessagePort['postMessage'];
    page.dispatch('message', { origin: PARENT, source: page.parent, data: { type: 'cc.connect', nonce }, ports: [ch.port2] });
    ch.port1.postMessage({ id: 1, op: 'project.forget' });
    ch.port1.postMessage({ id: 2, op: 'project.forget' });
    await settle();
    expect(got).toEqual([
      { id: 1, ok: false, error: { code: 'island_error', message: 'clone failed' } },
      { id: 2, ok: true, result: {} },
    ]);
  });

  it('refuses an explicit open that is not this frame\'s own kind', async () => {
    const { page, parent } = fakePage('?frame=pcb&theme=day');
    const r = startResponder({ parentOrigin: PARENT, page });
    const { port, got } = connect(page, parent.postMessage.mock.calls[0][0].nonce);
    const eng = fakeEngine();
    r.engineReady(eng.win, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
    await settle();
    got.length = 0;
    port.postMessage({ id: 1, op: 'project.open', args: { name: 'x', files: [
      { path: 'blink.kicad_sch', bytes: b('(kicad_sch)') }, { path: 'blink.kicad_pcb', bytes: b('(kicad_pcb)') },
    ], open: 'blink.kicad_sch' } });
    await settle();
    expect(got).toEqual([{ id: 1, ok: false, error: { code: 'bad_args', message: 'project.open' } }]);
    expect(eng.opened).toEqual([]);
    expect(eng.files.size).toBe(0);
  });

  it('reports blocked popups after ev.ready as ev.state popup, and only the booting note before', async () => {
    const { page, parent } = fakePage();
    const r = startResponder({ parentOrigin: PARENT, page });
    const { got } = connect(page, parent.postMessage.mock.calls[0][0].nonce);
    r.popupBlocked(1);   // before ready: counted into the booting note, no event of its own
    const eng = fakeEngine();
    r.engineReady(eng.win, { tag: 't', kicad: '10.0' }, { attempts: () => 1 });
    r.popupBlocked(2);
    r.popupBlocked(3);
    await settle();
    expect(got.map((e) => (e.type === 'ev.ready' ? { type: e.type } : e))).toEqual([
      { type: 'ev.state', phase: 'booting', detail: '1 popup attempts blocked' },
      { type: 'ev.ready' },
      { type: 'ev.state', phase: 'popup', detail: '2 popup attempts blocked' },
      { type: 'ev.state', phase: 'popup', detail: '3 popup attempts blocked' },
    ]);
  });

  /** A connected responder over a booted sch engine with a two-sheet schematic opened; `request` answers its reply. */
  async function twoSheets(eng = fakeEngine()) {
    const { page, parent } = fakePage();
    const r = startResponder({ parentOrigin: PARENT, page });
    const { port, got } = connect(page, parent.postMessage.mock.calls[0][0].nonce);
    r.engineReady(eng.win, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
    port.postMessage({ id: 1, op: 'project.open', args: { name: 'x', files: [
      { path: 'blink.kicad_sch', bytes: b('(kicad_sch)') }, { path: 'sub/power.kicad_sch', bytes: b('(kicad_sch)') },
    ], open: 'blink.kicad_sch' } });
    await settle(100);
    eng.Module.kicadSheetsGetTree.mockReturnValue(JSON.stringify({ current: '/a/', sheets: [
      { path: '/', file: `${ROOT}/blink.kicad_sch` }, { path: '/a/', file: `${ROOT}/sub/power.kicad_sch` },
    ] }));
    got.length = 0;
    let id = 1;
    const request = async (op: string, args?: unknown, wait = 100) => {
      const n = ++id;
      port.postMessage(args === undefined ? { id: n, op } : { id: n, op, args });
      await settle(wait);
      return got.find((m) => m.id === n);
    };
    return { eng, got, request };
  }

  it('saves every sheet through KiCad\'s own Save, and names the shown sheet in path', async () => {
    const { eng, got, request } = await twoSheets();
    expect(await request('project.save')).toEqual({ id: 2, ok: true, result: { path: 'sub/power.kicad_sch', saved: ['blink.kicad_sch', 'sub/power.kicad_sch'] } });
    // Every ev.saved arrived before the answer.
    expect(got.map((m) => m.type ?? `answer ${m.id}`)).toEqual(['ev.saved', 'ev.saved', 'answer 2']);
    expect(eng.Module.kicadSaveSchematic).not.toHaveBeenCalled();
    // A shown sheet outside the project still saves the project; path falls back to the opened file.
    eng.Module.kicadSheetsGetTree.mockReturnValue(JSON.stringify({ current: '/b/', sheets: [
      { path: '/', file: `${ROOT}/blink.kicad_sch` }, { path: '/b/', file: '/tmp/elsewhere.kicad_sch' },
    ] }));
    expect(await request('project.save')).toEqual({ id: 3, ok: true, result: { path: 'blink.kicad_sch', saved: ['blink.kicad_sch', 'sub/power.kicad_sch'] } });
  });

  it('waits for every sheet file the tree names, even when they arrive apart', async () => {
    const eng = fakeEngine();
    const { got, request } = await twoSheets(eng);
    // The root at 5 ms, the sub-sheet 30 ms later: past the settle pause, inside the quiet pause.
    eng.ctrlS.mockImplementation(() => {
      setTimeout(() => { eng.files.set(`${ROOT}/blink.kicad_sch`, b('(root)')); eng.win.kicadCollab?.onSave?.(`${ROOT}/blink.kicad_sch`); }, 5);
      setTimeout(() => { eng.files.set(`${ROOT}/sub/power.kicad_sch`, b('(power)')); eng.win.kicadCollab?.onSave?.(`${ROOT}/sub/power.kicad_sch`); }, 35);
    });
    expect(await request('project.save', undefined, 150)).toMatchObject({ ok: true, result: { saved: ['blink.kicad_sch', 'sub/power.kicad_sch'] } });
    expect(got.map((m) => m.type ?? 'answer')).toEqual(['ev.saved', 'ev.saved', 'answer']);
  });

  it('without a sheet tree, answers after a quiet pause with whatever KiCad saved', async () => {
    const eng = fakeEngine();
    const { request } = await twoSheets(eng);
    eng.Module.kicadSheetsGetTree.mockReturnValue('');
    const t0 = Date.now();
    expect(await request('project.save', undefined, 150)).toMatchObject({ ok: true, result: { path: 'blink.kicad_sch', saved: ['blink.kicad_sch', 'sub/power.kicad_sch'] } });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(timing.saveQuietMs);
  });

  it('answers save_failed when KiCad saves nothing, and busy (pressing nothing) while a dialog or a popup Escape cannot close is up', async () => {
    const { eng, got, request } = await twoSheets();
    eng.ctrlS.mockImplementationOnce(() => undefined);
    expect(await request('project.save', undefined, 150)).toEqual({ id: 2, ok: false, error: { code: 'save_failed', message: 'the editor saved nothing' } });
    expect(got.filter((m) => m.type === 'ev.saved')).toEqual([]);
    eng.ctrlS.mockClear();
    eng.dialogs.push({ typeName: 'wxGenericMessageDialog', visible: true });
    expect(await request('project.save')).toMatchObject({ ok: false, error: { code: 'busy' } });
    eng.dialogs.length = 0;
    // A menu bar popup (KiCad's menus shown) takes no Escape: it stays, and the save is refused.
    eng.ui.popup = true;
    eng.ui.escapeCloses = false;
    expect(await request('project.save')).toMatchObject({ ok: false, error: { code: 'busy' } });
    expect(eng.ui.popup).toBe(true);
    expect(eng.ctrlS).not.toHaveBeenCalled();
  });

  it('closes a popup menu with Escape before it presses Ctrl+S, and saves (a menu holds no edits)', async () => {
    const { eng, got, request } = await twoSheets();
    eng.ui.popup = true;   // a context menu or KiCad's clarify-selection menu
    eng.Module.kicadSheetsGetTree.mockClear();
    expect(await request('project.save', undefined, 150)).toEqual({ id: 2, ok: true, result: { path: 'sub/power.kicad_sch', saved: ['blink.kicad_sch', 'sub/power.kicad_sch'] } });
    expect(eng.ui.popup).toBe(false);
    expect(eng.Module.kicadSheetsGetTree).toHaveBeenCalledTimes(1);   // the shown sheet and the expected set come from one read
    expect(eng.popupEl.dispatchEvent).toHaveBeenCalledTimes(1);
    expect(eng.ctrlS).toHaveBeenCalledTimes(1);
    expect(eng.popupEl.dispatchEvent.mock.invocationCallOrder[0]).toBeLessThan(eng.ctrlS.mock.invocationCallOrder[0]);
    expect(got.map((m) => m.type ?? 'answer')).toEqual(['ev.saved', 'ev.saved', 'answer']);
    // Under a dialog as well as the popup, the dialog refuses first and NOTHING
    // is pressed: the popup stays as it is (the protocol's promise).
    eng.ui.popup = true;
    eng.dialogs.push({ typeName: 'wxDialog', visible: true });
    eng.ctrlS.mockClear();
    expect(await request('project.save')).toMatchObject({ ok: false, error: { code: 'busy', message: 'project.save' } });
    expect(eng.ctrlS).not.toHaveBeenCalled();
    expect(eng.ui.popup).toBe(true);
  });

  it('a sheet tree that never answers ends as island_error, and the next request is answered', async () => {
    const eng = fakeEngine();
    const { request } = await twoSheets(eng);
    const applyMs = timing.applyMs;
    timing.applyMs = 40;
    try {
      eng.Module.kicadSheetsGetTree.mockImplementation(() => new Promise(() => undefined) as unknown as string);
      expect(await request('sheet.tree')).toMatchObject({ ok: false, error: { code: 'island_error' } });
      expect(await request('readonly', { on: false })).toMatchObject({ ok: true });
      // project.save falls back to the opened file and the quiet pause.
      expect(await request('project.save', undefined, 250)).toMatchObject({ ok: true, result: { path: 'blink.kicad_sch' } });
    } finally { timing.applyMs = applyMs; }
  });

  it('shutdown runs the teardown, answers ok as its last message and closes the port', async () => {
    resetUnloadQuietForTest();
    const { page, parent } = fakePage();
    const order: string[] = [];
    const onShutdown = vi.fn(async () => { order.push('teardown'); await settle(5); order.push('teardown done'); });
    const r = startResponder({ parentOrigin: PARENT, page, onShutdown });
    const { port, got } = connect(page, parent.postMessage.mock.calls[0][0].nonce);
    const eng = fakeEngine();
    r.engineReady(eng.win, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
    port.postMessage({ id: 1, op: 'project.open', args: { name: 'x', files: [{ path: 'blink.kicad_sch', bytes: b('(kicad_sch)') }] } });
    await settle(100);
    expect(typeof eng.win.kicadCollab?.onSave).toBe('function');
    got.length = 0;
    // Requests sent behind the shutdown are never answered.
    port.postMessage({ id: 2, op: 'shutdown' });
    port.postMessage({ id: 3, op: 'project.save' });
    port.postMessage({ id: 4, op: 'nope' });
    await settle(60);
    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['teardown', 'teardown done']);
    expect(got).toEqual([{ id: 2, ok: true, result: {} }]);
    expect(eng.Module.kicadSaveSchematic).not.toHaveBeenCalled();
    // The save hook is gone and the engine's leave prompt stays quiet.
    expect(eng.win.kicadCollab?.onSave).toBeUndefined();
    expect(isQuiet(Date.now() + 3_600_000)).toBe(true);
    // Nothing is emitted any more, and a second connect is never adopted.
    r.emit({ type: 'ev.closing' });
    r.emit({ type: 'ev.state', phase: 'fatal', detail: 'crash' });
    await settle();
    expect(got).toEqual([{ id: 2, ok: true, result: {} }]);
    const again = connect(page, parent.postMessage.mock.calls[0][0].nonce);
    again.port.postMessage({ id: 5, op: 'project.forget' });
    await settle();
    expect(again.got).toEqual([]);
  });

  it('shutdown answers ok without a teardown, and island_error (still closing) when the teardown fails', async () => {
    const plain = fakePage();
    startResponder({ parentOrigin: PARENT, page: plain.page });
    const a = connect(plain.page, plain.parent.postMessage.mock.calls[0][0].nonce);
    a.port.postMessage({ id: 1, op: 'shutdown', args: {} });
    a.port.postMessage({ id: 2, op: 'project.forget' });
    await settle();
    expect(a.got).toEqual([{ id: 1, ok: true, result: {} }]);

    const failing = fakePage();
    startResponder({ parentOrigin: PARENT, page: failing.page, onShutdown: async () => { throw new Error('boom'); } });
    const c = connect(failing.page, failing.parent.postMessage.mock.calls[0][0].nonce);
    c.port.postMessage({ id: 1, op: 'shutdown' });
    c.port.postMessage({ id: 2, op: 'project.forget' });
    await settle();
    expect(c.got).toEqual([{ id: 1, ok: false, error: { code: 'island_error', message: 'boom' } }]);
  });

  it('shutdown with args answers bad_args and keeps the bridge open', async () => {
    const { page, parent } = fakePage();
    const onShutdown = vi.fn(async () => undefined);
    startResponder({ parentOrigin: PARENT, page, onShutdown });
    const { port, got } = connect(page, parent.postMessage.mock.calls[0][0].nonce);
    port.postMessage({ id: 1, op: 'shutdown', args: { now: true } });
    port.postMessage({ id: 2, op: 'shutdown', extra: 1 });
    port.postMessage({ id: 3, op: 'project.forget' });
    await settle();
    expect(onShutdown).not.toHaveBeenCalled();
    expect(got).toEqual([
      { id: 1, ok: false, error: { code: 'bad_args', message: 'shutdown' } },
      { id: 2, ok: false, error: { code: 'bad_args', message: 'shutdown' } },
      { id: 3, ok: true, result: {} },
    ]);
  });

  it('close() (pagehide) drops queued events, answers nothing more and stops the save hook', async () => {
    const { page, parent } = fakePage();
    const r = startResponder({ parentOrigin: PARENT, page });
    r.emit({ type: 'ev.state', phase: 'booting' });
    r.close();
    r.close();
    const { port, got } = connect(page, parent.postMessage.mock.calls[0][0].nonce);
    port.postMessage({ id: 1, op: 'project.forget' });
    await settle();
    expect(got).toEqual([]);

    const live = fakePage();
    const r2 = startResponder({ parentOrigin: PARENT, page: live.page });
    const c = connect(live.page, live.parent.postMessage.mock.calls[0][0].nonce);
    const eng = fakeEngine();
    r2.engineReady(eng.win, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
    c.port.postMessage({ id: 1, op: 'project.open', args: { name: 'x', files: [{ path: 'blink.kicad_sch', bytes: b('(kicad_sch)') }] } });
    await settle(100);
    c.got.length = 0;
    r2.emit({ type: 'ev.closing' });
    r2.close();
    eng.win.kicadCollab?.onSave?.(`${ROOT}/blink.kicad_sch`);
    c.port.postMessage({ id: 2, op: 'project.forget' });
    await settle();
    expect(c.got).toEqual([{ type: 'ev.closing' }]);
    expect(eng.win.kicadCollab?.onSave).toBeUndefined();
  });
});

describe('key.press', () => {
  /** A responder whose port is connected; `ready` hands it a booted engine first. */
  function respond(ready: boolean) {
    const { page, parent } = fakePage();
    const r = startResponder({ parentOrigin: PARENT, page });
    const { port, got } = connect(page, parent.postMessage.mock.calls[0][0].nonce);
    const eng = fakeEngine();
    if (ready) r.engineReady(eng.win, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
    let id = 0;
    const request = async (op: string, args?: unknown) => {
      const n = ++id;
      port.postMessage(args === undefined ? { id: n, op } : { id: n, op, args });
      await settle();
      return got.find((m) => m.id === n);
    };
    return { eng, request };
  }

  it('dispatches keydown and keyup on the engine window and answers {}', async () => {
    const { eng, request } = respond(true);
    const seen: string[] = [];
    eng.win.dispatchEvent = vi.fn((e: Event) => { seen.push(`${e.type}:${(e as KeyboardEvent).key}:${(e as KeyboardEvent).code}`); return true; });
    expect(await request('key.press', { key: 'a', code: 'KeyA' })).toEqual({ id: 1, ok: true, result: {} });
    expect(seen).toEqual(['keydown:a:KeyA', 'keyup:a:KeyA']);
  });

  it('answers busy while a KiCad dialog is up, and bad_args outside the grammar', async () => {
    const { eng, request } = respond(true);
    eng.win.dispatchEvent = vi.fn(() => true);
    eng.dialogs.push({ typeName: 'wxDialog', visible: true });
    expect(await request('key.press', { key: 'a', code: 'KeyA' })).toMatchObject({ ok: false, error: { code: 'busy' } });
    eng.dialogs.length = 0;
    expect(await request('key.press', { key: 'a', code: 'Mouse' })).toMatchObject({ ok: false, error: { code: 'bad_args' } });
    expect(await request('key.press')).toMatchObject({ ok: false, error: { code: 'bad_args' } });
    expect(eng.win.dispatchEvent).not.toHaveBeenCalled();
  });

  it('answers busy while a popup menu or any dialog type is up, but not for a progress dialog alone', async () => {
    const { eng, request } = respond(true);
    eng.win.dispatchEvent = vi.fn(() => true);
    eng.ui.popup = true;   // a context menu or KiCad's clarify-selection menu
    expect(await request('key.press', { key: 'a', code: 'KeyA' })).toMatchObject({ ok: false, error: { code: 'busy' } });
    expect(await request('view.fit')).toMatchObject({ ok: false, error: { code: 'busy', message: 'view.fit' } });
    eng.ui.popup = false;
    for (const typeName of ['wxGenericMessageDialog', 'wxRichMessageDialog', 'wxFileDialog', 'wxTextEntryDialog']) {
      eng.dialogs.splice(0, eng.dialogs.length, { typeName, visible: true });
      expect(await request('key.press', { key: 'a', code: 'KeyA' })).toMatchObject({ ok: false, error: { code: 'busy' } });
    }
    expect(eng.win.dispatchEvent).not.toHaveBeenCalled();
    eng.dialogs.splice(0, eng.dialogs.length, { typeName: 'wxGenericProgressDialog', visible: true }, { typeName: 'wxDialog', visible: false });
    expect(await request('key.press', { key: 'a', code: 'KeyA' })).toMatchObject({ ok: true });
    expect(eng.win.dispatchEvent).toHaveBeenCalledTimes(2);
  });

  it('answers not_ready before the engine is up', async () => {
    const { request } = respond(false);
    expect(await request('key.press', { key: 'a', code: 'KeyA' })).toMatchObject({ ok: false, error: { code: 'not_ready' } });
  });
});

describe('the chrome across opens', () => {
  it('hides KiCad\'s chrome again after each open (loading a file shows the menu bar and an infobar), until chrome.show turns it on', async () => {
    const { page, parent } = fakePage();
    const r = startResponder({ parentOrigin: PARENT, page });
    const { port, got } = connect(page, parent.postMessage.mock.calls[0][0].nonce);
    const eng = fakeEngine();
    r.engineReady(eng.win, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
    const open = { name: 'x', files: [{ path: 'blink.kicad_sch', bytes: b('(kicad_sch)') }] };
    port.postMessage({ id: 1, op: 'project.open', args: open });
    await settle(100);
    expect(eng.Module.kicadSetChrome.mock.calls).toEqual([[false]]);
    expect(got.at(-1)).toMatchObject({ id: 1, ok: true });
    port.postMessage({ id: 2, op: 'chrome.show', args: { on: true } });
    port.postMessage({ id: 3, op: 'project.open', args: open });
    await settle(100);
    expect(eng.Module.kicadSetChrome.mock.calls).toEqual([[false], [true]]);
    port.postMessage({ id: 4, op: 'chrome.show', args: { on: false } });
    port.postMessage({ id: 5, op: 'project.open', args: open });
    await settle(100);
    expect(eng.Module.kicadSetChrome.mock.calls).toEqual([[false], [true], [false], [false]]);
    expect(got.filter((m) => m.id != null).map((m) => m.ok)).toEqual([true, true, true, true, true]);
    // With the chrome meant shown, the answer says it is.
    port.postMessage({ id: 6, op: 'chrome.show', args: { on: true } });
    port.postMessage({ id: 7, op: 'project.open', args: open });
    await settle(100);
    expect(got.at(-1)).toMatchObject({ id: 7, ok: true, result: { chrome: true } });
  });

  it('hides the menu bar again when KiCad shows it after the load settled, and answers chrome false', async () => {
    const { page, parent } = fakePage();
    const r = startResponder({ parentOrigin: PARENT, page });
    const { port, got } = connect(page, parent.postMessage.mock.calls[0][0].nonce);
    const eng = fakeEngine();
    // The load shows the menu bar 15 ms after it returned: after the first hide.
    eng.Module.kicadOpenFile.mockImplementation((p: string) => { eng.opened.push(p); setTimeout(() => eng.chrome.push({ typeName: 'wxMenuBar', visible: true }), 15); });
    r.engineReady(eng.win, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
    port.postMessage({ id: 1, op: 'project.open', args: { name: 'x', files: [{ path: 'blink.kicad_sch', bytes: b('(kicad_sch)') }] } });
    await settle(150);
    expect(got.at(-1)).toEqual({ id: 1, ok: true, result: { opened: 'blink.kicad_sch', dropped: [], chrome: false } });
    expect(eng.Module.kicadSetChrome.mock.calls).toEqual([[false], [false]]);
    expect(eng.chrome).toEqual([]);
  });

  it('answers chrome true when the engine will not hide it, so the host sends chrome.show again', async () => {
    const { page, parent } = fakePage();
    const r = startResponder({ parentOrigin: PARENT, page });
    const { port, got } = connect(page, parent.postMessage.mock.calls[0][0].nonce);
    const eng = fakeEngine();
    eng.Module.kicadOpenFile.mockImplementation((p: string) => { eng.opened.push(p); eng.chrome.push({ typeName: 'wxMenuBar', visible: true }); });
    eng.Module.kicadSetChrome.mockImplementation(() => false);
    r.engineReady(eng.win, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
    port.postMessage({ id: 1, op: 'project.open', args: { name: 'x', files: [{ path: 'blink.kicad_sch', bytes: b('(kicad_sch)') }] } });
    await settle(150);
    expect(got.at(-1)).toEqual({ id: 1, ok: true, result: { opened: 'blink.kicad_sch', dropped: [], chrome: true } });
    // The watch kept trying while the bar stayed up.
    expect(eng.Module.kicadSetChrome.mock.calls.length).toBeGreaterThan(2);
  });

  it('hides the chrome on open_failed too', async () => {
    const { page, parent } = fakePage();
    const r = startResponder({ parentOrigin: PARENT, page });
    const { port, got } = connect(page, parent.postMessage.mock.calls[0][0].nonce);
    const eng = fakeEngine();
    r.engineReady(eng.win, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
    eng.chrome.push({ typeName: 'wxMenuBar', visible: true });
    port.postMessage({ id: 1, op: 'project.open', args: { name: 'x', files: [{ path: 'blink.kicad_sch', bytes: b('(kicad_sch)') }], open: 'missing.kicad_sch' } });
    await settle(150);
    expect(got.at(-1)).toMatchObject({ id: 1, ok: false, error: { code: 'open_failed' } });
    expect(eng.Module.kicadSetChrome).toHaveBeenCalledWith(false);
    expect(eng.chrome).toEqual([]);
  });
});

describe('ev.menu', () => {
  it('reports a popup menu or a dialog opening and the last one closing, and nothing after shutdown', async () => {
    const { page, parent } = fakePage();
    const r = startResponder({ parentOrigin: PARENT, page });
    const { port, got } = connect(page, parent.postMessage.mock.calls[0][0].nonce);
    const eng = fakeEngine();
    r.engineReady(eng.win, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
    const menus = () => got.filter((m) => m.type === 'ev.menu');
    await settle(150);
    expect(menus()).toEqual([]);   // nothing is up: nothing is reported
    eng.ui.popup = true;
    await settle(150);
    expect(menus()).toEqual([{ type: 'ev.menu', open: true }]);
    // A dialog over the menu changes nothing; the menu closing with the dialog still up neither.
    eng.dialogs.push({ typeName: 'wxDialog', visible: true });
    (eng.win.wxElementRegistry as unknown as { version: number }).version = 2;
    eng.ui.popup = false;
    await settle(150);
    expect(menus()).toHaveLength(1);
    eng.dialogs.length = 0;
    (eng.win.wxElementRegistry as unknown as { version: number }).version = 3;
    await settle(150);
    expect(menus()).toEqual([{ type: 'ev.menu', open: true }, { type: 'ev.menu', open: false }]);
    // A progress dialog is drawn over the canvas too.
    eng.dialogs.push({ typeName: 'wxGenericProgressDialog', visible: true });
    (eng.win.wxElementRegistry as unknown as { version: number }).version = 4;
    await settle(150);
    expect(menus().at(-1)).toEqual({ type: 'ev.menu', open: true });
    expect(Object.keys(menus()[0]).sort()).toEqual(['open', 'type']);
    port.postMessage({ id: 1, op: 'shutdown' });
    await settle(30);
    const before = got.length;
    eng.dialogs.length = 0;
    (eng.win.wxElementRegistry as unknown as { version: number }).version = 5;
    await settle(150);
    expect(got.length).toBe(before);
  });
});

describe('sheets, layers and fit', () => {
  /** A connected responder over a booted engine; `request` answers as { ok, result } or { ok: false, code, message }. */
  function booted(eng: ReturnType<typeof fakeEngine>) {
    const { page, parent } = fakePage();
    const r = startResponder({ parentOrigin: PARENT, page });
    const { port, got } = connect(page, parent.postMessage.mock.calls[0][0].nonce);
    r.engineReady(eng.win, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
    let id = 0;
    return {
      async request(op: string, args?: unknown) {
        const n = ++id;
        port.postMessage(args === undefined ? { id: n, op } : { id: n, op, args });
        await settle();
        const m = got.find((x) => x.id === n) as { ok: boolean; result?: unknown; error?: { code: string; message: string } } | undefined;
        if (m == null) return undefined;
        return m.ok ? { ok: true, result: m.result } : { ok: false, code: m.error?.code, message: m.error?.message };
      },
    };
  }

  it('sheet.tree drops the absolute file path for its base name and keeps the rest', async () => {
    const r = booted(fakeEngine());
    expect(await r.request('sheet.tree')).toEqual({ ok: true, result: { current: '/', sheets: [{ path: '/', name: 'blink', page: '1', depth: 0, parent: '', file: 'blink.kicad_sch' }] } });
  });
  it('sheet.enter validates the path and relays the engine\'s answer', async () => {
    const eng = fakeEngine();
    const r = booted(eng);
    expect(await r.request('sheet.enter', { path: '/00000000-0000-0000-0000-00005c7b59b0/' })).toEqual({ ok: true, result: {} });
    expect(await r.request('sheet.enter', { path: '/not-a-uuid/' })).toMatchObject({ ok: false, code: 'bad_args' });
    expect(await r.request('sheet.enter', { path: '/11111111-1111-1111-1111-111111111111/' })).toMatchObject({ ok: false, code: 'not_applied' });
    expect(await r.request('sheet.enter', {})).toMatchObject({ ok: false, code: 'bad_args' });
  });
  it('layers.get relays the state; the setters validate the id and relay the answer', async () => {
    const eng = fakeEngine();
    const r = booted(eng);
    const got = await r.request('layers.get');
    expect(got).toMatchObject({ ok: true });
    expect((got as { result: { active: number; layers: unknown[] } }).result.layers).toHaveLength(2);
    expect(await r.request('layers.visible', { id: 2, visible: false })).toEqual({ ok: true, result: {} });
    expect(eng.Module.kicadLayersSetVisible).toHaveBeenCalledWith(2, false);
    expect(await r.request('layers.visible', { id: 99, visible: true })).toMatchObject({ ok: false, code: 'not_applied' });
    expect(await r.request('layers.visible', { id: '2', visible: true })).toMatchObject({ ok: false, code: 'bad_args' });
    expect(await r.request('layers.active', { id: 2 })).toEqual({ ok: true, result: {} });
    expect(await r.request('layers.active', { id: -1 })).toMatchObject({ ok: false, code: 'bad_args' });
  });
  it('an empty answer from the engine (the other frame) is unsupported', async () => {
    const eng = fakeEngine();
    eng.Module.kicadLayersGetState.mockReturnValue('');
    eng.Module.kicadSheetsGetTree.mockReturnValue('');
    const r = booted(eng);
    expect(await r.request('layers.get')).toMatchObject({ ok: false, code: 'unsupported' });
    expect(await r.request('sheet.tree')).toMatchObject({ ok: false, code: 'unsupported' });
  });
  it('view.fit presses Home', async () => {
    const eng = fakeEngine();
    const seen: string[] = [];
    (eng.win as unknown as Window).dispatchEvent = vi.fn((e: Event) => { seen.push(`${e.type}:${(e as KeyboardEvent).code}`); return true; }) as never;
    const r = booted(eng);
    expect(await r.request('view.fit')).toEqual({ ok: true, result: {} });
    expect(seen).toEqual(['keydown:Home', 'keyup:Home']);
  });
});

describe('project.import', () => {
  /** A connected responder over a booted engine; `send` answers the request's own reply, `got` holds everything. */
  function importer(search = '?frame=pcb&theme=day', eng = fakeEngine()) {
    const { page, parent } = fakePage(search);
    const r = startResponder({ parentOrigin: PARENT, page });
    const { port, got } = connect(page, parent.postMessage.mock.calls[0][0].nonce);
    r.engineReady(eng.win, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
    let id = 0;
    const post = (op: string, args?: unknown): number => { const n = ++id; port.postMessage(args === undefined ? { id: n, op } : { id: n, op, args }); return n; };
    const answer = async (n: number, ms = 3_000): Promise<Record<string, unknown> | undefined> => {
      const end = Date.now() + ms;
      while (Date.now() < end) { const m = got.find((x) => x.id === n); if (m != null) return m; await settle(5); }
      return undefined;
    };
    const send = async (op: string, args?: unknown, ms?: number) => answer(post(op, args), ms);
    return { r, eng, port, got, post, answer, send };
  }

  /**
   * KiCad's import as the spike measured it: kicadOpenFile shows the "Load PCB"
   * progress reporter, then (for Eagle, CADSTAR, PADS) the layer mapping, whose
   * OK is refused until Auto-Match Layers ran; the open resolves true, and the
   * log report follows a little later (12 ms here, about 10 ms in the engine),
   * its lines written to the console first.
   */
  function kicadImport(eng: ReturnType<typeof fakeEngine>, o: { mapping?: boolean; report?: string[]; result?: boolean } = {}) {
    let busy = false;
    (eng.Module as { kicadOpenFileBusy: () => boolean }).kicadOpenFileBusy = () => busy;
    eng.Module.kicadOpenFile.mockImplementation((p: string) => {
      eng.opened.push(p);
      busy = true;
      return new Promise<boolean>((resolve) => {
        const finish = (v: boolean): void => {
          eng.hideModal(progress);
          busy = false;
          resolve(v);
          if (v && o.report != null) {
            for (const line of o.report) eng.win.console.info(`[wxLog][INFO] ${line}`);
            eng.win.console.debug('[wxLog][DEBUG] EndModal: 5100');
            setTimeout(() => {
              const rep: FakeModal = eng.showModal({ id: 'rep', title: 'KiCad PCB Editor Warning', x: 396, y: 353, w: 488, h: 94, texts: o.report!.slice(-1), pane: o.report!.length > 1, buttons: [{ label: '&OK', on: () => eng.hideModal(rep) }] });
            }, 12);   // later than one poll (5 ms), within the quiet wait (20 ms)
          }
        };
        const progress: FakeModal = eng.showModal({ id: 'load', title: 'Load PCB', x: 474, y: 334, w: 332, h: 131, gauge: true, texts: ['Elapsed time:'], buttons: [{ label: '&Cancel', on: () => finish(false) }] });
        if (!o.mapping) { setTimeout(() => finish(o.result ?? true), 10); return; }
        let matched = false;
        const map: FakeModal = eng.showModal({ id: 'map', title: 'Edit Mapping of Imported Layers', x: 332, y: 222, w: 616, h: 356, texts: ['Imported Layers', 'KiCad Layers'], buttons: [
          { label: '>' }, { label: '<' }, { label: '<<' },
          { label: 'Auto-Match Layers', on: () => { matched = true; } },
          { label: '&OK', on: () => { if (matched) { eng.hideModal(map); finish(o.result ?? true); } } },
        ] });
      });
    });
  }

  const brd = { path: 'boards/aht20.brd', bytes: b('<?xml version="1.0"?><eagle/>') };

  it('a sch frame answers unsupported; bad args and a foreign open answer bad_args; nothing is staged', async () => {
    const sch = importer('?frame=sch');
    expect(await sch.send('project.import', { name: 'x', files: [brd], open: brd.path })).toMatchObject({ ok: false, error: { code: 'unsupported' } });
    expect(sch.eng.opened).toEqual([]);
    expect([...sch.eng.files.keys()]).toEqual([]);
    const { send, eng } = importer();
    const bad = [
      { name: 'x', files: [brd] },                                     // no open
      { name: 'x', files: [brd], open: 'boards/aht20.kicad_pcb' },     // the frame's own kind is project.open's
      { name: 'x', files: [brd], open: 'boards/aht20.sch' },           // a schematic
      { name: 'x', files: [brd], open: 'copper.gbr' },                 // no importer reads Gerber
      { name: 'x', files: [brd], open: 'boards/.brd' },                // no stem
      { name: 'x', files: [brd], open: brd.path, format: 5 },
      { name: 'x', files: [brd], open: brd.path, format: 'e'.repeat(65) },
      { name: 'x', files: [brd], open: brd.path, extra: true },
      { name: 'x', files: [{ path: brd.path, bytes: brd.bytes.buffer }], open: brd.path },
      { name: 7, files: [brd], open: brd.path },
    ];
    for (const args of bad) expect(await send('project.import', args)).toMatchObject({ ok: false, error: { code: 'bad_args', message: 'project.import' } });
    expect(await send('project.import')).toMatchObject({ ok: false, error: { code: 'bad_args' } });
    expect(eng.opened).toEqual([]);
    expect([...eng.files.keys()]).toEqual([]);
    // An open that names no staged file is open_failed, as for project.open.
    expect(await send('project.import', { name: 'x', files: [brd], open: 'boards/other.brd' })).toMatchObject({ ok: false, error: { code: 'open_failed' } });
    expect(eng.opened).toEqual([]);
  });

  it('drives the layer mapping and the log report, saves <stem>.kicad_pcb beside the source and answers its warnings', async () => {
    const eng = fakeEngine();
    kicadImport(eng, { mapping: true, report: ["Ignoring a wire since Eagle layer 'tRestrict' (41) was not mapped", "Ignoring a wire since Eagle layer 'tRestrict' (41) was not mapped", 'The design has been imported.\nPlease review the import errors.'] });
    const consoleBefore = { ...eng.engineConsole };
    const { send, got } = importer(undefined, eng);
    const answer = await send('project.import', { name: 'AHT20', files: [brd, { path: '../evil.txt', bytes: b('x') }], open: brd.path, format: 'eagle' });
    expect(answer).toEqual({ id: 1, ok: true, result: {
      opened: 'boards/aht20.kicad_pcb',
      dropped: ['../evil.txt'],
      warnings: ["Ignoring a wire since Eagle layer 'tRestrict' (41) was not mapped", 'The design has been imported. Please review the import errors.'],
      chrome: false,
    } });
    // KiCad's own open on the staged source; Auto-Match, then OK, then the report's OK; the progress reporter untouched.
    expect(eng.opened).toEqual([`${ROOT}/boards/aht20.brd`]);
    expect(eng.clicks).toEqual(['Edit Mapping of Imported Layers:Auto-Match Layers', 'Edit Mapping of Imported Layers:OK', 'KiCad PCB Editor Warning:OK']);
    expect(eng.modals).toEqual([]);
    // The converted board was saved through the engine and reached the host before the answer.
    expect(eng.Module.kicadSaveBoard).toHaveBeenCalledWith(`${ROOT}/boards/aht20.kicad_pcb`);
    const events = got.filter((m) => m.type != null && m.type !== 'ev.ready' && m.type !== 'ev.menu');
    expect(events).toEqual([
      { type: 'ev.state', phase: 'staging' },
      { type: 'ev.state', phase: 'opening' },
      { type: 'ev.saved', path: 'boards/aht20.kicad_pcb', bytes: b('(kicad_pcb saved)') },
    ]);
    expect(got.indexOf(events[2])).toBeLessThan(got.indexOf(answer!));
    // The console tap is gone: every method is the engine's own again.
    expect({ ...eng.engineConsole }).toEqual(consoleBefore);

    // The converted board is the frame's document, as after project.open.
    eng.Module.kicadSaveBoard.mockClear();
    expect(await send('project.save')).toEqual({ id: 2, ok: true, result: { path: 'boards/aht20.kicad_pcb', saved: ['boards/aht20.kicad_pcb'] } });
    expect(eng.Module.kicadSaveBoard).toHaveBeenCalledWith(`${ROOT}/boards/aht20.kicad_pcb`);
    expect(await send('layers.get')).toMatchObject({ ok: true });
    expect(await send('layers.visible', { id: 2, visible: false })).toEqual({ id: 4, ok: true, result: {} });
    expect(await send('view.fit')).toEqual({ id: 5, ok: true, result: {} });
    expect(await send('key.press', { key: 'a', code: 'KeyA' })).toEqual({ id: 6, ok: true, result: {} });
    // Ctrl+S in the editor reaches the host too.
    got.length = 0;
    eng.files.set(`${ROOT}/boards/aht20.kicad_pcb`, b('(kicad_pcb edited)'));
    eng.win.kicadCollab?.onSave?.(`${ROOT}/boards/aht20.kicad_pcb`);
    await settle();
    expect(got).toEqual([{ type: 'ev.saved', path: 'boards/aht20.kicad_pcb', bytes: b('(kicad_pcb edited)') }]);
  });

  it('a board with no dialog imports straight through, an upper case extension included', async () => {
    const eng = fakeEngine();
    kicadImport(eng);
    const { send } = importer(undefined, eng);
    expect(await send('project.import', { name: 'p', files: [{ path: 'Glyphs.PCB', bytes: b('ACCEL_ASCII') }], open: 'Glyphs.PCB' })).toEqual({ id: 1, ok: true, result: { opened: 'Glyphs.kicad_pcb', dropped: [], warnings: [], chrome: false } });
    expect(eng.clicks).toEqual([]);
  });

  it('the engine\'s refusal is import_failed: its message box is closed, nothing is saved and there is no document', async () => {
    const eng = fakeEngine();
    let busy = false;
    (eng.Module as { kicadOpenFileBusy: () => boolean }).kicadOpenFileBusy = () => busy;
    eng.Module.kicadOpenFile.mockImplementation((p: string) => {
      eng.opened.push(p);
      busy = true;
      return new Promise<boolean>((resolve) => {
        const box: FakeModal = eng.showModal({ id: 'err', title: 'Error', x: 406, y: 334, w: 468, h: 132, texts: ['File format is not supported'], buttons: [{ label: '&OK', on: () => { eng.hideModal(box); busy = false; resolve(false); } }] });
      });
    });
    const { send, got } = importer(undefined, eng);
    const answer = await send('project.import', { name: 'a', files: [{ path: 'trs80.brd', bytes: b('allegro') }], open: 'trs80.brd' });
    expect(answer).toMatchObject({ ok: false, error: { code: 'import_failed' } });
    expect((answer as { error: { message: string } }).error.message).toContain('File format is not supported');
    expect(eng.clicks).toEqual(['Error:OK']);
    expect(eng.modals).toEqual([]);
    expect(eng.Module.kicadSaveBoard).not.toHaveBeenCalled();
    expect(got.filter((m) => m.type === 'ev.saved')).toEqual([]);
    expect(await send('project.save')).toMatchObject({ ok: false, error: { code: 'not_ready' } });
    // A refusal with no dialog at all answers a plain detail.
    eng.Module.kicadOpenFile.mockImplementation(() => Promise.resolve(false));
    expect(await send('project.import', { name: 'a', files: [{ path: 'trs80.brd', bytes: b('allegro') }], open: 'trs80.brd' })).toEqual({ id: 3, ok: false, error: { code: 'import_failed', message: 'the engine could not import the file' } });
    // When the engine logged why, its first line follows.
    eng.Module.kicadOpenFile.mockImplementation(() => { eng.win.console.error('[wxLog][ERROR] Unable to read the board.'); return Promise.resolve(false); });
    expect(await send('project.import', { name: 'a', files: [{ path: 'trs80.brd', bytes: b('allegro') }], open: 'trs80.brd' })).toEqual({ id: 4, ok: false, error: { code: 'import_failed', message: 'the engine could not import the file: Unable to read the board.' } });
  });

  it('any other dialog fails the import, named, and is closed without accepting it: Save Changes? gets Cancel, never Save or Discard', async () => {
    const eng = fakeEngine();
    let busy = false;
    (eng.Module as { kicadOpenFileBusy: () => boolean }).kicadOpenFileBusy = () => busy;
    eng.Module.kicadOpenFile.mockImplementation(() => {
      busy = true;
      return new Promise<boolean>((resolve) => {
        const done = (): void => { eng.hideModal(ask); busy = false; resolve(false); };
        const ask: FakeModal = eng.showModal({ id: 'ask', title: 'Save Changes?', x: 406, y: 334, w: 468, h: 132, texts: ['The current PCB has been modified.  Save changes?'], buttons: [
          { label: '&Save', on: () => { throw new Error('saved') } }, { label: 'Discard Changes', on: () => { throw new Error('discarded') } }, { label: '&Cancel', on: done },
        ] });
      });
    });
    const { send } = importer(undefined, eng);
    const answer = await send('project.import', { name: 'a', files: [brd], open: brd.path });
    expect(answer).toEqual({ id: 1, ok: false, error: { code: 'import_failed', message: 'dialog "Save Changes?": The current PCB has been modified. Save changes?' } });
    expect(eng.clicks).toEqual(['Save Changes?:Cancel']);
    expect(eng.modals).toEqual([]);
  });

  it('a layer mapping whose OK stays refused fails the import and is closed by its close box', async () => {
    const eng = fakeEngine();
    let busy = false;
    (eng.Module as { kicadOpenFileBusy: () => boolean }).kicadOpenFileBusy = () => busy;
    eng.Module.kicadOpenFile.mockImplementation(() => {
      busy = true;
      return new Promise<boolean>((resolve) => {
        const map: FakeModal = eng.showModal({ id: 'map', title: 'Edit Mapping of Imported Layers', x: 332, y: 222, w: 616, h: 356, buttons: [{ label: 'Auto-Match Layers' }, { label: '&OK' }],
          onClose: () => { eng.hideModal(map); busy = false; resolve(false); } });
      });
    });
    const { send } = importer(undefined, eng);
    expect(await send('project.import', { name: 'a', files: [brd], open: brd.path })).toMatchObject({ ok: false, error: { code: 'import_failed', message: 'the layer mapping was refused (Edit Mapping of Imported Layers)' } });
    expect(eng.clicks).toEqual(['Edit Mapping of Imported Layers:Auto-Match Layers', 'Edit Mapping of Imported Layers:OK', 'Edit Mapping of Imported Layers:×']);
    expect(eng.modals).toEqual([]);
  });

  it('an import past timing.importMs is import_failed, with the progress reporter cancelled and every dialog closed first', async () => {
    const eng = fakeEngine();
    let busy = false;
    (eng.Module as { kicadOpenFileBusy: () => boolean }).kicadOpenFileBusy = () => busy;
    eng.Module.kicadOpenFile.mockImplementation(() => {
      busy = true;
      return new Promise<boolean>((resolve) => {
        // The load never ends by itself; its Cancel raises KiCad's "canceled" message box.
        const progress: FakeModal = eng.showModal({ id: 'load', title: 'Load PCB', x: 474, y: 334, w: 332, h: 131, gauge: true, buttons: [{ label: '&Cancel', on: () => {
          eng.hideModal(progress);
          const box: FakeModal = eng.showModal({ id: 'err', title: 'Error', x: 406, y: 334, w: 468, h: 132, texts: ['File import canceled by user.'], buttons: [{ label: '&OK', on: () => { eng.hideModal(box); busy = false; resolve(false); } }] });
        } }] });
      });
    });
    const saved = timing.importMs;
    timing.importMs = 150;
    try {
      const { send } = importer(undefined, eng);
      const t0 = Date.now();
      const answer = await send('project.import', { name: 'a', files: [brd], open: brd.path });
      expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
      expect(answer).toEqual({ id: 1, ok: false, error: { code: 'import_failed', message: 'the import took longer than 0.15 s' } });
      expect(eng.clicks).toEqual(['Load PCB:Cancel', 'Error:OK']);
      expect(eng.modals).toEqual([]);
      expect(eng.Module.kicadSaveBoard).not.toHaveBeenCalled();
    } finally {
      timing.importMs = saved;
    }
  });

  it('while an import runs every request but shutdown answers busy at once; the import still answers after', async () => {
    const eng = fakeEngine();
    let finish: (v: boolean) => void = () => undefined;
    let busy = false;
    (eng.Module as { kicadOpenFileBusy: () => boolean }).kicadOpenFileBusy = () => busy;
    eng.Module.kicadOpenFile.mockImplementation(() => {
      busy = true;
      const progress = eng.showModal({ id: 'load', title: 'Load PCB', x: 474, y: 334, w: 332, h: 131, gauge: true, buttons: [{ label: '&Cancel' }] });
      return new Promise<boolean>((resolve) => { finish = (v) => { eng.hideModal(progress); busy = false; resolve(v); }; });
    });
    const { post, answer, got, eng: e } = importer(undefined, eng);
    const imp = post('project.import', { name: 'a', files: [brd], open: brd.path });
    await settle(30);
    const during = [
      post('key.press', { key: 'a', code: 'KeyA' }), post('view.fit'), post('project.save'), post('layers.get'),
      post('layers.visible', { id: 0, visible: false }), post('chrome.show', { on: true }), post('readonly', { on: true }),
      post('project.open', { name: 'b', files: [{ path: 'b.kicad_pcb', bytes: b('(kicad_pcb)') }] }),
      post('project.import', { name: 'c', files: [brd], open: brd.path }), post('project.forget'),
    ];
    await settle(30);
    for (const n of during) expect(got.find((m) => m.id === n)).toMatchObject({ ok: false, error: { code: 'busy' } });
    expect(got.find((m) => m.id === imp)).toBeUndefined();
    expect(e.win.dispatchEvent).toBeDefined();
    expect(e.Module.kicadSetChrome).not.toHaveBeenCalledWith(true);
    expect(e.Module.kicadLayersGetState).not.toHaveBeenCalled();
    finish(true);
    expect(await answer(imp)).toMatchObject({ ok: true, result: { opened: 'boards/aht20.kicad_pcb' } });
    // And requests are served again.
    expect(await answer(post('view.fit'))).toMatchObject({ ok: true });
  });

  it('a shutdown during an import ends it: the shutdown answers, the import never does, and the console is the engine\'s again', async () => {
    const eng = fakeEngine();
    const before = { ...eng.engineConsole };
    eng.Module.kicadOpenFile.mockImplementation(() => new Promise<boolean>(() => undefined));
    const { post, answer, got } = importer(undefined, eng);
    const imp = post('project.import', { name: 'a', files: [brd], open: brd.path });
    await settle(30);
    expect(await answer(post('shutdown'))).toEqual({ id: 2, ok: true, result: {} });
    await settle(60);
    expect(got.find((m) => m.id === imp)).toBeUndefined();
    expect({ ...eng.engineConsole }).toEqual(before);
  });

  it('answers busy, changing nothing, while a load is parked or a dialog or a popup menu is up', async () => {
    const eng = fakeEngine();
    const { send } = importer(undefined, eng);
    eng.dialogs.push({ typeName: 'wxDialog', visible: true });
    expect(await send('project.import', { name: 'a', files: [brd], open: brd.path })).toMatchObject({ ok: false, error: { code: 'busy' } });
    eng.dialogs.length = 0;
    eng.ui.popup = true;
    expect(await send('project.import', { name: 'a', files: [brd], open: brd.path })).toMatchObject({ ok: false, error: { code: 'busy' } });
    eng.ui.popup = false;
    (eng.Module as { kicadOpenFileBusy: () => boolean }).kicadOpenFileBusy = () => true;
    expect(await send('project.import', { name: 'a', files: [brd], open: brd.path })).toMatchObject({ ok: false, error: { code: 'busy' } });
    expect(eng.opened).toEqual([]);
    expect([...eng.files.keys()]).toEqual([]);
  });
});

describe('the import\'s report lines', () => {
  it('keeps each line once, folds its whitespace, cuts it at 200 characters and keeps at most 40', () => {
    const long = 'x'.repeat(300);
    expect(reportLines(['a  b\nc', 'a b c', '', '   ', long])).toEqual(['a b c', 'x'.repeat(200)]);
    expect(reportLines(Array.from({ length: 45 }, (_, i) => `line ${i}`))).toHaveLength(40);
  });

  it('the console tap keeps what a report lists, never the engine\'s DEBUG chatter, and passes every call on', () => {
    const seen: string[] = [];
    const c = { log: (...a: unknown[]) => seen.push(`log ${a.join(' ')}`), info: (...a: unknown[]) => seen.push(`info ${a.join(' ')}`), warn: (...a: unknown[]) => seen.push(`warn ${a.join(' ')}`), error: (...a: unknown[]) => seen.push(`error ${a.join(' ')}`), debug: (...a: unknown[]) => seen.push(`debug ${a.join(' ')}`) };
    const own = { ...c };
    const tap = tapEngineLog({ console: c as unknown as Console });
    c.warn('[wxLog][WARNING] fonts differ');
    c.debug('[wxLog][DEBUG] EndModal: 5100');
    c.info('[wxLog][INFO] imported.\nreview it');
    c.error('[wxLog][ERROR] a pad was dropped');
    c.log('[editor]', '[wxLog][WARNING] not first');
    c.log('plain');
    expect(tap.lines()).toEqual(['fonts differ', 'imported.\nreview it', 'a pad was dropped']);
    expect(seen).toHaveLength(6);
    tap.stop();
    expect({ ...c }).toEqual(own);
  });
});
