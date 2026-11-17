// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// island v0.2.3-cc23 over the local pair (PROTOCOL.md symbols.get, symbols.set,
// symbols.exchange, sch.edit, board.footprints, board.edit,
// footprints.exchange, settings.get and settings.set): properties, numbering
// and rules with no KiCad window, through our engine's run 14 exports. On
// tests/fixtures/variants (two variants, a sheet not populated, its board),
// drc-small with drc-badrules' rules, and Glasgow once, timed: each op, one
// undo step per apply, previews and dry runs pushing none, a 263-row set.
import { expect, test, type Page } from '@playwright/test';

declare const process: { env: Record<string, string | undefined> };

interface Ev { type: string; phase?: string; depth?: number; caps?: string[]; path?: string; text?: string; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Row { uuid: string; sheetPath: string; ref: string; unit: number; value: string; footprint: string; fields: Array<{ name: string; value: string; shown: boolean }>; inBom: boolean; onBoard: boolean; inSim: boolean; inPos: boolean; dnp: boolean; sheetHeld: string[]; overrides: string[]; filters: string[]; pins: number }
interface Table { variant: string; variants: string[]; rows: Row[]; power: number; truncated: boolean; depth: number }
interface EditReport { op: string; preview: boolean; rows: Array<{ uuid: string; kind: string; words: string; from?: string; to?: string; symbolPath?: string }>; count: number; truncated: boolean; depth: number; notes: string[] }

const UNDO = { key: 'z', code: 'KeyZ', ctrl: true };
/** tests/fixtures/variants/ids.json. */
const V = {
  root: 'cc0d5a11-0000-4000-8000-000000000a00', sheet: 'cc0d5a11-0000-4000-8000-000000000a50',
  r1: 'cc0d5a11-0000-4000-8000-000000000a01', r2: 'cc0d5a11-0000-4000-8000-000000000a02', r3: 'cc0d5a11-0000-4000-8000-000000000a03', r4: 'cc0d5a11-0000-4000-8000-000000000a05',
  fpR1: 'cc0d5a11-0000-4000-8000-000000000b00', fpR4: 'cc0d5a11-0000-4000-8000-000000000b30',
};
const SUB = `/${V.sheet}/`;

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
/** A request with its latency and the answer's size as JSON, measured in the page. */
const timed = <T = Record<string, unknown>>(page: Page, op: string, args?: unknown): Promise<{ ms: number; bytes: number; result: T }> => page.evaluate(async ([o, a]) => {
  const t0 = performance.now();
  const result = await (window as unknown as Harness).__bridge.request(o as string, a);
  const ms = Math.round((performance.now() - t0) * 100) / 100;
  return { ms, bytes: new TextEncoder().encode(JSON.stringify(result)).byteLength, result };
}, [op, args] as const) as Promise<{ ms: number; bytes: number; result: T }>;
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const fiveOf = async (page: Page, op: string, args?: unknown): Promise<{ ms: number[]; bytes: number }> => {
  const ms: number[] = [];
  let bytes = 0;
  for (let i = 0; i < 5; i++) { const t = await timed(page, op, args); ms.push(t.ms); bytes = t.bytes; }
  return { ms, bytes };
};

async function boot(page: Page, fixture: string, frame: 'sch' | 'pcb'): Promise<void> {
  await page.goto(`/parent.html?fixture=${fixture}&frame=${frame}`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  await expect(page.locator('#state')).toContainText(`opened ${fixture}.kicad_${frame}`, { timeout: 120_000 });
  await page.waitForTimeout(1_500);   // ev.edited's baseline
}
const depthNow = async (page: Page): Promise<number> => ((await request(page, 'symbols.get', { variant: '', items: [{ uuid: V.r1, sheetPath: `/` }] })) as unknown as Table).depth;

// One frame per test: a second page.goto in one test hung in Firefox (the frame's leave guard), so each boot is its own test.
test('a sch frame lists symbols, symbolExchange, schEdit and settings, none of the board\'s', async ({ page }) => {
  await boot(page, 'variants', 'sch');
  const caps = (await of(page, 'ev.ready'))[0]?.caps ?? [];
  expect(caps).toEqual(expect.arrayContaining(['symbols', 'symbolExchange', 'schEdit', 'settings', 'kicadSymbolsGet', 'kicadSettingsSet']));
  for (const c of ['boardFootprints', 'boardEdit', 'footprintExchange']) expect(caps).not.toContain(c);
  expect(await refusal(page, 'board.footprints')).toBe('unsupported: a board op runs in a pcb frame');
  expect(await refusal(page, 'settings.get', { section: 'customRules' })).toBe('unsupported: customRules is a board setting');
});

test('a pcb frame lists boardFootprints, boardEdit, footprintExchange and settings, none of the schematic\'s', async ({ page }) => {
  await boot(page, 'variants', 'pcb');
  const pcb = (await of(page, 'ev.ready'))[0]?.caps ?? [];
  expect(pcb).toEqual(expect.arrayContaining(['boardFootprints', 'boardEdit', 'footprintExchange', 'settings']));
  for (const c of ['symbols', 'symbolExchange', 'schEdit']) expect(pcb).not.toContain(c);
  expect(await refusal(page, 'symbols.get', { variant: '', scope: 'all' })).toBe('unsupported: a schematic edits in a sch frame');
});

test('symbols.get on the variants fixture: every part under each variant, a sheet\'s own flag, the power symbol counted', async ({ page }) => {
  await boot(page, 'variants', 'sch');
  const t = await timed<Table>(page, 'symbols.get', { variant: '', scope: 'all' });
  const base = t.result;
  measure('symbols.get, variants, all', `${t.ms} ms, ${t.bytes} bytes, ${base.rows.length} rows, ${base.power} power`);
  expect(base.variants.sort()).toEqual(['Lite', 'Pro']);
  expect(base.power).toBe(1);
  const byRef = (tb: Table): Record<string, Row> => Object.fromEntries(tb.rows.map((r) => [r.ref, r]));
  const b = byRef(base);
  expect(Object.keys(b).sort()).toEqual(['R1', 'R2', 'R3', 'R4']);
  expect(b.R1).toMatchObject({ uuid: V.r1, sheetPath: `/`, value: '10k', footprint: 'Resistor_SMD:R_0603_1608Metric', dnp: false, overrides: [], pins: 2, filters: ['R_*'] });
  expect(b.R1.fields.find((f) => f.name === 'MPN')).toEqual({ name: 'MPN', value: 'RC0603FR-0710KL', shown: false });
  expect(b.R4).toMatchObject({ uuid: V.r4, sheetPath: SUB, dnp: true, sheetHeld: ['dnp'] });
  const lite = byRef((await request(page, 'symbols.get', { variant: 'Lite', scope: 'all' })) as unknown as Table);
  expect(lite.R2).toMatchObject({ dnp: true, overrides: ['dnp'] });
  expect(lite.R3).toMatchObject({ value: '1k', overrides: [] });
  const pro = byRef((await request(page, 'symbols.get', { variant: 'Pro', scope: 'all' })) as unknown as Table);
  expect(pro.R3).toMatchObject({ value: '4k7', overrides: ['value'] });
  expect(pro.R2).toMatchObject({ dnp: false });
  const asked = (await request(page, 'symbols.get', { variant: '', items: [{ uuid: V.r4, sheetPath: SUB }, { uuid: V.r1, sheetPath: '/' }] })) as unknown as Table;
  expect(asked.rows.map((r) => r.ref)).toEqual(['R4', 'R1']);
  expect(await refusal(page, 'symbols.get', { variant: 'Max', scope: 'all' })).toBe('no_variant: Max');
  expect(await refusal(page, 'symbols.get', { variant: '', scope: 'some' })).toBe('bad_args: symbols.get');
});

test('symbols.set: one undo step per set, a variant\'s values and clears, Ctrl+Z takes it back; the variant\'s refusals', async ({ page }) => {
  await boot(page, 'variants', 'sch');
  const edits0 = (await of(page, 'ev.edited')).length;
  const d0 = await depthNow(page);
  const t = await timed(page, 'symbols.set', { variant: '', changes: [{ uuid: V.r1, sheetPath: '/', set: { value: '22k', inPos: false, fields: [{ name: 'MPN', value: 'X1' }] } }] });
  measure('symbols.set, one change', `${t.ms} ms: ${JSON.stringify(t.result)}`);
  expect(t.result).toEqual({ applied: 1, depth: d0 + 1 });
  await expect.poll(async () => (await of(page, 'ev.edited')).length, { timeout: 5_000 }).toBe(edits0 + 1);
  const r1 = ((await request(page, 'symbols.get', { variant: '', items: [{ uuid: V.r1, sheetPath: '/' }] })) as unknown as Table).rows[0];
  expect(r1).toMatchObject({ value: '22k', inPos: false });
  expect(r1.fields.find((f) => f.name === 'MPN')?.value).toBe('X1');
  // Under a variant: R1's value in Lite, then cleared.
  expect(await request(page, 'symbols.set', { variant: 'Lite', changes: [{ uuid: V.r1, sheetPath: '/', set: { value: '47k', dnp: true } }] })).toMatchObject({ applied: 1 });
  const liteR1 = ((await request(page, 'symbols.get', { variant: 'Lite', items: [{ uuid: V.r1, sheetPath: '/' }] })) as unknown as Table).rows[0];
  expect(liteR1).toMatchObject({ value: '47k', dnp: true });
  expect(liteR1.overrides.sort()).toEqual(['dnp', 'value']);
  expect(((await request(page, 'symbols.get', { variant: '', items: [{ uuid: V.r1, sheetPath: '/' }] })) as unknown as Table).rows[0]).toMatchObject({ value: '22k', dnp: false });
  expect(await request(page, 'symbols.set', { variant: 'Lite', changes: [{ uuid: V.r1, sheetPath: '/', set: { clear: ['value', 'dnp'] } }] })).toMatchObject({ applied: 1 });
  expect(((await request(page, 'symbols.get', { variant: 'Lite', items: [{ uuid: V.r1, sheetPath: '/' }] })) as unknown as Table).rows[0]).toMatchObject({ value: '22k', dnp: false, overrides: [] });
  const depth = await depthNow(page);
  measure('symbols.set, the depth after four sets', `${d0} to ${depth}`);
  expect(await request(page, 'key.press', UNDO)).toEqual({});
  await expect.poll(() => depthNow(page), { timeout: 5_000 }).toBe(depth - 1);
  // Refused before any effect.
  expect(await refusal(page, 'symbols.set', { variant: 'Max', changes: [{ uuid: V.r1, sheetPath: '/', set: { dnp: true } }] })).toBe('no_variant: Max');
  expect(await refusal(page, 'symbols.set', { variant: 'Lite', changes: [{ uuid: V.r1, sheetPath: '/', set: { ref: 'R9' } }] })).toBe('bad_args: symbols.set');
  expect(await refusal(page, 'symbols.set', { variant: '', changes: [{ uuid: V.r4, sheetPath: '/', set: { dnp: true } }] })).toBe(`not_found: ${V.r4} on /`);
});

test('symbols.exchange and sch.edit: previews push nothing, an apply is one undo step', async ({ page }) => {
  await boot(page, 'variants', 'sch');
  const d0 = await depthNow(page);
  const upd = await timed(page, 'symbols.exchange', { mode: 'update', targets: [{ uuid: V.r1, sheetPath: '/' }], libId: '', fields: 'all', options: { resetText: true }, preview: true });
  measure('symbols.exchange, update preview of R1', `${upd.ms} ms: ${JSON.stringify(upd.result)}`);
  const chg = await timed(page, 'symbols.exchange', { mode: 'change', targets: [{ uuid: V.r2, sheetPath: '/' }], libId: 'Device:R_Small', fields: 'all', options: {}, preview: true });
  measure('symbols.exchange, change preview of R2', `${chg.ms} ms: ${JSON.stringify(chg.result)}`);
  expect(await depthNow(page)).toBe(d0);
  const pre = await timed<EditReport>(page, 'sch.edit', { op: 'textGraphics', preview: true, filter: { references: true }, set: { size: 1.5 } });
  measure('sch.edit, references size preview', `${pre.ms} ms: ${pre.result.count} rows, first ${JSON.stringify(pre.result.rows[0])}`);
  expect(pre.result).toMatchObject({ op: 'textGraphics', preview: true, depth: d0 });
  expect(pre.result.count).toBeGreaterThanOrEqual(4);
  expect(await depthNow(page)).toBe(d0);
  const app = await timed<EditReport>(page, 'sch.edit', { op: 'textGraphics', preview: false, filter: { references: true }, set: { size: 1.5 } });
  measure('sch.edit, references size apply', `${app.ms} ms: ${app.result.count} rows, depth ${app.result.depth}`);
  expect(app.result.depth).toBe(d0 + 1);
  expect(await refusal(page, 'sch.edit', { op: 'textGraphics', preview: true, filter: { references: true }, set: { color: 'red' } })).toBe('bad_args: sch.edit');
});

test('settings in a sch frame: every section read, text variables and net classes set and read back, variant actions, no undo step', async ({ page }) => {
  await boot(page, 'variants', 'sch');
  const d0 = await depthNow(page);
  for (const section of ['netClasses', 'textVariables', 'variants', 'page', 'schFormatting', 'fieldTemplates', 'busAliases', 'ercSeverities', 'pinMap']) {
    const t = await timed(page, 'settings.get', { section });
    measure(`settings.get ${section}, variants`, `${t.ms} ms, ${t.bytes} bytes, keys ${Object.keys(t.result).slice(0, 12).join(' ')}`);
  }
  const variants = await request(page, 'settings.get', { section: 'variants' });
  expect(variants).toMatchObject({ current: '' });
  expect(JSON.stringify(variants)).toContain('R2 not fitted');
  const tv = await timed(page, 'settings.set', { section: 'textVariables', value: { REV: 'B' } });
  measure('settings.set textVariables', `${tv.ms} ms: ${JSON.stringify(tv.result)}`);
  expect((tv.result as { value: Record<string, unknown> }).value).toMatchObject({ REV: 'B' });
  expect(await request(page, 'settings.get', { section: 'textVariables' })).toMatchObject({ REV: 'B' });
  const nc = await request(page, 'settings.get', { section: 'netClasses' }) as { classes: Array<Record<string, unknown>> };
  const classes = nc.classes.map((c) => (c.name === 'Default' ? { ...c, clearance: 0.25 } : c));
  const set = await timed(page, 'settings.set', { section: 'netClasses', value: { classes } });
  measure('settings.set netClasses', `${set.ms} ms`);
  expect(((await request(page, 'settings.get', { section: 'netClasses' })) as typeof nc).classes.find((c) => c.name === 'Default')?.clearance).toBe(0.25);
  expect(await request(page, 'settings.set', { section: 'variants', value: { add: 'Max' } })).toMatchObject({ value: { current: '' } });
  expect(JSON.stringify(await request(page, 'settings.get', { section: 'variants' }))).toContain('Max');
  expect(((await request(page, 'symbols.get', { variant: 'Max', scope: 'all' })) as unknown as Table).variants).toContain('Max');
  expect(await request(page, 'settings.set', { section: 'variants', value: { delete: 'Max' } })).toBeTruthy();
  expect(await depthNow(page)).toBe(d0);
  expect(await refusal(page, 'settings.set', { section: 'pinMap', value: { pin_map: 'no' } })).toMatch(/^bad_args: /);
});

test('board.footprints and settings on the variants board: the paths, the sheet\'s do not populate, variants read only', async ({ page }) => {
  await boot(page, 'variants', 'pcb');
  const t = await timed<{ footprints: Array<{ uuid: string; ref: string; symbolPath: string; dnp: boolean; value: string }>; variant: string; truncated: boolean }>(page, 'board.footprints');
  measure('board.footprints, variants', `${t.ms} ms, ${t.bytes} bytes`);
  expect(t.result.variant).toBe('');
  expect(t.result.footprints.map((f) => [f.ref, f.symbolPath, f.dnp])).toEqual([['R1', `/${V.r1}`, false], ['R2', `/${V.r2}`, false], ['R3', `/${V.r3}`, false], ['R4', `/${V.sheet}/${V.r4}`, true]]);
  const v = await request(page, 'settings.get', { section: 'variants' });
  measure('settings.get variants, the board', JSON.stringify(v));
  expect(await refusal(page, 'settings.set', { section: 'variants', value: { add: 'Max' } })).toBe('unsupported: the board takes variants through Update the board');
});

test('the custom rules on drc-small: a dry run answers drc-badrules\' errors and writes nothing, an apply writes the file and sends it', async ({ page }) => {
  await boot(page, 'drc-small', 'pcb');
  const bad = await page.evaluate(async () => (await fetch('/fixtures/drc-badrules/drc-small.kicad_dru')).text());
  const good = await page.evaluate(async () => (await fetch('/fixtures/drc-small/drc-small.kicad_dru')).text());
  const saved0 = (await of(page, 'ev.saved')).length;
  const dry = await timed(page, 'settings.set', { section: 'customRules', value: { text: bad }, dryRun: true });
  measure('settings.set customRules, dry run of drc-badrules', `${dry.ms} ms: ${JSON.stringify(dry.result)}`);
  expect((dry.result as { errors?: unknown[] }).errors?.length).toBeGreaterThan(0);
  expect(await refusal(page, 'settings.set', { section: 'customRules', value: { text: bad } })).toMatch(/^rules_invalid: /);
  expect((await request(page, 'settings.get', { section: 'customRules' })).text).toBe(good);
  const clean = await timed(page, 'settings.set', { section: 'customRules', value: { text: good }, dryRun: true });
  expect(clean.result).not.toHaveProperty('errors');
  expect((await of(page, 'ev.saved')).length).toBe(saved0);
  const next = `${good}\n(rule "Wide"\n  (constraint track_width (min 0.3mm))\n  (condition "A.NetClass == 'Power'"))\n`;
  const app = await timed(page, 'settings.set', { section: 'customRules', value: { text: next } });
  measure('settings.set customRules, an apply', `${app.ms} ms`);
  const saved = (await of(page, 'ev.saved')).filter((e) => e.path === 'drc-small.kicad_dru');
  expect(saved).toHaveLength(1);
  expect(saved[0].text).toBe(next);
  expect((await request(page, 'settings.get', { section: 'customRules' })).text).toBe(next);
  // A layers dry run counts what removing copper layers would delete.
  const layers = await timed(page, 'settings.set', { section: 'layers', value: { copperCount: 2 }, dryRun: true });
  measure('settings.set layers, dry run', `${layers.ms} ms: wouldRemove ${(layers.result as { wouldRemove?: number }).wouldRemove}`);
});

test('Glasgow\'s schematic, timed: symbols.get, a 263-row symbols.set and its undo, its sections', async ({ page }) => {
  test.setTimeout(600_000);
  await boot(page, 'glasgow', 'sch');
  const all = await fiveOf(page, 'symbols.get', { variant: '', scope: 'all' });
  const table = (await request(page, 'symbols.get', { variant: '', scope: 'all' })) as unknown as Table;
  measure('symbols.get, Glasgow, all (five)', `${all.ms.join(', ')} ms; median ${median(all.ms)} ms; ${all.bytes} bytes; ${table.rows.length} rows, ${table.power} power`);
  const one = table.rows[0];
  const set1 = await timed(page, 'symbols.set', { variant: '', changes: [{ uuid: one.uuid, sheetPath: one.sheetPath, set: { inPos: !one.inPos } }] });
  measure('symbols.set, Glasgow, one change', `${set1.ms} ms`);
  const changes = table.rows.map((r) => ({ uuid: r.uuid, sheetPath: r.sheetPath, set: { inPos: false } }));
  const before = table.depth;
  const big = await timed<{ applied: number; depth: number }>(page, 'symbols.set', { variant: '', changes });
  measure(`symbols.set, Glasgow, ${changes.length} changes`, `${big.ms} ms: ${JSON.stringify(big.result)}`);
  expect(big.result.depth).toBe(before + 2);
  expect(((await request(page, 'symbols.get', { variant: '', scope: 'all' })) as unknown as Table).rows.every((r) => !r.inPos)).toBe(true);
  expect(await request(page, 'key.press', UNDO)).toEqual({});
  await expect.poll(async () => ((await request(page, 'symbols.get', { variant: '', scope: 'all' })) as unknown as Table).depth, { timeout: 10_000 }).toBe(before + 1);
  for (const section of ['netClasses', 'ercSeverities', 'pinMap']) {
    const g = await fiveOf(page, 'settings.get', { section });
    measure(`settings.get ${section}, Glasgow schematic (five)`, `median ${median(g.ms)} ms, ${g.bytes} bytes`);
  }
});

test('Glasgow\'s board, timed: board.footprints, every board section and every board edit previewed', async ({ page }) => {
  test.setTimeout(600_000);
  await boot(page, 'glasgow', 'pcb');
  const fps = await fiveOf(page, 'board.footprints');
  measure('board.footprints, Glasgow (five)', `${fps.ms.join(', ')} ms; median ${median(fps.ms)} ms; ${fps.bytes} bytes`);
  for (const section of ['netClasses', 'textVariables', 'variants', 'page', 'layers', 'stackup', 'finish', 'textDefaults', 'constraints', 'predefinedSizes', 'teardrops', 'checkSeverities', 'customRules']) {
    const g = await fiveOf(page, 'settings.get', { section });
    measure(`settings.get ${section}, Glasgow board (five)`, `median ${median(g.ms)} ms, ${g.bytes} bytes`);
  }
  const constraints = (await request(page, 'settings.get', { section: 'constraints' })) as { rules: Record<string, number> };
  const cset = await timed(page, 'settings.set', { section: 'constraints', value: { rules: { min_clearance: constraints.rules.min_clearance } } });
  measure('settings.set constraints, Glasgow (the same value back)', `${cset.ms} ms`);
  const d0 = ((await request(page, 'board.edit', { op: 'repair', preview: true, filter: {}, set: {} })) as unknown as EditReport).depth;
  const previews: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ['cleanupTracks', {}, { mergeCollinear: true, removeDangling: true, removeShorts: true, redundantVias: true, tracksInPads: true }],
    ['tracksVias', { tracks: true, vias: true }, { width: 'netclass' }],
    ['textGraphics', { references: true, values: true }, { height: 0.8 }],
    ['teardrops', { roundPads: true, rectPads: true, vias: true }, { on: true }],
    ['swapLayers', {}, { map: { 'In1.Cu': 'In2.Cu' } }],
    ['deleteGlobal', { texts: true }, {}],
    ['unusedPads', {}, { vias: true, pads: true }],
    ['cleanupGraphics', {}, { mergeRects: true, fixOutline: true }],
    ['repair', {}, {}],
  ];
  for (const [op, filter, set] of previews) {
    const r = await timed<EditReport>(page, 'board.edit', { op, preview: true, filter, set }).catch((e: Error) => ({ ms: -1, bytes: 0, result: { error: e.message } as unknown as EditReport }));
    measure(`board.edit ${op} preview, Glasgow`, r.ms < 0 ? `refused: ${(r.result as unknown as { error: string }).error}` : `${r.ms} ms: ${r.result.count} rows, notes ${r.result.notes.length}, first ${JSON.stringify(r.result.rows[0] ?? null)}`);
    if (r.ms >= 0) expect(r.result.depth).toBe(d0);
  }
  // The copper areas, as the layer swap's preview names them: their priorities reversed, previewed.
  const swapped = (await request(page, 'board.edit', { op: 'swapLayers', preview: true, filter: {}, set: { map: { 'In1.Cu': 'In2.Cu' } } })) as unknown as EditReport;
  const zones = [...new Set(swapped.rows.filter((r) => r.kind === 'zone').map((r) => r.uuid))];
  expect(zones.length).toBeGreaterThan(0);
  const zo = await timed<EditReport>(page, 'board.edit', { op: 'zoneOrder', preview: true, filter: {}, set: { order: [...zones].reverse() } });
  measure('board.edit zoneOrder preview, Glasgow', `${zo.ms} ms: ${zones.length} areas, ${zo.result.count} rows, first ${JSON.stringify(zo.result.rows[0] ?? null)}`);
  expect(zo.result.depth).toBe(d0);
  // Glasgow holds board-only footprints all named REF** (unnumbered): the engine counts them as one designator twice and refuses.
  const ann = await refusal(page, 'board.edit', { op: 'reannotate', preview: true, filter: {}, set: { order: 0 } });
  measure('board.edit reannotate preview, Glasgow', ann);
  expect(ann).toMatch(/^duplicate_designator: two parts would share a designator: Duplicate instances of REF\*\*/);
  const fx = await timed(page, 'footprints.exchange', { mode: 'update', match: { ref: 'R1' }, libId: '', options: {}, preview: true });
  measure('footprints.exchange, update preview of R1, Glasgow', `${fx.ms} ms: ${JSON.stringify(fx.result)}`);
});

test('board.edit reannotate on the variants board: the rows carry the symbol paths, one undo step, Ctrl+Z takes it back', async ({ page }) => {
  await boot(page, 'variants', 'pcb');
  const pre = await timed<EditReport>(page, 'board.edit', { op: 'reannotate', preview: true, filter: {}, set: { order: 0, frontStart: 11 } });
  measure('board.edit reannotate preview, variants', `${pre.ms} ms: ${JSON.stringify(pre.result.rows)}`);
  const d0 = pre.result.depth;
  expect(pre.result.rows.map((r) => [r.from, r.to, r.symbolPath])).toEqual([
    ['R1', 'R11', `/${V.r1}`], ['R2', 'R12', `/${V.r2}`], ['R3', 'R13', `/${V.r3}`], ['R4', 'R14', `/${V.sheet}/${V.r4}`],
  ]);
  const app = await timed<EditReport>(page, 'board.edit', { op: 'reannotate', preview: false, filter: {}, set: { order: 0, frontStart: 11 } });
  expect(app.result.depth).toBe(d0 + 1);
  const refs = async () => ((await request(page, 'board.footprints')) as { footprints: Array<{ ref: string }> }).footprints.map((f) => f.ref);
  expect(await refs()).toEqual(['R11', 'R12', 'R13', 'R14']);
  expect(await request(page, 'key.press', UNDO)).toEqual({});
  await expect.poll(refs, { timeout: 5_000 }).toEqual(['R1', 'R2', 'R3', 'R4']);
  expect(await refusal(page, 'board.edit', { op: 'reannotate', preview: true, filter: { all: true }, set: {} })).toBe('bad_args: board.edit');
});

test('symbols.exchange from the library mirror: a symbol changed as one undo step', async ({ page }) => {
  test.skip(process.env.LIBS_DIR == null, 'needs a library mirror: LIBS_DIR=<the directory served as /libs/> (tests/libs/make-mirror.mjs builds one)');
  await boot(page, 'variants', 'sch');
  const d0 = await depthNow(page);
  const pre = await timed(page, 'symbols.exchange', { mode: 'change', targets: [{ uuid: V.r2, sheetPath: '/' }], libId: 'Device:R_Small', fields: 'all', options: {}, preview: true });
  measure('symbols.exchange, change preview of R2, mirror', `${pre.ms} ms: ${JSON.stringify(pre.result)}`);
  expect(pre.result).toMatchObject({ preview: true, applied: 1, rows: [{ ref: 'R2', from: 'Device:R', to: 'Device:R_Small', status: 'changed' }], depth: d0 });
  const app = await timed(page, 'symbols.exchange', { mode: 'change', targets: [{ uuid: V.r2, sheetPath: '/' }], libId: 'Device:R_Small', fields: 'all', options: {}, preview: false });
  measure('symbols.exchange, change of R2, mirror', `${app.ms} ms`);
  expect(app.result).toMatchObject({ preview: false, applied: 1, depth: d0 + 1 });
  expect(((await request(page, 'symbols.get', { variant: '', items: [{ uuid: V.r2, sheetPath: '/' }] })) as unknown as Table).rows[0]).toMatchObject({ value: '10k' });
  const upd = await timed(page, 'symbols.exchange', { mode: 'update', targets: [{ uuid: V.r1, sheetPath: '/' }], libId: '', fields: 'all', options: {}, preview: true });
  measure('symbols.exchange, update preview of R1, mirror', `${upd.ms} ms: ${JSON.stringify(upd.result)}`);
});

test('footprints.exchange from the library mirror: every footprint previewed, one changed as one undo step', async ({ page }) => {
  test.skip(process.env.LIBS_DIR == null, 'needs a library mirror: LIBS_DIR=<the directory served as /libs/> (tests/libs/make-mirror.mjs builds one)');
  await boot(page, 'variants', 'pcb');
  const fpre = await timed(page, 'footprints.exchange', { mode: 'update', match: { all: true }, libId: '', options: {}, preview: true });
  measure('footprints.exchange, update preview of all, mirror', `${fpre.ms} ms: ${JSON.stringify(fpre.result)}`);
  const fdepth = (fpre.result as { depth: number }).depth;
  const fapp = await timed(page, 'footprints.exchange', { mode: 'change', match: { uuids: [V.fpR1] }, libId: 'Resistor_SMD:R_0805_2012Metric', options: {}, preview: false });
  measure('footprints.exchange, change of R1 to 0805, mirror', `${fapp.ms} ms: ${JSON.stringify(fapp.result)}`);
  expect(fapp.result).toMatchObject({ preview: false, applied: 1, depth: fdepth + 1 });
  expect(((await request(page, 'board.footprints')) as { footprints: Array<{ ref: string; libId: string }> }).footprints.find((f) => f.ref === 'R1')?.libId).toBe('Resistor_SMD:R_0805_2012Metric');
});
