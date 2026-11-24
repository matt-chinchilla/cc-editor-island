// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// fp-i2b over the local pair (PROTOCOL.md "The footprint editor's asks, pad
// defaults and numbering"): KiCad's footprint editor asking the page before
// each of its windows (ev.fpedit, cap fpeditHeld) and opening none, the
// master pad read and set with no undo step, and KiCad's own pad numbering
// started by fpedit.enumerate with no window, a drag over three pads
// numbering them in one undo step. The fixture is tests/fixtures/fpedit-small
// (written by hand), its SOIC.
//
// The first test needs no fpedit frame and runs on every engine: outside an
// fpedit frame the three ops are unsupported, no frame lists fpeditHeld and
// no frame takes the footprint editor's slot. Every other test boots an
// fpedit frame, which needs engine run 15 (the fpedit exports and the asks of
// kicad cc/main fp-e1a, fp-e1b and fp-e1c); it is skipped on an engine whose
// fpedit frame lists no fpeditHeld. KiCad's actions run here through the
// engine's own kicadRunAction, past the island's held keys, as the page's
// pencil rows would after the hold is lifted.
import { expect, test, type Frame, type Page } from '@playwright/test';

import { ISLAND } from './ports';

interface Ev { type: string; phase?: string; caps?: string[]; uuids?: string[]; ask?: string; uuid?: string; isNew?: boolean; notice?: string; kept?: boolean; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Engine { Module: { kicadRunAction(name: string): unknown; kicadCollabGetViewport?: () => string } }
type Item = Record<string, unknown> & { kind: string; uuid: string; x?: number; y?: number; number?: string };
interface Key { key: string; code: string; ctrl?: boolean; shift?: boolean; alt?: boolean }

const RUN15 = 'waits for engine run 15 (the fpedit exports and the footprint editor\'s asks: units fp-e1a, fp-e1b, fp-e1c, fp-e3)';
const SMALL = '/fixtures/fpedit-small';
const LIB = 'fpedit-small_parts';
const SOIC = 'SOIC-8_3.9x4.9mm_P1.27mm';
const SOIC_PATH = `${SMALL}/${LIB}.pretty/${SOIC}.kicad_mod`;
const FRAME_ONLY = 'unsupported: a footprint edits in an fpedit frame';
const OPS: Array<[string, unknown]> = [['fpedit.padDefaults.get', undefined], ['fpedit.padDefaults.set', { set: { number: '3' } }], ['fpedit.enumerate', { start: 1, step: 1, prefix: '' }]];
const E: Key = { key: 'e', code: 'KeyE' };
const ESC: Key = { key: 'Escape', code: 'Escape' };
const UNDO: Key = { key: 'z', code: 'KeyZ', ctrl: true };
/** pcbnew's internal units per millimeter. */
const IU_PER_MM = 1e6;

const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const of = async (page: Page, type: string): Promise<Ev[]> => (await events(page)).filter((e) => e.type === type);
const request = (page: Page, op: string, args?: unknown): Promise<Record<string, unknown>> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const);
const refusal = (page: Page, op: string, args?: unknown): Promise<string> =>
  request(page, op, args).then(() => 'ok', (err: Error) => err.message.split('\n')[0].replace(/^.*?page\.evaluate:\s*/, '').replace(/^Error:\s*/, ''));
const text = (page: Page, path: string): Promise<string> => page.evaluate(async (p) => (await fetch(p)).text(), path);
const strip = (e: Ev): Omit<Ev, 'at'> => { const { at: _at, ...rest } = e; void _at; return rest; };
const islandFrame = (page: Page): Frame | null => page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null;

async function boot(page: Page, frame: string, fixture: string | null = null): Promise<string[]> {
  await page.goto(fixture == null ? `/parent.html?frame=${frame}` : `/parent.html?fixture=${fixture}&frame=${frame}`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  expect((await of(page, 'ev.state')).filter((e) => e.phase === 'fatal' || e.phase === 'blocked')).toEqual([]);
  return (await of(page, 'ev.ready'))[0]?.caps ?? [];
}
/** Boots an fpedit frame, skipping on an engine whose footprint editor does not ask the page (before run 15). */
async function bootAsking(page: Page): Promise<Frame> {
  // An fpedit frame on an engine without the fpedit exports never reaches ev.ready: a schematic frame reads them first.
  test.skip(!(await boot(page, 'sch')).includes('kicadFpEditOpen'), RUN15);
  const caps = await boot(page, 'fpedit');
  test.skip(!caps.includes('fpeditHeld'), RUN15);
  expect(caps).toContain('fpedit');
  const frame = islandFrame(page);
  test.skip(frame == null, 'the island frame is out of Playwright\'s reach in this browser');
  return frame as Frame;
}
const openSoic = async (page: Page): Promise<void> => {
  await request(page, 'fpedit.open', { text: await text(page, SOIC_PATH), name: SOIC, lib: LIB, mode: 'library', discard: true });
};
const items = async (page: Page, args: Record<string, unknown> = {}): Promise<Item[]> => (await request(page, 'fpedit.items.get', args)).items as Item[];
const depth = async (page: Page): Promise<number> => (await request(page, 'fpedit.state')).depth as number;
const run = (frame: Frame, name: string): Promise<unknown> => frame.evaluate((n) => (window as unknown as Engine).Module.kicadRunAction(n), name);

/** Does `act` and waits for exactly one more ev.fpedit; no KiCad window opens within a second after. */
async function askFor(page: Page, act: () => Promise<unknown>, what: string): Promise<Omit<Ev, 'at'>> {
  const n = (await of(page, 'ev.fpedit')).length;
  const menus = (await of(page, 'ev.menu')).length;
  await act();
  await expect.poll(async () => (await of(page, 'ev.fpedit')).length, { timeout: 5_000, message: `${what} asks the page` }).toBe(n + 1);
  await page.waitForTimeout(1_000);
  expect((await of(page, 'ev.fpedit')).length, `${what} asks once`).toBe(n + 1);
  expect((await of(page, 'ev.menu')).length, `${what} opens no window`).toBe(menus);
  return strip((await of(page, 'ev.fpedit')).at(-1) as Ev);
}
/**
 * The footprint editor's selection as the engine holds it (kicadFpEditSelection,
 * the read behind ev.selected). Read straight from the engine: in an fpedit
 * frame ev.selected follows a pointer or key release, not a host's select.
 */
async function selection(page: Page): Promise<string[]> {
  const frame = islandFrame(page);
  if (frame == null) return [];
  const raw = await frame.evaluate(() => String((window as unknown as { Module: { kicadFpEditSelection(): unknown } }).Module.kicadFpEditSelection()));
  return raw === '' ? [] : ((JSON.parse(raw) as { uuids?: string[] }).uuids ?? []);
}
async function selectOnly(page: Page, uuid: string): Promise<void> {
  expect(await request(page, 'select', { uuids: [uuid] })).toEqual({});
  await expect.poll(() => selection(page), { timeout: 5_000 }).toEqual([uuid]);
}
/** The page's point of a footprint position in mm (the footprint sits at the origin), read from the engine's viewport. */
async function screenOf(page: Page, frame: Frame): Promise<((x: number, y: number) => [number, number]) | null> {
  const raw = await frame.evaluate(() => {
    const m = (window as unknown as Engine).Module;
    return typeof m.kicadCollabGetViewport === 'function' ? String(m.kicadCollabGetViewport()) : '';
  });
  if (raw === '') return null;
  const v = JSON.parse(raw) as { cx: number; cy: number; scale: number; w: number; h: number };
  const canvas = await frame.evaluate(() => {
    const all = [...document.querySelectorAll('canvas')].map((c) => c.getBoundingClientRect()).sort((a, b) => b.width * b.height - a.width * a.height);
    return { left: all[0].left, top: all[0].top };
  });
  const box = await page.locator('iframe').boundingBox();
  if (box == null) return null;
  return (x, y) => [box.x + canvas.left + v.w / 2 + (x * IU_PER_MM - v.cx) * v.scale, box.y + canvas.top + v.h / 2 + (y * IU_PER_MM - v.cy) * v.scale];
}
/** A point of the canvas well away from the SOIC, as the page sees it. */
async function emptyPoint(page: Page, frame: Frame): Promise<[number, number]> {
  const at = await screenOf(page, frame);
  if (at != null) return at(6, 6);
  const box = await page.locator('iframe').boundingBox();
  return [(box?.x ?? 0) + (box?.width ?? 800) - 80, (box?.y ?? 0) + (box?.height ?? 600) - 80];
}

test('run 14 or 15: outside an fpedit frame the three ops are unsupported, no frame lists fpeditHeld and none takes the footprint editor\'s slot', async ({ page }) => {
  for (const [frame, fixture] of [['pcb', 'fpedit-small'], ['sch', null]] as const) {
    const caps = await boot(page, frame, fixture);
    expect(caps, frame).not.toContain('fpeditHeld');
    for (const [op, args] of OPS) expect(await refusal(page, op, args), `${frame} ${op}`).toBe(FRAME_ONLY);
    const island = islandFrame(page);
    if (island != null) expect(await island.evaluate(() => 'kicadHostFpEdit' in window), frame).toBe(false);
  }
});

test('run 15: E on a pad, a field, a shape and a text asks its kind with its uuid, keeps it selected and opens no window', async ({ page }) => {
  const frame = await bootAsking(page);
  await openSoic(page);
  const all = await items(page);
  const pad = all.find((i) => i.kind === 'pad');
  const field = all.find((i) => i.kind === 'field');
  const shape = all.find((i) => i.kind === 'shape');
  expect([pad, field, shape].every((i) => i != null), 'the SOIC holds a pad, a field and a shape').toBe(true);
  const d0 = await depth(page);
  for (const it of [pad, field, shape] as Item[]) {
    await selectOnly(page, it.uuid);
    expect(await askFor(page, () => request(page, 'key.press', E), `E on a ${it.kind}`)).toEqual({ type: 'ev.fpedit', ask: it.kind, uuid: it.uuid, isNew: false });
    expect(await selection(page), `the ${it.kind} stays selected`).toEqual([it.uuid]);
  }
  expect(await depth(page), 'an ask changes nothing').toBe(d0);
  // A new text from KiCad's text tool asks with its new uuid, placed reading "Text"; E on it then asks text.
  // KiCad's own tool start (immediate actions, as RULINGS 29d) places one text at the cursor and asks for
  // it; each press then places and asks for one more: two texts, two asks, two uuids.
  const [x, y] = await emptyPoint(page, frame);
  const started = await askFor(page, () => run(frame, 'pcbnew.InteractiveDrawing.text'), 'the text tool\'s start');
  expect(started).toMatchObject({ type: 'ev.fpedit', ask: 'text', isNew: true });
  const made = await askFor(page, () => page.mouse.click(x, y), 'a press of the text tool');
  expect(made).toMatchObject({ type: 'ev.fpedit', ask: 'text', isNew: true });
  expect(made.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  expect(made.uuid).not.toBe(started.uuid);
  await request(page, 'key.press', ESC);
  expect((await items(page, { uuids: [made.uuid as string] }))[0]).toMatchObject({ kind: 'text', text: 'Text' });
  expect(await depth(page)).toBe(d0 + 2);
  await selectOnly(page, made.uuid as string);
  expect(await askFor(page, () => request(page, 'key.press', E), 'E on the new text')).toEqual({ type: 'ev.fpedit', ask: 'text', uuid: made.uuid, isNew: false });
});

test('run 15: the footprint, pad defaults, pad table, numbering, push pad, wizard, new, rename, cleanup and import asks each arrive once, after a footprint is open', async ({ page }) => {
  const frame = await bootAsking(page);
  // No footprint open: nothing is asked.
  const before = (await of(page, 'ev.fpedit')).length;
  await run(frame, 'pcbnew.ModuleEditor.footprintProperties');
  await page.waitForTimeout(1_000);
  expect((await of(page, 'ev.fpedit')).length, 'no ask before a footprint is open').toBe(before);
  await request(page, 'key.press', ESC);
  await openSoic(page);
  const d0 = await depth(page);
  const frameAsks: Array<[string, string]> = [
    ['pcbnew.ModuleEditor.footprintProperties', 'footprint'],
    ['pcbnew.PadTool.defaultPadProperties', 'padDefaults'],
    ['pcbnew.ModuleEditor.padTable', 'padTable'],
    ['pcbnew.PadTool.enumeratePads', 'enumerate'],
    ['pcbnew.ModuleEditor.createFootprint', 'wizard'],
    ['pcbnew.ModuleEditor.newFootprint', 'newFootprint'],
    ['pcbnew.ModuleEditor.renameFootprint', 'rename'],
    ['pcbnew.GlobalEdit.cleanupGraphics', 'cleanup'],
    ['pcbnew.InteractiveDrawing.placeImportedGraphics', 'graphics'],
  ];
  for (const [action, ask] of frameAsks) {
    expect(await askFor(page, () => run(frame, action), action), action).toEqual({ type: 'ev.fpedit', ask, uuid: '', isNew: false });
    await request(page, 'key.press', ESC);
  }
  // E on nothing asks the footprint.
  expect(await request(page, 'select', { uuids: [] })).toEqual({});
  expect(await askFor(page, () => request(page, 'key.press', E), 'E on nothing')).toEqual({ type: 'ev.fpedit', ask: 'footprint', uuid: '', isNew: false });
  // Push Pad Properties asks with the source pad.
  const pad = (await items(page, { kinds: ['pad'] }))[0];
  await selectOnly(page, pad.uuid);
  expect(await askFor(page, () => run(frame, 'pcbnew.PadTool.PushPadSettings'), 'Push Pad Properties')).toEqual({ type: 'ev.fpedit', ask: 'pushPad', uuid: pad.uuid, isNew: false });
  expect(await depth(page), 'no frame ask changes the footprint').toBe(d0);
  expect(await request(page, 'fpedit.state')).toMatchObject({ name: SOIC, open: true });
  // The new item tools: a picture asks with "" and places nothing; a table and a barcode ask with their new uuids.
  const [x, y] = await emptyPoint(page, frame);
  expect(await askFor(page, async () => { await run(frame, 'pcbnew.InteractiveDrawing.placeReferenceImage'); await page.mouse.click(x, y); }, 'the picture tool'))
    .toEqual({ type: 'ev.fpedit', ask: 'image', uuid: '', isNew: true });
  expect(await depth(page), 'a held picture places nothing').toBe(d0);
  await request(page, 'key.press', ESC);
  const table = await askFor(page, async () => { await run(frame, 'pcbnew.InteractiveDrawing.drawTable'); await page.mouse.click(x, y); await page.mouse.click(x + 60, y + 40); }, 'the table tool');
  expect(table).toMatchObject({ ask: 'table', isNew: true });
  await request(page, 'key.press', ESC);
  // The barcode tool's start places one barcode at the cursor and asks (KiCad's immediate actions), then the press one more.
  const barcodeStart = await askFor(page, () => run(frame, 'pcbnew.InteractiveDrawing.barcode'), 'the barcode tool\'s start');
  expect(barcodeStart).toMatchObject({ ask: 'barcode', isNew: true });
  const barcode = await askFor(page, () => page.mouse.click(x - 120, y), 'a press of the barcode tool');
  expect(barcode).toMatchObject({ ask: 'barcode', isNew: true });
  expect(barcode.uuid).not.toBe(barcodeStart.uuid);
  await request(page, 'key.press', ESC);
  expect(await depth(page)).toBe(d0 + 3);
});

test('run 15: the master pad read and set with no undo step; fpedit.enumerate then a drag over three pads numbers them in one undo step', async ({ page }) => {
  const frame = await bootAsking(page);
  const master = await request(page, 'fpedit.padDefaults.get');
  expect(master).not.toHaveProperty('kind');
  expect(master).not.toHaveProperty('uuid');
  expect(master).toMatchObject({ x: 0, y: 0 });
  await openSoic(page);
  const d0 = await depth(page);
  const set = await request(page, 'fpedit.padDefaults.set', { set: { copper: { size: [1, 2] } } });
  expect((set.copper as { size: number[] }).size).toEqual([1, 2]);
  expect(await request(page, 'fpedit.state')).toMatchObject({ depth: d0, modified: false });
  expect(await refusal(page, 'fpedit.enumerate', { start: 1, step: 1000, prefix: '' })).toBe('bad_args: fpedit.enumerate');

  const pads = (await items(page, { kinds: ['pad'] })).slice(0, 3);
  expect(pads).toHaveLength(3);
  expect(await request(page, 'view.fit', {})).toEqual({});
  await page.waitForTimeout(500);
  const at = await screenOf(page, frame);
  test.skip(at == null, 'this engine names no viewport for the footprint editor: the drag needs the pads\' places on screen');
  const edits = (await of(page, 'ev.edited')).length;
  const asks = (await of(page, 'ev.fpedit')).length;
  expect(await request(page, 'fpedit.enumerate', { start: 1, step: 2, prefix: 'A' })).toEqual({});
  await page.waitForTimeout(300);
  const points = pads.map((p) => (at as (x: number, y: number) => [number, number])(p.x as number, p.y as number));
  await page.mouse.move(...points[0]);
  await page.mouse.down();
  for (const p of points.slice(1)) await page.mouse.move(...p, { steps: 8 });
  await page.mouse.up();
  await page.mouse.dblclick(...(await emptyPoint(page, frame)));
  await expect.poll(async () => (await items(page, { uuids: pads.map((p) => p.uuid) })).map((p) => p.number), { timeout: 5_000, message: 'the drag numbers the three pads' }).toEqual(['A1', 'A3', 'A5']);
  await expect.poll(async () => (await of(page, 'ev.edited')).length, { timeout: 5_000 }).toBeGreaterThan(edits);
  expect(await depth(page), 'one undo step for the run').toBe(d0 + 1);
  expect((await of(page, 'ev.fpedit')).length, 'fpedit.enumerate asks nothing').toBe(asks);
  expect(await request(page, 'key.press', UNDO)).toEqual({});
  await expect.poll(async () => (await items(page, { uuids: pads.map((p) => p.uuid) })).map((p) => p.number), { timeout: 5_000 }).toEqual(pads.map((p) => p.number));
});

test('engine build T17: the numbering\'s end is one ev.fpeditNotice, kept on a double click and taken back on Esc, with no status popup', async ({ page }) => {
  const frame = await bootAsking(page);
  test.skip(!(await of(page, 'ev.ready'))[0]?.caps?.includes('fpeditNotice'), 'this engine tells no numbering end (build T17 and later)');
  await openSoic(page);
  const pads = (await items(page, { kinds: ['pad'] })).slice(0, 3);
  expect(await request(page, 'view.fit', {})).toEqual({});
  await page.waitForTimeout(500);
  const at = await screenOf(page, frame);
  test.skip(at == null, 'this engine names no viewport for the footprint editor');
  const points = pads.map((p) => (at as (x: number, y: number) => [number, number])(p.x as number, p.y as number));
  const popup = () => frame.evaluate(() => [...document.querySelectorAll('div.window.popup')].some((e) => (e as HTMLElement).offsetParent != null));
  const notices = async () => (await of(page, 'ev.fpeditNotice')).map((e) => ({ notice: e.notice, kept: e.kept }));
  // Esc takes the numbers back: kept false.
  expect(await request(page, 'fpedit.enumerate', { start: 10, step: 2, prefix: '' })).toEqual({});
  await page.waitForTimeout(300);
  for (const p of points) await page.mouse.click(...p);
  expect(await popup(), 'no status popup while numbering').toBe(false);
  await page.keyboard.press('Escape');
  await expect.poll(notices, { timeout: 5_000 }).toEqual([{ notice: 'enumerateEnd', kept: false }]);
  expect((await items(page, { uuids: pads.map((p) => p.uuid) })).map((p) => p.number), 'the old numbers back').toEqual(pads.map((p) => p.number));
  // A double click keeps them: kept true, one undo step.
  const d0 = await depth(page);
  expect(await request(page, 'fpedit.enumerate', { start: 10, step: 2, prefix: '' })).toEqual({});
  await page.waitForTimeout(300);
  for (const p of points) await page.mouse.click(...p);
  await page.mouse.dblclick(...(await emptyPoint(page, frame)));
  await expect.poll(notices, { timeout: 5_000 }).toEqual([{ notice: 'enumerateEnd', kept: false }, { notice: 'enumerateEnd', kept: true }]);
  expect(await depth(page), 'one undo step for the run').toBe(d0 + 1);
});

test('run 15: a group asks with its uuid from E and from Edit Group Properties run by name (engine fix e3-1), opening no window', async ({ page }) => {
  const frame = await bootAsking(page);
  await openSoic(page);
  const shapes = (await items(page, { kinds: ['shape'] })).slice(0, 2).map((s) => s.uuid);
  expect(shapes, 'the SOIC holds two shapes to group').toHaveLength(2);
  expect(await request(page, 'select', { uuids: shapes })).toEqual({});
  await expect.poll(async () => (await selection(page)).sort(), { timeout: 5_000 }).toEqual([...shapes].sort());
  const d0 = await depth(page);
  await run(frame, 'common.Interactive.group');
  await expect.poll(() => depth(page), { timeout: 5_000, message: 'KiCad groups the two shapes in one undo step' }).toBe(d0 + 1);
  // KiCad selects the group it made: its one uuid is the group's.
  await expect.poll(async () => (await selection(page)).length, { timeout: 5_000 }).toBe(1);
  const [group] = await selection(page);
  expect(shapes).not.toContain(group);
  expect(await askFor(page, () => request(page, 'key.press', E), 'E on the group')).toEqual({ type: 'ev.fpedit', ask: 'group', uuid: group, isNew: false });
  expect(await askFor(page, () => run(frame, 'common.Groups.groupProperties'), 'Edit Group Properties')).toEqual({ type: 'ev.fpedit', ask: 'group', uuid: group, isNew: false });
  expect(await selection(page), 'the group stays selected').toEqual([group]);
  expect(await depth(page), 'an ask changes nothing').toBe(d0 + 1);
});
