// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { describe, expect, it } from 'vitest';
import { MAX_RULES, parseRulesArgs, readRules, rulesJson, type RuleRecord } from './rules';

const A = 'bbbbbbbb-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const rec = (o: Record<string, unknown> = {}): RuleRecord => ({
  constraint: 'clearance', unit: 'mm', min: 0.2, opt: null, max: null, verdict: '', source: 'netclass', name: 'Default',
  condition: '', layer: 'F.Cu', items: [{ uuid: A, netclass: 'Default' }, { uuid: B, netclass: 'Default' }], ...o,
} as RuleRecord);
const answer = (rules: unknown[], o: Record<string, unknown> = {}) => JSON.stringify({ rules, notes: [], error: '', ...o });

describe('board.rules args', () => {
  it('takes one item, or two that differ, in KiCad\'s lower case spelling', () => {
    expect(parseRulesArgs({ a: A })).toEqual({ a: A });
    expect(parseRulesArgs({ b: B, a: A })).toEqual({ a: A, b: B });
    expect(JSON.parse(rulesJson({ a: A }))).toEqual({ a: A, b: '' });
    expect(JSON.parse(rulesJson({ a: A, b: B }))).toEqual({ a: A, b: B });
  });

  it('refuses each other shape', () => {
    for (const args of [undefined, null, [], A, {}, { b: B }, { a: A.toUpperCase() }, { a: A, b: A }, { a: A, b: '' }, { a: A, b: null }, { a: A, c: B }, { a: `${A} ` }]) {
      expect(parseRulesArgs(args), JSON.stringify(args)).toBeNull();
    }
  });
});

describe('the engine\'s answer', () => {
  it('reads every constraint with its unit and verdicts, the notes, and the engine\'s errors', () => {
    const records = [
      rec(),
      rec({ constraint: 'clearance', min: 0, source: 'sameNet', name: '' }),
      rec({ constraint: 'track_angle', unit: 'deg', min: 45 }),
      rec({ constraint: 'solder_paste_rel_margin', unit: 'percent', min: -5, layer: '' }),
      rec({ constraint: 'min_resolved_spokes', unit: 'count', min: 2 }),
      rec({ constraint: 'zone_connection', unit: 'none', min: null, verdict: 'thermal' }),
      rec({ constraint: 'disallow', unit: 'none', min: null, verdict: 'allowed', items: [{ uuid: A, netclass: '' }] }),
      rec({ constraint: 'assertion', unit: 'none', min: null, verdict: 'fail', source: 'custom', name: 'r1', condition: "A.Type == 'Pad'" }),
    ];
    expect(readRules(answer(records, { notes: ['Report may be incomplete.'] }))).toEqual({ rules: records, notes: ['Report may be incomplete.'] });
    expect(readRules(answer([]))).toEqual({ rules: [], notes: [] });
    expect(readRules(answer([], { error: 'not_found' }))).toEqual({ error: 'not_found' });
    expect(readRules(answer([], { error: 'rules_invalid' }))).toEqual({ error: 'rules_invalid' });
    expect(readRules(answer(Array.from({ length: MAX_RULES }, () => rec())))).not.toBeNull();
  });

  it('refuses every other shape', () => {
    for (const bad of [
      '', 'not json', '[]', undefined, 7,
      JSON.stringify({ rules: [], notes: [] }),
      answer([], { extra: 1 }),
      answer([], { error: 'nope' }),
      answer([rec()], { error: 'not_found' }),
      answer([], { notes: [1] }),
      answer([], { notes: Array.from({ length: 33 }, () => 'n') }),
      answer(Array.from({ length: MAX_RULES + 1 }, () => rec())),
      answer([{ ...rec(), extra: 1 }]),
      answer([rec({ constraint: 'thing' })]),
      answer([rec({ unit: 'deg' })]),
      answer([rec({ constraint: 'track_angle' })]),
      answer([rec({ constraint: 'zone_connection', unit: 'none', min: 0.1, verdict: 'solid' })]),
      answer([rec({ verdict: 'pass' })]),
      answer([rec({ constraint: 'disallow', unit: 'none', min: null, verdict: '' })]),
      answer([rec({ constraint: 'assertion', unit: 'none', min: null, verdict: 'solid' })]),
      answer([rec({ min: '0.2' })]),
      answer([rec({ min: true })]),
      answer([rec({ source: 'mine' })]),
      answer([rec({ condition: 'x'.repeat(2049) })]),
      answer([rec({ layer: 'F Cu' })]),
      answer([rec({ items: [] })]),
      answer([rec({ items: [{ uuid: A, netclass: '' }, { uuid: B, netclass: '' }, { uuid: A, netclass: '' }] })]),
      answer([rec({ items: [{ uuid: 'x', netclass: '' }] })]),
      answer([rec({ items: [{ uuid: A }] })]),
    ]) expect(readRules(bad), String(bad)).toBeNull();
  });
});
