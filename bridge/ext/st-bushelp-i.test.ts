// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-bushelp-i: Show Bus Syntax Help held in the sch frame under heldKeys, its
// row in the union the responder and the doors table read, and the frame's
// slot taking it with one ev.held. The engine here is this test's own module
// of exports; the real engine is the e2e's (tests/e2e/st/st-bushelp-i.spec.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startResponder } from '../responder';
import { HELD_ACTIONS, heldTaken } from '../held';
import type { ExtUnit } from './contract';
import { buildRegistry, heldActions, REGISTRY } from './registry';
import unit, { SHOW_BUS_SYNTAX_HELP, ST_BUSHELP_ROWS } from './st-bushelp-i';

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
    wxElementRegistry: { findAll: () => [{ id: 'frame', typeName: 'SCH_EDIT_FRAME', name: 'SchematicFrame', visible: true }], findByLabel: () => [] },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    dispatchEvent: () => true,
  } as unknown as ToolWindow & { kicadHostAction?: { onRequest?: (json: unknown) => boolean } };
  r.engineReady(win, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
  await settle();
  return { win, ready: got.find((m) => m.type === 'ev.ready') as { caps: string[] } | undefined, got };
}

describe('the unit in the registry', () => {
  it('loads in this checkout with nothing broken, its row in the union after the built ins', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect(REGISTRY.units.map((u) => u.unit)).toContain('st-bushelp-i');
    const union = heldActions();
    for (const row of ST_BUSHELP_ROWS) expect(union).toContainEqual(row);
    expect(union.slice(0, HELD_ACTIONS.length)).toEqual([...HELD_ACTIONS]);
    expect(union.filter((r) => r.action === SHOW_BUS_SYNTAX_HELP)).toHaveLength(1);
  });

  it('holds exactly the record\'s one action in sch under heldKeys, no built in row holding it', () => {
    expect(SHOW_BUS_SYNTAX_HELP).toBe('eeschema.InspectionTool.showBusSyntaxHelp');
    expect(unit.held).toEqual([SHOW_BUS_SYNTAX_HELP]);
    expect(ST_BUSHELP_ROWS.map((r) => [r.action, [...r.frames], r.cap])).toEqual([[SHOW_BUS_SYNTAX_HELP, ['sch'], 'heldKeys']]);
    expect(HELD_ACTIONS.some((h) => h.action === SHOW_BUS_SYNTAX_HELP)).toBe(false);
    expect(Object.isFrozen(ST_BUSHELP_ROWS)).toBe(true);
    expect(Object.isFrozen(ST_BUSHELP_ROWS[0])).toBe(true);
  });

  it('declares no op, event, cap, ask, export job or install (it holds one row, nothing more)', () => {
    const u = unit as ExtUnit;
    expect(u.ops ?? {}).toEqual({});
    expect(u.opsWidened ?? {}).toEqual({});
    expect(u.events ?? {}).toEqual({});
    expect(u.capNames ?? []).toEqual([]);
    expect(u.caps).toBeUndefined();
    expect(u.asks ?? []).toEqual([]);
    expect(u.exportJobs ?? {}).toEqual({});
    expect(u.install).toBeUndefined();
  });
});

describe('the row as the responder takes it (bridge/held.ts heldTaken over the union)', () => {
  const union = heldActions(buildRegistry(mods(unit)));
  const take = (f: 'sch' | 'pcb' | 'symedit', caps: string[]) => heldTaken(SHOW_BUS_SYNTAX_HELP, f, caps, union);

  it('takes the action in sch under heldKeys, with or without heldMenus', () => {
    expect(take('sch', ['heldKeys'])).toBe(true);
    expect(take('sch', ['heldKeys', 'heldMenus'])).toBe(true);
  });

  it('never takes it without heldKeys, nor in another frame', () => {
    expect(take('sch', [])).toBe(false);
    expect(take('sch', ['heldMenus'])).toBe(false);
    expect(take('pcb', ['heldKeys', 'heldMenus'])).toBe(false);
    expect(take('symedit', ['heldKeys', 'heldMenus'])).toBe(false);
  });
});

describe('the frame\'s slot (kicadHostAction.onRequest)', () => {
  it('with no document open lets KiCad run it (admit stands first) and sends nothing', async () => {
    const t = await boot('sch', RUN14);
    expect(t.ready?.caps).toContain('heldKeys');
    const slot = t.win.kicadHostAction!.onRequest!;
    expect(slot(JSON.stringify({ action: SHOW_BUS_SYNTAX_HELP }))).toBe(false);
    expect(t.got.filter((m) => m.type === 'ev.held')).toEqual([]);
  });

  it('in a pcb frame leaves it to KiCad', async () => {
    const t = await boot('pcb', RUN14);
    const slot = t.win.kicadHostAction!.onRequest!;
    expect(slot(JSON.stringify({ action: SHOW_BUS_SYNTAX_HELP }))).toBe(false);
    expect(t.got.filter((m) => m.type === 'ev.held')).toEqual([]);
  });
});
