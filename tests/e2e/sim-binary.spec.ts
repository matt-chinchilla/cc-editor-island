// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// si1-i over the local pair (PROTOCOL.md sim.netlist and sim.run, the compiled
// model notes): the island's sim-binary fixture (the RC step with a raw SPICE
// part whose library is models/adder.cm and a pre_osdi control line) lists two
// binary_model problems in sim.netlist, sim.run answers circuit with them and
// runs nothing (no ev.sim at all), and sim-rc still runs to its end. Nothing
// here needs an engine export of run 15: it runs on engine run 14.
import { expect, test, type Page } from '@playwright/test';

interface Ev { type: string; phase?: string; run?: number; code?: string; caps?: string[]; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Problem { code: string; severity: string; ref?: string; path?: string; text: string }

const OPTS = { voltages: true, currents: true, dissipations: false, events: false };
const SHEET = { analysis: { kind: 'sheet' }, options: OPTS };

const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const request = (page: Page, op: string, args?: unknown): Promise<Record<string, unknown>> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const);
const refusal = (page: Page, op: string, args?: unknown): Promise<string> =>
  request(page, op, args).then(() => 'ok', (err: Error) => err.message.split('\n')[0].replace(/^.*?page\.evaluate:\s*/, '').replace(/^Error:\s*/, ''));

async function boot(page: Page, fixture: string): Promise<void> {
  await page.goto(`/parent.html?fixture=${fixture}&frame=sch`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  await expect(page.locator('#state')).toContainText(`opened ${fixture}.kicad_sch`, { timeout: 120_000 });
}

test('a compiled model: sim.netlist lists two binary_model problems, sim.run answers circuit and runs nothing', async ({ page }) => {
  test.setTimeout(300_000);
  await boot(page, 'sim-binary');
  const caps = (await events(page)).find((e) => e.type === 'ev.ready')?.caps ?? [];
  expect(caps).toEqual(expect.arrayContaining(['sim']));

  const netlist = await request(page, 'sim.netlist', SHEET) as { netlist: string; problems: Problem[]; directive: string };
  console.log(`[measure] netlist:\n${netlist.netlist}`);
  console.log(`[measure] problems: ${JSON.stringify(netlist.problems)}`);
  const binary = netlist.problems.filter((p) => p.code === 'binary_model');
  expect(binary).toHaveLength(2);
  expect(binary.every((p) => p.severity === 'error')).toBe(true);
  expect(binary.map((p) => p.path).sort()).toEqual(['models/adder.cm', 'models/adder.osdi']);
  expect(binary.find((p) => p.path === 'models/adder.osdi')?.text).toBe('pre_osdi models/adder.osdi');

  const t0 = Date.now();
  const refused = await refusal(page, 'sim.run', { ...SHEET, overrides: [] });
  const first = netlist.problems.find((p) => p.code === 'binary_model')!;
  expect(refused).toBe(`circuit: ${first.text}`);
  console.log(`[measure] sim.run refused in ${Date.now() - t0} ms: ${refused}`);
  // Nothing ran: no run was numbered, so no ev.sim of any phase, and no service worker was fetched.
  await page.waitForTimeout(1_000);
  expect((await events(page)).filter((e) => e.type === 'ev.sim')).toEqual([]);
  expect(page.workers().some((w) => w.url().startsWith('blob:'))).toBe(false);
});

test('a circuit with no compiled model still runs: sim-rc to its end', async ({ page }) => {
  test.setTimeout(300_000);
  await boot(page, 'sim-rc');
  const netlist = await request(page, 'sim.netlist', SHEET) as { problems: Problem[] };
  expect(netlist.problems).toEqual([]);
  const r = await request(page, 'sim.run', { ...SHEET, overrides: [] }) as { run: number };
  expect(r.run).toBe(1);
  await page.waitForFunction((n) => (window as unknown as Harness).__events.some((e) => e.type === 'ev.sim' && e.run === n && ['done', 'stopped', 'failed'].includes(e.phase ?? '')), r.run, { timeout: 120_000 });
  const end = (await events(page)).find((e) => e.type === 'ev.sim' && e.run === r.run && ['done', 'stopped', 'failed'].includes(e.phase ?? ''));
  expect(end?.phase).toBe('done');
});
