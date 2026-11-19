// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-calc-i over the local pair (PROTOCOL.md, Calculator Tools): ev.ready
// lists openCalculator in sch and pcb, KiCad handing pcb_calculator to
// kicadWebOpenTool sends ev.openTool { frame: "calculator" } and opens no
// window, and the frame's slot holds common.Control.showCalculatorTools
// (ev.held). The menu press reaches KiCad's own Execute on engine run 14
// (ev.openTool) and is held on an engine whose menus ask the slot (heldMenus,
// run 15: ev.held); either way nothing of KiCad's opens.
import { expect, test, type Frame, type Page } from '@playwright/test';

import { ISLAND } from '../ports';

interface Ev { type: string; open?: boolean; action?: string; frame?: string; caps?: string[]; phase?: string; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface ToolWindowLike {
  wxElementRegistry: { findAll(f: object): Array<{ typeName: string; name: string }> };
  kicadHostAction?: { onRequest?: (json: unknown) => boolean };
  kicadWebOpenTool?: (tool: string, file?: string) => boolean;
}

const ACTION = 'common.Control.showCalculatorTools';
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

/** Presses a menu path of KiCad's menu bar (the title, then each item). */
async function pressMenu(page: Page, frame: Frame, path: readonly string[]): Promise<void> {
  const [title, ...items] = path;
  await expect.poll(() => domPoint(frame, '.wx-menu-title', title), { timeout: 15_000, message: `menu ${title}` }).not.toBeNull();
  await clickIn(page, ...(await domPoint(frame, '.wx-menu-title', title))!);
  for (const item of items) {
    await expect.poll(() => domPoint(frame, '.wx-menu-popup *', item), { timeout: 10_000, message: `item ${path.join(' > ')}` }).not.toBeNull();
    await clickIn(page, ...(await domPoint(frame, '.wx-menu-popup *', item))!);
  }
}

for (const kind of ['sch', 'pcb'] as const) {
  test(`${kind}: openCalculator is listed, pcb_calculator becomes ev.openTool calculator, the action is held, and no window opens`, async ({ page, browserName }) => {
    const { frame, caps } = await open(page, kind);
    expect(caps).toContain('openCalculator');
    test.skip(frame == null, `${browserName}: the island frame is out of Playwright's reach, so its slots cannot be asked`);
    const before = await windows(frame!);

    // KiCad's ExecuteFile hands the calculator's name to the frame; it boots nothing.
    for (const raw of ['pcb_calculator', '/usr/bin/pcb_calculator']) {
      const n = (await of(page, 'ev.openTool')).length;
      const handled = await frame!.evaluate((t) => (window as unknown as ToolWindowLike).kicadWebOpenTool?.(t, '') === true, raw);
      expect(handled, raw).toBe(true);
      await expect.poll(async () => (await of(page, 'ev.openTool')).length, { timeout: 5_000 }).toBe(n + 1);
      expect((await of(page, 'ev.openTool')).at(-1)?.frame).toBe('calculator');
    }
    // A tool no one names is left to KiCad's own refusal.
    expect(await frame!.evaluate(() => (window as unknown as ToolWindowLike).kicadWebOpenTool?.('bitmap2component', '') === true)).toBe(false);

    // The engine's slot, asked as a key's press asks it.
    const held = (await of(page, 'ev.held')).length;
    const taken = await frame!.evaluate((a) => (window as unknown as ToolWindowLike).kicadHostAction?.onRequest?.(JSON.stringify({ action: a })) === true, ACTION);
    expect(taken).toBe(true);
    await expect.poll(async () => (await of(page, 'ev.held')).length, { timeout: 5_000 }).toBe(held + 1);
    expect((await of(page, 'ev.held')).at(-1)?.action).toBe(ACTION);

    expect(await windows(frame!)).toEqual(before);
    expect(await request(page, 'chrome.show', { on: false })).toEqual({});
  });

  test(`${kind}: KiCad's Tools > Calculator Tools opens our calculator and no window of KiCad's`, async ({ page, browserName }) => {
    const { frame, caps } = await open(page, kind);
    test.skip(frame == null, `${browserName}: the island frame is out of Playwright's reach, so its menu cannot be found`);
    expect(await request(page, 'chrome.show', { on: true })).toEqual({});
    const before = await windows(frame!);
    const tools = (await of(page, 'ev.openTool')).length;
    const held = (await of(page, 'ev.held')).length;
    await pressMenu(page, frame!, ['Tools', 'Calculator Tools']);
    if (caps.includes('heldMenus')) {
      await expect.poll(async () => (await of(page, 'ev.held')).length, { timeout: 10_000, message: 'the menu item is held' }).toBe(held + 1);
      expect((await of(page, 'ev.held')).at(-1)?.action).toBe(ACTION);
      expect((await of(page, 'ev.openTool')).length).toBe(tools);
    } else {
      await expect.poll(async () => (await of(page, 'ev.openTool')).length, { timeout: 10_000, message: 'the menu item asks for the calculator' }).toBe(tools + 1);
      expect((await of(page, 'ev.openTool')).at(-1)?.frame).toBe('calculator');
    }
    await page.waitForTimeout(1_500);
    expect((await of(page, 'ev.menu')).at(-1)?.open ?? false).toBe(false);
    expect(await windows(frame!)).toEqual(before);
    expect(await request(page, 'chrome.show', { on: false })).toEqual({});
  });
}
