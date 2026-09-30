// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// Lays out one release: dist/r/<islandId>/{index.html, island.json, assets/, wasm/<tool>/<tag>/}
// plus dist/island.json and dist/current -> r/<islandId>. The icon and notices halves come later.
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
for (const name of FILES) {
  const bytes = engine[name];
  if (name === 'images.tar.gz') writeFileSync(join(rel, 'wasm', tool, toolTag, name), bytes);
  else writeFileSync(join(rel, 'wasm', tool, toolTag, `${name}.gz`), gzipSync(bytes, { level: 9 }));
}
// (Task 4 replaces the archive with the repacked one here.)

// 2. The page and its module.
execSync('npx vite build', { stdio: 'inherit' });

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
