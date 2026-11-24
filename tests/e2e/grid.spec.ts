// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The grid boot word over the local pair, on the bundled example (Glasgow):
// `grid=lines` boots the schematic and board editors with KiCad's lines grid,
// no word boots them with its dots as before. Proved on the drawing's own
// pixels, read back from the surface the engine draws into: a lines grid
// leaves whole columns and rows in the palette's grid color, a dots grid
// leaves only points. Also read: each editor's settings file holds the style
// the island seeded, and nothing else of the boot changed.
import { expect, test, type Frame, type Page } from '@playwright/test';
import { ISLAND } from './ports';

// The proof reads the drawing inside the island frame.
test.skip(({ browserName }) => browserName === 'firefox', 'Playwright Firefox reaches no context in the cross-site island frame');

interface Ev { type: string; phase?: string }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
/** What the pixels say: columns and rows mostly in the grid's color, and every pixel near it. */
interface GridRead { cols: number; rows: number; gridPx: number; total: number; w: number; h: number }
type Rgb = [number, number, number];

/** The palette's grid color (theme/colors/circuitcenter.json schematic.grid and board.grid). */
const PALETTE_GRID: Rgb = [113, 103, 153];
const CONFIG = '/home/kicad/.config/kicad/kicad/10.0';

function measure(type: string, description: string): void {
  test.info().annotations.push({ type, description });
  console.log(`[measure] ${type}: ${description}`);
}

async function boot(page: Page, frame: 'sch' | 'pcb', grid: 'lines' | null): Promise<Frame> {
  await page.goto(`/parent.html?fixture=glasgow&frame=${frame}${grid == null ? '' : `&grid=${grid}`}`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  await expect(page.locator('#state')).toContainText(`opened glasgow.kicad_${frame}`, { timeout: 120_000 });
  const island = page.frames().find((f) => f.url().startsWith(`${ISLAND}/`));
  if (island == null) throw new Error('no island frame');
  return island;
}

const request = (page: Page, op: string, args?: unknown): Promise<Record<string, unknown>> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const);

/**
 * The board fills the fitted view and its grid is drawn behind it: KiCad's
 * zoom out (F2) leaves a margin all around where the grid shows. The
 * two boots take the same steps from the same fit, so they show one view.
 */
async function roomAround(page: Page, frame: 'sch' | 'pcb'): Promise<void> {
  if (frame !== 'pcb') return;
  expect(await request(page, 'key.press', { key: 'F2', code: 'F2' })).toEqual({});
}

/** The grid style the editor's settings file holds (absent: KiCad's default, dots). */
const seededStyle = (f: Frame, file: string): Promise<number | null> =>
  f.evaluate(([path]) => {
    const FS = (window as unknown as { FS: { analyzePath(p: string): { exists: boolean }; readFile(p: string, o: { encoding: 'utf8' }): string } }).FS;
    if (!FS.analyzePath(path).exists) return null;
    const j = JSON.parse(FS.readFile(path, { encoding: 'utf8' })) as { window?: { grid?: { style?: number } } };
    return j.window?.grid?.style ?? null;
  }, [`${CONFIG}/${file}`] as const);

/** The drawing's pixels in the grid's color (each channel within 6), counted per column and per row. */
interface GridCounts { cols: number[]; rows: number[]; gridPx: number; w: number; h: number }
const readGrid = (f: Frame, color: Rgb): Promise<GridCounts> => f.evaluate((g) => {
  const gls = [...document.querySelectorAll('canvas.gl-canvas')] as HTMLCanvasElement[];
  const src = gls.filter((c) => c.style.display !== 'none' && c.width > 0).sort((a, b) => b.width * b.height - a.width * a.height)[0] ?? (document.getElementById('canvas') as HTMLCanvasElement);
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0);
  const px = ctx.getImageData(0, 0, c.width, c.height).data;
  const cols = new Array<number>(c.width).fill(0);
  const rows = new Array<number>(c.height).fill(0);
  let gridPx = 0;
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4;
      if (Math.abs(px[i] - g[0]) <= 6 && Math.abs(px[i + 1] - g[1]) <= 6 && Math.abs(px[i + 2] - g[2]) <= 6) {
        gridPx++;
        cols[x]++;
        rows[y]++;
      }
    }
  }
  return { cols, rows, gridPx, w: c.width, h: c.height };
}, color);

/** Waits until two reads in a row agree (the drawing is up and steady) with some of the grid's color on it. */
async function settled(f: Frame): Promise<GridCounts> {
  let last = '';
  let out: GridCounts | null = null;
  await expect.poll(async () => {
    const r = await readGrid(f, PALETTE_GRID);
    const key = JSON.stringify(r);
    const same = r.gridPx > 0 && key === last;
    last = key;
    out = r;
    return same;
  }, { timeout: 30_000, intervals: [300, 500, 800] }).toBe(true);
  return out!;
}

/**
 * What the lines boot adds over the dots boot of the same view: the columns
 * and rows that gained the grid's color on at least an eighth of their
 * length. Everything else the two boots draw is the same drawing, so a lines
 * grid shows here as whole columns and rows, and nothing else does.
 */
function gained(lines: GridCounts, dots: GridCounts): { cols: number; rows: number; px: number } {
  const cols = lines.cols.filter((n, x) => n - dots.cols[x] >= lines.h / 8).length;
  const rows = lines.rows.filter((n, y) => n - dots.rows[y] >= lines.w / 8).length;
  return { cols, rows, px: lines.gridPx - dots.gridPx };
}

for (const frame of ['sch', 'pcb'] as const) {
  const file = frame === 'sch' ? 'eeschema.json' : 'pcbnew.json';

  test(`grid=lines boots a ${frame} frame with KiCad's lines grid; no word boots it with its dots, as before`, async ({ page }) => {
    test.setTimeout(400_000);
    try {
      const plain = await boot(page, frame, null);
      // No word: the settings file holds no style, KiCad's own dots, as every frame booted before.
      expect(await seededStyle(plain, file)).toBeNull();
      await roomAround(page, frame);
      const dots = await settled(plain);
      await page.screenshot({ path: test.info().outputPath(`${frame}-dots.png`) });
      const lit = await boot(page, frame, 'lines');
      expect(await seededStyle(lit, file)).toBe(1);
      await roomAround(page, frame);
      const lines = await settled(lit);
      await page.screenshot({ path: test.info().outputPath(`${frame}-lines.png`) });
      expect([lines.w, lines.h]).toEqual([dots.w, dots.h]);
      const g = gained(lines, dots);
      measure(`${frame} dots`, `${dots.gridPx} pixels of the grid's color on the ${dots.w} by ${dots.h} canvas`);
      measure(`${frame} lines`, `${lines.gridPx} pixels of the grid's color; ${g.cols} columns and ${g.rows} rows gained it on an eighth of their length or more, ${g.px} pixels more`);
      expect(g.cols).toBeGreaterThanOrEqual(4);
      expect(g.rows).toBeGreaterThanOrEqual(4);
    } finally {
      await page.close();
    }
  });
}
