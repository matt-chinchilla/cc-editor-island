// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { describe, expect, it } from 'vitest';
import { MAX_ITEMS, MAX_VIOLATIONS, readCheckDone, readCheckReport, sheetPathOf } from './check';

const enc = (s: unknown) => new TextEncoder().encode(typeof s === 'string' ? s : JSON.stringify(s));
const ROOT = '8f38e89c-17d2-45bd-b2a9-83bd9bb08903';
const BANKS = '00000000-0000-0000-0000-00005c7b59b0';
const BUF_A = '00000000-0000-0000-0000-00005c9e337e';

/**
 * A report in the shape engine run 10's kicadCheckSheet writes on Glasgow
 * (ERC_REPORT::WriteJsonReport, 2026-11-07): the root sheet and one reused
 * sheet's instance, KiCad 10's own item descriptions, positions in its scale.
 */
const REPORT = {
  $schema: 'https://schemas.kicad.org/erc.v1.json',
  coordinate_units: 'mm',
  date: '2026-11-07T01:00:00-0500',
  ignored_checks: [{ key: 'simulation_model_issue', description: 'SPICE model issue' }],
  included_severities: ['error', 'warning'],
  kicad_version: '10.0.4',
  source: 'glasgow.kicad_sch',
  sheets: [
    {
      path: '/', uuid_path: `/${ROOT}`,
      violations: [
        { description: 'Pins of type Power output and Power output are connected', severity: 'error', type: 'pin_to_pin', items: [
          { description: 'Symbol #FLG0102 Pin 1 [pwr, Power output, Line]', pos: { x: 0.2667, y: 0.889 }, uuid: 'f9cbb641-810c-4283-9cda-f6c4dce4a1e2' },
          { description: 'Symbol #FLG0110 Pin 1 [pwr, Power output, Line]', pos: { x: 0.1905, y: 0.9779 }, uuid: '4314840e-c450-49fc-823b-905f52c2dffc' },
        ] },
        { description: 'Label not connected to anything', severity: 'warning', type: 'label_dangling', items: [
          { description: "Label 'CC_PROBE_L'", pos: { x: 1, y: 1 }, uuid: 'b44c4e1c-973e-45b6-bdc4-13df63bb07f3' },
        ] },
        { description: 'Excluded by the reader', severity: 'warning', type: 'wire_dangling', excluded: true, comment: 'fine', items: [] },
      ],
    },
    {
      path: '/IO_Banks/IO_Buffer_A/', uuid_path: `/${ROOT}/${BANKS}/${BUF_A}`,
      violations: [
        { description: 'Pin not connected', severity: 'error', type: 'pin_not_connected', items: [
          { description: 'Symbol U1 Pin 5 [XTALIN, Input, Line]', pos: { x: 0.1, y: 0.2 }, uuid: 'c9054f05-06f5-43bd-826d-6eb0fa5bcb73' },
        ] },
      ],
    },
  ],
};

describe('the run\'s record', () => {
  it('reads { code, lines } and nothing else', () => {
    expect(readCheckDone(enc({ code: 0, lines: [{ severity: 'info', text: 'Found 532 violations' }] }))).toEqual({ code: 0, lines: [{ severity: 'info', text: 'Found 532 violations' }] });
    for (const bad of [null, enc('{'), enc({ code: 0 }), enc({ code: 0.5, lines: [] }), enc({ code: '0', lines: [] }), enc({ code: 0, lines: [{ severity: 'x', text: '' }] })]) {
      expect(readCheckDone(bad)).toBeNull();
    }
  });
});

describe('sheet paths', () => {
  it('turns KiCad\'s uuid_path into project.open\'s form: the root\'s uuid dropped, a slash after every level', () => {
    expect(sheetPathOf(`/${ROOT}`)).toBe('/');
    expect(sheetPathOf(`/${ROOT}/`)).toBe('/');
    expect(sheetPathOf(`/${ROOT}/${BANKS}`)).toBe(`/${BANKS}/`);
    expect(sheetPathOf(`/${ROOT}/${BANKS}/${BUF_A}`)).toBe(`/${BANKS}/${BUF_A}/`);
    for (const bad of ['', '/', ROOT, `/${ROOT.toUpperCase()}`, `/${ROOT}//${BANKS}`, `/${ROOT}/IO_Banks`]) expect(sheetPathOf(bad)).toBeNull();
  });
});

describe('the report', () => {
  it('reads KiCad\'s report into sheets and findings: excluded ones left out, positions left out, counts by severity', () => {
    expect(readCheckReport(enc(REPORT))).toEqual({
      sheets: [
        { path: '/', name: '/', violations: [
          { type: 'pin_to_pin', severity: 'error', items: [
            { uuid: 'f9cbb641-810c-4283-9cda-f6c4dce4a1e2', description: 'Symbol #FLG0102 Pin 1 [pwr, Power output, Line]' },
            { uuid: '4314840e-c450-49fc-823b-905f52c2dffc', description: 'Symbol #FLG0110 Pin 1 [pwr, Power output, Line]' },
          ] },
          { type: 'label_dangling', severity: 'warning', items: [{ uuid: 'b44c4e1c-973e-45b6-bdc4-13df63bb07f3', description: "Label 'CC_PROBE_L'" }] },
        ] },
        { path: `/${BANKS}/${BUF_A}/`, name: '/IO_Banks/IO_Buffer_A/', violations: [
          { type: 'pin_not_connected', severity: 'error', items: [{ uuid: 'c9054f05-06f5-43bd-826d-6eb0fa5bcb73', description: 'Symbol U1 Pin 5 [XTALIN, Input, Line]' }] },
        ] },
      ],
      errors: 2,
      warnings: 1,
    });
  });

  it('lists at most MAX_VIOLATIONS findings, counting the rest, with truncated; at most MAX_ITEMS items a finding', () => {
    const item = { description: 'Symbol R1 Pin 1 [Passive, Line]', pos: { x: 0, y: 0 }, uuid: 'c9054f05-06f5-43bd-826d-6eb0fa5bcb73' };
    const one = { description: 'x', severity: 'warning', type: 'pin_not_connected', items: [item] };
    const big = { ...REPORT, sheets: [{ path: '/', uuid_path: `/${ROOT}`, violations: [...Array.from({ length: MAX_VIOLATIONS + 3 }, () => one), { ...one, severity: 'error', items: Array.from({ length: 70 }, () => item) }] }] };
    const r = readCheckReport(enc(big))!;
    expect(r.sheets[0].violations).toHaveLength(MAX_VIOLATIONS);
    expect(r.warnings).toBe(MAX_VIOLATIONS + 3);
    expect(r.errors).toBe(1);
    expect(r.truncated).toBe(true);
    const items = readCheckReport(enc({ ...REPORT, sheets: [{ path: '/', uuid_path: `/${ROOT}`, violations: [{ ...one, items: Array.from({ length: 70 }, () => item) }] }] }))!;
    expect(items.sheets[0].violations[0].items).toHaveLength(MAX_ITEMS);
    expect('truncated' in items).toBe(false);
  });

  it('cuts a description to the protocol\'s 1,024 characters', () => {
    const long = { ...REPORT, sheets: [{ path: '/'.padEnd(2000, 'a'), uuid_path: `/${ROOT}`, violations: [{ description: 'x', severity: 'error', type: 'pin_to_pin', items: [{ description: 'd'.repeat(3000), pos: { x: 0, y: 0 }, uuid: 'c9054f05-06f5-43bd-826d-6eb0fa5bcb73' }] }] }] };
    const r = readCheckReport(enc(long))!;
    expect(r.sheets[0].name).toHaveLength(1024);
    expect(r.sheets[0].violations[0].items[0].description).toHaveLength(1024);
  });

  it('refuses a report of any other shape', () => {
    const s = REPORT.sheets[0];
    const v = s.violations[0];
    for (const bad of [
      null, enc('{'), enc([]), enc({ ...REPORT, sheets: {} }),
      enc({ ...REPORT, sheets: [{ ...s, uuid_path: 'root' }] }),
      enc({ ...REPORT, sheets: [{ ...s, path: 1 }] }),
      enc({ ...REPORT, sheets: [{ ...s, violations: {} }] }),
      enc({ ...REPORT, sheets: [{ ...s, violations: [{ ...v, type: 'Pin To Pin' }] }] }),
      enc({ ...REPORT, sheets: [{ ...s, violations: [{ ...v, severity: 1 }] }] }),
      enc({ ...REPORT, sheets: [{ ...s, violations: [{ ...v, excluded: 'yes' }] }] }),
      enc({ ...REPORT, sheets: [{ ...s, violations: [{ ...v, items: [{ description: 'x', uuid: 'U1' }] }] }] }),
      enc({ ...REPORT, sheets: [{ ...s, violations: [{ ...v, items: [{ uuid: v.items[0].uuid }] }] }] }),
    ]) expect(readCheckReport(bad)).toBeNull();
  });
});
