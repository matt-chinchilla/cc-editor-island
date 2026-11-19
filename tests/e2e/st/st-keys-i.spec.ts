// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-keys-i over the local pair (PROTOCOL.md keys.editor.get and
// keys.editor.set): in a sch and a pcb frame ev.ready lists hotkeys exactly
// when the engine has kicadHotkeysGet and kicadHotkeysSet (engine run 15);
// on run 14 it is absent and both ops answer unsupported naming the export.
// Ctrl+F1 sends ev.held common.SuiteControl.listHotKeys in both frames and
// opens no window of KiCad's, on any engine with held keys. The reads and
// sets wait for engine run 15 (st-keys-e): there keys.editor.get answers the
// actions with their keys and defaults, and after keys.editor.set gives Draw
// Wires Shift+W, Shift+W from the keyboard starts a wire and W does not.
import { expect, test, type Frame, type Page } from '@playwright/test';

import { ISLAND } from '../ports';

interface Ev { type: string; open?: boolean; action?: string; caps?: string[]; phase?: string; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface ToolWindowLike { wxElementRegistry: { findAll(f: object): Array<{ typeName: string; name: string }> } }
interface KeyRow { action: string; key: string; default: string; label?: string; alt: string }

const LIST_HOTKEYS = 'common.SuiteControl.listHotKeys';
const WIRE = 'eeschema.InteractiveDrawingLineWireBus.drawWires';
const RUN15 = 'waits for the engine exports kicadHotkeysGet and kicadHotkeysSet (engine run 15, st-keys-e)';
const UNDO = { key: 'z', code: 'KeyZ', ctrl: true };
const ESCAPE = { key: 'Escape', code: 'Escape' };

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

/** A point of the drawing, in page pixels, at fractions of the island frame's box. */
async function at(page: Page, fx: number, fy: number): Promise<[number, number]> {
  const box = await page.locator('iframe').first().boundingBox();
  if (box == null) throw new Error('no iframe box');
  return [box.x + box.width * fx, box.y + box.height * fy];
}

/**
 * Presses `keys` from the keyboard (a Shift chord reaches KiCad only so: the
 * keyboard sends Shift down first, PROTOCOL.md key.press), then draws from
 * one point to another as the wire tool takes it (a press, then a double
 * press that ends the wire) and leaves the tool. Answers whether the design
 * was edited.
 */
async function drawsAWire(page: Page, keys: string): Promise<boolean> {
  const edits = (await of(page, 'ev.edited')).length;
  await page.mouse.click(...(await at(page, 0.5, 0.06)));
  await page.keyboard.press(keys);
  await page.waitForTimeout(500);
  await page.mouse.click(...(await at(page, 0.42, 0.5)));
  await page.waitForTimeout(300);
  await page.mouse.dblclick(...(await at(page, 0.46, 0.5)));
  await page.waitForTimeout(500);
  expect(await request(page, 'key.press', ESCAPE)).toEqual({});
  expect(await request(page, 'key.press', ESCAPE)).toEqual({});
  await page.waitForTimeout(1_500);
  return (await of(page, 'ev.edited')).length > edits;
}

for (const kind of ['sch', 'pcb'] as const) {
  test(`${kind}: hotkeys follows both exports, the ops answer unsupported without them, and Ctrl+F1 sends ev.held and opens nothing`, async ({ page, browserName }) => {
    const { frame, caps } = await open(page, kind);
    expect(caps).toContain('heldKeys');
    const run15 = caps.includes('kicadHotkeysGet') && caps.includes('kicadHotkeysSet');
    expect(caps.includes('hotkeys')).toBe(run15);
    if (!run15) {
      expect(await refusal(page, 'keys.editor.get')).toBe(`unsupported: ${caps.includes('kicadHotkeysGet') ? 'kicadHotkeysSet' : 'kicadHotkeysGet'}`);
      expect(await refusal(page, 'keys.editor.set', { keys: { 'common.Control.zoomFitScreen': 'Home' } })).toMatch(/^unsupported: kicadHotkeys(Get|Set)$/);
    }
    expect(await refusal(page, 'keys.editor.set', { keys: {} })).toBe('bad_args: keys.editor.set');

    const before = frame == null ? null : await windows(frame);
    const held = (await of(page, 'ev.held')).length;
    const menus = (await of(page, 'ev.menu')).length;
    await page.locator('iframe').first().click({ position: { x: 8, y: 8 } });
    await page.keyboard.press('Control+F1');
    await expect.poll(async () => (await of(page, 'ev.held')).length, { timeout: 5_000, message: 'Ctrl+F1 sends ev.held' }).toBe(held + 1);
    expect((await of(page, 'ev.held')).at(-1)?.action).toBe(LIST_HOTKEYS);
    await page.waitForTimeout(1_500);
    expect((await of(page, 'ev.menu')).length, 'Ctrl+F1 opens no window').toBe(menus);
    test.skip(frame == null, `${browserName}: the island frame is out of Playwright's reach, so its windows cannot be listed`);
    expect(await windows(frame!)).toEqual(before);
    expect(await request(page, 'chrome.show', { on: false })).toEqual({});
  });

  test(`${kind} run 15: keys.editor.get answers the editor's actions with their keys and defaults`, async ({ page }) => {
    const { caps } = await open(page, kind);
    test.skip(!caps.includes('hotkeys'), RUN15);
    const got = await request(page, 'keys.editor.get');
    expect(got.editor).toBe(kind);
    const actions = got.actions as KeyRow[];
    expect(actions.length).toBeGreaterThan(50);
    const own = kind === 'sch' ? 'eeschema.' : 'pcbnew.';
    const other = kind === 'sch' ? 'pcbnew.' : 'eeschema.';
    expect(actions.some((a) => a.action.startsWith(own))).toBe(true);
    expect(actions.some((a) => a.action.startsWith(other))).toBe(false);
    const known = kind === 'sch' ? { action: 'eeschema.InteractiveEdit.rotateCCW', default: 'R' } : { action: 'pcbnew.InteractiveRouter.SingleTrack', default: 'X' };
    expect(actions.find((a) => a.action === known.action)).toMatchObject({ default: known.default });
    // A set of nothing new is no edit.
    const edits = (await of(page, 'ev.edited')).length;
    const row = actions.find((a) => a.action === known.action)!;
    expect(await request(page, 'keys.editor.set', { keys: { [row.action]: row.key } })).toEqual({});
    await page.waitForTimeout(500);
    expect((await of(page, 'ev.edited')).length).toBe(edits);
  });
}

test('sch run 15: Draw Wires takes Shift+W, W no longer starts a wire, a seeded chord is refused, and the key goes back', async ({ page }) => {
  const { caps } = await open(page, 'sch');
  test.skip(!caps.includes('hotkeys'), RUN15);
  const menus = (await of(page, 'ev.menu')).length;
  const actions = (await request(page, 'keys.editor.get')).actions as KeyRow[];
  const wire = actions.find((a) => a.action === WIRE);
  expect(wire, 'the schematic editor lists Draw Wires').toBeDefined();
  // A chord the island seeds for another tool is kept for it.
  const rect = actions.find((a) => a.action === 'common.Interactive.selectSetRect');
  expect(rect?.key).toBe('Ctrl+Alt+1');
  expect(await refusal(page, 'keys.editor.set', { keys: { [WIRE]: 'Ctrl+Alt+1' } })).toBe('taken: Ctrl+Alt+1 is the island\'s chord for common.Interactive.selectSetRect');
  expect(await request(page, 'keys.editor.set', { keys: { [WIRE]: 'Shift+W' } })).toEqual({});
  const after = ((await request(page, 'keys.editor.get')).actions as KeyRow[]).find((a) => a.action === WIRE);
  expect(after).toMatchObject({ key: 'Shift+W', default: wire!.default, alt: wire!.alt });

  expect(await drawsAWire(page, 'w'), 'W no longer starts a wire').toBe(false);
  expect(await drawsAWire(page, 'Shift+W'), 'Shift+W starts a wire').toBe(true);
  await page.screenshot({ path: test.info().outputPath('wire-from-shift-w.png') });
  expect(await request(page, 'key.press', UNDO)).toEqual({});
  if (wire!.alt !== '') {
    // The second key is kept: it still starts a wire.
    expect(await drawsAWire(page, wire!.alt.replace('Ctrl', 'Control'))).toBe(true);
    expect(await request(page, 'key.press', UNDO)).toEqual({});
  }

  // Back as the engine had it.
  expect(await request(page, 'keys.editor.set', { keys: { [WIRE]: wire!.key } })).toEqual({});
  expect(((await request(page, 'keys.editor.get')).actions as KeyRow[]).find((a) => a.action === WIRE)?.key).toBe(wire!.key);
  expect((await of(page, 'ev.menu')).length, 'no window of KiCad\'s opened').toBe(menus);
});
