// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// m11-i over the local pair (PROTOCOL.md sim.userSignals). On engine run 14
// the sch frame lists no simUserSignals and the op answers unsupported naming
// kicadSimUserSignals; bad args are refused first on any engine. On engine
// run 15 (cc25), over tests/fixtures/sim-rc: a transient, then
// sim.userSignals [V(/out)-V(/in)] answers one vector, and sim.vectors' user0
// at 1 ms equals v(out) minus v(in) read from sim.vectors within 1e-9; an
// expression holding a semicolon, a line break, a quote or a brace answers
// bad_args and nothing reaches ngspice (user0 still reads as before); a run
// superseded by a newer transient answers no_simulation.
import { expect, test, type Page } from '@playwright/test';

const RUN15 = 'waits for engine run 15 (unit m11-e: kicadSimUserSignals)';
const OPTS = { voltages: true, currents: true, dissipations: false, events: false };
const TRAN = { analysis: { kind: 'tran', step: '1u', stop: '5m' }, options: OPTS, overrides: [] };

interface Ev { type: string; phase?: string; run?: number; caps?: string[]; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Plot { name: string; x: string | null; vectors: Array<{ name: string; signal: string; trace: string; complex: boolean; length: number }> }
interface Result { run: number; kind: string; ended: string; plots: Plot[] }
interface UserSignals { vectors: Array<{ name: string; signal: string; trace: string; complex: boolean; length: number }>; errors: Array<{ index: number; line: string }> }

function measure(type: string, description: string): void {
  test.info().annotations.push({ type, description });
  console.log(`[measure] ${type}: ${description}`);
}
const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const request = (page: Page, op: string, args?: unknown): Promise<Record<string, unknown>> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const);
const refusal = (page: Page, op: string, args?: unknown): Promise<string> =>
  request(page, op, args).then(() => 'ok', (err: Error) => err.message.split('\n')[0].replace(/^.*?page\.evaluate:\s*/, '').replace(/^Error:\s*/, ''));

async function boot(page: Page): Promise<string[]> {
  await page.goto('/parent.html?fixture=sim-rc&frame=sch');
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  await expect(page.locator('#state')).toContainText('opened sim-rc.kicad_sch', { timeout: 120_000 });
  return (await events(page)).find((e) => e.type === 'ev.ready')?.caps ?? [];
}

/** sim.run, then its one end event. */
const run = (page: Page, args: unknown): Promise<{ run: number; end: string }> => page.evaluate(async (a) => {
  const h = window as unknown as Harness;
  const r = await h.__bridge.request('sim.run', a) as { run: number };
  const t0 = performance.now();
  for (;;) {
    const end = h.__events.find((e) => e.type === 'ev.sim' && e.run === r.run && ['done', 'stopped', 'failed'].includes(e.phase ?? ''));
    if (end != null) return { run: r.run, end: end.phase as string };
    if (performance.now() - t0 > 120_000) throw new Error(`run ${r.run} did not end`);
    await new Promise((res) => setTimeout(res, 20));
  }
}, args);

/** The named vectors of a run as plain numbers. */
const vectors = (page: Page, runN: number, names: string[]) => page.evaluate(async ([n, list]) => {
  const r = await (window as unknown as Harness).__bridge.request('sim.vectors', { run: n, names: list }) as { vectors: Array<{ name: string; real: Float64Array; imag: Float64Array | null }> };
  return r.vectors.map((v) => ({ name: v.name, real: Array.from(v.real), imag: v.imag == null ? null : Array.from(v.imag) }));
}, [runN, names] as const);

const BAD = ['V(/out);quit', 'V(/out)\nquit', '"V(/out)"', "V('/out')", '{V(/out)}', 'V(/out)\\', '`V(/out)`'];

test('run 14 or 15: simUserSignals follows the engine; bad args first, and without the export the op answers unsupported naming kicadSimUserSignals', async ({ page }) => {
  const caps = await boot(page);
  for (const bad of BAD) expect(await refusal(page, 'sim.userSignals', { run: 1, signals: [bad] }), JSON.stringify(bad)).toBe('bad_args: sim.userSignals');
  expect(await refusal(page, 'sim.userSignals', { run: 1, signals: Array.from({ length: 17 }, (_, i) => `V(/n${i})`) })).toBe('bad_args: sim.userSignals');
  expect(await refusal(page, 'sim.userSignals', { run: 1, signals: ['V(/out)'], plot: 'tran1' })).toBe('bad_args: sim.userSignals');
  if (!caps.includes('simUserSignals')) {
    expect(await refusal(page, 'sim.userSignals', { run: 1, signals: ['V(/out)-V(/in)'] })).toBe('unsupported: kicadSimUserSignals');
    measure('engine', 'kicadSimUserSignals absent: the run 14 half');
  }
});

test('run 15: V(/out)-V(/in) over the RC transient equals v(out) minus v(in) at 1 ms; bad expressions reach nothing; a superseded run answers no_simulation', async ({ page }) => {
  test.setTimeout(300_000);
  const caps = await boot(page);
  test.skip(!caps.includes('simUserSignals'), RUN15);

  const first = await run(page, TRAN);
  expect(first.end).toBe('done');
  const result = await request(page, 'sim.result', { run: first.run }) as unknown as Result;
  const plot = result.plots.find((p) => p.vectors.some((v) => /^V\(\/?out\)$/i.test(v.signal)))!;
  const out = plot.vectors.find((v) => /^V\(\/?out\)$/i.test(v.signal))!.name;
  const inn = plot.vectors.find((v) => /^V\(\/?in\)$/i.test(v.signal))!.name;
  const time = plot.x!;

  const t0 = Date.now();
  const made = await request(page, 'sim.userSignals', { run: first.run, signals: ['V(/out)-V(/in)'] }) as unknown as UserSignals;
  measure('sim.userSignals', `answered in ${Date.now() - t0} ms: ${JSON.stringify(made)}`);
  expect(made.errors).toEqual([]);
  expect(made.vectors).toEqual([{ name: 'user0', signal: 'V(/out)-V(/in)', trace: 'other', complex: false, length: plot.vectors.find((v) => v.name === out)!.length }]);

  const [user, xs, vo, vi] = await vectors(page, first.run, ['user0', time, out, inn]);
  expect(user!.name).toBe('user0');
  const i = xs!.real.findIndex((x) => x >= 1e-3);
  expect(i).toBeGreaterThan(0);
  expect(Math.abs(user!.real[i]! - (vo!.real[i]! - vi!.real[i]!))).toBeLessThanOrEqual(1e-9);
  // Every sample, not only the one at 1 ms.
  for (let k = 0; k < user!.real.length; k++) expect(Math.abs(user!.real[k]! - (vo!.real[k]! - vi!.real[k]!))).toBeLessThanOrEqual(1e-9);
  measure('user0 at 1 ms', `t ${xs!.real[i]}, user0 ${user!.real[i]}, v(out) - v(in) ${vo!.real[i]! - vi!.real[i]!}`);

  // A refused expression: bad_args, and nothing reached ngspice (user0 reads as before, no user1).
  for (const bad of BAD) expect(await refusal(page, 'sim.userSignals', { run: first.run, signals: ['V(/in)', bad] })).toBe('bad_args: sim.userSignals');
  const [again] = await vectors(page, first.run, ['user0']);
  expect(again!.real).toEqual(user!.real);
  expect(await refusal(page, 'sim.vectors', { run: first.run, names: ['user1'] })).toMatch(/^bad_args/);

  // ngspice refuses an expression over a net that does not exist: its line, no vector.
  const refused = await request(page, 'sim.userSignals', { run: first.run, signals: ['V(/out)', 'V(/nosuchnet)'] }) as unknown as UserSignals;
  measure('refused expression', JSON.stringify(refused.errors));
  expect(refused.vectors.map((v) => v.name)).toEqual(['user0']);
  expect(refused.errors.map((e) => e.index)).toEqual([1]);
  expect(refused.errors[0]!.line.length).toBeGreaterThan(0);

  // A newer transient replaces the first: its signals answer no_simulation.
  const second = await run(page, TRAN);
  expect(second.end).toBe('done');
  expect(await refusal(page, 'sim.userSignals', { run: first.run, signals: ['V(/out)-V(/in)'] })).toMatch(/^no_simulation/);
  expect(await refusal(page, 'sim.vectors', { run: first.run, names: ['user0'] })).toMatch(/^no_simulation/);
  const later = await request(page, 'sim.userSignals', { run: second.run, signals: ['V(/out)*2'] }) as unknown as UserSignals;
  expect(later.vectors.map((v) => v.name)).toEqual(['user0']);
});
