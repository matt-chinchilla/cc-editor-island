// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// island v0.2.3-cc23 over the local pair (PROTOCOL.md sim.catalog,
// sim.model.get, sim.model.set, sim.file): models on parts with no KiCad
// dialog, through our engine's run 14 model exports. KiCad's model tables,
// each fixture part's model as KiCad resolves it, a set read back as ONE edit
// (one undo step, one ev.edited), a model from a SPICE file and from an IBIS
// file, and a set the engine refuses (model_invalid).
import { expect, test, type Frame, type Page } from '@playwright/test';

import { ISLAND } from './ports';
interface Ev { type: string; depth?: number; caps?: string[]; phase?: string; run?: number; code?: string; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Engine { Module: { kicadCollabTestUndoDepth(): number } }
interface ModelSheet { uuid: string; sheetPath: string; ref: string; enabled: boolean; source: string; device: string; type: string; typeName: string; file: { path: string; model: string } | null; pins: Array<{ symbolPin: string; modelPin: string }>; params: Array<{ name: string; value: string; default: string; unit: string; given: boolean }>; problems: Array<{ code: string; severity: string; text: string }> }

/** The fixtures' parts (tests/fixtures/sim-rc, sim-models). */
const RC = { V1: 'a1c0de00-0000-4000-8001-000000000100', R1: 'a1c0de00-0000-4000-8001-000000000200', C1: 'a1c0de00-0000-4000-8001-000000000300' };
const MODELS = { R2: 'a1c0de00-0000-4000-8003-000000000300', Q1: 'a1c0de00-0000-4000-8003-000000000400' };
const OPTS = { voltages: true, currents: true, dissipations: false, events: false };

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
const model = async (page: Page, uuid: string): Promise<ModelSheet> => (await request(page, 'sim.model.get', { uuid, sheetPath: '/' })) as unknown as ModelSheet;
const undoDepth = (frame: Frame): Promise<number> => frame.evaluate(() => Number((window as unknown as Engine).Module.kicadCollabTestUndoDepth()));

async function boot(page: Page, fixture: string): Promise<Frame | null> {
  await page.goto(`/parent.html?fixture=${fixture}&frame=sch`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  await expect(page.locator('#state')).toContainText(`opened ${fixture}.kicad_sch`, { timeout: 120_000 });
  await page.waitForTimeout(1_000);   // ev.edited's baseline is read
  return page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null;
}

test('KiCad\'s model tables, each RC part\'s model, a set read back as one edit, a set taken back, and model_invalid', async ({ page }) => {
  const frame = await boot(page, 'sim-rc');
  const catalog = await request(page, 'sim.catalog') as { devices: Array<{ device: string; types: Array<{ type: string; name: string }> }> };
  const devices = catalog.devices.map((d) => d.device);
  measure('catalog', `${catalog.devices.length} devices, ${catalog.devices.reduce((n, d) => n + d.types.length, 0)} types: ${devices.join(' ')}`);
  expect(devices).toEqual(expect.arrayContaining(['R', 'C', 'L', 'V', 'I', 'D', 'NPN', 'NMOS']));
  expect(catalog.devices.find((d) => d.device === 'V')?.types.map((t) => t.type)).toEqual(expect.arrayContaining(['V.DC', 'V.PULSE', 'V.SIN', 'V.=']));
  const r = await request(page, 'sim.catalog', { type: 'R' }) as { pins: unknown[]; params: Array<{ name: string; tuner: boolean; category: string }> };
  expect(r.pins).toHaveLength(2);
  expect(r.params.find((p) => p.name === 'r')).toMatchObject({ tuner: true, category: 'principal' });
  expect(await refusal(page, 'sim.catalog', { type: 'NOPE' })).toMatch(/^bad_args/);

  const v1 = await model(page, RC.V1);
  expect(v1).toMatchObject({ ref: 'V1', enabled: true, source: 'builtin', device: 'V', type: 'V.PULSE', file: null, problems: [] });
  expect(v1.pins).toEqual([{ symbolPin: '1', modelPin: '+' }, { symbolPin: '2', modelPin: '-' }]);
  expect(v1.params.find((p) => p.name === 'y2')).toMatchObject({ value: '5', given: true });
  const r1 = await model(page, RC.R1);
  expect(r1).toMatchObject({ ref: 'R1', source: 'inferred', device: 'R', type: 'R' });
  expect(r1.params.find((p) => p.name === 'r')?.value).toBe('1k');
  expect(await model(page, RC.C1)).toMatchObject({ ref: 'C1', source: 'inferred', device: 'C', type: 'C' });
  expect(await refusal(page, 'sim.model.get', { uuid: 'a1c0de00-0000-4000-8001-0000000009ff', sheetPath: '/' })).toMatch(/^not_found/);

  // A set: R1 as a built in resistor of 2k. One undo step, one ev.edited.
  const depth0 = frame == null ? null : await undoDepth(frame);
  const edits0 = (await of(page, 'ev.edited')).length;
  const t0 = Date.now();
  const set = await request(page, 'sim.model.set', { uuid: RC.R1, sheetPath: '/', model: { source: 'builtin', type: 'R', params: { r: '2k' }, pins: [] } }) as unknown as ModelSheet;
  measure('sim.model.set', `${Date.now() - t0} ms`);
  expect(set).toMatchObject({ ref: 'R1', source: 'builtin', type: 'R' });
  expect(set.params.find((p) => p.name === 'r')?.value).toBe('2k');
  if (frame != null) expect(await undoDepth(frame)).toBe((depth0 ?? 0) + 1);
  await expect.poll(async () => (await of(page, 'ev.edited')).length, { timeout: 5_000 }).toBe(edits0 + 1);
  // The circuit with the set runs.
  const run = await request(page, 'sim.run', { analysis: { kind: 'op' }, options: OPTS, overrides: [] }) as { run: number };
  await expect.poll(async () => (await of(page, 'ev.sim')).filter((e) => e.run === run.run).at(-1)?.phase, { timeout: 60_000 }).toBe('done');
  // Taken back: null removes the fields, and the model is inferred from the value again.
  const back = await request(page, 'sim.model.set', { uuid: RC.R1, sheetPath: '/', model: null }) as unknown as ModelSheet;
  expect(back).toMatchObject({ source: 'inferred', type: 'R' });
  if (frame != null) expect(await undoDepth(frame)).toBe((depth0 ?? 0) + 2);
  // The engine checks the whole set on a scratch model first: nothing changes on a refusal.
  const refused = {
    param: await refusal(page, 'sim.model.set', { uuid: RC.R1, sheetPath: '/', model: { source: 'builtin', type: 'R', params: { nosuch: '1' }, pins: [] } }),
    pin: await refusal(page, 'sim.model.set', { uuid: RC.R1, sheetPath: '/', model: { source: 'builtin', type: 'R', params: {}, pins: [{ symbolPin: '9', modelPin: '+' }] } }),
    file: await refusal(page, 'sim.model.set', { uuid: RC.R1, sheetPath: '/', model: { source: 'file', path: 'models/none.lib', model: 'X', params: {}, pins: [] } }),
  };
  measure('refused sets', JSON.stringify(refused));
  for (const why of Object.values(refused)) expect(why).toMatch(/^model_invalid/);
  if (frame != null) expect(await undoDepth(frame)).toBe((depth0 ?? 0) + 2);
  // Ctrl+Z takes the last set back as KiCad's own undo.
  expect(await request(page, 'key.press', { key: 'z', code: 'KeyZ', ctrl: true })).toEqual({});
  await expect.poll(async () => (await model(page, RC.R1)).source, { timeout: 5_000 }).toBe('builtin');
});

test('a model from a SPICE file and from an IBIS file', async ({ page }) => {
  await boot(page, 'sim-models');
  const lib = await request(page, 'sim.file', { path: 'models/bjt.lib' }) as { kind: string; models: Array<{ name: string; kind: string; type: string; pins: string[] }>; problems: unknown[] };
  measure('models/bjt.lib', JSON.stringify(lib.models));
  expect(lib.kind).toBe('spice');
  expect(lib.models.find((m) => m.name.toUpperCase() === 'Q2N3904')).toMatchObject({ kind: 'model' });
  // The subcircuit is listed as one; KiCad names no pins of it here (measured on engine run 14: pins []).
  expect(lib.models.find((m) => m.name.toUpperCase() === 'AMP10')).toMatchObject({ kind: 'subckt' });
  const missing = await request(page, 'sim.file', { path: 'models/none.lib' }) as { models: unknown[]; problems: Array<{ code: string }> };
  expect(missing.models).toEqual([]);
  expect(missing.problems.map((p) => p.code)).toContain('file_missing');
  expect(await refusal(page, 'sim.file', { path: '../outside.lib' })).toMatch(/^bad_args/);

  const q1 = await request(page, 'sim.model.get', { uuid: MODELS.Q1, sheetPath: '/' }) as unknown as ModelSheet;
  expect(q1).toMatchObject({ ref: 'Q1', source: 'file', file: { path: 'models/bjt.lib', model: 'Q2N3904' } });
  measure('Q1', `${q1.type} ${q1.typeName}, ${q1.params.length} parameters, problems ${JSON.stringify(q1.problems)}`);
  // The stage runs: the collector sits between the rails.
  const run = await request(page, 'sim.run', { analysis: { kind: 'op' }, options: OPTS, overrides: [] }) as { run: number };
  await expect.poll(async () => (await of(page, 'ev.sim')).filter((e) => e.run === run.run).at(-1)?.phase, { timeout: 60_000 }).toBe('done');
  const op = (await request(page, 'sim.result', { run: run.run }) as { op: Array<{ signal: string; value: number }> }).op;
  const vc = op.find((o) => /^v\(\/?c\)$/i.test(o.signal))?.value;
  measure('the common emitter stage', JSON.stringify(op));
  expect(vc).toBeGreaterThan(0.05);
  expect(vc).toBeLessThan(5);

  const ibis = await request(page, 'sim.file', { path: 'models/driver.ibs' }) as { kind: string; models: Array<{ name: string; kind: string; pins: string[] }>; problems: Array<{ text: string }> };
  measure('models/driver.ibs', `${JSON.stringify(ibis.models)} problems ${JSON.stringify(ibis.problems)}`);
  expect(ibis.kind).toBe('ibis');
  const part = ibis.models.find((m) => m.kind === 'ibis');
  expect(part, JSON.stringify(ibis)).toBeTruthy();
  // An IBIS model on R2: the file, its component, the pin and its buffer model.
  const set = await request(page, 'sim.model.set', { uuid: MODELS.R2, sheetPath: '/', model: { source: 'file', path: 'models/driver.ibs', model: part!.name, params: { 'ibis.pin': '1', 'ibis.model': 'BUF' }, pins: [] } }).catch((e: Error) => e.message) as ModelSheet | string;
  measure('an IBIS model on R2', typeof set === 'string' ? set : JSON.stringify({ source: set.source, device: set.device, type: set.type, file: set.file, ibis: (set as unknown as { ibis?: unknown }).ibis }));
  expect(typeof set === 'string' ? set : set.source).toBe('file');
});
