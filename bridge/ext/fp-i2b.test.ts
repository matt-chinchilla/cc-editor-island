// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// fp-i2b as the responder runs it, beside fp-i1 (which defines the fpedit
// frame): fpedit.padDefaults.get and .set, fpedit.enumerate, each check in
// its order, the cap fpeditHeld per frame and ev.fpedit from the footprint
// editor's asks. The engine here is this test's own fake of the fpedit
// exports and the ask marker (FP spec 5.1, 5.2 and 11), at the protocol
// boundary.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startResponder, timing } from '../responder';
import type { ExtUnit } from './contract';
import { buildRegistry, REGISTRY } from './registry';
import { FPEDIT_EXPORTS, FPEDIT_FRAME_ONLY } from '../fpedit/common';
import type { FpEditAskWindow } from '../fpedit/ask';
import fp1 from './fp-i1';
import unit, { parseEnumerateArgs, parsePadDefaultsSetArgs, readPadDefaults } from './fp-i2b';

const PARENT = 'http://localhost';
const P1 = '77777777-0000-4000-8000-000000000001';
const SOIC = '(footprint "SOIC-8_3.9x4.9mm_P1.27mm"\n\t(version 20240108)\n)\n';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));
const err = (code: string, message: string) => ({ ok: false, error: { code, message } });
const OPS = ['fpedit.padDefaults.get', 'fpedit.padDefaults.set', 'fpedit.enumerate'];
type Rec = Record<string, unknown>;

/** The master pad as kicadFpEditPadDefaultsGet writes it: a pad record with no kind and no uuid, from 0, 0. */
const MASTER = {
  number: '1', pinName: '', pinType: '', type: 'th', x: 0, y: 0, angle: 0, locked: false, padstack: 'normal',
  copper: { shape: 'circle', size: [1.6, 1.6], offset: [0, 0], delta: [0, 0], roundRatio: 0.25, chamferRatio: 0.2, chamferCorners: [], anchor: 'circle', primitives: [] },
  layerShapes: [], drill: { shape: 'circle', size: [0.8, 0.8] }, layers: ['F.Cu', 'B.Cu', 'F.Mask', 'B.Mask'], dieLength: 0, dieDelay: 0,
  clearance: null, maskMargin: null, pasteMargin: null, pasteRatio: null, zoneConnection: 'inherit', customZoneShape: 'outline',
  thermalSpokeWidth: null, thermalGap: null, thermalAngle: 90, property: 'none', unconnectedLayers: 'keep_all',
  teardrop: { enabled: false, useTwoTracks: true, preferZoneConnection: true, maxLength: 1, maxWidth: 2, lengthRatio: 0.5, widthRatio: 1, curved: false, sizeFilterRatio: 0.9 },
  backdrill: { front: null, back: null },
  postMachining: { front: { mode: 'none', size: 0, depth: 0, angle: 0 }, back: { mode: 'none', size: 0, depth: 0, angle: 0 } },
};

const saved = { editPollMs: timing.editPollMs, symeditMs: timing.symeditMs, selectMs: timing.selectMs };
beforeEach(() => {
  timing.editPollMs = 20;
  timing.symeditMs = 150;
  timing.selectMs = 150;
  vi.stubGlobal('KeyboardEvent', class extends Event {
    constructor(type: string, init: Record<string, unknown> = {}) {
      const { bubbles, cancelable, composed, ...rest } = init as EventInit & Record<string, unknown>;
      super(type, { bubbles, cancelable, composed });
      Object.assign(this, rest);
    }
  });
});
afterEach(() => {
  Object.assign(timing, saved);
  vi.unstubAllGlobals();
});

/**
 * The fake engine's fpedit exports, the asks' marker beside them unless
 * `marker` is false: one footprint of `pads` pads once opened, the master
 * pad, and the numbering loop's start.
 */
function fakeFp(o: { marker?: boolean; pads?: number; padEditMode?: boolean; refuseSet?: boolean; refuseEnum?: boolean } = {}) {
  const st = { token: '', open: false, name: '', lib: '', mode: 'library', modified: false, depth: 0, padCount: 0, type: 'unspecified', padEditMode: false };
  let master: Rec = structuredClone(MASTER);
  const calls: Array<[string, unknown]> = [];
  const exports: Rec = {
    ...Object.fromEntries(FPEDIT_EXPORTS.map((n) => [n, () => false])),
    kicadFpEditOpen: (j: string) => {
      const a = JSON.parse(j) as { name: string; lib: string; mode: string; token: string };
      Object.assign(st, { token: a.token, open: true, name: a.name, lib: a.lib, mode: a.mode, modified: false, depth: 0, padCount: o.pads ?? 8, type: 'smd', padEditMode: o.padEditMode ?? false });
      return true;
    },
    kicadFpEditState: () => JSON.stringify(st),
    kicadFpEditItemsGet: () => '{"items":[]}',
    kicadFpEditSelection: () => '{"uuids":[]}',
    kicadFpEditPadDefaultsGet: () => JSON.stringify(master),
    kicadFpEditPadDefaultsSet: (j: string) => {
      const a = JSON.parse(j) as { set: Rec };
      calls.push(['padDefaults', a]);
      if (o.refuseSet) return false;
      const { copper, ...rest } = a.set;
      master = { ...master, ...rest, ...(copper == null ? {} : { copper: { ...(master.copper as Rec), ...(copper as Rec) } }) };
      return true;
    },
    kicadFpEditEnumerate: (j: string) => {
      calls.push(['enumerate', JSON.parse(j)]);
      return o.refuseEnum !== true;
    },
    kicadCollabBusy: () => false,
    kicadCollabPresenceStart: () => true,
    kicadHostActions: () => true,
    ...(o.marker === false ? {} : { kicadHostFpEdit: () => true }),
  };
  return { st, exports, calls };
}

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

/** A responder with fp-i1 and fp-i2b, connected and booted on a fake engine with `exports`; `got` collects what the host hears. */
async function boot(frame: string, exports: Rec, busy = { now: false }) {
  const reg = buildRegistry(mods(fp1, unit));
  expect(reg.problems).toEqual([]);
  const { page, parent } = fakePage(`?frame=${frame}&theme=day`);
  const r = startResponder({ parentOrigin: PARENT, page, ext: reg });
  const ch = new MessageChannel();
  const got: Rec[] = [];
  ch.port1.onmessage = (m) => got.push(m.data);
  page.dispatch('message', { origin: PARENT, source: page.parent, data: { type: 'cc.connect', nonce: parent.postMessage.mock.calls[0][0].nonce }, ports: [ch.port2] });
  const Module: Rec = { kicadOpenFileBusy: () => busy.now, ...exports };
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const win = {
    FS: { analyzePath: () => ({ exists: false }), mkdirTree: () => {}, readdir: () => [], readFile: () => { throw new Error('ENOENT'); } },
    Module,
    wxElementRegistry: { findAll: () => [{ id: 'frame', typeName: 'FOOTPRINT_EDIT_FRAME', name: 'FootprintEditor', visible: true }], findByLabel: () => [] },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    addEventListener: (t: string, h: (e: unknown) => void) => { const s = listeners.get(t) ?? new Set(); s.add(h); listeners.set(t, s); },
    removeEventListener: (t: string, h: (e: unknown) => void) => listeners.get(t)?.delete(h),
    dispatchEvent: () => true,
  } as unknown as ToolWindow & FpEditAskWindow;
  r.engineReady(win, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
  await settle();
  let next = 1;
  const ask = async (op: string, args?: unknown, wait = 30) => {
    const id = next++;
    ch.port1.postMessage(args === undefined ? { id, op } : { id, op, args });
    for (let i = 0; i < 40 && got.find((m) => m.id === id) == null; i++) await settle(wait / 3);
    const m = got.find((x) => x.id === id);
    if (m == null) return undefined;
    const { id: _id, ...rest } = m;
    void _id;
    return rest;
  };
  const open = () => ask('fpedit.open', { text: SOIC, name: 'SOIC', lib: 'parts', mode: 'library', discard: true });
  const ready = got.find((m) => m.type === 'ev.ready') as { caps: string[] } | undefined;
  return { r, got, win, ask, open, caps: (ready?.caps ?? []).filter((c) => !/^kicad/.test(c)) };
}
const result = (a: unknown) => (a as { result: Rec }).result;

describe('fp-i2b in the registry', () => {
  it('loads with this checkout\'s units, its three ops, the cap fpeditHeld and ev.fpedit', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect([...REGISTRY.ops.entries()].filter(([, op]) => op.unit === 'fp-i2b').map(([op]) => op).sort()).toEqual([...OPS].sort());
    expect(REGISTRY.capNames.get('fpeditHeld')).toBe('fp-i2b');
    expect(REGISTRY.events.get('ev.fpedit')?.keys).toEqual(['ask', 'uuid', 'isNew']);
    expect(unit.ops['fpedit.padDefaults.get'].passesCheck).toBe(true);
  });
});

describe('the args and the engine\'s answers, read closed', () => {
  it('reads the master pad with no kind and no uuid; anything else is null', () => {
    expect(readPadDefaults(JSON.stringify(MASTER))).toEqual(MASTER);
    expect(readPadDefaults('')).toBeNull();
    expect(readPadDefaults(JSON.stringify({ ...MASTER, kind: 'pad' }))).toBeNull();
    expect(readPadDefaults(JSON.stringify({ ...MASTER, uuid: P1 }))).toBeNull();
    expect(readPadDefaults(JSON.stringify({ ...MASTER, extra: 1 }))).toBeNull();
    const { drill: _d, ...short } = MASTER;
    void _d;
    expect(readPadDefaults(JSON.stringify(short))).toBeNull();
  });

  it('reads a pad defaults set as a pad set is read, and the numbers within the window\'s ranges', () => {
    expect(parsePadDefaultsSetArgs({ set: { copper: { size: [1, 2] }, number: '5' } })).toEqual({ set: { copper: { size: [1, 2] }, number: '5' } });
    for (const bad of [{}, { set: {} }, { set: { kind: 'pad' } }, { set: { copper: { size: [1, 2] } }, more: 1 }, { set: { width: 1 } }, null])
      expect(parsePadDefaultsSetArgs(bad), JSON.stringify(bad)).toBeNull();
    expect(parseEnumerateArgs({ start: 1, step: 1, prefix: '' })).toEqual({ start: 1, step: 1, prefix: '' });
    expect(parseEnumerateArgs({ start: 0, step: 999, prefix: 'A'.repeat(64) })).toEqual({ start: 0, step: 999, prefix: 'A'.repeat(64) });
    for (const bad of [
      { start: 1, step: 1 }, { start: -1, step: 1, prefix: '' }, { start: 1, step: 1000, prefix: '' }, { start: 1.5, step: 1, prefix: '' },
      { start: 1, step: 1, prefix: 'A'.repeat(65) }, { start: 1, step: 1, prefix: 'A\n' }, { start: 1, step: 1, prefix: 3 }, { start: 1, step: 1, prefix: '', x: 1 },
    ]) expect(parseEnumerateArgs(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe('caps per frame', () => {
  it('an fpedit frame on an engine that asks the page lists fpeditHeld beside fpedit and takes the slot', async () => {
    const t = await boot('fpedit', fakeFp().exports);
    expect(t.caps).toEqual(['fpedit', 'fpeditHeld', 'heldKeys', 'hostKeys', 'write']);
    expect(typeof t.win.kicadHostFpEdit?.onRequest).toBe('function');
  });

  it('without the marker no fpeditHeld and no slot; on engine run 14 neither cap and every op names the first missing export', async () => {
    const t = await boot('fpedit', fakeFp({ marker: false }).exports);
    expect(t.caps).toEqual(['fpedit', 'heldKeys', 'hostKeys', 'write']);
    expect(t.win.kicadHostFpEdit).toBeUndefined();
    const old = await boot('fpedit', { kicadHostActions: () => true, kicadHostFpEdit: () => true });
    expect(old.caps).not.toContain('fpeditHeld');
    expect(old.win.kicadHostFpEdit).toBeUndefined();
    for (const op of OPS) expect(await old.ask(op, op === 'fpedit.padDefaults.get' ? undefined : {}), op).toEqual(op === 'fpedit.padDefaults.get' ? err('unsupported', 'kicadFpEditOpen') : err('bad_args', op));
    expect(await old.ask('fpedit.padDefaults.set', { set: { number: '3' } })).toEqual(err('unsupported', 'kicadFpEditOpen'));
    expect(await old.ask('fpedit.enumerate', { start: 1, step: 1, prefix: '' })).toEqual(err('unsupported', 'kicadFpEditOpen'));
  });

  it('a sch, pcb or symedit frame lists no fpeditHeld, takes no slot and answers every op unsupported', async () => {
    for (const frame of ['sch', 'pcb', 'symedit']) {
      const t = await boot(frame, fakeFp().exports);
      expect(t.caps, frame).not.toContain('fpeditHeld');
      expect(t.win.kicadHostFpEdit, frame).toBeUndefined();
      expect(await t.ask('fpedit.padDefaults.get'), frame).toEqual(err('unsupported', FPEDIT_FRAME_ONLY));
      expect(await t.ask('fpedit.padDefaults.set', { set: { number: '3' } }), frame).toEqual(err('unsupported', FPEDIT_FRAME_ONLY));
      expect(await t.ask('fpedit.enumerate', { start: 1, step: 1, prefix: '' }), frame).toEqual(err('unsupported', FPEDIT_FRAME_ONLY));
    }
  });
});

describe('the pad defaults', () => {
  it('reads the master pad with no footprint open, sets its size and number with no undo step, read back', async () => {
    const f = fakeFp();
    const t = await boot('fpedit', f.exports);
    expect(result(await t.ask('fpedit.padDefaults.get'))).toEqual(MASTER);
    const after = result(await t.ask('fpedit.padDefaults.set', { set: { copper: { size: [1, 2] }, number: '9' } }));
    expect(after).toMatchObject({ number: '9', copper: { shape: 'circle', size: [1, 2] } });
    expect(f.calls).toEqual([['padDefaults', { set: { copper: { size: [1, 2] }, number: '9' } }]]);
    expect(f.st.depth).toBe(0);
    expect(f.st.modified).toBe(false);
  });

  it('refuses a set of another shape before the engine, KiCad\'s refusal as bad_args, a pad of another shape as island_error, busy while a load is parked', async () => {
    const f = fakeFp({ refuseSet: true });
    const busy = { now: false };
    const t = await boot('fpedit', f.exports, busy);
    expect(await t.ask('fpedit.padDefaults.set', { set: { copper: { size: [1, 2] } }, extra: true })).toEqual(err('bad_args', 'fpedit.padDefaults.set'));
    expect(await t.ask('fpedit.padDefaults.get', { x: 1 })).toEqual(err('bad_args', 'fpedit.padDefaults.get'));
    expect(f.calls).toEqual([]);
    expect(await t.ask('fpedit.padDefaults.set', { set: { drill: { shape: 'circle', size: [0.3, 0.3] } } })).toEqual(err('bad_args', 'fpedit.padDefaults.set: KiCad\'s pad rules refuse the set'));
    busy.now = true;
    expect(await t.ask('fpedit.padDefaults.get')).toEqual(err('busy', 'fpedit.padDefaults.get'));
    const odd = await boot('fpedit', { ...fakeFp().exports, kicadFpEditPadDefaultsGet: () => JSON.stringify({ ...MASTER, kind: 'pad', uuid: P1 }) });
    expect(await odd.ask('fpedit.padDefaults.get')).toEqual(err('island_error', 'the engine answered a pad of another shape'));
  });
});

describe('the numbering', () => {
  it('starts KiCad\'s loop with the page\'s numbers and answers {} at once; no_footprint before an open', async () => {
    const f = fakeFp();
    const t = await boot('fpedit', f.exports);
    expect(await t.ask('fpedit.enumerate', { start: 1, step: 2, prefix: 'A' })).toEqual(err('no_footprint', 'fpedit.enumerate'));
    await t.open();
    expect(result(await t.ask('fpedit.enumerate', { start: 1, step: 2, prefix: 'A' }))).toEqual({});
    expect(f.calls).toEqual([['enumerate', { start: 1, step: 2, prefix: 'A' }]]);
  });

  it('refuses a footprint with no pads, pad edit mode and a loop KiCad does not start; bad numbers before the engine', async () => {
    const none = await boot('fpedit', fakeFp({ pads: 0 }).exports);
    await none.open();
    expect(await none.ask('fpedit.enumerate', { start: 1, step: 1, prefix: '' })).toEqual(err('bad_args', 'fpedit.enumerate: the footprint has no pads'));
    const apart = await boot('fpedit', fakeFp({ padEditMode: true }).exports);
    await apart.open();
    expect(await apart.ask('fpedit.enumerate', { start: 1, step: 1, prefix: '' })).toEqual(err('busy', 'fpedit.enumerate: a pad is taken apart'));
    const f = fakeFp({ refuseEnum: true });
    const t = await boot('fpedit', f.exports);
    await t.open();
    expect(await t.ask('fpedit.enumerate', { start: 1, step: 1000, prefix: '' })).toEqual(err('bad_args', 'fpedit.enumerate'));
    expect(f.calls).toEqual([]);
    expect(await t.ask('fpedit.enumerate', { start: 1, step: 1, prefix: '' })).toEqual(err('not_applied', 'fpedit.enumerate'));
  });
});

describe('ev.fpedit', () => {
  it('each ask goes out once per request, only after ev.ready with a footprint open; a form KiCad never sends is left to its window', async () => {
    const t = await boot('fpedit', fakeFp().exports);
    const press = (ask: string, uuid: string, isNew: boolean) => t.win.kicadHostFpEdit?.onRequest?.(JSON.stringify({ ask, uuid, isNew }));
    expect(press('pad', P1, false)).toBe(false);
    await t.open();
    expect(press('pad', P1, false)).toBe(true);
    expect(press('footprint', '', false)).toBe(true);
    expect(press('padDefaults', '', false)).toBe(true);
    expect(press('enumerate', '', false)).toBe(true);
    expect(press('text', P1, true)).toBe(true);
    expect(press('image', '', true)).toBe(true);
    expect(press('pad', '', false)).toBe(false);
    expect(press('footprint', P1, false)).toBe(false);
    await settle();
    expect(t.got.filter((m) => m.type === 'ev.fpedit')).toEqual([
      { type: 'ev.fpedit', ask: 'pad', uuid: P1, isNew: false },
      { type: 'ev.fpedit', ask: 'footprint', uuid: '', isNew: false },
      { type: 'ev.fpedit', ask: 'padDefaults', uuid: '', isNew: false },
      { type: 'ev.fpedit', ask: 'enumerate', uuid: '', isNew: false },
      { type: 'ev.fpedit', ask: 'text', uuid: P1, isNew: true },
      { type: 'ev.fpedit', ask: 'image', uuid: '', isNew: true },
    ]);
  });
});
