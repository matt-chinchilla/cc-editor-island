// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// m3-i: the board asks (convert, outset, zoneSettings), board.vertices.get and
// board.vertices.set, and Edit Corners held. The engine here is this test's
// own module of exports; the real engine is the e2e's
// (tests/e2e/m/m3-board-commands.spec.ts).
import { describe, expect, it, vi } from 'vitest';
import { heldTaken } from '../held';
import { fail, type Answer, type ExtUnit, type ResponderCtx } from './contract';
import { heldActions, REGISTRY } from './registry';
import unit, { EDIT_VERTICES, M3_HELD_ROWS, VERTICES_CAP, VERTICES_EXPORTS } from './m3-i';
import { BOARD_ASK_READERS, readConvert, readOutset, readZoneSettings } from './m3-i/asks';
import { parseVerticesGet, parseVerticesSet, readVertices } from './m3-i/vertices';
import { doorOf, doorRow } from './m1-i/doors';

const ZONE = 'cc0ca4d5-0000-4000-8000-000000000321';
const SQUARE = [{ x: 100, y: 100 }, { x: 110, y: 100 }, { x: 110, y: 110 }, { x: 100, y: 110 }];
const HOLE = [{ x: 102, y: 102 }, { x: 104, y: 102 }, { x: 104, y: 104 }];
const RECORD = { uuid: ZONE, kind: 'nonCopper', outlines: [{ outline: 0, hole: -1, points: SQUARE }, { outline: 0, hole: 0, points: HOLE }] };

/** The engine's two exports over one item it holds, moving a corner as KiCad's pane does. */
function engine(over: Record<string, unknown> = {}) {
  const rec = structuredClone(RECORD);
  return {
    kicadBoardVerticesGet: vi.fn((json: string): unknown => (JSON.parse(json).uuid === ZONE ? JSON.stringify(rec) : '')),
    kicadBoardVerticesSet: vi.fn((json: string): unknown => {
      const s = JSON.parse(json) as { uuid: string; outline: number; hole: number; index: number; x: number; y: number };
      const line = rec.outlines.find((l) => l.outline === s.outline && l.hole === s.hole);
      if (s.uuid !== ZONE || line == null || line.points[s.index] == null) return '';
      line.points[s.index] = { x: s.x, y: s.y };
      return JSON.stringify(rec);
    }),
    ...over,
  };
}

/**
 * A ctx over a fake engine module; the board gate answers as the responder's
 * does for an open, idle board. In an fpedit frame the unit makes its own
 * checks over the ctx's reads: `doc` is a footprint open (admit), `busy` a
 * load parked, `keys` a popup menu or a dialog up, `hanging` a placed item on
 * the pointer, `up` the engine up.
 */
function fakeCtx(mod: Record<string, unknown>, state: Partial<{ busy: boolean; doc: boolean; frame: string; keys: boolean; hanging: boolean; up: boolean; idle: boolean; onIdle: () => void }> = {}) {
  const s = { busy: false, doc: true, frame: 'pcb', keys: false, hanging: false, up: true, idle: true, onIdle: () => {}, ...state };
  const boardGate = vi.fn((op: string, exports: readonly string[]) => {
    if (s.frame !== 'pcb') return fail('unsupported', 'a pcb frame');
    for (const n of exports) if (typeof mod[n] !== 'function') return fail('unsupported', n);
    if (!s.doc) return fail('not_ready', op);
    if (s.busy) return fail('busy', op);
    return { w: {} as never, mod };
  });
  return {
    frame: s.frame,
    win: () => (s.up ? {} : null),
    mod: () => (s.up ? mod : null),
    admit: () => s.doc,
    engineBusy: () => s.busy,
    keysBlocked: () => s.keys,
    placeHanging: () => s.hanging,
    boardGate,
    // The engine's apply queue: the queued move runs as it empties.
    applyIdle: vi.fn(async (_ms: number) => { s.onIdle(); return s.idle; }),
  } as unknown as ResponderCtx;
}
const run = (op: string, args: unknown, ctx: ResponderCtx): Promise<Answer> => Promise.resolve((unit as ExtUnit).ops![op].run(args, ctx));
const get = (args: unknown, ctx: ResponderCtx) => run('board.vertices.get', args, ctx);
const set = (args: unknown, ctx: ResponderCtx) => run('board.vertices.set', args, ctx);
const SET = { uuid: ZONE, outline: 0, hole: -1, index: 2, x: 111.5, y: 112.25 };

describe('the unit in the registry', () => {
  it('loads with nothing broken: its ops, cap, asks and held row its own', () => {
    expect(REGISTRY.problems).toEqual([]);
    for (const op of ['board.vertices.get', 'board.vertices.set']) {
      expect(REGISTRY.ops.get(op)?.unit).toBe('m3-i');
      expect(REGISTRY.pending.has(op)).toBe(false);
    }
    expect(REGISTRY.ops.get('board.vertices.get')?.op.passesCheck).toBe(true);
    expect(REGISTRY.ops.get('board.vertices.set')?.op.passesCheck).toBeUndefined();
    expect(REGISTRY.capNames.get(VERTICES_CAP)).toBe('m3-i');
    for (const ask of ['convert', 'outset', 'zoneSettings']) {
      expect(REGISTRY.asks.get(ask)).toBe('m3-i');
      expect(REGISTRY.askReaders.get(ask)?.unit).toBe('m3-i');
    }
  });

  it('holds Edit Corners in the pcb and fpedit frames under vertices; our menu ends it in ev.held', () => {
    expect((unit as ExtUnit).held).toEqual([EDIT_VERTICES]);
    expect(M3_HELD_ROWS).toEqual([{ action: EDIT_VERTICES, frames: ['pcb', 'fpedit'], cap: 'vertices' }]);
    const union = heldActions();
    expect(heldTaken(EDIT_VERTICES, 'pcb', [VERTICES_CAP], union)).toBe(true);
    expect(heldTaken(EDIT_VERTICES, 'pcb', [], union)).toBe(false);
    expect(doorOf(EDIT_VERTICES, 'pcb', [VERTICES_CAP], union)).toBe('held');
    // Without the cap the item has no door and our menu leaves it out.
    expect(doorOf(EDIT_VERTICES, 'pcb', [], union)).toBeNull();
    expect(heldTaken(EDIT_VERTICES, 'sch', [VERTICES_CAP], union)).toBe(false);
    // The footprint editor takes it the same way once its frame lists the cap.
    expect(heldTaken(EDIT_VERTICES, 'fpedit', [VERTICES_CAP], union)).toBe(true);
    expect(heldTaken(EDIT_VERTICES, 'fpedit', [], union)).toBe(false);
    expect(doorOf(EDIT_VERTICES, 'fpedit', [VERTICES_CAP], union)).toBe('held');
    expect(doorOf(EDIT_VERTICES, 'fpedit', [], union)).toBeNull();
    expect(doorRow(EDIT_VERTICES)?.door).toBe('held');
    // The board's windows open the asks through the prompt host.
    expect(doorRow('pcbnew.Convert.convertToPoly')?.door).toBe('prompt:convert');
    expect(doorRow('pcbnew.Convert.outsetItems')?.door).toBe('prompt:outset');
    expect(doorRow('pcbnew.EditorControl.zoneDuplicate')?.door).toBe('prompt:zoneSettings');
  });
});

describe('vertices, feature detected', () => {
  it('lists the cap in a pcb and an fpedit frame, each only with both exports', () => {
    const caps = unit.caps!;
    // Engine fix e10-3 (builds T9 and later) reads corners in the footprint editor as on the board.
    for (const f of ['pcb', 'fpedit']) {
      expect(caps(engine(), f as never)).toEqual([VERTICES_CAP]);
      expect(caps({ kicadBoardVerticesGet: () => '' }, f as never)).toEqual([]);
      expect(caps({}, f as never)).toEqual([]);
    }
    for (const f of ['sch', 'symedit', 'ds']) expect(caps(engine(), f as never)).toEqual([]);
    expect(VERTICES_EXPORTS).toEqual(['kicadBoardVerticesGet', 'kicadBoardVerticesSet']);
    expect((unit as ExtUnit).frames).toEqual(['pcb', 'fpedit']);
  });

  it('on an engine without the exports (run 14) both ops answer unsupported naming the first missing', async () => {
    expect(await get({ uuid: ZONE }, fakeCtx({}))).toEqual(fail('unsupported', 'kicadBoardVerticesGet'));
    expect(await set(SET, fakeCtx({ kicadBoardVerticesGet: () => '' }))).toEqual(fail('unsupported', 'kicadBoardVerticesSet'));
  });

  it('a busy, empty or other frame answers through the gate and never calls the engine', async () => {
    const mod = engine();
    expect(await get({ uuid: ZONE }, fakeCtx(mod, { busy: true }))).toEqual(fail('busy', 'board.vertices.get'));
    expect(await set(SET, fakeCtx(mod, { doc: false }))).toEqual(fail('not_ready', 'board.vertices.set'));
    expect(await get({ uuid: ZONE }, fakeCtx(mod, { frame: 'sch' }))).toEqual(fail('unsupported', 'a pcb frame'));
    expect(mod.kicadBoardVerticesGet).not.toHaveBeenCalled();
    expect(mod.kicadBoardVerticesSet).not.toHaveBeenCalled();
  });
});

describe('the footprint editor (fpedit)', () => {
  const fp = (mod: Record<string, unknown>, state: Partial<{ busy: boolean; doc: boolean; keys: boolean; hanging: boolean; up: boolean }> = {}) => fakeCtx(mod, { frame: 'fpedit', ...state });

  it('reads and moves a corner of the open footprint\'s item as on the board, never through the board gate', async () => {
    const mod = engine();
    const ctx = fp(mod);
    expect(await get({ uuid: ZONE }, ctx)).toEqual({ ok: true, result: RECORD });
    const moved = await set(SET, ctx);
    expect(moved.ok).toBe(true);
    expect(mod.kicadBoardVerticesSet).toHaveBeenCalledWith(JSON.stringify(SET));
    expect((ctx as unknown as { boardGate: ReturnType<typeof vi.fn> }).boardGate).not.toHaveBeenCalled();
    const other = 'cc0ca4d5-0000-4000-8000-000000000399';
    expect(await get({ uuid: other }, ctx)).toEqual(fail('not_found', other));
  });

  it('checks in the board gate\'s order, each before the engine: the engine up, its exports, a footprint open, busy', async () => {
    const mod = engine();
    expect(await get({ uuid: ZONE }, fp(mod, { up: false }))).toEqual(fail('not_ready', 'board.vertices.get'));
    expect(await get({ uuid: ZONE }, fp({}))).toEqual(fail('unsupported', 'kicadBoardVerticesGet'));
    expect(await set(SET, fp({ kicadBoardVerticesGet: () => '' }, { doc: false }))).toEqual(fail('unsupported', 'kicadBoardVerticesSet'));
    expect(await get({ uuid: ZONE }, fp(mod, { doc: false }))).toEqual(fail('not_ready', 'board.vertices.get'));
    expect(await set(SET, fp(mod, { busy: true }))).toEqual(fail('busy', 'board.vertices.set'));
    expect(await set(SET, fp(mod, { keys: true }))).toEqual(fail('busy', 'board.vertices.set'));
    expect(await get({ uuid: ZONE }, fp(mod, { hanging: true }))).toEqual(fail('busy', 'board.vertices.get'));
    expect(await get({ uuid: 'nope' }, fp(mod))).toEqual(fail('bad_args', 'board.vertices.get'));
    expect(mod.kicadBoardVerticesGet).not.toHaveBeenCalled();
    expect(mod.kicadBoardVerticesSet).not.toHaveBeenCalled();
  });

  it('a corner the item lacks is named and never sent there either', async () => {
    const mod = engine();
    expect(await set({ ...SET, index: 9 }, fp(mod))).toEqual(fail('bad_args', 'board.vertices.set: the outline has no corner 9'));
    expect(mod.kicadBoardVerticesSet).not.toHaveBeenCalled();
  });
});

describe('board.vertices.get', () => {
  it('sends exactly { uuid }, lowercased, and answers the record', async () => {
    const mod = engine();
    expect(await get({ uuid: ZONE.toUpperCase() }, fakeCtx(mod))).toEqual({ ok: true, result: RECORD });
    expect(mod.kicadBoardVerticesGet).toHaveBeenCalledWith(JSON.stringify({ uuid: ZONE }));
  });

  it('refuses any other args before the engine', async () => {
    const mod = engine();
    for (const args of [undefined, null, {}, [ZONE], { uuid: 7 }, { uuid: 'nope' }, { uuid: ZONE, outline: 0 }]) {
      expect(await get(args, fakeCtx(mod))).toEqual(fail('bad_args', 'board.vertices.get'));
    }
    expect(mod.kicadBoardVerticesGet).not.toHaveBeenCalled();
  });

  it('"" is not_found naming the uuid; another shape or a throw is island_error', async () => {
    const other = 'cc0ca4d5-0000-4000-8000-000000000399';
    expect(await get({ uuid: other }, fakeCtx(engine()))).toEqual(fail('not_found', other));
    const shaped = (text: unknown) => engine({ kicadBoardVerticesGet: () => text });
    expect(await get({ uuid: ZONE }, fakeCtx(shaped('{"uuid":"x"}')))).toEqual(fail('island_error', 'board.vertices.get: the engine answered another shape'));
    // A record of another item is another shape.
    expect(await get({ uuid: ZONE }, fakeCtx(shaped(JSON.stringify({ ...RECORD, uuid: other }))))).toEqual(fail('island_error', 'board.vertices.get: the engine answered another shape'));
    expect(await get({ uuid: ZONE }, fakeCtx(engine({ kicadBoardVerticesGet: () => { throw new Error('trap'); } })))).toEqual(fail('island_error', 'board.vertices.get'));
  });
});

describe('board.vertices.set', () => {
  it('reads first, sends the set as given, and answers the read back record holding the moved corner', async () => {
    const mod = engine();
    const r = await set(SET, fakeCtx(mod));
    expect(mod.kicadBoardVerticesSet).toHaveBeenCalledTimes(1);
    expect(mod.kicadBoardVerticesSet).toHaveBeenCalledWith(JSON.stringify(SET));
    const want = structuredClone(RECORD);
    want.outlines[0].points[2] = { x: 111.5, y: 112.25 };
    expect(r).toEqual({ ok: true, result: want });
  });

  it('a hole corner is set the same way', async () => {
    const mod = engine();
    const r = await set({ ...SET, hole: 0, index: 0, x: 101, y: 101 }, fakeCtx(mod));
    expect(r.ok).toBe(true);
    expect((r as unknown as { result: { outlines: Array<{ points: unknown[] }> } }).result.outlines[1].points[0]).toEqual({ x: 101, y: 101 });
  });

  it('refuses any other args before the engine', async () => {
    const mod = engine();
    const bad = [
      undefined, {}, { ...SET, extra: 1 }, { uuid: ZONE, outline: 0, hole: -1, index: 0, x: 1 }, { ...SET, uuid: 'nope' },
      { ...SET, outline: -1 }, { ...SET, outline: 0.5 }, { ...SET, hole: -2 }, { ...SET, index: -1 }, { ...SET, x: Number.NaN },
      { ...SET, y: '1' }, { ...SET, x: 60_000 },
    ];
    for (const args of bad) expect(await set(args, fakeCtx(mod))).toEqual(fail('bad_args', 'board.vertices.set'));
    expect(mod.kicadBoardVerticesGet).not.toHaveBeenCalled();
    expect(mod.kicadBoardVerticesSet).not.toHaveBeenCalled();
  });

  it('a corner the item lacks is named and never sent; an item the board lacks is not_found', async () => {
    const mod = engine();
    expect(await set({ ...SET, outline: 1 }, fakeCtx(mod))).toEqual(fail('bad_args', 'board.vertices.set: the item has no outline 1 hole -1'));
    expect(await set({ ...SET, hole: 3 }, fakeCtx(mod))).toEqual(fail('bad_args', 'board.vertices.set: the item has no outline 0 hole 3'));
    expect(await set({ ...SET, index: 4 }, fakeCtx(mod))).toEqual(fail('bad_args', 'board.vertices.set: the outline has no corner 4'));
    const other = 'cc0ca4d5-0000-4000-8000-000000000399';
    expect(await set({ ...SET, uuid: other }, fakeCtx(mod))).toEqual(fail('not_found', other));
    expect(mod.kicadBoardVerticesSet).not.toHaveBeenCalled();
  });

  it('"" from the set, or a read back without the corner, is not_applied; another shape is island_error', async () => {
    expect(await set(SET, fakeCtx(engine({ kicadBoardVerticesSet: () => '' })))).toEqual(fail('not_applied', 'board.vertices.set'));
    // The engine answered the item unchanged.
    expect(await set(SET, fakeCtx(engine({ kicadBoardVerticesSet: () => JSON.stringify(RECORD) })))).toEqual(fail('not_applied', 'board.vertices.set'));
    expect(await set(SET, fakeCtx(engine({ kicadBoardVerticesSet: () => '{}' })))).toEqual(fail('island_error', 'board.vertices.set: the engine answered another shape'));
    expect(await set(SET, fakeCtx(engine({ kicadBoardVerticesSet: () => { throw new Error('trap'); } })))).toEqual(fail('island_error', 'board.vertices.set'));
  });
});

/**
 * Build T17 (engine item 1): a moved corner is queued on the frame's tool
 * coroutine and answered `{"queued":true}`; the island waits for the apply
 * queue, then reads the item back. A corner already there is still answered
 * at once with the record.
 */
describe('board.vertices.set on an engine that queues the move (build T17)', () => {
  /** An engine that answers {"queued":true} and moves the corner only when the apply queue runs. */
  function queuing(move = true) {
    const mod = engine();
    const real = mod.kicadBoardVerticesSet.getMockImplementation()!;
    let pending: string | null = null;
    mod.kicadBoardVerticesSet = vi.fn((json: string): unknown => { pending = json; return '{"queued":true}'; });
    const onIdle = () => { if (pending != null && move) real(pending); pending = null; };
    return { mod, onIdle };
  }

  it('waits for the apply queue (5 s at most), then answers the item read back holding the corner', async () => {
    const { mod, onIdle } = queuing();
    const ctx = fakeCtx(mod, { onIdle });
    const r = await set(SET, ctx);
    expect(ctx.applyIdle).toHaveBeenCalledWith(5000);
    expect(mod.kicadBoardVerticesGet).toHaveBeenCalledTimes(2);
    const want = structuredClone(RECORD);
    want.outlines[0].points[2] = { x: 111.5, y: 112.25 };
    expect(r).toEqual({ ok: true, result: want });
  });

  it('is not_applied when the queued body refused the move, or the queue never emptied', async () => {
    const refused = queuing(false);
    expect(await set(SET, fakeCtx(refused.mod, { onIdle: refused.onIdle }))).toEqual(fail('not_applied', 'board.vertices.set'));
    const stuck = queuing();
    expect(await set(SET, fakeCtx(stuck.mod, { idle: false }))).toEqual(fail('not_applied', 'board.vertices.set'));
    expect(stuck.mod.kicadBoardVerticesGet).toHaveBeenCalledTimes(1);
  });

  it('is not_found when the item is gone by the read back', async () => {
    const { mod, onIdle } = queuing();
    const read = mod.kicadBoardVerticesGet.getMockImplementation()!;
    let n = 0;
    mod.kicadBoardVerticesGet = vi.fn((json: string): unknown => (++n === 1 ? read(json) : ''));
    expect(await set(SET, fakeCtx(mod, { onIdle }))).toEqual(fail('not_found', ZONE));
  });

  it('reads the queued answer closed: another key beside queued, or queued false, is another shape', async () => {
    for (const odd of ['{"queued":false}', '{"queued":true,"x":1}', '{"queued":1}', 'queued']) {
      const ctx = fakeCtx(engine({ kicadBoardVerticesSet: () => odd }));
      expect(await set(SET, ctx)).toEqual(fail('island_error', 'board.vertices.set: the engine answered another shape'));
      expect(ctx.applyIdle).not.toHaveBeenCalled();
    }
  });

  it('a corner already there is answered at once from the record, with no wait (as on run 15 before T17)', async () => {
    const mod = engine();
    const ctx = fakeCtx(mod);
    const r = await set({ ...SET, index: 0, x: 100, y: 100 }, ctx);
    expect(r).toEqual({ ok: true, result: RECORD });
    expect(ctx.applyIdle).not.toHaveBeenCalled();
  });
});

describe('the vertices readers', () => {
  it('parse the args closed', () => {
    expect(parseVerticesGet({ uuid: ZONE })).toEqual({ uuid: ZONE });
    expect(parseVerticesSet(SET)).toEqual(SET);
    expect(parseVerticesSet({ ...SET, x: -50_000 })).toEqual({ ...SET, x: -50_000 });
  });

  it('read the record closed: kinds, lines of three corners or more, no line twice', () => {
    const t = (v: unknown) => readVertices(JSON.stringify(v), ZONE);
    expect(t(RECORD)).toEqual(RECORD);
    for (const kind of ['copper', 'ruleArea', 'polygon']) expect(t({ ...RECORD, kind })?.kind).toBe(kind);
    expect(t({ ...RECORD, kind: 'track' })).toBeNull();
    expect(t({ ...RECORD, outlines: [{ outline: 0, hole: -1, points: SQUARE.slice(0, 2) }] })).toBeNull();
    expect(t({ ...RECORD, outlines: [RECORD.outlines[0], RECORD.outlines[0]] })).toBeNull();
    expect(t({ ...RECORD, outlines: [{ ...RECORD.outlines[0], extra: 1 }] })).toBeNull();
    expect(t({ ...RECORD, outlines: [{ ...RECORD.outlines[0], points: [...SQUARE.slice(1), { x: 1, y: 2, z: 3 }] }] })).toBeNull();
    expect(t({ ...RECORD, more: 1 })).toBeNull();
    expect(readVertices('', ZONE)).toBeNull();
    expect(readVertices('not json', ZONE)).toBeNull();
    expect(readVertices(RECORD, ZONE)).toBeNull();
  });
});

describe('the convert ask', () => {
  const REC = { strategies: ['copyLineWidth', 'centerline', 'boundingHull'], strategy: 'centerline', gap: 0, lineWidth: 0.1, deleteOriginals: false };

  it('reads the record closed, the strategies in KiCad order and none twice', () => {
    expect(readConvert(REC)).toEqual(REC);
    // Create Lines from a polygon shows no strategy; KiCad may keep one selected the dialog hides.
    expect(readConvert({ ...REC, strategies: [], strategy: 'copyLineWidth' })).toEqual({ ...REC, strategies: [], strategy: 'copyLineWidth' });
    expect(readConvert({ ...REC, strategies: ['centerline', 'boundingHull'] })?.strategies).toEqual(['centerline', 'boundingHull']);
    expect(readConvert({ ...REC, strategies: ['boundingHull', 'centerline'] })).toBeNull();
    expect(readConvert({ ...REC, strategies: ['centerline', 'centerline'] })).toBeNull();
    expect(readConvert({ ...REC, strategies: ['hull'] })).toBeNull();
    expect(readConvert({ ...REC, strategy: 'hull' })).toBeNull();
    expect(readConvert({ ...REC, gap: -1 })).toBeNull();
    expect(readConvert({ ...REC, lineWidth: Number.POSITIVE_INFINITY })).toBeNull();
    expect(readConvert({ ...REC, deleteOriginals: 1 })).toBeNull();
    expect(readConvert({ ...REC, extra: 1 })).toBeNull();
    const { gap: _gap, ...short } = REC;
    void _gap;
    expect(readConvert(short)).toBeNull();
  });
});

describe('the outset ask', () => {
  const REC = {
    outsetDistance: 1, roundCorners: false, useSourceLayers: false, useSourceWidths: true, layer: 'Edge.Cuts',
    layers: ['F.Cu', 'B.Cu', 'F.SilkS', 'Edge.Cuts'], lineWidth: 0.1, gridRounding: null, deleteSourceItems: false,
  };

  it('reads the record closed, grid rounding a length or null', () => {
    expect(readOutset(REC)).toEqual(REC);
    expect(readOutset({ ...REC, gridRounding: 0.01 })?.gridRounding).toBe(0.01);
    expect(readOutset({ ...REC, outsetDistance: -0.5 })?.outsetDistance).toBe(-0.5);
    expect(readOutset({ ...REC, gridRounding: -1 })).toBeNull();
    expect(readOutset({ ...REC, layer: 'Edge Cuts' })).toBeNull();
    expect(readOutset({ ...REC, layers: ['F.Cu', 'F.Cu'] })).toBeNull();
    expect(readOutset({ ...REC, layers: 'F.Cu' })).toBeNull();
    expect(readOutset({ ...REC, lineWidth: -0.1 })).toBeNull();
    expect(readOutset({ ...REC, roundCorners: 'yes' })).toBeNull();
    expect(readOutset({ ...REC, extra: 1 })).toBeNull();
  });
});

describe('the zoneSettings ask', () => {
  const COPPER = {
    kind: 'zone', uuid: '', locked: false, name: '', net: 'Z', layers: ['F.Cu'], priority: 0, clearance: 0.5, minWidth: 0.25,
    padConnection: 'thermal', thermalGap: 0.5, spokeWidth: 0.5, netChoices: ['', 'A', 'B', 'Z'],
  };
  const NON_COPPER = { kind: 'zone', uuid: '', ruleArea: false, name: '', layers: ['F.SilkS'], locked: false, points: [], borderStyle: 'edge', hatchPitch: 0.5 };
  const RULE_AREA = {
    ...NON_COPPER, ruleArea: true, layers: ['F.Cu'], noTracks: true, noVias: true, noPads: false, noCopperPour: true, noFootprints: false,
    placement: false, placementSource: 'sheet', placementName: '',
  };

  it('reads a copper zone in wave 1\'s zone sheet with uuid ""', () => {
    expect(readZoneSettings({ kind: 'copper', sheet: COPPER })).toEqual({ kind: 'copper', sheet: COPPER });
    expect(readZoneSettings({ kind: 'copper', sheet: { ...COPPER, uuid: ZONE } })).toBeNull();
    expect(readZoneSettings({ kind: 'copper', sheet: { ...COPPER, priority: -1 } })).toBeNull();
    expect(readZoneSettings({ kind: 'copper', sheet: { ...COPPER, fill: 'solid' } })).toBeNull();
  });

  it('reads a non copper zone and a rule area in the zone item record with uuid ""', () => {
    expect(readZoneSettings({ kind: 'nonCopper', sheet: NON_COPPER })).toEqual({ kind: 'nonCopper', sheet: NON_COPPER });
    expect(readZoneSettings({ kind: 'ruleArea', sheet: RULE_AREA })).toEqual({ kind: 'ruleArea', sheet: RULE_AREA });
    // The kind and the record agree.
    expect(readZoneSettings({ kind: 'nonCopper', sheet: RULE_AREA })).toBeNull();
    expect(readZoneSettings({ kind: 'ruleArea', sheet: NON_COPPER })).toBeNull();
    expect(readZoneSettings({ kind: 'nonCopper', sheet: { ...NON_COPPER, uuid: ZONE } })).toBeNull();
    expect(readZoneSettings({ kind: 'nonCopper', sheet: COPPER })).toBeNull();
    expect(readZoneSettings({ kind: 'copper', sheet: NON_COPPER })).toBeNull();
  });

  it('refuses another kind or more keys', () => {
    expect(readZoneSettings({ kind: 'keepout', sheet: NON_COPPER })).toBeNull();
    expect(readZoneSettings({ kind: 'copper', sheet: COPPER, purpose: 'duplicate' })).toBeNull();
    expect(readZoneSettings({ kind: 'copper' })).toBeNull();
    expect(readZoneSettings(null)).toBeNull();
  });
});

describe('the prompt host reads these asks through the registry', () => {
  it('each ask reader is this unit\'s', () => {
    expect(Object.keys(BOARD_ASK_READERS).sort()).toEqual(['convert', 'outset', 'zoneSettings']);
    for (const [ask, read] of Object.entries(BOARD_ASK_READERS)) expect(REGISTRY.askReaders.get(ask)?.read).toBe(read);
  });
});
