// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-hold-i over the local pair (PROTOCOL.md, KiCad never shows): the cap
// heldMenus is listed exactly when the engine has kicadHeldMenus, and the
// unit's five rows are taken by the frame's own slot in their frames only. On
// engine run 14 the cap is absent and the language row is never taken; the
// menu presses of the recipe wait for engine run 15 (kicad cc/main K-HOLD).
import { expect, test, type Frame, type Page } from '@playwright/test';

import { ISLAND } from '../ports';

interface Ev { type: string; open?: boolean; action?: string; caps?: string[]; phase?: string; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface ToolWindowLike { wxElementRegistry: { findAll(f: object): Array<{ typeName: string; name: string }> }; kicadHostAction?: { onRequest?: (json: unknown) => boolean } }

const RUN15 = 'waits for the engine export kicadHeldMenus (engine run 15, kicad cc/main K-HOLD)';
const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const of = async (page: Page, type: string): Promise<Ev[]> => (await events(page)).filter((e) => e.type === type);
const request = (page: Page, op: string, args?: unknown): Promise<Record<string, unknown>> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const);

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

/** Presses a menu path of KiCad's menu bar (the title, then each item, submenus opened by a press). */
async function pressMenu(page: Page, frame: Frame, path: readonly string[]): Promise<void> {
  const [title, ...items] = path;
  await expect.poll(() => domPoint(frame, '.wx-menu-title', title), { timeout: 15_000, message: `menu ${title}` }).not.toBeNull();
  await clickIn(page, ...(await domPoint(frame, '.wx-menu-title', title))!);
  for (const item of items) {
    await expect.poll(() => domPoint(frame, '.wx-menu-popup *', item), { timeout: 10_000, message: `item ${path.join(' > ')}` }).not.toBeNull();
    await clickIn(page, ...(await domPoint(frame, '.wx-menu-popup *', item))!);
  }
}

/** Presses `path` and asserts ev.held { action }, no new KiCad window, and the menu closed after. */
async function heldFromMenu(page: Page, frame: Frame, path: readonly string[], action: string): Promise<void> {
  const before = await windows(frame);
  const n = (await of(page, 'ev.held')).length;
  await pressMenu(page, frame, path);
  await expect.poll(async () => (await of(page, 'ev.held')).length, { timeout: 10_000, message: `${path.join(' > ')} sends ev.held` }).toBe(n + 1);
  expect((await of(page, 'ev.held')).at(-1)?.action).toBe(action);
  await page.waitForTimeout(1_500);
  expect((await of(page, 'ev.menu')).at(-1)?.open ?? false).toBe(false);
  expect(await windows(frame)).toEqual(before);
}

for (const kind of ['sch', 'pcb'] as const) {
  test(`${kind}: heldMenus is listed exactly with kicadHeldMenus, and the unit's rows are taken in their frames only`, async ({ page, browserName }) => {
    const { frame, caps } = await open(page, kind);
    expect(caps).toContain('heldKeys');
    expect(caps.includes('heldMenus')).toBe(caps.includes('kicadHeldMenus'));
    test.skip(frame == null, `${browserName}: the island frame is out of Playwright's reach, so its slot cannot be asked`);
    const want: Record<string, boolean> = {
      'cc.Control.setLanguage': caps.includes('heldMenus'),
      'eeschema.RemoteSymbols.showPanel': kind === 'sch',
      'common.API.pluginsReload': true,
      'pcbnew.ScriptingTool.pluginsShowFolder': kind === 'pcb',
      'pcbnew.Control.showPythonConsole': kind === 'pcb',
      // A built in row still stands beside them, and an action no row names is KiCad's.
      'common.Control.showProperties': true,
      'common.Control.zoomFitScreen': false,
    };
    const before = await windows(frame!);
    for (const [action, taken] of Object.entries(want)) {
      expect(await ask(page, frame!, action), action).toEqual({ taken, sent: taken ? action : null });
    }
    // Nothing of KiCad's opened; the frame still answers.
    expect(await windows(frame!)).toEqual(before);
    expect(await request(page, 'chrome.show', { on: false })).toEqual({});
  });
}

test('run 15: the unit\'s menu items send ev.held and open nothing; Set Language leaves the menus in English', async ({ page, browserName }) => {
  const sch = await open(page, 'sch');
  test.skip(!sch.caps.includes('heldMenus'), RUN15);
  test.skip(sch.frame == null, `${browserName}: the island frame is out of Playwright's reach, so its menu cannot be found`);
  expect(await request(page, 'chrome.show', { on: true })).toEqual({});
  await heldFromMenu(page, sch.frame!, ['Preferences', 'Set Language', 'Deutsch'], 'cc.Control.setLanguage');
  expect(await domPoint(sch.frame!, '.wx-menu-title', 'Preferences')).not.toBeNull();
  await heldFromMenu(page, sch.frame!, ['View', 'Panels', 'Remote Symbols'], 'eeschema.RemoteSymbols.showPanel');
  await heldFromMenu(page, sch.frame!, ['Tools', 'External Plugins', 'Refresh Plugins'], 'common.API.pluginsReload');
  const pcb = await open(page, 'pcb');
  expect(await request(page, 'chrome.show', { on: true })).toEqual({});
  await heldFromMenu(page, pcb.frame!, ['Preferences', 'Set Language', 'Deutsch'], 'cc.Control.setLanguage');
  await heldFromMenu(page, pcb.frame!, ['Tools', 'External Plugins', 'Refresh Plugins'], 'common.API.pluginsReload');
  await heldFromMenu(page, pcb.frame!, ['Tools', 'External Plugins', 'Open Plugin Directory'], 'pcbnew.ScriptingTool.pluginsShowFolder');
  await heldFromMenu(page, pcb.frame!, ['Tools', 'Scripting Console'], 'pcbnew.Control.showPythonConsole');
  expect(await request(page, 'chrome.show', { on: false })).toEqual({});
});
