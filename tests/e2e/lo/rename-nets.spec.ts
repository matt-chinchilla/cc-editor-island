// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// lo-e4-i over the local pair (PROTOCOL.md board.padNets and sch.renameNets):
// net names from the board onto the schematic, on the fixture rename-nets (a
// label SIG on R1 pin 2 and R2 pin 1, the board naming that net DATA), with
// no KiCad window. On every engine: boardPadNets is listed by a pcb frame
// exactly when the engine has kicadBoardPadNets, renameNets by a sch frame
// exactly when it has kicadSchRenameNets and kicadCollabBusy; without them
// each op answers unsupported naming its export, and a pcb frame refuses
// sch.renameNets. On engine run 15 (island cc25): board.padNets lists R1 pad
// 2 and R2 pad 1 on DATA; the preview with those pads answers the rename SIG
// to DATA with no undo step; the apply renames the label as one undo step,
// sends ev.edited, and one Ctrl+Z restores SIG; no run folder is left.
import { expect, test, type Frame, type Page } from '@playwright/test';

import { ISLAND } from '../ports';

interface Ev { type: string; phase?: string; caps?: string[]; depth?: number; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Engine {
  Module: { kicadCollabTestUndoDepth(): number };
  FS: { readdir(p: string): string[]; analyzePath(p: string): { exists: boolean } };
}
interface PadNet { ref: string; pad: string; net: string }
interface Row { ref: string; pin: string; from: string; to: string; sheetPath: string; outcome: string; label?: string }
interface Report { preview: boolean; rows: Row[]; applied: number; truncated: boolean; depth: number }

const RUN15 = 'waits for engine run 15 (pcbjam cc_e8_pcb.inc and cc_e8_sch.inc, unit lo-e4-e: kicadBoardPadNets, kicadSchRenameNets)';
const FIXTURE = 'rename-nets';
/** The label SIG's uuid (tests/fixtures/rename-nets/SOURCE). */
const LABEL = 'cc0e4a11-0000-4000-8000-000000000c10';
const PADS: PadNet[] = [{ ref: 'R1', pad: '2', net: 'DATA' }, { ref: 'R2', pad: '1', net: 'DATA' }];
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
/** sch.renameNets, timed in the page. */
const rename = (page: Page, preview: boolean, pads: PadNet[]): Promise<{ ms: number; result: Report }> =>
  page.evaluate(async ([p, list]) => {
    const t0 = performance.now();
    const result = await (window as unknown as Harness).__bridge.request('sch.renameNets', { preview: p, pads: list });
    return { ms: Math.round((performance.now() - t0) * 100) / 100, result: result as unknown as Report };
  }, [preview, pads] as const);

/** Boots `frame` on the fixture and answers ev.ready's caps and the island frame (null where Playwright cannot reach it). */
async function boot(page: Page, frame: 'pcb' | 'sch'): Promise<{ caps: string[]; island: Frame | null }> {
  await page.goto(`/parent.html?fixture=${FIXTURE}&frame=${frame}`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  const caps = (await of(page, 'ev.ready'))[0]?.caps ?? [];
  await expect(page.locator('#state')).toContainText(`opened rename-nets.kicad_${frame}`, { timeout: 120_000 });
  await page.waitForTimeout(1_500);   // ev.edited's baseline
  return { caps, island: page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null };
}
const undoDepth = (island: Frame): Promise<number> => island.evaluate(() => Number((window as unknown as Engine).Module.kicadCollabTestUndoDepth()));
/** The run folders left under /tmp/cc-renameNets. */
const leftOver = (island: Frame): Promise<string[]> => island.evaluate(() => {
  const { FS } = window as unknown as Engine;
  const root = '/tmp/cc-renameNets';
  return FS.analyzePath(root).exists ? FS.readdir(root).filter((n) => n !== '.' && n !== '..') : [];
});
const byPad = (a: PadNet, b: PadNet): number => `${a.ref}/${a.pad}`.localeCompare(`${b.ref}/${b.pad}`);
/** The rows a preview answers for the fixture as it stands: SIG to DATA on the label, R1 pin 2 and R2 pin 1. */
function expectSigRows(r: Report): void {
  expect(r.rows.length).toBeGreaterThanOrEqual(1);
  for (const row of r.rows) {
    expect(row.from).toMatch(/^\/?SIG$/);
    expect(row).toMatchObject({ to: 'DATA', sheetPath: '/', outcome: 'rename', label: LABEL });
    expect(PADS.some((p) => p.ref === row.ref && p.pad === row.pin)).toBe(true);
  }
  expect(new Set(r.rows.map((row) => `${row.from}>${row.to}`)).size).toBe(1);
}

test('run 14 or 15, pcb frame: boardPadNets follows kicadBoardPadNets; without it board.padNets answers unsupported naming the export; sch.renameNets is refused', async ({ page }) => {
  const { caps } = await boot(page, 'pcb');
  expect(caps.includes('boardPadNets')).toBe(caps.includes('kicadBoardPadNets'));
  expect(caps).not.toContain('renameNets');
  if (!caps.includes('boardPadNets')) expect(await refusal(page, 'board.padNets')).toBe('unsupported: kicadBoardPadNets');
  expect(await refusal(page, 'board.padNets', { all: true })).toBe('bad_args: board.padNets');
  expect(await refusal(page, 'sch.renameNets', { preview: true, pads: PADS })).toBe('unsupported: a schematic edits in a sch frame');
  expect(await refusal(page, 'sch.renameNets', { preview: true, pads: [] })).toBe('bad_args: sch.renameNets');
});

test('run 14 or 15, sch frame: renameNets follows kicadSchRenameNets and kicadCollabBusy; without them sch.renameNets answers unsupported naming the export; bad args first', async ({ page }) => {
  const { caps } = await boot(page, 'sch');
  expect(caps.includes('renameNets')).toBe(caps.includes('kicadSchRenameNets') && caps.includes('kicadCollabBusy'));
  expect(caps).not.toContain('boardPadNets');
  if (!caps.includes('renameNets')) expect(await refusal(page, 'sch.renameNets', { preview: true, pads: PADS })).toBe('unsupported: kicadSchRenameNets');
  for (const bad of [{ preview: true }, { preview: 'yes', pads: PADS }, { preview: true, pads: [] }, { preview: true, pads: [{ ref: 'R1', pad: '2' }] }, { preview: true, pads: [{ ref: 'R1', pad: '2', net: '' }] }, { preview: true, pads: PADS, run: 1 }]) {
    expect(await refusal(page, 'sch.renameNets', bad)).toBe('bad_args: sch.renameNets');
  }
  expect(await refusal(page, 'board.padNets')).toMatch(/^unsupported: /);
});

test('run 15: the board\'s pad nets, the preview with no undo step, the apply as one undo step with ev.edited, one Ctrl+Z restores SIG', async ({ page, browserName }) => {
  const pcb = await boot(page, 'pcb');
  test.skip(!pcb.caps.includes('boardPadNets'), RUN15);
  const read = await request(page, 'board.padNets') as unknown as { pads: PadNet[]; truncated: boolean };
  expect({ pads: [...read.pads].sort(byPad), truncated: read.truncated }).toEqual({ pads: PADS, truncated: false });

  const sch = await boot(page, 'sch');
  test.skip(!sch.caps.includes('renameNets'), RUN15);
  test.skip(sch.island == null, `${browserName}: the island frame is out of Playwright's reach, so the undo depth and the run folders cannot be read`);
  const island = sch.island!;
  const depth0 = await undoDepth(island);
  const edits0 = (await of(page, 'ev.edited')).length;

  const preview = await rename(page, true, read.pads);
  measure('sch.renameNets preview, rename-nets', `${preview.ms} ms, ${preview.result.rows.length} rows`);
  expect(preview.result).toMatchObject({ preview: true, applied: 0, truncated: false, depth: depth0 });
  expectSigRows(preview.result);
  expect(await undoDepth(island)).toBe(depth0);
  expect(await leftOver(island)).toEqual([]);
  await page.waitForTimeout(1_000);
  expect((await of(page, 'ev.edited')).length).toBe(edits0);

  const apply = await rename(page, false, read.pads);
  measure('sch.renameNets apply, rename-nets', `${apply.ms} ms, applied ${apply.result.applied}`);
  expect(apply.result).toMatchObject({ preview: false, truncated: false, depth: depth0 + 1 });
  expectSigRows(apply.result);
  expect(apply.result.applied).toBe(apply.result.rows.length);
  expect(apply.result.applied).toBeGreaterThanOrEqual(1);
  expect(await undoDepth(island)).toBe(depth0 + 1);
  expect(await leftOver(island)).toEqual([]);
  await expect.poll(async () => (await of(page, 'ev.edited')).length, { timeout: 5_000 }).toBe(edits0 + 1);
  // The label is DATA now: the same pads give no row.
  expect((await rename(page, true, read.pads)).result).toEqual({ preview: true, rows: [], applied: 0, truncated: false, depth: depth0 + 1 });

  // One undo takes the whole rename back: SIG again.
  expect(await request(page, 'key.press', UNDO)).toEqual({});
  await expect.poll(() => undoDepth(island), { timeout: 5_000 }).toBe(depth0);
  const again = await rename(page, true, read.pads);
  expect(again.result).toMatchObject({ preview: true, applied: 0, depth: depth0 });
  expectSigRows(again.result);
  expect(await leftOver(island)).toEqual([]);
});
