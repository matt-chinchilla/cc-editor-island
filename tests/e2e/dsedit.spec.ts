// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// island v0.2.3-cc25 over the local pair (PROTOCOL.md "The drawing sheet
// editor: a ds frame and the dsedit ops"): KiCad's own drawing sheet editor
// booted with ?frame=ds, canvas only, driven through the dsedit ops on our
// engine's dsedit exports (engine run 15): a sheet opened from its text, or
// KiCad's default or an empty one, taken back as text by KiCad's own
// formatter, marked saved, shown on page 1 or the other pages with its values
// or its names, and the frame's windows held for the host (ev.held). The
// fixtures are tests/fixtures/ds-basic (KiCad's own basic_test) and
// tests/fixtures/ds-small (written by hand).
//
// The first test needs no ds frame and runs on every engine: outside a ds
// frame every dsedit op is unsupported and no frame lists dsedit. Every other
// test boots a ds frame, which needs engine run 15 (the pl_editor kiface in
// the merged image).
import { expect, test, type Frame, type Page } from '@playwright/test';

import { ISLAND } from './ports';
interface Ev { type: string; phase?: string; open?: boolean; shown?: boolean; depth?: number; caps?: string[]; action?: string; uuids?: string[]; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Engine { Module: { HEAP8: { length: number } } }
interface State { token: string; open: boolean; name: string; modified: boolean; depth: number; page: number; values: boolean; items: number }
interface Key { key: string; code: string; ctrl?: boolean; shift?: boolean; alt?: boolean }

const BASIC = '/fixtures/ds-basic';
const SMALL = '/fixtures/ds-small';
const DS_REFUSAL = 'unsupported: a drawing sheet editor opens drawing sheets, not documents';
const DS_FRAME_ONLY = 'unsupported: a drawing sheet edits in a ds frame';
const DS_OPS = ['dsedit.open', 'dsedit.state', 'dsedit.take', 'dsedit.markSaved', 'dsedit.show'];
/** The island's built in pseudo-caps a ds frame never lists (its descriptor allows heldKeys and hostKeys only). */
const BUILTIN_DOCUMENT_CAPS = [
  'picker', 'fields', 'identity', 'selection', 'write', 'projectLibs', 'symbolConvert', 'symedit', 'symeditHeld', 'symbolEdit', 'libUpdate',
  'models', 'plot', 'symbol', 'annotate', 'check', 'boardUpdate', 'drc', 'explain', 'boardItem', 'export', 'rules', 'symbols',
  'symbolExchange', 'schEdit', 'boardFootprints', 'boardEdit', 'footprintExchange', 'settings', 'simModel', 'sim', 'boardProperties', 'properties',
];

function measure(type: string, description: string): void {
  test.info().annotations.push({ type, description });
  console.log(`[measure] ${type}: ${description}`);
}
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const of = async (page: Page, type: string): Promise<Ev[]> => (await events(page)).filter((e) => e.type === type);
const request = (page: Page, op: string, args?: unknown): Promise<Record<string, unknown>> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const);
const refusal = (page: Page, op: string, args?: unknown): Promise<string> =>
  request(page, op, args).then(() => 'ok', (err: Error) => err.message.split('\n')[0].replace(/^.*?page\.evaluate:\s*/, '').replace(/^Error:\s*/, ''));
const timed = (page: Page, op: string, args?: unknown): Promise<{ ms: number; result: Record<string, unknown> }> => page.evaluate(async ([o, a]) => {
  const t0 = performance.now();
  const result = await (window as unknown as Harness).__bridge.request(o as string, a);
  return { ms: Math.round((performance.now() - t0) * 100) / 100, result };
}, [op, args] as const);
const text = (page: Page, path: string): Promise<string> => page.evaluate(async (p) => (await fetch(p)).text(), path);
const heap = async (frame: Frame | null): Promise<number | null> => (frame == null ? null : frame.evaluate(() => (window as unknown as Engine).Module.HEAP8.length));
const mb = (n: number | null): string => (n == null ? 'unread' : `${Math.round(n / 1048576)} MiB`);

async function boot(page: Page, frame: string): Promise<{ frame: Frame | null; readyMs: number }> {
  const t0 = Date.now();
  await page.goto(`/parent.html?frame=${frame}`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  const readyMs = Date.now() - t0;
  expect((await of(page, 'ev.state')).filter((e) => e.phase === 'fatal' || e.phase === 'blocked')).toEqual([]);
  return { frame: page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null, readyMs };
}
const state = async (page: Page): Promise<State> => (await request(page, 'dsedit.state')) as unknown as State;
async function openText(page: Page, path: string, name: string, discard = true): Promise<State> {
  return (await request(page, 'dsedit.open', { source: 'text', text: await text(page, path), name, discard })) as unknown as State;
}
const take = async (page: Page): Promise<{ name: string; text: string }> => (await request(page, 'dsedit.take')) as { name: string; text: string };
/**
 * Presses a key and waits for the next ev.held; no KiCad window opens within a
 * second after. A string is the reader's own chord on the drawing (Playwright's
 * keyboard, the frame focused by a press in its corner): key.press takes only
 * the codes KiCad's default hotkeys use (src/keys.ts), which leave out Comma.
 */
async function heldBy(page: Page, key: Key | string): Promise<string | undefined> {
  const n = (await of(page, 'ev.held')).length;
  const menus = (await of(page, 'ev.menu')).length;
  if (typeof key === 'string') {
    await page.locator('iframe').first().click({ position: { x: 8, y: 8 } });
    await page.keyboard.press(key);
  } else {
    expect(await request(page, 'key.press', key)).toEqual({});
  }
  await expect.poll(async () => (await of(page, 'ev.held')).length, { timeout: 5_000, message: `${JSON.stringify(key)} sends ev.held` }).toBe(n + 1);
  await page.waitForTimeout(1_000);
  expect((await of(page, 'ev.menu')).length, `${JSON.stringify(key)} opens no window`).toBe(menus);
  return (await of(page, 'ev.held')).at(-1)?.action;
}

test('outside a ds frame every dsedit op is unsupported and no frame lists dsedit (any engine)', async ({ page }) => {
  await boot(page, 'sch');
  const caps = (await of(page, 'ev.ready'))[0]?.caps ?? [];
  expect(caps).not.toContain('dsedit');
  expect(caps).not.toContain('dseditHeld');
  for (const op of DS_OPS) expect(await refusal(page, op, {}), op).toBe(DS_FRAME_ONLY);
});

test('boots canvas only: no KiCad window at boot, its own caps only, a document op refused, the heap measured', async ({ page }) => {
  const { frame, readyMs } = await boot(page, 'ds');
  await page.waitForTimeout(5_000);
  expect(await of(page, 'ev.menu')).toEqual([]);
  const caps = ((await of(page, 'ev.ready'))[0]?.caps ?? []).filter((c) => !/^kicad/.test(c));
  expect(caps).toEqual(expect.arrayContaining(['dsedit', 'heldKeys', 'hostKeys']));
  // Of the island's built in pseudo-caps only heldKeys and hostKeys: the others are each a document's (bridge/responder.ts).
  // The wave units' own caps (dseditHeld, m1-i's contextMenu and others as they land) are their units' caps(mod, frame) answers.
  expect(caps.filter((c) => BUILTIN_DOCUMENT_CAPS.includes(c))).toEqual([]);
  expect((await of(page, 'ev.chrome')).at(-1)?.shown ?? false).toBe(false);
  expect(await state(page)).toMatchObject({ open: false, token: '', name: '', modified: false });
  measure('ds boot', `ev.ready ${readyMs} ms after navigation; engine heap 5 s after ready ${mb(await heap(frame))}`);
  for (const op of ['project.open', 'project.write', 'project.save', 'symedit.open', 'place', 'settings.get']) expect(await refusal(page, op, {}), op).toBe(DS_REFUSAL);
  expect(await refusal(page, 'dsedit.take')).toBe('no_sheet: dsedit.take');
  expect(await refusal(page, 'dsedit.show', { page: 2, values: false })).toBe('no_sheet: dsedit.show');
});

test('opens KiCad\'s basic_test sheet; take, open, take is byte stable; every fixture sheet, the default and an empty one open', async ({ page }) => {
  await boot(page, 'ds');
  const s = await openText(page, `${BASIC}/custom_ds.kicad_wks`, 'custom_ds.kicad_wks', false);
  expect(s).toMatchObject({ open: true, name: 'custom_ds.kicad_wks', modified: false, depth: 0, page: 1, values: true });
  expect(s.token).toMatch(/^[\x20-\x7e]{1,64}$/);
  expect(s.items).toBeGreaterThan(0);
  const first = await take(page);
  expect(first.name).toBe('custom_ds.kicad_wks');
  expect(first.text).toMatch(/^\(kicad_wks/);
  const again = (await request(page, 'dsedit.open', { source: 'text', text: first.text, name: 'custom_ds.kicad_wks', discard: false })) as unknown as State;
  expect(again.items).toBe(s.items);
  expect((await take(page)).text, 'take, open, take').toBe(first.text);
  // A take carries no uuid (kicad-cli 10.0 refuses one), so a reopened take gives each item a fresh uuid: same items, same text.
  expect(first.text).not.toMatch(/\(uuid /);
  // every-item holds nine items, every kind KiCad's sheet editor draws (seen on engine build T3 and T4).
  for (const [file, n] of [['every-item.kicad_wks', 9], ['legacy.kicad_wks', 3]] as const) {
    const opened = await openText(page, `${SMALL}/${file}`, file);
    expect(opened.items, file).toBe(n);
  }
  // The legacy codes are read as KiCad's text variables.
  expect((await take(page)).text).toContain('${TITLE}');
  const def = (await request(page, 'dsedit.open', { source: 'default', name: 'new.kicad_wks', discard: false })) as unknown as State;
  expect(def.items).toBeGreaterThan(0);
  const empty = (await request(page, 'dsedit.open', { source: 'empty', name: 'blank.kicad_wks', discard: false })) as unknown as State;
  // KiCad's own empty sheet (emptyDrawingSheet, SetEmptyLayout) keeps one zero length line.
  expect(empty).toMatchObject({ open: true, name: 'blank.kicad_wks', items: 1 });
  const doc = await text(page, `${BASIC}/custom_ds.kicad_wks`);
  const opens: number[] = [];
  const takes: number[] = [];
  for (let i = 0; i < 5; i++) {
    opens.push((await timed(page, 'dsedit.open', { source: 'text', text: doc, name: 'custom_ds.kicad_wks', discard: true })).ms);
    takes.push((await timed(page, 'dsedit.take')).ms);
  }
  measure('dsedit.open and take, custom_ds', `open median ${median(opens)} ms of ${opens.join(', ')}; take median ${median(takes)} ms of ${takes.join(', ')}`);
});

test('refuses an unreadable sheet with KiCad\'s line and changes nothing', async ({ page }) => {
  await boot(page, 'ds');
  const before = await openText(page, `${BASIC}/custom_ds.kicad_wks`, 'custom_ds.kicad_wks');
  const said = await refusal(page, 'dsedit.open', { source: 'text', text: await text(page, `${SMALL}/broken.kicad_wks`), name: 'broken.kicad_wks', discard: true });
  expect(said).toMatch(/^unreadable: .*line/);
  measure('dsedit.open, broken.kicad_wks', said);
  expect(await state(page)).toMatchObject({ token: before.token, name: 'custom_ds.kicad_wks', items: before.items });
});

test('show changes the drawing and leaves the depth; markSaved takes only the open\'s token', async ({ page }) => {
  await boot(page, 'ds');
  const s = await openText(page, `${SMALL}/every-item.kicad_wks`, 'every-item.kicad_wks');
  const shown = (await request(page, 'dsedit.show', { page: 2, values: false })) as unknown as State;
  expect(shown).toMatchObject({ page: 2, values: false, depth: s.depth, modified: false });
  const back = (await request(page, 'dsedit.show', { page: 1, values: true })) as unknown as State;
  expect(back).toMatchObject({ page: 1, values: true, depth: s.depth });
  expect(await refusal(page, 'dsedit.markSaved', { token: 'not-the-open-token' })).toBe("bad_args: dsedit.markSaved: the token is not the open sheet's");
  expect(await request(page, 'dsedit.markSaved', { token: s.token })).toMatchObject({ modified: false, token: s.token });
});

test('Ctrl+S, Ctrl+O, Ctrl+N, Ctrl+P and Ctrl+, each send ev.held and open no KiCad window', async ({ page }) => {
  await boot(page, 'ds');
  await openText(page, `${BASIC}/custom_ds.kicad_wks`, 'custom_ds.kicad_wks');
  const keys: Array<[Key | string, string]> = [
    [{ key: 's', code: 'KeyS', ctrl: true }, 'common.Control.save'],
    [{ key: 'o', code: 'KeyO', ctrl: true }, 'common.Control.open'],
    [{ key: 'n', code: 'KeyN', ctrl: true }, 'common.Control.new'],
    [{ key: 'p', code: 'KeyP', ctrl: true }, 'common.Control.print'],
    ['Control+Comma', 'common.SuiteControl.openPreferences'],
  ];
  for (const [key, action] of keys) expect(await heldBy(page, key), action).toBe(action);
  await page.screenshot({ path: test.info().outputPath('held-keys.png') });
  // Nothing of KiCad's took the sheet meanwhile.
  expect(await state(page)).toMatchObject({ open: true, name: 'custom_ds.kicad_wks' });
});
