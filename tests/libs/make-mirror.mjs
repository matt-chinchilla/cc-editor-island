// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// A small library mirror for the local pair, in the layout LIBRARY.md fixes,
// built from a handful of KiCad's own files fetched from gitlab at the tag in
// PIN.json libs.tag. The real mirror is built by scripts/build-libs.mjs from
// full checkouts; this is a test fixture, so the island can be measured and
// driven without them:
//
//   node tests/libs/make-mirror.mjs [outDir]       (default tests/libs/out)
//   LIBS_DIR=tests/libs/out npm run e2e -- --project=chromium
//
// The fetched files are laid out in outDir/.src/<tag>/ as two small checkouts
// (kicad-symbols with <Lib>.kicad_symdir/ and sym-lib-table, kicad-footprints
// with <Lib>.pretty/ and fp-lib-table) and handed to the builder's own
// buildMirror, so the fixture is a ccl2 mirror byte for byte as the builder
// writes one: outDir/<tag>/ holds manifest.json.gz, fp-index.json.gz,
// sym-index.json.gz, fp-search.json.gz, one <id>.bin.gz per library,
// LICENSE.md.gz and SHA256SUMS.gz, and is read back by verifyMirror. A
// symbol's extends chain is fetched with it, so a derived symbol's parents
// are items of its library too (Diode's 1N4148 brings 1N4001). A second run
// needs no network. KiCad's libraries are CC BY-SA 4.0 with the KiCad
// libraries exception (LICENSE.md, fetched beside them); nothing fetched here
// is committed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMirror, verifyMirror } from '../../scripts/libs/mirror.mjs';
import { parseSymbolLib } from '../../scripts/libs/kicad-symdir.mjs';

const pin = JSON.parse(readFileSync(new URL('../../PIN.json', import.meta.url), 'utf8'));
const TAG = pin.libs.tag;
const REPO = { symbols: pin.libs.symbols.repo, footprints: pin.libs.footprints.repo };
const out = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), 'out');

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

const src = join(out, '.src', TAG);
const symbolsSrc = join(src, 'kicad-symbols');
const footprintsSrc = join(src, 'kicad-footprints');

/** One file of a repository at the tag, kept under the checkout it belongs to; fetched once. */
async function file(repo, root, rel) {
  const where = join(root, rel);
  if (existsSync(where)) return readFileSync(where, 'utf8');
  const url = `${REPO[repo]}/-/raw/${TAG}/${rel.split('/').map(encodeURIComponent).join('/')}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  const text = await r.text();
  mkdirSync(dirname(where), { recursive: true });
  writeFileSync(where, text);
  return text;
}

for (const rel of ['LICENSE.md', 'sym-lib-table']) await file('symbols', symbolsSrc, rel);
for (const rel of ['LICENSE.md', 'fp-lib-table']) await file('footprints', footprintsSrc, rel);
for (const [lib, names] of Object.entries(SYMBOLS)) {
  const pending = [...names];
  const seen = new Set();
  while (pending.length > 0) {
    const name = pending.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const text = await file('symbols', symbolsSrc, `${lib}.kicad_symdir/${name}.kicad_sym`);
    for (const s of parseSymbolLib(text).symbols) if (s.extends !== null) pending.push(s.extends);
  }
}
for (const [lib, names] of Object.entries(FOOTPRINTS)) {
  for (const name of names) await file('footprints', footprintsSrc, `${lib}.pretty/${name}.kicad_mod`);
}

const built = await buildMirror({
  symbolsSrc,
  footprintsSrc,
  out,
  tag: TAG,
  provenance: {
    symbols: `A few files of ${REPO.symbols} at tag ${TAG} (tests/libs/make-mirror.mjs).`,
    footprints: `A few files of ${REPO.footprints} at tag ${TAG} (tests/libs/make-mirror.mjs).`,
  },
});
const f = verifyMirror(built.dir);
console.log(`mirror ${TAG}: ${f.symbol.libs + f.footprint.libs} libraries (${f.symbol.libs} symbol, ${f.footprint.libs} footprint; ${f.symbol.items} symbols, ${f.footprint.items} footprints) in ${built.dir}`);
