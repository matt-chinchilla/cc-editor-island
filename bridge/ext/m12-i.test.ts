// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// m12-i: the table asks and table.csv. The engine here is this test's own
// module of exports; the real engine is the e2e's
// (tests/e2e/m/m12-tables.spec.ts).
import { describe, expect, it, vi } from 'vitest';
import { heldTaken } from '../held';
import { fail, type Answer, type ExtUnit, type ResponderCtx } from './contract';
import { heldActions, REGISTRY } from './registry';
import unit, { EXPORT_TABLE_CSV, M12_HELD_ROWS, TABLE_CSV_CAP, TABLE_CSV_EXPORTS } from './m12-i';
import { readCsv, readTable, readTableCell, TABLE_CELL_KEYS } from './m12-i/asks';
import { doorOf, doorRow } from './m1-i/doors';
import prompts from './m1x-i';

const T = 'cc0ca4d5-0000-4000-8000-00000000012f';
const C0 = 'cc0ca4d5-0000-4000-8000-000000000130';
const C1 = 'cc0ca4d5-0000-4000-8000-000000000131';

const SCH_TABLE = {
  uuid: T, rows: 2, cols: 2,
  cells: [['Ref', 'Value'], ['R1', null]],
  border: { external: true, header: true, width: 0.15, color: '', style: 'solid' },
  separators: { rows: true, cols: false, width: null, color: '#ff0000ff', style: 'dash' },
  layer: '', locked: false,
};
const PCB_TABLE = { ...SCH_TABLE, border: { ...SCH_TABLE.border, color: '' }, separators: { ...SCH_TABLE.separators, color: '' }, layer: 'F.SilkS', locked: true };
const SCH_CELL = {
  uuids: [C0], text: 'Ref', font: 'KiCad Font', bold: false, italic: false, hAlign: 'left', vAlign: 'center',
  margins: { left: 0.5, right: 0.5, top: 0.5, bottom: 0.5 }, size: 1.27, width: null, height: null, thickness: null, autoThickness: null,
  textColor: '', fill: { mode: 'none', color: '' },
};
const PCB_CELLS = {
  ...SCH_CELL, uuids: [C0, C1], text: null, font: null, hAlign: null, margins: null, size: null, width: 1, height: 1, thickness: 0.15, autoThickness: true,
  textColor: null, fill: null,
};

const RUN15 = (over: Record<string, unknown> = {}) => ({ kicadTableCsv: vi.fn((): unknown => '{"name":"canvas-kinds-table","text":"Ref,Value\\nR1,\\n"}'), ...over });

/** A ctx over a fake engine module; the gates answer as the responder's do for an open, idle document. */
function fakeCtx(frame: 'sch' | 'pcb', mod: Record<string, unknown>, state: Partial<{ busy: boolean; doc: boolean }> = {}) {
  const s = { busy: false, doc: true, ...state };
  const gate = (want: string) => (op: string, exports: readonly string[]) => {
    if (frame !== want) return fail('unsupported', `a ${want} frame`);
    for (const n of exports) if (typeof mod[n] !== 'function') return fail('unsupported', n);
    if (!s.doc) return fail('not_ready', op);
    if (s.busy) return fail('busy', op);
    return { w: {} as never, mod };
  };
  return { frame, mod: () => mod, boardGate: gate('pcb'), schematicGate: gate('sch') } as unknown as ResponderCtx;
}
const csv = (args: unknown, ctx: ResponderCtx): Promise<Answer> => Promise.resolve((unit as ExtUnit).ops!['table.csv'].run(args, ctx));

describe('the unit in the registry', () => {
  it('loads with nothing broken: its op, cap, asks and held row its own', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect(REGISTRY.ops.get('table.csv')?.unit).toBe('m12-i');
    expect(REGISTRY.ops.get('table.csv')?.op.passesCheck).toBe(true);
    expect(REGISTRY.pending.has('table.csv')).toBe(false);
    expect(REGISTRY.capNames.get(TABLE_CSV_CAP)).toBe('m12-i');
    for (const ask of ['table', 'tableCell']) {
      expect(REGISTRY.asks.get(ask)).toBe('m12-i');
      expect(REGISTRY.askReaders.get(ask)?.unit).toBe('m12-i');
    }
  });

  it('holds Export Table to CSV in the sch and pcb frames under tableCsv; our menu ends it in ev.held', () => {
    expect((unit as ExtUnit).held).toEqual([EXPORT_TABLE_CSV]);
    expect(M12_HELD_ROWS).toEqual([{ action: EXPORT_TABLE_CSV, frames: ['sch', 'pcb'], cap: 'tableCsv' }]);
    const union = heldActions();
    for (const f of ['sch', 'pcb'] as const) {
      expect(heldTaken(EXPORT_TABLE_CSV, f, [TABLE_CSV_CAP], union)).toBe(true);
      expect(heldTaken(EXPORT_TABLE_CSV, f, [], union)).toBe(false);
      expect(doorOf(EXPORT_TABLE_CSV, f, [TABLE_CSV_CAP], union)).toBe('held');
      // Without the cap the item has no door here and our menu leaves it out.
      expect(doorOf(EXPORT_TABLE_CSV, f, [], union)).toBeNull();
    }
    expect(heldTaken(EXPORT_TABLE_CSV, 'symedit', [TABLE_CSV_CAP], union)).toBe(false);
    expect(doorRow(EXPORT_TABLE_CSV)?.door).toBe('held');
    // Edit Table opens the table ask through the prompt host.
    expect(doorRow('pcbnew.TableEditor.editTable')?.door).toBe('prompt:table');
  });
});

describe('tableCsv, feature detected', () => {
  it('lists the cap in a sch or pcb frame only with kicadTableCsv', () => {
    const caps = unit.caps!;
    for (const f of ['sch', 'pcb'] as const) expect(caps(RUN15(), f)).toEqual([TABLE_CSV_CAP]);
    for (const f of ['symedit', 'fpedit', 'ds']) expect(caps(RUN15(), f as never)).toEqual([]);
    expect(caps({}, 'sch')).toEqual([]);
    expect(TABLE_CSV_EXPORTS).toEqual(['kicadTableCsv']);
  });

  it('on an engine without the export (run 14) table.csv answers unsupported naming it', async () => {
    for (const f of ['sch', 'pcb'] as const) expect(await csv({ uuid: T }, fakeCtx(f, {}))).toEqual(fail('unsupported', 'kicadTableCsv'));
  });
});

describe('table.csv', () => {
  it('sends exactly { uuid } and answers { name, text } in both frames', async () => {
    for (const f of ['sch', 'pcb'] as const) {
      const mod = RUN15();
      expect(await csv({ uuid: T }, fakeCtx(f, mod))).toEqual({ ok: true, result: { name: 'canvas-kinds-table', text: 'Ref,Value\nR1,\n' } });
      expect(mod.kicadTableCsv).toHaveBeenCalledWith(JSON.stringify({ uuid: T }));
    }
  });

  it('a cell uuid in capitals is sent lowercase', async () => {
    const mod = RUN15();
    await csv({ uuid: C0.toUpperCase() }, fakeCtx('sch', mod));
    expect(mod.kicadTableCsv).toHaveBeenCalledWith(JSON.stringify({ uuid: C0 }));
  });

  it('refuses any other args before the engine', async () => {
    const mod = RUN15();
    for (const args of [undefined, null, {}, { uuid: 7 }, { uuid: 'nope' }, { uuid: T, extra: 1 }, [T]]) {
      expect(await csv(args, fakeCtx('sch', mod))).toEqual(fail('bad_args', 'table.csv'));
    }
    expect(mod.kicadTableCsv).not.toHaveBeenCalled();
  });

  it('a busy or empty frame answers through the gate, and never calls the engine', async () => {
    const mod = RUN15();
    expect(await csv({ uuid: T }, fakeCtx('pcb', mod, { busy: true }))).toEqual(fail('busy', 'table.csv'));
    expect(await csv({ uuid: T }, fakeCtx('sch', mod, { doc: false }))).toEqual(fail('not_ready', 'table.csv'));
    expect(mod.kicadTableCsv).not.toHaveBeenCalled();
  });

  it('"" from the engine is not_found naming the uuid; another shape or a throw is island_error', async () => {
    expect(await csv({ uuid: T }, fakeCtx('sch', RUN15({ kicadTableCsv: () => '' })))).toEqual(fail('not_found', T));
    expect(await csv({ uuid: T }, fakeCtx('sch', RUN15({ kicadTableCsv: () => '{"name":"x"}' })))).toEqual(fail('island_error', 'table.csv: the engine answered another shape'));
    expect(await csv({ uuid: T }, fakeCtx('sch', RUN15({ kicadTableCsv: () => { throw new Error('trap'); } })))).toEqual(fail('island_error', 'table.csv'));
  });

  it('readCsv takes exactly { name, text }', () => {
    expect(readCsv('{"name":"table","text":""}')).toEqual({ name: 'table', text: '' });
    expect(readCsv('')).toBeNull();
    expect(readCsv('not json')).toBeNull();
    expect(readCsv('{"name":"a/b","text":""}')).toBeNull();
    expect(readCsv('{"name":"a","text":"","more":1}')).toBeNull();
    expect(readCsv({ name: 'a', text: '' })).toBeNull();
  });
});

describe('the table ask', () => {
  it('reads the schematic and the board records closed', () => {
    expect(readTable(SCH_TABLE)).toEqual(SCH_TABLE);
    expect(readTable(PCB_TABLE)).toEqual(PCB_TABLE);
    // A copy, never the engine's own object.
    const r = readTable(SCH_TABLE)!;
    expect(r.cells).not.toBe(SCH_TABLE.cells);
  });

  it('refuses another shape', () => {
    const bad: unknown[] = [
      null, [], {},
      { ...SCH_TABLE, extra: 1 },
      { ...SCH_TABLE, uuid: 'x' },
      { ...SCH_TABLE, rows: 0 }, { ...SCH_TABLE, cols: 1.5 },
      { ...SCH_TABLE, cells: [['a', 'b']] },
      { ...SCH_TABLE, cells: [['a', 'b'], ['c']] },
      { ...SCH_TABLE, cells: [['a', 'b'], ['c', 4]] },
      { ...SCH_TABLE, border: { ...SCH_TABLE.border, style: 'wavy' } },
      { ...SCH_TABLE, border: { ...SCH_TABLE.border, width: -1 } },
      { ...SCH_TABLE, border: { ...SCH_TABLE.border, color: 'red' } },
      { ...SCH_TABLE, border: { external: true, header: true, width: 0, color: '' } },
      { ...SCH_TABLE, separators: { ...SCH_TABLE.border } },
      { ...SCH_TABLE, layer: 'F Cu' }, { ...SCH_TABLE, locked: 'no' },
    ];
    for (const r of bad) expect(readTable(r)).toBeNull();
  });
});

describe('the tableCell ask', () => {
  it('reads one schematic cell and several board cells, nulls kept', () => {
    expect(readTableCell(SCH_CELL)).toEqual(SCH_CELL);
    expect(readTableCell(PCB_CELLS)).toEqual(PCB_CELLS);
    const mixed = { ...SCH_CELL, margins: { left: null, right: 0.5, top: 0.5, bottom: null }, fill: { mode: null, color: null } };
    expect(readTableCell(mixed)).toEqual(mixed);
  });

  it('every key is present', () => {
    for (const k of TABLE_CELL_KEYS) {
      const r: Record<string, unknown> = { ...SCH_CELL };
      delete r[k];
      expect(readTableCell(r)).toBeNull();
    }
  });

  it('refuses another shape', () => {
    const bad: unknown[] = [
      { ...SCH_CELL, extra: 1 },
      { ...SCH_CELL, uuids: [] }, { ...SCH_CELL, uuids: [C0, C0] }, { ...SCH_CELL, uuids: ['x'] },
      { ...SCH_CELL, text: 3 }, { ...SCH_CELL, bold: 'yes' },
      { ...SCH_CELL, hAlign: 'middle' }, { ...SCH_CELL, vAlign: 'left' },
      { ...SCH_CELL, size: -1 }, { ...SCH_CELL, width: Number.NaN },
      { ...SCH_CELL, margins: { left: 1, right: 1, top: 1 } },
      { ...SCH_CELL, fill: { mode: 'hatch', color: '' } },
      { ...SCH_CELL, textColor: '#fff' },
    ];
    for (const r of bad) expect(readTableCell(r)).toBeNull();
  });
});

describe('the prompt host takes the table asks through these readers', () => {
  type Slot = { onAsk?: (j: unknown) => boolean };
  function host(frame: 'sch' | 'pcb') {
    const w = { Module: { kicadHostPrompts: () => true, kicadPromptAnswer: () => '{"accepted":true}', kicadPromptCancel: () => 0, kicadPromptPick: () => 0 }, document: undefined, kicadHostPrompt: undefined as Slot | undefined };
    const emitted: Array<Record<string, unknown>> = [];
    const ctx = {
      frame, root: '/p', timing: {},
      win: () => w, mod: () => w.Module, ready: () => true, closed: () => false, caps: () => ['prompts', TABLE_CSV_CAP],
      hasDocument: () => true, importing: () => false,
      readAsk: (ask: string, record: unknown) => REGISTRY.askReaders.get(ask)?.read(record) ?? null,
      holdMenus: () => {}, emitExt: (type: string, p: Record<string, unknown>) => { emitted.push({ type, ...p }); }, log: () => {},
    } as unknown as ResponderCtx;
    const stop = prompts.install!(ctx) as () => void;
    return { slot: () => w.kicadHostPrompt as Slot, emitted, stop };
  }

  it('a table ask and a cell ask become ev.prompt with their records; a record of another shape is declined', () => {
    const h = host('sch');
    expect(h.slot().onAsk!(JSON.stringify({ token: 1, ask: 'tableCell', modal: true, record: SCH_CELL }))).toBe(true);
    expect(h.slot().onAsk!(JSON.stringify({ token: 2, ask: 'table', modal: true, record: SCH_TABLE }))).toBe(true);
    expect(h.slot().onAsk!(JSON.stringify({ token: 3, ask: 'table', modal: true, record: { ...SCH_TABLE, rows: 9 } }))).toBe(false);
    expect(h.emitted).toEqual([
      { type: 'ev.prompt', token: 1, ask: 'tableCell', modal: true, frame: 'sch', record: SCH_CELL },
      { type: 'ev.prompt', token: 2, ask: 'table', modal: true, frame: 'sch', record: SCH_TABLE },
    ]);
    h.stop();
  });
});
