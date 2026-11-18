// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// lo-e3-i: the stackup set's dielectric forms read closed, the cap
// settings:stackupLayers feature detected on the engine's section marker, and
// the widening of settings.set in the responder. The engine here is this
// test's own module of exports; the real engine is the e2e's
// (tests/e2e/lo/board-faults.spec.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startResponder } from '../responder';
import { ok, type Answer, type ExtUnit, type ResponderCtx } from './contract';
import { buildRegistry, REGISTRY } from './registry';
import unit, {
  asksDielectric, boardSections, MAX_STACKUP_INDEX, parseDielectricSet, parseDielectricValue, SECTIONS_EXPORT, STACKUP_LAYERS,
  STACKUP_LAYERS_CAP, takesDielectrics, widenSettingsSet,
} from './lo-e3-i';

const PARENT = 'http://localhost';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));
const sections = (board: string[], schematic: string[] = []) => () => JSON.stringify({ board, schematic });
const RUN14 = { kicadSettingsGet: () => '', kicadSettingsSet: () => true, kicadCollabBusy: () => false };
const RUN15 = { ...RUN14, [SECTIONS_EXPORT]: sections(['constraints', 'layers', 'router', 'stackup', STACKUP_LAYERS], ['pinMap']) };
const RUN15_WITHOUT = { ...RUN14, [SECTIONS_EXPORT]: sections(['constraints', 'layers', 'stackup']) };

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
  const set = vi.fn(() => true);
  const win = {
    FS: { analyzePath: () => ({ exists: false }), mkdirTree: () => {}, readdir: () => [], readFile: () => { throw new Error('ENOENT'); } },
    Module: { kicadOpenFileBusy: () => false, ...exports, kicadSettingsSet: set },
    wxElementRegistry: { findAll: () => [{ id: 'frame', typeName: frame === 'pcb' ? 'PCB_EDIT_FRAME' : 'SCH_EDIT_FRAME', name: 'Frame', visible: true }], findByLabel: () => [] },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    dispatchEvent: () => true,
  } as unknown as ToolWindow;
  r.engineReady(win, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
  await settle();
  const ask = async (id: number, op: string, args?: unknown) => {
    ch.port1.postMessage(args === undefined ? { id, op } : { id, op, args });
    await settle();
    return got.find((m) => m.id === id);
  };
  return { ready: got.find((m) => m.type === 'ev.ready') as { caps: string[] } | undefined, ask, set };
}

const ADD = { section: 'stackup', value: { addDielectric: { after: 3 } } };
const REMOVE = { section: 'stackup', value: { removeDielectric: { index: 3, sub: 1 } } };

describe('the unit in the registry', () => {
  it('loads in this checkout with nothing broken, widening settings.set and naming its one cap', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect(REGISTRY.units.map((u) => u.unit)).toContain('lo-e3-i');
    expect(REGISTRY.capNames.get(STACKUP_LAYERS_CAP)).toBe('lo-e3-i');
    expect(REGISTRY.widen.get('settings.set')?.map((w) => w.unit)).toContain('lo-e3-i');
  });

  it('declares no op, event, held row, ask, export job or settings section: it widens one op and lists one cap', () => {
    const u = unit as ExtUnit;
    expect(Object.keys(u.opsWidened ?? {})).toEqual(['settings.set']);
    expect(u.capNames).toEqual(['settings:stackupLayers']);
    expect(u.frames).toEqual(['pcb']);
    for (const empty of [u.ops, u.events, u.exportJobs, u.settingsSections]) expect(empty ?? {}).toEqual({});
    for (const none of [u.held, u.heldRows, u.asks]) expect(none ?? []).toEqual([]);
    expect(u.install).toBeUndefined();
  });
});

describe('the dielectric forms, read closed', () => {
  it('takes exactly addDielectric { after } and removeDielectric { index, sub }, with an optional boolean dryRun', () => {
    expect(parseDielectricValue({ addDielectric: { after: 0 } })).toEqual({ addDielectric: { after: 0 } });
    expect(parseDielectricValue({ removeDielectric: { index: MAX_STACKUP_INDEX, sub: 2 } })).toEqual({ removeDielectric: { index: 255, sub: 2 } });
    expect(parseDielectricSet(ADD)).toEqual(ADD);
    expect(parseDielectricSet(REMOVE)).toEqual(REMOVE);
    expect(parseDielectricSet({ ...ADD, dryRun: true })).toEqual({ ...ADD, dryRun: true });
    expect(parseDielectricSet({ ...REMOVE, dryRun: false })).toEqual({ ...REMOVE, dryRun: false });
    const nullProto = Object.assign(Object.create(null) as Record<string, unknown>, { after: 1 });
    expect(parseDielectricValue({ addDielectric: nullProto })).toEqual({ addDielectric: { after: 1 } });
  });

  it('refuses every other value of the widening', () => {
    const refused: unknown[] = [
      { addDielectric: { after: 1 }, removeDielectric: { index: 1, sub: 0 } },
      { addDielectric: { after: 1 }, rows: [] },
      { removeDielectric: { index: 1, sub: 0 }, boardThickness: 1.6 },
      { addDielectric: null }, { addDielectric: 3 }, { addDielectric: [3] }, { addDielectric: {} },
      { addDielectric: { after: 1, sub: 0 } }, { addDielectric: { index: 1 } },
      { addDielectric: { after: -1 } }, { addDielectric: { after: 1.5 } }, { addDielectric: { after: '1' } },
      { addDielectric: { after: MAX_STACKUP_INDEX + 1 } }, { addDielectric: { after: Number.NaN } }, { addDielectric: { after: true } },
      { removeDielectric: null }, { removeDielectric: { index: 1 } }, { removeDielectric: { sub: 0 } },
      { removeDielectric: { index: 1, sub: 0, after: 2 } }, { removeDielectric: { index: -1, sub: 0 } },
      { removeDielectric: { index: 1, sub: -1 } }, { removeDielectric: { index: 1, sub: 0.5 } },
      { removeDielectric: { index: '1', sub: 0 } }, { removeDielectric: { index: 1, sub: MAX_STACKUP_INDEX + 1 } },
      { removeDielectric: [1, 0] }, {}, [], null, 'addDielectric', { rows: [] },
    ];
    for (const value of refused) expect(parseDielectricValue(value), JSON.stringify(value)).toBeNull();
    class Shaped { after = 1; }
    expect(parseDielectricValue({ addDielectric: new Shaped() })).toBeNull();
  });

  it('refuses a request of another shape around a dielectric form', () => {
    for (const args of [
      { ...ADD, dryRun: 'yes' }, { ...ADD, dryRun: null }, { ...ADD, extra: 1 },
      { section: 'stackup' }, { value: ADD.value }, { section: 'layers', value: ADD.value }, null, [ADD],
    ]) expect(parseDielectricSet(args), JSON.stringify(args)).toBeNull();
  });

  it('names a request as the widening\'s only when its stackup value carries a dielectric key', () => {
    expect(asksDielectric(ADD)).toBe(true);
    expect(asksDielectric(REMOVE)).toBe(true);
    expect(asksDielectric({ section: 'stackup', value: { addDielectric: 'bad', rows: [] } })).toBe(true);
    expect(asksDielectric({ section: 'stackup', value: { rows: [{ index: 1, thickness: 0.2 }] } })).toBe(false);
    expect(asksDielectric({ section: 'layers', value: { addDielectric: { after: 1 } } })).toBe(false);
    expect(asksDielectric({ section: 'stackup', value: [{ addDielectric: { after: 1 } }] })).toBe(false);
    expect(asksDielectric(undefined)).toBe(false);
  });
});

describe('settings:stackupLayers, feature detected on kicadSettingsSections', () => {
  it('reads the board half of the marker, null for a missing marker or another shape', () => {
    expect(boardSections(RUN15)).toContain(STACKUP_LAYERS);
    expect(boardSections(RUN14)).toBeNull();
    expect(boardSections(null)).toBeNull();
    expect(boardSections({ [SECTIONS_EXPORT]: () => 'not json' })).toBeNull();
    expect(boardSections({ [SECTIONS_EXPORT]: () => { throw new Error('boom'); } })).toBeNull();
    expect(boardSections({ [SECTIONS_EXPORT]: () => JSON.stringify({ board: [1], schematic: [] }) })).toBeNull();
    expect(boardSections({ [SECTIONS_EXPORT]: () => JSON.stringify([STACKUP_LAYERS]) })).toBeNull();
  });

  it('lists the cap in a pcb frame only, and only when the board half names stackupLayers', () => {
    const caps = unit.caps!;
    expect(caps(RUN15, 'pcb')).toEqual([STACKUP_LAYERS_CAP]);
    expect(caps(RUN15, 'sch')).toEqual([]);
    expect(caps(RUN15, 'symedit')).toEqual([]);
    expect(caps(RUN15_WITHOUT, 'pcb')).toEqual([]);
    expect(caps(RUN14, 'pcb')).toEqual([]);
    expect(caps({ [SECTIONS_EXPORT]: sections([], [STACKUP_LAYERS]) }, 'pcb')).toEqual([]);
    expect(takesDielectrics({ [SECTIONS_EXPORT]: () => '' })).toBe(false);
  });

  it('ev.ready lists the cap on an engine that takes the forms, and not on run 14', async () => {
    expect((await boot('pcb', RUN15)).ready?.caps).toContain(STACKUP_LAYERS_CAP);
    expect((await boot('pcb', RUN15_WITHOUT)).ready?.caps).not.toContain(STACKUP_LAYERS_CAP);
    expect((await boot('pcb', RUN14)).ready?.caps).not.toContain(STACKUP_LAYERS_CAP);
    expect((await boot('sch', RUN15)).ready?.caps).not.toContain(STACKUP_LAYERS_CAP);
  });
});

describe('the widening of settings.set in the responder', () => {
  it('on run 14 answers a dielectric form unsupported naming the missing marker, and calls no engine set', async () => {
    const t = await boot('pcb', RUN14);
    expect(await t.ask(1, 'settings.set', ADD)).toEqual({ id: 1, ok: false, error: { code: 'unsupported', message: SECTIONS_EXPORT } });
    expect(await t.ask(2, 'settings.set', REMOVE)).toEqual({ id: 2, ok: false, error: { code: 'unsupported', message: SECTIONS_EXPORT } });
    expect(t.set).not.toHaveBeenCalled();
  });

  it('answers unsupported naming the section when the marker does not list stackupLayers', async () => {
    const t = await boot('pcb', RUN15_WITHOUT);
    expect(await t.ask(1, 'settings.set', ADD)).toEqual({ id: 1, ok: false, error: { code: 'unsupported', message: STACKUP_LAYERS } });
    expect(t.set).not.toHaveBeenCalled();
  });

  it('checks the form before the engine: a malformed form is bad_args on every engine', async () => {
    for (const exports of [RUN14, RUN15]) {
      const t = await boot('pcb', exports);
      expect(await t.ask(1, 'settings.set', { section: 'stackup', value: { addDielectric: { after: -1 } } })).toEqual({ id: 1, ok: false, error: { code: 'bad_args', message: 'settings.set' } });
      expect(await t.ask(2, 'settings.set', { section: 'stackup', value: { addDielectric: { after: 1 }, rows: [] } })).toEqual({ id: 2, ok: false, error: { code: 'bad_args', message: 'settings.set' } });
      expect(await t.ask(3, 'settings.set', { ...REMOVE, dryRun: 1 })).toEqual({ id: 3, ok: false, error: { code: 'bad_args', message: 'settings.set' } });
      expect(t.set).not.toHaveBeenCalled();
    }
  });

  it('on an engine that takes the forms hands them to the op as it ships (no board open: not_ready)', async () => {
    const t = await boot('pcb', RUN15);
    expect(await t.ask(1, 'settings.set', ADD)).toEqual({ id: 1, ok: false, error: { code: 'not_ready', message: 'settings.set' } });
    expect(await t.ask(2, 'settings.set', { ...REMOVE, dryRun: true })).toEqual({ id: 2, ok: false, error: { code: 'not_ready', message: 'settings.set' } });
  });

  it('leaves the frame\'s refusal to the op: a sch frame answers stackup is a board setting', async () => {
    const t = await boot('sch', RUN15);
    expect(await t.ask(1, 'settings.set', ADD)).toEqual({ id: 1, ok: false, error: { code: 'unsupported', message: 'stackup is a board setting' } });
  });

  it('leaves every other form to the op untouched, on run 14 as on run 15', async () => {
    for (const exports of [RUN14, RUN15]) {
      const t = await boot('pcb', exports);
      expect(await t.ask(1, 'settings.set', { section: 'stackup', value: { rows: [{ index: 1, thickness: 0.2 }] } })).toEqual({ id: 1, ok: false, error: { code: 'not_ready', message: 'settings.set' } });
      expect(await t.ask(2, 'settings.set', { section: 'stackup', value: [] })).toEqual({ id: 2, ok: false, error: { code: 'bad_args', message: 'settings.set' } });
    }
  });
});

describe('the hook alone', () => {
  const ctxOf = (frame: 'sch' | 'pcb', mod: Record<string, unknown> | null) => ({ frame, mod: () => mod }) as unknown as ResponderCtx;

  it('passes the closed copy of a dielectric form on, and any other args as they came', async () => {
    const next = vi.fn(async (_a: unknown): Promise<Answer> => ok({ value: {} }));
    const args = { section: 'stackup', value: { addDielectric: { after: 2 } }, dryRun: false };
    expect(await widenSettingsSet(args, ctxOf('pcb', RUN15), next)).toEqual(ok({ value: {} }));
    expect(next.mock.calls[0][0]).toEqual(args);
    expect(next.mock.calls[0][0]).not.toBe(args);
    const other = { section: 'netClasses', value: { classes: [] } };
    await widenSettingsSet(other, ctxOf('pcb', RUN14), next);
    expect(next.mock.calls[1][0]).toBe(other);
  });

  it('before the engine is up, and in a sch frame, leaves the gate to the op', async () => {
    const next = vi.fn(async (): Promise<Answer> => ok());
    await widenSettingsSet(ADD, ctxOf('pcb', null), next);
    await widenSettingsSet(ADD, ctxOf('sch', RUN14), next);
    expect(next).toHaveBeenCalledTimes(2);
  });
});
