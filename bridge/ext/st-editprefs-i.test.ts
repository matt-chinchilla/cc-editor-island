// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-editprefs-i: the sections schEditing, pcbEditing and mouse taken by
// settings.get and settings.set in their frames, their values read closed on
// KiCad's keys, the caps feature detected on the engine's section marker per
// frame half, and KiCad's Preferences window held in the sch and pcb frames.
// The engine here is this test's own module of exports; the real engine is
// the e2e's (tests/e2e/st/st-editprefs-i.spec.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HELD_ACTIONS, heldTaken } from '../held';
import { startResponder } from '../responder';
import { parseSettingsGetArgs, parseSettingsSetArgs, sectionFrames } from '../settings';
import type { ExtUnit } from './contract';
import { buildRegistry, heldActions, REGISTRY } from './registry';
import unit, {
  EDITPREFS_ROWS, EDITPREFS_SECTIONS, editPrefsCaps, frameSections, MOUSE, MOUSE_CAP, MOUSE_KEYS, OPEN_PREFERENCES, PCB_EDITING,
  PCB_EDITING_CAP, PCB_EDITING_KEYS, SCH_EDITING, SCH_EDITING_CAP, SCH_EDITING_KEYS, SECTIONS_EXPORT, valueFits,
} from './st-editprefs-i';

const PARENT = 'http://localhost';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));
const sections = (board: string[], schematic: string[]) => () => JSON.stringify({ board, schematic });
const RUN14 = { kicadSettingsGet: () => '', kicadSettingsSet: () => true, kicadCollabBusy: () => false, kicadHostActions: () => true };
const RUN15 = { ...RUN14, [SECTIONS_EXPORT]: sections(['constraints', 'router', PCB_EDITING, MOUSE], ['pinMap', SCH_EDITING, MOUSE]) };

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
  it('loads in this checkout with nothing broken: its three caps, its three sections and its held row', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect(REGISTRY.units.map((u) => u.unit)).toContain('st-editprefs-i');
    for (const cap of [SCH_EDITING_CAP, PCB_EDITING_CAP, MOUSE_CAP]) expect(REGISTRY.capNames.get(cap)).toBe('st-editprefs-i');
    for (const s of [SCH_EDITING, PCB_EDITING, MOUSE]) expect(REGISTRY.settingsSections.get(s)?.unit).toBe('st-editprefs-i');
    const union = heldActions();
    expect(union).toContainEqual(EDITPREFS_ROWS[0]);
    expect(union.slice(0, HELD_ACTIONS.length)).toEqual([...HELD_ACTIONS]);
    // Held once per frame: the symedit frame's built in row stays its own.
    for (const f of ['sch', 'pcb', 'symedit'] as const) {
      expect(union.filter((h) => h.action === OPEN_PREFERENCES && (h.frames as readonly string[]).includes(f)), f).toHaveLength(1);
    }
  });

  it('names exactly the record\'s caps, held row and frames, and no op, event, ask, export job or widening', () => {
    const u = unit as ExtUnit;
    expect(u.capNames).toEqual(['settings:schEditing', 'settings:pcbEditing', 'settings:mouse']);
    expect(u.held).toEqual(['common.SuiteControl.openPreferences']);
    expect(EDITPREFS_ROWS.map((r) => [r.action, [...r.frames], r.cap])).toEqual([['common.SuiteControl.openPreferences', ['sch', 'pcb'], 'heldKeys']]);
    expect(Object.isFrozen(EDITPREFS_ROWS)).toBe(true);
    expect(Object.isFrozen(EDITPREFS_ROWS[0].frames)).toBe(true);
    expect(Object.keys(u.settingsSections ?? {})).toEqual([SCH_EDITING, PCB_EDITING, MOUSE]);
    for (const empty of [u.ops, u.events, u.exportJobs, u.opsWidened, u.defineFrames, u.hostTools]) expect(empty ?? {}).toEqual({});
    expect(u.asks ?? []).toEqual([]);
    expect(u.install).toBeUndefined();
  });
});

describe('the three sections, as bridge/settings.ts takes them', () => {
  const extra = buildRegistry(mods(unit)).settingsSections;

  it('lives in its frames: schEditing in sch, pcbEditing in pcb, mouse in both', () => {
    expect(sectionFrames(SCH_EDITING, extra)).toEqual(['sch']);
    expect(sectionFrames(PCB_EDITING, extra)).toEqual(['pcb']);
    expect(sectionFrames(MOUSE, extra)).toEqual(['sch', 'pcb']);
    for (const s of [SCH_EDITING, PCB_EDITING, MOUSE]) {
      expect(sectionFrames(s)).toEqual([]);
      expect(parseSettingsGetArgs({ section: s }, extra)).toEqual({ section: s });
      expect(parseSettingsGetArgs({ section: s })).toBeNull();
    }
  });

  it('takes a value of the section\'s keys, each its kind, with an optional dryRun', () => {
    const takes: Array<[string, Record<string, unknown>]> = [
      [PCB_EDITING, { 'editing.magnetic_pads': 0 }],
      [PCB_EDITING, { 'editing.flip_left_right': true, 'editing.rotation_angle': 900, 'pcb_display.ratsnest_thickness': 0.5 }],
      [SCH_EDITING, { 'drawing.line_mode': 0, 'annotation.automatic': false, 'drawing.default_repeat_offset_y': -100 }],
      [MOUSE, { 'input.mouse_middle': 1, 'input.zoom_speed': 5, 'input.center_on_zoom': true }],
    ];
    for (const [section, value] of takes) {
      expect(parseSettingsSetArgs({ section, value }, extra), JSON.stringify(value)).toEqual({ section, value });
      expect(parseSettingsSetArgs({ section, value, dryRun: true }, extra)).toEqual({ section, value, dryRun: true });
    }
    // Every key of each table is taken alone, in its kind.
    const tables: Array<[string, typeof SCH_EDITING_KEYS]> = [[SCH_EDITING, SCH_EDITING_KEYS], [PCB_EDITING, PCB_EDITING_KEYS], [MOUSE, MOUSE_KEYS]];
    for (const [section, keys] of tables) {
      for (const k of keys.bools) expect(parseSettingsSetArgs({ section, value: { [k]: true } }, extra), k).not.toBeNull();
      for (const k of keys.numbers) expect(parseSettingsSetArgs({ section, value: { [k]: 1 } }, extra), k).not.toBeNull();
    }
  });

  it('refuses another key, the other kind, a null, nothing, or a key of another section', () => {
    const refused: Array<[string, unknown]> = [
      [MOUSE, { 'input.zoomspeed': 5 }],
      [MOUSE, { 'input.mouse_middle': '1' }],
      [MOUSE, { 'input.center_on_zoom': 1 }],
      [MOUSE, { 'input.zoom_speed': Number.NaN }],
      [MOUSE, { 'input.zoom_speed': null }],
      [MOUSE, {}],
      [MOUSE, [{ 'input.zoom_speed': 1 }]],
      [PCB_EDITING, { 'editing.magnetic_pads': true }],
      [PCB_EDITING, { editing: { magnetic_pads: 0 } }],
      [PCB_EDITING, { 'drawing.line_mode': 0 }],
      [SCH_EDITING, { 'editing.magnetic_pads': 0 }],
      [SCH_EDITING, { 'drawing.line_mode': 0, 'appearance.sheet_border_color': '#000000' }],
      [SCH_EDITING, { 'input.mouse_middle': 1 }],
    ];
    for (const [section, value] of refused) expect(parseSettingsSetArgs({ section, value }, extra), `${section} ${JSON.stringify(value)}`).toBeNull();
    expect(parseSettingsSetArgs({ section: MOUSE, value: { 'input.zoom_speed': 1 }, dryRun: 1 }, extra)).toBeNull();
  });

  it('valueFits reads each table closed and the tables share no key across kinds', () => {
    for (const keys of [SCH_EDITING_KEYS, PCB_EDITING_KEYS, MOUSE_KEYS]) {
      expect(keys.bools.filter((k) => keys.numbers.includes(k))).toEqual([]);
      expect(new Set([...keys.bools, ...keys.numbers]).size).toBe(keys.bools.length + keys.numbers.length);
    }
    expect(valueFits(MOUSE_KEYS, { 'input.auto_pan': false })).toBe(true);
    expect(valueFits(MOUSE_KEYS, { 'input.auto_pan': false, other: 1 })).toBe(false);
    expect(Object.keys(EDITPREFS_SECTIONS)).toEqual([SCH_EDITING, PCB_EDITING, MOUSE]);
    for (const s of Object.values(EDITPREFS_SECTIONS)) { expect(s.projectFile).toBeUndefined(); expect(s.pcbReadOnly).toBeUndefined(); }
  });
});

describe('the caps, feature detected on kicadSettingsSections per frame half', () => {
  it('reads the running frame\'s half of the marker, null for a missing marker, another shape or another frame', () => {
    expect(frameSections(RUN15, 'pcb')).toEqual(['constraints', 'router', PCB_EDITING, MOUSE]);
    expect(frameSections(RUN15, 'sch')).toEqual(['pinMap', SCH_EDITING, MOUSE]);
    expect(frameSections(RUN15, 'symedit')).toBeNull();
    expect(frameSections(RUN14, 'pcb')).toBeNull();
    expect(frameSections(null, 'pcb')).toBeNull();
    expect(frameSections({ [SECTIONS_EXPORT]: () => 'not json' }, 'sch')).toBeNull();
    expect(frameSections({ [SECTIONS_EXPORT]: () => { throw new Error('boom'); } }, 'sch')).toBeNull();
    expect(frameSections({ [SECTIONS_EXPORT]: () => JSON.stringify({ board: [MOUSE] }) }, 'sch')).toBeNull();
    expect(frameSections({ [SECTIONS_EXPORT]: () => JSON.stringify({ schematic: [1] }) }, 'sch')).toBeNull();
    expect(frameSections({ [SECTIONS_EXPORT]: () => JSON.stringify([MOUSE]) }, 'sch')).toBeNull();
  });

  it('lists the frame\'s own editing cap and the mouse cap only where the frame\'s half names them', () => {
    expect(editPrefsCaps(RUN15, 'pcb')).toEqual([PCB_EDITING_CAP, MOUSE_CAP]);
    expect(editPrefsCaps(RUN15, 'sch')).toEqual([SCH_EDITING_CAP, MOUSE_CAP]);
    expect(editPrefsCaps(RUN15, 'symedit')).toEqual([]);
    expect(editPrefsCaps(RUN14, 'pcb')).toEqual([]);
    expect(editPrefsCaps(RUN14, 'sch')).toEqual([]);
    // A board name in the schematic half (or the other way) never lists it.
    const swapped = { ...RUN14, [SECTIONS_EXPORT]: sections([SCH_EDITING], [PCB_EDITING]) };
    expect(editPrefsCaps(swapped, 'pcb')).toEqual([]);
    expect(editPrefsCaps(swapped, 'sch')).toEqual([]);
    expect(editPrefsCaps({ ...RUN14, [SECTIONS_EXPORT]: sections([MOUSE], []) }, 'pcb')).toEqual([MOUSE_CAP]);
    // The marker alone, without the settings calls, lists nothing.
    expect(editPrefsCaps({ [SECTIONS_EXPORT]: RUN15[SECTIONS_EXPORT] }, 'pcb')).toEqual([]);
    expect(unit.caps!(RUN15, 'pcb')).toEqual([PCB_EDITING_CAP, MOUSE_CAP]);
  });

  it('ev.ready lists the caps on an engine that takes the sections, and none of them on run 14', async () => {
    const pcb15 = (await boot('pcb', RUN15)).ready?.caps ?? [];
    expect(pcb15).toEqual(expect.arrayContaining([PCB_EDITING_CAP, MOUSE_CAP]));
    expect(pcb15).not.toContain(SCH_EDITING_CAP);
    const sch15 = (await boot('sch', RUN15)).ready?.caps ?? [];
    expect(sch15).toEqual(expect.arrayContaining([SCH_EDITING_CAP, MOUSE_CAP]));
    expect(sch15).not.toContain(PCB_EDITING_CAP);
    for (const f of ['sch', 'pcb'] as const) {
      const caps = (await boot(f, RUN14)).ready?.caps ?? [];
      expect(caps).toContain('heldKeys');
      for (const c of [SCH_EDITING_CAP, PCB_EDITING_CAP, MOUSE_CAP]) expect(caps).not.toContain(c);
    }
  });
});

describe('settings.get and settings.set in the responder', () => {
  it('answers a section of the other drawing unsupported, before any engine call', async () => {
    const sch = await boot('sch', RUN15);
    expect(await sch.ask(1, 'settings.get', { section: PCB_EDITING })).toEqual({ id: 1, ok: false, error: { code: 'unsupported', message: 'pcbEditing is a board setting' } });
    expect(await sch.ask(2, 'settings.set', { section: PCB_EDITING, value: { 'editing.magnetic_pads': 0 } })).toEqual({ id: 2, ok: false, error: { code: 'unsupported', message: 'pcbEditing is a board setting' } });
    const pcb = await boot('pcb', RUN15);
    expect(await pcb.ask(3, 'settings.get', { section: SCH_EDITING })).toEqual({ id: 3, ok: false, error: { code: 'unsupported', message: 'schEditing is a schematic setting' } });
    for (const t of [sch, pcb]) { expect(t.get).not.toHaveBeenCalled(); expect(t.set).not.toHaveBeenCalled(); }
  });

  it('checks the value before anything else: a key of no table is bad_args in either frame', async () => {
    for (const f of ['sch', 'pcb'] as const) {
      const t = await boot(f, RUN15);
      expect(await t.ask(1, 'settings.set', { section: MOUSE, value: { 'input.zoomspeed': 5 } })).toEqual({ id: 1, ok: false, error: { code: 'bad_args', message: 'settings.set' } });
      expect(t.set).not.toHaveBeenCalled();
    }
  });

  it('takes mouse in both frames, and waits for a document (not_ready) before the engine is asked', async () => {
    for (const f of ['sch', 'pcb'] as const) {
      const t = await boot(f, RUN15);
      expect(await t.ask(1, 'settings.get', { section: MOUSE })).toEqual({ id: 1, ok: false, error: { code: 'not_ready', message: 'settings.get' } });
      expect(await t.ask(2, 'settings.set', { section: MOUSE, value: { 'input.mouse_middle': 1 } })).toEqual({ id: 2, ok: false, error: { code: 'not_ready', message: 'settings.set' } });
      expect(t.get).not.toHaveBeenCalled();
      expect(t.set).not.toHaveBeenCalled();
    }
  });
});

describe('KiCad\'s Preferences window, held', () => {
  const union = heldActions(buildRegistry(mods(unit)));
  const take = (f: 'sch' | 'pcb' | 'symedit', caps: string[]) => heldTaken(OPEN_PREFERENCES, f, caps, union);

  it('is taken in sch and pcb under heldKeys, on run 14 as on run 15, and stays the symedit frame\'s own row there', () => {
    expect(take('sch', ['heldKeys'])).toBe(true);
    expect(take('pcb', ['heldKeys'])).toBe(true);
    expect(take('sch', [])).toBe(false);
    expect(take('pcb', [MOUSE_CAP])).toBe(false);
    expect(take('symedit', ['symedit'])).toBe(true);
    expect(take('symedit', ['heldKeys'])).toBe(false);
    // Without this unit, the sch and pcb frames let KiCad run it.
    expect(heldTaken(OPEN_PREFERENCES, 'sch', ['heldKeys'], HELD_ACTIONS)).toBe(false);
    expect(heldTaken(OPEN_PREFERENCES, 'pcb', ['heldKeys'], HELD_ACTIONS)).toBe(false);
    // The hotkey list is not this unit's.
    expect(heldTaken('common.SuiteControl.listHotKeys', 'pcb', ['heldKeys'], union)).toBe(false);
  });

  it('with no document open the slot lets KiCad run it (admit stands first)', async () => {
    for (const f of ['sch', 'pcb'] as const) {
      const t = await boot(f, RUN14);
      expect(t.win.kicadHostAction?.onRequest?.(JSON.stringify({ action: OPEN_PREFERENCES }))).toBe(false);
      expect(t.got.filter((m) => m.type === 'ev.held')).toEqual([]);
      t.r.close();
    }
  });
});
