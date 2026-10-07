// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The library mirror (LIBRARY.md) over the local pair. The mirror tests run
// when the pair serves one: build a small one with tests/libs/make-mirror.mjs,
// then LIBS_DIR=tests/libs/out npm run e2e -- --project=chromium (LIBS_DIR is
// what serve.mjs serves as /libs/). The fallback test runs always: it refuses
// the manifest, so the island must boot on its example library.
import { expect, test, type BrowserContext, type Frame, type Page } from '@playwright/test';
import pin from '../../PIN.json' with { type: 'json' };

declare const process: { env: Record<string, string | undefined> };

const ISLAND = 'http://editor.circuitcenter.localhost:4174';
const TAG = pin.libs.tag;
interface Ev { type: string; phase?: string; detail?: string; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Registry { wxElementRegistry: { findAll(f: object): Array<{ typeName: string; name: string; label: string }> } }
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

async function boot(page: Page, frameName: 'sch' | 'pcb'): Promise<Frame> {
  await page.goto(`/parent.html?fixture=glasgow&frame=${frameName}`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  expect((await events(page)).filter((e) => e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))).toEqual([]);
  await expect(page.locator('#state')).toContainText(`opened glasgow.kicad_${frameName}`, { timeout: 120_000 });
  const frame = page.frames().find((f) => f.url().startsWith(`${ISLAND}/`));
  if (frame == null) throw new Error('no island frame');
  return frame;
}

/** Presses A (the place tool: the symbol chooser, the footprint chooser), waits for the chooser window and resolves with how long it took. */
async function openChooser(page: Page, frame: Frame, name: string): Promise<number> {
  const t0 = Date.now();
  expect(await request(page, 'key.press', { key: 'a', code: 'KeyA' })).toEqual({});
  await expect.poll(() => windows(frame), { timeout: 120_000 }).toContain(name);
  return Date.now() - t0;
}

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

test.describe('with a mirror', () => {
  test.skip(process.env.LIBS_DIR == null, 'needs a library mirror: LIBS_DIR=<the directory served as /libs/> (tests/libs/make-mirror.mjs builds one)');

  test('the schematic frame boots with no library request, its chooser fetches each symbol bundle once, and the next session fetches none', async ({ page, context }) => {
    const w = libsWatch(context, page);
    const frame = await boot(page, 'sch');
    // Neither boot nor the project open touches a library: the manifest alone, read once.
    await page.waitForTimeout(3000);
    expect(files(w)).toEqual(['manifest.json']);
    expect(w.ops).toEqual([]);
    measure('schematic boot', `${w.net.length} library request (${files(w).join(', ')}), ${w.ops.length} provider ops, 3 s after the open`);
    const readyAt = (await events(page)).length;
    const symbols = ids(await readManifest(frame), 'symbol');

    // The symbol chooser enumerates every symbol library: each bundle once, and the footprint index once.
    const before = w.net.length;
    const opsBefore = w.ops.length;
    const ms = await openChooser(page, frame, 'dialog');
    await page.waitForTimeout(2000);
    expect(bundles(w, before)).toEqual(symbols.map((id) => `${id}.bin`));
    expect(files(w, before).filter((f) => !f.endsWith('.bin'))).toEqual(['fp-index.json']);
    const ops = w.ops.slice(opsBefore);
    expect(count(ops, /^op=list .*arg=bodies$/)).toBe(symbols.length);
    measure('symbol chooser, cold', `shown ${ms} ms after the press; ${w.net.length - before} requests (${symbols.length} bundles, fp-index.json); provider ops ${count(ops, /^op=get /)} get, ${count(ops, /^op=list .*arg=bodies$/)} list bodies, ${count(ops, /^op=list .*arg=$/)} list, ${count(ops, /^op=index /)} index`);
    expect(await storedKeys(frame)).toEqual(symbols.map((id) => `${TAG}/${id}`));
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

  test('the board frame boots with no library request, and its chooser\'s first enumerate fetches the footprint bundles in parallel', async ({ page, context }) => {
    const w = libsWatch(context, page);
    const frame = await boot(page, 'pcb');
    await page.waitForTimeout(3000);
    expect(files(w)).toEqual(['manifest.json']);
    expect(w.ops).toEqual([]);
    measure('board boot', `${w.net.length} library request (${files(w).join(', ')}), ${w.ops.length} provider ops, 3 s after the open`);
    const footprints = ids(await readManifest(frame), 'footprint');

    // Each bundle answers 400 ms late. KiCad's own crossings are serial (one in
    // flight at a time, measured 2026-10-07), so overlapping requests are the warm-up's.
    await context.route('**/libs/**/*.bin', async (route) => { await new Promise((r) => setTimeout(r, 400)); await route.continue(); });
    const before = w.net.length;
    const opsBefore = w.ops.length;
    const ms = await openChooser(page, frame, 'FootprintChooserFrame');
    await page.waitForTimeout(1000);
    expect(bundles(w, before)).toEqual(footprints.map((id) => `${id}.bin`));
    expect(count(w.ops.slice(opsBefore), /^op=list .*arg=bodies$/)).toBe(footprints.length);
    const reqs = w.net.slice(before).filter((n) => n.file.endsWith('.bin'));
    const overlap = Math.max(...reqs.map((a) => reqs.filter((b) => b.start <= a.start && (b.end < 0 || b.end > a.start)).length));
    measure('footprint chooser, cold, 400 ms per bundle', `shown ${ms} ms after the press; ${reqs.length} bundles, at most ${overlap} in flight at once (one at a time would take ${reqs.length * 400} ms or more)`);
    expect(overlap).toBeGreaterThan(1);
    expect(ms).toBeLessThan(reqs.length * 400);
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
