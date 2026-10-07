// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The library mirror (LIBRARY.md) over the local pair. The mirror tests run
// when the pair serves one: build a small one with tests/libs/make-mirror.mjs,
// then LIBS_DIR=tests/libs/out npm run e2e -- --project=chromium (LIBS_DIR is
// what serve.mjs serves as /libs/). The fallback test runs always: it refuses
// the manifest, so the island must boot on its example library. The playtest
// (a schematic and a board built from the mirror's parts in KiCad's own
// choosers) runs on any mirror holding Device, MCU_ST_STM32F1, Connector and
// Package_QFP: the 6-library one make-mirror.mjs builds, or the full one.
// KiCad's choosers open through KiCad's own Place menu: the island takes the
// A key for the host's picker (PICKER.md, tests/e2e/picker.spec.ts), and once
// the frame has been idle for a moment after the open, its quiet warm-up
// fetches the frame's search index and the common libraries the mirror holds.
import { expect, test, type BrowserContext, type Frame, type Page } from '@playwright/test';
import pin from '../../PIN.json' with { type: 'json' };

declare const process: { env: Record<string, string | undefined> };

const ISLAND = 'http://editor.circuitcenter.localhost:4174';
const TAG = pin.libs.tag;
interface Ev { type: string; phase?: string; detail?: string; depth?: number; at: number }
interface Harness { __events: Ev[]; __saved: Record<string, Uint8Array>; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Registry { wxElementRegistry: { findAll(f: object): Array<{ id: unknown; parentId?: unknown; typeName: string; name: string; label: string; centerX: number; centerY: number }> } }
interface Manifest { tag: string; libs: Array<{ id: string; kind: string }> }

/** Every /libs/ request the island makes (its path below the tag, with when it started and ended), and the provider's log of each library op. */
function libsWatch(context: BrowserContext, page: Page) {
  const t0 = Date.now();
  const w = { net: [] as Array<{ file: string; start: number; end: number }>, ops: [] as string[] };
  context.on('request', (r) => {
    const u = new URL(r.url());
    if (u.origin !== ISLAND || !u.pathname.startsWith('/libs/')) return;
    const rec = { file: decodeURIComponent(u.pathname.replace(/^\/libs\/[^/]+\//, '')), start: Date.now() - t0, end: -1 };
    w.net.push(rec);
    const settle = (): void => { rec.end = Date.now() - t0; };
    r.response().then(settle, settle);
  });
  page.on('console', (m) => { const t = m.text(); const i = t.indexOf('[libs] request '); if (i >= 0) w.ops.push(t.slice(i + '[libs] request '.length)); });
  return w;
}
type Watch = ReturnType<typeof libsWatch>;
const files = (w: Watch, from = 0): string[] => w.net.slice(from).map((n) => n.file);
const bundles = (w: Watch, from = 0): string[] => files(w, from).filter((f) => f.endsWith('.bin')).sort();
const count = (ops: string[], re: RegExp): number => ops.filter((o) => re.test(o)).length;

function measure(type: string, description: string): void {
  test.info().annotations.push({ type, description });
  console.log(`[measure] ${type}: ${description}`);
}

const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const request = (page: Page, op: string, args?: unknown): Promise<Record<string, unknown>> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const);
/** The names of the engine's visible top-level windows (its frame, a chooser frame or dialog). */
const windows = (frame: Frame): Promise<string[]> =>
  frame.evaluate(() => (window as unknown as Registry).wxElementRegistry.findAll({ visible: true }).filter((e) => /Dialog|Frame/.test(e.typeName)).map((e) => e.name));

async function boot(page: Page, frameName: 'sch' | 'pcb', fixture = 'glasgow'): Promise<Frame> {
  await page.goto(`/parent.html?fixture=${fixture}&frame=${frameName}`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  expect((await events(page)).filter((e) => e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))).toEqual([]);
  await expect(page.locator('#state')).toContainText(`opened ${fixture}.kicad_${frameName}`, { timeout: 120_000 });
  const frame = page.frames().find((f) => f.url().startsWith(`${ISLAND}/`));
  if (frame == null) throw new Error('no island frame');
  return frame;
}

/** The centre of the first DOM element under `selector` whose text is `text` (wx-dom.js draws the menu bar and its popups as DOM). */
const domPoint = (frame: Frame, selector: string, text: string): Promise<[number, number] | null> =>
  frame.evaluate(([sel, t]) => {
    const el = [...document.querySelectorAll(sel)].find((e) => e.textContent?.trim() === t);
    if (el == null) return null;
    const r = el.getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2] as [number, number];
  }, [selector, text] as const);

/**
 * Opens KiCad's own chooser (the symbol chooser, the footprint chooser) through
 * its own menus, Place > Place Symbols or Place Footprints (KiCad's chrome comes
 * on for it), waits for the chooser window and resolves with how long it took
 * from the menu item's press. The A key is the host's picker's (PICKER.md).
 */
async function openChooser(page: Page, frame: Frame, name: string): Promise<number> {
  const item = name === 'FootprintChooserFrame' ? 'Place Footprints' : 'Place Symbols';
  expect(await request(page, 'chrome.show', { on: true })).toEqual({});
  await expect.poll(() => domPoint(frame, '.wx-menu-title', 'Place')).not.toBeNull();
  await clickIn(page, ...(await domPoint(frame, '.wx-menu-title', 'Place'))!);
  await expect.poll(() => domPoint(frame, '.wx-menu-popup *', item)).not.toBeNull();
  const at = (await domPoint(frame, '.wx-menu-popup *', item))!;
  const t0 = Date.now();
  await clickIn(page, ...at);
  await expect.poll(() => windows(frame), { timeout: 120_000 }).toContain(name);
  return Date.now() - t0;
}

/** The quiet warm-up's end, as the island logs it (PICKER.md): the frame's index, then the common libraries. */
const warmedUp = (page: Page, kind: 'symbol' | 'footprint'): Promise<void> => new Promise((resolve) => {
  const on = (m: { text(): string }): void => { if (m.text().includes(`[libs] quiet ${kind} warm-up done`)) { page.off('console', on); resolve(); } };
  page.on('console', on);
});
/** The common libraries of a kind the quiet warm-up fetches (src/picker.ts COMMON_LIBS), as mirror ids. */
const COMMON: Record<'symbol' | 'footprint', string[]> = {
  symbol: ['Device', 'power', 'Connector', 'Connector_Generic', 'Switch', 'LED', 'Diode', 'Transistor_FET', 'Transistor_BJT', 'Regulator_Linear'].map((n) => `sym.${n}`),
  footprint: ['Resistor_SMD', 'Capacitor_SMD', 'LED_SMD', 'Diode_SMD', 'Package_TO_SOT_SMD', 'Connector_PinHeader_2.54mm'].map((n) => `fp.${n}`),
};

/** The keys the island's IndexedDB holds (LIBRARY.md: database cc-libs, store bundles). */
const storedKeys = (frame: Frame): Promise<string[]> => frame.evaluate(() => new Promise<string[]>((resolve, reject) => {
  const req = indexedDB.open('cc-libs');
  req.onerror = () => reject(req.error);
  req.onsuccess = () => {
    const db = req.result;
    const keys = db.transaction('bundles', 'readonly').objectStore('bundles').getAllKeys();
    keys.onsuccess = () => { resolve((keys.result as string[]).sort()); db.close(); };
    keys.onerror = () => reject(keys.error);
  };
}));

/** The mirror's manifest, read inside the island frame (Node cannot resolve *.localhost). The watch sees this read too, so take it before a count starts. */
const readManifest = (frame: Frame): Promise<Manifest> => frame.evaluate(async (tag) => (await fetch(`/libs/${tag}/manifest.json`)).json(), TAG);
const ids = (m: Manifest, kind: string): string[] => m.libs.filter((l) => l.kind === kind).map((l) => l.id).sort();

/** What the island's IndexedDB holds: the stored bundles (count, and their bytes as stored, decoded) and the origin's usage as the browser estimates it. */
const storedBytes = (frame: Frame): Promise<{ count: number; bytes: number; usage: number; indexedDB: number | null }> => frame.evaluate(async () => {
  const stored = await new Promise<{ count: number; bytes: number }>((resolve, reject) => {
    const req = indexedDB.open('cc-libs');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const sum = { count: 0, bytes: 0 };
      const cursor = db.transaction('bundles', 'readonly').objectStore('bundles').openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (c == null) { db.close(); resolve(sum); return; }
        sum.count += 1;
        sum.bytes += (c.value as Uint8Array).byteLength;
        c.continue();
      };
      cursor.onerror = () => reject(cursor.error);
    };
  });
  // usageDetails is Chromium's breakdown of usage by storage kind.
  const est = (await navigator.storage.estimate()) as StorageEstimate & { usageDetails?: { indexedDB?: number } };
  return { ...stored, usage: est.usage ?? 0, indexedDB: est.usageDetails?.indexedDB ?? null };
});
const mb = (n: number): string => `${(n / 1e6).toFixed(1)} MB`;

/** A press at a point of the island's viewport: a real pointer press, which also gives the frame the browser's keyboard focus (PROTOCOL.md key.press). */
async function clickIn(page: Page, x: number, y: number): Promise<void> {
  const box = await page.locator('iframe').boundingBox();
  if (box == null) throw new Error('no iframe box');
  await page.mouse.click(box.x + x, box.y + y);
}

/** The latest bytes ev.saved brought for a path, as text. */
const savedText = (page: Page, path: string): Promise<string> =>
  page.evaluate((p) => new TextDecoder().decode((window as unknown as Harness).__saved[p]), path);
const edits = async (page: Page): Promise<number> => (await events(page)).filter((e) => e.type === 'ev.edited').length;

/**
 * How long the chooser's search is given after the last key before Enter.
 * KiCad filters its tree on a debounce timer after a keystroke, then selects
 * its best match; an Enter that came first would accept the old selection.
 * Playwright's key presses wait for the frame to take each event, so the
 * pause starts once the frame has every key; a wrong pick still fails the
 * test, at the saved file.
 */
const SEARCH_SETTLE_MS = 3000;

/**
 * Places one library item through the chooser that is up, the way a reader
 * does: a press in its search field (the footprint chooser, a frame, does not
 * focus the field itself), Ctrl+A over the query the symbol chooser keeps
 * from its last open, the item's whole LIB_ID typed, then Enter, which
 * accepts the search's best match: for a whole LIB_ID, that item. A press in
 * the drawing drops it (an ev.edited says KiCad committed it), and Escape
 * ends the tool. Resolves with how long it took from the first key to the drop.
 */
async function place(page: Page, frame: Frame, chooser: string, libId: string, [x, y]: [number, number]): Promise<number> {
  const field = await frame.evaluate(() => {
    const shown = (window as unknown as Registry).wxElementRegistry.findAll({ visible: true });
    const search = shown.filter((e) => e.typeName === 'wxSearchCtrl');
    if (search.length !== 1) throw new Error(`${search.length} search fields on screen`);
    const text = shown.find((e) => e.typeName === 'wxTextCtrl' && e.parentId === search[0].id);
    if (text == null) throw new Error('no text field in the search field');
    return { x: text.centerX, y: text.centerY };
  });
  const t0 = Date.now();
  await clickIn(page, field.x, field.y);
  await page.keyboard.press('Control+a');
  await page.keyboard.type(libId);
  await page.waitForTimeout(SEARCH_SETTLE_MS);
  await page.keyboard.press('Enter');
  await expect.poll(() => windows(frame), { timeout: 30_000 }).not.toContain(chooser);
  const before = await edits(page);
  await clickIn(page, x, y);
  await expect.poll(() => edits(page), { timeout: 15_000 }).toBeGreaterThan(before);
  const ms = Date.now() - t0;
  expect(await request(page, 'key.press', { key: 'Escape', code: 'Escape' })).toEqual({});
  return ms;
}

/** The direct child lists of one s-expression, each whole (quoted strings are skipped, so a parenthesis inside one does not count). */
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
/** The first string of a list: a library symbol's name, a footprint's LIB_ID, a pad's number. */
const firstString = (sx: string): string | undefined => /^\([^\s()]+\s+"((?:[^"\\]|\\.)*)"/.exec(sx)?.[1];

/** A saved schematic's placed symbols (lib_id, Footprint property, pin count) and the names its lib_symbols cache holds. */
function schematicFacts(text: string) {
  const top = children(text.trim());
  const cache = top.find((c) => head(c) === 'lib_symbols');
  const placed = top.filter((c) => head(c) === 'symbol').map((c) => {
    const kids = children(c);
    const prop = (name: string): string | undefined => kids.filter((k) => head(k) === 'property').find((k) => firstString(k) === name)?.match(/^\(property\s+"(?:[^"\\]|\\.)*"\s+"((?:[^"\\]|\\.)*)"/)?.[1];
    return { libId: firstString(kids.find((k) => head(k) === 'lib_id') ?? '') ?? '', footprint: prop('Footprint') ?? '', pins: kids.filter((k) => head(k) === 'pin').length };
  });
  return { placed, cached: (cache == null ? [] : children(cache)).filter((c) => head(c) === 'symbol').map((c) => firstString(c) ?? '') };
}

/** The playtest's parts: a plain symbol, a derived one (its Footprint property comes down its extends chain), a 17-pin one, and the derived one's footprint. */
const PARTS = ['Device:R', 'MCU_ST_STM32F1:STM32F103C8Tx', 'Connector:USB_C_Receptacle_USB2.0_16P'];
const PART_BUNDLES = ['sym.Device', 'sym.MCU_ST_STM32F1', 'sym.Connector'];
const QFP = 'Package_QFP:LQFP-48_7x7mm_P0.5mm';

test.describe('with a mirror', () => {
  test.skip(process.env.LIBS_DIR == null, 'needs a library mirror: LIBS_DIR=<the directory served as /libs/> (tests/libs/make-mirror.mjs builds one)');

  test('the schematic frame boots with no library request but its quiet warm-up\'s, its chooser fetches each other symbol bundle once, and the next session fetches none', async ({ page, context }) => {
    const w = libsWatch(context, page);
    const warm = warmedUp(page, 'symbol');
    const frame = await boot(page, 'sch');
    const readyAt = (await events(page)).length;
    // Neither boot nor the project open touches a library: the manifest alone, read once. Then,
    // once the frame has been idle, the quiet warm-up: the symbol index (when the mirror has one)
    // and each common library the mirror holds, once, with no provider op (KiCad asked for nothing).
    await warm;
    const symbols = ids(await readManifest(frame), 'symbol');
    const common = COMMON.symbol.filter((id) => symbols.includes(id));
    expect(files(w)[0]).toBe('manifest.json');
    expect(bundles(w)).toEqual(common.map((id) => `${id}.bin`).sort());
    expect(files(w).filter((f) => !f.endsWith('.bin') && f !== 'manifest.json').every((f) => f === 'sym-index.json')).toBe(true);
    expect(w.ops).toEqual([]);
    measure('schematic boot', `${w.net.length} library requests after the quiet warm-up (${files(w).join(', ')}), ${w.ops.length} provider ops`);

    // The symbol chooser enumerates every symbol library: each other bundle once, and the footprint index once.
    const before = w.net.length;
    const opsBefore = w.ops.length;
    const ms = await openChooser(page, frame, 'dialog');
    await page.waitForTimeout(2000);
    expect(bundles(w, before)).toEqual(symbols.filter((id) => !common.includes(id)).map((id) => `${id}.bin`));
    expect(files(w, before).filter((f) => !f.endsWith('.bin'))).toEqual(['fp-index.json']);
    const ops = w.ops.slice(opsBefore);
    expect(count(ops, /^op=list .*arg=bodies$/)).toBe(symbols.length);
    measure('symbol chooser, cold', `shown ${ms} ms after the menu item's press; ${w.net.length - before} requests (${bundles(w, before).length} bundles, fp-index.json); provider ops ${count(ops, /^op=get /)} get, ${count(ops, /^op=list .*arg=bodies$/)} list bodies, ${count(ops, /^op=list .*arg=$/)} list, ${count(ops, /^op=index /)} index`);
    // Every symbol bundle is stored (beside the symbol search index the quiet warm-up keeps, LIBRARY.md).
    expect((await storedKeys(frame)).filter((k) => !k.startsWith(`${TAG}/index:`))).toEqual(symbols.map((id) => `${TAG}/${id}`));
    // The fetches changed nothing the host sees: no ev.state after the open.
    expect((await events(page)).slice(readyAt).filter((e) => e.type === 'ev.state')).toEqual([]);

    // A new session on this browser: every bundle comes from IndexedDB, none from the network.
    const second = w.net.length;
    const frame2 = await boot(page, 'sch');
    const ms2 = await openChooser(page, frame2, 'dialog');
    await page.waitForTimeout(2000);
    expect(bundles(w, second)).toEqual([]);
    measure('symbol chooser, next session', `shown ${ms2} ms after the press; library requests: ${files(w, second).join(', ')}`);
  });

  test('the board frame boots with no library request but its quiet warm-up\'s, and its chooser\'s first enumerate fetches the footprint bundles in parallel', async ({ page, context }) => {
    const w = libsWatch(context, page);
    // The quiet warm-up's bundles are refused here, so every footprint bundle is cold at the chooser
    // (a refused bundle is never kept: the next ask fetches it again).
    let refuse = true;
    await context.route('**/libs/**/*.bin', async (route) => {
      if (refuse) return route.fulfill({ status: 503, body: '' });
      // Each bundle answers 400 ms late. KiCad's own crossings are serial (one in
      // flight at a time, measured 2026-10-07), so overlapping requests are the chooser's warm-up's.
      await new Promise((r) => setTimeout(r, 400));
      return route.continue();
    });
    const warm = warmedUp(page, 'footprint');
    const frame = await boot(page, 'pcb');
    await warm;
    const footprints = ids(await readManifest(frame), 'footprint');
    expect(bundles(w)).toEqual(COMMON.footprint.filter((id) => footprints.includes(id)).map((id) => `${id}.bin`).sort());
    expect(w.ops).toEqual([]);
    measure('board boot', `${w.net.length} library requests after the quiet warm-up, its bundles refused (${files(w).join(', ')}), ${w.ops.length} provider ops`);
    refuse = false;
    const before = w.net.length;
    const opsBefore = w.ops.length;
    const ms = await openChooser(page, frame, 'FootprintChooserFrame');
    await page.waitForTimeout(1000);
    expect(bundles(w, before)).toEqual(footprints.map((id) => `${id}.bin`));
    expect(count(w.ops.slice(opsBefore), /^op=list .*arg=bodies$/)).toBe(footprints.length);
    const reqs = w.net.slice(before).filter((n) => n.file.endsWith('.bin'));
    const overlap = Math.max(...reqs.map((a) => reqs.filter((b) => b.start <= a.start && (b.end < 0 || b.end > a.start)).length));
    // The bundles' own span, from the first request to the last answer: one at a time it would be
    // reqs.length * 400 ms or more. (The chooser's own time on top of it is KiCad's and the menu's.)
    const span = Math.max(...reqs.map((r) => r.end)) - Math.min(...reqs.map((r) => r.start));
    measure('footprint chooser, cold, 400 ms per bundle', `shown ${ms} ms after the menu item's press; ${reqs.length} bundles in ${span} ms, at most ${overlap} in flight at once (one at a time would take ${reqs.length * 400} ms or more)`);
    expect(overlap).toBeGreaterThan(1);
    expect(span).toBeLessThan(reqs.length * 400);
  });

  test('playtest: the symbol chooser places Device:R, an STM32F103C8Tx and a USB C receptacle from the mirror into an empty schematic, the save holds all three, and the next session places one with no bundle request', async ({ page, context }) => {
    const w = libsWatch(context, page);
    const frame = await boot(page, 'sch', 'blank');
    const symbols = ids(await readManifest(frame), 'symbol');
    for (const id of PART_BUNDLES) expect(symbols).toContain(id);
    const start = w.net.length;

    // The first chooser of the session fetches the symbol set; then each part is
    // found by its LIB_ID in KiCad's own search and dropped on the sheet.
    // KiCad's chrome is on (its Place menu opened the chooser): the spots stay clear of its panes.
    const spots: Array<[number, number]> = [[650, 250], [850, 420], [1050, 300]];
    const opened: number[] = [];
    const placed: number[] = [];
    const opsAt: number[] = [];
    for (const [i, part] of PARTS.entries()) {
      opsAt.push(w.ops.length);
      opened.push(await openChooser(page, frame, 'dialog'));
      if (i === 0) {
        await expect.poll(async () => (await storedKeys(frame)).filter((k) => k.startsWith(`${TAG}/sym.`)).length, { timeout: 60_000 }).toBe(symbols.length);
        const stored = await storedBytes(frame);
        measure('symbol set stored', `${stored.count} bundles, ${mb(stored.bytes)} as stored (decoded); navigator.storage.estimate usage ${mb(stored.usage)}, indexedDB ${stored.indexedDB == null ? 'not broken out' : mb(stored.indexedDB)}`);
      }
      placed.push(await place(page, frame, 'dialog', part, spots[i]));
    }
    measure('symbol chooser, cold then in session', `shown ${opened.join(' ms, ')} ms after the press (${symbols.length} symbol libraries); each part found and dropped ${placed.join(' ms, ')} ms after its first key (${SEARCH_SETTLE_MS} ms of it the search pause)`);
    const opsOf = (i: number): string[] => w.ops.slice(opsAt[i], opsAt[i + 1] ?? w.ops.length);
    measure('provider ops per chooser open', PARTS.map((part, i) => `${part}: ${count(opsOf(i), /^op=list .*arg=bodies$/)} list bodies, ${count(opsOf(i), /^op=get /)} get (${count(opsOf(i), /^op=get .*lib=\/mnt\/pcbjam\/fp\./)} of a footprint), ${count(opsOf(i), /^op=index /)} index`).join('; '));

    // Each bundle at most once in the session: the three parts' bundles once each, and every symbol
    // bundle once (the quiet warm-up and the chooser's first-enumerate warm-up between them).
    const got = bundles(w);
    expect(got.length).toBe(new Set(got).size);
    for (const id of PART_BUNDLES) expect(got.filter((f) => f === `${id}.bin`)).toHaveLength(1);
    expect(got.filter((f) => f.startsWith('sym.'))).toEqual(symbols.map((id) => `${id}.bin`));
    const other = got.filter((f) => !f.startsWith('sym.'));
    measure('schematic session requests', `${got.length} bundles (${got.length - other.length} symbol${other.length > 0 ? `, and ${other.join(', ')}` : ''}), ${files(w, start).filter((f) => !f.endsWith('.bin')).join(', ')}`);

    // KiCad's own Save: the sheet holds each part, placed and cached in lib_symbols.
    const saved = await request(page, 'project.save');
    expect(saved.saved).toContain('blank.kicad_sch');
    const sch = schematicFacts(await savedText(page, 'blank.kicad_sch'));
    expect(sch.placed.map((p) => p.libId).sort()).toEqual([...PARTS].sort());
    expect([...sch.cached].sort()).toEqual([...PARTS].sort());
    const byId = new Map(sch.placed.map((p) => [p.libId, p]));
    // The derived STM32's Footprint property came down its extends chain from the mirror's body.
    expect(byId.get('MCU_ST_STM32F1:STM32F103C8Tx')?.footprint).toBe(QFP);
    expect(byId.get('MCU_ST_STM32F1:STM32F103C8Tx')?.pins).toBe(48);
    expect(byId.get('Connector:USB_C_Receptacle_USB2.0_16P')?.pins).toBe(17);
    expect(byId.get('Device:R')?.pins).toBe(2);

    // A new session on this browser: the chooser reads every bundle from IndexedDB, and a part still places.
    const second = w.net.length;
    const frame2 = await boot(page, 'sch', 'blank');
    const warm = await openChooser(page, frame2, 'dialog');
    const warmPlaced = await place(page, frame2, 'dialog', PARTS[2], [850, 400]);
    expect(bundles(w, second)).toEqual([]);
    expect(files(w, second).filter((f) => !['manifest.json', 'fp-index.json', 'sym-index.json'].includes(f))).toEqual([]);
    await request(page, 'project.save');
    expect(schematicFacts(await savedText(page, 'blank.kicad_sch')).placed.map((p) => p.libId)).toEqual([PARTS[2]]);
    measure('symbol chooser, next session', `shown ${warm} ms after the press, part dropped ${warmPlaced} ms after its first key; library requests: ${files(w, second).join(', ')}`);
  });

  test('playtest: the footprint chooser places the LQFP-48 from the mirror onto an empty board, the save holds its 48 pads, and the next session opens the chooser with no bundle request', async ({ page, context }) => {
    const w = libsWatch(context, page);
    const frame = await boot(page, 'pcb', 'blank');
    const footprints = ids(await readManifest(frame), 'footprint');
    expect(footprints).toContain('fp.Package_QFP');
    const start = w.net.length;

    const cold = await openChooser(page, frame, 'FootprintChooserFrame');
    await expect.poll(async () => (await storedKeys(frame)).filter((k) => k.startsWith(`${TAG}/fp.`)).length, { timeout: 60_000 }).toBe(footprints.length);
    const stored = await storedBytes(frame);
    measure('footprint set stored', `${stored.count} bundles, ${mb(stored.bytes)} as stored (decoded); navigator.storage.estimate usage ${mb(stored.usage)}, indexedDB ${stored.indexedDB == null ? 'not broken out' : mb(stored.indexedDB)}`);
    const ms = await place(page, frame, 'FootprintChooserFrame', QFP, [700, 400]);
    // Each footprint bundle once in the session, between the quiet warm-up and the chooser's.
    const got = bundles(w);
    expect(got).toEqual(footprints.map((id) => `${id}.bin`));
    measure('footprint chooser, cold', `shown ${cold} ms after the press (${footprints.length} footprint libraries, no throttling); found and dropped ${ms} ms after the first key; ${got.length} bundles, ${files(w, start).filter((f) => !f.endsWith('.bin')).join(', ') || 'nothing else'}`);

    // The board save: the footprint, with every numbered pad of KiCad's own LQFP-48.
    const saved = await request(page, 'project.save');
    expect(saved.saved).toEqual(['blank.kicad_pcb']);
    const pcb = await savedText(page, 'blank.kicad_pcb');
    expect(pcb).toContain(`(footprint "${QFP}"`);
    const fps = children(pcb.trim()).filter((c) => head(c) === 'footprint');
    expect(fps.map((f) => firstString(f))).toEqual([QFP]);
    const pads = new Set(children(fps[0]).filter((c) => head(c) === 'pad').map((c) => firstString(c) ?? '').filter((n) => n !== ''));
    expect([...pads].sort((a, b) => Number(a) - Number(b))).toEqual(Array.from({ length: 48 }, (_, i) => String(i + 1)));

    // A new session on this browser: the footprint chooser reads every bundle from IndexedDB.
    const second = w.net.length;
    const frame2 = await boot(page, 'pcb', 'blank');
    const warm = await openChooser(page, frame2, 'FootprintChooserFrame');
    await page.waitForTimeout(1000);
    expect(bundles(w, second)).toEqual([]);
    measure('footprint chooser, next session', `shown ${warm} ms after the press; library requests: ${files(w, second).join(', ')}`);
  });
});

test('with no mirror the island boots on its example library and its chooser asks for nothing more', async ({ page, context }) => {
  const w = libsWatch(context, page);
  // Refused whatever the pair serves: the manifest is a 404, a definitive answer, asked once.
  await context.route('**/libs/**', (route) => route.fulfill({ status: 404, body: '' }));
  const frame = await boot(page, 'sch');
  expect(files(w)).toEqual(['manifest.json']);
  const ms = await openChooser(page, frame, 'dialog');
  await page.waitForTimeout(2000);
  expect(files(w)).toEqual(['manifest.json']);
  // The example library answers from memory.
  expect(w.ops.some((o) => o.includes('lib=/mnt/pcbjam/examples') && o.endsWith('arg=bodies'))).toBe(true);
  measure('no mirror', `chooser shown ${ms} ms after the press, on the example library; library requests: ${files(w).join(', ')}`);
});
