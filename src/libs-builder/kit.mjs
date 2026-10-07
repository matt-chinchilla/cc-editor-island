// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The library builder's test kit: the file system, git and CLI work the tests
// need (the typecheck has no Node types, so it lives here, typed by kit.d.mts),
// and the fixture sources, a small hand-written pair of KiCad-shaped library
// checkouts (no KiCad library content is copied) that exercise every rule the
// builder keeps: extends chains, sub-unit symbols, a plain .kicad_sym library,
// non-ASCII names and bodies, lib-table descriptions, and each pad-count case.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const tempDir = (prefix) => mkdtempSync(join(tmpdir(), `${prefix}-`));
export const removeDir = (dir) => rmSync(dir, { recursive: true, force: true });
export const listDir = (dir) => readdirSync(dir).sort();
export const readBytes = (file) => readFileSync(file);
export const writeBytes = (file, data) => writeFileSync(file, data);
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const gunzip = (bytes) => gunzipSync(bytes);
export const readStoredJson = (dir, name) => JSON.parse(gunzipSync(readFileSync(join(dir, `${name}.gz`))).toString('utf8'));
export const readStoredText = (dir, name) => gunzipSync(readFileSync(join(dir, `${name}.gz`))).toString('utf8');
export const pinJson = () => JSON.parse(readFileSync(join(ROOT, 'PIN.json'), 'utf8'));

/** Write `files` (path relative to `root`: text) under `root`. */
export function writeTree(root, files) {
  for (const [rel, text] of Object.entries(files)) {
    const file = join(root, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}

/** Run scripts/build-libs.mjs from the repository root. */
export function runCli(args) {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-libs.mjs'), ...args], { cwd: ROOT, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Make `dir` a git checkout with everything in it committed; returns HEAD. */
export function gitCommitAll(dir) {
  const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  return git('rev-parse', 'HEAD').trim();
}

// ---------------------------------------------------------------- fixtures

const HEADER = '\t(version 20251024)\n\t(generator "kicad_symbol_editor")\n\t(generator_version "10.0")\n';
const symLib = (blocks, header = HEADER) => `(kicad_symbol_lib\n${header}\t${blocks.join('\n\t')}\n)\n`;

/** A base symbol with one sub-unit holding a rectangle and a pin (sub-units are not top-level symbols). */
export const baseBlock = (name, extra = '') => [
  `(symbol "${name}"`,
  '\t\t(exclude_from_sim no)',
  '\t\t(in_bom yes)',
  '\t\t(on_board yes)',
  `\t\t(property "Reference" "U"\n\t\t\t(at 0 0 0)\n\t\t)`,
  `\t\t(property "Value" "${name}"\n\t\t\t(at 0 0 0)\n\t\t)${extra}`,
  `\t\t(symbol "${name}_1_1"\n\t\t\t(rectangle\n\t\t\t\t(start -1 -2)\n\t\t\t\t(end 1 2)\n\t\t\t)\n\t\t\t(pin passive line\n\t\t\t\t(at 0 3.81 270)\n\t\t\t\t(length 1.27)\n\t\t\t\t(number "1")\n\t\t\t)\n\t\t)`,
  '\t)',
].join('\n');

/** A derived symbol: its own Value over its parent's drawing. */
export const derivedBlock = (name, parent) => `(symbol "${name}"\n\t\t(extends "${parent}")\n\t\t(property "Value" "${name}"\n\t\t\t(at 0 0 0)\n\t\t)\n\t)`;

export const symbolFile = (blocks) => symLib(blocks);

const fpFile = (name, children, version = 20260206) => `(footprint "${name}"\n\t(version ${version})\n\t(generator "pcbnew")\n\t(generator_version "10.0")\n\t(layer "F.Cu")\n${children.map((c) => `\t${c}\n`).join('')})\n`;
const pad = (number, type, layers, extra = '') => `(pad ${number} ${type} rect\n\t\t(at 0 0)\n\t\t(size 1 1)${layers === null ? '' : `\n\t\t(layers ${layers})`}${extra}\n\t)`;

/** Two copper pads and a paste-only aperture pad: 2. */
export const R0603 = fpFile('R_0603', [
  '(descr "Résistance 0603, 10 kΩ")',
  pad('"1"', 'smd', '"F.Cu" "F.Mask" "F.Paste"'),
  pad('"2"', 'smd', '"F.Cu" "F.Mask" "F.Paste"'),
  pad('""', 'smd', '"F.Paste"'),
  '(embedded_fonts no)',
]);

/**
 * A USB-C-like receptacle: A1 and B12 twice each, four S1 shield pads, two
 * unnumbered NPTH holes, a numbered NPTH, an unnumbered copper pad and a
 * paste-only A5: A1, B12 and S1 count, so 3.
 */
export const USB_C_LIKE = fpFile('USB_C_Like', [
  pad('"A1"', 'smd', '"F.Cu" "F.Mask" "F.Paste"'),
  pad('"A1"', 'thru_hole', '"*.Cu" "*.Mask"', '\n\t\t(drill 0.6)'),
  pad('"B12"', 'smd', '"F.Cu" "F.Mask" "F.Paste"'),
  pad('"B12"', 'smd', '"F.Cu" "F.Mask" "F.Paste"'),
  ...[1, 2, 3, 4].map(() => pad('"S1"', 'thru_hole', '"*.Cu" "*.Mask"', '\n\t\t(drill 0.6)')),
  pad('""', 'np_thru_hole', '"*.Cu" "*.Mask"', '\n\t\t(drill 0.65)'),
  pad('""', 'np_thru_hole', '"*.Cu" "*.Mask"', '\n\t\t(drill 0.65)'),
  pad('"H1"', 'np_thru_hole', '"*.Cu" "*.Mask"', '\n\t\t(drill 1)'),
  pad('""', 'smd', '"F.Cu"'),
  pad('"A5"', 'smd', '"F.Paste"'),
]);

/**
 * Every other rule, one pad each, against the fork's parser: a bare number and
 * bare layers (pre-KiCad 6 style); "A", "\x41" and "\101" are one number once
 * the lexer decodes them, "a" is another; In5.Cu, *In.Cu and F&B.Cu are copper,
 * Dwgs.User and the unknown In31.Cu are not; a pad with no layers keeps the
 * default PTH mask (copper); NPTH "11" never counts; a connect pad counts; the
 * last layers form wins; a layers form inside a quoted string is not one; a
 * pad form inside a text string is not a pad. Counted: 1 A 7 8 9 10 12 a Ω1, so 9.
 */
export const ODD = fpFile('Odd', [
  '(fp_text user "(pad \\"99\\" smd rect (layers F.Cu))"\n\t\t(at 0 0)\n\t\t(layer "F.Fab")\n\t)',
  pad('1', 'thru_hole', '*.Cu *.Mask', '\n\t\t(drill 1)'),
  pad('"1"', 'smd', '"F.Cu"'),
  pad('"A"', 'smd', '"F.Cu"'),
  pad('"\\x41"', 'smd', '"B.Cu"'),
  pad('"\\101"', 'smd', '"B.Cu"'),
  pad('"a"', 'smd', '"F.Cu"'),
  pad('"7"', 'smd', '"In5.Cu"'),
  pad('"8"', 'smd', '"*In.Cu"'),
  pad('"9"', 'smd', '"F&B.Cu"'),
  pad('"10"', 'thru_hole', null, '\n\t\t(drill 1)'),
  pad('"11"', 'np_thru_hole', '"*.Cu" "*.Mask"', '\n\t\t(drill 1)'),
  pad('"12"', 'connect', '"F.Cu" "F.Mask"'),
  pad('"13"', 'smd', '"Dwgs.User"'),
  pad('"14"', 'smd', '"In31.Cu"'),
  pad('"15"', 'smd', '"F.Cu"', '\n\t\t(layers "F.Paste")'),
  pad('"16"', 'smd', '"F.SilkS"', '\n\t\t(pinfunction "(layers \\"F.Cu\\")")'),
  pad('"Ω1"', 'smd', '"F.Cu"'),
]);

export const SYM_LICENCE = 'Symbols licence text, CC BY-SA 4.0.\n';
export const FP_LICENCE = 'Footprints licence text, CC BY-SA 4.0.\n';

/**
 * Write the fixture checkouts under `root`: root/kicad-symbols and
 * root/kicad-footprints. `extra` adds a broken library: 'cycle' (A extends B
 * extends A), 'orphan' (a parent that is not in the library) or 'future' (a
 * footprint newer than the engine's pinned fork reads).
 */
export function fixtureSources(root, extra = null) {
  const symbolsSrc = join(root, 'kicad-symbols');
  const footprintsSrc = join(root, 'kicad-footprints');
  const symbols = {
    'LICENSE.md': SYM_LICENCE,
    'README.md': 'not a library\n',
    'Simulation_SPICE.sp': '* not a library\n',
    'sym-lib-table': '(sym_lib_table\n\t(version 7)\n'
      + '\t(lib (name "Device") (type "KiCad") (uri "${KICAD10_SYMBOL_DIR}/Device.kicad_symdir") (options "") (descr "Generic symbols"))\n'
      + '\t(lib (name "Diode") (type "KiCad") (uri "${KICAD10_SYMBOL_DIR}/Diode.kicad_symdir") (options "") (descr "Diodes, \\"µ\\" sized"))\n'
      + '\t(lib (name "Connector") (type "KiCad") (uri "${KICAD10_SYMBOL_DIR}/Connector.kicad_symdir") (options "") (descr "Connector symbols"))\n'
      + '\t(lib (name "Gone") (type "KiCad") (uri "${KICAD10_SYMBOL_DIR}/Gone.kicad_symdir") (options "") (descr "A row with no library"))\n'
      + ')\n',
    'Device.kicad_symdir/R.kicad_sym': symbolFile([baseBlock('R')]),
    'Device.kicad_symdir/C.kicad_sym': symbolFile([baseBlock('C')]),
    'Device.kicad_symdir/Thermistor_µ.kicad_sym': symbolFile([baseBlock('Thermistor_µ', '\n\t\t(property "Description" "10 kΩ NTC, ±1 %"\n\t\t\t(at 0 0 0)\n\t\t)')]),
    'Device.kicad_symdir/notes.txt': 'not a symbol\n',
    'Diode.kicad_symdir/D_Base.kicad_sym': symbolFile([baseBlock('D_Base')]),
    'Diode.kicad_symdir/D_Mid.kicad_sym': symbolFile([derivedBlock('D_Mid', 'D_Base')]),
    'Diode.kicad_symdir/D_Leaf.kicad_sym': symbolFile([derivedBlock('D_Leaf', 'D_Mid')]),
    'Connector.kicad_symdir/Conn_01x02.kicad_sym': symbolFile([baseBlock('Conn_01x02')]),
    // A plain library file: two symbols in one document, the second derived,
    // under a header whose quoted generator mentions a symbol form.
    'Legacy.kicad_sym': symLib([baseBlock('P1'), derivedBlock('P2', 'P1')], '\t(version 20251024)\n\t(generator "tool (symbol \\"fake\\")")\n'),
  };
  if (extra === 'cycle') {
    symbols['Cyclic.kicad_symdir/A.kicad_sym'] = symbolFile([derivedBlock('A', 'B')]);
    symbols['Cyclic.kicad_symdir/B.kicad_sym'] = symbolFile([derivedBlock('B', 'A')]);
  }
  if (extra === 'orphan') symbols['Orphan.kicad_symdir/X.kicad_sym'] = symbolFile([derivedBlock('X', 'Nope')]);
  const footprints = {
    'LICENSE.md': FP_LICENCE,
    'fp-lib-table': '(fp_lib_table\n\t(version 7)\n'
      + '\t(lib (name "Resistor_SMD") (type "KiCad") (uri "${KICAD10_FOOTPRINT_DIR}/Resistor_SMD.pretty") (options "") (descr "Resistors, \\"SMD\\""))\n'
      + '\t(lib (name "Connector") (type "KiCad") (uri "${KICAD10_FOOTPRINT_DIR}/Connector.pretty") (options "") (descr ""))\n'
      + ')\n',
    'Resistor_SMD.pretty/R_0603.kicad_mod': R0603,
    'Connector.pretty/USB_C_Like.kicad_mod': USB_C_LIKE,
    'Connector.pretty/Odd.kicad_mod': ODD,
    'Connector.pretty/README.md': 'not a footprint\n',
    'Empty.pretty/README.md': 'a library with no footprints\n',
  };
  if (extra === 'future') footprints['Future.pretty/F.kicad_mod'] = fpFile('F', [pad('"1"', 'smd', '"F.Cu"')], 20990101);
  writeTree(symbolsSrc, symbols);
  writeTree(footprintsSrc, footprints);
  return { symbolsSrc, footprintsSrc };
}
