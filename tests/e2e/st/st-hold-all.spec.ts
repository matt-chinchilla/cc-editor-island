// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The whole wave's held e2e (PROTOCOL.md ev.held and heldMenus): the held
// union as the island reads it (bridge/held.ts HELD_ACTIONS and every wave
// unit's heldRows in bridge/ext/*.ts), pressed from KiCad's own menus and
// toolbars in the frames that hold it, over the local pair. Every pressed row
// sends ev.held { action } and no window of KiCad's opens. PM12: no item of
// the sch and pcb frames' menus reaches KiCad's Advanced Config dialog.
// The presses wait for engine run 15 (kicad cc/main K-HOLD, the export
// kicadHeldMenus): on an older engine a menu press still reaches KiCad's
// window, so only the union and the menu walk run there.
import { expect, test, type Frame, type Page } from '@playwright/test';

import { HELD_ACTIONS, type HeldAction } from '../../../bridge/held';
import { ISLAND } from '../ports';

interface Ev { type: string; open?: boolean; action?: string; caps?: string[]; phase?: string; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface ToolWindowLike { wxElementRegistry: { findAll(f: object): Array<{ typeName: string; name: string }> } }
interface FsLike { readdirSync(path: URL): string[] }

const RUN15 = 'waits for the engine export kicadHeldMenus (engine run 15, kicad cc/main K-HOLD)';
const EXT_DIR = new URL('../../../bridge/ext/', import.meta.url);
/** Files of bridge/ext that are no unit (the registry's own glob leaves them out). */
const NOT_UNITS = new Set(['contract.ts', 'registry.ts', 'builtins.ts']);

/**
 * The held union the island reads: the built ins, then every unit's rows in
 * unit id order (bridge/ext/registry.ts heldActions; its glob is Vite's, so
 * this reads the same files with Node's own).
 */
async function heldUnion(): Promise<{ rows: HeldAction[]; unread: string[] }> {
  const fsName = 'node:fs';
  const fs = (await import(/* @vite-ignore */ fsName)) as FsLike;
  const files = fs.readdirSync(EXT_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !NOT_UNITS.has(f)).sort();
  const rows: HeldAction[] = [...HELD_ACTIONS];
  const unread: string[] = [];
  for (const f of files) {
    try {
      const m = (await import(/* @vite-ignore */ new URL(f, EXT_DIR).href)) as { default?: { heldRows?: HeldAction[] } };
      rows.push(...(m.default?.heldRows ?? []));
    } catch (err) {
      unread.push(`${f}: ${String(err)}`);
    }
  }
  return { rows, unread };
}

/**
 * Where each held action sits in KiCad 10's menus, per frame (the title, then
 * each item; a submenu opens on its item). A row of the union with no path
 * here is listed in the test's annotations for the joiner to add.
 */
const MENU_PATHS: Record<'sch' | 'pcb', Record<string, readonly string[]>> = {
  sch: {
    'common.Control.updatePcbFromSchematic': ['Tools', 'Update PCB from Schematic'],
    'eeschema.InspectionTool.runERC': ['Inspect', 'Electrical Rules Checker'],
    'eeschema.EditorControl.annotate': ['Tools', 'Annotate Schematic'],
    'eeschema.EditorControl.showSimulator': ['Inspect', 'Simulator'],
    'common.Control.showSymbolEditor': ['Tools', 'Symbol Editor'],
    'eeschema.EditorTool.showHierarchy': ['View', 'Panels', 'Hierarchy'],
    'common.Control.showProperties': ['View', 'Panels', 'Properties'],
    'eeschema.RemoteSymbols.showPanel': ['View', 'Panels', 'Remote Symbols'],
    'common.API.pluginsReload': ['Tools', 'External Plugins', 'Refresh Plugins'],
    'eeschema.EditorControl.importGraphics': ['File', 'Import', 'Graphics'],
    'cc.Control.setLanguage': ['Preferences', 'Set Language', 'Deutsch'],
  },
  pcb: {
    'common.Control.updatePcbFromSchematic': ['Tools', 'Update PCB from Schematic'],
    'pcbnew.DRCTool.runDRC': ['Inspect', 'Design Rules Checker'],
    'common.Control.show3DViewer': ['View', '3D Viewer'],
    'pcbnew.Control.showLayersManager': ['View', 'Panels', 'Appearance'],
    'common.Control.showProperties': ['View', 'Panels', 'Properties'],
    'common.API.pluginsReload': ['Tools', 'External Plugins', 'Refresh Plugins'],
    'pcbnew.ScriptingTool.pluginsShowFolder': ['Tools', 'External Plugins', 'Open Plugin Directory'],
    'pcbnew.Control.showPythonConsole': ['Tools', 'Scripting Console'],
    'pcbnew.EditorControl.importGraphics': ['File', 'Import', 'Graphics'],
    'cc.Control.setLanguage': ['Preferences', 'Set Language', 'Deutsch'],
  },
};
/** Toolbar buttons of held actions, found by their tooltip. */
const TOOL_TIPS: Record<'sch' | 'pcb', Record<string, string>> = {
  sch: { 'eeschema.InspectionTool.runERC': 'Electrical Rules Checker', 'eeschema.EditorControl.annotate': 'Annotate' },
  pcb: { 'pcbnew.DRCTool.runDRC': 'Design Rules Checker', 'common.Control.show3DViewer': '3D Viewer' },
};

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
/** A toolbar tool whose tooltip, title or label starts with `tip`. */
const toolPoint = (frame: Frame, tip: string): Promise<[number, number] | null> =>
  frame.evaluate((t) => {
    const el = [...document.querySelectorAll('.wx-tool')].find((e) => [e.getAttribute('title'), e.getAttribute('aria-label'), e.getAttribute('data-tooltip')].some((s) => (s ?? '').trim().startsWith(t)));
    if (el == null) return null;
    const r = el.getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2] as [number, number];
  }, tip);

/** KiCad's menu popups shown now (wx-dom keeps a closed popup in the document, hidden). */
const shownPopups = (frame: Frame): Promise<number> =>
  frame.evaluate(() => [...document.querySelectorAll('.wx-menu-popup')].filter((p) => p.getBoundingClientRect().width > 0 && getComputedStyle(p).display !== 'none' && getComputedStyle(p).visibility !== 'hidden').length);
async function closedWithin(frame: Frame, ms: number): Promise<boolean> {
  try {
    await expect.poll(() => shownPopups(frame), { timeout: ms }).toBe(0);
    return true;
  } catch {
    return false;
  }
}

async function pressMenu(page: Page, frame: Frame, path: readonly string[]): Promise<void> {
  const [title, ...items] = path;
  await expect.poll(() => domPoint(frame, '.wx-menu-title', title), { timeout: 15_000, message: `menu ${title}` }).not.toBeNull();
  await clickIn(page, ...(await domPoint(frame, '.wx-menu-title', title))!);
  for (const item of items) {
    await expect.poll(() => domPoint(frame, '.wx-menu-popup *', item), { timeout: 10_000, message: `item ${path.join(' > ')}` }).not.toBeNull();
    await clickIn(page, ...(await domPoint(frame, '.wx-menu-popup *', item))!);
  }
}

/** Runs `press` and asserts one ev.held { action }, no new window of KiCad's, and no menu left open. */
async function heldBy(page: Page, frame: Frame, what: string, action: string, press: () => Promise<void>): Promise<void> {
  const before = await windows(frame);
  const n = (await of(page, 'ev.held')).length;
  await press();
  await expect.poll(async () => (await of(page, 'ev.held')).length, { timeout: 10_000, message: `${what} sends ev.held` }).toBe(n + 1);
  expect((await of(page, 'ev.held')).at(-1)?.action, what).toBe(action);
  await page.waitForTimeout(1_500);
  expect((await of(page, 'ev.menu')).at(-1)?.open ?? false, `${what}: the menu closed`).toBe(false);
  expect(await windows(frame), `${what} opens no window`).toEqual(before);
}

test('the held union reads every unit file, and each action sits once per frame', async () => {
  const { rows, unread } = await heldUnion();
  expect(unread).toEqual([]);
  expect(rows.length).toBeGreaterThanOrEqual(HELD_ACTIONS.length);
  const seen = new Set<string>();
  for (const r of rows) for (const f of r.frames) {
    const key = `${r.action} in ${f}`;
    expect(seen.has(key), key).toBe(false);
    seen.add(key);
  }
});

for (const kind of ['sch', 'pcb'] as const) {
  test(`${kind} (PM12): no item of KiCad's menus reaches the Advanced Config dialog`, async ({ page, browserName }) => {
    const { frame } = await open(page, kind);
    test.skip(frame == null, `${browserName}: the island frame is out of Playwright's reach, so its menus cannot be read`);
    expect(await request(page, 'chrome.show', { on: true })).toEqual({});
    const before = await windows(frame!);
    const titles = await frame!.evaluate(() => [...document.querySelectorAll('.wx-menu-title')].map((e) => (e.textContent ?? '').trim()).filter((t) => t !== ''));
    expect(titles.length).toBeGreaterThan(3);
    const items: string[] = [];
    for (const title of titles) {
      await clickIn(page, ...(await domPoint(frame!, '.wx-menu-title', title))!);
      await expect.poll(() => shownPopups(frame!), { timeout: 5_000, message: `menu ${title} opens` }).toBeGreaterThan(0);
      items.push(...(await frame!.evaluate(() => [...document.querySelectorAll('.wx-menu-popup')].filter((p) => p.getBoundingClientRect().width > 0 && getComputedStyle(p).display !== 'none' && getComputedStyle(p).visibility !== 'hidden').flatMap((p) => [...p.querySelectorAll('*')]).filter((e) => e.children.length === 0).map((e) => (e.textContent ?? '').trim()).filter((t) => t !== ''))).map((t) => `${title} > ${t}`));
      // Closed as a reader closes it: Escape, else a press on its title again.
      await page.keyboard.press('Escape');
      if (!(await closedWithin(frame!, 1_500))) await clickIn(page, ...(await domPoint(frame!, '.wx-menu-title', title))!);
      expect(await closedWithin(frame!, 5_000), `menu ${title} closes`).toBe(true);
    }
    test.info().annotations.push({ type: 'menu items read', description: String(items.length) });
    expect(items.filter((t) => /advanced\s*config/i.test(t))).toEqual([]);
    expect(await windows(frame!)).toEqual(before);
    expect(await request(page, 'chrome.show', { on: false })).toEqual({});
  });

  test(`${kind} run 15: every held row with a menu item or toolbar button sends ev.held and opens nothing`, async ({ page, browserName }) => {
    const { rows } = await heldUnion();
    const { frame, caps } = await open(page, kind);
    test.skip(!caps.includes('heldMenus'), RUN15);
    test.skip(frame == null, `${browserName}: the island frame is out of Playwright's reach, so its menus cannot be pressed`);
    expect(await request(page, 'chrome.show', { on: true })).toEqual({});
    const mine = rows.filter((r) => r.frames.includes(kind) && caps.includes(r.cap));
    const unmapped = mine.filter((r) => MENU_PATHS[kind][r.action] == null && TOOL_TIPS[kind][r.action] == null).map((r) => r.action);
    if (unmapped.length > 0) test.info().annotations.push({ type: 'held rows with no menu path here', description: unmapped.join(', ') });
    for (const r of mine) {
      const path = MENU_PATHS[kind][r.action];
      if (path != null) await heldBy(page, frame!, path.join(' > '), r.action, () => pressMenu(page, frame!, path));
      const tip = TOOL_TIPS[kind][r.action];
      if (tip != null) {
        await expect.poll(() => toolPoint(frame!, tip), { timeout: 10_000, message: `toolbar ${tip}` }).not.toBeNull();
        await heldBy(page, frame!, `toolbar ${tip}`, r.action, async () => clickIn(page, ...(await toolPoint(frame!, tip))!));
      }
    }
    // Set Language was held: the menus still read in English.
    expect(await domPoint(frame!, '.wx-menu-title', 'Preferences')).not.toBeNull();
    expect(await request(page, 'chrome.show', { on: false })).toEqual({});
  });
}
