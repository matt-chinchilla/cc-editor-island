// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// island v0.2.3-cc18 over the local pair (PROTOCOL.md board.check and
// board.explain): our engine's kicadCheckBoard (engine run 12) runs KiCad's
// design rules check with the board's own severities and answers its findings
// as records; kicadExplainViolation answers the rule behind one mark. The
// drc-small fixture is built to find one clearance against its custom rule
// "Tight", one connection not made, R2 with no symbol and one excluded
// finding with its comment (tests/fixtures/drc-small/SOURCE).
import { expect, test, type Frame, type Page } from '@playwright/test';

const ISLAND = 'http://editor.localhost:4174';
interface Ev { type: string; phase?: string; depth?: number; open?: boolean; caps?: string[]; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Engine { Module: { HEAP8: { length: number } }; FS: { readdir(p: string): string[]; analyzePath(p: string): { exists: boolean } } }
interface Item { uuid: string; kind: string; ref: string; pad: string; net: string; layer: string; parent: string; description: string }
interface Finding { marker: string; type: string; severity: string; excluded: boolean; comment: string; layer: string; x: number; y: number; items: Item[]; rule: { source: string; name: string } | null; actual: number | null; message: string }
interface Result { violations: Finding[]; unconnected: Finding[]; parity: Finding[]; parityRun: string; filled: boolean; skipped: string[]; ignored: string[]; errors: number; warnings: number; excludedCount: number; depth: number; truncated?: true }

/** drc-small's items (tests/fixtures/drc-small/ids.json). */
const R1 = 'cc0d5a11-0000-4000-8000-000000000100';
const R1_PAD1 = 'cc0d5a11-0000-4000-8000-000000000107';
const R2 = 'cc0d5a11-0000-4000-8000-000000000200';
const R2_PAD2 = 'cc0d5a11-0000-4000-8000-000000000208';
const TRACK_PASS = 'cc0d5a11-0000-4000-8000-000000000302';
const STUB = 'cc0d5a11-0000-4000-8000-000000000305';
const DEFAULTS = { fill: true, parity: true, allTrackErrors: false };

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
const timed = (page: Page, op: string, args: unknown): Promise<{ ms: number; result: Record<string, unknown> }> => page.evaluate(async ([o, a]) => {
  const t0 = performance.now();
  const result = await (window as unknown as Harness).__bridge.request(o as string, a);
  return { ms: Math.round(performance.now() - t0), result };
}, [op, args] as const);
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function ready(page: Page, url: string): Promise<Frame | null> {
  await page.goto(url);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  return page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null;
}
const opened = (page: Page, name: string): Promise<void> => expect(page.locator('#state')).toContainText(`opened ${name}`, { timeout: 120_000 });
const heap = (frame: Frame): Promise<number> => frame.evaluate(() => (window as unknown as Engine).Module.HEAP8.length);
const runsLeft = (frame: Frame): Promise<string[] | null> => frame.evaluate(() => {
  const { FS } = window as unknown as Engine;
  return FS.analyzePath('/tmp/cc-drc').exists ? FS.readdir('/tmp/cc-drc').filter((n) => n !== '.' && n !== '..') : null;
});
const unreached = (what: string): void => { test.info().annotations.push({ type: 'unreached', description: `the island frame is out of Playwright's reach in this browser: ${what} not read` }); };
const all = (r: Result): Finding[] => [...r.violations, ...r.unconnected, ...r.parity];

test('board.check on drc-small: the clearance against the custom rule, the connection not made, R2 with no symbol and the excluded stub; board.explain names the rule', async ({ page }) => {
  const frame = await ready(page, '/parent.html?fixture=drc-small&frame=pcb');
  expect((await of(page, 'ev.ready'))[0]?.caps).toEqual(expect.arrayContaining(['drc', 'explain']));
  await opened(page, 'drc-small.kicad_pcb');
  await page.waitForTimeout(1_500);
  const edits0 = (await of(page, 'ev.edited')).length;
  const first = await timed(page, 'board.check', DEFAULTS);
  const r = first.result as unknown as Result;
  measure('board.check, drc-small, the first of the boot', `${first.ms} ms`);
  console.log('[findings]', JSON.stringify(all(r).map((f) => [f.type, f.severity, f.excluded, f.comment, f.items.map((i) => `${i.kind} ${i.ref} ${i.pad}`), f.rule, f.actual, f.message])));

  // The clearance: R1 pad 1 and the VCC track, raised by Tight at 0.15 mm.
  const clearance = r.violations.filter((f) => f.type === 'clearance');
  expect(clearance).toHaveLength(1);
  expect(clearance[0]).toMatchObject({ severity: 'error', excluded: false, layer: 'F.Cu', rule: { source: 'custom', name: 'Tight' } });
  expect(clearance[0].actual).toBeCloseTo(0.15, 4);
  expect(clearance[0].items.map((i) => i.uuid).sort()).toEqual([R1_PAD1, TRACK_PASS].sort());
  expect(clearance[0].items.find((i) => i.uuid === R1_PAD1)).toMatchObject({ kind: 'pad', ref: 'R1', pad: '1', net: 'SIG', parent: R1 });
  expect(clearance[0].items.find((i) => i.uuid === TRACK_PASS)).toMatchObject({ kind: 'track', net: 'VCC', layer: 'F.Cu', parent: '' });
  // The stub's free end, excluded in the project file with its comment.
  const stub = r.violations.filter((f) => f.type === 'track_dangling');
  expect(stub).toHaveLength(1);
  expect(stub[0]).toMatchObject({ severity: 'warning', excluded: true, comment: 'The stub is left for a probe.', items: [{ uuid: STUB, kind: 'track' }] });
  expect(stub[0].x).toBeCloseTo(105.175, 4);
  expect(stub[0].y).toBeCloseTo(113, 4);
  expect(r.violations).toHaveLength(2);
  // The connection not made.
  expect(r.unconnected).toHaveLength(1);
  expect(r.unconnected[0]).toMatchObject({ type: 'unconnected_items', severity: 'error', excluded: false });
  expect(r.unconnected[0].items.map((i) => i.uuid).sort()).toEqual([R1_PAD1, R2_PAD2].sort());
  // R2 is on the board and not on the schematic, and nothing else differs.
  expect(r.parity.map((f) => f.type)).toEqual(['extra_footprint']);
  expect(r.parity[0]).toMatchObject({ severity: 'warning', excluded: false, items: [{ uuid: R2, kind: 'footprint', ref: 'R2' }] });
  expect(r).toMatchObject({ parityRun: 'yes', filled: true, skipped: [], errors: 2, warnings: 1, excludedCount: 1 });
  expect(r.ignored).toEqual(expect.arrayContaining(['lib_footprint_issues', 'lib_footprint_mismatch', 'isolated_copper']));
  expect('truncated' in r).toBe(false);
  // The fill makes one undo step (every time, even with nothing to pour), and one ev.edited at the answer's depth.
  await expect.poll(async () => (await of(page, 'ev.edited')).length, { timeout: 5_000 }).toBe(edits0 + 1);
  expect((await of(page, 'ev.edited')).at(-1)?.depth).toBe(r.depth);
  expect(await of(page, 'ev.menu')).toEqual([]);

  // Why: the custom rule, its condition and the two items' net classes.
  const whys: number[] = [];
  let why: Record<string, unknown> = {};
  for (let i = 0; i < 5; i++) {
    const t = await timed(page, 'board.explain', { marker: clearance[0].marker });
    whys.push(t.ms);
    why = t.result;
  }
  measure('board.explain, the clearance mark', `median ${median(whys)} ms of ${whys.join(', ')} ms`);
  expect(why).toMatchObject({ constraint: 'clearance', unit: 'mm', source: 'custom', name: 'Tight', condition: "A.NetClass == 'Power'" });
  expect(why.min as number).toBeCloseTo(0.25, 4);
  expect(why.items).toEqual(expect.arrayContaining([{ uuid: TRACK_PASS, netclass: 'Power' }]));
  // A mark KiCad does not explain, and a uuid no mark has.
  expect(await refusal(page, 'board.explain', { marker: r.unconnected[0].marker })).toBe(`no_rule: ${r.unconnected[0].marker}`);
  expect(await refusal(page, 'board.explain', { marker: R1 })).toBe(`not_found: ${R1}`);

  // The steady case, and the switches: the fill off, the comparison off, every track error.
  const times: Record<string, number[]> = { 'fill on': [], 'fill off': [], 'no comparison': [], 'every track error': [] };
  for (let i = 0; i < 2; i++) {
    times['fill on'].push((await timed(page, 'board.check', DEFAULTS)).ms);
    const off = await timed(page, 'board.check', { ...DEFAULTS, fill: false });
    times['fill off'].push(off.ms);
    expect((off.result as unknown as Result).filled).toBe(false);
    const noParity = await timed(page, 'board.check', { ...DEFAULTS, parity: false });
    times['no comparison'].push(noParity.ms);
    expect(noParity.result as unknown as Result).toMatchObject({ parityRun: 'off', parity: [] });
    times['every track error'].push((await timed(page, 'board.check', { ...DEFAULTS, allTrackErrors: true })).ms);
  }
  measure('board.check, drc-small, steady', Object.entries(times).map(([k, v]) => `${k} ${v.join(' and ')} ms`).join('; '));
  // A mark gets a new uuid at every check: the last check's marks are the ones explained.
  const last = await request(page, 'board.check', { ...DEFAULTS, fill: false }) as unknown as Result;
  const mark = last.violations.find((f) => f.type === 'clearance')?.marker ?? '';
  expect(await refusal(page, 'board.explain', { marker: mark })).toBe('ok');
  if (frame == null) { unreached('/tmp/cc-drc/'); return; }
  expect(await runsLeft(frame)).toEqual([]);
});

test('board.check: a change sent while it runs answers busy, a read is answered; ten checks leave the engine\'s memory where it was', async ({ page }) => {
  test.setTimeout(240_000);
  const frame = await ready(page, '/parent.html?fixture=drc-small&frame=pcb');
  await opened(page, 'drc-small.kicad_pcb');
  await page.waitForTimeout(1_500);
  const during = await page.evaluate(async ([fp]) => {
    const bridge = (window as unknown as Harness).__bridge;
    const order: string[] = [];
    const checked = bridge.request('board.check', { fill: true, parity: true, allTrackErrors: false }).then(() => { order.push('check'); return 'ok'; }, (e: Error) => e.message);
    await new Promise((r) => setTimeout(r, 30));
    const set = bridge.request('board.item.set', { uuid: fp, set: { locked: true } }).then(() => 'ok', (e: Error) => e.message).then((m) => { order.push('set'); return m; });
    const get = bridge.request('board.item.get', { uuids: [fp] }).then((r) => ((r as { items: Array<{ ref: string }> }).items[0]?.ref ?? ''), (e: Error) => e.message).then((m) => { order.push('get'); return m; });
    const [c, s, g] = await Promise.all([checked, set, get]);
    return { check: c, set: s, get: g, order };
  }, [R1] as const);
  measure('board.check with a set and a get behind it', `answers in the order ${during.order.join(' ')}; the set ${during.set}`);
  expect(during.check).toBe('ok');
  expect(during.get).toBe('R1');
  // The check holds the editor's thread: a set read after its answer goes through.
  if (during.set !== 'ok') expect(during.set).toBe('busy: board.item.set');
  else expect(during.order[0]).toBe('check');
  if (frame == null) { unreached('the engine\'s memory'); return; }
  const before = await heap(frame);
  const ms: number[] = [];
  for (let i = 0; i < 10; i++) ms.push((await timed(page, 'board.check', DEFAULTS)).ms);
  const after = await heap(frame);
  measure('ten board checks of drc-small', `${ms.join(', ')} ms; the engine's memory ${Math.round(before / 2 ** 20)} MB before, ${Math.round(after / 2 ** 20)} MB after`);
  expect(after - before).toBeLessThanOrEqual(16 * 2 ** 20);
});

test('board.check with a rules file that does not compile answers rules_invalid and checks nothing', async ({ page }) => {
  await ready(page, '/parent.html?frame=pcb');
  const answer = await page.evaluate(async () => {
    const get = async (p: string) => new Uint8Array(await (await fetch(p)).arrayBuffer());
    const files = [
      ...await Promise.all(['drc-small.kicad_pro', 'drc-small.kicad_sch', 'drc-small.kicad_pcb'].map(async (path) => ({ path, bytes: await get(`/fixtures/drc-small/${path}`) }))),
      { path: 'drc-small.kicad_dru', bytes: await get('/fixtures/drc-badrules/drc-small.kicad_dru') },
    ];
    const bridge = (window as unknown as Harness).__bridge;
    await bridge.request('project.open', { name: 'drc-small', files });
    await new Promise((r) => setTimeout(r, 1_500));
    return bridge.request('board.check', { fill: false, parity: true, allTrackErrors: false }).then(() => 'ok', (e: Error) => e.message);
  });
  measure('board.check, drc-badrules', answer);
  expect(answer).toMatch(/^rules_invalid: /);
  expect(await of(page, 'ev.menu')).toEqual([]);
});

test('board.check on Glasgow, once: its findings counted, the comparison made, no KiCad window', async ({ page }) => {
  test.setTimeout(300_000);
  const frame = await ready(page, '/parent.html?fixture=glasgow&frame=pcb');
  await opened(page, 'glasgow.kicad_pcb');
  await page.waitForTimeout(1_500);
  const { ms, result } = await timed(page, 'board.check', { fill: false, parity: true, allTrackErrors: false });
  const r = result as unknown as Result;
  measure('board.check, Glasgow, the first of the boot, fill off', `${ms} ms: ${r.violations.length} violations, ${r.unconnected.length} not connected, ${r.parity.length} differing, ${r.errors} errors, ${r.warnings} warnings, ${r.excludedCount} excluded, the comparison ${r.parityRun}`);
  expect(r.parityRun).toBe('yes');
  expect(r.errors + r.warnings + r.excludedCount).toBe(all(r).length);
  expect(await of(page, 'ev.menu')).toEqual([]);
  if (frame == null) { unreached('/tmp/cc-drc/'); return; }
  expect(await runsLeft(frame)).toEqual([]);
});

test('board.check and board.explain in a schematic are unsupported', async ({ page }) => {
  await ready(page, '/parent.html?fixture=drc-small&frame=sch');
  await opened(page, 'drc-small.kicad_sch');
  expect(await refusal(page, 'board.check', DEFAULTS)).toBe('unsupported: a board op runs in a pcb frame');
  expect(await refusal(page, 'board.explain', { marker: R1 })).toBe('unsupported: a board op runs in a pcb frame');
});
