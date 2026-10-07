// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The headed suite over the local pair (tests/serve.mjs): the island boots in
// the sandboxed, cross-origin isolated iframe the site uses, opens a handed-over
// project, saves both ways, drops traversal paths, never leaves the pair,
// never opens a popup, and lets go of its engine on shutdown. The harness (tests/harness/parent.html) speaks
// cc-editor/1 and keeps every event on window.__events.
import { expect, test, type BrowserContext, type Frame, type Page } from '@playwright/test';
import palette from '../../theme/colors/circuitcenter.json' with { type: 'json' };

const PAGE = 'http://circuitcenter.localhost:4173';
const ISLAND = 'http://editor.circuitcenter.localhost:4174';
const PAIR = new Set([PAGE, ISLAND]);

interface Ev { type: string; phase?: string; detail?: string; path?: string; bytes?: number; text?: string; topic?: string; caps?: string[]; open?: boolean; depth?: number; at: number }
interface Harness {
  __events: Ev[];
  /** The latest bytes ev.saved brought for each path, whole. */
  __saved: Record<string, Uint8Array>;
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
async function clickIn(page: Page, x: number, y: number, button: 'left' | 'right' = 'left'): Promise<void> {
  const box = await page.locator('iframe').boundingBox();
  if (box == null) throw new Error('no iframe box');
  await page.mouse.click(box.x + x, box.y + y, { button });
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

/** The centre of the first DOM element under `selector` whose text is `text` (wx-dom.js draws the menu bar and its popups as DOM). */
const domPoint = (frame: Frame, selector: string, text: string): Promise<[number, number] | null> =>
  frame.evaluate(([sel, t]) => {
    const el = [...document.querySelectorAll(sel)].find((e) => e.textContent?.trim() === t);
    if (el == null) return null;
    const r = el.getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2] as [number, number];
  }, [selector, text] as const);

/**
 * KiCad's own symbol chooser through its own menus, the path PICKER.md keeps
 * (the island takes the A key for the host's picker): KiCad's chrome comes
 * on, then Place > Place Symbols.
 */
async function kicadSymbolChooser(page: Page, frame: Frame): Promise<void> {
  expect(await request(page, 'chrome.show', { on: true })).toEqual({});
  await expect.poll(() => domPoint(frame, '.wx-menu-title', 'Place')).not.toBeNull();
  await clickIn(page, ...(await domPoint(frame, '.wx-menu-title', 'Place'))!);
  await expect.poll(() => domPoint(frame, '.wx-menu-popup *', 'Place Symbols')).not.toBeNull();
  await clickIn(page, ...(await domPoint(frame, '.wx-menu-popup *', 'Place Symbols'))!);
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
  expect(saved).toEqual({ path: 'glasgow.kicad_pcb', saved: ['glasgow.kicad_pcb'] });
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

/** Every file of the Glasgow schematic KiCad's own Save writes: the three sheets and the project file. */
const GLASGOW_SAVE = ['glasgow.kicad_pro', 'glasgow.kicad_sch', 'io_banks.kicad_sch', 'io_buffer.kicad_sch'];
/** project.save's answer with `saved` sorted (the engine's own order is not part of the protocol). */
async function saveAll(page: Page): Promise<{ path: unknown; saved: string[] }> {
  const r = await request(page, 'project.save');
  return { path: r.path, saved: [...(r.saved as string[])].sort() };
}

test('a hierarchical schematic saves every sheet, the hotkeys work, and a second open replaces the first', async ({ page, context }) => {
  const w = watch(context, page);
  const frame = await boot(page, 'fixture=glasgow&frame=sch', 'glasgow.kicad_sch');
  // The frame boots canvas only; this test reads the properties and hierarchy panes, so the chrome comes back.
  expect(await request(page, 'chrome.show', { on: true })).toEqual({});
  // KiCad's own Save writes every sheet and the project file; path names the root, the sheet on screen.
  expect(await saveAll(page)).toEqual({ path: 'glasgow.kicad_sch', saved: GLASGOW_SAVE });
  // Every file's ev.saved came before the answer.
  for (const f of GLASGOW_SAVE) expect(await savedCount(page, f)).toBe(1);
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
  expect(await saveAll(page)).toEqual({ path: 'io_banks.kicad_sch', saved: GLASGOW_SAVE });
  const sub = (await events(page)).filter((e) => e.type === 'ev.saved' && e.path === 'io_banks.kicad_sch').at(-1);
  expect(await savedCount(page, 'io_banks.kicad_sch')).toBe(2);
  expect(sub?.text?.startsWith('(kicad_sch')).toBe(true);

  // KiCad's place key A: with the library mirror (ev.ready lists the pseudo-cap picker) it is the
  // host's picker's, so the island sends ev.pick and KiCad's chooser never opens
  // (tests/e2e/picker.spec.ts has the rest); on the example library it opens KiCad's chooser.
  // A chooser's first open enumerates every symbol library, about 15 s on the full KiCad
  // mirror (LIBRARY.md), so each chooser wait in this file allows 120 s.
  expect(await visibleWx(frame, { type: 'wxDialog' })).toEqual([]);
  const picker = (await events(page)).find((e) => e.type === 'ev.ready')?.caps?.includes('picker') === true;
  await clickIn(page, 1100, 730);
  await page.keyboard.press('a');
  if (picker) {
    await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.pick'));
    await page.waitForTimeout(1_000);
    expect(await visibleWx(frame, { type: 'wxDialog' })).toEqual([]);
  } else {
    await expect.poll(async () => (await visibleWx(frame, { type: 'wxDialog' })).length, { timeout: 120_000 }).toBe(1);
    await clickWx(page, frame, 'Cancel');
    await expect.poll(async () => (await visibleWx(frame, { type: 'wxDialog' })).length).toBe(0);
  }
  await page.keyboard.press('Escape');

  // project.open over the opened, unmodified project: answered, and no modal is left up.
  const again = await page.evaluate(() => (window as unknown as Harness).__openFixture());
  // The chrome was turned on for this boot, so the answer says it shows.
  expect(again).toEqual({ opened: 'glasgow.kicad_sch', dropped: [], chrome: true });
  expect((await visibleWx(frame, {})).filter((e) => /Dialog/.test(e.typeName))).toEqual([]);
  expect(await saveAll(page)).toEqual({ path: 'glasgow.kicad_sch', saved: GLASGOW_SAVE });

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
  // The symbol chooser enumerates the libraries the project's sym-lib-table names. A
  // chooser's first open enumerates every symbol library, about 15 s on the full KiCad
  // mirror (LIBRARY.md), so the wait allows 120 s, as tests/e2e/libs.spec.ts does.
  await kicadSymbolChooser(page, frame);
  await expect.poll(async () => (await visibleWx(frame, { type: 'wxDialog' })).length, { timeout: 120_000 }).toBe(1);
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

/** The wx types on screen, sorted. */
const shownTypes = async (frame: Frame): Promise<string[]> => [...new Set((await visibleWx(frame, {})).map((e) => e.typeName))].sort();

/**
 * Canvas only, and it stays so: KiCad can show its menu bar again after the
 * open answered (2 of 14 runs before the open watched it), so the check polls
 * until only the frame and its canvas show, then looks again a second later.
 */
async function expectCanvasOnly(page: Page, frame: Frame): Promise<void> {
  await expect.poll(() => shownTypes(frame), { timeout: 10_000 }).toEqual(['wxFrame', 'wxGLCanvas']);
  await page.waitForTimeout(1_000);
  expect(await shownTypes(frame)).toEqual(['wxFrame', 'wxGLCanvas']);
}

test('boots with KiCad\'s chrome hidden, and key.press reaches KiCad with no real click', async ({ page }) => {
  const frame = await boot(page, 'fixture=glasgow&frame=sch', 'glasgow.kicad_sch');
  // Canvas only: no menu bar, toolbar, status bar or pane is visible, and the open said so.
  await expectCanvasOnly(page, frame);
  const box = await frame.evaluate(() => {
    const c = [...document.querySelectorAll<HTMLCanvasElement>('canvas.gl-canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0];
    const r = c.getBoundingClientRect();
    return { w: r.width, h: r.height, iw: innerWidth, ih: innerHeight };
  });
  expect((box.w * box.h) / (box.iw * box.ih)).toBeGreaterThan(0.95);
  // No real click anywhere: the boot's own focus click is what makes this work. The
  // seeded chord Ctrl+Alt+7 opens KiCad's schematic checker (theme/pencil-tools.json).
  expect(await visibleWx(frame, { type: 'wxDialog' })).toEqual([]);
  expect(await request(page, 'key.press', { key: '7', code: 'Digit7', ctrl: true, alt: true })).toEqual({});
  await expect.poll(async () => (await visibleWx(frame, { type: 'wxDialog' })).length, { timeout: 15_000 }).toBe(1);
  // While the checker is up, a key is refused rather than typed into it (the harness rejects with "code: message").
  await expect(request(page, 'key.press', { key: 'w', code: 'KeyW' })).rejects.toThrow('busy: key.press');
  await clickWx(page, frame, 'Close');
  await expect.poll(async () => (await visibleWx(frame, { type: 'wxDialog' })).length).toBe(0);
  // chrome.show brings the chrome back, and off again.
  expect(await request(page, 'chrome.show', { on: true })).toEqual({});
  await expect.poll(async () => (await visibleWx(frame, { type: 'wxMenuBar' })).length).toBe(1);
  expect(await request(page, 'chrome.show', { on: false })).toEqual({});
  await expect.poll(async () => (await visibleWx(frame, { type: 'wxMenuBar' })).length).toBe(0);
});

test('a press in the drawing takes the keyboard back from the host page, so its keys reach KiCad', async ({ page }) => {
  const frame = await boot(page, 'fixture=glasgow&frame=sch', 'glasgow.kicad_sch');
  // A control of the host page takes the focus, as the viewer's own buttons do.
  await page.evaluate(() => { const b = document.createElement('button'); b.id = 'host-control'; b.textContent = 'host'; document.body.prepend(b); });
  await page.click('#host-control');
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('host-control');
  expect(await frame.evaluate(() => document.hasFocus())).toBe(false);
  // A press in the drawing (KiCad cancels the mousedown, so the browser alone would leave the focus on the button).
  await clickIn(page, 1100, 730);
  await expect.poll(() => frame.evaluate(() => document.hasFocus())).toBe(true);
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('IFRAME');
  // The user's own key reaches KiCad: the seeded chord Ctrl+Alt+7 opens its schematic checker.
  expect(await visibleWx(frame, { type: 'wxDialog' })).toEqual([]);
  await page.keyboard.press('Control+Alt+7');
  await expect.poll(async () => (await visibleWx(frame, { type: 'wxDialog' })).length, { timeout: 15_000 }).toBe(1);
});

test('a popup menu is reported as ev.menu while it is up, and holds the host\'s keys back', async ({ page }) => {
  await boot(page, 'fixture=glasgow&frame=pcb', 'glasgow.kicad_pcb');
  const menus = async (): Promise<boolean[]> => (await events(page)).filter((e) => e.type === 'ev.menu').map((e) => e.open === true);
  expect(await menus()).toEqual([]);
  // A right press on the board opens KiCad's context menu (a wx-dom popup, not a wxWindow).
  await clickIn(page, 640, 400, 'right');
  await expect.poll(menus, { timeout: 10_000 }).toEqual([true]);
  // While it is up, a key from the host would land in it: refused.
  await expect(request(page, 'key.press', { key: 'a', code: 'KeyA' })).rejects.toThrow('busy: key.press');
  await expect(request(page, 'view.fit')).rejects.toThrow('busy: view.fit');
  await page.keyboard.press('Escape');
  await expect.poll(menus, { timeout: 10_000 }).toEqual([true, false]);
  expect(await request(page, 'view.fit')).toEqual({});
});

/** The engine's own test hooks (PCBJam's ysync suite uses them): an undoable local commit, KiCad's Undo and its undo depth. */
interface EngineHooks { Module: { kicadCollabTestUndoDepth(): number; kicadCollabTestMoveFirst(dx: number, dy: number): string; kicadCollabTestUndo(): boolean } }

test('an edit in the drawing is sent as ev.edited with KiCad\'s undo depth, an undo too, and opening or saving the board sends none', async ({ page }) => {
  const frame = await boot(page, 'fixture=glasgow&frame=pcb', 'glasgow.kicad_pcb');
  expect((await events(page)).find((e) => e.type === 'ev.ready')?.caps).toContain('kicadCollabTestUndoDepth');
  const edited = async (): Promise<number[]> => (await events(page)).filter((e) => e.type === 'ev.edited').map((e) => e.depth ?? -1);
  const depth = (): Promise<number> => frame.evaluate(() => (window as unknown as EngineHooks).Module.kicadCollabTestUndoDepth());
  // Opening Glasgow is no edit: four polls, 500 ms apart, send nothing.
  await page.waitForTimeout(2_000);
  expect(await edited()).toEqual([]);
  const before = await depth();
  expect(before).toBeGreaterThanOrEqual(0);
  // A real undoable commit: the engine's own move of the first item, 2 mm to the right.
  expect(await frame.evaluate(() => (window as unknown as EngineHooks).Module.kicadCollabTestMoveFirst(2_000_000, 0))).toMatch(/[0-9a-f-]{36}/);
  await expect.poll(async () => (await edited()).at(-1) ?? -1, { timeout: 10_000 }).toBeGreaterThan(before);
  const after = await depth();
  await expect.poll(async () => (await edited()).at(-1), { timeout: 10_000 }).toBe(after);
  measure('ev.edited', `depth ${before} before the move, ${after} after it`);
  // Each event carries exactly its keys (the harness adds `at`).
  const first = (await events(page)).find((e) => e.type === 'ev.edited');
  expect(Object.keys(first ?? {}).filter((k) => k !== 'at').sort()).toEqual(['depth', 'type']);
  // KiCad's Undo lowers the depth, and that is sent too.
  expect(await frame.evaluate(() => (window as unknown as EngineHooks).Module.kicadCollabTestUndo())).toBe(true);
  await expect.poll(async () => (await edited()).at(-1), { timeout: 10_000 }).toBe(before);
  // A save leaves the undo list as it is: nothing more is sent.
  const sent = (await edited()).length;
  expect(await request(page, 'project.save')).toMatchObject({ path: 'glasgow.kicad_pcb' });
  await page.waitForTimeout(1_500);
  expect((await edited()).length).toBe(sent);
});

test('a schematic save closes an open popup menu first, as Escape does, and saves every sheet', async ({ page }) => {
  await boot(page, 'fixture=glasgow&frame=sch', 'glasgow.kicad_sch');
  const menus = async (): Promise<boolean[]> => (await events(page)).filter((e) => e.type === 'ev.menu').map((e) => e.open === true);
  // A right press in the drawing opens KiCad's context menu (a wx-dom popup).
  await clickIn(page, 1100, 730, 'right');
  await expect.poll(menus, { timeout: 10_000 }).toEqual([true]);
  // A menu holds no edits: the save closes it and goes on, rather than answering busy.
  expect(await saveAll(page)).toEqual({ path: 'glasgow.kicad_sch', saved: GLASGOW_SAVE });
  await expect.poll(menus, { timeout: 10_000 }).toEqual([true, false]);
  // The editor takes keys again.
  expect(await request(page, 'view.fit')).toEqual({});
});

/** A seeded config file of the frame's MEMFS, parsed. */
const seededConfig = (frame: Frame, file: string): Promise<Record<string, any>> => frame.evaluate((name) => {
  const FS = (window as unknown as { FS: { readFile(p: string, o: { encoding: 'utf8' }): string } }).FS;
  return JSON.parse(FS.readFile(`/home/kicad/.config/kicad/kicad/10.0/${name}`, { encoding: 'utf8' })) as Record<string, any>;
}, file);

test('the board frame boots canvas only too, and the island wrote the cheap cursor seeds', async ({ page }) => {
  const frame = await boot(page, 'fixture=glasgow&frame=pcb', 'glasgow.kicad_pcb');
  await expectCanvasOnly(page, frame);
  // These read back the seed files the island wrote into MEMFS before main(),
  // which proves the seeds were written, not that KiCad applied them: the
  // engine keeps its settings in memory and never writes these files back
  // during a session, and neither anti-aliasing nor the crosshair mode shows
  // through anything the page can read (review P26, 2026-10-01; the idle
  // pointer is the system arrow either way). The seeds carry no meta.version.
  // No anti-aliasing, so the full-frame canvas keeps up with the pointer (task F1: SMAA
  // dropped the GL canvas, supersampling doubled every repaint).
  expect((await seededConfig(frame, 'kicad_common.json')).graphics).toEqual({ antialiasing_mode: 0 });
  // The crosshair shows only inside a drawing tool, so the system pointer leads (task F1b).
  for (const file of ['pcbnew.json', 'eeschema.json']) {
    expect((await seededConfig(frame, file)).window?.cursor).toEqual({ cross_hair_mode: 0, always_show_cursor: false });
  }
  // A Ctrl+Alt+Shift chord reaches the engine too: theme/user.hotkeys binds pcbnew.DRCTool.runDRC,
  // a topbar tool KiCad gives no key, to Ctrl+Alt+Shift+K (theme/pencil-tools.json), and it opens the checker.
  expect(await visibleWx(frame, { type: 'wxDialog' })).toEqual([]);
  expect(await request(page, 'key.press', { key: 'K', code: 'KeyK', ctrl: true, shift: true, alt: true })).toEqual({});
  await expect.poll(async () => (await visibleWx(frame, { type: 'wxDialog' })).length, { timeout: 15_000 }).toBe(1);
});

test('a seeded topbar chord opens the schematic checker: Ctrl+Alt+7 runs ERC', async ({ page }) => {
  const frame = await boot(page, 'fixture=glasgow&frame=sch', 'glasgow.kicad_sch');
  expect(await visibleWx(frame, { type: 'wxDialog' })).toEqual([]);
  // theme/user.hotkeys binds eeschema.InspectionTool.runERC to Ctrl+Alt+7 (theme/pencil-tools.json, strip top).
  expect(await request(page, 'key.press', { key: '7', code: 'Digit7', ctrl: true, alt: true })).toEqual({});
  await expect.poll(async () => (await visibleWx(frame, { type: 'wxDialog' })).length, { timeout: 15_000 }).toBe(1);
});

test('a seeded chord starts a tool KiCad gives no key, and one project.save keeps the edits on every sheet', async ({ page }) => {
  const frame = await boot(page, 'fixture=glasgow&frame=sch', 'glasgow.kicad_sch');
  // The harness keeps only the first 4 KiB of a save, so the counts read the saved sheet files from MEMFS.
  const rectangles = (file: string): Promise<number> => frame.evaluate((name) => {
    const FS = (window as unknown as { FS: { readdir(p: string): string[]; stat(p: string): { mode: number }; isDir(m: number): boolean; readFile(p: string, o: { encoding: 'utf8' }): string } }).FS;
    const walk = (dir: string): string | null => {
      for (const n of FS.readdir(dir).filter((x) => x !== '.' && x !== '..')) {
        const p = `${dir}/${n}`;
        if (FS.isDir(FS.stat(p).mode)) { const f = walk(p); if (f != null) return f; } else if (n === name) return p;
      }
      return null;
    };
    const path = walk('/home/kicad/documents/kicad/10.0/projects');
    return path == null ? -1 : FS.readFile(path, { encoding: 'utf8' }).split('(rectangle').length - 1;
  }, file);
  const box = await page.locator('iframe').boundingBox();
  if (box == null) throw new Error('no iframe box');
  /** A tool started by its hotkey takes the pointer as its first click, so the pointer goes to one corner first. */
  const drawRectangle = async (): Promise<void> => {
    await page.mouse.move(box.x + 1000, box.y + 640, { steps: 4 });
    // theme/user.hotkeys binds eeschema.InteractiveDrawing.drawRectangle to Ctrl+Alt+R (theme/pencil-tools.json).
    expect(await request(page, 'key.press', { key: 'r', code: 'KeyR', ctrl: true, alt: true })).toEqual({});
    // A click at the opposite corner finishes the rectangle; Escape leaves the tool.
    await clickIn(page, 1150, 730);
    expect(await request(page, 'key.press', { key: 'Escape', code: 'Escape' })).toEqual({});
  };
  expect(await saveAll(page)).toEqual({ path: 'glasgow.kicad_sch', saved: GLASGOW_SAVE });
  const root = await rectangles('glasgow.kicad_sch');
  const banks = await rectangles('io_banks.kicad_sch');

  // One rectangle on the root sheet, one on IO_Banks.
  await drawRectangle();
  const tree = await request(page, 'sheet.tree') as { sheets: Array<{ path: string; name: string }> };
  const io = tree.sheets.find((x) => x.name === 'IO_Banks');
  expect(io).toBeDefined();
  expect(await request(page, 'sheet.enter', { path: io!.path })).toEqual({});
  await expect.poll(async () => ((await request(page, 'sheet.tree')) as { current: string }).current, { timeout: 10_000 }).toBe(io!.path);
  await drawRectangle();

  // One save from IO_Banks writes both sheets (review M11: it used to write only the sheet on screen).
  const savedBefore = (await events(page)).filter((e) => e.type === 'ev.saved').length;
  expect(await saveAll(page)).toEqual({ path: 'io_banks.kicad_sch', saved: GLASGOW_SAVE });
  // Every ev.saved of the save reached the host before the answer.
  expect((await events(page)).filter((e) => e.type === 'ev.saved').length - savedBefore).toBe(GLASGOW_SAVE.length);
  expect(await rectangles('glasgow.kicad_sch')).toBe(root + 1);
  expect(await rectangles('io_banks.kicad_sch')).toBe(banks + 1);
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

// Pours (2026-10-02): KiCad's own display settings draw zones at 0.6 opacity,
// which over the palette's black board turns the viewer's green pour olive;
// the island stages <stem>.kicad_prl with every opacity at 1 when the host
// sent none.
test('pours: an opened board paints its pours opaque, in the palette colour the viewer draws', async ({ page }) => {
  const frame = await boot(page, 'fixture=glasgow&frame=pcb', 'glasgow.kicad_pcb');
  expect(await request(page, 'view.fit')).toEqual({});
  // Glasgow's GND pour on In1.Cu covers the board under the front copper.
  await expectPour(frame, pourOverBlack('in1'), 'glasgow.kicad_pcb after the open');
});

// project.import (spike 2026-10-02): a foreign board through KiCad's own
// importers in the board frame, its dialogs answered by the island, saved as
// <stem>.kicad_pcb. The boards are KiCad's qa samples at the engine's pin (and
// one EasyEDA Standard board of ours), in tests/e2e/fixtures/import with a
// .license note each.

interface ImportResult { opened: string; dropped: string[]; warnings: string[]; chrome: boolean }

/**
 * project.import of one file, named as itself and opened by itself: a board of
 * tests/e2e/fixtures/import (serve.mjs serves it at /e2e-fixtures/), or `text`
 * when given. Rejects with "code: message". The seconds run from the request
 * to the answer, the board's fetch excluded.
 */
async function importBoard(page: Page, name: string, text?: string): Promise<{ result: ImportResult; seconds: number }> {
  const [result, ms] = await page.evaluate(async ([n, t]) => {
    const bytes = t != null ? new TextEncoder().encode(t) : new Uint8Array(await (await fetch(`/e2e-fixtures/import/${encodeURIComponent(n)}`)).arrayBuffer());
    const t0 = performance.now();
    const r = await (window as unknown as Harness).__bridge.request('project.import', { name: n, files: [{ path: n, bytes }], open: n });
    return [r, performance.now() - t0] as const;
  }, [name, text] as const);
  return { result: result as unknown as ImportResult, seconds: ms / 1000 };
}

/** The whole file the last ev.saved brought for `path`, as text. */
const savedText = (page: Page, path: string): Promise<string> =>
  page.evaluate((p) => new TextDecoder().decode((window as unknown as Harness).__saved[p]), path);

type Sx = string | Sx[];
/** KiCad's s-expression format read whole: throws on an unbalanced list, an unterminated string or anything after the top form. */
function readSexpr(text: string): Sx {
  let i = 0;
  const space = (): void => { while (i < text.length && /\s/.test(text[i])) i++; };
  const node = (): Sx => {
    space();
    if (text[i] === '(') {
      i++;
      const list: Sx[] = [];
      for (;;) {
        space();
        if (i >= text.length) throw new Error('an unterminated list');
        if (text[i] === ')') { i++; return list; }
        list.push(node());
      }
    }
    if (text[i] === '"') {
      let s = '';
      for (i++; ; i++) {
        if (i >= text.length) throw new Error('an unterminated string');
        if (text[i] === '\\') { s += text[++i]; continue; }
        if (text[i] === '"') { i++; return s; }
        s += text[i];
      }
    }
    const start = i;
    while (i < text.length && !/[\s()"]/.test(text[i])) i++;
    if (i === start) throw new Error(`unexpected ${JSON.stringify(text[i])} at ${i}`);
    return text.slice(start, i);
  };
  const root = node();
  space();
  if (i !== text.length) throw new Error(`text after the top form at ${i}`);
  return root;
}

/** What a converted board file holds: its top form, its format version and its counts. */
function boardFacts(text: string) {
  const root = readSexpr(text);
  if (!Array.isArray(root)) throw new Error('the board is not a list');
  const kids = root.filter((k): k is Sx[] => Array.isArray(k));
  const count = (head: string): number => kids.filter((k) => k[0] === head).length;
  const layers = kids.find((k) => k[0] === 'layers') ?? [];
  return {
    head: root[0],
    version: Number(kids.find((k) => k[0] === 'version')?.[1]),
    footprints: count('footprint'),
    segments: count('segment'),
    vias: count('via'),
    copper: layers.filter((l) => Array.isArray(l) && /\.Cu$/.test(String(l[1]))).length,
  };
}

/**
 * The board's outline from a converted board file: the bounding box (nm) of
 * every top-level graphic on Edge.Cuts, or null when it has none.
 */
function outlineBox(text: string): { x0: number; y0: number; x1: number; y1: number } | null {
  const root = readSexpr(text);
  if (!Array.isArray(root)) return null;
  const xs: number[] = [];
  const ys: number[] = [];
  const at = (k: Sx[], head: string): [number, number] | null => {
    const p = k.find((c): c is Sx[] => Array.isArray(c) && c[0] === head);
    return p == null ? null : [Number(p[1]) * 1e6, Number(p[2]) * 1e6];
  };
  for (const k of root.filter((c): c is Sx[] => Array.isArray(c) && /^gr_(line|rect|arc|circle|poly|curve)$/.test(String(c[0])))) {
    const layer = k.find((c): c is Sx[] => Array.isArray(c) && c[0] === 'layer');
    if (layer?.[1] !== 'Edge.Cuts') continue;
    if (k[0] === 'gr_circle') {
      const c = at(k, 'center');
      const e = at(k, 'end');
      if (c == null || e == null) continue;
      const r = Math.hypot(e[0] - c[0], e[1] - c[1]);
      xs.push(c[0] - r, c[0] + r);
      ys.push(c[1] - r, c[1] + r);
      continue;
    }
    for (const head of ['start', 'mid', 'end']) { const p = at(k, head); if (p != null) { xs.push(p[0]); ys.push(p[1]); } }
    const pts = k.find((c): c is Sx[] => Array.isArray(c) && c[0] === 'pts');
    for (const xy of (pts ?? []).filter((c): c is Sx[] => Array.isArray(c) && c[0] === 'xy')) { xs.push(Number(xy[1]) * 1e6); ys.push(Number(xy[2]) * 1e6); }
  }
  return xs.length === 0 ? null : { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** The engine's viewport: its centre (nm), its scale (px per nm) and the drawing's size (px). */
const viewport = async (frame: Frame): Promise<{ cx: number; cy: number; scale: number; w: number; h: number }> =>
  JSON.parse(await frame.evaluate(() => (window as unknown as { Module: { kicadCollabGetViewport(): string } }).Module.kicadCollabGetViewport()));

/**
 * Where the board's outline sits in the view: `inside` when the whole outline
 * is on screen (1 px of slack), and `fill`, the share of the view's width or
 * height (the larger) the outline spans.
 */
async function outlineInView(frame: Frame, text: string): Promise<{ inside: boolean; fill: number }> {
  const box = outlineBox(text);
  if (box == null) throw new Error('the converted board has no outline');
  const v = await viewport(frame);
  const halfW = v.w / 2 / v.scale;
  const halfH = v.h / 2 / v.scale;
  const slack = 1 / v.scale;
  const inside = box.x0 >= v.cx - halfW - slack && box.x1 <= v.cx + halfW + slack && box.y0 >= v.cy - halfH - slack && box.y1 <= v.cy + halfH + slack;
  return { inside, fill: Math.max((box.x1 - box.x0) / (2 * halfW), (box.y1 - box.y0) / (2 * halfH)) };
}

/** The island's canvas theme (the viewer's palette), as the engine loads it. */
const PALETTE = palette as unknown as { board: Record<string, string> & { copper: Record<string, string> } };
/** An opaque `rgb(r, g, b)` palette value as [r, g, b]. */
const rgbOf = (css: string): number[] => {
  const m = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(css);
  if (m == null) throw new Error(`not an opaque rgb() palette value: ${css}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};

/**
 * Colours only one of the two palettes draws on a board: the circuitcenter
 * palette's front and back copper, via hole wall, board edge and front
 * silkscreen, read from the theme file; and KiCad's built-in default as it
 * shows over its own background (the board outline area, the ratsnest, a
 * non-plated hole, a via's hole wall), which a theme that failed to load
 * would draw.
 */
const PALETTE_TELLS = {
  circuitcenter: [PALETTE.board.copper.f, PALETTE.board.copper.b, PALETTE.board.via_hole_walls, PALETTE.board.edge_cuts, PALETTE.board.f_silks].map(rgbOf),
  kicadDefault: [[35, 45, 58], [0, 97, 112], [26, 196, 210], [236, 236, 236]],
};

/**
 * The drawing as the frame shows it, read back whole from the surface the
 * engine draws into (its GL contexts keep their drawing buffer): the colour
 * at the four corners, how many distinct colours, and how many pixels show
 * a colour only the circuitcenter palette draws, or only KiCad's default.
 */
const drawing = (frame: Frame) => frame.evaluate((tells) => {
  const gls = [...document.querySelectorAll('canvas.gl-canvas')] as HTMLCanvasElement[];
  const src = gls.filter((c) => c.style.display !== 'none' && c.width > 0).sort((a, b) => b.width * b.height - a.width * a.height)[0] ?? (document.getElementById('canvas') as HTMLCanvasElement);
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0);
  const px = ctx.getImageData(0, 0, c.width, c.height).data;
  const at = (x: number, y: number): string => { const i = (y * c.width + x) * 4; return `${px[i]},${px[i + 1]},${px[i + 2]},${px[i + 3]}`; };
  const near = (i: number, [r, g, b]: number[]): boolean => Math.abs(px[i] - r) <= 1 && Math.abs(px[i + 1] - g) <= 1 && Math.abs(px[i + 2] - b) <= 1;
  const colours = new Set<number>();
  let circuitcenter = 0;
  let kicadDefault = 0;
  for (let i = 0; i < px.length; i += 4) {
    colours.add((px[i] << 16) | (px[i + 1] << 8) | px[i + 2]);
    if (tells.circuitcenter.some((t) => near(i, t))) circuitcenter++;
    if (tells.kicadDefault.some((t) => near(i, t))) kicadDefault++;
  }
  return { surface: src.id, w: c.width, h: c.height, corners: [at(3, 3), at(c.width - 4, 3), at(3, c.height - 4), at(c.width - 4, c.height - 4)], colours: colours.size, circuitcenter, kicadDefault };
}, PALETTE_TELLS);

/** The circuitcenter palette's board background (theme/colors/circuitcenter.json), opaque. */
const BOARD_BG = [...rgbOf(PALETTE.board.background), 255].join(',');

/** `top` drawn at `alpha` over `under`, as the drawing shows it: [r, g, b]. */
const over = (top: number[], alpha: number, under: number[]): number[] => top.map((c, i) => Math.round(c * alpha + under[i] * (1 - alpha)));
/** A palette copper colour drawn opaque over the board background, as the viewer draws a pour. */
const pourOverBlack = (layer: string): number[] => over(rgbOf(PALETTE.board.copper[layer]), 1, rgbOf(PALETTE.board.background));

/**
 * The colour most of the drawing shows besides the board background, read
 * back whole from the surface the engine draws into: on a board under a pour,
 * the top pour (its tracks, pads and text are a small share of the pixels).
 */
const pourColour = (frame: Frame): Promise<number[]> => frame.evaluate((bg) => {
  const gls = [...document.querySelectorAll('canvas.gl-canvas')] as HTMLCanvasElement[];
  const src = gls.filter((c) => c.style.display !== 'none' && c.width > 0).sort((a, b) => b.width * b.height - a.width * a.height)[0] ?? (document.getElementById('canvas') as HTMLCanvasElement);
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0);
  const px = ctx.getImageData(0, 0, c.width, c.height).data;
  const counts = new Map<number, number>();
  for (let i = 0; i < px.length; i += 4) {
    if (px[i] === bg[0] && px[i + 1] === bg[1] && px[i + 2] === bg[2]) continue;
    const k = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return top == null ? [] : [top[0] >> 16, (top[0] >> 8) & 255, top[0] & 255];
}, rgbOf(PALETTE.board.background));

/** The largest per-channel difference between two colours (Infinity when one is missing). */
const channelDelta = (a: number[], b: number[]): number => (a.length === 3 && b.length === 3 ? Math.max(...a.map((v, i) => Math.abs(v - b[i]))) : Infinity);

/** Waits until the drawing's top pour is within 12 per channel of `want`, and quotes it. */
async function expectPour(frame: Frame, want: number[], label: string): Promise<void> {
  await expect.poll(async () => channelDelta(await pourColour(frame), want), { timeout: 30_000, intervals: [500, 1_000] }).toBeLessThanOrEqual(12);
  measure('pour', `${label}: ${(await pourColour(frame)).join(',')} (palette ${want.join(',')})`);
}

/**
 * What the reader sees the moment an import answers: the converted board,
 * drawn and fitted (its whole outline on screen, spanning at least `fill` of
 * the view), on the circuitcenter palette's board background.
 */
async function expectFittedBoard(frame: Frame, text: string, fill = 0.5): Promise<void> {
  const d = await drawing(frame);
  expect(d.colours).toBeGreaterThan(8);
  expect(d.corners).toEqual([BOARD_BG, BOARD_BG, BOARD_BG, BOARD_BG]);
  expect(d.circuitcenter).toBeGreaterThan(0);
  expect(d.kicadDefault).toBe(0);
  const v = await outlineInView(frame, text);
  expect(v.inside).toBe(true);
  expect(v.fill).toBeGreaterThan(fill);
  measure('fitted', `${d.surface} ${d.w}x${d.h}, ${d.colours} colours, outline ${(v.fill * 100).toFixed(0)}% of the view`);
}

const dialogsUp = async (frame: Frame): Promise<string[]> => (await visibleWx(frame, {})).filter((e) => /Dialog/.test(e.typeName)).map((e) => e.typeName);

/** KiCad reads the converted board back: a fresh board frame opens it as a project, and its layers answer. */
async function reopens(page: Page, path: string, text: string): Promise<void> {
  await boot(page, 'frame=pcb');
  const opened = await page.evaluate(([p, t]) => (window as unknown as Harness).__bridge.request('project.open', { name: 'reopen', files: [{ path: p, bytes: new TextEncoder().encode(t) }] }), [path, text] as const);
  expect(opened).toMatchObject({ opened: path, dropped: [] });
  // Imported boards keep their own layer names ("Top Elec"); the canonical names are KiCad's.
  const state = await request(page, 'layers.get') as { layers: Array<{ canonical: string; copper: boolean }> };
  expect(state.layers.filter((l) => l.copper).map((l) => l.canonical)).toEqual(expect.arrayContaining(['F.Cu', 'B.Cu']));
}

test('import: an Eagle board converts through its layer mapping, is the document after, and a second import meets Save Changes? and is cancelled', async ({ page }) => {
  const frame = await boot(page, 'frame=pcb');
  // While the import runs, the frame refuses the host's keys rather than queueing them.
  const pending = importBoard(page, 'test_eagle.brd');
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.state' && e.phase === 'opening'));
  await expect(request(page, 'key.press', { key: 'a', code: 'KeyA' })).rejects.toThrow('busy: key.press');
  const { result, seconds } = await pending;
  measure('import eagle', `${seconds.toFixed(1)} s (test_eagle.brd, 39 KB, layer mapping answered)`);
  expect(result).toEqual({ opened: 'test_eagle.kicad_pcb', dropped: [], warnings: [], chrome: false });
  expect(await dialogsUp(frame)).toEqual([]);
  // The converted board reached the host before the answer, and it parses: KiCad 10's format, every part.
  const text = await savedText(page, 'test_eagle.kicad_pcb');
  expect(boardFacts(text)).toEqual({ head: 'kicad_pcb', version: 20260206, footprints: 13, segments: 51, vias: 33, copper: 2 });
  // The answer came with the board drawn, fitted and in the circuitcenter palette.
  await expectFittedBoard(frame, text);
  // The host lays its page out again after the answer (the site narrowed the frame from 1211 to
  // 1103 px), and KiCad keeps its scale on a resize: the frame fits the board again.
  const wide = await viewport(frame);
  await page.evaluate(() => { (document.querySelector('iframe') as HTMLIFrameElement).style.width = '1100px'; });
  await expect.poll(async () => { const v = await viewport(frame); return v.w < wide.w && v.scale < wide.scale; }, { timeout: 10_000 }).toBe(true);
  await expect.poll(async () => (await outlineInView(frame, text)).inside, { timeout: 10_000 }).toBe(true);
  await expectFittedBoard(frame, text);
  // Once the reader steers (F1 zooms in), a resize leaves the view as the reader left it.
  const refitted = await viewport(frame);
  expect(await request(page, 'key.press', { key: 'F1', code: 'F1' })).toEqual({});
  await expect.poll(async () => (await viewport(frame)).scale, { timeout: 5_000 }).toBeGreaterThan(refitted.scale);
  const steered = await viewport(frame);
  await page.evaluate(() => { (document.querySelector('iframe') as HTMLIFrameElement).style.width = '1000px'; });
  await expect.poll(async () => (await viewport(frame)).w, { timeout: 10_000 }).toBeLessThan(steered.w);
  await page.waitForTimeout(1_500);
  expect((await viewport(frame)).scale).toBe(steered.scale);
  await page.evaluate(() => { (document.querySelector('iframe') as HTMLIFrameElement).style.width = ''; });
  await expect.poll(async () => (await viewport(frame)).w, { timeout: 10_000 }).toBe(wide.w);

  // It is the frame's document, as after project.open.
  expect(await request(page, 'project.save')).toEqual({ path: 'test_eagle.kicad_pcb', saved: ['test_eagle.kicad_pcb'] });
  const state = await request(page, 'layers.get') as { layers: Array<{ canonical: string; copper: boolean }> };
  expect(state.layers.filter((l) => l.copper).map((l) => l.canonical)).toEqual(['F.Cu', 'B.Cu']);
  // Keys reach the board after the importer's dialogs: F1 zooms in, view.fit zooms back out.
  expect(await request(page, 'view.fit')).toEqual({});
  const fitted = await viewScale(frame);
  expect(await request(page, 'key.press', { key: 'F1', code: 'F1' })).toEqual({});
  await expect.poll(() => viewScale(frame), { timeout: 5_000 }).toBeGreaterThan(fitted * 1.5);

  // The engine counts the converted board as modified: a second import meets KiCad's
  // "Save Changes?", which the island cancels (never Save, never Discard) and names.
  const t0 = Date.now();
  await expect(importBoard(page, 'test_eagle.brd')).rejects.toThrow(/import_failed: dialog "Save Changes\?"/);
  measure('import over a modified board', `${((Date.now() - t0) / 1000).toFixed(1)} s to import_failed, Save Changes? cancelled`);
  expect(await dialogsUp(frame)).toEqual([]);

  await reopens(page, 'test_eagle.kicad_pcb', text);
});

test('import: a CADSTAR board answers its log report as warnings', async ({ page }) => {
  const frame = await boot(page, 'frame=pcb');
  const { result, seconds } = await importBoard(page, 'minimal_route_offset_curved_track.cpa');
  measure('import cadstar', `${seconds.toFixed(1)} s (minimal_route_offset_curved_track.cpa, 74 KB, layer mapping and log report answered)`);
  expect(result.opened).toBe('minimal_route_offset_curved_track.kicad_pcb');
  expect(result.warnings).toEqual([
    'KiCad design rules are different from CADSTAR ones. Only the compatible design rules were imported. It is recommended that you review the design rules that have been applied.',
    expect.stringMatching(/^CADSTAR fonts are different to the ones in KiCad\./),
    'The CADSTAR design has been imported successfully. Please review the import errors and warnings (if any).',
  ]);
  expect(result.warnings.every((l) => l.length <= 200)).toBe(true);
  expect(await dialogsUp(frame)).toEqual([]);
  const text = await savedText(page, 'minimal_route_offset_curved_track.kicad_pcb');
  expect(boardFacts(text)).toMatchObject({ head: 'kicad_pcb', version: 20260206, footprints: 2, copper: 2 });
  await expectFittedBoard(frame, text);
  await reopens(page, 'minimal_route_offset_curved_track.kicad_pcb', text);
});

test('import: an EasyEDA Pro project (.zip) and an EasyEDA Standard board (.json) convert with no dialog', async ({ page }) => {
  for (const [file, board, facts] of [
    ['OpenSTM-ControlBoard.zip', 'OpenSTM-ControlBoard.kicad_pcb', { footprints: 152, copper: 2 }],
    ['synthetic-easyeda-std.json', 'synthetic-easyeda-std.kicad_pcb', { footprints: 1, segments: 4, vias: 2, copper: 2 }],
  ] as const) {
    const frame = await boot(page, 'frame=pcb');
    const { result, seconds } = await importBoard(page, file);
    measure(`import ${file.endsWith('.zip') ? 'easyeda pro' : 'easyeda std'}`, `${seconds.toFixed(1)} s (${file}, no dialog)`);
    expect(result).toEqual({ opened: board, dropped: [], warnings: [], chrome: false });
    expect(await dialogsUp(frame)).toEqual([]);
    const text = await savedText(page, board);
    expect(boardFacts(text)).toMatchObject({ head: 'kicad_pcb', version: 20260206, ...facts });
    await expectFittedBoard(frame, text);
    await reopens(page, board, text);
  }
});

test('import: a file no importer reads is import_failed with KiCad\'s message box closed, and a schematic frame refuses the op', async ({ page }) => {
  const frame = await boot(page, 'frame=pcb');
  await expect(importBoard(page, 'notes.brd', 'this is not a board\n')).rejects.toThrow(/import_failed: .*File format is not supported/);
  expect(await dialogsUp(frame)).toEqual([]);
  await expect(request(page, 'project.save')).rejects.toThrow('not_ready: project.save');
  // The host's keys work again at once.
  expect(await request(page, 'view.fit')).toEqual({});
  await boot(page, 'frame=sch');
  await expect(importBoard(page, 'test_eagle.brd')).rejects.toThrow('unsupported: project.import needs a pcb frame');
});

test('import: a converted board paints its pours opaque once filled, and the host\'s own display settings stand', async ({ page }) => {
  // KiCad's importers leave pours unfilled; the reader fills them with B (Fill All Zones).
  const fill = async (frame: Frame): Promise<void> => {
    expect(await request(page, 'key.press', { key: 'b', code: 'KeyB' })).toEqual({});
    await expect.poll(() => dialogsUp(frame), { timeout: 30_000 }).toEqual([]);
  };
  // test_eagle.brd's GND polygons cover the whole board on both sides: the front one is on top.
  let frame = await boot(page, 'frame=pcb');
  expect((await importBoard(page, 'test_eagle.brd')).result.opened).toBe('test_eagle.kicad_pcb');
  await fill(frame);
  await expectPour(frame, pourOverBlack('f'), 'test_eagle.brd imported and filled');

  // A host that sends its own settings keeps them: KiCad's 0.6 shows the front pour
  // over the back one, both at 0.6, so the sample above tells the two apart.
  frame = await boot(page, 'frame=pcb');
  const own = JSON.stringify({ board: { opacity: { zones: 0.6 } }, meta: { filename: 'test_eagle.kicad_prl', version: 5 } });
  const answer = await page.evaluate(async (prl) => {
    const bytes = new Uint8Array(await (await fetch('/e2e-fixtures/import/test_eagle.brd')).arrayBuffer());
    const files = [{ path: 'test_eagle.brd', bytes }, { path: 'test_eagle.kicad_prl', bytes: new TextEncoder().encode(prl) }];
    return (window as unknown as Harness).__bridge.request('project.import', { name: 'test_eagle.brd', files, open: 'test_eagle.brd' });
  }, own);
  expect(answer).toMatchObject({ opened: 'test_eagle.kicad_pcb', dropped: [] });
  await fill(frame);
  const black = rgbOf(PALETTE.board.background);
  await expectPour(frame, over(rgbOf(PALETTE.board.copper.f), 0.6, over(rgbOf(PALETTE.board.copper.b), 0.6, black)), 'test_eagle.brd with the host\'s zones at 0.6');
});
