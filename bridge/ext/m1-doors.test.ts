// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The doors table's join test (unit m1-i; the canvas commands addendum 3.6):
// every action a canvas menu of KiCad's can show that opens a window of
// KiCad's own has a door of ours. It lists every `none` row and fails while
// one remains. A `held` row must be held by the held union, or by a unit of
// the wave manifest that has not landed yet (listed as waiting): on the joined
// build every unit has landed, so nothing waits and every held row is held.
import { describe, expect, it } from 'vitest';
import { heldActions, REGISTRY } from './registry';
import { DOOR_RE, DOOR_ROWS, PROMPTS_CAP } from './m1-i/doors';
import TABLE from './contextMenuDoors.json';
import PIN_JSON from '../../PIN.json';
// @ts-expect-error a plain ES module, with no types
import { islandUnits } from '../../scripts/ext/manifest.mjs';

type MUnit = { id: string; caps: string[]; asks: string[]; heldRows: Array<{ action: string; frames: string[]; cap: string }> };
/** The manifest's island units; none where the wave plan is not on this machine (the held rows are then read in the union alone). */
const units: MUnit[] = (() => { try { return islandUnits() as MUnit[]; } catch { return []; } })();
const landed = new Set(REGISTRY.units.map((u) => u.unit));
const PIN = PIN_JSON.engine.build.kicad;

describe('the doors table (bridge/ext/contextMenuDoors.json)', () => {
  it('is read from KiCad at the engine\'s pin, by its generator', () => {
    expect((TABLE as { kicad: string }).kicad).toBe(PIN);
    expect((TABLE as { generator: string }).generator).toBe('scripts/context-menu-doors.mjs');
  });

  it('has one row per action, sorted, each door in the grammar and each row reviewed', () => {
    const names = DOOR_ROWS.map((r) => r.action);
    expect(names).toEqual([...new Set(names)].sort());
    for (const r of DOOR_ROWS) {
      expect(r.door, r.action).toMatch(DOOR_RE);
      expect(r.why, r.action).not.toBe('not reviewed');
      expect(r.why.length, r.action).toBeGreaterThan(0);
      expect(Object.keys(r).sort(), r.action).toEqual(['action', 'door', 'menus', 'opens', 'why']);
    }
  });

  it('leaves no command without a door (the none rows)', () => {
    expect(DOOR_ROWS.filter((r) => r.door === 'none').map((r) => r.action)).toEqual([]);
  });

  it('names an ask some unit declares for every prompt door, and the prompts cap is the prompt host\'s', () => {
    const asks = new Set([...REGISTRY.asks.keys(), ...units.flatMap((u) => u.asks)]);
    const caps = new Set([...REGISTRY.capNames.keys(), ...units.flatMap((u) => u.caps)]);
    if (units.length > 0) expect(caps.has(PROMPTS_CAP)).toBe(true);
    for (const r of DOOR_ROWS.filter((x) => x.door.startsWith('prompt:'))) expect(asks.has(r.door.slice('prompt:'.length)), r.action).toBe(true);
  });

  it('names a cap some unit lists for every form door', () => {
    const caps = new Set([...REGISTRY.capNames.keys(), ...units.flatMap((u) => u.caps)]);
    for (const r of DOOR_ROWS.filter((x) => x.door.startsWith('form:'))) expect(caps.has(r.door.slice('form:'.length)), r.action).toBe(true);
  });

  it('has every held row held in the union, or by a unit of the manifest still to land (waiting)', () => {
    const union = heldActions();
    const waiting: string[] = [];
    const unheld: string[] = [];
    for (const r of DOOR_ROWS.filter((x) => x.door === 'held')) {
      if (union.some((h) => h.action === r.action)) continue;
      const by = units.filter((u) => u.heldRows.some((h) => h.action === r.action)).map((u) => u.id);
      if (by.length > 0 && by.some((id) => !landed.has(id))) waiting.push(`${r.action} (${by.join(', ')})`);
      else unheld.push(r.action);
    }
    // On the joined build every unit has landed: nothing waits, and nothing is unheld.
    if (waiting.length > 0) console.info(`doors waiting for their unit: ${waiting.join('; ')}`);
    expect(unheld).toEqual([]);
  });
});
