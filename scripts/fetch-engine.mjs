// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// Puts the pinned tool's five files in engine/<tool>/<toolTag>/, verifies every
// file, and records the result in PIN.json. Refuses to write an unverified file:
// nothing is written until all five verify. Two sources, one verify-and-write path:
//
//   node scripts/fetch-engine.mjs [--cdn]
//       PCBJam's CDN build, each file checked against the meta.json PCBJam published.
//       The files are PCBJam's, so PIN.json carries no engine.build; while it names
//       our own build, this refuses unless --cdn says to switch back to PCBJam's.
//   node scripts/fetch-engine.mjs --local <dir> [--notes <file>]
//       our own build (scripts/engine/build.sh), copied from <dir>, each file checked
//       against <dir>/meta.json (sha256 and bytes). No CDN fetch. PIN.json engine.build
//       takes the four source commits from that meta.json and the recipe name, the
//       patches and the reproduction record from the notes file, or, with no --notes,
//       as PIN.json already holds them. Every patch names the commit it is, as
//       "<repo> <recipe> <sha>", and that sha must be the build's: notes left from an
//       older build are refused.
//
// A new images.tar.gz moves the icon overlay's anchor: build.mjs refuses until
// node theme/icons/rasterize.mjs && node theme/icons/repack.mjs records it
// (PIN.json icons.stockArchiveSha256), which this says when it happens.
//
// meta.json as PCBJam publishes it (scripts/deploy/publish-wasm.mjs at v0.2.3):
//   { tool, ver, hash: "sha256:<hex>", builtAt, files: { name: "sha256:<hex>" } }
// where hash = sha256 over the sorted "name:<hex>" lines joined by "\n".
// meta.json as scripts/engine/build.sh writes it:
//   { tool, name, sources: { pcbjam, kicad, wxwidgets, shared }, recipe, files: { name: { sha256, bytes } }, builtAt, ... }
// where recipe is the pcbjam commit whose docker/build.sh ran.
// A notes file: { recipe: "cc/main", patches: ["... (kicad cc/main <sha>)", ...],
//   reproduction: { pristine: "byte-equal" | { differs: [<file>, ...], note: "<sentence>" } } }
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const pin = JSON.parse(readFileSync('PIN.json', 'utf8'));
const { tool, toolTag } = pin.engine;
const FILES = ['kicad_editor.js', 'kicad_editor.wasm', 'wx.js', 'wx-dom.js', 'images.tar.gz'];
const SOURCES = ['pcbjam', 'kicad', 'wxwidgets', 'shared'];
const out = join('engine', tool, toolTag);
const sha256hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
const SHA = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function usage() {
  console.error('usage: node scripts/fetch-engine.mjs [--cdn | --local <dir> [--notes <file>]]');
  process.exit(2);
}

/** The arguments: none or --cdn (the CDN), or --local <dir> with an optional --notes <file>. */
function parseArgs(argv) {
  const a = { local: null, notes: null, cdn: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cdn' && !a.cdn) { a.cdn = true; continue; }
    const key = argv[i] === '--local' ? 'local' : argv[i] === '--notes' ? 'notes' : null;
    if (key == null || a[key] != null || argv[i + 1] == null || argv[i + 1].startsWith('--')) usage();
    a[key] = argv[++i];
  }
  if ((a.notes != null && a.local == null) || (a.cdn && a.local != null)) usage();
  return a;
}

const sameNames = (names) => [...names].sort().join('\n') === [...FILES].sort().join('\n');

/** PCBJam's CDN: the verified sha256 of each file, and a reader that fetches it. */
async function fromCdn() {
  const base = `https://cdn.pcbjam.com/wasm/${tool}/${toolTag}`;
  const HEX = /^sha256:([0-9a-f]{64})$/;
  const manifestRes = await fetch(pin.engine.manifest);
  if (!manifestRes.ok) throw new Error(`no manifest at ${pin.engine.manifest} (${manifestRes.status})`);
  const manifest = await manifestRes.json();
  if (manifest.tools?.[tool] !== toolTag) throw new Error(`manifest pins ${tool} at ${manifest.tools?.[tool]}, PIN.json says ${toolTag}`);
  const metaRes = await fetch(`${base}/meta.json`);
  if (!metaRes.ok) throw new Error(`no meta.json at ${base}/meta.json (${metaRes.status}); nothing is shipped unverified`);
  const meta = await metaRes.json();

  // The shape as published; stop on anything else.
  if (meta.tool !== tool || meta.ver !== toolTag) throw new Error(`meta.json describes ${meta.tool}@${meta.ver}, expected ${tool}@${toolTag}`);
  if (meta.files == null || typeof meta.files !== 'object') throw new Error('meta.json has no files map');
  if (!sameNames(Object.keys(meta.files))) throw new Error(`meta.json lists ${Object.keys(meta.files).sort().join(', ')}, expected ${[...FILES].sort().join(', ')}`);
  const expected = {};
  for (const name of FILES) {
    const m = typeof meta.files[name] === 'string' ? HEX.exec(meta.files[name]) : null;
    if (m == null) throw new Error(`${name}: meta.json has no sha256 for it`);
    expected[name] = { sha256: m[1] };
  }
  // The bundle hash must follow from the per-file hashes, or the meta.json is not self-consistent.
  const bundleHash = 'sha256:' + sha256hex(Buffer.from(FILES.map((n) => `${n}:${expected[n].sha256}`).sort().join('\n')));
  if (meta.hash !== bundleHash) throw new Error(`meta.json hash ${meta.hash} does not follow from its files (${bundleHash})`);

  const read = async (name) => {
    const res = await fetch(`${base}/${name}`);
    if (!res.ok) throw new Error(`${name}: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  };
  return { expected, read, source: pin.pcbjam.root, build: null, from: base };
}

/** The recipe name, patches and reproduction record, checked against the build's own commits. */
function checkNotes(notes, sources, from) {
  const bad = (msg) => { throw new Error(`${from}: ${msg}`); };
  if (notes == null || typeof notes !== 'object') bad('no notes (pass --notes <file> on the first local install)');
  const { recipe, patches, reproduction } = notes;
  if (typeof recipe !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(recipe)) bad(`recipe ${JSON.stringify(recipe)} is not a branch name`);
  if (!Array.isArray(patches) || patches.length === 0 || patches.some((p) => typeof p !== 'string' || p.trim() === '')) bad('patches must be a list of sentences');
  const mention = new RegExp(`\\b(${SOURCES.join('|')}) ${recipe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ([0-9a-f]{7,40})\\b`, 'g');
  for (const p of patches) {
    const named = [...p.matchAll(mention)];
    if (named.length === 0) bad(`the patch "${p}" names no "<repo> ${recipe} <sha>"`);
    for (const [, repo, sha] of named) {
      if (!sources[repo].startsWith(sha)) bad(`the patch "${p}" names ${repo} ${sha}, but the build's ${repo} is ${sources[repo]}`);
    }
  }
  const pristine = reproduction?.pristine;
  if (pristine !== 'byte-equal') {
    const ok = pristine != null && typeof pristine === 'object'
      && Array.isArray(pristine.differs) && pristine.differs.length > 0
      && pristine.differs.every((f) => FILES.includes(f)) && new Set(pristine.differs).size === pristine.differs.length
      && typeof pristine.note === 'string' && pristine.note.trim() !== '';
    if (!ok) bad('reproduction.pristine must be "byte-equal" or { differs: [<engine file>, ...], note: "<sentence>" }');
  }
  return { recipe, patches, reproduction };
}

/** Our build in <dir>: the sha256 and bytes its meta.json records, a reader of the copies, and engine.build. */
function fromLocal(dir, notesPath) {
  const metaPath = join(dir, 'meta.json');
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  if (meta.tool !== tool) throw new Error(`${metaPath} describes ${meta.tool}, expected ${tool}`);
  if (meta.files == null || typeof meta.files !== 'object') throw new Error(`${metaPath} has no files map`);
  if (!sameNames(Object.keys(meta.files))) throw new Error(`${metaPath} lists ${Object.keys(meta.files).sort().join(', ')}, expected ${[...FILES].sort().join(', ')}`);
  const expected = {};
  for (const name of FILES) {
    const { sha256, bytes } = meta.files[name] ?? {};
    if (!HEX64.test(sha256 ?? '') || !Number.isSafeInteger(bytes) || bytes < 0) throw new Error(`${name}: ${metaPath} has no sha256 and bytes for it`);
    expected[name] = { sha256, bytes };
  }
  const sources = {};
  for (const key of SOURCES) {
    if (!SHA.test(meta.sources?.[key] ?? '')) throw new Error(`${metaPath} has no full commit for sources.${key}`);
    sources[key] = meta.sources[key];
  }
  // build.sh runs the recipe inside the pcbjam tree, so the recipe commit is the pcbjam commit.
  if (meta.recipe !== sources.pcbjam) throw new Error(`${metaPath}: recipe ${meta.recipe} is not the pcbjam commit ${sources.pcbjam}`);

  const notes = notesPath != null ? JSON.parse(readFileSync(notesPath, 'utf8')) : pin.engine.build;
  const { recipe, patches, reproduction } = checkNotes(notes, sources, notesPath ?? 'PIN.json engine.build');
  const build = { recipe, ...sources, patches, reproduction };
  return { expected, read: (name) => readFileSync(join(dir, name)), source: sources.pcbjam, build, from: dir };
}

/** The one verify-and-write path: all five checked in memory, then written, then PIN.json. */
async function install({ expected, read, source, build, from }) {
  const verified = new Map();
  for (const name of FILES) {
    const bytes = await read(name);
    const sha256 = sha256hex(bytes);
    if (sha256 !== expected[name].sha256) throw new Error(`${name}: sha256 ${sha256} differs from ${from} ${expected[name].sha256}`);
    if (expected[name].bytes != null && bytes.byteLength !== expected[name].bytes) throw new Error(`${name}: ${bytes.byteLength} bytes, ${from} says ${expected[name].bytes}`);
    verified.set(name, { bytes, sha256 });
  }
  mkdirSync(out, { recursive: true });
  const files = {};
  for (const [name, { bytes, sha256 }] of verified) {
    // Write beside, then rename, so a crash never leaves a half file under the real name.
    const dest = join(out, name);
    writeFileSync(`${dest}.part`, bytes);
    renameSync(`${dest}.part`, dest);
    files[name] = { sha256, bytes: bytes.byteLength, source };
    console.log(`${name} ${bytes.byteLength} verified`);
  }
  // engine.build describes our own build; PCBJam's files carry none.
  const engine = { ...pin.engine };
  delete engine.build;
  delete engine.files;
  pin.engine = build ? { ...engine, build, files } : { ...engine, files };
  writeFileSync('PIN.json', JSON.stringify(pin, null, 2) + '\n');
  console.log(`PIN.json engine.files from ${from}${build ? `; engine.build ${build.recipe}: pcbjam ${build.pcbjam}, kicad ${build.kicad}` : ''}`);
  if (files['images.tar.gz'].sha256 !== pin.icons?.stockArchiveSha256) {
    console.log('images.tar.gz is not the archive PIN.json icons.stockArchiveSha256 names: check the overlay, then record it with node theme/icons/rasterize.mjs && node theme/icons/repack.mjs (the build refuses until then)');
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.local == null && pin.engine.build != null && !args.cdn) {
  throw new Error(`PIN.json engine.build names our own build (${pin.engine.build.recipe}, pcbjam ${pin.engine.build.pcbjam}): take it with --local <dir>, or pass --cdn to switch the island back to PCBJam's CDN build`);
}
await install(args.local != null ? fromLocal(args.local, args.notes) : await fromCdn());
