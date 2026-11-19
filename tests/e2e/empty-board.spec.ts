// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// flt-ds4-i over the local pair: a board with no item at all (the island's
// empty-board fixture: header, layers and setup only) opened in a pcb frame
// shows no pixel of the palette's drawing sheet color (theme/colors/
// circuitcenter.json board.worksheet, the same color as board.page_limits)
// after its first view and after view.fit; Glasgow's first view still shows
// its whole board, fitted, with no such pixel either. Each read also says
// where the colored pixels sit (on the page's edge, the page limits, or
// inside it, the drawing sheet), the local settings file the island staged
// for the board, and the view the fit chose, which is the diagnosis the
// unit's report quotes. A design that carries its own .kicad_prl (KiCad
// writes one beside every project, and the site hands it over) is read the
// same way, in KiCad 10's named form and in KiCad 8's numbered one.
import { expect, test, type Frame, type Page } from '@playwright/test';
import palette from '../../theme/colors/circuitcenter.json' with { type: 'json' };
import { ISLAND } from './ports';

interface Ev { type: string; phase?: string; caps?: string[]; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface View { cx: number; cy: number; scale: number; w: number; h: number }
interface SheetRead { w: number; h: number; colors: number; sheet: number; onEdge: number; inside: number; boardInside: number }

const PALETTE = palette as unknown as { board: Record<string, string> };
const rgbOf = (css: string): number[] => {
  const m = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(css);
  if (m == null) throw new Error(`not an opaque rgb() palette value: ${css}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};
/** The color KiCad draws the drawing sheet in, and the page limits in, on a board. */
const SHEET = rgbOf(PALETTE.board.worksheet);
const LIMITS = rgbOf(PALETTE.board.page_limits);
const BACKGROUND = rgbOf(PALETTE.board.background);
/** A4 landscape, the fixtures' paper, in nm. */
const PAGE = { w: 297e6, h: 210e6 };
/** Glasgow's outline (tests/fixtures/glasgow, its Edge.Cuts lines and arcs), in nm. */
const GLASGOW = { x0: 50e6, y0: 71e6, x1: 130e6, y1: 120e6 };
const CONFIG = '/home/kicad/.config/kicad/kicad/10.0';
const ROOT = '/home/kicad/documents/kicad/10.0/projects/cc';

const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const request = (page: Page, op: string, args?: unknown): Promise<Record<string, unknown>> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const);

function measure(type: string, description: string): void {
  test.info().annotations.push({ type, description });
  console.log(`[measure] ${type}: ${description}`);
}

/**
 * The local settings KiCad itself writes beside a new project, every
 * visibility item shown (the drawing sheet among them): KiCad 10's named form
 * (schema 5, VISIBILITY_LAYER's names in its order) and KiCad 8's numbered
 * one (schema 3, GAL layer offsets, the drawing sheet 24).
 */
const OWN_PRL = {
  named: { board: { active_layer: 0, visible_items: ['tracks', 'vias', 'pads', 'zones', 'shapes', 'bitmaps', 'footprints_front', 'footprints_back', 'footprint_values', 'footprint_references', 'footprint_text', 'footprint_anchors', 'ly_points', 'ratsnest', 'drc_warnings', 'drc_errors', 'drc_exclusions', 'locked_item_shadows', 'conflict_shadows', 'board_outline_area', 'drawing_sheet', 'grid'], visible_layers: 'ffffffff_ffffffff_ffffffff_ffffffff' }, meta: { filename: 'empty-board.kicad_prl', version: 5 } },
  numbered: { board: { active_layer: 0, visible_items: [0, 1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 32, 33, 34, 35, 36, 39, 40], visible_layers: 'fffffff_ffffffff' }, meta: { filename: 'empty-board.kicad_prl', version: 3 } },
};

/** Opens the empty board with the fixture's files and one of OWN_PRL beside them, as the site hands a project over (the frame's first document, so KiCad loads this project's settings fresh). */
async function openWithOwnSettings(page: Page, form: keyof typeof OWN_PRL): Promise<void> {
  const text = `${JSON.stringify(OWN_PRL[form], null, 2)}\n`;
  const opened = await page.evaluate(async (prl) => {
    const names = ['empty-board.kicad_pro', 'empty-board.kicad_pcb'];
    const files = await Promise.all(names.map(async (path) => ({ path, bytes: new Uint8Array(await (await fetch(`/fixtures/empty-board/${path}`)).arrayBuffer()) })));
    files.push({ path: 'empty-board.kicad_prl', bytes: new TextEncoder().encode(prl) });
    return (window as unknown as Harness).__bridge.request('project.open', { name: 'empty-board', files });
  }, text);
  expect(opened.opened).toBe('empty-board.kicad_pcb');
}

/** Boots a pcb frame; with a fixture the harness opens it at ev.ready, without one the frame holds no document yet. */
async function boot(page: Page, fixture: string | null, opened: string | null): Promise<Frame> {
  await page.goto(fixture == null ? '/parent.html?frame=pcb' : `/parent.html?fixture=${fixture}&frame=pcb`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  expect((await events(page)).filter((e) => e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))).toEqual([]);
  if (opened != null) await expect(page.locator('#state')).toContainText(`opened ${opened}`, { timeout: 120_000 });
  const frame = page.frames().find((f) => f.url().startsWith(`${ISLAND}/`));
  if (frame == null) throw new Error('no island frame');
  return frame;
}

const viewport = async (frame: Frame): Promise<View> =>
  JSON.parse(await frame.evaluate(() => (window as unknown as { Module: { kicadCollabGetViewport(): string } }).Module.kicadCollabGetViewport()));

/**
 * The drawing read back whole from the surface the engine draws into: how
 * many pixels show the drawing sheet or page limits color, and of those how
 * many lie within 2 px of the page's edge (KiCad's page limits) or inside it
 * (the drawing sheet's frame and title block); and how many pixels other than
 * the background lie inside `box` (nm), when one is given.
 */
const readSheet = (frame: Frame, view: View, box: { x0: number; y0: number; x1: number; y1: number } | null): Promise<SheetRead> =>
  frame.evaluate(({ tells, bg, view, page, box }) => {
    const gls = [...document.querySelectorAll('canvas.gl-canvas')] as HTMLCanvasElement[];
    const src = gls.filter((c) => c.style.display !== 'none' && c.width > 0).sort((a, b) => b.width * b.height - a.width * a.height)[0] ?? (document.getElementById('canvas') as HTMLCanvasElement);
    const c = document.createElement('canvas');
    c.width = src.width;
    c.height = src.height;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(src, 0, 0);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    // The drawing's pixels against the view's pixels (a canvas larger than the view on a dense screen).
    const k = c.width / view.w;
    const worldX = (x: number): number => view.cx + (x / k - view.w / 2) / view.scale;
    const worldY = (y: number): number => view.cy + (y / k - view.h / 2) / view.scale;
    const slack = 2 / k / view.scale;
    const colors = new Set<number>();
    let sheet = 0;
    let onEdge = 0;
    let inside = 0;
    let boardInside = 0;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        colors.add((px[i] << 16) | (px[i + 1] << 8) | px[i + 2]);
        const wx = worldX(x);
        const wy = worldY(y);
        if (box != null && wx >= box.x0 && wx <= box.x1 && wy >= box.y0 && wy <= box.y1 && (px[i] !== bg[0] || px[i + 1] !== bg[1] || px[i + 2] !== bg[2])) boardInside++;
        if (!tells.some((t) => Math.abs(px[i] - t[0]) <= 2 && Math.abs(px[i + 1] - t[1]) <= 2 && Math.abs(px[i + 2] - t[2]) <= 2)) continue;
        sheet++;
        const edge = Math.min(Math.abs(wx), Math.abs(wx - page.w), Math.abs(wy), Math.abs(wy - page.h)) <= slack;
        if (edge) onEdge++;
        else inside++;
      }
    }
    return { w: c.width, h: c.height, colors: colors.size, sheet, onEdge, inside, boardInside };
  }, { tells: [SHEET, LIMITS], bg: BACKGROUND, view, page: PAGE, box });

/** Waits until the drawing is painted (more than one color) and two reads in a row agree. */
async function settled(frame: Frame, box: { x0: number; y0: number; x1: number; y1: number } | null): Promise<{ view: View; read: SheetRead }> {
  let last = '';
  let out: { view: View; read: SheetRead } | null = null;
  await expect.poll(async () => {
    const view = await viewport(frame);
    const read = await readSheet(frame, view, box);
    const key = JSON.stringify([view, read]);
    const same = read.colors > 1 && key === last;
    last = key;
    out = { view, read };
    return same;
  }, { timeout: 60_000, intervals: [500, 750, 1_000] }).toBe(true);
  return out!;
}

const quote = (label: string, s: { view: View; read: SheetRead }): void => {
  const spanW = s.view.w / s.view.scale / 1e6;
  const spanH = s.view.h / s.view.scale / 1e6;
  measure(label, `${s.read.sheet} drawing sheet colored pixels (${s.read.onEdge} on the page's edge, ${s.read.inside} inside it), ${s.read.colors} colors, view centered at ${(s.view.cx / 1e6).toFixed(1)}, ${(s.view.cy / 1e6).toFixed(1)} mm spanning ${spanW.toFixed(1)} by ${spanH.toFixed(1)} mm (the page is 297 by 210)`);
};

test('an empty board: no pixel of the drawing sheet or page limits color after the first view and after view.fit', async ({ page }) => {
  test.setTimeout(300_000);
  const frame = await boot(page, 'empty-board', 'empty-board.kicad_pcb');

  // What the island staged for the board, and the user setting KiCad reads for page limits.
  const staged = await frame.evaluate(({ root, config }) => {
    const FS = (window as unknown as { FS: { analyzePath(p: string): { exists: boolean }; readFile(p: string, o: { encoding: 'utf8' }): string; readdir(p: string): string[] } }).FS;
    const read = (p: string): string | null => (FS.analyzePath(p).exists ? FS.readFile(p, { encoding: 'utf8' }) : null);
    return { files: FS.readdir(root).filter((n) => n !== '.' && n !== '..').sort(), prl: read(`${root}/empty-board.kicad_prl`), pcbnew: read(`${config}/pcbnew.json`) };
  }, { root: ROOT, config: CONFIG });
  measure('staged', `project folder: ${staged.files.join(', ')}`);
  const prl = staged.prl == null ? null : JSON.parse(staged.prl) as { board?: { visible_items?: string[] } };
  measure('prl', prl == null ? 'no empty-board.kicad_prl' : `visible_items: ${(prl.board?.visible_items ?? []).length} names, drawing_sheet ${(prl.board?.visible_items ?? []).includes('drawing_sheet') ? 'listed' : 'left out'}`);
  const pcbnew = staged.pcbnew == null ? null : JSON.parse(staged.pcbnew) as { pcb_display?: { show_page_borders?: boolean } };
  measure('pcbnew.json', `pcb_display.show_page_borders ${String(pcbnew?.pcb_display?.show_page_borders)}`);
  expect(prl?.board?.visible_items).toBeDefined();
  expect(prl?.board?.visible_items).not.toContain('drawing_sheet');

  const first = await settled(frame, null);
  quote('first view', first);
  await page.screenshot({ path: test.info().outputPath('empty-board-first.png') });

  await request(page, 'view.fit');
  const fitted = await settled(frame, null);
  quote('after view.fit', fitted);
  await page.screenshot({ path: test.info().outputPath('empty-board-fitted.png') });

  expect(first.read.sheet).toBe(0);
  expect(fitted.read.sheet).toBe(0);
});

for (const form of ['named', 'numbered'] as const) {
  test(`an empty board with its own ${form} .kicad_prl showing every item: no pixel of the drawing sheet or page limits color, the user's other settings kept`, async ({ page }) => {
    test.setTimeout(300_000);
    const frame = await boot(page, null, null);
    await openWithOwnSettings(page, form);
    const prl = await frame.evaluate((root) => (window as unknown as { FS: { readFile(p: string, o: { encoding: 'utf8' }): string } }).FS.readFile(`${root}/empty-board.kicad_prl`, { encoding: 'utf8' }), ROOT);
    measure(`own ${form} prl as KiCad reads it`, prl.replace(/\s+/g, ' ').slice(0, 600));
    const first = await settled(frame, null);
    quote(`own ${form} prl, first view`, first);
    await page.screenshot({ path: test.info().outputPath(`empty-board-own-${form}.png`) });
    await request(page, 'view.fit');
    const fitted = await settled(frame, null);
    quote(`own ${form} prl, after view.fit`, fitted);
    expect(first.read.sheet).toBe(0);
    expect(fitted.read.sheet).toBe(0);
    // The user's own keys stand: only the drawing sheet left their list.
    const read = JSON.parse(prl) as { board: { active_layer: number; visible_layers: string } };
    expect(read.board.active_layer).toBe(0);
    expect(read.board.visible_layers).toBe(OWN_PRL[form].board.visible_layers);
  });
}

test('Glasgow: the first view still fits the whole board, drawn inside its outline, with no drawing sheet pixel', async ({ page }) => {
  test.setTimeout(300_000);
  const frame = await boot(page, 'glasgow', 'glasgow.kicad_pcb');
  const first = await settled(frame, GLASGOW);
  quote('glasgow first view', first);
  measure('glasgow board', `${first.read.boardInside} drawn pixels inside the outline, ${first.read.colors} colors`);
  const v = first.view;
  const halfW = v.w / 2 / v.scale;
  const halfH = v.h / 2 / v.scale;
  const slack = 1 / v.scale;
  expect(GLASGOW.x0 >= v.cx - halfW - slack && GLASGOW.x1 <= v.cx + halfW + slack && GLASGOW.y0 >= v.cy - halfH - slack && GLASGOW.y1 <= v.cy + halfH + slack).toBe(true);
  expect(Math.max((GLASGOW.x1 - GLASGOW.x0) / (2 * halfW), (GLASGOW.y1 - GLASGOW.y0) / (2 * halfH))).toBeGreaterThan(0.5);
  expect(first.read.colors).toBeGreaterThan(8);
  expect(first.read.boardInside).toBeGreaterThan(0);
  expect(first.read.sheet).toBe(0);
});
