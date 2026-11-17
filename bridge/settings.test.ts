// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { describe, expect, it } from 'vitest';
import { readBoardFootprints } from './footprints';
import {
  parseSettingsGetArgs, parseSettingsSetArgs, PCB_SECTIONS, readSection, readSettingsRecord, rulesPathOf, SCH_SECTIONS, sectionFrames, settingsSetJson,
} from './settings';

const U = 'aaaaaaaa-0000-4000-8000-000000000001';
const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

describe('settings sections and args', () => {
  it('names each section\'s frames as the engine holds them', () => {
    expect(sectionFrames('netClasses')).toEqual(['sch', 'pcb']);
    expect(sectionFrames('pinMap')).toEqual(['sch']);
    expect(sectionFrames('customRules')).toEqual(['pcb']);
    expect(sectionFrames('variants')).toEqual(['sch', 'pcb']);
    expect(sectionFrames('nothing')).toEqual([]);
    expect(SCH_SECTIONS).toHaveLength(9);
    expect(PCB_SECTIONS).toHaveLength(13);
    expect(parseSettingsGetArgs({ section: 'stackup' })).toEqual({ section: 'stackup' });
    for (const a of [undefined, {}, { section: 'x' }, { section: 'page', extra: 1 }]) expect(parseSettingsGetArgs(a)).toBeNull();
  });

  it('takes a patch, a variant action, the custom rules, the bus aliases and text variables', () => {
    const cases = [
      { section: 'netClasses', value: { classes: [{ name: 'Power', clearance: 0.2 }] } },
      { section: 'constraints', value: { rules: { min_clearance: 0.15 } }, dryRun: false },
      { section: 'variants', value: { add: 'Lite' } },
      { section: 'variants', value: { copy: ['Lite', 'Pro'] } },
      { section: 'variants', value: { describe: ['Lite', 'R2 not fitted'] } },
      { section: 'variants', value: { current: '' } },
      { section: 'customRules', value: { text: '(version 1)' }, dryRun: true },
      { section: 'customRules', value: { text: '' } },
      { section: 'busAliases', value: { aliases: [{ name: 'DATA', members: ['D0', 'D1'] }] } },
      { section: 'textVariables', value: { REV: 'B', OLD: null } },
      { section: 'page', value: { paper: 'A4', comments: [null, 'two'] } },
      { section: 'layers', value: { copperCount: 4 }, dryRun: true },
    ];
    for (const c of cases) expect(parseSettingsSetArgs(c), c.section).toEqual(c);
    expect(JSON.parse(settingsSetJson(5, '/tmp/cc-settings/5', cases[0]))).toEqual({ run: 5, dir: '/tmp/cc-settings/5', ...cases[0] });
    expect(JSON.parse(settingsSetJson(5, '/tmp/cc-settings/5', cases[6]))).toEqual({ run: 5, dir: '/tmp/cc-settings/5', ...cases[6] });
  });

  it('refuses each other shape', () => {
    for (const a of [undefined, {}, { section: 'netClasses' }, { section: 'nothing', value: { a: 1 } }, { section: 'netClasses', value: {} },
      { section: 'netClasses', value: { classes: null } }, { section: 'netClasses', value: { a: 1 }, dryRun: 'yes' }, { section: 'netClasses', value: { a: 1 }, extra: 1 },
      { section: 'netClasses', value: [1] }, { section: 'constraints', value: { rules: { x: Infinity } } },
      { section: 'variants', value: { add: 'A', delete: 'B' } }, { section: 'variants', value: { add: '' } }, { section: 'variants', value: { rename: ['A', 'A'] } },
      { section: 'variants', value: { remove: 'A' } }, { section: 'customRules', value: { text: 1 } }, { section: 'customRules', value: { text: 'x'.repeat(256 * 1024 + 1) } },
      { section: 'busAliases', value: { DATA: ['D0'] } }, { section: 'textVariables', value: { 'A\nB': 'x' } },
      { section: 'netClasses', value: { big: 'x'.repeat((1 << 20) + 1) } }]) {
      expect(parseSettingsSetArgs(a), JSON.stringify(a)?.slice(0, 120)).toBeNull();
    }
  });
});

describe('the engine\'s sections and records', () => {
  it('reads a section as a plain object', () => {
    expect(readSection(JSON.stringify({ classes: [], netclass_patterns: [] }))).toEqual({ classes: [], netclass_patterns: [] });
    for (const bad of ['', '[]', '1', 'x', undefined]) expect(readSection(bad)).toBeNull();
  });

  it('reads a set\'s record closed', () => {
    expect(readSettingsRecord(enc({ value: { text: '' } }))).toEqual({ value: { text: '' } });
    expect(readSettingsRecord(enc({ value: {}, errors: [{ line: 4, column: 2, message: 'unknown keyword clearanse' }] }))?.errors).toHaveLength(1);
    expect(readSettingsRecord(enc({ value: {}, wouldRemove: 12 }))?.wouldRemove).toBe(12);
    for (const bad of [{}, { value: [] }, { value: {}, x: 1 }, { value: {}, errors: [] }, { value: {}, errors: [{ line: 1 }] }, { value: {}, wouldRemove: -1 }]) {
      expect(readSettingsRecord(enc(bad)), JSON.stringify(bad)).toBeNull();
    }
  });

  it('names the custom rules file beside the board', () => {
    expect(rulesPathOf('glasgow.kicad_pcb')).toBe('glasgow.kicad_dru');
    expect(rulesPathOf('hw/board.kicad_pcb')).toBe('hw/board.kicad_dru');
    expect(rulesPathOf('card.kicad_sch')).toBeNull();
  });
});

describe('board.footprints', () => {
  const fp = { uuid: U, ref: 'R1', value: '10k', libId: 'Resistor_SMD:R_0603_1608Metric', symbolPath: `/${U}`, side: 'front', locked: false, dnp: false, inBom: true, inPos: true, boardOnly: false, fields: [{ name: 'MPN', value: 'X', shown: false }] };
  const answer = (o: Record<string, unknown> = {}) => JSON.stringify({ footprints: [fp], variant: '', truncated: false, ...o });

  it('reads every footprint closed', () => {
    expect(readBoardFootprints(answer())).toEqual(JSON.parse(answer()));
    expect(readBoardFootprints(answer({ footprints: [{ ...fp, symbolPath: '', side: 'back' }], variant: 'Lite' }))?.footprints[0].side).toBe('back');
  });

  it('refuses each other shape', () => {
    for (const bad of ['', answer({ x: 1 }), answer({ footprints: [fp, fp] }), answer({ footprints: [{ ...fp, side: 'top' }] }), answer({ footprints: [{ ...fp, symbolPath: 'x' }] }),
      answer({ footprints: [{ ...fp, dnp: 0 }] }), answer({ footprints: [{ ...fp, extra: 1 }] }), answer({ truncated: 'no' })]) {
      expect(readBoardFootprints(bad), bad.slice(0, 100)).toBeNull();
    }
  });
});
