// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-mc-i: board.multichannel, its cap multichannel feature detected on the
// engine's kicadMultichannel, kicadMultichannelApply and kicadCollabBusy, the
// args and the engine's answers and records read closed, the run folder under
// /tmp/cc-multichannel removed after every apply, the reads answered during a
// check and the applies refused, and the two held KiCad actions. The engine
// here is this test's own module of exports (at the protocol boundary); the
// real engine is the e2e's (tests/e2e/st/st-mc-i.spec.ts, engine run 15).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HELD_ACTIONS, heldTaken } from '../held';
import { startResponder } from '../responder';
import type { ExtUnit, ResponderCtx } from './contract';
import { buildRegistry, heldActions, REGISTRY } from './registry';
import unit, {
  GENERATE_AREAS, MAX_NAMED, MULTICHANNEL_CAP, MULTICHANNEL_EXPORTS, MULTICHANNEL_ROOT, MULTICHANNEL_ROWS, multichannelLine, parseMultichannelArgs,
  readApplyDone, readAreas, readChecks, REPEAT_LAYOUT,
} from './st-mc-i';

const PARENT = 'http://localhost';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));
const enc = (v: unknown): Uint8Array => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v));
const RUN15 = { kicadMultichannel: () => '', kicadMultichannelApply: () => false, kicadCollabBusy: () => false };
const CH0 = '0b6c2f3a-9d1e-4c5b-8a7f-112233445566';
const CH1 = '1c7d3a4b-0e2f-4d6c-9b8a-223344556677';
const CH2 = '2d8e4b5c-1f3a-4e7d-8c9b-334455667788';
const FP = '3e9f5c6d-2a4b-4f8e-9d0c-445566778899';
const NEW0 = '4fa06d7e-3b5c-4a9f-8e1d-5566778899aa';
const NEW1 = '50b17e8f-4c6d-4b0a-9f2e-66778899aabb';

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
  const win = {
    FS: { analyzePath: () => ({ exists: false }), mkdirTree: () => {}, readdir: () => [], readFile: () => { throw new Error('ENOENT'); } },
    Module: { kicadOpenFileBusy: () => false, ...exports },
    wxElementRegistry: { findAll: () => [{ id: 'frame', typeName: 'PCB_EDIT_FRAME', name: 'PcbFrame', visible: true }], findByLabel: () => [] },
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

/**
 * A ResponderCtx over a fake board engine and a fake MEMFS: the folders the
 * op makes and drops are recorded; `read` plays kicadMultichannel, `engine`
 * plays kicadMultichannelApply (its records written into the run folder).
 */
function fakeCtx(opts: {
  read?: (a: Record<string, unknown>) => unknown;
  engine?: (a: Record<string, unknown>, files: Map<string, Uint8Array>) => unknown;
  idle?: () => boolean; gate?: string; checking?: boolean;
} = {}) {
  const files = new Map<string, Uint8Array>();
  const made: string[] = [];
  const dropped: string[] = [];
  const reads: Array<Record<string, unknown>> = [];
  const calls: Array<Record<string, unknown>> = [];
  let n = 0;
  const mod: Record<string, unknown> = {
    ...RUN15,
    kicadMultichannel: (json: string) => { const a = JSON.parse(json) as Record<string, unknown>; reads.push(a); return (opts.read ?? (() => ''))(a); },
    kicadMultichannelApply: (json: string) => { const a = JSON.parse(json) as Record<string, unknown>; calls.push(a); return (opts.engine ?? (() => false))(a, files); },
  };
  const ctx = {
    frame: 'pcb',
    root: '/project',
    timing: { multichannelMs: 200, applyPollMs: 5 },
    mod: () => mod,
    closed: () => false,
    checking: () => opts.checking === true,
    boardGate: (_op: string, exports: readonly string[]) => {
      if (opts.gate != null) return { ok: false, code: 'busy', message: opts.gate };
      for (const name of exports) if (typeof mod[name] !== 'function') return { ok: false, code: 'unsupported', message: name };
      return { w: {}, mod };
    },
    freshRunFolder: (root: string) => { n += 1; const d = `${root}/${n}`; made.push(d); return d; },
    dropRunFolder: (dir: string) => { dropped.push(dir); for (const k of [...files.keys()]) if (k.startsWith(`${dir}/`)) files.delete(k); },
    readBytes: (abs: string) => files.get(abs) ?? null,
    queuedRun: async (op: string, dir: string, ms: number, call: () => unknown, record: () => unknown) => {
      if (call() !== true) { dropped.push(dir); return { ok: false, code: 'not_applied', message: op }; }
      const deadline = Date.now() + ms;
      for (;;) {
        if ((opts.idle ?? (() => true))()) { const done = record(); if (done != null) return { done }; }
        if (Date.now() >= deadline) { dropped.push(dir); return { ok: false, code: 'not_applied', message: op }; }
        await settle(5);
      }
    },
    log: () => {},
  } as unknown as ResponderCtx;
  return { ctx, files, made, dropped, reads, calls };
}

const AREAS = {
  areas: [
    { key: 'sheet:/', name: 'auto-placement-area-/', source: 'sheet', sheetPath: '/', parts: 9, exists: false, zone: '' },
    { key: 'sheet:/i2c_thingy_ch0/', name: 'auto-placement-area-/i2c_thingy_ch0/', source: 'sheet', sheetPath: '/i2c_thingy_ch0/', parts: 4, exists: true, zone: CH0 },
    { key: 'sheet:/i2c_thingy_ch1/', name: 'auto-placement-area-/i2c_thingy_ch1/', source: 'sheet', sheetPath: '/i2c_thingy_ch1/', parts: 4, exists: true, zone: CH1 },
  ],
  ruleAreas: [
    { zone: CH0, name: 'ch0', source: 'sheet', sourceName: '/i2c_thingy_ch0/', parts: 4 },
    { zone: CH1, name: 'ch1', source: 'sheet', sourceName: '/i2c_thingy_ch1/', parts: 4 },
  ],
  canGenerate: true,
};
const CHECKS = { checks: [{ zone: CH1, name: 'ch1', parts: 4, matched: 4, ok: true, message: 'OK', reasons: [] }], error: '' };
const GEN_ROWS = [
  { key: 'sheet:/i2c_thingy_ch0/', name: 'auto-placement-area-/i2c_thingy_ch0/', parts: 4, ok: true, reasons: [], skipped: '', zone: NEW0 },
  { key: 'sheet:/i2c_thingy_ch1/', name: 'auto-placement-area-/i2c_thingy_ch1/', parts: 4, ok: true, reasons: [], skipped: '', zone: NEW1 },
];
const SKIP_ROWS = [
  { key: 'sheet:/i2c_thingy_ch0/', name: 'auto-placement-area-/i2c_thingy_ch0/', parts: 4, ok: false, reasons: [], skipped: 'exists' },
];
const REP_ROWS = [
  { zone: CH1, name: 'ch1', parts: 4, ok: true, reasons: [] },
  { zone: CH2, name: 'ch2', parts: 3, ok: false, reasons: ['U3 has no twin'] },
];
const report = (op: string, preview: boolean, areas: unknown[], applied: number, depth: number, error = '', message = '') =>
  ({ op, preview, areas, applied, depth, error, message });
const doneOf = (error = '') => ({ code: error === '' ? 0 : 1, error });

/** An engine that answers as kicadMultichannelApply does: the report, then the done record LAST. */
const engineWith = (r: (a: Record<string, unknown>) => ReturnType<typeof report>) => (a: Record<string, unknown>, files: Map<string, Uint8Array>) => {
  const rec = r(a);
  files.set(`${a.dir as string}/multichannel.json`, enc(rec));
  files.set(`${a.dir as string}/.cc-multichannel.json`, enc(doneOf(rec.error)));
  return true;
};

describe('st-mc-i in the registry', () => {
  it('loads in this checkout with nothing broken, owning board.multichannel and the cap multichannel', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect(REGISTRY.ops.get('board.multichannel')?.unit).toBe('st-mc-i');
    expect(REGISTRY.pending.has('board.multichannel')).toBe(false);
    expect(REGISTRY.capNames.get(MULTICHANNEL_CAP)).toBe('st-mc-i');
    expect(MULTICHANNEL_CAP).toBe('multichannel');
    expect(unit.ops['board.multichannel'].passesCheck).toBe(true);
  });

  it('lists multichannel in a pcb frame on an engine with all three exports, nothing on run 14 or in a sch frame', () => {
    expect([...MULTICHANNEL_EXPORTS]).toEqual(['kicadMultichannel', 'kicadMultichannelApply', 'kicadCollabBusy']);
    expect(unit.caps(RUN15, 'pcb')).toEqual(['multichannel']);
    expect(unit.caps(RUN15, 'sch')).toEqual([]);
    expect(unit.caps({ kicadMultichannel: () => '', kicadCollabBusy: () => false }, 'pcb')).toEqual([]);
    expect(unit.caps({ kicadCollabBusy: () => false }, 'pcb')).toEqual([]);
    expect(unit.caps({}, 'pcb')).toEqual([]);
  });

  it('a pcb frame on run 14 lists no multichannel cap and answers unsupported naming kicadMultichannel; bad args first', async () => {
    const s = await boot('pcb', { kicadCollabBusy: () => false });
    expect(s.ready?.caps).not.toContain('multichannel');
    expect(await s.ask(1, 'board.multichannel', { op: 'areas' })).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'kicadMultichannel' } });
    expect(await s.ask(2, 'board.multichannel', { op: 'list' })).toMatchObject({ ok: false, error: { code: 'bad_args', message: 'board.multichannel' } });
  });

  it('a pcb frame on run 15 lists multichannel and answers not_ready with no board open; a sch frame lists none and refuses the op', async () => {
    const pcb = await boot('pcb', RUN15);
    expect(pcb.ready?.caps).toContain('multichannel');
    expect(await pcb.ask(1, 'board.multichannel', { op: 'areas' })).toMatchObject({ ok: false, error: { code: 'not_ready', message: 'board.multichannel' } });
    const sch = await boot('sch', RUN15);
    expect(sch.ready?.caps).not.toContain('multichannel');
    expect(await sch.ask(1, 'board.multichannel', { op: 'areas' })).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'a multichannel op runs in a pcb frame' } });
  });
});

describe('the held Generate Placement Rule Areas and Repeat Layout', () => {
  const union = heldActions(buildRegistry(mods(unit)));
  it('holds exactly KiCad\'s two multichannel actions, in a pcb frame under the cap multichannel, no built in row holding them', () => {
    expect(unit.held).toEqual([GENERATE_AREAS, REPEAT_LAYOUT]);
    expect(GENERATE_AREAS).toBe('pcbnew.Multichannel.generatePlacementRuleAreas');
    expect(REPEAT_LAYOUT).toBe('pcbnew.Multichannel.repeatLayout');
    expect(unit.heldRows.map((r) => ({ ...r, frames: [...r.frames] }))).toEqual([
      { action: GENERATE_AREAS, frames: ['pcb'], cap: 'multichannel' },
      { action: REPEAT_LAYOUT, frames: ['pcb'], cap: 'multichannel' },
    ]);
    for (const row of MULTICHANNEL_ROWS) {
      expect(HELD_ACTIONS.some((h) => h.action === row.action)).toBe(false);
      expect(heldActions()).toContainEqual(row);
    }
  });
  it('the responder takes each only in a pcb frame whose ev.ready listed multichannel', () => {
    for (const a of [GENERATE_AREAS, REPEAT_LAYOUT]) {
      expect(heldTaken(a, 'pcb', ['multichannel'], union)).toBe(true);
      expect(heldTaken(a, 'pcb', ['heldKeys'], union)).toBe(false);
      expect(heldTaken(a, 'sch', ['multichannel'], union)).toBe(false);
    }
  });
});

describe('the args', () => {
  it('takes the four forms exactly', () => {
    expect(parseMultichannelArgs({ op: 'areas' })).toEqual({ op: 'areas' });
    expect(parseMultichannelArgs({ op: 'check', ref: CH0 })).toEqual({ op: 'check', ref: CH0 });
    expect(parseMultichannelArgs({ op: 'generate', areas: ['sheet:/a/', 'class:B'], replaceExisting: false })).toEqual({ op: 'generate', areas: ['sheet:/a/', 'class:B'], replaceExisting: false });
    expect(parseMultichannelArgs({ op: 'generate', areas: ['group:G'], replaceExisting: true, groupItems: true })).toEqual({ op: 'generate', areas: ['group:G'], replaceExisting: true, groupItems: true });
    expect(parseMultichannelArgs({ op: 'repeat', ref: CH0, targets: [CH1, CH2], options: {}, preview: true })).toEqual({ op: 'repeat', ref: CH0, targets: [CH1, CH2], options: {}, preview: true });
    const options = { copyRouting: true, connectedRoutingOnly: false, copyPlacement: true, copyOtherItems: false, includeLockedItems: true, anchor: FP };
    expect(parseMultichannelArgs({ op: 'repeat', ref: CH0, targets: [CH1], options, preview: false })).toEqual({ op: 'repeat', ref: CH0, targets: [CH1], options, preview: false });
    expect(parseMultichannelArgs({ op: 'repeat', ref: CH0, targets: [CH1], options: { anchor: '' }, preview: false })).toMatchObject({ options: { anchor: '' } });
    expect(parseMultichannelArgs({ op: 'generate', areas: Array.from({ length: MAX_NAMED }, (_, i) => `sheet:/s${i}/`), replaceExisting: false })).not.toBeNull();
  });
  it('refuses anything else, group the items on a repeat included', () => {
    for (const bad of [
      null, [], {}, { op: 'list' }, { op: 'areas', x: 1 }, { op: 'check' }, { op: 'check', ref: CH0.toUpperCase() }, { op: 'check', ref: 'x' }, { op: 'check', ref: CH0, x: 1 },
      { op: 'generate', areas: [], replaceExisting: false }, { op: 'generate', areas: ['a', 'a'], replaceExisting: false }, { op: 'generate', areas: [''], replaceExisting: false },
      { op: 'generate', areas: ['a'] }, { op: 'generate', areas: ['a'], replaceExisting: 1 }, { op: 'generate', areas: ['a'], replaceExisting: true, groupItems: 'yes' },
      { op: 'generate', areas: 'a', replaceExisting: true }, { op: 'generate', areas: [1], replaceExisting: true }, { op: 'generate', areas: ['x'.repeat(4097)], replaceExisting: true },
      { op: 'generate', areas: Array.from({ length: MAX_NAMED + 1 }, (_, i) => `k${i}`), replaceExisting: false }, { op: 'generate', areas: ['a'], replaceExisting: true, preview: true },
      { op: 'repeat', ref: CH0, targets: [CH1], options: {} }, { op: 'repeat', ref: CH0, targets: [], options: {}, preview: true },
      { op: 'repeat', ref: CH0, targets: [CH0], options: {}, preview: true }, { op: 'repeat', ref: CH0, targets: [CH1, CH1], options: {}, preview: true },
      { op: 'repeat', ref: CH0, targets: ['x'], options: {}, preview: true }, { op: 'repeat', ref: CH0, targets: [CH1], options: { groupItems: true }, preview: true },
      { op: 'repeat', ref: CH0, targets: [CH1], options: { copyRouting: 1 }, preview: true }, { op: 'repeat', ref: CH0, targets: [CH1], options: { anchor: 'R1' }, preview: true },
      { op: 'repeat', ref: CH0, targets: [CH1], options: [], preview: true }, { op: 'repeat', ref: CH0, targets: [CH1], options: {}, preview: 'no' },
      { op: 'repeat', ref: CH0, targets: [CH1], options: {}, preview: true, x: 1 }, { op: 'repeat', ref: 'x', targets: [CH1], options: {}, preview: true },
    ]) {
      expect(parseMultichannelArgs(bad), JSON.stringify(bad)?.slice(0, 80)).toBeNull();
    }
  });
});

describe('the engine\'s answers read closed', () => {
  it('the areas read: candidates, rule areas, canGenerate', () => {
    expect(readAreas(JSON.stringify(AREAS))).toEqual(AREAS);
    expect(readAreas(JSON.stringify({ areas: [], ruleAreas: [], canGenerate: false }))).toEqual({ areas: [], ruleAreas: [], canGenerate: false });
    for (const bad of [
      '', '{', '[]', { ...AREAS, x: 1 }, { areas: [], ruleAreas: [] }, { ...AREAS, canGenerate: 1 },
      { ...AREAS, areas: [{ ...AREAS.areas[1], exists: true, zone: '' }] }, { ...AREAS, areas: [{ ...AREAS.areas[0], zone: CH0 }] },
      { ...AREAS, areas: [{ ...AREAS.areas[0], source: 'room' }] }, { ...AREAS, areas: [{ ...AREAS.areas[0], parts: -1 }] }, { ...AREAS, areas: [{ ...AREAS.areas[0], key: '' }] },
      { ...AREAS, ruleAreas: [{ ...AREAS.ruleAreas[0], zone: '' }] }, { ...AREAS, ruleAreas: [{ ...AREAS.ruleAreas[0], extra: 1 }] },
    ]) {
      expect(readAreas(typeof bad === 'string' ? bad : JSON.stringify(bad)), JSON.stringify(bad).slice(0, 80)).toBeNull();
    }
    expect(readAreas(JSON.stringify({ ...AREAS, ruleAreas: [{ ...AREAS.ruleAreas[0], source: 'designBlock' }] }))?.ruleAreas[0].source).toBe('designBlock');
  });
  it('the check read: rows, not_found for an unknown ref', () => {
    expect(readChecks(JSON.stringify(CHECKS))).toEqual({ checks: CHECKS.checks });
    expect(readChecks(JSON.stringify({ checks: [], error: 'not_found' }))).toEqual({ error: 'not_found' });
    for (const bad of [
      '', { checks: [] }, { checks: CHECKS.checks, error: 'not_found' }, { checks: [], error: 'other' },
      { checks: [{ ...CHECKS.checks[0], reasons: [1] }], error: '' }, { checks: [{ ...CHECKS.checks[0], matched: 1.5 }], error: '' },
      { checks: [{ ...CHECKS.checks[0], message: undefined }], error: '' },
    ]) {
      expect(readChecks(typeof bad === 'string' ? bad : JSON.stringify(bad))).toBeNull();
    }
  });
  it('waits (null) until the done record is there', () => {
    expect(readApplyDone(null, null, 'generate', false)).toBeNull();
    expect(readApplyDone(null, enc(report('generate', false, GEN_ROWS, 2, 1)), 'generate', false)).toBeNull();
  });
  it('a generate and a repeat report; a generate is never a preview', () => {
    expect(readApplyDone(enc(doneOf()), enc(report('generate', false, GEN_ROWS, 2, 1)), 'generate', false)).toEqual({ report: { preview: false, areas: GEN_ROWS, applied: 2, depth: 1 } });
    expect(readApplyDone(enc(doneOf()), enc(report('generate', false, SKIP_ROWS, 0, 0)), 'generate', false)).toEqual({ report: { preview: false, areas: SKIP_ROWS, applied: 0, depth: 0 } });
    expect(readApplyDone(enc(doneOf()), enc(report('repeat', true, REP_ROWS, 1, 3)), 'repeat', true)).toEqual({ report: { preview: true, areas: REP_ROWS, applied: 1, depth: 3 } });
    expect(readApplyDone(enc(doneOf()), enc(report('repeat', false, REP_ROWS, 1, 4)), 'repeat', false)).toEqual({ report: { preview: false, areas: REP_ROWS, applied: 1, depth: 4 } });
  });
  it('the engine\'s errors carry its message', () => {
    for (const e of ['not_found', 'too_few', 'copy_failed', 'no_board', 'failed'] as const) {
      expect(readApplyDone(enc(doneOf(e)), enc(report('repeat', false, [], 0, 2, e, `m ${e}`)), 'repeat', false)).toEqual({ error: e, message: `m ${e}` });
    }
  });
  it('any other shape is a bad record', () => {
    const d = enc(doneOf());
    for (const [done, rep, op, preview] of [
      [enc('{'), enc(report('generate', false, [], 0, 0)), 'generate', false], [enc({ code: 0 }), enc(report('generate', false, [], 0, 0)), 'generate', false],
      [enc({ code: 1, error: '' }), enc(report('generate', false, [], 0, 0)), 'generate', false], [enc({ code: 0, error: 'too_few' }), enc(report('generate', false, [], 0, 0, 'too_few')), 'generate', false],
      [enc(doneOf('odd')), enc(report('generate', false, [], 0, 0, 'odd')), 'generate', false], [d, null, 'generate', false], [d, enc('{'), 'generate', false],
      [d, enc(report('repeat', false, REP_ROWS, 1, 1)), 'generate', false], [d, enc(report('repeat', true, REP_ROWS, 1, 1)), 'repeat', false],
      [d, enc(report('generate', true, GEN_ROWS, 2, 1)), 'generate', false], [d, enc({ ...report('generate', false, GEN_ROWS, 2, 1), x: 1 }), 'generate', false],
      [d, enc(report('generate', false, [{ ...GEN_ROWS[0], zone: undefined }], 1, 1)), 'generate', false],
      [d, enc(report('generate', false, [{ ...SKIP_ROWS[0], zone: CH0 }], 0, 1)), 'generate', false],
      [d, enc(report('generate', false, [{ ...SKIP_ROWS[0], skipped: 'gone' }], 0, 1)), 'generate', false],
      [d, enc(report('repeat', false, [{ ...REP_ROWS[0], zone: 'x' }], 1, 1)), 'repeat', false], [d, enc(report('repeat', false, REP_ROWS, -1, 1)), 'repeat', false],
      [d, enc({ ...report('repeat', false, REP_ROWS, 1, 1), message: undefined }), 'repeat', false], [d, enc({ ...report('repeat', false, REP_ROWS, 1, 1), message: 3 }), 'repeat', false],
      [enc(doneOf('too_few')), enc(report('generate', false, [], 0, 0, 'not_found')), 'generate', false],
    ] as Array<[Uint8Array, Uint8Array | null, 'generate' | 'repeat', boolean]>) {
      expect(readApplyDone(done, rep, op, preview), rep == null ? 'none' : new TextDecoder().decode(rep)).toEqual({ error: 'bad' });
    }
  });
  it('KiCad\'s line: the first line, no run folder named, at most 1,024 characters, ours when empty', () => {
    expect(multichannelLine('Copy failed\nsecond', 'x')).toBe('Copy failed');
    expect(multichannelLine(`in ${MULTICHANNEL_ROOT}/3/a`, 'x')).toBe('in a');
    expect(multichannelLine('', 'ours')).toBe('ours');
    expect([...multichannelLine('y'.repeat(5000), 'x')]).toHaveLength(1024);
  });
});

describe('board.multichannel on an engine with the exports', () => {
  const run = unit.ops['board.multichannel'].run;

  it('the areas read passes the engine\'s answer, nothing made or queued', async () => {
    const f = fakeCtx({ read: () => JSON.stringify(AREAS) });
    expect(await run({ op: 'areas' }, f.ctx)).toEqual({ ok: true, result: AREAS });
    expect(f.reads).toEqual([{ op: 'areas' }]);
    expect(f.made).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it('the check read answers the rows; an unknown ref is not_found naming it; an empty answer not_applied; another shape island_error', async () => {
    const good = fakeCtx({ read: () => JSON.stringify(CHECKS) });
    expect(await run({ op: 'check', ref: CH0 }, good.ctx)).toEqual({ ok: true, result: { checks: CHECKS.checks } });
    expect(good.reads).toEqual([{ op: 'check', ref: CH0 }]);
    const missing = fakeCtx({ read: () => JSON.stringify({ checks: [], error: 'not_found' }) });
    expect(await run({ op: 'check', ref: CH2 }, missing.ctx)).toEqual({ ok: false, code: 'not_found', message: CH2 });
    expect(await run({ op: 'areas' }, fakeCtx({ read: () => '' }).ctx)).toEqual({ ok: false, code: 'not_applied', message: 'board.multichannel' });
    expect(await run({ op: 'areas' }, fakeCtx({ read: () => '{"areas":1}' }).ctx)).toEqual({ ok: false, code: 'island_error', message: 'the engine answered areas of another shape' });
    expect(await run({ op: 'check', ref: CH0 }, fakeCtx({ read: () => 7 }).ctx)).toEqual({ ok: false, code: 'island_error', message: 'the engine answered a multichannel read of another shape' });
    expect(await run({ op: 'areas' }, fakeCtx({ read: () => { throw new Error('boom'); } }).ctx)).toEqual({ ok: false, code: 'island_error', message: 'boom' });
  });

  it('generate runs in a fresh /tmp/cc-multichannel/<n>, sends the args with run and dir, answers the report, removes the folder', async () => {
    const f = fakeCtx({ engine: engineWith(() => report('generate', false, GEN_ROWS, 2, 1)) });
    expect(await run({ op: 'generate', areas: ['sheet:/i2c_thingy_ch0/', 'sheet:/i2c_thingy_ch1/'], replaceExisting: true }, f.ctx))
      .toEqual({ ok: true, result: { preview: false, areas: GEN_ROWS, applied: 2, depth: 1 } });
    expect(f.made).toEqual([`${MULTICHANNEL_ROOT}/1`]);
    expect(f.calls).toEqual([{ run: 1, dir: `${MULTICHANNEL_ROOT}/1`, op: 'generate', areas: ['sheet:/i2c_thingy_ch0/', 'sheet:/i2c_thingy_ch1/'], replaceExisting: true }]);
    expect(f.dropped).toEqual([`${MULTICHANNEL_ROOT}/1`]);
    expect(f.files.size).toBe(0);
    const g = fakeCtx({ engine: engineWith(() => report('generate', false, SKIP_ROWS, 0, 0)) });
    await run({ op: 'generate', areas: ['sheet:/i2c_thingy_ch0/'], replaceExisting: false, groupItems: true }, g.ctx);
    expect(g.calls[0]).toEqual({ run: 1, dir: `${MULTICHANNEL_ROOT}/1`, op: 'generate', areas: ['sheet:/i2c_thingy_ch0/'], replaceExisting: false, groupItems: true });
  });

  it('repeat sends exactly the seven keys the engine takes and answers the preview or the apply', async () => {
    const f = fakeCtx({ engine: engineWith((a) => report('repeat', a.preview as boolean, REP_ROWS, 1, a.preview === true ? 3 : 4)) });
    expect(await run({ op: 'repeat', ref: CH0, targets: [CH1, CH2], options: { copyRouting: false, anchor: FP }, preview: true }, f.ctx))
      .toEqual({ ok: true, result: { preview: true, areas: REP_ROWS, applied: 1, depth: 3 } });
    expect(f.calls[0]).toEqual({ run: 1, dir: `${MULTICHANNEL_ROOT}/1`, op: 'repeat', ref: CH0, targets: [CH1, CH2], options: { copyRouting: false, anchor: FP }, preview: true });
    expect(Object.keys(f.calls[0])).toHaveLength(7);
    expect(await run({ op: 'repeat', ref: CH0, targets: [CH1], options: {}, preview: false }, f.ctx))
      .toEqual({ ok: true, result: { preview: false, areas: REP_ROWS, applied: 1, depth: 4 } });
    expect(f.dropped).toEqual(f.made);
    expect(f.files.size).toBe(0);
  });

  it('the engine\'s errors map to codes, every folder gone', async () => {
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ['not_found', CH2, { ok: false, code: 'not_found', message: CH2 }],
      ['too_few', 'Cannot auto-generate any placement areas because the schematic has only one or no hierarchical sheets, groups, or component classes.', { ok: false, code: 'too_few' }],
      ['copy_failed', `Copy failed in ${MULTICHANNEL_ROOT}/1/x\nmore`, { ok: false, code: 'copy_failed', message: 'Copy failed in x' }],
      ['no_board', '', { ok: false, code: 'not_ready', message: 'board.multichannel' }],
      ['failed', '', { ok: false, code: 'island_error', message: 'the multichannel run failed' }],
    ];
    for (const [error, message, want] of cases) {
      const f = fakeCtx({ engine: engineWith(() => report('repeat', false, [], 0, 2, error, message)) });
      expect(await run({ op: 'repeat', ref: CH0, targets: [CH2], options: {}, preview: false }, f.ctx)).toMatchObject(want);
      expect(f.dropped).toEqual(f.made);
      expect(f.files.size).toBe(0);
    }
  });

  it('a record of another shape is island_error; a refused run not_applied; a throw island_error; past its bound not_applied; every folder gone', async () => {
    const odd = fakeCtx({ engine: (a, files) => { files.set(`${a.dir as string}/.cc-multichannel.json`, enc(doneOf())); return true; } });
    expect(await run({ op: 'generate', areas: ['a'], replaceExisting: false }, odd.ctx)).toEqual({ ok: false, code: 'island_error', message: 'the engine answered a multichannel record of another shape' });
    const refusedRun = fakeCtx({ engine: () => false });
    expect(await run({ op: 'generate', areas: ['a'], replaceExisting: false }, refusedRun.ctx)).toEqual({ ok: false, code: 'not_applied', message: 'board.multichannel' });
    const thrown = fakeCtx({ engine: () => { throw new Error('boom'); } });
    expect(await run({ op: 'generate', areas: ['a'], replaceExisting: false }, thrown.ctx)).toEqual({ ok: false, code: 'island_error', message: 'boom' });
    const stuck = fakeCtx({ engine: engineWith(() => report('generate', false, GEN_ROWS, 2, 1)), idle: () => false });
    expect(await run({ op: 'generate', areas: ['a'], replaceExisting: false }, stuck.ctx)).toEqual({ ok: false, code: 'not_applied', message: 'board.multichannel' });
    for (const f of [odd, refusedRun, thrown, stuck]) {
      expect(f.dropped).toEqual(expect.arrayContaining(f.made));
      expect(f.files.size).toBe(0);
    }
  });

  it('during a check the reads are answered and the applies answer busy before anything is made', async () => {
    const f = fakeCtx({ read: () => JSON.stringify(AREAS), engine: engineWith(() => report('generate', false, GEN_ROWS, 2, 1)), checking: true });
    expect(await run({ op: 'areas' }, f.ctx)).toEqual({ ok: true, result: AREAS });
    expect(await run({ op: 'generate', areas: ['a'], replaceExisting: false }, f.ctx)).toEqual({ ok: false, code: 'busy', message: 'board.multichannel' });
    expect(await run({ op: 'repeat', ref: CH0, targets: [CH1], options: {}, preview: true }, f.ctx)).toEqual({ ok: false, code: 'busy', message: 'board.multichannel' });
    expect(f.made).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it('the gate answers before anything: bad args, then the board gate', async () => {
    const f = fakeCtx({ gate: 'board.multichannel' });
    expect(await run({ op: 'areas' }, f.ctx)).toEqual({ ok: false, code: 'busy', message: 'board.multichannel' });
    expect(await run({ op: 'list' }, f.ctx)).toEqual({ ok: false, code: 'bad_args', message: 'board.multichannel' });
    expect(f.reads).toEqual([]);
    expect(f.made).toEqual([]);
  });
});
