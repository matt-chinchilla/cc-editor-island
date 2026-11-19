// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// Tables (PROTOCOL.md table.csv, the canvas commands addendum 8): KiCad's
// Table Properties and Table Cell Properties dialogs asked of the host in
// place of their windows (asks `table` and `tableCell`, taken by m1x-i's
// prompt host through this unit's closed readers), and a table's text as CSV
// built by KiCad's own exporter, for the page to save.
//
// Engine run 15 (unit m12-e) adds kicadTableCsv(json) to both frames: exactly
// { uuid } (a table's or any of its cells'), answering JSON text
// { name, text }, or "" for a uuid that is no table, a busy frame, or another
// editor. A read: no commit, no undo step. KiCad's own Export Table to CSV
// would open a file window: it is held under the cap tableCsv, the frame
// sends ev.held, and the page asks table.csv in its place.
import { fail, hasAll, isObj, ok, refused, type ExtUnit, type HeldRow } from './contract';
import { readCsv, TABLE_ASK_READERS, TABLE_ASKS, UUID_RE } from './m12-i/asks';

/** The pseudo-cap: the engine builds a table's CSV with no window. */
export const TABLE_CSV_CAP = 'tableCsv';
/** The engine export the cap and the op need (engine run 15, unit m12-e). */
export const TABLE_CSV_EXPORTS = ['kicadTableCsv'] as const;
/** The frames whose tables the engine reads (the footprint, symbol and drawing sheet editors answer ""). */
export const TABLE_FRAMES = ['sch', 'pcb'] as const;
/** KiCad's Export Table to CSV, held: the page asks table.csv and saves the file itself. */
export const EXPORT_TABLE_CSV = 'common.TableEditor.exportTableCSV';
export const M12_HELD_ROWS: readonly HeldRow[] = Object.freeze([
  Object.freeze({ action: EXPORT_TABLE_CSV, frames: Object.freeze([...TABLE_FRAMES]), cap: TABLE_CSV_CAP }),
]);

export default {
  unit: 'm12-i',
  frames: [...TABLE_FRAMES],
  frameRefusal: 'a table is read in a sch or pcb frame',
  capNames: [TABLE_CSV_CAP],
  caps: (mod, frame) => ((TABLE_FRAMES as readonly string[]).includes(frame) && hasAll(mod, TABLE_CSV_EXPORTS) ? [TABLE_CSV_CAP] : []),
  held: M12_HELD_ROWS.map((r) => r.action),
  heldRows: M12_HELD_ROWS,
  asks: [...TABLE_ASKS],
  askReaders: TABLE_ASK_READERS,
  ops: {
    'table.csv': {
      // A read: answered during a sheet or board check too.
      passesCheck: true,
      run(args, ctx) {
        const op = 'table.csv';
        if (!isObj(args) || Object.keys(args).length !== 1 || typeof args.uuid !== 'string') return fail('bad_args', op);
        const uuid = args.uuid.toLowerCase();
        if (!UUID_RE.test(uuid)) return fail('bad_args', op);
        const g = ctx.frame === 'pcb' ? ctx.boardGate(op, TABLE_CSV_EXPORTS) : ctx.schematicGate(op, TABLE_CSV_EXPORTS);
        if (refused(g)) return g;
        let raw: unknown;
        try { raw = (g.mod.kicadTableCsv as (json: string) => unknown)(JSON.stringify({ uuid })); } catch { return fail('island_error', op); }
        // The gates passed, so "" says no table holds the uuid.
        if (raw === '' || raw == null) return fail('not_found', uuid);
        const csv = readCsv(raw);
        if (csv == null) return fail('island_error', `${op}: the engine answered another shape`);
        return ok(csv);
      },
    },
  },
} satisfies ExtUnit;
