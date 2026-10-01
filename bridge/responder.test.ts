// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { describe, expect, it, vi } from 'vitest';
import { memfsProjectDir } from '../loader/src/wasm/constants';
import { describeError, startResponder } from './responder';
import { isQuiet, resetUnloadQuietForTest } from '../src/unload-quiet';

const PARENT = 'http://circuitcenter.localhost';
const ROOT = memfsProjectDir('cc');
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

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

/** A booted engine: a visible frame, the programmatic open and the save exports. */
function fakeEngine() {
  const { FS, files, dirs, busy, broken, pinned } = fakeFs();
  const opened: string[] = [];
  const Module = {
    kicadOpenFile: vi.fn((p: string) => { opened.push(p); }),
    kicadOpenFileBusy: () => false,
    kicadSaveSchematic: vi.fn((p: string) => { FS.writeFile(p, '(kicad_sch saved)'); }),
    kicadSheetsGetTree: vi.fn(() => JSON.stringify({ current: '/', sheets: [{ path: '/', file: `${ROOT}/blink.kicad_sch` }] })),
    kicadSetChrome: vi.fn(() => true),
    kicadSetReadOnly: vi.fn(async () => true),
    notAnExport: 1,
  };
  const win = {
    FS,
    Module,
    wxElementRegistry: { findAll: () => [{ typeName: 'SCH_EDIT_FRAME', name: 'SchematicFrame', visible: true }], findByLabel: () => [] },
  } as unknown as ToolWindow & { kicadCollab?: { onSave?: (p: string) => void } };
  return { win, files, dirs, busy, broken, pinned, opened, Module };
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
      { type: 'ev.ready', caps: ['kicadOpenFile', 'kicadOpenFileBusy', 'kicadSaveSchematic', 'kicadSetChrome', 'kicadSetReadOnly', 'kicadSheetsGetTree'], engine: { tag: 'v0.2.3-cc1', kicad: '10.0' } },
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
      { id: 1, ok: true, result: { opened: 'blink.kicad_sch', dropped: ['../../../../.config/kicad/kicad/10.0/kicad_common.json'] } },
    ]);
    expect(eng.opened).toEqual([`${ROOT}/blink.kicad_sch`]);
    expect([...eng.files.keys()].every((k) => k.startsWith(`${ROOT}/`))).toBe(true);
    got.length = 0;

    port.postMessage({ id: 2, op: 'project.save' });
    await settle();
    expect(eng.Module.kicadSaveSchematic).toHaveBeenCalledWith(`${ROOT}/blink.kicad_sch`);
    expect(got).toHaveLength(2);
    expect(got[0]).toEqual({ type: 'ev.saved', path: 'blink.kicad_sch', bytes: b('(kicad_sch saved)') });
    expect(got[0].bytes).toBeInstanceOf(Uint8Array);
    expect(got[1]).toEqual({ id: 2, ok: true, result: { path: 'blink.kicad_sch' } });
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
    expect(got.at(-1)).toEqual({ id: 2, ok: true, result: { opened: 'b.kicad_sch', dropped: [] } });
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
    expect(got.at(-1)).toEqual({ id: 5, ok: true, result: { opened: 'other.kicad_sch', dropped: [] } });
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
    eng.Module.kicadSaveSchematic.mockImplementationOnce(() => undefined);
    port.postMessage({ id: 2, op: 'project.save' });
    await settle();
    expect(got.at(-1)).toMatchObject({ id: 2, ok: false });
    expect(isQuiet()).toBe(false);
    // Ctrl+S inside the editor is the user's save, not the host's: no quiet either.
    eng.win.kicadCollab?.onSave?.(`${ROOT}/blink.kicad_sch`);
    await settle();
    expect(isQuiet()).toBe(false);
    port.postMessage({ id: 3, op: 'project.save' });
    await settle();
    expect(got.at(-1)).toEqual({ id: 3, ok: true, result: { path: 'blink.kicad_sch' } });
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
    expect(got.at(-1)).toEqual({ id: 6, ok: true, result: { opened: 'blink.kicad_sch', dropped: [] } });
    expect(isQuiet()).toBe(false);
    resetUnloadQuietForTest();
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
    expect(got.at(-1)).toEqual({ id: 1, ok: true, result: { opened: 'proj/a.kicad_sch', dropped: [] } });
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
    expect(got.at(-1)).toEqual({ id: 3, ok: true, result: { opened: 'b.kicad_sch', dropped: [] } });
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

  it('answers save_failed and emits nothing when the engine save writes nothing', async () => {
    const { page, parent } = fakePage();
    const r = startResponder({ parentOrigin: PARENT, page });
    const { port, got } = connect(page, parent.postMessage.mock.calls[0][0].nonce);
    const eng = fakeEngine();
    eng.Module.kicadSaveSchematic.mockImplementation(() => undefined);   // the binding swallowed a failure
    r.engineReady(eng.win, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
    port.postMessage({ id: 1, op: 'project.open', args: { name: 'x', files: [{ path: 'blink.kicad_sch', bytes: b('(kicad_sch staged)') }] } });
    await settle(100);
    got.length = 0;
    port.postMessage({ id: 2, op: 'project.save' });
    await settle();
    expect(eng.Module.kicadSaveSchematic).toHaveBeenCalledWith(`${ROOT}/blink.kicad_sch`);
    expect(got).toEqual([{ id: 2, ok: false, error: { code: 'save_failed', message: 'blink.kicad_sch' } }]);
    // The staged bytes are back where the engine expects its document.
    expect(eng.files.get(`${ROOT}/blink.kicad_sch`)).toEqual(b('(kicad_sch staged)'));
    // A save that throws after writing nothing fails the same way.
    eng.Module.kicadSaveSchematic.mockImplementation(() => { throw new Error('boom'); });
    got.length = 0;
    port.postMessage({ id: 3, op: 'project.save' });
    await settle();
    expect(got).toEqual([{ id: 3, ok: false, error: { code: 'save_failed', message: 'blink.kicad_sch' } }]);
    // A save that writes an empty file is a failure too.
    eng.Module.kicadSaveSchematic.mockImplementation((p: string) => { eng.win.FS!.writeFile(p, new Uint8Array(0)); });
    got.length = 0;
    port.postMessage({ id: 4, op: 'project.save' });
    await settle();
    expect(got).toEqual([{ id: 4, ok: false, error: { code: 'save_failed', message: 'blink.kicad_sch' } }]);
    expect(eng.files.get(`${ROOT}/blink.kicad_sch`)).toEqual(b('(kicad_sch staged)'));
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

  it('saves the sheet the schematic editor is showing to that sheet file', async () => {
    const { page, parent } = fakePage();
    const r = startResponder({ parentOrigin: PARENT, page });
    const { port, got } = connect(page, parent.postMessage.mock.calls[0][0].nonce);
    const eng = fakeEngine();
    r.engineReady(eng.win, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
    port.postMessage({ id: 1, op: 'project.open', args: { name: 'x', files: [
      { path: 'blink.kicad_sch', bytes: b('(kicad_sch)') }, { path: 'sub/power.kicad_sch', bytes: b('(kicad_sch)') },
    ], open: 'blink.kicad_sch' } });
    await settle(100);
    eng.Module.kicadSheetsGetTree.mockReturnValue(JSON.stringify({ current: '/a/', sheets: [
      { path: '/', file: `${ROOT}/blink.kicad_sch` }, { path: '/a/', file: `${ROOT}/sub/power.kicad_sch` },
    ] }));
    got.length = 0;
    port.postMessage({ id: 2, op: 'project.save' });
    await settle();
    expect(eng.Module.kicadSaveSchematic).toHaveBeenCalledWith(`${ROOT}/sub/power.kicad_sch`);
    expect(got.at(-1)).toEqual({ id: 2, ok: true, result: { path: 'sub/power.kicad_sch' } });
    // A current sheet outside the project is refused, never saved over the root.
    eng.Module.kicadSheetsGetTree.mockReturnValue(JSON.stringify({ current: '/b/', sheets: [{ path: '/b/', file: '/tmp/elsewhere.kicad_sch' }] }));
    got.length = 0;
    port.postMessage({ id: 3, op: 'project.save' });
    await settle();
    expect(got).toEqual([{ id: 3, ok: false, error: { code: 'save_failed', message: 'the shown sheet is outside the project' } }]);
  });
});
