// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-routing-i: the board sections router and layerPairs taken by
// settings.get and settings.set in a pcb frame, their values read closed on
// KiCad's keys, the caps feature detected on the engine's section marker, and
// KiCad's three router windows held in the pcb frame under those caps. The
// engine here is this test's own module of exports; the real engine is the
// e2e's (tests/e2e/st/st-routing-i.spec.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HELD_ACTIONS, heldTaken } from '../held';
import { startResponder } from '../responder';
import { parseSettingsGetArgs, parseSettingsSetArgs, sectionFrames } from '../settings';
import type { ExtUnit } from './contract';
import { buildRegistry, heldActions, REGISTRY } from './registry';
import unit, {
  boardSections, CURRENT_SIZES, DIFF_PAIR_DIALOG, LAYER_PAIRS, LAYER_PAIRS_CAP, layerPairsFits, MAX_LAYER_PAIRS, ROUTER, ROUTER_CAP,
  ROUTER_SWITCHES, routerFits, routingCaps, ROUTING_ROWS, ROUTING_SECTIONS, SECTIONS_EXPORT, SELECT_LAYER_PAIR, SETTINGS_DIALOG,
} from './st-routing-i';

const PARENT = 'http://localhost';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));
const sections = (board: string[], schematic: string[]) => () => JSON.stringify({ board, schematic });
const RUN14 = { kicadSettingsGet: () => '', kicadSettingsSet: () => true, kicadCollabBusy: () => false, kicadHostActions: () => true };
const RUN15 = { ...RUN14, [SECTIONS_EXPORT]: sections(['constraints', ROUTER, LAYER_PAIRS, 'origins'], ['pinMap']) };
const ACTIONS = [SETTINGS_DIALOG, SELECT_LAYER_PAIR, DIFF_PAIR_DIALOG];

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

/** A responder with this unit alone, booted in `frame` on an engine with `exports`, no document open. */
async function boot(frame: 'sch' | 'pcb', exports: Record<string, unknown>) {
  const reg = buildRegistry(mods(unit));
  expect(reg.problems).toEqual([]);
  const { page, parent } = fakePage(`?frame=${frame}&theme=day`);
  const r = startResponder({ parentOrigin: PARENT, page, ext: reg });
  const ch = new MessageChannel();
  const got: Array<Record<string, unknown>> = [];
  ch.port1.onmessage = (m) => got.push(m.data);
  page.dispatch('message', { origin: PARENT, source: page.parent, data: { type: 'cc.connect', nonce: parent.postMessage.mock.calls[0][0].nonce }, ports: [ch.port2] });
  const get = vi.fn(() => '');
  const set = vi.fn(() => true);
  const win = {
    FS: { analyzePath: () => ({ exists: false }), mkdirTree: () => {}, readdir: () => [], readFile: () => { throw new Error('ENOENT'); } },
    Module: { kicadOpenFileBusy: () => false, ...exports, kicadSettingsGet: get, kicadSettingsSet: set },
    wxElementRegistry: { findAll: () => [{ id: 'frame', typeName: frame === 'pcb' ? 'PCB_EDIT_FRAME' : 'SCH_EDIT_FRAME', name: 'Frame', visible: true }], findByLabel: () => [] },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    dispatchEvent: () => true,
  } as unknown as ToolWindow & { kicadHostAction?: { onRequest?: (json: unknown) => boolean } };
  r.engineReady(win, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
  await settle();
  const ask = async (id: number, op: string, args?: unknown) => {
    ch.port1.postMessage(args === undefined ? { id, op } : { id, op, args });
    await settle();
    return got.find((m) => m.id === id);
  };
  return { r, win, got, ready: got.find((m) => m.type === 'ev.ready') as { caps: string[] } | undefined, ask, get, set };
}

describe('the unit in the registry', () => {
  it('loads in this checkout with nothing broken: its two caps, its two sections and its three held rows', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect(REGISTRY.units.map((u) => u.unit)).toContain('st-routing-i');
    for (const cap of [ROUTER_CAP, LAYER_PAIRS_CAP]) expect(REGISTRY.capNames.get(cap)).toBe('st-routing-i');
    for (const s of [ROUTER, LAYER_PAIRS]) expect(REGISTRY.settingsSections.get(s)?.unit).toBe('st-routing-i');
    const union = heldActions();
    for (const row of ROUTING_ROWS) expect(union).toContainEqual(row);
    expect(union.slice(0, HELD_ACTIONS.length)).toEqual([...HELD_ACTIONS]);
    // Held once in the pcb frame, by this unit alone.
    for (const a of ACTIONS) expect(union.filter((h) => h.action === a && (h.frames as readonly string[]).includes('pcb')), a).toHaveLength(1);
  });

  it('names exactly the record\'s caps, held rows and frames, and no op, event, ask, export job or widening', () => {
    const u = unit as ExtUnit;
    expect(u.capNames).toEqual(['settings:router', 'settings:layerPairs']);
    expect(u.held).toEqual(['pcbnew.InteractiveRouter.SettingsDialog', 'pcbnew.InteractiveRouter.SelectLayerPair', 'pcbnew.InteractiveRouter.DiffPairDialog']);
    expect(ROUTING_ROWS.map((r) => [r.action, [...r.frames], r.cap])).toEqual([
      ['pcbnew.InteractiveRouter.SettingsDialog', ['pcb'], 'settings:router'],
      ['pcbnew.InteractiveRouter.SelectLayerPair', ['pcb'], 'settings:layerPairs'],
      ['pcbnew.InteractiveRouter.DiffPairDialog', ['pcb'], 'settings:router'],
    ]);
    expect(Object.isFrozen(ROUTING_ROWS)).toBe(true);
    for (const r of ROUTING_ROWS) { expect(Object.isFrozen(r)).toBe(true); expect(Object.isFrozen(r.frames)).toBe(true); }
    expect(Object.keys(u.settingsSections ?? {})).toEqual([ROUTER, LAYER_PAIRS]);
    for (const empty of [u.ops, u.events, u.exportJobs, u.opsWidened, u.defineFrames, u.hostTools, u.exportHooks, u.eventGuards]) expect(empty ?? {}).toEqual({});
    expect(u.asks ?? []).toEqual([]);
    expect(u.install).toBeUndefined();
  });
});

describe('the two sections, as bridge/settings.ts takes them', () => {
  const extra = buildRegistry(mods(unit)).settingsSections;

  it('lives in the pcb frame alone, and only with this unit', () => {
    for (const s of [ROUTER, LAYER_PAIRS]) {
      expect(sectionFrames(s, extra)).toEqual(['pcb']);
      expect(sectionFrames(s)).toEqual([]);
      expect(parseSettingsGetArgs({ section: s }, extra)).toEqual({ section: s });
      expect(parseSettingsGetArgs({ section: s })).toBeNull();
    }
    for (const s of Object.values(ROUTING_SECTIONS)) { expect(s.projectFile).toBeUndefined(); expect(s.pcbReadOnly).toBeUndefined(); }
  });

  it('takes a router value of KiCad\'s keys, each its kind, with an optional dryRun', () => {
    const takes: Array<Record<string, unknown>> = [
      { mode: 1 },
      { mode: 0, effort: 2 },
      { shove_vias: false, auto_posture: true },
      { currentTrack: { index: 0 } },
      { currentTrack: { customWidth: 0.4, custom: true } },
      { currentVia: { custom: true, customDiameter: 0.8, customDrill: 0.4 } },
      { currentDiffPair: { index: 2, customWidth: 0.2, customGap: 0.15, customViaGap: 100 } },
      { currentVia: { customDrill: 0.001 } },
    ];
    for (const value of takes) {
      expect(parseSettingsSetArgs({ section: ROUTER, value }, extra), JSON.stringify(value)).toEqual({ section: ROUTER, value });
      expect(parseSettingsSetArgs({ section: ROUTER, value, dryRun: true }, extra)).toEqual({ section: ROUTER, value, dryRun: true });
    }
    for (const k of ROUTER_SWITCHES) expect(routerFits({ [k]: true }), k).toBe(true);
    expect(ROUTER_SWITCHES).toHaveLength(11);
    for (const [obj, sizes] of Object.entries(CURRENT_SIZES)) for (const k of sizes) expect(routerFits({ [obj]: { [k]: 1 } }), `${obj}.${k}`).toBe(true);
  });

  it('refuses a router value outside KiCad\'s keys and kinds, the read only sizes included', () => {
    const refused: unknown[] = [
      { mode: 3 }, { mode: 1.5 }, { mode: '1' }, { effort: -1 },
      { shove_vias: 1 }, { shoveVias: true }, { 'tools.pns.mode': 1 },
      { currentTrack: {} }, { currentTrack: { width: 0.4 } }, { currentVia: { diameter: 0.8 } }, { currentVia: { drill: 0.4 } },
      { currentDiffPair: { gap: 0.2 } }, { currentDiffPair: { viaGap: 0.2 } },
      { currentTrack: { index: -1 } }, { currentTrack: { index: 1.5 } }, { currentTrack: { custom: 1 } },
      { currentTrack: { customWidth: 0 } }, { currentTrack: { customWidth: 100.5 } }, { currentTrack: { customWidth: Number.NaN } },
      { currentTrack: { customDiameter: 0.8 } }, { currentVia: { customWidth: 0.4 } }, { currentDiffPair: { customDrill: 0.3 } },
      { currentTrack: [{ index: 0 }] }, { currentTrack: null }, { mode: null },
      { constructor: {} }, {}, [{ mode: 1 }],
    ];
    for (const value of refused) expect(parseSettingsSetArgs({ section: ROUTER, value }, extra), JSON.stringify(value)).toBeNull();
    expect(parseSettingsSetArgs({ section: ROUTER, value: { mode: 1 }, dryRun: 1 }, extra)).toBeNull();
  });

  it('takes a layer pairs value: the saved list whole, the current pair, or both', () => {
    const takes: Array<Record<string, unknown>> = [
      { pairs: [] },
      { pairs: [{ top: 'F.Cu', bottom: 'In1.Cu', name: 'Top pair' }], current: { top: 'F.Cu', bottom: 'In1.Cu' } },
      { pairs: [{ top: 'In2.Cu', bottom: 'B.Cu', enabled: false, name: '' }, { top: 'In30.Cu', bottom: 'F.Cu' }] },
      { current: { top: 'B.Cu', bottom: 'F.Cu' } },
      { pairs: [{ top: 'F.Cu', bottom: 'B.Cu', name: 'n'.repeat(128) }] },
      { pairs: Array.from({ length: MAX_LAYER_PAIRS }, () => ({ top: 'F.Cu', bottom: 'B.Cu' })) },
    ];
    for (const value of takes) expect(parseSettingsSetArgs({ section: LAYER_PAIRS, value }, extra), JSON.stringify(value).slice(0, 80)).toEqual({ section: LAYER_PAIRS, value });
  });

  it('refuses a layer pairs value of another shape, a layer that is not copper, or one layer twice', () => {
    const refused: unknown[] = [
      { pairs: {} }, { pairs: [{ top: 'F.Cu' }] }, { pairs: [{ top: 'F.Cu', bottom: 'F.Cu' }] },
      { pairs: [{ top: 'F.Cu', bottom: 'B.Cu', enabled: 'yes' }] }, { pairs: [{ top: 'F.Cu', bottom: 'B.Cu', name: 7 }] },
      { pairs: [{ top: 'F.Cu', bottom: 'B.Cu', name: 'n'.repeat(129) }] }, { pairs: [{ top: 'F.Cu', bottom: 'B.Cu', color: 1 }] },
      { pairs: [{ top: 'F.SilkS', bottom: 'B.Cu' }] }, { pairs: [{ top: 'In0.Cu', bottom: 'B.Cu' }] }, { pairs: [{ top: 'In31.Cu', bottom: 'B.Cu' }] },
      { pairs: [{ top: 0, bottom: 31 }] }, { pairs: [null] },
      { pairs: Array.from({ length: MAX_LAYER_PAIRS + 1 }, () => ({ top: 'F.Cu', bottom: 'B.Cu' })) },
      { current: { top: 'F.Cu', bottom: 'F.Cu' } }, { current: { top: 'F.Cu', bottom: 'B.Cu', name: 'x' } }, { current: { top: 'F.Cu' } },
      { current: null }, { other: 1 }, {},
    ];
    for (const value of refused) expect(parseSettingsSetArgs({ section: LAYER_PAIRS, value }, extra), JSON.stringify(value).slice(0, 80)).toBeNull();
    expect(layerPairsFits({ current: { top: 'F.Cu', bottom: 'B.Cu' } })).toBe(true);
    // A router key is not a layer pairs key, and the other way.
    expect(layerPairsFits({ mode: 1 })).toBe(false);
    expect(routerFits({ current: { top: 'F.Cu', bottom: 'B.Cu' } })).toBe(false);
  });
});

describe('the caps, feature detected on kicadSettingsSections\' board half', () => {
  it('reads the board half of the marker, null for a missing marker or another shape', () => {
    expect(boardSections(RUN15)).toEqual(['constraints', ROUTER, LAYER_PAIRS, 'origins']);
    expect(boardSections(RUN14)).toBeNull();
    expect(boardSections(null)).toBeNull();
    expect(boardSections({ [SECTIONS_EXPORT]: () => 'not json' })).toBeNull();
    expect(boardSections({ [SECTIONS_EXPORT]: () => { throw new Error('boom'); } })).toBeNull();
    expect(boardSections({ [SECTIONS_EXPORT]: () => JSON.stringify({ schematic: [ROUTER] }) })).toBeNull();
    expect(boardSections({ [SECTIONS_EXPORT]: () => JSON.stringify({ board: [1] }) })).toBeNull();
    expect(boardSections({ [SECTIONS_EXPORT]: () => JSON.stringify([ROUTER]) })).toBeNull();
  });

  it('lists each cap in a pcb frame only where the board half names its section', () => {
    expect(routingCaps(RUN15, 'pcb')).toEqual([ROUTER_CAP, LAYER_PAIRS_CAP]);
    for (const f of ['sch', 'symedit', 'fpedit']) expect(routingCaps(RUN15, f), f).toEqual([]);
    expect(routingCaps(RUN14, 'pcb')).toEqual([]);
    expect(routingCaps({ ...RUN14, [SECTIONS_EXPORT]: sections([LAYER_PAIRS], []) }, 'pcb')).toEqual([LAYER_PAIRS_CAP]);
    expect(routingCaps({ ...RUN14, [SECTIONS_EXPORT]: sections([ROUTER], []) }, 'pcb')).toEqual([ROUTER_CAP]);
    // A name in the schematic half never lists it.
    expect(routingCaps({ ...RUN14, [SECTIONS_EXPORT]: sections([], [ROUTER, LAYER_PAIRS]) }, 'pcb')).toEqual([]);
    // The marker alone, without the settings calls, lists nothing.
    expect(routingCaps({ [SECTIONS_EXPORT]: RUN15[SECTIONS_EXPORT] }, 'pcb')).toEqual([]);
    expect(unit.caps(RUN15, 'pcb')).toEqual([ROUTER_CAP, LAYER_PAIRS_CAP]);
  });

  it('ev.ready lists both caps in a pcb frame on an engine that takes the sections, and neither on run 14 or in a sch frame', async () => {
    const pcb15 = (await boot('pcb', RUN15)).ready?.caps ?? [];
    expect(pcb15).toEqual(expect.arrayContaining([ROUTER_CAP, LAYER_PAIRS_CAP]));
    for (const [f, exports] of [['sch', RUN15], ['pcb', RUN14], ['sch', RUN14]] as const) {
      const caps = (await boot(f, exports)).ready?.caps ?? [];
      expect(caps.length, `${f}`).toBeGreaterThan(0);
      for (const c of [ROUTER_CAP, LAYER_PAIRS_CAP]) expect(caps, `${f} ${c}`).not.toContain(c);
    }
  });
});

describe('settings.get and settings.set in the responder', () => {
  it('answers both sections unsupported in a sch frame, before any engine call', async () => {
    const sch = await boot('sch', RUN15);
    expect(await sch.ask(1, 'settings.get', { section: ROUTER })).toEqual({ id: 1, ok: false, error: { code: 'unsupported', message: 'router is a board setting' } });
    expect(await sch.ask(2, 'settings.set', { section: LAYER_PAIRS, value: { current: { top: 'F.Cu', bottom: 'B.Cu' } } }))
      .toEqual({ id: 2, ok: false, error: { code: 'unsupported', message: 'layerPairs is a board setting' } });
    expect(sch.get).not.toHaveBeenCalled();
    expect(sch.set).not.toHaveBeenCalled();
    // The same on engine run 14: the section is this unit's, whatever the engine takes.
    const sch14 = await boot('sch', RUN14);
    expect(await sch14.ask(3, 'settings.get', { section: ROUTER })).toEqual({ id: 3, ok: false, error: { code: 'unsupported', message: 'router is a board setting' } });
    expect(sch14.get).not.toHaveBeenCalled();
  });

  it('checks the value before anything else: a read only size or a key of no table is bad_args', async () => {
    const t = await boot('pcb', RUN15);
    expect(await t.ask(1, 'settings.set', { section: ROUTER, value: { currentTrack: { width: 0.4 } } })).toEqual({ id: 1, ok: false, error: { code: 'bad_args', message: 'settings.set' } });
    expect(await t.ask(2, 'settings.set', { section: LAYER_PAIRS, value: { current: { top: 'F.Cu', bottom: 'F.Cu' } } })).toEqual({ id: 2, ok: false, error: { code: 'bad_args', message: 'settings.set' } });
    expect(t.set).not.toHaveBeenCalled();
  });

  it('waits for a document (not_ready) before the engine is asked', async () => {
    const t = await boot('pcb', RUN15);
    expect(await t.ask(1, 'settings.get', { section: ROUTER })).toEqual({ id: 1, ok: false, error: { code: 'not_ready', message: 'settings.get' } });
    expect(await t.ask(2, 'settings.set', { section: LAYER_PAIRS, value: { pairs: [] } })).toEqual({ id: 2, ok: false, error: { code: 'not_ready', message: 'settings.set' } });
    expect(t.get).not.toHaveBeenCalled();
    expect(t.set).not.toHaveBeenCalled();
  });
});

describe('KiCad\'s router windows, held', () => {
  const union = heldActions(buildRegistry(mods(unit)));
  const take = (a: string, f: 'sch' | 'pcb' | 'fpedit', caps: string[]) => heldTaken(a, f as 'pcb', caps, union);

  it('takes each in a pcb frame under the cap of the section that replaces it, never elsewhere', () => {
    expect(take(SETTINGS_DIALOG, 'pcb', [ROUTER_CAP])).toBe(true);
    expect(take(DIFF_PAIR_DIALOG, 'pcb', [ROUTER_CAP])).toBe(true);
    expect(take(SELECT_LAYER_PAIR, 'pcb', [LAYER_PAIRS_CAP])).toBe(true);
    expect(take(SETTINGS_DIALOG, 'pcb', [LAYER_PAIRS_CAP, 'heldKeys'])).toBe(false);
    expect(take(DIFF_PAIR_DIALOG, 'pcb', [LAYER_PAIRS_CAP])).toBe(false);
    expect(take(SELECT_LAYER_PAIR, 'pcb', [ROUTER_CAP, 'heldKeys'])).toBe(false);
    for (const a of ACTIONS) {
      expect(take(a, 'sch', [ROUTER_CAP, LAYER_PAIRS_CAP, 'heldKeys']), a).toBe(false);
      expect(take(a, 'fpedit', [ROUTER_CAP, LAYER_PAIRS_CAP, 'heldKeys']), a).toBe(false);
      // Without this unit, the pcb frame lets KiCad run it.
      expect(heldTaken(a, 'pcb', [ROUTER_CAP, LAYER_PAIRS_CAP, 'heldKeys'], HELD_ACTIONS), a).toBe(false);
    }
  });

  it('on run 14 (no cap) and with no document open the slot lets KiCad run them', async () => {
    for (const exports of [RUN14, RUN15]) {
      const t = await boot('pcb', exports);
      for (const a of ACTIONS) expect(t.win.kicadHostAction?.onRequest?.(JSON.stringify({ action: a })), a).toBe(false);
      expect(t.got.filter((m) => m.type === 'ev.held')).toEqual([]);
      t.r.close();
    }
  });
});
