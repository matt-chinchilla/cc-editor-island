// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// Lays out one release: dist/r/<islandId>/{index.html, island.json, assets/, wasm/<tool>/<tag>/}
// plus dist/island.json and dist/current -> r/<islandId>, with the release's notices
// (licenses.html, LICENSE.txt, NOTICE.txt) from scripts/notices.mjs, whose census fails the build.
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const local = process.argv.includes('--local');
const pin = JSON.parse(readFileSync('PIN.json', 'utf8'));
const id = pin.islandId;
const rel = join('dist', 'r', id);
const { tool, toolTag } = pin.engine;
const engineSrc = join('engine', tool, toolTag);
const FILES = ['kicad_editor.js', 'kicad_editor.wasm', 'wx.js', 'wx-dom.js', 'images.tar.gz'];
if (!existsSync(engineSrc)) throw new Error('run npm run fetch-engine first');
// Every engine file must be recorded in PIN.json and present on disk with exactly the recorded bytes.
const engine = {};
for (const name of FILES) {
  const recorded = pin.engine.files?.[name];
  if (recorded?.sha256 == null) throw new Error(`${name} not recorded in PIN.json; run npm run fetch-engine first`);
  const path = join(engineSrc, name);
  if (!existsSync(path)) throw new Error(`${name} missing from ${engineSrc}`);
  const bytes = readFileSync(path);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== recorded.sha256) throw new Error(`${name}: sha256 ${sha256} differs from PIN.json ${recorded.sha256}`);
  engine[name] = bytes;
}

rmSync(rel, { recursive: true, force: true });
mkdirSync(join(rel, 'wasm', tool, toolTag), { recursive: true });

// 1. The engine: gz only, level 9; the icon archive raw (the boot requires it).
// The icon archive always ships repacked (theme/icons/repack.mjs). The repack is
// git-ignored, so a fresh clone makes it here (rasterise, then repack) rather than
// ship the stock archive. The stock file must be the one PIN.json.icons was built
// from, and the repack must hash to what the committed PIN.json.icons recorded
// (read above, before repack.mjs rewrites the file), or the build stops naming it.
const repacked = join('theme', 'icons', 'out', 'images.tar.gz');
if (!existsSync(repacked)) {
  console.log(`${repacked} missing: rasterising the glyphs and repacking the icon archive`);
  execSync('node theme/icons/rasterise.mjs', { stdio: 'inherit' });
  execSync('node theme/icons/repack.mjs', { stdio: 'inherit' });
}
for (const name of FILES) {
  let bytes = engine[name];
  if (name === 'images.tar.gz') {
    const stockSha = createHash('sha256').update(bytes).digest('hex');
    const icons = pin.icons ?? {};
    if (stockSha !== icons.stockArchiveSha256) throw new Error(`${name}: stock sha256 ${stockSha} differs from PIN.json icons.stockArchiveSha256 ${icons.stockArchiveSha256}; run node theme/icons/repack.mjs`);
    bytes = readFileSync(repacked);
    const repackedSha = createHash('sha256').update(bytes).digest('hex');
    if (repackedSha !== icons.repackedSha256) throw new Error(`${repacked}: sha256 ${repackedSha} differs from PIN.json icons.repackedSha256 ${icons.repackedSha256} as committed; if repack.mjs just rewrote PIN.json.icons, review that diff and commit it only when the new glyph rendering is intended`);
    console.log(`${name}: shipping the repack ${repacked} (sha256 ${repackedSha}, ${icons.replacedEntries ?? '?'} entries replaced)`);
    writeFileSync(join(rel, 'wasm', tool, toolTag, name), bytes);
  } else writeFileSync(join(rel, 'wasm', tool, toolTag, `${name}.gz`), gzipSync(bytes, { level: 9 }));
}

// 2. The page and its module.
execSync('npx vite build', { stdio: 'inherit' });

// 2b. The notices: licenses.html, LICENSE.txt and NOTICE.txt beside the page. The census
// inside exits 1 (and so stops the build before current moves) when versions.sh names a
// dependency with no licence entry or a changed copied file lacks its dated notice.
execSync(`node scripts/notices.mjs ${rel}`, { stdio: 'inherit' });

// 3. island.json, twice: inside the release and at the root for the no-cache route.
const island = { id, tag: pin.pcbjam.tag, kicad: pin.pcbjam.kicad, source: `https://github.com/matt-chinchilla/cc-editor-island/releases/tag/${id}` };
writeFileSync(join(rel, 'island.json'), JSON.stringify(island));
writeFileSync(join('dist', 'island.json'), JSON.stringify(island));

// 4. current -> r/<id>, relative, replaced atomically.
const tmp = join('dist', 'current.tmp');
rmSync(tmp, { force: true });
symlinkSync(join('r', id), tmp);
execSync(`mv -T ${tmp} ${join('dist', 'current')}`);
console.log(`built ${rel}${local ? ' (local)' : ''}`);
