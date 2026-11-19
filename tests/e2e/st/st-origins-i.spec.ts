// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-origins-i over the local pair (PROTOCOL.md, origins): in a pcb frame
// ev.ready lists settings:origins exactly when the engine's
// kicadSettingsSections() names origins in its board half (engine run 15,
// st-origins-e), and a sch frame never lists it. On engine run 14 the cap is
// absent and the frame's slot leaves KiCad's three origin actions to KiCad.
// On run 15 a set of the grid origin reads back through settings.get with no
// edit of the design and no KiCad window, and the three actions send ev.held
// and open nothing.
import { expect, test, type Frame, type Page } from '@playwright/test';

import { ISLAND } from '../ports';

interface Ev { type: string; open?: boolean; action?: string; caps?: string[]; phase?: string; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface ToolWindowLike { wxElementRegistry: { findAll(f: object): Array<{ typeName: string; name: string }> }; kicadHostAction?: { onRequest?: (json: unknown) => boolean } }
interface Point { x: number; y: number }

const CAP = 'settings:origins';
const HELD = ['common.Control.editGridOrigin', 'common.Control.gridResetOrigin', 'pcbnew.EditorControl.drillResetOrigin'] as const;
const RUN15 = 'waits for the engine marker kicadSettingsSections naming origins (engine run 15, st-origins-e)';

const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const of = async (page: Page, type: string): Promise<Ev[]> => (await events(page)).filter((e) => e.type === type);
const request = (page: Page, op: string, args?: unknown): Promise<Record<string, unknown>> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const);
const refusal = (page: Page, op: string, args?: unknown): Promise<string> =>
  request(page, op, args).then(() => 'ok', (err: Error) => err.message.split('\n')[0].replace(/^.*?page\.evaluate:\s*/, '').replace(/^Error:\s*/, ''));

async function open(page: Page, kind: 'sch' | 'pcb'): Promise<{ frame: Frame | null; caps: string[] }> {
  await page.goto(`/parent.html?fixture=glasgow&frame=${kind}`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  expect((await of(page, 'ev.state')).filter((e) => e.phase === 'fatal' || e.phase === 'blocked')).toEqual([]);
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

test('sch: the cap is never listed and the section is a board setting', async ({ page }) => {
  const { caps } = await open(page, 'sch');
  expect(caps).not.toContain(CAP);
  expect(await refusal(page, 'settings.get', { section: 'origins' })).toBe('unsupported: origins is a board setting');
});

test('pcb: the cap follows kicadSettingsSections, and without it the slot leaves the three actions to KiCad', async ({ page, browserName }) => {
  const { frame, caps } = await open(page, 'pcb');
  const run15 = caps.includes('kicadSettingsSections');
  test.skip(frame == null, `${browserName}: the island frame is out of Playwright's reach`);
  const sections = await frame!.evaluate(() => {
    const m = (window as unknown as { Module?: Record<string, unknown> }).Module;
    const f = m?.kicadSettingsSections;
    return typeof f === 'function' ? String((f as () => unknown)()) : null;
  });
  const listsOrigins = run15 && sections != null && (JSON.parse(sections) as { board?: string[] }).board?.includes('origins') === true;
  expect(caps.includes(CAP)).toBe(listsOrigins);
  if (!caps.includes(CAP)) {
    // Without the cap no action is held: KiCad runs them.
    for (const a of HELD) expect(await ask(page, frame!, a), a).toEqual({ taken: false, sent: null });
  }
});

test('pcb run 15: the grid origin is set and read back with no edit and no window, and the three actions are held', async ({ page, browserName }) => {
  const { frame, caps } = await open(page, 'pcb');
  test.skip(!caps.includes(CAP), RUN15);
  test.skip(frame == null, `${browserName}: the island frame is out of Playwright's reach`);
  const before = await request(page, 'settings.get', { section: 'origins' });
  const grid = before.grid_origin as Point;
  const aux = before.aux_origin as Point;
  expect(typeof grid.x).toBe('number');
  expect(typeof aux.y).toBe('number');
  const shown = await windows(frame!);
  const edited = (await of(page, 'ev.edited')).length;
  const menus = (await of(page, 'ev.menu')).length;

  const set = await request(page, 'settings.set', { section: 'origins', value: { grid_origin: { x: 10, y: 10 } } });
  expect((set.value as Record<string, Point>).grid_origin).toEqual({ x: 10, y: 10 });
  const read = await request(page, 'settings.get', { section: 'origins' });
  expect(read.grid_origin).toEqual({ x: 10, y: 10 });
  expect(read.aux_origin).toEqual(aux);

  for (const bad of [{ grid: [10, 10] }, { grid_origin: { x: 10 } }, { aux_origin: { x: 5000, y: 0 } }]) {
    expect(await refusal(page, 'settings.set', { section: 'origins', value: bad }), JSON.stringify(bad)).toBe('bad_args: settings.set');
  }

  for (const a of HELD) expect(await ask(page, frame!, a), a).toEqual({ taken: true, sent: a });
  await page.waitForTimeout(1_000);
  // A setting: no undo step, no edit of the design; the held actions opened no window.
  expect((await of(page, 'ev.edited')).length).toBe(edited);
  expect((await of(page, 'ev.menu')).length).toBe(menus);
  expect(await windows(frame!)).toEqual(shown);

  // Back as the board had them.
  await request(page, 'settings.set', { section: 'origins', value: { grid_origin: grid } });
  expect((await request(page, 'settings.get', { section: 'origins' })).grid_origin).toEqual(grid);
});
