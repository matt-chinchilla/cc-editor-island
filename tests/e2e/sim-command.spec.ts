// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// island v0.2.3-cc25 over the local pair (PROTOCOL.md sim.command): the lines
// a KiCad simulator workbook carries for one setup, on the real engine (any
// engine with the simulator: run 14 or later). sim-rc's transient with KiCad's
// default options answers [.tran 1u 5m, .save all, .probe alli]; the line is
// the schematic's own directive and the line KiCad's netlist carries for the
// same analysis through sim.netlist; every analysis kind answers; a number
// outside the SPICE grammar answers bad_args.
import { expect, test, type Page } from '@playwright/test';

interface Ev { type: string; caps?: string[]; phase?: string; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }

const KICAD_DEFAULT = { voltages: true, currents: true, dissipations: false, events: true };
const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const request = (page: Page, op: string, args?: unknown): Promise<Record<string, unknown>> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const);
const refusal = (page: Page, op: string, args?: unknown): Promise<string> =>
  request(page, op, args).then(() => 'ok', (err: Error) => err.message.split('\n')[0].replace(/^.*?page\.evaluate:\s*/, '').replace(/^Error:\s*/, ''));
const lines = async (page: Page, analysis: unknown, options: unknown = KICAD_DEFAULT): Promise<string[]> =>
  ((await request(page, 'sim.command', { analysis, options })) as { commands: string[] }).commands;

test('sim.command: the workbook lines of sim-rc, every analysis kind, and the SPICE grammar refused', async ({ page }) => {
  await page.goto('/parent.html?fixture=sim-rc&frame=sch');
  await expect(page.locator('#state')).toContainText('opened sim-rc.kicad_sch', { timeout: 170_000 });
  const ready = (await events(page)).find((e) => e.type === 'ev.ready');
  expect(ready?.caps).toEqual(expect.arrayContaining(['sim', 'simCommand']));

  const tran = { kind: 'tran', step: '1u', stop: '5m' };
  expect(await lines(page, tran)).toEqual(['.tran 1u 5m', '.save all', '.probe alli']);

  // The same line the schematic carries and the netlist KiCad writes for this analysis.
  const net = await request(page, 'sim.netlist', { analysis: tran, options: KICAD_DEFAULT }) as { netlist: string; directive: string };
  expect(net.directive.trim().toLowerCase()).toContain('.tran 1u 5m');
  expect(net.netlist.split('\n').map((l) => l.trim().toLowerCase())).toContain('.tran 1u 5m');

  const none = { voltages: false, currents: false, dissipations: false, events: false };
  expect(await lines(page, { kind: 'op' }, none)).toEqual(['.op', '.kicad esavenone']);
  expect(await lines(page, { kind: 'sheet' })).toEqual(['.save all', '.probe alli']);
  expect((await lines(page, { kind: 'dc', source: 'V1', start: '0', stop: '12', step: '1' }))[0]).toBe('.dc V1 0 12 1');
  expect((await lines(page, { kind: 'ac', scale: 'dec', points: 10, fStart: '1', fStop: '1meg' }))[0]).toBe('.ac dec 10 1 1meg');
  expect((await lines(page, { kind: 'sp', scale: 'lin', points: 11, fStart: '1meg', fStop: '1g' }))[0]).toBe('.sp lin 11 1meg 1g');
  expect((await lines(page, { kind: 'noise', output: '/out', source: 'V1', scale: 'dec', points: 5, fStart: '10', fStop: '100k' }))[0]).toBe('.noise v(/out) V1 dec 5 10 100k');
  expect((await lines(page, { kind: 'pz', input: ['/in', '0'], output: ['/out', '0'], transfer: 'vol', find: 'pz' }))[0]).toBe('.pz /in 0 /out 0 vol pz');
  expect(await lines(page, { kind: 'fft', of: 1, signals: ['V(/out)'] }, none)).toEqual(['linearize V(/out)', 'fft V(/out)', '.kicad esavenone']);
  expect(await lines(page, tran, { voltages: true, currents: true, dissipations: true, events: true })).toEqual(['.tran 1u 5m', '.save all', '.probe alli', '.probe allp']);

  // Outside the SPICE grammar, and a sweep over a part that is not a source.
  expect(await refusal(page, 'sim.command', { analysis: { kind: 'tran', step: '1 u', stop: '5m' }, options: KICAD_DEFAULT })).toMatch(/^bad_args/);
  expect(await refusal(page, 'sim.command', { analysis: { kind: 'tran', step: 'abc', stop: '5m' }, options: KICAD_DEFAULT })).toMatch(/^bad_args/);
  expect(await refusal(page, 'sim.command', { analysis: { kind: 'dc', source: 'C1', start: '0', stop: '1', step: '1' }, options: KICAD_DEFAULT })).toMatch(/^bad_args/);
  expect(await refusal(page, 'sim.command', { analysis: tran })).toMatch(/^bad_args/);
});
