// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// fp-i2a: fpedit.items.get, set, add and remove, each check in its order and
// each read back, against this test's own fake of the engine's item exports
// (FP spec 11, kicadFpEditItemsGet, Set, Add, Remove, kicadFpEditState) at the
// protocol boundary; and, as the responder runs the unit, every frame but the
// footprint editor's answering the four ops unsupported.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startResponder, timing } from '../responder';
import type { ExtUnit, ResponderCtx } from './contract';
import { buildRegistry, REGISTRY } from './registry';
import unit, {
  FP_ITEMS_EXPORTS, FPEDIT_FRAME_ONLY, fpItemsAdd, fpItemsGet, fpItemsRemove, fpItemsSet, parseFpItemsAddArgs, parseFpItemsGetArgs,
  parseFpItemsRemoveArgs, parseFpItemsSetArgs, readFpItems, readFpOpenState,
} from './fp-i2a';

const PARENT = 'http://localhost';
const U = (n: number): string => `abcdef55-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OPS = ['fpedit.items.get', 'fpedit.items.set', 'fpedit.items.add', 'fpedit.items.remove'];
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const err = (code: string, message: string) => ({ ok: false, code, message });

const style = { layer: 'F.SilkS', angle: 0, size: [1, 1], thickness: 0.15, autoThickness: false, bold: false, italic: false, mirrored: false, hJustify: 'center', vJustify: 'center', knockout: false, font: 'KiCad Font' };
const field = (uuid: string, name: string, t: string) => ({ kind: 'field', uuid, name, text: t, x: 0, y: -3, visible: true, keepUpright: true, ...style });
const copper = { shape: 'rect', size: [1.5, 0.6], offset: [0, 0], delta: [0, 0], roundRatio: 0, chamferRatio: 0, chamferCorners: [], anchor: 'circle', primitives: [] };
const pad = (uuid: string, number: string, x: number) => ({
  kind: 'pad', uuid, number, pinName: '', pinType: '', type: 'smd', x, y: 0, angle: 0, locked: false, padstack: 'normal', copper, layerShapes: [],
  drill: null, layers: ['F.Cu', 'F.Paste', 'F.Mask'], dieLength: 0, dieDelay: 0, clearance: null, maskMargin: null, pasteMargin: null, pasteRatio: null,
  zoneConnection: 'inherit', customZoneShape: 'outline', thermalSpokeWidth: null, thermalGap: null, thermalAngle: 90, property: 'none',
  unconnectedLayers: 'keep_all',
  teardrop: { enabled: false, useTwoTracks: true, preferZoneConnection: true, maxLength: 1, maxWidth: 2, lengthRatio: 0.5, widthRatio: 1, curved: false, sizeFilterRatio: 0.9 },
  backdrill: { front: null, back: null },
  postMachining: { front: { mode: 'none', size: 0, depth: 0, angle: 0 }, back: { mode: 'none', size: 0, depth: 0, angle: 0 } },
});
const line = (uuid: string) => ({ kind: 'shape', uuid, layer: 'F.SilkS', shape: 'segment', points: [[0, 0], [1, 0]], width: 0.12, style: 'solid', filled: false, fill: 'none', locked: false, hasSolderMask: false, solderMaskMargin: null });

type Item = Record<string, unknown> & { kind: string; uuid: string };
const merge = (into: Record<string, unknown>, patch: Record<string, unknown>): void => {
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v === 'object' && v !== null && !Array.isArray(v) && typeof into[k] === 'object' && into[k] !== null) merge(into[k] as Record<string, unknown>, v as Record<string, unknown>);
    else into[k] = structuredClone(v);
  }
};

/** The fake engine: one open footprint of Reference, Value, two pads and a silk line; each change applied on the next turn, one undo step. */
function fakeEngine(o: { refuse?: boolean; never?: boolean; reset?: (it: Item) => void; open?: boolean } = {}) {
  const st = { open: o.open ?? true, depth: 0 };
  let items: Item[] = [field(U(1), 'Reference', 'REF**'), field(U(2), 'Value', 'SOIC'), pad(U(3), '1', -1), pad(U(4), '2', 1), line(U(5))];
  const calls: Array<{ name: string; arg: unknown }> = [];
  const later = (f: () => void) => { if (!o.never) setTimeout(() => { f(); st.depth++; }, 1); };
  const mod: Record<string, unknown> = {
    kicadFpEditState: () => JSON.stringify({ token: 't', open: st.open, name: 'SOIC', lib: 'parts', mode: 'library', modified: st.depth > 0, depth: st.depth, padCount: 2, type: 'smd', padEditMode: false }),
    kicadFpEditItemsGet: (j: string) => {
      const a = JSON.parse(j) as { uuids?: string[]; kinds?: string[]; layers?: string[] };
      calls.push({ name: 'get', arg: a });
      if (a.uuids != null && a.uuids.some((u) => !items.some((i) => i.uuid === u))) return '';
      const out = items.filter((i) => (a.uuids == null || a.uuids.includes(i.uuid)) && (a.kinds == null || a.kinds.includes(i.kind))
        && (a.layers == null || [...((i.layers as string[]) ?? []), i.layer].some((l) => a.layers?.includes(l as string))));
      return JSON.stringify({ items: out });
    },
    kicadFpEditItemsSet: (j: string) => {
      const a = JSON.parse(j) as { uuids: string[]; set: Record<string, unknown> };
      calls.push({ name: 'set', arg: a });
      if (o.refuse) return false;
      later(() => { for (const it of items) if (a.uuids.includes(it.uuid)) { merge(it, a.set); o.reset?.(it); } });
      return true;
    },
    kicadFpEditItemsAdd: (j: string) => {
      const a = JSON.parse(j) as { items: Item[] };
      calls.push({ name: 'add', arg: a });
      if (o.refuse) return false;
      later(() => { for (const n of a.items) items.push(n.kind === 'shape' ? { ...line(n.uuid), ...n } : { ...pad(n.uuid, '', 0), ...n }); });
      return true;
    },
    kicadFpEditItemsRemove: (j: string) => {
      const a = JSON.parse(j) as { uuids: string[] };
      calls.push({ name: 'remove', arg: a });
      if (o.refuse) return false;
      later(() => { items = items.filter((i) => !a.uuids.includes(i.uuid)); });
      return true;
    },
    kicadCollabBusy: () => false,
  };
  return { st, mod, calls, items: () => items };
}

/** The responder's ctx in an fpedit frame as these ops read it, over `mod`. */
function fakeCtx(mod: Record<string, unknown> | null, o: { frame?: string; busy?: boolean; blocked?: boolean } = {}): ResponderCtx {
  return {
    frame: o.frame ?? 'fpedit',
    root: '/project',
    timing: { symeditMs: 150, applyPollMs: 2 },
    win: () => (mod == null ? null : ({} as never)),
    mod: () => mod,
    engineBusy: () => o.busy === true,
    keysBlocked: () => o.blocked === true,
    closed: () => false,
    applyIdle: async () => true,
    log: () => {},
  } as unknown as ResponderCtx;
}

describe('the unit in the registry', () => {
  it('loads with nothing broken and owns the four item ops, answered in the fpedit frame only', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect([...REGISTRY.ops.entries()].filter(([, op]) => op.unit === 'fp-i2a').map(([op]) => op).sort()).toEqual([...OPS].sort());
    const reg = buildRegistry({ './fp-i2a.ts': { default: unit as ExtUnit } }, {}, { fpedit: 'fp-i1' });
    expect(reg.problems).toEqual([]);
    expect(unit.frames).toEqual(['fpedit']);
    expect(unit.ops['fpedit.items.get'].passesCheck).toBe(true);
  });
});

describe('outside the footprint editor', () => {
  const saved = { editPollMs: timing.editPollMs };
  beforeEach(() => { timing.editPollMs = 20; });
  afterEach(() => { Object.assign(timing, saved); vi.unstubAllGlobals(); });

  it('a sch, pcb or symedit frame answers every item op unsupported and never calls the engine', async () => {
    for (const frame of ['sch', 'pcb', 'symedit']) {
      const reg = buildRegistry({ './fp-i2a.ts': { default: unit as ExtUnit } }, {}, { fpedit: 'fp-i1' });
      const listeners = new Map<string, Set<(e: unknown) => void>>();
      const parent = { postMessage: vi.fn() };
      const page = {
        parent, top: {}, location: { search: `?frame=${frame}&theme=day` },
        addEventListener: (t: string, h: (e: unknown) => void) => { const s = listeners.get(t) ?? new Set(); s.add(h); listeners.set(t, s); },
        removeEventListener: (t: string, h: (e: unknown) => void) => listeners.get(t)?.delete(h),
      };
      const r = startResponder({ parentOrigin: PARENT, page: page as unknown as Window, ext: reg });
      const ch = new MessageChannel();
      const got: Array<Record<string, unknown>> = [];
      ch.port1.onmessage = (m) => got.push(m.data);
      for (const h of listeners.get('message') ?? []) h({ origin: PARENT, source: parent, data: { type: 'cc.connect', nonce: parent.postMessage.mock.calls[0][0].nonce }, ports: [ch.port2] });
      const f = fakeEngine();
      const win = {
        FS: { analyzePath: () => ({ exists: false }), mkdirTree: () => {}, readdir: () => [], readFile: () => { throw new Error('ENOENT'); } },
        Module: { kicadOpenFileBusy: () => false, kicadHostActions: () => true, ...f.mod },
        wxElementRegistry: { findAll: () => [], findByLabel: () => [] },
        document: { querySelector: () => null, querySelectorAll: () => [] },
        dispatchEvent: () => true,
      };
      r.engineReady(win as never, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
      await settle();
      for (const [i, op] of OPS.entries()) {
        ch.port1.postMessage({ id: i + 1, op, args: { uuids: [U(3)] } });
        for (let n = 0; n < 40 && got.find((m) => m.id === i + 1) == null; n++) await settle(5);
        expect(got.find((m) => m.id === i + 1), `${frame} ${op}`).toEqual({ id: i + 1, ok: false, error: { code: 'unsupported', message: FPEDIT_FRAME_ONLY } });
      }
      expect(f.calls).toEqual([]);
      r.close?.();
    }
  });
});

describe('the args, read closed', () => {
  it('get: nothing, or uuids, kinds and layers each 1 or more and none twice', () => {
    expect(parseFpItemsGetArgs(undefined)).toEqual({});
    expect(parseFpItemsGetArgs({})).toEqual({});
    expect(parseFpItemsGetArgs({ uuids: [U(1)], kinds: ['pad'], layers: ['F.Cu'] })).toEqual({ uuids: [U(1)], kinds: ['pad'], layers: ['F.Cu'] });
    for (const bad of [null, [], { other: 1 }, { uuids: [] }, { uuids: [U(1), U(1)] }, { uuids: ['X'] }, { kinds: ['group'] }, { kinds: [] },
      { kinds: ['pad', 'pad'] }, { layers: ['F Cu'] }, { layers: Array.from({ length: 257 }, (_, i) => `User.${i}`) }, { uuids: Array.from({ length: 4097 }, (_, i) => U(i)) }]) {
      expect(parseFpItemsGetArgs(bad), JSON.stringify(bad).slice(0, 60)).toBeNull();
    }
  });
  it('set: exactly uuids and a non empty set', () => {
    expect(parseFpItemsSetArgs({ uuids: [U(3)], set: { x: 1 } })).toEqual({ uuids: [U(3)], set: { x: 1 } });
    for (const bad of [{ uuids: [U(3)] }, { uuids: [U(3)], set: {} }, { uuids: [U(3)], set: [] }, { uuids: [], set: { x: 1 } }, { uuids: [U(3)], set: { x: 1 }, more: 1 }]) {
      expect(parseFpItemsSetArgs(bad)).toBeNull();
    }
  });
  it('add: 1 to 512 new items, none twice; remove: 1 to 4,096 uuids', () => {
    const n = { kind: 'shape', uuid: U(9), layer: 'F.SilkS', shape: 'segment', points: [[0, 0], [1, 1]] };
    expect(parseFpItemsAddArgs({ items: [n] })).toEqual({ items: [n] });
    expect(parseFpItemsAddArgs({ items: [n, n] })).toBeNull();
    expect(parseFpItemsAddArgs({ items: [] })).toBeNull();
    expect(parseFpItemsAddArgs({ items: Array.from({ length: 513 }, (_, i) => ({ ...n, uuid: U(100 + i) })) })).toBeNull();
    expect(parseFpItemsAddArgs({ items: [{ ...n, kind: 'point' }] })).toBeNull();
    expect(parseFpItemsRemoveArgs({ uuids: [U(5)] })).toEqual({ uuids: [U(5)] });
    expect(parseFpItemsRemoveArgs({ uuids: [U(5)], more: true })).toBeNull();
  });
  it('the engine\'s answers: items each a record, no uuid twice; the state\'s open and depth', () => {
    expect(readFpItems(JSON.stringify({ items: [line(U(5))] }))).toHaveLength(1);
    expect(readFpItems(JSON.stringify({ items: [line(U(5)), line(U(5))] }))).toBeNull();
    expect(readFpItems(JSON.stringify({ items: [{ ...line(U(5)), width: -1 }] }))).toBeNull();
    expect(readFpItems(JSON.stringify({ items: [{ kind: 'point', uuid: U(5) }] }))).toBeNull();
    expect(readFpItems('')).toBeNull();
    expect(readFpItems('{"items":[],"more":1}')).toBeNull();
    expect(readFpOpenState('{"open":true,"depth":2}')).toEqual({ open: true, depth: 2 });
    expect(readFpOpenState('{"open":true,"depth":-1}')).toBeNull();
  });
});

describe('the checks in their order', () => {
  it('bad_args first, then the frame, the engine, the exports, busy, a footprint open', async () => {
    const f = fakeEngine();
    expect(await fpItemsSet({ uuids: [] }, fakeCtx(null, { frame: 'pcb' }))).toEqual(err('bad_args', 'fpedit.items.set'));
    expect(fpItemsGet({}, fakeCtx(f.mod, { frame: 'pcb' }))).toEqual(err('unsupported', FPEDIT_FRAME_ONLY));
    expect(fpItemsGet({}, fakeCtx(null))).toEqual(err('not_ready', 'fpedit.items.get'));
    for (const name of FP_ITEMS_EXPORTS) {
      const { [name]: _gone, ...less } = f.mod;
      void _gone;
      expect(fpItemsGet({}, fakeCtx(less)), name).toEqual(err('unsupported', name));
    }
    expect(fpItemsGet({}, fakeCtx(f.mod, { busy: true }))).toEqual(err('busy', 'fpedit.items.get'));
    expect(await fpItemsRemove({ uuids: [U(5)] }, fakeCtx(f.mod, { blocked: true }))).toEqual(err('busy', 'fpedit.items.remove'));
    expect(fpItemsGet({}, fakeCtx(fakeEngine({ open: false }).mod))).toEqual(err('no_footprint', 'fpedit.items.get'));
    expect(fpItemsGet({}, fakeCtx({ ...f.mod, kicadFpEditState: () => 'nope' }))).toEqual(err('island_error', 'the engine answered a state of another shape'));
    expect(f.calls).toEqual([]);
  });
});

describe('fpedit.items.get', () => {
  it('answers every item in the engine\'s order, filtered as asked', () => {
    const f = fakeEngine();
    const all = fpItemsGet({}, fakeCtx(f.mod)) as { ok: true; result: { items: Item[] } };
    expect(all.ok).toBe(true);
    expect(all.result.items.map((i) => i.uuid)).toEqual([U(1), U(2), U(3), U(4), U(5)]);
    const pads = fpItemsGet({ kinds: ['pad'] }, fakeCtx(f.mod)) as { ok: true; result: { items: Item[] } };
    expect(pads.result.items.map((i) => i.kind)).toEqual(['pad', 'pad']);
    const one = fpItemsGet({ uuids: [U(4)] }, fakeCtx(f.mod)) as { ok: true; result: { items: Item[] } };
    expect(one.result.items.map((i) => i.uuid)).toEqual([U(4)]);
    expect(f.calls.map((c) => c.arg)).toEqual([{}, { kinds: ['pad'] }, { uuids: [U(4)] }]);
  });
  it('names the first uuid the footprint does not hold, and an item of another shape is island_error', () => {
    const f = fakeEngine();
    expect(fpItemsGet({ uuids: [U(3), U(77), U(78)] }, fakeCtx(f.mod))).toEqual(err('not_found', U(77)));
    const odd = { ...f.mod, kicadFpEditItemsGet: () => JSON.stringify({ items: [{ ...line(U(5)), style: 'wavy' }] }) };
    expect(fpItemsGet({}, fakeCtx(odd))).toEqual(err('island_error', 'the engine answered items of another shape'));
  });
});

describe('fpedit.items.set', () => {
  it('sets one key over two pads in one call and answers them read back', async () => {
    const f = fakeEngine();
    const a = await fpItemsSet({ uuids: [U(3), U(4)], set: { copper: { size: [1, 2] } } }, fakeCtx(f.mod)) as { ok: true; result: { items: Item[] } };
    expect(a.ok).toBe(true);
    expect(a.result.items.map((i) => (i.copper as { size: number[] }).size)).toEqual([[1, 2], [1, 2]]);
    expect(f.calls.filter((c) => c.name === 'set')).toEqual([{ name: 'set', arg: { uuids: [U(3), U(4)], set: { copper: { size: [1, 2] } } } }]);
    expect(f.st.depth).toBe(1);
  });
  it('answers once its undo step shows when KiCad\'s dialog rules reset a value given', async () => {
    const f = fakeEngine({ reset: (it) => { const c = it.copper as { shape: string; size: number[] }; if (c.shape === 'circle') c.size = [c.size[0], c.size[0]]; } });
    const a = await fpItemsSet({ uuids: [U(3)], set: { copper: { shape: 'circle', size: [1, 2] } } }, fakeCtx(f.mod)) as { ok: true; result: { items: Item[] } };
    expect(a.ok).toBe(true);
    expect((a.result.items[0].copper as { size: number[] }).size).toEqual([1, 1]);
  });
  it('refuses before the engine: an unknown uuid, two kinds, a key the kind lacks, a bad value, a key one item lacks', async () => {
    const f = fakeEngine();
    const ctx = fakeCtx(f.mod);
    expect(await fpItemsSet({ uuids: [U(3), U(99)], set: { x: 1 } }, ctx)).toEqual(err('not_found', U(99)));
    expect(await fpItemsSet({ uuids: [U(3), U(5)], set: { locked: true } }, ctx)).toEqual(err('bad_args', 'fpedit.items.set: the items are of more than one kind'));
    expect(await fpItemsSet({ uuids: [U(5)], set: { number: '3' } }, ctx)).toEqual(err('bad_args', 'fpedit.items.set'));
    expect(await fpItemsSet({ uuids: [U(3)], set: { type: 'round' } }, ctx)).toEqual(err('bad_args', 'fpedit.items.set'));
    expect(await fpItemsSet({ uuids: [U(5)], set: { points: [[0, 0], [1, 1], [2, 2]] } }, ctx)).toEqual(err('bad_args', 'fpedit.items.set: a segment takes another count of points'));
    expect(f.calls.filter((c) => c.name === 'set')).toEqual([]);
  });
  it('the engine\'s refusal is bad_args; a change that never shows is not_applied', async () => {
    expect(await fpItemsSet({ uuids: [U(3)], set: { x: 2 } }, fakeCtx(fakeEngine({ refuse: true }).mod))).toEqual(err('bad_args', 'fpedit.items.set'));
    expect(await fpItemsSet({ uuids: [U(3)], set: { x: 2 } }, fakeCtx(fakeEngine({ never: true }).mod))).toEqual(err('not_applied', 'fpedit.items.set'));
  });
});

describe('fpedit.items.add', () => {
  it('adds two items with page made uuids in one call and answers them read back', async () => {
    const f = fakeEngine();
    const items = [
      { kind: 'shape', uuid: U(20), layer: 'F.SilkS', shape: 'segment', points: [[0, 0], [2, 0]] },
      { kind: 'pad', uuid: U(21), number: '3' },
    ];
    const a = await fpItemsAdd({ items }, fakeCtx(f.mod)) as { ok: true; result: { items: Item[] } };
    expect(a.ok).toBe(true);
    expect(a.result.items.map((i) => [i.uuid, i.kind])).toEqual([[U(20), 'shape'], [U(21), 'pad']]);
    expect(f.calls.filter((c) => c.name === 'add')).toEqual([{ name: 'add', arg: { items } }]);
  });
  it('a uuid the footprint holds is taken; the engine\'s refusal is bad_args; nothing shown is not_applied', async () => {
    const n = { kind: 'pad', uuid: U(3) };
    expect(await fpItemsAdd({ items: [n] }, fakeCtx(fakeEngine().mod))).toEqual(err('bad_args', `fpedit.items.add: ${U(3)} is taken`));
    expect(await fpItemsAdd({ items: [{ ...n, uuid: U(30) }] }, fakeCtx(fakeEngine({ refuse: true }).mod))).toEqual(err('bad_args', 'fpedit.items.add'));
    expect(await fpItemsAdd({ items: [{ ...n, uuid: U(30) }] }, fakeCtx(fakeEngine({ never: true }).mod))).toEqual(err('not_applied', 'fpedit.items.add'));
  });
});

describe('fpedit.items.remove', () => {
  it('removes a line and answers once it no longer reads back', async () => {
    const f = fakeEngine();
    expect(await fpItemsRemove({ uuids: [U(5)] }, fakeCtx(f.mod))).toEqual({ ok: true, result: { removed: [U(5)] } });
    expect(f.items().map((i) => i.uuid)).toEqual([U(1), U(2), U(3), U(4)]);
  });
  it('never the Reference or the Value field; an unknown uuid is not_found', async () => {
    const f = fakeEngine();
    expect(await fpItemsRemove({ uuids: [U(5), U(1)] }, fakeCtx(f.mod))).toEqual(err('bad_args', 'fpedit.items.remove: Reference is a field every footprint keeps'));
    expect(await fpItemsRemove({ uuids: [U(2)] }, fakeCtx(f.mod))).toEqual(err('bad_args', 'fpedit.items.remove: Value is a field every footprint keeps'));
    expect(await fpItemsRemove({ uuids: [U(66)] }, fakeCtx(f.mod))).toEqual(err('not_found', U(66)));
    expect(f.calls.filter((c) => c.name === 'remove')).toEqual([]);
    expect(await fpItemsRemove({ uuids: [U(5)] }, fakeCtx(fakeEngine({ never: true }).mod))).toEqual(err('not_applied', 'fpedit.items.remove'));
  });
});
