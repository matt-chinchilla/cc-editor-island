// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-hold-i: the heldMenus cap, feature detected on the engine's markers, and
// the unit's held rows in the union the responder and the doors table read.
// The engine here is this test's own module of exports; the real engine is the
// e2e's (tests/e2e/st/st-hold-i.spec.ts, tests/e2e/st/st-hold-all.spec.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startResponder } from '../responder';
import { HELD_ACTIONS, heldTaken } from '../held';
import type { ExtUnit } from './contract';
import { buildRegistry, heldActions, REGISTRY } from './registry';
import unit, { HELD_MENUS_CAP, HELD_MENUS_EXPORT, SET_LANGUAGE, ST_HOLD_ROWS } from './st-hold-i';

const PARENT = 'http://localhost';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));
const RUN15 = { kicadHostActions: () => true, kicadHeldMenus: () => true };
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
  it('loads in this checkout with nothing broken, its rows in the union after the built ins', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect(REGISTRY.units.map((u) => u.unit)).toContain('st-hold-i');
    expect(REGISTRY.capNames.get(HELD_MENUS_CAP)).toBe('st-hold-i');
    const union = heldActions();
    for (const row of ST_HOLD_ROWS) expect(union).toContainEqual(row);
    expect(union.slice(0, HELD_ACTIONS.length)).toEqual([...HELD_ACTIONS]);
  });

  it('holds exactly the record\'s five actions, each named once, none held by a built in row', () => {
    expect(unit.held).toEqual([SET_LANGUAGE, 'eeschema.RemoteSymbols.showPanel', 'common.API.pluginsReload', 'pcbnew.ScriptingTool.pluginsShowFolder', 'pcbnew.Control.showPythonConsole']);
    expect(ST_HOLD_ROWS.map((r) => [r.action, [...r.frames], r.cap])).toEqual([
      [SET_LANGUAGE, ['sch', 'pcb', 'symedit'], 'heldMenus'],
      ['eeschema.RemoteSymbols.showPanel', ['sch'], 'heldKeys'],
      ['common.API.pluginsReload', ['sch', 'pcb'], 'heldKeys'],
      ['pcbnew.ScriptingTool.pluginsShowFolder', ['pcb'], 'heldKeys'],
      ['pcbnew.Control.showPythonConsole', ['pcb'], 'heldKeys'],
    ]);
    const builtin = new Set(HELD_ACTIONS.map((h) => h.action));
    for (const a of unit.held) expect(builtin.has(a)).toBe(false);
    expect(Object.isFrozen(ST_HOLD_ROWS)).toBe(true);
  });

  it('declares no op, event, ask or export job (it holds and lists one cap, nothing more)', () => {
    const u = unit as ExtUnit;
    expect(u.ops ?? {}).toEqual({});
    expect(u.events ?? {}).toEqual({});
    expect(u.asks ?? []).toEqual([]);
    expect(u.exportJobs ?? {}).toEqual({});
    expect(u.install).toBeUndefined();
  });
});

describe('heldMenus, feature detected', () => {
  it('lists the cap in sch, pcb and symedit only on an engine with both markers', () => {
    const caps = unit.caps!;
    for (const f of ['sch', 'pcb', 'symedit'] as const) {
      expect(caps(RUN15, f)).toEqual([HELD_MENUS_CAP]);
      expect(caps(RUN14, f)).toEqual([]);
      expect(caps({ [HELD_MENUS_EXPORT]: () => true }, f)).toEqual([]);
      expect(caps({}, f)).toEqual([]);
    }
    expect(caps(RUN15, 'fpedit' as never)).toEqual([]);
  });

  it('ev.ready lists heldMenus beside heldKeys on run 15, and neither cap of ours on run 14', async () => {
    const t15 = await boot('pcb', RUN15);
    expect(t15.ready?.caps).toEqual(expect.arrayContaining(['heldKeys', HELD_MENUS_CAP]));
    expect(typeof t15.win.kicadHostAction?.onRequest).toBe('function');
    const t14 = await boot('pcb', RUN14);
    expect(t14.ready?.caps).toContain('heldKeys');
    expect(t14.ready?.caps).not.toContain(HELD_MENUS_CAP);
  });

  it('with no document open the slot lets KiCad run every row (admit stands first)', async () => {
    const t = await boot('sch', RUN15);
    const slot = t.win.kicadHostAction!.onRequest!;
    for (const a of unit.held) expect(slot(JSON.stringify({ action: a }))).toBe(false);
    expect(t.got.filter((m) => m.type === 'ev.held')).toEqual([]);
  });
});

describe('the rows as the responder takes them (bridge/held.ts heldTaken over the union)', () => {
  const union = heldActions(buildRegistry(mods(unit)));
  const take = (a: string, f: 'sch' | 'pcb' | 'symedit', caps: string[]) => heldTaken(a, f, caps, union);
  const BOTH = ['heldKeys', HELD_MENUS_CAP];

  it('takes Set Language in every editor frame under heldMenus, never on an engine without it', () => {
    for (const f of ['sch', 'pcb', 'symedit'] as const) {
      expect(take(SET_LANGUAGE, f, BOTH)).toBe(true);
      expect(take(SET_LANGUAGE, f, ['heldKeys'])).toBe(false);
    }
  });

  it('takes each heldKeys row only in its own frames', () => {
    expect(take('eeschema.RemoteSymbols.showPanel', 'sch', BOTH)).toBe(true);
    expect(take('eeschema.RemoteSymbols.showPanel', 'pcb', BOTH)).toBe(false);
    expect(take('common.API.pluginsReload', 'sch', ['heldKeys'])).toBe(true);
    expect(take('common.API.pluginsReload', 'pcb', ['heldKeys'])).toBe(true);
    expect(take('common.API.pluginsReload', 'symedit', BOTH)).toBe(false);
    expect(take('pcbnew.ScriptingTool.pluginsShowFolder', 'pcb', ['heldKeys'])).toBe(true);
    expect(take('pcbnew.ScriptingTool.pluginsShowFolder', 'sch', BOTH)).toBe(false);
    expect(take('pcbnew.Control.showPythonConsole', 'pcb', ['heldKeys'])).toBe(true);
    expect(take('pcbnew.Control.showPythonConsole', 'sch', BOTH)).toBe(false);
    for (const a of unit.held.slice(1)) expect(take(a, 'pcb', [])).toBe(false);
  });

  it('leaves an action of KiCad no row names to KiCad, menu or key', () => {
    expect(take('common.Control.zoomFitScreen', 'pcb', BOTH)).toBe(false);
  });
});
