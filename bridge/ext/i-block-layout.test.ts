// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// i-block-layout: block.applyLayout in a pcb frame, its args and the engine's
// record read closed, the run folder under /tmp/cc-blocklayout removed after
// every answer, block_failed for KiCad's refusals; board.preview and
// board.update widened with Keep groups and Apply block layouts, gated on the
// engine's marker; the cap blockLayouts listed only by a pcb frame whose
// engine has both halves. The engine here is this test's own module of
// exports (at the protocol boundary); the real engine is the e2e's
// (tests/e2e/blocks-layout.spec.ts, engine run 15).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startResponder } from '../responder';
import type { Answer, ExtUnit, ResponderCtx } from './contract';
import { buildRegistry, REGISTRY } from './registry';
import unit, {
  applyLayout, BLOCK_LAYOUT_CAP, BLOCK_LAYOUT_RECORD, BLOCK_LAYOUT_ROOT, MAX_LAYOUT_GROUPS, parseApplyLayoutArgs, readBlockLayoutRecord, UPDATE_GROUPS_MARKER,
} from './i-block-layout';

const PARENT = 'http://localhost';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));
const enc = (v: unknown): Uint8Array => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v));
const G1 = 'cc0b10c5-0000-4000-8000-000000000a01';
const G2 = 'cc0b10c5-0000-4000-8000-000000000a02';
const OPTS = { replaceFootprints: true, deleteExtra: false, relinkByReference: false };
const RUN15 = {
  kicadCollabBusy: () => false, kicadUpdateBoardFromSchematic: () => false, kicadDesignBlockApplyLayout: () => false, kicadBoardUpdateGroups: () => true,
};

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
    wxElementRegistry: { findAll: () => [{ id: 'frame', typeName: frame === 'pcb' ? 'PCB_EDIT_FRAME' : 'SCH_EDIT_FRAME', name: 'Frame', visible: true }], findByLabel: () => [] },
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
 * A ResponderCtx over a fake engine and a fake MEMFS: the run folders made and
 * dropped are recorded; `engine` plays kicadDesignBlockApplyLayout (its record
 * written into the run folder it is given).
 */
function fakeCtx(opts: { engine?: (a: Record<string, unknown>, files: Map<string, Uint8Array>) => unknown; idle?: () => boolean; gate?: string; frame?: string; dialog?: string; missing?: string[] } = {}) {
  const files = new Map<string, Uint8Array>();
  const made: string[] = [];
  const dropped: string[] = [];
  const calls: Array<Record<string, unknown>> = [];
  const gated: Array<readonly string[]> = [];
  let n = 0;
  const mod: Record<string, unknown> = {
    ...RUN15,
    kicadDesignBlockApplyLayout: (json: string) => { const a = JSON.parse(json) as Record<string, unknown>; calls.push(a); return (opts.engine ?? (() => false))(a, files); },
  };
  for (const name of opts.missing ?? []) delete mod[name];
  const ctx = {
    frame: opts.frame ?? 'pcb',
    root: '/project',
    timing: { blockLayoutMs: 200, applyPollMs: 5 },
    mod: () => mod,
    closed: () => false,
    boardGate: (_op: string, exports: readonly string[]) => {
      gated.push(exports);
      if (opts.gate != null) return { ok: false, code: 'busy', message: opts.gate };
      for (const name of exports) if (typeof mod[name] !== 'function') return { ok: false, code: 'unsupported', message: name };
      return { w: {}, mod };
    },
    freshRunFolder: (root: string) => { n += 1; const d = `${root}/${n}`; made.push(d); return d; },
    dropRunFolder: (dir: string) => { dropped.push(dir); for (const k of [...files.keys()]) if (k.startsWith(`${dir}/`)) files.delete(k); },
    readBytes: (abs: string) => files.get(abs) ?? null,
    watchedRun: async (op: string, dir: string, ms: number, call: () => unknown, record: () => unknown) => {
      if (call() !== true) return { ok: false, code: 'not_applied', message: op };
      const deadline = Date.now() + ms;
      for (;;) {
        if ((opts.idle ?? (() => true))()) { const done = record(); if (done != null) return { done, dialog: opts.dialog ?? null }; }
        if (Date.now() >= deadline) return { ok: false, code: 'not_applied', message: op };
        await settle(5);
      }
    },
    log: () => {},
  } as unknown as ResponderCtx;
  return { ctx, files, made, dropped, calls, gated };
}

/** An engine that answers as kicadDesignBlockApplyLayout does: the record written last. */
const engineOf = (record: unknown) => (a: Record<string, unknown>, files: Map<string, Uint8Array>) => {
  files.set(`${a.dir as string}/${BLOCK_LAYOUT_RECORD}`, enc(record));
  return true;
};

describe('i-block-layout in the registry', () => {
  it('loads in this checkout with nothing broken, owning block.applyLayout and widening board.preview and board.update', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect(REGISTRY.ops.get('block.applyLayout')?.unit).toBe('i-block-layout');
    expect(REGISTRY.pending.has('block.applyLayout')).toBe(false);
    for (const op of ['board.preview', 'board.update']) expect(REGISTRY.widen.get(op)?.map((w) => w.unit)).toContain('i-block-layout');
    expect(REGISTRY.capNames.get(BLOCK_LAYOUT_CAP)).toBe('i-block-layout');
  });

  it('lists blockLayouts only in a pcb frame whose engine has the apply, the update and the marker', () => {
    const caps = unit.caps;
    expect(caps(RUN15, 'pcb')).toEqual([BLOCK_LAYOUT_CAP]);
    expect(caps(RUN15, 'sch')).toEqual([]);
    for (const name of Object.keys(RUN15)) {
      const less: Record<string, unknown> = { ...RUN15 };
      delete less[name];
      expect(caps(less, 'pcb')).toEqual([]);
    }
  });
});

describe('block.applyLayout args', () => {
  it('takes exactly { uuids }: 1 to 256 distinct lower case uuids', () => {
    expect(parseApplyLayoutArgs({ uuids: [G1, G2] })).toEqual({ uuids: [G1, G2] });
    const many = Array.from({ length: MAX_LAYOUT_GROUPS }, (_, i) => `cc0b10c5-0000-4000-8000-${i.toString(16).padStart(12, '0')}`);
    expect(parseApplyLayoutArgs({ uuids: many })).not.toBeNull();
    for (const bad of [
      undefined, {}, { uuids: [] }, { uuids: G1 }, { uuids: [G1, G1] }, { uuids: [G1.toUpperCase()] }, { uuids: ['x'] }, { uuids: [3] },
      { uuids: [G1], more: 1 }, { uuids: [...many, 'cc0b10c5-0000-4000-8000-ffffffffffff'] },
    ]) expect(parseApplyLayoutArgs(bad)).toBeNull();
  });
});

describe('.cc-block-layout.json', () => {
  it('reads applied, the failures and the lines closed', () => {
    expect(readBlockLayoutRecord(null)).toBeNull();
    expect(readBlockLayoutRecord(enc({ applied: 1, failures: [{ uuid: G2, reason: 'no footprint for C2' }], lines: ['Applied.'] })))
      .toEqual({ applied: 1, failures: [{ uuid: G2, reason: 'no footprint for C2' }], lines: ['Applied.'] });
    expect(readBlockLayoutRecord(enc({ applied: 0, failures: [], lines: ['x'.repeat(2000), ...Array(70).fill('l')] })))
      .toMatchObject({ applied: 0, failures: [] });
    const cut = readBlockLayoutRecord(enc({ applied: 0, failures: [], lines: ['x'.repeat(2000), ...Array(70).fill('l')] }));
    expect(cut !== 'bad' && cut != null ? [cut.lines.length, cut.lines[0].length] : null).toEqual([64, 1024]);
  });

  it('answers bad for any other shape', () => {
    for (const bad of [
      'not json', [], { applied: 1, failures: [] }, { applied: -1, failures: [], lines: [] }, { applied: 1.5, failures: [], lines: [] },
      { applied: 0, failures: [{ uuid: 'x', reason: 'r' }], lines: [] }, { applied: 0, failures: [{ uuid: G1 }], lines: [] },
      { applied: 0, failures: [{ uuid: G1, reason: 'r', more: 1 }], lines: [] }, { applied: 0, failures: [], lines: [1] }, { applied: 0, failures: [], lines: [], code: 0 },
    ]) expect(readBlockLayoutRecord(enc(bad))).toBe('bad');
  });
});

describe('block.applyLayout', () => {
  it('queues the apply with the run, its folder and the groups; answers { applied, failures }; the folder removed', async () => {
    const { ctx, calls, made, dropped } = fakeCtx({ engine: engineOf({ applied: 1, failures: [{ uuid: G2, reason: 'its layout has no footprint for C2' }], lines: [] }) });
    const r = await applyLayout({ uuids: [G1, G2] }, ctx);
    expect(r).toEqual({ ok: true, result: { applied: 1, failures: [{ uuid: G2, reason: 'its layout has no footprint for C2' }] } });
    expect(calls).toEqual([{ run: 1, dir: `${BLOCK_LAYOUT_ROOT}/1`, uuids: [G1, G2] }]);
    expect(made).toEqual([`${BLOCK_LAYOUT_ROOT}/1`]);
    expect(dropped).toEqual(made);
  });

  it('every group failing still answers its failures', async () => {
    const { ctx } = fakeCtx({ engine: engineOf({ applied: 0, failures: [{ uuid: G1, reason: 'r' }], lines: ['l'] }) });
    expect(await applyLayout({ uuids: [G1] }, ctx)).toEqual({ ok: true, result: { applied: 0, failures: [{ uuid: G1, reason: 'r' }] } });
  });

  it('nothing applied and no failure (no group linked to a block): block_failed with KiCad\'s first line', async () => {
    const { ctx, dropped } = fakeCtx({ engine: engineOf({ applied: 0, failures: [], lines: ['', 'No groups with a linked design block are selected.'] }) });
    expect(await applyLayout({ uuids: [G1] }, ctx)).toEqual({ ok: false, code: 'block_failed', message: 'No groups with a linked design block are selected.' });
    expect(dropped.length).toBe(1);
  });

  it('the engine refusing the groups at once (a uuid naming no group): block_failed, nothing waited for', async () => {
    const { ctx, dropped } = fakeCtx({ engine: () => false });
    expect(await applyLayout({ uuids: [G1] }, ctx)).toEqual({ ok: false, code: 'block_failed', message: 'a uuid names no group of the board' });
    expect(dropped.length).toBe(1);
  });

  it('a dialog met during the run: block_failed naming it', async () => {
    const { ctx } = fakeCtx({ engine: engineOf({ applied: 1, failures: [], lines: [] }), dialog: 'Apply Design Block Layout' });
    expect(await applyLayout({ uuids: [G1] }, ctx)).toEqual({ ok: false, code: 'block_failed', message: 'Apply Design Block Layout' });
  });

  it('a record of another shape: island_error; a throw: island_error with its message; no record in time: not_applied', async () => {
    expect(await applyLayout({ uuids: [G1] }, fakeCtx({ engine: engineOf({ applied: 'one' }) }).ctx)).toMatchObject({ ok: false, code: 'island_error' });
    expect(await applyLayout({ uuids: [G1] }, fakeCtx({ engine: () => { throw new Error('boom'); } }).ctx)).toEqual({ ok: false, code: 'island_error', message: 'boom' });
    const late = fakeCtx({ engine: () => true });
    expect(await applyLayout({ uuids: [G1] }, late.ctx)).toEqual({ ok: false, code: 'not_applied', message: 'block.applyLayout' });
    expect(late.dropped.length).toBe(1);
  });

  it('checks in order: args, frame, then the gate, before any folder is made', async () => {
    const bad = fakeCtx({ frame: 'sch' });
    expect(await applyLayout({ uuids: ['x'] }, bad.ctx)).toEqual({ ok: false, code: 'bad_args', message: 'block.applyLayout' });
    expect(await applyLayout({ uuids: [G1] }, bad.ctx)).toEqual({ ok: false, code: 'unsupported', message: 'a design block layout is applied in a pcb frame' });
    const run14 = fakeCtx({ missing: ['kicadDesignBlockApplyLayout'] });
    expect(await applyLayout({ uuids: [G1] }, run14.ctx)).toEqual({ ok: false, code: 'unsupported', message: 'kicadDesignBlockApplyLayout' });
    const busy = fakeCtx({ gate: 'block.applyLayout' });
    expect(await applyLayout({ uuids: [G1] }, busy.ctx)).toMatchObject({ ok: false, code: 'busy' });
    expect([...bad.made, ...run14.made, ...busy.made]).toEqual([]);
  });
});

describe('board.preview and board.update widened', () => {
  const widen = (op: 'board.preview' | 'board.update') => unit.opsWidened[op];
  const nextOf = (answer: Answer) => {
    const seen: unknown[] = [];
    return { seen, next: async (args: unknown) => { seen.push(args); return answer; } };
  };
  const LAYOUTS = { applied: 1, failures: [] };

  it('args without the group boxes, or Keep groups off, go to the op as it ships with no marker asked', async () => {
    for (const args of [OPTS, { ...OPTS, transferGroups: false }, { ...OPTS, transferGroups: false, applyBlockLayouts: false }]) {
      const { ctx, gated } = fakeCtx({ missing: [UPDATE_GROUPS_MARKER] });
      const { seen, next } = nextOf({ ok: true, result: { token: 't' } });
      expect(await widen('board.preview')(args, ctx, next)).toEqual({ ok: true, result: { token: 't' } });
      expect(seen).toEqual([args]);
      expect(gated).toEqual([]);
    }
  });

  it('Apply block layouts without Keep groups, or on beside it off: bad_args with nothing run', async () => {
    for (const op of ['board.preview', 'board.update'] as const) {
      const tok = op === 'board.update' ? { token: 'abc' } : {};
      for (const args of [{ ...OPTS, ...tok, applyBlockLayouts: true }, { ...OPTS, ...tok, applyBlockLayouts: false }, { ...OPTS, ...tok, transferGroups: false, applyBlockLayouts: true }, { ...OPTS, ...tok, transferGroups: 1 }, { ...OPTS, ...tok, transferGroups: true, more: 1 }]) {
        const { ctx } = fakeCtx();
        const { seen, next } = nextOf({ ok: true, result: {} });
        expect(await widen(op)(args, ctx, next)).toEqual({ ok: false, code: 'bad_args', message: op });
        expect(seen).toEqual([]);
      }
    }
  });

  it('Keep groups on, on an engine without the marker (run 14): unsupported naming kicadBoardUpdateGroups, nothing run', async () => {
    const { ctx } = fakeCtx({ missing: [UPDATE_GROUPS_MARKER] });
    const { seen, next } = nextOf({ ok: true, result: {} });
    expect(await widen('board.preview')({ ...OPTS, transferGroups: true }, ctx, next)).toEqual({ ok: false, code: 'unsupported', message: UPDATE_GROUPS_MARKER });
    expect(seen).toEqual([]);
  });

  it('Keep groups on, on engine run 15: the op runs with the args as sent and answers its layouts', async () => {
    for (const op of ['board.preview', 'board.update'] as const) {
      const args = { ...OPTS, ...(op === 'board.update' ? { token: 'abc' } : {}), transferGroups: true, applyBlockLayouts: true };
      const { ctx, gated } = fakeCtx();
      const { seen, next } = nextOf({ ok: true, result: { changes: [], layouts: LAYOUTS } });
      expect(await widen(op)(args, ctx, next)).toEqual({ ok: true, result: { changes: [], layouts: LAYOUTS } });
      expect(seen).toEqual([args]);
      expect(gated).toEqual([['kicadUpdateBoardFromSchematic', 'kicadCollabBusy', UPDATE_GROUPS_MARKER]]);
    }
  });

  it('a run that kept groups answering no layouts: island_error; a failure passes through', async () => {
    const { ctx } = fakeCtx();
    expect(await widen('board.preview')({ ...OPTS, transferGroups: true }, ctx, nextOf({ ok: true, result: { changes: [] } }).next))
      .toEqual({ ok: false, code: 'island_error', message: 'the update report carried no layouts' });
    expect(await widen('board.preview')({ ...OPTS, transferGroups: true }, ctx, nextOf({ ok: false, code: 'stale', message: 'm' }).next))
      .toEqual({ ok: false, code: 'stale', message: 'm' });
  });
});

describe('through the responder', () => {
  it('a pcb frame on engine run 15 lists blockLayouts; a sch frame and engine run 14 do not', async () => {
    expect((await boot('pcb', RUN15)).ready?.caps).toContain(BLOCK_LAYOUT_CAP);
    expect((await boot('sch', RUN15)).ready?.caps).not.toContain(BLOCK_LAYOUT_CAP);
    expect((await boot('pcb', { kicadCollabBusy: () => false, kicadUpdateBoardFromSchematic: () => false })).ready?.caps).not.toContain(BLOCK_LAYOUT_CAP);
  });

  it('on engine run 14: block.applyLayout checks its args first, then answers unsupported naming the export; board.preview with Keep groups unsupported naming the marker', async () => {
    const { ask } = await boot('pcb', { kicadCollabBusy: () => false, kicadUpdateBoardFromSchematic: () => false });
    expect(await ask(1, 'block.applyLayout', { uuids: [] })).toMatchObject({ id: 1, ok: false, error: { code: 'bad_args', message: 'block.applyLayout' } });
    expect(await ask(2, 'block.applyLayout', { uuids: [G1] })).toMatchObject({ id: 2, ok: false, error: { code: 'unsupported', message: 'kicadDesignBlockApplyLayout' } });
    expect(await ask(3, 'board.preview', { ...OPTS, transferGroups: true })).toMatchObject({ id: 3, ok: false, error: { code: 'unsupported', message: UPDATE_GROUPS_MARKER } });
    expect(await ask(4, 'board.preview', { ...OPTS, applyBlockLayouts: true })).toMatchObject({ id: 4, ok: false, error: { code: 'bad_args', message: 'board.preview' } });
  });

  it('in a sch frame: unsupported with the unit\'s frame refusal', async () => {
    const { ask } = await boot('sch', RUN15);
    expect(await ask(1, 'block.applyLayout', { uuids: [G1] })).toMatchObject({ id: 1, ok: false, error: { code: 'unsupported', message: 'a design block layout is applied in a pcb frame' } });
  });
});
