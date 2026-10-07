// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The fast part picker's island half (PICKER.md) over the local pair: KiCad's
// place keys become ev.pick and its chooser never opens, and place puts a
// library item on the pointer from the mirror without the engine enumerating
// a library. The picker needs the mirror (ev.ready lists the pseudo-cap
// picker): the example library's test runs always, the others when the pair
// serves a mirror holding Device, MCU_ST_STM32F1, Connector and Package_QFP
// (LIBS_DIR, as tests/e2e/libs.spec.ts).
import { expect, test, type BrowserContext, type Frame, type Page } from '@playwright/test';
import pin from '../../PIN.json' with { type: 'json' };

declare const process: { env: Record<string, string | undefined> };

const ISLAND = 'http://editor.circuitcenter.localhost:4174';
const TAG = pin.libs.tag;
interface Ev { type: string; phase?: string; kind?: string; power?: boolean; depth?: number; open?: boolean; caps?: string[]; at: number }
interface Harness { __events: Ev[]; __saved: Record<string, Uint8Array>; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Registry { wxElementRegistry: { findAll(f: object): Array<{ typeName: string; name: string; label: string; centerX: number; centerY: number }> } }

function measure(type: string, description: string): void {
  test.info().annotations.push({ type, description });
  console.log(`[measure] ${type}: ${description}`);
}

const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const of = async (page: Page, type: string): Promise<Ev[]> => (await events(page)).filter((e) => e.type === type);
const request = (page: Page, op: string, args?: unknown): Promise<Record<string, unknown>> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const);
/** A request's refusal as "code: message" (the harness rejects with it; Playwright prefixes its own words), or "ok". */
const refusal = (page: Page, op: string, args?: unknown): Promise<string> =>
  request(page, op, args).then(() => 'ok', (err: Error) => { const first = err.message.split('\n')[0]; return first.slice(first.lastIndexOf('Error: ') + 'Error: '.length); });
/** The engine's visible top-level windows (its frame, a chooser frame or a dialog). */
const windows = (frame: Frame): Promise<string[]> =>
  frame.evaluate(() => (window as unknown as Registry).wxElementRegistry.findAll({ visible: true }).filter((e) => /Dialog|Frame/.test(e.typeName)).map((e) => e.name));
const savedText = (page: Page, path: string): Promise<string> =>
  page.evaluate((p) => new TextDecoder().decode((window as unknown as Harness).__saved[p]), path);

async function boot(page: Page, frameName: 'sch' | 'pcb', fixture = 'blank'): Promise<Frame> {
  await page.goto(`/parent.html?fixture=${fixture}&frame=${frameName}`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  expect(await of(page, 'ev.state').then((s) => s.filter((e) => e.phase === 'blocked' || e.phase === 'fatal'))).toEqual([]);
  await expect(page.locator('#state')).toContainText(`opened ${fixture}.kicad_${frameName}`, { timeout: 120_000 });
  const frame = page.frames().find((f) => f.url().startsWith(`${ISLAND}/`));
  if (frame == null) throw new Error('no island frame');
  return frame;
}

/** A point of the island's viewport, in the page. */
async function at(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const box = await page.locator('iframe').boundingBox();
  if (box == null) throw new Error('no iframe box');
  return { x: box.x + x, y: box.y + y };
}
async function clickIn(page: Page, x: number, y: number): Promise<void> {
  const p = await at(page, x, y);
  await page.mouse.click(p.x, p.y);
}
async function moveIn(page: Page, x: number, y: number): Promise<void> {
  const p = await at(page, x, y);
  await page.mouse.move(p.x, p.y, { steps: 4 });
}

/** Every /libs/ request the island makes, and the provider's log of each library op the engine asks for. */
function libsWatch(context: BrowserContext, page: Page) {
  const w = { net: [] as string[], ops: [] as string[], lines: [] as string[] };
  context.on('request', (r) => {
    const u = new URL(r.url());
    if (u.origin === ISLAND && u.pathname.startsWith('/libs/')) w.net.push(decodeURIComponent(u.pathname.replace(/^\/libs\/[^/]+\//, '')));
  });
  page.on('console', (m) => {
    const t = m.text();
    w.lines.push(t);
    const i = t.indexOf('[libs] request ');
    if (i >= 0) w.ops.push(t.slice(i + '[libs] request '.length));
  });
  return w;
}

/** The pointer goes to (x, y), the part is placed, and a press there commits it: resolves with the place's round trip in ms. */
async function placeAt(page: Page, kind: 'symbol' | 'footprint', lib: string, name: string, [x, y]: [number, number]): Promise<number> {
  await moveIn(page, x, y);
  const t0 = Date.now();
  expect(await request(page, 'place', { kind, lib, name })).toEqual({});
  const ms = Date.now() - t0;
  const before = (await of(page, 'ev.edited')).length;
  await moveIn(page, x + 6, y + 6);
  await clickIn(page, x + 6, y + 6);
  await expect.poll(async () => (await of(page, 'ev.edited')).length, { timeout: 15_000 }).toBeGreaterThan(before);
  return ms;
}

/** The direct child lists of one s-expression, each whole (quoted strings skipped). */
function children(sx: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let quoted = false;
  for (let i = 0; i < sx.length; i++) {
    const c = sx[i];
    if (quoted) { if (c === '\\') i++; else if (c === '"') quoted = false; continue; }
    if (c === '"') quoted = true;
    else if (c === '(') { depth++; if (depth === 2) start = i; }
    else if (c === ')') { if (depth === 2) out.push(sx.slice(start, i + 1)); depth--; }
  }
  return out;
}
const head = (sx: string): string => /^\(([^\s()]+)/.exec(sx)?.[1] ?? '';
const firstString = (sx: string): string | undefined => /^\([^\s()]+\s+"((?:[^"\\]|\\.)*)"/.exec(sx)?.[1];

/** A saved schematic's placed symbols (lib_id, Footprint, pins) and its lib_symbols cache (name, unit names, pins). */
function schematicFacts(text: string) {
  const top = children(text.trim());
  const cache = top.find((c) => head(c) === 'lib_symbols');
  const placed = top.filter((c) => head(c) === 'symbol').map((c) => {
    const kids = children(c);
    const prop = (name: string): string | undefined => kids.filter((k) => head(k) === 'property').find((k) => firstString(k) === name)?.match(/^\(property\s+"(?:[^"\\]|\\.)*"\s+"((?:[^"\\]|\\.)*)"/)?.[1];
    return { libId: firstString(kids.find((k) => head(k) === 'lib_id') ?? '') ?? '', reference: prop('Reference') ?? '', footprint: prop('Footprint') ?? '', pins: kids.filter((k) => head(k) === 'pin').length };
  });
  const cached = (cache == null ? [] : children(cache)).filter((c) => head(c) === 'symbol').map((c) => {
    const units = children(c).filter((u) => head(u) === 'symbol');
    return { name: firstString(c) ?? '', units: units.map((u) => firstString(u) ?? ''), pins: units.reduce((n, u) => n + children(u).filter((p) => head(p) === 'pin').length, 0), extends: children(c).some((k) => head(k) === 'extends') };
  });
  return { placed, cached };
}

test('without a mirror there is no picker: A opens KiCad\'s own chooser, lib.index answers no index, and place still puts the example library\'s R on the pointer', async ({ page, context }) => {
  // Refused whatever the pair serves: the island boots on its example library.
  await context.route('**/libs/**', (route) => route.fulfill({ status: 404, body: '' }));
  const frame = await boot(page, 'sch');
  expect((await of(page, 'ev.ready'))[0]?.caps).not.toContain('picker');
  expect(await request(page, 'lib.index', { kind: 'symbol' })).toEqual({ text: null });
  const body = await request(page, 'lib.item', { kind: 'symbol', lib: 'pcbjam-examples', name: 'R' });
  expect(String(body.body)).toContain('(symbol "R"');
  expect(await request(page, 'lib.item', { kind: 'symbol', lib: 'Device', name: 'R' })).toEqual({ body: null });
  expect(await refusal(page, 'place', { kind: 'symbol', lib: 'Device', name: 'R' })).toBe('not_found: Device:R');
  const ms = await placeAt(page, 'symbol', 'pcbjam-examples', 'R', [500, 400]);
  measure('place, example library', `${ms} ms from the request to the part on the pointer`);
  await request(page, 'project.save');
  expect(schematicFacts(await savedText(page, 'blank.kicad_sch')).placed.map((p) => [p.libId, p.pins])).toEqual([['pcbjam-examples:R', 2]]);
  // The place keys stay KiCad's: A opens its chooser, on the example library, and no ev.pick is sent.
  expect(await request(page, 'key.press', { key: 'a', code: 'KeyA' })).toEqual({});
  await expect.poll(() => windows(frame), { timeout: 60_000 }).toContain('dialog');
  expect(await of(page, 'ev.pick')).toEqual([]);
});

const PARTS: Array<[string, string, [number, number]]> = [
  ['MCU_ST_STM32F1', 'STM32F103C8Tx', [640, 420]],
  ['Device', 'R', [300, 250]],
  ['Connector', 'USB_C_Receptacle_USB2.0_16P', [950, 300]],
];
const QFP = 'Package_QFP:LQFP-48_7x7mm_P0.5mm';

test.describe('with a mirror', () => {
  test.skip(process.env.LIBS_DIR == null, 'needs a library mirror: LIBS_DIR=<the directory served as /libs/> (tests/libs/make-mirror.mjs builds one)');

  test('A and P in a schematic are ev.pick, and KiCad\'s chooser never opens; with a modifier, or under a dialog, a key is KiCad\'s', async ({ page }) => {
    const frame = await boot(page, 'sch', 'glasgow');
    // The picker is available: the mirror loaded and the engine places items.
    expect((await of(page, 'ev.ready'))[0]?.caps).toEqual(expect.arrayContaining(['picker', 'kicadPlaceImportedItem', 'kicadCollabGetSelection']));
    // A real press in the drawing gives the frame the keyboard; then the reader's own keys.
    await clickIn(page, 1100, 730);
    await page.keyboard.press('a');
    await expect.poll(() => of(page, 'ev.pick')).toHaveLength(1);
    await page.keyboard.press('p');
    await expect.poll(() => of(page, 'ev.pick')).toHaveLength(2);
    // The host's key.press of a place key takes the same path.
    expect(await request(page, 'key.press', { key: 'a', code: 'KeyA' })).toEqual({});
    await expect.poll(() => of(page, 'ev.pick')).toHaveLength(3);
    const picks = await of(page, 'ev.pick');
    expect(picks.map(({ at: _at, ...e }) => e)).toEqual([{ type: 'ev.pick', kind: 'symbol' }, { type: 'ev.pick', kind: 'symbol', power: true }, { type: 'ev.pick', kind: 'symbol' }]);
    // KiCad's chooser never opened: on the full mirror it would take 11 to 15 s, so 3 s of nothing is the island's.
    await page.waitForTimeout(3_000);
    expect(await windows(frame)).toEqual(['SchematicFrame']);
    expect(await of(page, 'ev.menu')).toEqual([]);
    // Under a dialog (KiCad's checker, its seeded chord) the key is KiCad's: no pick.
    await page.keyboard.press('Control+Alt+7');
    await expect.poll(() => windows(frame), { timeout: 15_000 }).toContain('DialogErcWindowName');
    await page.keyboard.press('a');
    await page.waitForTimeout(500);
    expect(await of(page, 'ev.pick')).toHaveLength(3);
  });

  test('A on a board is ev.pick for a footprint, and KiCad\'s footprint chooser never opens', async ({ page }) => {
    const frame = await boot(page, 'pcb', 'glasgow');
    await clickIn(page, 1100, 730);
    await page.keyboard.press('a');
    await expect.poll(async () => (await of(page, 'ev.pick')).map(({ at: _at, ...e }) => e)).toEqual([{ type: 'ev.pick', kind: 'footprint' }]);
    await page.waitForTimeout(3_000);
    expect(await windows(frame)).toEqual(['PcbFrame']);
  });

  test('the quiet warm-up, then place puts Device:R, the derived STM32F103C8Tx and a USB C receptacle on the pointer: each fetches its own library at most, none enumerates, and the save holds them whole', async ({ page, context }) => {
    const w = libsWatch(context, page);
    const frame = await boot(page, 'sch');
    const readyAt = (await events(page)).length;
    // The quiet warm-up: the symbol index, when the mirror has one, and the common libraries it holds, without a provider op.
    await expect.poll(() => w.lines.some((l) => l.includes('[libs] quiet symbol warm-up done')), { timeout: 30_000 }).toBe(true);
    const manifest = await frame.evaluate(async (tag) => (await fetch(`/libs/${tag}/manifest.json`)).json() as Promise<{ libs: Array<{ id: string }> }>, TAG);
    const common = ['Device', 'power', 'Connector', 'Connector_Generic', 'Switch', 'LED', 'Diode', 'Transistor_FET', 'Transistor_BJT', 'Regulator_Linear'].map((n) => `sym.${n}`).filter((id) => manifest.libs.some((l) => l.id === id));
    const warmed = w.net.filter((f) => f.endsWith('.bin')).sort();
    expect(warmed).toEqual(common.map((id) => `${id}.bin`).sort());
    expect(w.net.filter((f) => !f.endsWith('.bin') && f !== 'manifest.json').every((f) => f === 'sym-index.json')).toBe(true);
    expect(w.ops).toEqual([]);
    const done = w.lines.find((l) => l.includes('[libs] quiet symbol warm-up done')) ?? '';
    measure('quiet warm-up, schematic', `${w.net.filter((f) => f !== 'manifest.json').join(', ')} (${done.slice(done.indexOf('warm-up done'))})`);

    // Each place: its own bundle at most, and no op of the engine's but none at all (no enumeration).
    const taken: string[] = [];
    for (const [lib, name, spot] of PARTS) {
      const n0 = w.net.length;
      const o0 = w.ops.length;
      const ms = await placeAt(page, 'symbol', lib, name, spot);
      const fetched = w.net.slice(n0).filter((f) => f !== 'manifest.json');
      expect(fetched.every((f) => f === `sym.${lib}.bin`)).toBe(true);
      expect(w.ops.slice(o0).filter((o) => o.startsWith('op=list'))).toEqual([]);
      taken.push(`${lib}:${name} ${ms} ms (${fetched.length > 0 ? `cold: ${fetched.join(', ')} fetched` : 'warm'}; engine ops: ${w.ops.slice(o0).join(' | ') || 'none'})`);
    }
    // The derived MCU again, its bundle now held: the warm time.
    const warm = await placeAt(page, 'symbol', 'MCU_ST_STM32F1', 'STM32F103C8Tx', [640, 650]);
    taken.push(`MCU_ST_STM32F1:STM32F103C8Tx again ${warm} ms (warm)`);
    measure('place, schematic', taken.join('; '));
    // The fetches and placements changed nothing the host sees but ev.edited: no ev.state after the open.
    expect((await events(page)).slice(readyAt).filter((e) => e.type === 'ev.state')).toEqual([]);
    expect(await windows(frame)).toEqual(['SchematicFrame']);

    const saved = await request(page, 'project.save');
    expect(saved.saved).toContain('blank.kicad_sch');
    const sch = schematicFacts(await savedText(page, 'blank.kicad_sch'));
    expect(sch.placed.map((p) => p.libId).sort()).toEqual(['Connector:USB_C_Receptacle_USB2.0_16P', 'Device:R', 'MCU_ST_STM32F1:STM32F103C8Tx', 'MCU_ST_STM32F1:STM32F103C8Tx']);
    const byId = new Map(sch.placed.map((p) => [p.libId, p]));
    expect(byId.get('Device:R')?.pins).toBe(2);
    expect(byId.get('MCU_ST_STM32F1:STM32F103C8Tx')?.pins).toBe(48);
    expect(byId.get('Connector:USB_C_Receptacle_USB2.0_16P')?.pins).toBe(17);
    // The derived MCU's Footprint came down its extends chain; KiCad annotated each part.
    expect(byId.get('MCU_ST_STM32F1:STM32F103C8Tx')?.footprint).toBe(QFP);
    expect(sch.placed.map((p) => p.reference).sort()).toEqual(['J1', 'R1', 'U1', 'U2']);
    // lib_symbols holds each definition once, flattened: no extends, its units named after it, every pin.
    expect(sch.cached.map((c) => c.name).sort()).toEqual(['Connector:USB_C_Receptacle_USB2.0_16P', 'Device:R', 'MCU_ST_STM32F1:STM32F103C8Tx']);
    const mcu = sch.cached.find((c) => c.name === 'MCU_ST_STM32F1:STM32F103C8Tx');
    expect(mcu?.extends).toBe(false);
    expect(mcu?.units).toEqual(['STM32F103C8Tx_0_1', 'STM32F103C8Tx_1_1']);
    expect(mcu?.pins).toBe(48);
  });

  test('place puts the LQFP-48 on a board from its own bundle, and the save holds its 48 pads under its LIB_ID', async ({ page, context }) => {
    const w = libsWatch(context, page);
    const frame = await boot(page, 'pcb');
    await expect.poll(() => w.lines.some((l) => l.includes('[libs] quiet footprint warm-up done')), { timeout: 30_000 }).toBe(true);
    const n0 = w.net.length;
    const cold = await placeAt(page, 'footprint', 'Package_QFP', 'LQFP-48_7x7mm_P0.5mm', [700, 400]);
    expect(w.net.slice(n0)).toEqual(['fp.Package_QFP.bin']);
    expect(w.ops.filter((o) => o.startsWith('op=list'))).toEqual([]);
    const warm = await placeAt(page, 'footprint', 'Package_QFP', 'LQFP-48_7x7mm_P0.5mm', [400, 400]);
    measure('place, board', `${QFP} ${cold} ms (cold: fp.Package_QFP.bin fetched), again ${warm} ms (warm)`);
    expect(await windows(frame)).toEqual(['PcbFrame']);
    const saved = await request(page, 'project.save');
    expect(saved.saved).toEqual(['blank.kicad_pcb']);
    const fps = children((await savedText(page, 'blank.kicad_pcb')).trim()).filter((c) => head(c) === 'footprint');
    expect(fps.map((f) => firstString(f))).toEqual([QFP, QFP]);
    for (const fp of fps) {
      const pads = new Set(children(fp).filter((c) => head(c) === 'pad').map((c) => firstString(c) ?? '').filter((n) => n !== ''));
      expect([...pads].sort((a, b) => Number(a) - Number(b))).toEqual(Array.from({ length: 48 }, (_, i) => String(i + 1)));
    }
  });

  test('place puts a power symbol (P\'s pick) and a diode that extends another on the pointer, and KiCad annotates both', async ({ page }) => {
    const frame = await boot(page, 'sch');
    const manifest = await frame.evaluate(async (tag) => (await fetch(`/libs/${tag}/manifest.json`)).json() as Promise<{ libs: Array<{ id: string }> }>, TAG);
    test.skip(!['sym.power', 'sym.Diode'].every((id) => manifest.libs.some((l) => l.id === id)), 'the mirror has no power or Diode library');
    const gnd = await placeAt(page, 'symbol', 'power', 'GND', [500, 300]);
    const diode = await placeAt(page, 'symbol', 'Diode', '1N4148', [800, 300]);
    measure('place, power and derived diode', `power:GND ${gnd} ms, Diode:1N4148 ${diode} ms`);
    await request(page, 'project.save');
    const sch = schematicFacts(await savedText(page, 'blank.kicad_sch'));
    expect(sch.placed.map((p) => [p.libId, p.pins]).sort()).toEqual([['Diode:1N4148', 2], ['power:GND', 1]]);
    // A power symbol's reference is KiCad's #PWR series; the diode's is D1.
    expect(sch.placed.map((p) => p.reference).sort()).toEqual(['#PWR01', 'D1']);
    expect(sch.cached.find((c) => c.name === 'Diode:1N4148')).toMatchObject({ extends: false, units: ['1N4148_0_1', '1N4148_1_1'], pins: 2 });
  });

  test('a placement the reader drops with Escape leaves KiCad\'s tool (the next press opens no chooser), and a place while one hangs replaces it', async ({ page }) => {
    const frame = await boot(page, 'sch');
    await moveIn(page, 400, 300);
    expect(await request(page, 'place', { kind: 'symbol', lib: 'Device', name: 'R' })).toEqual({});
    expect(await request(page, 'key.press', { key: 'Escape', code: 'Escape' })).toEqual({});
    // KiCad's tool stays armed after its Escape, and its next press would open its chooser: the island leaves it.
    await page.waitForTimeout(800);
    await clickIn(page, 500, 300);
    await page.waitForTimeout(3_000);
    expect(await windows(frame)).toEqual(['SchematicFrame']);
    expect(await of(page, 'ev.edited')).toEqual([]);
    // Two places in a row: the first part is dropped, the second one lands.
    await moveIn(page, 400, 300);
    expect(await request(page, 'place', { kind: 'symbol', lib: 'Device', name: 'R' })).toEqual({});
    expect(await request(page, 'place', { kind: 'symbol', lib: 'Connector', name: 'USB_C_Receptacle_USB2.0_16P' })).toEqual({});
    await moveIn(page, 420, 320);
    await clickIn(page, 420, 320);
    await expect.poll(async () => (await of(page, 'ev.edited')).length, { timeout: 15_000 }).toBe(1);
    await request(page, 'project.save');
    expect(schematicFacts(await savedText(page, 'blank.kicad_sch')).placed.map((p) => p.libId)).toEqual(['Connector:USB_C_Receptacle_USB2.0_16P']);
  });

  test('place refuses an unknown item (not_found), a footprint in a schematic (unsupported), and while a dialog is up (busy)', async ({ page }) => {
    const frame = await boot(page, 'sch');
    expect(await refusal(page, 'place', { kind: 'symbol', lib: 'Device', name: 'No_Such_Part' })).toBe('not_found: Device:No_Such_Part');
    expect(await refusal(page, 'place', { kind: 'symbol', lib: 'No_Such_Library', name: 'R' })).toBe('not_found: No_Such_Library:R');
    expect(await refusal(page, 'place', { kind: 'footprint', lib: 'Package_QFP', name: 'LQFP-48_7x7mm_P0.5mm' })).toMatch(/^unsupported: /);
    expect(await request(page, 'lib.item', { kind: 'footprint', lib: 'Package_QFP', name: 'LQFP-48_7x7mm_P0.5mm' })).toEqual({ body: expect.stringContaining('(footprint "LQFP-48_7x7mm_P0.5mm"') });
    expect(await request(page, 'key.press', { key: '7', code: 'Digit7', ctrl: true, alt: true })).toEqual({});
    await expect.poll(() => windows(frame), { timeout: 15_000 }).toContain('DialogErcWindowName');
    expect(await refusal(page, 'place', { kind: 'symbol', lib: 'Device', name: 'R' })).toBe('busy: place');
  });

  test('lib.prefetch answers at once and warms the named library\'s bundle; lib.index answers null when the mirror has no index', async ({ page, context }) => {
    await context.route('**/libs/**/sym-index.json', (route) => route.fulfill({ status: 404, body: '' }));
    const w = libsWatch(context, page);
    await boot(page, 'sch');
    await expect.poll(() => w.lines.some((l) => l.includes('[libs] quiet symbol warm-up done')), { timeout: 30_000 }).toBe(true);
    expect(await request(page, 'lib.index', { kind: 'symbol' })).toEqual({ text: null });
    const n0 = w.net.length;
    expect(await request(page, 'lib.prefetch', { kind: 'symbol', libs: ['MCU_ST_STM32F1', 'No_Such_Library'] })).toEqual({});
    await expect.poll(() => w.net.slice(n0), { timeout: 10_000 }).toEqual(['sym.MCU_ST_STM32F1.bin']);
    expect(w.ops).toEqual([]);
  });

  test('the library reads answer off the request queue, for either kind in either frame: a footprint read waiting on its bundle holds up no key.press behind it', async ({ page, context }) => {
    const w = libsWatch(context, page);
    await boot(page, 'sch');
    await expect.poll(() => w.lines.some((l) => l.includes('[libs] quiet symbol warm-up done')), { timeout: 30_000 }).toBe(true);
    // The footprint bundle answers 2 s late; a schematic frame reads it all the same.
    await context.route('**/libs/**/fp.Connector_USB.bin', async (route) => { await new Promise((r) => setTimeout(r, 2_000)); await route.continue(); });
    const t0 = Date.now();
    const item = request(page, 'lib.item', { kind: 'footprint', lib: 'Connector_USB', name: 'USB_C_Receptacle_GCT_USB4105-xx-A_16P_TopMnt_Horizontal' }).then((r) => ({ r, ms: Date.now() - t0 }));
    await page.waitForTimeout(100);
    expect(await request(page, 'key.press', { key: 'w', code: 'KeyW' })).toEqual({});
    expect(await request(page, 'key.press', { key: 'Escape', code: 'Escape' })).toEqual({});
    const keyMs = Date.now() - t0;
    expect(String((await request(page, 'lib.index', { kind: 'footprint' })).text ?? '')).toContain('"rows"');
    const { r, ms } = await item;
    expect(String(r.body)).toContain('(footprint "USB_C_Receptacle_GCT_USB4105-xx-A_16P_TopMnt_Horizontal"');
    expect(keyMs).toBeLessThan(1_500);
    expect(ms).toBeGreaterThanOrEqual(2_000);
    measure('library reads off the queue', `key.press answered ${keyMs} ms after a lib.item whose bundle took ${ms} ms`);
  });
});
