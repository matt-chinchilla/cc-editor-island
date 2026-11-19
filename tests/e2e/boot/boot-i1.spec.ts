// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// boot-i1 over the local pair: every frame the island has (sch, pcb, symedit,
// fpedit, ds) starts with nothing of KiCad's on screen (owner 2026-11-17:
// nothing of KiCad's before his engine). The island sets the engine's start-up
// input (window.kicadBoot = { chrome: false }, src/reveal.ts) before the
// engine boots; an engine that read it says so with kicadBootCanvasOnly, and
// the loading screen comes down at its first canvas frame (reveal way
// `canvas`). Each start is screencast and every frame classified as the
// probe's classifier does (the island's area by luminance: chrome = beige
// toolbars beside white panes, beige = wx's empty window, loader = the white
// screen, drawn = anything else): zero chrome frames and zero beige frames,
// at full speed and with the island frame's CPU slowed 4x. The time from the
// island document's start to the revealed stage is printed as a measure.
// Chromium only (the screencast and the CPU throttle are the DevTools
// protocol's). More starts per case: --repeat-each=N.
import { expect, test, type BrowserContext, type CDPSession, type Frame, type Page } from '@playwright/test';

import { ISLAND } from '../ports';

interface Ev { type: string; phase?: string; shown?: boolean }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }

/** What the in-frame recorder keeps (island frame only), every time on the frame's own clock (ms from its start). */
interface BootRec {
  /** Each change of #screen's hidden attribute: [time, hidden]. */
  screen: Array<[number, boolean]>;
  /** Animation frames on which kicadChromeShown() answered true. */
  chromeAt: number[];
  /** The first animation frame on which the engine's Module answered kicadChromeShown. */
  moduleAt: number | null;
  /** The reveal's own line, `stage shown: <way>`, and when it came. */
  way: string | null;
  wayAt: number | null;
}

/** Runs in every frame at document start; records only in the island's. */
function bootRecorder(): void {
  if (!/^editor\./.test(location.hostname)) return;
  const rec: BootRec = { screen: [], chromeAt: [], moduleAt: null, way: null, wayAt: null };
  (window as unknown as { __bootRec: BootRec }).__bootRec = rec;
  const debug = console.debug.bind(console);
  console.debug = (...args: unknown[]) => {
    const m = typeof args[1] === 'string' ? /^stage shown: (\w+)/.exec(args[1]) : null;
    if (m != null && rec.way == null) { rec.way = m[1]; rec.wayAt = performance.now(); }
    debug(...args);
  };
  new MutationObserver((list) => {
    for (const r of list) {
      const el = r.target as Element;
      if (el.id === 'screen') rec.screen.push([performance.now(), el.hasAttribute('hidden')]);
    }
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
  const tick = (): void => {
    const mod = (window as unknown as { Module?: { kicadChromeShown?: () => unknown } }).Module;
    if (typeof mod?.kicadChromeShown === 'function') {
      if (rec.moduleAt == null) rec.moduleAt = performance.now();
      try { if (mod.kicadChromeShown() === true) rec.chromeAt.push(performance.now()); } catch { /* read next frame */ }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** The probe's classifier (luminance over the island's area, scaled to 320 pixels wide), in the browser. */
async function classify(page: Page, shots: string[], area: { x: number; y: number; w: number; h: number }, viewportWidth: number): Promise<string[]> {
  const kinds: string[] = [];
  for (let i = 0; i < shots.length; i += 40) {
    kinds.push(...await page.evaluate(async ([batch, a, vw]) => {
      const out: string[] = [];
      for (const b64 of batch) {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
        const k = bmp.width / vw;
        const sx = a.x * k; const sy = a.y * k; const sw = a.w * k; const sh = a.h * k;
        const W = 320; const H = Math.max(1, Math.round((320 * sh) / sw));
        const c = new OffscreenCanvas(W, H);
        const g = c.getContext('2d')!;
        g.drawImage(bmp, sx, sy, sw, sh, 0, 0, W, H);
        bmp.close();
        const px = g.getImageData(0, 0, W, H).data;
        let beige = 0; let white = 0;
        for (let p = 0; p < px.length; p += 4) {
          const lum = (px[p] + px[p + 1] + px[p + 2]) / 3;
          if (lum > 200 && lum < 216) beige++;
          if (lum >= 250) white++;
        }
        const n = W * H; const fb = beige / n; const fw = white / n;
        out.push(fb > 0.3 && fw > 0.06 ? 'chrome' : fb > 0.6 ? 'beige' : fw > 0.6 ? 'loader' : 'drawn');
      }
      return out;
    }, [shots.slice(i, i + 40), area, viewportWidth] as const));
  }
  return kinds;
}

/** Slows the island frame's CPU as soon as it attaches (its own session when it is out of process, else the page's). */
function throttleIsland(context: BrowserContext, page: Page, pageCdp: CDPSession, rate: number): { how: () => string } {
  let how = 'none';
  if (rate <= 1) return { how: () => how };
  const done = new Set<Frame>();
  const arm = async (f: Frame): Promise<void> => {
    if (done.has(f) || !f.url().startsWith(`${ISLAND}/`)) return;
    done.add(f);
    try {
      const s = await context.newCDPSession(f);
      await s.send('Emulation.setCPUThrottlingRate', { rate });
      how = 'island frame';
    } catch {
      await pageCdp.send('Emulation.setCPUThrottlingRate', { rate });
      how = 'page (the island frame in process)';
    }
  };
  page.on('framenavigated', (f) => { void arm(f); });
  page.on('frameattached', (f) => { void arm(f); });
  return { how: () => how };
}

interface Start { kinds: string[]; rec: BootRec; marker: boolean; chromeEvents: boolean[]; revealedAt: number | null; how: string }

/** One start of `frame`, screencast from before the navigation until `settleMs` after the stage is shown and any fixture opened. */
async function start(context: BrowserContext, page: Page, frame: string, fixture: string | null, rate: number): Promise<Start> {
  const cdp = await context.newCDPSession(page);
  const shots: string[] = [];
  cdp.on('Page.screencastFrame', (f) => {
    shots.push(f.data);
    void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
  });
  const vp = page.viewportSize() ?? { width: 1320, height: 900 };
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: vp.width, maxHeight: vp.height });
  const throttle = throttleIsland(context, page, cdp, rate);
  await page.goto(`/parent.html?frame=${frame}${fixture != null ? `&fixture=${fixture}` : ''}`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  const island = page.frames().find((f) => f.url().startsWith(`${ISLAND}/`));
  if (island == null) throw new Error('no island frame');
  await expect.poll(() => island.evaluate(() => (window as unknown as { __bootRec: BootRec }).__bootRec.way), { timeout: 60_000 }).not.toBeNull();
  if (fixture != null) await expect(page.locator('#state')).toContainText('opened ', { timeout: 120_000 });
  // The drawing on its way and drawn: the frames after the reveal are classified too.
  await page.waitForTimeout(2_000 * rate);
  await cdp.send('Page.stopScreencast');
  const box = await page.locator('iframe').boundingBox();
  if (box == null) throw new Error('no iframe box');
  const rec = await island.evaluate(() => (window as unknown as { __bootRec: BootRec }).__bootRec);
  const marker = await island.evaluate(() => {
    const mod = (window as unknown as { Module?: { kicadBootCanvasOnly?: () => unknown } }).Module;
    return typeof mod?.kicadBootCanvasOnly === 'function' && mod.kicadBootCanvasOnly() === true;
  });
  const chromeEvents = (await page.evaluate(() => (window as unknown as Harness).__events)).filter((e) => e.type === 'ev.chrome').map((e) => e.shown === true);
  const kinds = await classify(page, shots, { x: box.x, y: box.y, w: box.width, h: box.height }, vp.width);
  let wasShown = false;
  let revealedAt: number | null = null;
  for (const [t, hidden] of rec.screen) {
    if (!hidden) wasShown = true;
    else if (wasShown) { revealedAt = t; break; }
  }
  await cdp.detach().catch(() => undefined);
  return { kinds, rec, marker, chromeEvents, revealedAt, how: throttle.how() };
}

/** A measurement the report quotes: kept as an annotation and printed by the list reporter. */
function measure(type: string, description: string): void {
  test.info().annotations.push({ type, description });
  console.log(`[measure] ${type}: ${description}`);
}

const FRAMES: ReadonlyArray<{ frame: string; fixture: string | null }> = [
  { frame: 'sch', fixture: 'glasgow' },
  { frame: 'pcb', fixture: 'glasgow' },
  { frame: 'symedit', fixture: null },
  { frame: 'fpedit', fixture: null },
  { frame: 'ds', fixture: null },
];

test.beforeEach(async ({ context, browserName }) => {
  test.skip(browserName !== 'chromium', 'the screencast and the CPU throttle are the DevTools protocol\'s');
  await context.addInitScript(bootRecorder);
});

for (const { frame, fixture } of FRAMES) {
  for (const rate of [1, 4]) {
    test(`${frame} at ${rate}x: nothing of KiCad's on screen from the first frame, the stage shown at the first canvas frame`, async ({ context, page }) => {
      test.setTimeout(300_000);
      const s = await start(context, page, frame, fixture, rate);
      const count = (k: string): number => s.kinds.filter((x) => x === k).length;
      const fromModule = s.revealedAt != null && s.rec.moduleAt != null ? `${Math.round(s.revealedAt - s.rec.moduleAt)} ms` : 'unknown';
      measure('boot to reveal', `${frame} ${rate}x: ${s.revealedAt == null ? 'never' : `${Math.round(s.revealedAt)} ms`} from the island document's start, ${fromModule} from the engine's runtime up, way ${s.rec.way}, marker ${s.marker}, throttled ${s.how}`);
      measure('classifier', `${frame} ${rate}x: ${s.kinds.length} frames, chrome ${count('chrome')}, beige ${count('beige')}, loader ${count('loader')}, drawn ${count('drawn')}`);
      expect.soft(count('chrome'), 'frames with KiCad\'s chrome').toBe(0);
      expect.soft(count('beige'), 'frames of wx\'s beige window').toBe(0);
      expect.soft(s.rec.chromeAt, 'animation frames on which the engine said its chrome showed').toEqual([]);
      expect.soft(s.chromeEvents.filter(Boolean), 'ev.chrome shown').toEqual([]);
      expect(s.revealedAt).not.toBeNull();
      // The engine read the start-up input, so the screen came down at its first canvas frame.
      expect(s.marker).toBe(true);
      expect(s.rec.way).toBe('canvas');
    });
  }
}

/** The visible wx elements of a type, as the engine's registry reports them. */
const visibleWx = (frame: Frame, typeName: string): Promise<number> =>
  frame.evaluate((t) => (window as unknown as { wxElementRegistry: { findAll(f: object): unknown[] } }).wxElementRegistry.findAll({ type: t, visible: true }).length, typeName);
const request = (page: Page, op: string, args?: unknown): Promise<Record<string, unknown>> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const);
const chromeEvents = async (page: Page): Promise<boolean[]> =>
  (await page.evaluate(() => (window as unknown as Harness).__events)).filter((e) => e.type === 'ev.chrome').map((e) => e.shown === true);

for (const { frame, fixture } of FRAMES) {
  test(`${frame}: after a canvas only start, Show and Hide KiCad's menus work as before`, async ({ page }) => {
    await page.goto(`/parent.html?frame=${frame}${fixture != null ? `&fixture=${fixture}` : ''}`);
    await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready'), null, { timeout: 170_000 });
    if (fixture != null) await expect(page.locator('#state')).toContainText('opened ', { timeout: 120_000 });
    const island = page.frames().find((f) => f.url().startsWith(`${ISLAND}/`));
    if (island == null) throw new Error('no island frame');
    const shown = (): Promise<unknown> => island.evaluate(() => (window as unknown as { Module: { kicadChromeShown(): unknown } }).Module.kicadChromeShown());
    expect(await island.evaluate(() => (window as unknown as { Module: { kicadBootCanvasOnly?: () => unknown } }).Module.kicadBootCanvasOnly?.())).toBe(true);
    expect(await shown()).toBe(false);
    expect(await visibleWx(island, 'wxMenuBar')).toBe(0);
    // ev.chrome says the state once at ready, as it always has: hidden.
    await expect.poll(() => chromeEvents(page)).toEqual([false]);
    // Show: KiCad's menu bar, toolbars and status bar, and ev.chrome says so.
    expect(await request(page, 'chrome.show', { on: true })).toEqual({});
    await expect.poll(() => visibleWx(island, 'wxMenuBar')).toBe(1);
    expect(await visibleWx(island, 'wxAuiToolBar')).toBeGreaterThan(0);
    expect(await visibleWx(island, 'wxStatusBar')).toBe(1);
    expect(await shown()).toBe(true);
    await expect.poll(() => chromeEvents(page)).toEqual([false, true]);
    // Hide: all of it gone again, and back once more.
    expect(await request(page, 'chrome.show', { on: false })).toEqual({});
    await expect.poll(() => visibleWx(island, 'wxMenuBar')).toBe(0);
    expect(await visibleWx(island, 'wxAuiToolBar')).toBe(0);
    expect(await visibleWx(island, 'wxStatusBar')).toBe(0);
    expect(await shown()).toBe(false);
    await expect.poll(() => chromeEvents(page)).toEqual([false, true, false]);
    expect(await request(page, 'chrome.show', { on: true })).toEqual({});
    await expect.poll(() => visibleWx(island, 'wxMenuBar')).toBe(1);
    await expect.poll(() => chromeEvents(page)).toEqual([false, true, false, true]);
  });
}
