// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// m9-i over the local pair (PROTOCOL.md sheet.pins.get, sheet.pins.apply,
// sheet.pins.place). On engine run 14 the cap syncPins is absent and the
// three ops answer unsupported naming the export. On engine run 15 (cc25):
// sheet.pins.get answers the sheet io of sheet-pins with A (both), B (label
// only), C (shapes differ), D (pin only), E and E1 (two singles);
// sheet.pins.apply of renameLabel E to E1, shapePin C and removePin D is ONE
// undo step with ONE ev.edited and leaves no folder under /tmp/cc-sheet-pins;
// sheet.pins.place of a label D enters the sub sheet and hangs the label on
// the pointer, of a pin B arms KiCad's sheet pin tool, and neither opens a
// window; Ctrl+Alt+Y (the seeded chord of Sync All Sheet Pins) sends ev.held
// and opens no window. Both held action names are in the engine's own
// strings.
import { expect, test, type Frame, type Page } from '@playwright/test';
import { ISLAND, ISLAND_ADDR } from './ports';

interface Ev { type: string; phase?: string; caps?: string[]; action?: string; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Engine {
  Module: { kicadCollabTestUndoDepth(): number; kicadCollabGetSelection(): string };
  FS: { readdir(p: string): string[]; analyzePath(p: string): { exists: boolean } };
  wxElementRegistry: { findAll(f: object): Array<{ typeName: string }> };
}
type Shape = 'input' | 'output' | 'bidirectional' | 'tri_state' | 'passive';
interface Pair { name: string; pin: string | null; label: string | null; pinShape: Shape | null; labelShape: Shape | null }
interface Row { sheet: string; sheetPath: string; name: string; file: string; pairs: Pair[] }

const RUN15 = 'waits for engine run 15 (pcbjam cc_e8_sch.inc, unit m9-e: kicadSheetPinsGet, kicadSheetPinsApply, kicadSheetPinsPlace)';
const U = (n: number): string => `5e7a1b00-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ROOT = U(0x100);
const SHEET = U(0x150);
// A sheet path as every op of the island reads and answers it: the root is "/", the root sheet's own uuid left out.
const ROOT_PATH = '/';
const SUB_PATH = `/${SHEET}/`;
const PIN = { A: U(0x151), C: U(0x152), D: U(0x153), E1: U(0x154) };
const LABEL = { A: U(0x201), B: U(0x202), C: U(0x203), E: U(0x204) };
const UNDO = { key: 'z', code: 'KeyZ', ctrl: true };
const ESCAPE = { key: 'Escape', code: 'Escape' };
const SYNC_ALL = { key: 'y', code: 'KeyY', ctrl: true, alt: true };
const HELD = ['eeschema.InteractiveDrawing.syncSheetPins', 'eeschema.InteractiveDrawing.syncAllSheetsPins'];

function measure(type: string, description: string): void {
  test.info().annotations.push({ type, description });
  console.log(`[measure] ${type}: ${description}`);
}
const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const of = async (page: Page, type: string): Promise<Ev[]> => (await events(page)).filter((e) => e.type === type);
const request = (page: Page, op: string, args?: unknown): Promise<Record<string, unknown>> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const);
const refusal = (page: Page, op: string, args?: unknown): Promise<string> =>
  request(page, op, args).then(() => 'ok', (err: Error) => err.message.split('\n')[0].replace(/^.*?page\.evaluate:\s*/, '').replace(/^Error:\s*/, ''));
const timed = (page: Page, op: string, args?: unknown): Promise<{ ms: number; result: Record<string, unknown> }> =>
  page.evaluate(async ([o, a]) => {
    const t0 = performance.now();
    const result = await (window as unknown as Harness).__bridge.request(o as string, a);
    return { ms: Math.round((performance.now() - t0) * 100) / 100, result };
  }, [op, args] as const);

/** Boots a sch frame on sheet-pins and answers ev.ready's caps and the island frame (null where Playwright cannot reach it). */
async function boot(page: Page): Promise<{ caps: string[]; island: Frame | null }> {
  await page.goto('/parent.html?fixture=sheet-pins&frame=sch');
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  const caps = (await of(page, 'ev.ready'))[0]?.caps ?? [];
  await expect(page.locator('#state')).toContainText('opened sheet-pins.kicad_sch', { timeout: 120_000 });
  await page.waitForTimeout(1_500);   // ev.edited's baseline
  return { caps, island: page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null };
}
const undoDepth = (island: Frame): Promise<number> => island.evaluate(() => Number((window as unknown as Engine).Module.kicadCollabTestUndoDepth()));
const selected = (island: Frame): Promise<string[]> => island.evaluate(() => JSON.parse((window as unknown as Engine).Module.kicadCollabGetSelection()) as string[]);
const dialogsUp = (island: Frame): Promise<string[]> =>
  island.evaluate(() => (window as unknown as Engine).wxElementRegistry.findAll({ visible: true }).map((e) => e.typeName)).then((t) => t.filter((n) => /Dialog/.test(n)));
const leftOver = (island: Frame): Promise<string[]> => island.evaluate(() => {
  const { FS } = window as unknown as Engine;
  return FS.analyzePath('/tmp/cc-sheet-pins').exists ? FS.readdir('/tmp/cc-sheet-pins').filter((n) => n !== '.' && n !== '..') : [];
});
const rowsOf = async (page: Page): Promise<Row[]> => ((await request(page, 'sheet.pins.get')) as { sheets: Row[] }).sheets;
const byName = (pairs: Pair[]): Pair[] => [...pairs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : (a.pin ?? '') < (b.pin ?? '') ? -1 : 1));

test('run 14 or 15: the cap follows the exports; without them the three ops answer unsupported naming the export', async ({ page }) => {
  const { caps } = await boot(page);
  const run15 = ['kicadSheetPinsGet', 'kicadSheetPinsApply', 'kicadSheetPinsPlace', 'kicadCollabBusy', 'kicadCollabGetSelection'].every((e) => caps.includes(e));
  expect(caps.includes('syncPins')).toBe(run15);
  if (!caps.includes('kicadSheetPinsGet')) expect(await refusal(page, 'sheet.pins.get')).toBe('unsupported: kicadSheetPinsGet');
  if (!caps.includes('kicadSheetPinsApply')) expect(await refusal(page, 'sheet.pins.apply', { actions: [{ op: 'removePin', pin: PIN.D }] })).toBe('unsupported: kicadSheetPinsApply');
  if (!caps.includes('kicadSheetPinsPlace')) expect(await refusal(page, 'sheet.pins.place', { sheet: SHEET, sheetPath: ROOT_PATH, place: 'pin', names: ['B'] })).toBe('unsupported: kicadSheetPinsPlace');
  expect(await refusal(page, 'sheet.pins.get', { all: true })).toBe('bad_args: sheet.pins.get');
  expect(await refusal(page, 'sheet.pins.apply', { actions: [] })).toBe('bad_args: sheet.pins.apply');
  expect(await refusal(page, 'sheet.pins.place', { sheet: SHEET, sheetPath: ROOT_PATH, place: 'both', names: ['B'] })).toBe('bad_args: sheet.pins.place');
});

test('the held actions\' names are in the engine\'s own strings', async ({ request: http }) => {
  const res = await http.get(`${ISLAND_ADDR}/current/wasm/kicad_editor/v0.2.3/kicad_editor.wasm`);
  expect(res.ok()).toBe(true);
  const wasm = await res.text();
  for (const n of HELD) expect(wasm.includes(n), n).toBe(true);
});

test('run 15: the read pairs every name; one apply is one undo step; one undo brings it all back', async ({ page, browserName }) => {
  const { caps, island } = await boot(page);
  test.skip(!caps.includes('syncPins'), RUN15);

  const got = await timed(page, 'sheet.pins.get');
  measure('sheet.pins.get, sheet-pins', `${got.ms} ms`);
  const read = got.result as { sheets: Row[]; truncated: boolean };
  expect(read.truncated).toBe(false);
  expect(read.sheets).toHaveLength(1);
  const io = read.sheets[0];
  expect({ sheet: io.sheet, sheetPath: io.sheetPath, name: io.name, file: io.file }).toEqual({ sheet: SHEET, sheetPath: ROOT_PATH, name: 'io', file: 'io.kicad_sch' });
  const before: Pair[] = [
    { name: 'A', pin: PIN.A, label: LABEL.A, pinShape: 'input', labelShape: 'input' },
    { name: 'B', pin: null, label: LABEL.B, pinShape: null, labelShape: 'input' },
    { name: 'C', pin: PIN.C, label: LABEL.C, pinShape: 'input', labelShape: 'output' },
    { name: 'D', pin: PIN.D, label: null, pinShape: 'input', labelShape: null },
    { name: 'E', pin: null, label: LABEL.E, pinShape: null, labelShape: 'input' },
    { name: 'E1', pin: PIN.E1, label: null, pinShape: 'input', labelShape: null },
  ];
  expect(byName(io.pairs)).toEqual(before);
  expect(await request(page, 'sheet.pins.get', { sheets: [{ uuid: SHEET, sheetPath: ROOT_PATH }] })).toEqual(read);

  // A uuid the design does not hold: nothing changes.
  expect(await refusal(page, 'sheet.pins.apply', { actions: [{ op: 'removePin', pin: U(0x999) }] })).toBe('not_applied: sheet.pins.apply');

  test.skip(island == null, `${browserName}: the island frame is out of Playwright's reach, so the undo depth and the run folders cannot be read`);
  const depth0 = await undoDepth(island!);
  const edits0 = (await of(page, 'ev.edited')).length;
  const actions = [
    { op: 'renameLabel', label: LABEL.E, sheetPath: SUB_PATH, to: 'E1' },
    { op: 'shapePin', pin: PIN.C, to: 'output' },
    { op: 'removePin', pin: PIN.D },
  ];
  const applied = await timed(page, 'sheet.pins.apply', { actions });
  measure('sheet.pins.apply, three actions', `${applied.ms} ms`);
  expect(applied.result).toEqual({ applied: 3 });
  expect(await leftOver(island!)).toEqual([]);
  expect(await dialogsUp(island!)).toEqual([]);
  expect(await undoDepth(island!)).toBe(depth0 + 1);
  await expect.poll(async () => (await of(page, 'ev.edited')).length, { timeout: 5_000 }).toBe(edits0 + 1);
  await page.waitForTimeout(500);
  expect((await of(page, 'ev.edited')).length).toBe(edits0 + 1);
  expect(byName((await rowsOf(page))[0].pairs)).toEqual([
    { name: 'A', pin: PIN.A, label: LABEL.A, pinShape: 'input', labelShape: 'input' },
    { name: 'B', pin: null, label: LABEL.B, pinShape: null, labelShape: 'input' },
    { name: 'C', pin: PIN.C, label: LABEL.C, pinShape: 'output', labelShape: 'output' },
    { name: 'E1', pin: PIN.E1, label: LABEL.E, pinShape: 'input', labelShape: 'input' },
  ]);

  // One undo brings the label's name, the pin's shape and the removed pin back.
  expect(await request(page, 'key.press', UNDO)).toEqual({});
  await expect.poll(() => undoDepth(island!), { timeout: 5_000 }).toBe(depth0);
  expect(byName((await rowsOf(page))[0].pairs)).toEqual(before);
});

test('run 15: a label placed enters the sheet and hangs; a pin placed arms the tool; neither opens a window', async ({ page, browserName }) => {
  const { caps, island } = await boot(page);
  test.skip(!caps.includes('syncPins'), RUN15);
  // A name with no counterpart arms nothing.
  expect(await refusal(page, 'sheet.pins.place', { sheet: SHEET, sheetPath: ROOT_PATH, place: 'label', names: ['B'] }))
    .toBe('not_applied: sheet.pins.place: the sheet is not there, or a name has no sheet pin of its name');
  test.skip(island == null, `${browserName}: the island frame is out of Playwright's reach, so the selection cannot be read`);
  const depth0 = await undoDepth(island!);

  const label = await timed(page, 'sheet.pins.place', { sheet: SHEET, sheetPath: ROOT_PATH, place: 'label', names: ['D'] });
  measure('sheet.pins.place, a label', `${label.ms} ms`);
  expect(label.result).toEqual({ hanging: true });
  const hung = await selected(island!);
  expect(hung).toHaveLength(1);
  expect(Object.values(LABEL)).not.toContain(hung[0]);
  expect(await dialogsUp(island!)).toEqual([]);
  // Esc drops it and leaves the tool: nothing stays, no undo step.
  expect(await request(page, 'key.press', ESCAPE)).toEqual({});
  await expect.poll(() => selected(island!), { timeout: 5_000 }).toEqual([]);
  expect(await undoDepth(island!)).toBe(depth0);

  const pin = await timed(page, 'sheet.pins.place', { sheet: SHEET, sheetPath: ROOT_PATH, place: 'pin', names: ['B'] });
  measure('sheet.pins.place, a pin', `${pin.ms} ms, ${JSON.stringify(pin.result)}`);
  expect(typeof (pin.result as { hanging: unknown }).hanging).toBe('boolean');
  expect(await dialogsUp(island!)).toEqual([]);
  expect(await request(page, 'key.press', ESCAPE)).toEqual({});
  expect(await request(page, 'key.press', ESCAPE)).toEqual({});
  await page.waitForTimeout(500);
  expect(await undoDepth(island!)).toBe(depth0);
  expect(await dialogsUp(island!)).toEqual([]);
});

test('run 15: Ctrl+Alt+Y sends ev.held for Sync All Sheet Pins and opens no window', async ({ page, browserName }) => {
  const { caps, island } = await boot(page);
  test.skip(!caps.includes('syncPins'), RUN15);
  const held0 = (await of(page, 'ev.held')).length;
  expect(await request(page, 'key.press', SYNC_ALL)).toEqual({});
  await expect.poll(async () => (await of(page, 'ev.held')).slice(held0).map((e) => e.action), { timeout: 10_000 }).toEqual([HELD[1]]);
  expect(await refusal(page, 'action.run', { name: HELD[0] })).toBe(`held: ${HELD[0]}`);
  test.skip(island == null, `${browserName}: the island frame is out of Playwright's reach`);
  await page.waitForTimeout(500);
  expect(await dialogsUp(island!)).toEqual([]);
});
