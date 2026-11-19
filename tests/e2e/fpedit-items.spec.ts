// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// island v0.2.3-cc25 over the local pair (PROTOCOL.md "The footprint editor's
// items"): fpedit.items.get, set, add and remove on the open footprint of an
// fpedit frame, through our engine's item exports (engine run 15), each
// change one undo step of KiCad's, Ctrl+Z through key.press restoring it.
// The fixtures are tests/fixtures/fpedit-small (written by hand) and its
// mark.png, the picture markPng() below writes.
//
// The first test needs no fpedit frame and runs on every engine: outside an
// fpedit frame every item op is unsupported. Every other test boots an
// fpedit frame and opens the SOIC, which needs engine run 15; on an engine
// without it the frame lists no fpedit cap and the test is skipped.
import { expect, test, type Page } from '@playwright/test';

interface Ev { type: string; phase?: string; caps?: string[]; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
type Item = Record<string, unknown> & { kind: string; uuid: string };

const SMALL = '/fixtures/fpedit-small';
const SOIC = 'SOIC-8_3.9x4.9mm_P1.27mm';
const FRAME_ONLY = 'unsupported: a footprint edits in an fpedit frame';
const OPS = ['fpedit.items.get', 'fpedit.items.set', 'fpedit.items.add', 'fpedit.items.remove'];
const UNDO = { key: 'z', code: 'KeyZ', ctrl: true };

/** The fixture picture: 64 by 64 RGB in two colors (a dark green and white, by quarters), stored uncompressed, so its bytes are this function's alone. */
function markPng(): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (b: number[]): number => (b.reduce((c, x) => crcTable[(c ^ x) & 0xff] ^ (c >>> 8), 0xffffffff) ^ 0xffffffff) >>> 0;
  const be32 = (n: number): number[] => [n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  const chunk = (type: string, data: number[]): number[] => {
    const td = [...type].map((c) => c.charCodeAt(0)).concat(data);
    return [...be32(data.length), ...td, ...be32(crc32(td))];
  };
  const raw: number[] = [];
  for (let y = 0; y < 64; y++) {
    raw.push(0);
    for (let x = 0; x < 64; x++) raw.push(...((x < 32) !== (y < 32) ? [0x0a, 0x4a, 0x2e] : [0xff, 0xff, 0xff]));
  }
  let a = 1;
  let b = 0;
  for (const x of raw) { a = (a + x) % 65521; b = (b + a) % 65521; }
  const len = raw.length;
  const z = [0x78, 0x01, 0x01, len & 0xff, len >>> 8, ~len & 0xff, (~len >>> 8) & 0xff, ...raw, ...be32(((b << 16) | a) >>> 0)];
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk('IHDR', [...be32(64), ...be32(64), 8, 2, 0, 0, 0]), ...chunk('IDAT', z), ...chunk('IEND', [])]);
}
const base64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const request = (page: Page, op: string, args?: unknown): Promise<Record<string, unknown>> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const);
const refusal = (page: Page, op: string, args?: unknown): Promise<string> =>
  request(page, op, args).then(() => 'ok', (err: Error) => err.message.split('\n')[0].replace(/^.*?page\.evaluate:\s*/, '').replace(/^Error:\s*/, ''));
const text = (page: Page, path: string): Promise<string> => page.evaluate(async (p) => (await fetch(p)).text(), path);
const bytesOf = (page: Page, path: string): Promise<number[]> => page.evaluate(async (p) => [...new Uint8Array(await (await fetch(p)).arrayBuffer())], path);
const uuid = (n: number): string => `cc000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function boot(page: Page, frame: string): Promise<string[]> {
  await page.goto(`/parent.html?frame=${frame}`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  expect((await events(page)).filter((e) => e.type === 'ev.state' && (e.phase === 'fatal' || e.phase === 'blocked'))).toEqual([]);
  return ((await events(page)).find((e) => e.type === 'ev.ready')?.caps ?? []).filter((c) => !/^kicad/.test(c));
}
/** Boots an fpedit frame and opens `file` of the fixture, or skips on an engine without the footprint editor. */
async function openFootprint(page: Page, file: string, name: string): Promise<void> {
  const caps = await boot(page, 'fpedit');
  test.skip(!caps.includes('fpedit'), 'the footprint editor needs engine run 15 (island cc25)');
  await request(page, 'fpedit.open', { text: await text(page, `${SMALL}/${file}`), name, lib: 'fpedit-small_parts', mode: 'library', discard: true });
}
const items = async (page: Page, args: Record<string, unknown> = {}): Promise<Item[]> => (await request(page, 'fpedit.items.get', args)).items as Item[];
const depth = async (page: Page): Promise<number> => (await request(page, 'fpedit.state')).depth as number;
/** One set, one undo step, and Ctrl+Z through key.press restores the item. */
async function setThenUndo(page: Page, it: Item, set: Record<string, unknown>): Promise<void> {
  const d0 = await depth(page);
  const after = (await request(page, 'fpedit.items.set', { uuids: [it.uuid], set })).items as Item[];
  expect(after, JSON.stringify(set)).toHaveLength(1);
  expect(await depth(page), `${it.kind} ${Object.keys(set).join(' ')} is one undo step`).toBe(d0 + 1);
  expect(await request(page, 'key.press', UNDO)).toEqual({});
  await expect.poll(() => depth(page), { timeout: 5_000 }).toBe(d0);
  expect((await items(page, { uuids: [it.uuid] }))[0], `${it.kind} restored after ${Object.keys(set).join(' ')}`).toEqual(it);
}

test('outside an fpedit frame every item op is unsupported; the fixture picture is markPng\'s (any engine)', async ({ page }) => {
  const caps = await boot(page, 'pcb');
  expect(caps).not.toContain('fpedit');
  for (const op of OPS) expect(await refusal(page, op, { uuids: [uuid(1)] }), op).toBe(FRAME_ONLY);
  expect(await bytesOf(page, `${SMALL}/mark.png`)).toEqual([...markPng()]);
});

test('get lists every item in KiCad\'s order with its kind and uuid, and filters by kinds, uuids and layers', async ({ page }) => {
  await openFootprint(page, `fpedit-small_parts.pretty/${SOIC}.kicad_mod`, SOIC);
  const all = await items(page);
  expect(all.length).toBeGreaterThan(8);
  expect(new Set(all.map((i) => i.uuid)).size).toBe(all.length);
  expect(all.slice(0, 2).map((i) => i.kind)).toEqual(['field', 'field']);
  const pads = await items(page, { kinds: ['pad'] });
  expect(pads.map((p) => p.number).sort()).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
  expect(pads.every((p) => p.type === 'smd' && p.drill === null && p.padstack === 'normal')).toBe(true);
  expect((await items(page, { uuids: [pads[0].uuid] })).map((i) => i.uuid)).toEqual([pads[0].uuid]);
  const silk = await items(page, { layers: ['F.SilkS'] });
  expect(silk.length).toBeGreaterThan(0);
  expect(silk.every((i) => i.layer === 'F.SilkS' || (i.layers as string[] | undefined)?.includes('F.SilkS'))).toBe(true);
  expect(await refusal(page, 'fpedit.items.get', { uuids: [uuid(999)] })).toBe(`not_found: ${uuid(999)}`);
});

test('a set over two pads is one undo step; one set per pad key, each undone by Ctrl+Z', async ({ page }) => {
  await openFootprint(page, `fpedit-small_parts.pretty/${SOIC}.kicad_mod`, SOIC);
  const pads = await items(page, { kinds: ['pad'] });
  const d0 = await depth(page);
  const two = (await request(page, 'fpedit.items.set', { uuids: [pads[0].uuid, pads[1].uuid], set: { copper: { size: [1, 2] } } })).items as Item[];
  expect(two.map((p) => (p.copper as { size: number[] }).size)).toEqual([[1, 2], [1, 2]]);
  expect(await depth(page)).toBe(d0 + 1);
  expect(await request(page, 'key.press', UNDO)).toEqual({});
  await expect.poll(() => depth(page), { timeout: 5_000 }).toBe(d0);
  const p = (await items(page, { uuids: [pads[2].uuid] }))[0];
  for (const set of [{ x: 0.5 }, { angle: 90 }, { number: '9' }, { copper: { shape: 'oval' } }, { layers: ['F.Cu', 'F.Mask'] }, { zoneConnection: 'solid' }, { clearance: 0.3 }, { property: 'testpoint' }]) {
    await setThenUndo(page, p, set);
  }
  const circle = (await request(page, 'fpedit.items.set', { uuids: [p.uuid], set: { copper: { shape: 'circle' } } })).items as Item[];
  const c = circle[0].copper as { size: number[]; offset: number[] };
  expect(c.size[0]).toBe(c.size[1]);
  expect(await refusal(page, 'fpedit.items.set', { uuids: [p.uuid], set: { drill: { shape: 'circle', size: [1, 1] } } })).toMatch(/^bad_args/);
  expect(await refusal(page, 'fpedit.items.set', { uuids: [pads[0].uuid], set: { padstack: 'custom' } })).toMatch(/^bad_args/);
});

test('the custom pad and the thermal pad read whole', async ({ page }) => {
  await openFootprint(page, 'CUSTOMPAD.kicad_mod', 'CUSTOMPAD');
  const pads = await items(page, { kinds: ['pad'] });
  const custom = pads.find((p) => (p.copper as { shape: string }).shape === 'custom');
  expect((custom?.copper as { primitives: unknown[] } | undefined)?.primitives).toHaveLength(3);
  const thermal = pads.find((p) => p.thermalSpokeWidth != null);
  expect(thermal).toMatchObject({ thermalGap: expect.any(Number), thermalAngle: expect.any(Number) });
});

test('add one item of each kind with page made uuids, one undo step, each read back, one set per key undone; remove', async ({ page }) => {
  await openFootprint(page, `fpedit-small_parts.pretty/${SOIC}.kicad_mod`, SOIC);
  const d0 = await depth(page);
  const png = base64(markPng());
  const added = (await request(page, 'fpedit.items.add', { items: [
    { kind: 'field', uuid: uuid(1), name: 'MPN', layer: 'F.Fab', text: 'X1' },
    { kind: 'text', uuid: uuid(2), text: 'T', layer: 'F.SilkS', x: 1, y: 1 },
    { kind: 'textbox', uuid: uuid(3), text: 'B', layer: 'F.SilkS', points: [[0, 0], [5, 3]] },
    { kind: 'table', uuid: uuid(4), layer: 'F.SilkS', colWidths: [5, 5], rowHeights: [2, 2], cells: [['a', 'b'], ['c', 'd']] },
    { kind: 'barcode', uuid: uuid(5), layer: 'F.SilkS', text: 'CC', symbology: 'code128' },
    { kind: 'shape', uuid: uuid(6), layer: 'F.SilkS', shape: 'segment', points: [[0, 0], [2, 0]] },
    { kind: 'shape', uuid: uuid(7), layer: 'F.SilkS', shape: 'rect', points: [[0, 0], [2, 1]] },
    { kind: 'shape', uuid: uuid(8), layer: 'F.SilkS', shape: 'arc', points: [[0, 0], [1, 1], [2, 0]] },
    { kind: 'shape', uuid: uuid(9), layer: 'F.SilkS', shape: 'circle', points: [[0, 0], [1, 0]] },
    { kind: 'shape', uuid: uuid(10), layer: 'F.SilkS', shape: 'polygon', points: [[0, 0], [1, 0], [1, 1]] },
    { kind: 'shape', uuid: uuid(11), layer: 'F.SilkS', shape: 'bezier', points: [[0, 0], [1, 1], [2, 1], [3, 0]] },
    { kind: 'image', uuid: uuid(12), layer: 'User.1', png },
    { kind: 'pad', uuid: uuid(13), number: '9' },
    { kind: 'dimension', uuid: uuid(14), dimType: 'aligned', layer: 'F.Fab', start: [0, 0], end: [3, 0], height: 1 },
    { kind: 'zone', uuid: uuid(15), layers: ['F.Cu'], points: [[-1, -1], [1, -1], [1, 1]], name: 'K' },
    { kind: 'point', uuid: uuid(16), layer: 'F.Fab' },
  ] })).items as Item[];
  expect(added.map((i) => i.uuid)).toEqual(Array.from({ length: 16 }, (_, i) => uuid(i + 1)));
  expect(await depth(page), 'the add is one undo step').toBe(d0 + 1);
  expect((added[3].cells as unknown[][]).map((r) => r.length)).toEqual([2, 2]);
  expect(added[4]).toMatchObject({ kind: 'barcode', symbology: 'code128', margin: expect.any(Array) });
  expect(added[6]).toMatchObject({ shape: 'rect', cornerRadius: 0, fill: 'none', filled: false });
  expect(added[11], 'the picture reads its PNG\'s own bytes').toMatchObject({ bytes: markPng().length, png });
  expect(added[12]).toMatchObject({ kind: 'pad', number: '9' });
  expect(added[13]).toMatchObject({ kind: 'dimension', dimType: 'aligned', start: [0, 0], end: [3, 0] });
  expect(added[14]).toMatchObject({ kind: 'zone', ruleArea: true, layers: ['F.Cu'] });
  expect(added[15]).toMatchObject({ kind: 'point', layer: 'F.Fab' });
  const sets: Record<string, Array<Record<string, unknown>>> = {
    field: [{ text: 'X2' }, { visible: false }, { size: [1.2, 1.2] }],
    text: [{ text: 'U' }, { angle: 90 }, { bold: true }, { hJustify: 'left' }, { layer: 'B.SilkS' }],
    textbox: [{ text: 'C' }, { border: false }],
    table: [{ cells: [['e', 'f'], ['g', 'h']] }, { borderExternal: false }],
    barcode: [{ text: 'DD' }, { errorCorrection: 'H' }, { symbology: 'datamatrix' }],
    shape: [{ width: 0.2 }, { style: 'dash' }],
    image: [{ scale: 2 }],
    dimension: [{ precision: 3 }, { units: 'mils' }],
    zone: [{ noVias: false }, { hatchPitch: 1 }],
    point: [{ size: 2 }],
  };
  for (const it of added) for (const set of sets[it.kind] ?? []) await setThenUndo(page, it, set);
  expect(await refusal(page, 'fpedit.items.set', { uuids: [uuid(5)], set: { kind: 'qr' } })).toMatch(/^bad_args/);
  expect(await refusal(page, 'fpedit.items.set', { uuids: [uuid(6)], set: { fill: 'solid' } })).toMatch(/^bad_args/);
  expect(await refusal(page, 'fpedit.items.set', { uuids: [uuid(12)], set: { locked: true } })).toBe('bad_args: fpedit.items.set: locked does not fit a image');
  expect(await refusal(page, 'fpedit.items.add', { items: [{ kind: 'shape', uuid: uuid(6), layer: 'F.SilkS', shape: 'segment', points: [[0, 0], [1, 0]] }] })).toBe(`bad_args: fpedit.items.add: ${uuid(6)} is taken`);
  const reference = (await items(page, { kinds: ['field'] })).find((f) => f.name === 'Reference') as Item;
  expect(await refusal(page, 'fpedit.items.remove', { uuids: [reference.uuid] })).toBe('bad_args: fpedit.items.remove: Reference is a field every footprint keeps');
  const d1 = await depth(page);
  expect(await request(page, 'fpedit.items.remove', { uuids: [uuid(6)] })).toEqual({ removed: [uuid(6)] });
  expect(await depth(page)).toBe(d1 + 1);
  expect(await refusal(page, 'fpedit.items.get', { uuids: [uuid(6)] })).toBe(`not_found: ${uuid(6)}`);
});
