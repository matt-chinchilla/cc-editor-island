// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// Overlays theme/icons/png/*.png onto the verified stock images.tar.gz: every tar
// entry whose basename matches one of our PNGs gets our bytes (size field and
// header checksum rewritten), every other byte of the archive is kept as it is,
// nothing is appended and nothing is deleted. Writes theme/icons/out/images.tar.gz
// and records the stock and repacked sha256 in PIN.json.icons (the repacked one is
// informational: scripts/build.mjs enforces the stock archive and the SVG inputs).
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pin = JSON.parse(readFileSync('PIN.json', 'utf8'));
const stockPath = join('engine', pin.engine.tool, pin.engine.toolTag, 'images.tar.gz');
const stock = readFileSync(stockPath);
const stockSha = sha256(stock);
const recorded = pin.engine.files?.['images.tar.gz']?.sha256;
if (stockSha !== recorded) throw new Error(`${stockPath}: sha256 ${stockSha} differs from PIN.json ${recorded}`);

const pngDir = join('theme', 'icons', 'png');
const pngs = new Map(readdirSync(pngDir).filter((f) => f.endsWith('.png')).map((f) => [f, readFileSync(join(pngDir, f))]));
if (pngs.size === 0) throw new Error(`${pngDir} is empty; run node theme/icons/rasterise.mjs first`);

// The tar walker. Headers are 512 bytes: name 0..100, size 124..136 (octal), checksum
// 148..156, typeflag 156, ustar magic 257..263, prefix 345..500. Data is padded to 512.
const field = (h, at, len) => {
  const raw = h.subarray(at, at + len);
  const nul = raw.indexOf(0);
  return raw.subarray(0, nul === -1 ? len : nul).toString('latin1');
};
const isZero = (b) => b.every((x) => x === 0);
const checksum = (h) => {
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
  return sum;
};

const tar = gunzipSync(stock);
const parts = [];
const replaced = [];
const matchedNames = new Set();
let entries = 0;
let off = 0;
let tail = null;
while (off + 512 <= tar.length) {
  const header = tar.subarray(off, off + 512);
  if (isZero(header)) { tail = tar.subarray(off); break; } // the end of archive blocks and any record padding, verbatim
  const type = String.fromCharCode(header[156]);
  if (type === 'L' || type === 'K') throw new Error(`GNU long name entry at offset ${off}; the walker does not handle it`);
  const magic = header.subarray(257, 265).toString('latin1');
  if (!magic.startsWith('ustar')) throw new Error(`entry at offset ${off} is not ustar (magic ${JSON.stringify(magic)})`);
  const name = field(header, 0, 100);
  // The prefix field exists in the POSIX form ("ustar\0"); GNU tar ("ustar  \0") leaves it unused.
  const prefix = magic.startsWith('ustar\0') ? field(header, 345, 155) : '';
  const full = prefix ? `${prefix}/${name}` : name;
  const size = parseInt(field(header, 124, 12).trim(), 8);
  if (!Number.isFinite(size)) throw new Error(`${full}: unreadable size field`);
  const dataStart = off + 512;
  const padded = Math.ceil(size / 512) * 512;
  if (dataStart + padded > tar.length) throw new Error(`${full}: data runs past the end of the archive`);
  const base = basename(full);
  const mine = (type === '0' || type === '\0') ? pngs.get(base) : undefined;
  if (mine) {
    const h = Buffer.from(header);
    h.fill(0, 124, 136);
    h.write(mine.length.toString(8).padStart(11, '0'), 124, 11, 'latin1');
    h.fill(0, 148, 156);
    h.write(checksum(h).toString(8).padStart(6, '0'), 148, 6, 'latin1');
    h[154] = 0;
    h[155] = 0x20;
    const pad = Buffer.alloc(Math.ceil(mine.length / 512) * 512 - mine.length);
    parts.push(h, mine, pad);
    replaced.push({ name: full, stockBytes: size, bytes: mine.length });
    matchedNames.add(base);
  } else {
    parts.push(tar.subarray(off, dataStart + padded));
  }
  entries++;
  off = dataStart + padded;
}
if (tail == null) throw new Error('no end of archive blocks found');
parts.push(tail);
const unmatched = [...pngs.keys()].filter((n) => !matchedNames.has(n));
if (unmatched.length) throw new Error(`PNGs with no stock entry (the repack appends nothing): ${unmatched.join(', ')}`);

const repacked = gzipSync(Buffer.concat(parts), { level: 9 });
mkdirSync(join('theme', 'icons', 'out'), { recursive: true });
const outPath = join('theme', 'icons', 'out', 'images.tar.gz');
writeFileSync(outPath, repacked);
const repackedSha = sha256(repacked);
const ids = [...new Set(replaced.map((r) => basename(r.name).replace(/(_dark)?_(16|24|32|48|64)\.png$/, '')))].sort();
// The inputs map (theme/icons/inputs.mjs) is kept as recorded; the repacked sha256 is informational.
pin.icons = { stockArchiveSha256: stockSha, repackedSha256: repackedSha, inputs: pin.icons?.inputs ?? {}, ids, replacedEntries: replaced.length, entries };
writeFileSync('PIN.json', `${JSON.stringify(pin, null, 2)}\n`);
console.log(`${entries} entries walked, ${replaced.length} replaced (${ids.join(', ')}), ${stock.length} -> ${repacked.length} bytes`);
console.log(`stock ${stockSha}\nrepacked ${repackedSha}\nwrote ${outPath}`);
