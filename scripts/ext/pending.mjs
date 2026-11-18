// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// Writes bridge/ext/pending.json: every request op the wave manifest names for
// an island unit, with its unit; and bridge/ext/pending-frames.json: every
// frame the manifest names that no frame ships as, with the unit that defines
// it (a unit may name such a frame before that unit lands: it waits). Until that unit's file lands, the responder
// answers the op unsupported with the seam's placeholder marker
// (bridge/ext/contract.ts SEAM_PLACEHOLDER), and island.json never lists it.
// Run by the island seam once; the join test fails while any op here still
// has no unit's file.
//   node scripts/ext/pending.mjs [--check]
import { readFileSync, writeFileSync } from 'node:fs';
import { islandUnits, manifestPath } from './manifest.mjs';

const OUT = 'bridge/ext/pending.json';
const OUT_FRAMES = 'bridge/ext/pending-frames.json';
/** The unit that defines each new frame (PLAN.md: fp-i1 the footprint editor, ds-i1 the drawing sheet editor). */
const FRAME_DEFINERS = { fpedit: 'fp-i1', ds: 'ds-i1' };
const units = islandUnits();
const pending = {};
for (const u of units) for (const op of u.ops) pending[op] = u.id;
const frames = {};
for (const u of units) {
  for (const f of u.frames) {
    if (['sch', 'pcb', 'symedit'].includes(f)) continue;
    if (!(f in FRAME_DEFINERS)) { console.error(`${u.id} names frame ${f}, which no unit defines (FRAME_DEFINERS)`); process.exit(1); }
    frames[f] = FRAME_DEFINERS[f];
  }
}
const sortedText = (o) => `${JSON.stringify(Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]])), null, 2)}\n`;
const outputs = [[OUT, sortedText(pending)], [OUT_FRAMES, sortedText(frames)]];
if (process.argv.includes('--check')) {
  for (const [path, text] of outputs) if (readFileSync(path, 'utf8') !== text) { console.error(`${path} differs from ${manifestPath()}`); process.exit(1); }
} else {
  for (const [path, text] of outputs) writeFileSync(path, text);
  console.log(`${Object.keys(pending).length} ops and ${Object.keys(frames).length} frames pending, from ${manifestPath()}`);
}
