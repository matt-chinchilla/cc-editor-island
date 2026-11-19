// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-routing-i over the local pair (PROTOCOL.md, Routing: the sections router
// and layerPairs) on the Glasgow fixture: in a pcb frame ev.ready lists
// settings:router and settings:layerPairs exactly when the engine's
// kicadSettingsSections names them (engine run 15, st-routing-e); on run 14
// neither, and KiCad's three router windows stay KiCad's. On run 15 the
// router's keys and the layer pairs read and set with no KiCad window and no
// undo step, and Interactive Router Settings (Ctrl+<), Set Layer Pair and
// Differential Pair Dimensions each send ev.held { action } and open nothing.
// A sch frame answers both sections unsupported on any engine.
import { expect, test, type Frame, type Page } from '@playwright/test';

import { ISLAND } from '../ports';

interface Ev { type: string; open?: boolean; action?: string; caps?: string[]; phase?: string; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface ToolWindowLike { wxElementRegistry: { findAll(f: object): Array<{ typeName: string; name: string }> }; kicadHostAction?: { onRequest?: (json: unknown) => boolean } }
type Answer = { error?: { code: string; message: string } } & Record<string, unknown>;

const SETTINGS_DIALOG = 'pcbnew.InteractiveRouter.SettingsDialog';
const SELECT_LAYER_PAIR = 'pcbnew.InteractiveRouter.SelectLayerPair';
const DIFF_PAIR_DIALOG = 'pcbnew.InteractiveRouter.DiffPairDialog';
const ACTIONS = [SETTINGS_DIALOG, SELECT_LAYER_PAIR, DIFF_PAIR_DIALOG];
const ROUTER_CAP = 'settings:router';
const LAYER_PAIRS_CAP = 'settings:layerPairs';
const SWITCHES = ['remove_loops', 'smart_pads', 'shove_vias', 'suggest_finish', 'follow_mouse', 'free_angle_mode', 'snap_to_tracks', 'snap_to_pads',
  'optimize_dragged_track', 'auto_posture', 'fix_all_segments'];
const RUN15 = 'waits for the router and layerPairs sections of kicadSettingsSections (engine run 15, st-routing-e)';

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

/** Whether the engine's section marker names both sections (run 15). */
const takesSections = (caps: string[]): boolean => caps.includes(ROUTER_CAP) && caps.includes(LAYER_PAIRS_CAP);

test('pcb: the routing caps follow kicadSettingsSections, and without them the router windows stay KiCad\'s', async ({ page, browserName }) => {
  const { frame, caps } = await open(page, 'pcb');
  expect(caps).toContain('heldKeys');
  const run15 = caps.includes('kicadSettingsSections');
  expect(caps.includes(ROUTER_CAP)).toBe(run15);
  expect(caps.includes(LAYER_PAIRS_CAP)).toBe(run15);
  test.skip(run15, 'on run 15 the windows are held: the next test');
  test.skip(frame == null, `${browserName}: the island frame is out of Playwright's reach, so its slot cannot be asked`);
  for (const a of ACTIONS) expect(await ask(page, frame!, a), a).toEqual({ taken: false, sent: null });
  expect(await request(page, 'view.fit')).toEqual({});
});

test('sch: both sections are board settings, and no routing cap is listed', async ({ page }) => {
  const { caps } = await open(page, 'sch');
  expect(caps).not.toContain(ROUTER_CAP);
  expect(caps).not.toContain(LAYER_PAIRS_CAP);
  expect(await request(page, 'settings.get', { section: 'router' })).toEqual({ error: { code: 'unsupported', message: 'router is a board setting' } });
  expect(await request(page, 'settings.get', { section: 'layerPairs' })).toEqual({ error: { code: 'unsupported', message: 'layerPairs is a board setting' } });
});

test('pcb run 15: the three router windows are held, Ctrl+< sends ev.held, and nothing of KiCad\'s opens', async ({ page, browserName }) => {
  const { frame, caps } = await open(page, 'pcb');
  test.skip(!takesSections(caps), RUN15);
  for (const a of ACTIONS) expect(await request(page, 'action.run', { name: a }), a).toEqual({ error: { code: 'held', message: a } });
  test.skip(frame == null, `${browserName}: the island frame is out of Playwright's reach, so its slot cannot be asked`);
  const before = await windows(frame!);
  for (const a of ACTIONS) expect(await ask(page, frame!, a), a).toEqual({ taken: true, sent: a });

  const held = (await of(page, 'ev.held')).length;
  const menus = (await of(page, 'ev.menu')).length;
  await page.locator('iframe').first().click({ position: { x: 8, y: 8 } });
  await page.keyboard.press('Control+Shift+Comma');
  await expect.poll(async () => (await of(page, 'ev.held')).length, { timeout: 5_000, message: 'Ctrl+< sends ev.held' }).toBe(held + 1);
  expect((await of(page, 'ev.held')).at(-1)?.action).toBe(SETTINGS_DIALOG);
  await page.waitForTimeout(1_500);
  expect((await of(page, 'ev.menu')).length, 'Ctrl+< opens no window').toBe(menus);
  expect(await windows(frame!)).toEqual(before);
  expect(await request(page, 'view.fit')).toEqual({});
});

test('pcb run 15: the router and the layer pairs read and set with no window and no undo step', async ({ page }) => {
  const { caps } = await open(page, 'pcb');
  test.skip(!takesSections(caps), RUN15);
  const router = await request(page, 'settings.get', { section: 'router' });
  expect(router.error).toBeUndefined();
  for (const k of ['mode', 'effort']) expect([0, 1, 2]).toContain(router[k]);
  for (const k of SWITCHES) expect(typeof router[k], k).toBe('boolean');
  for (const k of ['currentTrack', 'currentVia', 'currentDiffPair']) expect(typeof router[k], k).toBe('object');
  const pairs = await request(page, 'settings.get', { section: 'layerPairs' });
  expect(Array.isArray(pairs.pairs)).toBe(true);
  const edited = (await of(page, 'ev.edited')).length;
  const menus = (await of(page, 'ev.menu')).length;

  const mode = router.mode === 1 ? 2 : 1;
  const set = await request(page, 'settings.set', { section: 'router', value: { mode } });
  expect((set.value as Record<string, unknown>).mode).toBe(mode);
  expect((await request(page, 'settings.get', { section: 'router' })).mode).toBe(mode);
  await request(page, 'settings.set', { section: 'router', value: { currentTrack: { customWidth: 0.4, custom: true } } });
  const custom = await request(page, 'settings.get', { section: 'router' });
  expect(custom.currentTrack).toMatchObject({ custom: true, width: 0.4 });
  expect(custom.currentVia).toMatchObject({ custom: true });

  const pair = { top: 'F.Cu', bottom: 'B.Cu' };
  await request(page, 'settings.set', { section: 'layerPairs', value: { pairs: [{ ...pair, name: 'Outer pair' }], current: pair } });
  const after = await request(page, 'settings.get', { section: 'layerPairs' });
  expect(after.pairs).toEqual([{ ...pair, enabled: true, name: 'Outer pair' }]);
  expect(after.current).toEqual(pair);

  await page.waitForTimeout(1_000);
  expect((await of(page, 'ev.edited')).length, 'no undo step').toBe(edited);
  expect((await of(page, 'ev.menu')).length, 'no window').toBe(menus);

  expect(await request(page, 'settings.set', { section: 'router', value: { currentTrack: { width: 0.4 } } })).toEqual({ error: { code: 'bad_args', message: 'settings.set' } });
  expect(await request(page, 'settings.set', { section: 'router', value: { mode: 3 } })).toEqual({ error: { code: 'bad_args', message: 'settings.set' } });
  expect(await request(page, 'settings.set', { section: 'layerPairs', value: { current: { top: 'F.Cu', bottom: 'F.Cu' } } })).toEqual({ error: { code: 'bad_args', message: 'settings.set' } });
  expect((await request(page, 'settings.set', { section: 'router', value: { currentTrack: { index: 999 } } })).error?.code).toBe('bad_args');

  // Back as the engine had them.
  await request(page, 'settings.set', { section: 'router', value: { mode: router.mode, currentTrack: { index: (router.currentTrack as { index: number }).index } } });
  expect((await request(page, 'settings.get', { section: 'router' })).currentTrack).toMatchObject({ custom: false });
  await request(page, 'settings.set', { section: 'layerPairs', value: { pairs: pairs.pairs } });
});
