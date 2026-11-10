// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { describe, expect, it } from 'vitest';
import {
  boardCheckJson, EXPLAINED_TYPES, MAX_FINDINGS, MAX_FINDING_ITEMS, parseBoardCheckArgs, parseExplainArgs,
  readBoardCheckDone, readDrcReport, readExplain,
} from './boardCheck';

const enc = (s: unknown) => new TextEncoder().encode(typeof s === 'string' ? s : JSON.stringify(s));
const R1 = '0f3b2c1d-1111-4222-8333-944455556666';
const R1_PAD = '0f3b2c1d-1111-4222-8333-944455556667';
const TRACK = '0f3b2c1d-1111-4222-8333-944455556668';
const MARK = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;

const pad = { uuid: R1_PAD, kind: 'pad', ref: 'R1', pad: '1', net: '/VCC', layer: 'F.Cu', parent: R1, description: 'Pad 1 [/VCC] of R1 on F.Cu' };
const track = { uuid: TRACK, kind: 'track', ref: '', pad: '', net: '/GND', layer: 'F.Cu', parent: '', description: 'Track [/GND] on F.Cu, length 4.0000 mm' };
const finding = (o: Record<string, unknown> = {}) => ({
  marker: MARK(1), type: 'clearance', severity: 'error', excluded: false, comment: '', layer: 'F.Cu', x: 101.5, y: 52.25,
  items: [pad, track], rule: { source: 'custom', name: 'Tight' }, actual: 0.15,
  message: 'Clearance violation (rule \'Tight\' clearance 0.2500 mm; actual 0.1500 mm)', ...o,
});
/** drc.json as kicadCheckBoard writes it (engine run A, section 7.2 of its design without `truncated`). */
const report = (o: Record<string, unknown> = {}) => ({
  violations: [finding(), finding({ marker: MARK(2), type: 'silk_overlap', severity: 'warning', items: [], rule: null, actual: null }), finding({ marker: MARK(3), type: 'track_dangling', severity: 'warning', excluded: true, comment: 'on purpose', items: [track], rule: null, actual: null })],
  unconnected: [finding({ marker: MARK(4), type: 'unconnected_items', layer: '', rule: null, actual: null })],
  parity: [finding({ marker: MARK(5), type: 'extra_footprint', severity: 'warning', items: [{ ...pad, uuid: R1, kind: 'footprint', pad: '', net: '', layer: 'F.Cu', parent: '' }], rule: null, actual: null })],
  parityRun: 'yes', filled: true, skipped: [], ignored: ['silk_edge_clearance'],
  errors: 2, warnings: 2, excludedCount: 1, depth: 3,
  ...o,
});

describe('board.check args', () => {
  it('takes exactly fill, parity and allTrackErrors, each a boolean', () => {
    expect(parseBoardCheckArgs({ fill: true, parity: false, allTrackErrors: false })).toEqual({ fill: true, parity: false, allTrackErrors: false });
    for (const bad of [undefined, null, {}, [], { fill: true, parity: false }, { fill: true, parity: false, allTrackErrors: 0 }, { fill: 'yes', parity: false, allTrackErrors: false }, { fill: true, parity: false, allTrackErrors: false, extra: 1 }]) {
      expect(parseBoardCheckArgs(bad)).toBeNull();
    }
  });

  it('hands the engine run, dir and the three switches, nothing else', () => {
    expect(JSON.parse(boardCheckJson(4, '/tmp/cc-drc/4', { fill: false, parity: true, allTrackErrors: true }))).toEqual({ run: 4, dir: '/tmp/cc-drc/4', fill: false, parity: true, allTrackErrors: true });
  });
});

describe('.cc-drc.json', () => {
  it('reads the code, the error, the message and the lines closed', () => {
    expect(readBoardCheckDone(enc({ code: 0, error: '', message: '', lines: [] }))).toEqual({ code: 0, error: '', message: '', lines: [] });
    expect(readBoardCheckDone(enc({ code: -1, error: 'rules_invalid', message: 'Expected ( in line 3', lines: [{ severity: 'error', text: 'x' }] }))).toEqual({ code: -1, error: 'rules_invalid', message: 'Expected ( in line 3', lines: [{ severity: 'error', text: 'x' }] });
    for (const bad of [null, enc('{'), enc([]), enc({ code: 0, error: '', message: '' }), enc({ code: 0, error: 'other', message: '', lines: [] }), enc({ code: 0.5, error: '', message: '', lines: [] }), enc({ code: 0, error: '', message: 3, lines: [] }), enc({ code: 0, error: '', message: '', lines: [{ severity: 'loud', text: '' }] })]) {
      expect(readBoardCheckDone(bad)).toBeNull();
    }
  });
});

describe('drc.json', () => {
  it('reads every list, keeps excluded findings flagged, and recounts errors, warnings and excluded over all three', () => {
    const r = readDrcReport(enc(report({ errors: 99, warnings: 99, excludedCount: 99 })));
    expect(r).not.toBeNull();
    expect(r!.violations.map((f) => f.marker)).toEqual([MARK(1), MARK(2), MARK(3)]);
    expect(r!.violations[2]).toMatchObject({ excluded: true, comment: 'on purpose' });
    expect(r!.unconnected[0].type).toBe('unconnected_items');
    expect(r!.parity[0].items[0]).toMatchObject({ kind: 'footprint', ref: 'R1' });
    // Not excluded: the clearance and the unconnected pair are errors, the overlap and the extra footprint warnings.
    expect([r!.errors, r!.warnings, r!.excludedCount]).toEqual([2, 2, 1]);
    expect(r).toMatchObject({ parityRun: 'yes', filled: true, skipped: [], ignored: ['silk_edge_clearance'], depth: 3 });
    expect('truncated' in r!).toBe(false);
    expect(r!.violations[0]).toEqual(finding());
  });

  it('keeps an unknown rule key for the page\'s catch-all sentence, but only in KiCad\'s spelling', () => {
    expect(readDrcReport(enc(report({ violations: [finding({ type: 'some_future_rule' })] })))?.violations[0].type).toBe('some_future_rule');
    expect(readDrcReport(enc(report({ violations: [finding({ type: 'Not A Key' })] })))).toBeNull();
  });

  it('refuses any other shape: a key added or missing, a wrong type, an out of range value', () => {
    const bad: Array<Record<string, unknown>> = [
      { extra: 1 },
      { parityRun: 'maybe' }, { filled: 'yes' }, { depth: -1 }, { depth: 1.5 }, { errors: -1 },
      { skipped: Array.from({ length: 9 }, () => 'lib_footprint_issues') }, { skipped: ['Bad Key'] },
      { ignored: Array.from({ length: 129 }, () => 'clearance') },
      { violations: [finding({ severity: 'info' })] },
      { violations: [finding({ excluded: 'no' })] },
      { violations: [finding({ marker: 'not-a-uuid' })] },
      { violations: [finding({ marker: MARK(1).toUpperCase() })] },
      { violations: [finding({ x: Number.NaN })] },
      { violations: [finding({ x: 'far' })] },
      { violations: [finding({ layer: 'F Cu with spaces' })] },
      { violations: [finding({ rule: { source: 'magic', name: 'x' } })] },
      { violations: [finding({ rule: { source: 'custom' } })] },
      { violations: [finding({ actual: 'thin' })] },
      { violations: [finding({ items: [{ ...pad, kind: 'blob' }] })] },
      { violations: [finding({ items: [{ ...pad, parent: 'nope' }] })] },
      { violations: [finding({ items: [{ ...pad, net: 'n'.repeat(513) }] })] },
      { violations: [finding({ items: [{ ...pad, extra: 1 }] })] },
      { violations: [finding({ items: 'none' })] },
      { unconnected: [finding({ type: 'clearance' })] },
    ];
    for (const o of bad) expect(readDrcReport(enc(report(o))), JSON.stringify(o).slice(0, 80)).toBeNull();
    const missing = report() as Record<string, unknown>;
    delete missing.parity;
    expect(readDrcReport(enc(missing))).toBeNull();
    const noMessage = finding() as Record<string, unknown>;
    delete noMessage.message;
    expect(readDrcReport(enc(report({ violations: [noMessage] })))).toBeNull();
    expect(readDrcReport(null)).toBeNull();
    expect(readDrcReport(enc('{'))).toBeNull();
  });

  it('cuts KiCad\'s own words (descriptions, messages, comments) at 1,024 characters and a finding\'s items at 64', () => {
    const r = readDrcReport(enc(report({ violations: [finding({ message: 'm'.repeat(2000), comment: 'c'.repeat(2000), items: Array.from({ length: 70 }, () => ({ ...pad, description: 'd'.repeat(1500) })) })] })));
    expect(r!.violations[0].message).toHaveLength(1024);
    expect(r!.violations[0].comment).toHaveLength(1024);
    expect(r!.violations[0].items).toHaveLength(MAX_FINDING_ITEMS);
    expect(r!.violations[0].items[0].description).toHaveLength(1024);
  });

  it('lists at most 4,096 findings over the three lists in their order; past that the counts still total and truncated is set', () => {
    const many = Array.from({ length: MAX_FINDINGS - 1 }, (_, i) => finding({ marker: MARK(100 + i), excluded: false }));
    const r = readDrcReport(enc(report({ violations: many, unconnected: [finding({ marker: MARK(9000), type: 'unconnected_items' })], parity: [finding({ marker: MARK(9001), type: 'missing_footprint', severity: 'warning' }), finding({ marker: MARK(9002), type: 'net_conflict', severity: 'warning', excluded: true })] })));
    expect(r!.violations).toHaveLength(MAX_FINDINGS - 1);
    expect(r!.unconnected).toHaveLength(1);
    expect(r!.parity).toEqual([]);
    expect(r!.truncated).toBe(true);
    expect([r!.errors, r!.warnings, r!.excludedCount]).toEqual([MAX_FINDINGS, 1, 1]);
  });
});

describe('board.explain', () => {
  it('takes exactly one lower case marker uuid', () => {
    expect(parseExplainArgs({ marker: MARK(1) })).toEqual({ marker: MARK(1) });
    for (const bad of [undefined, {}, { marker: MARK(1).toUpperCase() }, { marker: 'x' }, { marker: MARK(1), extra: 1 }]) expect(parseExplainArgs(bad)).toBeNull();
  });

  it('names the sixteen rule keys KiCad itself explains, each to its constraint', () => {
    expect(Object.keys(EXPLAINED_TYPES)).toHaveLength(16);
    expect(EXPLAINED_TYPES).toMatchObject({ clearance: 'clearance', copper_edge_clearance: 'edge_clearance', drill_out_of_range: 'hole_size', microvia_drill_out_of_range: 'hole_size', diff_pair_uncoupled_length_too_long: 'max_uncoupled', assertion_failure: 'assertion' });
  });

  const explained = (o: Record<string, unknown> = {}) => JSON.stringify({
    constraint: 'clearance', unit: 'mm', min: 0.25, opt: null, max: null, source: 'custom', name: 'Tight',
    condition: "A.NetClass == 'Power'", layer: 'F.Cu', items: [{ uuid: R1_PAD, netclass: 'Power' }, { uuid: TRACK, netclass: 'Default' }], ...o,
  });

  it('reads the engine\'s answer closed: a rule, no rule, or the rules not compiling', () => {
    expect(readExplain(explained())).toEqual({ rule: JSON.parse(explained()) });
    expect(readExplain(explained({ constraint: 'track_angle', unit: 'deg', min: null, max: 45, source: 'board', name: '', condition: '' }))).toMatchObject({ rule: { unit: 'deg', max: 45 } });
    expect(readExplain('{"constraint":"none"}')).toEqual({ none: true });
    expect(readExplain('{"constraint":"none","error":"rules_invalid"}')).toEqual({ none: true, rulesInvalid: true });
    for (const bad of ['', '{', '[]', '{"constraint":"none","error":"other"}', '{"constraint":"none","x":1}',
      explained({ constraint: 'width' }), explained({ unit: 'in' }), explained({ min: 'x' }), explained({ opt: true }), explained({ source: 'magic' }),
      explained({ unit: 'deg' }), explained({ constraint: 'track_angle', unit: 'mm' }),
      explained({ condition: 'c'.repeat(2049) }), explained({ name: 'n'.repeat(1025) }), explained({ items: [{ uuid: R1_PAD, netclass: 'a' }, { uuid: TRACK, netclass: 'b' }, { uuid: R1, netclass: 'c' }] }),
      explained({ items: [{ uuid: 'x', netclass: 'a' }] }), explained({ extra: 1 })]) {
      expect(readExplain(bad), bad.slice(0, 60)).toBeNull();
    }
    expect(readExplain(42)).toBeNull();
  });
});
