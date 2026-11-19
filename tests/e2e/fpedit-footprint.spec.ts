// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// island v0.2.3-cc25 over the local pair (PROTOCOL.md "The footprint's
// properties, its embedded files, the checker, Tidy and the SVG"):
// fpedit.footprint.get and set, fpedit.embed, fpedit.check, fpedit.cleanup
// and fpedit.svg on the open footprint of an fpedit frame, through our
// engine's run 15 exports (unit fp-e5 and fp-e6), each change one undo step
// of KiCad's, Ctrl+Z through key.press restoring it. The fixtures are
// tests/fixtures/fpedit-small (the SOIC, CHECKME.kicad_mod) and its body.step,
// kicad-packages3D's own SOIC-8 model at tag 10.0.6.
//
// The first test runs on every engine: outside an fpedit frame every op is
// unsupported, and an fpedit frame on an engine without the footprint
// editor's exports lists no fpedit cap and answers each op unsupported
// naming kicadFpEditOpen. Every other test opens a footprint, which needs
// engine run 15; on an engine without it the test is skipped.
import { expect, test, type Page } from '@playwright/test';

interface Ev { type: string; phase?: string; caps?: string[]; depth?: number; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Props { name: string; description: string; fields: Array<{ name: string; kind: string; value: string }>; type: string;
  allowMissingCourtyard: boolean; models: Array<Record<string, unknown>>; embedded: Array<{ name: string; type: string; bytes: number }>; userLayerNames: Record<string, string> }

const SMALL = '/fixtures/fpedit-small';
const SOIC = 'SOIC-8_3.9x4.9mm_P1.27mm';
const FRAME_ONLY = 'unsupported: a footprint edits in an fpedit frame';
const OPS = ['fpedit.footprint.get', 'fpedit.footprint.set', 'fpedit.embed', 'fpedit.check', 'fpedit.cleanup', 'fpedit.svg'];
const UNDO = { key: 'z', code: 'KeyZ', ctrl: true };
const TIDY = { mergeRects: true, deleteRedundant: true, mergePads: false, repair: true, dryRun: true };

const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const request = (page: Page, op: string, args?: unknown): Promise<Record<string, unknown>> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const);
const refusal = (page: Page, op: string, args?: unknown): Promise<string> =>
  request(page, op, args).then(() => 'ok', (err: Error) => err.message.split('\n')[0].replace(/^.*?page\.evaluate:\s*/, '').replace(/^Error:\s*/, ''));
const text = (page: Page, path: string): Promise<string> => page.evaluate(async (p) => (await fetch(p)).text(), path);
const depth = async (page: Page): Promise<number> => (await request(page, 'fpedit.state')).depth as number;
const props = async (page: Page): Promise<Props> => (await request(page, 'fpedit.footprint.get')) as unknown as Props;

async function boot(page: Page, frame: string): Promise<string[]> {
  await page.goto(`/parent.html?frame=${frame}`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  expect((await events(page)).filter((e) => e.type === 'ev.state' && (e.phase === 'fatal' || e.phase === 'blocked'))).toEqual([]);
  return ((await events(page)).find((e) => e.type === 'ev.ready')?.caps ?? []).filter((c) => !/^kicad/.test(c));
}
/** Boots an fpedit frame and opens `file` of the fixture, or skips on an engine without the footprint editor. */
async function openFootprint(page: Page, file: string, name: string): Promise<void> {
  const caps = await boot(page, 'fpedit');
  test.skip(!caps.includes('fpedit'), 'the footprint editor needs engine run 15 (island cc25)');
  await request(page, 'fpedit.open', { text: await text(page, `${SMALL}/${file}`), name, lib: 'fpedit-small_parts', mode: 'library', discard: true });
}
/** Ctrl+Z through key.press, the undo depth back to `d`. */
async function undoTo(page: Page, d: number): Promise<void> {
  expect(await request(page, 'key.press', UNDO)).toEqual({});
  await expect.poll(() => depth(page), { timeout: 5_000 }).toBe(d);
}

test('outside an fpedit frame every op is unsupported; an engine without the footprint editor names its first export (any engine)', async ({ page }) => {
  const caps = await boot(page, 'pcb');
  expect(caps).not.toContain('fpedit');
  for (const op of OPS) expect(await refusal(page, op, {}), op).toBe(FRAME_ONLY);
  const fp = await boot(page, 'fpedit');
  if (!fp.includes('fpedit')) for (const op of OPS) expect(await refusal(page, op, op === 'fpedit.cleanup' ? TIDY : op === 'fpedit.footprint.set' ? { set: { dnp: true } } : op === 'fpedit.embed' ? { remove: 'x' } : {}), op).toBe('unsupported: kicadFpEditOpen');
});

test('get reads the SOIC as KiCad\'s dialog shows it; each set is one undo step, undone by Ctrl+Z; the engine\'s refusals change nothing', async ({ page }) => {
  await openFootprint(page, `fpedit-small_parts.pretty/${SOIC}.kicad_mod`, SOIC);
  const p0 = await props(page);
  expect(p0.name).toBe(SOIC);
  expect(p0.fields.slice(0, 4).map((f) => [f.name, f.kind])).toEqual([['Reference', 'reference'], ['Value', 'value'], ['Datasheet', 'datasheet'], ['Description', 'description']]);
  expect(p0.type).toBe('smd');
  expect(p0.embedded).toEqual([]);
  const d0 = await depth(page);
  for (const set of [{ description: 'probe' }, { addField: { name: 'MPN', value: 'X', visible: false, layer: 'F.Fab' } }, { allowMissingCourtyard: true },
    { models: [{ path: 'body.step', offset: [0, 0, 1], rotate: [0, 0, 0], scale: [2, 2, 2], opacity: 1, show: true }] }]) {
    const after = (await request(page, 'fpedit.footprint.set', { set })) as unknown as Props;
    expect(await depth(page), `${Object.keys(set).join(' ')} is one undo step`).toBe(d0 + 1);
    expect((await request(page, 'fpedit.state')).modified).toBe(true);
    if ('description' in set) expect(after.description).toBe('probe');
    if ('addField' in set) expect(after.fields.map((f) => f.name)).toContain('MPN');
    if ('allowMissingCourtyard' in set) expect(after.allowMissingCourtyard).toBe(true);
    if ('models' in set) expect(after.models).toEqual(set.models);
    await undoTo(page, d0);
    expect(await props(page)).toEqual(p0);
  }
  for (const set of [{ removeField: 'Reference' }, { jumpers: { duplicateNumbersAreJumpers: false, groups: [['99']] } }]) {
    expect(await refusal(page, 'fpedit.footprint.set', { set }), JSON.stringify(set)).toBe('bad_args: fpedit.footprint.set');
  }
  expect(await refusal(page, 'fpedit.footprint.set', { set: { customStackup: { on: true, copperLayers: 3 } } })).toBe('bad_args: fpedit.footprint.set');
  expect(await refusal(page, 'fpedit.footprint.set', { set: { userLayerNames: { 'User.1': 'renamed here' } } })).toBe('bad_args: fpedit.footprint.set: userLayerNames is the editor\'s and read only');
  expect(await refusal(page, 'fpedit.footprint.set', { set: { embedded: [] } })).toBe('bad_args: fpedit.footprint.set');
  expect(await depth(page)).toBe(d0);
});

test('embed body.step: one undo step, the take carries it; remove it: one more; removing it again is not_found', async ({ page }) => {
  await openFootprint(page, `fpedit-small_parts.pretty/${SOIC}.kicad_mod`, SOIC);
  const bytes = await page.evaluate(async (p) => (await (await fetch(p)).arrayBuffer()).byteLength, `${SMALL}/body.step`);
  expect(bytes).toBeGreaterThan(1000);
  const d0 = await depth(page);
  const t0 = Date.now();
  const after = (await page.evaluate(async (p) => {
    const b = new Uint8Array(await (await fetch(p)).arrayBuffer());
    return (window as unknown as Harness).__bridge.request('fpedit.embed', { name: 'body.step', type: 'model', bytes: b });
  }, `${SMALL}/body.step`)) as unknown as Props;
  console.log(`fpedit.embed of ${bytes} bytes: ${Date.now() - t0} ms`);
  expect(after.embedded).toEqual([{ name: 'body.step', type: 'model', bytes }]);
  expect(await depth(page)).toBe(d0 + 1);
  expect(String((await request(page, 'fpedit.take')).text)).toContain('(embedded_files');
  const gone = (await request(page, 'fpedit.embed', { remove: 'body.step' })) as unknown as Props;
  expect(gone.embedded).toEqual([]);
  expect(await depth(page)).toBe(d0 + 2);
  expect(await refusal(page, 'fpedit.embed', { remove: 'body.step' })).toBe('not_found: body.step');
  expect(await refusal(page, 'fpedit.embed', { name: 'a/b', type: 'model', bytes: [1] })).toBe('bad_args: fpedit.embed');
});

test('the checker\'s exact findings on CHECKME; the SOIC has no missing courtyard', async ({ page }) => {
  await openFootprint(page, 'CHECKME.kicad_mod', 'CHECKME');
  const d0 = await depth(page);
  const findings = (await request(page, 'fpedit.check')).findings as Array<{ code: string; severity: string; message: string; uuids: string[]; pads: string[]; x: number | null; y: number | null }>;
  console.log('CHECKME findings:', JSON.stringify(findings.map((f) => [f.code, f.severity, f.pads])));
  const codes = new Set(findings.map((f) => f.code));
  for (const c of ['missing_courtyard', 'through_hole_pad_without_hole', 'shorting_items', 'silk_over_copper']) expect(codes, c).toContain(c);
  expect(findings.every((f) => f.code !== '' && f.message !== '')).toBe(true);
  const missing = findings.find((f) => f.code === 'missing_courtyard');
  expect(missing).toMatchObject({ x: null, y: null });
  expect(findings.find((f) => f.code === 'shorting_items')?.pads.sort()).toEqual(['2', '3']);
  expect(await depth(page)).toBe(d0);
  await request(page, 'fpedit.open', { text: await text(page, `${SMALL}/fpedit-small_parts.pretty/${SOIC}.kicad_mod`), name: SOIC, lib: 'fpedit-small_parts', mode: 'library', discard: true });
  const soic = (await request(page, 'fpedit.check')).findings as Array<{ code: string }>;
  expect(soic.map((f) => f.code)).not.toContain('missing_courtyard');
});

test('Tidy: a dry and a real cleanup of a line drawn twice; nothing to do changes nothing', async ({ page }) => {
  await openFootprint(page, `fpedit-small_parts.pretty/${SOIC}.kicad_mod`, SOIC);
  expect(await request(page, 'fpedit.cleanup', TIDY)).toEqual({ items: [], repaired: 0 });
  const d0 = await depth(page);
  expect(await request(page, 'fpedit.cleanup', { ...TIDY, dryRun: false })).toEqual({ items: [], repaired: 0 });
  expect(await depth(page)).toBe(d0);
  const twice = ['cc000000-0000-4000-8000-000000000301', 'cc000000-0000-4000-8000-000000000302'];
  await request(page, 'fpedit.items.add', { items: twice.map((uuid) => ({ kind: 'shape', uuid, layer: 'F.Fab', shape: 'segment', points: [[-1, 3], [1, 3]] })) });
  const d1 = await depth(page);
  const dry = (await request(page, 'fpedit.cleanup', TIDY)) as { items: Array<{ code: string; uuids: string[] }>; repaired: number };
  console.log('Tidy dry run:', JSON.stringify(dry));
  expect(dry.items.some((i) => i.code === 'duplicate_graphic' && i.uuids.some((u) => twice.includes(u)))).toBe(true);
  expect(await depth(page)).toBe(d1);
  const real = (await request(page, 'fpedit.cleanup', { ...TIDY, dryRun: false })) as { items: unknown[] };
  expect(real.items).toEqual(dry.items);
  expect(await depth(page)).toBe(d1 + 1);
  const left = ((await request(page, 'fpedit.items.get')).items as Array<{ uuid: string }>).filter((i) => twice.includes(i.uuid));
  expect(left).toHaveLength(1);
  await undoTo(page, d1);
  expect(((await request(page, 'fpedit.items.get')).items as Array<{ uuid: string }>).filter((i) => twice.includes(i.uuid))).toHaveLength(2);
});

test('the SVG: KiCad\'s plot of the SOIC, an SVG of at most 4 MiB', async ({ page }) => {
  await openFootprint(page, `fpedit-small_parts.pretty/${SOIC}.kicad_mod`, SOIC);
  const t0 = Date.now();
  const svg = await page.evaluate(async () => {
    const r = await (window as unknown as Harness).__bridge.request('fpedit.svg', {});
    const b = r.bytes as Uint8Array;
    return { size: b.byteLength, head: new TextDecoder().decode(b.slice(0, 200)), body: new TextDecoder().decode(b) };
  });
  console.log(`fpedit.svg: ${svg.size} bytes in ${Date.now() - t0} ms`);
  expect(svg.size).toBeGreaterThan(0);
  expect(svg.size).toBeLessThanOrEqual(4 * 1024 * 1024);
  expect(svg.head).toMatch(/^\s*(<\?xml|<svg)/);
  expect(svg.body).toContain('</svg>');
});
