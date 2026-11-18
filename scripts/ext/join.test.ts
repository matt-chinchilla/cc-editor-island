// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The JOIN test (npm run test:join; never in the default run): every name the
// wave manifest gives the island (CC_W2_MANIFEST, default the wave plan's
// wave2-manifest.json) is made by a landed unit's file, no manifest op still
// answers the seam's placeholder, and the generated files are current.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { BUILTIN_EVENTS, BUILTIN_OPS } from '../../bridge/ext/builtins';
import { exportJobs, heldActions, REGISTRY, requestOps } from '../../bridge/ext/registry';
// @ts-expect-error a plain ES module, with no types
import { bare, islandUnits, manifestPath } from './manifest.mjs';
// @ts-expect-error a plain ES module, with no types
import { assembleProtocol, EXPORTS_PATH, OPS_PATH, PROTOCOL_PATH, readFragments } from './gen.mjs';

type MUnit = { id: string; ops: string[]; opsWidened: string[]; caps: string[]; events: string[]; held: string[]; heldRows: Array<{ action: string; frames: string[]; cap: string }>; asks: string[]; exportJobs: string[]; frames: string[]; e2e: string | null };
const units = islandUnits() as MUnit[];
const missing = (pick: (u: MUnit) => string[], has: (name: string) => boolean): string[] =>
  units.flatMap((u) => pick(u).filter((n) => !has(n)).map((n) => `${u.id}: ${n}`));

describe(`the join: every island name of ${manifestPath() as string}`, () => {
  it('reads the manifest', () => { expect(units.length).toBeGreaterThan(0); });

  it('loads every unit with no broken rule', () => { expect(REGISTRY.problems).toEqual([]); });

  it('answers every manifest op by a landed unit, none of them the seam placeholder', () => {
    expect(missing((u) => u.ops, (op) => REGISTRY.ops.has(op) || BUILTIN_OPS.includes(op))).toEqual([]);
    expect([...REGISTRY.pending.keys()]).toEqual([]);
  });

  it('answers every widened op through a hook of its unit, or the unit edits a file it alone owns', () => {
    // A widening the manifest names lands either as an opsWidened hook or in a bridge file the unit owns (its ownedPaths).
    const landed = new Set(REGISTRY.units.map((u) => u.unit));
    expect(units.flatMap((u) => u.opsWidened.filter((op) => !REGISTRY.widen.has(bare(op) as string) && !landed.has(u.id)).map((op) => `${u.id}: ${op}`))).toEqual([]);
  });

  it('declares every new event, cap, ask, export job and frame', () => {
    expect(missing((u) => u.events.filter((e) => !BUILTIN_EVENTS.includes(e)), (e) => REGISTRY.events.has(e))).toEqual([]);
    expect(missing((u) => u.caps, (c) => REGISTRY.capNames.has(c))).toEqual([]);
    expect(missing((u) => u.asks, (a) => REGISTRY.asks.has(a))).toEqual([]);
    expect(missing((u) => u.exportJobs, (j) => j in exportJobs())).toEqual([]);
    expect(missing((u) => u.frames, (f) => ['sch', 'pcb', 'symedit'].includes(f) || REGISTRY.frames.has(f))).toEqual([]);
  });

  it('holds every held action, and every held row exactly', () => {
    const rows = heldActions();
    expect(missing((u) => u.held, (a) => rows.some((h) => h.action === a))).toEqual([]);
    const row = (r: { action: string; frames: string[]; cap: string }) => `${r.action} [${[...r.frames].sort().join(' ')}] ${r.cap}`;
    const have = new Set<string>();
    for (const h of rows) for (const f of h.frames) have.add(`${h.action} ${f} ${h.cap}`);
    expect(units.flatMap((u) => u.heldRows.filter((r) => !r.frames.every((f) => have.has(`${r.action} ${f} ${r.cap}`))).map((r) => `${u.id}: ${row(r)}`))).toEqual([]);
  });

  it('has every unit\'s e2e spec, and a PROTOCOL.md part for every unit with ops or events', () => {
    expect(units.filter((u) => u.e2e != null && !existsSync(u.e2e)).map((u) => `${u.id}: ${u.e2e}`)).toEqual([]);
    const parts = new Set((readFragments() as Array<{ unit: string }>).map((f) => f.unit));
    expect(REGISTRY.units.filter((u) => (Object.keys(u.ops ?? {}).length > 0 || Object.keys(u.events ?? {}).length > 0) && !parts.has(u.unit)).map((u) => u.unit)).toEqual([]);
  });

  it('has the generated files current (node scripts/ext/gen.mjs)', () => {
    expect(JSON.parse(readFileSync(OPS_PATH as string, 'utf8'))).toEqual(requestOps());
    expect(JSON.parse(readFileSync(EXPORTS_PATH as string, 'utf8'))).toEqual(exportJobs());
    const protocol = readFileSync(PROTOCOL_PATH as string, 'utf8');
    expect(assembleProtocol(protocol, readFragments()) === protocol).toBe(true);
  });
});
