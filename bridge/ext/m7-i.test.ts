// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// m7-i: the eight Setup sections of settings.get and settings.set read closed,
// their caps feature detected on the engine's section marker per frame, the
// widenings in the responder, and board.tuningSolve's args and answer. The
// engine here is this test's own module of exports (at the protocol
// boundary); the real engine is the e2e's (tests/e2e/settings-w2.spec.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startResponder } from '../responder';
import { fail, ok, type Answer, type ExtUnit, type ResponderCtx } from './contract';
import { buildRegistry, REGISTRY } from './registry';
import unit, {
  annotationOk, BOARD_SECTIONS, boardFormattingOk, bomPresetsOk, componentClassesOk, conditionKeyOk, engineSections, M7_CAPS,
  M7_SECTIONS, m7Caps, parseSolveArgs, readSolve, SCHEMATIC_SECTIONS, SECTIONS_EXPORT, SOLVE_CAP, tuningPatternsOk,
  tuningProfilesOk, widenSettingsGet, widenSettingsSet, ZONE_DEFAULT_KEYS, zoneDefaultsOk, zoneHatchOffsetsOk,
} from './m7-i';

const PARENT = 'http://localhost';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));
const sections = (board: readonly string[], schematic: readonly string[]) => () => JSON.stringify({ board, schematic });
const RUN14 = { kicadSettingsGet: () => '', kicadSettingsSet: () => true, kicadCollabBusy: () => false };
const RUN15 = {
  ...RUN14,
  [SECTIONS_EXPORT]: sections(['layers', 'stackup', ...BOARD_SECTIONS], ['pinMap', ...SCHEMATIC_SECTIONS]),
  kicadTuningSolve: () => JSON.stringify({ width: 0.876, gap: null, delay: 60.58, problem: '' }),
};
const RUN15_WITHOUT = { ...RUN14, [SECTIONS_EXPORT]: sections(['layers', 'stackup'], ['pinMap']) };

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
  const get = vi.fn(() => '');
  const solve = vi.fn(() => '');
  const win = {
    FS: { analyzePath: () => ({ exists: false }), mkdirTree: () => {}, readdir: () => [], readFile: () => { throw new Error('ENOENT'); } },
    Module: { kicadOpenFileBusy: () => false, ...exports, kicadSettingsSet: set, kicadSettingsGet: get, ...(exports.kicadTuningSolve ? { kicadTuningSolve: solve } : {}) },
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
  return { ready: got.find((m) => m.type === 'ev.ready') as { caps: string[] } | undefined, ask, set, get, solve };
}

const refusal = (id: number, code: string, message: string) => ({ id, ok: false, error: { code, message } });
const SAMPLES: Record<string, Record<string, unknown>> = {
  zoneDefaults: { min_clearance: 0.6, fill_mode: 1, hatch_orientation: -45 },
  zoneHatchOffsets: { layers: [{ layer: 'In1.Cu', offset: [0.5, 0.5] }, { layer: 'F.Cu', offset: null }] },
  boardFormatting: { dashRatio: 6, applyToText: true },
  tuningPatterns: { single_track_defaults: { spacing: 1.2, corner_style: 1 } },
  componentClasses: { 'sheet_component_classes.enabled': true, assignments: [{ component_class: 'POWER', conditions_operator: 'ALL', conditions: { REFERENCE: { primary: 'U*' } } }] },
  tuningProfiles: { tuning_profiles_impedance_geometric: [{ profile_name: 'USB 90R', type: 1 }] },
  annotation: { 'annotation.method': 1, annotate_start_num: 100 },
  bomPresets: { bom_presets: [{ name: 'Assembly' }], bom_settings: {} },
};

describe('the unit in the registry', () => {
  it('loads in this checkout with nothing broken: two widenings, eight sections, nine caps, one op', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect(REGISTRY.units.map((u) => u.unit)).toContain('m7-i');
    for (const cap of [...M7_CAPS, SOLVE_CAP]) expect(REGISTRY.capNames.get(cap)).toBe('m7-i');
    expect(REGISTRY.widen.get('settings.get')?.map((w) => w.unit)).toContain('m7-i');
    expect(REGISTRY.widen.get('settings.set')?.map((w) => w.unit)).toContain('m7-i');
    expect(REGISTRY.ops.get('board.tuningSolve')?.unit).toBe('m7-i');
    for (const s of M7_SECTIONS) expect(REGISTRY.settingsSections.get(s)?.unit).toBe('m7-i');
  });

  it('names exactly the manifest\'s caps and op, and no event, held row, ask or export job', () => {
    const u = unit as ExtUnit;
    expect([...(u.capNames ?? [])].sort()).toEqual([
      'settings:annotation', 'settings:boardFormatting', 'settings:bomPresets', 'settings:componentClasses', 'settings:tuningPatterns',
      'settings:tuningProfiles', 'settings:zoneDefaults', 'settings:zoneHatchOffsets', 'tuningSolve',
    ]);
    expect(Object.keys(u.ops ?? {})).toEqual(['board.tuningSolve']);
    expect(Object.keys(u.opsWidened ?? {}).sort()).toEqual(['settings.get', 'settings.set']);
    expect(u.frames).toEqual(['pcb', 'sch']);
    for (const empty of [u.events, u.exportJobs]) expect(empty ?? {}).toEqual({});
    for (const none of [u.held, u.heldRows, u.asks]) expect(none ?? []).toEqual([]);
    expect(u.settingsSections?.componentClasses.frames).toEqual(['pcb', 'sch']);
    expect(u.settingsSections?.annotation.frames).toEqual(['sch']);
    expect(u.settingsSections?.zoneHatchOffsets.projectFile).toBeUndefined();
  });
});

describe('the values, read closed', () => {
  it('takes each section\'s own sample', () => {
    expect(zoneDefaultsOk(SAMPLES.zoneDefaults)).toBe(true);
    expect(zoneHatchOffsetsOk(SAMPLES.zoneHatchOffsets)).toBe(true);
    expect(boardFormattingOk(SAMPLES.boardFormatting)).toBe(true);
    expect(tuningPatternsOk(SAMPLES.tuningPatterns)).toBe(true);
    expect(componentClassesOk(SAMPLES.componentClasses)).toBe(true);
    expect(tuningProfilesOk(SAMPLES.tuningProfiles)).toBe(true);
    expect(annotationOk(SAMPLES.annotation)).toBe(true);
    expect(bomPresetsOk(SAMPLES.bomPresets)).toBe(true);
    expect(zoneDefaultsOk(Object.fromEntries(ZONE_DEFAULT_KEYS.map((k) => [k, 1])))).toBe(true);
    expect(zoneHatchOffsetsOk({ layers: [] })).toBe(true);
    expect(componentClassesOk({ assignments: [] })).toBe(true);
  });

  it('refuses keys and values the engine would refuse', () => {
    expect(zoneDefaultsOk({ min_clearance: -0.1 })).toBe(false);
    expect(zoneDefaultsOk({ clearance: 0.2 })).toBe(false);
    expect(zoneDefaultsOk({ fill_mode: true })).toBe(false);
    for (const v of [
      { layers: [{ layer: 'In1.Cu', offset: [0.5] }] }, { layers: [{ layer: 'In1.Cu', offset: [1001, 0] }] },
      { layers: [{ layer: 'F.SilkS', offset: null }] }, { layers: [{ layer: 'In1.Cu', offset: null }, { layer: 'In1.Cu', offset: null }] },
      { layers: [{ layer: 'In1.Cu' }] }, { layers: [{ layer: 'In1.Cu', offset: null, extra: 1 }] }, { layers: {} }, { layers: [], more: 1 }, {},
    ]) expect(zoneHatchOffsetsOk(v), JSON.stringify(v)).toBe(false);
    for (const v of [{ dashRatio: 0 }, { gapRatio: 1001 }, { applyToText: 1 }, { dash: 1 }]) expect(boardFormattingOk(v), JSON.stringify(v)).toBe(false);
    for (const v of [
      { single_track_defaults: { corner_style: 2 } }, { single_track_defaults: { corner_radius_percentage: 101 } },
      { single_track_defaults: { corner_radius_percentage: 1.5 } }, { single_track_defaults: { spacing: -1 } },
      { single_track_defaults: {} }, { single_track_defaults: { amplitude: 1 } }, { other_defaults: { spacing: 1 } }, { single_track_defaults: 3 },
    ]) expect(tuningPatternsOk(v), JSON.stringify(v)).toBe(false);
    const a = { component_class: 'POWER', conditions_operator: 'ALL', conditions: { REFERENCE: { primary: 'U*' } } };
    for (const v of [
      { assignments: [{ ...a, component_class: '' }] }, { assignments: [{ ...a, conditions_operator: 'SOME' }] },
      { assignments: [{ ...a, conditions: { BOGUS: {} } }] }, { assignments: [{ ...a, conditions: { REFERENCE: { primary: 3 } } }] },
      { assignments: [{ ...a, conditions: { REFERENCE: { third: 'x' } } }] }, { assignments: [{ ...a, extra: 1 }] },
      { 'sheet_component_classes.enabled': 1 }, { sheet_component_classes: { enabled: true } }, { assignments: {} },
    ]) expect(componentClassesOk(v), JSON.stringify(v)).toBe(false);
    expect(conditionKeyOk('REFERENCE-2')).toBe(true);
    expect(conditionKeyOk('FOOTPRINT_FIELD')).toBe(true);
    expect(conditionKeyOk('REFERENCE-x')).toBe(false);
    expect(conditionKeyOk('REFERENCE-')).toBe(false);
    for (const v of [{ tuning_profiles_impedance_geometric: {} }, { tuning_profiles_impedance_geometric: [3] }, { profiles: [] }]) expect(tuningProfilesOk(v)).toBe(false);
    for (const v of [
      { 'annotation.method': 3 }, { 'annotation.sort_order': 2 }, { annotate_start_num: 1_000_000 }, { annotate_start_num: -1 },
      { reuse_designators: 1 }, { method: 1 },
    ]) expect(annotationOk(v), JSON.stringify(v)).toBe(false);
    for (const v of [{ bom_presets: {} }, { bom_presets: [3] }, { bom_settings: [] }, { presets: [] }]) expect(bomPresetsOk(v), JSON.stringify(v)).toBe(false);
  });
});

describe('the caps, feature detected on kicadSettingsSections per frame', () => {
  it('reads the frame\'s half of the marker, null for a missing marker or another shape', () => {
    expect(engineSections(RUN15, 'pcb')).toContain('zoneDefaults');
    expect(engineSections(RUN15, 'sch')).toContain('annotation');
    expect(engineSections(RUN14, 'pcb')).toBeNull();
    expect(engineSections(RUN15, 'symedit')).toBeNull();
    expect(engineSections({ [SECTIONS_EXPORT]: () => 'not json' }, 'pcb')).toBeNull();
    expect(engineSections({ [SECTIONS_EXPORT]: () => { throw new Error('boom'); } }, 'pcb')).toBeNull();
    expect(engineSections({ [SECTIONS_EXPORT]: () => JSON.stringify({ board: [1] }) }, 'pcb')).toBeNull();
  });

  it('lists each section\'s cap in its frames only, and tuningSolve in a pcb frame with the export', () => {
    expect(m7Caps(RUN15, 'pcb').sort()).toEqual([...BOARD_SECTIONS.map((s) => `settings:${s}`), SOLVE_CAP].sort());
    expect(m7Caps(RUN15, 'sch').sort()).toEqual(['settings:annotation', 'settings:bomPresets', 'settings:componentClasses']);
    expect(m7Caps(RUN15, 'symedit')).toEqual([]);
    expect(m7Caps(RUN14, 'pcb')).toEqual([]);
    expect(m7Caps(RUN14, 'sch')).toEqual([]);
    expect(m7Caps(RUN15_WITHOUT, 'pcb')).toEqual([]);
    expect(m7Caps({ ...RUN15, kicadTuningSolve: undefined }, 'pcb')).not.toContain(SOLVE_CAP);
    expect(m7Caps({ [SECTIONS_EXPORT]: sections([], ['zoneDefaults']) }, 'sch')).toEqual([]);
  });

  it('ev.ready lists the caps on run 15 and none of them on run 14', async () => {
    const pcb = (await boot('pcb', RUN15)).ready?.caps ?? [];
    for (const s of BOARD_SECTIONS) expect(pcb).toContain(`settings:${s}`);
    expect(pcb).toContain(SOLVE_CAP);
    expect(pcb).not.toContain('settings:annotation');
    const sch = (await boot('sch', RUN15)).ready?.caps ?? [];
    expect(sch).toEqual(expect.arrayContaining(['settings:annotation', 'settings:bomPresets', 'settings:componentClasses']));
    expect(sch).not.toContain(SOLVE_CAP);
    expect(sch).not.toContain('settings:zoneDefaults');
    for (const frame of ['pcb', 'sch'] as const) {
      const caps = (await boot(frame, RUN14)).ready?.caps ?? [];
      for (const cap of [...M7_CAPS, SOLVE_CAP]) expect(caps).not.toContain(cap);
    }
  });
});

describe('settings.get and settings.set in the responder', () => {
  it('on run 14 answers the eight sections unsupported naming the missing marker, the engine never asked', async () => {
    for (const [frame, list] of [['pcb', BOARD_SECTIONS], ['sch', SCHEMATIC_SECTIONS]] as const) {
      const t = await boot(frame, RUN14);
      let id = 0;
      for (const section of list) {
        expect(await t.ask(++id, 'settings.get', { section })).toEqual(refusal(id, 'unsupported', SECTIONS_EXPORT));
        if (frame === 'sch' && section === 'componentClasses') continue;
        expect(await t.ask(++id, 'settings.set', { section, value: SAMPLES[section] })).toEqual(refusal(id, 'unsupported', SECTIONS_EXPORT));
      }
      expect(t.get).not.toHaveBeenCalled();
      expect(t.set).not.toHaveBeenCalled();
    }
  });

  it('answers unsupported naming the section when the marker does not list it', async () => {
    const t = await boot('pcb', RUN15_WITHOUT);
    expect(await t.ask(1, 'settings.get', { section: 'zoneDefaults' })).toEqual(refusal(1, 'unsupported', 'zoneDefaults'));
    expect(await t.ask(2, 'settings.set', { section: 'tuningPatterns', value: SAMPLES.tuningPatterns })).toEqual(refusal(2, 'unsupported', 'tuningPatterns'));
    expect(t.set).not.toHaveBeenCalled();
  });

  it('answers the other frame\'s sections with the op\'s own words, componentClasses read in both', async () => {
    const pcb = await boot('pcb', RUN15);
    expect(await pcb.ask(1, 'settings.get', { section: 'annotation' })).toEqual(refusal(1, 'unsupported', 'annotation is a schematic setting'));
    expect(await pcb.ask(2, 'settings.set', { section: 'bomPresets', value: SAMPLES.bomPresets })).toEqual(refusal(2, 'unsupported', 'bomPresets is a schematic setting'));
    expect(await pcb.ask(3, 'settings.get', { section: 'componentClasses' })).toEqual(refusal(3, 'not_ready', 'settings.get'));
    const sch = await boot('sch', RUN15);
    expect(await sch.ask(1, 'settings.get', { section: 'zoneHatchOffsets' })).toEqual(refusal(1, 'unsupported', 'zoneHatchOffsets is a board setting'));
    expect(await sch.ask(2, 'settings.get', { section: 'componentClasses' })).toEqual(refusal(2, 'not_ready', 'settings.get'));
    expect(await sch.ask(3, 'settings.set', { section: 'componentClasses', value: SAMPLES.componentClasses }))
      .toEqual(refusal(3, 'unsupported', 'the schematic reads componentClasses and never sets it'));
  });

  it('checks the value before the engine: bad_args on every engine', async () => {
    for (const exports of [RUN14, RUN15]) {
      const t = await boot('pcb', exports);
      expect(await t.ask(1, 'settings.set', { section: 'tuningPatterns', value: { single_track_defaults: { corner_style: 2 } } })).toEqual(refusal(1, 'bad_args', 'settings.set'));
      expect(await t.ask(2, 'settings.set', { section: 'zoneDefaults', value: { min_clearance: null } })).toEqual(refusal(2, 'bad_args', 'settings.set'));
      expect(await t.ask(3, 'settings.set', { section: 'zoneDefaults', value: {} })).toEqual(refusal(3, 'bad_args', 'settings.set'));
      expect(await t.ask(4, 'settings.set', { section: 'componentClasses', value: SAMPLES.componentClasses, dryRun: 1 })).toEqual(refusal(4, 'bad_args', 'settings.set'));
      expect(await t.ask(5, 'settings.get', { section: 'zoneDefaults', more: 1 })).toEqual(refusal(5, 'bad_args', 'settings.get'));
      expect(t.set).not.toHaveBeenCalled();
    }
  });

  it('on run 15 hands a well formed read or set to the op as it ships (no document open: not_ready)', async () => {
    const t = await boot('pcb', RUN15);
    let id = 0;
    for (const section of BOARD_SECTIONS) {
      expect(await t.ask(++id, 'settings.get', { section })).toEqual(refusal(id, 'not_ready', 'settings.get'));
      expect(await t.ask(++id, 'settings.set', { section, value: SAMPLES[section] })).toEqual(refusal(id, 'not_ready', 'settings.set'));
    }
    const s = await boot('sch', RUN15);
    expect(await s.ask(1, 'settings.set', { section: 'annotation', value: SAMPLES.annotation, dryRun: true })).toEqual(refusal(1, 'not_ready', 'settings.set'));
  });

  it('leaves the built in sections to the op untouched', async () => {
    const t = await boot('pcb', RUN14);
    expect(await t.ask(1, 'settings.get', { section: 'layers' })).toEqual(refusal(1, 'not_ready', 'settings.get'));
    expect(await t.ask(2, 'settings.get', { section: 'nope' })).toEqual(refusal(2, 'bad_args', 'settings.get'));
  });
});

describe('the hooks alone', () => {
  const ctxOf = (frame: 'sch' | 'pcb', mod: Record<string, unknown> | null) => ({ frame, mod: () => mod }) as unknown as ResponderCtx;

  it('passes a closed copy of a set on, and any other args as they came', async () => {
    const next = vi.fn(async (_a: unknown): Promise<Answer> => ok({ value: {} }));
    const args = { section: 'annotation', value: { 'annotation.method': 2 }, dryRun: false };
    expect(await widenSettingsSet(args, ctxOf('sch', RUN15), next)).toEqual(ok({ value: {} }));
    expect(next.mock.calls[0][0]).toEqual(args);
    expect(next.mock.calls[0][0]).not.toBe(args);
    const other = { section: 'netClasses', value: { classes: [] } };
    await widenSettingsSet(other, ctxOf('pcb', RUN14), next);
    expect(next.mock.calls[1][0]).toBe(other);
    const get = { section: 'stackup' };
    await widenSettingsGet(get, ctxOf('pcb', RUN14), next);
    expect(next.mock.calls[2][0]).toBe(get);
  });

  it('before the engine is up leaves the gate to the op', async () => {
    const next = vi.fn(async (): Promise<Answer> => ok());
    await widenSettingsGet({ section: 'zoneDefaults' }, ctxOf('pcb', null), next);
    await widenSettingsSet({ section: 'annotation', value: SAMPLES.annotation }, ctxOf('sch', null), next);
    expect(next).toHaveBeenCalledTimes(2);
  });
});

describe('board.tuningSolve', () => {
  const SINGLE = { type: 'single', impedance: 50, signalLayer: 'F.Cu', bottomRef: 'In1.Cu', solveFor: 'width' };

  it('reads the args closed', () => {
    expect(parseSolveArgs(SINGLE)).toEqual(SINGLE);
    expect(parseSolveArgs({ type: 'differential', impedance: 90, signalLayer: 'In2.Cu', topRef: 'In1.Cu', bottomRef: 'In3.Cu', solveFor: 'gap', width: 0.2 }))
      .toEqual({ type: 'differential', impedance: 90, signalLayer: 'In2.Cu', topRef: 'In1.Cu', bottomRef: 'In3.Cu', solveFor: 'gap', width: 0.2 });
    expect(parseSolveArgs({ ...SINGLE, solveFor: 'delay', width: 0.3 })).toEqual({ ...SINGLE, solveFor: 'delay', width: 0.3 });
    for (const v of [
      { ...SINGLE, solveFor: 'gap' }, { ...SINGLE, gap: 0.2 }, { ...SINGLE, type: 'pair' }, { ...SINGLE, impedance: 0 },
      { ...SINGLE, impedance: 2e6 }, { ...SINGLE, impedance: '50' }, { ...SINGLE, signalLayer: 'Bogus.Cu' }, { ...SINGLE, signalLayer: 'In31.Cu' },
      { ...SINGLE, topRef: 'F.SilkS' }, { ...SINGLE, width: 0 }, { ...SINGLE, width: 1001 }, { ...SINGLE, solveFor: 'length' },
      { ...SINGLE, extra: 1 }, { type: 'single', impedance: 50, solveFor: 'width' }, null, [SINGLE], undefined,
    ]) expect(parseSolveArgs(v), JSON.stringify(v)).toBeNull();
  });

  it('reads the engine\'s answer closed, "" and other shapes null', () => {
    expect(readSolve(JSON.stringify({ width: 0.876, gap: null, delay: 60.58, problem: '' }))).toEqual({ width: 0.876, gap: null, delay: 60.58, problem: '' });
    const problem = 'Diff pair gap must be greater than 0 to calculate width';
    expect(readSolve(JSON.stringify({ width: null, gap: null, delay: null, problem }))).toEqual({ width: null, gap: null, delay: null, problem });
    for (const raw of ['', 'nope', '[]', JSON.stringify({ width: 1, gap: null, delay: 1 }), JSON.stringify({ width: '1', gap: null, delay: 1, problem: '' }),
      JSON.stringify({ width: 1, gap: null, delay: 1, problem: '', more: 1 }), 3, null]) expect(readSolve(raw), String(raw)).toBeNull();
  });

  it('on run 14 answers unsupported naming kicadTuningSolve; in a sch frame the board op is refused; bad args first', async () => {
    const t = await boot('pcb', RUN14);
    expect(await t.ask(1, 'board.tuningSolve', SINGLE)).toEqual(refusal(1, 'unsupported', 'kicadTuningSolve'));
    expect(await t.ask(2, 'board.tuningSolve', { ...SINGLE, signalLayer: 'Bogus.Cu' })).toEqual(refusal(2, 'bad_args', 'board.tuningSolve'));
    const s = await boot('sch', RUN15);
    expect(await s.ask(1, 'board.tuningSolve', SINGLE)).toEqual(refusal(1, 'unsupported', 'a board op runs in a pcb frame'));
    const r = await boot('pcb', RUN15);
    expect(await r.ask(1, 'board.tuningSolve', SINGLE)).toEqual(refusal(1, 'not_ready', 'board.tuningSolve'));
    expect(r.solve).not.toHaveBeenCalled();
  });

  it('with a board open calls the engine once and reads its answer; "" is bad_args', async () => {
    const answers: unknown[] = [JSON.stringify({ width: 0.876, gap: null, delay: 60.58, problem: '' }), '', '{"width":1}'];
    const solve = vi.fn(() => answers.shift());
    const ctx = {
      frame: 'pcb',
      boardGate: () => ({ w: {}, mod: { kicadTuningSolve: solve } }),
    } as unknown as ResponderCtx;
    const run = (args: unknown) => unit.ops['board.tuningSolve'].run(args, ctx);
    expect(await run(SINGLE)).toEqual(ok({ width: 0.876, gap: null, delay: 60.58, problem: '' }));
    expect(JSON.parse((solve.mock.calls[0] as unknown as string[])[0])).toEqual(SINGLE);
    expect(await run({ ...SINGLE, signalLayer: 'In30.Cu' })).toEqual(fail('bad_args', 'board.tuningSolve'));
    expect(await run(SINGLE)).toEqual(fail('island_error', 'the engine answered a solve of another shape'));
    expect(solve).toHaveBeenCalledTimes(3);
  });
});
