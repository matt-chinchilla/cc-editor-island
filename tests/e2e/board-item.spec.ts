// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// island v0.2.3-cc18 over the local pair (PROTOCOL.md board.item.get and
// board.item.set): our engine's kicadBoardItemGet and kicadBoardItemSet
// (engine run 12) read and change a footprint, a track, a via, a copper area
// and a board text by uuid, each set ONE undo step through KiCad's own
// setters. The board is drc-small with one via added here (the fixture has
// none, and a via of its own would add a finding to its check).
import { expect, test, type Page } from '@playwright/test';

interface Ev { type: string; phase?: string; depth?: number; open?: boolean; caps?: string[]; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
type Sheet = Record<string, unknown> & { kind: string; uuid: string };

/** drc-small's items (tests/fixtures/drc-small/ids.json) and the via added here. */
const R1 = 'cc0d5a11-0000-4000-8000-000000000100';
const R1_REF_FIELD = 'cc0d5a11-0000-4000-8000-000000000101';
const R1_PAD1 = 'cc0d5a11-0000-4000-8000-000000000107';
const SYM_R1 = 'cc0d5a11-0000-4000-8000-000000000900';
const TRACK = 'cc0d5a11-0000-4000-8000-000000000302';
const TEXT = 'cc0d5a11-0000-4000-8000-000000000400';
const ZONE = 'cc0d5a11-0000-4000-8000-000000000500';
const VIA = 'cc0d5a11-0000-4000-8000-000000000700';
const NOWHERE = 'cc0d5a11-0000-4000-8000-0000000fffff';
/** Glasgow's U1, the Cypress FX2 in its 56 pin QFN. */
const GLASGOW_U1 = '00000000-0000-0000-0000-00005befb37d';

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
const timed = (page: Page, op: string, args: unknown): Promise<{ ms: number; result: Record<string, unknown> }> => page.evaluate(async ([o, a]) => {
  const t0 = performance.now();
  const result = await (window as unknown as Harness).__bridge.request(o as string, a);
  return { ms: Math.round((performance.now() - t0) * 10) / 10, result };
}, [op, args] as const);
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const get = async (page: Page, uuid: string): Promise<Sheet | undefined> => ((await request(page, 'board.item.get', { uuids: [uuid] })) as { items: Sheet[] }).items[0];
const lastDepth = async (page: Page): Promise<number | undefined> => (await of(page, 'ev.edited')).at(-1)?.depth;

async function ready(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
}

/** drc-small with a no-net via at (115, 105) on both copper layers, opened in a board frame. */
async function openWithVia(page: Page): Promise<void> {
  await ready(page, '/parent.html?frame=pcb');
  expect((await of(page, 'ev.ready'))[0]?.caps).toEqual(expect.arrayContaining(['boardItem']));
  const answer = await page.evaluate(async (via) => {
    const text = async (p: string) => (await fetch(`/fixtures/drc-small/${p}`)).text();
    const board = (await text('drc-small.kicad_pcb')).trimEnd();
    const line = `\t(via\n\t\t(at 115 105)\n\t\t(size 0.6)\n\t\t(drill 0.3)\n\t\t(layers "F.Cu" "B.Cu")\n\t\t(net 0)\n\t\t(uuid "${via}")\n\t)\n`;
    const enc = new TextEncoder();
    const files = [
      ...await Promise.all(['drc-small.kicad_pro', 'drc-small.kicad_sch', 'drc-small.kicad_dru'].map(async (path) => ({ path, bytes: enc.encode(await text(path)) }))),
      { path: 'drc-small.kicad_pcb', bytes: enc.encode(`${board.slice(0, board.lastIndexOf(')'))}${line})\n`) },
    ];
    return (window as unknown as Harness).__bridge.request('project.open', { name: 'drc-small', files });
  }, VIA);
  expect(answer).toMatchObject({ opened: 'drc-small.kicad_pcb' });
  await page.waitForTimeout(1_500);   // the open's baseline read
}

test('board.item.get answers every kind with its keys, a field as its footprint, a pad as other, in the order asked', async ({ page }) => {
  await openWithVia(page);
  const items = ((await request(page, 'board.item.get', { uuids: [TRACK, R1_REF_FIELD, R1, VIA, ZONE, TEXT, R1_PAD1, NOWHERE] })) as { items: Sheet[] }).items;
  console.log('[items]', JSON.stringify(items));
  expect(items.map((i) => [i.kind, i.uuid])).toEqual([['track', TRACK], ['footprint', R1], ['via', VIA], ['zone', ZONE], ['text', TEXT], ['other', R1_PAD1]]);
  const [track, fp, via, zone, text, pad] = items;
  expect(fp).toEqual({
    kind: 'footprint', uuid: R1, locked: false, ref: 'R1', value: '10k', libId: 'Resistor_SMD:R_0603_1608Metric', side: 'front',
    x: 106, y: 105, rotation: 0, inBom: true, inPos: true, dnp: false, boardOnly: false, variant: '', symbolPath: `/${SYM_R1}`,
  });
  expect(track).toMatchObject({ kind: 'track', locked: false, net: 'VCC', layer: 'F.Cu', width: 0.2 });
  expect(track.length as number).toBeCloseTo(2.825, 4);
  expect(via).toEqual({ kind: 'via', uuid: VIA, locked: false, net: '', x: 115, y: 105, diameter: 0.6, drill: 0.3, viaType: 'through', top: 'F.Cu', bottom: 'B.Cu' });
  expect(zone).toMatchObject({ kind: 'zone', locked: false, name: 'Pour', net: '', layers: ['B.Cu'], priority: 0, padConnection: 'thermal' });
  expect(zone.netChoices).toEqual(expect.arrayContaining(['SIG', 'VCC']));
  expect(text).toMatchObject({ kind: 'text', locked: false, text: 'drc-small', layer: 'F.SilkS', x: 112, y: 116, rotation: 0, height: 1, width: 1, bold: false, italic: false, knockout: false, mirrored: false, hAlign: 'center' });
  expect(pad).toEqual({ kind: 'other', uuid: R1_PAD1, type: 'pad' });
  const ms: number[] = [];
  for (let i = 0; i < 5; i++) ms.push((await timed(page, 'board.item.get', { uuids: [R1] })).ms);
  measure('board.item.get, one footprint of drc-small', `median ${median(ms)} ms of ${ms.join(', ')} ms`);
});

test('board.item.set: every key of every kind read back as one undo step each, an ev.edited each; Ctrl+Z takes the last back', async ({ page }) => {
  test.setTimeout(240_000);
  await openWithVia(page);
  const sets: Array<[string, Record<string, unknown>]> = [
    [R1, { x: 107.5 }], [R1, { y: 106.25 }], [R1, { rotation: 90 }], [R1, { locked: true }], [R1, { locked: false }], [R1, { side: 'back' }],
    [R1, { inBom: false }], [R1, { inPos: false }], [R1, { dnp: true }],
    [TRACK, { width: 0.25 }], [TRACK, { layer: 'B.Cu' }], [TRACK, { locked: true }],
    [VIA, { x: 116 }], [VIA, { y: 106 }], [VIA, { diameter: 0.8 }], [VIA, { drill: 0.4 }], [VIA, { locked: true }],
    [ZONE, { name: 'Ground' }], [ZONE, { net: 'VCC' }], [ZONE, { priority: 2 }], [ZONE, { clearance: 0.3 }], [ZONE, { minWidth: 0.2 }],
    [ZONE, { padConnection: 'solid' }], [ZONE, { thermalGap: 0.4 }], [ZONE, { spokeWidth: 0.4 }], [ZONE, { locked: true }],
    [TEXT, { text: 'drc-small\nrev A' }], [TEXT, { layer: 'B.SilkS' }], [TEXT, { height: 1.2 }], [TEXT, { width: 1.1 }], [TEXT, { thickness: 0.2 }],
    [TEXT, { bold: true }], [TEXT, { italic: true }], [TEXT, { knockout: true }], [TEXT, { hAlign: 'left' }], [TEXT, { x: 113 }], [TEXT, { y: 117 }],
    [TEXT, { rotation: 90 }], [TEXT, { locked: true }],
  ];
  let depth = (await lastDepth(page)) ?? 0;
  const times: Record<string, number[]> = {};
  for (const [uuid, set] of sets) {
    const key = Object.keys(set)[0];
    const { ms, result } = await timed(page, 'board.item.set', { uuid, set });
    const item = result.item as Sheet;
    (times[item.kind] ??= []).push(ms);
    if (typeof set[key] === 'number') expect(item[key] as number, `${item.kind} ${key}`).toBeCloseTo(set[key] as number, 3);
    else expect(item[key], `${item.kind} ${key}`).toEqual(set[key]);
    depth += 1;
    await expect.poll(() => lastDepth(page), { timeout: 5_000, message: `${item.kind} ${key}: one undo step` }).toBe(depth);
  }
  measure('board.item.set, drc-small, request to read back', Object.entries(times).map(([k, v]) => `${k} median ${median(v)} ms of ${v.length}`).join('; '));
  // A text on the back reads mirrored.
  expect((await get(page, TEXT))?.mirrored).toBe(true);
  expect(await of(page, 'ev.menu')).toEqual([]);
  // Ctrl+Z takes the last set back, one step.
  expect(await request(page, 'key.press', { key: 'z', code: 'KeyZ', ctrl: true })).toEqual({});
  await expect.poll(() => lastDepth(page), { timeout: 5_000 }).toBe(depth - 1);
  expect((await get(page, TEXT))?.locked).toBe(false);
});

test('board.item.set refuses whole: a linked footprint\'s designator, a track off copper, a layer the board does not use, a pad, an item the board lacks', async ({ page }) => {
  await openWithVia(page);
  expect(await refusal(page, 'board.item.set', { uuid: R1, set: { ref: 'R9' } })).toBe('bad_args: board.item.set: R1 takes its designator from the schematic');
  expect(await refusal(page, 'board.item.set', { uuid: TRACK, set: { layer: 'F.SilkS' } })).toBe('bad_args: board.item.set: a track runs on a copper layer');
  expect(await refusal(page, 'board.item.set', { uuid: TRACK, set: { layer: 'In1.Cu' } })).toBe('bad_args: board.item.set');
  expect(await refusal(page, 'board.item.set', { uuid: VIA, set: { drill: 0.7 } })).toBe('bad_args: board.item.set: the hole must be smaller than the via');
  expect(await refusal(page, 'board.item.set', { uuid: R1_PAD1, set: { x: 1 } })).toBe('bad_args: board.item.set: a pad does not change here');
  expect(await refusal(page, 'board.item.set', { uuid: NOWHERE, set: { x: 1 } })).toBe(`not_found: ${NOWHERE}`);
  await page.waitForTimeout(1_200);
  expect(await of(page, 'ev.edited')).toEqual([]);
  expect((await get(page, TRACK))?.layer).toBe('F.Cu');
});

test('Glasgow: one footprint read and set, medians of five', async ({ page }) => {
  test.setTimeout(240_000);
  await ready(page, '/parent.html?fixture=glasgow&frame=pcb');
  await expect(page.locator('#state')).toContainText('opened glasgow.kicad_pcb', { timeout: 120_000 });
  await page.waitForTimeout(1_500);
  const gets: number[] = [];
  for (let i = 0; i < 5; i++) gets.push((await timed(page, 'board.item.get', { uuids: [GLASGOW_U1] })).ms);
  const u1 = await get(page, GLASGOW_U1);
  expect(u1).toMatchObject({ kind: 'footprint', ref: 'U1' });
  const sets: number[] = [];
  for (let i = 0; i < 5; i++) sets.push((await timed(page, 'board.item.set', { uuid: GLASGOW_U1, set: { locked: i % 2 === 0 } })).ms);
  measure('Glasgow U1', `board.item.get median ${median(gets)} ms of ${gets.join(', ')} ms; board.item.set median ${median(sets)} ms of ${sets.join(', ')} ms`);
});
