// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { describe, expect, it } from 'vitest';
import { BOARD_OPS, editJson, parseEditArgs, readEditReport, SCH_OPS } from './edit';

const U = 'aaaaaaaa-0000-4000-8000-000000000001';
const Z = 'aaaaaaaa-0000-4000-8000-000000000002';
const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

describe('board.edit args', () => {
  it('takes every op with its filter and set', () => {
    const cases = [
      { op: 'tracksVias', filter: { tracks: true, nets: ['/SDA'], netClass: 'Power', layer: 'F.Cu', uuids: [U], microVias: false, trackWidth: 0.2 }, set: { width: 0.3, viaDiameter: 'netclass', annularRings: 'keepAll' } },
      { op: 'textGraphics', filter: { references: true, refGlob: 'R*', footprintItems: true }, set: { height: 1, thickness: 0.15, visible: true, defaults: false } },
      { op: 'teardrops', filter: { vias: true, existing: true }, set: { on: true, lengthRatio: 0.5, maxWidth: 2 } },
      { op: 'swapLayers', filter: {}, set: { map: { 'F.Cu': 'B.Cu', 'B.Cu': 'F.Cu' } } },
      { op: 'deleteGlobal', filter: { texts: true, layer: 'F.SilkS', locked: true }, set: {} },
      { op: 'cleanupTracks', filter: { nets: ['GND'] }, set: { mergeCollinear: true, refillZones: false } },
      { op: 'unusedPads', filter: { uuids: [U] }, set: { vias: true, keepOuter: true, remove: false } },
      { op: 'cleanupGraphics', filter: {}, set: { mergeRects: true, tolerance: 0.01 } },
      { op: 'repair', filter: {}, set: {} },
      { op: 'reannotate', filter: {}, set: {} },
      { op: 'reannotate', filter: {}, set: { order: 7, round: 1.27, by: 'reference', frontStart: 1, backStart: 101, frontPrefix: '', backPrefix: 'B', removePrefix: true, skipLocked: true, scope: 'back', exclude: 'R*, C' } },
      { op: 'zoneOrder', filter: {}, set: { order: [U, Z] } },
    ];
    for (const c of cases) expect(parseEditArgs({ ...c, preview: true }, BOARD_OPS), c.op).toEqual({ ...c, preview: true });
    expect(JSON.parse(editJson(4, '/tmp/cc-edit/4', { ...cases[8], preview: false }))).toEqual({ run: 4, dir: '/tmp/cc-edit/4', op: 'repair', preview: false, filter: {}, set: {} });
  });

  it('refuses a key the op does not take, a value of another kind, and an op with nothing to do', () => {
    const bad = [
      { op: 'tracksVias', filter: { tracks: true }, set: {} },
      { op: 'tracksVias', filter: { tracks: false, vias: false }, set: { width: 0.2 } },
      { op: 'tracksVias', filter: { tracks: true }, set: { width: 0 } },
      { op: 'tracksVias', filter: { tracks: true }, set: { width: 'class' } },
      { op: 'tracksVias', filter: { tracks: true, nets: [] }, set: { width: 0.2 } },
      { op: 'tracksVias', filter: { tracks: true, layer: 'F Cu' }, set: { width: 0.2 } },
      { op: 'textGraphics', filter: { boardItems: true }, set: { bold: true } },
      { op: 'textGraphics', filter: { references: true }, set: { color: 'red' } },
      { op: 'teardrops', filter: { vias: true }, set: { lengthRatio: 0 } },
      { op: 'swapLayers', filter: { tracks: true }, set: { map: { 'F.Cu': 'B.Cu' } } },
      { op: 'swapLayers', filter: {}, set: { map: {} } },
      { op: 'deleteGlobal', filter: { locked: true }, set: {} },
      { op: 'deleteGlobal', filter: { texts: true }, set: { all: true } },
      { op: 'unusedPads', filter: {}, set: { keepOuter: true } },
      { op: 'cleanupGraphics', filter: {}, set: { tolerance: 0.1 } },
      { op: 'repair', filter: { all: true }, set: {} },
      { op: 'reannotate', filter: {}, set: { order: 8 } },
      { op: 'reannotate', filter: {}, set: { frontPrefix: 'x'.repeat(33) } },
      { op: 'zoneOrder', filter: {}, set: { order: [U, U] } },
      { op: 'zoneOrder', filter: {}, set: {} },
      { op: 'unknown', filter: {}, set: {} },
    ];
    for (const a of bad) expect(parseEditArgs({ ...a, preview: true }, BOARD_OPS), JSON.stringify(a)).toBeNull();
    expect(parseEditArgs({ op: 'repair', filter: {}, set: {} }, BOARD_OPS)).toBeNull();
    expect(parseEditArgs({ op: 'repair', preview: true, filter: {}, set: {}, extra: 1 }, BOARD_OPS)).toBeNull();
  });
});

describe('sch.edit args', () => {
  it('takes the text and graphics edit with KiCad\'s targets and filters, and nothing else', () => {
    const a = { op: 'textGraphics', preview: false, filter: { references: true, sheetPath: '/', refGlob: 'R*', power: false }, set: { size: 1.27, bold: true, hAlign: 'left', lineStyle: 'dashDot' } };
    expect(parseEditArgs(a, SCH_OPS)).toEqual(a);
    for (const bad of [{ ...a, op: 'tracksVias' }, { ...a, filter: { power: true } }, { ...a, set: {} }, { ...a, set: { size: 0 } }, { ...a, set: { hAlign: 'justify' } }, { ...a, set: { color: '#fff' } }]) {
      expect(parseEditArgs(bad, SCH_OPS), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('the edit report', () => {
  const asked = { op: 'reannotate', preview: true, filter: {}, set: {} };
  const report = (o: Record<string, unknown> = {}) => ({ op: 'reannotate', preview: true, rows: [{ uuid: U, kind: 'footprint', words: 'R4 to R12', from: 'R4', to: 'R12', symbolPath: `/${Z}` }], count: 1, truncated: false, depth: 7, ...o });

  it('reads a board report with symbol paths and the run\'s lines as notes', () => {
    expect(readEditReport(enc(report()), 'pcb', asked)).toEqual({ ...report(), notes: [] });
    expect(readEditReport(enc(report({ lines: [{ severity: 'warning', text: 'R? keeps its designator.' }] })), 'pcb', asked)?.notes).toEqual(['R? keeps its designator.']);
    expect(readEditReport(enc(report({ rows: [{ uuid: '', kind: 'item', words: 'Redundant via' }], count: 9, truncated: true })), 'pcb', asked)?.count).toBe(9);
    const sch = { op: 'textGraphics', preview: false, filter: {}, set: {} };
    expect(readEditReport(enc({ op: 'textGraphics', preview: false, rows: [{ uuid: U, kind: 'reference', words: 'R1 Reference: size' }], count: 1, truncated: false, depth: 2 }), 'sch', sch)?.rows).toHaveLength(1);
  });

  it('refuses each other shape', () => {
    for (const [r, f] of [[report({ op: 'repair' }), 'pcb'], [report({ preview: false }), 'pcb'], [report({ x: 1 }), 'pcb'], [report(), 'sch'], [report({ lines: [] }), 'sch'],
      [report({ rows: [{ uuid: U, kind: 'footprint', words: 'w', from: 'a' }] }), 'pcb'], [report({ rows: [{ uuid: U, kind: 'planet', words: 'w' }] }), 'pcb'],
      [report({ rows: [{ uuid: U, kind: 'footprint', words: 'w', symbolPath: 'nope' }] }), 'pcb'], [report({ count: 0 }), 'pcb']] as const) {
      expect(readEditReport(enc(r), f, asked), JSON.stringify(r)).toBeNull();
    }
  });
});
