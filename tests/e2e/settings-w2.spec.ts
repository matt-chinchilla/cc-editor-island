// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// m7-i over the local pair (PROTOCOL.md settings.get, settings.set and
// board.tuningSolve): the eight Setup sections of engine run 15 and KiCad's
// tuning profile work out. On engine run 14 (Glasgow) no cap of the unit is
// listed and every read, set and solve answers unsupported naming what the
// engine lacks. On engine run 15 (cc25, the settings-from fixture of unit
// m8-i): each section reads in its frame and answers unsupported in the
// other (componentClasses read in both); one set per section reads back with
// no ev.edited; a zoneHatchOffsets set replaces the list; a componentClasses
// set then board.rules on a U part names the class; board.tuningSolve answers
// a width for a 50 ohm single track and bad_args for a layer the board lacks.
import { expect, test, type Page } from '@playwright/test';

interface Ev { type: string; phase?: string; caps?: string[] }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }

const SECTIONS = 'kicadSettingsSections';
const RUN15 = 'waits for engine run 15 (pcbjam cc_e12_pcb.inc and cc_e12_sch.inc, unit m7-e: kicadSettingsSections, kicadTuningSolve)';
const FIXTURE = 'settings-from';
const FIXTURE_LIST = new URL(`../fixtures/${FIXTURE}/files.json`, import.meta.url);
interface FsLike { existsSync(path: URL): boolean }
/** The fixture is unit m8-i's: until it lands the run 15 tests wait for it. */
async function hasFixture(): Promise<boolean> {
  const fsName = 'node:fs';
  const fs = (await import(/* @vite-ignore */ fsName)) as FsLike;
  return fs.existsSync(FIXTURE_LIST);
}
const NO_FIXTURE = 'waits for the settings-from fixture (unit m8-i)';
const BOARD = ['zoneDefaults', 'zoneHatchOffsets', 'boardFormatting', 'tuningPatterns', 'componentClasses', 'tuningProfiles'];
const SCHEMATIC = ['annotation', 'bomPresets', 'componentClasses'];
const CAPS = [...new Set([...BOARD, ...SCHEMATIC])].map((s) => `settings:${s}`);
const SINGLE = { type: 'single', impedance: 50, signalLayer: 'F.Cu', bottomRef: 'In1.Cu', solveFor: 'width' };

function measure(type: string, description: string): void {
  test.info().annotations.push({ type, description });
  console.log(`[measure] ${type}: ${description}`);
}
const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const edits = async (page: Page): Promise<number> => (await events(page)).filter((e) => e.type === 'ev.edited').length;
const request = (page: Page, op: string, args?: unknown): Promise<Record<string, unknown>> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const);
const refusal = (page: Page, op: string, args?: unknown): Promise<string> =>
  request(page, op, args).then(() => 'ok', (err: Error) => err.message.split('\n')[0].replace(/^.*?page\.evaluate:\s*/, '').replace(/^Error:\s*/, ''));
const get = (page: Page, section: string) => request(page, 'settings.get', { section });
const set = async (page: Page, section: string, value: Record<string, unknown>) => {
  const before = await edits(page);
  const answer = await request(page, 'settings.set', { section, value });
  await page.waitForTimeout(250);
  expect(await edits(page), `${section}: no ev.edited`).toBe(before);
  return answer;
};

/** Boots `fixture` in `frame` and answers ev.ready's caps once the document is open. */
async function boot(page: Page, fixture: string, frame: 'pcb' | 'sch'): Promise<string[]> {
  await page.goto(`/parent.html?fixture=${fixture}&frame=${frame}`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  const caps = (await events(page)).find((e) => e.type === 'ev.ready')?.caps ?? [];
  await expect(page.locator('#state')).toContainText(new RegExp(`opened \\S+\\.kicad_${frame}`), { timeout: 120_000 });
  return caps;
}

test('run 14 or 15, a pcb frame: the caps follow the engine; without it every section and the solve answer unsupported; bad args first', async ({ page }) => {
  const caps = await boot(page, 'glasgow', 'pcb');
  expect(caps.includes('tuningSolve')).toBe(caps.includes('kicadTuningSolve'));
  if (!caps.includes(SECTIONS)) {
    for (const cap of CAPS) expect(caps).not.toContain(cap);
    for (const section of BOARD) expect(await refusal(page, 'settings.get', { section })).toBe(`unsupported: ${SECTIONS}`);
    expect(await refusal(page, 'settings.set', { section: 'zoneDefaults', value: { min_clearance: 0.6 } })).toBe(`unsupported: ${SECTIONS}`);
  }
  if (!caps.includes('kicadTuningSolve')) expect(await refusal(page, 'board.tuningSolve', SINGLE)).toBe('unsupported: kicadTuningSolve');
  expect(await refusal(page, 'settings.get', { section: 'annotation' })).toBe('unsupported: annotation is a schematic setting');
  expect(await refusal(page, 'settings.set', { section: 'tuningPatterns', value: { single_track_defaults: { corner_style: 2 } } })).toBe('bad_args: settings.set');
  expect(await refusal(page, 'board.tuningSolve', { ...SINGLE, signalLayer: 'Bogus.Cu' })).toBe('bad_args: board.tuningSolve');
  expect(await refusal(page, 'board.tuningSolve', { ...SINGLE, solveFor: 'gap' })).toBe('bad_args: board.tuningSolve');
});

test('run 14 or 15, a sch frame: the caps follow the engine; the board sections and the solve are refused', async ({ page }) => {
  const caps = await boot(page, 'glasgow', 'sch');
  expect(caps).not.toContain('tuningSolve');
  for (const cap of ['settings:zoneDefaults', 'settings:zoneHatchOffsets', 'settings:boardFormatting', 'settings:tuningPatterns', 'settings:tuningProfiles']) expect(caps).not.toContain(cap);
  if (!caps.includes(SECTIONS)) {
    for (const section of SCHEMATIC) expect(await refusal(page, 'settings.get', { section })).toBe(`unsupported: ${SECTIONS}`);
  }
  expect(await refusal(page, 'settings.get', { section: 'zoneDefaults' })).toBe('unsupported: zoneDefaults is a board setting');
  expect(await refusal(page, 'settings.set', { section: 'componentClasses', value: { 'sheet_component_classes.enabled': true } }))
    .toBe('unsupported: the schematic reads componentClasses and never sets it');
  expect(await refusal(page, 'board.tuningSolve', SINGLE)).toBe('unsupported: a board op runs in a pcb frame');
});

test('run 15, the board: six sections read and set, hatch offsets replace the list, a class reaches board.rules, the solve works out a width', async ({ page }) => {
  test.skip(!(await hasFixture()), NO_FIXTURE);
  const caps = await boot(page, FIXTURE, 'pcb');
  test.skip(!caps.includes('settings:zoneDefaults'), RUN15);
  for (const s of BOARD) expect(caps).toContain(`settings:${s}`);
  expect(caps).toContain('tuningSolve');

  for (const section of BOARD) {
    const t0 = Date.now();
    expect(Object.keys(await get(page, section)).length, section).toBeGreaterThan(0);
    measure(`settings.get ${section}`, `${Date.now() - t0} ms`);
  }

  const zone = (await set(page, 'zoneDefaults', { min_clearance: 0.6 })) as { value: Record<string, unknown> };
  expect(zone.value.min_clearance).toBe(0.6);
  expect((await get(page, 'zoneDefaults')).min_clearance).toBe(0.6);

  const before = (await get(page, 'zoneHatchOffsets')) as { layers: { layer: string; offset: number[] | null }[] };
  expect(before.layers[0].layer).toBe('F.Cu');
  expect(before.layers.find((l) => l.layer === 'In1.Cu')?.offset).not.toBeNull();
  await set(page, 'zoneHatchOffsets', { layers: [{ layer: 'In2.Cu', offset: [0.25, 0.25] }] });
  const after = (await get(page, 'zoneHatchOffsets')) as typeof before;
  expect(after.layers.map((l) => l.layer)).toEqual(before.layers.map((l) => l.layer));
  for (const l of after.layers) expect(l.offset, l.layer).toEqual(l.layer === 'In2.Cu' ? [0.25, 0.25] : null);

  await set(page, 'boardFormatting', { dashRatio: 7 });
  expect((await get(page, 'boardFormatting')).dashRatio).toBe(7);

  const patterns = (await get(page, 'tuningPatterns')) as Record<string, Record<string, unknown>>;
  await set(page, 'tuningPatterns', { single_track_defaults: { spacing: 1.2 } });
  const patterns2 = (await get(page, 'tuningPatterns')) as typeof patterns;
  expect(patterns2.single_track_defaults).toEqual({ ...patterns.single_track_defaults, spacing: 1.2 });
  expect(await refusal(page, 'settings.set', { section: 'tuningPatterns', value: { single_track_defaults: { corner_style: 2 } } })).toBe('bad_args: settings.set');

  const profiles = (await get(page, 'tuningProfiles')) as { tuning_profiles_impedance_geometric: unknown[] };
  expect(profiles.tuning_profiles_impedance_geometric.length).toBeGreaterThan(0);
  await set(page, 'tuningProfiles', profiles);
  expect(await get(page, 'tuningProfiles')).toEqual(profiles);

  const classes = (await get(page, 'componentClasses')) as { assignments: { component_class: string }[] };
  expect(classes.assignments.map((a) => a.component_class)).toContain('POWER');
  const assignment = { component_class: 'W2CLASS', conditions_operator: 'ALL', conditions: { REFERENCE: { primary: 'U*' } } };
  await set(page, 'componentClasses', { assignments: [assignment] });
  expect(((await get(page, 'componentClasses')) as typeof classes).assignments).toEqual([assignment]);
  await request(page, 'settings.set', { section: 'customRules', value: { text: '(version 1)\n(rule "w2 class"\n  (condition "A.hasComponentClass(\'W2CLASS\')")\n  (constraint assertion "A.Type == \'Footprint\'"))\n' } });
  const fps = (await request(page, 'board.footprints')) as { footprints: { uuid: string; ref: string }[] };
  const u = fps.footprints.find((f) => /^U[0-9]/.test(f.ref));
  expect(u, 'a U part on the board').toBeDefined();
  const rules = (await request(page, 'board.rules', { a: u!.uuid })) as { rules: { constraint: string; condition: string; verdict: string }[] };
  measure('board.rules on a U part after the class set', JSON.stringify(rules.rules.filter((r) => r.condition.includes('W2CLASS'))));
  expect(rules.rules.some((r) => r.constraint === 'assertion' && r.condition.includes('W2CLASS'))).toBe(true);

  const t0 = Date.now();
  const width = (await request(page, 'board.tuningSolve', SINGLE)) as { width: number | null; gap: number | null; delay: number | null; problem: string };
  measure('board.tuningSolve, 50 ohm single track', `${JSON.stringify(width)} in ${Date.now() - t0} ms`);
  expect(width.problem).toBe('');
  expect(width.width).toBeGreaterThan(0);
  expect(width.delay).toBeGreaterThan(0);
  expect(await refusal(page, 'board.tuningSolve', { ...SINGLE, signalLayer: 'In30.Cu' })).toBe('bad_args: board.tuningSolve');
  const pair = (await request(page, 'board.tuningSolve', { ...SINGLE, type: 'differential', impedance: 90 })) as typeof width;
  expect(pair.problem).not.toBe('');
  expect([pair.width, pair.gap, pair.delay]).toEqual([null, null, null]);
});

test('run 15, the schematic: annotation, BOM presets and the classes read; two set; the board sections refused', async ({ page }) => {
  test.skip(!(await hasFixture()), NO_FIXTURE);
  const caps = await boot(page, FIXTURE, 'sch');
  test.skip(!caps.includes('settings:annotation'), RUN15);
  for (const s of SCHEMATIC) expect(caps).toContain(`settings:${s}`);
  for (const s of SCHEMATIC) expect(Object.keys(await get(page, s)).length, s).toBeGreaterThan(0);
  expect(((await get(page, 'componentClasses')) as { assignments: { component_class: string }[] }).assignments.map((a) => a.component_class)).toContain('POWER');
  for (const s of BOARD.filter((x) => x !== 'componentClasses')) expect(await refusal(page, 'settings.get', { section: s })).toBe(`unsupported: ${s} is a board setting`);

  expect((await get(page, 'annotation')).annotate_start_num).toBe(100);
  await set(page, 'annotation', { 'annotation.method': 1 });
  expect((await get(page, 'annotation'))['annotation.method']).toBe(1);
  expect(await refusal(page, 'settings.set', { section: 'annotation', value: { 'annotation.method': 3 } })).toBe('bad_args: settings.set');

  const bom = (await get(page, 'bomPresets')) as { bom_presets: { name: string }[] };
  expect(bom.bom_presets.map((p) => p.name)).toContain('Assembly');
  await set(page, 'bomPresets', { bom_presets: bom.bom_presets });
  expect(((await get(page, 'bomPresets')) as typeof bom).bom_presets).toEqual(bom.bom_presets);
  expect((await refusal(page, 'settings.set', { section: 'bomPresets', value: { bom_presets: [{ name: 'x' }] } })).startsWith('bad_args')).toBe(true);
});

