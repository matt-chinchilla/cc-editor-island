// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// m6-i: the placement asks (moveExact, offset, array, positionRelative,
// filterSelection, findFootprint) and selectFilter.get and selectFilter.set.
// The engine here is this test's own module of exports; the real engine is
// the e2e's (tests/e2e/m/m6-placement.spec.ts).
import { describe, expect, it, vi } from 'vitest';
import { fail, type Answer, type ExtUnit, type ResponderCtx } from './contract';
import { REGISTRY } from './registry';
import unit, { SELECT_FILTER_CAP, SELECT_FILTER_EXPORTS } from './m6-i';
import {
  FILTER_SELECTION_KEYS, PLACEMENT_ASK_READERS, PLACEMENT_ASKS, readArray, readFilterSelection, readFindFootprint, readMoveExact, readOffset,
  readPositionRelative,
} from './m6-i/asks';
import { BOARD_FILTER_KEYS, parseFilterSet, readFilter, SCH_FILTER_KEYS } from './m6-i/selectFilter';
import { doorOf } from './m1-i/doors';
import { heldActions } from './registry';

const MOVE = { x: 0, y: 0, rotation: 0, anchor: 'item', anchors: ['item', 'userOrigin', 'drillOrigin'] };
const AXIS = { type: 'numeric', start: '1', step: 1 };
const ARRAY = {
  shape: 'grid',
  arrangeSelection: false,
  uniqueReferences: true,
  padNumbering: false,
  grid: {
    nx: 5, ny: 5, dx: 2.54, dy: 2.54, offsetX: 0, offsetY: 0, centered: true, stagger: 1, staggerRows: true, horizontalThenVertical: true,
    reverseNumberingAlternate: false, numberingStartSpecified: true, numbering2d: false, primary: AXIS, secondary: AXIS,
  },
  circular: { centerX: 0, centerY: 0, angle: 90, angleOffset: 0, clockwise: true, count: 4, rotateItems: false, numberingStartSpecified: true, axis: AXIS },
};
const RELATIVE = { anchor: { kind: 'item', x: 120.5, y: 80, label: 'Reference item: U1' }, x: 5, y: 0 };
const FILTER_SEL = Object.fromEntries(FILTER_SELECTION_KEYS.map((k) => [k, true]));
const FIND = { references: ['R1', 'R2', 'U1'] };

const allTrue = (keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, true]));

/** The engine's two exports over one editor's filter, as m6-e3 answers them. */
function engine(frame: 'sch' | 'pcb', over: Record<string, unknown> = {}) {
  const keys: readonly string[] = frame === 'pcb' ? BOARD_FILTER_KEYS : SCH_FILTER_KEYS;
  const f: Record<string, boolean> = allTrue(keys);
  return {
    kicadSelectionFilterGet: vi.fn((): unknown => JSON.stringify(f)),
    kicadSelectionFilterSet: vi.fn((json: string): unknown => {
      const s = JSON.parse(json) as Record<string, unknown>;
      const names = Object.keys(s);
      if (names.length === 0 || !names.every((k) => keys.includes(k) && typeof s[k] === 'boolean')) return false;
      Object.assign(f, s);
      return true;
    }),
    ...over,
  };
}

/** A ctx over a fake engine module; the gates answer as the responder's do for an open, idle document. */
function fakeCtx(mod: Record<string, unknown>, state: Partial<{ busy: boolean; doc: boolean; frame: string }> = {}) {
  const s = { busy: false, doc: true, frame: 'pcb', ...state };
  const gateFor = (want: string) => (op: string, exports: readonly string[]) => {
    if (s.frame !== want) return fail('unsupported', `a ${want} frame`);
    for (const n of exports) if (typeof mod[n] !== 'function') return fail('unsupported', n);
    if (!s.doc) return fail('not_ready', op);
    if (s.busy) return fail('busy', op);
    return { w: {} as never, mod };
  };
  return { frame: s.frame, mod: () => mod, boardGate: gateFor('pcb'), schematicGate: gateFor('sch') } as unknown as ResponderCtx;
}
const run = (op: string, args: unknown, ctx: ResponderCtx): Promise<Answer> => Promise.resolve((unit as ExtUnit).ops![op].run(args, ctx));
const get = (args: unknown, ctx: ResponderCtx) => run('selectFilter.get', args, ctx);
const set = (args: unknown, ctx: ResponderCtx) => run('selectFilter.set', args, ctx);

describe('the unit in the registry', () => {
  it('loads with nothing broken: its ops, cap and asks its own', () => {
    expect(REGISTRY.problems).toEqual([]);
    for (const op of ['selectFilter.get', 'selectFilter.set']) {
      expect(REGISTRY.ops.get(op)?.unit).toBe('m6-i');
      expect(REGISTRY.pending.has(op)).toBe(false);
    }
    expect(REGISTRY.ops.get('selectFilter.get')?.op.passesCheck).toBe(true);
    expect(REGISTRY.ops.get('selectFilter.set')?.op.passesCheck).toBeUndefined();
    expect(REGISTRY.capNames.get(SELECT_FILTER_CAP)).toBe('m6-i');
    expect([...PLACEMENT_ASKS]).toEqual(['moveExact', 'offset', 'array', 'positionRelative', 'filterSelection', 'findFootprint']);
    for (const ask of PLACEMENT_ASKS) {
      expect(REGISTRY.asks.get(ask)).toBe('m6-i');
      expect(REGISTRY.askReaders.get(ask)?.unit).toBe('m6-i');
    }
  });

  it('answers in the sch and pcb frames only, and lists the cap only where the engine has both exports', () => {
    const u = unit as ExtUnit;
    expect(u.frames).toEqual(['sch', 'pcb']);
    const mod = engine('pcb');
    expect(u.caps!(mod, 'pcb')).toEqual([SELECT_FILTER_CAP]);
    expect(u.caps!(mod, 'sch')).toEqual([SELECT_FILTER_CAP]);
    expect(u.caps!(mod, 'fpedit')).toEqual([]);
    expect(u.caps!(mod, 'symedit')).toEqual([]);
    // Engine run 14: neither export, no cap.
    expect(u.caps!({}, 'pcb')).toEqual([]);
    expect(u.caps!({ kicadSelectionFilterGet: () => '' }, 'sch')).toEqual([]);
    expect(SELECT_FILTER_EXPORTS).toEqual(['kicadSelectionFilterGet', 'kicadSelectionFilterSet']);
  });

  it('gives each placement command of our menu its prompt door while the engine asks (cap prompts)', () => {
    const union = heldActions();
    for (const action of [
      'pcbnew.InteractiveEdit.moveExact', 'pcbnew.InteractiveEdit.FindMove', 'pcbnew.Array.createArray',
      'pcbnew.PositionRelative.positionRelative', 'pcbnew.PositionRelative.interactiveOffsetTool', 'pcbnew.InteractiveSelection.FilterSelection',
    ]) {
      expect(doorOf(action, 'pcb', ['prompts'], union), action).toBe('prompt');
      expect(doorOf(action, 'pcb', [], union), action).toBeNull();
    }
  });
});

describe('the ask records, read closed', () => {
  it('takes each record as the engine sends it, through the registry the prompt host reads', () => {
    const records: Record<string, unknown> = { moveExact: MOVE, offset: { x: 3.001, y: -0.5 }, array: ARRAY, positionRelative: RELATIVE, filterSelection: FILTER_SEL, findFootprint: FIND };
    for (const ask of PLACEMENT_ASKS) {
      expect(PLACEMENT_ASK_READERS[ask](records[ask]), ask).toEqual(records[ask]);
      expect(REGISTRY.askReaders.get(ask)!.read(records[ask]), ask).toEqual(records[ask]);
      // Another ask's record is not this one's.
      expect(PLACEMENT_ASK_READERS[ask]({}), ask).toBeNull();
      expect(PLACEMENT_ASK_READERS[ask](null), ask).toBeNull();
    }
  });

  it('moveExact: the anchor one of the offered anchors, none twice; finite numbers; no other key', () => {
    expect(readMoveExact({ ...MOVE, x: 2, rotation: 90 })).toEqual({ ...MOVE, x: 2, rotation: 90 });
    expect(readMoveExact({ ...MOVE, anchor: 'selectionCenter', anchors: ['selectionCenter', 'item', 'userOrigin'] })).not.toBeNull();
    expect(readMoveExact({ ...MOVE, anchor: 'drillOrigin', anchors: ['item', 'userOrigin'] })).toBeNull();
    expect(readMoveExact({ ...MOVE, anchors: ['item', 'item'] })).toBeNull();
    expect(readMoveExact({ ...MOVE, anchors: [] })).toBeNull();
    expect(readMoveExact({ ...MOVE, anchors: ['item', 'gridOrigin'] })).toBeNull();
    expect(readMoveExact({ ...MOVE, x: Number.NaN })).toBeNull();
    expect(readMoveExact({ ...MOVE, y: '2' })).toBeNull();
    expect(readMoveExact({ ...MOVE, rotation: Infinity })).toBeNull();
    expect(readMoveExact({ ...MOVE, polar: false })).toBeNull();
    const { anchors: _a, ...lacking } = MOVE;
    expect(readMoveExact(lacking)).toBeNull();
  });

  it('offset: exactly x and y in mm', () => {
    expect(readOffset({ x: 1e5, y: 0 })).toBeNull();
    expect(readOffset({ x: 1, y: 0, z: 0 })).toBeNull();
    expect(readOffset({ x: 1 })).toBeNull();
  });

  it('array: both tabs whole, each axis closed, the shape grid or circular', () => {
    expect(readArray({ ...ARRAY, shape: 'circular', padNumbering: true })).toEqual({ ...ARRAY, shape: 'circular', padNumbering: true });
    for (const type of ['numeric', 'hex', 'alphaShort', 'alphaFull']) {
      expect(readArray({ ...ARRAY, circular: { ...ARRAY.circular, axis: { ...AXIS, type, start: 'A' } } })).not.toBeNull();
    }
    expect(readArray({ ...ARRAY, shape: 'polar' })).toBeNull();
    // RULINGS 33a: the engine's keys are spelled centerX, centerY and centered (engine fix e2-1); the old spelling is no alias.
    const old = (k: string) => k.replace('ter', 'tre');
    const { centerX, centerY, ...circularRest } = ARRAY.circular;
    expect(readArray({ ...ARRAY, circular: { ...circularRest, [old('centerX')]: centerX, [old('centerY')]: centerY } })).toBeNull();
    const { centered, ...gridRest } = ARRAY.grid;
    expect(readArray({ ...ARRAY, grid: { ...gridRest, [old('centered').replace('treed', 'tred')]: centered } })).toBeNull();
    expect(readArray({ ...ARRAY, grid: { ...ARRAY.grid, nx: 2.5 } })).toBeNull();
    expect(readArray({ ...ARRAY, grid: { ...ARRAY.grid, extra: 1 } })).toBeNull();
    expect(readArray({ ...ARRAY, grid: { ...ARRAY.grid, primary: { ...AXIS, type: 'roman' } } })).toBeNull();
    expect(readArray({ ...ARRAY, grid: { ...ARRAY.grid, secondary: { type: 'numeric', start: 1, step: 1 } } })).toBeNull();
    expect(readArray({ ...ARRAY, circular: { ...ARRAY.circular, count: '4' } })).toBeNull();
    expect(readArray({ ...ARRAY, circular: { ...ARRAY.circular, axis: { ...AXIS, start: 'x'.repeat(2000) } } })).toBeNull();
    const { circular: _c, ...noCircular } = ARRAY;
    expect(readArray(noCircular)).toBeNull();
    expect(readArray({ ...ARRAY, padNumbering: 1 })).toBeNull();
  });

  it('positionRelative: the anchor of a known kind with its label, the offset in mm', () => {
    for (const kind of ['item', 'point', 'gridOrigin', 'userOrigin']) {
      expect(readPositionRelative({ ...RELATIVE, anchor: { ...RELATIVE.anchor, kind } })).not.toBeNull();
    }
    expect(readPositionRelative({ ...RELATIVE, anchor: { ...RELATIVE.anchor, kind: 'drillOrigin' } })).toBeNull();
    expect(readPositionRelative({ ...RELATIVE, anchor: { kind: 'item', x: 0, y: 0 } })).toBeNull();
    expect(readPositionRelative({ ...RELATIVE, polar: true })).toBeNull();
    expect(readPositionRelative({ ...RELATIVE, x: null })).toBeNull();
  });

  it('filterSelection: the eight boxes, booleans', () => {
    expect(readFilterSelection({ ...FILTER_SEL, includeTracks: false })).toEqual({ ...FILTER_SEL, includeTracks: false });
    expect(readFilterSelection({ ...FILTER_SEL, includeTracks: 1 })).toBeNull();
    const { includePcbTexts: _t, ...seven } = FILTER_SEL;
    expect(readFilterSelection(seven)).toBeNull();
    expect(readFilterSelection({ ...FILTER_SEL, includeGroups: true })).toBeNull();
  });

  it('findFootprint: the references in the list order, strings, repeats kept as KiCad lists them', () => {
    expect(readFindFootprint({ references: [] })).toEqual({ references: [] });
    expect(readFindFootprint({ references: ['R1', 'R1'] })).toEqual({ references: ['R1', 'R1'] });
    expect(readFindFootprint({ references: ['R1', 2] })).toBeNull();
    expect(readFindFootprint({ references: 'R1' })).toBeNull();
    expect(readFindFootprint({ references: ['R1'], value: 'x' })).toBeNull();
  });

  it('copies what it reads: the reader never hands the engine record on', () => {
    const r = readMoveExact(MOVE)!;
    expect(r.anchors).not.toBe(MOVE.anchors);
    const f = readFindFootprint(FIND)!;
    expect(f.references).not.toBe(FIND.references);
  });
});

describe('the selection filter shapes', () => {
  it('reads exactly the frame keys, booleans', () => {
    expect(readFilter(JSON.stringify(allTrue(BOARD_FILTER_KEYS)), 'pcb')).toEqual(allTrue(BOARD_FILTER_KEYS));
    expect(readFilter(JSON.stringify(allTrue(SCH_FILTER_KEYS)), 'sch')).toEqual(allTrue(SCH_FILTER_KEYS));
    expect(BOARD_FILTER_KEYS).toHaveLength(12);
    expect(SCH_FILTER_KEYS).toHaveLength(10);
    expect(readFilter(JSON.stringify(allTrue(SCH_FILTER_KEYS)), 'pcb')).toBeNull();
    expect(readFilter(JSON.stringify({ ...allTrue(BOARD_FILTER_KEYS), tracks: 'no' }), 'pcb')).toBeNull();
    expect(readFilter('', 'pcb')).toBeNull();
    expect(readFilter('not json', 'sch')).toBeNull();
    expect(readFilter({}, 'sch')).toBeNull();
  });

  it('takes a set of one or more of the frame switches', () => {
    expect(parseFilterSet({ filter: { tracks: false } }, 'pcb')).toEqual({ tracks: false });
    expect(parseFilterSet({ filter: { wires: false, lockedItems: true } }, 'sch')).toEqual({ lockedItems: true, wires: false });
    expect(parseFilterSet({ filter: {} }, 'pcb')).toBeNull();
    expect(parseFilterSet({ filter: { wires: false } }, 'pcb')).toBeNull();
    expect(parseFilterSet({ filter: { tracks: false } }, 'sch')).toBeNull();
    expect(parseFilterSet({ filter: { tracks: 0 } }, 'pcb')).toBeNull();
    expect(parseFilterSet({ filter: { tracks: false }, frame: 'pcb' }, 'pcb')).toBeNull();
    expect(parseFilterSet({ tracks: false }, 'pcb')).toBeNull();
    expect(parseFilterSet(null, 'pcb')).toBeNull();
  });
});

describe('selectFilter.get', () => {
  it('answers the twelve board switches in a pcb frame and the ten schematic ones in a sch frame', async () => {
    expect(await get({}, fakeCtx(engine('pcb')))).toEqual({ ok: true, result: { frame: 'pcb', filter: allTrue(BOARD_FILTER_KEYS) } });
    expect(await get(undefined, fakeCtx(engine('sch'), { frame: 'sch' }))).toEqual({ ok: true, result: { frame: 'sch', filter: allTrue(SCH_FILTER_KEYS) } });
  });

  it('refuses args, then the gate (no export named, no document, busy), then a read of another shape', async () => {
    expect(await get({ frame: 'pcb' }, fakeCtx(engine('pcb')))).toEqual(fail('bad_args', 'selectFilter.get'));
    expect(await get({}, fakeCtx({}))).toEqual(fail('unsupported', 'kicadSelectionFilterGet'));
    expect(await get({}, fakeCtx(engine('pcb'), { doc: false }))).toEqual(fail('not_ready', 'selectFilter.get'));
    expect(await get({}, fakeCtx(engine('pcb'), { busy: true }))).toEqual(fail('busy', 'selectFilter.get'));
    // A board read in a schematic frame: another shape.
    const r = await get({}, fakeCtx(engine('pcb'), { frame: 'sch' }));
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ code: 'island_error' });
    expect(await get({}, fakeCtx(engine('pcb', { kicadSelectionFilterGet: () => { throw new Error('x'); } })))).toEqual(fail('island_error', 'selectFilter.get'));
  });
});

describe('selectFilter.set', () => {
  it('sets the named switches, keeps the rest, and answers the read back', async () => {
    const mod = engine('pcb');
    const ctx = fakeCtx(mod);
    expect(await set({ filter: { tracks: false } }, ctx)).toEqual({ ok: true, result: { frame: 'pcb', filter: { ...allTrue(BOARD_FILTER_KEYS), tracks: false } } });
    expect(mod.kicadSelectionFilterSet).toHaveBeenCalledWith('{"tracks":false}');
    expect(await get({}, ctx)).toEqual({ ok: true, result: { frame: 'pcb', filter: { ...allTrue(BOARD_FILTER_KEYS), tracks: false } } });
    const sch = engine('sch');
    expect(await set({ filter: { wires: false } }, fakeCtx(sch, { frame: 'sch' }))).toEqual({ ok: true, result: { frame: 'sch', filter: { ...allTrue(SCH_FILTER_KEYS), wires: false } } });
  });

  it('refuses a set of another shape before the engine is asked', async () => {
    const mod = engine('pcb');
    for (const args of [{ filter: {} }, { filter: { wires: false } }, { filter: { tracks: 'no' } }, { tracks: false }, null]) {
      expect(await set(args, fakeCtx(mod)), JSON.stringify(args)).toEqual(fail('bad_args', 'selectFilter.set'));
    }
    expect(mod.kicadSelectionFilterSet).not.toHaveBeenCalled();
  });

  it('answers the gate refusals, not_applied when the engine refuses or the read back disagrees', async () => {
    expect(await set({ filter: { tracks: false } }, fakeCtx({}))).toEqual(fail('unsupported', 'kicadSelectionFilterGet'));
    expect(await set({ filter: { tracks: false } }, fakeCtx(engine('pcb'), { busy: true }))).toEqual(fail('busy', 'selectFilter.set'));
    expect(await set({ filter: { tracks: false } }, fakeCtx(engine('pcb', { kicadSelectionFilterSet: () => false })))).toEqual(fail('not_applied', 'selectFilter.set'));
    // The engine says done, the read back still has the switch on.
    expect(await set({ filter: { tracks: false } }, fakeCtx(engine('pcb', { kicadSelectionFilterSet: () => true })))).toEqual(fail('not_applied', 'selectFilter.set'));
    expect(await set({ filter: { tracks: false } }, fakeCtx(engine('pcb'), { frame: 'fpedit' }))).toMatchObject({ ok: false, code: 'unsupported' });
  });
});
