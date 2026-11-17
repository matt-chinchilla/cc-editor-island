// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// island v0.2.3-cc23 over the local pair (PROTOCOL.md sim.*): the simulator.
// KiCad's own NGSPICE class, driven through our engine's run 14 exports, runs
// ngspice 46 in the simulator service's worker, which the island loads only on
// the first run. The two known circuits (tests/fixtures/sim-rc, sim-divider)
// are checked against the references the spec measured with desktop ngspice
// (12.3); then Stop, the progress events' order, a worker that dies mid run,
// and sim.release followed by a run that boots the service again.
import { expect, test, type Frame, type Page } from '@playwright/test';

const ISLAND = 'http://editor.localhost:4174';
interface Ev { type: string; phase?: string; run?: number; percent?: number; code?: string; caps?: string[]; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Plot { name: string; x: string | null; vectors: Array<{ name: string; signal: string; trace: string; complex: boolean; length: number }> }
interface Result { run: number; kind: string; ended: string; depth: number; plots: Plot[]; op: Array<{ signal: string; trace: string; value: number }> | null; console: string[]; problems: unknown[] }
interface Ran { run: number; problems: unknown[]; answerMs: number; endMs: number; end: string; code?: string }

const OPTS = { voltages: true, currents: true, dissipations: false, events: false };

function measure(type: string, description: string): void {
  test.info().annotations.push({ type, description });
  console.log(`[measure] ${type}: ${description}`);
}
const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const sims = async (page: Page, run?: number): Promise<Ev[]> => (await events(page)).filter((e) => e.type === 'ev.sim' && (run == null || e.run === run));
const request = (page: Page, op: string, args?: unknown): Promise<Record<string, unknown>> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const);
const refusal = (page: Page, op: string, args?: unknown): Promise<string> =>
  request(page, op, args).then(() => 'ok', (err: Error) => err.message.split('\n')[0].replace(/^.*?page\.evaluate:\s*/, '').replace(/^Error:\s*/, ''));

async function boot(page: Page, fixture: string): Promise<Frame | null> {
  await page.goto(`/parent.html?fixture=${fixture}&frame=sch`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  await expect(page.locator('#state')).toContainText(`opened ${fixture}.kicad_sch`, { timeout: 120_000 });
  return page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null;
}

/** sim.run from the page, then its one end event: the answer's latency and the end's, both from the request. */
const run = (page: Page, args: unknown, timeout = 120_000): Promise<Ran> => page.evaluate(async ([a, limit]) => {
  const h = window as unknown as Harness;
  const t0 = performance.now();
  const r = await h.__bridge.request('sim.run', a) as { run: number; problems: unknown[] };
  const answerMs = performance.now() - t0;
  for (;;) {
    const end = h.__events.find((e) => e.type === 'ev.sim' && e.run === r.run && ['done', 'stopped', 'failed'].includes(e.phase ?? ''));
    if (end != null) return { run: r.run, problems: r.problems, answerMs: Math.round(answerMs), endMs: Math.round(end.at - t0), end: end.phase as string, ...(end.code != null ? { code: end.code } : {}) };
    if (performance.now() - t0 > (limit as number)) throw new Error(`run ${r.run} did not end`);
    await new Promise((res) => setTimeout(res, 20));
  }
}, [args, timeout] as const);

/** The named vectors of a run, read in the page: plain numbers, and whether each came as a fresh Float64Array. */
const vectors = (page: Page, runN: number, names: string[]) => page.evaluate(async ([n, list]) => {
  const r = await (window as unknown as Harness).__bridge.request('sim.vectors', { run: n, names: list }) as { vectors: Array<{ name: string; real: Float64Array; imag: Float64Array | null }> };
  return r.vectors.map((v) => ({ name: v.name, real: Array.from(v.real), imag: v.imag == null ? null : Array.from(v.imag), typed: v.real instanceof Float64Array && v.real.byteOffset === 0 && v.real.byteLength === v.real.buffer.byteLength }));
}, [runN, names] as const);

/** y at x on the polyline (xs, ys), by linear interpolation. */
function at(xs: number[], ys: number[], x: number): number {
  for (let i = 1; i < xs.length; i++) {
    if (xs[i]! >= x) {
      const t = (x - xs[i - 1]!) / (xs[i]! - xs[i - 1]!);
      return ys[i - 1]! + t * (ys[i]! - ys[i - 1]!);
    }
  }
  return ys.at(-1)!;
}
/** The first x where ys crosses `level` upward, by linear interpolation. */
function crossing(xs: number[], ys: number[], level: number): number {
  for (let i = 1; i < xs.length; i++) {
    if (ys[i - 1]! < level && ys[i]! >= level) return xs[i - 1]! + ((level - ys[i - 1]!) / (ys[i]! - ys[i - 1]!)) * (xs[i]! - xs[i - 1]!);
  }
  return Number.NaN;
}
/** The name of the vector whose signal (KiCad's spelling, V(/out)) matches, as ngspice names it (/out). */
const vectorNamed = (r: Result, re: RegExp): string | undefined => r.plots.flatMap((p) => p.vectors).find((v) => re.test(v.signal))?.name;

test('the RC step: the service loads on the first run, the transient matches the references, and the progress events come in order', async ({ page }) => {
  const frame = await boot(page, 'sim-rc');
  const caps = (await events(page)).find((e) => e.type === 'ev.ready')?.caps ?? [];
  expect(caps).toEqual(expect.arrayContaining(['sim', 'simModel']));
  // No worker before the first run: the service is fetched only when a run asks for it.
  expect(page.workers().some((w) => w.url().startsWith('blob:'))).toBe(false);

  const netlist = await request(page, 'sim.netlist', { analysis: { kind: 'sheet' }, options: OPTS }) as { netlist: string; problems: unknown[]; directive: string };
  expect(netlist.directive).toBe('.tran 1u 5m');
  expect(netlist.problems).toEqual([]);
  expect(netlist.netlist).toMatch(/^V1 /m);
  expect(netlist.netlist).toMatch(/^R1 /m);
  expect(netlist.netlist).toMatch(/^C1 /m);
  measure('sim-rc netlist', netlist.netlist.replace(/\n/g, ' | ').slice(0, 600));

  const cold = await run(page, { analysis: { kind: 'sheet' }, options: OPTS, overrides: [] });
  expect(cold.end).toBe('done');
  measure('first run (the service cold)', `answered ${cold.answerMs} ms, done ${cold.endMs} ms after the request`);
  const evs = await sims(page, cold.run);
  for (const e of evs) expect(Object.keys(e).filter((k) => k !== 'at').sort()).toEqual(['phase', 'run', 'type', ...(e.percent != null ? ['percent'] : []), ...(e.code != null ? ['code'] : [])].sort());
  const phases = evs.map((e) => e.phase);
  // loading (the service's files), then running, then exactly one end; never back.
  const order = { loading: 0, running: 1, done: 2, stopped: 2, failed: 2 } as Record<string, number>;
  for (let i = 1; i < phases.length; i++) expect(order[phases[i]!]!).toBeGreaterThanOrEqual(order[phases[i - 1]!]!);
  expect(phases.filter((p) => p === 'done')).toHaveLength(1);
  expect(phases).toContain('loading');
  expect(phases).toContain('running');
  for (const e of evs) if (e.percent != null) { expect(Number.isInteger(e.percent)).toBe(true); expect(e.percent).toBeGreaterThanOrEqual(0); expect(e.percent).toBeLessThanOrEqual(100); }
  for (let i = 1; i < evs.length; i++) if (evs[i]!.phase === evs[i - 1]!.phase && evs[i]!.phase !== 'done') expect(evs[i]!.at - evs[i - 1]!.at).toBeGreaterThanOrEqual(240);
  measure('first run events', evs.map((e) => `${e.phase}${e.percent != null ? ` ${e.percent}` : ''} @${Math.round(e.at - evs[0]!.at)}`).join(', '));

  const result = await request(page, 'sim.result', { run: cold.run }) as unknown as Result;
  expect(result).toMatchObject({ run: cold.run, kind: 'tran', ended: 'done' });
  const out = vectorNamed(result, /^v\(\/?out\)$/i);
  const x = result.plots[0]?.x;
  expect(out, JSON.stringify(result.plots.map((p) => p.vectors.map((v) => v.name)))).toBeTruthy();
  expect(x).toBe('time');
  const [time, vout] = await vectors(page, cold.run, [x!, out!]);
  expect(time!.typed && vout!.typed).toBe(true);
  expect(vout!.imag).toBeNull();
  const v1 = at(time!.real, vout!.real, 1e-3);
  const v5 = at(time!.real, vout!.real, 5e-3);
  const t63 = crossing(time!.real, vout!.real, 3.1606);
  measure('sim-rc', `v(out) ${v1.toFixed(6)} V at 1 ms, ${v5.toFixed(6)} V at 5 ms, 63.2 percent at ${(t63 * 1e3).toFixed(6)} ms, ${time!.real.length} points`);
  expect(Math.abs(v1 - 3.160602) / 3.160602).toBeLessThan(0.001);
  expect(Math.abs(v5 - 4.966310) / 4.966310).toBeLessThan(0.001);
  expect(Math.abs(t63 - 1e-3) / 1e-3).toBeLessThan(0.01);

  // The service is booted now: a run of the browser's cached service.
  const warm: number[] = [];
  for (let i = 0; i < 5; i++) {
    const r = await run(page, { analysis: { kind: 'tran', step: '1u', stop: '5m' }, options: OPTS, overrides: [] });
    expect(r.end).toBe('done');
    warm.push(r.endMs);
    // Only the latest transient is held.
    expect(await refusal(page, 'sim.result', { run: r.run - 1 })).toMatch(/^no_simulation/);
  }
  warm.sort((a, b) => a - b);
  measure('sim-rc request to done, the service booted', `median ${warm[2]} ms (${warm.join(', ')})`);
  if (frame != null) {
    const left = await frame.evaluate(() => { const FS = (window as unknown as { FS: { analyzePath(p: string): { exists: boolean }; readdir(p: string): string[] } }).FS; return FS.analyzePath('/tmp/cc-sim').exists ? FS.readdir('/tmp/cc-sim').filter((n) => n !== '.' && n !== '..') : []; });
    expect(left).toEqual([]);
  }
});

test('the divider\'s operating point: v(mid) and I(V1) to the references, and the overrides of a tuner', async ({ page }) => {
  await boot(page, 'sim-divider');
  const times: number[] = [];
  let last: Ran | null = null;
  for (let i = 0; i < 5; i++) {
    last = await run(page, { analysis: { kind: 'op' }, options: OPTS, overrides: [] });
    expect(last.end).toBe('done');
    times.push(last.endMs);
  }
  times.sort((a, b) => a - b);
  measure('sim-divider request to done', `median ${times[2]} ms (${times.join(', ')}), the first boots the service`);
  const result = await request(page, 'sim.result', { run: last!.run }) as unknown as Result;
  expect(result.kind).toBe('op');
  measure('sim-divider op', JSON.stringify(result.op));
  const mid = result.op?.find((o) => o.trace === 'voltage' && /^v\(\/?mid\)$/i.test(o.signal));
  const iv1 = result.op?.find((o) => o.trace === 'current' && /^i\(v1\)$/i.test(o.signal));
  expect(mid, JSON.stringify(result.op)).toBeTruthy();
  expect(iv1, JSON.stringify(result.op)).toBeTruthy();
  expect(Math.abs(mid!.value - 3.836735) / 3.836735).toBeLessThan(1e-6);
  expect(Math.abs(iv1!.value - -0.816327e-3) / 0.816327e-3).toBeLessThan(1e-6);
  // KiCad's own operating point labels on the drawing, on and off: no edit.
  expect(await request(page, 'sim.opOnSheet', { voltages: true, currents: true })).toEqual({});
  expect(await request(page, 'sim.opOnSheet', { voltages: false, currents: false })).toEqual({});
  // A tuner: R2 at 10k makes the divider a half.
  const tuned = await run(page, { analysis: { kind: 'op' }, options: OPTS, overrides: [{ ref: 'R2', value: '10k' }] });
  expect(tuned.end).toBe('done');
  const half = (await request(page, 'sim.result', { run: tuned.run }) as unknown as Result).op?.find((o) => o.trace === 'voltage' && /^v\(\/?mid\)$/i.test(o.signal));
  expect(Math.abs(half!.value - 6) / 6).toBeLessThan(1e-6);
  // A net the netlist does not hold is refused before the engine is asked.
  expect(await refusal(page, 'sim.run', { analysis: { kind: 'dc', source: 'V9', start: '0', stop: '12', step: '1' }, options: OPTS, overrides: [] })).toMatch(/^bad_args/);
  const sweep = await run(page, { analysis: { kind: 'dc', source: 'V1', start: '0', stop: '12', step: '1' }, options: OPTS, overrides: [] });
  expect(sweep.end).toBe('done');
  const swept = await request(page, 'sim.result', { run: sweep.run }) as unknown as Result;
  expect(swept.kind).toBe('dc');
  const sx = swept.plots[0]!.x!;
  const smid = vectorNamed(swept, /^v\(\/?mid\)$/i)!;
  const [xs, ys] = await vectors(page, sweep.run, [sx, smid]);
  expect(xs!.real).toHaveLength(13);
  expect(Math.abs(at(xs!.real, ys!.real, 12) - 3.836735)).toBeLessThan(1e-5);
});

test('Stop 200 ms into a long transient ends it stopped within 500 ms; the next run is done', async ({ page }) => {
  await boot(page, 'sim-rc');
  expect((await run(page, { analysis: { kind: 'op' }, options: OPTS, overrides: [] })).end).toBe('done');   // the service booted
  const r = await request(page, 'sim.run', { analysis: { kind: 'tran', step: '1u', stop: '20' }, options: OPTS, overrides: [] }) as { run: number };
  await page.waitForTimeout(200);
  const stopped = await page.evaluate(async (n) => {
    const h = window as unknown as Harness;
    const t0 = performance.now();
    await h.__bridge.request('sim.stop');
    const answered = performance.now() - t0;
    for (;;) {
      const end = h.__events.find((e) => e.type === 'ev.sim' && e.run === n && ['done', 'stopped', 'failed'].includes(e.phase ?? ''));
      if (end != null) return { answered: Math.round(answered), end: end.phase, ms: Math.round(end.at - t0) };
      if (performance.now() - t0 > 30_000) return { answered: Math.round(answered), end: 'none', ms: -1 };
      await new Promise((res) => setTimeout(res, 10));
    }
  }, r.run);
  measure('Stop', `answered ${stopped.answered} ms, ${stopped.end} ${stopped.ms} ms after the press`);
  expect(stopped.end).toBe('stopped');
  expect(stopped.ms).toBeLessThan(500);
  const progress = (await sims(page, r.run)).filter((e) => e.phase === 'running' && e.percent != null);
  measure('running events of the long transient', progress.map((e) => e.percent).join(', '));
  expect((await run(page, { analysis: { kind: 'tran', step: '1u', stop: '5m' }, options: OPTS, overrides: [] })).end).toBe('done');
});

test('a worker that dies mid run ends it service_failed, and the next run boots a fresh one and is done', async ({ page, browserName }) => {
  await boot(page, 'sim-rc');
  expect((await run(page, { analysis: { kind: 'op' }, options: OPTS, overrides: [] })).end).toBe('done');
  const worker = page.workers().find((w) => w.url().startsWith('blob:'));
  test.skip(worker == null, `${browserName}: the island frame's workers are out of Playwright's reach`);
  const r = await request(page, 'sim.run', { analysis: { kind: 'tran', step: '1u', stop: '20' }, options: OPTS, overrides: [] }) as { run: number };
  await page.waitForTimeout(200);
  // An uncaught error in the worker: the provider retires it as a dead worker.
  await worker!.evaluate(() => { setTimeout(() => { throw new Error('the test ends this worker'); }, 0); });
  await expect.poll(async () => (await sims(page, r.run)).find((e) => ['done', 'stopped', 'failed'].includes(e.phase ?? '')), { timeout: 30_000 }).toMatchObject({ phase: 'failed', code: 'service_failed' });
  const again = await run(page, { analysis: { kind: 'tran', step: '1u', stop: '5m' }, options: OPTS, overrides: [] });
  expect(again.end).toBe('done');
  measure('the run after the death', `done ${again.endMs} ms after the request (a fresh worker)`);
});

test('sim.release ends the service when no run is live, and the next run boots it again', async ({ page }) => {
  await boot(page, 'sim-rc');
  const first = await run(page, { analysis: { kind: 'op' }, options: OPTS, overrides: [] });
  expect(first.end).toBe('done');
  expect(await request(page, 'sim.release')).toEqual({});
  // The released service's vectors are gone.
  expect(await refusal(page, 'sim.vectors', { run: first.run, names: ['v(in)'] })).toMatch(/^(no_simulation|bad_args)/);
  const second = await run(page, { analysis: { kind: 'op' }, options: OPTS, overrides: [] });
  expect(second.end).toBe('done');
  expect((await sims(page, second.run)).map((e) => e.phase)).toContain('loading');
  measure('the run after a release', `done ${second.endMs} ms after the request (loaded again, from the browser's cache)`);
  // A release while a run is live is refused.
  const live = await request(page, 'sim.run', { analysis: { kind: 'tran', step: '1u', stop: '20' }, options: OPTS, overrides: [] }) as { run: number };
  expect(await refusal(page, 'sim.release')).toMatch(/^busy/);
  expect(await refusal(page, 'sim.run', { analysis: { kind: 'op' }, options: OPTS, overrides: [] })).toMatch(/^busy/);
  expect(await request(page, 'sim.stop')).toEqual({});
  await expect.poll(async () => (await sims(page, live.run)).at(-1)?.phase, { timeout: 10_000 }).toBe('stopped');
});
