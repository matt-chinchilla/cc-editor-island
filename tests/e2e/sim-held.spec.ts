// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// island v0.2.3-cc23 over the local pair (PROTOCOL.md ev.held): KiCad's
// Inspect > Simulator, from its own menu with KiCad's chrome shown. Our engine
// (run 14, kicad cc/main K-SIM) asks the frame before it makes the Simulator
// window, from the menu, the toolbar and the key alike; the frame holds it
// under `sim` and sends ev.held, and no window of KiCad's opens.
import { expect, test, type Frame, type Page } from '@playwright/test';

import { ISLAND } from './ports';
interface Ev { type: string; open?: boolean; action?: string; caps?: string[]; phase?: string; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface ToolWindowLike { wxElementRegistry: { findAll(f: object): Array<{ typeName: string; name: string }> } }

const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const of = async (page: Page, type: string): Promise<Ev[]> => (await events(page)).filter((e) => e.type === type);
const request = (page: Page, op: string, args?: unknown): Promise<Record<string, unknown>> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const);

async function clickIn(page: Page, x: number, y: number): Promise<void> {
  const box = await page.locator('iframe').boundingBox();
  if (box == null) throw new Error('no iframe box');
  await page.mouse.click(box.x + x, box.y + y);
}
/** The center of the first DOM element under `selector` whose text starts with `text` (wx-dom.js draws the menu bar and its popups as DOM). */
const domPoint = (frame: Frame, selector: string, text: string): Promise<[number, number] | null> =>
  frame.evaluate(([sel, t]) => {
    const el = [...document.querySelectorAll(sel)].find((e) => (e.textContent ?? '').trim().startsWith(t));
    if (el == null) return null;
    const r = el.getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2] as [number, number];
  }, [selector, text] as const);
/** The names of KiCad's visible top level frames. */
const frames = (frame: Frame): Promise<string[]> => frame.evaluate(() => (window as unknown as ToolWindowLike).wxElementRegistry.findAll({ visible: true }).filter((e) => /Frame/.test(e.typeName)).map((e) => `${e.typeName}:${e.name}`));

test('Inspect > Simulator is held under sim: ev.held, and no window of KiCad\'s', async ({ page, browserName }) => {
  await page.goto('/parent.html?fixture=sim-rc&frame=sch');
  await expect(page.locator('#state')).toContainText('opened sim-rc.kicad_sch', { timeout: 170_000 });
  expect((await of(page, 'ev.ready'))[0]?.caps).toEqual(expect.arrayContaining(['sim', 'heldKeys']));
  const frame = page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null;
  test.skip(frame == null, `${browserName}: the island frame is out of Playwright's reach, so its menu cannot be found`);
  await page.waitForTimeout(1_000);
  expect(await request(page, 'chrome.show', { on: true })).toEqual({});
  const before = await frames(frame!);
  await expect.poll(() => domPoint(frame!, '.wx-menu-title', 'Inspect'), { timeout: 15_000 }).not.toBeNull();
  await clickIn(page, ...(await domPoint(frame!, '.wx-menu-title', 'Inspect'))!);
  await expect.poll(() => domPoint(frame!, '.wx-menu-popup *', 'Simulator'), { timeout: 10_000 }).not.toBeNull();
  const held0 = (await of(page, 'ev.held')).length;
  await clickIn(page, ...(await domPoint(frame!, '.wx-menu-popup *', 'Simulator'))!);
  await expect.poll(async () => (await of(page, 'ev.held')).length, { timeout: 10_000 }).toBe(held0 + 1);
  expect((await of(page, 'ev.held')).at(-1)?.action).toBe('eeschema.EditorControl.showSimulator');
  // The menu closed, and nothing of KiCad's opened after it: no dialog, no new frame.
  await page.waitForTimeout(1_500);
  expect((await of(page, 'ev.menu')).at(-1)?.open).toBe(false);
  expect(await frames(frame!)).toEqual(before);
  expect(await request(page, 'chrome.show', { on: false })).toEqual({});
});
