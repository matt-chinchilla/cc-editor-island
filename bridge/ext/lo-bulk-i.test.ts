// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// lo-bulk-i: the nine Change, Update and Zone manager rows in the held union,
// each in its frame under the cap of the op the host's Edit in bulk page runs,
// and the doors table reading all nine as held with nothing waiting. The
// engine here is this test's own module of exports; the real engine is the
// e2e's (tests/e2e/lo/bulk-held.spec.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startResponder } from '../responder';
import { HELD_ACTIONS, heldTaken } from '../held';
import type { ExtUnit } from './contract';
import { buildRegistry, heldActions, REGISTRY } from './registry';
import { doorOf, doorRow } from './m1-i/doors';
import unit, {
  BOARD_EDIT_CAP, FOOTPRINT_ACTIONS, FOOTPRINT_EXCHANGE_CAP, LO_BULK_ROWS, SYMBOL_ACTIONS, SYMBOL_EXCHANGE_CAP, ZONES_MANAGER,
} from './lo-bulk-i';

const PARENT = 'http://localhost';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));
const NINE = [...SYMBOL_ACTIONS, ...FOOTPRINT_ACTIONS, ZONES_MANAGER];

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
  return { r, win, got };
}

describe('the unit in the registry', () => {
  it('loads in this checkout with nothing broken, its rows in the union after the built ins', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect(REGISTRY.units.map((u) => u.unit)).toContain('lo-bulk-i');
    const union = heldActions();
    for (const row of LO_BULK_ROWS) expect(union).toContainEqual(row);
    expect(union.slice(0, HELD_ACTIONS.length)).toEqual([...HELD_ACTIONS]);
    // Each of the nine is held once in the union: no built in row and no other unit holds it.
    for (const a of NINE) expect(union.filter((h) => h.action === a), a).toHaveLength(1);
  });

  it('holds exactly the record\'s nine actions, each in its frame under the cap of the host\'s op', () => {
    expect(unit.held).toEqual(NINE);
    expect(LO_BULK_ROWS.map((r) => [r.action, [...r.frames], r.cap])).toEqual([
      ['eeschema.InteractiveEdit.changeSymbol', ['sch'], 'symbolExchange'],
      ['eeschema.InteractiveEdit.changeSymbols', ['sch'], 'symbolExchange'],
      ['eeschema.InteractiveEdit.updateSymbol', ['sch'], 'symbolExchange'],
      ['eeschema.InteractiveEdit.updateSymbols', ['sch'], 'symbolExchange'],
      ['pcbnew.GlobalEdit.changeFootprint', ['pcb'], 'footprintExchange'],
      ['pcbnew.GlobalEdit.changeFootprints', ['pcb'], 'footprintExchange'],
      ['pcbnew.GlobalEdit.updateFootprint', ['pcb'], 'footprintExchange'],
      ['pcbnew.GlobalEdit.updateFootprints', ['pcb'], 'footprintExchange'],
      ['pcbnew.Control.zonesManager', ['pcb'], 'boardEdit'],
    ]);
    expect(Object.isFrozen(LO_BULK_ROWS)).toBe(true);
    for (const r of LO_BULK_ROWS) { expect(Object.isFrozen(r)).toBe(true); expect(Object.isFrozen(r.frames)).toBe(true); }
  });

  it('declares no op, cap, event, ask, frame or export job: the caps it waits on ship with the island', () => {
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
    // The three caps are the built in ones of symbols.exchange, footprints.exchange and board.edit.
    for (const c of [SYMBOL_EXCHANGE_CAP, FOOTPRINT_EXCHANGE_CAP, BOARD_EDIT_CAP]) expect(REGISTRY.capNames.has(c), c).toBe(false);
  });
});

describe('the doors table reads the nine as held', () => {
  it('names each row held, reviewed for this unit, and opening the window the page replaces', () => {
    for (const a of SYMBOL_ACTIONS) expect(doorRow(a), a).toMatchObject({ door: 'held', opens: 'DIALOG_CHANGE_SYMBOLS' });
    for (const a of FOOTPRINT_ACTIONS) expect(doorRow(a), a).toMatchObject({ door: 'held', opens: 'DIALOG_EXCHANGE_FOOTPRINTS' });
    expect(doorRow(ZONES_MANAGER)).toMatchObject({ door: 'held', opens: 'DIALOG_ZONE_MANAGER' });
    for (const a of NINE) expect(doorRow(a)!.why, a).toContain('lo-bulk-i');
  });

  it('gives each a held door in its frame while the cap is listed, and none where it is not', () => {
    const union = heldActions();
    for (const a of SYMBOL_ACTIONS) {
      expect(doorOf(a, 'sch', [SYMBOL_EXCHANGE_CAP], union), a).toBe('held');
      expect(doorOf(a, 'sch', [], union), a).toBeNull();
    }
    for (const a of FOOTPRINT_ACTIONS) {
      expect(doorOf(a, 'pcb', [FOOTPRINT_EXCHANGE_CAP], union), a).toBe('held');
      expect(doorOf(a, 'pcb', [BOARD_EDIT_CAP], union), a).toBeNull();
    }
    expect(doorOf(ZONES_MANAGER, 'pcb', [BOARD_EDIT_CAP], union)).toBe('held');
    expect(doorOf(ZONES_MANAGER, 'pcb', [FOOTPRINT_EXCHANGE_CAP], union)).toBeNull();
  });
});

describe('the rows as the responder takes them (bridge/held.ts heldTaken over the union)', () => {
  const union = heldActions(buildRegistry(mods(unit)));
  const take = (a: string, f: 'sch' | 'pcb' | 'symedit', caps: string[]) => heldTaken(a, f, caps, union);
  const SCH = ['heldKeys', SYMBOL_EXCHANGE_CAP];
  const PCB = ['heldKeys', FOOTPRINT_EXCHANGE_CAP, BOARD_EDIT_CAP];

  it('takes the symbol actions in a sch frame under symbolExchange only', () => {
    for (const a of SYMBOL_ACTIONS) {
      expect(take(a, 'sch', SCH), a).toBe(true);
      expect(take(a, 'sch', ['heldKeys']), a).toBe(false);
      expect(take(a, 'pcb', [...PCB, SYMBOL_EXCHANGE_CAP]), a).toBe(false);
      expect(take(a, 'symedit', SCH), a).toBe(false);
    }
  });

  it('takes the footprint actions in a pcb frame under footprintExchange only', () => {
    for (const a of FOOTPRINT_ACTIONS) {
      expect(take(a, 'pcb', PCB), a).toBe(true);
      expect(take(a, 'pcb', ['heldKeys', BOARD_EDIT_CAP]), a).toBe(false);
      expect(take(a, 'sch', [...SCH, FOOTPRINT_EXCHANGE_CAP]), a).toBe(false);
    }
  });

  it('takes the Zone manager in a pcb frame under boardEdit only', () => {
    expect(take(ZONES_MANAGER, 'pcb', PCB)).toBe(true);
    expect(take(ZONES_MANAGER, 'pcb', ['heldKeys', FOOTPRINT_EXCHANGE_CAP])).toBe(false);
    expect(take(ZONES_MANAGER, 'sch', [...SCH, BOARD_EDIT_CAP])).toBe(false);
  });

  it('leaves an action of KiCad no row names to KiCad', () => {
    expect(take('pcbnew.Control.zoneFillAll', 'pcb', PCB)).toBe(false);
    expect(take('eeschema.InteractiveEdit.editWithLibEdit', 'sch', SCH)).toBe(false);
  });
});

describe('the frame\'s slot', () => {
  it('with no document open lets KiCad run every row (admit stands first), and sends nothing', async () => {
    for (const frame of ['sch', 'pcb']) {
      const t = await boot(frame, { kicadHostActions: () => true });
      const slot = t.win.kicadHostAction!.onRequest!;
      for (const a of NINE) expect(slot(JSON.stringify({ action: a })), `${frame} ${a}`).toBe(false);
      expect(t.got.filter((m) => m.type === 'ev.held')).toEqual([]);
      t.r.close();
    }
  });
});
