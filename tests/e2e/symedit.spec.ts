// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// island v0.2.3-cc23 over the local pair (PROTOCOL.md "The symbol editor"):
// KiCad's own symbol editor booted with ?frame=symedit, canvas only, driven
// through the symedit.* ops on our engine's symedit exports (engine run 14):
// a symbol opened from its text with no library row, every change one undo
// step, the symbol taken back as text, KiCad's checker and SVG plot read as
// data, and every dialog and window of the frame held for the host
// (ev.symedit, ev.held). The fixture is tests/fixtures/symedit-small.
import { readFileSync } from 'node:fs';
import { expect, test, type Frame, type Page } from '@playwright/test';

const ISLAND = 'http://editor.localhost:4174';
interface Ev { type: string; phase?: string; open?: boolean; shown?: boolean; depth?: number; caps?: string[]; action?: string; ask?: string; uuid?: string; isNew?: boolean; uuids?: string[]; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Engine { Module: { HEAP8: { length: number } } }
interface State { token: string; open: boolean; name: string; lib: string; mode: string; modified: boolean; depth: number; unit: number; unitCount: number; bodyStyle: number; parent: string }
interface Item { kind: string; uuid: string; unit: number; bodyStyle: number; number?: string; name?: string; text?: string; [k: string]: unknown }
interface Key { key: string; code: string; ctrl?: boolean; shift?: boolean; alt?: boolean }

const FIX = '/fixtures/symedit-small';
const LIB = 'symedit-small_parts';
const UNDO: Key = { key: 'z', code: 'KeyZ', ctrl: true };

function measure(type: string, description: string): void {
  test.info().annotations.push({ type, description });
  console.log(`[measure] ${type}: ${description}`);
}
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const of = async (page: Page, type: string): Promise<Ev[]> => (await events(page)).filter((e) => e.type === type);
const request = (page: Page, op: string, args?: unknown): Promise<Record<string, unknown>> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const);
const refusal = (page: Page, op: string, args?: unknown): Promise<string> =>
  request(page, op, args).then(() => 'ok', (err: Error) => err.message.split('\n')[0].replace(/^.*?page\.evaluate:\s*/, '').replace(/^Error:\s*/, ''));
const timed = (page: Page, op: string, args?: unknown): Promise<{ ms: number; result: Record<string, unknown> }> => page.evaluate(async ([o, a]) => {
  const t0 = performance.now();
  const result = await (window as unknown as Harness).__bridge.request(o as string, a);
  return { ms: Math.round((performance.now() - t0) * 100) / 100, result };
}, [op, args] as const);
const text = (page: Page, path: string): Promise<string> => page.evaluate(async (p) => (await fetch(p)).text(), path);
const bytesOf = (page: Page, path: string): Promise<number[]> => page.evaluate(async (p) => [...new Uint8Array(await (await fetch(p)).arrayBuffer())], path);
const heap = async (frame: Frame | null): Promise<number | null> => (frame == null ? null : frame.evaluate(() => (window as unknown as Engine).Module.HEAP8.length));
const mb = (n: number | null): string => (n == null ? 'unread' : `${Math.round(n / 1048576)} MiB`);

async function boot(page: Page): Promise<{ frame: Frame | null; readyMs: number }> {
  const t0 = Date.now();
  await page.goto('/parent.html?frame=symedit');
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  const readyMs = Date.now() - t0;
  expect((await of(page, 'ev.state')).filter((e) => e.phase === 'fatal' || e.phase === 'blocked')).toEqual([]);
  return { frame: page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null, readyMs };
}
async function open(page: Page, name: string, o: Record<string, unknown> = {}): Promise<State> {
  const doc = await text(page, `${FIX}/${LIB}.kicad_sym`);
  return (await request(page, 'symedit.open', { text: doc, name, lib: LIB, mode: 'library', discard: true, ...o })) as unknown as State;
}
const state = async (page: Page): Promise<State> => (await request(page, 'symedit.state')) as unknown as State;
const items = async (page: Page, o: Record<string, unknown> = {}): Promise<Item[]> => ((await request(page, 'symedit.items.get', { unit: 0, bodyStyle: 0, ...o })) as { items: Item[] }).items;
/** Presses a key and waits for the next event of `type`; no KiCad window opens within a second after. */
async function pressFor(page: Page, key: Key, type: string): Promise<Ev> {
  const n = (await of(page, type)).length;
  const menus = (await of(page, 'ev.menu')).length;
  expect(await request(page, 'key.press', key)).toEqual({});
  await expect.poll(async () => (await of(page, type)).length, { timeout: 5_000, message: `${JSON.stringify(key)} sends ${type}` }).toBe(n + 1);
  await page.waitForTimeout(1_000);
  expect((await of(page, 'ev.menu')).length, `${JSON.stringify(key)} opens no window`).toBe(menus);
  return (await of(page, type)).at(-1) as Ev;
}

test('boots canvas only: no KiCad window at boot, its own caps only, the heap measured', async ({ page }) => {
  const { frame, readyMs } = await boot(page);
  await page.waitForTimeout(5_000);
  // K1: the library tree is never filled, so KiCad's "Loading Symbol Libraries" box never shows.
  expect(await of(page, 'ev.menu')).toEqual([]);
  const caps = (await of(page, 'ev.ready'))[0]?.caps ?? [];
  expect(caps.filter((c) => !/^kicad/.test(c))).toEqual(['heldKeys', 'hostKeys', 'projectLibs', 'symbolConvert', 'symedit', 'symeditHeld', 'write']);
  expect((await of(page, 'ev.chrome')).at(-1)?.shown ?? false).toBe(false);
  expect(await state(page)).toMatchObject({ open: false, token: '' });
  measure('symedit boot', `ev.ready ${readyMs} ms after navigation; engine heap 5 s after ready ${mb(await heap(frame))}`);
  for (const op of ['project.open', 'project.save', 'symbol.get', 'place', 'board.check']) expect(await refusal(page, op, {})).toBe('unsupported: a symbol editor opens symbols, not documents');
  expect(await refusal(page, 'symedit.take')).toBe('no_symbol: symedit.take');
});

test('opens every fixture symbol; take after an open reads the same symbol back, and take, open, take is byte stable', async ({ page }) => {
  await boot(page);
  for (const [name, units, parent] of [['OPAMP2', 3, ''], ['OPAMP2_ALT', 3, 'OPAMP2'], ['PWR3V3', 1, ''], ['CHECKME', 1, '']] as const) {
    const s = await open(page, name);
    expect(s, name).toMatchObject({ open: true, name, lib: LIB, mode: 'library', modified: false, depth: 0, unitCount: units, parent });
    const taken = (await request(page, 'symedit.take')) as { name: string; text: string; parent: string };
    expect(taken.name).toBe(name);
    expect(taken.parent).toBe(parent);
    expect(taken.text).toMatch(new RegExp(`\\(symbol "${name}"`));
    const again = await open(page, name, { text: taken.text });
    expect(again.name).toBe(name);
    const second = (await request(page, 'symedit.take')) as { text: string };
    expect(second.text, `${name}: take, open, take`).toBe(taken.text);
  }
  const placed = await open(page, 'OPAMP2', { mode: 'placed', unit: 2 });
  expect(placed).toMatchObject({ mode: 'placed', unit: 2 });
  const opens: number[] = [];
  const takes: number[] = [];
  const doc = await text(page, `${FIX}/${LIB}.kicad_sym`);
  for (let i = 0; i < 5; i++) {
    opens.push((await timed(page, 'symedit.open', { text: doc, name: 'OPAMP2', lib: LIB, mode: 'library', discard: true })).ms);
    takes.push((await timed(page, 'symedit.take')).ms);
  }
  measure('symedit.open and take, OPAMP2', `open median ${median(opens)} ms of ${opens.join(', ')}; take median ${median(takes)} ms of ${takes.join(', ')}`);
  expect(await refusal(page, 'symedit.open', { text: doc, name: 'NOSUCH', lib: LIB, mode: 'library', discard: true })).toBe('bad_args: symedit.open: the text holds no symbol NOSUCH KiCad reads');
});

test('every item kind read, one set per key, one undo step each, Ctrl+Z through key.press; add and remove pins; unit and body style', async ({ page }) => {
  const { frame } = await boot(page);
  await open(page, 'OPAMP2');
  await page.waitForTimeout(1_200);   // ev.edited's baseline
  const all = await items(page);
  const pins = all.filter((i) => i.kind === 'pin');
  expect(pins.map((p) => p.number).sort()).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
  expect(all.filter((i) => i.kind === 'field').map((f) => f.name)).toEqual(expect.arrayContaining(['Reference', 'Value', 'Footprint', 'Datasheet', 'Description']));
  expect(all.some((i) => i.kind === 'shape' && i.shape === 'polyline')).toBe(true);
  const pin3 = pins.find((p) => p.number === '3') as Item;
  const pinSets: Array<Record<string, unknown>> = [
    { name: 'INP' }, { number: '33' }, { type: 'bidirectional' }, { shape: 'clock' }, { x: -10.16 }, { y: 5.08 }, { orientation: 'left' },
    { length: 3.81 }, { nameSize: 1.016 }, { numberSize: 1.016 }, { visible: false }, { alternates: [{ name: 'ALT', type: 'output', shape: 'line' }] },
  ];
  let depth = (await state(page)).depth;
  const times: number[] = [];
  for (const set of pinSets) {
    const t = await timed(page, 'symedit.items.set', { uuids: [pin3.uuid], set });
    times.push(t.ms);
    expect((t.result as { items: Item[] }).items[0], JSON.stringify(set)).toMatchObject(set);
    depth += 1;
    expect((await state(page)).depth, JSON.stringify(set)).toBe(depth);
  }
  measure('symedit.items.set, a pin key', `median ${median(times)} ms of ${times.join(', ')}`);
  await expect.poll(async () => (await of(page, 'ev.edited')).at(-1)?.depth, { timeout: 5_000 }).toBe(depth);
  expect(await request(page, 'key.press', UNDO)).toEqual({});
  await expect.poll(async () => (await items(page, { uuids: [pin3.uuid] }))[0]?.alternates, { timeout: 5_000 }).toEqual([]);
  // A field, a shape.
  const value = all.find((i) => i.kind === 'field' && i.name === 'Value') as Item;
  for (const set of [{ text: 'TL072' }, { size: 1.524 }, { bold: true }, { italic: true }, { hJustify: 'right' }, { vJustify: 'top' }, { angle: 90 }, { visible: false }, { showName: true }, { x: 2.54 }]) {
    expect(((await request(page, 'symedit.items.set', { uuids: [value.uuid], set })) as { items: Item[] }).items[0], JSON.stringify(set)).toMatchObject(set);
  }
  const tri = all.find((i) => i.kind === 'shape') as Item;
  for (const set of [{ stroke: { width: 0.3, style: 'dash', color: '' } }, { fill: { type: 'none', color: '' } }]) {
    expect(((await request(page, 'symedit.items.set', { uuids: [tri.uuid], set })) as { items: Item[] }).items[0]).toMatchObject(set);
  }
  // Add two pins and a text in one step, then remove them in one step.
  const d0 = (await state(page)).depth;
  const newPin = (uuid: string, number: string) => ({ kind: 'pin', uuid, unit: 1, bodyStyle: 1, number, name: `P${number}`, type: 'passive', shape: 'line', x: 10.16, y: Number(number), orientation: 'left', length: 2.54, nameSize: 1.27, numberSize: 1.27, visible: true, alternates: [] });
  const note = { kind: 'text', uuid: 'eeeeeeee-0000-4000-8000-000000000003', unit: 1, bodyStyle: 1, name: '', text: 'hello', x: 0, y: -2.54, angle: 0, size: 1.27, bold: false, italic: false, hJustify: 'center', vJustify: 'center', visible: true, showName: false };
  const added = (await request(page, 'symedit.items.add', { items: [newPin('eeeeeeee-0000-4000-8000-000000000001', '9'), newPin('eeeeeeee-0000-4000-8000-000000000002', '10'), note] })) as { items: Item[] };
  expect(added.items.map((i) => i.uuid)).toHaveLength(3);
  expect((await state(page)).depth).toBe(d0 + 1);
  expect(await request(page, 'symedit.items.remove', { uuids: added.items.map((i) => i.uuid) })).toEqual({ removed: added.items.map((i) => i.uuid) });
  expect((await state(page)).depth).toBe(d0 + 2);
  // The shown unit and body style: no undo step, no modification.
  expect(await request(page, 'symedit.show', { unit: 2, bodyStyle: 1 })).toMatchObject({ unit: 2, depth: d0 + 2 });
  expect(await refusal(page, 'symedit.show', { unit: 4, bodyStyle: 1 })).toBe('bad_args: symedit.show: the symbol has 3 units');
  // The symbol's properties: one undo step a set.
  const props = await request(page, 'symedit.symbol.set', { set: { value: 'TL072', keywords: 'amp dual', inBom: false, unitNames: { 1: 'In', 2: 'Out' }, addField: { name: 'MPN', value: 'TL072CP', visible: false } } });
  expect(props).toMatchObject({ value: 'TL072', keywords: 'amp dual', inBom: false, unitNames: { 1: 'In', 2: 'Out' } });
  expect((props.fields as Array<{ name: string }>).some((f) => f.name === 'MPN')).toBe(true);
  expect((await state(page)).depth).toBe(d0 + 3);
  if (frame != null) measure('symedit heap after the edits', mb(await heap(frame)));
});

test('a derived symbol takes its parent\'s fields and is made independent; a new symbol from the form', async ({ page }) => {
  await boot(page);
  await open(page, 'OPAMP2_ALT');
  expect(await request(page, 'symedit.symbol.set', { set: { fromParent: { fields: 'all', resetEmpty: true, resetVisibility: true, resetEffects: false, resetPositions: false, removeExtra: false } } })).toMatchObject({ parent: 'OPAMP2' });
  expect(await request(page, 'symedit.symbol.set', { set: { flatten: true } })).toMatchObject({ parent: '' });
  const s = await request(page, 'symedit.new', {
    name: 'NEW_DUAL', lib: LIB, parentText: '', parent: '', refPrefix: 'U', unitCount: 2, unitsInterchangeable: true, bodyStyles: 'demorgan', power: 'none',
    pinNameOffset: 0.508, showPinNames: true, showPinNumbers: true, pinNamesInside: true, inBom: true, onBoard: true, inSim: true, keepParentFields: false, discard: true,
  });
  expect(s).toMatchObject({ open: true, name: 'NEW_DUAL', mode: 'new', unitCount: 2 });
  const p = await request(page, 'symedit.symbol.get');
  measure('symedit.new with bodyStyles demorgan', `state ${JSON.stringify(s.bodyStyles)}, symbol ${JSON.stringify(p.bodyStyles)}, show body 2: ${await refusal(page, 'symedit.show', { unit: 1, bodyStyle: 2 })}`);
  // A new symbol is a blank page (KiCad's own New Symbol draws nothing): one undo step adds its first pin.
  expect(p).toMatchObject({ name: 'NEW_DUAL', refPrefix: 'U', unitCount: 2, unitsInterchangeable: true });
  expect(await refusal(page, 'symedit.items.set', { uuids: ['eeeeeeee-0000-4000-8000-0000000000ff'], set: { x: 1 } })).toBe('not_found: eeeeeeee-0000-4000-8000-0000000000ff');
});

test('the checker\'s findings on CHECKME, the SVG plot, held edits and mark saved', async ({ page }) => {
  await boot(page);
  await open(page, 'CHECKME');
  const check = (await request(page, 'symedit.check')) as { grid: number; findings: Array<{ code: string; pins: string[]; severity: string }> };
  const codes = check.findings.map((f) => f.code).sort();
  measure('symedit.check, CHECKME', JSON.stringify(check.findings.map((f) => [f.code, f.severity, f.pins.join(' ')])));
  expect(codes).toEqual(expect.arrayContaining(['duplicate_pin', 'off_grid_pin', 'hidden_power_pin', 'reference_prefix_digit']));
  expect(check.findings.find((f) => f.code === 'duplicate_pin')?.pins).toContain('3');
  expect(check.findings.find((f) => f.code === 'off_grid_pin')?.pins).toEqual(['2']);
  const svgText = await page.evaluate(async () => new TextDecoder().decode(((await (window as unknown as Harness).__bridge.request('symedit.svg')) as { bytes: Uint8Array }).bytes));
  expect(svgText).toMatch(/<svg/);
  measure('symedit.svg, CHECKME', `${svgText.length} bytes`);
  // An edit, then an open over it without discard is refused; mark saved clears the flag.
  const ref = (await items(page, { kinds: ['field'] })).find((f) => f.name === 'Reference') as Item;
  await request(page, 'symedit.items.set', { uuids: [ref.uuid], set: { text: 'U' } });
  const s = await state(page);
  expect(s.modified).toBe(true);
  const doc = await text(page, `${FIX}/${LIB}.kicad_sym`);
  expect(await refusal(page, 'symedit.open', { text: doc, name: 'OPAMP2', lib: LIB, mode: 'library', discard: false })).toBe('held_edits: symedit.open');
  expect(await request(page, 'symedit.markSaved', { token: s.token })).toMatchObject({ modified: false });
  expect(((await request(page, 'symedit.check')) as { findings: Array<{ code: string }> }).findings.some((f) => f.code === 'reference_prefix_digit')).toBe(false);
});

test('KiCad\'s dialogs and windows are held: P places a pin with ev.symedit, E on each kind asks, every held key sends ev.held and opens nothing', async ({ page, browserName }) => {
  await boot(page);
  await open(page, 'OPAMP2');
  await page.waitForTimeout(1_200);
  const d0 = (await state(page)).depth;
  // P, then a press on the canvas: KiCad's pin tool asks the host and places the pin with its defaults.
  const asks = (await of(page, 'ev.symedit')).length;
  expect(await request(page, 'key.press', { key: 'p', code: 'KeyP' })).toEqual({});
  await page.waitForTimeout(300);
  await page.mouse.click(400, 400);
  await expect.poll(async () => (await of(page, 'ev.symedit')).length, { timeout: 5_000 }).toBe(asks + 1);
  const ask = (await of(page, 'ev.symedit')).at(-1) as Ev;
  expect(ask).toMatchObject({ ask: 'pin', isNew: true });
  // The pin tool asks the host and KiCad places the pin with its defaults on that press
  // (Chromium, measured: the pin and its twins in the other units, one undo step). In
  // Firefox the request comes and the pin is never placed, whatever presses follow
  // (measured 2026-11-17 on engine run 14: no undo step, no new pin, no window): an
  // open defect of the engine's pin tool in Firefox, pinned here so its repair shows.
  if (browserName === 'firefox') {
    await page.waitForTimeout(1_500);
    test.info().annotations.push({ type: 'defect', description: 'Firefox: P and a press send ev.symedit pin, but KiCad never places the pin' });
    expect((await state(page)).depth).toBe(d0);
  } else {
    await expect.poll(async () => (await state(page)).depth, { timeout: 5_000 }).toBe(d0 + 1);
  }
  expect(await request(page, 'key.press', { key: 'Escape', code: 'Escape' })).toEqual({});
  if (browserName !== 'firefox') expect(await request(page, 'key.press', UNDO)).toEqual({});
  await expect.poll(async () => (await state(page)).depth, { timeout: 5_000 }).toBe(d0);
  expect(await of(page, 'ev.menu')).toEqual([]);
  // E over a pin, a field, a shape, and over nothing (the symbol).
  const all = await items(page);
  for (const kind of ['pin', 'field', 'shape'] as const) {
    const it = all.find((i) => i.kind === kind && (kind !== 'field' || i.name === 'Value')) as Item;
    expect(await request(page, 'select', { uuids: [it.uuid] })).toEqual({});
    const e = await pressFor(page, { key: 'e', code: 'KeyE' }, 'ev.symedit');
    expect(e, kind).toMatchObject({ ask: kind, uuid: it.uuid, isNew: false });
  }
  // Over nothing (KiCad's E picks the item under the pointer when nothing is selected): the symbol's own properties.
  // KiCad's E with nothing selected takes the item under its cursor, which for a key
  // the host presses reads at the symbol's origin (measured: the hidden Description
  // field there, then the amplifier's triangle): what lies there moves away first.
  const atOrigin = (await items(page, { kinds: ['field'] })).filter((f) => f.x === 0 && f.y === 0).map((f) => f.uuid);
  if (atOrigin.length > 0) await request(page, 'symedit.items.set', { uuids: atOrigin, set: { x: 30.48, y: 30.48 } });
  for (const sh of await items(page, { kinds: ['shape'] })) {
    await request(page, 'symedit.items.set', { uuids: [sh.uuid], set: { points: (sh.points as Array<[number, number]>).map(([x, y]) => [x + 30.48, y]) } });
  }
  expect(await request(page, 'select', { uuids: [] })).toEqual({});
  const over = await pressFor(page, { key: 'e', code: 'KeyE' }, 'ev.symedit');
  const hit = (await items(page)).find((i) => i.uuid === over.uuid);
  measure('E over an empty corner', JSON.stringify({ ask: over.ask, item: hit == null ? null : { kind: hit.kind, name: hit.name, x: hit.x, y: hit.y, visible: hit.visible } }));
  expect(over).toMatchObject({ ask: 'symbol', uuid: '', isNew: false });
  // The held keys KiCad binds by default in the symbol editor (Show Datasheet is enabled only with a datasheet to show).
  await request(page, 'symedit.symbol.set', { set: { datasheet: 'https://example.com/opamp2.pdf' } });
  const held: Array<[Key, string]> = [
    [{ key: 's', code: 'KeyS', ctrl: true }, 'common.Control.save'],
    [{ key: 's', code: 'KeyS', ctrl: true, shift: true }, 'common.Control.saveAs'],
    [{ key: 'n', code: 'KeyN', ctrl: true }, 'eeschema.SymbolLibraryControl.newSymbol'],
    [{ key: 'f', code: 'KeyF', ctrl: true }, 'common.Interactive.find'],
    [{ key: 'f', code: 'KeyF', ctrl: true, alt: true }, 'common.Interactive.findAndReplace'],
    [{ key: 'd', code: 'KeyD' }, 'common.Control.showDatasheet'],
  ];
  for (const [key, action] of held) expect((await pressFor(page, key, 'ev.held')).action, JSON.stringify(key)).toBe(action);
});

test('the held actions\' names are in the engine\'s own strings', () => {
  const wasm = readFileSync('engine/kicad_editor/v0.2.3/kicad_editor.wasm').toString('latin1');
  const names = ['common.Control.save', 'common.Control.saveAs', 'common.Control.saveAll', 'eeschema.SymbolLibraryControl.saveSymbolAs',
    'eeschema.SymbolLibraryControl.saveSymbolCopyAs', 'eeschema.SymbolLibraryControl.saveLibraryAs', 'eeschema.SymbolLibraryControl.newSymbol',
    'common.Interactive.find', 'common.Interactive.findAndReplace', 'common.Control.showDatasheet', 'common.Control.showProperties',
    'common.Control.showLibraryTree', 'eeschema.InteractiveEdit.pinTable', 'eeschema.InteractiveEdit.symbolProperties', 'eeschema.InspectionTool.checkSymbol',
    'eeschema.SymbolLibraryControl.importSymbol', 'eeschema.SymbolLibraryControl.exportSymbol', 'eeschema.SymbolLibraryControl.exportSymbolAsSVG',
    'eeschema.SymbolLibraryControl.exportSymbolView', 'eeschema.SymbolLibraryControl.addSymbolToSchematic', 'common.Control.quit',
    'eeschema.EditorControl.editWithSymbolEditor', 'common.Control.showSymbolEditor'];
  for (const n of names) expect(wasm.includes(n), n).toBe(true);
});

test('symbol.convert reads a legacy .lib and an Eagle .lbr; ten opens in a row leave the heap flat', async ({ page }) => {
  const { frame } = await boot(page);
  for (const [file, name] of [['legacy.lib', 'LEGACY_R'], ['parts.lbr', 'EAGLE_R']] as const) {
    const bytes = await bytesOf(page, `${FIX}/${file}`);
    const t0 = Date.now();
    const out = await page.evaluate(([n, b]) => (window as unknown as Harness).__bridge.request('symbol.convert', { name: n, bytes: new Uint8Array(b as number[]) }), [file, bytes] as const) as { format: string; symbols: Array<{ name: string; text: string }> };
    measure(`symbol.convert, ${file}`, `${out.format}: ${out.symbols.map((s) => s.name).join(', ')} in ${Date.now() - t0} ms`);
    expect(out.symbols.map((s) => s.name).join(' ')).toContain(name);
    // A converted symbol opens in the editor as it is.
    const s = await request(page, 'symedit.open', { text: out.symbols[0].text, name: out.symbols[0].name, lib: LIB, mode: 'library', discard: true });
    expect(s).toMatchObject({ open: true });
  }
  const bad = await page.evaluate(() => (window as unknown as Harness).__bridge.request('symbol.convert', { name: 'x.kicad_sym', bytes: new TextEncoder().encode('not a symbol') }).then(() => 'ok', (e: Error) => e.message));
  expect(bad).toMatch(/^unreadable: /);
  const heaps: Array<number | null> = [];
  for (let i = 0; i < 10; i++) {
    await open(page, i % 2 === 0 ? 'OPAMP2' : 'CHECKME');
    await request(page, 'symedit.take');
    heaps.push(await heap(frame));
  }
  measure('ten opens and takes, heap', heaps.map(mb).join(', '));
  if (heaps[0] != null) expect((heaps[9] as number) - (heaps[2] as number)).toBeLessThanOrEqual(64 * 1048576);
});
