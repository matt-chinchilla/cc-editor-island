// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The wave manifest's island names, read from the file CC_W2_MANIFEST names
// (default the wave plan's wave2-manifest.json): for each unit of the island
// layer, its ops, caps, events, held actions and rows, asks, export jobs,
// frames and e2e spec, as plain names (the manifest's notes in parentheses
// taken off). Read by scripts/ext/pending.mjs and the join test.
import { readFileSync } from 'node:fs';

export const DEFAULT_MANIFEST = '/home/matthew/cc-wave2/plan/wave2-manifest.json';
export const manifestPath = () => process.env.CC_W2_MANIFEST || DEFAULT_MANIFEST;

/** "ev.held (widened: ...)" is "ev.held"; "blocks (gated on ...)" is "blocks". */
export const bare = (s) => String(s).replace(/\s*\(.*$/s, '').trim();
/** A held entry "pcbnew.X.y (fpedit, under fpedit)": the action. */
const heldName = (s) => bare(s);

/** Every island unit of the manifest, with its names. */
export function islandUnits(path = manifestPath()) {
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  const all = Array.isArray(doc) ? doc : (doc.units ?? []);
  const out = [];
  for (const u of all) {
    if (u == null || u.layer !== 'island') continue;
    const i = u.island ?? {};
    const list = (k) => (Array.isArray(i[k]) ? i[k].map(bare).filter((s) => s !== '') : []);
    const widened = (k) => list(k).filter((s) => !/\bwidened\b|\bexisting\b|\bunchanged\b/.test(String((i[k] ?? []).find((x) => bare(x) === s) ?? '')));
    out.push({
      id: u.id,
      ops: list('ops'),
      opsWidened: list('opsWidened'),
      caps: list('caps'),
      /** New event types only (a widened, existing or unchanged one ships already). */
      events: widened('events'),
      held: Array.isArray(i.held) ? i.held.map(heldName) : [],
      heldRows: Array.isArray(i.heldRows) ? i.heldRows : [],
      asks: list('asks'),
      exportJobs: list('exportJobs'),
      frames: list('frames'),
      e2e: typeof i.e2e === 'string' ? i.e2e : null,
    });
  }
  return out;
}
