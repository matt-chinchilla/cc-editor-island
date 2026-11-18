// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The pencil generator's seam for the wave units' rows (theme/pencil/<unit>.json):
// none today, so the table and the ledger stand byte for byte; a unit's rows go
// after the built ins, keyed as the built ins are, and a row pressed by name takes no chord.
import { describe, expect, it } from 'vitest';
import { generate, readUnitRows, type GenInputs } from './pencil-tools.gen.mjs';
import defaultsJson from './pencil-tools.defaults.json?raw';
import sch from './toolbars/eeschema-toolbars.json?raw';
import pcb from './toolbars/pcbnew-toolbars.json?raw';
import ledger from './user.hotkeys?raw';
import table from './pencil-tools.json?raw';

const inputs = (unitRows: GenInputs['unitRows'] = []): GenInputs => ({ defaultsJson, layouts: { sch, pcb }, ledger, unitRows });

describe('the wave units\' pencil rows', () => {
  it('with the rows written so far, the table and the ledger are as they stand', () => {
    const out = generate(inputs(readUnitRows()));
    expect(out.table).toBe(table);
    expect(out.hotkeys).toBe(ledger);
  });

  it('go after the built ins in unit order, keyed from the pool, or pressed by name with no chord', () => {
    const base = generate(inputs());
    const out = generate(inputs([
      { unit: 'z-i', rows: [{ editor: 'pcb', strip: 'right', action: 'pcbnew.Z.one', defaultKey: 'Shift+F9' }] },
      { unit: 'a-i', rows: [{ editor: 'sch', strip: 'left', action: 'eeschema.A.run', press: 'run' }, { editor: 'sch', strip: 'left', action: 'eeschema.A.key' }] },
    ]));
    const tail = out.rows.slice(base.rows.length);
    // (The pool holds one free chord today: ST-PRESS widens it before it hands out more.)
    expect(tail.map((r) => [r.action, r.defaultKey, r.seededKey])).toEqual([['eeschema.A.run', null, ''], ['eeschema.A.key', null, out.added[0].split('\t')[1]], ['pcbnew.Z.one', 'Shift+F9', null]]);
    expect(out.added).toHaveLength(1);
    expect(out.hotkeys.startsWith(ledger)).toBe(true);
    expect(() => generate(inputs([{ unit: 'd-i', rows: [{ editor: 'sch', strip: 'right', action: base.rows[0].action }] }]))).toThrow(/already/);
  });
});
