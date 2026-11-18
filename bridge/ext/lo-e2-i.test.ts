// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// lo-e2-i: the simulator's run guard as the responder runs it. ev.sim of a run
// that is not the live one never reaches the host, each run ends once, and
// sim.result answers only the asked run's own result. The engine here is this
// file's own stand-in with only what engineReady reads.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startResponder } from '../responder';
import { ok, type ExtUnit, type ResponderCtx } from './contract';
import { buildRegistry, REGISTRY } from './registry';
import unit from './lo-e2-i';
import { endIfWedged, STOP_WATCH, type SimService } from '../../src/sim-service';

const PARENT = 'http://localhost';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));

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

/** A responder with lo-e2-i and a test unit that hands over the ctx; `got` collects what the host hears. */
async function boot() {
  let ctxSeen: ResponderCtx | null = null;
  const probe: ExtUnit = { unit: 'probe-i', install: (ctx) => { ctxSeen = ctx; } };
  const reg = buildRegistry(mods(unit, probe));
  expect(reg.problems).toEqual([]);
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const parent = { postMessage: vi.fn() };
  const page = {
    parent, top: {}, location: { search: '?frame=sch&theme=day' },
    addEventListener: (t: string, h: (e: unknown) => void) => { const s = listeners.get(t) ?? new Set(); s.add(h); listeners.set(t, s); },
    removeEventListener: (t: string, h: (e: unknown) => void) => listeners.get(t)?.delete(h),
  };
  const dispatch = (t: string, e: unknown) => { for (const h of listeners.get(t) ?? []) h(e); };
  const r = startResponder({ parentOrigin: PARENT, page: page as unknown as Window, ext: reg });
  const ch = new MessageChannel();
  const got: Array<Record<string, unknown>> = [];
  ch.port1.onmessage = (m) => got.push(m.data);
  dispatch('message', { origin: PARENT, source: page.parent, data: { type: 'cc.connect', nonce: parent.postMessage.mock.calls[0][0].nonce }, ports: [ch.port2] });
  const win = {
    FS: { analyzePath: () => ({ exists: false }), mkdirTree: () => {}, readdir: () => [], readFile: () => { throw new Error('ENOENT'); } },
    Module: { kicadOpenFileBusy: () => false },
    wxElementRegistry: { findAll: () => [{ id: 'frame', typeName: 'SCH_EDIT_FRAME', name: 'SchematicFrame', visible: true }], findByLabel: () => [] },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    dispatchEvent: () => true,
  } as unknown as ToolWindow;
  r.engineReady(win, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
  await settle();
  const ask = async (id: number, op: string, args?: unknown) => {
    ch.port1.postMessage(args === undefined ? { id, op } : { id, op, args });
    await settle();
    return got.find((m) => m.id === id);
  };
  return { r, got, ask, ctx: ctxSeen as unknown as ResponderCtx, sims: () => got.filter((m) => m.type === 'ev.sim') };
}

describe('lo-e2-i in the registry', () => {
  it('loads from its own file with nothing broken: a guard on ev.sim and widenings of sim.result and sim.stop, all its own', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect(REGISTRY.units.map((u) => u.unit)).toContain('lo-e2-i');
    expect(REGISTRY.eventGuards.get('ev.sim')?.map((g) => g.unit)).toEqual(['lo-e2-i']);
    expect(REGISTRY.widen.get('sim.result')?.map((w) => w.unit)).toEqual(['lo-e2-i']);
    expect(REGISTRY.widen.get('sim.stop')?.map((w) => w.unit)).toEqual(['lo-e2-i']);
    // No op, cap, event or held row of its own: the simulator's ops and caps ship already.
    const own = unit as ExtUnit;
    expect(own.ops).toBeUndefined();
    expect(own.capNames).toBeUndefined();
    expect(own.events).toBeUndefined();
    expect(own.heldRows).toBeUndefined();
  });
});

describe('the run guard on ev.sim', () => {
  it('drops a progress notice of a run that is not live and a second end of a run, and keeps each run\'s own end', async () => {
    const t = await boot();
    expect(t.ctx.simRun()).toBeNull();
    t.ctx.emit({ type: 'ev.sim', run: 1, phase: 'running', percent: 10 });   // no run is live
    t.ctx.emit({ type: 'ev.sim', run: 1, phase: 'done' });
    t.ctx.emit({ type: 'ev.sim', run: 1, phase: 'stopped' });                 // a second end of run 1
    t.ctx.emit({ type: 'ev.sim', run: 2, phase: 'stopped' });
    t.ctx.emit({ type: 'ev.sim', run: 1, phase: 'done' });                    // a stray end of an older run
    t.ctx.emit({ type: 'ev.sim', run: 3, phase: 'failed', code: 'circuit' });
    await settle();
    expect(t.sims()).toEqual([
      { type: 'ev.sim', run: 1, phase: 'done' },
      { type: 'ev.sim', run: 2, phase: 'stopped' },
      { type: 'ev.sim', run: 3, phase: 'failed', code: 'circuit' },
    ]);
    t.r.close();
  });

  it('keeps one guard per frame: a second frame\'s runs start from nothing', async () => {
    const a = await boot();
    const b = await boot();
    a.ctx.emit({ type: 'ev.sim', run: 5, phase: 'done' });
    b.ctx.emit({ type: 'ev.sim', run: 1, phase: 'done' });
    await settle();
    expect(a.sims()).toEqual([{ type: 'ev.sim', run: 5, phase: 'done' }]);
    expect(b.sims()).toEqual([{ type: 'ev.sim', run: 1, phase: 'done' }]);
    a.r.close();
    b.r.close();
  });

  it('asks the responder for the live run at each notice', () => {
    const guard = unit.eventGuards['ev.sim'];
    let live: number | null = 7;
    const ctx = { simRun: () => live } as unknown as ResponderCtx;
    expect(guard({ type: 'ev.sim', run: 7, phase: 'running', percent: 6 }, ctx)).toBe(true);
    expect(guard({ type: 'ev.sim', run: 6, phase: 'done' }, ctx)).toBe(false);
    live = null;
    expect(guard({ type: 'ev.sim', run: 7, phase: 'stopped' }, ctx)).toBe(true);
    expect(guard({ type: 'ev.sim', run: 7, phase: 'running', percent: 7 }, ctx)).toBe(false);
  });
});

describe('the run guard on sim.result', () => {
  const hook = unit.opsWidened['sim.result'];
  const ctx = {} as ResponderCtx;
  it('passes the asked run\'s own result and every refusal as the op answered them', async () => {
    const own = ok({ run: 2, kind: 'tran', ended: 'done' });
    expect(await hook({ run: 2 }, ctx, async () => own)).toBe(own);
    const busy = { ok: false as const, code: 'busy', message: 'run 2 has not ended' };
    expect(await hook({ run: 2 }, ctx, async () => busy)).toBe(busy);
    const bad = { ok: false as const, code: 'bad_args', message: 'sim.result' };
    expect(await hook({ run: 'x' }, ctx, async () => bad)).toBe(bad);
  });
  it('answers no_simulation for a result of another run', async () => {
    expect(await hook({ run: 3 }, ctx, async () => ok({ run: 2, kind: 'tran' }))).toEqual({ ok: false, code: 'no_simulation', message: 'run 3' });
  });
  it('is the op the responder answers: a frame with no simulator still refuses as before', async () => {
    const t = await boot();
    expect(await t.ask(1, 'sim.result', { run: 1 })).toEqual({ id: 1, ok: false, error: { code: 'unsupported', message: 'kicadSimNetlist' } });
    t.r.close();
  });
});

describe('Stop\'s watch (SI1)', () => {
  const T = { graceMs: 5, probeMs: 10, maxMs: 2000 };
  /** A service whose `running` read answers `running` after `answerMs` (never when null). */
  const service = (answerMs: number | null, running = true) => {
    const s = {
      request: vi.fn(() => (answerMs == null ? new Promise<never>(() => {}) : new Promise((r) => setTimeout(() => r({ running }), answerMs)))),
      release: vi.fn(() => true),
      live: () => true,
      listen: () => () => {},
    };
    return s as unknown as SimService & { request: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
  };
  const stopped = (o: { live?: () => boolean; busy?: () => boolean } = {}) => {
    const r = { restops: 0, logs: [] as string[] };
    return Object.assign(r, {
      live: o.live ?? (() => true),
      engineBusy: o.busy ?? (() => false),
      restop: () => { r.restops += 1; },
      log: (m: string) => { r.logs.push(m); },
    });
  };

  it('ends a worker that does not answer while the stopped run is still live, and asks the engine to stop again', async () => {
    const s = service(null);
    const r = stopped({ busy: () => true });
    expect(await endIfWedged(s, r, T)).toBe('ended');
    expect(s.request).toHaveBeenCalledWith({ kind: 'running' });
    expect(s.release).toHaveBeenCalledTimes(1);
    expect(r.restops).toBe(1);
    expect(r.logs).toEqual(['[sim] the service did not answer within 10 ms of a Stop: its worker is ended']);
  });

  it('ends a worker whose ngspice runs nothing while the engine waits on no end, twice in a row', async () => {
    const s = service(1, false);
    const r = stopped();
    expect(await endIfWedged(s, r, T)).toBe('ended');
    expect(s.request).toHaveBeenCalledTimes(2);
    expect(s.release).toHaveBeenCalledTimes(1);
    expect(r.restops).toBe(1);
    expect(r.logs).toEqual(['[sim] ngspice runs nothing and the engine waits on no end: the worker is ended']);
  });

  it('leaves an idle ngspice alone while the engine works (its finish reads the results)', async () => {
    const s = service(1, false);
    let live = true;
    setTimeout(() => { live = false; }, 80);
    expect(await endIfWedged(s, stopped({ live: () => live, busy: () => true }), T)).toBe('over');
    expect(s.release).not.toHaveBeenCalled();
  });

  it('leaves a worker whose ngspice still runs to end the run itself, and stops watching when the run ends', async () => {
    const s = service(1);
    let live = true;
    setTimeout(() => { live = false; }, 60);
    const r = stopped({ live: () => live });
    expect(await endIfWedged(s, r, T)).toBe('over');
    expect(s.request.mock.calls.length).toBeGreaterThan(1);
    expect(s.release).not.toHaveBeenCalled();
    expect(r.restops).toBe(0);
  });

  it('asks nothing when the run ended before the first look', async () => {
    const s = service(null);
    expect(await endIfWedged(s, stopped({ live: () => false }), T)).toBe('over');
    expect(s.request).not.toHaveBeenCalled();
    expect(s.release).not.toHaveBeenCalled();
  });

  it('a worker that answers an error is no worker that answers', async () => {
    const s = service(null);
    s.request.mockImplementation(async () => ({ error: 'ngspice_service request failed' }));
    expect(await endIfWedged(s, stopped(), T)).toBe('ended');
    expect(s.release).toHaveBeenCalledTimes(1);
  });

  it('gives up after its bound when the run never ends but ngspice keeps running', async () => {
    const s = service(1);
    expect(await endIfWedged(s, stopped(), { graceMs: 5, probeMs: 10, maxMs: 30 })).toBe('answering');
    expect(s.release).not.toHaveBeenCalled();
  });

  it('looks within half a second of the Stop, so a wedged run ends well inside a second', () => {
    expect(STOP_WATCH.graceMs + STOP_WATCH.probeMs).toBeLessThanOrEqual(600);
  });

  it('sim.stop with no service installed answers as the op did, and watches nothing', async () => {
    const hook = unit.opsWidened['sim.stop'];
    const ctx = { simRun: () => 4, closed: () => false, log: () => {} } as unknown as ResponderCtx;
    expect(await hook({}, ctx, async () => ok())).toEqual(ok());
    const refusal = { ok: false as const, code: 'not_ready', message: 'sim.stop' };
    expect(await hook({}, ctx, async () => refusal)).toBe(refusal);
  });
});
