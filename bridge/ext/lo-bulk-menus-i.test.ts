// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// lo-bulk-menus-i: the ten bulk edit actions of KiCad's own menus that
// lo-bulk-i's nine leave out, each in its frame under the cap of the op the
// host's Edit in bulk page runs. Before this unit the smoke pass of
// 2026-11-19 saw KiCad's own Set Track and Via Properties and Edit Text and
// Graphic Properties windows open from KiCad's Edit menu. The engine here is
// this test's own module of exports.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startResponder } from '../responder';
import { HELD_ACTIONS, heldTaken } from '../held';
import type { ExtUnit } from './contract';
import { buildRegistry, heldActions, REGISTRY } from './registry';
import fpEditor from './fp-i6';
import bulk from './lo-bulk-i';
import unit, { BOARD_ACTIONS, BOARD_EDIT_CAP, LO_BULK_MENU_ROWS, SCH_ACTIONS, SCH_EDIT_CAP } from './lo-bulk-menus-i';

const PARENT = 'http://localhost';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));
const TEN = [...BOARD_ACTIONS, ...SCH_ACTIONS];

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
    expect(REGISTRY.units.map((u) => u.unit)).toContain('lo-bulk-menus-i');
    const union = heldActions();
    for (const row of LO_BULK_MENU_ROWS) expect(union).toContainEqual(row);
    expect(union.slice(0, HELD_ACTIONS.length)).toEqual([...HELD_ACTIONS]);
    // No built in row holds any of them, and none is held twice in one frame.
    for (const a of TEN) expect(HELD_ACTIONS.some((h) => h.action === a), a).toBe(false);
    for (const row of LO_BULK_MENU_ROWS) for (const f of row.frames) expect(union.filter((h) => h.action === row.action && (h.frames as readonly string[]).includes(f)), `${row.action} ${f}`).toHaveLength(1);
  });

  it('holds exactly the ten actions, each in its frame under the cap of the host\'s op', () => {
    expect(unit.held).toEqual(TEN);
    expect(LO_BULK_MENU_ROWS.map((r) => [r.action, [...r.frames], r.cap])).toEqual([
      ['pcbnew.GlobalEdit.editTracksAndVias', ['pcb'], 'boardEdit'],
      ['pcbnew.GlobalEdit.editTextAndGraphics', ['pcb'], 'boardEdit'],
      ['pcbnew.GlobalEdit.editTeardrops', ['pcb'], 'boardEdit'],
      ['pcbnew.GlobalEdit.swapLayers', ['pcb'], 'boardEdit'],
      ['pcbnew.GlobalEdit.globalDeletions', ['pcb'], 'boardEdit'],
      ['pcbnew.GlobalEdit.cleanupTracksAndVias', ['pcb'], 'boardEdit'],
      ['pcbnew.GlobalEdit.removeUnusedPads', ['pcb'], 'boardEdit'],
      ['pcbnew.GlobalEdit.cleanupGraphics', ['pcb'], 'boardEdit'],
      ['pcbnew.Control.repairBoard', ['pcb'], 'boardEdit'],
      ['eeschema.InteractiveEdit.editTextAndGraphics', ['sch'], 'schEdit'],
    ]);
    expect(Object.isFrozen(LO_BULK_MENU_ROWS)).toBe(true);
    for (const r of LO_BULK_MENU_ROWS) { expect(Object.isFrozen(r)).toBe(true); expect(Object.isFrozen(r.frames)).toBe(true); }
  });

  it('names none of lo-bulk-i\'s nine, and shares two actions with the footprint editor only across frames', () => {
    for (const a of TEN) expect(bulk.held).not.toContain(a);
    const shared = TEN.filter((a) => fpEditor.held?.includes(a));
    expect(shared).toEqual(['pcbnew.GlobalEdit.editTextAndGraphics', 'pcbnew.GlobalEdit.cleanupGraphics']);
    // In the whole registry each of the two stands in two rows, the footprint editor's frame and the board's.
    const union = heldActions();
    for (const a of shared) expect(union.filter((h) => h.action === a).map((h) => [...h.frames]).sort(), a).toEqual([['fpedit'], ['pcb']]);
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
    for (const c of [BOARD_EDIT_CAP, SCH_EDIT_CAP]) expect(REGISTRY.capNames.has(c), c).toBe(false);
  });
});

describe('the rows as the responder takes them (bridge/held.ts heldTaken over the union)', () => {
  const union = heldActions(buildRegistry(mods(unit)));
  const take = (a: string, f: 'sch' | 'pcb' | 'symedit', caps: string[]) => heldTaken(a, f, caps, union);
  const SCH = ['heldKeys', SCH_EDIT_CAP];
  const PCB = ['heldKeys', BOARD_EDIT_CAP];

  it('takes the nine board actions in a pcb frame under boardEdit only', () => {
    for (const a of BOARD_ACTIONS) {
      expect(take(a, 'pcb', PCB), a).toBe(true);
      expect(take(a, 'pcb', ['heldKeys', 'footprintExchange']), a).toBe(false);
      expect(take(a, 'sch', [...SCH, BOARD_EDIT_CAP]), a).toBe(false);
    }
  });

  it('takes the schematic\'s Edit Text and Graphics in a sch frame under schEdit only', () => {
    for (const a of SCH_ACTIONS) {
      expect(take(a, 'sch', SCH), a).toBe(true);
      expect(take(a, 'sch', ['heldKeys', 'symbolExchange']), a).toBe(false);
      expect(take(a, 'pcb', [...PCB, SCH_EDIT_CAP]), a).toBe(false);
      expect(take(a, 'symedit', SCH), a).toBe(false);
    }
  });

  it('leaves an action of KiCad no row names to KiCad', () => {
    expect(take('pcbnew.Control.zoneFillAll', 'pcb', PCB)).toBe(false);
    expect(take('pcbnew.GlobalEdit.editTextAndGraphics', 'sch', [...SCH, BOARD_EDIT_CAP])).toBe(false);
  });
});

describe('the frame\'s slot', () => {
  it('with no document open lets KiCad run every row (admit stands first), and sends nothing', async () => {
    for (const frame of ['sch', 'pcb']) {
      const t = await boot(frame, { kicadHostActions: () => true });
      const slot = t.win.kicadHostAction!.onRequest!;
      for (const a of TEN) expect(slot(JSON.stringify({ action: a })), `${frame} ${a}`).toBe(false);
      expect(t.got.filter((m) => m.type === 'ev.held')).toEqual([]);
      t.r.close();
    }
  });
});
