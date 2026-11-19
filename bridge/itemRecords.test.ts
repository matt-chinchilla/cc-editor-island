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
  knockout: false, margin: [0.5, 0.5], showText: false, symbology: 'qr', errorCorrection: 'M', ...o,
});
const fpShape = (o: Record<string, unknown> = {}) => ({
  kind: 'shape', uuid: U(7), layer: 'F.SilkS', shape: 'segment', points: [[0, 0], [1, 0]], width: 0.12, style: 'solid', filled: false, fill: 'none',
  locked: false, hasSolderMask: false, solderMaskMargin: null, ...o,
});
const image = (o: Record<string, unknown> = {}) => ({ kind: 'image', uuid: U(8), x: 0, y: 0, scale: 1, layer: 'User.1', bytes: base64Bytes(PNG), png: PNG, ...o });
/** An aligned dimension as the engine writes one (cc_item_shape.h dimensionJson). */
const dimension = (o: Record<string, unknown> = {}) => ({
  kind: 'dimension', uuid: U(10), dimType: 'aligned', layer: 'F.Fab', start: [0, 0], end: [5, 0], height: 2, extensionHeight: 0.5,
  override: false, value: '', prefix: '', suffix: '', arrowDirection: 'outward', units: 'mm', unitsFormat: 'bare', precision: 2,
  suppressZeroes: false, textPosition: 'outside', textPos: [2.5, -2.5], keepAligned: true, angle: 0, size: [1, 1], thickness: 0.15,
  bold: false, italic: false, hJustify: 'center', mirrored: false, font: 'KiCad Font', lineThickness: 0.1, arrowLength: 1.27,
  extensionOffset: 0.5, locked: false, ...o,
});
/** A rule area (a keepout) as the engine writes one (zoneJson). */
const zone = (o: Record<string, unknown> = {}) => ({
  kind: 'zone', uuid: U(11), ruleArea: true, name: 'K', layers: ['F.Cu', 'B.Cu'], locked: false, points: [[0, 0], [2, 0], [2, 2]],
  borderStyle: 'edge', hatchPitch: 0.508, noTracks: true, noVias: true, noPads: false, noCopperPour: true, noFootprints: false,
  placement: false, placementSource: 'sheet', placementName: '', ...o,
});
const point = (o: Record<string, unknown> = {}) => ({ kind: 'point', uuid: U(12), x: 1, y: 2, layer: 'F.Fab', size: 1, locked: false, ...o });

const GOOD: Record<string, () => Record<string, unknown>> = { pad, field, text, textbox, table, barcode, shape: fpShape, image, dimension, zone, point };
/** One value per key of the wrong type, and one past a bound where the key has one. */
const WRONG_TYPE: Record<string, unknown> = {};
const PAST_BOUND: Record<string, unknown> = {
  x: 50_001, y: -50_001, angle: 361, thermalAngle: -400, dieLength: 1001, dieDelay: 2001, pasteRatio: 1.5, clearance: 1001,
  thickness: 1001, size: [0, 1], width: 1001, height: 50_001, textSize: 1001, margin: [-0.1, 0], borderWidth: -1, separatorsWidth: 1001,
  rows: 65, cols: 0, scale: 0, number: 'x'.repeat(1025), font: 'x'.repeat(1025), text: 'x'.repeat(8193),
  solderMaskMargin: 1001, precision: 10, start: [50_001, 0], end: [0, -50_001], textPos: [50_001, 0], lineThickness: 1001,
  arrowLength: -1, extensionOffset: 1001, extensionHeight: -1, value: 'x'.repeat(1025), name: 'x'.repeat(1025), hatchPitch: -1,
  colWidths: [], rowHeights: [], points: [[0, 0]], layers: Array.from({ length: 257 }, (_, i) => `User.${i}`),
};
const typeOf = (v: unknown): unknown => (typeof v === 'boolean' ? 'yes' : typeof v === 'number' ? '1' : typeof v === 'string' ? 7 : v === null ? 'none' : Array.isArray(v) ? 'list' : 5);

describe('the kinds', () => {
  it('names the engine\'s eleven kinds in its order, and reads every one of them', () => {
    expect(ITEM_RECORD_KINDS).toEqual(['pad', 'field', 'text', 'textbox', 'shape', 'dimension', 'zone', 'table', 'barcode', 'image', 'point']);
    expect([...READABLE_KINDS].sort()).toEqual(Object.keys(GOOD).sort());
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
      const own = s === 'rect' ? { cornerRadius: 0 } : {};
      expect(readItemRecord('shape', fpShape({ shape: s, points: pts, ...own })), s).not.toBeNull();
      expect(readItemRecord('shape', fpShape({ shape: s, points: pts.slice(1), ...own })), `${s} short`).toBeNull();
    }
  });

  it('a picture carries its PNG\'s own size in bytes, its png while that is at most 64 KiB, and a lock in the board frame', () => {
    expect(readItemRecord('image', image({ bytes: 1 }))).toBeNull();
    const { png: _p, ...big } = image();
    void _p;
    expect(readItemRecord('image', { ...big, bytes: 70_000 })).not.toBeNull();
    expect(readItemRecord('image', { ...big, bytes: 1000 })).toBeNull();
    expect(readItemRecord('image', { ...big, bytes: 0 })).not.toBeNull();
    const { bytes: _b, ...sizeless } = image();
    void _b;
    expect(readItemRecord('image', sizeless)).toBeNull();
    expect(readItemRecord('image', image({ locked: true }))).not.toBeNull();
    expect(readItemRecord('image', image({ locked: 'yes' }))).toBeNull();
    expect(readItemRecord('image', image({ png: 'AAAA' }))).toBeNull();
    expect(readItemRecord('image', image({ png: `${PNG}!` }))).toBeNull();
  });

  it('a barcode names its type symbology (never kind), its margin [x, y], its text up to 4,096 characters', () => {
    for (const s of ['code39', 'code128', 'datamatrix', 'qr', 'microqr']) expect(readItemRecord('barcode', barcode({ symbology: s })), s).not.toBeNull();
    expect(readItemRecord('barcode', barcode({ symbology: 'aztec' }))).toBeNull();
    expect(readItemRecord('barcode', barcode({ margin: 0.5 }))).toBeNull();
    expect(readItemRecord('barcode', barcode({ text: 'x'.repeat(4096) }))).not.toBeNull();
    expect(readItemRecord('barcode', barcode({ text: 'x'.repeat(4097) }))).toBeNull();
    expect(readItemRecord('barcode', barcode({ errorCorrection: 'X' }))).toBeNull();
    expect(readItemSet('barcode', { symbology: 'code128' })).toEqual({ symbology: 'code128' });
    expect(readItemSet('barcode', { kind: 'qr' })).toBeNull();
    expect(readNewItem({ kind: 'barcode', uuid: U(20), layer: 'F.SilkS', symbology: 'datamatrix' })).not.toBeNull();
  });

  it('a shape: its fill named and filled agreeing, a corner radius on a rectangle only, its solder mask margin null or a length', () => {
    expect(readItemRecord('shape', fpShape({ shape: 'circle', fill: 'hatch', filled: true }))).not.toBeNull();
    expect(readItemRecord('shape', fpShape({ fill: 'solid', filled: false }))).toBeNull();
    expect(readItemRecord('shape', fpShape({ fill: 'dots' }))).toBeNull();
    expect(readItemRecord('shape', fpShape({ shape: 'rect', cornerRadius: 0.2 }))).not.toBeNull();
    expect(readItemRecord('shape', fpShape({ shape: 'rect' }))).toBeNull();
    expect(readItemRecord('shape', fpShape({ cornerRadius: 0.2 }))).toBeNull();
    expect(readItemRecord('shape', fpShape({ solderMaskMargin: -0.05, hasSolderMask: true }))).not.toBeNull();
    expect(readItemSet('shape', { fill: 'solid', filled: false })).toBeNull();
    expect(readItemSet('shape', { fill: 'cross_hatch', filled: true })).not.toBeNull();
    expect(readNewItem({ kind: 'shape', uuid: U(20), layer: 'F.SilkS', shape: 'segment', points: [[0, 0], [1, 0]], cornerRadius: 0.1 })).toBeNull();
  });

  it('a dimension carries the keys of its type, and no other', () => {
    expect(readItemRecord('dimension', dimension({ dimType: 'orthogonal', orientation: 'vertical' }))).not.toBeNull();
    expect(readItemRecord('dimension', dimension({ dimType: 'orthogonal' }))).toBeNull();
    const { height: _h, extensionHeight: _e, ...base } = dimension();
    void _h; void _e;
    expect(readItemRecord('dimension', { ...base, dimType: 'center' })).not.toBeNull();
    expect(readItemRecord('dimension', { ...base, dimType: 'radial', leaderLength: 2 })).not.toBeNull();
    expect(readItemRecord('dimension', { ...base, dimType: 'leader', textBorder: 'roundrect' })).not.toBeNull();
    expect(readItemRecord('dimension', { ...base, dimType: 'leader' })).toBeNull();
    expect(readItemRecord('dimension', dimension({ dimType: 'center' }))).toBeNull();
    expect(readItemRecord('dimension', dimension({ height: -3 }))).not.toBeNull();
    expect(readItemRecord('dimension', dimension({ precision: 1.5 }))).toBeNull();
  });

  it('a zone is a rule area with its rule keys, or a zone on no copper layer without them', () => {
    const { noTracks: _a, noVias: _b, noPads: _c, noCopperPour: _d, noFootprints: _e, placement: _f, placementSource: _g, placementName: _i, ...plain } = zone({ ruleArea: false, layers: ['F.SilkS'] });
    void _a; void _b; void _c; void _d; void _e; void _f; void _g; void _i;
    expect(readItemRecord('zone', plain)).not.toBeNull();
    expect(readItemRecord('zone', { ...plain, ruleArea: true })).toBeNull();
    expect(readItemRecord('zone', zone({ ruleArea: false }))).toBeNull();
    expect(readItemRecord('zone', zone({ placementSource: 'net' }))).toBeNull();
    expect(readItemSet('zone', { hatchPitch: 0.05 })).toBeNull();
    expect(readItemSet('zone', { hatchPitch: 2 })).not.toBeNull();
    expect(readItemSet('zone', { layers: [] })).toBeNull();
    expect(readItemSet('zone', { points: [[0, 0], [1, 1]] })).toBeNull();
    expect(readNewItem({ kind: 'zone', uuid: U(20), layers: ['F.Cu'], points: [[0, 0], [1, 0], [1, 1]], ruleArea: false })).toBeNull();
  });

  it('a point has a size over 0', () => {
    expect(readItemRecord('point', point({ size: 0 }))).toBeNull();
    expect(readItemSet('point', { size: 0 })).toBeNull();
    expect(readItemSet('point', { x: 1, size: 2 })).toEqual({ x: 1, size: 2 });
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
    expect(readItemSet('point', { x: 1 })).toEqual({ x: 1 });
    expect(itemSetKeys('point')).toEqual(['x', 'y', 'layer', 'size', 'locked']);
    expect(readItemSet('image', { grayscale: true })).toEqual({ grayscale: true });
    expect(readItemSet('image', { grayscale: false })).toBeNull();
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

  it('a shape keeps its shape, a dimension its type, a zone its rule area; a text position wants a manual one; a picture takes grayscale', () => {
    const seg = readItemRecord('shape', fpShape()) as ItemRecord;
    expect(itemSetMisfit({ shape: 'arc', points: [[0, 0], [1, 1], [2, 0]] }, [seg])).toBe('a shape keeps its shape');
    expect(itemSetMisfit({ cornerRadius: 0.1 }, [seg])).toBe('cornerRadius does not fit a shape');
    const dim = readItemRecord('dimension', dimension()) as ItemRecord;
    expect(itemSetMisfit({ dimType: 'radial' }, [dim])).toBe('a dimension keeps its dimType');
    expect(itemSetMisfit({ leaderLength: 1 }, [dim])).toBe('leaderLength does not fit a dimension');
    expect(itemSetMisfit({ textPos: [1, 1] }, [dim])).toBe('textPos takes a manual text position');
    expect(itemSetMisfit({ textPos: [1, 1], textPosition: 'manual' }, [dim])).toBeNull();
    const area = readItemRecord('zone', zone()) as ItemRecord;
    expect(itemSetMisfit({ ruleArea: false }, [area])).toBe('a zone keeps its ruleArea');
    expect(itemSetMisfit({ ruleArea: true, noVias: false }, [area])).toBeNull();
    const pic = readItemRecord('image', image()) as ItemRecord;
    expect(itemSetMisfit({ grayscale: true }, [pic])).toBeNull();
    expect(itemSetMisfit({ locked: true }, [pic])).toBe('locked does not fit a image');
    expect(showsItemSet({ grayscale: true, scale: 1 }, pic)).toBe(true);
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
      ['dimension', { dimType: 'aligned', layer: 'F.Fab', start: [0, 0], end: [4, 0], height: 2 }],
      ['zone', { layers: ['F.Cu'], points: [[0, 0], [2, 0], [2, 2]], name: 'K' }],
      ['point', { layer: 'F.Fab', size: 1 }],
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

  it('refuses a kind it does not know, a bad uuid, an empty text but a field\'s, an empty field name, cells of another size, a dimension of no length', () => {
    expect(readNewItem({ kind: 'group', uuid: U(20), layer: 'F.Fab' })).toBeNull();
    expect(readNewItem({ kind: 'dimension', uuid: U(20), dimType: 'aligned', layer: 'F.Fab', start: [1, 1], end: [1, 1] })).toBeNull();
    expect(readNewItem({ kind: 'dimension', uuid: U(20), dimType: 'center', layer: 'F.Fab', start: [0, 0], end: [1, 1], height: 1 })).toBeNull();
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
