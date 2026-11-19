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
/**
 * A held entry's row when its note names one: "a.b.c (fpedit, under fpedit)"
 * or "a.b.c (sch, under importGraphics; symedit already holds it)" is
 * { action, frames, cap }; null when the note names none.
 */
export function heldRowOf(s) {
  const m = String(s).match(/\(\s*([a-z][a-z0-9 ,]*?)\s*,\s*under\s+([A-Za-z][A-Za-z0-9:]*)/);
  if (m == null) return null;
  const frames = m[1].split(/[\s,]+|\band\b/).filter((f) => f !== '');
  return frames.length === 0 ? null : { action: bare(s), frames, cap: m[2] };
}
/** An owned path of the island ("island:bridge/x.ts (note)" is "bridge/x.ts"); null for another repository or a unit files entry. */
const islandPath = (s) => (typeof s === 'string' && s.startsWith('island:') ? bare(s.slice('island:'.length)).replace(/#.*$/, '') : null);

/** A fixture entry: its path in this repository, the manifest's "island:" prefix taken off. */
export const fixturePath = (s) => bare(String(s).replace(/^island:/, ''));

/** Every island unit of the manifest, with its names. */
export function islandUnits(path = manifestPath()) {
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  const all = Array.isArray(doc) ? doc : (doc.units ?? []);
  const out = [];
  for (const u of all) {
    if (u == null || u.layer !== 'island') continue;
    const i = u.island ?? {};
    const list = (k) => (Array.isArray(i[k]) ? i[k].map(bare).filter((s) => s !== '') : []);
    const heldRows = Array.isArray(i.heldRows) ? [...i.heldRows] : [];
    // A held entry whose note names its frames and cap is a row too (fp-i6's "(fpedit, under fpedit)").
    for (const h of Array.isArray(i.held) ? i.held : []) {
      const row = heldRowOf(h);
      if (row != null && !heldRows.some((r) => r.action === row.action && row.frames.every((f) => (r.frames ?? []).includes(f)))) heldRows.push(row);
    }
    const widened = (k) => list(k).filter((s) => !/\bwidened\b|\bexisting\b|\bunchanged\b/.test(String((i[k] ?? []).find((x) => bare(x) === s) ?? '')));
    out.push({
      id: u.id,
      ops: list('ops'),
      opsWidened: list('opsWidened'),
      caps: list('caps'),
      /** New event types only (a widened, existing or unchanged one ships already). */
      events: widened('events'),
      held: Array.isArray(i.held) ? i.held.map(heldName) : [],
      heldRows,
      asks: list('asks'),
      exportJobs: list('exportJobs'),
      frames: list('frames'),
      /** Its e2e spec; null for none (a fixture unit's record names "", i-fix-blocks). */
      e2e: typeof i.e2e === 'string' && i.e2e.trim() !== '' ? i.e2e.trim() : null,
      /** The island fixture folders and files its record names, "island:tests/fixtures/x/" read as "tests/fixtures/x/". */
      fixtures: Array.isArray(i.fixtures) ? i.fixtures.map(fixturePath).filter((f) => f !== '') : [],
      /** The island paths it may create or edit (its ownedPaths). */
      owned: (Array.isArray(u.ownedPaths) ? u.ownedPaths : []).map(islandPath).filter((p) => p != null),
    });
  }
  return out;
}
