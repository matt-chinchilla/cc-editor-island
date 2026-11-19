// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// m11-i: sim.userSignals and the user vectors sim.vectors reads. The engine,
// the responder's ctx and the simulator service are this file's own doubles
// at the protocol boundary; the real engine's half is tests/e2e/sim-user-signals.spec.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startResponder } from '../responder';
import { fail, ok, type Answer, type ExtUnit, type ResponderCtx } from './contract';
import { buildRegistry, REGISTRY } from './registry';
import type { NgspiceRequest, NgspiceResponse } from '../../loader/src/wasm/ngspice-service';
import { SIM_FRAME_ONLY } from '../sim';
import { isExpression, parseUserSignalsArgs, readUserSignals, USER_SIGNALS_RECORD } from './m11-i/userSignals';

/** The service double: what all_plots lists and the vectors each plot holds. */
const service = {
  booted: true,
  plots: ['const', 'ac1', 'tran2'] as string[],
  vecs: new Map<string, Float64Array>(),
  asked: [] as NgspiceRequest[],
  live() { return this.booted; },
  async request(req: NgspiceRequest): Promise<NgspiceResponse> {
    this.asked.push(req);
    if (req.kind === 'all_plots') return { names: [...this.plots] };
    if (req.kind === 'get_vec_info') {
      const v = this.vecs.get(req.name);
      return v == null ? { found: false } : { found: true, real: v.slice() };
    }
    return { error: 'not in this double' };
  },
};
let installed: typeof service | null = service;
vi.mock('../../src/sim-service', async (orig) => ({ ...(await orig<typeof import('../../src/sim-service')>()), currentSimService: () => installed }));

const { default: unit } = await import('./m11-i');
const run = unit.ops['sim.userSignals'].run;
const widen = unit.opsWidened['sim.vectors'];

interface Double { ctx: ResponderCtx; files: Map<string, Uint8Array>; dirs: string[]; dropped: string[]; engine: ReturnType<typeof vi.fn>; live: { run: number | null } }

/** A ctx double whose engine accepts only `accepts` for run 3 and then writes `record` (by default the made record). */
function double(opts: { accepts?: string; record?: (args: Record<string, unknown>) => unknown; gate?: Answer } = {}): Double {
  const files = new Map<string, Uint8Array>();
  const dirs: string[] = [];
  const dropped: string[] = [];
  const live = { run: null as number | null };
  let n = 0;
  const engine = vi.fn((json: string) => {
    const a = JSON.parse(json) as Record<string, unknown>;
    if (a.run !== 3 || a.plot !== (opts.accepts ?? 'tran2')) return false;
    const rec = opts.record?.(a) ?? {
      run: a.run, plot: a.plot, error: '',
      vectors: [{ id: 0, name: 'user0', length: 4, complex: false }],
      errors: [{ id: 1, line: 'Error: no such vector nosuchnet' }],
    };
    files.set(`${a.dir as string}/${USER_SIGNALS_RECORD}`, new TextEncoder().encode(JSON.stringify(rec)));
    return true;
  });
  const mod = { kicadSimUserSignals: engine, kicadCollabBusy: () => false };
  const ctx = {
    frame: 'sch',
    schematicGate: () => opts.gate ?? { w: {} as ToolWindow, mod },
    simRun: () => live.run,
    freshRunFolder: (root: string) => { n += 1; const d = `${root}/${n}`; dirs.push(d); return d; },
    dropRunFolder: (d: string) => { dropped.push(d); for (const k of [...files.keys()]) if (k.startsWith(`${d}/`)) files.delete(k); },
    readBytes: (abs: string) => files.get(abs) ?? null,
    async queuedRun<T>(op: string, _dir: string, _ms: number, call: () => unknown, record: () => T | null) {
      if (call() !== true) return fail('not_applied', op);
      const done = record();
      return done == null ? fail('not_applied', op) : { done };
    },
  } as unknown as ResponderCtx;
  return { ctx, files, dirs, dropped, engine, live };
}

beforeEach(() => {
  installed = service;
  service.booted = true;
  service.plots = ['const', 'ac1', 'tran2'];
  service.vecs = new Map([['tran2.user0', new Float64Array([0, 0.5, 0.75, 0.875])]]);
  service.asked = [];
});

describe('m11-i in the registry', () => {
  it('loads from its own file with nothing broken: the op, its cap, and a widening of sim.vectors', () => {
    expect(buildRegistry({ './m11-i.ts': { default: unit } }).problems).toEqual([]);
    expect(REGISTRY.problems).toEqual([]);
    expect(REGISTRY.ops.get('sim.userSignals')?.unit).toBe('m11-i');
    expect(REGISTRY.widen.get('sim.vectors')?.map((w) => w.unit)).toContain('m11-i');
    expect(REGISTRY.capNames.get('simUserSignals')).toBe('m11-i');
  });

  it('lists simUserSignals only in a sch frame whose engine has kicadSimUserSignals (never on engine run 14)', () => {
    const run15 = { kicadSimUserSignals: () => false };
    expect(unit.caps(run15, 'sch')).toEqual(['simUserSignals']);
    expect(unit.caps(run15, 'pcb')).toEqual([]);
    expect(unit.caps({ kicadSimRun: () => false }, 'sch')).toEqual([]);
  });
});

describe('the one expression grammar check', () => {
  it('takes one expression of printable ASCII, 1 to 256 characters', () => {
    for (const ok of ['V(out)-V(in)', 'V(/out) * I(R1)', 'db(V(out))', 'x', 'a'.repeat(256), ' V(out) ']) expect(isExpression(ok), ok).toBe(true);
  });
  it('refuses what could end the let or start a second command: line breaks, ;, quotes, backslash, backtick, braces, control characters', () => {
    for (const bad of ['', 'a'.repeat(257), 'V(out);quit', 'V(out)\nquit', 'V(out)\rquit', 'V(out)\tV(in)', '"V(out)"', "V('out')", 'V(out)\\', '`ls`', '{V(out)}', 'V(out)\u0000', 'V(out)µ', 'V(out)−V(in)', 'V(out)\u007f'])
      expect(isExpression(bad), JSON.stringify(bad)).toBe(false);
    expect(isExpression(3)).toBe(false);
  });
  it('reads the args closed: run 1 or more, 0 to 16 expressions, no other key', () => {
    expect(parseUserSignalsArgs({ run: 1, signals: [] })).toEqual({ run: 1, signals: [] });
    expect(parseUserSignalsArgs({ run: 2, signals: Array.from({ length: 16 }, (_, i) => `V(n${i})`) })?.signals).toHaveLength(16);
    expect(parseUserSignalsArgs({ run: 2, signals: Array.from({ length: 17 }, (_, i) => `V(n${i})`) })).toBeNull();
    expect(parseUserSignalsArgs({ run: 0, signals: [] })).toBeNull();
    expect(parseUserSignalsArgs({ run: 1.5, signals: [] })).toBeNull();
    expect(parseUserSignalsArgs({ run: 1, signals: ['V(out)'], plot: 'tran1' })).toBeNull();
    expect(parseUserSignalsArgs({ run: 1 })).toBeNull();
    expect(parseUserSignalsArgs({ run: 1, signals: 'V(out)' })).toBeNull();
    expect(parseUserSignalsArgs({ run: 1, signals: ['V(out)', 'V(a);quit'] })).toBeNull();
  });
});

describe('the record read closed', () => {
  const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
  it('reads the engine record with its run, plot and error, message optional', () => {
    const rec = { run: 3, plot: 'tran2', error: '', vectors: [{ id: 0, name: 'user0', length: 4, complex: false }], errors: [] };
    expect(readUserSignals(enc(rec))).toEqual(rec);
    expect(readUserSignals(enc({ ...rec, error: 'sim_failed', message: 'ngspice stopped' }))?.message).toBe('ngspice stopped');
  });
  it('refuses another shape: an unknown key, a name that is not user<id>, an id past 15, an unknown error', () => {
    const rec = { run: 3, plot: 'tran2', error: '', vectors: [], errors: [] };
    expect(readUserSignals(null)).toBeNull();
    expect(readUserSignals(new TextEncoder().encode('{"run":'))).toBeNull();
    expect(readUserSignals(enc({ ...rec, extra: 1 }))).toBeNull();
    expect(readUserSignals(enc({ ...rec, vectors: [{ id: 0, name: 'user1', length: 1, complex: false }] }))).toBeNull();
    expect(readUserSignals(enc({ ...rec, errors: [{ id: 16, line: 'x' }] }))).toBeNull();
    expect(readUserSignals(enc({ ...rec, error: 'stopped' }))).toBeNull();
  });
});

describe('sim.userSignals', () => {
  it('sends each expression as user<index> into the plot the engine takes, and answers the vectors and the refused lines', async () => {
    const t = double();
    const answer = await run({ run: 3, signals: ['V(/out)-V(/in)', 'V(nosuchnet)'] }, t.ctx);
    expect(answer).toEqual(ok({
      vectors: [{ name: 'user0', signal: 'V(/out)-V(/in)', trace: 'other', complex: false, length: 4 }],
      errors: [{ index: 1, line: 'Error: no such vector nosuchnet' }],
    }));
    // ngspice's constants are never asked; the plots before the run's are, and refused with nothing queued.
    const plots = t.engine.mock.calls.map(([j]) => (JSON.parse(j as string) as { plot: string }).plot);
    expect(plots).toEqual(['ac1', 'tran2']);
    expect(JSON.parse(t.engine.mock.calls[1]![0] as string)).toEqual({
      run: 3, dir: '/tmp/cc-sim/1', plot: 'tran2',
      signals: [{ id: 0, expr: 'V(/out)-V(/in)' }, { id: 1, expr: 'V(nosuchnet)' }],
    });
    expect(t.dropped).toEqual(['/tmp/cc-sim/1']);
  });

  it('answers bad_args for an expression with a semicolon, a line break, a quote or a brace, and nothing reaches the engine or the service', async () => {
    for (const bad of ['V(out);quit', 'V(out)\nquit', '"V(out)"', '{V(out)}']) {
      const t = double();
      expect(await run({ run: 3, signals: ['V(in)', bad] }, t.ctx)).toEqual(fail('bad_args', 'sim.userSignals'));
      expect(t.engine).not.toHaveBeenCalled();
      expect(t.dirs).toEqual([]);
    }
    expect(service.asked).toEqual([]);
  });

  it('answers no_simulation when no plot the service holds is the run\'s: a run superseded by a newer one of its kind', async () => {
    service.plots = ['const', 'tran3'];
    const t = double();
    expect(await run({ run: 3, signals: ['V(/out)'] }, t.ctx)).toEqual(fail('no_simulation', 'run 3'));
    expect(t.engine).toHaveBeenCalledTimes(1);
    expect(t.dropped).toEqual(['/tmp/cc-sim/1']);
  });

  it('answers no_simulation when the engine finds the plot gone at its queued body', async () => {
    const t = double({ record: (a) => ({ run: a.run, plot: a.plot, error: 'no_simulation', vectors: [], errors: [] }) });
    expect(await run({ run: 3, signals: ['V(/out)'] }, t.ctx)).toEqual(fail('no_simulation', 'run 3'));
  });

  it('answers sim_failed with the engine\'s message', async () => {
    const t = double({ record: (a) => ({ run: a.run, plot: a.plot, error: 'sim_failed', message: 'the simulator ended', vectors: [], errors: [] }) });
    expect(await run({ run: 3, signals: ['V(/out)'] }, t.ctx)).toEqual(fail('sim_failed', 'the simulator ended'));
  });

  it('answers island_error for a record of another run or a signal it did not send', async () => {
    let t = double({ record: (a) => ({ run: 9, plot: a.plot, error: '', vectors: [], errors: [] }) });
    expect((await run({ run: 3, signals: ['V(/out)'] }, t.ctx) as { code: string }).code).toBe('island_error');
    t = double({ record: (a) => ({ run: a.run, plot: a.plot, error: '', vectors: [{ id: 2, name: 'user2', length: 1, complex: false }], errors: [] }) });
    expect((await run({ run: 3, signals: ['V(/out)'] }, t.ctx) as { code: string }).code).toBe('island_error');
  });

  it('keeps the gates in order: the gate\'s refusal, no service, a live run, a released service', async () => {
    let t = double({ gate: fail('unsupported', 'kicadSimUserSignals') });
    expect(await run({ run: 3, signals: [] }, t.ctx)).toEqual(fail('unsupported', 'kicadSimUserSignals'));
    installed = null;
    t = double();
    expect(await run({ run: 3, signals: [] }, t.ctx)).toEqual(fail('unsupported', 'ngspice_service.wasm'));
    installed = service;
    t = double();
    t.live.run = 4;
    expect(await run({ run: 3, signals: [] }, t.ctx)).toEqual(fail('busy', 'a run is live'));
    service.booted = false;
    t = double();
    expect((await run({ run: 3, signals: [] }, t.ctx) as { code: string }).code).toBe('no_simulation');
    expect(t.engine).not.toHaveBeenCalled();
  });
});

describe('sim.vectors reads the user vectors as any other', () => {
  const base = (names: string[]) => ({
    ok: true as const,
    result: { vectors: names.map((name) => ({ name, real: new Float64Array([1, 2, 3, 4]), imag: null })) },
    transfer: [] as ArrayBuffer[],
  });

  it('reads user0 from the run\'s plot and the other names through the op, in the order asked', async () => {
    const t = double();
    expect((await run({ run: 3, signals: ['V(/out)-V(/in)', 'V(nosuchnet)'] }, t.ctx)).ok).toBe(true);
    const next = vi.fn(async (a: unknown) => base((a as { names: string[] }).names) as Answer);
    const answer = await widen({ run: 3, names: ['user0', 'time'] }, t.ctx, next);
    expect(next).toHaveBeenCalledWith({ run: 3, names: ['time'] });
    expect(answer.ok).toBe(true);
    const vs = (answer as unknown as { result: { vectors: Array<{ name: string; real: Float64Array }> } }).result.vectors;
    expect(vs.map((v) => v.name)).toEqual(['user0', 'time']);
    expect(Array.from(vs[0]!.real)).toEqual([0, 0.5, 0.75, 0.875]);
    expect(service.asked.at(-1)).toEqual({ kind: 'get_vec_info', name: 'tran2.user0' });
    expect((answer as unknown as { transfer: ArrayBuffer[] }).transfer).toContain(vs[0]!.real.buffer);
  });

  it('leaves to the op a run it made nothing for, and a user name it did not make', async () => {
    const t = double();
    expect((await run({ run: 3, signals: ['V(/out)', 'V(nosuchnet)'] }, t.ctx)).ok).toBe(true);
    const next = vi.fn(async () => fail('bad_args', 'run 3 has no user5'));
    expect(await widen({ run: 3, names: ['user5'] }, t.ctx, next)).toEqual(fail('bad_args', 'run 3 has no user5'));
    expect(await widen({ run: 2, names: ['user0'] }, t.ctx, next)).toEqual(fail('bad_args', 'run 3 has no user5'));
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('answers no_simulation once the plot is gone, busy while a run is live', async () => {
    const t = double();
    expect((await run({ run: 3, signals: ['V(/out)', 'V(nosuchnet)'] }, t.ctx)).ok).toBe(true);
    const next = vi.fn(async (a: unknown) => base((a as { names: string[] }).names) as Answer);
    t.live.run = 4;
    expect(await widen({ run: 3, names: ['user0'] }, t.ctx, next)).toEqual(fail('busy', 'a run is live'));
    t.live.run = null;
    service.vecs.clear();
    expect((await widen({ run: 3, names: ['user0'] }, t.ctx, next) as { code: string }).code).toBe('no_simulation');
    expect(next).not.toHaveBeenCalled();
  });
});

describe('through the responder', () => {
  const PARENT = 'http://localhost';
  const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
  beforeEach(() => {
    vi.stubGlobal('KeyboardEvent', class extends Event {});
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  async function boot(frame: string, mod: Record<string, unknown>) {
    const reg = buildRegistry({ './m11-i.ts': { default: unit as ExtUnit } });
    const listeners = new Map<string, Set<(e: unknown) => void>>();
    const parent = { postMessage: vi.fn() };
    const page = {
      parent, top: {}, location: { search: `?frame=${frame}&theme=day` },
      addEventListener: (t: string, h: (e: unknown) => void) => { const s = listeners.get(t) ?? new Set(); s.add(h); listeners.set(t, s); },
      removeEventListener: (t: string, h: (e: unknown) => void) => listeners.get(t)?.delete(h),
    };
    const r = startResponder({ parentOrigin: PARENT, page: page as unknown as Window, ext: reg });
    const ch = new MessageChannel();
    const got: Array<Record<string, unknown>> = [];
    ch.port1.onmessage = (m) => got.push(m.data);
    for (const h of listeners.get('message') ?? []) h({ origin: PARENT, source: page.parent, data: { type: 'cc.connect', nonce: parent.postMessage.mock.calls[0][0].nonce }, ports: [ch.port2] });
    const win = {
      FS: { analyzePath: () => ({ exists: false }), mkdirTree: () => {}, readdir: () => [], readFile: () => { throw new Error('ENOENT'); } },
      Module: { kicadOpenFileBusy: () => false, ...mod },
      wxElementRegistry: { findAll: () => [], findByLabel: () => [] },
      document: { querySelector: () => null, querySelectorAll: () => [] },
      dispatchEvent: () => true,
    } as unknown as ToolWindow;
    r.engineReady(win, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
    await settle();
    const ask = async (id: number, op: string, args?: unknown) => { ch.port1.postMessage({ id, op, args }); await settle(); return got.find((m) => m.id === id); };
    return { r, got, ask };
  }

  it('on engine run 14: no cap, and the op answers unsupported naming kicadSimUserSignals', async () => {
    const t = await boot('sch', { kicadSimRun: () => false });
    const ready = t.got.find((m) => m.type === 'ev.ready') as { caps: string[] };
    expect(ready.caps).not.toContain('simUserSignals');
    const a = await t.ask(1, 'sim.userSignals', { run: 1, signals: ['V(/out)-V(/in)'] });
    expect(a).toEqual({ id: 1, ok: false, error: { code: 'unsupported', message: 'kicadSimUserSignals' } });
    t.r.close();
  });

  it('on engine run 15 the cap is listed in a sch frame; a pcb frame refuses the op', async () => {
    const t = await boot('sch', { kicadSimUserSignals: () => false, kicadCollabBusy: () => false });
    expect((t.got.find((m) => m.type === 'ev.ready') as { caps: string[] }).caps).toContain('simUserSignals');
    t.r.close();
    const p = await boot('pcb', { kicadSimUserSignals: () => false, kicadCollabBusy: () => false });
    expect((p.got.find((m) => m.type === 'ev.ready') as { caps: string[] }).caps).not.toContain('simUserSignals');
    const a = await p.ask(1, 'sim.userSignals', { run: 1, signals: [] });
    expect(a).toEqual({ id: 1, ok: false, error: { code: 'unsupported', message: SIM_FRAME_ONLY } });
    p.r.close();
  });
});
