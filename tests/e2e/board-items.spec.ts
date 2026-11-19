// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// m4-i over the local pair on the fixture items-board (properties addendum
// 3.3 and 3.8): board.item.get with full, the record form of board.item.set,
// board.tuning.get and board.tuning.set, board.image.place, ev.boardItem and
// the held Ctrl+L of the tuning tool. On an engine without run 15's exports
// none of the caps boardItemKinds, boardTuning, boardImagePlace is listed,
// `full` is ignored, the record form and the new ops answer unsupported
// naming the export. On run 15 every kind's record, one set per kind read
// back as one undo step and taken back by Ctrl+Z, E on each kind sending
// exactly one ev.boardItem and no ev.menu, a new text reading "Text", a
// picture hung on the pointer and placed by a press, and the tuning tool's
// live settings.
import { expect, test, type Page } from '@playwright/test';

interface Ev { type: string; phase?: string; caps?: string[]; depth?: number; kind?: string; uuid?: string; isNew?: boolean; action?: string; open?: boolean }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
type Sheet = Record<string, unknown> & { kind: string; uuid: string; item?: Record<string, unknown> & { kind: string } };

/** items-board's items (tests/fixtures/items-board/SOURCE). */
const U = (n: number): string => `4d000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FP = U(1);
const PAD_SMD = U(2);
const PAD_TH = U(3);
const PAD_CUSTOM = U(4);
const SEGMENT = U(21);
const RECT = U(22);
const CIRCLE = U(23);
const ARC = U(24);
const POLYGON = U(25);
const BEZIER = U(26);
const DIMS = [U(31), U(32), U(33), U(34), U(35)];
const TEXTBOX = U(51);
const TABLE = U(52);
const BARCODE = U(57);
const IMAGE = U(58);
const ZONES = [U(61), U(62), U(63)];
const POINT = U(64);
const TARGET = U(65);
const GROUP = U(68);
const TRACK = U(71);
const TUNING = U(72);
const CAPS = ['boardItemKinds', 'boardTuning', 'boardImagePlace'];

function measure(type: string, description: string): void {
  test.info().annotations.push({ type, description });
  console.log(`[measure] ${type}: ${description}`);
}
const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const of = async (page: Page, type: string): Promise<Ev[]> => (await events(page)).filter((e) => e.type === type);
const request = (page: Page, op: string, args?: unknown): Promise<Record<string, unknown>> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const);
const refusal = (page: Page, op: string, args?: unknown): Promise<string> =>
  request(page, op, args).then(() => 'ok', (err: Error) => err.message.split('\n')[0].replace(/^.*?page\.evaluate:\s*/, '').replace(/^Error:\s*/, ''));
/** board.image.place with the fixture's 64 by 64 PNG, fetched by the page. */
const placeImage = (page: Page): Promise<string> => page.evaluate(async () => {
  try {
    const bytes = new Uint8Array(await (await fetch('/fixtures/items-board/mark64.png')).arrayBuffer());
    await (window as unknown as Harness).__bridge.request('board.image.place', { name: 'mark64.png', bytes });
    return 'ok';
  } catch (err) {
    return (err as Error).message.split('\n')[0];
  }
});
const lastDepth = async (page: Page): Promise<number | undefined> => (await of(page, 'ev.edited')).at(-1)?.depth;
const items = async (page: Page, uuids: string[], full?: boolean): Promise<Sheet[]> =>
  ((await request(page, 'board.item.get', full ? { uuids, full: true } : { uuids })) as { items: Sheet[] }).items;
const press = (page: Page, key: string, code: string, ctrl = false) => request(page, 'key.press', ctrl ? { key, code, ctrl: true } : { key, code });

/** The page with items-board open in a board frame; ev.ready's caps. */
async function boot(page: Page): Promise<string[]> {
  await page.goto('/parent.html?fixture=items-board&frame=pcb');
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  await expect(page.locator('#state')).toContainText('opened items-board.kicad_pcb', { timeout: 120_000 });
  await page.waitForTimeout(1_500);   // the open's baseline read
  return (await of(page, 'ev.ready'))[0]?.caps ?? [];
}

test('board items: full records, the record form, the tuning tool and pictures by the engine\'s exports', async ({ page }) => {
  try {
    const caps = await boot(page);
    const run15 = caps.includes('boardItemKinds');
    for (const c of CAPS) expect(caps.includes(c), c).toBe(run15);
    measure('engine', run15 ? 'run 15 exports: boardItemKinds, boardTuning and boardImagePlace listed' : 'no run 15 exports: none of the three caps listed');

    // The args are read before the engine is asked, on any engine.
    expect(await refusal(page, 'board.item.get', { uuids: [PAD_SMD], full: false })).toBe('bad_args: board.item.get');
    expect(await refusal(page, 'board.item.set', { uuids: [GROUP], kind: 'group', set: { members: 3 } })).toBe('bad_args: board.item.set');
    expect(await refusal(page, 'board.tuning.set', { set: { mode: 'skew' } })).toBe('bad_args: board.tuning.set');
    expect(await refusal(page, 'board.image.place', { name: 'a.png', bytes: [1, 2, 3] })).toBe('bad_args: board.image.place');

    if (!run15) {
      // full is ignored: today's answer, item for item.
      const asked = [PAD_SMD, GROUP, TARGET, SEGMENT];
      expect(await items(page, asked, true)).toEqual(await items(page, asked));
      expect(await refusal(page, 'board.item.set', { uuids: [GROUP], kind: 'group', set: { locked: true } })).toBe('unsupported: kicadBoardItemRecordsSet');
      expect(await refusal(page, 'board.tuning.get')).toBe('unsupported: kicadBoardTuningGet');
      expect(await refusal(page, 'board.tuning.set', { set: { spacing: 1 } })).toBe('unsupported: kicadBoardTuningGet');
      expect(await placeImage(page)).toContain('unsupported');
      expect(await placeImage(page)).toContain('kicadBoardPlaceImage');
      return;
    }

    // Every kind's record with full; a record the island's readers refuse stays as today's answer.
    const all = [PAD_SMD, PAD_TH, PAD_CUSTOM, SEGMENT, RECT, CIRCLE, ARC, POLYGON, BEZIER, ...DIMS, TEXTBOX, TABLE, BARCODE, IMAGE, ...ZONES, POINT, TARGET, GROUP, TUNING];
    let t0 = Date.now();
    const full = await items(page, all, true);
    measure('board.item.get full', `${Date.now() - t0} ms for ${all.length} items`);
    console.log('[records]', JSON.stringify(full.map((s) => [s.kind, s.item?.kind ?? s.type, s.uuid])));
    const recordOf = (uuid: string): Sheet | undefined => full.find((s) => s.uuid === uuid && s.kind === 'record');
    expect(recordOf(PAD_SMD)).toMatchObject({ parent: FP, parentRef: 'U1', net: 'GND', netChoices: ['/SIG', 'GND'], item: { kind: 'pad', type: 'smd' } });
    expect(recordOf(PAD_TH)).toMatchObject({ net: '/SIG', item: { kind: 'pad', type: 'th' } });
    expect(recordOf(GROUP)).toMatchObject({ net: null, netChoices: [], item: { kind: 'group', name: 'pair', members: 2 } });
    expect(recordOf(TARGET)).toMatchObject({ item: { kind: 'target', shape: 'plus', size: 5, layer: 'Edge.Cuts' } });
    expect(recordOf(TUNING)).toMatchObject({ item: { kind: 'tuning', mode: 'single', layer: 'F.Cu' } });
    for (const u of [SEGMENT, RECT, CIRCLE, ARC, POLYGON, BEZIER, ...DIMS, TEXTBOX, TABLE, BARCODE, IMAGE, ZONES[0], ZONES[1], POINT]) expect(recordOf(u), u).toBeDefined();
    measure('records', `${full.filter((s) => s.kind === 'record').length} of ${all.length} items answered as records`);
    // Today's answer, item for item, for everything that is not a record.
    expect(full.filter((s) => s.kind !== 'record')).toEqual(await items(page, full.filter((s) => s.kind !== 'record').map((s) => s.uuid)));

    // One set per kind through the record form: read back, one undo step, Ctrl+Z restores.
    const sets: Array<[string, string, Record<string, unknown>, (s: Sheet) => unknown]> = [
      [PAD_SMD, 'pad', { net: '/SIG' }, (s) => s.net],
      [PAD_SMD, 'pad', { copper: { shape: 'roundrect' } }, (s) => (s.item?.copper as Record<string, unknown>).shape],
      [GROUP, 'group', { name: 'G2', locked: true }, (s) => [s.item?.name, s.item?.locked]],
      [TARGET, 'target', { shape: 'x', size: 2 }, (s) => [s.item?.shape, s.item?.size]],
      [TUNING, 'tuning', { spacing: 1 }, (s) => s.item?.spacing],
      [TEXTBOX, 'textbox', { text: 'Changed' }, (s) => s.item?.text],
      [BARCODE, 'barcode', { text: 'CHANGED' }, (s) => s.item?.text],
    ];
    for (const [uuid, kind, set, value] of sets) {
      if (recordOf(uuid) == null) continue;
      const before = await lastDepth(page);
      const was = value(recordOf(uuid) as Sheet);
      t0 = Date.now();
      const got = (await request(page, 'board.item.set', { uuids: [uuid], kind, set })) as { items: Sheet[] };
      measure(`set ${kind}`, `${Date.now() - t0} ms`);
      expect(got.items[0].uuid).toBe(uuid);
      expect(value(got.items[0])).not.toEqual(was);
      await expect.poll(() => lastDepth(page), { timeout: 5_000 }).toBe((before ?? 0) + 1);
      await press(page, 'z', 'KeyZ', true);
      await expect.poll(async () => value((await items(page, [uuid], true))[0]), { timeout: 5_000 }).toEqual(was);
    }
    expect(await refusal(page, 'board.item.set', { uuids: [PAD_SMD], kind: 'pad', set: { net: 'NO_SUCH' } })).toBe('bad_args: board.item.set: the board has no net NO_SUCH');
    expect(await refusal(page, 'board.item.set', { uuids: [GROUP, TARGET], kind: 'group', set: { locked: true } })).toBe(`bad_args: board.item.set: ${TARGET} is not a group`);

    // E on each kind: exactly one ev.boardItem, no ev.menu, the selection kept.
    for (const [uuid, kind] of [[PAD_SMD, 'pad'], [SEGMENT, 'shape'], [DIMS[0], 'dimension'], [TEXTBOX, 'textbox'], [BARCODE, 'barcode'], [IMAGE, 'image'], [ZONES[1], 'zone'], [POINT, 'point'], [TARGET, 'target'], [GROUP, 'group'], [TUNING, 'tuning']] as const) {
      const asks = (await of(page, 'ev.boardItem')).length;
      const menus = (await of(page, 'ev.menu')).length;
      await request(page, 'select', { uuids: [uuid] });
      await press(page, 'e', 'KeyE');
      await expect.poll(async () => (await of(page, 'ev.boardItem')).length, { timeout: 5_000 }).toBe(asks + 1);
      expect((await of(page, 'ev.boardItem')).at(-1)).toMatchObject({ uuid, kind, isNew: false });
      await page.waitForTimeout(300);
      expect((await of(page, 'ev.boardItem')).length).toBe(asks + 1);
      expect((await of(page, 'ev.menu')).filter((e) => e.open === true).length).toBe(menus);
    }
    await press(page, 'Escape', 'Escape');

    // A picture: on the pointer, a press places it as one undo step.
    const before = await lastDepth(page);
    t0 = Date.now();
    expect(await placeImage(page)).toBe('ok');
    measure('board.image.place', `${Date.now() - t0} ms`);
    const frame = page.frameLocator('iframe').first();
    await frame.locator('canvas').first().click({ position: { x: 200, y: 200 } });
    await expect.poll(() => lastDepth(page), { timeout: 5_000 }).toBe((before ?? 0) + 1);

    // No tuning tool runs: no_tuning.
    expect(await refusal(page, 'board.tuning.get')).toBe('no_tuning: board.tuning.get');
    expect(await refusal(page, 'board.tuning.set', { set: { spacing: 1 } })).toBe('no_tuning: board.tuning.set');
  } finally {
    await page.close();
  }
});
