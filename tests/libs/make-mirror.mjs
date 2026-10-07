// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// A small library mirror for the local pair, in the layout LIBRARY.md fixes,
// built from a handful of KiCad's own files fetched from gitlab at the tag in
// PIN.json libs.tag. The real mirror is built elsewhere (the libs build); this
// is a test fixture, so the island can be measured and driven before that
// mirror exists:
//
//   node tests/libs/make-mirror.mjs [outDir]       (default tests/libs/out)
//   LIBS_DIR=tests/libs/out npm run e2e -- --project=chromium
//
// outDir is what the local pair serves as /libs/: it receives <tag>/ with
// manifest.json.gz, fp-index.json.gz, one <id>.bin.gz per library, LICENSE.md.gz
// and SHA256SUMS.gz. The fetched sources are kept in outDir/.src/ so a second
// run needs no network. KiCad's libraries are CC BY-SA 4.0 with the KiCad
// libraries exception (LICENSE.md, fetched beside them); nothing fetched here
// is committed.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

const pin = JSON.parse(readFileSync(new URL('../../PIN.json', import.meta.url), 'utf8'));
const TAG = pin.libs.tag;
const SYM = `${pin.libs.symbols.repo}/-/raw/${TAG}`;
const FP = `${pin.libs.footprints.repo}/-/raw/${TAG}`;
const out = process.argv[2] ?? join(dirname(new URL(import.meta.url).pathname), 'out');

/** Symbol libraries (nickname: symbols); a symbol's extends chain is fetched with it. */
const SYMBOLS = {
  Device: ['R', 'C', 'L', 'LED'],
  Amplifier_Operational: ['LM358'],
  Diode: ['1N4148'],
  Transistor_BJT: ['2N3904'],
  power: ['GND', '+5V'],
  Connector: ['TestPoint'],
};
/** Footprint libraries (nickname: footprints). */
const FOOTPRINTS = {
  Resistor_SMD: ['R_0603_1608Metric', 'R_0805_2012Metric'],
  Capacitor_SMD: ['C_0603_1608Metric'],
  LED_SMD: ['LED_0603_1608Metric'],
  Package_TO_SOT_SMD: ['SOT-23'],
  Diode_SMD: ['D_SOD-123'],
};

const srcDir = join(out, '.src');
async function fetchText(url) {
  const cached = join(srcDir, createHash('sha256').update(url).digest('hex').slice(0, 24));
  if (existsSync(cached)) return readFileSync(cached, 'utf8');
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  const text = await r.text();
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(cached, text);
  return text;
}

/** The top-level (symbol "NAME" ...) blocks of a kicad_symbol_lib and the text before the first one. */
function splitSymbolLib(text) {
  const blocks = new Map();
  let depth = 0;
  let inStr = false;
  let start = -1;
  let header = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '(') {
      depth++;
      if (depth === 2 && text.startsWith('(symbol ', i)) {
        start = i;
        if (header == null) header = text.slice(0, i).trimEnd();
      }
    } else if (c === ')') {
      if (depth === 2 && start >= 0) {
        const block = text.slice(start, i + 1);
        blocks.set(/^\(symbol\s+"((?:[^"\\]|\\.)*)"/.exec(block)[1], block);
        start = -1;
      }
      depth--;
    }
  }
  return { header, blocks };
}

/** A self-contained kicad_symbol_lib for one symbol: its extends chain first, root first. */
async function symbolBody(lib, name) {
  const chain = [];
  let header = null;
  for (let cur = name, guard = 0; cur != null; guard++) {
    if (guard > 8) throw new Error(`${lib}:${name}: extends chain too long`);
    const { header: h, blocks } = splitSymbolLib(await fetchText(`${SYM}/${lib}.kicad_symdir/${encodeURIComponent(cur)}.kicad_sym`));
    header ??= h;
    const block = blocks.get(cur);
    if (block == null) throw new Error(`${lib}:${cur}: not in its file`);
    chain.unshift(block);
    cur = /^\(symbol\s+"(?:[^"\\]|\\.)*"\s*\(extends\s+"((?:[^"\\]|\\.)*)"\)/.exec(block)?.[1] ?? null;
  }
  return `${header}\n${chain.map((b) => `\t${b}`).join('\n')}\n)\n`;
}

/** Distinct pad numbers over pads that are neither NPTH nor unnumbered (GetUniquePadCount(DO_NOT_INCLUDE_NPTH)). */
function uniquePadCount(mod) {
  const nums = new Set();
  for (const m of mod.matchAll(/\(pad\s+"((?:[^"\\]|\\.)*)"\s+([a-z_]+)/g)) {
    if (m[1] !== '' && m[2] !== 'np_thru_hole') nums.add(m[1]);
  }
  return nums.size;
}

/** The descr of each row of a lib table. */
function descriptions(table) {
  const d = new Map();
  for (const m of table.matchAll(/\(lib\s+\(name\s+"((?:[^"\\]|\\.)*)"\).*?\(descr\s+"((?:[^"\\]|\\.)*)"\)/g)) d.set(m[1], m[2]);
  return d;
}

const enc = new TextEncoder();
function bundle(id, kind, items) {
  items.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const bodies = items.map(([, body]) => enc.encode(body));
  const header = JSON.stringify({ v: 1, id, kind, items: items.map(([name], i) => [name, bodies[i].length]) });
  return Buffer.concat([enc.encode(`${header}\n`), ...bodies]);
}

const symDescr = descriptions(await fetchText(`${SYM}/sym-lib-table`));
const fpDescr = descriptions(await fetchText(`${FP}/fp-lib-table`));
const files = new Map();
const libs = [];
const fpIndex = {};
for (const [lib, names] of Object.entries(SYMBOLS)) {
  const items = [];
  for (const n of names) items.push([n, await symbolBody(lib, n)]);
  const id = `sym.${lib}`;
  files.set(`${id}.bin`, bundle(id, 'symbol', items));
  libs.push({ id, name: lib, kind: 'symbol', itemCount: items.length, description: symDescr.get(lib) });
}
for (const [lib, names] of Object.entries(FOOTPRINTS)) {
  const items = [];
  for (const n of names) items.push([n, await fetchText(`${FP}/${lib}.pretty/${encodeURIComponent(n)}.kicad_mod`)]);
  const id = `fp.${lib}`;
  files.set(`${id}.bin`, bundle(id, 'footprint', items));
  libs.push({ id, name: lib, kind: 'footprint', itemCount: items.length, description: fpDescr.get(lib) });
  fpIndex[id] = items.map(([name, body]) => [name, uniquePadCount(body)]);
}

const gz = (buf) => gzipSync(buf, { level: 9 });   // node writes mtime 0
const tagDir = join(out, TAG);
rmSync(tagDir, { recursive: true, force: true });
mkdirSync(tagDir, { recursive: true });
const stored = new Map();
for (const [name, buf] of files) stored.set(`${name}.gz`, gz(buf));
libs.sort((a, b) => (a.id < b.id ? -1 : 1));
for (const l of libs) {
  l.bytes = stored.get(`${l.id}.bin.gz`).length;
  if (l.description == null) delete l.description;
}
stored.set('manifest.json.gz', gz(Buffer.from(JSON.stringify({ schema: 1, tag: TAG, libs }))));
stored.set('fp-index.json.gz', gz(Buffer.from(JSON.stringify({ schema: 1, tag: TAG, libs: fpIndex }))));
const licence = `${await fetchText(`${SYM}/LICENSE.md`)}\n\n${await fetchText(`${FP}/LICENSE.md`)}`;
stored.set('LICENSE.md.gz', gz(Buffer.from(licence)));
const sums = [...stored].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, buf]) => `${createHash('sha256').update(buf).digest('hex')}  ${name}\n`).join('');
stored.set('SHA256SUMS.gz', gz(Buffer.from(sums)));
for (const [name, buf] of stored) writeFileSync(join(tagDir, name), buf);
console.log(`mirror ${TAG}: ${libs.length} libraries (${libs.filter((l) => l.kind === 'symbol').length} symbol, ${libs.filter((l) => l.kind === 'footprint').length} footprint) in ${tagDir}`);
