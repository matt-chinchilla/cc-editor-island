// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// lo-bulk-i over the local pair (PROTOCOL.md, Edit in bulk's doors) on the
// canvas-kinds fixture (unit m1-fx): KiCad's four Change and Update Symbol
// actions are held in a sch frame under symbolExchange, the four Change and
// Update Footprint actions in a pcb frame under footprintExchange and the Zone
// manager there under boardEdit. On every engine: the frame's slot takes each
// row in its own frame and sends ev.held { action } once, action.run of each
// answers held, and no window of KiCad's opens. On engine run 15 (island
// cc25, K-MENU and K-HOLD): a right click on a symbol, a footprint and a zone
// shows our context menu with the row as a held item, and choosing it sends
// ev.held with nothing of KiCad's shown.
import { expect, test, type Frame, type Page } from '@playwright/test';

import { ISLAND } from '../ports';

interface Item { id: number; type: string; action: string; door: string; items?: Item[] }
interface Ev { type: string; action?: string; caps?: string[]; token?: number; items?: Item[]; phase?: string; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface ToolWindowLike { wxElementRegistry: { findAll(f: object): Array<{ typeName: string; name: string }> }; kicadHostAction?: { onRequest?: (json: unknown) => boolean } }
type Answer = { error?: { code: string; message: string } } & Record<string, unknown>;

const FIXTURE = 'canvas-kinds';
const RUN15 = 'waits for engine run 15 (kicad cc/main K-MENU and K-HOLD: kicadHostContextMenu, kicadHeldMenus)';
/** The fixture's uuids (tests/fixtures/canvas-kinds/ids.json). */
const R1_SYMBOL = 'cc0ca4d5-0000-4000-8000-000000000101';
const R1_FOOTPRINT = 'cc0ca4d5-0000-4000-8000-000000000301';
const COPPER_ZONE = 'cc0ca4d5-0000-4000-8000-000000000320';

const SYMBOL_ACTIONS = [
  'eeschema.InteractiveEdit.changeSymbol',
  'eeschema.InteractiveEdit.changeSymbols',
  'eeschema.InteractiveEdit.updateSymbol',
  'eeschema.InteractiveEdit.updateSymbols',
];
const FOOTPRINT_ACTIONS = [
  'pcbnew.GlobalEdit.changeFootprint',
  'pcbnew.GlobalEdit.changeFootprints',
  'pcbnew.GlobalEdit.updateFootprint',
  'pcbnew.GlobalEdit.updateFootprints',
];
const ZONES_MANAGER = 'pcbnew.Control.zonesManager';
/** Each frame's rows and the cap each waits on. */
const ROWS: Record<'sch' | 'pcb', Array<[string, string]>> = {
  sch: SYMBOL_ACTIONS.map((a) => [a, 'symbolExchange']),
  pcb: [...FOOTPRINT_ACTIONS.map((a): [string, string] => [a, 'footprintExchange']), [ZONES_MANAGER, 'boardEdit']],
};

const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const of = async (page: Page, type: string): Promise<Ev[]> => (await events(page)).filter((e) => e.type === type);
/** The bridge's answer, or its refusal as { error }. */
const request = (page: Page, op: string, args?: unknown): Promise<Answer> =>
  page.evaluate(async ([o, a]) => {
    try { return await (window as unknown as Harness).__bridge.request(o as string, a); } catch (e) {
      const m = /^([a-z_]+): ([\s\S]*)$/.exec(String((e as { message?: string }).message ?? e));
      return { error: { code: m?.[1] ?? 'thrown', message: m?.[2] ?? String(e) } };
    }
  }, [op, args] as const);
const islandFrame = (page: Page): Frame | null => page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null;

async function open(page: Page, kind: 'sch' | 'pcb'): Promise<{ frame: Frame | null; caps: string[] }> {
  await page.goto(`/parent.html?frame=${kind}&fixture=${FIXTURE}`);
  await page.waitForFunction(() => /opened |open failed|state (blocked|fatal)/.test(document.getElementById('state')?.textContent ?? ''), null, { timeout: 170_000 });
  expect(await page.textContent('#state')).toContain(`opened ${FIXTURE}.kicad_${kind}`);
  await page.waitForTimeout(1_500);
  return { frame: islandFrame(page), caps: (await of(page, 'ev.ready'))[0]?.caps ?? [] };
}

/** KiCad's visible top level frames and dialogs. */
const windows = (frame: Frame): Promise<string[]> => frame.evaluate(() => (window as unknown as ToolWindowLike).wxElementRegistry.findAll({ visible: true }).filter((e) => /Frame|Dialog/.test(e.typeName)).map((e) => `${e.typeName}:${e.name}`).sort());

/** Asks the frame's slot as the engine does, and returns its answer and the ev.held sent for it, if any. */
async function ask(page: Page, frame: Frame, action: string): Promise<{ taken: boolean; sent: string | null }> {
  const n = (await of(page, 'ev.held')).length;
  const taken = await frame.evaluate((a) => (window as unknown as ToolWindowLike).kicadHostAction?.onRequest?.(JSON.stringify({ action: a })) === true, action);
  await page.waitForTimeout(300);
  const after = await of(page, 'ev.held');
  return { taken, sent: after.length > n ? after.at(-1)?.action ?? null : null };
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

/** Every item of a menu, submenus walked. */
const flat = (items: readonly Item[]): Item[] => items.flatMap((i) => [i, ...flat(i.items ?? [])]);

/** Selects `uuid` zoomed to it, right clicks it, chooses `action` from our menu: ev.held { action }, no KiCad window. */
async function chooseHeld(page: Page, frame: Frame, uuid: string, action: string): Promise<void> {
  const before = await windows(frame);
  const menus = (await of(page, 'ev.contextMenu')).length;
  const held = (await of(page, 'ev.held')).length;
  expect(await request(page, 'select', { uuids: [uuid], zoom: true })).toEqual({});
  await page.waitForTimeout(600);
  const at = await canvasCenter(page);
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await expect.poll(async () => (await of(page, 'ev.contextMenu')).length, { timeout: 10_000, message: `a menu for ${action}` }).toBe(menus + 1);
  const menu = (await of(page, 'ev.contextMenu')).at(-1)!;
  const item = flat(menu.items ?? []).find((i) => i.action === action);
  expect(item, `${action} in the menu`).toMatchObject({ door: 'held' });
  expect(await request(page, 'contextMenu.choose', { token: menu.token, id: item!.id })).toEqual({});
  await expect.poll(async () => (await of(page, 'ev.held')).length, { timeout: 10_000, message: `${action} sends ev.held` }).toBe(held + 1);
  expect((await of(page, 'ev.held')).at(-1)?.action).toBe(action);
  await page.waitForTimeout(1_500);
  expect(await windows(frame)).toEqual(before);
}

for (const kind of ['sch', 'pcb'] as const) {
  test(`${kind}: the slot takes each row in its frame under its cap, action.run answers held, no KiCad window`, async ({ page, browserName }) => {
    const { frame, caps } = await open(page, kind);
    expect(caps).toContain('heldKeys');
    for (const [, cap] of ROWS[kind]) expect(caps, `${kind} lists ${cap}`).toContain(cap);
    // action.run refuses a held action before it reaches the engine.
    for (const [action] of ROWS[kind]) expect(await request(page, 'action.run', { name: action }), action).toEqual({ error: { code: 'held', message: action } });
    test.skip(frame == null, `${browserName}: the island frame is out of Playwright's reach, so its slot cannot be asked`);
    const before = await windows(frame!);
    for (const [action] of ROWS[kind]) expect(await ask(page, frame!, action), action).toEqual({ taken: true, sent: action });
    // The other frame's rows stay KiCad's here.
    for (const [action] of ROWS[kind === 'sch' ? 'pcb' : 'sch']) expect(await ask(page, frame!, action), action).toEqual({ taken: false, sent: null });
    expect(await windows(frame!)).toEqual(before);
    expect(await request(page, 'view.fit')).toEqual({});
  });
}

test.describe('engine run 15: our context menu ends in ev.held', () => {
  test('sch: Change Symbol from a right click on R1', async ({ page, browserName }) => {
    const { frame, caps } = await open(page, 'sch');
    test.skip(!caps.includes('contextMenu') || !caps.includes('heldMenus'), RUN15);
    test.skip(frame == null, `${browserName}: the island frame is out of Playwright's reach`);
    await chooseHeld(page, frame!, R1_SYMBOL, 'eeschema.InteractiveEdit.changeSymbol');
    await chooseHeld(page, frame!, R1_SYMBOL, 'eeschema.InteractiveEdit.updateSymbol');
  });

  test('pcb: Change Footprint from a right click on R1, Zone manager from a right click on the copper zone', async ({ page, browserName }) => {
    const { frame, caps } = await open(page, 'pcb');
    test.skip(!caps.includes('contextMenu') || !caps.includes('heldMenus'), RUN15);
    test.skip(frame == null, `${browserName}: the island frame is out of Playwright's reach`);
    await chooseHeld(page, frame!, R1_FOOTPRINT, 'pcbnew.GlobalEdit.changeFootprint');
    await chooseHeld(page, frame!, R1_FOOTPRINT, 'pcbnew.GlobalEdit.updateFootprint');
    await chooseHeld(page, frame!, COPPER_ZONE, ZONES_MANAGER);
  });
});
