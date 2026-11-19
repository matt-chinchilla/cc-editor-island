// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-editprefs-i over the local pair (PROTOCOL.md, editing preferences): in a
// sch frame ev.ready lists settings:schEditing and settings:mouse, in a pcb
// frame settings:pcbEditing and settings:mouse, exactly when the engine has
// kicadSettingsSections (engine run 15); on run 14 none of the three. Ctrl+,
// sends ev.held common.SuiteControl.openPreferences in both frames and opens
// no window of KiCad's, on any engine with held keys. The sections' reads and
// sets wait for engine run 15 (st-editprefs-e).
import { expect, test, type Frame, type Page } from '@playwright/test';

import { ISLAND } from '../ports';

interface Ev { type: string; open?: boolean; action?: string; caps?: string[]; phase?: string; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface ToolWindowLike { wxElementRegistry: { findAll(f: object): Array<{ typeName: string; name: string }> } }

const PREFERENCES = 'common.SuiteControl.openPreferences';
const RUN15 = 'waits for the engine marker kicadSettingsSections (engine run 15, st-editprefs-e)';
const OWN = { sch: 'schEditing', pcb: 'pcbEditing' } as const;
const OTHER = { sch: 'pcbEditing', pcb: 'schEditing' } as const;

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

/** KiCad's visible top level frames and dialogs. */
const windows = (frame: Frame): Promise<string[]> => frame.evaluate(() => (window as unknown as ToolWindowLike).wxElementRegistry.findAll({ visible: true }).filter((e) => /Frame|Dialog/.test(e.typeName)).map((e) => `${e.typeName}:${e.name}`).sort());

for (const kind of ['sch', 'pcb'] as const) {
  test(`${kind}: the editing caps follow kicadSettingsSections, and Ctrl+, sends ev.held and opens nothing`, async ({ page, browserName }) => {
    const { frame, caps } = await open(page, kind);
    expect(caps).toContain('heldKeys');
    const run15 = caps.includes('kicadSettingsSections');
    expect(caps.includes(`settings:${OWN[kind]}`)).toBe(run15);
    expect(caps.includes('settings:mouse')).toBe(run15);
    expect(caps).not.toContain(`settings:${OTHER[kind]}`);

    const before = frame == null ? null : await windows(frame);
    const held = (await of(page, 'ev.held')).length;
    const menus = (await of(page, 'ev.menu')).length;
    await page.locator('iframe').first().click({ position: { x: 8, y: 8 } });
    await page.keyboard.press('Control+Comma');
    await expect.poll(async () => (await of(page, 'ev.held')).length, { timeout: 5_000, message: 'Ctrl+, sends ev.held' }).toBe(held + 1);
    expect((await of(page, 'ev.held')).at(-1)?.action).toBe(PREFERENCES);
    await page.waitForTimeout(1_500);
    expect((await of(page, 'ev.menu')).length, 'Ctrl+, opens no window').toBe(menus);
    test.skip(frame == null, `${browserName}: the island frame is out of Playwright's reach, so its windows cannot be listed`);
    expect(await windows(frame!)).toEqual(before);
    // The frame still answers.
    expect(await request(page, 'chrome.show', { on: false })).toEqual({});
  });

  test(`${kind} run 15: the frame's sections read and set with no KiCad window, the other drawing's refused`, async ({ page }) => {
    const { caps } = await open(page, kind);
    test.skip(!caps.includes('kicadSettingsSections'), RUN15);
    const own = await request(page, 'settings.get', { section: OWN[kind] });
    expect(Object.keys(own).length).toBeGreaterThan(0);
    const mouse = await request(page, 'settings.get', { section: 'mouse' });
    expect(typeof mouse['input.mouse_middle']).toBe('number');
    const menus = (await of(page, 'ev.menu')).length;
    const edited = (await of(page, 'ev.edited')).length;

    const set = await request(page, 'settings.set', { section: 'mouse', value: { 'input.mouse_middle': 1 } });
    expect((set.value as Record<string, unknown>)['input.mouse_middle']).toBe(1);
    expect((await request(page, 'settings.get', { section: 'mouse' }))['input.mouse_middle']).toBe(1);
    const flip = kind === 'pcb' ? { 'editing.magnetic_pads': 0 } : { 'drawing.line_mode': 0 };
    const setOwn = await request(page, 'settings.set', { section: OWN[kind], value: flip });
    expect(setOwn.value).toMatchObject(flip);
    // App settings: no edit of the design, no window of KiCad's.
    await page.waitForTimeout(1_000);
    expect((await of(page, 'ev.edited')).length).toBe(edited);
    expect((await of(page, 'ev.menu')).length).toBe(menus);

    expect(await refusal(page, 'settings.set', { section: 'mouse', value: { 'input.zoomspeed': 5 } })).toBe('bad_args: settings.set');
    expect(await refusal(page, 'settings.set', { section: 'mouse', value: { 'input.zoom_speed': 11 } })).toMatch(/^bad_args/);
    expect(await refusal(page, 'settings.get', { section: OTHER[kind] })).toBe(`unsupported: ${OTHER[kind]} is a ${kind === 'sch' ? 'board' : 'schematic'} setting`);

    // Back as the engine had them.
    await request(page, 'settings.set', { section: 'mouse', value: { 'input.mouse_middle': mouse['input.mouse_middle'] } });
    const back = Object.fromEntries(Object.keys(flip).map((k) => [k, own[k]]));
    await request(page, 'settings.set', { section: OWN[kind], value: back });
  });
}
