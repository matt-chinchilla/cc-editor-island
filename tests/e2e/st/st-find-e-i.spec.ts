// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-find-e-i over the local pair (PROTOCOL.md find, find.replace) on Glasgow.
// On engine run 14 the caps find and replace are absent, both ops answer
// unsupported naming the export, and KiCad's find keys are left to KiCad. On
// engine run 15 (cc25): find "R4" (designators, whole words) answers one hit
// of kind symbol; the regular expression ^R\d+$ answers every resistor; on the
// board a net name answers a net hit; find.replace of a label text over every
// target answers { replaced, skipped } as ONE undo step with an ev.edited, and
// one undo takes it back; a replace that matches nothing answers no_match;
// /tmp/cc-replace holds no folder after any answer; and Find (Ctrl+F), Find
// and Replace (Ctrl+Alt+F), the Search panel (Ctrl+G), Find Next (F3), Find
// Previous (Shift+F3) and Replace and Find Next send ev.held in their frames.
import { expect, test, type Frame, type Page } from '@playwright/test';
import { ISLAND } from '../ports';

interface Ev { type: string; phase?: string; caps?: string[]; action?: string; depth?: number; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Engine {
  Module: { kicadCollabTestUndoDepth(): number };
  FS: { readdir(p: string): string[]; analyzePath(p: string): { exists: boolean } };
  kicadHostAction?: { onRequest?: (json: unknown) => boolean };
}
interface Hit { uuid: string; sheetPath: string; kind: string; ref: string; field: string; text: string; start: number; length: number }

const RUN15 = 'waits for engine run 15 (pcbjam cc_e10_dispatch.inc and cc_e10_sch.inc, unit st-find-e-e: kicadFind, kicadSchReplace)';
const FIXTURE = 'glasgow';
const UNDO = { key: 'z', code: 'KeyZ', ctrl: true };
const FIND_ROWS = [
  { action: 'common.Interactive.find', frames: ['sch', 'pcb'], cap: 'find' },
  { action: 'common.Interactive.findAndReplace', frames: ['sch'], cap: 'replace' },
  { action: 'common.Interactive.search', frames: ['sch', 'pcb'], cap: 'find' },
  { action: 'common.Interactive.findNext', frames: ['sch', 'pcb'], cap: 'find' },
  { action: 'common.Interactive.findPrevious', frames: ['sch', 'pcb'], cap: 'find' },
  { action: 'common.Interactive.replaceAndFindNext', frames: ['sch'], cap: 'replace' },
];
const SCH = { refs: false, values: false, fields: false, hidden: false, pins: false, labels: false, nets: false, thisSheet: false, selected: false };
const PCB = { refs: false, values: false, texts: false, nets: false, markers: false };
const OPTIONS = { matchCase: false, wholeWord: false, wildcards: false, regex: false };

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
const timed = (page: Page, op: string, args: unknown): Promise<{ ms: number; result: Record<string, unknown> }> =>
  page.evaluate(async ([o, a]) => {
    const t0 = performance.now();
    const result = await (window as unknown as Harness).__bridge.request(o as string, a);
    return { ms: Math.round((performance.now() - t0) * 100) / 100, result };
  }, [op, args] as const);

/** Boots `frame` on Glasgow and answers ev.ready's caps and the island frame (null where Playwright cannot reach it). */
async function boot(page: Page, frame: 'sch' | 'pcb'): Promise<{ caps: string[]; island: Frame | null }> {
  await page.goto(`/parent.html?fixture=${FIXTURE}&frame=${frame}`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  const caps = (await of(page, 'ev.ready'))[0]?.caps ?? [];
  await expect(page.locator('#state')).toContainText(frame === 'sch' ? 'opened glasgow.kicad_sch' : 'opened glasgow.kicad_pcb', { timeout: 120_000 });
  await page.waitForTimeout(1_500);   // ev.edited's baseline
  return { caps, island: page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null };
}
const undoDepth = (island: Frame): Promise<number> => island.evaluate(() => Number((window as unknown as Engine).Module.kicadCollabTestUndoDepth()));
/** The folders left under /tmp/cc-replace. */
const leftOver = (island: Frame): Promise<string[]> => island.evaluate(() => {
  const { FS } = window as unknown as Engine;
  return FS.analyzePath('/tmp/cc-replace').exists ? FS.readdir('/tmp/cc-replace').filter((n) => n !== '.' && n !== '..') : [];
});
/** Asks the frame's held slot as the engine does: taken, and the ev.held sent for it. */
async function askHeld(page: Page, island: Frame, action: string): Promise<{ taken: boolean; sent: string | null }> {
  const n = (await of(page, 'ev.held')).length;
  const taken = await island.evaluate((a) => (window as unknown as Engine).kicadHostAction?.onRequest?.(JSON.stringify({ action: a })) === true, action);
  await page.waitForTimeout(300);
  const after = await of(page, 'ev.held');
  return { taken, sent: after.length > n ? after.at(-1)?.action ?? null : null };
}
/** Each find action held in this frame exactly when its row's frame and cap say so. */
async function heldKeys(page: Page, island: Frame, frame: 'sch' | 'pcb', caps: string[]): Promise<void> {
  for (const r of FIND_ROWS) {
    const held = r.frames.includes(frame) && caps.includes(r.cap);
    expect(await askHeld(page, island, r.action), `${frame} ${r.action}`).toEqual({ taken: held, sent: held ? r.action : null });
  }
}

for (const frame of ['sch', 'pcb'] as const) {
  test(`run 14 or 15, ${frame}: the caps follow the exports; without them find answers unsupported naming kicadFind and the find keys are KiCad's`, async ({ page, browserName }) => {
    const { caps, island } = await boot(page, frame);
    expect(caps.includes('find')).toBe(caps.includes('kicadFind'));
    expect(caps.includes('replace')).toBe(frame === 'sch' && ['kicadFind', 'kicadSchReplace', 'kicadCollabBusy'].every((e) => caps.includes(e)));
    const args = frame === 'sch' ? { text: 'R4', ...OPTIONS, sch: { ...SCH, refs: true } } : { text: 'GND', ...OPTIONS, pcb: { ...PCB, nets: true } };
    if (!caps.includes('find')) expect(await refusal(page, 'find', args)).toBe('unsupported: kicadFind');
    if (frame === 'sch' && !caps.includes('replace')) expect(await refusal(page, 'find.replace', { find: { text: 'SDA', ...OPTIONS, sch: { ...SCH, labels: true } }, with: 'I2CSDA', targets: 'all' })).toBe('unsupported: kicadSchReplace');
    if (frame === 'pcb') expect(await refusal(page, 'find.replace', { find: { text: 'SDA', ...OPTIONS, sch: { ...SCH, labels: true } }, with: 'X', targets: 'all' })).toBe('unsupported: a replace runs in a sch frame');
    expect(await refusal(page, 'find', { text: '', ...OPTIONS, sch: SCH })).toBe('bad_args: find');
    expect(await refusal(page, 'find', frame === 'sch' ? { text: 'GND', ...OPTIONS, pcb: PCB } : { text: 'R4', ...OPTIONS, sch: SCH })).toBe('bad_args: find');
    test.skip(island == null, `${browserName}: the island frame is out of Playwright's reach, so its held slot cannot be asked`);
    await heldKeys(page, island!, frame, caps);
  });
}

test('run 15, sch: R4 is one symbol hit, ^R\\d+$ every resistor, a label replace is one undo step, no match is no_match', async ({ page, browserName }) => {
  const { caps, island } = await boot(page, 'sch');
  test.skip(!caps.includes('find') || !caps.includes('replace'), RUN15);

  const r4 = await timed(page, 'find', { text: 'R4', ...OPTIONS, wholeWord: true, sch: { ...SCH, refs: true } });
  measure('find "R4", Glasgow schematic', `${r4.ms} ms`);
  const r4Hits = (r4.result as { hits: Hit[]; truncated: boolean });
  expect(r4Hits.truncated).toBe(false);
  expect(r4Hits.hits).toHaveLength(1);
  expect(r4Hits.hits[0]).toMatchObject({ kind: 'symbol', ref: 'R4', field: 'Reference', text: 'R4', start: 0, length: 2 });

  const res = await timed(page, 'find', { text: '^R\\d+$', ...OPTIONS, regex: true, sch: { ...SCH, refs: true } });
  measure('find ^R\\d+$, Glasgow schematic', `${res.ms} ms`);
  const resHits = (res.result as { hits: Hit[] }).hits;
  expect(resHits.length).toBeGreaterThan(1);
  for (const h of resHits) expect(h).toMatchObject({ kind: 'symbol', field: 'Reference', text: expect.stringMatching(/^R\d+$/) });
  expect(resHits.map((h) => h.text)).toContain('R4');
  expect(await refusal(page, 'find', { text: '(', ...OPTIONS, regex: true, sch: { ...SCH, refs: true } })).toBe('bad_args: find: the regular expression does not compile');

  test.skip(island == null, `${browserName}: the island frame is out of Playwright's reach, so the undo depth and the run folders cannot be read`);
  const labels = { text: 'SDA', ...OPTIONS, matchCase: true, wholeWord: true, sch: { ...SCH, labels: true } };
  const before = (await request(page, 'find', labels) as { hits: Hit[] }).hits.filter((h) => h.kind === 'label');
  expect(before.length).toBeGreaterThan(0);
  const depth0 = await undoDepth(island!);
  const edits0 = (await of(page, 'ev.edited')).length;
  const rep = await timed(page, 'find.replace', { find: labels, with: 'I2CSDA', targets: 'all' });
  measure('find.replace SDA to I2CSDA, all, Glasgow', `${rep.ms} ms`);
  const r = rep.result as { replaced: number; skipped: number };
  expect(r.skipped).toBe(0);
  expect(r.replaced).toBeGreaterThanOrEqual(before.length);
  expect(await leftOver(island!)).toEqual([]);
  expect(await undoDepth(island!)).toBe(depth0 + 1);
  await expect.poll(async () => (await of(page, 'ev.edited')).length, { timeout: 5_000 }).toBe(edits0 + 1);
  expect((await request(page, 'find', { ...labels, text: 'I2CSDA' }) as { hits: Hit[] }).hits.filter((h) => h.kind === 'label').length).toBe(before.length);
  expect(await refusal(page, 'find.replace', { find: labels, with: 'I2CSDA', targets: 'all' })).toBe('no_match: find.replace');
  expect(await leftOver(island!)).toEqual([]);
  expect(await undoDepth(island!)).toBe(depth0 + 1);

  // One undo takes the whole replace back.
  expect(await request(page, 'key.press', UNDO)).toEqual({});
  await expect.poll(() => undoDepth(island!), { timeout: 5_000 }).toBe(depth0);
  expect((await request(page, 'find', labels) as { hits: Hit[] }).hits.filter((h) => h.kind === 'label').length).toBe(before.length);
});

test('run 15, pcb: a net name answers its net hit', async ({ page }) => {
  const { caps } = await boot(page, 'pcb');
  test.skip(!caps.includes('find'), RUN15);
  const gnd = await timed(page, 'find', { text: 'GND', ...OPTIONS, wholeWord: true, matchCase: true, pcb: { ...PCB, nets: true } });
  measure('find "GND" nets, Glasgow board', `${gnd.ms} ms`);
  const hits = (gnd.result as { hits: Hit[] }).hits;
  expect(hits.length).toBeGreaterThan(0);
  for (const h of hits) expect(h).toMatchObject({ kind: 'net', sheetPath: '' });
  expect(hits.map((h) => h.text)).toContain('GND');
});
