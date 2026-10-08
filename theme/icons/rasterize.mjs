// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// Rasterizes theme/icons/src/*.svg through Playwright's chromium (the owner's rule:
// brand SVG goes through Chrome, never ImageMagick) into the ten PNG names KiCad
// loads per id: <id>_<size>.png and <id>_dark_<size>.png at 16, 24, 32, 48 and 64.
// Each variant sets `color` (the ink) and the glyph's accent pair (`--accent`, and
// `--hole` for the via) from the visual record's canvas palette. At 16 the stroke
// follows the record's optical ladder (1.25 px) and `.fine` details are dropped.
import { chromium } from '@playwright/test';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SIZES = [16, 24, 32, 48, 64];
const VARIANTS = [{ suffix: '', color: '#2b3137' }, { suffix: '_dark', color: '#d6dbe0' }];
// Accent pairs [day, night] per id, from icons/redraw-list.md and colors/canvas_palette.py.
const WIRE = ['#1a7a3a', '#62d92b'];
const LIT = ['#37a20d', '#62d92b'];
const COPPER = ['#c23232', '#d9503d'];
const HOLE = ['#e8ebf1', '#0f1512']; // the bench (board.background) by day, the ground by night
const ACCENTS = {
  add_component: { accent: WIRE },
  add_line: { accent: WIRE },
  erc: { accent: LIT },
  add_tracks: { accent: COPPER },
  add_via: { accent: COPPER, hole: HOLE },
  zoom_fit_in_page: { accent: COPPER },
};
// The 16 px rung of the optical ladder: 1.25 px strokes on a 24 unit grid.
const STROKE_16 = `${(1.25 * 24) / 16}px`;
const out = 'theme/icons/png';
// Start empty: a PNG left from a glyph since removed must never reach the repack.
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage();
for (const file of readdirSync('theme/icons/src').filter((f) => f.endsWith('.svg'))) {
  const id = file.replace(/\.svg$/, '');
  const svg = readFileSync(join('theme/icons/src', file), 'utf8');
  const pair = ACCENTS[id];
  if (!pair) throw new Error(`${id}: no accent pair recorded in rasterize.mjs`);
  for (const [variant, { suffix, color }] of VARIANTS.entries()) for (const size of SIZES) {
    const vars = `--accent:${pair.accent[variant]};--hole:${(pair.hole ?? HOLE)[variant]}`;
    const rung = size === 16 ? `svg *{stroke-width:${STROKE_16}}.fine{display:none}` : '';
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<html><head><style>svg{display:block}${rung}</style></head><body style="margin:0;background:transparent;color:${color};${vars}">${svg.replace('<svg', `<svg width="${size}" height="${size}"`)}</body></html>`);
    const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    writeFileSync(join(out, `${id}${suffix}_${size}.png`), png);
  }
  console.log(`${id}: ${VARIANTS.length * SIZES.length} PNGs`);
}
await browser.close();
