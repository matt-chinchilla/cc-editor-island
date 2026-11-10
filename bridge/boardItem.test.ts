// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { describe, expect, it } from 'vitest';
import {
  boardItemSetJson, MAX_GET_UUIDS, parseBoardItemGetArgs, parseBoardItemSetArgs, readBoardItems, setMisfit, showsBoardSet,
  type BoardItemSheet,
} from './boardItem';

const U = (n: number) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SHEET = '00000000-0000-0000-0000-00005c7b59b0';
const SYM = 'ca2704bd-cd2e-427d-8825-1d89e09f5ad7';

const footprint = (o: Record<string, unknown> = {}) => ({
  kind: 'footprint', uuid: U(1), locked: false, ref: 'U3', value: 'STM32F072', libId: 'Package_QFP:LQFP-48_7x7mm_P0.5mm',
  side: 'front', x: 120.5, y: 80.25, rotation: 90, inBom: true, inPos: true, dnp: false, boardOnly: false, variant: '',
  symbolPath: `/${SHEET}/${SYM}`, ...o,
});
const track = (o: Record<string, unknown> = {}) => ({ kind: 'track', uuid: U(2), locked: false, net: '/VCC', layer: 'F.Cu', width: 0.25, length: 4.125, ...o });
const via = (o: Record<string, unknown> = {}) => ({ kind: 'via', uuid: U(3), locked: false, net: 'GND', x: 10, y: 12, diameter: 0.6, drill: 0.3, viaType: 'through', top: 'F.Cu', bottom: 'B.Cu', ...o });
const zone = (o: Record<string, unknown> = {}) => ({
  kind: 'zone', uuid: U(4), locked: false, name: '', net: 'GND', layers: ['F.Cu', 'B.Cu'], priority: 0, clearance: 0.5, minWidth: 0.25,
  padConnection: 'thermal', thermalGap: 0.5, spokeWidth: 0.5, netChoices: ['', '/VCC', 'GND'], ...o,
});
const text = (o: Record<string, unknown> = {}) => ({
  kind: 'text', uuid: U(5), locked: false, text: 'Rev C\nglasgow', layer: 'F.SilkS', x: 5, y: 6, rotation: 0, height: 1, width: 1, thickness: 0.15,
  bold: false, italic: false, knockout: false, mirrored: false, hAlign: 'center', ...o,
});
const other = (o: Record<string, unknown> = {}) => ({ kind: 'other', uuid: U(6), type: 'pad', ...o });
const items = (...xs: unknown[]) => JSON.stringify({ items: xs });

describe('board.item.get args', () => {
  it('takes 1 to 512 lower case uuids and nothing else', () => {
    expect(parseBoardItemGetArgs({ uuids: [U(1)] })).toEqual({ uuids: [U(1)] });
    // A uuid asked twice is asked once: an answer never names a uuid twice.
    expect(parseBoardItemGetArgs({ uuids: [U(2), U(1), U(2)] })).toEqual({ uuids: [U(2), U(1)] });
    expect(parseBoardItemGetArgs({ uuids: Array.from({ length: MAX_GET_UUIDS }, (_, i) => U(i)) })?.uuids).toHaveLength(512);
    for (const bad of [undefined, {}, { uuids: [] }, { uuids: Array.from({ length: 513 }, (_, i) => U(i)) }, { uuids: [U(1).toUpperCase()] }, { uuids: 'x' }, { uuids: [U(1)], extra: 1 }]) {
      expect(parseBoardItemGetArgs(bad)).toBeNull();
    }
  });
});

describe('board items', () => {
  it('reads each kind with exactly its keys, in the order asked', () => {
    const got = readBoardItems(items(footprint(), track(), track({ kind: 'arc', uuid: U(7) }), via(), zone(), text(), other()));
    expect(got?.map((i) => i.kind)).toEqual(['footprint', 'track', 'arc', 'via', 'zone', 'text', 'other']);
    expect(got?.[0]).toEqual(footprint());
    expect(readBoardItems(items())).toEqual([]);
    for (const t of ['pad', 'shape', 'dimension', 'textbox', 'table', 'group', 'image', 'barcode', 'rulearea', 'marker', 'other']) {
      expect(readBoardItems(items(other({ type: t })))?.[0]).toEqual(other({ type: t }));
    }
  });

  it('refuses the whole answer for any item of another shape', () => {
    const drop = (o: Record<string, unknown>, k: string) => { const c = { ...o }; delete c[k]; return c; };
    const bad: unknown[] = [
      footprint({ extra: 1 }), drop(footprint(), 'variant'), footprint({ side: 'top' }), footprint({ rotation: -180 }), footprint({ rotation: 181 }),
      footprint({ x: 'far' }), footprint({ symbolPath: 'nope' }), footprint({ uuid: U(1).toUpperCase() }), footprint({ inBom: 1 }),
      track({ layer: 'F Cu' }), track({ width: -1 }), track({ net: 'n'.repeat(513) }), track({ kind: 'wire' }),
      via({ viaType: 'laser' }), via({ top: '' }),
      zone({ padConnection: 'spokes' }), zone({ priority: 1.5 }), zone({ layers: 'F.Cu' }), zone({ netChoices: Array.from({ length: 4097 }, (_, i) => `n${i}`) }),
      text({ hAlign: 'justify' }), text({ text: 't'.repeat(4097) }), text({ text: '' }), text({ mirrored: 'no' }),
      other({ type: 'widget' }), other({ extra: 1 }),
    ];
    for (const b of bad) expect(readBoardItems(items(b)), JSON.stringify(b).slice(0, 80)).toBeNull();
    // An answer that names one uuid twice is of another shape.
    expect(readBoardItems(items(footprint(), track({ uuid: U(1) })))).toBeNull();
    for (const raw of ['', '{', '[]', '{"items":{}}', '{"items":[],"x":1}', JSON.stringify({ items: Array.from({ length: 513 }, () => other()) })]) {
      expect(readBoardItems(raw)).toBeNull();
    }
    expect(readBoardItems(3)).toBeNull();
  });
});

describe('board.item.set args', () => {
  const set = (s: Record<string, unknown>) => parseBoardItemSetArgs({ uuid: U(1), set: s });
  it('takes one uuid and a set of exactly one key, in its type and bounds', () => {
    const good: Array<Record<string, unknown>> = [
      { x: -50_000 }, { y: 50_000 }, { rotation: -360 }, { rotation: 360 }, { locked: true }, { side: 'back' }, { inBom: false }, { inPos: true }, { dnp: true },
      { ref: 'R12' }, { value: '' }, { value: '10k' }, { width: 0.001 }, { width: 1000 }, { layer: 'In1.Cu' }, { diameter: 0.6 }, { drill: 0.3 },
      { name: 'GND pour' }, { net: '/VCC' }, { net: '' }, { priority: 0 }, { priority: 1_000_000 }, { clearance: 0.2 }, { minWidth: 0.2 },
      { padConnection: 'thtThermal' }, { thermalGap: 0.5 }, { spokeWidth: 0.4 }, { text: 'Rev C\n\tmain' }, { height: 1.2 }, { thickness: 0.15 },
      { bold: true }, { italic: false }, { knockout: true }, { hAlign: 'right' },
    ];
    for (const s of good) expect(set(s), JSON.stringify(s)).toEqual({ uuid: U(1), set: s });
  });

  it('refuses two keys, no key, an unknown key, a wrong type or a value out of bounds', () => {
    const bad: Array<Record<string, unknown>> = [
      {}, { x: 1, y: 2 }, { tint: 'red' }, { x: 50_001 }, { x: Number.NaN }, { x: '1' }, { rotation: 361 }, { locked: 'yes' }, { side: 'top' },
      { ref: '' }, { ref: 'R'.repeat(65) }, { ref: 'R\u00011' }, { value: 'v'.repeat(1025) }, { value: 'a\nb' }, { width: 0 }, { width: 1000.5 },
      { layer: '' }, { layer: 'F Cu' }, { priority: -1 }, { priority: 0.5 }, { priority: 1_000_001 }, { padConnection: 'spokes' },
      { text: 't'.repeat(4097) }, { text: '' }, { text: 'a\u0000b' }, { hAlign: 'justify' }, { net: 'n'.repeat(513) }, { name: 'a\u0007' },
    ];
    for (const s of bad) expect(set(s), JSON.stringify(s)).toBeNull();
    for (const a of [undefined, {}, { uuid: U(1) }, { uuid: 'x', set: { x: 1 } }, { uuid: U(1), set: { x: 1 }, extra: 1 }, { uuid: U(1), set: [] }]) {
      expect(parseBoardItemSetArgs(a)).toBeNull();
    }
  });

  it('hands the engine exactly the uuid and the set', () => {
    expect(JSON.parse(boardItemSetJson({ uuid: U(1), set: { width: 0.3 } }))).toEqual({ uuid: U(1), set: { width: 0.3 } });
  });
});

describe('a set against the item it changes', () => {
  const read = (x: unknown): BoardItemSheet => readBoardItems(items(x))![0];

  it('lets each kind take its own keys and no other', () => {
    const fits: Array<[unknown, string[]]> = [
      [footprint({ boardOnly: true }), ['x', 'y', 'rotation', 'locked', 'side', 'inBom', 'inPos', 'dnp', 'ref', 'value']],
      [track(), ['width', 'layer', 'locked']],
      [track({ kind: 'arc' }), ['width', 'layer', 'locked']],
      [via(), ['x', 'y', 'locked', 'diameter', 'drill']],
      [zone(), ['name', 'net', 'priority', 'clearance', 'minWidth', 'padConnection', 'thermalGap', 'spokeWidth', 'locked']],
      [text(), ['x', 'y', 'rotation', 'locked', 'layer', 'text', 'height', 'width', 'thickness', 'bold', 'italic', 'knockout', 'hAlign']],
    ];
    const sample: Record<string, unknown> = {
      x: 1, y: 1, rotation: 45, locked: true, side: 'back', inBom: false, inPos: false, dnp: true, ref: 'J9', value: 'X',
      width: 0.2, layer: 'B.Cu', diameter: 0.8, drill: 0.4, name: 'n', net: '/VCC', priority: 2, clearance: 0.3, minWidth: 0.2,
      padConnection: 'solid', thermalGap: 0.3, spokeWidth: 0.3, text: 't', height: 1, thickness: 0.2, bold: true, italic: true, knockout: true, hAlign: 'left',
    };
    for (const [item, keys] of fits) {
      const it = read(item);
      for (const k of Object.keys(sample)) {
        const why = setMisfit({ [k]: sample[k] } as never, it);
        if (keys.includes(k)) expect(why, `${it.kind} ${k}`).toBeNull();
        else expect(why, `${it.kind} ${k}`).toMatch(/^.+$/);
      }
    }
    expect(setMisfit({ x: 1 } as never, read(other()))).toBe('a pad does not change here');
  });

  it('keeps a linked footprint\'s designator and value on the schematic, a track on copper, a via\'s hole inside it and a zone\'s net on the board', () => {
    expect(setMisfit({ ref: 'U9' } as never, read(footprint()))).toBe('U3 takes its designator from the schematic');
    expect(setMisfit({ value: 'X' } as never, read(footprint()))).toBe('U3 takes its value from the schematic');
    expect(setMisfit({ layer: 'F.SilkS' } as never, read(track()))).toBe('a track runs on a copper layer');
    expect(setMisfit({ layer: 'F.SilkS' } as never, read(text()))).toBeNull();
    expect(setMisfit({ drill: 0.6 } as never, read(via()))).toBe('the hole must be smaller than the via');
    expect(setMisfit({ diameter: 0.3 } as never, read(via()))).toBe('the hole must be smaller than the via');
    expect(setMisfit({ net: '/MISSING' } as never, read(zone()))).toBe('the board has no net /MISSING');
    expect(setMisfit({ net: '' } as never, read(zone()))).toBeNull();
  });

  it('reads a set back within KiCad\'s rounding, a rotation by its angle', () => {
    const fp = read(footprint());
    expect(showsBoardSet({ x: 120.50004 } as never, fp)).toBe(true);
    expect(showsBoardSet({ x: 120.6 } as never, fp)).toBe(false);
    expect(showsBoardSet({ rotation: 90 } as never, fp)).toBe(true);
    expect(showsBoardSet({ rotation: -270 } as never, fp)).toBe(true);
    expect(showsBoardSet({ rotation: 450 - 360 } as never, fp)).toBe(true);
    expect(showsBoardSet({ rotation: 0 } as never, fp)).toBe(false);
    expect(showsBoardSet({ rotation: -180 } as never, read(footprint({ rotation: 180 })))).toBe(true);
    expect(showsBoardSet({ side: 'front' } as never, fp)).toBe(true);
    expect(showsBoardSet({ dnp: true } as never, fp)).toBe(false);
    expect(showsBoardSet({ padConnection: 'thermal' } as never, read(zone()))).toBe(true);
    expect(showsBoardSet({ text: 'Rev C\nglasgow' } as never, read(text()))).toBe(true);
  });
});
