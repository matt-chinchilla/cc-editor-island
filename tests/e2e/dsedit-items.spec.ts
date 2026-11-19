// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// island v0.2.3-cc25 over the local pair (PROTOCOL.md "The drawing sheet
// editor: items, defaults, preview, append and pictures"): the open sheet's
// items read and changed by uuid, its defaults, the page and title block it is
// previewed on, another sheet appended, and KiCad's Place Bitmaps asking the
// page for a picture (ev.dsedit) and placing an armed one, all with no KiCad
// window. The fixtures are tests/fixtures/ds-small (written by hand) and
// tests/fixtures/ds-basic (KiCad's own basic_test).
//
// The first test needs no ds frame and runs on every engine: outside a ds
// frame every op of this unit is unsupported and no frame lists dseditHeld.
// Every other test boots a ds frame, which needs engine run 15.
import { expect, test, type Page } from '@playwright/test';

interface Ev { type: string; phase?: string; caps?: string[]; depth?: number; ask?: string; uuid?: string; isNew?: boolean }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface State { token: string; open: boolean; depth: number; items: number }
type Item = Record<string, unknown> & { kind: string; uuid: string };

const BASIC = '/fixtures/ds-basic';
const SMALL = '/fixtures/ds-small';
const DS_FRAME_ONLY = 'unsupported: a drawing sheet edits in a ds frame';
const OPS = ['dsedit.items.get', 'dsedit.items.set', 'dsedit.items.add', 'dsedit.items.remove', 'dsedit.defaults.get', 'dsedit.defaults.set', 'dsedit.preview.get', 'dsedit.preview.set', 'dsedit.append', 'dsedit.image.arm'];
const COMMON = ['kind', 'uuid', 'name', 'comment', 'pages', 'start', 'repeat', 'step'];
const KEYS: Record<string, string[]> = {
  line: [...COMMON, 'end', 'lineWidth'],
  rect: [...COMMON, 'end', 'lineWidth'],
  text: [...COMMON, 'text', 'labelStep', 'font', 'bold', 'italic', 'color', 'hJustify', 'vJustify', 'rotation', 'size', 'maxLength', 'maxHeight', 'lineWidth'],
  polygon: [...COMMON, 'rotation', 'lineWidth', 'outlines', 'points'],
  bitmap: [...COMMON, 'ppi', 'width', 'height'],
};
// KiCad's Place Bitmaps has no key of its own: the chord the island seeds for it (theme/user.hotkeys).
const PLACE_BITMAPS = { key: '5', code: 'Digit5', ctrl: true, alt: true };

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
const timed = (page: Page, op: string, args?: unknown): Promise<{ ms: number; result: Record<string, unknown> }> => page.evaluate(async ([o, a]) => {
  const t0 = performance.now();
  const result = await (window as unknown as Harness).__bridge.request(o as string, a);
  return { ms: Math.round((performance.now() - t0) * 100) / 100, result };
}, [op, args] as const);
const text = (page: Page, path: string): Promise<string> => page.evaluate(async (p) => (await fetch(p)).text(), path);
const state = async (page: Page): Promise<State> => (await request(page, 'dsedit.state')) as unknown as State;
const items = async (page: Page, args: Record<string, unknown> = {}): Promise<Item[]> => ((await request(page, 'dsedit.items.get', args)) as { items: Item[] }).items;
const newUuid = (page: Page): Promise<string> => page.evaluate(() => crypto.randomUUID());

async function boot(page: Page, frame: string): Promise<void> {
  await page.goto(`/parent.html?frame=${frame}`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  expect((await of(page, 'ev.state')).filter((e) => e.phase === 'fatal' || e.phase === 'blocked')).toEqual([]);
}
async function openSmall(page: Page): Promise<State> {
  return (await request(page, 'dsedit.open', { source: 'text', text: await text(page, `${SMALL}/every-item.kicad_wks`), name: 'every-item.kicad_wks', discard: true })) as unknown as State;
}
/** A press at the middle of the island's canvas. */
async function clickCanvas(page: Page): Promise<void> {
  const box = await page.locator('iframe').boundingBox();
  if (box == null) throw new Error('no island frame');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test('outside a ds frame every op of the unit is unsupported and no frame lists dseditHeld (any engine)', async ({ page }) => {
  await boot(page, 'sch');
  expect((await of(page, 'ev.ready'))[0]?.caps ?? []).not.toContain('dseditHeld');
  for (const op of OPS) expect(await refusal(page, op, {}), op).toBe(DS_FRAME_ONLY);
});

test('reads one item of each kind with every key of its kind and no other', async ({ page }) => {
  await boot(page, 'ds');
  expect((await of(page, 'ev.ready'))[0]?.caps ?? []).toEqual(expect.arrayContaining(['dsedit', 'dseditHeld']));
  const s = await openSmall(page);
  const all = await items(page);
  expect(all).toHaveLength(s.items);
  for (const kind of ['line', 'rect', 'text', 'polygon', 'bitmap']) {
    const one = all.find((i) => i.kind === kind);
    expect(one, kind).toBeDefined();
    expect(Object.keys(one as Item).sort(), kind).toEqual([...KEYS[kind]].sort());
  }
  const label = all.find((i) => i.kind === 'text' && i.name === 'label') as Item;
  expect(label).toMatchObject({ repeat: 3, step: [10, 0], labelStep: 1, bold: true, italic: true, hJustify: 'center', vJustify: 'top', maxLength: 40, maxHeight: 5 });
  expect(all.find((i) => i.kind === 'bitmap')).toMatchObject({ width: 16, height: 16 });
  expect((await items(page, { kinds: ['line'] })).map((i) => i.kind)).toEqual(['line', 'line', 'line', 'line']);
  const reads: number[] = [];
  for (let i = 0; i < 5; i++) reads.push((await timed(page, 'dsedit.items.get')).ms);
  measure('dsedit.items.get, every-item', `${reads.join(', ')} ms`);
});

test('sets the text\'s size, the line\'s end and the bitmap\'s ppi, each read back with one more undo depth', async ({ page }) => {
  await boot(page, 'ds');
  await openSmall(page);
  const all = await items(page);
  const title = all.find((i) => i.kind === 'text' && i.name === 'title') as Item;
  const line = all.find((i) => i.kind === 'line') as Item;
  const bitmap = all.find((i) => i.kind === 'bitmap') as Item;
  const sets: Array<[Item, Record<string, unknown>]> = [
    [title, { size: [3, 3] }],
    [line, { end: { x: 55, y: 45, corner: 'rbcorner' } }],
    [bitmap, { ppi: 600 }],
  ];
  const times: number[] = [];
  for (const [item, set] of sets) {
    const before = (await state(page)).depth;
    const { ms, result } = await timed(page, 'dsedit.items.set', { uuids: [item.uuid], set });
    times.push(ms);
    expect((result as { items: Item[] }).items[0], JSON.stringify(set)).toMatchObject(set);
    expect((await state(page)).depth).toBe(before + 1);
  }
  measure('dsedit.items.set', `${times.join(', ')} ms`);
  expect(await refusal(page, 'dsedit.items.set', { uuids: [line.uuid], set: { ppi: 300 } })).toBe('bad_args: dsedit.items.set: a line has no ppi');
});

test('adds a line with a uuid the page made, refuses a taken one, removes it', async ({ page }) => {
  await boot(page, 'ds');
  await openSmall(page);
  const uuid = await newUuid(page);
  const line = { kind: 'line', uuid, name: 'added', comment: '', pages: 'all', start: { x: 30, y: 30, corner: 'rbcorner' }, repeat: 1, step: [0, 0], end: { x: 60, y: 30, corner: 'rbcorner' }, lineWidth: 0.25 };
  const depth = (await state(page)).depth;
  expect(((await request(page, 'dsedit.items.add', { items: [line] })) as { items: Item[] }).items).toEqual([line]);
  expect((await state(page)).depth).toBe(depth + 1);
  expect(await refusal(page, 'dsedit.items.add', { items: [line] })).toBe(`bad_args: dsedit.items.add: ${uuid} is on the sheet already`);
  expect(await request(page, 'dsedit.items.remove', { uuids: [uuid] })).toEqual({ removed: [uuid] });
  expect(await items(page, { uuids: [uuid] })).toEqual([]);
  expect((await state(page)).depth).toBe(depth + 2);
});

test('a 0.3 mm default line width and a preview titled Checked on A3 read back', async ({ page }) => {
  await boot(page, 'ds');
  await openSmall(page);
  expect(await request(page, 'dsedit.defaults.set', { set: { lineWidth: 0.3 } })).toMatchObject({ lineWidth: 0.3 });
  const preview = await request(page, 'dsedit.preview.set', { set: { title: 'Checked', paper: 'A3' } });
  expect(preview).toMatchObject({ paper: 'A3', title: 'Checked' });
  expect(Math.max(preview.width as number, preview.height as number)).toBeCloseTo(420, 0);
  expect(await request(page, 'dsedit.preview.get')).toEqual(preview);
  await page.screenshot({ path: test.info().outputPath('a3-checked.png') });
});

test('appends KiCad\'s basic_test sheet and answers its added uuids; an unreadable sheet is refused with KiCad\'s line', async ({ page }) => {
  await boot(page, 'ds');
  const s = await openSmall(page);
  const { ms, result } = await timed(page, 'dsedit.append', { text: await text(page, `${BASIC}/custom_ds.kicad_wks`) });
  const added = (result as { added: string[] }).added;
  expect(added.length).toBeGreaterThan(0);
  expect((await items(page, { uuids: added })).map((i) => i.uuid)).toEqual(added);
  expect((await state(page)).items).toBe(s.items + added.length);
  measure('dsedit.append, custom_ds', `${ms} ms, ${added.length} items`);
  expect(await refusal(page, 'dsedit.append', { text: await text(page, `${SMALL}/broken.kicad_wks`) })).toMatch(/^unreadable: .*line/);
});

test('Place Bitmaps with nothing armed sends ev.dsedit and opens no window; an armed logo is placed by a click', async ({ page }) => {
  await boot(page, 'ds');
  await openSmall(page);
  const bitmaps = async () => (await items(page, { kinds: ['bitmap'] })).length;
  const n = await bitmaps();
  const menus = (await of(page, 'ev.menu')).length;
  // KiCad's own Place Bitmaps (RULINGS 29d): started by its key it asks once at the tool's start, then once per press.
  expect(await request(page, 'key.press', PLACE_BITMAPS)).toEqual({});
  await expect.poll(async () => (await of(page, 'ev.dsedit')).length, { timeout: 5_000, message: 'the start by key asks' }).toBe(1);
  await clickCanvas(page);
  await expect.poll(async () => (await of(page, 'ev.dsedit')).length, { timeout: 5_000, message: 'the press asks again' }).toBe(2);
  // The harness stamps each event with its arrival time (at); the event itself is exactly these keys.
  for (const { at: _at, ...ask } of await of(page, 'ev.dsedit')) expect(ask).toEqual({ type: 'ev.dsedit', ask: 'image', uuid: '', isNew: true });
  await page.waitForTimeout(1_000);
  expect((await of(page, 'ev.menu')).length, 'no window').toBe(menus);
  expect(await bitmaps()).toBe(n);
  await request(page, 'key.press', { key: 'Escape', code: 'Escape' });
  const armed = await page.evaluate(async (p) => {
    const bytes = new Uint8Array(await (await fetch(p)).arrayBuffer());
    return (window as unknown as Harness).__bridge.request('dsedit.image.arm', { bytes, name: 'logo.png' });
  }, `${SMALL}/logo.png`);
  expect(armed).toEqual({});
  expect(await request(page, 'key.press', PLACE_BITMAPS)).toEqual({});
  await clickCanvas(page);
  await expect.poll(bitmaps, { timeout: 5_000 }).toBe(n + 1);
  expect((await items(page, { kinds: ['bitmap'] })).some((b) => b.width === 64 && b.height === 64)).toBe(true);
  expect((await of(page, 'ev.dsedit')).length, 'the armed picture asks nothing').toBe(2);
  await request(page, 'key.press', { key: 'Escape', code: 'Escape' });
  await page.screenshot({ path: test.info().outputPath('placed-logo.png') });
});
