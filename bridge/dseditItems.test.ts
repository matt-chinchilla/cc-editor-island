// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The closed parsers and readers of ds-i2's ops (bridge/dseditItems.ts): every
// record read with exactly its kind's keys, every parser refusing one key, one
// type and one bound at a time, what a read back must show, and the picture
// ask's slot.
import { describe, expect, it } from 'vitest';
import {
  defaultsShow, installDsEditAsk, isPngBase64, itemShows, parseDsAppendArgs, parseDsDefaultsSetArgs, parseDsImageArmArgs,
  parseDsItemsAddArgs, parseDsItemsGetArgs, parseDsItemsRemoveArgs, parseDsItemsSetArgs, parseDsPreviewSetArgs, previewShows,
  readDsAppendAnswer, readDsDefaults, readDsEditAsk, readDsItem, readDsItems, readDsPreview, setFitsKind, toBase64,
  type DsEditAskWindow, type DsItem,
} from './dseditItems';

const U = (n: number) => `55555555-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P = (x = 1, y = 2, corner = 'rbcorner') => ({ x, y, corner });
const common = (kind: string, n: number) => ({ kind, uuid: U(n), name: '', comment: '', pages: 'all', start: P(), repeat: 1, step: [0, 0] });
const LINE = { ...common('line', 1), end: P(5, 6, 'ltcorner'), lineWidth: 0 };
const RECT = { ...common('rect', 2), end: P(9, 9), lineWidth: 0.3 };
const TEXT = {
  ...common('text', 3), text: '${TITLE}', labelStep: 1, font: '', bold: false, italic: true, color: '#0a4a2eff',
  hJustify: 'center', vJustify: 'top', rotation: 0, size: [2, 2], maxLength: 40, maxHeight: 5, lineWidth: 0.2,
};
const POLY = { ...common('polygon', 4), rotation: 15, lineWidth: 0.1, outlines: 1, points: 3 };
const BMP = { ...common('bitmap', 5), ppi: 300, width: 16, height: 16 };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const PNG64 = toBase64(PNG);
const without = (o: Record<string, unknown>, k: string) => { const c = { ...o }; delete c[k]; return c; };

describe('the item records, read closed', () => {
  it('reads one item of each kind with every key of its kind', () => {
    const all = [LINE, RECT, TEXT, POLY, BMP];
    expect(readDsItems(JSON.stringify({ items: all }))).toEqual(all);
  });

  it('refuses a missing key, an extra key, another kind\'s key and a key of the wrong type', () => {
    for (const item of [LINE, TEXT, POLY, BMP] as Record<string, unknown>[]) {
      for (const k of Object.keys(item)) expect(readDsItem(without(item, k)), `${item.kind} without ${k}`).toBeNull();
      expect(readDsItem({ ...item, extra: 1 })).toBeNull();
    }
    expect(readDsItem({ ...LINE, ppi: 300 })).toBeNull();
    expect(readDsItem({ ...LINE, kind: 'arc' })).toBeNull();
    expect(readDsItem({ ...LINE, uuid: U(1).replace('55555555', 'ABCDEF01') })).toBeNull();
    expect(readDsItem({ ...LINE, start: { x: 1, y: 2 } })).toBeNull();
    expect(readDsItem({ ...LINE, start: P(1, 2, 'middle') })).toBeNull();
    expect(readDsItem({ ...LINE, pages: 'page2only' })).toBeNull();
    expect(readDsItem({ ...LINE, step: [1] })).toBeNull();
    expect(readDsItem({ ...TEXT, color: '#0A4A2EFF' })).toBeNull();
    expect(readDsItem({ ...TEXT, hJustify: 'middle' })).toBeNull();
    expect(readDsItem({ ...TEXT, bold: 1 })).toBeNull();
    expect(readDsItem({ ...TEXT, text: 'x'.repeat(4097) })).toBeNull();
    expect(readDsItem({ ...LINE, name: 'x'.repeat(1025) })).toBeNull();
    expect(readDsItem({ ...BMP, width: 1.5 })).toBeNull();
    expect(readDsItems(JSON.stringify({ items: [LINE], more: 1 }))).toBeNull();
    expect(readDsItems('')).toBeNull();
    expect(readDsItems('{"items":[1]}')).toBeNull();
  });

  it('reads the defaults and the preview closed', () => {
    const d = { lineWidth: 0.15, textSize: [1.5, 1.5], textThickness: 0.15, margins: { left: 10, right: 10, top: 10, bottom: 10 } };
    expect(readDsDefaults(JSON.stringify(d))).toEqual(d);
    expect(readDsDefaults(JSON.stringify({ ...d, margins: { left: 1, right: 1, top: 1 } }))).toBeNull();
    expect(readDsDefaults(JSON.stringify(without(d, 'textThickness')))).toBeNull();
    const p = { paper: 'A4', portrait: false, width: 297, height: 210, title: '', date: '', revision: '', company: '', comments: Array(9).fill('') };
    expect(readDsPreview(JSON.stringify(p))).toEqual(p);
    expect(readDsPreview(JSON.stringify({ ...p, comments: Array(8).fill('') }))).toBeNull();
    expect(readDsPreview(JSON.stringify({ ...p, paper: 'A6' }))).toBeNull();
    expect(readDsPreview(JSON.stringify({ ...p, extra: 1 }))).toBeNull();
  });

  it('reads the append\'s answer: the added uuids, or the refusal with KiCad\'s line', () => {
    expect(readDsAppendAnswer(JSON.stringify({ error: '', message: '', added: [U(7), U(8)] }))).toEqual({ error: '', message: '', added: [U(7), U(8)] });
    expect(readDsAppendAnswer('{"error":"unreadable","message":"line 7"}')).toEqual({ error: 'unreadable', message: 'line 7', added: [] });
    expect(readDsAppendAnswer('{"error":"too_large"}')).toEqual({ error: 'too_large', message: '', added: [] });
    expect(readDsAppendAnswer(JSON.stringify({ error: '', added: [U(7), U(7)] }))).toBeNull();
    expect(readDsAppendAnswer('{"error":""}')).toBeNull();
    expect(readDsAppendAnswer('{"error":"held_edits"}')).toBeNull();
  });
});

describe('the ops\' args, read closed', () => {
  it('items.get: optional uuids and kinds, each bounded and none twice', () => {
    expect(parseDsItemsGetArgs(undefined)).toEqual({});
    expect(parseDsItemsGetArgs({})).toEqual({});
    expect(parseDsItemsGetArgs({ uuids: [U(1)], kinds: ['text', 'line'] })).toEqual({ uuids: [U(1)], kinds: ['text', 'line'] });
    for (const bad of [{ uuids: [] }, { uuids: [U(1), U(1)] }, { uuids: ['nope'] }, { kinds: [] }, { kinds: ['arc'] }, { kinds: ['line', 'line'] }, { x: 1 }, [], null]) {
      expect(parseDsItemsGetArgs(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(parseDsItemsGetArgs({ uuids: Array.from({ length: 4097 }, (_, i) => U(i)) })).toBeNull();
  });

  it('items.set: every key one some kind sets, each value in its bound, one at a time', () => {
    expect(parseDsItemsSetArgs({ uuids: [U(3)], set: { size: [3, 3] } })).toEqual({ uuids: [U(3)], set: { size: [3, 3] } });
    const good: Record<string, unknown> = {
      name: 'n', comment: 'c', pages: 'page1only', start: P(), end: P(), repeat: 3, step: [10, 0], lineWidth: 0.3,
      text: 'two\nlines', labelStep: 1, font: '', bold: true, italic: false, color: '', hJustify: 'right', vJustify: 'bottom',
      rotation: -90, size: [0, 0], maxLength: 0, maxHeight: 0, ppi: 600,
    };
    for (const [k, v] of Object.entries(good)) expect(parseDsItemsSetArgs({ uuids: [U(1)], set: { [k]: v } }), k).not.toBeNull();
    const bad: Record<string, unknown> = {
      name: 'a\tb', comment: 3, pages: 'odd', start: P(10_001), end: { x: 1, y: 1 }, repeat: 0, step: [0, 10_001], lineWidth: 10.5,
      text: 'x'.repeat(4097), labelStep: 1.5, font: 'a\nb', bold: 'yes', italic: null, color: '#fff', hJustify: 'middle', vJustify: 'left',
      rotation: 361, size: [101, 1], maxLength: -1, maxHeight: 10_001, ppi: 0, kind: 'line', uuid: U(1), outlines: 1, points: 3, width: 2, height: 2,
    };
    for (const [k, v] of Object.entries(bad)) expect(parseDsItemsSetArgs({ uuids: [U(1)], set: { [k]: v } }), k).toBeNull();
    expect(parseDsItemsSetArgs({ uuids: [U(1)], set: {} })).toBeNull();
    expect(parseDsItemsSetArgs({ uuids: [], set: { name: 'n' } })).toBeNull();
    expect(parseDsItemsSetArgs({ uuids: Array.from({ length: 513 }, (_, i) => U(i)), set: { name: 'n' } })).toBeNull();
    expect(parseDsItemsSetArgs({ uuids: [U(1)], set: { name: 'n' }, x: 1 })).toBeNull();
    expect(parseDsItemsSetArgs({ set: { name: 'n' } })).toBeNull();
  });

  it('a set fits a kind only with keys that kind has', () => {
    expect(setFitsKind({ end: P(), lineWidth: 1 }, 'rect')).toBe(true);
    expect(setFitsKind({ ppi: 300 }, 'line')).toBe(false);
    expect(setFitsKind({ rotation: 30 }, 'polygon')).toBe(true);
    expect(setFitsKind({ end: P() }, 'polygon')).toBe(false);
    expect(setFitsKind({ name: 'n', start: P() }, 'bitmap')).toBe(true);
  });

  it('items.add: whole lines, rects, texts and bitmaps with a png; never a polygon, a partial record or a uuid twice', () => {
    const bmp = { ...without(without(without(BMP, 'width'), 'height'), 'ppi'), ppi: 300, png: PNG64 };
    expect(parseDsItemsAddArgs({ items: [LINE, RECT, TEXT, bmp] })?.items).toHaveLength(4);
    expect(parseDsItemsAddArgs({ items: [POLY] })).toBeNull();
    expect(parseDsItemsAddArgs({ items: [BMP] })).toBeNull();
    expect(parseDsItemsAddArgs({ items: [{ ...bmp, png: 'aGVsbG8=' }] })).toBeNull();
    expect(parseDsItemsAddArgs({ items: [{ ...bmp, png: 'not base64!' }] })).toBeNull();
    for (const k of Object.keys(TEXT)) expect(parseDsItemsAddArgs({ items: [without(TEXT, k)] }), `text without ${k}`).toBeNull();
    expect(parseDsItemsAddArgs({ items: [{ ...LINE, lineWidth: 11 }] })).toBeNull();
    expect(parseDsItemsAddArgs({ items: [LINE, { ...RECT, uuid: LINE.uuid }] })).toBeNull();
    expect(parseDsItemsAddArgs({ items: [] })).toBeNull();
    expect(parseDsItemsAddArgs({ items: Array.from({ length: 65 }, (_, i) => ({ ...LINE, uuid: U(100 + i) })) })).toBeNull();
  });

  it('items.remove: 1 to 4,096 uuids, none twice', () => {
    expect(parseDsItemsRemoveArgs({ uuids: [U(1), U(2)] })).toEqual({ uuids: [U(1), U(2)] });
    for (const bad of [{ uuids: [] }, { uuids: [U(1), U(1)] }, { uuids: ['x'] }, { uuids: [U(1)], x: 1 }, {}]) expect(parseDsItemsRemoveArgs(bad)).toBeNull();
  });

  it('defaults.set: a non empty partial within KiCad\'s bounds, the margins whole', () => {
    expect(parseDsDefaultsSetArgs({ set: { lineWidth: 0.3 } })).toEqual({ set: { lineWidth: 0.3 } });
    expect(parseDsDefaultsSetArgs({ set: { margins: { left: 1, right: 2, top: 3, bottom: 4 } } })).not.toBeNull();
    for (const set of [{}, { lineWidth: 11 }, { textSize: [0, 1] }, { textSize: [1, 101] }, { textThickness: 6 }, { margins: { left: 1 } }, { margins: { left: 1, right: 1, top: 1, bottom: 1001 } }, { other: 1 }]) {
      expect(parseDsDefaultsSetArgs({ set }), JSON.stringify(set)).toBeNull();
    }
  });

  it('preview.set: KiCad\'s paper names, sizes together and bounded, nine comments', () => {
    expect(parseDsPreviewSetArgs({ set: { title: 'Checked', paper: 'A3' } })).toEqual({ set: { title: 'Checked', paper: 'A3' } });
    expect(parseDsPreviewSetArgs({ set: { paper: 'User', width: 300, height: 200 } })).not.toBeNull();
    for (const set of [{}, { paper: 'A6' }, { width: 300 }, { width: 20, height: 200 }, { width: 300, height: 3049 }, { portrait: 'yes' }, { title: 'a\nb' }, { comments: Array(8).fill('') }, { comments: Array(9).fill(1) }, { other: '' }]) {
      expect(parseDsPreviewSetArgs({ set }), JSON.stringify(set)).toBeNull();
    }
  });

  it('append: a non empty text with a UTF-8 spelling', () => {
    expect(parseDsAppendArgs({ text: '(kicad_wks)' })).toEqual({ text: '(kicad_wks)' });
    for (const bad of [{ text: '' }, { text: 'a\0b' }, { text: '\ud800' }, { text: 1 }, { text: 'x', name: 'y' }, {}]) expect(parseDsAppendArgs(bad)).toBeNull();
  });

  it('image.arm: PNG bytes or none, and a name', () => {
    expect(parseDsImageArmArgs({ bytes: PNG, name: 'logo.png' })?.name).toBe('logo.png');
    expect(parseDsImageArmArgs({ bytes: new Uint8Array(0), name: '' })).not.toBeNull();
    for (const bad of [{ bytes: new Uint8Array([1, 2, 3]), name: 'x' }, { bytes: PNG.buffer, name: 'x' }, { bytes: PNG64, name: 'x' }, { bytes: PNG, name: 'a\nb' }, { bytes: PNG }, { bytes: PNG, name: 'x', more: 1 }]) {
      expect(parseDsImageArmArgs(bad)).toBeNull();
    }
  });

  it('base64 round trips and PNG base64 is checked by its signature and size', () => {
    const big = new Uint8Array(70_000).map((_, i) => i % 251);
    expect(Uint8Array.from(atob(toBase64(big)), (c) => c.charCodeAt(0))).toEqual(big);
    expect(isPngBase64(PNG64)).toBe(true);
    expect(isPngBase64(toBase64(new Uint8Array(12)))).toBe(false);
    expect(isPngBase64('')).toBe(false);
  });
});

describe('what a read back shows', () => {
  it('compares each set key, numbers within a part in a million, the ppi within one, a named font not at all', () => {
    const t = readDsItem(TEXT) as DsItem;
    expect(itemShows(t, { size: [2, 2.0000000001], italic: true })).toBe(true);
    expect(itemShows(t, { size: [3, 2] })).toBe(false);
    expect(itemShows(t, { font: 'Some Face' })).toBe(true);
    expect(itemShows(t, { font: '' })).toBe(true);
    expect(itemShows({ ...t, font: 'KiCad Font' } as DsItem, { font: '' })).toBe(false);
    expect(itemShows(readDsItem(LINE) as DsItem, { end: P(5, 6, 'ltcorner') })).toBe(true);
    expect(itemShows(readDsItem(LINE) as DsItem, { end: P(5, 6, 'rbcorner') })).toBe(false);
    expect(itemShows(readDsItem({ ...BMP, ppi: 599 }) as DsItem, { ppi: 600 })).toBe(true);
    expect(itemShows(readDsItem({ ...BMP, ppi: 590 }) as DsItem, { ppi: 600 })).toBe(false);
    const d = { lineWidth: 0.3, textSize: [2, 2] as [number, number], textThickness: 0.15, margins: { left: 1, right: 2, top: 3, bottom: 4 } };
    expect(defaultsShow(d, { lineWidth: 0.3, margins: { left: 1, right: 2, top: 3, bottom: 4 } })).toBe(true);
    expect(defaultsShow(d, { lineWidth: 0.2 })).toBe(false);
    const p = { paper: 'User', portrait: false, width: 299.99, height: 200.02, title: 'Checked', date: '', revision: '', company: '', comments: Array(9).fill('') };
    expect(previewShows(p, { paper: 'User', width: 300, height: 200, title: 'Checked' })).toBe(true);
    expect(previewShows(p, { width: 301, height: 200 })).toBe(false);
  });
});

describe('the picture ask', () => {
  it('reads exactly { ask: "image", uuid: "", isNew: true }', () => {
    expect(readDsEditAsk('{"ask":"image","uuid":"","isNew":true}')).toEqual({ ask: 'image', uuid: '', isNew: true });
    for (const bad of ['{"ask":"pin","uuid":"","isNew":true}', '{"ask":"image","uuid":"x","isNew":true}', '{"ask":"image","uuid":"","isNew":false}', '{"ask":"image","uuid":""}', '{"ask":"image","uuid":"","isNew":true,"x":1}', 'nope', 3]) {
      expect(readDsEditAsk(bad)).toBeNull();
    }
  });

  it('answers true and sends once per admitted request; false when not admitted, for another shape, or when send throws; the stop clears its own slot', () => {
    const w: DsEditAskWindow = {};
    const sent: unknown[] = [];
    let admit = false;
    const stop = installDsEditAsk(w, { admit: () => admit, send: (a) => sent.push(a) });
    const ask = '{"ask":"image","uuid":"","isNew":true}';
    expect(w.kicadHostDsEdit?.onRequest?.(ask)).toBe(false);
    admit = true;
    expect(w.kicadHostDsEdit?.onRequest?.(ask)).toBe(true);
    expect(w.kicadHostDsEdit?.onRequest?.('{"ask":"x"}')).toBe(false);
    expect(sent).toEqual([{ ask: 'image', uuid: '', isNew: true }]);
    const t: DsEditAskWindow = {};
    installDsEditAsk(t, { admit: () => true, send: () => { throw new Error('no'); } });
    expect(t.kicadHostDsEdit?.onRequest?.(ask)).toBe(false);
    stop();
    expect(w.kicadHostDsEdit).toBeUndefined();
  });
});
