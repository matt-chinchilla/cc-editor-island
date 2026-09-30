// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The headed suite over the local pair (tests/serve.mjs): the island boots in
// the sandboxed, cross-origin isolated iframe the site uses, opens a handed-over
// project, saves both ways, drops traversal paths, never leaves the pair and
// never opens a popup. The harness (tests/harness/parent.html) speaks
// cc-editor/1 and keeps every event on window.__events.
import { expect, test, type BrowserContext, type Frame, type Page } from '@playwright/test';

const PAGE = 'http://circuitcenter.localhost:4173';
const ISLAND = 'http://editor.circuitcenter.localhost:4174';
const PAIR = new Set([PAGE, ISLAND]);

interface Ev { type: string; phase?: string; detail?: string; path?: string; bytes?: number; text?: string; topic?: string; caps?: string[]; at: number }
interface Harness {
  __events: Ev[];
  __hellos: number;
  __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> };
  __openFixture(): Promise<{ opened: string; dropped: string[] }>;
}

/** A request leaves the pair unless its origin is the page or the island (a blob: URL carries its creator's origin). */
function leavesPair(url: string): boolean {
  const u = new URL(url);
  return u.protocol !== 'data:' && !PAIR.has(u.origin);
}

/**
 * Everything the page, its frames and their workers send: request events see
 * each request that reached the network stack (a worker's too, checked by the
 * sentinel below), WebSockets are their own event, and a popup is a new page.
 * A request the CSP refused never reaches the network; its console line is kept
 * as a fenced attempt.
 */
function watch(context: BrowserContext, page: Page) {
  const w = { seen: [] as string[], leftPair: [] as string[], sockets: [] as string[], popups: [] as string[], fenced: [] as string[] };
  context.on('request', (r) => { w.seen.push(r.url()); if (leavesPair(r.url())) w.leftPair.push(r.url()); });
  context.on('page', (p) => w.popups.push(p.url() || 'about:blank'));
  page.on('popup', (p) => w.popups.push(p.url() || 'about:blank'));
  page.on('websocket', (ws) => w.sockets.push(ws.url()));
  page.on('console', (m) => { if (/Content[- ]Security[- ]Policy/i.test(m.text())) w.fenced.push(m.text().slice(0, 200)); });
  return w;
}

/** A measurement the report quotes: kept as an annotation and printed by the list reporter. */
function measure(type: string, description: string): void {
  test.info().annotations.push({ type, description });
  console.log(`[measure] ${type}: ${description}`);
}
const fencedNote = (w: { fenced: string[] }): void => { if (w.fenced.length > 0) measure('csp fenced', [...new Set(w.fenced)].join(' | ')); };

const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const request = (page: Page, op: string, args?: unknown): Promise<Record<string, unknown>> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const);
const savedCount = async (page: Page, path: string): Promise<number> => (await events(page)).filter((e) => e.type === 'ev.saved' && e.path === path).length;

/** Loads the harness, waits for ev.ready (never blocked or fatal) and the handed-over project's open. */
async function boot(page: Page, query: string, opened?: string): Promise<Frame> {
  const t0 = Date.now();
  await page.goto(`/parent.html?${query}`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  const seconds = (Date.now() - t0) / 1000;
  expect((await events(page)).filter((e) => e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))).toEqual([]);
  measure('ev.ready', `${seconds.toFixed(1)} s after the harness loaded (${query})`);
  if (opened != null) await expect(page.locator('#state')).toContainText(`opened ${opened}`, { timeout: 120_000 });
  const frame = page.frames().find((f) => f.url().startsWith(`${ISLAND}/`));
  if (frame == null) throw new Error('no island frame');
  return frame;
}

/** A click at a point of the island's viewport. */
async function clickIn(page: Page, x: number, y: number): Promise<void> {
  const box = await page.locator('iframe').boundingBox();
  if (box == null) throw new Error('no iframe box');
  await page.mouse.click(box.x + x, box.y + y);
}

/** The visible wx elements (dialogs, buttons) the engine's registry reports, in viewport coordinates. */
const visibleWx = (frame: Frame, filter: { type?: string; label?: string }) =>
  frame.evaluate((f) => (window as unknown as ToolWindowLike).wxElementRegistry.findAll({ ...f, visible: true }).map((e) => ({ typeName: e.typeName, label: e.label, x: e.centerX, y: e.centerY })), filter);
interface ToolWindowLike { wxElementRegistry: { findAll(f: object): Array<{ typeName: string; label: string; centerX: number; centerY: number }> } }

async function clickWx(page: Page, frame: Frame, label: string): Promise<void> {
  await expect.poll(async () => (await visibleWx(frame, { label })).length, { timeout: 15_000 }).toBeGreaterThan(0);
  const [el] = await visibleWx(frame, { label });
  await clickIn(page, el.x, el.y);
}

// KiCad draws its menus on the canvas; these points were measured on both
// engines at the harness's 1280 by 800 frame (the menu bar is the frame's top row).
const MENU = { help: [461, 9], gettingStarted: [560, 59], getInvolved: [508, 107] } as const;

test('top-level opens nothing', async ({ page }) => {
  await page.goto(`${ISLAND}/?frame=sch&theme=day`);
  await expect(page.locator('#screen')).toContainText('Open it from circuitcenter.ai');
  await expect(page.locator('#main-window canvas, #window-container *')).toHaveCount(0);
});

test('the island answers with the snippet headers, and the worker script carries the CSP', async ({ page }) => {
  // Through the browser: Node cannot resolve *.localhost, the browsers do.
  const islandRes = await page.goto(`${ISLAND}/island.json`);
  expect(islandRes?.status()).toBe(200);
  const island = (await islandRes!.json()) as { id: string };
  expect(island.id).toMatch(/^[a-z0-9][a-z0-9.-]{0,63}$/);
  expect(islandRes!.headers()['access-control-allow-origin']).toBe(PAGE);
  const res = await page.goto(`${ISLAND}/r/${island.id}/wasm/kicad_editor/v0.2.3/kicad_editor.js`);
  expect(res?.status()).toBe(200);
  const hd = res!.headers();
  expect(hd['content-security-policy']).toContain("worker-src 'self' blob:");
  expect(hd['content-security-policy']).toContain("connect-src 'self' blob: data:;");
  expect(hd['content-security-policy']).toContain(`frame-ancestors ${PAGE};`);
  expect(hd['cross-origin-embedder-policy']).toBe('require-corp');
  expect(hd['cross-origin-opener-policy']).toBe('same-origin');
  expect(hd['cross-origin-resource-policy']).toBe('same-site');
  expect(hd['access-control-allow-origin']).toBe(PAGE);
});

test('the network watch sees a worker inside the island frame, and flags a request that leaves the pair and a popup', async ({ page, context }) => {
  const w = watch(context, page);
  const frame = await boot(page, 'frame=sch');
  // A blob worker inside the island frame fetches a same-origin URL: the watch must see it.
  const done = await frame.evaluate(() => new Promise<string>((resolve) => {
    const src = `fetch('${location.origin}/island.json?sentinel=worker').then(() => postMessage('done'), (e) => postMessage(String(e)))`;
    const wk = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    wk.onmessage = (m) => resolve(String(m.data));
  }));
  expect(done).toBe('done');
  expect(w.seen).toContain(`${ISLAND}/island.json?sentinel=worker`);
  expect(w.leftPair).toEqual([]);
  // The harness page has no connect-src: its request to a third host is flagged.
  await page.evaluate(() => fetch('http://sentinel.invalid/').catch(() => undefined));
  expect(w.leftPair).toEqual(['http://sentinel.invalid/']);
  // And a window the harness page opens (it has no sandbox) is caught as a popup.
  expect(w.popups).toEqual([]);
  await page.evaluate(() => { window.open('about:blank', '_blank'); });
  await expect.poll(() => w.popups.length).toBeGreaterThan(0);
});

test('boots inside the sandboxed iframe, opens Glasgow, saves both ways, never leaves the pair', async ({ page, context }) => {
  const w = watch(context, page);
  const frame = await boot(page, 'fixture=glasgow&frame=pcb', 'glasgow.kicad_pcb');
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  expect(await frame.evaluate(() => crossOriginIsolated)).toBe(true);
  const ready = (await events(page)).find((e) => e.type === 'ev.ready');
  expect(ready?.caps).toEqual(expect.arrayContaining(['kicadOpenFile', 'kicadSaveBoard', 'kicadSetChrome', 'kicadSetReadOnly']));
  expect(await page.evaluate(() => (window as unknown as Harness).__hellos)).toBe(1);

  // Ctrl+S in the editor reaches the host as ev.saved, with the board's bytes.
  await clickIn(page, 640, 450);
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.saved' && e.path === 'glasgow.kicad_pcb'));
  const ctrlS = (await events(page)).find((e) => e.type === 'ev.saved' && e.path === 'glasgow.kicad_pcb');
  expect(ctrlS?.text?.startsWith('(kicad_pcb')).toBe(true);

  // A host-driven save does too, exactly once: the save hook does not emit a second copy.
  const before = await savedCount(page, 'glasgow.kicad_pcb');
  const saved = await request(page, 'project.save');
  expect(saved).toEqual({ path: 'glasgow.kicad_pcb' });
  // One more round trip through the island before counting, so a late hook emission would be in.
  expect(await request(page, 'readonly', { on: false })).toEqual({});
  expect(await savedCount(page, 'glasgow.kicad_pcb')).toBe(before + 1);
  const hostSaved = (await events(page)).filter((e) => e.type === 'ev.saved' && e.path === 'glasgow.kicad_pcb').at(-1);
  expect(hostSaved?.bytes).toBeGreaterThan(1_000_000);
  expect(hostSaved?.text?.startsWith('(kicad_pcb')).toBe(true);

  // The chrome and read-only switches resolve in the real engine.
  expect(await request(page, 'chrome.show', { on: false })).toEqual({});
  expect(await request(page, 'chrome.show', { on: true })).toEqual({});
  expect(await request(page, 'readonly', { on: true })).toEqual({});
  expect(await request(page, 'readonly', { on: false })).toEqual({});

  // Help > Get Involved calls window.open with a foreign URL: nothing opens, the attempt is reported.
  await clickIn(page, ...MENU.help);
  await clickIn(page, ...MENU.getInvolved);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.state' && e.phase === 'popup' && e.detail === '1 popup attempts blocked'));
  // Help > Getting Started: KiCad offers its online help; Yes becomes ev.help, still no popup.
  await clickIn(page, ...MENU.help);
  await clickIn(page, ...MENU.gettingStarted);
  await clickWx(page, frame, 'Yes');
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.help' && e.topic === 'getting_started_in_kicad'));
  expect(await frame.evaluate(() => Object.getOwnPropertyDescriptor(window, 'open')?.writable)).toBe(false);

  expect(w.popups).toEqual([]);
  expect(w.sockets).toEqual([]);
  expect(w.leftPair).toEqual([]);
  fencedNote(w);
});

test('a hierarchical schematic saves the shown sheet, the hotkeys work, and a second open replaces the first', async ({ page, context }) => {
  const w = watch(context, page);
  const frame = await boot(page, 'fixture=glasgow&frame=sch', 'glasgow.kicad_sch');
  // The sheet files the engine reports are absolute, so the root save lands on the root file.
  expect(await request(page, 'project.save')).toEqual({ path: 'glasgow.kicad_sch' });
  expect(await savedCount(page, 'glasgow.kicad_sch')).toBe(1);
  // Selecting a symbol makes this engine reach for ws://localhost:4242 (the
  // stage 0 probe saw :4243 too); the CSP refuses it, so no socket opens. With
  // ws: allowed in connect-src this test goes red on the sockets check below.
  await clickIn(page, 620, 450);   // U1, the FX2 microcontroller
  await expect.poll(async () => (await visibleWx(frame, { label: 'No objects selected' })).length).toBe(0);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await visibleWx(frame, { label: 'No objects selected' })).length).toBe(1);

  // Into IO_Banks through the hierarchy pane: the save follows the shown sheet.
  const [tree] = await visibleWx(frame, { type: 'HIERARCHY_TREE' });
  expect(tree).toBeDefined();
  await clickIn(page, 99, 384);   // the "IO_Banks (page 2)" row of the hierarchy pane
  await expect.poll(async () => JSON.parse(await frame.evaluate(() => (window as unknown as { Module: { kicadSheetsGetTree(): string } }).Module.kicadSheetsGetTree())).current).not.toBe('/');
  expect(await request(page, 'project.save')).toEqual({ path: 'io_banks.kicad_sch' });
  const sub = (await events(page)).filter((e) => e.type === 'ev.saved').at(-1);
  expect(sub?.path).toBe('io_banks.kicad_sch');
  expect(sub?.text?.startsWith('(kicad_sch')).toBe(true);

  // The seeded hotkey A starts placing a symbol: the chooser opens.
  expect(await visibleWx(frame, { type: 'wxDialog' })).toEqual([]);
  await clickIn(page, 1100, 730);
  await page.keyboard.press('a');
  await expect.poll(async () => (await visibleWx(frame, { type: 'wxDialog' })).length, { timeout: 15_000 }).toBe(1);
  await clickWx(page, frame, 'Cancel');
  await expect.poll(async () => (await visibleWx(frame, { type: 'wxDialog' })).length).toBe(0);
  await page.keyboard.press('Escape');

  // project.open over the opened, unmodified project: answered, and no modal is left up.
  const again = await page.evaluate(() => (window as unknown as Harness).__openFixture());
  expect(again).toEqual({ opened: 'glasgow.kicad_sch', dropped: [] });
  expect((await visibleWx(frame, {})).filter((e) => /Dialog/.test(e.typeName))).toEqual([]);
  expect(await request(page, 'project.save')).toEqual({ path: 'glasgow.kicad_sch' });

  expect(w.popups).toEqual([]);
  expect(w.sockets).toEqual([]);
  expect(w.leftPair).toEqual([]);
  fencedNote(w);
});

test('a traversal path is dropped, never written', async ({ page }) => {
  const frame = await boot(page, 'fixture=traversal&frame=sch', 'traversal.kicad_sch');
  await expect(page.locator('#state')).toContainText('dropped ../../home/.config/kicad/kicad_common.json');
  // No kicad_common.json anywhere in MEMFS holds the fixture's marker.
  const hits = await frame.evaluate(() => {
    const FS = (window as unknown as { FS: { readdir(p: string): string[]; stat(p: string): { mode: number }; isDir(m: number): boolean; readFile(p: string): Uint8Array } }).FS;
    const found: Array<{ path: string; marked: boolean }> = [];
    const walk = (dir: string, depth: number): void => {
      if (depth > 16) return;
      let names: string[];
      try { names = FS.readdir(dir); } catch { return; }
      for (const n of names) {
        if (n === '.' || n === '..') continue;
        const p = `${dir === '/' ? '' : dir}/${n}`;
        if (p === '/proc' || p === '/dev') continue;
        let mode: number;
        try { mode = FS.stat(p).mode; } catch { continue; }
        if (FS.isDir(mode)) walk(p, depth + 1);
        else if (n === 'kicad_common.json') found.push({ path: p, marked: new TextDecoder().decode(FS.readFile(p)).includes('cc-traversal-fixture') });
      }
    };
    walk('/', 0);
    return found;
  });
  expect(hits.length).toBeGreaterThan(0);   // the seeded one
  expect(hits.filter((f) => f.marked)).toEqual([]);
});

test('an HTTP library named by the project produces zero off-origin requests', async ({ page, context }) => {
  const w = watch(context, page);
  const frame = await boot(page, 'fixture=http-lib&frame=sch', 'httplib.kicad_sch');
  // The symbol chooser enumerates every library the project's sym-lib-table names.
  await clickIn(page, 1100, 730);
  await page.keyboard.press('a');
  await expect.poll(async () => (await visibleWx(frame, { type: 'wxDialog' })).length, { timeout: 15_000 }).toBe(1);
  await page.waitForTimeout(3000);   // the brief's quiet period for a late library fetch
  expect(w.leftPair).toEqual([]);
  expect(w.sockets).toEqual([]);
  expect(w.popups).toEqual([]);
  fencedNote(w);
});

test('the loader under reduced motion and night mode, then the night editor', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  // Hold the engine download so the loader stays up long enough to look at.
  await page.route('**/kicad_editor.wasm', async (route) => { await gate; await route.continue(); });
  await page.goto('/parent.html?fixture=glasgow&frame=sch&theme=night');
  const island = page.frameLocator('iframe');
  await expect(island.locator('.cc-loader')).toBeVisible();
  expect(await island.locator('html').getAttribute('class')).toContain('dark');
  expect(await island.locator('#screen').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(15, 21, 18)');
  // Under reduced motion the indeterminate sweep does not run.
  expect(await island.locator('.cc-bar-fill').evaluate((el) => [getComputedStyle(el).animationName, getComputedStyle(el).opacity])).toEqual(['none', '0']);
  await page.screenshot({ path: test.info().outputPath('loader-night-reduced-motion.png') });
  release();
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready'), null, { timeout: 170_000 });
  await expect(page.locator('#state')).toContainText('opened glasgow.kicad_sch', { timeout: 120_000 });
  await expect(island.locator('#screen')).toBeHidden();
  await page.screenshot({ path: test.info().outputPath('editor-night.png') });
});

test('the loader sweeps in day mode', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  await page.route('**/kicad_editor.wasm', async (route) => { await gate; await route.continue(); });
  await page.goto('/parent.html?frame=sch&theme=day');
  const island = page.frameLocator('iframe');
  await expect(island.locator('.cc-loader')).toBeVisible();
  expect(await island.locator('html').getAttribute('class')).not.toContain('dark');
  expect(await island.locator('#screen').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(251, 251, 248)');
  expect(await island.locator('.cc-bar-fill').evaluate((el) => getComputedStyle(el).animationName)).toBe('cc-sweep');
  await page.screenshot({ path: test.info().outputPath('loader-day.png') });
  release();
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready'), null, { timeout: 170_000 });
  await page.screenshot({ path: test.info().outputPath('editor-day.png') });
});
