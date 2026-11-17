// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { describe, expect, it } from 'vitest';
import {
  DOC_MAX_BYTES, EDITABLE_KEYS, itemSetMisfit, newItemKeys, parseItemsAddArgs, parseItemsGetArgs, parseItemSet, parseItemsRemoveArgs,
  parseItemsSetArgs, parseMarkSavedArgs, parseNewArgs, parseOpenArgs, parseShowArgs, parseSymbolSetArgs, pointsFit, readFindings, readItem,
  readItems, readSelection, readState, readSvgDone, readSymbolProps, readTaken, showsItemSet, showsSymbolSet, type SymItem,
} from './symedit';

const U1 = '11111111-0000-4000-8000-000000000001';
const U2 = '11111111-0000-4000-8000-000000000002';
const DOC = '(kicad_symbol_lib (version 20251024) (generator "kicad_symbol_editor") (symbol "OPAMP2"))';
const without = (o: Record<string, unknown>, k: string) => { const c = { ...o }; delete c[k]; return c; };
const STROKE = { width: 0.254, style: 'default', color: '' };
const FILL = { type: 'background', color: '' };

const pin = (o: Record<string, unknown> = {}) => ({
  kind: 'pin', uuid: U1, unit: 1, bodyStyle: 1, number: '1', name: 'IN+', type: 'input', shape: 'line', x: -7.62, y: 2.54,
  orientation: 'right', length: 2.54, nameSize: 1.27, numberSize: 1.27, visible: true, alternates: [], ...o,
});
const field = (o: Record<string, unknown> = {}) => ({
  kind: 'field', uuid: U2, unit: 0, bodyStyle: 0, name: 'Reference', text: 'U', x: 0, y: 5.08, angle: 0, size: 1.27, bold: false, italic: false,
  hJustify: 'left', vJustify: 'center', visible: true, showName: false, ...o,
});
const textbox = (o: Record<string, unknown> = {}) => ({
  kind: 'textbox', uuid: U2, unit: 1, bodyStyle: 1, text: 'note', x: 0, y: 0, angle: 0, size: 1.27, bold: false, italic: false, hJustify: 'left',
  vJustify: 'top', visible: true, x2: 5, y2: -3, stroke: STROKE, fill: FILL, margins: [0.5, 0.5, 0.5, 0.5], ...o,
});
const shape = (o: Record<string, unknown> = {}) => ({ kind: 'shape', uuid: U2, unit: 1, bodyStyle: 1, shape: 'rectangle', points: [[-5, 5], [5, -5]], stroke: STROKE, fill: FILL, ...o });
const state = (o: Record<string, unknown> = {}) => ({
  token: 'tabc', open: true, name: 'OPAMP2', lib: 'board_parts', mode: 'library', modified: false, depth: 0, unit: 1, unitCount: 3,
  bodyStyle: 1, bodyStyles: { mode: 'one', names: [] }, parent: '', syncedPins: true, ...o,
});
const props = (o: Record<string, unknown> = {}) => ({
  name: 'OPAMP2', refPrefix: 'U', value: 'OPAMP2', footprint: '', datasheet: '~', description: 'Dual op amp', keywords: 'amp', fpFilters: ['SOIC*'],
  fields: [{ name: 'Reference', value: 'U', visible: true, kind: 'reference' }, { name: 'MPN', value: 'X1', visible: false, kind: 'user' }],
  unitCount: 3, unitsInterchangeable: false, unitNames: { 1: 'A' }, bodyStyles: { mode: 'one', names: [] }, power: 'none', pinNameOffset: 0.508,
  showPinNames: true, showPinNumbers: true, pinNamesInside: true, inBom: true, onBoard: true, inSim: true, inPosFiles: true,
  jumpers: { duplicateNumbersAreJumpers: false, groups: [] }, parent: '', ...o,
});

describe('symedit.open and symedit.new args', () => {
  const OPEN = { text: DOC, name: 'OPAMP2', lib: 'board_parts', mode: 'library', discard: false };
  it('takes the open, unit and body style defaulting to 1', () => {
    expect(parseOpenArgs(OPEN)).toEqual({ ...OPEN, unit: 1, bodyStyle: 1 });
    expect(parseOpenArgs({ ...OPEN, mode: 'placed', unit: 2, bodyStyle: 2 })).toEqual({ ...OPEN, mode: 'placed', unit: 2, bodyStyle: 2 });
  });
  it('refuses one key, type or bound at a time', () => {
    for (const k of ['text', 'name', 'lib', 'mode', 'discard']) expect(parseOpenArgs(without(OPEN, k)), k).toBeNull();
    const bad: Array<Record<string, unknown>> = [
      { extra: 1 }, { token: 't' }, { text: '' }, { text: 1 }, { text: 'x'.repeat(DOC_MAX_BYTES + 1) }, { text: 'é'.repeat(DOC_MAX_BYTES / 2 + 1) },
      { name: '' }, { name: 'a\nb' }, { name: 'x'.repeat(1025) }, { lib: '' }, { lib: 'a\tb' }, { mode: 'new' }, { mode: 'LIBRARY' },
      { unit: 0 }, { unit: 703 }, { unit: 1.5 }, { unit: '1' }, { bodyStyle: 0 }, { bodyStyle: 65 }, { discard: 'no' },
    ];
    for (const b of bad) expect(parseOpenArgs({ ...OPEN, ...b }), JSON.stringify(b).slice(0, 60)).toBeNull();
    expect(parseOpenArgs(null)).toBeNull();
    expect(parseOpenArgs([OPEN])).toBeNull();
  });

  const NEW = {
    name: 'NEW1', lib: 'board_parts', parentText: '', parent: '', refPrefix: 'U', unitCount: 1, unitsInterchangeable: false, bodyStyles: 'one',
    power: 'none', pinNameOffset: 0.508, showPinNames: true, showPinNumbers: true, pinNamesInside: true, inBom: true, onBoard: true, inSim: true,
    keepParentFields: false, discard: false,
  };
  it('takes the new symbol\'s eighteen keys, a parent only with its text', () => {
    expect(parseNewArgs(NEW)).toEqual(NEW);
    expect(parseNewArgs({ ...NEW, parent: 'OPAMP2', parentText: DOC })).toMatchObject({ parent: 'OPAMP2' });
    expect(parseNewArgs({ ...NEW, parent: 'OPAMP2' })).toBeNull();
    expect(parseNewArgs({ ...NEW, parentText: DOC })).toBeNull();
  });
  it('refuses every missing key, an extra one, and each bound', () => {
    for (const k of Object.keys(NEW)) expect(parseNewArgs(without(NEW, k)), k).toBeNull();
    const bad: Array<Record<string, unknown>> = [
      { token: 't' }, { name: '' }, { lib: '' }, { refPrefix: 'a\u0001' }, { unitCount: 0 }, { unitCount: 703 }, { bodyStyles: 'named' },
      { power: 'yes' }, { pinNameOffset: -1 }, { pinNameOffset: 51 }, { inBom: 1 }, { keepParentFields: null }, { discard: 'false' },
    ];
    for (const b of bad) expect(parseNewArgs({ ...NEW, ...b }), JSON.stringify(b)).toBeNull();
  });
});

describe('the small args', () => {
  it('markSaved takes exactly a printable token of 1 to 64 characters', () => {
    expect(parseMarkSavedArgs({ token: 'tabc' })).toEqual({ token: 'tabc' });
    for (const bad of [{}, { token: '' }, { token: 'x'.repeat(65) }, { token: 'é' }, { token: 'a\nb' }, { token: 't', x: 1 }]) expect(parseMarkSavedArgs(bad)).toBeNull();
  });
  it('items.get takes a unit and a body style (0 for all), uuids and kinds each optional', () => {
    expect(parseItemsGetArgs({ unit: 0, bodyStyle: 0 })).toEqual({ unit: 0, bodyStyle: 0 });
    expect(parseItemsGetArgs({ unit: 1, bodyStyle: 2, uuids: [U1], kinds: ['pin', 'field'] })).toEqual({ unit: 1, bodyStyle: 2, uuids: [U1], kinds: ['pin', 'field'] });
    for (const bad of [{}, { unit: 0 }, { bodyStyle: 0 }, { unit: -1, bodyStyle: 0 }, { unit: 0, bodyStyle: 0, uuids: [] }, { unit: 0, bodyStyle: 0, uuids: [U1, U1] },
      { unit: 0, bodyStyle: 0, uuids: ['AAAAAAAA-0000-4000-8000-000000000001'] }, { unit: 0, bodyStyle: 0, kinds: [] }, { unit: 0, bodyStyle: 0, kinds: ['pad'] },
      { unit: 0, bodyStyle: 0, kinds: ['pin', 'pin'] }, { unit: 0, bodyStyle: 0, x: 1 }]) expect(parseItemsGetArgs(bad), JSON.stringify(bad)).toBeNull();
  });
  it('items.remove and show take exactly their keys', () => {
    expect(parseItemsRemoveArgs({ uuids: [U1, U2] })).toEqual({ uuids: [U1, U2] });
    for (const bad of [{ uuids: [] }, { uuids: [U1, U1] }, { uuids: ['x'] }, { uuids: [U1], x: 1 }]) expect(parseItemsRemoveArgs(bad)).toBeNull();
    expect(parseShowArgs({ unit: 2, bodyStyle: 1 })).toEqual({ unit: 2, bodyStyle: 1 });
    for (const bad of [{ unit: 0, bodyStyle: 1 }, { unit: 1, bodyStyle: 0 }, { unit: 1 }, { unit: 1, bodyStyle: 1, x: 1 }, { unit: 1.5, bodyStyle: 1 }]) expect(parseShowArgs(bad)).toBeNull();
  });
});

describe('items.set and items.add', () => {
  it('takes a set of keys some kind takes, each in its bounds', () => {
    expect(parseItemsSetArgs({ uuids: [U1], set: { number: '3', type: 'power_in', alternates: [{ name: 'SDA', type: 'bidirectional', shape: 'line' }] } })).not.toBeNull();
    expect(parseItemsSetArgs({ uuids: [U1, U2], set: { stroke: { width: 0.2, style: 'dash', color: '#ff0000ff' } } })).not.toBeNull();
    const bad: Array<Record<string, unknown>> = [
      {}, { kind: 'pin' }, { uuid: U1 }, { pad: 1 }, { number: 3 }, { type: 'pwr' }, { shape: 'square' }, { orientation: 'north' }, { x: 50001 }, { x: Infinity },
      { length: -1 }, { size: 1001 }, { angle: 45 }, { hJustify: 'middle' }, { stroke: { width: 0.2, style: 'dash' } }, { stroke: { width: 101, style: 'dash', color: '' } },
      { stroke: { width: 1, style: 'dash', color: '#FF0000FF' } }, { fill: { type: 'solid', color: '' } }, { margins: [1, 1, 1] }, { margins: [1, 1, 1, -1] },
      { points: [[0, 0]] }, { points: [[0, 0], [1]] }, { alternates: [{ name: 'A', type: 'input', shape: 'line' }, { name: 'A', type: 'input', shape: 'line' }] },
      { alternates: [{ name: '', type: 'input', shape: 'line' }] }, { text: 'a\u0001' }, { name: 'a\nb' }, { unit: 703 },
    ];
    for (const set of bad) expect(parseItemSet(set), JSON.stringify(set)).toBeNull();
    expect(parseItemSet({ text: 'two\nlines' })).not.toBeNull();
    expect(parseItemsSetArgs({ uuids: [], set: { x: 1 } })).toBeNull();
    expect(parseItemsSetArgs({ uuids: [U1], set: { x: 1 }, extra: 1 })).toBeNull();
  });

  it('a new item carries its kind\'s every key and no other, a field as a user field, a text with no name', () => {
    const full = (o: Record<string, unknown>) => ({ ...o });
    expect(parseItemsAddArgs({ items: [full(pin()), full(shape())] })?.items).toHaveLength(2);
    expect(parseItemsAddArgs({ items: [field({ name: 'MPN', unit: 0, bodyStyle: 0 })] })).not.toBeNull();
    expect(parseItemsAddArgs({ items: [textbox()] })).not.toBeNull();
    const text = { ...field({ kind: 'text', name: '', showName: false, unit: 1, bodyStyle: 1 }) };
    expect(parseItemsAddArgs({ items: [text] })).not.toBeNull();
    for (const k of newItemKeys('pin')) expect(parseItemsAddArgs({ items: [without(pin(), k)] }), k).toBeNull();
    const bad: Array<Record<string, unknown>> = [
      pin({ extra: 1 }), pin({ uuid: 'X' }), shape({ shape: 'square' }), shape({ points: [[0, 0], [1, 1], [2, 2]] }), shape({ shape: 'arc' }),
      field({ name: 'MPN', unit: 1 }), field({ name: '' }), { ...text, name: 'x' }, { ...text, showName: true }, { kind: 'pad', uuid: U1 },
    ];
    for (const it of bad) expect(parseItemsAddArgs({ items: [it] }), JSON.stringify(it).slice(0, 80)).toBeNull();
    expect(parseItemsAddArgs({ items: [pin(), pin()] })).toBeNull();
    expect(parseItemsAddArgs({ items: [field({ name: 'MPN' }), field({ uuid: U1, name: 'mpn' })] })).toBeNull();
    expect(parseItemsAddArgs({ items: [] })).toBeNull();
    expect(parseItemsAddArgs({ items: Array.from({ length: 513 }, () => pin()) })).toBeNull();
  });

  it('the points each shape takes', () => {
    expect([pointsFit('rectangle', 2), pointsFit('circle', 2), pointsFit('arc', 3), pointsFit('bezier', 4), pointsFit('polyline', 5)]).toEqual([true, true, true, true, true]);
    expect([pointsFit('rectangle', 3), pointsFit('arc', 2), pointsFit('bezier', 3), pointsFit('polyline', 1)]).toEqual([false, false, false, false]);
  });

  it('names what the items refuse: another kind\'s key, a mandatory field\'s name, a rename over several fields, a point count', () => {
    const items = [readItem(pin()), readItem(field())] as SymItem[];
    expect(itemSetMisfit({ x: 1 }, items)).toBeNull();
    expect(itemSetMisfit({ number: '2' }, items)).toBe('number does not fit a field');
    expect(itemSetMisfit({ name: 'Ref' }, [items[1]])).toBe('Reference keeps its name');
    const user = readItem(field({ name: 'MPN' })) as SymItem;
    expect(itemSetMisfit({ name: 'Part' }, [user])).toBeNull();
    expect(itemSetMisfit({ name: 'Part' }, [user, { ...user, uuid: U1 }])).toBe('a field is renamed one at a time');
    expect(itemSetMisfit({ points: [[0, 0], [1, 1], [2, 2]] }, [readItem(shape()) as SymItem])).toBe('a rectangle takes another count of points');
    expect(EDITABLE_KEYS.shape).toEqual(['unit', 'bodyStyle', 'points', 'stroke', 'fill']);
  });
});

describe('symedit.symbol.set args', () => {
  it('takes every key of the record\'s set', () => {
    const set = {
      name: 'X', refPrefix: 'U', value: 'v', footprint: 'a:b', datasheet: '', description: 'd', keywords: 'k', fpFilters: ['SOIC*'],
      fields: [{ name: 'MPN', value: 'X' }], addField: { name: 'Mfr', value: 'TI', visible: false }, removeField: 'Old', unitCount: 2,
      unitsInterchangeable: true, unitNames: { 1: 'A', 2: 'B' }, bodyStyles: { mode: 'named', names: ['Normal', 'Alt'] }, power: 'local',
      pinNameOffset: 0.5, showPinNames: true, showPinNumbers: false, pinNamesInside: true, inBom: false, onBoard: true, inSim: false, inPosFiles: true,
      jumpers: { duplicateNumbersAreJumpers: true, groups: [['1', '2']] }, fromParent: { fields: 'all', resetEmpty: false, resetVisibility: true, resetEffects: false, resetPositions: false, removeExtra: false },
      flatten: true,
    };
    expect(parseSymbolSetArgs({ set })).toEqual({ set });
  });
  it('refuses one key, type or bound at a time, and a field changed twice', () => {
    const bad: Array<Record<string, unknown>> = [
      {}, { parent: 'x' }, { name: '' }, { refPrefix: 1 }, { fpFilters: [''] },
      { fields: [{ name: 'MPN' }] }, { fields: [{ name: 'MPN', value: 'a', x: 1 }] }, { addField: { name: 'A', value: 'b' } },
      { unitCount: 0 }, { unitNames: { 0: 'A' } }, { unitNames: { a: 'A' } }, { unitCount: 2, unitNames: { 3: 'C' } }, { bodyStyles: { mode: 'named', names: ['One'] } },
      { bodyStyles: { mode: 'one', names: ['x'] } }, { power: 'yes' }, { pinNameOffset: 51 }, { jumpers: {} }, { jumpers: { groups: [['']] } },
      { fromParent: { fields: [], resetEmpty: false, resetVisibility: false, resetEffects: false, resetPositions: false, removeExtra: false } },
      { fromParent: { fields: 'all' } }, { flatten: false }, { removeField: 'MPN', fields: [{ name: 'MPN', value: 'x' }] },
      { removeField: 'MPN', addField: { name: 'mpn', value: '', visible: true } }, { value: 'v', fields: [{ name: 'Value', value: 'w' }] },
    ];
    for (const set of bad) expect(parseSymbolSetArgs({ set }), JSON.stringify(set)).toBeNull();
    expect(parseSymbolSetArgs({ set: { name: 'x' }, extra: 1 })).toBeNull();
  });
});

describe('the engine\'s answers, read closed', () => {
  it('reads the state, and refuses one key or bound at a time', () => {
    expect(readState(JSON.stringify(state()))).toEqual(state());
    expect(readState(JSON.stringify(state({ token: '', open: false, mode: 'library' })))).not.toBeNull();
    expect(readState('')).toBeNull();
    for (const k of Object.keys(state())) expect(readState(JSON.stringify(without(state(), k))), k).toBeNull();
    for (const b of [{ mode: 'edit' }, { depth: -1 }, { unit: 0 }, { bodyStyles: { mode: 'one' } }, { x: 1 }]) expect(readState(JSON.stringify(state(b)))).toBeNull();
  });
  it('reads every item kind, and refuses a uuid twice or another shape', () => {
    const items = [pin({ alternates: [{ name: 'SCL', type: 'bidirectional', shape: 'line' }] }), field(), field({ kind: 'text', uuid: '22222222-0000-4000-8000-000000000003', name: '', showName: false }), textbox({ uuid: '22222222-0000-4000-8000-000000000001' }), shape({ uuid: '22222222-0000-4000-8000-000000000002', fill: { type: 'hatch', color: '' } })];
    expect(readItems(JSON.stringify({ items }))).toEqual(items);
    expect(readItems(JSON.stringify({ items: [pin(), pin()] }))).toBeNull();
    for (const bad of [pin({ type: 'x' }), pin({ x: 'a' }), field({ angle: 45 }), textbox({ margins: [1] }), shape({ shape: 'oval' }), { ...pin(), extra: 1 }]) {
      expect(readItems(JSON.stringify({ items: [bad] }))).toBeNull();
    }
  });
  it('reads the symbol, the taken text, the findings, the SVG record and the selection', () => {
    expect(readSymbolProps(JSON.stringify(props()))).toEqual(props());
    expect(readSymbolProps(JSON.stringify(props({ power: 'maybe' })))).toBeNull();
    expect(readSymbolProps(JSON.stringify(without(props(), 'jumpers')))).toBeNull();
    expect(readTaken(JSON.stringify({ name: 'OPAMP2', text: DOC, parent: '' }))).toEqual({ name: 'OPAMP2', text: DOC, parent: '' });
    expect(readTaken(JSON.stringify({ name: '', text: DOC, parent: '' }))).toBeNull();
    const finding = { code: 'duplicate_pin', severity: 'warning', pins: ['3'], unit: 1, bodyStyle: 1, x: 2.54, y: -5.08, uuids: [U1] };
    expect(readFindings(JSON.stringify({ grid: 0.635, findings: [finding, { ...finding, code: 'pin_meteor', x: null, y: null }] }))).toEqual({
      grid: 0.635, findings: [finding, { ...finding, code: 'other', x: null, y: null }],
    });
    expect(readFindings(JSON.stringify({ grid: 0.635, findings: [{ ...finding, x: null }] }))).toBeNull();
    expect(readFindings(JSON.stringify({ grid: 0.635, findings: [{ ...finding, severity: 'error' }] }))).toBeNull();
    const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
    expect(readSvgDone(enc({ error: '' }))).toEqual({ error: '' });
    expect(readSvgDone(enc({ error: 'boom' }))).toBeNull();
    expect(readSvgDone(null)).toBeNull();
    expect(readSelection(JSON.stringify({ uuids: [U1] }))).toEqual([U1]);
    expect(readSelection(JSON.stringify([U1]))).toBeNull();
  });
});

describe('the read backs', () => {
  it('an item shows a set within KiCad\'s rounding, a pin\'s alternates by name', () => {
    const p = readItem(pin({ x: 2.5401, alternates: [{ name: 'B', type: 'input', shape: 'line' }, { name: 'A', type: 'input', shape: 'line' }] })) as SymItem;
    expect(showsItemSet({ x: 2.54 }, p)).toBe(true);
    expect(showsItemSet({ x: 2.55 }, p)).toBe(false);
    expect(showsItemSet({ alternates: [{ name: 'A', type: 'input', shape: 'line' }, { name: 'B', type: 'input', shape: 'line' }] }, p)).toBe(true);
    const s = readItem(shape()) as SymItem;
    expect(showsItemSet({ stroke: { width: 0.254, style: 'default', color: '' } }, s)).toBe(true);
    expect(showsItemSet({ points: [[-5, 5], [5, -5.00004]] }, s)).toBe(true);
  });
  it('a symbol shows its set, a power symbol\'s value its name, an offset only while the names sit inside', () => {
    const p = readSymbolProps(JSON.stringify(props())) as NonNullable<ReturnType<typeof readSymbolProps>>;
    expect(showsSymbolSet({ fields: [{ name: 'MPN', value: 'X1' }], unitNames: { 1: 'A' } }, p)).toBe(true);
    expect(showsSymbolSet({ addField: { name: 'Mfr', value: 'TI', visible: false } }, p)).toBe(false);
    expect(showsSymbolSet({ removeField: 'MPN' }, p)).toBe(false);
    expect(showsSymbolSet({ pinNameOffset: 0.508 }, p)).toBe(true);
    expect(showsSymbolSet({ pinNameOffset: 1 }, { ...p, pinNamesInside: false })).toBe(true);
    expect(showsSymbolSet({ value: 'x' }, { ...p, power: 'global' })).toBe(true);
    expect(showsSymbolSet({ flatten: true }, { ...p, parent: 'LM2904' })).toBe(false);
    expect(showsSymbolSet({ jumpers: { groups: [['2', '1']] } }, { ...p, jumpers: { duplicateNumbersAreJumpers: false, groups: [['1', '2']] } })).toBe(true);
  });
});
