// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// m5-i over the local pair (PROTOCOL.md "Schematic items: sch.item.get,
// sch.item.set, sch.image.place" and ev.schItem), on the fixture items-sch
// (one of every schematic item kind that is not a symbol, a sheet sub and a
// spare sheet file; tests/fixtures/items-sch/SOURCE).
//
// The first two tests run on every engine: schItem is listed by a sch frame
// exactly when the engine has kicadSchItemGet, kicadSchItemSet,
// kicadHostSchItems and kicadCollabBusy, schImagePlace exactly when it has
// kicadSchPlaceImage and kicadCollabGetSelection; without them each op
// answers unsupported naming the first missing export and no slot is taken;
// a pcb frame refuses every op. The others need engine run 15 (pcbjam
// cc_e8_sch.inc and kicad cc/main K-SITEM, K-SHEETFILE, unit m5-e) and are
// skipped on an engine whose sch frame lists no schItem: every kind's get,
// one set per key with one undo step each that one Ctrl+Z restores, a label
// kind change that keeps the label where it was, a sheet file renamed and
// linked, E on each kind asking the page once with no window (a no connect
// asking nothing), the new label, text, text box and sheet asking with
// isNew, and a picture hanging on the pointer. KiCad's tools run here
// through the engine's own kicadRunAction.
import { expect, test, type Frame, type Page } from '@playwright/test';

import { ISLAND } from './ports';

interface Ev { type: string; phase?: string; caps?: string[]; uuids?: string[]; kind?: string; uuid?: string; sheetPath?: string; isNew?: boolean; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Engine {
  Module: { kicadCollabTestUndoDepth(): number; kicadRunAction(name: string): unknown; kicadCollabGetViewport?: () => string };
  FS: { readdir(p: string): string[]; analyzePath(p: string): { exists: boolean } };
}
type Rec = Record<string, unknown> & { kind: string; uuid: string; sheetPath: string };
interface Key { key: string; code: string; ctrl?: boolean; shift?: boolean; alt?: boolean }

const RUN15 = 'waits for engine run 15 (pcbjam cc_e8_sch.inc and kicad K-SITEM, K-SHEETFILE: unit m5-e)';
const FIXTURE = 'items-sch';
const ITEM_EXPORTS = ['kicadSchItemGet', 'kicadSchItemSet', 'kicadHostSchItems', 'kicadCollabBusy'];
const IMAGE_EXPORTS = ['kicadSchPlaceImage', 'kicadCollabGetSelection'];
const U = (n: number): string => `cc05a11e-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
/** The fixture's items by kind (SOURCE). */
const ITEMS: Record<string, string> = {
  label: U(0x11a), global: U(0x11e), hierarchical: U(0x11f), directive: U(0x120), wire: U(0x112), bus: U(0x115), line: U(0x123),
  busEntry: U(0x116), junction: U(0x118), text: U(0x121), textbox: U(0x122), shape: U(0x140), ruleArea: U(0x141), image: U(0x144),
  sheet: U(0x150), sheetPin: U(0x151), table: U(0x12f), tableCell: U(0x130), group: U(0x160),
};
const NO_CONNECT = U(0x119);
const E: Key = { key: 'e', code: 'KeyE' };
const ESC: Key = { key: 'Escape', code: 'Escape' };
const UNDO: Key = { key: 'z', code: 'KeyZ', ctrl: true };
/** eeschema's internal units per millimeter. */
const IU_PER_MM = 1e4;
/** An 8 by 8 PNG. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR42mM4YSOHFTEMLQkAfuxIgRXblWMAAAAASUVORK5CYII=';

const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const of = async (page: Page, type: string): Promise<Ev[]> => (await events(page)).filter((e) => e.type === type);
const request = (page: Page, op: string, args?: unknown): Promise<Record<string, unknown>> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const);
const refusal = (page: Page, op: string, args?: unknown): Promise<string> =>
  request(page, op, args).then(() => 'ok', (err: Error) => err.message.split('\n')[0].replace(/^.*?page\.evaluate:\s*/, '').replace(/^Error:\s*/, ''));
const strip = (e: Ev): Omit<Ev, 'at'> => { const { at: _at, ...rest } = e; void _at; return rest; };
const islandFrame = (page: Page): Frame | null => page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null;
/** sch.image.place, the PNG made into bytes in the page (a Uint8Array crosses to the island). */
const placeImage = (page: Page, name: string, b64: string): Promise<string> => page.evaluate(([n, b]) => {
  const bytes = Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
  return (window as unknown as Harness).__bridge.request('sch.image.place', { name: n, bytes }).then(() => 'ok', (err: Error) => err.message);
}, [name, b64] as const);

async function boot(page: Page, frame: 'sch' | 'pcb'): Promise<string[]> {
  await page.goto(`/parent.html?fixture=${FIXTURE}&frame=${frame}`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  expect((await of(page, 'ev.state')).filter((e) => e.phase === 'fatal' || e.phase === 'blocked')).toEqual([]);
  return (await of(page, 'ev.ready'))[0]?.caps ?? [];
}
/** Boots a sch frame on the fixture, skipping on an engine without the item exports. */
async function bootRun15(page: Page, need = 'schItem'): Promise<Frame> {
  const caps = await boot(page, 'sch');
  test.skip(!caps.includes(need), RUN15);
  test.skip(!caps.includes('schItem'), RUN15);
  await expect(page.locator('#state')).toContainText('opened items-sch.kicad_sch', { timeout: 120_000 });
  await page.waitForTimeout(1_500);   // ev.edited's baseline
  const frame = islandFrame(page);
  test.skip(frame == null, 'the island frame is out of Playwright\'s reach in this browser');
  return frame as Frame;
}
const depth = (frame: Frame): Promise<number> => frame.evaluate(() => Number((window as unknown as Engine).Module.kicadCollabTestUndoDepth()));
const run = (frame: Frame, name: string): Promise<unknown> => frame.evaluate((n) => (window as unknown as Engine).Module.kicadRunAction(n), name);
const get = async (page: Page, uuids: string[]): Promise<Rec[]> => (await request(page, 'sch.item.get', { items: uuids.map((uuid) => ({ uuid, sheetPath: '' })) })).items as Rec[];
const one = async (page: Page, uuid: string): Promise<Rec> => (await get(page, [uuid]))[0];
const near = (a: unknown, b: unknown): boolean => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-3
  : Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((x, i) => near(x, b[i]))
    : typeof a === 'object' && a !== null && typeof b === 'object' && b !== null ? Object.keys(a).every((k) => near((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
      : a === b);
async function selectOnly(page: Page, uuid: string): Promise<void> {
  expect(await request(page, 'select', { uuids: [uuid] })).toEqual({});
  await expect.poll(async () => (await of(page, 'ev.selected')).at(-1)?.uuids, { timeout: 5_000 }).toEqual([uuid]);
}
/** Does `act` and answers the ev.schItem it sent: exactly one, and no KiCad window (no ev.menu) within a second after. */
async function askFor(page: Page, act: () => Promise<unknown>, what: string): Promise<Omit<Ev, 'at'>> {
  const n = (await of(page, 'ev.schItem')).length;
  const menus = (await of(page, 'ev.menu')).length;
  await act();
  await expect.poll(async () => (await of(page, 'ev.schItem')).length, { timeout: 5_000, message: `${what} asks the page` }).toBe(n + 1);
  await page.waitForTimeout(1_000);
  expect((await of(page, 'ev.schItem')).length, `${what} asks once`).toBe(n + 1);
  expect((await of(page, 'ev.menu')).length, `${what} opens no window`).toBe(menus);
  return strip((await of(page, 'ev.schItem')).at(-1) as Ev);
}
/** The page's point of a schematic position in mm, read from the engine's viewport; else a point near the canvas's lower right. */
async function pointOf(page: Page, frame: Frame, x: number, y: number): Promise<[number, number]> {
  const raw = await frame.evaluate(() => {
    const m = (window as unknown as Engine).Module;
    return typeof m.kicadCollabGetViewport === 'function' ? String(m.kicadCollabGetViewport()) : '';
  });
  const box = await page.locator('iframe').boundingBox();
  if (raw === '' || box == null) return [(box?.x ?? 0) + (box?.width ?? 800) - 80, (box?.y ?? 0) + (box?.height ?? 600) - 80];
  const v = JSON.parse(raw) as { cx: number; cy: number; scale: number; w: number; h: number };
  const canvas = await frame.evaluate(() => {
    const all = [...document.querySelectorAll('canvas')].map((c) => c.getBoundingClientRect()).sort((a, b) => b.width * b.height - a.width * a.height);
    return { left: all[0].left, top: all[0].top };
  });
  return [box.x + canvas.left + v.w / 2 + (x * IU_PER_MM - v.cx) * v.scale, box.y + canvas.top + v.h / 2 + (y * IU_PER_MM - v.cy) * v.scale];
}

test('run 14 or 15, sch frame: schItem and schImagePlace follow their exports; without them each op answers unsupported naming its export; bad args first', async ({ page }) => {
  const caps = await boot(page, 'sch');
  expect(caps.includes('schItem')).toBe(ITEM_EXPORTS.every((n) => caps.includes(n)));
  expect(caps.includes('schImagePlace')).toBe(IMAGE_EXPORTS.every((n) => caps.includes(n)));
  const anItem = { items: [{ uuid: ITEMS.label, sheetPath: '' }] };
  if (!caps.includes('schItem')) {
    expect(await refusal(page, 'sch.item.get', anItem)).toBe('unsupported: kicadSchItemGet');
    expect(await refusal(page, 'sch.item.set', { ...anItem, kind: 'label', set: { bold: true } })).toBe('unsupported: kicadSchItemGet');
    const island = islandFrame(page);
    if (island != null) expect(await island.evaluate(() => 'kicadHostSchItem' in window)).toBe(false);
  }
  if (!caps.includes('schImagePlace')) expect(await placeImage(page, 'a.png', PNG)).toContain('unsupported: kicadSchPlaceImage');
  for (const [op, bad] of [['sch.item.get', { items: [] }], ['sch.item.get', { items: [{ uuid: ITEMS.label }] }], ['sch.item.set', { ...anItem, kind: 'label', set: {} }],
    ['sch.item.set', { ...anItem, kind: 'table', set: { rows: 3 } }], ['sch.item.set', { ...anItem, kind: 'label', set: { bold: true }, fileMode: 'rename' }],
    ['sch.image.place', { name: 'a.png' }]] as const) {
    expect(await refusal(page, op, bad), JSON.stringify(bad)).toMatch(new RegExp(`^bad_args: ${op.replace(/\./g, '\\.')}`));
  }
});

test('run 14 or 15, pcb frame: neither cap is listed and every op is refused', async ({ page }) => {
  const caps = await boot(page, 'pcb');
  expect(caps).not.toContain('schItem');
  expect(caps).not.toContain('schImagePlace');
  expect(await refusal(page, 'sch.item.get', { items: [{ uuid: ITEMS.label, sheetPath: '' }] })).toBe('unsupported: a schematic edits in a sch frame');
  expect(await placeImage(page, 'a.png', PNG)).toContain('unsupported: a schematic edits in a sch frame');
});

test('run 15: every kind reads; one set per key reads back as one undo step that one Ctrl+Z restores', async ({ page }) => {
  const frame = await bootRun15(page);
  const all = await get(page, [...Object.values(ITEMS), U(0xfff)]);
  expect(all.map((r) => r.uuid), 'every item in the order asked, the unknown left out').toEqual(Object.values(ITEMS));
  expect(new Set(all.map((r) => r.kind))).toEqual(new Set(['label', 'wire', 'line', 'busEntry', 'junction', 'text', 'textbox', 'shape', 'ruleArea', 'image', 'sheet', 'sheetPin', 'table', 'tableCell', 'group']));
  const byUuid = new Map(all.map((r) => [r.uuid, r]));
  expect(byUuid.get(ITEMS.global)).toMatchObject({ labelKind: 'global', text: 'GOUT', shape: 'input' });
  expect((byUuid.get(ITEMS.global)?.fields as Array<{ name: string }>).map((f) => f.name)).toContain('Intersheetrefs');
  expect(byUuid.get(ITEMS.directive)).toMatchObject({ labelKind: 'directive', shape: 'round' });
  expect(byUuid.get(ITEMS.bus)).toMatchObject({ kind: 'wire', bus: true });
  expect(byUuid.get(ITEMS.sheet)).toMatchObject({ name: 'sub', file: 'sub.kicad_sch', page: '2', pins: 1 });
  expect(byUuid.get(ITEMS.table)).toMatchObject({ rows: 2, cols: 2, cells: [['A', 'B'], ['C', '']] });
  expect(byUuid.get(ITEMS.group)).toMatchObject({ name: 'Pair', members: 2 });
  expect(byUuid.get(ITEMS.image)?.bytes).toBeGreaterThan(0);

  const SETS: Array<[string, string, Record<string, unknown>]> = [
    ['label', ITEMS.label, { text: 'IN2' }], ['label', ITEMS.label, { size: 2.54 }], ['label', ITEMS.label, { bold: true }], ['label', ITEMS.label, { italic: true }],
    ['label', ITEMS.label, { orientation: 'up' }], ['label', ITEMS.label, { color: '#ff0000ff' }], ['label', ITEMS.label, { x: 78.74 }],
    ['label', ITEMS.global, { shape: 'output' }], ['label', ITEMS.directive, { shape: 'diamond' }], ['label', ITEMS.directive, { pinLength: 3.81 }],
    ['label', ITEMS.directive, { fields: [{ name: 'Netclass', value: 'Power' }] }],
    ['wire', ITEMS.wire, { width: 0.3 }], ['wire', ITEMS.wire, { style: 'dot' }], ['wire', ITEMS.wire, { color: '#00ff00ff' }], ['wire', ITEMS.wire, { points: [[63.5, 50.8], [78.74, 50.8]] }],
    ['line', ITEMS.line, { style: 'solid' }], ['line', ITEMS.line, { width: 0.5 }],
    ['busEntry', ITEMS.busEntry, { width: 0.25 }], ['busEntry', ITEMS.busEntry, { style: 'dash' }],
    ['junction', ITEMS.junction, { diameter: 1.27 }], ['junction', ITEMS.junction, { color: '#0000ffff' }],
    ['text', ITEMS.text, { text: 'Changed' }], ['text', ITEMS.text, { size: 2.54 }], ['text', ITEMS.text, { color: '#ff0000ff' }],
    ['textbox', ITEMS.textbox, { text: 'Changed' }], ['textbox', ITEMS.textbox, { margins: [1.27, 1.27, 1.27, 1.27] }],
    ['shape', ITEMS.shape, { stroke: { width: 0.3, style: 'dash', color: '' } }], ['shape', ITEMS.shape, { fill: { type: 'color', color: '#ffff00ff' } }],
    ['ruleArea', ITEMS.ruleArea, { stroke: { width: 0.2, style: 'dot', color: '' } }],
    ['image', ITEMS.image, { scale: 2 }], ['image', ITEMS.image, { x: 130.81 }],
    ['sheet', ITEMS.sheet, { name: 'renamed' }], ['sheet', ITEMS.sheet, { page: '7' }], ['sheet', ITEMS.sheet, { size: [30.48, 20.32] }],
    ['sheet', ITEMS.sheet, { borderWidth: 0.3 }], ['sheet', ITEMS.sheet, { fillColor: '#ffffffff' }], ['sheet', ITEMS.sheet, { dnp: true }], ['sheet', ITEMS.sheet, { inBom: false }],
    ['sheet', ITEMS.sheet, { fields: [{ name: 'Note', value: 'x', visible: true }] }],
    ['sheetPin', ITEMS.sheetPin, { shape: 'output' }], ['sheetPin', ITEMS.sheetPin, { size: 2.54 }],
    ['group', ITEMS.group, { name: 'Couple' }],
  ];
  for (const [kind, uuid, set] of SETS) {
    const what = `${kind} ${JSON.stringify(set)}`;
    const before = await one(page, uuid);
    const d0 = await depth(frame);
    const edits = (await of(page, 'ev.edited')).length;
    const got = await request(page, 'sch.item.set', { items: [{ uuid, sheetPath: '' }], kind, set });
    const after = (got.items as Rec[])[0];
    for (const [k, v] of Object.entries(set)) {
      if (k === 'fields') for (const f of v as Array<Record<string, unknown>>) expect((after.fields as Array<Record<string, unknown>>).find((x) => x.name === f.name), what).toMatchObject(f);
      else expect(near(after[k], v), `${what} reads back`).toBe(true);
    }
    expect(await depth(frame), `${what} is one undo step`).toBe(d0 + 1);
    await expect.poll(async () => (await of(page, 'ev.edited')).length, { timeout: 5_000 }).toBe(edits + 1);
    expect(await request(page, 'key.press', UNDO)).toEqual({});
    await expect.poll(() => depth(frame), { timeout: 5_000 }).toBe(d0);
    expect(near(await one(page, uuid), before), `${what}: Ctrl+Z restores it`).toBe(true);
  }
  // Read only and misfit sets refuse before anything changes.
  const d0 = await depth(frame);
  expect(await refusal(page, 'sch.item.set', { items: [{ uuid: ITEMS.table, sheetPath: '' }], kind: 'table', set: { rows: 3 } })).toBe('bad_args: sch.item.set: a table is read only here');
  expect(await refusal(page, 'sch.item.set', { items: [{ uuid: ITEMS.label, sheetPath: '' }], kind: 'label', set: { shape: 'input' } })).toBe('bad_args: sch.item.set: a local label takes no shape');
  expect(await refusal(page, 'sch.item.set', { items: [{ uuid: ITEMS.label, sheetPath: '' }], kind: 'wire', set: { width: 1 } })).toBe('bad_args: sch.item.set: the items are of more than one kind');
  expect(await refusal(page, 'sch.item.set', { items: [{ uuid: U(0xfff), sheetPath: '' }], kind: 'wire', set: { width: 1 } })).toBe(`not_found: ${U(0xfff)}`);
  expect(await depth(frame)).toBe(d0);
  const left = await frame.evaluate(() => { const { FS } = window as unknown as Engine; return FS.analyzePath('/tmp/cc-schitems').exists ? FS.readdir('/tmp/cc-schitems').filter((n) => n !== '.' && n !== '..') : []; });
  expect(left, 'no run folder is left').toEqual([]);
});

test('run 15: a local label made global keeps its place under a new uuid; one Ctrl+Z brings the local label back', async ({ page }) => {
  const frame = await bootRun15(page);
  const before = await one(page, ITEMS.label);
  const d0 = await depth(frame);
  const got = await request(page, 'sch.item.set', { items: [{ uuid: ITEMS.label, sheetPath: '' }], kind: 'label', set: { labelKind: 'global', shape: 'bidirectional' } });
  const replaced = got.replaced as Array<{ from: string; to: string }>;
  expect(replaced).toHaveLength(1);
  expect(replaced[0].from).toBe(ITEMS.label);
  expect((got.items as Rec[])[0]).toMatchObject({ uuid: replaced[0].to, labelKind: 'global', shape: 'bidirectional', text: before.text, x: before.x, y: before.y });
  expect(await depth(frame)).toBe(d0 + 1);
  expect(await request(page, 'key.press', UNDO)).toEqual({});
  await expect.poll(() => depth(frame), { timeout: 5_000 }).toBe(d0);
  expect(await one(page, ITEMS.label)).toMatchObject({ labelKind: 'local', text: before.text });
});

test('run 15: a sheet file renamed writes the new file and keeps the old; a file that exists needs fileMode; useExisting links it', async ({ page }) => {
  const frame = await bootRun15(page);
  const sheet = [{ uuid: ITEMS.sheet, sheetPath: '' }];
  const files = (): Promise<string[]> => frame.evaluate(() => (window as unknown as Engine).FS.readdir('/project'));
  expect(await refusal(page, 'sch.item.set', { items: sheet, kind: 'sheet', set: { file: 'spare.kicad_sch' } })).toBe('bad_args: fileMode is required: the file exists');
  const renamed = await request(page, 'sch.item.set', { items: sheet, kind: 'sheet', set: { file: 'renamed.kicad_sch' } });
  expect(renamed.renamed).toEqual([{ from: 'sub.kicad_sch', to: 'renamed.kicad_sch' }]);
  expect((renamed.items as Rec[])[0]).toMatchObject({ file: 'renamed.kicad_sch' });
  expect(await files()).toEqual(expect.arrayContaining(['sub.kicad_sch', 'renamed.kicad_sch']));
  const linked = await request(page, 'sch.item.set', { items: sheet, kind: 'sheet', set: { file: 'spare.kicad_sch' }, fileMode: 'useExisting' });
  expect(linked.renamed).toEqual([{ from: 'renamed.kicad_sch', to: 'spare.kicad_sch' }]);
  expect((linked.items as Rec[])[0]).toMatchObject({ file: 'spare.kicad_sch' });
});

test('run 15: E on each kind asks the page once with no window; a no connect asks nothing', async ({ page }) => {
  await bootRun15(page);
  const asked: Array<[string, string]> = [
    ['label', ITEMS.label], ['label', ITEMS.global], ['label', ITEMS.hierarchical], ['label', ITEMS.directive], ['wire', ITEMS.wire], ['wire', ITEMS.bus],
    ['line', ITEMS.line], ['busEntry', ITEMS.busEntry], ['junction', ITEMS.junction], ['text', ITEMS.text], ['textbox', ITEMS.textbox], ['shape', ITEMS.shape],
    ['ruleArea', ITEMS.ruleArea], ['image', ITEMS.image], ['sheet', ITEMS.sheet], ['sheetPin', ITEMS.sheetPin], ['group', ITEMS.group],
  ];
  for (const [kind, uuid] of asked) {
    await selectOnly(page, uuid);
    expect(await askFor(page, () => request(page, 'key.press', E), `E on a ${kind}`)).toEqual({ type: 'ev.schItem', kind, uuid, sheetPath: '/', isNew: false });
    expect((await of(page, 'ev.selected')).at(-1)?.uuids, `the ${kind} stays selected`).toEqual([uuid]);
  }
  await selectOnly(page, NO_CONNECT);
  const n = (await of(page, 'ev.schItem')).length;
  const menus = (await of(page, 'ev.menu')).length;
  expect(await request(page, 'key.press', E)).toEqual({});
  await page.waitForTimeout(1_500);
  expect((await of(page, 'ev.schItem')).length, 'a no connect asks nothing').toBe(n);
  expect((await of(page, 'ev.menu')).length, 'a no connect opens nothing').toBe(menus);
});

test('run 15: a new label, text, text box and sheet ask with isNew and go down with KiCad\'s defaults; the picture tool asks and ends', async ({ page }) => {
  const frame = await bootRun15(page);
  const [x, y] = await pointOf(page, frame, 101.6, 152.4);
  const label = await askFor(page, async () => { await run(frame, 'eeschema.InteractiveDrawing.placeLabel'); await page.mouse.click(x, y); }, 'the label tool');
  expect(label).toMatchObject({ kind: 'label', isNew: true, sheetPath: '/' });
  await request(page, 'key.press', ESC);
  expect(await one(page, label.uuid as string)).toMatchObject({ labelKind: 'local' });
  const text = await askFor(page, async () => { await run(frame, 'eeschema.InteractiveDrawing.placeSchematicText'); await page.mouse.click(x + 60, y); }, 'the text tool');
  expect(text).toMatchObject({ kind: 'text', isNew: true });
  await request(page, 'key.press', ESC);
  expect(await one(page, text.uuid as string)).toMatchObject({ kind: 'text', text: 'Text' });
  const [bx, by] = await pointOf(page, frame, 101.6, 165.1);
  const box = await askFor(page, async () => { await run(frame, 'eeschema.InteractiveDrawing.drawTextBox'); await page.mouse.click(bx, by); await page.mouse.click(bx + 80, by + 30); }, 'the text box tool');
  expect(box).toMatchObject({ kind: 'textbox', isNew: true });
  await request(page, 'key.press', ESC);
  expect(await one(page, box.uuid as string)).toMatchObject({ kind: 'textbox', text: '' });
  const [sx, sy] = await pointOf(page, frame, 203.2, 101.6);
  const sheet = await askFor(page, async () => { await run(frame, 'eeschema.InteractiveDrawing.drawSheet'); await page.mouse.click(sx, sy); await page.mouse.click(sx + 80, sy + 60); }, 'the sheet tool');
  expect(sheet).toMatchObject({ kind: 'sheet', isNew: true });
  await request(page, 'key.press', ESC);
  expect((await one(page, sheet.uuid as string)).file).toMatch(/\.kicad_sch$/);
  const d = await depth(frame);
  const image = await askFor(page, async () => { await run(frame, 'eeschema.InteractiveDrawing.placeImage'); await page.mouse.click(x, y + 40); }, 'the picture tool');
  expect(image).toEqual({ type: 'ev.schItem', kind: 'image', uuid: '00000000-0000-0000-0000-000000000000', sheetPath: '/', isNew: true });
  expect(await depth(frame), 'a held picture places nothing').toBe(d);
});

test('run 15: sch.image.place hangs a PNG on the pointer; every gated op is busy until a click places it as one undo step', async ({ page }) => {
  const island = await bootRun15(page, 'schImagePlace');
  const d0 = await depth(island);
  expect(await placeImage(page, 'logo.png', PNG)).toBe('ok');
  expect(await refusal(page, 'sch.item.get', { items: [{ uuid: ITEMS.label, sheetPath: '' }] })).toMatch(/^busy: /);
  const [x, y] = await pointOf(page, island, 101.6, 177.8);
  await page.mouse.move(x, y);
  await page.mouse.click(x, y);
  await expect.poll(() => depth(island), { timeout: 5_000 }).toBe(d0 + 1);
  await expect.poll(async () => refusal(page, 'sch.item.get', { items: [{ uuid: ITEMS.label, sheetPath: '' }] }), { timeout: 5_000 }).toBe('ok');
  expect(await placeImage(page, 'bad.png', 'AAAA')).toContain('bad_args: sch.image.place');
});
