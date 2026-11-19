// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-links-i: KiCad's Show Footprint Associations in the held union, taken in a
// pcb frame only while ev.ready listed boardFootprints (the cap of
// board.footprints, which the host's Linked to block reads), and left to KiCad
// everywhere else. The engine here is this test's own module of exports; the
// real engine is the e2e's (tests/e2e/st/st-links-i.spec.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startResponder } from '../responder';
import { HELD_ACTIONS, heldTaken } from '../held';
import type { ExtUnit } from './contract';
import { buildRegistry, heldActions, REGISTRY } from './registry';
import unit, { LINKS_ACTION, LINKS_CAP, ST_LINKS_ROWS } from './st-links-i';

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
  return { r, win, got };
}

describe('the unit in the registry', () => {
  it('loads in this checkout with nothing broken, its row in the union after the built ins, held once', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect(REGISTRY.units.map((u) => u.unit)).toContain('st-links-i');
    const union = heldActions();
    for (const row of ST_LINKS_ROWS) expect(union).toContainEqual(row);
    expect(union.slice(0, HELD_ACTIONS.length)).toEqual([...HELD_ACTIONS]);
    expect(union.filter((h) => h.action === LINKS_ACTION)).toHaveLength(1);
  });

  it('holds exactly the record\'s one action, in a pcb frame under boardFootprints', () => {
    expect(LINKS_ACTION).toBe('pcbnew.InspectionTool.ShowFootprintAssociations');
    expect(LINKS_CAP).toBe('boardFootprints');
    expect(unit.held).toEqual([LINKS_ACTION]);
    expect(ST_LINKS_ROWS.map((r) => [r.action, [...r.frames], r.cap])).toEqual([
      ['pcbnew.InspectionTool.ShowFootprintAssociations', ['pcb'], 'boardFootprints'],
    ]);
    expect(Object.isFrozen(ST_LINKS_ROWS)).toBe(true);
    for (const r of ST_LINKS_ROWS) { expect(Object.isFrozen(r)).toBe(true); expect(Object.isFrozen(r.frames)).toBe(true); }
  });

  it('declares no op, cap, event, ask, frame or export job: boardFootprints ships with the island', () => {
    const u = unit as ExtUnit;
    expect(u.ops ?? {}).toEqual({});
    expect(u.opsWidened ?? {}).toEqual({});
    expect(u.capNames ?? []).toEqual([]);
    expect(u.caps).toBeUndefined();
    expect(u.events ?? {}).toEqual({});
    expect(u.asks ?? []).toEqual([]);
    expect(u.exportJobs ?? {}).toEqual({});
    expect(u.defineFrames ?? {}).toEqual({});
    expect(u.install).toBeUndefined();
    expect(REGISTRY.capNames.has(LINKS_CAP)).toBe(false);
  });
});

describe('the row as the responder takes it (bridge/held.ts heldTaken over the union)', () => {
  const union = heldActions(buildRegistry(mods(unit)));
  const take = (a: string, f: 'sch' | 'pcb' | 'symedit', caps: string[]) => heldTaken(a, f, caps, union);

  it('takes Show Footprint Associations in a pcb frame under boardFootprints only', () => {
    expect(take(LINKS_ACTION, 'pcb', ['heldKeys', LINKS_CAP])).toBe(true);
    expect(take(LINKS_ACTION, 'pcb', ['heldKeys'])).toBe(false);
    expect(take(LINKS_ACTION, 'pcb', ['heldKeys', 'boardEdit', 'footprintExchange'])).toBe(false);
    expect(take(LINKS_ACTION, 'sch', ['heldKeys', LINKS_CAP])).toBe(false);
    expect(take(LINKS_ACTION, 'symedit', ['heldKeys', LINKS_CAP])).toBe(false);
  });

  it('leaves an action no row names to KiCad', () => {
    expect(take('common.Control.zoomFitScreen', 'pcb', ['heldKeys', LINKS_CAP])).toBe(false);
  });
});

describe('the frame\'s slot', () => {
  it('with no document open lets KiCad run the action (admit stands first), and sends nothing', async () => {
    const t = await boot('pcb', { kicadHostActions: () => true, kicadBoardFootprints: () => '{}', kicadCollabBusy: () => false });
    const slot = t.win.kicadHostAction!.onRequest!;
    expect(slot(JSON.stringify({ action: LINKS_ACTION }))).toBe(false);
    expect(t.got.filter((m) => m.type === 'ev.held')).toEqual([]);
    t.r.close();
  });
});
