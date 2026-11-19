// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-mw-i: microwave.arm, the cap microwave feature detected on the engine's
// kicadMicrowaveArm, the args read closed with the engine's bounds. The engine
// here is this test's own module of exports (at the protocol boundary); the
// real engine is the e2e's (tests/e2e/st/st-mw-i.spec.ts, engine run 15).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startResponder } from '../responder';
import type { ExtUnit, ResponderCtx } from './contract';
import unit, { MICROWAVE_CAP, MICROWAVE_EXPORTS, POINTS_MAX, parseArm } from './st-mw-i';
import { buildRegistry, REGISTRY } from './registry';

const PARENT = 'http://localhost';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));
const RUN15 = { kicadMicrowaveArm: () => true };
const SHAPE = { points: [[0, 0], [0.25, 0.5], [0.5, 0.7], [0.75, 0.5], [1, 0]], kind: 'symmetrical', size: [4, 2] };

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

/** A ResponderCtx over a fake engine in a pcb frame: `engine` plays kicadMicrowaveArm, its calls recorded. */
function fakeCtx(opts: { engine?: (json: string) => unknown; gate?: { code: string; message: string } } = {}) {
  const calls: string[] = [];
  const mod: Record<string, unknown> = {
    kicadMicrowaveArm: (json: string) => { calls.push(json); return (opts.engine ?? (() => true))(json); },
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
const run = (ctx: ResponderCtx, args?: unknown) => unit.ops['microwave.arm'].run(args, ctx);

describe('st-mw-i in the registry', () => {
  it('loads in this checkout with nothing broken, owning microwave.arm and the cap microwave', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect(REGISTRY.ops.get('microwave.arm')?.unit).toBe('st-mw-i');
    expect(REGISTRY.pending.has('microwave.arm')).toBe(false);
    expect(REGISTRY.capNames.get(MICROWAVE_CAP)).toBe('st-mw-i');
    expect(MICROWAVE_CAP).toBe('microwave');
    expect('passesCheck' in unit.ops['microwave.arm']).toBe(false);
  });

  it('lists microwave in a pcb frame on an engine with kicadMicrowaveArm; nothing on run 14 or in another frame', () => {
    expect([...MICROWAVE_EXPORTS]).toEqual(['kicadMicrowaveArm']);
    expect(unit.caps(RUN15, 'pcb')).toEqual(['microwave']);
    expect(unit.caps(RUN15, 'sch')).toEqual([]);
    expect(unit.caps(RUN15, 'symedit')).toEqual([]);
    expect(unit.caps({}, 'pcb')).toEqual([]);
  });

  it('run 14: the cap is not listed and microwave.arm answers unsupported naming the export; bad args first', async () => {
    const s = await boot('pcb', {});
    expect(s.ready?.caps).not.toContain('microwave');
    expect(await s.ask(1, 'microwave.arm', { shape: 'stub', value: 5 })).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'kicadMicrowaveArm' } });
    expect(await s.ask(2, 'microwave.arm', { shape: 'polygon', polygon: SHAPE })).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'kicadMicrowaveArm' } });
    expect(await s.ask(3, 'microwave.arm', { shape: 'stub', value: 0 })).toMatchObject({ ok: false, error: { code: 'bad_args', message: 'microwave.arm' } });
    expect(await s.ask(4, 'microwave.arm')).toMatchObject({ ok: false, error: { code: 'bad_args', message: 'microwave.arm' } });
  });

  it('run 15: the cap listed, not_ready with no board open; a sch frame refuses the op and lists no cap', async () => {
    const pcb = await boot('pcb', RUN15);
    expect(pcb.ready?.caps).toContain('microwave');
    expect(await pcb.ask(1, 'microwave.arm', { shape: 'stub', value: 5 })).toMatchObject({ ok: false, error: { code: 'not_ready', message: 'microwave.arm' } });
    const sch = await boot('sch', RUN15);
    expect(sch.ready?.caps ?? []).not.toContain('microwave');
    expect(await sch.ask(1, 'microwave.arm', { shape: 'stub', value: 5 })).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'a board op runs in a pcb frame' } });
  });
});

describe('the args', () => {
  it('line, gap and stub take exactly { shape, value }, 0 < value <= 500 mm', () => {
    for (const shape of ['line', 'gap', 'stub'] as const) {
      expect(parseArm({ shape, value: 5 })).toEqual({ shape, value: 5 });
      expect(parseArm({ shape, value: 500 })).toEqual({ shape, value: 500 });
      expect(parseArm({ shape, value: 0.001 })).toEqual({ shape, value: 0.001 });
      for (const bad of [{ shape }, { shape, value: 0 }, { shape, value: -1 }, { shape, value: 501 }, { shape, value: '5' }, { shape, value: Number.NaN }, { shape, value: Number.POSITIVE_INFINITY }, { shape, value: 1, angle: 5 }, { shape, value: 1, extra: true }]) {
        expect(parseArm(bad), JSON.stringify(bad)).toBeNull();
      }
    }
  });

  it('arcStub takes { shape, value, angle? }, the angle 0 to 180 degrees', () => {
    expect(parseArm({ shape: 'arcStub', value: 3 })).toEqual({ shape: 'arcStub', value: 3 });
    expect(parseArm({ shape: 'arcStub', value: 3, angle: 60 })).toEqual({ shape: 'arcStub', value: 3, angle: 60 });
    expect(parseArm({ shape: 'arcStub', value: 3, angle: 0 })).toEqual({ shape: 'arcStub', value: 3, angle: 0 });
    expect(parseArm({ shape: 'arcStub', value: 3, angle: 180 })).toEqual({ shape: 'arcStub', value: 3, angle: 180 });
    for (const bad of [{ shape: 'arcStub', value: 3, angle: 190 }, { shape: 'arcStub', value: 3, angle: -1 }, { shape: 'arcStub', value: 3, angle: '60' }, { shape: 'arcStub', value: 3, angle: undefined }, { shape: 'arcStub', value: 0, angle: 60 }, { shape: 'arcStub', angle: 60 }, { shape: 'arcStub', value: 3, angle: 60, more: 1 }]) {
      expect(parseArm(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('polygon takes { shape, polygon: { points, kind, size } }: fractions, a kind, a size in mm, the extents bounded', () => {
    expect(parseArm({ shape: 'polygon', polygon: SHAPE })).toEqual({ shape: 'polygon', polygon: SHAPE });
    for (const kind of ['plain', 'symmetrical', 'mirrored']) expect(parseArm({ shape: 'polygon', polygon: { ...SHAPE, kind } })).not.toBeNull();
    expect(parseArm({ shape: 'polygon', polygon: { ...SHAPE, points: [[0, 0], [1, 1]] } })).not.toBeNull();
    expect(parseArm({ shape: 'polygon', polygon: { ...SHAPE, size: [-4, 2] } })).not.toBeNull();
    expect(parseArm({ shape: 'polygon', polygon: { ...SHAPE, size: [500, 500], points: [[2, 2], [-2, 0]] } })).not.toBeNull();
    const many = Array.from({ length: POINTS_MAX }, (_, i) => [i / POINTS_MAX, 0]);
    expect(parseArm({ shape: 'polygon', polygon: { ...SHAPE, points: many } })).not.toBeNull();
    for (const bad of [
      { shape: 'polygon' }, { shape: 'polygon', polygon: null }, { shape: 'polygon', polygon: SHAPE, value: 1 },
      { shape: 'polygon', polygon: { ...SHAPE, points: [[0, 0]] } },
      { shape: 'polygon', polygon: { ...SHAPE, points: [...many, [1, 0]] } },
      { shape: 'polygon', polygon: { ...SHAPE, points: [[0, 0], [1]] } },
      { shape: 'polygon', polygon: { ...SHAPE, points: [[0, 0], [1, 0, 2]] } },
      { shape: 'polygon', polygon: { ...SHAPE, points: [[0, 0], ['1', 0]] } },
      { shape: 'polygon', polygon: { ...SHAPE, points: [[0, 0], { x: 1, y: 0 }] } },
      { shape: 'polygon', polygon: { ...SHAPE, kind: 'normal' } },
      { shape: 'polygon', polygon: { ...SHAPE, size: [0, 2] } },
      { shape: 'polygon', polygon: { ...SHAPE, size: [4, 501] } },
      { shape: 'polygon', polygon: { ...SHAPE, size: [4] } },
      { shape: 'polygon', polygon: { ...SHAPE, size: [500, 2], points: [[0, 0], [2.5, 0]] } },
      { shape: 'polygon', polygon: { ...SHAPE, more: 1 } },
      { shape: 'polygon', polygon: { points: SHAPE.points, kind: SHAPE.kind } },
    ]) {
      expect(parseArm(bad), JSON.stringify(bad).slice(0, 80)).toBeNull();
    }
  });

  it('anything else is refused', () => {
    for (const bad of [undefined, null, 3, 'stub', [], {}, { shape: 'tee', value: 1 }, { value: 5 }, { shape: 'Stub', value: 5 }]) {
      expect(parseArm(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('microwave.arm', () => {
  it('sends the arm read closed and answers {} when the engine arms', async () => {
    const f = fakeCtx();
    expect(await run(f.ctx, { shape: 'stub', value: 5 })).toEqual({ ok: true, result: {} });
    expect(await run(f.ctx, { shape: 'arcStub', value: 3, angle: 60 })).toEqual({ ok: true, result: {} });
    expect(await run(f.ctx, { shape: 'polygon', polygon: SHAPE })).toEqual({ ok: true, result: {} });
    expect(f.calls.map((c) => JSON.parse(c))).toEqual([{ shape: 'stub', value: 5 }, { shape: 'arcStub', value: 3, angle: 60 }, { shape: 'polygon', polygon: SHAPE }]);
  });

  it('bad args before the gate; the gate refusal as it stands; nothing called then', async () => {
    const f = fakeCtx({ gate: { code: 'busy', message: 'microwave.arm' } });
    expect(await run(f.ctx, { shape: 'stub', value: 501 })).toEqual({ ok: false, code: 'bad_args', message: 'microwave.arm' });
    expect(await run(f.ctx, { shape: 'stub', value: 5 })).toEqual({ ok: false, code: 'busy', message: 'microwave.arm' });
    expect(f.calls).toEqual([]);
  });

  it('an engine that cannot arm now is busy; another answer or a throw is island_error', async () => {
    expect(await run(fakeCtx({ engine: () => false }).ctx, { shape: 'gap', value: 0.5 })).toEqual({ ok: false, code: 'busy', message: 'microwave.arm' });
    expect(await run(fakeCtx({ engine: () => 1 }).ctx, { shape: 'gap', value: 0.5 })).toEqual({ ok: false, code: 'island_error', message: 'the engine answered the arm with another shape' });
    expect(await run(fakeCtx({ engine: () => { throw new Error('boom'); } }).ctx, { shape: 'gap', value: 0.5 })).toEqual({ ok: false, code: 'island_error', message: 'the engine could not arm the microwave tool' });
  });
});
