// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// i-block-save over the local pair (PROTOCOL.md block.save), on Glasgow and
// the blocks-small fixture (unit i-fix-blocks). On engine run 14 the engine
// has no kicadDesignBlockSave: block.save is listed in island.json, checks
// its args first and answers unsupported naming the export. On engine run 15
// (unit e-block-save) the scopes sheet, selection, board and linkedGroup
// answer { files }, KiCad's refusals answer block_failed with its line, and
// the design's undo depth never moves.
import { expect, test, type Frame, type Page } from '@playwright/test';

import { ISLAND } from './ports';

interface Ev { type: string; phase?: string; caps?: string[]; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Engine {
  Module: { kicadCollabTestUndoDepth(): number; kicadDesignBlockPlace(json: string): boolean };
  FS: { mkdirTree(p: string): void; writeFile(p: string, data: string): void; analyzePath(p: string): { exists: boolean }; readdir(p: string): string[] };
}
interface Saved { files: Array<{ path: string; text: string }> }
type Kind = 'sch' | 'pcb';

const RUN15 = 'waits for engine run 15: kicadDesignBlockSave (unit e-block-save)';
/** Glasgow's io_buffer sheet as IO_Buffer_A shows it (under io_banks), in project.open's sheet path form. */
const BANKS = '00000000-0000-0000-0000-00005c7b59b0';
const IO_BUFFER_A = `/${BANKS}/00000000-0000-0000-0000-00005c9e337e/`;
/** Two of Glasgow's root sheet symbols: U1 (CY7C68013A) and a capacitor. */
const U1 = '00000000-0000-0000-0000-00005aca0321';
const C_ROOT = '00000000-0000-0000-0000-00005acb69d3';
/** Two of Glasgow's footprints (test points) and its footprint count. */
const TP_A = '00000000-0000-0000-0000-00005ad5dbcb';
const TP_B = '00000000-0000-0000-0000-00005ad5dbe1';
const GLASGOW_FOOTPRINTS = 272;
/** blocks-small's J1, a footprint in no group. */
const J1 = 'cc0b10c5-0000-4000-8000-000000000500';
const BLOCKS = 'blocks-small_blocks';
const LDO_FILES = ['LDO.kicad_sch', 'LDO.kicad_pcb', 'LDO.json'];

function measure(type: string, description: string): void {
  test.info().annotations.push({ type, description });
  console.log(`[measure] ${type}: ${description}`);
}
const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const of = async (page: Page, type: string): Promise<Ev[]> => (await events(page)).filter((e) => e.type === type);
const request = (page: Page, op: string, args?: unknown): Promise<Record<string, unknown>> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const);
/** A request's refusal as "code: message", or "ok". */
const refusal = (page: Page, op: string, args?: unknown): Promise<string> =>
  request(page, op, args).then(() => 'ok', (err: Error) => err.message.split('\n')[0].replace(/^.*?page\.evaluate:\s*/, '').replace(/^Error:\s*/, ''));
/** block.save timed in the page, from the request to the answer. */
const save = (page: Page, args: unknown): Promise<{ ms: number; result: Saved }> => page.evaluate(async (a) => {
  const t0 = performance.now();
  const result = await (window as unknown as Harness).__bridge.request('block.save', a) as unknown as Saved;
  return { ms: Math.round(performance.now() - t0), result };
}, args);

/** The page with `fixture` open in a frame of that kind; ev.ready's caps and the island frame (null where Playwright cannot reach it). */
async function boot(page: Page, fixture: string, kind: Kind): Promise<{ caps: string[]; island: Frame | null }> {
  await page.goto(`/parent.html?fixture=${fixture}&frame=${kind}`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  await expect(page.locator('#state')).toContainText(`opened ${fixture}.kicad_${kind}`, { timeout: 120_000 });
  await page.waitForTimeout(1_500);   // the open's baseline read (ev.edited)
  const caps = (await events(page)).find((e) => e.type === 'ev.ready')?.caps ?? [];
  return { caps, island: page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null };
}
const run15 = (caps: readonly string[]): boolean => caps.includes('kicadDesignBlockSave');
const undoDepth = (island: Frame): Promise<number> => island.evaluate(() => Number((window as unknown as Engine).Module.kicadCollabTestUndoDepth()));
/** The run folders left under /tmp/cc-blocksave. */
const leftOver = (island: Frame): Promise<string[]> => island.evaluate(() => {
  const { FS } = window as unknown as Engine;
  return FS.analyzePath('/tmp/cc-blocksave').exists ? FS.readdir('/tmp/cc-blocksave').filter((n) => n !== '.' && n !== '..') : [];
});
const footprints = (text: string): number => (text.match(/^\s*\(footprint\s+"/gm) ?? []).length;
const symbols = (text: string): number => (text.match(/\(symbol\s+\(lib_id\s+"/g) ?? []).length;

async function select(page: Page, uuids: string[]): Promise<void> {
  expect(await request(page, 'select', { uuids, zoom: true })).toEqual({});
  await page.waitForTimeout(600);
}

/**
 * One save: answered with exactly one file of the frame's kind, the undo
 * depth unchanged (where the frame is in reach), no ev.edited, no run folder
 * left. Answers the file's text.
 */
async function savedOnce(page: Page, island: Frame | null, kind: Kind, args: { scope: string; name: string; sheetPath?: string }): Promise<string> {
  const depth0 = island == null ? null : await undoDepth(island);
  const edits0 = (await of(page, 'ev.edited')).length;
  const { ms, result } = await save(page, args);
  measure(`block.save ${kind} ${args.scope}`, `${ms} ms, ${result.files[0]?.text.length ?? 0} characters`);
  expect(result.files.map((f) => f.path)).toEqual([`${args.name}.kicad_${kind}`]);
  const text = result.files[0].text;
  expect(text.trimStart().startsWith(`(kicad_${kind}`)).toBe(true);
  await page.waitForTimeout(1_000);
  expect((await of(page, 'ev.edited')).length).toBe(edits0);
  if (island != null) {
    expect(await undoDepth(island)).toBe(depth0);
    expect(await leftOver(island)).toEqual([]);
  }
  return text;
}

test.describe('engine run 14 or 15: block.save is listed and checks its args first', () => {
  test('island.json lists block.save', async ({ page }) => {
    const res = await page.goto(`${ISLAND}/island.json`);
    const island = (await res!.json()) as { ops?: string[] };
    expect(island.ops ?? []).toContain('block.save');
  });

  for (const kind of ['sch', 'pcb'] as const) {
    test(`a ${kind} frame: bad names answer bad_args, the other frame's scopes unsupported, and without the export unsupported naming it`, async ({ page }) => {
      const { caps } = await boot(page, 'glasgow', kind);
      const scope = kind === 'sch' ? 'selection' : 'board';
      for (const name of ['x'.repeat(121), 'a/b', 'a\\b', 'a:b', '', '..']) {
        expect(await refusal(page, 'block.save', { scope, name })).toBe('bad_args: block.save');
      }
      expect(await refusal(page, 'block.save', { scope: 'selection', name: 'a', sheetPath: '/' })).toBe('bad_args: block.save');
      expect(await refusal(page, 'block.save', { scope: 'sheet', name: 'a' })).toBe('bad_args: block.save');
      expect(await refusal(page, 'block.save', { scope, name: 'a', more: 1 })).toBe('bad_args: block.save');
      if (kind === 'sch') expect(await refusal(page, 'block.save', { scope: 'board', name: 'a' })).toBe('unsupported: scope board is saved in a pcb frame');
      else expect(await refusal(page, 'block.save', { scope: 'sheet', name: 'a', sheetPath: '/' })).toBe('unsupported: scope sheet is saved in a sch frame');
      if (!run15(caps)) expect(await refusal(page, 'block.save', { scope, name: 'x'.repeat(120) })).toBe('unsupported: kicadDesignBlockSave');
    });
  }
});

test.describe('engine run 15: block.save', () => {
  test('Glasgow, sch frame: io_buffer as a block, a two part selection, the root and an unknown path refused, the undo depth unchanged', async ({ page, browserName }) => {
    const { caps, island } = await boot(page, 'glasgow', 'sch');
    test.skip(!run15(caps), RUN15);
    if (island == null) measure('unreached', `${browserName}: the island frame is out of Playwright's reach, the undo depth and the run folders were not read`);

    const sheet = await savedOnce(page, island, 'sch', { scope: 'sheet', name: 'iobuf', sheetPath: IO_BUFFER_A });
    expect(sheet.length).toBeGreaterThan(100_000);
    expect(symbols(sheet)).toBeGreaterThan(10);

    await select(page, [U1, C_ROOT]);
    const two = await savedOnce(page, island, 'sch', { scope: 'selection', name: 'two parts' });
    expect(symbols(two)).toBe(2);

    expect(await refusal(page, 'block.save', { scope: 'sheet', name: 'root', sheetPath: '/' })).toBe('block_failed: Design blocks with nested sheets are not supported.');
    expect(await refusal(page, 'block.save', { scope: 'sheet', name: 'gone', sheetPath: '/00000000-0000-4000-8000-000000000000/' })).toBe('block_failed: No sheet has that path.');
    if (island != null) expect(await leftOver(island)).toEqual([]);
  });

  test('Glasgow, pcb frame: the whole board and a two footprint selection, the undo depth unchanged', async ({ page, browserName }) => {
    const { caps, island } = await boot(page, 'glasgow', 'pcb');
    test.skip(!run15(caps), RUN15);
    if (island == null) measure('unreached', `${browserName}: the island frame is out of Playwright's reach, the undo depth and the run folders were not read`);

    const board = await savedOnce(page, island, 'pcb', { scope: 'board', name: 'glasgow board' });
    expect(footprints(board)).toBe(GLASGOW_FOOTPRINTS);

    await select(page, [TP_A, TP_B]);
    const two = await savedOnce(page, island, 'pcb', { scope: 'selection', name: 'two pads' });
    expect(footprints(two)).toBe(2);
  });

  test('blocks-small, pcb frame: a group placed from LDO saves as linkedGroup; a footprint in no group answers block_failed', async ({ page, browserName }) => {
    const { caps, island } = await boot(page, 'blocks-small', 'pcb');
    test.skip(!run15(caps), RUN15);
    test.skip(island == null, `${browserName}: the island frame is out of Playwright's reach, so the linked group cannot be placed through the engine here`);
    const frame = island!;

    // The block row loaded, then LDO placed as a group linked to it (the engine's own place, the press puts it down).
    expect(await request(page, 'project.libs', { libs: [BLOCKS] })).toMatchObject({ block: [BLOCKS] });
    const texts = await page.evaluate(async (names) => Promise.all(names.map(async (n) => (await fetch(`/fixtures/blocks-small/blocks-small_blocks.kicad_blocks/LDO.kicad_block/${n}`)).text())), LDO_FILES);
    // The engine reads a block only from a run folder under /tmp/cc-block/ (block.place's own root).
    const placed = await frame.evaluate(([names, bodies, lib]) => {
      const { FS, Module } = window as unknown as Engine;
      const dir = '/tmp/cc-block/9001';
      FS.mkdirTree(`${dir}/LDO.kicad_block`);
      names.forEach((n, i) => FS.writeFile(`${dir}/LDO.kicad_block/${n}`, bodies[i]));
      return Module.kicadDesignBlockPlace(JSON.stringify({ dir, name: 'LDO', asSheet: false, keepAnnotations: false, asGroup: true, nickname: lib }));
    }, [LDO_FILES, texts, BLOCKS] as const);
    expect(placed).toBe(true);
    const depthBefore = await undoDepth(frame);
    const box = await page.locator('iframe').boundingBox();
    expect(box).not.toBeNull();
    await page.waitForTimeout(800);
    await page.mouse.move(box!.x + box!.width / 2 - 10, box!.y + box!.height / 2 - 10);
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    const editsBefore = (await of(page, 'ev.edited')).length;
    await expect.poll(() => undoDepth(frame), { timeout: 10_000 }).toBe(depthBefore + 1);
    await page.keyboard.press('Escape');
    // ev.edited is a poll (every 500 ms, never while a request is in flight): the placement's own
    // comes before the save is asked, or savedOnce would count it as the save's.
    await expect.poll(async () => (await of(page, 'ev.edited')).length, { timeout: 10_000 }).toBe(editsBefore + 1);

    // The placed group, read from the board as KiCad writes it.
    const board = await savedOnce(page, island, 'pcb', { scope: 'board', name: 'with LDO' });
    const groups = board.split(/\(group\s/).slice(1).filter((g) => g.includes(`(lib_id "${BLOCKS}:LDO")`));
    expect(groups.length).toBe(1);
    const group = /\(uuid\s+"?([0-9a-f-]{36})"?\)/.exec(groups[0])?.[1];
    expect(group).toBeDefined();

    await select(page, [group!]);
    const linked = await savedOnce(page, island, 'pcb', { scope: 'linkedGroup', name: 'LDO' });
    expect(footprints(linked)).toBe(3);

    await select(page, [J1]);
    expect(await refusal(page, 'block.save', { scope: 'linkedGroup', name: 'LDO' })).toMatch(/^block_failed: \S/);
    expect(await leftOver(frame)).toEqual([]);
  });
});
