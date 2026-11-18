// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The item records read closed (FP spec 7.2): each readable kind's record
// read whole, then refused for one key missing, one key too many, one type
// and one bound at a time; the sets and the new items; the read back rules.
import { describe, expect, it } from 'vitest';
import {
  ITEM_RECORD_KINDS, NEW_ITEM_NEEDS, READABLE_KINDS, base64Bytes, itemSetKeys, itemSetMisfit, readItemRecord, readItemSet, readNewItem, showsItemSet,
  type ItemRecord, type ItemRecordKind,
} from './itemRecords';

const U = (n: number): string => `abcdef44-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** A 1 by 1 PNG's base64 (the signature, IHDR, IDAT, IEND). */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const shape = (o: Record<string, unknown> = {}) => ({
  shape: 'roundrect', size: [1.5, 0.6], offset: [0, 0], delta: [0, 0], roundRatio: 0.25, chamferRatio: 0, chamferCorners: [], anchor: 'circle', primitives: [], ...o,
});
const pad = (o: Record<string, unknown> = {}) => ({
  kind: 'pad', uuid: U(1), number: '1', pinName: '', pinType: '', type: 'smd', x: -2.475, y: -1.905, angle: 0, locked: false, padstack: 'normal',
  copper: shape(), layerShapes: [], drill: null, layers: ['F.Cu', 'F.Paste', 'F.Mask'], dieLength: 0, dieDelay: 0,
  clearance: null, maskMargin: null, pasteMargin: null, pasteRatio: null, zoneConnection: 'inherit', customZoneShape: 'outline',
  thermalSpokeWidth: null, thermalGap: null, thermalAngle: 90, property: 'none', unconnectedLayers: 'keep_all',
  teardrop: { enabled: false, useTwoTracks: true, preferZoneConnection: true, maxLength: 1, maxWidth: 2, lengthRatio: 0.5, widthRatio: 1, curved: false, sizeFilterRatio: 0.9 },
  backdrill: { front: null, back: null },
  postMachining: { front: { mode: 'none', size: 0, depth: 0, angle: 0 }, back: { mode: 'none', size: 0, depth: 0, angle: 0 } },
  ...o,
});
const style = { layer: 'F.SilkS', angle: 0, size: [1, 1], thickness: 0.15, autoThickness: false, bold: false, italic: false, mirrored: false, hJustify: 'center', vJustify: 'center', knockout: false, font: 'KiCad Font' };
const field = (o: Record<string, unknown> = {}) => ({ kind: 'field', uuid: U(2), name: 'Reference', text: 'REF**', x: 0, y: -3, visible: true, keepUpright: true, ...style, ...o });
const text = (o: Record<string, unknown> = {}) => ({ kind: 'text', uuid: U(3), name: '', text: '${REFERENCE}', x: 0, y: 0, keepUpright: true, ...style, layer: 'F.Fab', ...o });
const textbox = (o: Record<string, unknown> = {}) => ({ kind: 'textbox', uuid: U(4), text: 'B', points: [[0, 0], [5, 3]], locked: false, border: true, borderWidth: 0.1, borderStyle: 'solid', ...style, ...o });
const table = (o: Record<string, unknown> = {}) => ({
  kind: 'table', uuid: U(5), x: 1, y: 1, layer: 'F.SilkS', locked: false, cells: [['a', 'b'], ['c', null]], borderExternal: true, borderHeader: true,
  borderWidth: 0.1, borderStyle: 'solid', rowSeparators: true, colSeparators: true, separatorsWidth: 0.1, separatorsStyle: 'solid',
  rows: 2, cols: 2, colWidths: [5, 5], rowHeights: [2, 2], ...o,
});
const barcode = (o: Record<string, unknown> = {}) => ({
  kind: 'barcode', uuid: U(6), text: 'CC', layer: 'F.SilkS', locked: false, x: 0, y: 0, width: 5, height: 5, textSize: 1, angle: 0,
  knockout: false, margin: 0.5, showText: false, errorCorrection: 'M', ...o,
});
const fpShape = (o: Record<string, unknown> = {}) => ({ kind: 'shape', uuid: U(7), layer: 'F.SilkS', shape: 'segment', points: [[0, 0], [1, 0]], width: 0.12, style: 'solid', filled: false, locked: false, ...o });
const image = (o: Record<string, unknown> = {}) => ({ kind: 'image', uuid: U(8), x: 0, y: 0, scale: 1, layer: 'User.1', png: PNG, ...o });

const GOOD: Record<string, () => Record<string, unknown>> = { pad, field, text, textbox, table, barcode, shape: fpShape, image };
/** One value per key of the wrong type, and one past a bound where the key has one. */
const WRONG_TYPE: Record<string, unknown> = {};
const PAST_BOUND: Record<string, unknown> = {
  x: 50_001, y: -50_001, angle: 361, thermalAngle: -400, dieLength: 1001, dieDelay: 2001, pasteRatio: 1.5, clearance: 1001,
  thickness: 1001, size: [0, 1], width: 1001, height: -1, textSize: 1001, margin: -0.1, borderWidth: -1, separatorsWidth: 1001,
  rows: 65, cols: 0, scale: 0, number: 'x'.repeat(1025), font: 'x'.repeat(1025), text: 'x'.repeat(8193),
  colWidths: [], rowHeights: [], points: [[0, 0]], layers: Array.from({ length: 257 }, (_, i) => `User.${i}`),
};
const typeOf = (v: unknown): unknown => (typeof v === 'boolean' ? 'yes' : typeof v === 'number' ? '1' : typeof v === 'string' ? 7 : v === null ? 'none' : Array.isArray(v) ? 'list' : 5);

describe('the kinds', () => {
  it('names the engine\'s eleven kinds in its order, and reads eight of them', () => {
    expect(ITEM_RECORD_KINDS).toEqual(['pad', 'field', 'text', 'textbox', 'shape', 'dimension', 'zone', 'table', 'barcode', 'image', 'point']);
    expect([...READABLE_KINDS].sort()).toEqual(Object.keys(GOOD).sort());
    for (const k of ['dimension', 'zone', 'point'] as const) expect(readItemRecord(k, { kind: k, uuid: U(9) })).toBeNull();
    expect(readItemRecord('group', { kind: 'group', uuid: U(9) })).toBeNull();
  });
});

describe('readItemRecord, one kind at a time', () => {
  for (const [kind, make] of Object.entries(GOOD)) {
    describe(kind, () => {
      it('reads the whole record and gives a copy', () => {
        const v = make();
        const r = readItemRecord(kind, v);
        expect(r).toEqual(v);
        expect(r).not.toBe(v);
      });
      it('refuses another kind or a bad uuid', () => {
        expect(readItemRecord(kind === 'pad' ? 'field' : 'pad', make())).toBeNull();
        expect(readItemRecord(kind, { ...make(), uuid: U(1).toUpperCase() })).toBeNull();
        expect(readItemRecord(kind, { ...make(), uuid: 'x' })).toBeNull();
      });
      it('refuses each key missing, one at a time, and one key too many', () => {
        const v = make();
        for (const k of Object.keys(v)) {
          if (kind === 'image' && k === 'png') continue;
          const { [k]: _gone, ...rest } = v;
          void _gone;
          expect(readItemRecord(kind, rest), `${kind} without ${k}`).toBeNull();
        }
        expect(readItemRecord(kind, { ...v, extra: 1 })).toBeNull();
      });
      it('refuses each key of another type, one at a time', () => {
        const v = make();
        for (const k of Object.keys(v)) {
          if (k === 'kind') continue;
          const wrong = WRONG_TYPE[k] ?? typeOf(v[k]);
          expect(readItemRecord(kind, { ...v, [k]: wrong }), `${kind} ${k} = ${JSON.stringify(wrong)}`).toBeNull();
        }
      });
      it('refuses each bounded key past its bound, one at a time', () => {
        const v = make();
        for (const k of Object.keys(v)) {
          if (!(k in PAST_BOUND)) continue;
          if (kind === 'field' && k === 'text') continue;
          expect(readItemRecord(kind, { ...v, [k]: PAST_BOUND[k] }), `${kind} ${k} past its bound`).toBeNull();
        }
      });
    });
  }

  it('a pad: its nested shape, primitives only on a custom shape, layer shapes only off normal, the sides whole', () => {
    expect(readItemRecord('pad', pad({ copper: shape({ roundRatio: 0.6 }) }))).toBeNull();
    expect(readItemRecord('pad', pad({ copper: shape({ chamferCorners: ['tl', 'tl'] }) }))).toBeNull();
    expect(readItemRecord('pad', pad({ copper: shape({ anchor: 'oval' }) }))).toBeNull();
    const prims = [
      { shape: 'line', points: [[0, 0], [1, 0]], width: 0.1, filled: false },
      { shape: 'arc', points: [[0, 0], [1, 1], [2, 0]], width: 0.1, filled: false },
      { shape: 'polygon', points: [[0, 0], [1, 0], [1, 1]], width: 0, filled: true },
    ];
    expect(readItemRecord('pad', pad({ copper: shape({ shape: 'custom', primitives: prims }) }))).not.toBeNull();
    expect(readItemRecord('pad', pad({ copper: shape({ primitives: prims }) }))).toBeNull();
    expect(readItemRecord('pad', pad({ copper: shape({ shape: 'custom', primitives: [{ ...prims[1], points: [[0, 0], [1, 1]] }] }) }))).toBeNull();
    expect(readItemRecord('pad', pad({ copper: shape({ shape: 'custom', primitives: Array.from({ length: 513 }, () => prims[0]) }) }))).toBeNull();
    expect(readItemRecord('pad', pad({ type: 'th', padstack: 'front_inner_back', layerShapes: [{ layer: 'In1.Cu', copper: shape() }] }))).not.toBeNull();
    expect(readItemRecord('pad', pad({ layerShapes: [{ layer: 'In1.Cu', copper: shape() }] }))).toBeNull();
    expect(readItemRecord('pad', pad({ padstack: 'custom', layerShapes: [{ layer: 'F.Cu', copper: shape() }] }))).toBeNull();
    expect(readItemRecord('pad', pad({ drill: { shape: 'oval', size: [0.8, 1.2] } }))).not.toBeNull();
    expect(readItemRecord('pad', pad({ drill: { shape: 'square', size: [0.8, 0.8] } }))).toBeNull();
    expect(readItemRecord('pad', pad({ backdrill: { front: { size: 0.5, end: 'In2.Cu' }, back: null } }))).not.toBeNull();
    expect(readItemRecord('pad', pad({ backdrill: { front: null } }))).toBeNull();
    expect(readItemRecord('pad', pad({ postMachining: { front: { mode: 'countersink', size: 1, depth: 0, angle: 200 }, back: { mode: 'none', size: 0, depth: 0, angle: 0 } } }))).toBeNull();
    expect(readItemRecord('pad', pad({ teardrop: { enabled: true } }))).toBeNull();
    expect(readItemRecord('pad', pad({ thermalSpokeWidth: 0.5, thermalGap: 0.5, zoneConnection: 'thermal' }))).not.toBeNull();
  });

  it('a field carries visible and keepUpright and a name; a text keepUpright inside a footprint or locked outside one, and no name', () => {
    expect(readItemRecord('field', field({ name: '' }))).toBeNull();
    const { keepUpright: _k, ...outside } = text({ text: 'two\nlines', locked: true });
    void _k;
    expect(readItemRecord('text', outside)).not.toBeNull();
    expect(readItemRecord('text', text({ text: 'two\nlines' }))).toBeNull();
    expect(readItemRecord('text', text({ locked: false }))).toBeNull();
    expect(readItemRecord('text', text({ name: 'X' }))).toBeNull();
    expect(readItemRecord('text', text({ visible: true }))).toBeNull();
  });

  it('a text box reads two corners or four, a table rows by cols, a shape the points its shape takes', () => {
    expect(readItemRecord('textbox', textbox({ points: [[0, 0], [5, 0], [5, 3], [0, 3]] }))).not.toBeNull();
    expect(readItemRecord('textbox', textbox({ points: [[0, 0], [5, 0], [5, 3]] }))).toBeNull();
    expect(readItemRecord('table', table({ cells: [['a', 'b'], ['c']] }))).toBeNull();
    expect(readItemRecord('table', table({ rows: 3 }))).toBeNull();
    expect(readItemRecord('table', table({ colWidths: [5] }))).toBeNull();
    expect(readItemRecord('table', table({ borderWidth: null }))).not.toBeNull();
    for (const [s, n] of [['segment', 2], ['rect', 2], ['circle', 2], ['arc', 3], ['bezier', 4], ['polygon', 3]] as const) {
      const pts = Array.from({ length: n }, (_, i) => [i, i * 2]);
      expect(readItemRecord('shape', fpShape({ shape: s, points: pts })), s).not.toBeNull();
      expect(readItemRecord('shape', fpShape({ shape: s, points: pts.slice(1) })), `${s} short`).toBeNull();
    }
  });

  it('a picture carries its png while it is at most 64 KiB, else its size in bytes', () => {
    expect(readItemRecord('image', image({ bytes: base64Bytes(PNG) }))).not.toBeNull();
    expect(readItemRecord('image', image({ bytes: 1 }))).toBeNull();
    const { png: _p, ...big } = image();
    void _p;
    expect(readItemRecord('image', { ...big, bytes: 70_000 })).not.toBeNull();
    expect(readItemRecord('image', { ...big, bytes: 1000 })).toBeNull();
    expect(readItemRecord('image', big)).toBeNull();
    expect(readItemRecord('image', image({ png: 'AAAA' }))).toBeNull();
    expect(readItemRecord('image', image({ png: `${PNG}!` }))).toBeNull();
  });

  it('a barcode has no symbology key (the engine writes it under kind)', () => {
    expect(readItemRecord('barcode', barcode({ code: 'qr' }))).toBeNull();
    expect(readItemRecord('barcode', barcode({ errorCorrection: 'X' }))).toBeNull();
  });
});

describe('readItemSet', () => {
  it('takes any non empty subset of a kind\'s keys, each checked; never kind, uuid, an unknown key or an empty text', () => {
    expect(readItemSet('pad', { x: 1 })).toEqual({ x: 1 });
    expect(readItemSet('pad', { copper: { size: [1, 2] } })).toEqual({ copper: { size: [1, 2] } });
    expect(readItemSet('pad', { teardrop: { enabled: true } })).toEqual({ teardrop: { enabled: true } });
    expect(readItemSet('pad', { layerShapes: [{ layer: 'B.Cu', copper: { shape: 'rect' } }] })).not.toBeNull();
    expect(readItemSet('pad', { postMachining: { front: { mode: 'counterbore', size: 1, depth: 0.5, angle: 0 } } })).not.toBeNull();
    expect(readItemSet('pad', { postMachining: { front: { mode: 'counterbore' } } })).toBeNull();
    expect(readItemSet('pad', { postMachining: {} })).toBeNull();
    expect(readItemSet('pad', {})).toBeNull();
    expect(readItemSet('pad', { kind: 'pad' })).toBeNull();
    expect(readItemSet('pad', { uuid: U(1) })).toBeNull();
    expect(readItemSet('pad', { nope: 1 })).toBeNull();
    expect(readItemSet('pad', { x: '1' })).toBeNull();
    expect(readItemSet('pad', { x: 60_000 })).toBeNull();
    expect(readItemSet('pad', { copper: { size: [1] } })).toBeNull();
    expect(readItemSet('field', { text: '' })).toBeNull();
    expect(readItemSet('text', { text: 'two\nlines' })).not.toBeNull();
    expect(readItemSet('table', { cells: [['a']], rows: 1 })).not.toBeNull();
    expect(readItemSet('shape', { shape: 'arc', points: [[0, 0], [1, 1]] })).toBeNull();
    expect(readItemSet('image', { png: PNG })).toBeNull();
    expect(readItemSet('dimension', { x: 1 })).toBeNull();
    expect(readItemSet('zone', { x: 1 })).toBeNull();
    expect(readItemSet('point', { x: 1 })).toBeNull();
    expect(itemSetKeys('point')).toEqual([]);
    expect(itemSetKeys('barcode')).not.toContain('kind');
  });

  it('a key one of the items lacks does not fit them, and a shape\'s new points must fit its shape', () => {
    const inside = readItemRecord('text', text()) as ItemRecord;
    const { keepUpright: _k, ...o } = text({ uuid: U(9), locked: false });
    void _k;
    const outside = readItemRecord('text', o) as ItemRecord;
    expect(itemSetMisfit({ keepUpright: true }, [inside])).toBeNull();
    expect(itemSetMisfit({ keepUpright: true }, [inside, outside])).toBe('keepUpright does not fit a text');
    const seg = readItemRecord('shape', fpShape()) as ItemRecord;
    expect(itemSetMisfit({ points: [[0, 0], [1, 1], [2, 2]] }, [seg])).toBe('a segment takes another count of points');
    expect(itemSetMisfit({ points: [[0, 0], [2, 2]] }, [seg])).toBeNull();
  });
});

describe('readNewItem', () => {
  it('reads a new item of each kind with the keys it needs and refuses one missing', () => {
    const cases: Array<[ItemRecordKind, Record<string, unknown>]> = [
      ['pad', { number: '9' }],
      ['field', { name: 'MPN', layer: 'F.Fab', text: '' }],
      ['text', { text: 'T', layer: 'F.SilkS', x: 1, y: 1 }],
      ['textbox', { text: 'B', layer: 'F.SilkS', points: [[0, 0], [5, 3]] }],
      ['table', { layer: 'F.SilkS', colWidths: [5, 5], rowHeights: [2, 2], cells: [['a', 'b'], ['c', 'd']] }],
      ['barcode', { layer: 'F.SilkS', text: 'CC' }],
      ['shape', { layer: 'F.SilkS', shape: 'circle', points: [[0, 0], [1, 0]] }],
      ['image', { layer: 'User.1', png: PNG }],
    ];
    for (const [kind, rest] of cases) {
      expect(readNewItem({ kind, uuid: U(20), ...rest }), kind).toEqual({ kind, uuid: U(20), ...rest });
      for (const k of Object.keys(rest)) {
        const { [k]: _g, ...less } = rest;
        void _g;
        const needed = NEW_ITEM_NEEDS[kind]?.includes(k) === true;
        expect(readNewItem({ kind, uuid: U(20), ...less }) == null, `${kind} without ${k}`).toBe(needed);
      }
    }
  });

  it('refuses a kind with no reader, a bad uuid, an empty text but a field\'s, an empty field name and cells of another size', () => {
    expect(readNewItem({ kind: 'point', uuid: U(20) })).toBeNull();
    expect(readNewItem({ kind: 'pad', uuid: 'X' })).toBeNull();
    expect(readNewItem({ kind: 'text', uuid: U(20), text: '', layer: 'F.SilkS' })).toBeNull();
    expect(readNewItem({ kind: 'field', uuid: U(20), name: '', layer: 'F.SilkS' })).toBeNull();
    expect(readNewItem({ kind: 'table', uuid: U(20), layer: 'F.SilkS', colWidths: [5], rowHeights: [2, 2], cells: [['a', 'b'], ['c', 'd']] })).toBeNull();
    expect(readNewItem({ kind: 'image', uuid: U(20), layer: 'User.1', png: 'AAAA' })).toBeNull();
  });
});

describe('showsItemSet', () => {
  it('reads every key of the set: nested by the keys given, lengths within 1 nm, angles by direction, layers and corners as sets', () => {
    const p = readItemRecord('pad', pad({ angle: -90, layers: ['F.Mask', 'F.Cu', 'F.Paste'], copper: shape({ chamferCorners: ['br', 'tl'] }) })) as ItemRecord;
    expect(showsItemSet({ x: -2.4750005 }, p)).toBe(true);
    expect(showsItemSet({ x: -2.48 }, p)).toBe(false);
    expect(showsItemSet({ angle: 270 }, p)).toBe(true);
    expect(showsItemSet({ layers: ['F.Cu', 'F.Paste', 'F.Mask'] }, p)).toBe(true);
    expect(showsItemSet({ layers: ['F.Cu'] }, p)).toBe(false);
    expect(showsItemSet({ copper: { size: [1.5, 0.6] } }, p)).toBe(true);
    expect(showsItemSet({ copper: { chamferCorners: ['tl', 'br'] } }, p)).toBe(true);
    expect(showsItemSet({ copper: { shape: 'rect' } }, p)).toBe(false);
  });
});
