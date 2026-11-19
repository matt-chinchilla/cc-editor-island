// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-links-i over the local pair (PROTOCOL.md, Show Footprint Associations
// held) on the Glasgow fixture: in a pcb frame whose ev.ready listed
// boardFootprints, KiCad's Show Footprint Associations is taken by the frame's
// slot and sent as ev.held { action } once, action.run of it answers held, and
// no window of KiCad's opens; a sch frame leaves it to KiCad. On engine run 15
// (island cc25, K-HOLD: heldMenus) the menu path Inspect > Show Footprint
// Associations sends ev.held and opens nothing.
import { expect, test, type Frame, type Page } from '@playwright/test';

import { ISLAND } from '../ports';

interface Ev { type: string; open?: boolean; action?: string; caps?: string[]; phase?: string; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface ToolWindowLike { wxElementRegistry: { findAll(f: object): Array<{ typeName: string; name: string }> }; kicadHostAction?: { onRequest?: (json: unknown) => boolean } }
type Answer = { error?: { code: string; message: string } } & Record<string, unknown>;

const ACTION = 'pcbnew.InspectionTool.ShowFootprintAssociations';
const CAP = 'boardFootprints';
const RUN15 = 'waits for the engine export kicadHeldMenus (engine run 15, kicad cc/main K-HOLD)';

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

async function open(page: Page, kind: 'sch' | 'pcb'): Promise<{ frame: Frame | null; caps: string[] }> {
  await page.goto(`/parent.html?fixture=glasgow&frame=${kind}`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  await expect(page.locator('#state')).toContainText(`opened glasgow.kicad_${kind}`, { timeout: 120_000 });
  await page.waitForTimeout(1_500);
  const caps = (await of(page, 'ev.ready'))[0]?.caps ?? [];
  return { frame: page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null, caps };
}

/** Asks the frame's slot as the engine does, and returns its answer and the ev.held sent for it, if any. */
async function ask(page: Page, frame: Frame, action: string): Promise<{ taken: boolean; sent: string | null }> {
  const n = (await of(page, 'ev.held')).length;
  const taken = await frame.evaluate((a) => (window as unknown as ToolWindowLike).kicadHostAction?.onRequest?.(JSON.stringify({ action: a })) === true, action);
  await page.waitForTimeout(300);
  const after = await of(page, 'ev.held');
  return { taken, sent: after.length > n ? after.at(-1)?.action ?? null : null };
}

/** KiCad's visible top level frames and dialogs. */
const windows = (frame: Frame): Promise<string[]> => frame.evaluate(() => (window as unknown as ToolWindowLike).wxElementRegistry.findAll({ visible: true }).filter((e) => /Frame|Dialog/.test(e.typeName)).map((e) => `${e.typeName}:${e.name}`).sort());

async function clickIn(page: Page, x: number, y: number): Promise<void> {
  const box = await page.locator('iframe').boundingBox();
  if (box == null) throw new Error('no iframe box');
  await page.mouse.click(box.x + x, box.y + y);
}
const domPoint = (frame: Frame, selector: string, text: string): Promise<[number, number] | null> =>
  frame.evaluate(([sel, t]) => {
    const el = [...document.querySelectorAll(sel)].find((e) => e.getBoundingClientRect().width > 0 && (e.textContent ?? '').trim().startsWith(t));
    if (el == null) return null;
    const r = el.getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2] as [number, number];
  }, [selector, text] as const);

test('pcb: the slot takes Show Footprint Associations under boardFootprints, action.run answers held, no KiCad window', async ({ page, browserName }) => {
  const { frame, caps } = await open(page, 'pcb');
  expect(caps).toContain('heldKeys');
  expect(caps).toContain(CAP);
  expect(await request(page, 'action.run', { name: ACTION })).toEqual({ error: { code: 'held', message: ACTION } });
  test.skip(frame == null, `${browserName}: the island frame is out of Playwright's reach, so its slot cannot be asked`);
  const before = await windows(frame!);
  expect(await ask(page, frame!, ACTION)).toEqual({ taken: true, sent: ACTION });
  // An action no row names stays KiCad's.
  expect(await ask(page, frame!, 'common.Control.zoomFitScreen')).toEqual({ taken: false, sent: null });
  expect(await windows(frame!)).toEqual(before);
  expect(await request(page, 'view.fit')).toEqual({});
});

test('sch: the action is never held in a schematic frame', async ({ page, browserName }) => {
  const { frame, caps } = await open(page, 'sch');
  expect(caps).toContain('heldKeys');
  expect(caps).not.toContain(CAP);
  test.skip(frame == null, `${browserName}: the island frame is out of Playwright's reach, so its slot cannot be asked`);
  expect(await ask(page, frame!, ACTION)).toEqual({ taken: false, sent: null });
});

test('run 15: Inspect > Show Footprint Associations sends ev.held and opens nothing', async ({ page, browserName }) => {
  const { frame, caps } = await open(page, 'pcb');
  test.skip(!caps.includes('heldMenus'), RUN15);
  test.skip(frame == null, `${browserName}: the island frame is out of Playwright's reach, so its menu cannot be found`);
  expect(await request(page, 'chrome.show', { on: true })).toEqual({});
  const before = await windows(frame!);
  const n = (await of(page, 'ev.held')).length;
  await expect.poll(() => domPoint(frame!, '.wx-menu-title', 'Inspect'), { timeout: 15_000, message: 'menu Inspect' }).not.toBeNull();
  await clickIn(page, ...(await domPoint(frame!, '.wx-menu-title', 'Inspect'))!);
  await expect.poll(() => domPoint(frame!, '.wx-menu-popup *', 'Show Footprint Associations'), { timeout: 10_000, message: 'item Show Footprint Associations' }).not.toBeNull();
  await clickIn(page, ...(await domPoint(frame!, '.wx-menu-popup *', 'Show Footprint Associations'))!);
  await expect.poll(async () => (await of(page, 'ev.held')).length, { timeout: 10_000, message: 'the menu item sends ev.held' }).toBe(n + 1);
  expect((await of(page, 'ev.held')).at(-1)?.action).toBe(ACTION);
  await page.waitForTimeout(1_500);
  expect((await of(page, 'ev.menu')).at(-1)?.open ?? false).toBe(false);
  expect(await windows(frame!)).toEqual(before);
  expect(await request(page, 'chrome.show', { on: false })).toEqual({});
});
