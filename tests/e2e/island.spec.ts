// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The headed suite over the local pair (tests/serve.mjs): the island boots in
// the sandboxed, cross-origin isolated iframe the site uses, opens a handed-over
// project, saves both ways, drops traversal paths, never leaves the pair,
// never opens a popup, and lets go of its engine on shutdown. The harness (tests/harness/parent.html) speaks
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
 * as a fenced attempt. Playwright reports WebSockets per page only (there is
 * no context event), so the socket watch is attached to every page of the
 * context, the ones open now and any that appear later.
 */
function watch(context: BrowserContext, page: Page) {
  const w = { seen: [] as string[], leftPair: [] as string[], sockets: [] as string[], popups: [] as string[], fenced: [] as string[] };
  const socketsOf = (p: Page): void => { p.on('websocket', (ws) => w.sockets.push(ws.url())); };
  context.on('request', (r) => { w.seen.push(r.url()); if (leavesPair(r.url())) w.leftPair.push(r.url()); });
  for (const p of context.pages()) socketsOf(p);
  context.on('page', (p) => { w.popups.push(p.url() || 'about:blank'); socketsOf(p); });
  page.on('popup', (p) => w.popups.push(p.url() || 'about:blank'));
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

test('top-level opens nothing', async ({ page, context }) => {
  const asked: string[] = [];
  context.on('request', (r) => asked.push(r.url()));
  await page.goto(`${ISLAND}/?frame=sch&theme=day`);
  await expect(page.locator('#screen')).toContainText('Open it from circuitcenter.ai');
  await expect(page.locator('#main-window canvas, #window-container *')).toHaveCount(0);
  // Proven by the network too: the page loaded, and neither engine script nor the wasm was asked for.
  await page.waitForLoadState('networkidle');
  expect(asked.some((u) => u.startsWith(`${ISLAND}/`))).toBe(true);
  expect(asked.filter((u) => /\/(kicad_editor\.(wasm|js)|wx\.js|wx-dom\.js)(\.gz)?(\?|$)/.test(new URL(u).pathname + new URL(u).search))).toEqual([]);
});

test('the island answers with the snippet headers, and the worker script carries the CSP', async ({ page }) => {
  // Through the browser: Node cannot resolve *.localhost, the browsers do.
  const islandRes = await page.goto(`${ISLAND}/island.json`);
  expect(islandRes?.status()).toBe(200);
  const island = (await islandRes!.json()) as { id: string; kicadCommit: string };
  expect(island.id).toMatch(/^[a-z0-9][a-z0-9.-]{0,63}$/);
  // PROTOCOL.md's island.json fields: the commit is kicadCommit, never ev.ready's engine.kicad version name.
  expect(Object.keys(island).sort()).toEqual(['id', 'kicadCommit', 'source', 'tag']);
  expect(island.kicadCommit).toMatch(/^[0-9a-f]{40}$/);
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
  // The loading heartbeat: on this cold load, booting carried the whole percent loaded at least once.
  const beats = (await events(page)).filter((e) => e.type === 'ev.state' && e.phase === 'booting' && /^\d{1,3}$/.test(e.detail ?? ''));
  expect(beats.length).toBeGreaterThan(0);
  measure('booting heartbeat', beats.map((e) => e.detail).join(' '));
  expect(await page.evaluate(() => (window as unknown as Harness).__hellos)).toBe(1);

  // Ctrl+S in the editor reaches the host as ev.saved, with the board's bytes.
  // The click lands clear of the board: with the chrome hidden the canvas fills
  // the frame, and a click on a dense spot opens KiCad's clarify-selection menu,
  // which takes the key (e2e 2026-10-01).
  await clickIn(page, 1250, 780);
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

  // An empty popup list is guaranteed by the iframe's sandbox (no allow-popups)
  // whatever the island does; the real proof is above: the ev.state popup
  // report, ev.help, and window.open non-writable inside the frame.
  expect(w.popups).toEqual([]);
  expect(w.sockets).toEqual([]);
  expect(w.leftPair).toEqual([]);
  fencedNote(w);
});

test('a hierarchical schematic saves the shown sheet, the hotkeys work, and a second open replaces the first', async ({ page, context }) => {
  const w = watch(context, page);
  const frame = await boot(page, 'fixture=glasgow&frame=sch', 'glasgow.kicad_sch');
  // The frame boots canvas only; this test reads the properties and hierarchy panes, so the chrome comes back.
  expect(await request(page, 'chrome.show', { on: true })).toEqual({});
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

  // Guaranteed by the sandbox; the popup proof is the Glasgow pcb test's ev.state popup and window.open checks.
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

// Not a fence proof on this engine: its HTTP library type (the sym-lib-table
// row with type "HTTP") is inert. The chooser shows no row for it and no
// request for example.invalid is attempted even with connect-src relaxed
// (Task 7 report), so this test cannot fail here. The fence (Focus 5) is
// carried by the WebSocket check in the hierarchical schematic test, which
// goes red when ws: is allowed. This test stays as the guard for a later
// engine that does fetch HTTP libraries.
test('an HTTP library named by the project produces zero off-origin requests', async ({ page, context }) => {
  const w = watch(context, page);
  const frame = await boot(page, 'fixture=http-lib&frame=sch', 'httplib.kicad_sch');
  // The symbol chooser enumerates the libraries the project's sym-lib-table names.
  await clickIn(page, 1100, 730);
  await page.keyboard.press('a');
  await expect.poll(async () => (await visibleWx(frame, { type: 'wxDialog' })).length, { timeout: 15_000 }).toBe(1);
  await page.waitForTimeout(3000);   // the brief's quiet period for a late library fetch
  expect(w.leftPair).toEqual([]);
  expect(w.sockets).toEqual([]);
  // Guaranteed by the sandbox; the popup proof is the Glasgow pcb test's ev.state popup and window.open checks.
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

  // "Licences and source" opens in place: the frame never navigates, the loader
  // keeps running under the overlay, Escape closes it and focus comes back.
  const frameUrl = (): string | undefined => page.frames().find((f) => f.url().startsWith(`${ISLAND}/`))?.url();
  const before = frameUrl();
  expect(before).toBeDefined();
  const control = island.locator('button.cc-licences');
  const dialog = island.locator('[role="dialog"][aria-modal="true"]');
  await control.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.cc-licences-doc h1')).toHaveText('Licences and source');
  await expect(dialog.locator('script, style')).toHaveCount(0);
  await expect(dialog.locator('.cc-licences-action', { hasText: 'Close' })).toBeFocused();
  expect(frameUrl()).toBe(before);
  await dialog.locator('a', { hasText: 'NOTICE.txt' }).click();
  await expect(dialog.locator('.cc-licences-text')).toBeVisible();
  expect(frameUrl()).toBe(before);
  await dialog.locator('.cc-licences-action', { hasText: 'Back to the licences' }).click();
  await expect(dialog.locator('.cc-licences-doc h1')).toHaveText('Licences and source');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(control).toBeFocused();
  await expect(island.locator('.cc-loader')).toBeVisible();
  expect(frameUrl()).toBe(before);
  await page.screenshot({ path: test.info().outputPath('licences-closed-loader.png') });

  // Left open across ev.ready, the overlay stays above the editor until closed.
  await control.click();
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('licences-over-loader.png') });
  release();
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready'), null, { timeout: 170_000 });
  await expect(island.locator('#screen')).toBeHidden();
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('licences-over-editor.png') });
  await dialog.locator('.cc-licences-action', { hasText: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
  expect(frameUrl()).toBe(before);
  expect((await events(page)).filter((e) => e.type === 'ev.state' && e.phase === 'fatal')).toEqual([]);
  await page.screenshot({ path: test.info().outputPath('editor-day.png') });

  // A lost WebGL context (a GPU reset) ends at the fatal screen with the closed code, never a frozen canvas.
  const frame = page.frames().find((f) => f.url().startsWith(`${ISLAND}/`));
  if (frame == null) throw new Error('no island frame');
  // The loader's listener sits on its #canvas; the event is dispatched there (that canvas holds no
  // WebGL context of its own to lose through WEBGL_lose_context), so the island's mapping is what runs.
  const lost = await frame.evaluate(() => {
    const canvas = document.getElementById('canvas');
    return canvas?.dispatchEvent(new Event('webglcontextlost', { cancelable: true })) === false;   // the listener called preventDefault
  });
  expect(lost).toBe(true);
  await expect(island.locator('#screen')).toBeVisible();
  await expect(island.locator('.cc-copy')).toHaveText('The editor stopped. Reload the page to start again.');
  await expect(island.locator('.cc-detail')).toHaveText('webgl_lost');
  await expect.poll(async () => (await events(page)).filter((e) => e.type === 'ev.state' && e.phase === 'fatal').map((e) => e.detail)).toEqual(['webgl_lost']);
  await page.screenshot({ path: test.info().outputPath('webgl-lost.png') });
});

test('shutdown releases the engine: the answer is the last message, and the removed frame leaves no document behind', async ({ page, browserName }) => {
  const docs = async (): Promise<number | null> => {
    if (browserName !== 'chromium') return null;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.collectGarbage');
    const { documents } = await cdp.send('Memory.getDOMCounters');
    await cdp.detach();
    return documents;
  };
  const frame = await boot(page, 'fixture=glasgow&frame=sch', 'glasgow.kicad_sch');
  const booted = await docs();
  expect(await request(page, 'shutdown')).toEqual({});
  // Nothing is answered after it, and nothing is emitted (no ev.closing either).
  const after = await page.evaluate(() => Promise.race([
    (window as unknown as Harness).__bridge.request('project.save').then(() => 'answered', () => 'answered'),
    new Promise((r) => setTimeout(() => r('silent'), 1500)),
  ]));
  expect(after).toBe('silent');
  expect((await events(page)).filter((e) => e.type === 'ev.closing')).toEqual([]);
  // Every parked activation unwound, the engine's globals and stage are gone.
  expect(await frame.evaluate(() => {
    const w = window as unknown as { __wxScheduler?: { dead: boolean; _suspended: Map<unknown, unknown> }; Module?: unknown; FS?: unknown };
    return { dead: w.__wxScheduler?.dead, parked: w.__wxScheduler?._suspended.size, Module: typeof w.Module, FS: typeof w.FS, canvases: document.querySelectorAll('canvas').length };
  })).toEqual({ dead: true, parked: 0, Module: 'undefined', FS: 'undefined', canvases: 0 });
  await page.evaluate(() => document.querySelector('iframe')?.remove());
  // The top frame's event handler keeps the last subframe the pointer was over
  // (a Blink reference, one frame at most): a move over the page lets it go.
  await page.mouse.move(4, 880);
  await page.waitForTimeout(3000);   // the detached document is collected after the frame's last task
  const removed = await docs();
  if (booted != null && removed != null) {
    measure('documents', `${booted} with the editor, ${removed} after shutdown and removal`);
    expect(removed).toBeLessThan(booted);
  }
});

test('boots with KiCad\'s chrome hidden, and key.press opens the chooser with no real click', async ({ page }) => {
  const frame = await boot(page, 'fixture=glasgow&frame=sch', 'glasgow.kicad_sch');
  // Canvas only: no menu bar, toolbar, status bar or pane is visible.
  const types = new Set((await visibleWx(frame, {})).map((e) => e.typeName));
  expect([...types].sort()).toEqual(['wxFrame', 'wxGLCanvas']);
  const box = await frame.evaluate(() => {
    const c = [...document.querySelectorAll<HTMLCanvasElement>('canvas.gl-canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0];
    const r = c.getBoundingClientRect();
    return { w: r.width, h: r.height, iw: innerWidth, ih: innerHeight };
  });
  expect((box.w * box.h) / (box.iw * box.ih)).toBeGreaterThan(0.95);
  // No real click anywhere: the boot's own focus click is what makes this work.
  expect(await visibleWx(frame, { type: 'wxDialog' })).toEqual([]);
  expect(await request(page, 'key.press', { key: 'a', code: 'KeyA' })).toEqual({});
  await expect.poll(async () => (await visibleWx(frame, { type: 'wxDialog' })).length, { timeout: 15_000 }).toBe(1);
  // While the chooser is up, a key is refused rather than typed into it (the harness rejects with "code: message").
  await expect(request(page, 'key.press', { key: 'w', code: 'KeyW' })).rejects.toThrow('busy: key.press');
  await clickWx(page, frame, 'Cancel');
  await expect.poll(async () => (await visibleWx(frame, { type: 'wxDialog' })).length).toBe(0);
  // chrome.show brings the chrome back, and off again.
  expect(await request(page, 'chrome.show', { on: true })).toEqual({});
  await expect.poll(async () => (await visibleWx(frame, { type: 'wxMenuBar' })).length).toBe(1);
  expect(await request(page, 'chrome.show', { on: false })).toEqual({});
  await expect.poll(async () => (await visibleWx(frame, { type: 'wxMenuBar' })).length).toBe(0);
});

/** A seeded config file of the frame's MEMFS, parsed. */
const seededConfig = (frame: Frame, file: string): Promise<Record<string, any>> => frame.evaluate((name) => {
  const FS = (window as unknown as { FS: { readFile(p: string, o: { encoding: 'utf8' }): string } }).FS;
  return JSON.parse(FS.readFile(`/home/kicad/.config/kicad/kicad/10.0/${name}`, { encoding: 'utf8' })) as Record<string, any>;
}, file);

test('the board frame boots canvas only too, with the cheap cursor seeds', async ({ page }) => {
  const frame = await boot(page, 'fixture=glasgow&frame=pcb', 'glasgow.kicad_pcb');
  const types = new Set((await visibleWx(frame, {})).map((e) => e.typeName));
  expect([...types].sort()).toEqual(['wxFrame', 'wxGLCanvas']);
  // No anti-aliasing, so the full-frame canvas keeps up with the pointer (task F1: SMAA
  // dropped the GL canvas, supersampling doubled every repaint).
  expect((await seededConfig(frame, 'kicad_common.json')).graphics).toEqual({ antialiasing_mode: 0 });
  // The crosshair shows only inside a drawing tool, so the system pointer leads (task F1b).
  for (const file of ['pcbnew.json', 'eeschema.json']) {
    expect((await seededConfig(frame, file)).window?.cursor).toEqual({ cross_hair_mode: 0, always_show_cursor: false });
  }
});

test('a seeded chord starts a tool KiCad gives no key: Ctrl+Alt+R draws a schematic rectangle', async ({ page }) => {
  const frame = await boot(page, 'fixture=glasgow&frame=sch', 'glasgow.kicad_sch');
  // The harness keeps only the first 4 KiB of a save, so the count reads the saved root file from MEMFS.
  const rectangles = async (): Promise<number> => {
    expect(await request(page, 'project.save')).toEqual({ path: 'glasgow.kicad_sch' });
    return frame.evaluate(() => {
      const FS = (window as unknown as { FS: { readdir(p: string): string[]; stat(p: string): { mode: number }; isDir(m: number): boolean; readFile(p: string, o: { encoding: 'utf8' }): string } }).FS;
      const walk = (dir: string): string | null => {
        for (const n of FS.readdir(dir).filter((x) => x !== '.' && x !== '..')) {
          const p = `${dir}/${n}`;
          if (FS.isDir(FS.stat(p).mode)) { const f = walk(p); if (f != null) return f; } else if (n === 'glasgow.kicad_sch') return p;
        }
        return null;
      };
      const path = walk('/home/kicad/documents/kicad/10.0/projects');
      return path == null ? -1 : FS.readFile(path, { encoding: 'utf8' }).split('(rectangle').length - 1;
    });
  };
  const before = await rectangles();
  // A tool started by its hotkey takes the pointer as its first click, so the pointer goes to one corner first.
  const box = await page.locator('iframe').boundingBox();
  if (box == null) throw new Error('no iframe box');
  await page.mouse.move(box.x + 1000, box.y + 640, { steps: 4 });
  // theme/user.hotkeys binds eeschema.InteractiveDrawing.drawRectangle to Ctrl+Alt+R (theme/pencil-tools.json).
  expect(await request(page, 'key.press', { key: 'r', code: 'KeyR', ctrl: true, alt: true })).toEqual({});
  // A click at the opposite corner finishes the rectangle; Escape leaves the tool.
  await clickIn(page, 1150, 730);
  expect(await request(page, 'key.press', { key: 'Escape', code: 'Escape' })).toEqual({});
  await expect.poll(rectangles, { timeout: 10_000 }).toBe(before + 1);
});

/** The appearance.color_theme an editor's seeded config selects, read from the frame's MEMFS. */
const colorTheme = (frame: Frame, file: 'eeschema.json' | 'pcbnew.json'): Promise<unknown> => frame.evaluate((name) => {
  const FS = (window as unknown as { FS: { readFile(p: string, o: { encoding: 'utf8' }): string } }).FS;
  return (JSON.parse(FS.readFile(`/home/kicad/.config/kicad/kicad/10.0/${name}`, { encoding: 'utf8' })) as { appearance?: { color_theme?: unknown } }).appearance?.color_theme;
}, file);
/** The board view's zoom, from the engine's own viewport report. */
const viewScale = async (frame: Frame): Promise<number> => (JSON.parse(await frame.evaluate(() => (window as unknown as { Module: { kicadCollabGetViewport(): string } }).Module.kicadCollabGetViewport())) as { scale: number }).scale;

test('sheets and layers answer from the engine, and fit refits the view', async ({ page }) => {
  const sch = await boot(page, 'fixture=glasgow&frame=sch', 'glasgow.kicad_sch');
  expect(await colorTheme(sch, 'eeschema.json')).toBe('circuitcenter');
  const tree = await request(page, 'sheet.tree') as { current: string; sheets: Array<{ path: string; name: string; file: string }> };
  expect(tree.current).toBe('/');
  // Each row names its file by base name only; the engine's absolute path stays in the frame.
  expect(tree.sheets.find((s) => s.path === '/')?.file).toBe('glasgow.kicad_sch');
  expect(tree.sheets.every((s) => !s.file.includes('/'))).toBe(true);
  const banks = tree.sheets.find((s) => s.name === 'IO_Banks');
  expect(banks).toBeDefined();
  expect(banks!.file).toBe('io_banks.kicad_sch');
  expect(await request(page, 'sheet.enter', { path: banks!.path })).toEqual({});
  await expect.poll(async () => ((await request(page, 'sheet.tree')) as { current: string }).current, { timeout: 10_000 }).toBe(banks!.path);
  // The schematic frame has no layers (the harness rejects with "code: message").
  await expect(request(page, 'layers.get')).rejects.toThrow('unsupported: kicadLayersGetState');

  // The board frame.
  const pcb = await boot(page, 'fixture=glasgow&frame=pcb', 'glasgow.kicad_pcb');
  expect(await colorTheme(pcb, 'pcbnew.json')).toBe('circuitcenter');
  await expect(request(page, 'sheet.tree')).rejects.toThrow('unsupported: kicadSheetsGetTree');
  const state = await request(page, 'layers.get') as { active: number; layers: Array<{ id: number; name: string; visible: boolean }> };
  const bcu = state.layers.find((l) => l.name === 'B.Cu');
  expect(bcu?.visible).toBe(true);
  expect(await request(page, 'layers.visible', { id: bcu!.id, visible: false })).toEqual({});
  expect(await request(page, 'layers.active', { id: bcu!.id })).toEqual({});
  await expect.poll(async () => {
    const s = (await request(page, 'layers.get')) as typeof state;
    return [s.active, s.layers.find((l) => l.name === 'B.Cu')?.visible];
  }, { timeout: 5_000 }).toEqual([bcu!.id, false]);

  // key.press reaches the board: F1 (KiCad's Zoom In) zooms in, and view.fit (Home) zooms back out to the board.
  const fitted = await viewScale(pcb);
  expect(await request(page, 'key.press', { key: 'F1', code: 'F1' })).toEqual({});
  await expect.poll(() => viewScale(pcb), { timeout: 5_000 }).toBeGreaterThan(fitted * 1.5);
  const zoomed = await viewScale(pcb);
  expect(await request(page, 'view.fit')).toEqual({});
  await expect.poll(() => viewScale(pcb), { timeout: 5_000 }).toBeLessThan(zoomed / 1.5);
});
