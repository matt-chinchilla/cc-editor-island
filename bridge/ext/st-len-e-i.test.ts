// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-len-e-i: board.nets, the cap netReport feature detected on the engine's
// kicadNetReport, the args and the engine's answer read closed. The engine
// here is this test's own module of exports (at the protocol boundary); the
// real engine is the e2e's (tests/e2e/st/st-len-e-i.spec.ts, engine run 15).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startResponder } from '../responder';
import type { ExtUnit, ResponderCtx } from './contract';
import unit, { NAME_MAX_BYTES, NAMES_MAX, NET_CAP, NET_EXPORTS, parseNetsArgs, readNetReport, readNetRow } from './st-len-e-i';
import { buildRegistry, REGISTRY } from './registry';

const PARENT = 'http://localhost';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));
const RUN15 = { kicadNetReport: () => '' };

const GND = {
  name: 'GND', netClass: 'Power', length: 254.473435, byLayer: [{ layer: 'F.Cu', length: 120.5 }, { layer: 'B.Cu', length: 133.973435 }],
  vias: 121, viaLength: 37.92, pads: 293, dieLength: 0, delay: null,
};
const SDA = { name: '/SDA', netClass: 'Default', length: 166.5, byLayer: [{ layer: 'F.Cu', length: 166.5 }], vias: 10, viaLength: 3.2, pads: 6, dieLength: 0.4, delay: 1023.5 };

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

function fakePage(search: string) {
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

/** A responder with this unit alone, booted in `frame` on an engine with `exports` and no document open. */
async function boot(frame: string, exports: Record<string, unknown>) {
  const reg = buildRegistry(mods(unit));
  expect(reg.problems).toEqual([]);
  const { page, parent } = fakePage(`?frame=${frame}&theme=day`);
  const r = startResponder({ parentOrigin: PARENT, page, ext: reg });
  const ch = new MessageChannel();
  const got: Array<Record<string, unknown>> = [];
  ch.port1.onmessage = (m) => got.push(m.data);
  page.dispatch('message', { origin: PARENT, source: page.parent, data: { type: 'cc.connect', nonce: parent.postMessage.mock.calls[0][0].nonce }, ports: [ch.port2] });
  const typeName = frame === 'pcb' ? 'PCB_EDIT_FRAME' : 'SCH_EDIT_FRAME';
  const win = {
    FS: { analyzePath: () => ({ exists: false }), mkdirTree: () => {}, readdir: () => [], readFile: () => { throw new Error('ENOENT'); } },
    Module: { kicadOpenFileBusy: () => false, ...exports },
    wxElementRegistry: { findAll: () => [{ id: 'frame', typeName, name: 'Frame', visible: true }], findByLabel: () => [] },
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
  return { ready: got.find((m) => m.type === 'ev.ready') as { caps: string[] } | undefined, ask };
}

/** A ResponderCtx over a fake engine in a pcb frame: `engine` plays kicadNetReport, its calls recorded. */
function fakeCtx(opts: { engine?: (json: string) => unknown; gate?: { code: string; message: string } } = {}) {
  const calls: string[] = [];
  const mod: Record<string, unknown> = {
    kicadNetReport: (json: string) => { calls.push(json); return (opts.engine ?? (() => JSON.stringify({ nets: [] })))(json); },
  };
  const ctx = {
    frame: 'pcb',
    mod: () => mod,
    boardGate: (_op: string, exports: readonly string[]) => {
      if (opts.gate != null) return { ok: false, ...opts.gate };
      for (const name of exports) if (typeof mod[name] !== 'function') return { ok: false, code: 'unsupported', message: name };
      return { w: {}, mod };
    },
  } as unknown as ResponderCtx;
  return { ctx, calls };
}
const run = (ctx: ResponderCtx, args?: unknown) => unit.ops['board.nets'].run(args, ctx);

describe('st-len-e-i in the registry', () => {
  it('loads in this checkout with nothing broken, owning board.nets and the cap netReport', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect(REGISTRY.ops.get('board.nets')?.unit).toBe('st-len-e-i');
    expect(REGISTRY.pending.has('board.nets')).toBe(false);
    expect(REGISTRY.capNames.get(NET_CAP)).toBe('st-len-e-i');
    expect(NET_CAP).toBe('netReport');
    expect(unit.ops['board.nets'].passesCheck).toBe(true);
  });

  it('lists netReport in a pcb frame on an engine with kicadNetReport; nothing on run 14 or in another frame', () => {
    expect([...NET_EXPORTS]).toEqual(['kicadNetReport']);
    expect(unit.caps(RUN15, 'pcb')).toEqual(['netReport']);
    expect(unit.caps(RUN15, 'sch')).toEqual([]);
    expect(unit.caps(RUN15, 'symedit')).toEqual([]);
    expect(unit.caps({}, 'pcb')).toEqual([]);
  });

  it('run 14: the cap is not listed and board.nets answers unsupported naming the export; bad args first', async () => {
    const s = await boot('pcb', {});
    expect(s.ready?.caps).not.toContain('netReport');
    expect(await s.ask(1, 'board.nets')).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'kicadNetReport' } });
    expect(await s.ask(2, 'board.nets', { nets: ['GND'] })).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'kicadNetReport' } });
    expect(await s.ask(3, 'board.nets', { all: true })).toMatchObject({ ok: false, error: { code: 'bad_args', message: 'board.nets' } });
    expect(await s.ask(4, 'board.nets', { nets: [] })).toMatchObject({ ok: false, error: { code: 'bad_args', message: 'board.nets' } });
  });

  it('run 15: the cap listed, not_ready with no board open; a sch frame refuses the op and lists no cap', async () => {
    const pcb = await boot('pcb', RUN15);
    expect(pcb.ready?.caps).toContain('netReport');
    expect(await pcb.ask(1, 'board.nets')).toMatchObject({ ok: false, error: { code: 'not_ready', message: 'board.nets' } });
    const sch = await boot('sch', RUN15);
    expect(sch.ready?.caps ?? []).not.toContain('netReport');
    expect(await sch.ask(1, 'board.nets')).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'a board op runs in a pcb frame' } });
  });
});

describe('the args', () => {
  it('none or {} asks every net; { nets } asks those names, closed', () => {
    expect(parseNetsArgs(undefined)).toBeNull();
    expect(parseNetsArgs({})).toBeNull();
    expect(parseNetsArgs({ nets: ['GND', '/SDA'] })).toEqual(['GND', '/SDA']);
    expect(parseNetsArgs({ nets: Array.from({ length: NAMES_MAX }, (_, i) => `N${i}`) })).toHaveLength(NAMES_MAX);
    expect(parseNetsArgs({ nets: ['x'.repeat(NAME_MAX_BYTES)] })).toEqual(['x'.repeat(NAME_MAX_BYTES)]);
    for (const bad of [
      null, 3, 'GND', [], ['GND'], { nets: [] }, { nets: 'GND' }, { nets: [''] }, { nets: [3] }, { nets: ['A\0B'] },
      { nets: ['x'.repeat(NAME_MAX_BYTES + 1)] }, { nets: ['é'.repeat(NAME_MAX_BYTES / 2 + 1)] },
      { nets: Array.from({ length: NAMES_MAX + 1 }, (_, i) => `N${i}`) }, { nets: ['GND'], all: true },
    ]) {
      expect(parseNetsArgs(bad), JSON.stringify(bad)?.slice(0, 60)).toBe('bad');
    }
  });
});

describe('the reads', () => {
  it('a row is read closed: names, lengths in mm, counts, the delay or null', () => {
    expect(readNetRow(GND)).toEqual(GND);
    expect(readNetRow(SDA)).toEqual(SDA);
    expect(readNetRow({ ...GND, byLayer: [] })).toEqual({ ...GND, byLayer: [] });
    expect(readNetRow({ ...GND, netClass: '' })).toEqual({ ...GND, netClass: '' });
    for (const bad of [
      null, [], { ...GND, extra: 1 }, { ...GND, name: '' }, { ...GND, name: 3 }, { ...GND, netClass: null }, { ...GND, length: -1 },
      { ...GND, length: Number.NaN }, { ...GND, length: '254' }, { ...GND, vias: 1.5 }, { ...GND, vias: -1 }, { ...GND, pads: '293' },
      { ...GND, viaLength: -0.1 }, { ...GND, dieLength: null }, { ...GND, delay: '12' }, { ...GND, delay: Number.POSITIVE_INFINITY },
      { ...GND, byLayer: {} }, { ...GND, byLayer: [{ layer: 'F.Cu' }] }, { ...GND, byLayer: [{ layer: '', length: 1 }] },
      { ...GND, byLayer: [{ layer: 'F.Cu', length: 1, more: 1 }] }, { ...GND, byLayer: [{ layer: 'F.Cu', length: -1 }] },
      Object.fromEntries(Object.entries(GND).filter(([k]) => k !== 'delay')),
    ]) {
      expect(readNetRow(bad), JSON.stringify(bad)?.slice(0, 80)).toBeNull();
    }
  });

  it('the answer is read closed: exactly { nets }, no net twice', () => {
    expect(readNetReport(JSON.stringify({ nets: [GND, SDA] }))).toEqual([GND, SDA]);
    expect(readNetReport(JSON.stringify({ nets: [] }))).toEqual([]);
    for (const bad of ['', 'not json', '[]', '{}', JSON.stringify({ nets: {} }), JSON.stringify({ nets: [GND], more: 1 }), JSON.stringify({ nets: [GND, GND] }), JSON.stringify({ nets: [{ ...GND, vias: -1 }] })]) {
      expect(readNetReport(bad), bad.slice(0, 60)).toBeNull();
    }
    expect(readNetReport(3)).toBeNull();
  });
});

describe('board.nets', () => {
  it('asks every net with {} and answers the rows as read', async () => {
    const f = fakeCtx({ engine: () => JSON.stringify({ nets: [GND, SDA] }) });
    expect(await run(f.ctx)).toEqual({ ok: true, result: { nets: [GND, SDA] } });
    expect(await run(f.ctx, {})).toEqual({ ok: true, result: { nets: [GND, SDA] } });
    expect(f.calls).toEqual(['{}', '{}']);
  });

  it('sends the names asked, and answers what the engine found (a name the board lacks left out)', async () => {
    const f = fakeCtx({ engine: () => JSON.stringify({ nets: [GND] }) });
    expect(await run(f.ctx, { nets: ['GND', 'NOT_A_NET'] })).toEqual({ ok: true, result: { nets: [GND] } });
    expect(f.calls.map((c) => JSON.parse(c))).toEqual([{ nets: ['GND', 'NOT_A_NET'] }]);
  });

  it('bad args before the gate; the gate refusal as it stands; nothing called then', async () => {
    const f = fakeCtx({ gate: { code: 'busy', message: 'board.nets' } });
    expect(await run(f.ctx, { nets: [] })).toEqual({ ok: false, code: 'bad_args', message: 'board.nets' });
    expect(await run(f.ctx)).toEqual({ ok: false, code: 'busy', message: 'board.nets' });
    expect(f.calls).toEqual([]);
  });

  it('an empty engine answer is busy; another shape or a throw is island_error', async () => {
    expect(await run(fakeCtx({ engine: () => '' }).ctx)).toEqual({ ok: false, code: 'busy', message: 'board.nets' });
    expect(await run(fakeCtx({ engine: () => JSON.stringify({ rows: [] }) }).ctx)).toEqual({ ok: false, code: 'island_error', message: 'the engine answered nets of another shape' });
    expect(await run(fakeCtx({ engine: () => 42 }).ctx)).toEqual({ ok: false, code: 'island_error', message: 'the engine answered nets of another shape' });
    expect(await run(fakeCtx({ engine: () => { throw new Error('boom'); } }).ctx)).toEqual({ ok: false, code: 'island_error', message: 'the engine could not read the nets' });
  });
});
