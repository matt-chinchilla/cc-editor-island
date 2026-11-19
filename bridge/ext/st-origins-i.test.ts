// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-origins-i: the board section origins taken by settings.get and
// settings.set in a pcb frame, its value read closed on KiCad's two origins,
// the cap feature detected on the engine's section marker, and KiCad's three
// origin actions held in the pcb frame under it. The engine here is this
// test's own module of exports; the real engine is the e2e's
// (tests/e2e/st/st-origins-i.spec.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HELD_ACTIONS, heldTaken } from '../held';
import { startResponder } from '../responder';
import { parseSettingsGetArgs, parseSettingsSetArgs, sectionFrames } from '../settings';
import type { ExtUnit } from './contract';
import { buildRegistry, heldActions, REGISTRY } from './registry';
import unit, {
  AUX_ORIGIN, boardSections, DRILL_RESET_ORIGIN, EDIT_GRID_ORIGIN, GRID_ORIGIN, GRID_RESET_ORIGIN, isOrigin, MAX_ORIGIN_MM, ORIGINS,
  ORIGINS_CAP, ORIGINS_ROWS, ORIGINS_SECTIONS, originsCaps, originsFit, SECTIONS_EXPORT,
} from './st-origins-i';

const PARENT = 'http://localhost';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));
const sections = (board: string[], schematic: string[]) => () => JSON.stringify({ board, schematic });
const RUN14 = { kicadSettingsGet: () => '', kicadSettingsSet: () => true, kicadCollabBusy: () => false, kicadHostActions: () => true };
const RUN15 = { ...RUN14, [SECTIONS_EXPORT]: sections(['constraints', 'router', ORIGINS], ['pinMap']) };
const HELD = [EDIT_GRID_ORIGIN, GRID_RESET_ORIGIN, DRILL_RESET_ORIGIN];

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
  it('loads in this checkout with nothing broken: its cap, its section and its three held rows', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect(REGISTRY.units.map((u) => u.unit)).toContain('st-origins-i');
    expect(REGISTRY.capNames.get(ORIGINS_CAP)).toBe('st-origins-i');
    expect(REGISTRY.settingsSections.get(ORIGINS)?.unit).toBe('st-origins-i');
    const union = heldActions();
    for (const row of ORIGINS_ROWS) expect(union).toContainEqual(row);
    expect(union.slice(0, HELD_ACTIONS.length)).toEqual([...HELD_ACTIONS]);
    // Each held once in the pcb frame, and in no other frame by this unit.
    for (const a of HELD) expect(union.filter((h) => h.action === a && (h.frames as readonly string[]).includes('pcb')), a).toHaveLength(1);
  });

  it('names exactly the record\'s cap, held rows and frames, and no op, event, ask, export job or widening', () => {
    const u = unit as ExtUnit;
    expect(u.capNames).toEqual(['settings:origins']);
    expect(u.held).toEqual(['common.Control.editGridOrigin', 'common.Control.gridResetOrigin', 'pcbnew.EditorControl.drillResetOrigin']);
    expect(ORIGINS_ROWS.map((r) => [r.action, [...r.frames], r.cap])).toEqual([
      ['common.Control.editGridOrigin', ['pcb'], 'settings:origins'],
      ['common.Control.gridResetOrigin', ['pcb'], 'settings:origins'],
      ['pcbnew.EditorControl.drillResetOrigin', ['pcb'], 'settings:origins'],
    ]);
    expect(Object.isFrozen(ORIGINS_ROWS)).toBe(true);
    for (const r of ORIGINS_ROWS) { expect(Object.isFrozen(r)).toBe(true); expect(Object.isFrozen(r.frames)).toBe(true); }
    expect(Object.keys(u.settingsSections ?? {})).toEqual([ORIGINS]);
    for (const empty of [u.ops, u.events, u.exportJobs, u.opsWidened, u.defineFrames, u.hostTools]) expect(empty ?? {}).toEqual({});
    expect(u.asks ?? []).toEqual([]);
    expect(u.install).toBeUndefined();
  });
});

describe('the section, as bridge/settings.ts takes it', () => {
  const extra = buildRegistry(mods(unit)).settingsSections;

  it('lives in the pcb frame alone, as a board setting it reads and sets', () => {
    expect(sectionFrames(ORIGINS, extra)).toEqual(['pcb']);
    expect(sectionFrames(ORIGINS)).toEqual([]);
    expect(parseSettingsGetArgs({ section: ORIGINS }, extra)).toEqual({ section: ORIGINS });
    expect(parseSettingsGetArgs({ section: ORIGINS })).toBeNull();
    const s = ORIGINS_SECTIONS[ORIGINS];
    expect(s.projectFile).toBeUndefined();
    expect(s.pcbReadOnly).toBeUndefined();
  });

  it('takes either origin or both, each exactly { x, y } in mm, Reset included, with an optional dryRun', () => {
    const takes: Array<Record<string, unknown>> = [
      { [GRID_ORIGIN]: { x: 10, y: 20 } },
      { [AUX_ORIGIN]: { x: -12.7, y: 3.81 } },
      { [GRID_ORIGIN]: { x: 0, y: 0 }, [AUX_ORIGIN]: { x: 0, y: 0 } },
      { [GRID_ORIGIN]: { x: MAX_ORIGIN_MM, y: -MAX_ORIGIN_MM } },
    ];
    for (const value of takes) {
      expect(parseSettingsSetArgs({ section: ORIGINS, value }, extra), JSON.stringify(value)).toEqual({ section: ORIGINS, value });
      expect(parseSettingsSetArgs({ section: ORIGINS, value, dryRun: true }, extra)).toEqual({ section: ORIGINS, value, dryRun: true });
    }
  });

  it('refuses another key, a part of an origin, another shape, past the bound, a null or nothing', () => {
    const refused: unknown[] = [
      { origin: { x: 1, y: 1 } },
      { grid: [10, 10] },
      { [GRID_ORIGIN]: { x: 10 } },
      { [GRID_ORIGIN]: { x: 10, y: 20, z: 0 } },
      { [GRID_ORIGIN]: [10, 20] },
      { [GRID_ORIGIN]: { x: '10', y: 20 } },
      { [GRID_ORIGIN]: { x: Number.NaN, y: 0 } },
      { [AUX_ORIGIN]: { x: 5000, y: 0 } },
      { [AUX_ORIGIN]: { x: 0, y: -1000.5 } },
      { [AUX_ORIGIN]: null },
      { [GRID_ORIGIN]: { x: 0, y: 0 }, other: { x: 0, y: 0 } },
      {},
      [{ [GRID_ORIGIN]: { x: 0, y: 0 } }],
    ];
    for (const value of refused) expect(parseSettingsSetArgs({ section: ORIGINS, value }, extra), JSON.stringify(value)).toBeNull();
    expect(parseSettingsSetArgs({ section: ORIGINS, value: { [GRID_ORIGIN]: { x: 0, y: 0 } }, dryRun: 1 }, extra)).toBeNull();
  });

  it('isOrigin and originsFit read closed', () => {
    expect(isOrigin({ x: 1, y: 2 })).toBe(true);
    expect(isOrigin({ y: 2, x: 1 })).toBe(true);
    expect(isOrigin({ x: Number.POSITIVE_INFINITY, y: 0 })).toBe(false);
    expect(isOrigin(null)).toBe(false);
    expect(originsFit({ [AUX_ORIGIN]: { x: 1, y: 2 } })).toBe(true);
    expect(originsFit({ [AUX_ORIGIN]: { x: 1, y: 2 }, x: 1 })).toBe(false);
  });
});

describe('the cap, feature detected on kicadSettingsSections\' board half', () => {
  it('reads the board half, null for a missing marker or another shape', () => {
    expect(boardSections(RUN15)).toEqual(['constraints', 'router', ORIGINS]);
    expect(boardSections(RUN14)).toBeNull();
    expect(boardSections(null)).toBeNull();
    expect(boardSections({ [SECTIONS_EXPORT]: () => 'not json' })).toBeNull();
    expect(boardSections({ [SECTIONS_EXPORT]: () => { throw new Error('boom'); } })).toBeNull();
    expect(boardSections({ [SECTIONS_EXPORT]: () => JSON.stringify({ schematic: [ORIGINS] }) })).toBeNull();
    expect(boardSections({ [SECTIONS_EXPORT]: () => JSON.stringify({ board: [1] }) })).toBeNull();
    expect(boardSections({ [SECTIONS_EXPORT]: () => JSON.stringify([ORIGINS]) })).toBeNull();
  });

  it('lists settings:origins in a pcb frame only, only where the board half names origins and the settings calls exist', () => {
    expect(originsCaps(RUN15, 'pcb')).toEqual([ORIGINS_CAP]);
    expect(originsCaps(RUN15, 'sch')).toEqual([]);
    expect(originsCaps(RUN15, 'fpedit')).toEqual([]);
    expect(originsCaps(RUN14, 'pcb')).toEqual([]);
    expect(originsCaps({ ...RUN14, [SECTIONS_EXPORT]: sections(['router'], [ORIGINS]) }, 'pcb')).toEqual([]);
    expect(originsCaps({ [SECTIONS_EXPORT]: RUN15[SECTIONS_EXPORT] }, 'pcb')).toEqual([]);
    expect(unit.caps!(RUN15, 'pcb')).toEqual([ORIGINS_CAP]);
  });

  it('ev.ready lists the cap on an engine that takes the section, and not on run 14 or in a sch frame', async () => {
    expect((await boot('pcb', RUN15)).ready?.caps ?? []).toContain(ORIGINS_CAP);
    expect((await boot('sch', RUN15)).ready?.caps ?? []).not.toContain(ORIGINS_CAP);
    for (const f of ['sch', 'pcb'] as const) expect((await boot(f, RUN14)).ready?.caps ?? []).not.toContain(ORIGINS_CAP);
  });
});

describe('settings.get and settings.set in the responder', () => {
  it('answers the section unsupported in a sch frame, before any engine call', async () => {
    const sch = await boot('sch', RUN15);
    expect(await sch.ask(1, 'settings.get', { section: ORIGINS })).toEqual({ id: 1, ok: false, error: { code: 'unsupported', message: 'origins is a board setting' } });
    expect(await sch.ask(2, 'settings.set', { section: ORIGINS, value: { [GRID_ORIGIN]: { x: 10, y: 10 } } })).toEqual({ id: 2, ok: false, error: { code: 'unsupported', message: 'origins is a board setting' } });
    expect(sch.get).not.toHaveBeenCalled();
    expect(sch.set).not.toHaveBeenCalled();
  });

  it('checks the value first (bad_args), then waits for a document (not_ready) before the engine is asked', async () => {
    const t = await boot('pcb', RUN15);
    expect(await t.ask(1, 'settings.set', { section: ORIGINS, value: { grid: [10, 10] } })).toEqual({ id: 1, ok: false, error: { code: 'bad_args', message: 'settings.set' } });
    expect(await t.ask(2, 'settings.get', { section: ORIGINS })).toEqual({ id: 2, ok: false, error: { code: 'not_ready', message: 'settings.get' } });
    expect(await t.ask(3, 'settings.set', { section: ORIGINS, value: { [GRID_ORIGIN]: { x: 10, y: 10 } } })).toEqual({ id: 3, ok: false, error: { code: 'not_ready', message: 'settings.set' } });
    expect(t.get).not.toHaveBeenCalled();
    expect(t.set).not.toHaveBeenCalled();
  });
});

describe('KiCad\'s three origin actions, held', () => {
  const union = heldActions(buildRegistry(mods(unit)));

  it('are taken in the pcb frame under settings:origins only, never in the sch frame', () => {
    for (const a of HELD) {
      expect(heldTaken(a, 'pcb', [ORIGINS_CAP], union), a).toBe(true);
      expect(heldTaken(a, 'pcb', ['heldKeys'], union), a).toBe(false);
      expect(heldTaken(a, 'pcb', [], union), a).toBe(false);
      expect(heldTaken(a, 'sch', [ORIGINS_CAP, 'heldKeys'], union), a).toBe(false);
      // Without this unit KiCad runs them.
      expect(heldTaken(a, 'pcb', [ORIGINS_CAP, 'heldKeys'], HELD_ACTIONS), a).toBe(false);
    }
    // The set origin tools stay KiCad's (a press on the canvas, not a window).
    expect(heldTaken('common.Control.gridSetOrigin', 'pcb', [ORIGINS_CAP], union)).toBe(false);
    expect(heldTaken('pcbnew.EditorControl.drillOrigin', 'pcb', [ORIGINS_CAP], union)).toBe(false);
  });

  it('with the cap listed and no document open, the slot lets KiCad run them (admit stands first)', async () => {
    const t = await boot('pcb', RUN15);
    expect(t.ready?.caps ?? []).toContain(ORIGINS_CAP);
    for (const a of HELD) expect(t.win.kicadHostAction?.onRequest?.(JSON.stringify({ action: a })), a).toBe(false);
    expect(t.got.filter((m) => m.type === 'ev.held')).toEqual([]);
    t.r.close();
  });
});
