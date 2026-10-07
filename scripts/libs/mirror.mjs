// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// Writes and checks one library mirror, `<out>/<tag>/`, exactly as LIBRARY.md
// lays it out: manifest.json, fp-index.json, the picker's sym-index.json and
// fp-search.json (search-index.mjs), one ccl2 bundle per library (<id>.bin),
// LICENSE.md and SHA256SUMS, every file stored gzipped only
// (<name>.gz, level 9, mtime 0). The output is a function of the sources
// alone: every list is sorted in code point order and nothing carries a time,
// so the same sources give the same bytes and the same SHA256SUMS.
// scripts/build-libs.mjs checks the sources against PIN.json before calling
// buildMirror; buildMirror itself trusts the directories it is handed.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync, gzip } from 'node:zlib';
import { compareNames, decodeBundle, encodeBundle } from './bundle.mjs';
import { extractLib, listLibs, readLibTable } from './extract-libs.mjs';
import { countUniquePads } from './kicad-pretty.mjs';
import { buildSelfContainedLib, parseSymbolLib, resolveChain } from './kicad-symdir.mjs';
import {
  footprintFacts, FP_FIELDS, FP_SEARCH, fpSearchText, INDEX_SCHEMA, SYM_FIELDS, SYM_INDEX, symbolFacts, symbolRow, symIndexText,
} from './search-index.mjs';

export const SCHEMA = 1;
export const MANIFEST = 'manifest.json';
export const FP_INDEX = 'fp-index.json';
export { FP_SEARCH, SYM_INDEX };
export const LICENSE = 'LICENSE.md';
export const SUMS = 'SHA256SUMS';
export const bundleName = (id) => `${id}.bin`;

const gzipAsync = promisify(gzip);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** gzip at level 9. zlib writes mtime 0 when no header is given; checked, so a change in Node never slips a time in. */
export async function gz(buf) {
  const out = await gzipAsync(buf, { level: 9 });
  if (out.readUInt32LE(4) !== 0) throw new Error('gzip wrote a modification time; the mirror must be reproducible');
  return out;
}

/** The ids of the libraries the sources hold, by kind, with the description each lib-table gives. */
export function sourceLibs({ symbolsSrc, footprintsSrc }) {
  const descr = {
    symbol: readLibTable(join(symbolsSrc, 'sym-lib-table')),
    footprint: readLibTable(join(footprintsSrc, 'fp-lib-table')),
  };
  return listLibs({ symbolsSrc, footprintsSrc }).map((lib) => ({ ...lib, description: descr[lib.kind].get(lib.nick) ?? null }));
}

/** LICENSE.md: each repository's own LICENSE.md, in full, under a heading naming it. */
export function licenceText({ symbolsSrc, footprintsSrc, provenance }) {
  const part = (title, src, from) => {
    const file = join(src, 'LICENSE.md');
    if (!existsSync(file)) throw new Error(`${file} is missing; the mirror ships KiCad's library licence beside the libraries`);
    const text = readFileSync(file, 'utf8');
    return `# ${title}\n\n${from}\n\n${text.endsWith('\n') ? text : `${text}\n`}`;
  };
  return `${part('kicad-symbols', symbolsSrc, provenance.symbols)}\n${part('kicad-footprints', footprintsSrc, provenance.footprints)}`;
}

/** A directory that holds nothing but regular `*.gz` files: one this module wrote, safe to replace. */
function isMirrorDir(dir) {
  return readdirSync(dir).every((name) => name.endsWith('.gz') && lstatSync(join(dir, name)).isFile());
}

/**
 * Build `<out>/<tag>/` from the two source checkouts. `only` (a list of ids)
 * limits the build to those libraries and refuses an id the sources do not
 * hold. The mirror is written beside its final place and renamed into it; a
 * previous local build at `<out>/<tag>` is replaced only when it holds nothing
 * but `*.gz` files. Returns what was written, for the build's summary.
 */
export async function buildMirror({ symbolsSrc, footprintsSrc, out, tag, only = null, provenance, log = () => {}, concurrency = availableParallelism() }) {
  if (!/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/.test(tag)) throw new Error(`the tag ${JSON.stringify(tag)} is not one the mirror can use as a directory name`);
  let libs = sourceLibs({ symbolsSrc, footprintsSrc });
  if (only !== null) {
    const known = new Set(libs.map((l) => l.id));
    const unknown = only.filter((id) => !known.has(id));
    if (unknown.length > 0) throw new Error(`--only names ${unknown.join(', ')}, which the sources do not hold (ids are sym.<nickname> and fp.<nickname>)`);
    const wanted = new Set(only);
    libs = libs.filter((l) => wanted.has(l.id));
  }
  const licence = licenceText({ symbolsSrc, footprintsSrc, provenance: provenance ?? { symbols: `At tag ${tag}.`, footprints: `At tag ${tag}.` } });

  mkdirSync(out, { recursive: true });
  const final = join(out, tag);
  const stage = join(out, `.${tag}.partial`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage);

  const stored = new Map();   // stored file name -> sha256 of its gz bytes
  const manifestLibs = [];
  const fpIndex = {};
  const symRows = [];
  const fpRows = [];
  const raw = {};
  const skipped = [];
  const inflight = new Set();
  for (const lib of libs) {
    const { items } = extractLib(lib);
    if (items.length === 0) {
      skipped.push(lib.id);
      log(`  ${lib.id}: no items, left out`);
      continue;
    }
    const bundle = encodeBundle({ id: lib.id, kind: lib.kind, items: items.map((it) => [it.name, it.body]) });
    raw[lib.id] = bundle.length;
    const row = { id: lib.id, name: lib.nick, kind: lib.kind, itemCount: items.length, bytes: 0 };
    if (lib.description !== null) row.description = lib.description;
    manifestLibs.push(row);
    // extractLib sorts by name in code point order, the order encodeBundle writes.
    if (lib.kind === 'footprint') fpIndex[lib.id] = items.map((it) => [it.name, it.pads]);
    for (const it of items) (lib.kind === 'symbol' ? symRows : fpRows).push(it.row);
    const job = gz(bundle).then((zipped) => {
      const name = `${bundleName(lib.id)}.gz`;
      writeFileSync(join(stage, name), zipped);
      stored.set(name, sha256(zipped));
      row.bytes = zipped.length;
      log(`  ${lib.id.padEnd(48)} ${String(items.length).padStart(6)} items ${String(zipped.length).padStart(10)} bytes`);
    });
    inflight.add(job);
    job.finally(() => inflight.delete(job)).catch(() => {});
    if (inflight.size >= concurrency) await Promise.race(inflight);
  }
  await Promise.all(inflight);

  manifestLibs.sort((a, b) => compareNames(a.id, b.id));
  const fpIndexSorted = {};
  for (const id of Object.keys(fpIndex).sort(compareNames)) fpIndexSorted[id] = fpIndex[id];
  const put = async (name, text) => {
    const zipped = await gz(Buffer.from(text, 'utf8'));
    writeFileSync(join(stage, `${name}.gz`), zipped);
    stored.set(`${name}.gz`, sha256(zipped));
  };
  await put(MANIFEST, JSON.stringify({ schema: SCHEMA, tag, libs: manifestLibs }));
  await put(FP_INDEX, JSON.stringify({ schema: SCHEMA, tag, libs: fpIndexSorted }));
  await put(SYM_INDEX, symIndexText(tag, symRows));
  await put(FP_SEARCH, fpSearchText(tag, fpRows));
  await put(LICENSE, licence);
  const sums = [...stored.keys()].sort(compareNames).map((name) => `${stored.get(name)}  ${name}\n`).join('');
  await put(SUMS, sums);

  if (existsSync(final)) {
    if (!isMirrorDir(final)) throw new Error(`${final} exists and holds more than a mirror's *.gz files; not replacing it`);
    rmSync(final, { recursive: true });
  }
  renameSync(stage, final);
  return { dir: final, libs: manifestLibs, raw, skipped, sumsSha256: stored.get(`${SUMS}.gz`) };
}

/** A stored file's gzip bytes, their header checked: deflate, mtime 0, the level 9 flag. */
function readZipped(dir, name) {
  const zipped = readFileSync(join(dir, name));
  if (zipped.length < 18 || zipped[0] !== 0x1f || zipped[1] !== 0x8b || zipped[2] !== 8) throw new Error(`${name} is not a gzip file`);
  if (zipped.readUInt32LE(4) !== 0) throw new Error(`${name} carries a gzip modification time`);
  if (zipped[8] !== 2) throw new Error(`${name} was not compressed at level 9 (gzip XFL ${zipped[8]})`);
  return zipped;
}

/** A stored file read back: its gzip bytes (checked) and its inflated bytes. */
function readStored(dir, name) {
  const zipped = readZipped(dir, name);
  return { zipped, bytes: gunzipSync(zipped) };
}

/** An index file's rows, its header checked against the manifest's tag and the fields the picker reads. */
function readIndexRows(dir, name, tag, fields) {
  const doc = JSON.parse(readStored(dir, `${name}.gz`).bytes.toString('utf8'));
  if (doc === null || typeof doc !== 'object' || doc.schema !== INDEX_SCHEMA || doc.tag !== tag) throw new Error(`${name} is not schema ${INDEX_SCHEMA} with the manifest's tag`);
  if (JSON.stringify(doc.fields) !== JSON.stringify(fields)) throw new Error(`${name} fields are ${JSON.stringify(doc.fields)}, not ${JSON.stringify(fields)}`);
  if (!Array.isArray(doc.rows)) throw new Error(`${name} has no rows`);
  return doc.rows;
}

/**
 * Check a built mirror end to end: every file a regular `*.gz`, SHA256SUMS
 * covering exactly the other files and matching them, the manifest sorted by
 * id with each bundle's stored size and item count, every bundle decoding,
 * every symbol body a kicad_symbol_lib holding the item alone (ccl2) whose
 * extends chain resolves inside its own bundle, fp-index keyed by footprint
 * library id with every footprint's name and unique pad count recomputed from
 * its body, and sym-index and fp-search holding exactly one row per item of
 * the manifest's libraries, in order, each recomputed from the bodies.
 * Throws on the first fault; returns the mirror's figures.
 */
export function verifyMirror(dir) {
  const names = readdirSync(dir).sort(compareNames);
  for (const name of names) {
    if (!name.endsWith('.gz')) throw new Error(`${name} is not stored gzipped`);
    if (!lstatSync(join(dir, name)).isFile()) throw new Error(`${name} is not a regular file`);
  }
  for (const need of [MANIFEST, FP_INDEX, SYM_INDEX, FP_SEARCH, LICENSE, SUMS]) {
    if (!names.includes(`${need}.gz`)) throw new Error(`${need}.gz is missing`);
  }

  const sumsText = readStored(dir, `${SUMS}.gz`).bytes.toString('utf8');
  const listed = new Map();
  for (const line of sumsText.split('\n').filter((l) => l !== '')) {
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!m) throw new Error(`SHA256SUMS line ${JSON.stringify(line)} is not "<sha256>  <name>"`);
    if (listed.has(m[2])) throw new Error(`SHA256SUMS lists ${m[2]} twice`);
    listed.set(m[2], m[1]);
  }
  const others = names.filter((n) => n !== `${SUMS}.gz`);
  for (const name of others) if (!listed.has(name)) throw new Error(`${name} is not in SHA256SUMS`);
  for (const name of listed.keys()) if (!others.includes(name)) throw new Error(`SHA256SUMS lists ${name}, which is missing`);

  for (const name of others) {
    if (sha256(readZipped(dir, name)) !== listed.get(name)) throw new Error(`${name} does not match its SHA256SUMS line`);
  }

  const manifest = JSON.parse(readStored(dir, `${MANIFEST}.gz`).bytes.toString('utf8'));
  if (manifest.schema !== SCHEMA || typeof manifest.tag !== 'string' || !Array.isArray(manifest.libs)) throw new Error('manifest.json is not schema 1 with a tag and libs');
  const fpIndex = JSON.parse(readStored(dir, `${FP_INDEX}.gz`).bytes.toString('utf8'));
  if (fpIndex.schema !== SCHEMA || fpIndex.tag !== manifest.tag || fpIndex.libs === null || typeof fpIndex.libs !== 'object') throw new Error('fp-index.json is not schema 1 with the manifest\'s tag and libs');
  if (readStored(dir, `${LICENSE}.gz`).bytes.length === 0) throw new Error('LICENSE.md is empty');
  const symRows = readIndexRows(dir, SYM_INDEX, manifest.tag, SYM_FIELDS);
  const fpRows = readIndexRows(dir, FP_SEARCH, manifest.tag, FP_FIELDS);
  // The rows are sorted by lib then name; the manifest by id, which within a
  // kind is the same order, so each library's rows are a run at a cursor.
  const cursor = { symbol: 0, footprint: 0 };
  const expectRow = (kind, row) => {
    const rows = kind === 'symbol' ? symRows : fpRows;
    const file = kind === 'symbol' ? SYM_INDEX : FP_SEARCH;
    const at = cursor[kind]++;
    if (JSON.stringify(rows[at]) !== JSON.stringify(row)) throw new Error(`${file}: row ${at} is ${JSON.stringify(rows[at])}, the bundle says ${JSON.stringify(row)}`);
  };

  const figures = {
    tag: manifest.tag,
    symbol: { libs: 0, items: 0, bytes: 0, raw: 0 },
    footprint: { libs: 0, items: 0, bytes: 0, raw: 0 },
    biggest: [],
    indexes: {},
  };
  const bundles = new Set(others.filter((n) => n.endsWith('.bin.gz')));
  const fpIds = [];
  let prev = null;
  for (const lib of manifest.libs) {
    const prefix = lib.kind === 'symbol' ? 'sym' : lib.kind === 'footprint' ? 'fp' : null;
    if (prefix === null) throw new Error(`manifest: ${lib.id} has kind ${JSON.stringify(lib.kind)}`);
    if (lib.id !== `${prefix}.${lib.name}`) throw new Error(`manifest: ${lib.id} is not ${prefix}.<name> for name ${JSON.stringify(lib.name)}`);
    if (prev !== null && compareNames(prev, lib.id) >= 0) throw new Error(`manifest: ${lib.id} is out of order after ${prev}`);
    prev = lib.id;
    if ('description' in lib && (typeof lib.description !== 'string' || lib.description === '')) throw new Error(`manifest: ${lib.id} has a description that is not text`);
    const name = `${bundleName(lib.id)}.gz`;
    if (!bundles.has(name)) throw new Error(`manifest names ${lib.id}, but ${name} is missing`);
    const f = readStored(dir, name);
    bundles.delete(name);
    if (lib.bytes !== f.zipped.length) throw new Error(`manifest: ${lib.id} bytes ${lib.bytes}, but ${name} is ${f.zipped.length} bytes`);
    const bundle = decodeBundle(f.bytes);
    if (bundle.id !== lib.id || bundle.kind !== lib.kind) throw new Error(`${name} says ${bundle.id} (${bundle.kind})`);
    if (bundle.items.length !== lib.itemCount) throw new Error(`manifest: ${lib.id} itemCount ${lib.itemCount}, but the bundle holds ${bundle.items.length}`);
    if (lib.kind === 'symbol') {
      const byName = new Map();
      for (const item of bundle.items) {
        const where = `${lib.id}:${item.name}`;
        const text = item.body.toString('utf8');
        const parsed = parseSymbolLib(text);
        if (parsed.symbols.length !== 1 || parsed.symbols[0].name !== item.name) {
          throw new Error(`${where}: the body holds ${parsed.symbols.map((s) => s.name).join(', ')}, not the item alone`);
        }
        if (buildSelfContainedLib(parsed.header, [], parsed.symbols[0].block) !== text) throw new Error(`${where}: the body is not the library header and the symbol, as the builder writes them`);
        byName.set(item.name, parsed.symbols[0]);
      }
      const facts = new Map();
      const factsOf = (sym) => {
        if (!facts.has(sym.name)) facts.set(sym.name, symbolFacts(sym.block));
        return facts.get(sym.name);
      };
      for (const item of bundle.items) {
        const sym = byName.get(item.name);
        let parents;
        try {
          parents = resolveChain(byName, sym);
        } catch (err) {
          throw new Error(`${lib.id}: ${err.message}`);
        }
        expectRow('symbol', symbolRow(lib.name, [...parents, sym].map(factsOf)));
      }
    } else {
      fpIds.push(lib.id);
      const index = fpIndex.libs[lib.id];
      if (!Array.isArray(index) || index.length !== bundle.items.length) throw new Error(`fp-index: ${lib.id} does not list the bundle's ${bundle.items.length} footprints`);
      bundle.items.forEach((item, i) => {
        const text = item.body.toString('utf8');
        const pads = countUniquePads(text);
        const row = index[i];
        if (!Array.isArray(row) || row[0] !== item.name || row[1] !== pads) throw new Error(`fp-index: ${lib.id} row ${i} is ${JSON.stringify(row)}, the bundle says ["${item.name}",${pads}]`);
        const { desc, tags } = footprintFacts(text);
        expectRow('footprint', [lib.name, item.name, desc, tags, pads]);
      });
    }
    const k = figures[lib.kind];
    k.libs += 1;
    k.items += bundle.items.length;
    k.bytes += f.zipped.length;
    k.raw += f.bytes.length;
    figures.biggest.push({ id: lib.id, bytes: f.zipped.length, raw: f.bytes.length, items: bundle.items.length });
  }
  if (bundles.size > 0) throw new Error(`${[...bundles].join(', ')} not named by the manifest`);
  const indexIds = Object.keys(fpIndex.libs);
  if (indexIds.join('\n') !== fpIds.join('\n')) throw new Error('fp-index is not keyed by exactly the manifest\'s footprint libraries, in id order');
  if (cursor.symbol !== symRows.length) throw new Error(`${SYM_INDEX} has ${symRows.length} rows, the bundles hold ${cursor.symbol} symbols`);
  if (cursor.footprint !== fpRows.length) throw new Error(`${FP_SEARCH} has ${fpRows.length} rows, the bundles hold ${cursor.footprint} footprints`);
  for (const [file, rows] of [[SYM_INDEX, symRows], [FP_SEARCH, fpRows]]) {
    const f = readStored(dir, `${file}.gz`);
    figures.indexes[file] = { rows: rows.length, bytes: f.zipped.length, raw: f.bytes.length };
  }
  figures.biggest.sort((a, b) => b.bytes - a.bytes || compareNames(a.id, b.id));
  figures.biggest = figures.biggest.slice(0, 5);
  figures.sumsSha256 = sha256(readFileSync(join(dir, `${SUMS}.gz`)));
  return figures;
}
