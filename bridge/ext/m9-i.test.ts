// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// m9-i: sheet.pins.get, sheet.pins.apply and sheet.pins.place, the cap
// syncPins feature detected on the engine's kicadSheetPinsGet,
// kicadSheetPinsApply, kicadSheetPinsPlace, kicadCollabBusy and
// kicadCollabGetSelection, KiCad's two Sync Sheet Pins actions held under it,
// the args and the engine's answers read closed, and the run folder under
// /tmp/cc-sheet-pins removed after every answer. The engine here is this
// test's own module of exports (at the protocol boundary); the real engine is
// the e2e's (tests/e2e/sheet-pins.spec.ts, engine run 15).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { heldTaken } from '../held';
import { startResponder } from '../responder';
import type { ExtUnit, ResponderCtx } from './contract';
import unit, {
  ACTIONS_MAX, APPLY_EXPORTS, GET_EXPORTS, M9_HELD_ROWS, NAME_MAX, NAMES_MAX, PAIRS_MAX, parseApplyArgs, parseGetArgs, parsePlaceArgs,
  PINS_CAP, PINS_ROOT, PLACE_EXPORTS, readAction, readApplyDone, readPair, readRow, readSheetPins, SHEETS_MAX, SYNC_ALL_SHEETS_PINS, SYNC_SHEET_PINS,
} from './m9-i';
import { buildRegistry, heldActions, REGISTRY } from './registry';

const PARENT = 'http://localhost';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));
const enc = (v: unknown): Uint8Array => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v));
const RUN15 = {
  kicadSheetPinsGet: () => '', kicadSheetPinsApply: () => false, kicadSheetPinsPlace: () => false,
  kicadCollabBusy: () => false, kicadCollabGetSelection: () => '[]',
};

const U = (n: number): string => `5e7a1b00-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const SHEET = U(0x150);
const A = { name: 'A', pin: U(0x151), label: U(0x201), pinShape: 'input', labelShape: 'input' };
const B = { name: 'B', pin: null, label: U(0x202), pinShape: null, labelShape: 'input' };
const C = { name: 'C', pin: U(0x152), label: U(0x203), pinShape: 'input', labelShape: 'output' };
const D = { name: 'D', pin: U(0x153), label: null, pinShape: 'input', labelShape: null };
const ROW = { sheet: SHEET, sheetPath: `/${U(0x100)}/`, name: 'io', file: 'io.kicad_sch', pairs: [A, B, C, D] };
const SUB = `/${U(0x100)}/${SHEET}/`;
const ACTIONS = [
  { op: 'renameLabel', label: U(0x204), sheetPath: SUB, to: 'E1' },
  { op: 'shapePin', pin: C.pin, to: 'output' },
  { op: 'removePin', pin: D.pin },
];

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

/**
 * A ResponderCtx over a fake engine in a sch frame and a fake MEMFS: `get`
 * plays kicadSheetPinsGet, `engine` kicadSheetPinsApply (its record written
 * into the run folder it is given), `place` kicadSheetPinsPlace and `sel` the
 * selection read after each call.
 */
function fakeCtx(opts: {
  get?: (json: string) => unknown; engine?: (a: Record<string, unknown>, files: Map<string, Uint8Array>) => unknown; gate?: string;
  place?: (json: string) => unknown; sel?: () => string[]; hanging?: boolean; cancels?: boolean; idle?: boolean;
} = {}) {
  const files = new Map<string, Uint8Array>();
  const made: string[] = [];
  const dropped: string[] = [];
  const calls: Array<Record<string, unknown>> = [];
  const gets: string[] = [];
  const placed: string[] = [];
  const started: string[] = [];
  let canceled = 0;
  let n = 0;
  const mod: Record<string, unknown> = {
    ...RUN15,
    kicadSheetPinsGet: (json: string) => { gets.push(json); return (opts.get ?? (() => JSON.stringify({ sheets: [], truncated: false })))(json); },
    kicadSheetPinsApply: (json: string) => { const a = JSON.parse(json) as Record<string, unknown>; calls.push(a); return (opts.engine ?? (() => false))(a, files); },
    kicadSheetPinsPlace: (json: string) => { placed.push(json); return (opts.place ?? (() => true))(json); },
    kicadCollabGetSelection: () => JSON.stringify(opts.sel?.() ?? []),
  };
  const w = { Module: mod };
  const ctx = {
    frame: 'sch',
    root: '/project',
    timing: { sheetPinsMs: 200, applyPollMs: 5, placeMs: 120, placePollMs: 2, sheetPinSettleMs: 30 },
    mod: () => mod,
    closed: () => false,
    placeHanging: () => opts.hanging ?? false,
    placeCancel: async () => { canceled += 1; return opts.cancels ?? true; },
    placeStart: (uuid: string) => { started.push(uuid); },
    applyIdle: async () => opts.idle ?? true,
    schematicGate: (_op: string, exports: readonly string[]) => {
      if (opts.gate != null) return { ok: false, code: 'busy', message: opts.gate };
      for (const name of exports) if (typeof mod[name] !== 'function') return { ok: false, code: 'unsupported', message: name };
      return { w, mod };
    },
    freshRunFolder: (root: string) => { n += 1; const d = `${root}/${n}`; made.push(d); return d; },
    dropRunFolder: (dir: string) => { dropped.push(dir); for (const k of [...files.keys()]) if (k.startsWith(`${dir}/`)) files.delete(k); },
    readBytes: (abs: string) => files.get(abs) ?? null,
    queuedRun: async (op: string, dir: string, ms: number, call: () => unknown, record: () => unknown) => {
      if (call() !== true) return { ok: false, code: 'not_applied', message: op };
      const deadline = Date.now() + ms;
      for (;;) {
        const done = record();
        if (done != null) return { done };
        if (Date.now() >= deadline) return { ok: false, code: 'not_applied', message: op };
        await settle(5);
      }
    },
    log: () => {},
  } as unknown as ResponderCtx;
  return { ctx, files, made, dropped, calls, gets, placed, started, canceled: () => canceled };
}

/** An engine that applies as kicadSheetPinsApply does: sheet-pins.json last, one commit. */
const applying = (depth: number) => (a: Record<string, unknown>, files: Map<string, Uint8Array>) => {
  files.set(`${a.dir as string}/sheet-pins.json`, enc({ applied: (a.actions as unknown[]).length, depth }));
  return true;
};

const runGet = (ctx: ResponderCtx, args?: unknown) => unit.ops['sheet.pins.get'].run(args, ctx);
const runApply = (ctx: ResponderCtx, args: unknown) => unit.ops['sheet.pins.apply'].run(args, ctx);
const runPlace = (ctx: ResponderCtx, args: unknown) => unit.ops['sheet.pins.place'].run(args, ctx);
const PLACE_PIN = { sheet: SHEET, sheetPath: `/${U(0x100)}/`, place: 'pin', names: ['B'] };
const PLACE_LABEL = { sheet: SHEET, sheetPath: `/${U(0x100)}/`, place: 'label', names: ['D'] };

describe('m9-i in the registry', () => {
  it('loads in this checkout with nothing broken, owning the three ops and the cap syncPins', () => {
    expect(REGISTRY.problems).toEqual([]);
    for (const op of ['sheet.pins.get', 'sheet.pins.apply', 'sheet.pins.place']) {
      expect(REGISTRY.ops.get(op)?.unit).toBe('m9-i');
      expect(REGISTRY.pending.has(op)).toBe(false);
    }
    expect(REGISTRY.capNames.get(PINS_CAP)).toBe('m9-i');
    expect(PINS_CAP).toBe('syncPins');
    expect(unit.ops['sheet.pins.get'].passesCheck).toBe(true);
    expect('passesCheck' in unit.ops['sheet.pins.apply']).toBe(false);
    expect('passesCheck' in unit.ops['sheet.pins.place']).toBe(false);
  });

  it('lists syncPins in a sch frame only on an engine with every export; nothing on run 14 or in another frame', () => {
    expect([...GET_EXPORTS]).toEqual(['kicadSheetPinsGet']);
    expect([...APPLY_EXPORTS]).toEqual(['kicadSheetPinsApply', 'kicadCollabBusy']);
    expect([...PLACE_EXPORTS]).toEqual(['kicadSheetPinsPlace', 'kicadCollabBusy', 'kicadCollabGetSelection']);
    expect(unit.caps(RUN15, 'sch')).toEqual(['syncPins']);
    for (const f of ['pcb', 'symedit', 'fpedit', 'ds']) expect(unit.caps(RUN15, f as never)).toEqual([]);
    for (const missing of Object.keys(RUN15)) {
      const less: Record<string, unknown> = { ...RUN15 };
      delete less[missing];
      expect(unit.caps(less, 'sch'), missing).toEqual([]);
    }
  });

  it('holds KiCad\'s two Sync Sheet Pins actions in a sch frame under syncPins, the names of sch_actions.cpp', () => {
    expect(SYNC_SHEET_PINS).toBe('eeschema.InteractiveDrawing.syncSheetPins');
    expect(SYNC_ALL_SHEETS_PINS).toBe('eeschema.InteractiveDrawing.syncAllSheetsPins');
    expect((unit as ExtUnit).held).toEqual([SYNC_SHEET_PINS, SYNC_ALL_SHEETS_PINS]);
    expect((unit as ExtUnit).heldRows).toEqual(M9_HELD_ROWS.map((r) => ({ action: r.action, frames: ['sch'], cap: 'syncPins' })));
    const union = heldActions();
    for (const action of [SYNC_SHEET_PINS, SYNC_ALL_SHEETS_PINS]) {
      expect(heldTaken(action, 'sch', [PINS_CAP], union), action).toBe(true);
      // Without the cap (run 14) KiCad keeps its own action; in a pcb frame the action is not ours to hold.
      expect(heldTaken(action, 'sch', [], union), action).toBe(false);
      expect(heldTaken(action, 'pcb', [PINS_CAP], union), action).toBe(false);
    }
  });

  it('run 14: the cap is not listed and each op answers unsupported naming its first missing export; bad args first', async () => {
    const s = await boot('sch', { kicadCollabBusy: () => false, kicadCollabGetSelection: () => '[]' });
    expect(s.ready?.caps).not.toContain('syncPins');
    expect(await s.ask(1, 'sheet.pins.get')).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'kicadSheetPinsGet' } });
    expect(await s.ask(2, 'sheet.pins.apply', { actions: ACTIONS })).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'kicadSheetPinsApply' } });
    expect(await s.ask(3, 'sheet.pins.place', PLACE_PIN)).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'kicadSheetPinsPlace' } });
    expect(await s.ask(4, 'sheet.pins.get', { all: true })).toMatchObject({ ok: false, error: { code: 'bad_args', message: 'sheet.pins.get' } });
    expect(await s.ask(5, 'sheet.pins.apply', { actions: [] })).toMatchObject({ ok: false, error: { code: 'bad_args', message: 'sheet.pins.apply' } });
    expect(await s.ask(6, 'sheet.pins.place', { ...PLACE_PIN, names: [] })).toMatchObject({ ok: false, error: { code: 'bad_args', message: 'sheet.pins.place' } });
  });

  it('run 15: the cap listed, not_ready with no schematic open; a pcb frame refuses the three ops', async () => {
    const sch = await boot('sch', RUN15);
    expect(sch.ready?.caps).toContain('syncPins');
    expect(await sch.ask(1, 'sheet.pins.get')).toMatchObject({ ok: false, error: { code: 'not_ready', message: 'sheet.pins.get' } });
    expect(await sch.ask(2, 'sheet.pins.apply', { actions: ACTIONS })).toMatchObject({ ok: false, error: { code: 'not_ready', message: 'sheet.pins.apply' } });
    expect(await sch.ask(3, 'sheet.pins.place', PLACE_PIN)).toMatchObject({ ok: false, error: { code: 'not_ready', message: 'sheet.pins.place' } });
    const pcb = await boot('pcb', RUN15);
    expect(pcb.ready?.caps ?? []).not.toContain('syncPins');
    for (const [i, op, args] of [[1, 'sheet.pins.get', undefined], [2, 'sheet.pins.apply', { actions: ACTIONS }], [3, 'sheet.pins.place', PLACE_PIN]] as const) {
      expect(await pcb.ask(i, op, args)).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'a sheet pins op runs in a sch frame' } });
    }
  });
});

describe('the reads', () => {
  it('a pair is read closed: a name, at least one side, each side\'s shape present exactly with it', () => {
    for (const p of [A, B, C, D]) expect(readPair(p)).toEqual(p);
    for (const bad of [
      null, [], { ...A, more: 1 }, { ...A, name: 3 }, { ...A, pin: 'PIN' }, { ...A, pin: A.pin.toUpperCase() }, { ...A, pinShape: 'dot' },
      { ...A, pinShape: null }, { ...B, pinShape: 'input' }, { ...D, labelShape: 'input' }, { ...A, label: null },
      { name: 'X', pin: null, label: null, pinShape: null, labelShape: null }, { name: 'A', pin: A.pin, label: A.label, pinShape: 'input' },
    ]) {
      expect(readPair(bad), JSON.stringify(bad)?.slice(0, 80)).toBeNull();
    }
    for (const s of ['input', 'output', 'bidirectional', 'tri_state', 'passive']) expect(readPair({ ...A, pinShape: s, labelShape: s })).not.toBeNull();
  });
  it('a sheet\'s row is read closed, at most 4,096 pairs', () => {
    expect(readRow(ROW)).toEqual(ROW);
    expect(readRow({ ...ROW, pairs: [] })).toEqual({ ...ROW, pairs: [] });
    expect(readRow({ ...ROW, pairs: Array.from({ length: PAIRS_MAX }, () => A) })).not.toBeNull();
    for (const bad of [
      { ...ROW, pairs: Array.from({ length: PAIRS_MAX + 1 }, () => A) }, { ...ROW, extra: 1 }, { ...ROW, sheet: 'S' }, { ...ROW, sheetPath: '' },
      { ...ROW, name: null }, { ...ROW, file: 1 }, { ...ROW, pairs: {} }, { ...ROW, pairs: [{ ...A, more: 1 }] },
    ]) {
      expect(readRow(bad), JSON.stringify(bad).slice(0, 80)).toBeNull();
    }
  });
  it('the engine\'s answer is exactly { sheets, truncated }', () => {
    expect(readSheetPins(JSON.stringify({ sheets: [ROW], truncated: false }))).toEqual({ sheets: [ROW], truncated: false });
    expect(readSheetPins('{"sheets":[],"truncated":true}')).toEqual({ sheets: [], truncated: true });
    for (const bad of ['', 'nope', '[]', '{}', '{"sheets":[]}', '{"sheets":[],"truncated":0}', JSON.stringify({ sheets: [ROW], truncated: false, more: 1 }), JSON.stringify({ sheets: [{}], truncated: false })]) {
      expect(readSheetPins(bad), bad.slice(0, 60)).toBeNull();
    }
  });
});

describe('the args', () => {
  it('get takes none, or exactly { sheets } of 1 to 4,096 { uuid, sheetPath }', () => {
    expect(parseGetArgs(undefined)).toBe('all');
    expect(parseGetArgs({})).toBe('all');
    const one = [{ uuid: SHEET, sheetPath: '/' }];
    expect(parseGetArgs({ sheets: one })).toEqual(one);
    expect(parseGetArgs({ sheets: Array.from({ length: SHEETS_MAX }, () => one[0]) })).not.toBeNull();
    for (const bad of [
      null, [], 'all', { sheets: [] }, { sheets: one, more: 1 }, { sheets: Array.from({ length: SHEETS_MAX + 1 }, () => one[0]) },
      { sheets: [{ uuid: SHEET }] }, { sheets: [{ uuid: SHEET, sheetPath: '' }] }, { sheets: [{ uuid: 'S', sheetPath: '/' }] },
      { sheets: [{ uuid: SHEET, sheetPath: '/', more: 1 }] }, { sheets: [{ uuid: SHEET, sheetPath: 'a\0b' }] },
    ]) {
      expect(parseGetArgs(bad), JSON.stringify(bad)?.slice(0, 80)).toBeNull();
    }
  });
  it('each action is closed per its op: uuids lowercase, a label with its sheet path, a name of 1 to 1,024 characters, a port shape', () => {
    const all = [
      { op: 'renamePin', pin: A.pin, to: 'A2' }, { op: 'renameLabel', label: A.label, sheetPath: SUB, to: 'A2' },
      { op: 'shapePin', pin: A.pin, to: 'tri_state' }, { op: 'shapeLabel', label: A.label, sheetPath: SUB, to: 'passive' },
      { op: 'removePin', pin: A.pin }, { op: 'removeLabel', label: A.label, sheetPath: SUB },
    ];
    for (const a of all) expect(readAction(a)).toEqual(a);
    expect(readAction({ op: 'renamePin', pin: A.pin, to: 'é'.repeat(NAME_MAX) })).not.toBeNull();
    for (const bad of [
      null, { op: 'swapPin', pin: A.pin }, { op: 'renamePin', pin: A.pin }, { op: 'renamePin', pin: A.pin, to: '' },
      { op: 'renamePin', pin: A.pin, to: 'a\nb' }, { op: 'renamePin', pin: A.pin, to: 'x'.repeat(NAME_MAX + 1) },
      { op: 'renamePin', pin: A.pin, to: 'X', sheetPath: SUB }, { op: 'renameLabel', label: A.label, to: 'X' },
      { op: 'renameLabel', label: A.label, sheetPath: '', to: 'X' }, { op: 'shapePin', pin: A.pin, to: 'dot' },
      { op: 'shapeLabel', label: A.label, sheetPath: SUB, to: 'Input' }, { op: 'removePin', pin: A.pin, to: 'X' },
      { op: 'removeLabel', label: A.label }, { op: 'removePin', pin: 'PIN' }, { op: 'removePin', label: A.label },
    ]) {
      expect(readAction(bad), JSON.stringify(bad)).toBeNull();
    }
  });
  it('apply takes exactly { actions } of 1 to 4,096', () => {
    expect(parseApplyArgs({ actions: ACTIONS })).toEqual(ACTIONS);
    expect(parseApplyArgs({ actions: Array.from({ length: ACTIONS_MAX }, () => ACTIONS[2]) })).not.toBeNull();
    for (const bad of [null, {}, { actions: [] }, { actions: ACTIONS, more: 1 }, { actions: [ACTIONS[0], {}] }, { actions: Array.from({ length: ACTIONS_MAX + 1 }, () => ACTIONS[2]) }]) {
      expect(parseApplyArgs(bad), JSON.stringify(bad)?.slice(0, 80)).toBeNull();
    }
  });
  it('place takes exactly { sheet, sheetPath, place: pin or label, names (1 to 64) }', () => {
    expect(parsePlaceArgs(PLACE_PIN)).toEqual(PLACE_PIN);
    expect(parsePlaceArgs(PLACE_LABEL)).toEqual(PLACE_LABEL);
    expect(parsePlaceArgs({ ...PLACE_PIN, names: Array.from({ length: NAMES_MAX }, (_, i) => `N${i}`) })).not.toBeNull();
    for (const bad of [
      null, {}, { ...PLACE_PIN, more: 1 }, { ...PLACE_PIN, place: 'both' }, { ...PLACE_PIN, names: [] }, { ...PLACE_PIN, names: [''] },
      { ...PLACE_PIN, names: Array.from({ length: NAMES_MAX + 1 }, (_, i) => `N${i}`) }, { ...PLACE_PIN, names: ['a\tb'] }, { ...PLACE_PIN, names: 'B' },
      { ...PLACE_PIN, sheet: SHEET.toUpperCase() }, { ...PLACE_PIN, sheetPath: '' },
    ]) {
      expect(parsePlaceArgs(bad), JSON.stringify(bad)?.slice(0, 80)).toBeNull();
    }
  });
  it('the apply\'s record is read closed', () => {
    expect(readApplyDone(null)).toBeNull();
    expect(readApplyDone(enc({ applied: 3, depth: 7 }))).toEqual({ report: { applied: 3, depth: 7 } });
    for (const bad of ['nope', { applied: 3 }, { applied: -1, depth: 7 }, { applied: 3, depth: 7, more: 1 }, { applied: '3', depth: 7 }]) {
      expect(readApplyDone(enc(bad)), JSON.stringify(bad)).toEqual({ error: 'bad' });
    }
  });
});

describe('sheet.pins.get', () => {
  it('answers each sheet\'s pairs; the asked sheets go to the engine as they came, none as {}', async () => {
    const f = fakeCtx({ get: () => JSON.stringify({ sheets: [ROW], truncated: false }) });
    expect(await runGet(f.ctx)).toEqual({ ok: true, result: { sheets: [ROW], truncated: false } });
    const asked = [{ uuid: SHEET, sheetPath: ROW.sheetPath }];
    expect(await runGet(f.ctx, { sheets: asked })).toEqual({ ok: true, result: { sheets: [ROW], truncated: false } });
    expect(f.gets.map((g) => JSON.parse(g))).toEqual([{}, { sheets: asked }]);
  });
  it('bad_args before the gate; the gate\'s refusal as it is; "" is not_ready; another shape or a throw is island_error', async () => {
    expect(await runGet(fakeCtx({ gate: 'sheet.pins.get' }).ctx, { x: 1 })).toEqual({ ok: false, code: 'bad_args', message: 'sheet.pins.get' });
    expect(await runGet(fakeCtx({ gate: 'sheet.pins.get' }).ctx)).toEqual({ ok: false, code: 'busy', message: 'sheet.pins.get' });
    expect(await runGet(fakeCtx({ get: () => '' }).ctx)).toEqual({ ok: false, code: 'not_ready', message: 'sheet.pins.get' });
    expect(await runGet(fakeCtx({ get: () => '{"sheets":[{}],"truncated":false}' }).ctx)).toMatchObject({ ok: false, code: 'island_error' });
    expect(await runGet(fakeCtx({ get: () => { throw new Error('boom'); } }).ctx)).toEqual({ ok: false, code: 'island_error', message: 'boom' });
  });
});

describe('sheet.pins.apply', () => {
  it('queues every action as one run in a fresh folder under /tmp/cc-sheet-pins, answers the count applied, and removes the folder', async () => {
    const f = fakeCtx({ engine: applying(5) });
    expect(await runApply(f.ctx, { actions: ACTIONS })).toEqual({ ok: true, result: { applied: 3 } });
    expect(f.calls).toEqual([{ run: 1, dir: `${PINS_ROOT}/1`, actions: ACTIONS }]);
    expect(f.made).toEqual(['/tmp/cc-sheet-pins/1']);
    expect(f.dropped).toEqual(f.made);
    expect(f.files.size).toBe(0);
  });
  it('a refused run is not_applied; a throw island_error; a record of another shape island_error; the folder removed each time', async () => {
    const refused = fakeCtx({ engine: () => false });
    expect(await runApply(refused.ctx, { actions: ACTIONS })).toEqual({ ok: false, code: 'not_applied', message: 'sheet.pins.apply' });
    expect(refused.dropped).toEqual(refused.made);
    const threw = fakeCtx({ engine: () => { throw new Error('boom'); } });
    expect(await runApply(threw.ctx, { actions: ACTIONS })).toEqual({ ok: false, code: 'island_error', message: 'boom' });
    expect(threw.dropped).toEqual(threw.made);
    const odd = fakeCtx({ engine: (a, files) => { files.set(`${a.dir as string}/sheet-pins.json`, enc({ applied: 1 })); return true; } });
    expect(await runApply(odd.ctx, { actions: ACTIONS })).toEqual({ ok: false, code: 'island_error', message: 'the engine answered an apply of another shape' });
    expect(odd.dropped).toEqual(odd.made);
  });
  it('bad_args and the gate come before any folder', async () => {
    const f = fakeCtx({ gate: 'sheet.pins.apply' });
    expect(await runApply(f.ctx, { actions: [{ op: 'removePin' }] })).toEqual({ ok: false, code: 'bad_args', message: 'sheet.pins.apply' });
    expect(await runApply(f.ctx, { actions: ACTIONS })).toEqual({ ok: false, code: 'busy', message: 'sheet.pins.apply' });
    expect(f.made).toEqual([]);
  });
});

describe('sheet.pins.place', () => {
  it('a label: the engine armed with the args as they came, answered once the new label hangs, joined to the place watch', async () => {
    const NEW = U(0x999);
    let calls = 0;
    const f = fakeCtx({ sel: () => (calls++ < 3 ? [SHEET] : [NEW]) });
    expect(await runPlace(f.ctx, PLACE_LABEL)).toEqual({ ok: true, result: { hanging: true } });
    expect(f.placed.map((p) => JSON.parse(p))).toEqual([PLACE_LABEL]);
    expect(f.started).toEqual([NEW]);
  });
  it('a pin: answered with hanging false once the tool runs with nothing hanging, never the sheet itself', async () => {
    const f = fakeCtx({ sel: () => [SHEET] });
    expect(await runPlace(f.ctx, PLACE_PIN)).toEqual({ ok: true, result: { hanging: false } });
    expect(f.started).toEqual([]);
  });
  it('a pin that hangs at once is joined to the watch', async () => {
    const NEW = U(0x998);
    let calls = 0;
    const f = fakeCtx({ sel: () => (calls++ === 0 ? [] : [NEW]) });
    expect(await runPlace(f.ctx, PLACE_PIN)).toEqual({ ok: true, result: { hanging: true } });
    expect(f.started).toEqual([NEW]);
  });
  it('a label that never hangs is busy', async () => {
    const f = fakeCtx({ sel: () => [] });
    expect(await runPlace(f.ctx, PLACE_LABEL)).toEqual({ ok: false, code: 'busy', message: 'sheet.pins.place: the editor did not take the placement' });
  });
  it('an item still hanging is dropped first; one that would not go is busy and nothing is armed', async () => {
    let g = 0;
    const goes = fakeCtx({ hanging: true, sel: () => (g++ === 0 ? [] : [U(0x997)]) });
    expect(await runPlace(goes.ctx, PLACE_LABEL)).toMatchObject({ ok: true });
    expect(goes.canceled()).toBe(1);
    const stays = fakeCtx({ hanging: true, cancels: false });
    expect(await runPlace(stays.ctx, PLACE_LABEL)).toEqual({ ok: false, code: 'busy', message: 'the previous item still hangs off the pointer' });
    expect(stays.placed).toEqual([]);
    const none = fakeCtx({ sel: () => [U(0x996)] });
    await runPlace(none.ctx, PLACE_LABEL);
    expect(none.canceled()).toBe(0);
  });
  it('a name with no counterpart (the engine says false) is not_applied; a throw island_error; an editor that never runs the tool not_applied', async () => {
    expect(await runPlace(fakeCtx({ place: () => false }).ctx, PLACE_PIN))
      .toEqual({ ok: false, code: 'not_applied', message: 'sheet.pins.place: the sheet is not there, or a name has no hierarchical label of its name' });
    expect(await runPlace(fakeCtx({ place: () => false }).ctx, PLACE_LABEL))
      .toEqual({ ok: false, code: 'not_applied', message: 'sheet.pins.place: the sheet is not there, or a name has no sheet pin of its name' });
    expect(await runPlace(fakeCtx({ place: () => { throw new Error('boom'); } }).ctx, PLACE_PIN)).toEqual({ ok: false, code: 'island_error', message: 'boom' });
    expect(await runPlace(fakeCtx({ idle: false }).ctx, PLACE_PIN)).toEqual({ ok: false, code: 'not_applied', message: 'sheet.pins.place: the editor did not take the placement' });
  });
  it('bad_args and the gate come before the engine', async () => {
    const f = fakeCtx({ gate: 'sheet.pins.place' });
    expect(await runPlace(f.ctx, { ...PLACE_PIN, place: 'both' })).toEqual({ ok: false, code: 'bad_args', message: 'sheet.pins.place' });
    expect(await runPlace(f.ctx, PLACE_PIN)).toEqual({ ok: false, code: 'busy', message: 'sheet.pins.place' });
    expect(f.placed).toEqual([]);
  });
});
