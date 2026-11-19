// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-compare-i over the local pair (PROTOCOL.md item.compare) on Glasgow and
// the st-compare-drift fixture. On engine run 14 the cap compare is absent,
// item.compare answers unsupported naming kicadCompareWithSource, and KiCad's
// compare actions are left to KiCad. On engine run 15 (cc25): a footprint
// whose nickname no table names (Glasgow's own R_0603 DNP footprint of R6)
// answers status noSource, not an error; an item the document does not hold
// answers not_found; Compare Symbol with Library and Compare Footprint with
// Library send ev.held in their frames. With a library mirror (LIBS_DIR, the
// directory serve.mjs serves as /libs/): R4 on Glasgow's schematic answers
// its source Device:R; on the drift board R48 differs with a pad finding for
// pad 1 (turned 90 degrees) and none for pad 2, while Glasgow's own R48
// (KiCad 6's older pads) differs on both.
import { expect, test, type Frame, type Page } from '@playwright/test';
import { ISLAND } from '../ports';

declare const process: { env: Record<string, string | undefined> };

interface Ev { type: string; phase?: string; caps?: string[]; action?: string; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Engine { kicadHostAction?: { onRequest?: (json: unknown) => boolean } }
interface Finding { code: string; uuid: string | null; pin: string; field: string }
interface Compared { status: string; source: string; findings: Finding[] }

const RUN15 = 'waits for engine run 15 (pcbjam cc_e10_dispatch.inc, unit st-compare-e: kicadCompareWithSource)';
const MIRROR = 'needs a library mirror: LIBS_DIR=<the directory served as /libs/> (tests/libs/make-mirror.mjs builds one)';
const ROWS = [
  { action: 'pcbnew.InspectionTool.DiffFootprint', frames: ['pcb'], cap: 'compare' },
  { action: 'eeschema.InspectionTool.diffSymbol', frames: ['sch'], cap: 'compare' },
];
/** R4 on Glasgow's root sheet (Device:R). */
const R4 = '00000000-0000-0000-0000-00005f06d941';
/** R48's footprint (Resistor_SMD:R_0603_1608Metric) and its two pads (tests/fixtures/st-compare-drift/SOURCE). */
const R48 = '00000000-0000-0000-0000-00005cc279d9';
const R48_PAD1 = '9fe5c991-a4bb-46ca-b81d-72a45f57a872';
const R48_PAD2 = '212aa087-f922-4c93-bf39-0e34e7e54b8a';
/** R6's footprint, Glasgow:R_0603_1608Metric_DNP: no table names the nickname Glasgow. */
const R6 = '00000000-0000-0000-0000-00005f0b48b7';
const ABSENT = '01234567-89ab-4cde-8f01-23456789abcd';

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
const timed = (page: Page, op: string, args: unknown): Promise<{ ms: number; result: Compared }> =>
  page.evaluate(async ([o, a]) => {
    const t0 = performance.now();
    const result = await (window as unknown as Harness).__bridge.request(o as string, a);
    return { ms: Math.round((performance.now() - t0) * 100) / 100, result: result as unknown as Compared };
  }, [op, args] as const);
/**
 * The compare once the frame's libraries have been read: a source the mirror
 * holds answers noSource until its bundle is fetched, so the ask is repeated
 * until it does not (the engine's lane notes).
 */
async function compareRead(page: Page, args: unknown): Promise<{ ms: number; result: Compared }> {
  let last: { ms: number; result: Compared } | null = null;
  await expect.poll(async () => { last = await timed(page, 'item.compare', args); return last.result.status; }, { timeout: 60_000, intervals: [500, 1_000, 2_000] }).not.toBe('noSource');
  return last!;
}

/** Boots `frame` on `fixture` and answers ev.ready's caps and the island frame (null where Playwright cannot reach it). */
async function boot(page: Page, fixture: string, frame: 'sch' | 'pcb'): Promise<{ caps: string[]; island: Frame | null }> {
  await page.goto(`/parent.html?fixture=${fixture}&frame=${frame}`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  const caps = (await of(page, 'ev.ready'))[0]?.caps ?? [];
  await expect(page.locator('#state')).toContainText(frame === 'sch' ? 'opened glasgow.kicad_sch' : 'opened glasgow.kicad_pcb', { timeout: 120_000 });
  return { caps, island: page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null };
}
/** Asks the frame's held slot as the engine does: taken, and the ev.held sent for it. */
async function askHeld(page: Page, island: Frame, action: string): Promise<{ taken: boolean; sent: string | null }> {
  const n = (await of(page, 'ev.held')).length;
  const taken = await island.evaluate((a) => (window as unknown as Engine).kicadHostAction?.onRequest?.(JSON.stringify({ action: a })) === true, action);
  await page.waitForTimeout(300);
  const after = await of(page, 'ev.held');
  return { taken, sent: after.length > n ? after.at(-1)?.action ?? null : null };
}
/** Each compare action held in this frame exactly when its row's frame and cap say so. */
async function heldKeys(page: Page, island: Frame, frame: 'sch' | 'pcb', caps: string[]): Promise<void> {
  for (const r of ROWS) {
    const held = r.frames.includes(frame) && caps.includes(r.cap);
    expect(await askHeld(page, island, r.action), `${frame} ${r.action}`).toEqual({ taken: held, sent: held ? r.action : null });
  }
}
const padFindings = (c: Compared): Finding[] => c.findings.filter((f) => f.code === 'pad');

for (const frame of ['sch', 'pcb'] as const) {
  test(`run 14 or 15, ${frame}: the cap follows the export; without it item.compare answers unsupported and the compare actions are KiCad's`, async ({ page, browserName }) => {
    const { caps, island } = await boot(page, 'glasgow', frame);
    expect(caps.includes('compare')).toBe(caps.includes('kicadCompareWithSource'));
    const item = frame === 'sch' ? { uuid: R4, sheetPath: '/' } : { uuid: R48 };
    if (!caps.includes('compare')) expect(await refusal(page, 'item.compare', item)).toBe('unsupported: kicadCompareWithSource');
    expect(await refusal(page, 'item.compare', { uuid: 'R4' })).toBe('bad_args: item.compare');
    if (frame === 'pcb') expect(await refusal(page, 'item.compare', { uuid: R48, sheetPath: '/' })).toBe('bad_args: item.compare');
    test.skip(island == null, `${browserName}: the island frame is out of Playwright's reach, so its held slot cannot be asked`);
    await heldKeys(page, island!, frame, caps);
  });
}

test('run 15, pcb: a nickname no table names is noSource, not an error; an absent item is not_found', async ({ page }) => {
  const { caps } = await boot(page, 'glasgow', 'pcb');
  test.skip(!caps.includes('compare'), RUN15);
  const r6 = await timed(page, 'item.compare', { uuid: R6 });
  measure('item.compare R6 (Glasgow nickname), Glasgow board', `${r6.ms} ms`);
  expect(r6.result).toMatchObject({ status: 'noSource', source: 'Glasgow:R_0603_1608Metric_DNP' });
  expect(await refusal(page, 'item.compare', { uuid: ABSENT })).toBe(`not_found: ${ABSENT}`);
});

test('run 15, sch: R4 compares with its source Device:R', async ({ page }) => {
  const { caps } = await boot(page, 'glasgow', 'sch');
  test.skip(!caps.includes('compare'), RUN15);
  expect(await refusal(page, 'item.compare', { uuid: ABSENT, sheetPath: '/' })).toBe(`not_found: ${ABSENT} on /`);
  test.skip(process.env.LIBS_DIR == null, MIRROR);
  const r4 = await compareRead(page, { uuid: R4, sheetPath: '/' });
  measure('item.compare R4, Glasgow schematic', `${r4.ms} ms, ${r4.result.status}, ${r4.result.findings.length} findings`);
  expect(r4.result.source).toBe('Device:R');
  expect(['same', 'differs']).toContain(r4.result.status);
  expect(r4.result.findings.map((f) => f.code)).not.toContain('other');
});

test('run 15, pcb: the drift board\'s R48 differs on pad 1 alone; Glasgow\'s own R48 on both pads', async ({ page }) => {
  const { caps } = await boot(page, 'st-compare-drift', 'pcb');
  test.skip(!caps.includes('compare'), RUN15);
  test.skip(process.env.LIBS_DIR == null, MIRROR);
  const drift = await compareRead(page, { uuid: R48 });
  measure('item.compare R48, drift board', `${drift.ms} ms, ${drift.result.findings.length} findings: ${drift.result.findings.map((f) => f.code).join(' ')}`);
  expect(drift.result.status).toBe('differs');
  expect(drift.result.source).toBe('Resistor_SMD:R_0603_1608Metric');
  expect(drift.result.findings.map((f) => f.code)).not.toContain('other');
  expect(padFindings(drift.result).some((f) => f.uuid === R48_PAD1 && f.pin === '1')).toBe(true);
  expect(padFindings(drift.result).some((f) => f.uuid === R48_PAD2)).toBe(false);

  await boot(page, 'glasgow', 'pcb');
  const own = await compareRead(page, { uuid: R48 });
  measure('item.compare R48, Glasgow board', `${own.ms} ms, ${own.result.findings.length} findings`);
  expect(own.result.status).toBe('differs');
  expect(padFindings(own.result).some((f) => f.uuid === R48_PAD1)).toBe(true);
  expect(padFindings(own.result).some((f) => f.uuid === R48_PAD2)).toBe(true);
});
