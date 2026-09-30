// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// Fetches the pinned tool's bundle from PCBJam's CDN, verifies every file
// against the tool's published meta.json sha256, and records the result in
// PIN.json. Refuses to write an unverified file. Node 22: fetch decodes br.
//
// meta.json as PCBJam publishes it (scripts/deploy/publish-wasm.mjs at v0.2.3):
//   { tool, ver, hash: "sha256:<hex>", builtAt, files: { name: "sha256:<hex>" } }
// where hash = sha256 over the sorted "name:<hex>" lines joined by "\n".
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const pin = JSON.parse(readFileSync('PIN.json', 'utf8'));
const { tool, toolTag } = pin.engine;
const base = `https://cdn.pcbjam.com/wasm/${tool}/${toolTag}`;
const FILES = ['kicad_editor.js', 'kicad_editor.wasm', 'wx.js', 'wx-dom.js', 'images.tar.gz'];
const out = join('engine', tool, toolTag);
const sha256hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
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
const listed = Object.keys(meta.files).sort();
if (listed.join('\n') !== [...FILES].sort().join('\n')) throw new Error(`meta.json lists ${listed.join(', ')}, expected ${[...FILES].sort().join(', ')}`);
const expectedHex = {};
for (const name of FILES) {
  const m = typeof meta.files[name] === 'string' ? HEX.exec(meta.files[name]) : null;
  if (m == null) throw new Error(`${name}: meta.json has no sha256 for it`);
  expectedHex[name] = m[1];
}
// The bundle hash must follow from the per-file hashes, or the meta.json is not self-consistent.
const bundleHash = 'sha256:' + sha256hex(Buffer.from(FILES.map((n) => `${n}:${expectedHex[n]}`).sort().join('\n')));
if (meta.hash !== bundleHash) throw new Error(`meta.json hash ${meta.hash} does not follow from its files (${bundleHash})`);

mkdirSync(out, { recursive: true });
const files = {};
for (const name of FILES) {
  const res = await fetch(`${base}/${name}`);
  if (!res.ok) throw new Error(`${name}: ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const sha256 = sha256hex(bytes);
  if (sha256 !== expectedHex[name]) throw new Error(`${name}: sha256 ${sha256} differs from meta.json ${expectedHex[name]}`);
  // Verified: write beside, then rename, so a crash never leaves a half file under the real name.
  const dest = join(out, name);
  writeFileSync(`${dest}.part`, bytes);
  renameSync(`${dest}.part`, dest);
  files[name] = { sha256, bytes: bytes.byteLength, source: pin.pcbjam.root };
  console.log(`${name} ${bytes.byteLength} verified`);
}
pin.engine.files = files;
writeFileSync('PIN.json', JSON.stringify(pin, null, 2) + '\n');
