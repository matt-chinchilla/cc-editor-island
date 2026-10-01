// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// Lays out one release: dist/r/<islandId>/{index.html, island.json, assets/, wasm/<tool>/<tag>/}
// plus dist/island.json and dist/current -> r/<islandId>, with the release's notices
// (licenses.html, LICENSE.txt, NOTICE.txt) from scripts/notices.mjs, whose census fails the build.
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { inputDrift } from '../theme/icons/inputs.mjs';

const local = process.argv.includes('--local');
const pin = JSON.parse(readFileSync('PIN.json', 'utf8'));
const id = pin.islandId;
// The site's ISLAND_ID_RE: an id it would refuse never builds (release.sh, ship.sh and mirrors.sh check the same).
if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(id)) throw new Error(`PIN.json islandId ${JSON.stringify(id)} does not match ^[a-z0-9][a-z0-9.-]{0,63}$`);
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

// The icon inputs, checked before anything in dist is touched (see step 1).
const stockIcons = engine['images.tar.gz'];
const icons = pin.icons ?? {};
const stockSha = createHash('sha256').update(stockIcons).digest('hex');
if (stockSha !== icons.stockArchiveSha256) throw new Error(`images.tar.gz: stock sha256 ${stockSha} differs from PIN.json icons.stockArchiveSha256 ${icons.stockArchiveSha256}`);
const drift = inputDrift(icons.inputs);
if (drift.length > 0) throw new Error(`the icon sources differ from PIN.json icons.inputs:\n  ${drift.join('\n  ')}\nreview the glyph change, then record it with node theme/icons/inputs.mjs --pin`);

rmSync(rel, { recursive: true, force: true });
mkdirSync(join(rel, 'wasm', tool, toolTag), { recursive: true });

// 1. The engine: gz only, level 9; the icon archive raw (the boot requires it).
// The icon archive always ships repacked (theme/icons/repack.mjs), rebuilt on every
// build. The trust anchors are the inputs, checked before anything is rasterised:
// the stock archive must hash to PIN.json.icons.stockArchiveSha256 and every
// theme/icons/src/*.svg to its row in PIN.json.icons.inputs (theme/icons/inputs.mjs).
// The PNGs come from Playwright's Chromium, whose bytes differ between Chromium
// builds, so the repacked archive's sha256 is an output: repack.mjs records it in
// PIN.json.icons.repackedSha256 and the build reports whether it moved, never
// refuses on it. The release's SHA256SUMS pins the bytes that ship.
const repacked = join('theme', 'icons', 'out', 'images.tar.gz');
console.log('icons: inputs verified; rasterising the glyphs and repacking the icon archive');
execSync('node theme/icons/rasterise.mjs', { stdio: 'inherit' });
execSync('node theme/icons/repack.mjs', { stdio: 'inherit' });
const repackedIcons = readFileSync(repacked);
const repackedSha = createHash('sha256').update(repackedIcons).digest('hex');
const after = JSON.parse(readFileSync('PIN.json', 'utf8')).icons ?? {};
console.log(repackedSha === icons.repackedSha256
  ? `icons: the repack reproduced PIN.json icons.repackedSha256 ${repackedSha}`
  : `icons: the repack hashes to ${repackedSha} (PIN.json had ${icons.repackedSha256}); recorded in PIN.json, informational only`);
for (const name of FILES) {
  if (name === 'images.tar.gz') {
    console.log(`${name}: shipping the repack ${repacked} (sha256 ${repackedSha}, ${after.replacedEntries ?? '?'} entries replaced)`);
    writeFileSync(join(rel, 'wasm', tool, toolTag, name), repackedIcons);
  } else writeFileSync(join(rel, 'wasm', tool, toolTag, `${name}.gz`), gzipSync(engine[name], { level: 9 }));
}

// 2. The page and its module.
execSync('npx vite build', { stdio: 'inherit' });

// 2b. The notices: licenses.html, LICENSE.txt and NOTICE.txt beside the page. The census
// inside exits 1 (and so stops the build before current moves) when versions.sh names a
// dependency with no licence entry or a changed copied file lacks its dated notice.
execSync(`node scripts/notices.mjs ${rel}`, { stdio: 'inherit' });

// 3. island.json, twice: inside the release and at the root for the no-cache route.
const island = { id, tag: pin.pcbjam.tag, kicadCommit: pin.pcbjam.kicad, source: `https://github.com/matt-chinchilla/cc-editor-island/releases/tag/${id}` };
writeFileSync(join(rel, 'island.json'), JSON.stringify(island));
writeFileSync(join('dist', 'island.json'), JSON.stringify(island));

// 4. current -> r/<id>, relative, replaced atomically.
const tmp = join('dist', 'current.tmp');
rmSync(tmp, { force: true });
symlinkSync(join('r', id), tmp);
// rename(2) replaces the old link in one step, as mv -T did, with no coreutils dependency.
renameSync(tmp, join('dist', 'current'));
console.log(`built ${rel}${local ? ' (local)' : ''}`);
