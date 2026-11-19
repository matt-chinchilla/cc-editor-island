// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-mc-i over the local pair (PROTOCOL.md board.multichannel): KiCad's
// multichannel tool on KiCad's own qa board issue21739 topology_mismatch (the
// sheet i2c_thingy placed twice, the board holding the two placement rule
// areas of its channels; GPL-3.0-or-later, read from the KiCad clone by path
// at test time and never copied: CC_KICAD_DIR names the clone). On engine run
// 14 the cap multichannel is absent, board.multichannel answers unsupported
// naming kicadMultichannel, and KiCad's Generate Placement Rule Areas and
// Repeat Layout are left to KiCad. On engine run 15 (cc25): the areas read
// lists the two channel areas as sheet areas that exist; the check of channel
// 0 finds channel 1 a match with KiCad's OK; a repeat preview changes nothing
// and the repeat is ONE undo step that one undo takes back; generate skips the
// areas that exist, refuses a key KiCad does not find, and with replace makes
// two new areas in ONE undo step; /tmp/cc-multichannel holds no folder after
// any answer; and both KiCad actions send ev.held.
import { expect, test, type Frame, type Page } from '@playwright/test';
import { ISLAND, PAGE } from '../ports';

declare const process: { env: Record<string, string | undefined> };
const KICAD = process.env.CC_KICAD_DIR ?? '/home/matthew/cc-engine/kicad-source-mirror';
const QA = `${KICAD}/qa/data/pcbnew/issue21739`;
const OUTSIDE_PREFIX = '/st-mc-i-outside/';
const FILES = ['topology_mismatch.kicad_pro', 'topology_mismatch.kicad_pcb', 'topology_mismatch.kicad_sch', 'i2c_thingy.kicad_sch'];
const RUN15 = 'waits for engine run 15 (pcbjam cc_e13_pcb.inc, unit st-mc-e: kicadMultichannel, kicadMultichannelApply)';
const GENERATE_AREAS = 'pcbnew.Multichannel.generatePlacementRuleAreas';
const REPEAT_LAYOUT = 'pcbnew.Multichannel.repeatLayout';
const CH0 = '/i2c_thingy_ch0/';
const CH1 = '/i2c_thingy_ch1/';
const UNDO = { key: 'z', code: 'KeyZ', ctrl: true };

interface Ev { type: string; phase?: string; caps?: string[]; action?: string; depth?: number; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Engine {
  Module: { kicadCollabTestUndoDepth(): number };
  FS: { readdir(p: string): string[]; analyzePath(p: string): { exists: boolean } };
  kicadHostAction?: { onRequest?: (json: unknown) => boolean };
}
interface AreaRow { key: string; name: string; source: string; sheetPath: string; parts: number; exists: boolean; zone: string }
interface RuleAreaRow { zone: string; name: string; source: string; sourceName: string; parts: number }
interface CheckRow { zone: string; name: string; parts: number; matched: number; ok: boolean; message: string; reasons: string[] }
interface Report { preview: boolean; areas: Array<Record<string, unknown>>; applied: number; depth: number }

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
/** board.multichannel, timed in the page. */
const mc = (page: Page, args: unknown): Promise<{ ms: number; result: Record<string, unknown> }> =>
  page.evaluate(async (a) => {
    const t0 = performance.now();
    const result = await (window as unknown as Harness).__bridge.request('board.multichannel', a);
    return { ms: Math.round((performance.now() - t0) * 100) / 100, result };
  }, args);

/** Boots a pcb frame and opens KiCad's qa project from the clone; answers ev.ready's caps and the island frame (null where Playwright cannot reach it). */
async function boot(page: Page): Promise<{ caps: string[]; frame: Frame | null }> {
  await page.route(`${PAGE}${OUTSIDE_PREFIX}**`, async (route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.slice(OUTSIDE_PREFIX.length));
    return FILES.includes(name) ? route.fulfill({ path: `${QA}/${name}`, contentType: 'application/octet-stream' }) : route.fulfill({ status: 404, body: 'not a fixture' });
  });
  await page.goto('/parent.html?frame=pcb');
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  const caps = (await of(page, 'ev.ready'))[0]?.caps ?? [];
  const opened = await page.evaluate(async ([prefix, names]) => {
    const files = await Promise.all((names as string[]).map(async (path) => ({ path, bytes: new Uint8Array(await (await fetch(`${prefix}${path}`)).arrayBuffer()) })));
    return (window as unknown as Harness).__bridge.request('project.open', { name: 'topology_mismatch', files, open: 'topology_mismatch.kicad_pcb' });
  }, [OUTSIDE_PREFIX, FILES] as const);
  expect(opened.opened).toBe('topology_mismatch.kicad_pcb');
  await page.waitForTimeout(1_500);   // ev.edited's baseline
  return { caps, frame: page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null };
}
const undoDepth = (frame: Frame): Promise<number> => frame.evaluate(() => Number((window as unknown as Engine).Module.kicadCollabTestUndoDepth()));
/** The folders left under the run root. */
const leftOver = (frame: Frame): Promise<string[]> => frame.evaluate(() => {
  const { FS } = window as unknown as Engine;
  const root = '/tmp/cc-multichannel';
  return FS.analyzePath(root).exists ? FS.readdir(root).filter((n) => n !== '.' && n !== '..').map((n) => `${root}/${n}`) : [];
});
/** Asks the frame's held slot as the engine does: taken, and the ev.held sent for it. */
async function askHeld(page: Page, frame: Frame, action: string): Promise<{ taken: boolean; sent: string | null }> {
  const n = (await of(page, 'ev.held')).length;
  const taken = await frame.evaluate((a) => (window as unknown as Engine).kicadHostAction?.onRequest?.(JSON.stringify({ action: a })) === true, action);
  await page.waitForTimeout(300);
  const after = await of(page, 'ev.held');
  return { taken, sent: after.length > n ? after.at(-1)?.action ?? null : null };
}

test('run 14 or 15: multichannel follows the engine\'s exports; without them board.multichannel answers unsupported naming kicadMultichannel and both KiCad actions are KiCad\'s', async ({ page, browserName }) => {
  const { caps, frame } = await boot(page);
  if (!caps.includes('multichannel')) {
    expect(await refusal(page, 'board.multichannel', { op: 'areas' })).toBe('unsupported: kicadMultichannel');
    expect(await refusal(page, 'board.multichannel', { op: 'generate', areas: [`sheet:${CH0}`], replaceExisting: false })).toBe('unsupported: kicadMultichannel');
  }
  expect(await refusal(page, 'board.multichannel', { op: 'list' })).toBe('bad_args: board.multichannel');
  expect(await refusal(page, 'board.multichannel', { op: 'repeat', ref: 'x', targets: [], options: {}, preview: true })).toBe('bad_args: board.multichannel');
  test.skip(frame == null, `${browserName}: the island frame is out of Playwright's reach, so its held slot cannot be asked`);
  const held = caps.includes('multichannel');
  for (const action of [GENERATE_AREAS, REPEAT_LAYOUT]) {
    expect(await askHeld(page, frame!, action)).toEqual({ taken: held, sent: held ? action : null });
  }
});

test('run 15: the areas, the check, a repeat previewed then applied as one undo step, rule areas made as one undo step, both actions held', async ({ page, browserName }) => {
  const { caps, frame } = await boot(page);
  test.skip(!caps.includes('multichannel'), RUN15);
  test.skip(frame == null, `${browserName}: the island frame is out of Playwright's reach, so the undo depth and the run folders cannot be read`);
  const depth0 = await undoDepth(frame!);
  const edits0 = (await of(page, 'ev.edited')).length;

  // The areas: the two channel areas exist as sheet rule areas with equal parts.
  const read = await mc(page, { op: 'areas' });
  measure('board.multichannel areas', `${read.ms} ms`);
  const { areas, ruleAreas, canGenerate } = read.result as { areas: AreaRow[]; ruleAreas: RuleAreaRow[]; canGenerate: boolean };
  expect(canGenerate).toBe(true);
  expect(ruleAreas.map((r) => [r.source, r.sourceName]).sort()).toEqual([['sheet', CH0], ['sheet', CH1]]);
  expect(ruleAreas[0].parts).toBeGreaterThan(0);
  expect(ruleAreas[0].parts).toBe(ruleAreas[1].parts);
  const zoneOf = (path: string): string => ruleAreas.find((r) => r.sourceName === path)!.zone;
  for (const path of [CH0, CH1]) {
    expect(areas.find((a) => a.key === `sheet:${path}`)).toMatchObject({ source: 'sheet', sheetPath: path, exists: true, zone: zoneOf(path) });
  }

  // The check of channel 0: channel 1 matches, KiCad's OK.
  const check = await mc(page, { op: 'check', ref: zoneOf(CH0) });
  measure('board.multichannel check', `${check.ms} ms`);
  const checks = (check.result as { checks: CheckRow[] }).checks;
  expect(checks).toHaveLength(1);
  expect(checks[0]).toMatchObject({ zone: zoneOf(CH1), ok: true, message: 'OK', reasons: [] });
  expect(checks[0].matched).toBe(checks[0].parts);
  expect(await refusal(page, 'board.multichannel', { op: 'check', ref: '00000000-0000-4000-8000-000000000000' })).toBe('not_found: 00000000-0000-4000-8000-000000000000');

  // The repeat, previewed: nothing changes.
  const repeat = { op: 'repeat', ref: zoneOf(CH0), targets: [zoneOf(CH1)], options: {} };
  const preview = await mc(page, { ...repeat, preview: true });
  measure('board.multichannel repeat preview', `${preview.ms} ms`);
  expect(preview.result).toMatchObject({ preview: true, applied: 1, depth: depth0 });
  expect((preview.result as unknown as Report).areas).toEqual([expect.objectContaining({ zone: zoneOf(CH1), ok: true })]);
  expect(await undoDepth(frame!)).toBe(depth0);
  expect(await leftOver(frame!)).toEqual([]);
  await page.waitForTimeout(1_000);
  expect((await of(page, 'ev.edited')).length).toBe(edits0);

  // The repeat: one undo step, which one undo takes back.
  const applied = await mc(page, { ...repeat, preview: false });
  measure('board.multichannel repeat', `${applied.ms} ms`);
  expect(applied.result).toMatchObject({ preview: false, applied: 1, depth: depth0 + 1 });
  expect(await undoDepth(frame!)).toBe(depth0 + 1);
  await expect.poll(async () => (await of(page, 'ev.edited')).length, { timeout: 5_000 }).toBeGreaterThan(edits0);
  expect(await leftOver(frame!)).toEqual([]);
  expect(await request(page, 'key.press', UNDO)).toEqual({});
  await expect.poll(() => undoDepth(frame!), { timeout: 5_000 }).toBe(depth0);

  // Generate: the areas that exist are skipped, a key KiCad does not find is refused.
  const keys = [`sheet:${CH0}`, `sheet:${CH1}`];
  const skipped = await mc(page, { op: 'generate', areas: keys, replaceExisting: false });
  expect(skipped.result).toMatchObject({ preview: false, applied: 0, depth: depth0 });
  expect((skipped.result as unknown as Report).areas.map((r) => [r.key, r.skipped])).toEqual(keys.map((k) => [k, 'exists']));
  expect(await refusal(page, 'board.multichannel', { op: 'generate', areas: ['sheet:/no_such_sheet/'], replaceExisting: true })).toBe('not_found: sheet:/no_such_sheet/');
  expect(await undoDepth(frame!)).toBe(depth0);

  // Generate with replace: two new areas in one undo step, the old two gone.
  const made = await mc(page, { op: 'generate', areas: keys, replaceExisting: true });
  measure('board.multichannel generate', `${made.ms} ms`);
  expect(made.result).toMatchObject({ preview: false, applied: 2, depth: depth0 + 1 });
  const rows = (made.result as unknown as Report).areas as Array<{ key: string; ok: boolean; zone?: string }>;
  expect(rows.map((r) => [r.key, r.ok])).toEqual(keys.map((k) => [k, true]));
  const after = (await request(page, 'board.multichannel', { op: 'areas' })) as unknown as { ruleAreas: RuleAreaRow[] };
  expect(after.ruleAreas.map((r) => r.zone).sort()).toEqual(rows.map((r) => r.zone).sort());
  expect(after.ruleAreas.map((r) => r.zone)).not.toContain(zoneOf(CH0));
  expect(await undoDepth(frame!)).toBe(depth0 + 1);
  expect(await leftOver(frame!)).toEqual([]);

  for (const action of [GENERATE_AREAS, REPEAT_LAYOUT]) {
    expect(await askHeld(page, frame!, action)).toEqual({ taken: true, sent: action });
  }
});
