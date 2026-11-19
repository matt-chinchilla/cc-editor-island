// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-revert-i over the local pair (PROTOCOL.md ev.held): in a sch and a pcb
// frame KiCad's New (Ctrl+N), Open (Ctrl+O), Save As (Ctrl+Shift+S), Save a
// Copy and Revert are held: each sends ev.held with the action's name and opens
// no window of KiCad's. Save a Copy and Revert have no default chord, so the
// frame's slot is asked for them as the engine asks it. The File menu presses
// of the recipe wait for engine run 15 (kicad cc/main K-HOLD, the cap heldMenus).
import { expect, test, type Frame, type Page } from '@playwright/test';

import { ISLAND, ISLAND_ADDR } from '../ports';

interface Ev { type: string; open?: boolean; action?: string; caps?: string[]; phase?: string; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface ToolWindowLike { wxElementRegistry: { findAll(f: object): Array<{ typeName: string; name: string }> }; kicadHostAction?: { onRequest?: (json: unknown) => boolean } }

interface Key { key: string; code: string; ctrl?: boolean; shift?: boolean }

const NEW = 'common.Control.new';
const OPEN = 'common.Control.open';
const SAVE_AS = 'common.Control.saveAs';
const SAVE_COPY = 'common.Control.saveCopy';
const REVERT = 'common.Control.revert';
/** KiCad's default chords of the three that have one (common/tool/actions.cpp). */
const KEYS: ReadonlyArray<[Key, string]> = [
  [{ key: 'n', code: 'KeyN', ctrl: true }, NEW],
  [{ key: 'o', code: 'KeyO', ctrl: true }, OPEN],
  [{ key: 's', code: 'KeyS', ctrl: true, shift: true }, SAVE_AS],
];
/** File menu labels (KiCad's friendly names) and their actions; New, Open, Save As and Save a Copy are listed only in a standalone editor. */
const MENU: ReadonlyArray<[string, string]> = [['New...', NEW], ['Open...', OPEN], ['Save As...', SAVE_AS], ['Save a Copy...', SAVE_COPY], ['Revert', REVERT]];
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


/** Presses a key through key.press and returns the ev.held it sent, if any; no KiCad menu or window opened. */
async function pressHeld(page: Page, key: Key): Promise<string | null> {
  const n = (await of(page, 'ev.held')).length;
  const menus = (await of(page, 'ev.menu')).length;
  expect(await request(page, 'key.press', key)).toEqual({});
  await expect.poll(async () => (await of(page, 'ev.held')).length, { timeout: 5_000, message: `${JSON.stringify(key)} sends ev.held` }).toBe(n + 1);
  await page.waitForTimeout(1_000);
  expect((await of(page, 'ev.menu')).length, `${JSON.stringify(key)} opens no window`).toBe(menus);
  return (await of(page, 'ev.held')).at(-1)?.action ?? null;
}

test('the held actions\' names are in the engine\'s own strings', async ({ request: http }) => {
  const res = await http.get(`${ISLAND_ADDR}/current/wasm/kicad_editor/v0.2.3/kicad_editor.wasm`);   // the island server, by address
  expect(res.ok()).toBe(true);
  const wasm = await res.text();
  for (const n of [NEW, OPEN, SAVE_AS, SAVE_COPY, REVERT]) expect(wasm.includes(n), n).toBe(true);
});

for (const kind of ['sch', 'pcb'] as const) {
  test(`${kind}: Ctrl+N, Ctrl+O and Ctrl+Shift+S send ev.held and open nothing`, async ({ page }) => {
    const { frame, caps } = await open(page, kind);
    expect(caps).toContain('heldKeys');
    const before = frame == null ? null : await windows(frame);
    for (const [key, action] of KEYS) expect(await pressHeld(page, key), JSON.stringify(key)).toBe(action);
    if (frame != null) expect(await windows(frame)).toEqual(before);
    expect(await request(page, 'chrome.show', { on: false })).toEqual({});
  });

  test(`${kind}: Save a Copy and Revert are taken by the slot, send ev.held and open nothing`, async ({ page, browserName }) => {
    const { frame, caps } = await open(page, kind);
    expect(caps).toContain('heldKeys');
    test.skip(frame == null, `${browserName}: the island frame is out of Playwright's reach, so its slot cannot be asked`);
    const before = await windows(frame!);
    for (const action of [NEW, OPEN, SAVE_AS, SAVE_COPY, REVERT]) expect(await ask(page, frame!, action), action).toEqual({ taken: true, sent: action });
    // An action no row names is still KiCad's.
    expect(await ask(page, frame!, 'common.Control.zoomFitScreen')).toEqual({ taken: false, sent: null });
    await page.waitForTimeout(1_000);
    expect(await windows(frame!)).toEqual(before);
    expect(await request(page, 'chrome.show', { on: false })).toEqual({});
  });

  test(`run 15, ${kind}: each File menu item of the five sends ev.held and opens nothing`, async ({ page, browserName }) => {
    const { frame, caps } = await open(page, kind);
    test.skip(!caps.includes('heldMenus'), RUN15);
    test.skip(frame == null, `${browserName}: the island frame is out of Playwright's reach, so its menu cannot be found`);
    expect(await request(page, 'chrome.show', { on: true })).toEqual({});
    // Which of the five this File menu lists (Revert always; the others in a standalone editor).
    await expect.poll(() => domPoint(frame!, '.wx-menu-title', 'File'), { timeout: 15_000, message: 'menu File' }).not.toBeNull();
    await clickIn(page, ...(await domPoint(frame!, '.wx-menu-title', 'File'))!);
    await expect.poll(() => domPoint(frame!, '.wx-menu-popup *', 'Revert'), { timeout: 10_000, message: 'File > Revert' }).not.toBeNull();
    const listed: Array<[string, string]> = [];
    for (const [label, action] of MENU) if ((await domPoint(frame!, '.wx-menu-popup *', label)) != null) listed.push([label, action]);
    await clickIn(page, ...(await domPoint(frame!, '.wx-menu-title', 'File'))!);
    await expect.poll(async () => (await of(page, 'ev.menu')).at(-1)?.open ?? false, { timeout: 5_000, message: 'the File menu closes' }).toBe(false);
    expect(listed.map(([, a]) => a)).toContain(REVERT);
    const before = await windows(frame!);
    for (const [label, action] of listed) {
      const n = (await of(page, 'ev.held')).length;
      await pressMenu(page, frame!, ['File', label]);
      await expect.poll(async () => (await of(page, 'ev.held')).length, { timeout: 10_000, message: `File > ${label} sends ev.held` }).toBe(n + 1);
      expect((await of(page, 'ev.held')).at(-1)?.action).toBe(action);
      await page.waitForTimeout(1_500);
      expect((await of(page, 'ev.menu')).at(-1)?.open ?? false).toBe(false);
      expect(await windows(frame!)).toEqual(before);
    }
    expect(await request(page, 'chrome.show', { on: false })).toEqual({});
  });
}
