// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// island v0.2.3-cc15 over the local pair, on the Glasgow example (PROTOCOL.md):
// symbol.get reads one symbol's fields, flags and drawing by uuid and symbol.set
// changes them, one undo step a set, with no KiCad dialog, through our engine's
// kicadSymbolGet and kicadSymbolSet (pcbjam cc/main e8b2abe; engine run 10).
// Glasgow's io_buffer.kicad_sch is one sheet shown twice (IO_Buffer_A and
// IO_Buffer_B): its symbols are one object with a designator per path.
import { expect, test, type Frame, type Page } from '@playwright/test';

const ISLAND = 'http://editor.localhost:4174';
interface Ev { type: string; phase?: string; depth?: number; caps?: string[]; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Engine { Module: { kicadCollabTestUndoDepth(): number } }
interface Field { name: string; value: string; shown: boolean; kind: string }
interface Sheet { uuid: string; sheetPath: string; sheetName: string; ref: string; value: string; footprint: string; libId: string; fields: Field[]; inBom: boolean; onBoard: boolean; inSim: boolean; dnp: boolean; rotation: number; mirror: string; x: number; y: number; unit: number; units: number; bodyStyle: number; bodyStyles: number; filters: string[] }

/** Glasgow's U1 (CY7C68013A) on the root sheet. */
const U1 = '00000000-0000-0000-0000-00005aca0321';
/** A capacitor of io_buffer.kicad_sch: C59 on IO_Buffer_A, C45 on IO_Buffer_B. */
const C_REUSED = '00000000-0000-0000-0000-00005ad9c9d7';
const BANKS = '00000000-0000-0000-0000-00005c7b59b0';
const PATH_A = `/${BANKS}/00000000-0000-0000-0000-00005c9e337e/`;
const PATH_B = `/${BANKS}/00000000-0000-0000-0000-00005c9e338e/`;

function measure(type: string, description: string): void {
  test.info().annotations.push({ type, description });
  console.log(`[measure] ${type}: ${description}`);
}
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const of = async (page: Page, type: string): Promise<Ev[]> => (await events(page)).filter((e) => e.type === type);
const request = (page: Page, op: string, args?: unknown): Promise<Record<string, unknown>> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const);
const refusal = (page: Page, op: string, args?: unknown): Promise<string> =>
  request(page, op, args).then(() => 'ok', (err: Error) => err.message.split('\n')[0].replace(/^.*?page\.evaluate:\s*/, '').replace(/^Error:\s*/, ''));
/** One request timed in the page, from the request to the answer. */
const timed = (page: Page, op: string, args: unknown): Promise<{ ms: number; result: Sheet }> => page.evaluate(async ([o, a]) => {
  const t0 = performance.now();
  const result = await (window as unknown as Harness).__bridge.request(o as string, a) as unknown as Sheet;
  return { ms: Math.round((performance.now() - t0) * 100) / 100, result };
}, [op, args] as const);
const get = async (page: Page, uuid: string, sheetPath?: string): Promise<Sheet> => (await request(page, 'symbol.get', sheetPath == null ? { uuid } : { uuid, sheetPath })) as unknown as Sheet;
const set = async (page: Page, uuid: string, sheetPath: string, s: unknown): Promise<Sheet> => (await request(page, 'symbol.set', { uuid, sheetPath, set: s })) as unknown as Sheet;

async function boot(page: Page, frameName: 'sch' | 'pcb'): Promise<Frame | null> {
  await page.goto(`/parent.html?fixture=glasgow&frame=${frameName}`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  await expect(page.locator('#state')).toContainText(`opened glasgow.kicad_${frameName}`, { timeout: 120_000 });
  return page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null;
}
const undoDepth = (frame: Frame): Promise<number> => frame.evaluate(() => Number((window as unknown as Engine).Module.kicadCollabTestUndoDepth()));
const unreached = (): void => { test.info().annotations.push({ type: 'unreached', description: 'the island frame is out of Playwright\'s reach in this browser: the undo depth was not read' }); };
const UNDO = { key: 'z', code: 'KeyZ', ctrl: true };

test('symbol.get on Glasgow: U1\'s sheet as the engine holds it, not_found for a uuid no sheet holds', async ({ page }) => {
  await boot(page, 'sch');
  expect((await of(page, 'ev.ready'))[0]?.caps).toEqual(expect.arrayContaining(['symbol', 'annotate', 'check']));
  const u1 = await get(page, U1);
  expect(u1).toMatchObject({ uuid: U1, sheetPath: '/', sheetName: 'glasgow', ref: 'U1', value: 'CY7C68013A-56LTX', inBom: true, onBoard: true, dnp: false, rotation: 0, mirror: 'none', unit: 1, units: 1, bodyStyle: 1, bodyStyles: 1 });
  expect(u1.footprint).toMatch(/^Package_DFN_QFN:Cypress_QFN-56/);
  expect(u1.fields.slice(0, 5).map((f) => f.kind)).toEqual(['reference', 'value', 'footprint', 'datasheet', 'description']);
  expect(u1.fields.find((f) => f.name === 'MPN')).toMatchObject({ value: 'CY7C68013A-56LTXC', shown: false, kind: 'user' });
  expect(Array.isArray(u1.filters)).toBe(true);
  const times: number[] = [];
  for (let i = 0; i < 5; i++) times.push((await timed(page, 'symbol.get', { uuid: U1 })).ms);
  measure('symbol.get, Glasgow U1', `median ${median(times)} ms of ${times.join(', ')} ms from the request to the answer`);
  expect(await refusal(page, 'symbol.get', { uuid: '00000000-0000-0000-0000-000000000001' })).toBe('not_found: 00000000-0000-0000-0000-000000000001');
  expect(await refusal(page, 'symbol.get', { uuid: U1.toUpperCase() })).toBe('bad_args: symbol.get');
});

test('symbol.set on Glasgow: one undo step a set, the read back answered, Ctrl+Z takes it back', async ({ page }) => {
  const frame = await boot(page, 'sch');
  await page.waitForTimeout(1_500);   // the open's baseline read (ev.edited)
  const before = await get(page, U1);
  const depth0 = frame == null ? null : await undoDepth(frame);
  const edits0 = (await of(page, 'ev.edited')).length;
  const first = await timed(page, 'symbol.set', { uuid: U1, sheetPath: '/', set: { value: 'CY7C68013A-probe' } });
  expect(first.result.value).toBe('CY7C68013A-probe');
  expect(first.result.fields.find((f) => f.name === 'Value')?.value).toBe('CY7C68013A-probe');
  await expect.poll(async () => (await of(page, 'ev.edited')).length, { timeout: 5_000 }).toBe(edits0 + 1);
  if (frame != null) expect(await undoDepth(frame)).toBe((depth0 ?? 0) + 1); else unreached();
  // KiCad's own Undo takes the set back.
  expect(await request(page, 'key.press', UNDO)).toEqual({});
  await expect.poll(async () => (await get(page, U1)).value, { timeout: 5_000 }).toBe(before.value);
  const times = [first.ms];
  for (let i = 0; i < 4; i++) times.push((await timed(page, 'symbol.set', { uuid: U1, sheetPath: '/', set: { value: `probe-${i}` } })).ms);
  measure('symbol.set, Glasgow U1 value', `median ${median(times)} ms of ${times.join(', ')} ms from the request to the answer`);
  // Each key of a set, one at a time: the answer reads it back.
  expect((await set(page, U1, '/', { ref: 'U19' })).ref).toBe('U19');
  expect((await set(page, U1, '/', { rotation: 90 })).rotation).toBe(90);
  // A mirror across Y reads back in KiCad's spelling: across X, turned 180 degrees more.
  expect(await set(page, U1, '/', { mirror: 'y' })).toMatchObject({ rotation: 270, mirror: 'x' });
  expect(await set(page, U1, '/', { rotation: 0, mirror: 'none' })).toMatchObject({ rotation: 0, mirror: 'none' });
  expect(await set(page, U1, '/', { x: 92.71 })).toMatchObject({ x: 92.71, y: before.y });
  expect(await set(page, U1, '/', { inBom: false, onBoard: false, inSim: false, dnp: true })).toMatchObject({ inBom: false, onBoard: false, inSim: false, dnp: true });
  expect((await set(page, U1, '/', { fields: [{ name: 'Datasheet', shown: true }, { name: 'MPN', value: 'CY7C68013A-56LTXT' }] })).fields.filter((f) => f.name === 'Datasheet' || f.name === 'MPN').map((f) => [f.name, f.value, f.shown]))
    .toEqual([['Datasheet', before.fields.find((f) => f.name === 'Datasheet')?.value, true], ['MPN', 'CY7C68013A-56LTXT', false]]);
  expect((await set(page, U1, '/', { addField: { name: 'Tolerance', value: '1%', shown: true } })).fields.at(-1)).toEqual({ name: 'Tolerance', value: '1%', shown: true, kind: 'user' });
  expect((await set(page, U1, '/', { removeField: 'Tolerance' })).fields.some((f) => f.name === 'Tolerance')).toBe(false);
  expect((await set(page, U1, '/', { footprint: 'Package_DFN_QFN:QFN-56-1EP_8x8mm_P0.5mm_EP5.6x5.6mm' })).footprint).toBe('Package_DFN_QFN:QFN-56-1EP_8x8mm_P0.5mm_EP5.6x5.6mm');
  if (frame != null) expect(await undoDepth(frame)).toBe((depth0 ?? 0) + 14); else unreached();   // 1 set, 1 undo, 4 timed sets, 10 sets of one key each
  // The symbol's own bounds, before any effect.
  expect(await refusal(page, 'symbol.set', { uuid: U1, sheetPath: '/', set: { unit: 2 } })).toBe('bad_args: symbol.set: unit 2 of 1');
  expect(await refusal(page, 'symbol.set', { uuid: U1, sheetPath: '/', set: { addField: { name: 'mpn', value: '', shown: false } } })).toBe('bad_args: symbol.set: mpn is taken');
  expect(await refusal(page, 'symbol.set', { uuid: U1, sheetPath: PATH_A, set: { value: 'x' } })).toBe(`not_found: ${U1} on ${PATH_A}`);
});

test('a reused sheet: one symbol, a designator per path; a set changes the instance on its own path only', async ({ page }) => {
  await boot(page, 'sch');
  expect((await get(page, C_REUSED, PATH_A))).toMatchObject({ sheetPath: PATH_A, sheetName: 'IO_Buffer_A', ref: 'C59' });
  expect((await get(page, C_REUSED, PATH_B))).toMatchObject({ sheetPath: PATH_B, sheetName: 'IO_Buffer_B', ref: 'C45' });
  // No path, or one that does not hold it: the sheet shown (the root does not) falls to the first path holding it.
  expect((await get(page, C_REUSED)).sheetPath).toBe(PATH_A);
  expect((await get(page, C_REUSED, '/')).sheetPath).toBe(PATH_A);
  expect((await set(page, C_REUSED, PATH_B, { ref: 'C145' }))).toMatchObject({ sheetPath: PATH_B, ref: 'C145' });
  expect((await get(page, C_REUSED, PATH_A)).ref).toBe('C59');
  // The value is the symbol's, shared by both instances.
  const v = await set(page, C_REUSED, PATH_B, { value: '220n' });
  expect(v.value).toBe('220n');
  expect((await get(page, C_REUSED, PATH_A)).value).toBe('220n');
});

test('symbol.get and symbol.set in a board are unsupported', async ({ page }) => {
  await boot(page, 'pcb');
  expect((await of(page, 'ev.ready'))[0]?.caps).toContain('symbol');
  expect(await refusal(page, 'symbol.get', { uuid: U1 })).toBe('unsupported: a schematic edits in a sch frame');
  expect(await refusal(page, 'symbol.set', { uuid: U1, sheetPath: '/', set: { value: 'x' } })).toBe('unsupported: a schematic edits in a sch frame');
});
