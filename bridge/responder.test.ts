// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { describe, expect, it, vi } from 'vitest';
import { memfsProjectDir } from '../loader/src/wasm/constants';
import { startResponder } from './responder';

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
    unlink(p: string) { files.delete(p); },
    readdir(p: string) {
      const names = new Set<string>(['.', '..']);
      for (const k of [...files.keys(), ...dirs]) if (k !== p && parentOf(k) === p) names.add(k.slice(p.length + 1));
      return [...names];
    },
    stat(p: string) { return { mode: dirs.has(p) ? 0o040755 : 0o100644 }; },
    isDir(mode: number) { return (mode & 0o170000) === 0o040000; },
    rmdir(p: string) { if (this.readdir(p).length > 2) throw new Error('ENOTEMPTY'); dirs.delete(p); },
  };
  return { FS, files, dirs };
}

/** A booted engine: a visible frame, the programmatic open and the save exports. */
function fakeEngine() {
  const { FS, files, dirs } = fakeFs();
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
  return { win, files, dirs, opened, Module };
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
