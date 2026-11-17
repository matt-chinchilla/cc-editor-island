// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// island v0.2.3-cc23 over the local pair (PROTOCOL.md): board.rules reads the
// rules KiCad applies to one board item (its Constraints Resolution) or between
// two (its Clearance Resolution), with no KiCad window, through our engine's
// kicadResolveRules (engine run 14). On Glasgow: a pad, a track, a pad and a
// track of two nets, and a pad and a track of one net; on drc-small with a rules
// file that does not compile.
import { expect, test, type Page } from '@playwright/test';

interface Ev { type: string; phase?: string; caps?: string[]; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Rule { constraint: string; unit: string; min: number | null; opt: number | null; max: number | null; verdict: string; source: string; name: string; condition: string; layer: string; items: Array<{ uuid: string; netclass: string }> }
interface Rules { rules: Rule[]; notes: string[] }

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
/** board.rules with its latency, measured in the page. */
const rules = (page: Page, args: unknown): Promise<Rules & { ms: number }> => page.evaluate(async (a) => {
  const t0 = performance.now();
  const r = await (window as unknown as Harness).__bridge.request('board.rules', a) as unknown as Rules;
  return { ...r, ms: Math.round(performance.now() - t0) };
}, args);
const summary = (r: Rules): string => r.rules.map((x) => `${x.constraint}${x.layer === '' ? '' : `@${x.layer}`} ${x.min ?? '-'}/${x.opt ?? '-'}/${x.max ?? '-'} ${x.unit}${x.verdict === '' ? '' : ` ${x.verdict}`} (${x.source}${x.name === '' ? '' : ` ${x.name}`})`).join('; ');

async function boot(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
}

// Glasgow (a KiCad 6 board: its tstamps are the items' uuids): TP pads and F.Cu tracks.
/** Pad 1 of a test point on net 1 (/SDA), F.Cu. */
const PAD_SDA = '91c8df6d-e40b-46b7-8db4-36c6027c36ea';
/** Pad 1 of a test point on net 4 (/SCL), F.Cu. */
const PAD_SCL = 'd7c89af1-19d8-4456-a972-5f70a7809836';
/** A 0.15 mm track on net 1 (/SDA), F.Cu. */
const TRACK_SDA = '065e20db-a8d8-41a2-86d7-70fce80d950f';

test('board.rules on Glasgow: a pad, a track, a pad and a track of two nets, and of one net', async ({ page }) => {
  await boot(page, '/parent.html?fixture=glasgow&frame=pcb');
  await expect(page.locator('#state')).toContainText('opened glasgow.kicad_pcb', { timeout: 120_000 });
  expect((await of(page, 'ev.ready'))[0]?.caps).toContain('rules');
  await page.waitForTimeout(1_500);
  const edits = (await of(page, 'ev.edited')).length;

  const pad = await rules(page, { a: PAD_SDA });
  measure('board.rules, a pad', `${pad.ms} ms: ${summary(pad)}${pad.notes.length > 0 ? `; notes: ${pad.notes.join(' | ')}` : ''}`);
  const kinds = pad.rules.map((r) => r.constraint);
  expect(kinds).toEqual(expect.arrayContaining(['solder_mask_expansion', 'solder_paste_abs_margin', 'solder_paste_rel_margin', 'disallow']));
  expect(pad.rules.find((r) => r.constraint === 'solder_paste_rel_margin')?.unit).toBe('percent');
  expect(pad.rules.find((r) => r.constraint === 'disallow')?.verdict).toMatch(/^(allowed|disallowed)$/);
  for (const r of pad.rules) expect(r.items.map((i) => i.uuid)).toEqual([PAD_SDA]);

  const track = await rules(page, { a: TRACK_SDA });
  measure('board.rules, a track', `${track.ms} ms: ${summary(track)}`);
  const width = track.rules.find((r) => r.constraint === 'track_width');
  expect(width).toMatchObject({ unit: 'mm', layer: 'F.Cu' });
  expect(width?.min).not.toBeNull();
  expect(track.rules.map((r) => r.constraint)).toContain('solder_mask_expansion');

  const pair = await rules(page, { a: PAD_SCL, b: TRACK_SDA });
  measure('board.rules, a pad and a track of two nets', `${pair.ms} ms: ${summary(pair)}`);
  const clearance = pair.rules.find((r) => r.constraint === 'clearance' && r.layer === 'F.Cu');
  expect(clearance).toBeDefined();
  expect(clearance?.source).not.toBe('sameNet');
  expect(clearance?.min).toBeGreaterThan(0);
  expect(clearance?.items.map((i) => i.uuid).sort()).toEqual([PAD_SCL, TRACK_SDA].sort());

  const same = await rules(page, { a: PAD_SDA, b: TRACK_SDA });
  measure('board.rules, a pad and a track of one net', `${same.ms} ms: ${summary(same)}`);
  expect(same.rules.find((r) => r.constraint === 'clearance' && r.layer === 'F.Cu')).toMatchObject({ source: 'sameNet', min: 0, unit: 'mm' });

  // The latency of a read, the median of five.
  const ms: number[] = [];
  for (let i = 0; i < 5; i++) ms.push((await rules(page, { a: PAD_SCL, b: TRACK_SDA })).ms);
  measure('board.rules, the pair, five reads', `${ms.join(', ')} ms; median ${[...ms].sort((x, y) => x - y)[2]} ms`);

  expect(await refusal(page, 'board.rules', { a: 'aaaaaaaa-0000-4000-8000-000000000001' })).toBe('not_found: aaaaaaaa-0000-4000-8000-000000000001');
  expect(await refusal(page, 'board.rules', { a: PAD_SDA, b: PAD_SDA })).toBe('bad_args: board.rules');
  expect(await refusal(page, 'board.rules', { a: PAD_SDA.toUpperCase() })).toBe('bad_args: board.rules');
  // A read: nothing in the board changed.
  await page.waitForTimeout(2_000);
  expect((await of(page, 'ev.edited')).length).toBe(edits);
  expect(await of(page, 'ev.menu')).toEqual([]);
});

test('board.rules is a board op: a schematic frame answers it unsupported', async ({ page }) => {
  await boot(page, '/parent.html?fixture=glasgow&frame=sch');
  await expect(page.locator('#state')).toContainText('opened glasgow.kicad_sch', { timeout: 120_000 });
  expect(await refusal(page, 'board.rules', { a: PAD_SDA })).toBe('unsupported: a board op runs in a pcb frame');
});

test('board.rules with a rules file that does not compile answers rules_invalid', async ({ page }) => {
  await boot(page, '/parent.html?frame=pcb');
  const answer = await page.evaluate(async () => {
    const get = async (p: string) => new Uint8Array(await (await fetch(p)).arrayBuffer());
    const files = [
      ...await Promise.all(['drc-small.kicad_pro', 'drc-small.kicad_sch', 'drc-small.kicad_pcb'].map(async (path) => ({ path, bytes: await get(`/fixtures/drc-small/${path}`) }))),
      { path: 'drc-small.kicad_dru', bytes: await get('/fixtures/drc-badrules/drc-small.kicad_dru') },
    ];
    const board = new TextDecoder().decode(files[2].bytes);
    // Any item of the board: the first uuid its text names.
    const uuid = /\(uuid "([0-9a-f-]{36})"\)/.exec(board)?.[1] ?? '';
    const bridge = (window as unknown as Harness).__bridge;
    await bridge.request('project.open', { name: 'drc-small', files });
    await new Promise((r) => setTimeout(r, 1_500));
    return bridge.request('board.rules', { a: uuid }).then(() => 'ok', (e: Error) => e.message);
  });
  measure('board.rules, drc-badrules', answer);
  expect(answer).toBe('rules_invalid: board.rules');
});
