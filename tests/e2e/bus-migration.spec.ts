// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// m10-i over the local pair (PROTOCOL.md buses.migration.get,
// buses.migration.apply). On engine run 14 the cap busMigration is absent
// and both ops answer unsupported naming the export. On engine run 15
// (cc25): bus-conflict opens with no ev.menu and no dialog (KiCad's Migrate
// Buses window never opens); buses.migration.get lists its two buses, each
// with its two labels and KiCad's proposals, and not the bus of one name;
// buses.migration.apply names both as ONE undo step with ONE ev.edited, and
// /tmp/cc-buses holds no folder after it; a second get answers an empty
// list; a uuid the schematic does not hold answers bus_label_unknown; one
// undo brings both buses back; on Glasgow get answers an empty list in under
// 50 ms.
import { expect, test, type Frame, type Page } from '@playwright/test';
import { ISLAND } from './ports';

interface Ev { type: string; phase?: string; caps?: string[]; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Engine {
  Module: { kicadCollabTestUndoDepth(): number };
  FS: { readdir(p: string): string[]; analyzePath(p: string): { exists: boolean } };
  wxElementRegistry: { findAll(f: object): Array<{ typeName: string }> };
}
interface Bus { id: number; sheetPath: string; labels: Array<{ uuid: string; text: string }>; proposals: string[] }

const RUN15 = 'waits for engine run 15 (pcbjam cc_e9_sch.inc, unit m10-e: kicadBusMigrationGet, kicadBusMigrationApply)';
const UNDO = { key: 'z', code: 'KeyZ', ctrl: true };
const FIXTURE_DOC: Record<string, string> = { 'bus-conflict': 'bus-conflict.kicad_sch', glasgow: 'glasgow.kicad_sch' };

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
/** A request timed in the page. */
const timed = (page: Page, op: string, args?: unknown): Promise<{ ms: number; result: Record<string, unknown> }> =>
  page.evaluate(async ([o, a]) => {
    const t0 = performance.now();
    const result = await (window as unknown as Harness).__bridge.request(o as string, a);
    return { ms: Math.round((performance.now() - t0) * 100) / 100, result };
  }, [op, args] as const);

/** Boots a sch frame on `fixture` and answers ev.ready's caps and the island frame (null where Playwright cannot reach it). */
async function boot(page: Page, fixture: 'bus-conflict' | 'glasgow'): Promise<{ caps: string[]; island: Frame | null }> {
  await page.goto(`/parent.html?fixture=${fixture}&frame=sch`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  const caps = (await of(page, 'ev.ready'))[0]?.caps ?? [];
  await expect(page.locator('#state')).toContainText(`opened ${FIXTURE_DOC[fixture]}`, { timeout: 120_000 });
  await page.waitForTimeout(1_500);   // ev.edited's baseline
  return { caps, island: page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null };
}
const undoDepth = (island: Frame): Promise<number> => island.evaluate(() => Number((window as unknown as Engine).Module.kicadCollabTestUndoDepth()));
const dialogsUp = (island: Frame): Promise<string[]> =>
  island.evaluate(() => (window as unknown as Engine).wxElementRegistry.findAll({ visible: true }).map((e) => e.typeName)).then((t) => t.filter((n) => /Dialog/.test(n)));
/** The folders left under /tmp/cc-buses. */
const leftOver = (island: Frame): Promise<string[]> => island.evaluate(() => {
  const { FS } = window as unknown as Engine;
  return FS.analyzePath('/tmp/cc-buses').exists ? FS.readdir('/tmp/cc-buses').filter((n) => n !== '.' && n !== '..') : [];
});
const busesOf = async (page: Page): Promise<Bus[]> => ((await request(page, 'buses.migration.get')) as { buses: Bus[] }).buses;
const textsOf = (b: Bus): string[] => b.labels.map((l) => l.text).sort();

test('run 14 or 15: the cap follows the exports; without them both ops answer unsupported naming the export', async ({ page }) => {
  const { caps } = await boot(page, 'glasgow');
  const run15 = ['kicadBusMigrationGet', 'kicadBusMigrationApply', 'kicadCollabBusy'].every((e) => caps.includes(e));
  expect(caps.includes('busMigration')).toBe(run15);
  const choice = { choices: [{ labels: ['00000000-0000-4000-8000-000000000000'], name: 'X' }] };
  if (!caps.includes('kicadBusMigrationGet')) expect(await refusal(page, 'buses.migration.get')).toBe('unsupported: kicadBusMigrationGet');
  if (!caps.includes('kicadBusMigrationApply')) expect(await refusal(page, 'buses.migration.apply', choice)).toBe('unsupported: kicadBusMigrationApply');
  expect(await refusal(page, 'buses.migration.get', { all: true })).toBe('bad_args: buses.migration.get');
  expect(await refusal(page, 'buses.migration.apply', { choices: [] })).toBe('bad_args: buses.migration.apply');
});

test('run 15, bus-conflict: no window at open; two buses listed; one apply names both as one undo step; then none', async ({ page, browserName }) => {
  const { caps, island } = await boot(page, 'bus-conflict');
  test.skip(!caps.includes('busMigration'), RUN15);
  expect(await of(page, 'ev.menu')).toEqual([]);
  if (island != null) expect(await dialogsUp(island)).toEqual([]);

  const got = await timed(page, 'buses.migration.get');
  measure('buses.migration.get, bus-conflict', `${got.ms} ms`);
  const buses = (got.result as { buses: Bus[] }).buses;
  expect(buses).toHaveLength(2);
  expect(buses.map(textsOf).sort()).toEqual([['ADDR[0..1]', 'A[0..1]'], ['DATA[0..3]', 'D[0..3]']]);   // code unit order: 'D' sorts before '['
  for (const b of buses) {
    expect(b.sheetPath).toBe('/');
    expect(b.proposals.length).toBeGreaterThan(0);
    for (const p of b.proposals) expect(typeof p).toBe('string');
  }
  expect(buses.flatMap(textsOf)).not.toContain('CTRL[0..1]');

  const nameOf = (b: Bus): string => (textsOf(b).includes('DATA[0..3]') ? 'DATA[0..3]' : 'ADDR[0..1]');
  const choices = buses.map((b) => ({ labels: b.labels.map((l) => l.uuid), name: nameOf(b) }));
  expect(await refusal(page, 'buses.migration.apply', { choices: [{ labels: ['00000000-0000-4000-8000-000000000000'], name: 'X' }] })).toBe('bus_label_unknown: buses.migration.apply');
  expect(await busesOf(page)).toHaveLength(2);

  test.skip(island == null, `${browserName}: the island frame is out of Playwright's reach, so the undo depth and the run folders cannot be read`);
  const depth0 = await undoDepth(island!);
  const edits0 = (await of(page, 'ev.edited')).length;
  const applied = await timed(page, 'buses.migration.apply', { choices });
  measure('buses.migration.apply, two buses', `${applied.ms} ms`);
  expect(applied.result).toEqual({ applied: 2, labels: 4 });
  expect(await leftOver(island!)).toEqual([]);
  expect(await undoDepth(island!)).toBe(depth0 + 1);
  await expect.poll(async () => (await of(page, 'ev.edited')).length, { timeout: 5_000 }).toBe(edits0 + 1);
  await page.waitForTimeout(500);
  expect((await of(page, 'ev.edited')).length).toBe(edits0 + 1);
  expect(await busesOf(page)).toEqual([]);

  // One undo brings both buses and their names back.
  expect(await request(page, 'key.press', UNDO)).toEqual({});
  await expect.poll(() => undoDepth(island!), { timeout: 5_000 }).toBe(depth0);
  expect((await busesOf(page)).map(textsOf).sort()).toEqual([['ADDR[0..1]', 'A[0..1]'], ['DATA[0..3]', 'D[0..3]']]);   // code unit order: 'D' sorts before '['
});

test('run 15, Glasgow: no bus needs a name, answered in under 50 ms', async ({ page }) => {
  const { caps } = await boot(page, 'glasgow');
  test.skip(!caps.includes('busMigration'), RUN15);
  const got = await timed(page, 'buses.migration.get');
  measure('buses.migration.get, Glasgow schematic', `${got.ms} ms`);
  expect(got.result).toEqual({ buses: [] });
  expect(got.ms).toBeLessThan(50);
});
