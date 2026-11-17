// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NgspiceNotice } from '../loader/src/wasm/ngspice-service';
import { ngspiceWorkerBlobParts } from '../loader/src/wasm/ngspice-service';
import { installSimService } from './sim-service';

/** A Worker stand-in: what the provider posts, and a way to answer as the worker does. */
class FakeWorker {
  static made: FakeWorker[] = [];
  posted: unknown[] = [];
  terminated = false;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  private listeners = new Set<(e: MessageEvent) => void>();
  constructor(public url: string) { FakeWorker.made.push(this); }
  postMessage(m: unknown): void { this.posted.push(m); }
  terminate(): void { this.terminated = true; }
  addEventListener(_t: string, h: (e: MessageEvent) => void): void { this.listeners.add(h); }
  removeEventListener(_t: string, h: (e: MessageEvent) => void): void { this.listeners.delete(h); }
  send(data: unknown): void {
    const e = { data } as MessageEvent;
    this.onmessage?.(e);
    for (const h of [...this.listeners]) h(e);
  }
}

const settle = () => new Promise((r) => setTimeout(r, 0));
let blobs: Blob[] = [];

beforeEach(() => {
  FakeWorker.made = [];
  blobs = [];
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('window', { location: { href: 'https://editor.example/r/x/index.html' } });
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => { blobs.push(b as Blob); return `blob:${blobs.length}`; });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  delete (globalThis as { ngspiceService?: unknown }).ngspiceService;
  delete (globalThis as { __ngspiceOnEvent?: unknown }).__ngspiceOnEvent;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (globalThis as { ngspiceService?: unknown }).ngspiceService;
  delete (globalThis as { __ngspiceOnEvent?: unknown }).__ngspiceOnEvent;
});

function install() {
  const notices: NgspiceNotice[] = [];
  const sim = installSimService({ base: '/r/x/wasm/kicad_editor/v0.2.3/', wasmBytes: 5_666_939, log: () => undefined });
  sim?.listen((n) => notices.push(n));
  return { sim, notices };
}

describe('the simulator service', () => {
  it('is installed only when the island serves its files, and only once', () => {
    expect(installSimService({ base: '/b/', wasmBytes: 0, log: () => undefined })).toBeNull();
    expect(globalThis.ngspiceService).toBeUndefined();
    const { sim } = install();
    expect(sim).not.toBeNull();
    expect(globalThis.ngspiceService).toBeDefined();
    expect(installSimService({ base: '/b/', wasmBytes: 1, log: () => undefined })).toBeNull();
  });

  it('makes no worker until the first request', async () => {
    install();
    await settle();
    expect(FakeWorker.made).toHaveLength(0);
  });

  it('tells the worker the glue beside the engine and the wasm\'s raw size', async () => {
    const { sim } = install();
    void sim!.request({ kind: 'init' });
    await settle();
    expect(FakeWorker.made).toHaveLength(1);
    const prelude = await blobs[0]!.text();
    expect(prelude).toContain('self.NGSPICE_GLUE_URL = "https://editor.example/r/x/wasm/kicad_editor/v0.2.3/ngspice_service.js";');
    expect(prelude).toContain('self.NGSPICE_WASM_BYTES = 5666939;');
    expect(prelude).toContain('instantiateWasm: instantiateWithProgress');
    expect(ngspiceWorkerBlobParts('g', -3)[0]).toContain('self.NGSPICE_WASM_BYTES = 0;');
  });

  it('passes the loading progress and readiness on, then answers the request', async () => {
    const { sim, notices } = install();
    const answer = sim!.request({ kind: 'all_plots' });
    await settle();
    const w = FakeWorker.made[0]!;
    w.send({ progress: { loaded: 1000, total: 5_666_939 } });
    w.send({ ready: true });
    await settle();
    expect(w.posted).toEqual([{ id: 1, req: { kind: 'all_plots' } }]);
    w.send({ id: 1, res: { names: ['const'] } });
    await expect(answer).resolves.toEqual({ names: ['const'] });
    expect(notices).toEqual([{ type: 'progress', loaded: 1000, total: 5_666_939 }, { type: 'ready' }]);
  });

  it('hands each event to the engine and to the island, and acknowledges it', async () => {
    const { sim, notices } = install();
    const engine: unknown[] = [];
    globalThis.__ngspiceOnEvent = (e) => { engine.push(e); };
    void sim!.request({ kind: 'init' });
    await settle();
    const w = FakeWorker.made[0]!;
    w.send({ ready: true });
    await settle();
    const evt = { kind: 'stat', lines: ['tran: 34.5%'] };
    w.send({ evt, eventSequence: 1, eventBytes: 40 });
    expect(engine).toEqual([evt]);
    expect(notices).toContainEqual({ type: 'event', evt });
    expect(w.posted).toContainEqual({ eventAck: { sequence: 1, bytes: 40 } });
  });

  it('a release ends the worker, says released, and the next request boots a fresh one', async () => {
    const { sim, notices } = install();
    expect(sim!.release()).toBe(false);
    void sim!.request({ kind: 'init' });
    await settle();
    FakeWorker.made[0]!.send({ ready: true });
    await settle();
    expect(sim!.live()).toBe(true);
    expect(sim!.release()).toBe(true);
    expect(FakeWorker.made[0]!.terminated).toBe(true);
    expect(sim!.live()).toBe(false);
    expect(notices.at(-1)).toEqual({ type: 'released' });
    expect(notices.some((n) => n.type === 'died')).toBe(false);
    void sim!.request({ kind: 'init' });
    await settle();
    expect(FakeWorker.made).toHaveLength(2);
  });

  it('a worker that dies settles what was in flight and says died', async () => {
    const { sim, notices } = install();
    void sim!.request({ kind: 'init' });
    await settle();
    const w = FakeWorker.made[0]!;
    w.send({ ready: true });
    await settle();
    const pending = sim!.request({ kind: 'command', cmd: 'bg_run' });
    await settle();
    w.onerror?.({ message: 'out of memory' });
    await expect(pending).resolves.toEqual({ error: 'ngspice_service crashed: out of memory' });
    expect(notices.at(-1)).toEqual({ type: 'died', why: 'ngspice_service crashed: out of memory' });
  });
});
