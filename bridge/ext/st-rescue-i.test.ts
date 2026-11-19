// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-rescue-i: sch.rescue, its cap rescue feature detected on the engine's
// kicadSchRescue, kicadSchRescueApply and kicadCollabBusy, the args and the
// engine's answers read closed, the apply's run folder under /tmp/cc-rescue
// removed after every answer, the two written files sent as ev.saved, and the
// held Rescue Symbols and Remap Legacy Library Symbols. The engine here is
// this test's own module of exports (at the protocol boundary); the real
// engine is the e2e's (tests/e2e/st/st-rescue-i.spec.ts, engine run 15).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HELD_ACTIONS, heldTaken } from '../held';
import { startResponder } from '../responder';
import type { ExtUnit, ResponderCtx } from './contract';
import { buildRegistry, heldActions, REGISTRY } from './registry';
import unit, {
  NAMES_MAX, parseRescueArgs, readCandidates, readRescueDone, REMAP_SYMBOLS, RESCUE_CAP, RESCUE_EXPORTS, RESCUE_ROOT, RESCUE_ROWS, RESCUE_SYMBOLS,
  rescueLine, savedPaths, UNWRITTEN,
} from './st-rescue-i';

const PARENT = 'http://localhost';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));
const enc = (v: unknown): Uint8Array => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v));
const RUN15 = { kicadSchRescue: async () => '', kicadSchRescueApply: () => false, kicadCollabBusy: () => false };

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
  const win = {
    FS: { analyzePath: () => ({ exists: false }), mkdirTree: () => {}, readdir: () => [], readFile: () => { throw new Error('ENOENT'); } },
    Module: { kicadOpenFileBusy: () => false, ...exports },
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
  return { ready: got.find((m) => m.type === 'ev.ready') as { caps: string[] } | undefined, ask };
}

const ROOT = '/project';
const SYM = `${ROOT}/glasgow-rescue.kicad_sym`;
const TABLE = `${ROOT}/sym-lib-table`;
const CANDIDATES = [{ name: 'R', libId: 'MyParts:R', uses: 12, rescuedAs: 'glasgow-rescue:R-MyParts' }];
const LINES = [{ severity: 'info', text: 'Rescue symbol R found only in cache library to R-MyParts.' }];

/**
 * A ResponderCtx over a fake schematic engine and a fake MEMFS: the folders
 * the op makes and drops are recorded, the events it sends are kept,
 * `engine` plays kicadSchRescueApply (its records written into the run folder
 * it is given, the files it writes into the project folder).
 */
function fakeCtx(engine: (a: Record<string, unknown>, files: Map<string, Uint8Array>) => unknown, opts: { idle?: () => boolean; gate?: string; read?: () => unknown } = {}) {
  const files = new Map<string, Uint8Array>();
  const made: string[] = [];
  const dropped: string[] = [];
  const calls: Array<Record<string, unknown>> = [];
  const reads: string[] = [];
  const events: Array<Record<string, unknown>> = [];
  let n = 0;
  const mod: Record<string, unknown> = {
    ...RUN15,
    kicadSchRescue: (j: string) => { reads.push(j); return opts.read != null ? opts.read() : Promise.resolve(JSON.stringify({ candidates: CANDIDATES })); },
    kicadSchRescueApply: (j: string) => { const a = JSON.parse(j) as Record<string, unknown>; calls.push(a); return engine(a, files); },
  };
  const ctx = {
    frame: 'sch',
    root: ROOT,
    timing: { rescueMs: 200, applyPollMs: 5 },
    mod: () => mod,
    fs: () => ({ writeFile: (p: string, b: Uint8Array) => { files.set(p, b); } }),
    closed: () => false,
    schematicGate: (_op: string, exports: readonly string[]) => {
      if (opts.gate != null) return { ok: false, code: 'busy', message: opts.gate };
      for (const name of exports) if (typeof mod[name] !== 'function') return { ok: false, code: 'unsupported', message: name };
      return { w: {}, mod };
    },
    withTimeout: async <T>(v: T | Promise<T>, ms: number) => Promise.race([Promise.resolve(v), new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))]),
    freshRunFolder: (root: string) => { n += 1; const d = `${root}/${n}`; made.push(d); return d; },
    dropRunFolder: (dir: string) => { dropped.push(dir); for (const k of [...files.keys()]) if (k.startsWith(`${dir}/`)) files.delete(k); },
    readBytes: (abs: string) => files.get(abs) ?? null,
    emit: (ev: Record<string, unknown>) => { events.push(ev); },
    queuedRun: async (op: string, dir: string, ms: number, call: () => unknown, record: () => unknown) => {
      if (call() !== true) { dropped.push(dir); return { ok: false, code: 'not_applied', message: op }; }
      const deadline = Date.now() + ms;
      for (;;) {
        if ((opts.idle ?? (() => true))()) { const done = record(); if (done != null) return { done }; }
        if (Date.now() >= deadline) { dropped.push(dir); return { ok: false, code: 'not_applied', message: op }; }
        await settle(5);
      }
    },
    log: () => {},
  } as unknown as ResponderCtx;
  return { ctx, files, made, dropped, calls, reads, events };
}

const report = (run: unknown, r: Record<string, unknown> = {}) => ({ run, rescued: 1, symbols: 12, files: [SYM, TABLE], depth: 4, lines: LINES, ...r });

/** An engine that answers as kicadSchRescueApply does: the two files, the report, then the done record LAST. */
const goodEngine = (a: Record<string, unknown>, files: Map<string, Uint8Array>) => {
  const dir = a.dir as string;
  files.set(SYM, enc('(kicad_symbol_lib (symbol "R-MyParts"))'));
  files.set(TABLE, enc('(sym_lib_table (lib (name "glasgow-rescue")))'));
  files.set(`${dir}/rescue.json`, enc(report(a.run)));
  files.set(`${dir}/.cc-rescue.json`, enc({ error: '', message: '', lines: LINES }));
  return true;
};

describe('st-rescue-i in the registry', () => {
  it('loads in this checkout with nothing broken, owning sch.rescue and the cap rescue', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect(REGISTRY.ops.get('sch.rescue')?.unit).toBe('st-rescue-i');
    expect(REGISTRY.pending.has('sch.rescue')).toBe(false);
    expect(REGISTRY.capNames.get(RESCUE_CAP)).toBe('st-rescue-i');
    expect(RESCUE_CAP).toBe('rescue');
  });

  it('lists rescue in a sch frame on an engine with all three exports, nothing on run 14 or in a pcb frame', () => {
    expect([...RESCUE_EXPORTS]).toEqual(['kicadSchRescue', 'kicadSchRescueApply', 'kicadCollabBusy']);
    expect(unit.caps(RUN15, 'sch')).toEqual(['rescue']);
    expect(unit.caps(RUN15, 'pcb')).toEqual([]);
    expect(unit.caps(RUN15, 'symedit')).toEqual([]);
    expect(unit.caps({ kicadSchRescue: () => '', kicadCollabBusy: () => false }, 'sch')).toEqual([]);
    expect(unit.caps({}, 'sch')).toEqual([]);
  });

  it('a sch frame on run 14 lists no rescue cap and answers sch.rescue unsupported naming the export; bad args first', async () => {
    const s = await boot('sch', { kicadCollabBusy: () => false });
    expect(s.ready?.caps).not.toContain('rescue');
    expect(await s.ask(1, 'sch.rescue', { preview: true })).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'kicadSchRescue' } });
    expect(await s.ask(2, 'sch.rescue', { preview: false })).toMatchObject({ ok: false, error: { code: 'bad_args', message: 'sch.rescue' } });
  });

  it('a sch frame on run 15 lists rescue and answers not_ready with no schematic open; a pcb frame lists none and refuses the op', async () => {
    const sch = await boot('sch', RUN15);
    expect(sch.ready?.caps).toContain('rescue');
    expect(await sch.ask(1, 'sch.rescue', { preview: true })).toMatchObject({ ok: false, error: { code: 'not_ready', message: 'sch.rescue' } });
    const pcb = await boot('pcb', RUN15);
    expect(pcb.ready?.caps).not.toContain('rescue');
    expect(await pcb.ask(1, 'sch.rescue', { preview: true })).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'a rescue runs in a sch frame' } });
  });
});

describe('the held Rescue Symbols and Remap Legacy Library Symbols', () => {
  const union = heldActions(buildRegistry(mods(unit)));
  it('holds exactly the two, in a sch frame under the cap rescue, no built in row holding either', () => {
    expect(unit.held).toEqual([RESCUE_SYMBOLS, REMAP_SYMBOLS]);
    expect(RESCUE_SYMBOLS).toBe('eeschema.EditorControl.rescueSymbols');
    expect(REMAP_SYMBOLS).toBe('eeschema.EditorControl.remapSymbols');
    expect(unit.heldRows.map((r) => ({ ...r, frames: [...r.frames] }))).toEqual([
      { action: RESCUE_SYMBOLS, frames: ['sch'], cap: 'rescue' },
      { action: REMAP_SYMBOLS, frames: ['sch'], cap: 'rescue' },
    ]);
    for (const r of RESCUE_ROWS) {
      expect(HELD_ACTIONS.some((h) => h.action === r.action)).toBe(false);
      expect(heldActions()).toContainEqual(r);
    }
  });
  it('the responder takes them only in a sch frame whose ev.ready listed rescue', () => {
    for (const a of [RESCUE_SYMBOLS, REMAP_SYMBOLS]) {
      expect(heldTaken(a, 'sch', ['rescue'], union)).toBe(true);
      expect(heldTaken(a, 'sch', ['heldKeys'], union)).toBe(false);
      expect(heldTaken(a, 'pcb', ['rescue'], union)).toBe(false);
    }
  });
});

describe('the args', () => {
  it('takes exactly { preview: true } or { names } of 1 to 4,096 names of 1 to 1,024 bytes', () => {
    expect(parseRescueArgs({ preview: true })).toEqual({ preview: true });
    expect(parseRescueArgs({ names: ['MyParts:R'] })).toEqual({ names: ['MyParts:R'] });
    expect(parseRescueArgs({ names: ['R', 'MyParts:C'] })).toEqual({ names: ['R', 'MyParts:C'] });
    expect(parseRescueArgs({ names: Array.from({ length: NAMES_MAX }, (_, i) => `L:${i}`) })).not.toBeNull();
    expect(parseRescueArgs({ names: ['x'.repeat(1024)] })).not.toBeNull();
    for (const bad of [
      {}, null, [], 'x', { preview: false }, { preview: 1 }, { preview: true, names: ['R'] }, { preview: true, x: 1 },
      { names: [] }, { names: 'R' }, { names: [''] }, { names: [1] }, { names: ['a\nb'] }, { names: ['a\0'] }, { names: ['R'], x: 1 },
      { names: ['x'.repeat(1025)] }, { names: ['é'.repeat(513)] }, { names: Array.from({ length: NAMES_MAX + 1 }, (_, i) => `L:${i}`) },
    ]) {
      expect(parseRescueArgs(bad), JSON.stringify(bad)?.slice(0, 60)).toBeNull();
    }
  });
});

describe('the engine\'s answers read closed', () => {
  it('the candidates: exactly { candidates } of { name, libId, uses, rescuedAs }, at most 4,096', () => {
    expect(readCandidates(JSON.stringify({ candidates: CANDIDATES }))).toEqual(CANDIDATES);
    expect(readCandidates(JSON.stringify({ candidates: [] }))).toEqual([]);
    for (const bad of [
      '', '{', 'null', JSON.stringify({}), JSON.stringify({ candidates: CANDIDATES, x: 1 }), JSON.stringify({ candidates: [{ ...CANDIDATES[0], x: 1 }] }),
      JSON.stringify({ candidates: [{ ...CANDIDATES[0], uses: -1 }] }), JSON.stringify({ candidates: [{ ...CANDIDATES[0], uses: 1.5 }] }),
      JSON.stringify({ candidates: [{ ...CANDIDATES[0], name: '' }] }), JSON.stringify({ candidates: [{ ...CANDIDATES[0], libId: 3 }] }),
      JSON.stringify({ candidates: Array.from({ length: NAMES_MAX + 1 }, () => CANDIDATES[0]) }),
    ]) {
      expect(readCandidates(bad), bad.slice(0, 60)).toBeNull();
    }
    expect(readCandidates(42)).toBeNull();
  });

  const R = 3;
  const done = enc({ error: '', message: '', lines: [] });
  it('waits (null) until the done record is there', () => {
    expect(readRescueDone(null, null, R)).toBeNull();
    expect(readRescueDone(null, enc(report(R)), R)).toBeNull();
  });
  it('an apply: rescued, symbols, depth and the files written', () => {
    expect(readRescueDone(done, enc(report(R)), R)).toEqual({ report: { rescued: 1, symbols: 12, depth: 4, files: [SYM, TABLE] } });
  });
  it('rescue_unknown and rescue_failed', () => {
    expect(readRescueDone(enc({ error: 'rescue_unknown', message: 'Nope:X', lines: [] }), null, R)).toEqual({ error: 'rescue_unknown' });
    expect(readRescueDone(enc({ error: 'rescue_failed', message: 'Cannot write x', lines: [] }), null, R)).toEqual({ error: 'rescue_failed', message: 'Cannot write x' });
  });
  it('any other shape is a bad record', () => {
    for (const [d, rep] of [
      [enc('{'), enc(report(R))], [enc({ error: 'other', message: '', lines: [] }), null], [enc({ error: '', lines: [] }), enc(report(R))],
      [done, null], [done, enc('{')], [done, enc(report(R + 1))], [done, enc(report(R, { extra: 1 }))], [done, enc(report(R, { rescued: -1 }))],
      [done, enc(report(R, { depth: 'x' }))], [done, enc(report(R, { files: ['relative'] }))], [done, enc(report(R, { files: [SYM, TABLE, SYM] }))],
      [done, enc(report(R, { lines: 'x' }))],
    ] as Array<[Uint8Array, Uint8Array | null]>) {
      expect(readRescueDone(d, rep, R)).toEqual({ error: 'bad' });
    }
  });
  it('the saved paths: inside the project folder only, once each', () => {
    expect(savedPaths([SYM, TABLE], ROOT)).toEqual(['glasgow-rescue.kicad_sym', 'sym-lib-table']);
    expect(savedPaths(['/elsewhere/x.kicad_sym', `${ROOT}/../x`, `${ROOT}/a/./b`, `${ROOT}/`, TABLE, TABLE], ROOT)).toEqual(['sym-lib-table']);
  });
  it('KiCad\'s line: the first line, no run folder, at most 1,024 characters, ours when empty', () => {
    expect(rescueLine('Cannot write /tmp/cc-rescue/7/x\nmore')).toBe('Cannot write x');
    expect(rescueLine('')).toBe(UNWRITTEN);
    expect([...rescueLine('x'.repeat(5000))]).toHaveLength(1024);
  });
});

describe('sch.rescue on an engine with the exports', () => {
  const run = unit.ops['sch.rescue'].run;

  it('a preview answers the candidates with nothing queued, no folder made, no event', async () => {
    const f = fakeCtx(goodEngine);
    expect(await run({ preview: true }, f.ctx)).toEqual({ ok: true, result: { candidates: CANDIDATES } });
    expect(f.reads).toEqual(['{}']);
    expect(f.calls).toEqual([]);
    expect(f.made).toEqual([]);
    expect(f.events).toEqual([]);
  });

  it('a preview the engine answers empty or of another shape is island_error; past its bound not_applied; a throw island_error', async () => {
    expect(await run({ preview: true }, fakeCtx(goodEngine, { read: () => Promise.resolve('') }).ctx)).toEqual({ ok: false, code: 'island_error', message: 'the engine answered rescue candidates of another shape' });
    expect(await run({ preview: true }, fakeCtx(goodEngine, { read: () => new Promise(() => {}) }).ctx)).toEqual({ ok: false, code: 'not_applied', message: 'sch.rescue' });
    expect(await run({ preview: true }, fakeCtx(goodEngine, { read: () => Promise.reject(new Error('boom')) }).ctx)).toEqual({ ok: false, code: 'island_error', message: 'boom' });
  });

  it('an apply runs in a fresh /tmp/cc-rescue/<n>, sends both files as ev.saved before the answer, answers the counts, removes the folder', async () => {
    const f = fakeCtx(goodEngine);
    expect(await run({ names: ['MyParts:R'] }, f.ctx)).toEqual({ ok: true, result: { rescued: 1, symbols: 12, depth: 4, saved: ['glasgow-rescue.kicad_sym', 'sym-lib-table'] } });
    expect(f.made).toEqual([`${RESCUE_ROOT}/1`]);
    expect(f.calls).toEqual([{ run: 1, dir: `${RESCUE_ROOT}/1`, names: ['MyParts:R'] }]);
    expect(f.events.map((e) => [e.type, e.path])).toEqual([['ev.saved', 'glasgow-rescue.kicad_sym'], ['ev.saved', 'sym-lib-table']]);
    expect(new TextDecoder().decode(f.events[0].bytes as Uint8Array)).toContain('R-MyParts');
    expect(f.dropped).toContain(`${RESCUE_ROOT}/1`);
    expect([...f.files.keys()].filter((k) => k.startsWith(RESCUE_ROOT))).toEqual([]);
  });

  it('a name no candidate matches is not_found with nothing sent; a failed write is island_error with KiCad\'s line; folders gone', async () => {
    const unknown = fakeCtx((a, files) => { files.set(`${a.dir as string}/.cc-rescue.json`, enc({ error: 'rescue_unknown', message: 'Nope:X', lines: [] })); return true; });
    expect(await run({ names: ['Nope:X'] }, unknown.ctx)).toEqual({ ok: false, code: 'not_found', message: 'a name matches no rescue candidate' });
    expect(unknown.events).toEqual([]);
    const failed = fakeCtx((a, files) => { files.set(`${a.dir as string}/.cc-rescue.json`, enc({ error: 'rescue_failed', message: `Error writing ${a.dir as string}/x.kicad_sym\nmore`, lines: [] })); return true; });
    const got = await run({ names: ['MyParts:R'] }, failed.ctx);
    expect(got).toEqual({ ok: false, code: 'island_error', message: 'Error writing x.kicad_sym' });
    expect(JSON.stringify(got)).not.toContain('/tmp');
    for (const f of [unknown, failed]) {
      expect(f.dropped).toEqual(expect.arrayContaining(f.made));
      expect(f.files.size).toBe(0);
    }
  });

  it('a record of another shape is island_error; a refused run not_applied; a throw island_error; past its bound not_applied; every folder gone', async () => {
    const odd = fakeCtx((a, files) => { files.set(`${a.dir as string}/.cc-rescue.json`, enc({ error: '', message: '', lines: [] })); return true; });
    expect(await run({ names: ['R'] }, odd.ctx)).toEqual({ ok: false, code: 'island_error', message: 'the engine answered a rescue of another shape' });
    const refusedRun = fakeCtx(() => false);
    expect(await run({ names: ['R'] }, refusedRun.ctx)).toEqual({ ok: false, code: 'not_applied', message: 'sch.rescue' });
    const thrown = fakeCtx(() => { throw new Error('boom'); });
    expect(await run({ names: ['R'] }, thrown.ctx)).toEqual({ ok: false, code: 'island_error', message: 'boom' });
    const stuck = fakeCtx(goodEngine, { idle: () => false });
    expect(await run({ names: ['R'] }, stuck.ctx)).toEqual({ ok: false, code: 'not_applied', message: 'sch.rescue' });
    for (const f of [odd, refusedRun, thrown, stuck]) {
      expect(f.dropped).toEqual(expect.arrayContaining(f.made));
      expect(f.events).toEqual([]);
    }
  });

  it('the gate answers before anything runs: bad args, then the schematic gate', async () => {
    const f = fakeCtx(goodEngine, { gate: 'sch.rescue' });
    expect(await run({ preview: true }, f.ctx)).toEqual({ ok: false, code: 'busy', message: 'sch.rescue' });
    expect(await run({ names: ['R'] }, f.ctx)).toEqual({ ok: false, code: 'busy', message: 'sch.rescue' });
    expect(await run({ names: [] }, f.ctx)).toEqual({ ok: false, code: 'bad_args', message: 'sch.rescue' });
    expect(f.made).toEqual([]);
    expect(f.calls).toEqual([]);
    expect(f.reads).toEqual([]);
  });
});
