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
interface Read { top: number[]; topShare: number; red: number; white: number; total: number }
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
  for (let i = 0; i < px.length; i += 4) {
    if (px[i] >= 253 && px[i + 1] >= 253 && px[i + 2] >= 253) white++;
    const k = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
    counts.set(k, (counts.get(k) ?? 0) + 1);
    if (px[i] >= 253 && px[i + 1] <= 2 && px[i + 2] <= 2) red++;
  }
  let best = 0;
  let n = 0;
  for (const [k, v] of counts) if (v > n) { best = k; n = v; }
  const total = px.length / 4;
  return { top: [(best >> 16) & 255, (best >> 8) & 255, best & 255], topShare: n / total, red, white, total };
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
    expect(await request(page, 'theme.set', { colors: white })).toEqual({});
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
    expect(answers).toEqual(Array(5).fill({}));
    // The first set switched alone; the four behind it were coalesced into one switch, the newest.
    await expect.poll(() => switches.length - before).toBe(2);
    measure('burst switches', switches.slice(before).join(' | '));
    await showing(island, [0, 50, 0]);
    expect(await viewport(island)).toEqual(view);

    t0 = Date.now();
    expect(await request(page, 'theme.set', { colors: null })).toEqual({});
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
    expect(await request(page, 'theme.set', { colors: await paletteWith(island, { board: { background: 'rgb(255, 255, 255)' } }) })).toEqual({});
    measure('theme.set', `${Date.now() - t0} ms to the answer`);
    const after = await settledOn(island, (r) => r.white > first.white + 0.05 * r.total);
    measure('host theme', `${after.white} white pixels (${((after.white / after.total) * 100).toFixed(1)} %)`);
    expect(await viewport(island)).toEqual(view);
    expect(await chromeShown(island)).toBe(false);
    expect(await request(page, 'theme.set', { colors: null })).toEqual({});
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
    expect(await request(page, 'theme.set', { colors: white })).toEqual({});
    await showing(island, WHITE);
    // A light theme by day with KiCad's chrome hidden: what the reader sees.
    await page.screenshot({ path: test.info().outputPath('sch-white-day.png') });

    for (const frame of ['symedit', 'fpedit', 'ds']) {
      const f = await bootBare(page, frame);
      const caps = (await events(page)).find((e) => e.type === 'ev.ready')?.caps ?? [];
      expect(caps).not.toContain('theme');
      expect(await refusal(page, 'theme.set', { colors: null })).toBe(`theme_frame: the canvas colors of a ${frame} frame change at its next boot`);
      const r = await showing(f, WHITE);
      measure(`${frame} booted kept`, `background ${r.top.join(', ')} on ${(r.topShare * 100).toFixed(1)} %`);
    }

    // null in a schematic frame forgets the kept colors: the next editor boots in the palette.
    const again = await boot(page, 'sch');
    // This schematic frame booted in the kept colors too.
    await showing(again.island, WHITE);
    expect(await request(page, 'theme.set', { colors: null })).toEqual({});
    await showing(again.island, PALETTE_SCH_BG);
    for (const frame of ['symedit', 'ds']) {
      const r = await showing(await bootBare(page, frame), PALETTE_SCH_BG);
      measure(`${frame} after null`, `background ${r.top.join(', ')}`);
    }
  } finally {
    await page.close();
  }
});
