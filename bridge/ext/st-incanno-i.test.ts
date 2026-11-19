// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-incanno-i: sheet.increment in a sch frame through the schematic gate,
// its args read closed, the engine's answer read strictly, the answer held
// until the apply queue empties and carrying whether the undo depth moved,
// the op unsupported naming kicadSchIncrementAnnotations on an engine without
// it (the cap then not listed), and KiCad's Increment Annotations From held
// under the cap. The engine here is this test's own module of exports (at the
// protocol boundary); the real engine is the e2e's
// (tests/e2e/st/st-incanno-i.spec.ts, engine run 15).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HELD_ACTIONS, heldTaken } from '../held';
import { startResponder } from '../responder';
import type { ExtUnit, ResponderCtx } from './contract';
import { buildRegistry, heldActions, REGISTRY } from './registry';
import unit, { INCREMENT_ACTION, INCREMENT_CAP, INCREMENT_EXPORTS, INCREMENT_MS, readIncrementArgs, sheetIncrement } from './st-incanno-i';

const PARENT = 'http://localhost';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));
const GOOD = { first: 'R10', by: 100, allSheets: true };

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
async function boot(frame: string, exports: Record<string, unknown>, ready = true) {
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
  } as unknown as ToolWindow & { kicadHostAction?: { onRequest?: (json: unknown) => boolean } };
  if (ready) r.engineReady(win, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
  await settle();
  const ask = async (id: number, op: string, args?: unknown) => {
    ch.port1.postMessage(args === undefined ? { id, op } : { id, op, args });
    await settle();
    return got.find((m) => m.id === id);
  };
  return { r, win, got, ready: got.find((m) => m.type === 'ev.ready') as { caps: string[] } | undefined, ask };
}

const RUN14 = { kicadCollabBusy: () => false, kicadCollabTestUndoDepth: () => 0 };
const RUN15 = { ...RUN14, kicadSchIncrementAnnotations: () => true };

/**
 * A ResponderCtx over a fake engine: `shift` plays kicadSchIncrementAnnotations,
 * `depths` the undo depth read before and after, `idle` the apply queue's
 * answer, `gate` makes the schematic gate refuse with that code.
 */
function fakeCtx(opts: { shift?: (json: string) => unknown; depths?: unknown[]; idle?: boolean; gate?: string; missing?: string; timing?: Record<string, number> } = {}) {
  const calls: string[] = [];
  const idleAsked: number[] = [];
  const depths = [...(opts.depths ?? [4, 5])];
  const mod: Record<string, unknown> = {
    kicadCollabBusy: () => false,
    kicadCollabTestUndoDepth: () => { calls.push('depth'); return depths.length > 1 ? depths.shift() : depths[0]; },
    kicadSchIncrementAnnotations: (json: string) => { calls.push(`shift ${json}`); return (opts.shift ?? (() => true))(json); },
  };
  if (opts.missing != null) delete mod[opts.missing];
  const ctx = {
    frame: 'sch',
    timing: opts.timing ?? {},
    schematicGate: (op: string, exports: readonly string[]) => {
      calls.push(`gate ${op} ${exports.join(' ')}`);
      if (opts.gate != null) return { ok: false, code: opts.gate, message: op };
      for (const name of exports) if (typeof mod[name] !== 'function') return { ok: false, code: 'unsupported', message: name };
      return { w: {}, mod };
    },
    applyIdle: async (ms: number) => { idleAsked.push(ms); calls.push('idle'); return opts.idle ?? true; },
    log: () => {},
  } as unknown as ResponderCtx;
  return { ctx, calls, idleAsked };
}

describe('st-incanno-i in the registry', () => {
  it('loads in this checkout with nothing broken, owning sheet.increment, its cap and its held row, no longer a placeholder', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect(REGISTRY.ops.get('sheet.increment')?.unit).toBe('st-incanno-i');
    expect(REGISTRY.pending.has('sheet.increment')).toBe(false);
    expect(REGISTRY.capNames.get(INCREMENT_CAP)).toBe('st-incanno-i');
    expect(unit.unit).toBe('st-incanno-i');
    expect(INCREMENT_CAP).toBe('incrementAnnotations');
    expect(INCREMENT_ACTION).toBe('eeschema.EditorControl.incrementAnnotations');
    expect(INCREMENT_EXPORTS).toEqual(['kicadSchIncrementAnnotations', 'kicadCollabBusy', 'kicadCollabTestUndoDepth']);
    expect(unit.held).toEqual([INCREMENT_ACTION]);
    expect(unit.heldRows).toEqual([{ action: INCREMENT_ACTION, frames: ['sch'], cap: INCREMENT_CAP }]);
    const union = heldActions();
    expect(union.filter((h) => h.action === INCREMENT_ACTION)).toEqual([{ action: INCREMENT_ACTION, frames: ['sch'], cap: INCREMENT_CAP }]);
    expect(HELD_ACTIONS.some((h) => h.action === INCREMENT_ACTION)).toBe(false);
  });

  it('lists incrementAnnotations in a sch frame only, and only on an engine with every export', () => {
    expect(unit.caps!(RUN15, 'sch')).toEqual(['incrementAnnotations']);
    for (const frame of ['pcb', 'symedit', 'fpedit', 'ds'] as const) expect(unit.caps!(RUN15, frame), frame).toEqual([]);
    expect(unit.caps!(RUN14, 'sch')).toEqual([]);
    for (const name of INCREMENT_EXPORTS) {
      const less: Record<string, unknown> = { ...RUN15 };
      delete less[name];
      expect(unit.caps!(less, 'sch'), name).toEqual([]);
    }
    expect(unit.caps!(null as unknown as Record<string, unknown>, 'sch')).toEqual([]);
  });

  it('takes the held action in a sch frame under the cap only', () => {
    const union = heldActions(buildRegistry(mods(unit)));
    expect(heldTaken(INCREMENT_ACTION, 'sch', ['heldKeys', INCREMENT_CAP], union)).toBe(true);
    expect(heldTaken(INCREMENT_ACTION, 'sch', ['heldKeys'], union)).toBe(false);
    expect(heldTaken(INCREMENT_ACTION, 'pcb', ['heldKeys', INCREMENT_CAP], union)).toBe(false);
    expect(heldTaken(INCREMENT_ACTION, 'symedit', ['heldKeys', INCREMENT_CAP], union)).toBe(false);
    expect(heldTaken('eeschema.EditorControl.annotate', 'sch', ['heldKeys', INCREMENT_CAP], union)).toBe(false);
  });
});

describe('sheet.increment through the responder', () => {
  it('on run 14: the cap is not listed, the op answers unsupported naming the export, and the slot leaves the action to KiCad', async () => {
    const t = await boot('sch', { ...RUN14, kicadHostActions: () => true });
    try {
      expect(t.ready?.caps).not.toContain('incrementAnnotations');
      expect(await t.ask(1, 'sheet.increment', GOOD)).toEqual({ id: 1, ok: false, error: { code: 'unsupported', message: 'kicadSchIncrementAnnotations' } });
      expect(await t.ask(2, 'sheet.increment', { first: 'R', by: 1, allSheets: true })).toEqual({ id: 2, ok: false, error: { code: 'bad_args', message: 'sheet.increment' } });
      expect(t.win.kicadHostAction!.onRequest!(JSON.stringify({ action: INCREMENT_ACTION }))).toBe(false);
      expect(t.got.filter((m) => m.type === 'ev.held')).toEqual([]);
    } finally { t.r.close(); }
  });

  it('on run 15: the cap is listed, and with no schematic open the op answers not_ready, changing nothing', async () => {
    const shift = vi.fn(() => true);
    const t = await boot('sch', { ...RUN15, kicadSchIncrementAnnotations: shift });
    try {
      expect(t.ready?.caps).toContain('incrementAnnotations');
      expect(await t.ask(1, 'sheet.increment', GOOD)).toEqual({ id: 1, ok: false, error: { code: 'not_ready', message: 'sheet.increment' } });
      expect(shift).not.toHaveBeenCalled();
    } finally { t.r.close(); }
  });

  it('before ev.ready it answers not_ready', async () => {
    const t = await boot('sch', RUN15, false);
    try {
      expect(await t.ask(1, 'sheet.increment', GOOD)).toEqual({ id: 1, ok: false, error: { code: 'not_ready', message: 'sheet.increment' } });
    } finally { t.r.close(); }
  });

  it('in a pcb frame it answers unsupported with the frame refusal, and lists no cap', async () => {
    const t = await boot('pcb', RUN15);
    try {
      expect(t.ready?.caps ?? []).not.toContain('incrementAnnotations');
      expect(await t.ask(1, 'sheet.increment', GOOD)).toEqual({ id: 1, ok: false, error: { code: 'unsupported', message: 'designators shift in a sch frame' } });
    } finally { t.r.close(); }
  });
});

describe('sheet.increment, the args', () => {
  it('takes exactly first, by and allSheets', () => {
    expect(readIncrementArgs(GOOD)).toEqual(GOOD);
    expect(readIncrementArgs({ first: 'U3', by: 1, allSheets: false })).toEqual({ first: 'U3', by: 1, allSheets: false });
    expect(readIncrementArgs({ first: 'J_12', by: 100_000, allSheets: true })).toEqual({ first: 'J_12', by: 100_000, allSheets: true });
  });

  it('refuses anything else', () => {
    for (const args of [
      undefined, null, [], 'R10', {},
      { ...GOOD, run: 1 },
      { by: 100, allSheets: true },
      { first: 'R10', allSheets: true },
      { first: 'R10', by: 100 },
      { ...GOOD, first: 'R' }, { ...GOOD, first: '10' }, { ...GOOD, first: 'R1x' }, { ...GOOD, first: '' },
      { ...GOOD, first: ' R10' }, { ...GOOD, first: 'R\u000710' }, { ...GOOD, first: `R${'1'.repeat(64)}` }, { ...GOOD, first: 10 },
      { ...GOOD, by: 0 }, { ...GOOD, by: -1 }, { ...GOOD, by: 1.5 }, { ...GOOD, by: 100_001 }, { ...GOOD, by: '100' }, { ...GOOD, by: Number.NaN },
      { ...GOOD, allSheets: 'true' }, { ...GOOD, allSheets: 1 },
    ]) expect(readIncrementArgs(args), JSON.stringify(args)).toBeNull();
  });
});

describe('sheet.increment, the op', () => {
  it('reads its args closed before any gate', async () => {
    const f = fakeCtx();
    expect(await sheetIncrement({ first: 'R', by: 1, allSheets: true }, f.ctx)).toEqual({ ok: false, code: 'bad_args', message: 'sheet.increment' });
    expect(f.calls).toEqual([]);
  });

  it('goes through the schematic gate with every export, sends the three keys, waits for the queue and answers the depth moved', async () => {
    const f = fakeCtx({ depths: [4, 5] });
    expect(await sheetIncrement(GOOD, f.ctx)).toEqual({ ok: true, result: { shifted: true, depth: 5 } });
    expect(f.calls).toEqual([
      'gate sheet.increment kicadSchIncrementAnnotations kicadCollabBusy kicadCollabTestUndoDepth',
      'depth',
      'shift {"first":"R10","by":100,"allSheets":true}',
      'idle',
      'depth',
    ]);
  });

  it('answers shifted false when nothing matched (the depth did not move)', async () => {
    const f = fakeCtx({ depths: [7, 7] });
    expect(await sheetIncrement({ first: 'Q900', by: 1, allSheets: false }, f.ctx)).toEqual({ ok: true, result: { shifted: false, depth: 7 } });
  });

  it('answers the gate refusal unchanged and never calls the engine', async () => {
    for (const code of ['not_ready', 'busy']) {
      const f = fakeCtx({ gate: code });
      expect(await sheetIncrement(GOOD, f.ctx)).toEqual({ ok: false, code, message: 'sheet.increment' });
      expect(f.calls.some((c) => c.startsWith('shift'))).toBe(false);
    }
    const old = fakeCtx({ missing: 'kicadSchIncrementAnnotations' });
    expect(await sheetIncrement(GOOD, old.ctx)).toEqual({ ok: false, code: 'unsupported', message: 'kicadSchIncrementAnnotations' });
  });

  it('answers not_applied for any engine answer but true, without waiting on the queue', async () => {
    for (const answer of [false, undefined, 1, 'true', null]) {
      const f = fakeCtx({ shift: () => answer });
      expect(await sheetIncrement(GOOD, f.ctx)).toEqual({ ok: false, code: 'not_applied', message: 'sheet.increment' });
      expect(f.calls).not.toContain('idle');
    }
  });

  it('takes a promise of true as true', async () => {
    const f = fakeCtx({ shift: () => Promise.resolve(true) });
    expect(await sheetIncrement(GOOD, f.ctx)).toEqual({ ok: true, result: { shifted: true, depth: 5 } });
  });

  it('answers island_error when the engine throws or the depth reads in another shape', async () => {
    const f = fakeCtx({ shift: () => { throw new Error('trap'); } });
    expect(await sheetIncrement(GOOD, f.ctx)).toEqual({ ok: false, code: 'island_error', message: 'trap' });
    const bad = fakeCtx({ depths: ['x'] });
    expect(await sheetIncrement(GOOD, bad.ctx)).toEqual({ ok: false, code: 'island_error', message: 'the engine answered an undo depth of another shape' });
    expect(bad.calls.some((c) => c.startsWith('shift'))).toBe(false);
  });

  it('waits for the apply queue, 30 s unless the bridge names incrementMs, and answers not_applied past it', async () => {
    const f = fakeCtx();
    await sheetIncrement(GOOD, f.ctx);
    expect(f.idleAsked).toEqual([INCREMENT_MS]);
    expect(INCREMENT_MS).toBe(30_000);
    const short = fakeCtx({ timing: { incrementMs: 50 } });
    await sheetIncrement(GOOD, short.ctx);
    expect(short.idleAsked).toEqual([50]);
    const stuck = fakeCtx({ idle: false });
    expect(await sheetIncrement(GOOD, stuck.ctx)).toEqual({ ok: false, code: 'not_applied', message: 'sheet.increment' });
  });
});
