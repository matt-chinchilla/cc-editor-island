// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The simulator's faults (wave 2 E2, ledger SI1 to SI3), on the local pair.
// Engine run 15 (island cc25) cases: Glasgow's model-less parts answered as
// no_model problems naming them; a missing model file a file_missing problem
// with no KiCad box, the next op answered at once; a resistance KiCad cannot
// read as a number refused, the old value kept; a subcircuit's pins listed.
// Island cases, on any engine with the simulator: a Stop that the service
// cannot answer still ends the run stopped within a second (SI1); runs back to
// back each end once with their own number (SI3's run guard); pole-zero and
// S-parameters give a real result (SI3, measured here for the first time).
import { expect, test, type Page } from '@playwright/test';

interface Ev { type: string; phase?: string; run?: number; percent?: number; code?: string; caps?: string[]; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Problem { code: string; severity: string; ref?: string; path?: string; text: string }
interface Plot { name: string; x: string | null; vectors: Array<{ name: string; signal: string; trace: string; complex: boolean; length: number }> }
interface Result { run: number; kind: string; ended: string; plots: Plot[]; problems: Problem[] }
interface ModelSheet { ref: string; source: string; type: string; file: { path: string; model: string } | null; pins: Array<{ symbolPin: string; modelPin: string }>; params: Array<{ name: string; value: string }>; problems: Problem[] }
interface Ran { run: number; end: string; code?: string; endMs: number }

const OPTS = { voltages: true, currents: true, dissipations: false, events: false };
/** The fixtures' symbols (their uuids as the files write them). */
const DIVIDER_R1 = 'a1c0de00-0000-4000-8002-000000000200';
const MODELS_R2 = 'a1c0de00-0000-4000-8003-000000000300';
const SPARAM_PORTS = 2;

function measure(type: string, description: string): void {
  test.info().annotations.push({ type, description });
  console.log(`[measure] ${type}: ${description}`);
}
const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const sims = async (page: Page, run: number): Promise<Ev[]> => (await events(page)).filter((e) => e.type === 'ev.sim' && e.run === run);
const request = (page: Page, op: string, args?: unknown): Promise<Record<string, unknown>> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const);
const refusal = (page: Page, op: string, args?: unknown): Promise<string> =>
  request(page, op, args).then(() => 'ok', (err: Error) => err.message.split('\n')[0]!.replace(/^.*?page\.evaluate:\s*/, '').replace(/^Error:\s*/, ''));

async function boot(page: Page, fixture: string): Promise<void> {
  await page.goto(`/parent.html?fixture=${fixture}&frame=sch`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  await expect(page.locator('#state')).toContainText(`opened ${fixture}.kicad_sch`, { timeout: 120_000 });
  const caps = (await events(page)).find((e) => e.type === 'ev.ready')?.caps ?? [];
  expect(caps).toEqual(expect.arrayContaining(['sim', 'simModel']));
}

/** sim.run, then its one end event: the end's phase and code, and its time from the request. */
const run = (page: Page, args: unknown, timeout = 120_000): Promise<Ran> => page.evaluate(async ([a, limit]) => {
  const h = window as unknown as Harness;
  const t0 = performance.now();
  const r = await h.__bridge.request('sim.run', a) as { run: number };
  for (;;) {
    const end = h.__events.find((e) => e.type === 'ev.sim' && e.run === r.run && ['done', 'stopped', 'failed'].includes(e.phase ?? ''));
    if (end != null) return { run: r.run, end: end.phase as string, endMs: Math.round(end.at - t0), ...(end.code != null ? { code: end.code } : {}) };
    if (performance.now() - t0 > (limit as number)) throw new Error(`run ${r.run} did not end`);
    await new Promise((res) => setTimeout(res, 20));
  }
}, [args, timeout] as const);

const vectors = (page: Page, n: number, names: string[]) => page.evaluate(async ([runN, list]) => {
  const r = await (window as unknown as Harness).__bridge.request('sim.vectors', { run: runN, names: list }) as { vectors: Array<{ name: string; real: Float64Array; imag: Float64Array | null }> };
  return r.vectors.map((v) => ({ name: v.name, real: Array.from(v.real), imag: v.imag == null ? null : Array.from(v.imag) }));
}, [n, names] as const);

// ---------------------------------------------------------------- engine run 15 (cc25)

test('run 15: Glasgow\'s netlist names each part with no simulation model, U1 among them, as no_model', async ({ page }) => {
  await boot(page, 'glasgow');
  const netlist = await request(page, 'sim.netlist', { analysis: { kind: 'op' }, options: OPTS }) as { problems: Problem[] };
  const noModel = netlist.problems.filter((p) => p.code === 'no_model');
  measure('Glasgow no_model', `${noModel.length} parts: ${noModel.slice(0, 12).map((p) => p.ref).join(', ')}`);
  expect(noModel.map((p) => p.ref)).toContain('U1');
});

test('run 15: a model file the project does not hold is a file_missing problem, no KiCad box, and the next op is answered within 2 s', async ({ page }) => {
  await boot(page, 'sim-missing-lib');
  const netlist = await request(page, 'sim.netlist', { analysis: { kind: 'op' }, options: OPTS }) as { problems: Problem[] };
  measure('sim-missing-lib problems', JSON.stringify(netlist.problems.map((p) => ({ code: p.code, ref: p.ref, path: p.path }))));
  expect(netlist.problems).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'file_missing', ref: 'R1' })]));
  // No KiCad box was left up: the next op that needs a free editor is answered, not busy, within 2 s.
  const t0 = Date.now();
  const again = await request(page, 'sim.netlist', { analysis: { kind: 'op' }, options: OPTS }) as { problems: Problem[] };
  measure('the next op', `answered in ${Date.now() - t0} ms`);
  expect(Date.now() - t0).toBeLessThan(2000);
  expect(again.problems.map((p) => p.code)).toContain('file_missing');
});

test('run 15: a resistance KiCad cannot read as a number is refused and the old value is read back', async ({ page }) => {
  await boot(page, 'sim-divider');
  const before = await request(page, 'sim.model.get', { uuid: DIVIDER_R1, sheetPath: '/' }) as unknown as ModelSheet;
  const why = await refusal(page, 'sim.model.set', { uuid: DIVIDER_R1, sheetPath: '/', model: { source: 'builtin', type: 'R', params: { r: 'abc' }, pins: [] } });
  expect(why).toMatch(/^model_invalid/);
  const after = await request(page, 'sim.model.get', { uuid: DIVIDER_R1, sheetPath: '/' }) as unknown as ModelSheet;
  expect(after).toEqual(before);
  measure('R1 after a refused set', `${after.source} ${after.type} r=${after.params.find((p) => p.name === 'r')?.value}`);
});

test('run 15: a subcircuit model lists its pins', async ({ page }) => {
  await boot(page, 'sim-models');
  const lib = await request(page, 'sim.file', { path: 'models/bjt.lib' }) as { models: Array<{ name: string; kind: string; pins: string[] }> };
  expect(lib.models.find((m) => m.name.toUpperCase() === 'AMP10')?.pins.map((p) => p.toLowerCase())).toEqual(['in', 'out']);
  const set = await request(page, 'sim.model.set', { uuid: MODELS_R2, sheetPath: '/', model: { source: 'file', path: 'models/bjt.lib', model: 'AMP10', params: {}, pins: [] } }) as unknown as ModelSheet;
  expect(set).toMatchObject({ source: 'file', file: { path: 'models/bjt.lib', model: 'AMP10' } });
  const got = await request(page, 'sim.model.get', { uuid: MODELS_R2, sheetPath: '/' }) as unknown as ModelSheet;
  measure('AMP10 on R2', JSON.stringify(got.pins));
  expect(got.pins.map((p) => p.modelPin.toLowerCase()).sort()).toEqual(['in', 'out']);
});

test('run 15: a transient past the service\'s memory, stopped about 6 percent in, ends stopped or failed, never done', async ({ page }) => {
  test.setTimeout(240_000);
  await boot(page, 'sim-rc');
  const r = await request(page, 'sim.run', { analysis: { kind: 'tran', step: '1n', stop: '2' }, options: OPTS, overrides: [] }) as { run: number };
  await page.waitForFunction((n) => {
    const evs = (window as unknown as Harness).__events.filter((e) => e.type === 'ev.sim' && e.run === n);
    return evs.some((e) => (e.percent ?? 0) >= 6) || evs.some((e) => ['done', 'stopped', 'failed'].includes(e.phase ?? ''));
  }, r.run, { timeout: 5_000 }).catch(() => undefined);
  expect(await request(page, 'sim.stop')).toEqual({});
  await expect.poll(async () => (await sims(page, r.run)).find((e) => ['done', 'stopped', 'failed'].includes(e.phase ?? ''))?.phase, { timeout: 5_000 }).toMatch(/^(stopped|failed)$/);
});

// ---------------------------------------------------------------- the island (any engine with the simulator)

test('Stop on 1 ns steps over 2 s, about 6 percent in, ends the run within 1 s, and a new run starts at once', async ({ page }) => {
  test.setTimeout(240_000);
  await boot(page, 'sim-rc');
  expect((await run(page, { analysis: { kind: 'op' }, options: OPTS, overrides: [] })).end).toBe('done');   // the service booted
  const r = await request(page, 'sim.run', { analysis: { kind: 'tran', step: '1n', stop: '2' }, options: OPTS, overrides: [] }) as { run: number };
  // Wait for about 6 percent, or 5 s at most.
  await page.waitForFunction((n) => {
    const evs = (window as unknown as Harness).__events.filter((e) => e.type === 'ev.sim' && e.run === n);
    return evs.some((e) => (e.percent ?? 0) >= 6) || evs.some((e) => ['done', 'stopped', 'failed'].includes(e.phase ?? ''));
  }, r.run, { timeout: 5_000 }).catch(() => undefined);
  const percent = (await sims(page, r.run)).filter((e) => e.percent != null).at(-1)?.percent ?? null;
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
  measure('Stop at 1 ns over 2 s', `pressed at ${percent} percent; answered ${stopped.answered} ms, ${stopped.end} ${stopped.ms} ms after the press`);
  expect(stopped.end).not.toBe('none');
  expect(stopped.ms).toBeLessThan(1000);
  expect((await sims(page, r.run)).filter((e) => ['done', 'stopped', 'failed'].includes(e.phase ?? ''))).toHaveLength(1);
  const t0 = Date.now();
  const next = await run(page, { analysis: { kind: 'tran', step: '1u', stop: '5m' }, options: OPTS, overrides: [] });
  measure('the run after the Stop', `${next.end} ${next.endMs} ms after its request, ${Date.now() - t0} ms in all`);
  expect(next.end).toBe('done');
});

test('two runs back to back each end once, with their own run number, and the second\'s result is whole', async ({ page }) => {
  await boot(page, 'sim-rc');
  const first = await request(page, 'sim.run', { analysis: { kind: 'tran', step: '1u', stop: '20' }, options: OPTS, overrides: [] }) as { run: number };
  await page.waitForTimeout(200);
  expect(await request(page, 'sim.stop')).toEqual({});
  await expect.poll(async () => (await sims(page, first.run)).at(-1)?.phase, { timeout: 10_000 }).toBe('stopped');
  // The second starts the moment the first ended.
  const second = await run(page, { analysis: { kind: 'tran', step: '1u', stop: '5m' }, options: OPTS, overrides: [] });
  expect(second.run).toBe(first.run + 1);
  expect(second.end).toBe('done');
  const all = (await events(page)).filter((e) => e.type === 'ev.sim');
  const ends = all.filter((e) => ['done', 'stopped', 'failed'].includes(e.phase ?? ''));
  expect(ends.filter((e) => e.run === first.run).map((e) => e.phase)).toEqual(['stopped']);
  expect(ends.filter((e) => e.run === second.run).map((e) => e.phase)).toEqual(['done']);
  // Nothing of the first run came after the second began.
  const secondStart = all.findIndex((e) => e.run === second.run);
  expect(all.slice(secondStart).filter((e) => e.run === first.run)).toEqual([]);
  const result = await request(page, 'sim.result', { run: second.run }) as unknown as Result;
  expect(result).toMatchObject({ run: second.run, kind: 'tran', ended: 'done' });
  const time = result.plots[0]!.vectors.find((v) => v.name === 'time')!;
  const [t] = await vectors(page, second.run, ['time']);
  measure('the second run', `${time.length} points, the last at ${t!.real.at(-1)} s`);
  expect(Math.abs(t!.real.at(-1)! - 5e-3)).toBeLessThan(1e-9);
  // The first run's result is another run's: the guard answers it no_simulation (only the latest transient is held).
  expect(await refusal(page, 'sim.result', { run: first.run })).toMatch(/^no_simulation/);
});

test('pole-zero on the RC gives one real pole at minus 1/RC', async ({ page }) => {
  await boot(page, 'sim-rc');
  // V1 given an AC magnitude of 1 (its pulse kept), as KiCad's AC and pole-zero analyses take a source:
  // without one ngspice answers "The input signal is shorted on the way to the output" (measured).
  await request(page, 'sim.model.set', { uuid: 'a1c0de00-0000-4000-8001-000000000100', sheetPath: '/', model: { source: 'builtin', type: 'V.PULSE', params: { y1: '0', y2: '5', td: '0', tr: '1n', tf: '1n', tw: '10m', per: '20m', ac: '1' }, pins: [] } });
  const pz = await run(page, { analysis: { kind: 'pz', input: ['/in', '0'], output: ['/out', '0'], transfer: 'vol', find: 'pz' }, options: OPTS, overrides: [] });
  const result = await request(page, 'sim.result', { run: pz.run }) as unknown as Result & { console: string[] };
  measure('pz', `${pz.end}${pz.code ? ` ${pz.code}` : ''}; console ${JSON.stringify(result.console.slice(-10))}`);
  expect(pz.end).toBe('done');
  const poles = result.plots.flatMap((p) => p.vectors).filter((v) => /pole/i.test(v.name));
  measure('pz vectors', JSON.stringify(result.plots.map((p) => [p.name, p.vectors.map((v) => `${v.name}:${v.complex}:${v.length}`)])));
  expect(poles).toHaveLength(1);
  const [p] = await vectors(page, pz.run, [poles[0]!.name]);
  measure('the RC pole', `${p!.real[0]} + ${p!.imag?.[0] ?? 0}j per second`);
  expect(p!.real).toHaveLength(1);
  expect(Math.abs(p!.real[0]! + 1000) / 1000).toBeLessThan(1e-3);
  expect(Math.abs(p!.imag?.[0] ?? 0)).toBeLessThan(1e-6);
});

test('S-parameters on a two-port LC low-pass give an S21 vector', async ({ page }) => {
  await boot(page, 'sim-sparam');
  const sp = await run(page, { analysis: { kind: 'sp', scale: 'dec', points: 10, fStart: '1meg', fStop: '1g' }, options: OPTS, overrides: [] });
  const result = await request(page, 'sim.result', { run: sp.run }).catch(() => null) as unknown as Result | null;
  measure('sp', `${sp.end}${sp.code ? ` ${sp.code}` : ''}: ${JSON.stringify(result?.plots.map((p) => [p.name, p.x, p.vectors.map((v) => `${v.name}:${v.complex}:${v.length}`)]))}`);
  expect(sp.end).toBe('done');
  const all = result!.plots.flatMap((p) => p.vectors);
  const s21 = all.find((v) => /^s_2_1$/i.test(v.name));
  expect(s21, JSON.stringify(all.map((v) => v.name))).toBeTruthy();
  expect(s21!.complex).toBe(true);
  // Every pair of the two ports: S11, S12, S21, S22.
  const names = new Set(all.filter((v) => /^s_\d_\d$/i.test(v.name)).map((v) => v.name.toUpperCase()));
  expect([...names].sort()).toEqual(Array.from({ length: SPARAM_PORTS * SPARAM_PORTS }, (_, i) => `S_${Math.floor(i / SPARAM_PORTS) + 1}_${(i % SPARAM_PORTS) + 1}`));
  const x = result!.plots.find((p) => p.vectors.includes(s21!))!.x!;
  const [freq, s] = await vectors(page, sp.run, [x, s21!.name]);
  const mag = (i: number) => Math.hypot(s!.real[i]!, s!.imag![i]!);
  // A low-pass: through at the low end, down at the high end.
  measure('|S21|', `${mag(0).toFixed(4)} at ${freq!.real[0]} Hz, ${mag(freq!.real.length - 1).toFixed(4)} at ${freq!.real.at(-1)} Hz`);
  expect(mag(0)).toBeGreaterThan(0.9);
  expect(mag(freq!.real.length - 1)).toBeLessThan(mag(0));
});
