// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { describe, expect, it } from 'vitest';
import {
  boardUpdateJson, MAX_UPDATE_CHANGES, parseBoardPreviewArgs, parseBoardUpdateArgs, previewAnswer, readBoardReport,
  readBoardUpdateDone, schematicBeside, updateAnswer,
} from './boardUpdate';

const enc = (s: unknown) => new TextEncoder().encode(typeof s === 'string' ? s : JSON.stringify(s));
const ROOT = '/home/web_user/projects/cc';
const toRel = (abs: string): string | null => (abs.startsWith(`${ROOT}/`) ? abs.slice(ROOT.length + 1) : null);
const OPTS = { replaceFootprints: true, deleteExtra: false, relinkByReference: false };

/** One record of each kind, exactly its keys (the Update spec's 6.4). */
const CHANGES = [
  { kind: 'add', ref: 'U1', footprint: 'Package_DFN_QFN:DFN-8-1EP_3x2mm_P0.5mm_EP1.36x1.46mm', pins: [{ pin: '1', net: '/SDA', pad: true }, { pin: '9', net: 'GND', pad: false }], extraPads: ['EP'], sameName: false, message: 'Add U1 (footprint ...).' },
  { kind: 'remove', ref: 'R9', footprint: 'Resistor_SMD:R_0603_1608Metric', message: 'Remove unused footprint R9.' },
  { kind: 'footprint', ref: 'R1', from: 'Resistor_SMD:R_0402_1005Metric', to: 'Resistor_SMD:R_0603_1608Metric', message: 'm' },
  { kind: 'reference', ref: 'R2', to: 'R3', message: 'm' },
  { kind: 'value', ref: 'R1', from: '10k', to: '4k7', message: 'm' },
  { kind: 'detail', ref: 'R1', topic: 'attribute', name: 'dnp', from: '', to: 'on', message: 'm' },
  { kind: 'connect', ref: 'U1', pin: '1', to: '/SDA', message: 'm' },
  { kind: 'reconnect', ref: 'U1', pin: '2', from: '/SCL', to: '/SDA', message: 'm' },
  { kind: 'disconnect', ref: 'U1', pin: '3', from: '/INT', message: 'm' },
  { kind: 'net', net: '/SDA', message: 'm' },
  { kind: 'unusedNet', net: '/OLD', message: 'm' },
  { kind: 'copper', item: 'zone', name: 'GND pour', from: 'GND', to: 'GNDA', message: 'm' },
  { kind: 'problem', code: 'pin_without_pad', severity: 'warning', ref: 'U1', pin: '9', footprint: 'x:y', net: 'GND', name: '', message: 'm' },
];
const report = (o: Record<string, unknown> = {}) => ({
  run: 3, ok: true, token: 'a'.repeat(64), blocked: '', sheets: [`${ROOT}/card.kicad_sch`, `${ROOT}/sub/io.kicad_sch`],
  changes: CHANGES, added: [], warnings: 1, errors: 0, truncated: false, unmapped: 0, ...o,
});

describe('board.preview and board.update args', () => {
  it('a preview takes exactly the three options, each a boolean', () => {
    expect(parseBoardPreviewArgs(OPTS)).toEqual(OPTS);
    for (const bad of [undefined, {}, { ...OPTS, token: 'x' }, { ...OPTS, deleteExtra: 1 }, { replaceFootprints: true, deleteExtra: false }]) expect(parseBoardPreviewArgs(bad)).toBeNull();
  });

  it('an update takes the three options and a token of 1 to 128 characters', () => {
    expect(parseBoardUpdateArgs({ ...OPTS, token: 'abc' })).toEqual({ ...OPTS, token: 'abc' });
    expect(parseBoardUpdateArgs({ ...OPTS, token: 't'.repeat(128) })).not.toBeNull();
    for (const bad of [OPTS, { ...OPTS, token: '' }, { ...OPTS, token: 't'.repeat(129) }, { ...OPTS, token: 3 }, { ...OPTS, token: 'x', extra: 1 }]) expect(parseBoardUpdateArgs(bad)).toBeNull();
  });

  it('hands the engine the seven keys, the token empty on a preview', () => {
    expect(JSON.parse(boardUpdateJson(2, '/tmp/cc-update/2', OPTS, null))).toEqual({ run: 2, dir: '/tmp/cc-update/2', apply: false, ...OPTS, token: '' });
    expect(JSON.parse(boardUpdateJson(5, '/tmp/cc-update/5', OPTS, 'tok'))).toEqual({ run: 5, dir: '/tmp/cc-update/5', apply: true, ...OPTS, token: 'tok' });
  });

  it('names the schematic beside the opened board: the same folder, the board\'s stem', () => {
    expect(schematicBeside('card.kicad_pcb')).toBe('card.kicad_sch');
    expect(schematicBeside('boards/glasgow.kicad_pcb')).toBe('boards/glasgow.kicad_sch');
    expect(schematicBeside('My Board.KICAD_PCB')).toBe('My Board.kicad_sch');
  });
});

describe('.cc-update.json', () => {
  it('reads the error, the message and the lines closed', () => {
    expect(readBoardUpdateDone(enc({ error: '', message: '', lines: [] }))).toEqual({ error: '', message: '', lines: [] });
    for (const e of ['schematic_unreadable', 'stale', 'not_annotated', 'island_error']) expect(readBoardUpdateDone(enc({ error: e, message: 'x', lines: [] }))?.error).toBe(e);
    for (const bad of [null, enc('{'), enc({ error: 'other', message: '', lines: [] }), enc({ error: '', message: '' }), enc({ error: '', message: '', lines: [], x: 1 })]) expect(readBoardUpdateDone(bad)).toBeNull();
  });
});

describe('report.json', () => {
  it('reads every kind with exactly its keys, and the sheets as project paths', () => {
    const r = readBoardReport(enc(report()), 3, toRel);
    expect(r?.changes).toEqual(CHANGES);
    expect(r?.sheets).toEqual(['card.kicad_sch', 'sub/io.kicad_sch']);
    expect(previewAnswer(r!)).toEqual({ token: 'a'.repeat(64), blocked: '', sheets: ['card.kicad_sch', 'sub/io.kicad_sch'], changes: CHANGES, warnings: 1, errors: 0, truncated: false, unmapped: 0 });
    expect(updateAnswer(readBoardReport(enc(report({ added: ['U1'] })), 3, toRel)!)).toEqual({ changes: CHANGES, added: ['U1'], warnings: 1, errors: 0, truncated: false, unmapped: 0 });
  });

  it('refuses another run\'s report, a sheet outside the project folder, and any record of another shape', () => {
    expect(readBoardReport(enc(report()), 4, toRel)).toBeNull();
    expect(readBoardReport(enc(report({ sheets: ['/tmp/elsewhere.kicad_sch'] })), 3, toRel)).toBeNull();
    const bad: Array<Record<string, unknown>> = [
      { blocked: 'maybe' }, { ok: 'yes' }, { token: 't'.repeat(129) }, { unmapped: -1 }, { warnings: 1.5 }, { truncated: 'no' }, { extra: 1 }, { added: [3] },
      { changes: [{ ...CHANGES[0], kind: 'move' }] },
      { changes: [{ ...CHANGES[0], extra: 1 }] },
      { changes: [{ ...CHANGES[0], pins: [{ pin: '1', net: 'x' }] }] },
      { changes: [{ ...CHANGES[5], topic: 'colour' }] },
      { changes: [{ ...CHANGES[11], item: 'track' }] },
      { changes: [{ ...CHANGES[12], code: 'odd' }] },
      { changes: [{ ...CHANGES[12], severity: 'info' }] },
      { changes: [{ ...CHANGES[2], ref: 'r'.repeat(1025) }] },
    ];
    for (const o of bad) expect(readBoardReport(enc(report(o)), 3, toRel), JSON.stringify(o).slice(0, 80)).toBeNull();
    expect(readBoardReport(null, 3, toRel)).toBeNull();
  });

  it('cuts KiCad\'s own sentence at 1,024 characters, and lists at most 4,096 records with truncated set and the counts kept', () => {
    const long = readBoardReport(enc(report({ changes: [{ ...CHANGES[1], message: 'm'.repeat(5000) }] })), 3, toRel);
    expect((long!.changes[0] as { message: string }).message).toHaveLength(1024);
    const many = Array.from({ length: MAX_UPDATE_CHANGES + 3 }, (_, i) => ({ kind: 'net', net: `n${i}`, message: '' }));
    const r = readBoardReport(enc(report({ changes: many, warnings: 7 })), 3, toRel);
    expect(r!.changes).toHaveLength(MAX_UPDATE_CHANGES);
    expect(r!.truncated).toBe(true);
    expect(r!.warnings).toBe(7);
  });
});
