// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// si5-i: sim.command, the lines a KiCad simulator workbook carries for one
// setup: the analysis line written by the island's own commandOf (the line
// sim.run sends) and the option lines KiCad's workbook writes from the
// options. A read with no engine call; the cap simCommand is listed in a sch
// frame whose engine has the simulator. The engine here is this test's own
// module of exports (at the protocol boundary); the real engine is the e2e's
// (tests/e2e/sim-command.spec.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startResponder } from '../responder';
import { SIM_RUN_EXPORTS } from '../sim';
import type { ExtUnit } from './contract';
import { buildRegistry, REGISTRY } from './registry';
import unit, { optionLines, SIM_COMMAND, SIM_COMMAND_CAP, simCommandLines } from './si5-i';

const PARENT = 'http://localhost';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));
const SIM = Object.fromEntries(SIM_RUN_EXPORTS.map((n) => [n, () => '']));
/** KiCad's default options of a new simulator tab: voltages, currents and events saved, no dissipations. */
const KICAD_DEFAULT = { voltages: true, currents: true, dissipations: false, events: true };
const NONE = { voltages: false, currents: false, dissipations: false, events: false };
const ALL = { voltages: true, currents: true, dissipations: true, events: true };

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

/** A responder with this unit alone, booted in `frame` on an engine with `exports` and no document open; `calls` counts every export called. */
async function boot(frame: string, exports: Record<string, unknown>) {
  const reg = buildRegistry(mods(unit));
  expect(reg.problems).toEqual([]);
  const { page, parent } = fakePage(`?frame=${frame}&theme=day`);
  const r = startResponder({ parentOrigin: PARENT, page, ext: reg });
  const ch = new MessageChannel();
  const got: Array<Record<string, unknown>> = [];
  ch.port1.onmessage = (m) => got.push(m.data);
  page.dispatch('message', { origin: PARENT, source: page.parent, data: { type: 'cc.connect', nonce: parent.postMessage.mock.calls[0][0].nonce }, ports: [ch.port2] });
  const typeName = frame === 'pcb' ? 'PCB_EDIT_FRAME' : 'SCH_EDIT_FRAME';
  const calls: string[] = [];
  const watched = Object.fromEntries(Object.entries(exports).map(([n, f]) => [n, (...a: unknown[]) => { calls.push(n); return (f as (...x: unknown[]) => unknown)(...a); }]));
  const win = {
    FS: { analyzePath: () => ({ exists: false }), mkdirTree: () => {}, readdir: () => [], readFile: () => { throw new Error('ENOENT'); } },
    Module: { kicadOpenFileBusy: () => false, ...watched },
    wxElementRegistry: { findAll: () => [{ id: 'frame', typeName, name: 'Frame', visible: true }], findByLabel: () => [] },
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
  return { ready: got.find((m) => m.type === 'ev.ready') as { caps: string[] } | undefined, ask, calls };
}

describe('si5-i in the registry', () => {
  it('loads in this checkout with nothing broken, owning sim.command and the cap simCommand', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect(REGISTRY.units.map((u) => u.unit)).toContain('si5-i');
    expect(SIM_COMMAND).toBe('sim.command');
    expect(SIM_COMMAND_CAP).toBe('simCommand');
    expect(Object.keys(unit.ops)).toEqual(['sim.command']);
    expect(unit.capNames).toEqual(['simCommand']);
    expect(unit.frames).toEqual(['sch']);
  });

  it('lists simCommand only in a sch frame whose engine has the simulator', () => {
    expect(unit.caps(SIM, 'sch')).toEqual(['simCommand']);
    expect(unit.caps(SIM, 'pcb')).toEqual([]);
    expect(unit.caps({}, 'sch')).toEqual([]);
    const noRun = Object.fromEntries(Object.entries(SIM).filter(([n]) => n !== 'kicadSimRun'));
    expect(unit.caps(noRun, 'sch')).toEqual([]);
  });
});

describe('the option lines', () => {
  it('follow KiCad workbook order, never .kicad adjustpaths', () => {
    expect(optionLines(KICAD_DEFAULT)).toEqual(['.save all', '.probe alli']);
    expect(optionLines(ALL)).toEqual(['.save all', '.probe alli', '.probe allp']);
    expect(optionLines(NONE)).toEqual(['.kicad esavenone']);
    expect(optionLines({ ...NONE, dissipations: true })).toEqual(['.probe allp', '.kicad esavenone']);
    for (const o of [KICAD_DEFAULT, ALL, NONE]) expect(optionLines(o)).not.toContain('.kicad adjustpaths');
  });
});

describe('simCommandLines', () => {
  it('the sim-rc transient with KiCad default options', () => {
    expect(simCommandLines({ analysis: { kind: 'tran', step: '1u', stop: '5m' }, options: KICAD_DEFAULT }))
      .toEqual({ commands: ['.tran 1u 5m', '.save all', '.probe alli'] });
  });

  it('every analysis kind answers the line sim.run would send', () => {
    const line = (analysis: unknown) => {
      const r = simCommandLines({ analysis, options: NONE });
      return 'commands' in r ? r.commands[0] : r;
    };
    expect(line({ kind: 'op' })).toBe('.op');
    expect(line({ kind: 'dc', source: 'V1', start: '0', stop: '12', step: '1' })).toBe('.dc V1 0 12 1');
    expect(line({ kind: 'dc', source: 'temp', start: '-40', stop: '85', step: '5', second: { source: 'V1', start: '0', stop: '5', step: '1' } })).toBe('.dc TEMP -40 85 5 V1 0 5 1');
    expect(line({ kind: 'ac', scale: 'dec', points: 10, fStart: '1', fStop: '1meg' })).toBe('.ac dec 10 1 1meg');
    expect(line({ kind: 'sp', scale: 'lin', points: 101, fStart: '1meg', fStop: '1g' })).toBe('.sp lin 101 1meg 1g');
    expect(line({ kind: 'tran', step: '1u', stop: '5m', start: '1m', maxStep: '2u', useIc: true })).toBe('.tran 1u 5m 1m 2u uic');
    expect(line({ kind: 'tran', step: '1u', stop: '5m', useIc: true })).toBe('.tran 1u 5m 0 0.000001 uic');
    expect(line({ kind: 'noise', output: '/out', reference: '/in', source: 'V1', scale: 'oct', points: 5, fStart: '10', fStop: '100k' })).toBe('.noise v(/out,/in) V1 oct 5 10 100k');
    expect(line({ kind: 'pz', input: ['/in', '0'], output: ['/out', '0'], transfer: 'vol', find: 'pz' })).toBe('.pz /in 0 /out 0 vol pz');
    expect(simCommandLines({ analysis: { kind: 'fft', of: 3, signals: ['V(/out)', 'V(/in)'], window: 'hanning' }, options: NONE }))
      .toEqual({ commands: ['set specwindow=hanning', 'linearize V(/out) V(/in)', 'fft V(/out) V(/in)', '.kicad esavenone'] });
  });

  it('the schematic own directive writes no analysis line: the option lines alone', () => {
    expect(simCommandLines({ analysis: { kind: 'sheet' }, options: KICAD_DEFAULT })).toEqual({ commands: ['.save all', '.probe alli'] });
  });

  it('a number outside the SPICE grammar, an unknown key or a wrong shape is refused', () => {
    expect(simCommandLines({ analysis: { kind: 'tran', step: '1 u', stop: '5m' }, options: KICAD_DEFAULT })).toEqual({ refused: 'sim.command' });
    expect(simCommandLines({ analysis: { kind: 'tran', step: 'abc', stop: '5m' }, options: KICAD_DEFAULT })).toEqual({ refused: 'sim.command' });
    expect(simCommandLines({ analysis: { kind: 'ac', scale: 'dec', points: 10, fStart: '1', fStop: '1meg;' }, options: KICAD_DEFAULT })).toEqual({ refused: 'sim.command' });
    expect(simCommandLines({ analysis: { kind: 'op' }, options: KICAD_DEFAULT, extra: 1 })).toEqual({ refused: 'sim.command' });
    expect(simCommandLines({ analysis: { kind: 'op' } })).toEqual({ refused: 'sim.command' });
    expect(simCommandLines({ analysis: { kind: 'op' }, options: { ...KICAD_DEFAULT, voltages: 1 } })).toEqual({ refused: 'sim.command' });
    expect(simCommandLines(null)).toEqual({ refused: 'sim.command' });
  });

  it('a DC sweep or a noise source that is not a source of its kind is refused, as sim.run refuses it', () => {
    expect(simCommandLines({ analysis: { kind: 'dc', source: 'C1', start: '0', stop: '1', step: '1' }, options: NONE })).toEqual({ refused: 'sim.command: C1 is not a source' });
    expect(simCommandLines({ analysis: { kind: 'noise', output: '/out', source: 'R1', scale: 'dec', points: 5, fStart: '10', fStop: '100k' }, options: NONE })).toEqual({ refused: 'sim.command: R1 is not a source' });
  });
});

describe('sim.command through the responder', () => {
  it('in a sch frame with the simulator: the lines, with no engine call and no document open', async () => {
    const s = await boot('sch', SIM);
    expect(s.ready?.caps).toContain('simCommand');
    const a = await s.ask(1, 'sim.command', { analysis: { kind: 'tran', step: '1u', stop: '5m' }, options: KICAD_DEFAULT });
    expect(a).toMatchObject({ ok: true, result: { commands: ['.tran 1u 5m', '.save all', '.probe alli'] } });
    expect(s.calls).toEqual([]);
    expect(await s.ask(2, 'sim.command', { analysis: { kind: 'tran', step: '1x5', stop: '5m' }, options: KICAD_DEFAULT })).toMatchObject({ ok: false, error: { code: 'bad_args', message: 'sim.command' } });
  });

  it('an engine without the simulator: no cap, unsupported naming the export', async () => {
    const s = await boot('sch', {});
    expect(s.ready?.caps ?? []).not.toContain('simCommand');
    expect(await s.ask(1, 'sim.command', { analysis: { kind: 'op' }, options: KICAD_DEFAULT })).toMatchObject({ ok: false, error: { code: 'unsupported', message: SIM_RUN_EXPORTS[0] } });
  });

  it('a pcb frame: no cap, the frame refusal', async () => {
    const s = await boot('pcb', SIM);
    expect(s.ready?.caps ?? []).not.toContain('simCommand');
    expect(await s.ask(1, 'sim.command', { analysis: { kind: 'op' }, options: KICAD_DEFAULT })).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'the simulator runs in a sch frame' } });
  });
});
