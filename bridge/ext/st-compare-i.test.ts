// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-compare-i: item.compare, the cap compare feature detected on the engine's
// kicadCompareWithSource, the args and the engine's answer read closed, a
// missing source answered as the status noSource (not an error), an item the
// document does not hold answered not_found, and KiCad's two compare actions
// held. The engine here is this test's own module of exports (at the protocol
// boundary); the real engine is the e2e's (tests/e2e/st/st-compare-i.spec.ts,
// engine run 15).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HELD_ACTIONS, heldTaken } from '../held';
import { startResponder } from '../responder';
import type { ExtUnit, ResponderCtx } from './contract';
import { buildRegistry, heldActions, REGISTRY } from './registry';
import unit, {
  COMPARE_CAP, COMPARE_EXPORTS, COMPARE_ROWS, DIFF_CODES, DIFF_FOOTPRINT, DIFF_SYMBOL, FINDINGS_MAX, parseCompareArgs,
  readCompareResult, readFinding, STATUSES,
} from './st-compare-i';

const PARENT = 'http://localhost';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));
const RUN15 = { kicadCompareWithSource: () => '' };

const R4 = '00000000-0000-0000-0000-00005f06d941';
const R48 = '00000000-0000-0000-0000-00005cc279d9';
const PAD1 = '9fe5c991-a4bb-46ca-b81d-72a45f57a872';
const SHEET = '/00000000-0000-0000-0000-00005c7b59b0/';
const SAME = { status: 'same', source: 'Device:R', findings: [] };
const PAD_FINDING = { code: 'pad', uuid: PAD1, pin: '1', field: '' };
const DIFFERS = { status: 'differs', source: 'Resistor_SMD:R_0603_1608Metric', findings: [PAD_FINDING, { code: 'override', uuid: null, pin: '', field: 'clearance' }] };
const NO_SOURCE = { status: 'noSource', source: 'Glasgow:R_0603_1608Metric_DNP', findings: [] };

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

/** A responder with this unit alone, booted in `frame` on an engine with `exports` and no document open. */
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
  const win = {
    FS: { analyzePath: () => ({ exists: false }), mkdirTree: () => {}, readdir: () => [], readFile: () => { throw new Error('ENOENT'); } },
    Module: { kicadOpenFileBusy: () => false, ...exports },
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
  return { ready: got.find((m) => m.type === 'ev.ready') as { caps: string[] } | undefined, ask };
}

/** A ResponderCtx over a fake engine in `frame`: `engine` plays kicadCompareWithSource; `gate` makes the gate refuse busy. */
function fakeCtx(opts: { frame?: 'sch' | 'pcb'; engine?: (a: Record<string, unknown>) => unknown; gate?: string } = {}) {
  const asked: Array<Record<string, unknown>> = [];
  const frame = opts.frame ?? 'sch';
  const mod: Record<string, unknown> = {
    kicadCompareWithSource: (json: string) => { const a = JSON.parse(json) as Record<string, unknown>; asked.push(a); return (opts.engine ?? (() => ''))(a); },
  };
  const gated = (want: string) => (_op: string, exports: readonly string[]) => {
    if (frame !== want) return { ok: false, code: 'unsupported', message: `the ${want} gate in a ${frame} frame` };
    if (opts.gate != null) return { ok: false, code: 'busy', message: opts.gate };
    for (const name of exports) if (typeof mod[name] !== 'function') return { ok: false, code: 'unsupported', message: name };
    return { w: {}, mod };
  };
  const ctx = {
    frame,
    root: '/project',
    timing: {},
    mod: () => mod,
    closed: () => false,
    schematicGate: gated('sch'),
    boardGate: gated('pcb'),
    log: () => {},
  } as unknown as ResponderCtx;
  return { ctx, asked };
}

describe('st-compare-i in the registry', () => {
  it('loads in this checkout with nothing broken, owning item.compare and the cap compare', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect(REGISTRY.ops.get('item.compare')?.unit).toBe('st-compare-i');
    expect(REGISTRY.pending.has('item.compare')).toBe(false);
    expect(REGISTRY.capNames.get(COMPARE_CAP)).toBe('st-compare-i');
    expect(COMPARE_CAP).toBe('compare');
    expect(unit.ops['item.compare'].passesCheck).toBe(true);
  });

  it('lists compare in a sch and a pcb frame on an engine with kicadCompareWithSource, nothing on run 14 or in another frame', () => {
    expect([...COMPARE_EXPORTS]).toEqual(['kicadCompareWithSource']);
    expect(unit.caps(RUN15, 'sch')).toEqual(['compare']);
    expect(unit.caps(RUN15, 'pcb')).toEqual(['compare']);
    expect(unit.caps(RUN15, 'symedit')).toEqual([]);
    expect(unit.caps({}, 'sch')).toEqual([]);
    expect(unit.caps({ kicadCompareWithSource: 'not a function' }, 'pcb')).toEqual([]);
  });

  it('run 14: no cap listed in either frame, item.compare answers unsupported naming the export; bad args first', async () => {
    for (const frame of ['sch', 'pcb']) {
      const s = await boot(frame, {});
      expect(s.ready?.caps).not.toContain('compare');
      expect(await s.ask(1, 'item.compare', { uuid: R48 })).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'kicadCompareWithSource' } });
      expect(await s.ask(2, 'item.compare', { uuid: 'R48' })).toMatchObject({ ok: false, error: { code: 'bad_args', message: 'item.compare' } });
    }
  });

  it('run 15: the cap listed, not_ready with no document open; a symedit frame refuses it', async () => {
    const sch = await boot('sch', RUN15);
    expect(sch.ready?.caps).toContain('compare');
    expect(await sch.ask(1, 'item.compare', { uuid: R4, sheetPath: '/' })).toMatchObject({ ok: false, error: { code: 'not_ready', message: 'item.compare' } });
    const pcb = await boot('pcb', RUN15);
    expect(pcb.ready?.caps).toContain('compare');
    expect(await pcb.ask(1, 'item.compare', { uuid: R48 })).toMatchObject({ ok: false, error: { code: 'not_ready', message: 'item.compare' } });
    expect(await pcb.ask(2, 'item.compare', { uuid: R48, sheetPath: '/' })).toMatchObject({ ok: false, error: { code: 'bad_args', message: 'item.compare' } });
    const sym = await boot('symedit', RUN15);
    expect(sym.ready?.caps ?? []).not.toContain('compare');
    expect(await sym.ask(1, 'item.compare', { uuid: R4 })).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'item.compare runs in a sch or pcb frame' } });
  });
});

describe('the held compare actions', () => {
  const union = heldActions(buildRegistry(mods(unit)));
  it('holds Compare Footprint with Library in a pcb frame and Compare Symbol with Library in a sch frame, both under compare', () => {
    expect([DIFF_FOOTPRINT, DIFF_SYMBOL]).toEqual(['pcbnew.InspectionTool.DiffFootprint', 'eeschema.InspectionTool.diffSymbol']);
    expect(unit.held).toEqual(COMPARE_ROWS.map((h) => h.action));
    expect(COMPARE_ROWS.map((h) => ({ ...h, frames: [...h.frames] }))).toEqual([
      { action: DIFF_FOOTPRINT, frames: ['pcb'], cap: 'compare' },
      { action: DIFF_SYMBOL, frames: ['sch'], cap: 'compare' },
    ]);
    for (const r of COMPARE_ROWS) expect(heldActions()).toContainEqual(r);
  });
  it('no built in row holds them', () => {
    for (const r of COMPARE_ROWS) expect(HELD_ACTIONS.some((h) => h.action === r.action)).toBe(false);
  });
  it('the responder takes each only in its frame while ev.ready listed compare', () => {
    expect(heldTaken(DIFF_FOOTPRINT, 'pcb', ['compare'], union)).toBe(true);
    expect(heldTaken(DIFF_FOOTPRINT, 'pcb', ['heldKeys'], union)).toBe(false);
    expect(heldTaken(DIFF_FOOTPRINT, 'sch', ['compare'], union)).toBe(false);
    expect(heldTaken(DIFF_SYMBOL, 'sch', ['compare'], union)).toBe(true);
    expect(heldTaken(DIFF_SYMBOL, 'sch', [], union)).toBe(false);
    expect(heldTaken(DIFF_SYMBOL, 'pcb', ['compare'], union)).toBe(false);
  });
});

describe('the args', () => {
  it('a sch frame takes { uuid } or { uuid, sheetPath } in symbol.get\'s grammar', () => {
    expect(parseCompareArgs({ uuid: R4 }, 'sch')).toEqual({ uuid: R4 });
    expect(parseCompareArgs({ uuid: R4, sheetPath: '/' }, 'sch')).toEqual({ uuid: R4, sheetPath: '/' });
    expect(parseCompareArgs({ uuid: R4, sheetPath: SHEET }, 'sch')).toEqual({ uuid: R4, sheetPath: SHEET });
  });
  it('a pcb frame takes exactly { uuid }: a footprint has no sheet path', () => {
    expect(parseCompareArgs({ uuid: R48 }, 'pcb')).toEqual({ uuid: R48 });
    expect(parseCompareArgs({ uuid: R48, sheetPath: '/' }, 'pcb')).toBeNull();
    expect(parseCompareArgs({ uuid: R48, sheetPath: '' }, 'pcb')).toBeNull();
  });
  it('anything else is refused', () => {
    for (const bad of [undefined, null, [], 'R4', {}, { uuid: 'R4' }, { uuid: R4.toUpperCase().replace(/^0+/, 'A') }, { uuid: `${R4} ` },
      { uuid: R4, sheetPath: '' }, { uuid: R4, sheetPath: 'root' }, { uuid: R4, sheetPath: 1 }, { uuid: R4, extra: true },
      { uuid: R4, sheetPath: '/', field: 'Value' }, { uuid: 4 }]) {
      expect(parseCompareArgs(bad, 'sch'), JSON.stringify(bad) ?? 'undefined').toBeNull();
    }
  });
});

describe('the engine\'s answer read closed', () => {
  it('reads the three statuses, the source and the findings', () => {
    expect([...STATUSES]).toEqual(['same', 'differs', 'noSource']);
    expect(readCompareResult(JSON.stringify(SAME))).toEqual(SAME);
    expect(readCompareResult(JSON.stringify(DIFFERS))).toEqual(DIFFERS);
    expect(readCompareResult(JSON.stringify(NO_SOURCE))).toEqual(NO_SOURCE);
    // A same footprint can still carry KiCad's informational stackup lines.
    const informational = { status: 'same', source: 'Resistor_SMD:R_0603_1608Metric', findings: [{ code: 'boardStackup', uuid: null, pin: '', field: '' }] };
    expect(readCompareResult(JSON.stringify(informational))).toEqual(informational);
  });
  it('every code of 7.4 and of run 15\'s footprint codes is read; an unknown code is refused', () => {
    expect(DIFF_CODES).toContain('pad');
    for (const code of ['boardStackup', 'dnp', 'stackup', 'override', 'netTie', 'barcodeCount', 'barcode', 'ruleAreaCount', 'ruleArea', 'excludeSim', 'fpFilters']) {
      expect(readFinding({ code, uuid: null, pin: '', field: '' })?.code).toBe(code);
    }
    expect(new Set(DIFF_CODES).size).toBe(DIFF_CODES.length);
    expect(readFinding({ code: 'rotation', uuid: null, pin: '', field: '' })).toBeNull();
  });
  it('a finding is exactly its four keys, a lowercase uuid or null, strings within the engine\'s cut', () => {
    expect(readFinding(PAD_FINDING)).toEqual(PAD_FINDING);
    for (const bad of [{ ...PAD_FINDING, uuid: PAD1.toUpperCase() }, { ...PAD_FINDING, uuid: '' }, { ...PAD_FINDING, pin: 1 }, { ...PAD_FINDING, field: null },
      { ...PAD_FINDING, pin: 'x'.repeat(1025) }, { ...PAD_FINDING, extra: 1 }, { code: 'pad', uuid: PAD1, pin: '1' }, null, 'pad']) {
      expect(readFinding(bad), JSON.stringify(bad)?.slice(0, 80)).toBeNull();
    }
    expect(readFinding({ ...PAD_FINDING, pin: 'é'.repeat(1024) })).not.toBeNull();
  });
  it('at most 512 findings; any other shape is null', () => {
    const many = (n: number) => JSON.stringify({ ...DIFFERS, findings: Array.from({ length: n }, () => PAD_FINDING) });
    expect(readCompareResult(many(FINDINGS_MAX))?.findings).toHaveLength(512);
    expect(readCompareResult(many(FINDINGS_MAX + 1))).toBeNull();
    for (const bad of ['', 'nope', '[]', '{}', JSON.stringify({ ...SAME, status: 'missing' }), JSON.stringify({ ...SAME, source: 3 }),
      JSON.stringify({ ...SAME, findings: {} }), JSON.stringify({ ...SAME, extra: 1 }), JSON.stringify({ status: 'same', source: 'Device:R' }),
      JSON.stringify({ ...DIFFERS, findings: [{ code: 'other' }] })]) {
      expect(readCompareResult(bad), bad).toBeNull();
    }
  });
});

describe('item.compare on an engine with the export', () => {
  const run = unit.ops['item.compare'].run;
  it('sends the args as given and answers the engine\'s compare in a sch frame and in a pcb frame', async () => {
    const sch = fakeCtx({ engine: () => JSON.stringify(SAME) });
    expect(await run({ uuid: R4, sheetPath: '/' }, sch.ctx)).toEqual({ ok: true, result: SAME });
    expect(await run({ uuid: R4 }, sch.ctx)).toEqual({ ok: true, result: SAME });
    expect(sch.asked).toEqual([{ uuid: R4, sheetPath: '/' }, { uuid: R4 }]);
    const pcb = fakeCtx({ frame: 'pcb', engine: () => JSON.stringify(DIFFERS) });
    expect(await run({ uuid: R48 }, pcb.ctx)).toEqual({ ok: true, result: DIFFERS });
    expect(pcb.asked).toEqual([{ uuid: R48 }]);
  });
  it('a missing source is a success answer with status noSource, not an error', async () => {
    const pcb = fakeCtx({ frame: 'pcb', engine: () => JSON.stringify(NO_SOURCE) });
    expect(await run({ uuid: R48 }, pcb.ctx)).toEqual({ ok: true, result: NO_SOURCE });
  });
  it('the engine\'s empty answer (no such item) is not_found naming the item', async () => {
    const sch = fakeCtx();
    expect(await run({ uuid: R4, sheetPath: SHEET }, sch.ctx)).toEqual({ ok: false, code: 'not_found', message: `${R4} on ${SHEET}` });
    const pcb = fakeCtx({ frame: 'pcb' });
    expect(await run({ uuid: R48 }, pcb.ctx)).toEqual({ ok: false, code: 'not_found', message: R48 });
  });
  it('bad args, then the gate, before the engine is asked', async () => {
    const pcb = fakeCtx({ frame: 'pcb', engine: () => JSON.stringify(SAME) });
    expect(await run({ uuid: R48, sheetPath: '/' }, pcb.ctx)).toEqual({ ok: false, code: 'bad_args', message: 'item.compare' });
    const busy = fakeCtx({ gate: 'item.compare', engine: () => JSON.stringify(SAME) });
    expect(await run({ uuid: R4 }, busy.ctx)).toEqual({ ok: false, code: 'busy', message: 'item.compare' });
    expect([...pcb.asked, ...busy.asked]).toEqual([]);
  });
  it('another shape or a throw is island_error', async () => {
    const shape = fakeCtx({ engine: () => JSON.stringify({ ...SAME, status: 'maybe' }) });
    expect(await run({ uuid: R4 }, shape.ctx)).toEqual({ ok: false, code: 'island_error', message: 'the engine answered a compare of another shape' });
    const thrown = fakeCtx({ engine: () => { throw new Error('engine fault'); } });
    expect(await run({ uuid: R4 }, thrown.ctx)).toEqual({ ok: false, code: 'island_error', message: 'engine fault' });
  });
});
