// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// m1-i over the local pair (PROTOCOL.md, Our context menu) on the
// canvas-kinds fixture (unit m1-fx). On engine run 14 the engine has none of
// K-MENU's exports: the cap contextMenu is absent, the three ops are listed in
// island.json and answer unsupported naming the export (action.run refuses a
// held action first), the frame's slot answers falsy, and KiCad's own popup
// still shows and closes as before. The recipe's run 15 steps wait for engine
// run 15 (kicad cc/main K-MENU, pcbjam kicadHostContextMenu) and are skipped
// here with the export they wait for.
import { expect, test, type Frame, type Page } from '@playwright/test';

import { ISLAND } from '../ports';

interface Item { id: number; type: string; action: string; label: string; enabled: boolean; door: string; items?: Item[] }
interface Ev { type: string; open?: boolean; caps?: string[]; token?: number; reason?: string; items?: Item[]; omitted?: string[]; clarify?: boolean; frame?: string; depth?: number; phase?: string; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
type Answer = { ok?: boolean; error?: { code: string; message: string } } & Record<string, unknown>;

const FIXTURE = 'canvas-kinds';
const R1 = 'cc0ca4d5-0000-4000-8000-000000000101';
const RUN15 = 'waits for the engine exports kicadHostContextMenu, kicadContextMenuChoose, kicadContextMenuHighlight and kicadRunAction (engine run 15, kicad cc/main K-MENU)';
const OPS = ['contextMenu.choose', 'contextMenu.highlight', 'action.run'];

const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const of = async (page: Page, type: string): Promise<Ev[]> => (await events(page)).filter((e) => e.type === type);
/** The bridge's answer, or its refusal as { error }. */
const request = (page: Page, op: string, args?: unknown): Promise<Answer> =>
  page.evaluate(async ([o, a]) => {
    try { return await (window as unknown as Harness).__bridge.request(o as string, a); } catch (e) {
      // The harness rejects with "<code>: <message>".
      const m = /^([a-z_]+): ([\s\S]*)$/.exec(String((e as { message?: string }).message ?? e));
      return { error: { code: m?.[1] ?? 'thrown', message: m?.[2] ?? String(e) } };
    }
  }, [op, args] as const);
const islandFrame = (page: Page): Frame | null => page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null;

async function open(page: Page, frame: 'sch' | 'pcb'): Promise<string[]> {
  await page.goto(`/parent.html?frame=${frame}&fixture=${FIXTURE}`);
  await page.waitForFunction(() => /opened |open failed|state (blocked|fatal)/.test(document.getElementById('state')?.textContent ?? ''), null, { timeout: 170_000 });
  expect(await page.textContent('#state')).toContain(`opened ${FIXTURE}.kicad_${frame}`);
  await page.waitForTimeout(1_500);
  return (await of(page, 'ev.ready'))[0]?.caps ?? [];
}

/** The drawing canvas's center, in the page's coordinates. */
async function canvasCenter(page: Page): Promise<{ x: number; y: number }> {
  const frame = islandFrame(page);
  const box = await page.locator('iframe').boundingBox();
  if (frame == null || box == null) throw new Error('no island frame');
  const c = await frame.evaluate(() => {
    const all = [...document.querySelectorAll('canvas')].filter((e) => e.getBoundingClientRect().width > 0);
    all.sort((a, b) => b.width * b.height - a.width * a.height);
    const r = all[0]?.getBoundingClientRect();
    return r == null ? null : { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (c == null) throw new Error('no drawing canvas');
  return { x: box.x + c.x, y: box.y + c.y };
}

/** R1 selected and zoomed to, then a right click on it. */
async function rightClickR1(page: Page): Promise<void> {
  expect(await request(page, 'select', { uuids: [R1], zoom: true })).toEqual({});
  await page.waitForTimeout(600);
  const at = await canvasCenter(page);
  await page.mouse.click(at.x, at.y, { button: 'right' });
}

/** Every item of a menu, submenus walked. */
const flat = (items: readonly Item[]): Item[] => items.flatMap((i) => [i, ...flat(i.items ?? [])]);

test.describe('engine run 14: the ops are listed and refuse cleanly, nothing else changes', () => {
  test('island.json lists the three ops', async ({ page }) => {
    const res = await page.goto(`${ISLAND}/island.json`);
    const island = (await res!.json()) as { ops?: string[] };
    for (const op of OPS) expect(island.ops ?? []).toContain(op);
  });

  test('a sch frame: no contextMenu cap, the ops answer unsupported, the slot answers falsy, KiCad\'s popup still opens and closes', async ({ page }) => {
    const caps = await open(page, 'sch');
    test.skip(caps.includes('contextMenu'), 'this engine has K-MENU: the run 15 tests below cover it');
    expect(await request(page, 'action.run', { name: 'common.Control.zoomFitScreen' })).toEqual({ error: { code: 'unsupported', message: 'kicadRunAction' } });
    expect(await request(page, 'action.run', { name: 'no' })).toEqual({ error: { code: 'bad_args', message: 'action.run' } });
    expect(await request(page, 'contextMenu.choose', { token: 1, id: -1 })).toEqual({ error: { code: 'unsupported', message: 'kicadContextMenuChoose' } });
    expect(await request(page, 'contextMenu.highlight', { token: 1, id: 1 })).toEqual({ error: { code: 'unsupported', message: 'kicadContextMenuHighlight' } });
    const frame = islandFrame(page);
    expect(await frame!.evaluate(() => (window as unknown as { kicadHostMenu?: { onMenu?: (j: unknown) => boolean } }).kicadHostMenu?.onMenu?.('{}'))).toBe(false);
    // KiCad's own popup, reported as before.
    const menus = (await of(page, 'ev.menu')).length;
    await rightClickR1(page);
    await expect.poll(async () => (await of(page, 'ev.menu')).slice(menus).some((e) => e.open === true), { timeout: 10_000 }).toBe(true);
    expect(await request(page, 'key.press', { key: 'Home', code: 'Home' })).toEqual({ error: { code: 'busy', message: 'key.press' } });
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await of(page, 'ev.menu')).at(-1)?.open, { timeout: 10_000 }).toBe(false);
    expect(await of(page, 'ev.contextMenu')).toEqual([]);
    expect(await request(page, 'view.fit')).toEqual({});
  });

  test('a pcb frame: action.run refuses a held action before the engine', async ({ page }) => {
    const caps = await open(page, 'pcb');
    test.skip(!caps.includes('drc'), 'this engine lists no drc cap: runDRC is not held here');
    expect(await request(page, 'action.run', { name: 'pcbnew.DRCTool.runDRC' })).toEqual({ error: { code: 'held', message: 'pcbnew.DRCTool.runDRC' } });
  });
});

test.describe('engine run 15: our context menu', () => {
  test('a right click on R1 sends one ev.contextMenu, a choice turns R1, a cancel edits nothing', async ({ page }) => {
    const caps = await open(page, 'sch');
    test.skip(!caps.includes('contextMenu'), RUN15);
    await rightClickR1(page);
    await expect.poll(async () => (await of(page, 'ev.contextMenu')).length, { timeout: 10_000 }).toBe(1);
    const [menu] = await of(page, 'ev.contextMenu');
    expect(menu.frame).toBe('sch');
    expect(menu.clarify).toBe(false);
    const items = flat(menu.items ?? []);
    expect(items.some((i) => i.type === 'action')).toBe(true);
    expect(items.some((i) => i.type === 'submenu')).toBe(true);
    // Separators collapsed: none first, last or doubled, at any level.
    const check = (list: readonly Item[]): void => {
      expect(list[0]?.type).not.toBe('separator');
      expect(list.at(-1)?.type).not.toBe('separator');
      list.forEach((i, n) => { if (i.type === 'separator') expect(list[n + 1]?.type).not.toBe('separator'); if (i.items) check(i.items); });
    };
    check(menu.items ?? []);
    for (const a of menu.omitted ?? []) expect(items.some((i) => i.action === a)).toBe(false);
    // key.press while it is up: busy.
    expect(await request(page, 'key.press', { key: 'Home', code: 'Home' })).toEqual({ error: { code: 'busy', message: 'key.press' } });
    const rotate = items.find((i) => i.action === 'eeschema.InteractiveEdit.rotateCCW');
    expect(rotate).toBeDefined();
    const edited = (await of(page, 'ev.edited')).length;
    expect(await request(page, 'contextMenu.choose', { token: menu.token, id: rotate!.id })).toEqual({});
    await expect.poll(async () => (await of(page, 'ev.edited')).length - edited, { timeout: 10_000 }).toBe(1);
    expect(await of(page, 'ev.contextMenuEnd')).toEqual([]);
    // A second menu closed with -1: no edit.
    await rightClickR1(page);
    await expect.poll(async () => (await of(page, 'ev.contextMenu')).length, { timeout: 10_000 }).toBe(2);
    const second = (await of(page, 'ev.contextMenu'))[1];
    const before = (await of(page, 'ev.edited')).length;
    expect(await request(page, 'contextMenu.choose', { token: second.token, id: -1 })).toEqual({});
    await page.waitForTimeout(1_500);
    expect((await of(page, 'ev.edited')).length).toBe(before);
    expect(await of(page, 'ev.menu')).toEqual(expect.not.arrayContaining([expect.objectContaining({ open: true })]));
  });

  test('a press in the frame ends the menu canceled; a save ends it, then saves', async ({ page }) => {
    const caps = await open(page, 'sch');
    test.skip(!caps.includes('contextMenu'), RUN15);
    await rightClickR1(page);
    await expect.poll(async () => (await of(page, 'ev.contextMenu')).length, { timeout: 10_000 }).toBe(1);
    const box = (await page.locator('iframe').boundingBox())!;
    await page.mouse.click(box.x + 20, box.y + 20);
    await expect.poll(async () => (await of(page, 'ev.contextMenuEnd')).at(-1)?.reason, { timeout: 10_000 }).toBe('canceled');
    await rightClickR1(page);
    await expect.poll(async () => (await of(page, 'ev.contextMenu')).length, { timeout: 10_000 }).toBe(2);
    const saved = await request(page, 'project.save');
    expect(saved.error).toBeUndefined();
    const ends = await of(page, 'ev.contextMenuEnd');
    expect(ends).toHaveLength(2);
    expect(ends[1].reason).toBe('canceled');
  });

  test('action.run: a held action, an unknown name; Shift+F10 opens the keyboard menu', async ({ page }) => {
    const caps = await open(page, 'pcb');
    test.skip(!caps.includes('contextMenu'), RUN15);
    expect(await request(page, 'action.run', { name: 'pcbnew.DRCTool.runDRC' })).toEqual({ error: { code: 'held', message: 'pcbnew.DRCTool.runDRC' } });
    expect(await request(page, 'action.run', { name: 'no.Such.thing' })).toEqual({ error: { code: 'unknown_action', message: 'no.Such.thing' } });
    const at = await canvasCenter(page);
    await page.mouse.click(at.x, at.y);
    await page.keyboard.press('Shift+F10');
    await expect.poll(async () => (await of(page, 'ev.contextMenu')).length, { timeout: 10_000 }).toBe(1);
    const [menu] = await of(page, 'ev.contextMenu');
    expect(menu.frame).toBe('pcb');
    expect(await request(page, 'contextMenu.choose', { token: menu.token, id: -1 })).toEqual({});
  });

  test('the symbol editor\'s right click sends one too', async ({ page }) => {
    await page.goto('/parent.html?frame=symedit');
    await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready'), null, { timeout: 170_000 });
    const caps = (await of(page, 'ev.ready'))[0]?.caps ?? [];
    test.skip(!caps.includes('contextMenu'), RUN15);
    const opened = await request(page, 'symedit.new', { name: 'M1_PROBE', lib: 'm1', discard: true });
    expect(opened.error).toBeUndefined();
    const at = await canvasCenter(page);
    await page.mouse.click(at.x, at.y, { button: 'right' });
    await expect.poll(async () => (await of(page, 'ev.contextMenu')).length, { timeout: 10_000 }).toBe(1);
    expect((await of(page, 'ev.contextMenu'))[0].frame).toBe('symedit');
  });
});
