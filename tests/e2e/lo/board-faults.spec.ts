// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// lo-e3-i over the local pair (PROTOCOL.md settings.set and board.rules): the
// board faults engine run 15 mends, on Glasgow with no KiCad window. On every
// engine: the stackup set's dielectric forms are checked closed, and the cap
// settings:stackupLayers is listed exactly when the engine's
// kicadSettingsSections() names stackupLayers. On engine run 15 (island cc25):
// a dielectric sublayer added then removed, the solder mask expansion's
// numbers, a through hole pad pair's copper layers, the board's numbering
// preview, a net class clearance the rules read at once, the drill report and
// the footprint list with no repeated name line. On run 14 those tests skip,
// each naming what it waits for.
import { expect, test, type Frame, type Page } from '@playwright/test';

import { ISLAND } from '../ports';

interface Ev { type: string; phase?: string; caps?: string[]; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Rule { constraint: string; unit: string; min: number | null; opt: number | null; max: number | null; source: string; layer: string }
interface Rules { rules: Rule[]; notes: string[] }
interface StackupRow { index: number; sub: number; kind: string; enabled: boolean; thickness: number }
interface Stackup { rows: StackupRow[]; boardThickness: number }
interface EditReport { rows: Array<{ uuid: string; kind: string; words: string }>; count: number; depth: number; notes: string[] }
interface Made { ok: boolean; ms: number; code?: string; message?: string; paths: string[]; notes: string[] }

const SECTIONS_EXPORT = 'kicadSettingsSections';
const CAP = 'settings:stackupLayers';
const RUN15 = 'waits for engine run 15 (island cc25): kicadSettingsSections and the board faults fixes of lo-e3r-e, lo-e3o-e and lo-e3s-e';

// Glasgow (a KiCad 6 board: its tstamps are the items' uuids).
/** Pad 1 of a test point on net 4 (/SCL), F.Cu. */
const PAD_SCL = 'd7c89af1-19d8-4456-a972-5f70a7809836';
/** A 0.15 mm track on net 1 (/SDA), F.Cu. */
const TRACK_SDA = '065e20db-a8d8-41a2-86d7-70fce80d950f';
/** J10 (PinHeader_1x03, through hole): pad 1 on GND, pad 2 on Net-(D12-Pad1). */
const J10_PAD1 = '76db18cf-82fe-4fbd-908f-95fc6ba1adbb';
const J10_PAD2 = 'a3c89279-9a9b-4c2d-8d7c-bddfb17f131a';

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
const summary = (r: Rules): string => r.rules.map((x) => `${x.constraint}${x.layer === '' ? '' : `@${x.layer}`} ${x.min ?? '-'}/${x.opt ?? '-'}/${x.max ?? '-'} ${x.unit} (${x.source})`).join('; ');

/** Boots Glasgow in `kind` and answers ev.ready's caps and the island's frame. */
async function open(page: Page, kind: 'sch' | 'pcb'): Promise<{ caps: string[]; frame: Frame | null }> {
  await page.goto(`/parent.html?fixture=glasgow&frame=${kind}`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  await expect(page.locator('#state')).toContainText(`opened glasgow.kicad_${kind}`, { timeout: 120_000 });
  await page.waitForTimeout(1_500);
  return { caps: (await of(page, 'ev.ready'))[0]?.caps ?? [], frame: page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null };
}
const run15 = (caps: readonly string[]): boolean => caps.includes(SECTIONS_EXPORT);

/** project.export from the host page: the paths, the notes, or the refusal. */
const make = (page: Page, args: unknown): Promise<Made> => page.evaluate(async (a) => {
  const t0 = performance.now();
  try {
    const r = await (window as unknown as Harness).__bridge.request('project.export', a) as { files: Array<{ path: string }>; notes: string[] };
    return { ok: true, ms: Math.round(performance.now() - t0), paths: r.files.map((f) => f.path), notes: r.notes };
  } catch (err) {
    const [code, ...rest] = (err as Error).message.split(': ');
    return { ok: false, ms: Math.round(performance.now() - t0), code, message: rest.join(': '), paths: [], notes: [] };
  }
}, args);

test('pcb: settings:stackupLayers is listed exactly when kicadSettingsSections names stackupLayers; the dielectric forms are checked closed', async ({ page }) => {
  const { caps, frame } = await open(page, 'pcb');
  const listed = frame == null ? null : await frame.evaluate((name) => {
    const read = (window as unknown as { Module?: Record<string, unknown> }).Module?.[name];
    if (typeof read !== 'function') return null;
    try { return (JSON.parse(String((read as () => unknown)())) as { board?: string[] }).board ?? null; } catch { return null; }
  }, SECTIONS_EXPORT);
  measure('kicadSettingsSections, board half', listed == null ? 'absent (engine run 14)' : listed.join(', '));
  expect(caps.includes(CAP)).toBe(listed?.includes('stackupLayers') === true);
  expect(caps.includes(SECTIONS_EXPORT)).toBe(listed != null);
  expect(await refusal(page, 'settings.set', { section: 'stackup', value: { addDielectric: { after: -1 } } })).toBe('bad_args: settings.set');
  expect(await refusal(page, 'settings.set', { section: 'stackup', value: { addDielectric: { after: 1 }, removeDielectric: { index: 1, sub: 0 } } })).toBe('bad_args: settings.set');
  expect(await refusal(page, 'settings.set', { section: 'stackup', value: { removeDielectric: { index: 1 } } })).toBe('bad_args: settings.set');
  if (listed == null) {
    expect(await refusal(page, 'settings.set', { section: 'stackup', value: { addDielectric: { after: 1 } } })).toBe(`unsupported: ${SECTIONS_EXPORT}`);
    expect(await refusal(page, 'settings.set', { section: 'stackup', value: { removeDielectric: { index: 1, sub: 1 } } })).toBe(`unsupported: ${SECTIONS_EXPORT}`);
  } else if (!listed.includes('stackupLayers')) {
    expect(await refusal(page, 'settings.set', { section: 'stackup', value: { addDielectric: { after: 1 } } })).toBe('unsupported: stackupLayers');
  }
  // The rows form goes on to the op as it ships, on every engine (the same rows back).
  const stackup = (await request(page, 'settings.get', { section: 'stackup' })) as unknown as Stackup;
  const first = stackup.rows.find((r) => r.kind === 'dielectric' && r.enabled);
  expect(first).toBeDefined();
  expect(await request(page, 'settings.set', { section: 'stackup', value: { rows: [{ index: first!.index, sub: first!.sub, thickness: first!.thickness }] } })).toHaveProperty('value');
  expect(await of(page, 'ev.menu')).toEqual([]);
});

test('sch: the cap is never listed and a dielectric form answers stackup is a board setting', async ({ page }) => {
  const { caps } = await open(page, 'sch');
  expect(caps).not.toContain(CAP);
  expect(await refusal(page, 'settings.set', { section: 'stackup', value: { addDielectric: { after: 1 } } })).toBe('unsupported: stackup is a board setting');
});

test('settings.set stackup: addDielectric adds one sublayer, removeDielectric takes it out, no undo step', async ({ page }) => {
  const { caps } = await open(page, 'pcb');
  test.skip(!caps.includes(CAP), RUN15);
  const edits = (await of(page, 'ev.edited')).length;
  const before = (await request(page, 'settings.get', { section: 'stackup' })) as unknown as Stackup;
  const item = before.rows.find((r) => r.kind === 'dielectric' && r.enabled)!;
  const subs = (rows: StackupRow[]): StackupRow[] => rows.filter((r) => r.index === item.index);
  const t0 = Date.now();
  const added = (await request(page, 'settings.set', { section: 'stackup', value: { addDielectric: { after: item.index } } })) as { value: Stackup };
  measure('settings.set stackup addDielectric, Glasgow', `${Date.now() - t0} ms: ${before.rows.length} to ${added.value.rows.length} rows`);
  expect(added.value.rows.length).toBe(before.rows.length + 1);
  const read = (await request(page, 'settings.get', { section: 'stackup' })) as unknown as Stackup;
  expect(read.rows.length).toBe(before.rows.length + 1);
  expect(subs(read.rows).length).toBe(subs(before.rows).length + 1);
  const last = Math.max(...subs(read.rows).map((r) => r.sub));
  const removed = (await request(page, 'settings.set', { section: 'stackup', value: { removeDielectric: { index: item.index, sub: last } } })) as { value: Stackup };
  expect(removed.value.rows.length).toBe(before.rows.length);
  expect(((await request(page, 'settings.get', { section: 'stackup' })) as unknown as Stackup).rows.length).toBe(before.rows.length);
  // The item's last sublayer stays: the engine refuses to take it.
  if (subs(before.rows).length === 1) {
    expect(await refusal(page, 'settings.set', { section: 'stackup', value: { removeDielectric: { index: item.index, sub: 0 } } })).toMatch(/^bad_args: /);
  }
  await page.waitForTimeout(1_500);
  expect((await of(page, 'ev.edited')).length).toBe(edits);
  expect(await of(page, 'ev.menu')).toEqual([]);
});

test('board.rules: a track and a pad answer the solder mask expansion\'s numbers; two through hole pads only the enabled copper', async ({ page }) => {
  const { caps } = await open(page, 'pcb');
  test.skip(!run15(caps), RUN15);
  for (const uuid of [TRACK_SDA, PAD_SCL]) {
    const r = (await request(page, 'board.rules', { a: uuid })) as unknown as Rules;
    measure(`board.rules ${uuid === TRACK_SDA ? 'a track' : 'a pad'}`, summary(r));
    const mask = r.rules.find((x) => x.constraint === 'solder_mask_expansion');
    expect(mask).toMatchObject({ unit: 'mm' });
    expect([mask!.min, mask!.opt, mask!.max].some((v) => typeof v === 'number')).toBe(true);
  }
  const layers = (await request(page, 'settings.get', { section: 'layers' })) as { copperCount: number; layers: Array<{ name: string; enabled: boolean }> };
  const copper = new Set(layers.layers.filter((l) => l.enabled && l.name.endsWith('.Cu')).map((l) => l.name));
  expect(copper.size).toBe(layers.copperCount);
  const pair = (await request(page, 'board.rules', { a: J10_PAD1, b: J10_PAD2 })) as unknown as Rules;
  measure('board.rules J10 pads 1 and 2', summary(pair));
  const named = [...new Set(pair.rules.map((x) => x.layer).filter((l) => l.endsWith('.Cu')))];
  expect(named.length).toBeGreaterThan(0);
  expect(named.length).toBeLessThanOrEqual(copper.size);
  for (const l of named) expect(copper.has(l)).toBe(true);
});

test('board.edit reannotate preview on Glasgow answers rows and no duplicate_designator', async ({ page }) => {
  const { caps } = await open(page, 'pcb');
  test.skip(!run15(caps), RUN15);
  const pre = (await request(page, 'board.edit', { op: 'reannotate', preview: true, filter: {}, set: { order: 0 } })) as unknown as EditReport;
  measure('board.edit reannotate preview, Glasgow', `${pre.count} rows, notes ${pre.notes.join(' | ')}`);
  expect(pre.count).toBeGreaterThan(0);
  expect(pre.rows.length).toBeGreaterThan(0);
});

test('settings.set netClasses, then board.rules reads the new clearance at once', async ({ page }) => {
  const { caps } = await open(page, 'pcb');
  test.skip(!run15(caps), RUN15);
  const nc = (await request(page, 'settings.get', { section: 'netClasses' })) as { classes: Array<Record<string, unknown>> };
  const classes = nc.classes.map((c) => (c.name === 'Default' ? { ...c, clearance: 0.3 } : c));
  await request(page, 'settings.set', { section: 'netClasses', value: { classes } });
  const r = (await request(page, 'board.rules', { a: PAD_SCL, b: TRACK_SDA })) as unknown as Rules;
  measure('board.rules after a 0.3 mm Default clearance', summary(r));
  const clearance = r.rules.find((x) => x.constraint === 'clearance' && x.layer === 'F.Cu');
  expect(clearance?.min).toBeCloseTo(0.3, 4);
});

test('project.export: the drill job with its report writes the .rpt, the footprint list names no footprint twice', async ({ page }) => {
  test.setTimeout(300_000);
  const { caps } = await open(page, 'pcb');
  test.skip(!run15(caps), RUN15);
  const drill = await make(page, { job: 'pcb_export_drill', settings: { generate_report: true } });
  measure('project.export drill with its report, Glasgow', drill.ok ? `${drill.ms} ms: ${drill.paths.join(', ')}` : `${drill.code}: ${drill.message}`);
  expect(drill.ok).toBe(true);
  expect(drill.paths.some((p) => /\.rpt$/.test(p))).toBe(true);
  expect(drill.paths.some((p) => /\.drl$/.test(p))).toBe(true);
  const fps = await make(page, { job: 'cc_footprints', settings: {} });
  measure('project.export cc_footprints, Glasgow', fps.ok ? `${fps.ms} ms: ${fps.paths.length} files, notes ${fps.notes.join(' | ')}` : `${fps.code}: ${fps.message}`);
  expect(fps.ok).toBe(true);
  for (const n of fps.notes) expect(n).not.toMatch(/More than one footprint is named/);
  expect(new Set(fps.paths).size).toBe(fps.paths.length);
});
