// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// m4-i: board item properties against this test's own fake of engine run 15's
// exports (kicadBoardItemRecords, kicadBoardItemRecordsSet,
// kicadBoardTuningGet, kicadBoardTuningSet, kicadBoardPlaceImage and the slot
// window.kicadHostBoardItem) at the protocol boundary: every kind read, every
// key of a set refused one at a time, `full` ignored without the cap,
// ev.boardItem once per request and never before ready, and the unit as the
// registry and the responder take it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startResponder } from '../responder';
import type { Answer, ExtUnit, ResponderCtx } from './contract';
import { buildRegistry, heldActions, REGISTRY } from './registry';
import unit, {
  BOARD_IMAGE_PLACE_CAP, BOARD_ITEM_KINDS_CAP, BOARD_TUNING_CAP, IMAGE_EXPORTS, LENGTH_TUNER_SETTINGS, RECORD_EXPORTS, TUNING_EXPORTS,
  boardImagePlace, boardItemGetFull, boardItemSetRecords, boardTuningGet, boardTuningSet, installBoardItemAsk, mergeInOrder,
  parseImagePlaceArgs, parseRecordSetArgs, pictureKind, readBoardItemAsk, readItemsRecord, readLiveTuning,
} from './m4-i';
import {
  readBoardRecords, readBoardRecordSet, readGroup, readRecordSheet, readTarget, readTuningPattern, readTuningSettings, readsKind,
} from './m4-i/records';

const U = (n: number): string => `abcdef44-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FP = U(1);
const PAD = U(2);
const LINE = U(3);
const GROUP = U(4);
const TARGET = U(5);
const TUNE = U(6);
const DIM = U(7);
const TRACK = U(8);
const err = (code: string, message: string) => ({ ok: false, code, message });

const copper = { shape: 'rect', size: [1.5, 0.6], offset: [0, 0], delta: [0, 0], roundRatio: 0, chamferRatio: 0, chamferCorners: [], anchor: 'circle', primitives: [] };
const padItem = (uuid: string) => ({
  kind: 'pad', uuid, number: '1', pinName: '', pinType: '', type: 'smd', x: 100, y: 50, angle: 0, locked: false, padstack: 'normal', copper, layerShapes: [],
  drill: null, layers: ['F.Cu', 'F.Paste', 'F.Mask'], dieLength: 0, dieDelay: 0, clearance: null, maskMargin: null, pasteMargin: null, pasteRatio: null,
  zoneConnection: 'inherit', customZoneShape: 'outline', thermalSpokeWidth: null, thermalGap: null, thermalAngle: 90, property: 'none',
  unconnectedLayers: 'keep_all',
  teardrop: { enabled: false, useTwoTracks: true, preferZoneConnection: true, maxLength: 1, maxWidth: 2, lengthRatio: 0.5, widthRatio: 1, curved: false, sizeFilterRatio: 0.9 },
  backdrill: { front: null, back: null },
  postMachining: { front: { mode: 'none', size: 0, depth: 0, angle: 0 }, back: { mode: 'none', size: 0, depth: 0, angle: 0 } },
});
const lineItem = (uuid: string) => ({
  kind: 'shape', uuid, layer: 'F.SilkS', shape: 'segment', points: [[0, 0], [1, 0]], width: 0.12, style: 'solid', filled: false, fill: 'none', locked: false,
  hasSolderMask: false, solderMaskMargin: null,
});
const settings = () => ({
  mode: 'single', minAmplitude: 0.2, maxAmplitude: 1, spacing: 0.6, cornerStyle: 'chamfer', cornerRadiusPercent: 80, singleSided: false,
  timeDomain: false, overrideCustomRules: false, target: { min: null, opt: 30, max: null }, fromRules: null,
});
const groupItem = (uuid: string) => ({ kind: 'group', uuid, name: 'G1', locked: false, members: 2, designBlock: '' });
const targetItem = (uuid: string) => ({ kind: 'target', uuid, layer: 'Edge.Cuts', x: 10, y: 10, shape: 'plus', size: 5, width: 0.15 });
const tuneItem = (uuid: string) => ({ ...settings(), kind: 'tuning', uuid, layer: 'F.Cu' });
/** A dimension record of a shape no reader takes (no dimType): a record this island cannot read. */
const dimItem = (uuid: string) => ({ kind: 'dimension', uuid, layer: 'Dwgs.User', start: [0, 0], end: [10, 0] });

type Sheet = Record<string, unknown> & { uuid: string; item: Record<string, unknown> };
const sheet = (item: Record<string, unknown>, o: { parent?: string; parentRef?: string } = {}): Sheet => ({
  kind: 'record', uuid: item.uuid as string, parent: o.parent ?? '', parentRef: o.parentRef ?? '',
  net: item.kind === 'pad' ? 'GND' : null, netChoices: item.kind === 'pad' ? ['/SIG', 'GND'] : [], item,
});

const merge = (into: Record<string, unknown>, patch: Record<string, unknown>): void => {
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v === 'object' && v !== null && !Array.isArray(v) && typeof into[k] === 'object' && into[k] !== null) merge(into[k] as Record<string, unknown>, v as Record<string, unknown>);
    else into[k] = structuredClone(v);
  }
};

/** The fake engine: a board holding a pad of footprint U1, a silk line, a group, a target, a tuning pattern and a dimension. */
function fakeEngine(o: { refuse?: boolean; revert?: boolean; never?: boolean; tuning?: boolean; image?: boolean } = {}) {
  const files = new Map<string, Uint8Array>();
  const sheets: Sheet[] = [
    sheet(padItem(PAD), { parent: FP, parentRef: 'U1' }), sheet(lineItem(LINE)), sheet(groupItem(GROUP)), sheet(targetItem(TARGET)), sheet(tuneItem(TUNE)), sheet(dimItem(DIM)),
  ];
  const st = { depth: 0, tuning: o.tuning ?? false, live: settings() as Record<string, unknown>, placed: 0 };
  const calls: Array<{ name: string; arg: unknown }> = [];
  const write = (path: string, v: unknown) => files.set(path, new TextEncoder().encode(JSON.stringify(v)));
  const mod: Record<string, unknown> = {
    kicadHostBoardItems: () => true,
    kicadBoardItemGet: () => '{"items":[]}',
    kicadCollabBusy: () => false,
    kicadBoardItemRecords: (j: string) => {
      const a = JSON.parse(j) as { uuids: string[] };
      calls.push({ name: 'records', arg: a });
      if (a.uuids.length === 0) return '';
      return JSON.stringify({ items: a.uuids.map((u) => sheets.find((s) => s.uuid === u)).filter((s) => s != null) });
    },
    kicadBoardItemRecordsSet: (j: string) => {
      const a = JSON.parse(j) as { run: number; dir: string; uuids: string[]; kind: string; set: Record<string, unknown> };
      calls.push({ name: 'set', arg: a });
      if (o.refuse) return false;
      if (!o.never) {
        setTimeout(() => {
          if (!o.revert) {
            for (const s of sheets) {
              if (!a.uuids.includes(s.uuid)) continue;
              const { net, ...rest } = a.set;
              if (net !== undefined) s.net = net;
              merge(s.item, rest);
            }
            st.depth++;
          }
          write(`${a.dir}/items.json`, { run: a.run, applied: !o.revert, depth: st.depth });
        }, 1);
      }
      return true;
    },
    kicadBoardTuningGet: () => (st.tuning ? JSON.stringify(st.live) : ''),
    kicadBoardTuningSet: (j: string) => {
      const a = JSON.parse(j) as { run: number; dir: string; set: Record<string, unknown> };
      calls.push({ name: 'tuningSet', arg: a });
      if (!st.tuning || o.refuse) return false;
      if (!o.never) setTimeout(() => { merge(st.live, a.set); write(`${a.dir}/tuning.json`, { run: a.run, settings: st.live }); }, 1);
      return true;
    },
    kicadBoardPlaceImage: (j: string) => {
      const a = JSON.parse(j) as { path: string };
      calls.push({ name: 'image', arg: a });
      if (o.image === false || !files.has(a.path)) return false;
      st.placed++;
      return true;
    },
  };
  return { mod, st, calls, files, sheets };
}

/** The responder's ctx in a pcb frame as these ops read it, over the fake engine. */
function fakeCtx(f: ReturnType<typeof fakeEngine> | null, o: { frame?: string; busy?: boolean; caps?: string[]; admit?: boolean } = {}) {
  const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
  let runs = 0;
  const removed: string[] = [];
  const win: Record<string, unknown> = {};
  const ctx = {
    frame: o.frame ?? 'pcb',
    root: '/project',
    timing: { boardItemMs: 150, applyPollMs: 2 },
    win: () => (f == null ? null : win),
    mod: () => (f == null ? null : f.mod),
    fs: () => (f == null ? null : { writeFile: (p: string, b: Uint8Array) => f.files.set(p, b) }),
    closed: () => false,
    admit: () => o.admit ?? true,
    caps: () => o.caps ?? [BOARD_ITEM_KINDS_CAP],
    boardGate: (op: string, exports: readonly string[]) => {
      if ((o.frame ?? 'pcb') !== 'pcb') return err('unsupported', 'board ops run in a pcb frame');
      if (f == null) return err('not_ready', op);
      for (const n of exports) if (typeof f.mod[n] !== 'function') return err('unsupported', n);
      if (o.busy) return err('busy', op);
      return { w: win, mod: f.mod };
    },
    freshRunFolder: (root: string) => `${root}/${++runs}`,
    dropRunFolder: (dir: string) => { removed.push(dir); },
    readBytes: (p: string) => f?.files.get(p) ?? null,
    applyIdle: async () => true,
    queuedRun: async <T>(_op: string, dir: string, ms: number, call: () => unknown, record: () => T | null) => {
      if ((await call()) !== true) return err('not_applied', _op);
      const deadline = Date.now() + ms;
      for (;;) {
        const done = record();
        if (done != null) return { done };
        if (Date.now() >= deadline) return err('not_applied', _op);
        await new Promise((r) => setTimeout(r, 2));
      }
    },
    emitExt: (type: string, payload: Record<string, unknown>) => { emitted.push({ type, payload }); },
    log: () => {},
  } as unknown as ResponderCtx;
  return { ctx, emitted, removed, win };
}

/** today's board.item.get, as the op ships, for the widening's `next`. */
const todayNext = (items: Array<Record<string, unknown>>) => vi.fn(async (args: unknown): Promise<Answer> => {
  const asked = (args as { uuids: string[] }).uuids;
  return { ok: true, result: { items: items.filter((i) => asked.includes(i.uuid as string) || i.kind === 'footprint') } };
});

describe('the unit in the registry', () => {
  it('loads with nothing broken: its three ops, two widenings, three caps, one event and one held row', () => {
    expect(REGISTRY.problems).toEqual([]);
    const reg = buildRegistry({ './m4-i.ts': { default: unit as ExtUnit } });
    expect(reg.problems).toEqual([]);
    expect([...reg.ops.entries()].filter(([, op]) => op.unit === 'm4-i').map(([op]) => op).sort()).toEqual(['board.image.place', 'board.tuning.get', 'board.tuning.set']);
    expect(Object.keys(unit.opsWidened).sort()).toEqual(['board.item.get', 'board.item.set']);
    expect(unit.capNames).toEqual([BOARD_ITEM_KINDS_CAP, BOARD_TUNING_CAP, BOARD_IMAGE_PLACE_CAP]);
    expect(unit.events).toEqual({ 'ev.boardItem': ['uuid', 'kind', 'isNew'] });
    expect(heldActions().some((r) => r.action === LENGTH_TUNER_SETTINGS && r.cap === BOARD_ITEM_KINDS_CAP && r.frames.includes('pcb'))).toBe(true);
  });

  it('lists each cap in a pcb frame only on an engine with its exports, never in a sch frame', () => {
    const all = Object.fromEntries([...RECORD_EXPORTS, ...TUNING_EXPORTS, ...IMAGE_EXPORTS].map((n) => [n, () => true]));
    expect(unit.caps(all, 'pcb')).toEqual([BOARD_ITEM_KINDS_CAP, BOARD_TUNING_CAP, BOARD_IMAGE_PLACE_CAP]);
    expect(unit.caps(all, 'sch')).toEqual([]);
    expect(unit.caps({ kicadBoardItemGet: () => '', kicadCollabBusy: () => false }, 'pcb')).toEqual([]);
    for (const name of RECORD_EXPORTS) {
      const less = { ...all };
      delete less[name];
      expect(unit.caps(less, 'pcb')).not.toContain(BOARD_ITEM_KINDS_CAP);
    }
    const noTune = { ...all };
    delete noTune.kicadBoardTuningSet;
    expect(unit.caps(noTune, 'pcb')).toEqual([BOARD_ITEM_KINDS_CAP, BOARD_IMAGE_PLACE_CAP]);
  });
});

describe('the records', () => {
  it('reads every kind: pad (with its net), shape, group, target, tuning pattern; a record no reader takes is unread', () => {
    const f = fakeEngine();
    const read = readBoardRecords(f.mod.kicadBoardItemRecords && (f.mod.kicadBoardItemRecords as (j: string) => string)(JSON.stringify({ uuids: [PAD, LINE, GROUP, TARGET, TUNE, DIM] })), [PAD, LINE, GROUP, TARGET, TUNE, DIM]);
    expect(read?.unread).toEqual([DIM]);
    expect(read?.sheets.map((s) => s.item.kind)).toEqual(['pad', 'shape', 'group', 'target', 'tuning']);
    const pad = read?.sheets[0];
    expect(pad).toMatchObject({ kind: 'record', uuid: PAD, parent: FP, parentRef: 'U1', net: 'GND', netChoices: ['/SIG', 'GND'] });
    expect(read?.sheets[1]).toMatchObject({ net: null, netChoices: [], parent: '' });
  });

  it('refuses a sheet of another shape, each key in turn', () => {
    const good = sheet(groupItem(GROUP));
    expect('sheet' in readRecordSheet(good)).toBe(true);
    const bad: Array<Record<string, unknown>> = [
      { ...good, kind: 'other' }, { ...good, extra: 1 }, { ...good, parent: 'U1' }, { ...good, net: 'GND' }, { ...good, netChoices: ['GND'] },
      { ...good, uuid: U(99) }, { ...good, item: { ...groupItem(GROUP), kind: 'footprint' } },
      { ...sheet(padItem(PAD)), net: null }, { ...good, parentRef: 'x'.repeat(1025) },
    ];
    for (const b of bad) expect(readRecordSheet(b)).toEqual({ shape: true });
    // A record kind this island reads nothing of (a table cell is M12's) is unread, never passed on.
    expect(readRecordSheet({ ...good, item: { ...groupItem(GROUP), kind: 'tablecell' } })).toEqual({ unread: GROUP });
    expect(readRecordSheet({ ...good, item: { ...groupItem(GROUP), extra: 1 } })).toEqual({ unread: GROUP });
    const { parent: _p, ...noParent } = good;
    void _p;
    expect(readRecordSheet(noParent)).toEqual({ shape: true });
  });

  it('refuses the whole answer for a uuid not asked, one twice, or "" (the engine refused the args)', () => {
    const s = sheet(groupItem(GROUP));
    expect(readBoardRecords(JSON.stringify({ items: [s] }), [TARGET])).toBeNull();
    expect(readBoardRecords(JSON.stringify({ items: [s, s] }), [GROUP, TARGET])).toBeNull();
    expect(readBoardRecords('', [GROUP])).toBeNull();
    expect(readBoardRecords('{"items":[],"x":1}', [GROUP])).toBeNull();
    expect(readBoardRecords('{"items":[]}', [GROUP])).toEqual({ sheets: [], unread: [] });
  });

  it('reads the board only records closed', () => {
    expect(readGroup(groupItem(GROUP))).toEqual(groupItem(GROUP));
    expect(readGroup({ ...groupItem(GROUP), members: -1 })).toBeNull();
    expect(readGroup({ ...groupItem(GROUP), end: 'none' })).toBeNull();
    expect(readTarget(targetItem(TARGET))).toEqual(targetItem(TARGET));
    expect(readTarget({ ...targetItem(TARGET), shape: 'circle' })).toBeNull();
    expect(readTuningPattern(tuneItem(TUNE))).toEqual(tuneItem(TUNE));
    expect(readTuningPattern({ ...tuneItem(TUNE), end: 'none' })).toBeNull();   // the pattern has no end key
    expect(readTuningSettings(settings())).toEqual(settings());
    expect(readTuningSettings({ ...settings(), fromRules: { min: 1, opt: 2, max: 3 } })).not.toBeNull();
    for (const [k, v] of Object.entries({ mode: 'meander', cornerStyle: 'square', cornerRadiusPercent: 101, spacing: -1, timeDomain: 1, target: { opt: 1 }, fromRules: 0 })) {
      expect(readTuningSettings({ ...settings(), [k]: v }), k).toBeNull();
    }
    for (const k of ['pad', 'shape', 'dimension', 'textbox', 'table', 'barcode', 'image', 'zone', 'point', 'group', 'target', 'tuning'] as const) expect(readsKind(k), k).toBe(true);
    expect(readsKind('tablecell')).toBe(false);
  });
});

describe('board.item.get with full', () => {
  afterEach(() => vi.restoreAllMocks());

  it('without full is the op as it ships', async () => {
    const f = fakeEngine();
    const { ctx } = fakeCtx(f);
    const next = todayNext([]);
    await boardItemGetFull({ uuids: [PAD] }, ctx, next);
    expect(next).toHaveBeenCalledWith({ uuids: [PAD] });
    expect(f.calls).toEqual([]);
  });

  it('is ignored without the cap (an engine without the records, a sch frame): the op answers as it ships', async () => {
    const f = fakeEngine();
    delete f.mod.kicadBoardItemRecords;
    const next = todayNext([]);
    await boardItemGetFull({ uuids: [PAD, PAD], full: true }, fakeCtx(f).ctx, next);
    expect(next).toHaveBeenLastCalledWith({ uuids: [PAD] });
    const g = fakeEngine();
    await boardItemGetFull({ uuids: [PAD], full: true }, fakeCtx(g, { frame: 'sch' }).ctx, next);
    expect(next).toHaveBeenLastCalledWith({ uuids: [PAD] });
    expect(g.calls).toEqual([]);
  });

  it('answers a record kind as its record, the others as today\'s read gives them, in the order asked', async () => {
    const f = fakeEngine();
    const footprint = { kind: 'footprint', uuid: FP };
    const track = { kind: 'track', uuid: TRACK };
    const dimOther = { kind: 'other', uuid: DIM, type: 'dimension' };
    const next = todayNext([track, dimOther]);
    const got = await boardItemGetFull({ uuids: [TRACK, PAD, DIM, GROUP], full: true }, fakeCtx(f).ctx, next);
    expect(next).toHaveBeenCalledWith({ uuids: [TRACK, DIM] });
    expect(got.ok).toBe(true);
    const items = (got as unknown as { result: { items: Array<Record<string, unknown>> } }).result.items;
    expect(items.map((i) => [i.kind, i.uuid])).toEqual([['track', TRACK], ['record', PAD], ['other', DIM], ['record', GROUP]]);
    expect(mergeInOrder([PAD, LINE], [], [footprint, { kind: 'other', uuid: LINE }]).map((i) => i.uuid)).toEqual([FP, LINE]);
  });

  it('asks today\'s read nothing when every uuid has a record; checks its args and the gate first', async () => {
    const f = fakeEngine();
    const next = todayNext([]);
    const got = await boardItemGetFull({ uuids: [GROUP, TARGET, TUNE], full: true }, fakeCtx(f).ctx, next);
    expect(next).not.toHaveBeenCalled();
    expect((got as unknown as { result: { items: unknown[] } }).result.items).toHaveLength(3);
    for (const bad of [{ uuids: [PAD], full: false }, { uuids: [], full: true }, { uuids: ['ABC'], full: true }, { uuids: [PAD], full: true, x: 1 }]) {
      expect(await boardItemGetFull(bad, fakeCtx(f).ctx, next)).toEqual(err('bad_args', 'board.item.get'));
    }
    expect(await boardItemGetFull({ uuids: [PAD], full: true }, fakeCtx(f, { busy: true }).ctx, next)).toEqual(err('busy', 'board.item.get'));
    f.mod.kicadBoardItemRecords = () => '{"items":[{"kind":"record"}]}';
    expect(await boardItemGetFull({ uuids: [PAD], full: true }, fakeCtx(f).ctx, next)).toMatchObject({ ok: false, code: 'island_error' });
  });
});

describe('board.item.set, the record form', () => {
  it('leaves today\'s form to the op as it ships', async () => {
    const next = vi.fn(async (): Promise<Answer> => ({ ok: true, result: {} }));
    await boardItemSetRecords({ uuid: PAD, set: { x: 1 } }, fakeCtx(fakeEngine()).ctx, next);
    expect(next).toHaveBeenCalledWith({ uuid: PAD, set: { x: 1 } });
  });

  it('sets one key per kind as ONE run, the items read back, the run folder removed', async () => {
    const cases: Array<[string, string, Record<string, unknown>]> = [
      [PAD, 'pad', { net: '/SIG' }], [PAD, 'pad', { x: 101 }], [PAD, 'pad', { net: '', locked: true }], [LINE, 'shape', { width: 0.2 }],
      [GROUP, 'group', { name: 'G2' }], [GROUP, 'group', { locked: true }], [GROUP, 'group', { designBlock: 'blocks:LDO' }],
      [TARGET, 'target', { shape: 'x' }], [TARGET, 'target', { size: 2 }], [TARGET, 'target', { x: 12, layer: 'F.SilkS' }],
      [TUNE, 'tuning', { spacing: 1 }], [TUNE, 'tuning', { target: { opt: 40, min: 39 } }], [TUNE, 'tuning', { cornerStyle: 'round' }],
    ];
    for (const [uuid, kind, set] of cases) {
      const f = fakeEngine();
      const { ctx, removed } = fakeCtx(f);
      const got = await boardItemSetRecords({ uuids: [uuid], kind, set }, ctx, vi.fn());
      expect(got.ok, `${kind} ${JSON.stringify(set)}`).toBe(true);
      const sets = f.calls.filter((c) => c.name === 'set');
      expect(sets).toHaveLength(1);
      expect(sets[0].arg).toEqual({ run: 1, dir: '/tmp/cc-boarditems/1', uuids: [uuid], kind, set });
      expect(f.st.depth).toBe(1);
      const item = (got as unknown as { result: { items: Array<{ uuid: string; net: string | null; item: Record<string, unknown> }> } }).result.items[0];
      expect(item.uuid).toBe(uuid);
      if ('net' in set) expect(item.net).toBe(set.net);
      expect(removed).toEqual(['/tmp/cc-boarditems/1']);
    }
  });

  it('sets several items of one kind in one run', async () => {
    const f = fakeEngine();
    f.sheets.push(sheet(groupItem(U(20))));
    const got = await boardItemSetRecords({ uuids: [GROUP, U(20)], kind: 'group', set: { locked: true } }, fakeCtx(f).ctx, vi.fn());
    expect((got as unknown as { result: { items: Array<{ item: { locked: boolean } }> } }).result.items.map((i) => i.item.locked)).toEqual([true, true]);
    expect(f.st.depth).toBe(1);
  });

  it('refuses every bad key one at a time before the engine is asked', async () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ['pad', { net: 7 }], ['pad', { x: 'a' }], ['pad', { kind: 'pad' }], ['pad', {}], ['shape', { net: 'GND' }], ['shape', { width: -1 }],
      ['group', { name: 'a\nb' }], ['group', { members: 3 }], ['group', { locked: 'yes' }],
      ['target', { shape: 'o' }], ['target', { size: 0 }], ['target', { width: 1001 }], ['target', { x: 2001 }], ['target', { layer: 'no such' }],
      ['tuning', { mode: 'skew' }], ['tuning', { fromRules: null }], ['tuning', { cornerRadiusPercent: 1.5 }], ['tuning', { spacing: 1001 }],
      ['tuning', { target: { min: 1 } }], ['tuning', { target: { opt: 2001 } }], ['tuning', { target: { opt: 1, typ: 2 } }],
    ];
    for (const [kind, set] of bad) {
      const f = fakeEngine();
      expect(await boardItemSetRecords({ uuids: [PAD], kind, set }, fakeCtx(f).ctx, vi.fn()), `${kind} ${JSON.stringify(set)}`).toEqual(err('bad_args', 'board.item.set'));
      expect(f.calls).toEqual([]);
    }
    const f = fakeEngine();
    for (const args of [
      { uuids: [], kind: 'pad', set: { x: 1 } }, { uuids: [PAD, PAD], kind: 'pad', set: { x: 1 } }, { uuids: [PAD], kind: 'tablecell', set: { text: 'a' } },
      { uuids: [PAD], kind: 'other', set: { x: 1 } }, { uuids: [PAD], kind: 'pad' }, { uuids: [PAD], kind: 'pad', set: { x: 1 }, more: 1 },
    ]) {
      expect(await boardItemSetRecords(args, fakeCtx(f).ctx, vi.fn()), JSON.stringify(args)).toEqual(err('bad_args', 'board.item.set'));
    }
    expect(f.calls).toEqual([]);
  });

  it('answers island_error for a record this island cannot read, and unsupported on an engine without the exports', async () => {
    const f = fakeEngine();
    expect(await boardItemSetRecords({ uuids: [DIM], kind: 'dimension', set: { height: 1 } }, fakeCtx(f).ctx, vi.fn())).toEqual(err('island_error', `the engine answered a record this island cannot read: ${DIM}`));
    delete f.mod.kicadBoardItemRecordsSet;
    expect(await boardItemSetRecords({ uuids: [PAD], kind: 'pad', set: { x: 1 } }, fakeCtx(f).ctx, vi.fn())).toEqual(err('unsupported', 'kicadBoardItemRecordsSet'));
  });

  it('not_found names the first item the board lacks; bad_args for an item of another kind, a key one lacks, a net the board does not hold', async () => {
    const f = fakeEngine();
    const { ctx } = fakeCtx(f);
    expect(await boardItemSetRecords({ uuids: [GROUP, U(77)], kind: 'group', set: { locked: true } }, ctx, vi.fn())).toEqual(err('not_found', U(77)));
    expect(await boardItemSetRecords({ uuids: [GROUP, TARGET], kind: 'group', set: { locked: true } }, ctx, vi.fn())).toEqual(err('bad_args', `board.item.set: ${TARGET} is not a group`));
    expect(await boardItemSetRecords({ uuids: [PAD], kind: 'pad', set: { net: 'VCC' } }, ctx, vi.fn())).toEqual(err('bad_args', 'board.item.set: the board has no net VCC'));
    expect(await boardItemSetRecords({ uuids: [LINE], kind: 'shape', set: { number: '2' } }, ctx, vi.fn())).toMatchObject({ ok: false, code: 'bad_args' });
    expect(f.calls.filter((c) => c.name === 'set')).toEqual([]);
  });

  it('bad_args when the engine refuses or reverts the set, not_applied when it never records', async () => {
    expect(await boardItemSetRecords({ uuids: [GROUP], kind: 'group', set: { name: 'x' } }, fakeCtx(fakeEngine({ refuse: true })).ctx, vi.fn())).toEqual(err('bad_args', 'board.item.set'));
    const reverted = fakeEngine({ revert: true });
    expect(await boardItemSetRecords({ uuids: [GROUP], kind: 'group', set: { name: 'x' } }, fakeCtx(reverted).ctx, vi.fn())).toEqual(err('bad_args', 'board.item.set'));
    expect(reverted.st.depth).toBe(0);
    const never = fakeEngine({ never: true });
    const { ctx, removed } = fakeCtx(never);
    expect(await boardItemSetRecords({ uuids: [GROUP], kind: 'group', set: { name: 'x' } }, ctx, vi.fn())).toEqual(err('not_applied', 'board.item.set'));
    expect(removed).toEqual(['/tmp/cc-boarditems/1']);
  });

  it('reads items.json closed for its own run', () => {
    const b = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
    expect(readItemsRecord(b({ run: 3, applied: true, depth: 2 }), 3)).toEqual({ applied: true, depth: 2 });
    expect(readItemsRecord(b({ run: 2, applied: true, depth: 2 }), 3)).toBeNull();
    expect(readItemsRecord(b({ run: 3, applied: true }), 3)).toBeNull();
    expect(readItemsRecord(null, 3)).toBeNull();
  });

  it('parses the record form closed', () => {
    expect(parseRecordSetArgs({ uuids: [PAD], kind: 'pad', set: { net: 'GND' } })).toEqual({ uuids: [PAD], kind: 'pad', set: { net: 'GND' } });
    expect(readBoardRecordSet('pad', { net: 'GND', locked: true })).toEqual({ locked: true, net: 'GND' });
    expect(parseRecordSetArgs({ uuids: Array.from({ length: 4097 }, (_, i) => U(i + 100)), kind: 'pad', set: { x: 1 } })).toBeNull();
  });
});

describe('board.tuning.get and board.tuning.set', () => {
  it('no_tuning while no tuning tool runs; the live settings while one does', () => {
    expect(boardTuningGet({}, fakeCtx(fakeEngine()).ctx)).toEqual(err('no_tuning', 'board.tuning.get'));
    expect(boardTuningGet(undefined, fakeCtx(fakeEngine({ tuning: true })).ctx)).toEqual({ ok: true, result: { settings: settings() } });
    expect(boardTuningGet({ x: 1 }, fakeCtx(fakeEngine({ tuning: true })).ctx)).toEqual(err('bad_args', 'board.tuning.get'));
    const f = fakeEngine({ tuning: true });
    delete f.mod.kicadBoardTuningGet;
    expect(boardTuningGet({}, fakeCtx(f).ctx)).toEqual(err('unsupported', 'kicadBoardTuningGet'));
    expect(readLiveTuning('{"mode":"single"}')).toBeNull();
    expect(readLiveTuning('')).toBe('none');
  });

  it('hands a set to the tool and answers the settings it then holds, no undo step', async () => {
    const f = fakeEngine({ tuning: true });
    const { ctx, removed } = fakeCtx(f);
    const got = await boardTuningSet({ set: { maxAmplitude: 2, cornerStyle: 'round' } }, ctx);
    expect(got).toEqual({ ok: true, result: { settings: { ...settings(), maxAmplitude: 2, cornerStyle: 'round' } } });
    expect(f.calls.find((c) => c.name === 'tuningSet')?.arg).toEqual({ run: 1, dir: '/tmp/cc-boarditems/1', set: { maxAmplitude: 2, cornerStyle: 'round' } });
    expect(f.st.depth).toBe(0);
    expect(removed).toEqual(['/tmp/cc-boarditems/1']);
  });

  it('refuses bad sets before the engine; no_tuning with no tool; bad_args when the engine refuses; no_tuning when the tool ended first', async () => {
    for (const args of [{}, { set: {} }, { set: { mode: 'skew' } }, { set: { maxAmplitude: 2 }, x: 1 }, { set: { target: { max: 3 } } }]) {
      const f = fakeEngine({ tuning: true });
      expect(await boardTuningSet(args, fakeCtx(f).ctx), JSON.stringify(args)).toEqual(err('bad_args', 'board.tuning.set'));
      expect(f.calls).toEqual([]);
    }
    expect(await boardTuningSet({ set: { spacing: 1 } }, fakeCtx(fakeEngine()).ctx)).toEqual(err('no_tuning', 'board.tuning.set'));
    expect(await boardTuningSet({ set: { spacing: 1 } }, fakeCtx(fakeEngine({ tuning: true, refuse: true })).ctx)).toEqual(err('bad_args', 'board.tuning.set'));
    const ended = fakeEngine({ tuning: true, never: true });
    setTimeout(() => { ended.st.tuning = false; }, 20);
    expect(await boardTuningSet({ set: { spacing: 1 } }, fakeCtx(ended).ctx)).toEqual(err('no_tuning', 'board.tuning.set'));
    expect(await boardTuningSet({ set: { spacing: 1 } }, fakeCtx(fakeEngine({ tuning: true, never: true })).ctx)).toEqual(err('not_applied', 'board.tuning.set'));
  });
});

describe('board.image.place', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16]);

  it('stages the picture by its content, places it and removes the folder', async () => {
    const f = fakeEngine();
    const { ctx, removed } = fakeCtx(f);
    expect(await boardImagePlace({ name: 'logo.bin', bytes: png }, ctx)).toEqual({ ok: true, result: {} });
    expect(f.calls).toEqual([{ name: 'image', arg: { path: '/tmp/cc-stage/1/picture.png' } }]);
    expect(f.st.placed).toBe(1);
    expect(removed).toEqual(['/tmp/cc-stage/1']);
    expect(await boardImagePlace({ name: 'photo.jpg', bytes: jpg }, ctx)).toEqual({ ok: true, result: {} });
    expect(f.calls[1].arg).toEqual({ path: '/tmp/cc-stage/2/picture.jpg' });
  });

  it('refuses a file that is no PNG or JPEG, past 4 MiB, a name with a folder, before the engine', async () => {
    const f = fakeEngine();
    for (const args of [
      { name: 'a.png', bytes: new Uint8Array([1, 2, 3]) }, { name: 'a.png', bytes: new Uint8Array(4 * 1024 * 1024 + 1).fill(0x89) },
      { name: 'x/a.png', bytes: png }, { name: '', bytes: png }, { name: 'a.png', bytes: [1, 2] }, { name: 'a.png' },
    ]) {
      expect(await boardImagePlace(args, fakeCtx(f).ctx)).toEqual(err('bad_args', 'board.image.place'));
    }
    expect(f.calls).toEqual([]);
    expect(pictureKind(png)).toBe('png');
    expect(parseImagePlaceArgs({ name: 'a', bytes: jpg })?.ext).toBe('jpg');
  });

  it('bad_args when KiCad places nothing; unsupported without the export', async () => {
    const f = fakeEngine({ image: false });
    expect(await boardImagePlace({ name: 'a.png', bytes: png }, fakeCtx(f).ctx)).toMatchObject({ ok: false, code: 'bad_args' });
    delete f.mod.kicadBoardPlaceImage;
    expect(await boardImagePlace({ name: 'a.png', bytes: png }, fakeCtx(f).ctx)).toEqual(err('unsupported', 'kicadBoardPlaceImage'));
  });
});

describe('ev.boardItem', () => {
  const ask = (v: unknown) => JSON.stringify(v);

  it('reads the engine\'s request closed', () => {
    expect(readBoardItemAsk(ask({ kind: 'pad', uuid: PAD, isNew: false }))).toEqual({ kind: 'pad', uuid: PAD, isNew: false });
    expect(readBoardItemAsk(ask({ kind: 'tuning', uuid: '', isNew: false }))).toEqual({ kind: 'tuning', uuid: '', isNew: false });
    expect(readBoardItemAsk(ask({ kind: 'image', uuid: '', isNew: true }))).toEqual({ kind: 'image', uuid: '', isNew: true });
    expect(readBoardItemAsk(ask({ kind: 'text', uuid: LINE, isNew: true }))).toEqual({ kind: 'text', uuid: LINE, isNew: true });
    for (const bad of [
      { kind: 'pad', uuid: '', isNew: false }, { kind: 'pad', uuid: PAD, isNew: true }, { kind: 'image', uuid: PAD, isNew: true },
      { kind: 'footprint', uuid: PAD, isNew: false }, { kind: 'pad', uuid: PAD }, { kind: 'pad', uuid: PAD, isNew: false, field: 'x' },
      { kind: 'pad', uuid: PAD.toUpperCase(), isNew: false },
    ]) expect(readBoardItemAsk(ask(bad)), JSON.stringify(bad)).toBeNull();
    expect(readBoardItemAsk({ kind: 'pad', uuid: PAD, isNew: false })).toBeNull();
    expect(readBoardItemAsk('not json')).toBeNull();
  });

  it('sends one ev.boardItem per request and holds KiCad\'s dialog; never before ready, without the cap, or in a sch frame', () => {
    const f = fakeEngine();
    const on = fakeCtx(f);
    const stop = installBoardItemAsk(on.ctx);
    const slot = (on.win as { kicadHostBoardItem?: { onRequest: (j: unknown) => boolean } }).kicadHostBoardItem;
    expect(slot?.onRequest(ask({ kind: 'group', uuid: GROUP, isNew: false }))).toBe(true);
    expect(slot?.onRequest(ask({ kind: 'tuning', uuid: '', isNew: false }))).toBe(true);
    expect(slot?.onRequest(ask({ kind: 'nothing', uuid: GROUP, isNew: false }))).toBe(false);
    expect(on.emitted).toEqual([
      { type: 'ev.boardItem', payload: { uuid: GROUP, kind: 'group', isNew: false } },
      { type: 'ev.boardItem', payload: { uuid: '', kind: 'tuning', isNew: false } },
    ]);
    if (typeof stop === 'function') stop();
    expect((on.win as Record<string, unknown>).kicadHostBoardItem).toBeUndefined();

    for (const o of [{ admit: false }, { caps: [] as string[] }]) {
      const c = fakeCtx(f, o);
      installBoardItemAsk(c.ctx);
      expect((c.win as { kicadHostBoardItem: { onRequest: (j: unknown) => boolean } }).kicadHostBoardItem.onRequest(ask({ kind: 'pad', uuid: PAD, isNew: false }))).toBe(false);
      expect(c.emitted).toEqual([]);
    }
    const sch = fakeCtx(f, { frame: 'sch' });
    installBoardItemAsk(sch.ctx);
    expect((sch.win as Record<string, unknown>).kicadHostBoardItem).toBeUndefined();
  });
});

describe('as the responder runs it', () => {
  it('a pcb frame on an engine with every export lists the three caps at ev.ready; on run 14 none, and the new ops answer unsupported', async () => {
    const run = async (exports: Record<string, unknown>) => {
      const reg = buildRegistry({ './m4-i.ts': { default: unit as ExtUnit } });
      const listeners = new Map<string, Set<(e: unknown) => void>>();
      const parent = { postMessage: vi.fn() };
      const page = {
        parent, top: {}, location: { search: '?frame=pcb&theme=day' },
        addEventListener: (t: string, h: (e: unknown) => void) => { const s = listeners.get(t) ?? new Set(); s.add(h); listeners.set(t, s); },
        removeEventListener: (t: string, h: (e: unknown) => void) => listeners.get(t)?.delete(h),
      };
      const r = startResponder({ parentOrigin: 'http://localhost', page: page as unknown as Window, ext: reg });
      const ch = new MessageChannel();
      const got: Array<Record<string, unknown>> = [];
      ch.port1.onmessage = (m) => got.push(m.data);
      for (const h of listeners.get('message') ?? []) h({ origin: 'http://localhost', source: parent, data: { type: 'cc.connect', nonce: parent.postMessage.mock.calls[0][0].nonce }, ports: [ch.port2] });
      const win = {
        FS: { analyzePath: () => ({ exists: false }), mkdirTree: () => {}, readdir: () => [], readFile: () => { throw new Error('ENOENT'); } },
        Module: { kicadOpenFileBusy: () => false, ...exports },
        wxElementRegistry: { findAll: () => [], findByLabel: () => [] },
        document: { querySelector: () => null, querySelectorAll: () => [] },
        dispatchEvent: () => true,
      };
      r.engineReady(win as unknown as ToolWindow, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
      await new Promise((res) => setTimeout(res, 20));
      const ready = got.find((m) => m.type === 'ev.ready') as { caps: string[] };
      ch.port1.postMessage({ id: 1, op: 'board.tuning.get' });
      ch.port1.postMessage({ id: 2, op: 'board.image.place', args: { name: 'a.png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) } });
      await new Promise((res) => setTimeout(res, 30));
      const slot = typeof (win as Record<string, unknown>).kicadHostBoardItem;
      r.close();
      return { caps: ready.caps, answers: [got.find((m) => m.id === 1), got.find((m) => m.id === 2)], slot, after: typeof (win as Record<string, unknown>).kicadHostBoardItem };
    };
    const f = fakeEngine();
    const full = await run(f.mod);
    expect(full.caps).toEqual(expect.arrayContaining([BOARD_ITEM_KINDS_CAP, BOARD_TUNING_CAP, BOARD_IMAGE_PLACE_CAP]));
    expect(full.slot).toBe('object');
    expect(full.after).toBe('undefined');   // the stop runs at close
    const old = await run({ kicadBoardItemGet: () => '', kicadCollabBusy: () => false });
    expect(old.caps.filter((c) => [BOARD_ITEM_KINDS_CAP, BOARD_TUNING_CAP, BOARD_IMAGE_PLACE_CAP].includes(c))).toEqual([]);
    expect(old.answers[0]).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'kicadBoardTuningGet' } });
    expect(old.answers[1]).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'kicadBoardPlaceImage' } });
  });
});
