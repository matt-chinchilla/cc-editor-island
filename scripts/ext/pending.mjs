// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// Writes bridge/ext/pending.json: every request op the wave manifest names for
// an island unit, with its unit. Until that unit's file lands, the responder
// answers the op unsupported with the seam's placeholder marker
// (bridge/ext/contract.ts SEAM_PLACEHOLDER), and island.json never lists it.
// Run by the island seam once; the join test fails while any op here still
// has no unit's file.
//   node scripts/ext/pending.mjs [--check]
import { readFileSync, writeFileSync } from 'node:fs';
import { islandUnits, manifestPath } from './manifest.mjs';

const OUT = 'bridge/ext/pending.json';
const pending = {};
for (const u of islandUnits()) for (const op of u.ops) pending[op] = u.id;
const sorted = Object.fromEntries(Object.keys(pending).sort().map((k) => [k, pending[k]]));
const text = `${JSON.stringify(sorted, null, 2)}\n`;
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) { console.error(`${OUT} differs from ${manifestPath()}`); process.exit(1); }
} else {
  writeFileSync(OUT, text);
  console.log(`${Object.keys(sorted).length} ops pending, from ${manifestPath()}`);
}
