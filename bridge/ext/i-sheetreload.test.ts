// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// i-sheetreload: sheet.reload in a sch or pcb frame through the frame's own
// gate, the engine's answer read strictly, the answer held until the apply
// queue empties, and the op unsupported naming kicadDrawingSheetReload on an
// engine without it (the cap then not listed). The engine here is this
// test's own module of exports (at the protocol boundary); the real engine is
// the e2e's (tests/e2e/sheet-reload.spec.ts, engine run 15).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startResponder } from '../responder';
import type { ExtUnit, ResponderCtx } from './contract';
import { buildRegistry, REGISTRY } from './registry';
import unit, { SHEET_RELOAD_CAP, SHEET_RELOAD_EXPORTS, SHEET_RELOAD_MS, sheetReload } from './i-sheetreload';

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
  } as unknown as ToolWindow;
  if (ready) r.engineReady(win, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
  await settle();
  const ask = async (id: number, op: string, args?: unknown) => {
    ch.port1.postMessage(args === undefined ? { id, op } : { id, op, args });
    await settle();
    return got.find((m) => m.id === id);
  };
  return { r, got, ready: got.find((m) => m.type === 'ev.ready') as { caps: string[] } | undefined, ask };
}

const RUN15 = { kicadCollabBusy: () => false, kicadDrawingSheetReload: () => true };

/**
 * A ResponderCtx over a fake engine: `reload` plays kicadDrawingSheetReload,
 * `idleAfter` is how many applyIdle polls stay busy, `gate` makes the frame's
 * gate refuse with that code.
 */
function fakeCtx(opts: { frame?: string; reload?: () => unknown; idle?: boolean; gate?: string; missing?: string; timing?: Record<string, number> } = {}) {
  const calls: string[] = [];
  const idleAsked: number[] = [];
  const mod: Record<string, unknown> = {
    kicadCollabBusy: () => false,
    kicadDrawingSheetReload: (...a: unknown[]) => { calls.push(`reload ${a.length}`); return (opts.reload ?? (() => true))(); },
  };
  if (opts.missing != null) delete mod[opts.missing];
  const gate = (kind: string) => (op: string, exports: readonly string[]) => {
    calls.push(`gate ${kind} ${op} ${exports.join(' ')}`);
    if (opts.gate != null) return { ok: false, code: opts.gate, message: op };
    for (const name of exports) if (typeof mod[name] !== 'function') return { ok: false, code: 'unsupported', message: name };
    return { w: {}, mod };
  };
  const ctx = {
    frame: opts.frame ?? 'pcb',
    timing: opts.timing ?? {},
    boardGate: gate('board'),
    schematicGate: gate('schematic'),
    applyIdle: async (ms: number) => { idleAsked.push(ms); calls.push('idle'); return opts.idle ?? true; },
    log: () => {},
  } as unknown as ResponderCtx;
  return { ctx, calls, idleAsked };
}

describe('i-sheetreload in the registry', () => {
  it('loads in this checkout with nothing broken, owning sheet.reload and its cap, no longer a placeholder', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect(REGISTRY.ops.get('sheet.reload')?.unit).toBe('i-sheetreload');
    expect(REGISTRY.pending.has('sheet.reload')).toBe(false);
    expect(REGISTRY.capNames.get(SHEET_RELOAD_CAP)).toBe('i-sheetreload');
    expect(unit.unit).toBe('i-sheetreload');
    expect(SHEET_RELOAD_CAP).toBe('sheetReload');
    expect(SHEET_RELOAD_EXPORTS).toEqual(['kicadDrawingSheetReload', 'kicadCollabBusy']);
  });

  it('lists sheetReload in a sch and a pcb frame only, and only on an engine with both exports', () => {
    expect(unit.caps!(RUN15, 'sch')).toEqual(['sheetReload']);
    expect(unit.caps!(RUN15, 'pcb')).toEqual(['sheetReload']);
    expect(unit.caps!(RUN15, 'symedit')).toEqual([]);
    expect(unit.caps!(RUN15, 'ds')).toEqual([]);
    expect(unit.caps!({ kicadCollabBusy: () => false }, 'pcb')).toEqual([]);
    expect(unit.caps!({ kicadDrawingSheetReload: () => true }, 'sch')).toEqual([]);
    expect(unit.caps!(null as unknown as Record<string, unknown>, 'sch')).toEqual([]);
  });
});

describe('sheet.reload through the responder', () => {
  it('on an engine without the export: the cap is not listed and the op answers unsupported naming it', async () => {
    for (const frame of ['sch', 'pcb']) {
      const t = await boot(frame, { kicadCollabBusy: () => false });
      try {
        expect(t.ready?.caps).not.toContain('sheetReload');
        expect(await t.ask(1, 'sheet.reload')).toEqual({ id: 1, ok: false, error: { code: 'unsupported', message: 'kicadDrawingSheetReload' } });
        expect(await t.ask(2, 'sheet.reload', { x: 1 })).toEqual({ id: 2, ok: false, error: { code: 'bad_args', message: 'sheet.reload' } });
      } finally { t.r.close(); }
    }
  });

  it('on a run 15 engine: the cap is listed, and with no document open the op answers not_ready, changing nothing', async () => {
    for (const frame of ['sch', 'pcb']) {
      const reload = vi.fn(() => true);
      const t = await boot(frame, { ...RUN15, kicadDrawingSheetReload: reload });
      try {
        expect(t.ready?.caps).toContain('sheetReload');
        expect(await t.ask(1, 'sheet.reload')).toEqual({ id: 1, ok: false, error: { code: 'not_ready', message: 'sheet.reload' } });
        expect(await t.ask(2, 'sheet.reload', {})).toEqual({ id: 2, ok: false, error: { code: 'not_ready', message: 'sheet.reload' } });
        expect(reload).not.toHaveBeenCalled();
      } finally { t.r.close(); }
    }
  });

  it('before ev.ready it answers not_ready', async () => {
    const t = await boot('pcb', RUN15, false);
    try {
      expect(await t.ask(1, 'sheet.reload')).toEqual({ id: 1, ok: false, error: { code: 'not_ready', message: 'sheet.reload' } });
    } finally { t.r.close(); }
  });

  it('in a symedit frame it answers unsupported with the frame refusal, and lists no cap', async () => {
    const t = await boot('symedit', RUN15);
    try {
      expect(t.ready?.caps ?? []).not.toContain('sheetReload');
      expect(await t.ask(1, 'sheet.reload')).toEqual({ id: 1, ok: false, error: { code: 'unsupported', message: 'a drawing sheet reloads in a sch or a pcb frame' } });
    } finally { t.r.close(); }
  });
});

describe('sheet.reload, the op', () => {
  it('reads its args closed: none or {} only, before any gate', async () => {
    for (const args of [{ all: true }, [], 'x', 1, null]) {
      const f = fakeCtx();
      expect(await sheetReload(args, f.ctx)).toEqual({ ok: false, code: 'bad_args', message: 'sheet.reload' });
      expect(f.calls).toEqual([]);
    }
  });

  it('goes through the board gate in a pcb frame and the schematic gate in a sch frame, with both exports', async () => {
    const pcb = fakeCtx({ frame: 'pcb' });
    expect(await sheetReload(undefined, pcb.ctx)).toEqual({ ok: true, result: {} });
    expect(pcb.calls).toEqual(['gate board sheet.reload kicadDrawingSheetReload kicadCollabBusy', 'reload 0', 'idle']);
    const sch = fakeCtx({ frame: 'sch' });
    expect(await sheetReload({}, sch.ctx)).toEqual({ ok: true, result: {} });
    expect(sch.calls).toEqual(['gate schematic sheet.reload kicadDrawingSheetReload kicadCollabBusy', 'reload 0', 'idle']);
  });

  it('answers the gate refusal unchanged and never calls the engine', async () => {
    for (const code of ['not_ready', 'busy']) {
      const f = fakeCtx({ gate: code });
      expect(await sheetReload(undefined, f.ctx)).toEqual({ ok: false, code, message: 'sheet.reload' });
      expect(f.calls.some((c) => c.startsWith('reload'))).toBe(false);
    }
    const old = fakeCtx({ missing: 'kicadDrawingSheetReload' });
    expect(await sheetReload(undefined, old.ctx)).toEqual({ ok: false, code: 'unsupported', message: 'kicadDrawingSheetReload' });
  });

  it('answers not_applied for any engine answer but true, without waiting on the queue', async () => {
    for (const answer of [false, undefined, 1, 'true', null]) {
      const f = fakeCtx({ reload: () => answer });
      expect(await sheetReload(undefined, f.ctx)).toEqual({ ok: false, code: 'not_applied', message: 'sheet.reload' });
      expect(f.calls).not.toContain('idle');
    }
  });

  it('takes a promise of true as true', async () => {
    const f = fakeCtx({ reload: () => Promise.resolve(true) });
    expect(await sheetReload(undefined, f.ctx)).toEqual({ ok: true, result: {} });
  });

  it('answers island_error when the engine throws', async () => {
    const f = fakeCtx({ reload: () => { throw new Error('trap'); } });
    expect(await sheetReload(undefined, f.ctx)).toEqual({ ok: false, code: 'island_error', message: 'trap' });
  });

  it('waits for the apply queue, 30 s unless the bridge names sheetReloadMs, and answers not_applied past it', async () => {
    const f = fakeCtx();
    await sheetReload(undefined, f.ctx);
    expect(f.idleAsked).toEqual([SHEET_RELOAD_MS]);
    expect(SHEET_RELOAD_MS).toBe(30_000);
    const short = fakeCtx({ timing: { sheetReloadMs: 50 } });
    await sheetReload(undefined, short.ctx);
    expect(short.idleAsked).toEqual([50]);
    const stuck = fakeCtx({ idle: false });
    expect(await sheetReload(undefined, stuck.ctx)).toEqual({ ok: false, code: 'not_applied', message: 'sheet.reload' });
  });
});
