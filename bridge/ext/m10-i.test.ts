// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// m10-i: buses.migration.get and buses.migration.apply, the cap busMigration
// feature detected on the engine's kicadBusMigrationGet,
// kicadBusMigrationApply and kicadCollabBusy, the args and the engine's
// answers read closed, and the run folder under /tmp/cc-buses removed after
// every answer. The engine here is this test's own module of exports (at the
// protocol boundary); the real engine is the e2e's
// (tests/e2e/bus-migration.spec.ts, engine run 15).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startResponder } from '../responder';
import type { ExtUnit, ResponderCtx } from './contract';
import unit, {
  APPLY_EXPORTS, BUS_CAP, BUSES_MAX, BUSES_ROOT, GET_EXPORTS, LABEL_UNKNOWN, LABELS_MAX, parseApplyArgs, readApplyDone, readBus, readBuses,
} from './m10-i';
import { buildRegistry, REGISTRY } from './registry';

const PARENT = 'http://localhost';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));
const enc = (v: unknown): Uint8Array => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v));
const RUN15 = { kicadBusMigrationGet: () => '', kicadBusMigrationApply: () => false, kicadHostBusMigration: () => true, kicadCollabBusy: () => false };

const U = (n: number): string => `${n.toString(16).padStart(8, '0')}-a86e-57ec-8f79-7d7741049346`;
const DATA = { id: 0, sheetPath: '/', labels: [{ uuid: U(1), text: 'D[0..3]' }, { uuid: U(2), text: 'DATA[0..3]' }], proposals: ['D[3..0]', 'DATA[3..0]'] };
const ADDR = { id: 1, sheetPath: '/', labels: [{ uuid: U(3), text: 'A[0..1]' }, { uuid: U(4), text: 'ADDR[0..1]' }], proposals: ['A[1..0]', 'ADDR[1..0]'] };
const CHOICES = [{ labels: [U(1), U(2)], name: 'DATA[0..3]' }, { labels: [U(3), U(4)], name: 'ADDR[0..1]' }];

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

/**
 * A ResponderCtx over a fake engine in a sch frame and a fake MEMFS: the
 * folders the op makes and drops are recorded; `get` plays
 * kicadBusMigrationGet and `engine` kicadBusMigrationApply (its records
 * written into the run folder it is given).
 */
function fakeCtx(opts: {
  get?: () => unknown; engine?: (a: Record<string, unknown>, files: Map<string, Uint8Array>) => unknown; gate?: string;
} = {}) {
  const files = new Map<string, Uint8Array>();
  const made: string[] = [];
  const dropped: string[] = [];
  const calls: Array<Record<string, unknown>> = [];
  let n = 0;
  const mod: Record<string, unknown> = {
    ...RUN15,
    kicadBusMigrationGet: () => (opts.get ?? (() => JSON.stringify({ buses: [] })))(),
    kicadBusMigrationApply: (json: string) => { const a = JSON.parse(json) as Record<string, unknown>; calls.push(a); return (opts.engine ?? (() => false))(a, files); },
  };
  const ctx = {
    frame: 'sch',
    root: '/project',
    timing: { busesMs: 200, applyPollMs: 5 },
    mod: () => mod,
    closed: () => false,
    schematicGate: (_op: string, exports: readonly string[]) => {
      if (opts.gate != null) return { ok: false, code: 'busy', message: opts.gate };
      for (const name of exports) if (typeof mod[name] !== 'function') return { ok: false, code: 'unsupported', message: name };
      return { w: {}, mod };
    },
    freshRunFolder: (root: string) => { n += 1; const d = `${root}/${n}`; made.push(d); return d; },
    dropRunFolder: (dir: string) => { dropped.push(dir); for (const k of [...files.keys()]) if (k.startsWith(`${dir}/`)) files.delete(k); },
    readBytes: (abs: string) => files.get(abs) ?? null,
    queuedRun: async (op: string, dir: string, ms: number, call: () => unknown, record: () => unknown) => {
      if (call() !== true) return { ok: false, code: 'not_applied', message: op };
      const deadline = Date.now() + ms;
      for (;;) {
        const done = record();
        if (done != null) return { done };
        if (Date.now() >= deadline) return { ok: false, code: 'not_applied', message: op };
        await settle(5);
      }
    },
    log: () => {},
  } as unknown as ResponderCtx;
  return { ctx, files, made, dropped, calls };
}

/** An engine that applies as kicadBusMigrationApply does: buses.json, then the done record LAST. */
const applying = (depth: number) => (a: Record<string, unknown>, files: Map<string, Uint8Array>) => {
  const dir = a.dir as string;
  const choices = a.choices as Array<{ labels: string[] }>;
  const labels = choices.reduce((s, c) => s + c.labels.length, 0);
  files.set(`${dir}/buses.json`, enc({ run: a.run, applied: choices.length, labels, depth, lines: [] }));
  files.set(`${dir}/.cc-buses.json`, enc({ error: '', message: '', lines: [] }));
  return true;
};

const runGet = (ctx: ResponderCtx, args?: unknown) => unit.ops['buses.migration.get'].run(args, ctx);
const runApply = (ctx: ResponderCtx, args: unknown) => unit.ops['buses.migration.apply'].run(args, ctx);

describe('m10-i in the registry', () => {
  it('loads in this checkout with nothing broken, owning both ops and the cap busMigration', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect(REGISTRY.ops.get('buses.migration.get')?.unit).toBe('m10-i');
    expect(REGISTRY.ops.get('buses.migration.apply')?.unit).toBe('m10-i');
    expect(REGISTRY.pending.has('buses.migration.get')).toBe(false);
    expect(REGISTRY.pending.has('buses.migration.apply')).toBe(false);
    expect(REGISTRY.capNames.get(BUS_CAP)).toBe('m10-i');
    expect(BUS_CAP).toBe('busMigration');
    expect(unit.ops['buses.migration.get'].passesCheck).toBe(true);
    expect('passesCheck' in unit.ops['buses.migration.apply']).toBe(false);
  });

  it('lists busMigration in a sch frame on an engine with the read, the apply and kicadCollabBusy; nothing on run 14 or in another frame', () => {
    expect([...GET_EXPORTS]).toEqual(['kicadBusMigrationGet']);
    expect([...APPLY_EXPORTS]).toEqual(['kicadBusMigrationApply', 'kicadCollabBusy']);
    expect(unit.caps(RUN15, 'sch')).toEqual(['busMigration']);
    expect(unit.caps(RUN15, 'pcb')).toEqual([]);
    expect(unit.caps(RUN15, 'symedit')).toEqual([]);
    expect(unit.caps({ kicadBusMigrationGet: () => '', kicadCollabBusy: () => false }, 'sch')).toEqual([]);
    expect(unit.caps({ kicadCollabBusy: () => false }, 'sch')).toEqual([]);
  });

  it('run 14: the cap is not listed and both ops answer unsupported naming the export; bad args first', async () => {
    const s = await boot('sch', { kicadCollabBusy: () => false });
    expect(s.ready?.caps).not.toContain('busMigration');
    expect(await s.ask(1, 'buses.migration.get')).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'kicadBusMigrationGet' } });
    expect(await s.ask(2, 'buses.migration.apply', { choices: CHOICES })).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'kicadBusMigrationApply' } });
    expect(await s.ask(3, 'buses.migration.get', { all: true })).toMatchObject({ ok: false, error: { code: 'bad_args', message: 'buses.migration.get' } });
    expect(await s.ask(4, 'buses.migration.apply', { choices: [] })).toMatchObject({ ok: false, error: { code: 'bad_args', message: 'buses.migration.apply' } });
  });

  it('run 15: the cap listed, not_ready with no schematic open; a pcb frame refuses both ops', async () => {
    const sch = await boot('sch', RUN15);
    expect(sch.ready?.caps).toContain('busMigration');
    expect(await sch.ask(1, 'buses.migration.get')).toMatchObject({ ok: false, error: { code: 'not_ready', message: 'buses.migration.get' } });
    expect(await sch.ask(2, 'buses.migration.apply', { choices: CHOICES })).toMatchObject({ ok: false, error: { code: 'not_ready', message: 'buses.migration.apply' } });
    const pcb = await boot('pcb', RUN15);
    expect(pcb.ready?.caps ?? []).not.toContain('busMigration');
    expect(await pcb.ask(1, 'buses.migration.get')).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'a bus op runs in a sch frame' } });
    expect(await pcb.ask(2, 'buses.migration.apply', { choices: CHOICES })).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'a bus op runs in a sch frame' } });
  });
});

describe('the reads', () => {
  it('a bus is read closed: id, sheet path, 1 to 64 labels of uuid and text, the proposals as strings', () => {
    expect(readBus(DATA)).toEqual(DATA);
    expect(readBus({ ...DATA, proposals: [] })).toEqual({ ...DATA, proposals: [] });
    for (const bad of [
      null, [], { ...DATA, extra: 1 }, { ...DATA, id: -1 }, { ...DATA, id: 1.5 }, { ...DATA, sheetPath: 3 }, { ...DATA, labels: [] },
      { ...DATA, labels: Array.from({ length: LABELS_MAX + 1 }, (_, i) => ({ uuid: U(i), text: 'X' })) },
      { ...DATA, labels: [{ uuid: 'NOT-A-UUID', text: 'D' }] }, { ...DATA, labels: [{ uuid: U(1).toUpperCase(), text: 'D' }] },
      { ...DATA, labels: [{ uuid: U(1), text: 'D', more: 1 }] }, { ...DATA, labels: [{ uuid: U(1) }] }, { ...DATA, proposals: [1] },
      { ...DATA, proposals: 'D[3..0]' }, { id: 0, sheetPath: '/', labels: DATA.labels },
    ]) {
      expect(readBus(bad), JSON.stringify(bad)?.slice(0, 80)).toBeNull();
    }
  });
  it('the engine\'s answer is exactly { buses } of at most 1,024', () => {
    expect(readBuses(JSON.stringify({ buses: [DATA, ADDR] }))).toEqual([DATA, ADDR]);
    expect(readBuses('{"buses":[]}')).toEqual([]);
    expect(readBuses(JSON.stringify({ buses: Array.from({ length: BUSES_MAX + 1 }, () => DATA) }))).toBeNull();
    for (const bad of ['', 'nope', '[]', '{}', '{"buses":{}}', JSON.stringify({ buses: [DATA], more: 1 }), JSON.stringify({ buses: [{ ...DATA, id: 'x' }] })]) {
      expect(readBuses(bad), bad.slice(0, 60)).toBeNull();
    }
  });
});

describe('the apply args', () => {
  it('takes exactly { choices }: 1 to 1,024 of { labels (1 to 64 uuids, none twice), name (1 to 1,024 bytes, one line) }', () => {
    expect(parseApplyArgs({ choices: CHOICES })).toEqual(CHOICES);
    expect(parseApplyArgs({ choices: [{ labels: [U(1)], name: 'é'.repeat(512) }] })).not.toBeNull();
    for (const bad of [
      null, [], {}, { choices: [] }, { choices: CHOICES, more: 1 }, { choices: 'all' },
      { choices: Array.from({ length: BUSES_MAX + 1 }, (_, i) => ({ labels: [U(i)], name: 'X' })) },
      { choices: [{ labels: [U(1)], name: '' }] }, { choices: [{ labels: [U(1)], name: 'A\nB' }] }, { choices: [{ labels: [U(1)], name: 'A\rB' }] },
      { choices: [{ labels: [U(1)], name: 'A\0B' }] }, { choices: [{ labels: [U(1)], name: 'é'.repeat(513) }] }, { choices: [{ labels: [U(1)], name: 4 }] },
      { choices: [{ labels: [], name: 'X' }] }, { choices: [{ labels: Array.from({ length: LABELS_MAX + 1 }, (_, i) => U(i)), name: 'X' }] },
      { choices: [{ labels: ['label'], name: 'X' }] }, { choices: [{ labels: [U(1), U(1)], name: 'X' }] },
      { choices: [{ labels: [U(1)], name: 'X' }, { labels: [U(1)], name: 'Y' }] }, { choices: [{ labels: [U(1)], name: 'X', sheet: '/' }] },
    ]) {
      expect(parseApplyArgs(bad), JSON.stringify(bad)?.slice(0, 80)).toBeNull();
    }
  });
  it('the records are read closed, the done record last', () => {
    const report = enc({ run: 3, applied: 2, labels: 4, depth: 7, lines: [] });
    const done = enc({ error: '', message: '', lines: [] });
    expect(readApplyDone(null, report, 3)).toBeNull();
    expect(readApplyDone(done, report, 3)).toEqual({ report: { applied: 2, labels: 4, depth: 7 } });
    expect(readApplyDone(enc({ error: LABEL_UNKNOWN, message: U(9), lines: [] }), null, 3)).toEqual({ error: 'unknown' });
    expect(readApplyDone(done, null, 3)).toEqual({ error: 'bad' });
    expect(readApplyDone(done, report, 4)).toEqual({ error: 'bad' });
    expect(readApplyDone(done, enc({ run: 3, applied: 0, labels: 0, depth: 7, lines: [] }), 3)).toEqual({ error: 'bad' });
    expect(readApplyDone(done, enc({ run: 3, applied: 2, labels: 4, depth: 7 }), 3)).toEqual({ error: 'bad' });
    expect(readApplyDone(enc({ error: 'other', message: '', lines: [] }), report, 3)).toEqual({ error: 'bad' });
    expect(readApplyDone(enc({ error: '', message: '' }), report, 3)).toEqual({ error: 'bad' });
    expect(readApplyDone(enc('not json'), report, 3)).toEqual({ error: 'bad' });
  });
});

describe('buses.migration.get', () => {
  it('answers the engine\'s buses with their labels and KiCad\'s proposals', async () => {
    const { ctx } = fakeCtx({ get: () => JSON.stringify({ buses: [DATA, ADDR] }) });
    expect(await runGet(ctx)).toEqual({ ok: true, result: { buses: [DATA, ADDR] } });
    expect(await runGet(ctx, {})).toEqual({ ok: true, result: { buses: [DATA, ADDR] } });
  });
  it('an empty list when every bus has one name', async () => {
    const { ctx } = fakeCtx();
    expect(await runGet(ctx)).toEqual({ ok: true, result: { buses: [] } });
  });
  it('bad_args before the gate; the gate\'s refusal as it is; "" is not_ready; another shape or a throw is island_error', async () => {
    expect(await runGet(fakeCtx({ gate: 'buses.migration.get' }).ctx, { x: 1 })).toEqual({ ok: false, code: 'bad_args', message: 'buses.migration.get' });
    expect(await runGet(fakeCtx({ gate: 'buses.migration.get' }).ctx)).toEqual({ ok: false, code: 'busy', message: 'buses.migration.get' });
    expect(await runGet(fakeCtx({ get: () => '' }).ctx)).toEqual({ ok: false, code: 'not_ready', message: 'buses.migration.get' });
    expect(await runGet(fakeCtx({ get: () => '{"buses":[{}]}' }).ctx)).toMatchObject({ ok: false, code: 'island_error' });
    expect(await runGet(fakeCtx({ get: () => { throw new Error('boom'); } }).ctx)).toEqual({ ok: false, code: 'island_error', message: 'boom' });
  });
});

describe('buses.migration.apply', () => {
  it('queues the run with its number, its fresh folder and the choices; answers applied and labels; removes the folder', async () => {
    const f = fakeCtx({ engine: applying(5) });
    expect(await runApply(f.ctx, { choices: CHOICES })).toEqual({ ok: true, result: { applied: 2, labels: 4 } });
    expect(f.made).toEqual([`${BUSES_ROOT}/1`]);
    expect(f.calls).toEqual([{ run: 1, dir: `${BUSES_ROOT}/1`, choices: CHOICES }]);
    expect(f.dropped).toEqual([`${BUSES_ROOT}/1`]);
    expect(f.files.size).toBe(0);
  });
  it('a label the schematic does not hold answers bus_label_unknown; the folder removed', async () => {
    const f = fakeCtx({
      engine: (a, files) => { files.set(`${a.dir as string}/.cc-buses.json`, enc({ error: LABEL_UNKNOWN, message: U(9), lines: [] })); return true; },
    });
    expect(await runApply(f.ctx, { choices: CHOICES })).toEqual({ ok: false, code: 'bus_label_unknown', message: 'buses.migration.apply' });
    expect(f.dropped).toEqual(f.made);
  });
  it('bad_args and the gate before any folder; a refused run is not_applied; a throw or a record of another shape is island_error; the folder removed each time', async () => {
    const bad = fakeCtx({ engine: applying(1) });
    expect(await runApply(bad.ctx, { choices: [{ labels: [U(1)], name: 'A\nB' }] })).toEqual({ ok: false, code: 'bad_args', message: 'buses.migration.apply' });
    expect(bad.made).toEqual([]);
    const busy = fakeCtx({ engine: applying(1), gate: 'buses.migration.apply' });
    expect(await runApply(busy.ctx, { choices: CHOICES })).toEqual({ ok: false, code: 'busy', message: 'buses.migration.apply' });
    expect(busy.made).toEqual([]);
    const refused = fakeCtx({ engine: () => false });
    expect(await runApply(refused.ctx, { choices: CHOICES })).toEqual({ ok: false, code: 'not_applied', message: 'buses.migration.apply' });
    expect(refused.dropped).toEqual(refused.made);
    const thrown = fakeCtx({ engine: () => { throw new Error('boom'); } });
    expect(await runApply(thrown.ctx, { choices: CHOICES })).toEqual({ ok: false, code: 'island_error', message: 'boom' });
    expect(thrown.dropped).toEqual(thrown.made);
    const odd = fakeCtx({ engine: (a, files) => { files.set(`${a.dir as string}/.cc-buses.json`, enc({ error: '', message: '', lines: [] })); return true; } });
    expect(await runApply(odd.ctx, { choices: CHOICES })).toMatchObject({ ok: false, code: 'island_error' });
    expect(odd.dropped).toEqual(odd.made);
  });
  it('no record within the bound is not_applied', async () => {
    const f = fakeCtx({ engine: () => true });
    expect(await runApply(f.ctx, { choices: CHOICES })).toEqual({ ok: false, code: 'not_applied', message: 'buses.migration.apply' });
    expect(f.dropped).toEqual(f.made);
  });
});
