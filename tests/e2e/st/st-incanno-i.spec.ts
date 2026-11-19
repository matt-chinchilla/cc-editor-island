// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-incanno-i over the local pair (PROTOCOL.md sheet.increment) on Glasgow.
// On engine run 14 the cap incrementAnnotations is absent, sheet.increment
// answers unsupported naming kicadSchIncrementAnnotations, and KiCad's
// Increment Annotations From is left to KiCad. On engine run 15 (cc25):
// { first: "R10", by: 100, allSheets: true } moves every R10 and above to
// R110 and above on every sheet, R1 to R9 and every other prefix unchanged,
// in one undo step with an ev.edited, and one undo takes it all back; a first
// that matches no part answers shifted false with no undo step; the action
// sends ev.held and opens no window.
import { expect, test, type Frame, type Page } from '@playwright/test';
import { ISLAND } from '../ports';

interface Ev { type: string; phase?: string; caps?: string[]; action?: string; depth?: number; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Engine {
  Module: { kicadCollabTestUndoDepth(): number };
  kicadHostAction?: { onRequest?: (json: unknown) => boolean };
}
interface Row { uuid: string; sheetPath: string; ref: string }

const RUN15 = 'waits for engine run 15 (pcbjam cc_e8_sch.inc, unit st-incanno-e: kicadSchIncrementAnnotations)';
const ACTION = 'eeschema.EditorControl.incrementAnnotations';
const UNDO = { key: 'z', code: 'KeyZ', ctrl: true };
const SHIFT = { first: 'R10', by: 100, allSheets: true };

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
const timed = (page: Page, args: unknown): Promise<{ ms: number; result: Record<string, unknown> }> =>
  page.evaluate(async (a) => {
    const t0 = performance.now();
    const result = await (window as unknown as Harness).__bridge.request('sheet.increment', a);
    return { ms: Math.round((performance.now() - t0) * 100) / 100, result };
  }, args);
/** Every placed part's designator, keyed by instance. */
async function refs(page: Page): Promise<Map<string, string>> {
  const t = await request(page, 'symbols.get', { variant: '', scope: 'all' });
  return new Map((t.rows as Row[]).map((r) => [`${r.uuid} ${r.sheetPath}`, r.ref]));
}
/** The designator R10 and above takes after a shift by 100; every other one unchanged. */
function shifted(ref: string): string {
  const m = /^R(\d+)$/.exec(ref);
  return m != null && Number(m[1]) >= 10 ? `R${Number(m[1]) + 100}` : ref;
}

/** Boots a sch frame on Glasgow and answers ev.ready's caps and the island frame (null where Playwright cannot reach it). */
async function boot(page: Page): Promise<{ caps: string[]; frame: Frame | null }> {
  await page.goto('/parent.html?fixture=glasgow&frame=sch');
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  const caps = (await of(page, 'ev.ready'))[0]?.caps ?? [];
  await expect(page.locator('#state')).toContainText('opened glasgow.kicad_sch', { timeout: 120_000 });
  await page.waitForTimeout(1_500);   // ev.edited's baseline
  return { caps, frame: page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null };
}
const undoDepth = (frame: Frame): Promise<number> => frame.evaluate(() => Number((window as unknown as Engine).Module.kicadCollabTestUndoDepth()));
/** Asks the frame's held slot as the engine does: taken, and the ev.held sent for it. */
async function askHeld(page: Page, frame: Frame, action: string): Promise<{ taken: boolean; sent: string | null }> {
  const n = (await of(page, 'ev.held')).length;
  const taken = await frame.evaluate((a) => (window as unknown as Engine).kicadHostAction?.onRequest?.(JSON.stringify({ action: a })) === true, action);
  await page.waitForTimeout(300);
  const after = await of(page, 'ev.held');
  return { taken, sent: after.length > n ? after.at(-1)?.action ?? null : null };
}

test('run 14 or 15: incrementAnnotations follows the export; without it sheet.increment answers unsupported and the action is KiCad\'s', async ({ page, browserName }) => {
  const { caps, frame } = await boot(page);
  const run15 = caps.includes('kicadSchIncrementAnnotations');
  expect(caps.includes('incrementAnnotations')).toBe(run15 && caps.includes('kicadCollabBusy') && caps.includes('kicadCollabTestUndoDepth'));
  if (!caps.includes('incrementAnnotations')) expect(await refusal(page, 'sheet.increment', SHIFT)).toBe('unsupported: kicadSchIncrementAnnotations');
  expect(await refusal(page, 'sheet.increment', { first: 'R', by: 100, allSheets: true })).toBe('bad_args: sheet.increment');
  expect(await refusal(page, 'sheet.increment', { ...SHIFT, by: 0 })).toBe('bad_args: sheet.increment');
  expect(await refusal(page, 'sheet.increment', { ...SHIFT, run: 1 })).toBe('bad_args: sheet.increment');
  test.skip(frame == null, `${browserName}: the island frame is out of Playwright's reach, so its held slot cannot be asked`);
  const held = caps.includes('incrementAnnotations');
  expect(await askHeld(page, frame!, ACTION)).toEqual({ taken: held, sent: held ? ACTION : null });
});

test('run 15: R10 and above move up by 100 on every sheet in one undo step, and one undo takes it back', async ({ page, browserName }) => {
  const { caps, frame } = await boot(page);
  test.skip(!caps.includes('incrementAnnotations'), RUN15);
  test.skip(frame == null, `${browserName}: the island frame is out of Playwright's reach, so the undo depth cannot be read`);
  const before = await refs(page);
  const moving = [...before.values()].filter((r) => shifted(r) !== r);
  expect(moving.length).toBeGreaterThan(0);
  expect([...before.values()]).toContain('R9');
  const depth0 = await undoDepth(frame!);
  const edits0 = (await of(page, 'ev.edited')).length;

  // A first matching no part: nothing changes and no undo step.
  const none = await timed(page, { first: 'R9000', by: 1, allSheets: true });
  expect(none.result).toEqual({ shifted: false, depth: depth0 });
  expect(await refs(page)).toEqual(before);

  const run = await timed(page, SHIFT);
  measure('sheet.increment R10 by 100 all sheets, Glasgow', `${run.ms} ms, ${moving.length} instances moved`);
  expect(run.result).toEqual({ shifted: true, depth: depth0 + 1 });
  const after = await refs(page);
  expect([...after.keys()]).toEqual([...before.keys()]);
  for (const [k, ref] of before) expect(after.get(k), `${k} ${ref}`).toBe(shifted(ref));
  expect(await undoDepth(frame!)).toBe(depth0 + 1);
  await expect.poll(async () => (await of(page, 'ev.edited')).length, { timeout: 5_000 }).toBe(edits0 + 1);

  // One undo restores every designator.
  expect(await request(page, 'key.press', UNDO)).toEqual({});
  await expect.poll(() => undoDepth(frame!), { timeout: 5_000 }).toBe(depth0);
  expect(await refs(page)).toEqual(before);

  expect(await askHeld(page, frame!, ACTION)).toEqual({ taken: true, sent: ACTION });
});
