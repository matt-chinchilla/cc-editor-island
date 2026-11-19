// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The 3D service's provider (3d-i1): lazy, its loading progress, an export
// written where the engine reads it, the staging hook, the release after 60 s
// idle and at once, and a worker's end with requests waiting.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installOccService,
  occWorkerBlobParts,
  OCC_NO_FILE,
  OCC_NO_PATH,
  OCC_STOPPED,
  type OccResponse,
  type OccServiceHandle,
} from './occ-service';

/** A Worker stand-in: what the provider posts, and a way to answer as the worker does. */
class FakeWorker {
  static made: FakeWorker[] = [];
  posted: Array<{ data: Record<string, unknown>; transfer?: unknown[] }> = [];
  terminated = false;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  private listeners = new Set<(e: MessageEvent) => void>();
  constructor(public url: string) { FakeWorker.made.push(this); }
  postMessage(data: Record<string, unknown>, transfer?: unknown[]): void { this.posted.push({ data, transfer }); }
  terminate(): void { this.terminated = true; locks.endHolder(this); }
  addEventListener(_t: string, h: (e: MessageEvent) => void): void { this.listeners.add(h); }
  removeEventListener(_t: string, h: (e: MessageEvent) => void): void { this.listeners.delete(h); }
  send(data: unknown): void {
    const e = { data } as MessageEvent;
    this.onmessage?.(e);
    for (const h of [...this.listeners]) h(e);
  }
  /** The worker's top realm takes its life lock and says so. */
  alive(name: string): void { locks.hold(name, this); this.send({ alive: true }); }
  requests(): Array<{ id: number; req: Record<string, unknown> }> {
    return this.posted.filter((p) => typeof p.data.id === 'number').map((p) => p.data as { id: number; req: Record<string, unknown> });
  }
}

/** navigator.locks as the provider uses it: a lock the worker holds is granted to the host once the worker ends. */
const locks = {
  held: new Map<string, FakeWorker>(),
  waiting: new Map<string, Array<{ cb: () => void; signal?: AbortSignal; reject: (e: unknown) => void }>>(),
  hold(name: string, w: FakeWorker) { this.held.set(name, w); },
  endHolder(w: FakeWorker) {
    for (const [name, holder] of [...this.held]) {
      if (holder !== w) continue;
      this.held.delete(name);
      for (const waiter of this.waiting.get(name) ?? []) if (!waiter.signal?.aborted) waiter.cb();
      this.waiting.delete(name);
    }
  },
  request(name: string, opts: { signal?: AbortSignal }, cb: () => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const list = this.waiting.get(name) ?? [];
      const entry = { cb: () => { cb(); resolve(); }, signal: opts.signal, reject };
      list.push(entry);
      this.waiting.set(name, list);
      opts.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  },
};

const BASE = '/r/x/wasm/kicad_editor/v0.2.3/';
const WASM_BYTES = 1_000;
// The real timer, taken before any test fakes them.
const realSetTimeout = globalThis.setTimeout;
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => realSetTimeout(r, 0)); };
let blobs: Blob[] = [];
let fetched: string[] = [];
let files: Map<string, Uint8Array>;
let dirs: Set<string>;
let logs: string[];

function fakeFs(): EmscriptenFS {
  return {
    mkdirTree: (p: string) => { dirs.add(p); },
    writeFile: (p: string, d: Uint8Array | string) => { files.set(p, typeof d === 'string' ? new TextEncoder().encode(d) : d); },
    readFile: () => { throw new Error('unused'); },
    analyzePath: (p: string) => ({ exists: dirs.has(p) || files.has(p) }),
    unlink: () => undefined,
    readdir: () => [],
    stat: () => ({ mode: 0 }),
    isDir: () => false,
    rmdir: () => undefined,
  };
}

/** A Response whose body arrives in `chunks` pieces of the wasm's size. */
function wasmResponse(chunks = 4): Response {
  const piece = WASM_BYTES / chunks;
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent >= chunks) { c.close(); return; }
      sent++;
      c.enqueue(new Uint8Array(piece));
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/wasm' } });
}

beforeEach(() => {
  FakeWorker.made = [];
  blobs = [];
  fetched = [];
  files = new Map();
  dirs = new Set(['/tmp/out']);
  logs = [];
  locks.held.clear();
  locks.waiting.clear();
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('window', { location: { href: 'https://editor.example/r/x/index.html' } });
  vi.stubGlobal('navigator', { locks });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { fetched.push(url); return wasmResponse(); }));
  vi.stubGlobal('WebAssembly', { ...WebAssembly, compileStreaming: vi.fn(async (r: Response | Promise<Response>) => { await (await r).arrayBuffer(); return { compiled: true }; }) });
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => { blobs.push(b as Blob); return `blob:${blobs.length}`; });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  delete globalThis.occService;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete globalThis.occService;
});

function install(watchdogs = {}): OccServiceHandle {
  const h = installOccService({ base: BASE, wasmBytes: WASM_BYTES, log: (m) => logs.push(m), fs: fakeFs, watchdogs });
  if (h == null) throw new Error('not installed');
  return h;
}

const exportReq = (outPath: string | null = '/tmp/out/board.step') => ({
  kind: 'export' as const,
  board: new TextEncoder().encode('(kicad_pcb)'),
  jobJson: '{"format":"step"}',
  fileName: 'board.step',
  ...(outPath === null ? {} : { outPath }),
});

/** Boots the n-th worker: ready, its life lock held. */
async function bootWorker(n: number): Promise<FakeWorker> {
  await vi.waitFor(() => expect(FakeWorker.made[n]).toBeDefined());
  const w = FakeWorker.made[n]!;
  const lock = /OCC_LIFE_LOCK = "([^"]+)"/.exec(await blobs[n]!.text())?.[1];
  if (lock == null) throw new Error('no life lock in the prelude');
  w.send({ ready: true });
  w.alive(lock);
  await settle();
  return w;
}

/** Answers the worker's latest request. */
async function answer(w: FakeWorker, res: OccResponse): Promise<void> {
  await vi.waitFor(() => expect(w.requests().length).toBeGreaterThan(0));
  const { id } = w.requests().at(-1)!;
  w.send({ id, res });
  await settle();
}

describe('the 3D service provider', () => {
  it('is installed once, and fetches nothing until the first request', async () => {
    const h = install();
    expect(typeof globalThis.occService?.request).toBe('function');
    expect(installOccService({ base: BASE, wasmBytes: WASM_BYTES, log: () => undefined, fs: fakeFs })).toBeNull();
    await settle();
    expect(fetched).toEqual([]);
    expect(FakeWorker.made).toEqual([]);
    expect(h.live()).toBe(false);
    expect(logs.some((l) => l.includes('installed (lazy)'))).toBe(true);
  });

  it('fetches the wasm once from the island base, reports its progress, and posts the module first', async () => {
    const h = install();
    const seen: Array<[number, number]> = [];
    h.onProgress((loaded, total) => seen.push([loaded, total]));
    const first = h.request({ kind: 'loadModel', bytes: new Uint8Array([1, 2, 3]), ext: 'step' });
    const w = await bootWorker(0);
    expect(fetched).toEqual(['https://editor.example/r/x/wasm/kicad_editor/v0.2.3/occ_service.wasm']);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)).toEqual([WASM_BYTES, WASM_BYTES]);
    expect(seen.every(([, total]) => total === WASM_BYTES)).toBe(true);
    expect(w.posted[0]!.data).toEqual({ wasmModule: { compiled: true } });
    expect(w.requests()[0]!.req).toMatchObject({ kind: 'loadModel', ext: 'step' });
    await answer(w, { ok: true, bytes: new Uint8Array([9]) });
    await expect(first).resolves.toMatchObject({ ok: true });
    // a second request reuses the worker: no second fetch
    const second = h.request({ kind: 'loadModel', bytes: new Uint8Array([4]), ext: 'step' });
    await answer(w, { ok: true });
    await expect(second).resolves.toMatchObject({ ok: true });
    expect(fetched).toHaveLength(1);
    expect(FakeWorker.made).toHaveLength(1);
  });

  it('names the glue and the life lock in the worker prelude', async () => {
    const parts = occWorkerBlobParts('https://e.example/occ_service.js', 'cc-occ-life-x');
    expect(parts[0]).toBe('self.OCC_GLUE_URL = "https://e.example/occ_service.js";\nself.OCC_LIFE_LOCK = "cc-occ-life-x";\n');
    const h = install();
    void h.request({ kind: 'loadModel', bytes: new Uint8Array([1]), ext: 'step' });
    await vi.waitFor(() => expect(blobs).toHaveLength(1));
    const text = await blobs[0]!.text();
    expect(text).toContain('self.OCC_GLUE_URL = "https://editor.example/r/x/wasm/kicad_editor/v0.2.3/occ_service.js"');
    expect(text).toMatch(/self\.OCC_LIFE_LOCK = "cc-occ-life-[^"]+"/);
  });

  it('writes an export at outPath in the engine file system and answers ok and the report only', async () => {
    const h = install();
    const staged: unknown[] = [];
    h.setStage(async (input) => {
      staged.push(input);
      return { models: [{ path: 'R.3dshapes/R.step', bytes: new Uint8Array([7, 7]) }], report: 'Skipped 1 file.' };
    });
    const run = h.request(exportReq());
    const w = await bootWorker(0);
    const sent = w.requests()[0]!;
    expect(sent.req).toMatchObject({ kind: 'export', jobJson: '{"format":"step"}', fileName: 'board.step' });
    expect((sent.req.models as unknown[]).length).toBe(1);
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatchObject({ outPath: '/tmp/out/board.step', fileName: 'board.step' });
    const bytes = new TextEncoder().encode('ISO-10303-21;');
    await answer(w, { ok: true, report: 'Exported.', fileName: 'board.step', bytes });
    const res = await run;
    expect(res).toEqual({ ok: true, report: 'Exported.\nSkipped 1 file.' });
    expect(files.get('/tmp/out/board.step')).toEqual(bytes);
  });

  it('makes the folder of outPath when it is missing', async () => {
    const h = install();
    const run = h.request(exportReq('/tmp/new/dir/board.glb'));
    const w = await bootWorker(0);
    await answer(w, { ok: true, bytes: new Uint8Array([1]) });
    await expect(run).resolves.toMatchObject({ ok: true });
    expect(dirs.has('/tmp/new/dir')).toBe(true);
    expect(files.has('/tmp/new/dir/board.glb')).toBe(true);
  });

  it('refuses an export with no outPath, and one that gave no bytes', async () => {
    const h = install();
    await expect(h.request(exportReq(null))).resolves.toEqual({ ok: false, report: OCC_NO_PATH });
    expect(FakeWorker.made).toEqual([]);
    const run = h.request(exportReq());
    const w = await bootWorker(0);
    await answer(w, { ok: true });
    await expect(run).resolves.toEqual({ ok: false, report: OCC_NO_FILE });
    expect(files.size).toBe(0);
  });

  it('passes a failed export through with its report', async () => {
    const h = install();
    const run = h.request(exportReq());
    const w = await bootWorker(0);
    await answer(w, { ok: false, report: 'No board outline.' });
    await expect(run).resolves.toEqual({ ok: false, report: 'No board outline.' });
  });

  it('runs the export with no bodies, and says so, when staging fails', async () => {
    const h = install();
    h.setStage(async () => { throw new Error('offline'); });
    const run = h.request(exportReq());
    const w = await bootWorker(0);
    expect(w.requests()[0]!.req.models).toEqual([]);
    await answer(w, { ok: true, bytes: new Uint8Array([1]) });
    const res = await run;
    expect(res.ok).toBe(true);
    expect(res.report).toContain('could not be gathered');
  });

  it('releases the worker 60 s after its last answer, and the next request boots a new one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = install();
    const run = h.request(exportReq());
    const w = await bootWorker(0);
    await answer(w, { ok: true, bytes: new Uint8Array([1]) });
    await run;
    expect(h.live()).toBe(true);
    vi.advanceTimersByTime(59_000);
    expect(w.terminated).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(w.terminated).toBe(true);
    expect(h.live()).toBe(false);
    const again = h.request({ kind: 'loadModel', bytes: new Uint8Array([1]), ext: 'step' });
    const w2 = await bootWorker(1);
    await answer(w2, { ok: true });
    await expect(again).resolves.toMatchObject({ ok: true });
    expect(fetched).toHaveLength(2);
  });

  it('keeps the worker while a request waits, however long', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = install();
    const run = h.request(exportReq());
    const w = await bootWorker(0);
    vi.advanceTimersByTime(120_000);
    expect(w.terminated).toBe(false);
    await answer(w, { ok: true, bytes: new Uint8Array([1]) });
    await expect(run).resolves.toMatchObject({ ok: true });
  });

  it('release() ends the worker at once and settles what waits', async () => {
    const h = install();
    const run = h.request(exportReq());
    const w = await bootWorker(0);
    expect(h.release()).toBe(true);
    expect(w.terminated).toBe(true);
    await expect(run).resolves.toEqual({ ok: false, report: OCC_STOPPED });
    expect(h.release()).toBe(false);
  });

  it('a worker error settles every waiting request "The 3D service stopped." and the next boots a new worker', async () => {
    const h = install();
    const a = h.request(exportReq());
    const w = await bootWorker(0);
    const b = h.request({ kind: 'loadModel', bytes: new Uint8Array([1]), ext: 'step' });
    await vi.waitFor(() => expect(w.requests()).toHaveLength(2));
    w.onerror?.({ message: 'RuntimeError: unreachable' });
    await expect(a).resolves.toEqual({ ok: false, report: OCC_STOPPED });
    await expect(b).resolves.toEqual({ ok: false, report: OCC_STOPPED });
    expect(w.terminated).toBe(true);
    const c = h.request(exportReq());
    const w2 = await bootWorker(1);
    await answer(w2, { ok: true, bytes: new Uint8Array([2]) });
    await expect(c).resolves.toMatchObject({ ok: true });
  });

  it('hears a worker that closed itself through its life lock', async () => {
    const h = install();
    const run = h.request(exportReq());
    const w = await bootWorker(0);
    // close() inside the worker: no error event, only the lock let go
    locks.endHolder(w);
    await expect(run).resolves.toEqual({ ok: false, report: OCC_STOPPED });
    expect(h.live()).toBe(false);
    const next = h.request(exportReq());
    const w2 = await bootWorker(1);
    await answer(w2, { ok: true, bytes: new Uint8Array([3]) });
    await expect(next).resolves.toMatchObject({ ok: true });
  });

  it('a failed wasm fetch answers that the service did not start, and the next request tries again', async () => {
    const h = install();
    vi.mocked(fetch).mockImplementationOnce(async (url) => { fetched.push(String(url)); return new Response('', { status: 404 }); });
    const res = await h.request(exportReq());
    expect(res.ok).toBe(false);
    expect(res.report).toMatch(/^The 3D service did not start: .*HTTP 404/);
    expect(FakeWorker.made).toEqual([]);
    const next = h.request(exportReq());
    const w = await bootWorker(0);
    await answer(w, { ok: true, bytes: new Uint8Array([1]) });
    await expect(next).resolves.toMatchObject({ ok: true });
  });

  it('a boot error answers that the service did not start', async () => {
    const h = install();
    const run = h.request(exportReq());
    await vi.waitFor(() => expect(FakeWorker.made[0]).toBeDefined());
    FakeWorker.made[0]!.send({ bootError: 'out of memory' });
    const res = await run;
    expect(res.ok).toBe(false);
    expect(res.report).toContain('The 3D service did not start');
    expect(FakeWorker.made[0]!.terminated).toBe(true);
  });
});
