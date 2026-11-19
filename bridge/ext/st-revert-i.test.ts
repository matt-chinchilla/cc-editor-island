// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-revert-i: KiCad's New, Open, Save As, Save a Copy and Revert are held in
// a sch and a pcb frame under heldKeys, so the host's File card stands in their
// place. The engine here is this test's own module of exports; the real engine
// is the e2e's (tests/e2e/st/st-revert-i.spec.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startResponder } from '../responder';
import { HELD_ACTIONS, heldTaken } from '../held';
import type { ExtUnit } from './contract';
import { buildRegistry, heldActions, REGISTRY } from './registry';
import unit, { NEW, OPEN, REVERT, SAVE_AS, SAVE_COPY, ST_REVERT_ROWS } from './st-revert-i';

const PARENT = 'http://localhost';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));
const ENGINE = { kicadHostActions: () => true };

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

/** A responder with this unit alone, booted in a frame of `kind` with no document open. */
async function boot(kind: 'sch' | 'pcb') {
  const reg = buildRegistry(mods(unit));
  expect(reg.problems).toEqual([]);
  const { page, parent } = fakePage(`?frame=${kind}&theme=day`);
  const r = startResponder({ parentOrigin: PARENT, page, ext: reg });
  const ch = new MessageChannel();
  const got: Array<Record<string, unknown>> = [];
  ch.port1.onmessage = (m) => got.push(m.data);
  page.dispatch('message', { origin: PARENT, source: page.parent, data: { type: 'cc.connect', nonce: parent.postMessage.mock.calls[0][0].nonce }, ports: [ch.port2] });
  const win = {
    FS: { analyzePath: () => ({ exists: false }), mkdirTree: () => {}, readdir: () => [], readFile: () => { throw new Error('ENOENT'); } },
    Module: { kicadOpenFileBusy: () => false, ...ENGINE },
    wxElementRegistry: { findAll: () => [kind === 'sch' ? { id: 'frame', typeName: 'SCH_EDIT_FRAME', name: 'SchematicFrame', visible: true } : { id: 'frame', typeName: 'PCB_EDIT_FRAME', name: 'PcbFrame', visible: true }], findByLabel: () => [] },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    dispatchEvent: () => true,
  } as unknown as ToolWindow & { kicadHostAction?: { onRequest?: (json: unknown) => boolean } };
  r.engineReady(win, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
  await settle();
  return { win, ready: got.find((m) => m.type === 'ev.ready') as { caps: string[] } | undefined, got };
}

const ACTIONS = [NEW, OPEN, SAVE_AS, SAVE_COPY, REVERT];

describe('the unit in the registry', () => {
  it('loads in this checkout with nothing broken, its rows in the union after the built ins', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect(REGISTRY.units.map((u) => u.unit)).toContain('st-revert-i');
    const union = heldActions();
    for (const row of ST_REVERT_ROWS) expect(union).toContainEqual(row);
    expect(union.slice(0, HELD_ACTIONS.length)).toEqual([...HELD_ACTIONS]);
  });

  it('holds exactly the record\'s five actions, each in a sch and a pcb frame under heldKeys', () => {
    expect(ACTIONS).toEqual(['common.Control.new', 'common.Control.open', 'common.Control.saveAs', 'common.Control.saveCopy', 'common.Control.revert']);
    expect(unit.held).toEqual(ACTIONS);
    expect(ST_REVERT_ROWS.map((r) => [r.action, [...r.frames], r.cap])).toEqual(ACTIONS.map((a) => [a, ['sch', 'pcb'], 'heldKeys']));
    expect(Object.isFrozen(ST_REVERT_ROWS)).toBe(true);
    for (const r of ST_REVERT_ROWS) {
      expect(Object.isFrozen(r)).toBe(true);
      expect(Object.isFrozen(r.frames)).toBe(true);
    }
  });

  it('no built in row holds any of them in a sch or a pcb frame', () => {
    for (const a of ACTIONS) {
      expect(HELD_ACTIONS.some((h) => h.action === a && (h.frames.includes('sch') || h.frames.includes('pcb'))), a).toBe(false);
    }
  });

  it('declares no op, cap, event, ask or export job (it holds five actions, nothing more)', () => {
    const u = unit as ExtUnit;
    expect(u.ops ?? {}).toEqual({});
    expect(u.capNames ?? []).toEqual([]);
    expect(u.caps).toBeUndefined();
    expect(u.events ?? {}).toEqual({});
    expect(u.asks ?? []).toEqual([]);
    expect(u.exportJobs ?? {}).toEqual({});
    expect(u.install).toBeUndefined();
  });
});

describe('the rows as the responder takes them (bridge/held.ts heldTaken over the union)', () => {
  const union = heldActions(buildRegistry(mods(unit)));
  const take = (a: string, f: 'sch' | 'pcb' | 'symedit', caps: string[]) => heldTaken(a, f, caps, union);

  it('takes each in a sch and a pcb frame while heldKeys is listed, and never without the cap', () => {
    for (const a of ACTIONS) {
      for (const f of ['sch', 'pcb'] as const) {
        expect(take(a, f, ['heldKeys']), `${a} ${f}`).toBe(true);
        expect(take(a, f, ['heldKeys', 'heldMenus']), `${a} ${f}`).toBe(true);
        expect(take(a, f, []), `${a} ${f}`).toBe(false);
        expect(take(a, f, ['heldMenus']), `${a} ${f}`).toBe(false);
      }
    }
  });

  it('adds nothing in a symedit frame (the built in table decides there)', () => {
    const builtIn = heldActions(buildRegistry({}));
    for (const a of ACTIONS) {
      expect(take(a, 'symedit', ['heldKeys', 'heldMenus', 'symedit']), a).toBe(heldTaken(a, 'symedit', ['heldKeys', 'heldMenus', 'symedit'], builtIn));
    }
    expect(take(NEW, 'symedit', ['heldKeys', 'heldMenus', 'symedit'])).toBe(false);
  });

  it('without this unit no row takes them in a sch or a pcb frame', () => {
    const none = heldActions(buildRegistry({}));
    for (const a of ACTIONS) for (const f of ['sch', 'pcb'] as const) expect(heldTaken(a, f, ['heldKeys'], none), `${a} ${f}`).toBe(false);
  });
});

describe('over a booted responder', () => {
  for (const kind of ['sch', 'pcb'] as const) {
    it(`${kind}: ev.ready lists heldKeys, and with no document open the slot lets KiCad run them`, async () => {
      const t = await boot(kind);
      expect(t.ready?.caps).toContain('heldKeys');
      const slot = t.win.kicadHostAction!.onRequest!;
      for (const a of ACTIONS) expect(slot(JSON.stringify({ action: a })), a).toBe(false);
      expect(t.got.filter((m) => m.type === 'ev.held')).toEqual([]);
    });
  }
});
