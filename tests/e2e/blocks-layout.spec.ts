// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// i-block-layout over the local pair (PROTOCOL.md block.applyLayout, and
// board.preview and board.update with Keep groups and Apply block layouts),
// on the blocks-small fixture (unit i-fix-blocks). On engine run 14 the engine
// has neither kicadDesignBlockApplyLayout nor the marker
// kicadBoardUpdateGroups: block.applyLayout is listed in island.json, checks
// its args first and answers unsupported naming the export, a preview with
// Keep groups on answers unsupported naming the marker, Apply block layouts
// without Keep groups answers bad_args, Keep groups off runs today's preview,
// and the cap blockLayouts is absent. On engine run 15 (unit e-block-layout)
// a moved member of a group placed from LDO goes back in one undo step, and an
// update keeping the groups of a schematic holding LDO_PARTIAL answers the
// layouts' failures.
import { expect, test, type Frame, type Page } from '@playwright/test';

import { ISLAND } from './ports';

interface Ev { type: string; phase?: string; caps?: string[]; at: number }
interface Harness { __events: Ev[]; __saved: Record<string, Uint8Array>; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Engine {
  Module: { kicadCollabTestUndoDepth(): number; kicadDesignBlockPlace(json: string): boolean };
  FS: { mkdirTree(p: string): void; writeFile(p: string, data: string): void; analyzePath(p: string): { exists: boolean }; readdir(p: string): string[] };
}
interface Layouts { applied: number; failures: Array<{ uuid: string; reason: string }> }
type Kind = 'sch' | 'pcb';

const RUN15 = 'waits for engine run 15: kicadDesignBlockApplyLayout and kicadBoardUpdateGroups (unit e-block-layout)';
const FIXTURE = 'blocks-small';
const BLOCKS = 'blocks-small_blocks';
const OPTS = { replaceFootprints: false, deleteExtra: false, relinkByReference: false };
const KEEP = { ...OPTS, transferGroups: true, applyBlockLayouts: true };
/** blocks-small's J1, a footprint in no group. */
const J1 = 'cc0b10c5-0000-4000-8000-000000000500';
const NO_GROUP = 'cc0b10c5-0000-4000-8000-00000000ffff';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
/** A request timed in the page, from the request to the answer. */
const timed = (page: Page, op: string, args: unknown): Promise<{ ms: number; result: Record<string, unknown> }> => page.evaluate(async ([o, a]) => {
  const t0 = performance.now();
  const result = await (window as unknown as Harness).__bridge.request(o as string, a);
  return { ms: Math.round(performance.now() - t0), result };
}, [op, args] as const);

/**
 * The page with blocks-small open in a frame of that kind (its schematic
 * replaced by `schematic` when given); ev.ready's caps and the island frame
 * (null where Playwright cannot reach it).
 */
async function boot(page: Page, kind: Kind, schematic?: string): Promise<{ caps: string[]; island: Frame | null }> {
  await page.goto(schematic == null ? `/parent.html?fixture=${FIXTURE}&frame=${kind}` : `/parent.html?frame=${kind}`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  if (schematic != null) {
    const answer = await page.evaluate(async ([fx, sch]) => {
      const enc = new TextEncoder();
      const names = (await (await fetch(`/fixtures/${fx}/files.json`)).json()) as string[];
      const files = await Promise.all(names.map(async (path) => ({
        path, bytes: path === `${fx}.kicad_sch` ? enc.encode(sch) : new Uint8Array(await (await fetch(`/fixtures/${fx}/${path}`)).arrayBuffer()),
      })));
      return (window as unknown as Harness).__bridge.request('project.open', { name: fx, files });
    }, [FIXTURE, schematic] as const);
    expect(answer).toMatchObject({ opened: `${FIXTURE}.kicad_${kind}` });
  } else {
    await expect(page.locator('#state')).toContainText(`opened ${FIXTURE}.kicad_${kind}`, { timeout: 120_000 });
  }
  await page.waitForTimeout(1_500);   // the open's baseline read (ev.edited)
  const caps = (await events(page)).find((e) => e.type === 'ev.ready')?.caps ?? [];
  return { caps, island: page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null };
}
const run15 = (caps: readonly string[]): boolean => caps.includes('kicadDesignBlockApplyLayout') && caps.includes('kicadBoardUpdateGroups');
const undoDepth = (island: Frame): Promise<number> => island.evaluate(() => Number((window as unknown as Engine).Module.kicadCollabTestUndoDepth()));
/** The run folders left under /tmp/cc-blocklayout. */
const leftOver = (island: Frame): Promise<string[]> => island.evaluate(() => {
  const { FS } = window as unknown as Engine;
  return FS.analyzePath('/tmp/cc-blocklayout').exists ? FS.readdir('/tmp/cc-blocklayout').filter((n) => n !== '.' && n !== '..') : [];
});

/**
 * A block of the fixture placed through the engine's own place (the block
 * row loaded first, so the placed group keeps its link), put down by one
 * press at the drawing's middle: one undo step.
 */
async function placeBlock(page: Page, island: Frame, name: string, kind: Kind): Promise<void> {
  expect(await request(page, 'project.libs', { libs: [BLOCKS] })).toMatchObject({ block: [BLOCKS] });
  const names = kind === 'pcb' ? [`${name}.kicad_sch`, `${name}.kicad_pcb`, `${name}.json`] : [`${name}.kicad_sch`, `${name}.json`];
  const texts = await page.evaluate(async ([n, ns]) => Promise.all(ns.map(async (f) => (await fetch(`/fixtures/blocks-small/blocks-small_blocks.kicad_blocks/${n}.kicad_block/${f}`)).text())), [name, names] as const);
  // The engine reads a block only from a run folder under /tmp/cc-block/ (block.place's own root).
  const placed = await island.evaluate(([n, ns, bodies, lib]) => {
    const { FS, Module } = window as unknown as Engine;
    const dir = '/tmp/cc-block/9101';
    FS.mkdirTree(`${dir}/${n}.kicad_block`);
    ns.forEach((f, i) => FS.writeFile(`${dir}/${n}.kicad_block/${f}`, bodies[i]));
    return Module.kicadDesignBlockPlace(JSON.stringify({ dir, name: n, asSheet: false, keepAnnotations: true, asGroup: true, nickname: lib }));
  }, [name, names, texts, BLOCKS] as const);
  expect(placed).toBe(true);
  const depth0 = await undoDepth(island);
  const box = await page.locator('iframe').boundingBox();
  expect(box).not.toBeNull();
  await page.waitForTimeout(800);
  await page.mouse.move(box!.x + box!.width / 2 - 10, box!.y + box!.height / 2 - 10);
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await expect.poll(() => undoDepth(island), { timeout: 10_000 }).toBe(depth0 + 1);
  await page.keyboard.press('Escape');
}

/** The board as KiCad writes it (block.save of the whole board): each group linked to `block`, with its members. */
async function linkedGroups(page: Page, block: string): Promise<Array<{ uuid: string; members: string[] }>> {
  const saved = await request(page, 'block.save', { scope: 'board', name: 'board now' }) as unknown as { files: Array<{ text: string }> };
  return saved.files[0].text.split(/\(group\s/).slice(1).filter((g) => g.includes(`(lib_id "${BLOCKS}:${block}")`)).map((g) => ({
    uuid: /\(uuid\s+"?([0-9a-f-]{36})"?\)/.exec(g)?.[1] ?? '',
    members: [.../\(members([^)]*)\)/.exec(g)?.[1].matchAll(/"?([0-9a-f-]{36})"?/g) ?? []].map((m) => m[1]),
  }));
}

test.describe('engine run 14 or 15: block.applyLayout is listed, and both ops check their args first', () => {
  test('island.json lists block.applyLayout', async ({ page }) => {
    const res = await page.goto(`${ISLAND}/island.json`);
    const island = (await res!.json()) as { ops?: string[] };
    expect(island.ops ?? []).toContain('block.applyLayout');
  });

  test('a pcb frame: bad uuids answer bad_args, Apply block layouts without Keep groups bad_args; without the engine half unsupported naming it, Keep groups off today\'s preview', async ({ page }) => {
    const { caps } = await boot(page, 'pcb');
    for (const args of [{}, { uuids: [] }, { uuids: ['X'] }, { uuids: [J1, J1] }, { uuids: [J1], more: 1 }, { uuids: Array.from({ length: 257 }, (_, i) => `cc0b10c5-0000-4000-8000-${i.toString(16).padStart(12, '0')}`) }]) {
      expect(await refusal(page, 'block.applyLayout', args)).toBe('bad_args: block.applyLayout');
    }
    expect(await refusal(page, 'board.preview', { ...OPTS, applyBlockLayouts: true })).toBe('bad_args: board.preview');
    expect(await refusal(page, 'board.preview', { ...OPTS, transferGroups: false, applyBlockLayouts: true })).toBe('bad_args: board.preview');
    expect(await refusal(page, 'board.update', { ...OPTS, applyBlockLayouts: false, token: 't' })).toBe('bad_args: board.update');
    // Keep groups off is today's run on any engine: no layouts in the answer.
    const off = await request(page, 'board.preview', { ...OPTS, transferGroups: false });
    expect(off).toMatchObject({ blocked: '' });
    expect('layouts' in off).toBe(false);
    if (!run15(caps)) {
      expect(caps).not.toContain('blockLayouts');
      expect(await refusal(page, 'block.applyLayout', { uuids: [J1] })).toBe('unsupported: kicadDesignBlockApplyLayout');
      expect(await refusal(page, 'board.preview', { ...OPTS, transferGroups: true })).toBe('unsupported: kicadBoardUpdateGroups');
      expect(await refusal(page, 'board.update', { ...KEEP, token: 't' })).toBe('unsupported: kicadBoardUpdateGroups');
    } else {
      expect(caps).toContain('blockLayouts');
    }
  });

  test('a sch frame: block.applyLayout answers unsupported with its frame refusal, and no blockLayouts cap', async ({ page }) => {
    const { caps } = await boot(page, 'sch');
    expect(caps).not.toContain('blockLayouts');
    expect(await refusal(page, 'block.applyLayout', { uuids: [J1] })).toBe('unsupported: a design block layout is applied in a pcb frame');
  });
});

test.describe('engine run 15: block layouts', () => {
  test('blocks-small, pcb frame: a moved member of a group placed from LDO goes back in one undo step; a uuid naming no group answers block_failed', async ({ page, browserName }) => {
    const { caps, island } = await boot(page, 'pcb');
    test.skip(!run15(caps), RUN15);
    test.skip(island == null, `${browserName}: the island frame is out of Playwright's reach, so the linked group cannot be placed through the engine here`);
    const frame = island!;
    await placeBlock(page, frame, 'LDO', 'pcb');

    const groups = await linkedGroups(page, 'LDO');
    expect(groups.length).toBe(1);
    const group = groups[0];
    expect(group.uuid).toMatch(UUID);
    const read = await request(page, 'board.item.get', { uuids: group.members }) as unknown as { items: Array<{ kind: string; uuid: string; x: number }> };
    const fp = read.items.find((i) => i.kind === 'footprint');
    expect(fp).toBeDefined();
    const x0 = fp!.x;
    await request(page, 'board.item.set', { uuid: fp!.uuid, set: { x: x0 + 5 } });

    const depth0 = await undoDepth(frame);
    const { ms, result } = await timed(page, 'block.applyLayout', { uuids: [group.uuid] });
    measure('block.applyLayout, one group of LDO', `${ms} ms`);
    expect(result).toEqual({ applied: 1, failures: [] });
    expect(await undoDepth(frame)).toBe(depth0 + 1);
    const back = await request(page, 'board.item.get', { uuids: [fp!.uuid] }) as unknown as { items: Array<{ x: number }> };
    expect(back.items[0].x).toBeCloseTo(x0, 3);
    expect(back.items[0].x).not.toBeCloseTo(x0 + 5, 3);

    expect(await refusal(page, 'block.applyLayout', { uuids: [J1] })).toBe('block_failed: a uuid names no group of the board');
    expect(await refusal(page, 'block.applyLayout', { uuids: [NO_GROUP] })).toBe('block_failed: a uuid names no group of the board');
    expect(await undoDepth(frame)).toBe(depth0 + 1);
    expect(await leftOver(frame)).toEqual([]);
  });

  test('blocks-small: a schematic holding LDO_PARTIAL updated onto the board with Keep groups and Apply block layouts answers the layouts\' failure', async ({ page, browserName }) => {
    // 1. LDO_PARTIAL's schematic placed in the root sheet as a group linked to its block, then saved.
    const sch = await boot(page, 'sch');
    test.skip(!run15(sch.caps), RUN15);
    test.skip(sch.island == null, `${browserName}: the island frame is out of Playwright's reach, so the linked group cannot be placed through the engine here`);
    await placeBlock(page, sch.island!, 'LDO_PARTIAL', 'sch');
    await request(page, 'project.save');
    const schematic = await page.evaluate((path) => new TextDecoder().decode((window as unknown as Harness).__saved[path]), `${FIXTURE}.kicad_sch`);
    expect(schematic).toContain(`(lib_id "${BLOCKS}:LDO_PARTIAL")`);

    // 2. The board opened beside that schematic, the block row loaded, then the preview and the update keeping the groups.
    const pcb = await boot(page, 'pcb', schematic);
    expect(await request(page, 'project.libs', { libs: [BLOCKS] })).toMatchObject({ block: [BLOCKS] });
    const keepOnly = await request(page, 'board.preview', { ...OPTS, transferGroups: true }) as unknown as { layouts: Layouts };
    expect(keepOnly.layouts).toEqual({ applied: 0, failures: [] });
    const { ms: pms, result: preview } = await timed(page, 'board.preview', KEEP);
    measure('board.preview with Keep groups and Apply block layouts, blocks-small', `${pms} ms`);
    expect(preview.layouts).toEqual({ applied: 0, failures: [] });
    const p = preview as unknown as { token: string; errors: number; changes: Array<{ kind: string; code?: string }> };
    if (p.changes.some((c) => c.kind === 'problem' && c.code === 'footprint_not_found')) {
      test.info().annotations.push({ type: 'no mirror', description: 'the pair serves no library mirror: the preview answered footprint_not_found, and no update was applied' });
      return;
    }
    // An update whose boxes differ from its preview's is stale.
    expect(await refusal(page, 'board.update', { ...OPTS, transferGroups: true, token: p.token })).toMatch(/^stale: /);

    const again = await request(page, 'board.preview', KEEP) as unknown as { token: string };
    const depth0 = pcb.island == null ? null : await undoDepth(pcb.island);
    const { ms: ums, result: update } = await timed(page, 'board.update', { ...KEEP, token: again.token });
    measure('board.update with Keep groups and Apply block layouts, blocks-small', `${ums} ms`);
    const layouts = update.layouts as Layouts;
    expect(layouts.failures.length).toBeGreaterThanOrEqual(1);
    for (const f of layouts.failures) {
      expect(f.uuid).toMatch(UUID);
      expect(f.reason.trim()).not.toBe('');
    }
    measure('LDO_PARTIAL failure', layouts.failures.map((f) => f.reason).join(' | '));
    // The update is one step, plus one per group laid out.
    if (pcb.island != null) expect(await undoDepth(pcb.island)).toBe((depth0 as number) + 1 + layouts.applied);
    const groups = await linkedGroups(page, 'LDO_PARTIAL');
    expect(groups.map((g) => g.uuid)).toContain(layouts.failures[0].uuid);
  });
});
