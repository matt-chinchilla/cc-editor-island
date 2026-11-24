// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// theme-i over the local pair, on the bundled example (Glasgow): theme.set
// repaints the running frame in the colors the host sends, with no reload of
// the document and the view kept, and null brings the palette back. Proved on
// the drawing's own pixels, read back from the surface the engine draws into:
// the background's color is the most common pixel, and a wire color sent
// shows on the schematic's wires. Also: KiCad's chrome stays hidden after a
// switch, and a burst of sets is answered whole and ends on its newest set.
import { expect, test, type Frame, type Page } from '@playwright/test';
import { ISLAND } from './ports';

// The proof reads the drawing inside the island frame.
test.skip(({ browserName }) => browserName === 'firefox', 'Playwright Firefox reaches no context in the cross-site island frame');

interface Ev { type: string; phase?: string; caps?: string[]; shown?: boolean }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface View { cx: number; cy: number; w: number; h: number; scale: number }
interface Read { top: number[]; topShare: number; red: number; white: number; axes: number; total: number }
type Rgb = [number, number, number];

const PALETTE_SCH_BG: Rgb = [19, 18, 24];
const PALETTE_PCB_BG: Rgb = [0, 0, 0];
const WHITE: Rgb = [255, 255, 255];

function measure(type: string, description: string): void {
  test.info().annotations.push({ type, description });
  console.log(`[measure] ${type}: ${description}`);
}

const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const request = (page: Page, op: string, args?: unknown): Promise<Record<string, unknown>> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const);
const refusal = (page: Page, op: string, args?: unknown): Promise<string> =>
  request(page, op, args).then(() => 'ok', (err: Error) => err.message.split('\n')[0].replace(/^.*?page\.evaluate:\s*/, '').replace(/^Error:\s*/, ''));

/** The palette the island seeded (read from the engine's colors folder) with the given changes. */
const paletteWith = (f: Frame, change: { schematic?: Record<string, string>; board?: Record<string, string> }): Promise<Record<string, unknown>> =>
  f.evaluate((c) => {
    const FS = (window as unknown as { FS: { readFile(p: string, o: { encoding: 'utf8' }): string } }).FS;
    const p = JSON.parse(FS.readFile('/home/kicad/.config/kicad/kicad/10.0/colors/circuitcenter.json', { encoding: 'utf8' })) as Record<string, Record<string, unknown>>;
    return { ...p, schematic: { ...p.schematic, ...(c.schematic ?? {}) }, board: { ...p.board, ...(c.board ?? {}) } };
  }, change);

async function boot(page: Page, frame: 'sch' | 'pcb'): Promise<{ island: Frame; caps: string[] }> {
  await page.goto(`/parent.html?fixture=glasgow&frame=${frame}`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  await expect(page.locator('#state')).toContainText(`opened glasgow.kicad_${frame}`, { timeout: 120_000 });
  const island = page.frames().find((f) => f.url().startsWith(`${ISLAND}/`));
  if (island == null) throw new Error('no island frame');
  return { island, caps: (await events(page)).find((e) => e.type === 'ev.ready')?.caps ?? [] };
}

const viewport = async (f: Frame): Promise<View> =>
  JSON.parse(await f.evaluate(() => (window as unknown as { Module: { kicadCollabGetViewport(): string } }).Module.kicadCollabGetViewport()));
const chromeShown = (f: Frame): Promise<boolean> =>
  f.evaluate(() => (window as unknown as { Module: { kicadChromeShown(): boolean } }).Module.kicadChromeShown());

/** The drawing's pixels: the most common color and its share, and how many pixels are pure red (255, 0, 0) and pure white (each within 2). */
const readCanvas = (f: Frame): Promise<Read> => f.evaluate(() => {
  const gls = [...document.querySelectorAll('canvas.gl-canvas')] as HTMLCanvasElement[];
  const src = gls.filter((c) => c.style.display !== 'none' && c.width > 0).sort((a, b) => b.width * b.height - a.width * a.height)[0] ?? (document.getElementById('canvas') as HTMLCanvasElement);
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0);
  const px = ctx.getImageData(0, 0, c.width, c.height).data;
  const counts = new Map<number, number>();
  let red = 0;
  let white = 0;
  let axes = 0;
  for (let i = 0; i < px.length; i += 4) {
    // The palette's grid_axes, the editors' origin axes: (255, 129, 173).
    if (Math.abs(px[i] - 255) <= 2 && Math.abs(px[i + 1] - 129) <= 2 && Math.abs(px[i + 2] - 173) <= 2) axes++;
    if (px[i] >= 253 && px[i + 1] >= 253 && px[i + 2] >= 253) white++;
    const k = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
    counts.set(k, (counts.get(k) ?? 0) + 1);
    if (px[i] >= 253 && px[i + 1] <= 2 && px[i + 2] <= 2) red++;
  }
  let best = 0;
  let n = 0;
  for (const [k, v] of counts) if (v > n) { best = k; n = v; }
  const total = px.length / 4;
  return { top: [(best >> 16) & 255, (best >> 8) & 255, best & 255], topShare: n / total, red, white, axes, total };
});

const near = (a: number[], b: Rgb): boolean => a.every((x, i) => Math.abs(x - b[i]) <= 2);

/** Waits until the drawing's most common color is `bg` and two reads agree. */
async function showing(f: Frame, bg: Rgb): Promise<Read> {
  let last = '';
  let out: Read | null = null;
  await expect.poll(async () => {
    const r = await readCanvas(f);
    const key = JSON.stringify(r);
    const same = near(r.top, bg) && key === last;
    last = key;
    out = r;
    return same;
  }, { timeout: 30_000, intervals: [200, 300, 500] }).toBe(true);
  return out!;
}

test('theme.set in a sch frame: a white background and red wires live, the view kept, the chrome hidden, null the palette again', async ({ page }) => {
  test.setTimeout(300_000);
  try {
    const switches: string[] = [];
    page.on('console', (m) => { if (m.text().includes('[theme]')) switches.push(m.text()); });
    const { island, caps } = await boot(page, 'sch');
    expect(caps).toContain('theme');
    const first = await showing(island, PALETTE_SCH_BG);
    expect(first.red).toBe(0);
    const view = await viewport(island);
    measure('palette', `background ${first.top.join(', ')} on ${(first.topShare * 100).toFixed(1)} % of ${first.total} pixels`);

    // The args first.
    expect(await refusal(page, 'theme.set', { colors: { schematic: 'white' } })).toBe('bad_args: theme.set');
    expect(await refusal(page, 'theme.set', {})).toBe('bad_args: theme.set');

    const white = await paletteWith(island, { schematic: { background: 'rgb(255, 255, 255)', wire: 'rgb(255, 0, 0)' } });
    let t0 = Date.now();
    expect(await request(page, 'theme.set', { colors: white })).toEqual({ ok: true });
    measure('theme.set', `${Date.now() - t0} ms to the answer`);
    // The answer comes once the canvas has the colors: the first read after it already shows them.
    const atAnswer = await readCanvas(island);
    measure('read at the answer', `${atAnswer.top.join(', ')}, ${atAnswer.red} red pixels`);
    const after = await showing(island, WHITE);
    expect(after.red).toBeGreaterThan(100);
    measure('host theme', `background ${after.top.join(', ')} on ${(after.topShare * 100).toFixed(1)} %, ${after.red} red wire pixels`);
    expect(await viewport(island)).toEqual(view);
    expect(await chromeShown(island)).toBe(false);

    // A burst: every set is answered, and the drawing ends on the newest.
    const greens = [10, 20, 30, 40, 50].map((g) => paletteWith(island, { schematic: { background: `rgb(0, ${g}, 0)` } }));
    const bodies = await Promise.all(greens);
    t0 = Date.now();
    const before = switches.length;
    const answers = await page.evaluate((list) => Promise.all(list.map((colors) => (window as unknown as Harness).__bridge.request('theme.set', { colors }))), bodies);
    measure('burst of 5', `${Date.now() - t0} ms to the last answer`);
    expect(answers).toEqual(Array(5).fill({ ok: true }));
    // The first set switched alone; the four behind it were coalesced into one switch, the newest.
    await expect.poll(() => switches.length - before).toBe(2);
    measure('burst switches', switches.slice(before).join(' | '));
    await showing(island, [0, 50, 0]);
    expect(await viewport(island)).toEqual(view);

    t0 = Date.now();
    expect(await request(page, 'theme.set', { colors: null })).toEqual({ ok: true });
    measure('theme.set null', `${Date.now() - t0} ms to the answer`);
    const back = await showing(island, PALETTE_SCH_BG);
    expect(back.red).toBe(0);
    expect(await viewport(island)).toEqual(view);
    expect(await chromeShown(island)).toBe(false);
    // No document was reloaded: the edit counter and the open state are as they were.
    await expect(page.locator('#state')).toContainText('opened glasgow.kicad_sch');
    // The host's files are gone from the colors folder.
    const left = await island.evaluate(() => {
      const FS = (window as unknown as { FS: { readdir(p: string): string[] } }).FS;
      return FS.readdir('/home/kicad/.config/kicad/kicad/10.0/colors').filter((n) => n.startsWith('cc-host-theme-'));
    });
    expect(left).toEqual([]);
  } finally {
    await page.close();
  }
});

/** Waits until two reads in a row agree and `ok` holds for the read. */
async function settledOn(f: Frame, ok: (r: Read) => boolean): Promise<Read> {
  let last = '';
  let out: Read | null = null;
  await expect.poll(async () => {
    const r = await readCanvas(f);
    const key = JSON.stringify(r);
    const same = ok(r) && key === last;
    last = key;
    out = r;
    return same;
  }, { timeout: 30_000, intervals: [200, 300, 500] }).toBe(true);
  return out!;
}

test('theme.set in a pcb frame: a white board background around the board, then the palette', async ({ page }) => {
  test.setTimeout(300_000);
  try {
    const { island, caps } = await boot(page, 'pcb');
    expect(caps).toContain('theme');
    // Glasgow fills most of the fitted view: the background is what lies around the board, so its pixels are counted.
    const first = await settledOn(island, (r) => r.topShare < 0.99);
    measure('palette', `most common ${first.top.join(', ')} on ${(first.topShare * 100).toFixed(1)} %, ${first.white} white pixels`);
    const view = await viewport(island);
    const t0 = Date.now();
    expect(await request(page, 'theme.set', { colors: await paletteWith(island, { board: { background: 'rgb(255, 255, 255)' } }) })).toEqual({ ok: true });
    measure('theme.set', `${Date.now() - t0} ms to the answer`);
    const after = await settledOn(island, (r) => r.white > first.white + 0.05 * r.total);
    measure('host theme', `${after.white} white pixels (${((after.white / after.total) * 100).toFixed(1)} %)`);
    expect(await viewport(island)).toEqual(view);
    expect(await chromeShown(island)).toBe(false);
    expect(await request(page, 'theme.set', { colors: null })).toEqual({ ok: true });
    const back = await settledOn(island, (r) => Math.abs(r.white - first.white) <= 0.001 * r.total);
    expect(back.top).toEqual(first.top);
    expect(await viewport(island)).toEqual(view);
  } finally {
    await page.close();
  }
});

/** A frame booted with no document (the editors that open their own item later); its island frame. */
async function bootBare(page: Page, frame: string): Promise<Frame> {
  await page.goto(`/parent.html?frame=${frame}`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  expect((await events(page)).filter((e) => e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))).toEqual([]);
  const island = page.frames().find((f) => f.url().startsWith(`${ISLAND}/`));
  if (island == null) throw new Error('no island frame');
  return island;
}

test('the kept colors: the symbol, footprint and drawing sheet editors boot in the colors a schematic frame took, and in the palette after null', async ({ page }) => {
  test.setTimeout(600_000);
  try {
    const { island } = await boot(page, 'sch');
    await showing(island, PALETTE_SCH_BG);
    const white = await paletteWith(island, { schematic: { background: 'rgb(255, 255, 255)' }, board: { background: 'rgb(255, 255, 255)' } });
    expect(await request(page, 'theme.set', { colors: white })).toEqual({ ok: true });
    await showing(island, WHITE);
    // A light theme by day with KiCad's chrome hidden: what the reader sees.
    await page.screenshot({ path: test.info().outputPath('sch-white-day.png') });

    for (const frame of ['symedit', 'fpedit', 'ds']) {
      const f = await bootBare(page, frame);
      const caps = (await events(page)).find((e) => e.type === 'ev.ready')?.caps ?? [];
      // On an engine whose switch does not reach the editors (build T18b) they refuse the op; on any engine they boot in the kept colors.
      if (!caps.includes('theme')) expect(await refusal(page, 'theme.set', { colors: null })).toBe(`theme_frame: the canvas colors of a ${frame} frame change at its next boot`);
      const r = await showing(f, WHITE);
      measure(`${frame} booted kept`, `background ${r.top.join(', ')} on ${(r.topShare * 100).toFixed(1)} %`);
    }

    // null in a schematic frame forgets the kept colors: the next editor boots in the palette.
    const again = await boot(page, 'sch');
    // A reload of the schematic frame comes up in the kept colors with no theme.set sent.
    const reloaded = await showing(again.island, WHITE);
    measure('sch reloaded kept', `background ${reloaded.top.join(', ')} on ${(reloaded.topShare * 100).toFixed(1)} %, no theme.set sent`);
    expect(await request(page, 'theme.set', { colors: null })).toEqual({ ok: true });
    await showing(again.island, PALETTE_SCH_BG);
    for (const frame of ['symedit', 'ds']) {
      const r = await showing(await bootBare(page, frame), PALETTE_SCH_BG);
      measure(`${frame} after null`, `background ${r.top.join(', ')}`);
    }
  } finally {
    await page.close();
  }
});

/** The drawing's pixels as one digest, the whole canvas. */
const digest = (f: Frame): Promise<string> => f.evaluate(async () => {
  const gls = [...document.querySelectorAll('canvas.gl-canvas')] as HTMLCanvasElement[];
  const src = gls.filter((c) => c.style.display !== 'none' && c.width > 0).sort((a, b) => b.width * b.height - a.width * a.height)[0] ?? (document.getElementById('canvas') as HTMLCanvasElement);
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0);
  const px = ctx.getImageData(0, 0, c.width, c.height).data;
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', px));
  return [...h].map((x) => x.toString(16).padStart(2, '0')).join('');
});

for (const frame of ['symedit', 'fpedit', 'ds'] as const) {
  test(`theme.set live in a ${frame} frame: a white background, the chrome hidden, null the drawing as before`, async ({ page }) => {
    test.setTimeout(300_000);
    try {
      const f = await bootBare(page, frame);
      const caps = (await events(page)).find((e) => e.type === 'ev.ready')?.caps ?? [];
      test.skip(!caps.includes('theme'), 'an engine whose switch does not reach this frame (build T18b)');
      const bg: Rgb = frame === 'fpedit' ? PALETTE_PCB_BG : PALETTE_SCH_BG;
      const first = await showing(f, bg);
      const control = await digest(f);
      expect(await digest(f)).toBe(control);
      measure('palette', `background ${first.top.join(', ')} on ${(first.topShare * 100).toFixed(1)} %, ${first.axes} origin axes pixels`);
      if (frame !== 'ds') expect(first.axes).toBeGreaterThan(0);
      const white = await paletteWith(f, { schematic: { background: 'rgb(255, 255, 255)' }, board: { background: 'rgb(255, 255, 255)' } });
      let t0 = Date.now();
      expect(await request(page, 'theme.set', { colors: white })).toEqual({ ok: true });
      measure('theme.set', `${Date.now() - t0} ms to the answer`);
      const after = await showing(f, WHITE);
      measure('host theme', `background ${after.top.join(', ')} on ${(after.topShare * 100).toFixed(1)} %, ${after.axes} origin axes pixels`);
      expect(await chromeShown(f)).toBe(false);
      t0 = Date.now();
      expect(await request(page, 'theme.set', { colors: null })).toEqual({ ok: true });
      measure('theme.set null', `${Date.now() - t0} ms to the answer`);
      const back = await showing(f, bg);
      // The view kept and the axes still drawn: the drawing is the control's, pixel for pixel.
      await expect.poll(() => digest(f), { timeout: 10_000 }).toBe(control);
      expect(back.axes).toBe(first.axes);
      expect(await chromeShown(f)).toBe(false);
    } finally {
      await page.close();
    }
  });
}

test('a drawing sheet editor that booted in the kept colors takes null live: its own palette with the sheet color', async ({ page }) => {
  test.setTimeout(300_000);
  try {
    const { island } = await boot(page, 'sch');
    await showing(island, PALETTE_SCH_BG);
    expect(await request(page, 'theme.set', { colors: await paletteWith(island, { schematic: { background: 'rgb(255, 255, 255)' } }) })).toEqual({ ok: true });
    await showing(island, WHITE);
    const ds = await bootBare(page, 'ds');
    test.skip(!((await events(page)).find((e) => e.type === 'ev.ready')?.caps ?? []).includes('theme'), 'an engine whose switch does not reach this frame (build T18b)');
    await showing(ds, WHITE);
    expect(await request(page, 'theme.set', { colors: null })).toEqual({ ok: true });
    const r = await showing(ds, PALETTE_SCH_BG);
    measure('ds kept then null', `background ${r.top.join(', ')} on ${(r.topShare * 100).toFixed(1)} %`);
  } finally {
    await page.close();
  }
});

/** The mean luminance (0 to 255) of a part of the page as the reader sees it: KiCad's chrome is wx's own, painted into the page. */
async function lightness(page: Page, clip: { x: number; y: number; width: number; height: number }): Promise<number> {
  const png = (await page.screenshot({ clip })).toString('base64');
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    return sum / (px.length / 4);
  }, png);
}

test('by day a theme.set keeps KiCad\'s chrome light: the shown panes read as light after the switch as before it', async ({ page }) => {
  test.setTimeout(300_000);
  try {
    const { island } = await boot(page, 'sch');
    await showing(island, PALETTE_SCH_BG);
    // The Properties pane's list, left of the drawing, once KiCad's chrome is shown (1320 by 900 window).
    const pane = { x: 10, y: 110, width: 280, height: 200 };
    const shown = async (): Promise<number> => {
      expect(await request(page, 'chrome.show', { on: true })).toEqual({});
      await expect.poll(() => chromeShown(island)).toBe(true);
      // Two reads in a row agree: the panes are painted.
      let last = -1;
      let now = -2;
      await expect.poll(async () => { last = now; now = await lightness(page, pane); return Math.abs(now - last) < 0.5; }, { timeout: 10_000, intervals: [300, 300, 500] }).toBe(true);
      return now;
    };
    const before = await shown();
    expect(await request(page, 'chrome.show', { on: false })).toEqual({});
    expect(await request(page, 'theme.set', { colors: await paletteWith(island, { schematic: { background: 'rgb(255, 255, 255)' } }) })).toEqual({ ok: true });
    const after = await shown();
    await page.screenshot({ path: test.info().outputPath('chrome-after-switch-day.png') });
    measure('pane lightness', `before the switch ${before.toFixed(1)}, after it ${after.toFixed(1)} (0 black, 255 white)`);
    expect(before).toBeGreaterThan(150);
    expect(Math.abs(after - before)).toBeLessThan(10);
    expect(await request(page, 'chrome.show', { on: false })).toEqual({});
    await expect.poll(() => chromeShown(island)).toBe(false);
  } finally {
    await page.close();
  }
});
