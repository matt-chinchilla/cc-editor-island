// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The repack's inputs: the sha256 of every theme/icons/src/*.svg. PIN.json
// records them in icons.inputs (a map of path to sha256), and scripts/build.mjs
// refuses to rasterize and repack unless the sources on disk are exactly those.
// The repacked archive itself is a build output: its PNGs come from Playwright's
// Chromium, whose bytes differ between Chromium builds, so its sha256 is recorded
// (icons.repackedSha256) but never enforced; the release's SHA256SUMS pins what ships.
//   node theme/icons/inputs.mjs          print the inputs and whether PIN.json matches
//   node theme/icons/inputs.mjs --pin    record the current sources in PIN.json (after a reviewed glyph change)
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ICON_SRC = 'theme/icons/src';

/** Every source SVG as { 'theme/icons/src/<id>.svg': sha256 }, sorted by path. */
export function iconInputs(dir = ICON_SRC) {
  const out = {};
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.svg')).sort()) {
    out[`${dir}/${f}`] = createHash('sha256').update(readFileSync(join(dir, f))).digest('hex');
  }
  return out;
}

/** The differences between the sources on disk and a recorded map, as sentences; empty when they agree. */
export function inputDrift(recorded, actual = iconInputs()) {
  if (recorded == null || typeof recorded !== 'object' || Array.isArray(recorded)) return ['PIN.json icons.inputs is not a map of path to sha256'];
  const drift = [];
  for (const [path, sha] of Object.entries(actual)) {
    if (!(path in recorded)) drift.push(`${path} is not recorded in PIN.json icons.inputs`);
    else if (recorded[path] !== sha) drift.push(`${path}: sha256 ${sha} differs from PIN.json ${recorded[path]}`);
  }
  for (const path of Object.keys(recorded)) if (!(path in actual)) drift.push(`${path} is recorded in PIN.json icons.inputs but missing`);
  return drift;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pin = JSON.parse(readFileSync('PIN.json', 'utf8'));
  const actual = iconInputs();
  if (process.argv.includes('--pin')) {
    pin.icons = { ...pin.icons, inputs: actual };
    writeFileSync('PIN.json', `${JSON.stringify(pin, null, 2)}\n`);
    console.log(`recorded ${Object.keys(actual).length} icon sources in PIN.json icons.inputs`);
  } else {
    for (const [p, s] of Object.entries(actual)) console.log(`${s}  ${p}`);
    const drift = inputDrift(pin.icons?.inputs, actual);
    console.log(drift.length === 0 ? 'PIN.json icons.inputs matches' : drift.join('\n'));
    process.exitCode = drift.length === 0 ? 0 : 1;
  }
}
