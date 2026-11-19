// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-copydraw-i: KiCad's Export Drawing to Clipboard is held in a schematic
// frame under heldKeys, so the host's Copy the drawing stands in its place. The
// engine here is this test's own module of exports; the real engine is the
// e2e's (tests/e2e/st/st-copydraw-i.spec.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startResponder } from '../responder';
import { HELD_ACTIONS, heldTaken } from '../held';
import type { ExtUnit } from './contract';
import { buildRegistry, heldActions, REGISTRY } from './registry';
import unit, { DRAW_SHEET_ON_CLIPBOARD, ST_COPYDRAW_ROWS } from './st-copydraw-i';

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

/** A responder with this unit alone, booted in a schematic frame with no document open. */
async function boot() {
  const reg = buildRegistry(mods(unit));
  expect(reg.problems).toEqual([]);
  const { page, parent } = fakePage('?frame=sch&theme=day');
  const r = startResponder({ parentOrigin: PARENT, page, ext: reg });
  const ch = new MessageChannel();
  const got: Array<Record<string, unknown>> = [];
  ch.port1.onmessage = (m) => got.push(m.data);
  page.dispatch('message', { origin: PARENT, source: page.parent, data: { type: 'cc.connect', nonce: parent.postMessage.mock.calls[0][0].nonce }, ports: [ch.port2] });
  const win = {
    FS: { analyzePath: () => ({ exists: false }), mkdirTree: () => {}, readdir: () => [], readFile: () => { throw new Error('ENOENT'); } },
    Module: { kicadOpenFileBusy: () => false, ...ENGINE },
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
    expect(REGISTRY.units.map((u) => u.unit)).toContain('st-copydraw-i');
    const union = heldActions();
    for (const row of ST_COPYDRAW_ROWS) expect(union).toContainEqual(row);
    expect(union.slice(0, HELD_ACTIONS.length)).toEqual([...HELD_ACTIONS]);
  });

  it('holds exactly the record\'s one action, in a sch frame under heldKeys, held by no built in row', () => {
    expect(DRAW_SHEET_ON_CLIPBOARD).toBe('eeschema.EditorControl.drawSheetOnClipboard');
    expect(unit.held).toEqual([DRAW_SHEET_ON_CLIPBOARD]);
    expect(ST_COPYDRAW_ROWS.map((r) => [r.action, [...r.frames], r.cap])).toEqual([[DRAW_SHEET_ON_CLIPBOARD, ['sch'], 'heldKeys']]);
    expect(HELD_ACTIONS.some((h) => h.action === DRAW_SHEET_ON_CLIPBOARD)).toBe(false);
    expect(Object.isFrozen(ST_COPYDRAW_ROWS)).toBe(true);
    expect(Object.isFrozen(ST_COPYDRAW_ROWS[0].frames)).toBe(true);
  });

  it('declares no op, cap, event, ask or export job (it holds one action, nothing more)', () => {
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

describe('the row as the responder takes it (bridge/held.ts heldTaken over the union)', () => {
  const union = heldActions(buildRegistry(mods(unit)));
  const take = (f: 'sch' | 'pcb' | 'symedit', caps: string[]) => heldTaken(DRAW_SHEET_ON_CLIPBOARD, f, caps, union);

  it('takes it in a sch frame while heldKeys is listed, and never without the cap', () => {
    expect(take('sch', ['heldKeys'])).toBe(true);
    expect(take('sch', ['heldKeys', 'heldMenus'])).toBe(true);
    expect(take('sch', [])).toBe(false);
    expect(take('sch', ['heldMenus'])).toBe(false);
  });

  it('leaves it to KiCad in every other frame', () => {
    expect(take('pcb', ['heldKeys', 'heldMenus'])).toBe(false);
    expect(take('symedit', ['heldKeys', 'heldMenus'])).toBe(false);
  });

  it('without this unit no row takes it', () => {
    expect(heldTaken(DRAW_SHEET_ON_CLIPBOARD, 'sch', ['heldKeys'], heldActions(buildRegistry({})))).toBe(false);
  });
});

describe('over a booted responder', () => {
  it('ev.ready lists heldKeys, and with no document open the slot lets KiCad run it', async () => {
    const t = await boot();
    expect(t.ready?.caps).toContain('heldKeys');
    const slot = t.win.kicadHostAction!.onRequest!;
    expect(slot(JSON.stringify({ action: DRAW_SHEET_ON_CLIPBOARD }))).toBe(false);
    expect(t.got.filter((m) => m.type === 'ev.held')).toEqual([]);
  });
});
