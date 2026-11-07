// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// island v0.2.3-cc15 over the local pair (PROTOCOL.md): sheet.check runs
// KiCad's electrical rules check with no KiCad dialog through our engine's
// kicadCheckSheet (pcbjam cc/main e8b2abe; engine run 10) and answers KiCad's
// own report read into sheets and findings. Nothing in the document changes:
// no undo step and no ev.edited. The unnumbered fixture's resistors are not
// wired, so each pin is unconnected; Glasgow is one design of four sheets.
import { expect, test, type Frame, type Page } from '@playwright/test';

const ISLAND = 'http://editor.localhost:4174';
interface Ev { type: string; phase?: string; depth?: number; caps?: string[]; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Engine { Module: { kicadCollabTestUndoDepth(): number }; FS: { readdir(p: string): string[]; analyzePath(p: string): { exists: boolean } } }
interface Item { uuid: string; description: string }
interface Violation { type: string; severity: 'error' | 'warning'; items: Item[] }
interface Report { sheets: Array<{ path: string; name: string; violations: Violation[] }>; errors: number; warnings: number; truncated?: true }

const U1 = '00000000-0000-0000-0000-00005aca0321';

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
const check = (page: Page): Promise<{ ms: number; report: Report }> => page.evaluate(async () => {
  const t0 = performance.now();
  const report = await (window as unknown as Harness).__bridge.request('sheet.check', {}) as unknown as Report;
  return { ms: Math.round(performance.now() - t0), report };
});
const listed = (r: Report): Violation[] => r.sheets.flatMap((s) => s.violations);

async function ready(page: Page, url: string): Promise<Frame | null> {
  await page.goto(url);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  return page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null;
}
const undoDepth = (frame: Frame): Promise<number> => frame.evaluate(() => Number((window as unknown as Engine).Module.kicadCollabTestUndoDepth()));
const runsLeft = (frame: Frame): Promise<string[] | null> => frame.evaluate(() => {
  const { FS } = window as unknown as Engine;
  return FS.analyzePath('/tmp/cc-erc').exists ? FS.readdir('/tmp/cc-erc').filter((n) => n !== '.' && n !== '..') : null;
});
const unreached = (): void => { test.info().annotations.push({ type: 'unreached', description: 'the island frame is out of Playwright\'s reach in this browser: the undo depth and /tmp/cc-erc/ were not read' }); };

test('sheet.check on the unnumbered fixture: every resistor pin unconnected, named in KiCad\'s words; nothing in the document changed', async ({ page }) => {
  const frame = await ready(page, '/parent.html?frame=sch');
  expect((await of(page, 'ev.ready'))[0]?.caps).toContain('check');
  expect(await page.evaluate(async () => {
    const files = await Promise.all(['unnumbered.kicad_pro', 'unnumbered.kicad_sch'].map(async (path) => ({ path, bytes: new Uint8Array(await (await fetch(`/fixtures/unnumbered/${path}`)).arrayBuffer()) })));
    return (window as unknown as Harness).__bridge.request('project.open', { name: 'unnumbered', files });
  })).toMatchObject({ opened: 'unnumbered.kicad_sch' });
  await page.waitForTimeout(1_500);
  const depth0 = frame == null ? null : await undoDepth(frame);
  const edits0 = (await of(page, 'ev.edited')).length;
  const { ms, report } = await check(page);
  measure('sheet.check, the unnumbered fixture', `${ms} ms, ${report.errors} errors, ${report.warnings} warnings`);
  expect(report.sheets.map((s) => [s.path, s.name])).toEqual([['/', '/']]);
  const all = listed(report);
  expect(report.errors).toBe(all.filter((v) => v.severity === 'error').length);
  expect(report.warnings).toBe(all.filter((v) => v.severity === 'warning').length);
  expect('truncated' in report).toBe(false);
  const unconnected = all.filter((v) => v.type === 'pin_not_connected');
  measure('sheet.check, the unnumbered fixture types', [...new Set(all.map((v) => v.type))].join(' '));
  expect(unconnected).toHaveLength(6);
  for (const v of unconnected) {
    expect(v.severity).toBe('error');
    expect(v.items).toHaveLength(1);
    expect(v.items[0].description).toMatch(/^Symbol R[1?] Pin [12] \[Passive, Line\]$/);
  }
  await page.waitForTimeout(2_000);
  expect((await of(page, 'ev.edited')).length).toBe(edits0);
  if (frame == null) { unreached(); return; }
  expect(await undoDepth(frame)).toBe(depth0);
  expect(await runsLeft(frame)).toEqual([]);
});

test('sheet.check on Glasgow: the four sheets in sheet.tree\'s paths; a change sent while it runs is refused busy or read once it has answered, never in its middle', async ({ page }) => {
  test.setTimeout(300_000);
  const frame = await ready(page, '/parent.html?fixture=glasgow&frame=sch');
  await expect(page.locator('#state')).toContainText('opened glasgow.kicad_sch', { timeout: 120_000 });
  await page.waitForTimeout(1_500);
  const depth0 = frame == null ? null : await undoDepth(frame);
  const edits0 = (await of(page, 'ev.edited')).length;
  const tree = await request(page, 'sheet.tree') as { sheets: Array<{ path: string }> };
  // The check, and behind it a change and a read sent while it runs.
  const during = await page.evaluate(async () => {
    const bridge = (window as unknown as Harness).__bridge;
    const order: string[] = [];
    const t0 = performance.now();
    const checked = bridge.request('sheet.check', {}).then((r) => { order.push('check'); return { ms: Math.round(performance.now() - t0), report: r }; });
    await new Promise((r) => setTimeout(r, 300));
    const set = bridge.request('symbol.set', { uuid: '00000000-0000-0000-0000-00005aca0321', sheetPath: '/', set: { value: 'x' } })
      .then(() => 'ok', (e: Error) => e.message).then((m) => { order.push('set'); return m; });
    const get = bridge.request('symbol.get', { uuid: '00000000-0000-0000-0000-00005aca0321' })
      .then((r) => (r as { ref: string }).ref, (e: Error) => e.message).then((m) => { order.push('get'); return m; });
    const [c, s, g] = await Promise.all([checked, set, get]);
    return { check: c, set: s, get: g, order };
  });
  const report = during.check.report as unknown as Report;
  measure('sheet.check, Glasgow', `${during.check.ms} ms, ${report.errors} errors, ${report.warnings} warnings, answers in the order ${during.order.join(' ')}`);
  // KiCad's check holds the editor's thread for its run, so what the host sends
  // meanwhile is read once it ends: refused busy while the check is still being
  // collected, else answered after the check's own answer.
  const setOk = during.set === 'ok';
  if (!setOk) expect(during.set).toBe('busy: symbol.set');
  else expect(during.order[0]).toBe('check');
  expect(during.get).toBe('U1');
  expect(report.sheets.map((s) => s.path)).toEqual(tree.sheets.map((s) => s.path));
  expect(report.sheets.map((s) => s.name)).toEqual(['/', '/IO_Banks/', '/IO_Banks/IO_Buffer_A/', '/IO_Banks/IO_Buffer_B/']);
  expect(report.errors).toBeGreaterThan(0);
  expect(report.warnings).toBeGreaterThan(0);
  expect(report.errors + report.warnings).toBe(listed(report).length);
  // Every item in KiCad 10's own words, a symbol's designator first.
  expect(listed(report).flatMap((v) => v.items).some((i) => /^Symbol U1 Pin \S+ \[/.test(i.description))).toBe(true);
  await page.waitForTimeout(2_000);
  expect((await of(page, 'ev.edited')).length).toBe(edits0 + (setOk ? 1 : 0));
  // After the answer the document takes changes again.
  expect(await refusal(page, 'symbol.set', { uuid: U1, sheetPath: '/', set: { value: 'CY7C68013A-56LTX' } })).toBe('ok');
  if (frame == null) { unreached(); return; }
  expect(await undoDepth(frame)).toBe((depth0 ?? 0) + (setOk ? 2 : 1));
  expect(await runsLeft(frame)).toEqual([]);
});

test('sheet.check in a board is unsupported', async ({ page }) => {
  await ready(page, '/parent.html?fixture=glasgow&frame=pcb');
  expect(await refusal(page, 'sheet.check', {})).toBe('unsupported: a schematic edits in a sch frame');
});
