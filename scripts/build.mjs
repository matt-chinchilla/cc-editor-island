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
import { servedSources } from './notices.mjs';
import { collect } from './ext/gen.mjs';

const local = process.argv.includes('--local');
const pin = JSON.parse(readFileSync('PIN.json', 'utf8'));
const id = pin.islandId;
// The site's ISLAND_ID_RE: an id it would refuse never builds (release.sh, ship.sh and mirrors.sh check the same).
if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(id)) throw new Error(`PIN.json islandId ${JSON.stringify(id)} does not match ^[a-z0-9][a-z0-9.-]{0,63}$`);
const rel = join('dist', 'r', id);
const { tool, toolTag } = pin.engine;
const engineSrc = join('engine', tool, toolTag);
const ENGINE_FILES = ['kicad_editor.js', 'kicad_editor.wasm', 'wx.js', 'wx-dom.js', 'images.tar.gz'];
// The services served beside the engine when PIN.json records them, each both files or
// neither (src/main.ts installs each from its wasm's recorded size): the simulator
// (engine run 14 on) and the 3D service (engine run 15 on, wave unit 3d-i1).
const SERVICES = [
  { name: 'the simulator service', files: ['ngspice_service.js', 'ngspice_service.wasm'] },
  { name: 'the 3D service', files: ['occ_service.js', 'occ_service.wasm'] },
];
const FILES = [...ENGINE_FILES];
for (const service of SERVICES) {
  const listed = service.files.filter((name) => pin.engine.files?.[name] != null);
  if (listed.length === 1) throw new Error(`PIN.json records ${listed[0]} alone; ${service.name} is both ${service.files.join(' and ')}, or neither`);
  if (listed.length === service.files.length) FILES.push(...service.files);
}
if (!existsSync(engineSrc)) throw new Error('run npm run fetch-engine first');
// The commits the engine was built from: PIN.json engine.build for our own build, else
// PCBJam's pin (servedSources). Whether they are reachable in the mirrors is ship.sh's
// check, at ship time, against the cc/<islandId> tags; the build only needs them whole
// and agreeing with the source every engine file records.
const sources = servedSources(pin);
// Every engine file must be recorded in PIN.json and present on disk with exactly the recorded bytes.
const engine = {};
for (const name of FILES) {
  const recorded = pin.engine.files?.[name];
  if (recorded?.sha256 == null) throw new Error(`${name} not recorded in PIN.json; run npm run fetch-engine first`);
  if (recorded.source !== sources.pcbjam) throw new Error(`${name}: PIN.json says it was built from ${recorded.source}, but the served pcbjam commit is ${sources.pcbjam}; run npm run fetch-engine again`);
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
// build. The trust anchors are the inputs, checked before anything is rasterized:
// the stock archive must hash to PIN.json.icons.stockArchiveSha256 and every
// theme/icons/src/*.svg to its row in PIN.json.icons.inputs (theme/icons/inputs.mjs).
// The PNGs come from Playwright's Chromium, whose bytes differ between Chromium
// builds, so the repacked archive's sha256 is an output: repack.mjs records it in
// PIN.json.icons.repackedSha256 and the build reports whether it moved, never
// refuses on it. The release's SHA256SUMS pins the bytes that ship.
const repacked = join('theme', 'icons', 'out', 'images.tar.gz');
console.log('icons: inputs verified; rasterizing the glyphs and repacking the icon archive');
execSync('node theme/icons/rasterize.mjs', { stdio: 'inherit' });
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
// dependency with no license entry or a changed copied file lacks its dated notice.
execSync(`node scripts/notices.mjs ${rel}`, { stdio: 'inherit' });

// 3. island.json, twice: inside the release and at the root for the no-cache route.
// `ops` (island v0.2.3-cc13): the request ops this release answers, sorted: the
// built ins (bridge/ops.builtin.json) and every wave unit's (bridge/ext/<unit>.ts),
// read through the registry as the responder builds its OPS set (scripts/ext/gen.mjs
// collect; bridge/ops.json is the same list, regenerated at the join); a host reads
// it to know what the island answers before any engine boots (PROTOCOL.md). An op
// whose unit has not landed answers the seam's placeholder and is never listed.
// `exportKinds` (island v0.2.3-cc23): the jobs project.export runs, sorted, the
// built ins (bridge/exports.builtin.json) and every unit's; a host shows an output
// as held when its job is not listed (PROTOCOL.md).
const units = await collect();
if (units.problems.length > 0) throw new Error(`the wave units break the contract (bridge/ext/README.md):\n${units.problems.join('\n')}`);
const ops = units.ops;
if (!Array.isArray(ops) || ops.length === 0 || !ops.every((op) => typeof op === 'string' && /^[a-z]+(\.[a-z]+)*$/i.test(op))) throw new Error('the request ops must be strings');
const exportFaces = units.exportJobs;
const exportKinds = Object.keys(exportFaces ?? {});
if (exportKinds.length === 0 || !exportKinds.every((job) => /^[a-z][a-z0-9_]*$/.test(job) && (exportFaces[job] === 'pcb' || exportFaces[job] === 'sch'))) throw new Error('every output job must map to its face, pcb or sch');
// `timing` (island v0.2.3-cc25): `exportMs`, the bound in ms of each project.export
// job the island waits on, as bridge/exportTiming.json gives it ({ default, <job>: ms }),
// so a host waits as long as the island does; absent while that file is.
const timingPath = join('bridge', 'exportTiming.json');
let timing;
if (existsSync(timingPath)) {
  const exportMs = JSON.parse(readFileSync(timingPath, 'utf8'));
  const valid = exportMs != null && typeof exportMs === 'object' && !Array.isArray(exportMs)
    && Number.isSafeInteger(exportMs.default) && exportMs.default > 0
    && Object.entries(exportMs).every(([job, ms]) => (job === 'default' || /^[a-z][a-z0-9_]*$/.test(job)) && Number.isSafeInteger(ms) && ms > 0);
  if (!valid) throw new Error(`${timingPath} must map default and each job to a whole number of ms above 0`);
  timing = { exportMs };
}
const island = { id, tag: pin.pcbjam.tag, kicadCommit: sources.kicad, source: `https://github.com/matt-chinchilla/cc-editor-island/releases/tag/${id}`, ops: [...new Set(ops)].sort(), exportKinds: exportKinds.sort(), ...(timing ? { timing } : {}) };
writeFileSync(join(rel, 'island.json'), JSON.stringify(island));
writeFileSync(join('dist', 'island.json'), JSON.stringify(island));

// 4. current -> r/<id>, relative, replaced atomically.
const tmp = join('dist', 'current.tmp');
rmSync(tmp, { force: true });
symlinkSync(join('r', id), tmp);
// rename(2) replaces the old link in one step, as mv -T did, with no coreutils dependency.
renameSync(tmp, join('dist', 'current'));
console.log(`built ${rel}${local ? ' (local)' : ''}`);
