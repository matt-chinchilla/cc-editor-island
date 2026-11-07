// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// island v0.2.3-cc15 over the local pair (PROTOCOL.md): sheet.annotate numbers
// the parts with no KiCad dialog through our engine's kicadAnnotate (pcbjam
// cc/main e8b2abe; engine run 10), one undo step for a run that moved anything
// and none for one that moved nothing. The unnumbered fixture holds three
// resistors in a row: two "R?" on the left, R1 on the right.
import { expect, test, type Frame, type Page } from '@playwright/test';

const ISLAND = 'http://editor.localhost:4174';
interface Ev { type: string; phase?: string; depth?: number; caps?: string[]; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Engine { Module: { kicadCollabTestUndoDepth(): number }; FS: { readdir(p: string): string[]; analyzePath(p: string): { exists: boolean } } }
interface Change { uuid: string; sheetPath: string; from: string; to: string }
interface Numbered { ms: number; changes: Change[]; notes: string[] }

/** The unnumbered fixture's resistors, left to right. */
const LEFT = '7a1f0c2e-3b4d-4e5f-8a9b-0c1d2e3f4a51';
const MIDDLE = '7a1f0c2e-3b4d-4e5f-8a9b-0c1d2e3f4a61';
const RIGHT = '7a1f0c2e-3b4d-4e5f-8a9b-0c1d2e3f4a71';
const UNDO = { key: 'z', code: 'KeyZ', ctrl: true };

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
const annotate = (page: Page, args: unknown): Promise<Numbered> => page.evaluate(async (a) => {
  const t0 = performance.now();
  const r = await (window as unknown as Harness).__bridge.request('sheet.annotate', a) as unknown as { changes: Change[]; notes: string[] };
  return { ms: Math.round(performance.now() - t0), changes: r.changes, notes: r.notes };
}, args);
const refOf = async (page: Page, uuid: string): Promise<string> => ((await request(page, 'symbol.get', { uuid })) as { ref: string }).ref;

async function ready(page: Page, url: string): Promise<Frame | null> {
  await page.goto(url);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  return page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null;
}
/** The unnumbered fixture opened in a sch frame (the harness's own fixture list does not name it: the page fetches its files and opens them). */
async function bootUnnumbered(page: Page): Promise<Frame | null> {
  const frame = await ready(page, '/parent.html?frame=sch');
  const opened = await page.evaluate(async () => {
    const files = await Promise.all(['unnumbered.kicad_pro', 'unnumbered.kicad_sch'].map(async (path) => ({ path, bytes: new Uint8Array(await (await fetch(`/fixtures/unnumbered/${path}`)).arrayBuffer()) })));
    return (window as unknown as Harness).__bridge.request('project.open', { name: 'unnumbered', files });
  });
  expect(opened).toMatchObject({ opened: 'unnumbered.kicad_sch' });
  await page.waitForTimeout(1_500);   // the open's baseline read (ev.edited)
  return frame;
}
const undoDepth = (frame: Frame): Promise<number> => frame.evaluate(() => Number((window as unknown as Engine).Module.kicadCollabTestUndoDepth()));
const runsLeft = (frame: Frame): Promise<string[] | null> => frame.evaluate(() => {
  const { FS } = window as unknown as Engine;
  return FS.analyzePath('/tmp/cc-annotate').exists ? FS.readdir('/tmp/cc-annotate').filter((n) => n !== '.' && n !== '..') : null;
});
const unreached = (): void => { test.info().annotations.push({ type: 'unreached', description: 'the island frame is out of Playwright\'s reach in this browser: the undo depth and /tmp/cc-annotate/ were not read' }); };
const sorted = (cs: Change[]): Change[] => [...cs].sort((a, b) => a.uuid.localeCompare(b.uuid));

test('sheet.annotate numbers the two "R?" from where R1 left off, one undo step; a second run moves nothing and makes none', async ({ page }) => {
  const frame = await bootUnnumbered(page);
  expect((await of(page, 'ev.ready'))[0]?.caps).toContain('annotate');
  const depth0 = frame == null ? null : await undoDepth(frame);
  const edits0 = (await of(page, 'ev.edited')).length;
  const first = await annotate(page, { scope: 'all', order: 'x', reset: false, keep: [] });
  measure('sheet.annotate, the unnumbered fixture', `${first.ms} ms, ${first.changes.length} changes`);
  expect(sorted(first.changes)).toEqual([
    { uuid: LEFT, sheetPath: '/', from: 'R?', to: 'R2' },
    { uuid: MIDDLE, sheetPath: '/', from: 'R?', to: 'R3' },
  ]);
  expect(first.notes).toEqual([]);
  expect(await refOf(page, RIGHT)).toBe('R1');
  await expect.poll(async () => (await of(page, 'ev.edited')).length, { timeout: 5_000 }).toBe(edits0 + 1);
  const again = await annotate(page, { scope: 'all', order: 'x', reset: false, keep: [] });
  expect(again.changes).toEqual([]);
  await page.waitForTimeout(1_500);
  expect((await of(page, 'ev.edited')).length).toBe(edits0 + 1);
  if (frame == null) { unreached(); return; }
  expect(await undoDepth(frame)).toBe((depth0 ?? 0) + 1);
  expect(await runsLeft(frame)).toEqual([]);
});

test('sheet.annotate with reset: a kept designator stays and stays taken; without it the row is numbered left to right; Ctrl+Z takes a run back', async ({ page }) => {
  await bootUnnumbered(page);
  const kept = await annotate(page, { scope: 'sheet', order: 'x', reset: true, keep: [RIGHT] });
  expect(sorted(kept.changes)).toEqual([
    { uuid: LEFT, sheetPath: '/', from: 'R?', to: 'R2' },
    { uuid: MIDDLE, sheetPath: '/', from: 'R?', to: 'R3' },
  ]);
  const all = await annotate(page, { scope: 'sheet', order: 'x', reset: true, keep: [] });
  expect(sorted(all.changes)).toEqual([
    { uuid: LEFT, sheetPath: '/', from: 'R2', to: 'R1' },
    { uuid: MIDDLE, sheetPath: '/', from: 'R3', to: 'R2' },
    { uuid: RIGHT, sheetPath: '/', from: 'R1', to: 'R3' },
  ]);
  expect(await request(page, 'key.press', UNDO)).toEqual({});
  await expect.poll(() => refOf(page, RIGHT), { timeout: 5_000 }).toBe('R1');
  expect(await refOf(page, LEFT)).toBe('R2');
});

test('sheet.annotate on Glasgow: a numbered design moves nothing, and makes no undo step', async ({ page }) => {
  // One run: under the headless browsers' software WebGL, three Glasgow runs in a
  // row lose the canvas's context and the engine stops; the median of five is
  // taken in the GPU window (PROTOCOL.md).
  await page.goto('/parent.html?fixture=glasgow&frame=sch');
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  await expect(page.locator('#state')).toContainText('opened glasgow.kicad_sch', { timeout: 120_000 });
  const frame = page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null;
  const depth0 = frame == null ? null : await undoDepth(frame);
  const r = await annotate(page, { scope: 'all', order: 'x', reset: false, keep: [] });
  expect(r.changes).toEqual([]);
  measure('sheet.annotate, Glasgow, nothing to move', `${r.ms} ms; notes ${r.notes.join(' | ') || 'none'}`);
  if (frame == null) { unreached(); return; }
  expect(await undoDepth(frame)).toBe(depth0);
  expect(await runsLeft(frame)).toEqual([]);
});

test('sheet.annotate in a board is unsupported', async ({ page }) => {
  await ready(page, '/parent.html?fixture=glasgow&frame=pcb');
  expect(await refusal(page, 'sheet.annotate', { scope: 'all', order: 'x', reset: false, keep: [] })).toBe('unsupported: a schematic edits in a sch frame');
});
