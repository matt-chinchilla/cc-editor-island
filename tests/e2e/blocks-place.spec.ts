// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// i-block-place over the local pair (PROTOCOL.md block.place), on the
// blocks-small fixture (unit i-fix-blocks). On engine run 14 the engine has
// no kicadDesignBlockPlace: block.place is listed in island.json, checks its
// args first, answers unsupported naming the export, and ev.ready lists no
// blocks cap. On engine run 15 (units e-block-place and e-block-place-sch)
// the files land under a fresh /tmp/cc-block/<n>/<name>.kicad_block/, one
// block hangs at a time, Escape drops a hanging block with no undo step, and
// a press commits ONE undo step, in a sch and a pcb frame.
import { expect, test, type Frame, type Page } from '@playwright/test';

import { ISLAND } from './ports';

interface Ev { type: string; phase?: string; caps?: string[]; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Engine {
  Module: { kicadCollabTestUndoDepth(): number; kicadCollabGetSelection(): string };
  FS: { analyzePath(p: string): { exists: boolean }; readdir(p: string): string[] };
}
type Kind = 'sch' | 'pcb';
interface BlockFile { path: string; text: string }

const RUN15 = 'waits for engine run 15: kicadDesignBlockPlace (units e-block-place, e-block-place-sch)';
const BLOCKS = 'blocks-small_blocks';
const FILES: Record<string, string[]> = {
  LDO: ['LDO.kicad_sch', 'LDO.kicad_pcb', 'LDO.json'],
  RC: ['RC.kicad_sch', 'RC.json'],
};

function measure(type: string, description: string): void {
  test.info().annotations.push({ type, description });
  console.log(`[measure] ${type}: ${description}`);
}
const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const request = (page: Page, op: string, args?: unknown): Promise<Record<string, unknown>> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const);
/** A request's refusal as "code: message", or "ok". */
const refusal = (page: Page, op: string, args?: unknown): Promise<string> =>
  request(page, op, args).then(() => 'ok', (err: Error) => err.message.split('\n')[0].replace(/^.*?page\.evaluate:\s*/, '').replace(/^Error:\s*/, ''));

/** The page with `fixture` open in a frame of that kind; ev.ready's caps and the island frame (null where Playwright cannot reach it). */
async function boot(page: Page, fixture: string, kind: Kind): Promise<{ caps: string[]; island: Frame | null }> {
  await page.goto(`/parent.html?fixture=${fixture}&frame=${kind}`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  await expect(page.locator('#state')).toContainText(`opened ${fixture}.kicad_${kind}`, { timeout: 120_000 });
  await page.waitForTimeout(1_500);   // the open's baseline read (ev.edited)
  const caps = (await events(page)).find((e) => e.type === 'ev.ready')?.caps ?? [];
  return { caps, island: page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null };
}
const run15 = (caps: readonly string[]): boolean => caps.includes('blocks');
const undoDepth = (island: Frame): Promise<number> => island.evaluate(() => Number((window as unknown as Engine).Module.kicadCollabTestUndoDepth()));
/** The run folders under /tmp/cc-block, each with what it holds (`<n>/<name>.kicad_block/<file>`). */
const runFiles = (island: Frame): Promise<string[]> => island.evaluate(() => {
  const { FS } = window as unknown as Engine;
  const root = '/tmp/cc-block';
  const out: string[] = [];
  const ls = (p: string): string[] => FS.readdir(p).filter((n) => n !== '.' && n !== '..');
  if (!FS.analyzePath(root).exists) return out;
  for (const run of ls(root)) {
    const blocks = ls(`${root}/${run}`);
    if (blocks.length === 0) out.push(run);
    for (const b of blocks) for (const f of ls(`${root}/${run}/${b}`)) out.push(`${run}/${b}/${f}`);
  }
  return out;
});
/** A block's files as the fixture holds them. */
const blockFiles = (page: Page, name: string): Promise<BlockFile[]> => page.evaluate(async ([n, names]) => Promise.all(
  names.map(async (p) => ({ path: p, text: await (await fetch(`/fixtures/blocks-small/blocks-small_blocks.kicad_blocks/${n}.kicad_block/${p}`)).text() })),
), [name, FILES[name]] as const);
/** block.place timed in the page, from the request to the answer. */
const place = (page: Page, args: unknown): Promise<{ ms: number; result: Record<string, unknown> }> => page.evaluate(async (a) => {
  const t0 = performance.now();
  const result = await (window as unknown as Harness).__bridge.request('block.place', a);
  return { ms: Math.round(performance.now() - t0), result };
}, args);

/** The middle of the island's frame, a pointer moved there (the hanging block follows it). */
async function hover(page: Page, dx = 0): Promise<{ x: number; y: number }> {
  const box = await page.locator('iframe').boundingBox();
  expect(box).not.toBeNull();
  const at = { x: box!.x + box!.width / 2 + dx, y: box!.y + box!.height / 2 };
  await page.mouse.move(at.x - 10, at.y - 10);
  await page.mouse.move(at.x, at.y);
  await page.waitForTimeout(400);
  return at;
}

test.describe('engine run 14 or 15: block.place is listed and checks its args first', () => {
  test('island.json lists block.place', async ({ page }) => {
    const res = await page.goto(`${ISLAND}/island.json`);
    const island = (await res!.json()) as { ops?: string[] };
    expect(island.ops ?? []).toContain('block.place');
  });

  for (const kind of ['sch', 'pcb'] as const) {
    test(`a ${kind} frame: bad args answer bad_args, a block with no file for the frame bad_args, and without the export unsupported naming it`, async ({ page }) => {
      const { caps } = await boot(page, 'blocks-small', kind);
      const files = [{ path: 'LDO.kicad_sch', text: '(kicad_sch)' }, { path: 'LDO.kicad_pcb', text: '(kicad_pcb)' }];
      const base = { name: 'LDO', files, asSheet: false, keepAnnotations: false, asGroup: true };
      for (const bad of [
        { ...base, name: 'a:b' }, { ...base, name: '' }, { ...base, more: 1 }, { ...base, asGroup: 'yes' },
        { ...base, files: [] }, { ...base, files: [{ path: 'RC.kicad_sch', text: '' }] }, { ...base, files: [{ path: '../LDO.kicad_sch', text: '' }] },
        { ...base, nickname: '' }, { ...base, nickname: 'a:b' },
      ]) {
        expect(await refusal(page, 'block.place', bad)).toBe('bad_args: block.place');
      }
      const other = kind === 'sch' ? 'LDO.kicad_pcb' : 'LDO.kicad_sch';
      expect(await refusal(page, 'block.place', { ...base, files: [{ path: other, text: '' }] })).toBe(`bad_args: block.place: a block placed in a ${kind} frame needs LDO.kicad_${kind}`);
      if (!run15(caps)) {
        expect(caps).not.toContain('blocks');
        expect(await refusal(page, 'block.place', base)).toBe('unsupported: kicadDesignBlockPlace');
      }
    });
  }
});

test.describe('engine run 15: block.place', () => {
  test('blocks-small, pcb frame: LDO\'s layout hangs, Escape drops it, a second placement drops the first, a press commits one undo step, Ctrl+Z takes it back', async ({ page, browserName }) => {
    const { caps, island } = await boot(page, 'blocks-small', 'pcb');
    test.skip(!run15(caps), RUN15);
    test.skip(island == null, `${browserName}: the island frame is out of Playwright's reach, so the undo depth cannot be read here`);
    const frame = island!;
    expect(await request(page, 'project.libs', { libs: [BLOCKS] })).toMatchObject({ block: [BLOCKS] });
    const files = await blockFiles(page, 'LDO');
    const args = { name: 'LDO', files, asSheet: false, keepAnnotations: false, asGroup: true, nickname: BLOCKS };
    const depth0 = await undoDepth(frame);

    // Placed, then dropped by Escape: no undo step, the run folder gone once the layout hangs.
    let { ms, result } = await place(page, args);
    measure('block.place pcb LDO', `${ms} ms`);
    expect(result).toEqual({});
    expect(await runFiles(frame)).toEqual([]);
    expect(await refusal(page, 'select', { uuids: [] })).toBe('busy: select');
    await hover(page);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
    expect(await undoDepth(frame)).toBe(depth0);
    expect(await refusal(page, 'select', { uuids: [] })).toBe('ok');

    // One at a time: a second placement drops the first, and one press commits ONE step.
    ({ result } = await place(page, args));
    expect(result).toEqual({});
    ({ ms, result } = await place(page, args));
    measure('block.place pcb LDO over a hanging one', `${ms} ms`);
    expect(result).toEqual({});
    expect(await undoDepth(frame)).toBe(depth0);
    const at = await hover(page);
    await page.mouse.click(at.x, at.y);
    await expect.poll(() => undoDepth(frame), { timeout: 10_000 }).toBe(depth0 + 1);
    await page.waitForTimeout(600);
    expect(await undoDepth(frame)).toBe(depth0 + 1);
    expect(await refusal(page, 'select', { uuids: [] })).toBe('ok');

    await page.keyboard.press('Control+z');
    await expect.poll(() => undoDepth(frame), { timeout: 10_000 }).toBe(depth0);
  });

  test('blocks-small, sch frame: RC\'s items and LDO as a sheet, the files under /tmp/cc-block/<n>/<name>.kicad_block/, Escape drops a hanging sheet, each press one undo step', async ({ page, browserName }) => {
    const { caps, island } = await boot(page, 'blocks-small', 'sch');
    test.skip(!run15(caps), RUN15);
    test.skip(island == null, `${browserName}: the island frame is out of Playwright's reach, so the undo depth and the run folders cannot be read here`);
    const frame = island!;
    expect(await request(page, 'project.libs', { libs: [BLOCKS] })).toMatchObject({ block: [BLOCKS] });
    const depth0 = await undoDepth(frame);

    // RC's items: hang, one press, one step.
    const rc = await blockFiles(page, 'RC');
    let { ms, result } = await place(page, { name: 'RC', files: rc, asSheet: false, keepAnnotations: true, asGroup: false });
    measure('block.place sch RC items', `${ms} ms`);
    expect(result).toEqual({});
    let at = await hover(page);
    await page.mouse.click(at.x, at.y);
    await expect.poll(() => undoDepth(frame), { timeout: 10_000 }).toBe(depth0 + 1);
    await page.waitForTimeout(600);
    expect(await undoDepth(frame)).toBe(depth0 + 1);

    // LDO as a sheet: its files stay in the run folder while the box hangs; Escape drops it with no step.
    const ldo = await blockFiles(page, 'LDO');
    const asSheet = { name: 'LDO', files: ldo, asSheet: true, keepAnnotations: false, asGroup: true, nickname: BLOCKS };
    ({ ms, result } = await place(page, asSheet));
    measure('block.place sch LDO as a sheet', `${ms} ms`);
    expect(result).toEqual({});
    const held = await runFiles(frame);
    expect(held).toHaveLength(3);
    expect(held.every((p) => /^\d+\/LDO\.kicad_block\/LDO\.(kicad_sch|kicad_pcb|json)$/.test(p))).toBe(true);
    await hover(page, 60);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
    expect(await undoDepth(frame)).toBe(depth0 + 1);

    // Again in a fresh folder (the old one cleared): one press puts the sheet down as ONE step, a second press places nothing.
    ({ result } = await place(page, asSheet));
    expect(result).toEqual({});
    const fresh = await runFiles(frame);
    expect(fresh).toHaveLength(3);
    expect(fresh[0].split('/')[0]).not.toBe(held[0].split('/')[0]);
    at = await hover(page, 60);
    await page.mouse.click(at.x, at.y);
    await expect.poll(() => undoDepth(frame), { timeout: 10_000 }).toBe(depth0 + 2);
    await page.mouse.click(at.x + 40, at.y + 40);
    await page.waitForTimeout(800);
    expect(await undoDepth(frame)).toBe(depth0 + 2);
    expect(await refusal(page, 'select', { uuids: [] })).toBe('ok');

    await page.keyboard.press('Control+z');
    await expect.poll(() => undoDepth(frame), { timeout: 10_000 }).toBe(depth0 + 1);
  });
});
