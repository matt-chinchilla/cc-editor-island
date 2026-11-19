// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// island v0.2.3-cc25 over the local pair, engine run 15 (unit sy4-e): the two
// symbol editor faults of ledger row SY4, read on the real engine.
// 1. A placed part opened in the symbol editor (symbol.forEditor in a sch
//    frame, then symedit.open with mode placed in a symedit frame) reads its
//    designator prefix "U", never the instance's "U1", so KiCad's checker
//    finds no prefix ending in a digit; a prefix set there keeps the number.
// 2. symedit.new with bodyStyles demorgan makes a symbol with two body styles
//    (engine run 14 made one).
// Engine run 14 shows both faults, so this spec runs on cc25 only. The
// fixture is tests/fixtures/symedit-small (U1 is OPAMP2, units A and B).
import { expect, test, type Page } from '@playwright/test';

interface Ev { type: string; phase?: string; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface BodyStyles { mode: string; names: string[] }
interface State { open: boolean; name: string; mode: string; unit: number; bodyStyle: number; bodyStyles: BodyStyles }
interface Item { kind: string; uuid: string; name?: string; text?: string }
interface Finding { code: string; severity: string; pins: string[] }

const U1A = '5e1ec700-0000-4000-8000-000000000101';
const LIB = 'symedit-small_parts';
const FIX = '/fixtures/symedit-small';

const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const request = (page: Page, op: string, args?: unknown): Promise<Record<string, unknown>> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const);
const refusal = (page: Page, op: string, args?: unknown): Promise<string> =>
  request(page, op, args).then(() => 'ok', (err: Error) => err.message.split('\n')[0].replace(/^.*?page\.evaluate:\s*/, '').replace(/^Error:\s*/, ''));

async function boot(page: Page, query: string): Promise<void> {
  await page.goto(`/parent.html?${query}`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  expect((await events(page)).filter((e) => e.type === 'ev.state' && (e.phase === 'fatal' || e.phase === 'blocked'))).toEqual([]);
}
const reference = async (page: Page): Promise<Item> =>
  (((await request(page, 'symedit.items.get', { unit: 0, bodyStyle: 0, kinds: ['field'] })) as { items: Item[] }).items).find((f) => f.name === 'Reference') as Item;
const codes = async (page: Page): Promise<string[]> =>
  (((await request(page, 'symedit.check')) as { findings: Finding[] }).findings).map((f) => f.code);

const form = (o: Record<string, unknown>) => ({
  name: 'NEW_GATE', lib: LIB, parentText: '', parent: '', refPrefix: 'U', unitCount: 1, unitsInterchangeable: false, bodyStyles: 'one', power: 'none',
  pinNameOffset: 0.508, showPinNames: true, showPinNumbers: true, pinNamesInside: true, inBom: true, onBoard: true, inSim: true, keepParentFields: false, discard: true, ...o,
});

test('a placed U1 opened in the symbol editor reads the prefix U: no prefix finding, and a prefix set there keeps the number', async ({ page, context }) => {
  // The schematic side: KiCad's Edit with Symbol Editor on the placed part.
  await boot(page, 'fixture=symedit-small&frame=sch');
  await expect(page.locator('#state')).toContainText('opened symedit-small.kicad_sch', { timeout: 120_000 });
  const placed = (await request(page, 'symbol.forEditor', { uuid: U1A, sheetPath: '/' })) as { name: string; libId: string; text: string };
  expect(placed).toMatchObject({ name: 'OPAMP2', libId: `${LIB}:OPAMP2` });
  const editor = await context.newPage();
  try {
    await boot(editor, 'frame=symedit');
    const s = (await request(editor, 'symedit.open', { text: placed.text, name: placed.name, lib: LIB, mode: 'placed', unit: 1, discard: true })) as unknown as State;
    expect(s).toMatchObject({ open: true, name: 'OPAMP2', mode: 'placed', unit: 1 });
    // The prefix alone, as KiCad's Symbol Properties shows it for a placed part.
    expect(await request(editor, 'symedit.symbol.get')).toMatchObject({ refPrefix: 'U' });
    expect(await codes(editor)).not.toContain('reference_prefix_digit');
    // The designator itself keeps its number: a new prefix gives IC1, never IC.
    expect((await reference(editor)).text).toBe('U1');
    expect(await request(editor, 'symedit.symbol.set', { set: { refPrefix: 'IC' } })).toMatchObject({ refPrefix: 'IC' });
    await expect.poll(async () => (await reference(editor)).text, { timeout: 5_000 }).toBe('IC1');
    expect(await codes(editor)).not.toContain('reference_prefix_digit');
    // The checker still names a real fault: CHECKME's own prefix U1, opened from the library.
    const doc = await editor.evaluate(async (p) => (await fetch(p)).text(), `${FIX}/${LIB}.kicad_sym`);
    await request(editor, 'symedit.open', { text: doc, name: 'CHECKME', lib: LIB, mode: 'library', discard: true });
    expect(await codes(editor)).toContain('reference_prefix_digit');
  } finally {
    await editor.close();
  }
});

test('symedit.new with De Morgan makes two body styles; with one body style it makes one', async ({ page }) => {
  await boot(page, 'frame=symedit');
  const s = (await request(page, 'symedit.new', form({ bodyStyles: 'demorgan' }))) as unknown as State;
  expect(s).toMatchObject({ open: true, name: 'NEW_GATE', mode: 'new', bodyStyle: 1, bodyStyles: { mode: 'demorgan' } });
  expect(await request(page, 'symedit.symbol.get')).toMatchObject({ bodyStyles: { mode: 'demorgan' } });
  // The body style press steps between the two drawings.
  expect(await request(page, 'symedit.show', { unit: 1, bodyStyle: 2 })).toMatchObject({ bodyStyle: 2 });
  expect(await request(page, 'symedit.show', { unit: 1, bodyStyle: 1 })).toMatchObject({ bodyStyle: 1 });
  expect(await refusal(page, 'symedit.show', { unit: 1, bodyStyle: 3 })).toMatch(/^bad_args: symedit\.show/);
  // One body style stays one.
  const one = (await request(page, 'symedit.new', form({ name: 'NEW_ONE', bodyStyles: 'one' }))) as unknown as State;
  expect(one).toMatchObject({ name: 'NEW_ONE', mode: 'new', bodyStyles: { mode: 'one' } });
  expect(await refusal(page, 'symedit.show', { unit: 1, bodyStyle: 2 })).toMatch(/^bad_args: symedit\.show/);
});
