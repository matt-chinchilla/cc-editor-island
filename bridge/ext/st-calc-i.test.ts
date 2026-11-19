// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-calc-i: KiCad's pcb_calculator becomes the host tool "calculator"
// (ev.openTool), Calculator Tools is held in sch and pcb under openCalculator,
// and the cap is feature detected on the engine's held keys marker. The engine
// here is this test's own module of exports; the real engine is the e2e's
// (tests/e2e/st/st-calc-i.spec.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startResponder } from '../responder';
import { HELD_ACTIONS, heldTaken } from '../held';
import { hostToolFor } from '../../src/frames';
import type { ExtUnit } from './contract';
import { buildRegistry, heldActions, REGISTRY } from './registry';
import unit, { CALCULATOR_FRAME, CALCULATOR_TOOL, OPEN_CALCULATOR_CAP, SHOW_CALCULATOR_TOOLS, ST_CALC_ROWS } from './st-calc-i';

const PARENT = 'http://localhost';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));
const RUN14 = { kicadHostActions: () => true };

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

/** A responder with this unit alone, booted in `frame` on an engine with `exports`. */
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
    wxElementRegistry: { findAll: () => [{ id: 'frame', typeName: 'PCB_EDIT_FRAME', name: 'PcbFrame', visible: true }], findByLabel: () => [] },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    dispatchEvent: () => true,
  } as unknown as ToolWindow & { kicadHostAction?: { onRequest?: (json: unknown) => boolean } };
  r.engineReady(win, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
  await settle();
  return { r, win, ready: got.find((m) => m.type === 'ev.ready') as { caps: string[] } | undefined, got };
}

describe('the unit in the registry', () => {
  it('loads in this checkout with nothing broken: its cap, its row after the built ins, its host tool', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect(REGISTRY.units.map((u) => u.unit)).toContain('st-calc-i');
    expect(REGISTRY.capNames.get(OPEN_CALCULATOR_CAP)).toBe('st-calc-i');
    expect(REGISTRY.hostTools.get(CALCULATOR_TOOL)).toEqual({ unit: 'st-calc-i', frame: CALCULATOR_FRAME });
    const union = heldActions();
    expect(union).toContainEqual(ST_CALC_ROWS[0]);
    expect(union.slice(0, HELD_ACTIONS.length)).toEqual([...HELD_ACTIONS]);
  });

  it('holds exactly the record\'s one action in sch and pcb under openCalculator, no built in row holding it', () => {
    expect(unit.held).toEqual(['common.Control.showCalculatorTools']);
    expect(ST_CALC_ROWS.map((r) => [r.action, [...r.frames], r.cap])).toEqual([['common.Control.showCalculatorTools', ['sch', 'pcb'], 'openCalculator']]);
    expect(HELD_ACTIONS.some((h) => h.action === SHOW_CALCULATOR_TOOLS)).toBe(false);
    expect(Object.isFrozen(ST_CALC_ROWS)).toBe(true);
    expect(Object.isFrozen(ST_CALC_ROWS[0])).toBe(true);
  });

  it('declares no op, event, ask, export job, frame or install (a host tool, a row and a cap, nothing more)', () => {
    const u = unit as ExtUnit;
    expect(u.ops ?? {}).toEqual({});
    expect(u.events ?? {}).toEqual({});
    expect(u.asks ?? []).toEqual([]);
    expect(u.exportJobs ?? {}).toEqual({});
    expect(u.defineFrames ?? {}).toEqual({});
    expect(u.install).toBeUndefined();
    expect(u.hostTools).toEqual({ pcb_calculator: 'calculator' });
  });
});

describe('pcb_calculator as kicadWebOpenTool hands it', () => {
  it('maps every spelling KiCad may pass (a bare name, a path, .exe) to "calculator", and nothing else', () => {
    for (const raw of ['pcb_calculator', '/usr/bin/pcb_calculator', 'C:\\KiCad\\bin\\pcb_calculator.exe', 'pcb_calculator.EXE']) {
      expect(hostToolFor(raw)).toBe('calculator');
    }
    for (const raw of ['pcbnew', 'eeschema', 'gerbview', 'pcb_calculatorx', 'calculator', '']) {
      expect(hostToolFor(raw)).not.toBe('calculator');
    }
  });

  it('the responder sends ev.openTool { frame: "calculator" } with exactly its protocol keys', async () => {
    const t = await boot('pcb', RUN14);
    t.r.emit({ type: 'ev.openTool', frame: hostToolFor(CALCULATOR_TOOL)! });
    await settle();
    expect(t.got.filter((m) => m.type === 'ev.openTool')).toEqual([{ type: 'ev.openTool', frame: 'calculator' }]);
  });
});

describe('openCalculator, feature detected', () => {
  it('lists the cap in sch and pcb only, on an engine with kicadHostActions', () => {
    const caps = unit.caps!;
    for (const f of ['sch', 'pcb'] as const) {
      expect(caps(RUN14, f)).toEqual([OPEN_CALCULATOR_CAP]);
      expect(caps({}, f)).toEqual([]);
    }
    for (const f of ['symedit', 'fpedit', 'ds'] as const) expect(caps(RUN14, f as never)).toEqual([]);
  });

  it('ev.ready lists openCalculator in pcb and sch on run 14, and not without the marker', async () => {
    expect((await boot('pcb', RUN14)).ready?.caps).toContain(OPEN_CALCULATOR_CAP);
    expect((await boot('sch', RUN14)).ready?.caps).toContain(OPEN_CALCULATOR_CAP);
    expect((await boot('pcb', {})).ready?.caps ?? []).not.toContain(OPEN_CALCULATOR_CAP);
  });

  it('with no document open the slot lets KiCad run the action (admit stands first)', async () => {
    const t = await boot('pcb', RUN14);
    expect(t.win.kicadHostAction!.onRequest!(JSON.stringify({ action: SHOW_CALCULATOR_TOOLS }))).toBe(false);
    expect(t.got.filter((m) => m.type === 'ev.held')).toEqual([]);
  });
});

describe('the row as the responder takes it (bridge/held.ts heldTaken over the union)', () => {
  const union = heldActions(buildRegistry(mods(unit)));
  const take = (f: 'sch' | 'pcb' | 'symedit', caps: string[]) => heldTaken(SHOW_CALCULATOR_TOOLS, f, caps, union);

  it('takes Calculator Tools in sch and pcb under openCalculator, never without it, never in symedit', () => {
    expect(take('sch', [OPEN_CALCULATOR_CAP])).toBe(true);
    expect(take('pcb', [OPEN_CALCULATOR_CAP])).toBe(true);
    expect(take('pcb', ['heldKeys'])).toBe(false);
    expect(take('sch', [])).toBe(false);
    expect(take('symedit', [OPEN_CALCULATOR_CAP, 'symedit'])).toBe(false);
  });
});
