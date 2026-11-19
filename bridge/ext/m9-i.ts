// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// m9-i (PROTOCOL.md sheet.pins.get, sheet.pins.apply, sheet.pins.place): each
// sheet's pins against its own file's hierarchical labels, read through our
// engine's run 15 export kicadSheetPinsGet; the host's renames, shapes and
// removals as ONE commit "Synchronize sheet pins" (one undo step) through
// kicadSheetPinsApply; and the missing side placed by KiCad's own placement
// tools, armed with the counterparts' names and shapes, through
// kicadSheetPinsPlace (unit m9-e), in a sch frame. KiCad's two Sync Sheet Pins
// actions are held under the cap syncPins: its dialog never opens, the frame
// sends ev.held and the host opens its own page. The apply writes its record
// under a fresh /tmp/cc-sheet-pins/<n>/, removed after every answer. Feature
// detected: on an engine without the exports the cap is not listed, nothing
// is held, and each op answers unsupported naming the first missing export.
import { selection } from '../place';
import { fail, hasAll, isObj, ok, refused, type Answer, type ExtUnit, type ResponderCtx } from './contract';

/** The engine export the read needs (a synchronous read of the hierarchy). */
export const GET_EXPORTS = ['kicadSheetPinsGet'] as const;
/** The engine exports the apply needs (queued on the apply coroutine, so the wait reads kicadCollabBusy). */
export const APPLY_EXPORTS = ['kicadSheetPinsApply', 'kicadCollabBusy'] as const;
/** The engine exports the placement needs (the item hanging is read in the selection). */
export const PLACE_EXPORTS = ['kicadSheetPinsPlace', 'kicadCollabBusy', 'kicadCollabGetSelection'] as const;
/** The cap a host gates its Sheet pins page on; the held rows follow it. */
export const PINS_CAP = 'syncPins';
/** KiCad's two actions that open its Sync Sheet Pins dialog (sch_actions.cpp), held under the cap. */
export const SYNC_SHEET_PINS = 'eeschema.InteractiveDrawing.syncSheetPins';
export const SYNC_ALL_SHEETS_PINS = 'eeschema.InteractiveDrawing.syncAllSheetsPins';
export const M9_HELD_ROWS = [
  { action: SYNC_SHEET_PINS, frames: ['sch'], cap: PINS_CAP },
  { action: SYNC_ALL_SHEETS_PINS, frames: ['sch'], cap: PINS_CAP },
] as const;
/** The port shapes, as the engine names them. */
export const PORT_SHAPES = ['input', 'output', 'bidirectional', 'tri_state', 'passive'] as const;
export type PortShape = (typeof PORT_SHAPES)[number];
/** At most this many sheets asked in a read, pairs in one sheet's row, and actions in one apply (the engine's bounds). */
export const SHEETS_MAX = 4096;
export const PAIRS_MAX = 4096;
export const ACTIONS_MAX = 4096;
/** At most this many names in one placement (the engine's bound). */
export const NAMES_MAX = 64;
/** A name: 1 to 1,024 characters, no control character (the engine's text rule). */
export const NAME_MAX = 1024;
/** Where the apply writes its record (the engine takes no other run folder). */
export const PINS_ROOT = '/tmp/cc-sheet-pins';
/** The bound of one apply when the bridge's timing names none. */
const APPLY_MS = 30_000;
/** How long a hierarchical label may take to hang after the editor ran its tool. */
const PLACE_MS = 10_000;
/** How long the sheet pin tool is watched for an item before the answer says none hangs yet. */
const PIN_SETTLE_MS = 500;
const POLL_MS = 25;
const REPORT = 'sheet-pins.json';
const FRAME_REFUSAL = 'a sheet pins op runs in a sch frame';
const SHEET_PATH_MAX = 4096;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export interface SheetPinsPair { name: string; pin: string | null; label: string | null; pinShape: PortShape | null; labelShape: PortShape | null }
export interface SheetPinsRow { sheet: string; sheetPath: string; name: string; file: string; pairs: SheetPinsPair[] }
export interface SheetPinsRead { sheets: SheetPinsRow[]; truncated: boolean }
export interface SheetRef { uuid: string; sheetPath: string }
export type SyncAction =
  | { op: 'renamePin'; pin: string; to: string } | { op: 'renameLabel'; label: string; sheetPath: string; to: string }
  | { op: 'shapePin'; pin: string; to: PortShape } | { op: 'shapeLabel'; label: string; sheetPath: string; to: PortShape }
  | { op: 'removePin'; pin: string } | { op: 'removeLabel'; label: string; sheetPath: string };
export interface PlaceArgs { sheet: string; sheetPath: string; place: 'pin' | 'label'; names: string[] }
export type ApplyDone = { report: { applied: number; depth: number } } | { error: 'bad' };

const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
};
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
const isShape = (v: unknown): v is PortShape => typeof v === 'string' && (PORT_SHAPES as readonly string[]).includes(v);
const isSheetPath = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= SHEET_PATH_MAX && !v.includes('\0');
/** A name as the engine takes it: 1 to 1,024 characters (code points), no control character. */
export const isPinName = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && [...v].length <= NAME_MAX && !CONTROL_RE.test(v);
const isText = (v: unknown): v is string => typeof v === 'string' && !v.includes('\0');

/** One pair of the engine's read, closed: a name and at least one side, each side's shape present exactly with it. */
export function readPair(v: unknown): SheetPinsPair | null {
  if (!isObj(v) || !exactKeys(v, ['name', 'pin', 'label', 'pinShape', 'labelShape'])) return null;
  const { name, pin, label, pinShape, labelShape } = v;
  if (!isText(name)) return null;
  if (pin === null ? pinShape !== null : !isUuid(pin) || !isShape(pinShape)) return null;
  if (label === null ? labelShape !== null : !isUuid(label) || !isShape(labelShape)) return null;
  if (pin === null && label === null) return null;
  return { name, pin: pin as string | null, label: label as string | null, pinShape: pinShape as PortShape | null, labelShape: labelShape as PortShape | null };
}

/** One sheet of the engine's read, closed: `{ sheet, sheetPath, name, file, pairs (at most 4,096) }`, or null. */
export function readRow(v: unknown): SheetPinsRow | null {
  if (!isObj(v) || !exactKeys(v, ['sheet', 'sheetPath', 'name', 'file', 'pairs'])) return null;
  const { sheet, sheetPath, name, file, pairs } = v;
  if (!isUuid(sheet) || !isSheetPath(sheetPath) || !isText(name) || !isText(file)) return null;
  if (!Array.isArray(pairs) || pairs.length > PAIRS_MAX) return null;
  const out: SheetPinsPair[] = [];
  for (const p of pairs) {
    const pair = readPair(p);
    if (pair == null) return null;
    out.push(pair);
  }
  return { sheet, sheetPath, name, file, pairs: out };
}

/** kicadSheetPinsGet's answer read closed: `{ sheets, truncated }`, null for any other shape. */
export function readSheetPins(raw: string): SheetPinsRead | null {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!isObj(v) || !exactKeys(v, ['sheets', 'truncated']) || !Array.isArray(v.sheets) || typeof v.truncated !== 'boolean') return null;
  const sheets: SheetPinsRow[] = [];
  for (const s of v.sheets) {
    const row = readRow(s);
    if (row == null) return null;
    sheets.push(row);
  }
  return { sheets, truncated: v.truncated };
}

/**
 * sheet.pins.get's args: none (every sheet of the design), or exactly
 * `{ sheets }`, 1 to 4,096 of exactly `{ uuid, sheetPath }` (the sheet's
 * uuid, lowercase, and the path it sits on, as the read answers them).
 * Null for anything else.
 */
export function parseGetArgs(args: unknown): SheetRef[] | 'all' | null {
  if (args === undefined || (isObj(args) && Object.keys(args).length === 0)) return 'all';
  if (!isObj(args) || !exactKeys(args, ['sheets'])) return null;
  const s = args.sheets;
  if (!Array.isArray(s) || s.length < 1 || s.length > SHEETS_MAX) return null;
  const out: SheetRef[] = [];
  for (const r of s) {
    if (!isObj(r) || !exactKeys(r, ['uuid', 'sheetPath']) || !isUuid(r.uuid) || !isSheetPath(r.sheetPath)) return null;
    out.push({ uuid: r.uuid, sheetPath: r.sheetPath });
  }
  return out;
}

/** One action, closed per its op (spec 7.3): the uuids lowercase, a label with its sheet path, a name or a shape where one is set. */
export function readAction(v: unknown): SyncAction | null {
  if (!isObj(v) || typeof v.op !== 'string') return null;
  switch (v.op) {
    case 'renamePin': return exactKeys(v, ['op', 'pin', 'to']) && isUuid(v.pin) && isPinName(v.to) ? { op: v.op, pin: v.pin, to: v.to } : null;
    case 'shapePin': return exactKeys(v, ['op', 'pin', 'to']) && isUuid(v.pin) && isShape(v.to) ? { op: v.op, pin: v.pin, to: v.to } : null;
    case 'removePin': return exactKeys(v, ['op', 'pin']) && isUuid(v.pin) ? { op: v.op, pin: v.pin } : null;
    case 'renameLabel':
      return exactKeys(v, ['op', 'label', 'sheetPath', 'to']) && isUuid(v.label) && isSheetPath(v.sheetPath) && isPinName(v.to)
        ? { op: v.op, label: v.label, sheetPath: v.sheetPath, to: v.to } : null;
    case 'shapeLabel':
      return exactKeys(v, ['op', 'label', 'sheetPath', 'to']) && isUuid(v.label) && isSheetPath(v.sheetPath) && isShape(v.to)
        ? { op: v.op, label: v.label, sheetPath: v.sheetPath, to: v.to } : null;
    case 'removeLabel':
      return exactKeys(v, ['op', 'label', 'sheetPath']) && isUuid(v.label) && isSheetPath(v.sheetPath)
        ? { op: v.op, label: v.label, sheetPath: v.sheetPath } : null;
    default: return null;
  }
}

/** sheet.pins.apply's args: exactly `{ actions }`, 1 to 4,096 actions each read closed. Null for anything else. */
export function parseApplyArgs(args: unknown): SyncAction[] | null {
  if (!isObj(args) || !exactKeys(args, ['actions'])) return null;
  const a = args.actions;
  if (!Array.isArray(a) || a.length < 1 || a.length > ACTIONS_MAX) return null;
  const out: SyncAction[] = [];
  for (const v of a) {
    const action = readAction(v);
    if (action == null) return null;
    out.push(action);
  }
  return out;
}

/**
 * sheet.pins.place's args: exactly `{ sheet, sheetPath, place, names }`: the
 * sheet's uuid and the path it sits on, "pin" or "label", and 1 to 64 names.
 * Null for anything else.
 */
export function parsePlaceArgs(args: unknown): PlaceArgs | null {
  if (!isObj(args) || !exactKeys(args, ['sheet', 'sheetPath', 'place', 'names'])) return null;
  const { sheet, sheetPath, place, names } = args;
  if (!isUuid(sheet) || !isSheetPath(sheetPath) || (place !== 'pin' && place !== 'label')) return null;
  if (!Array.isArray(names) || names.length < 1 || names.length > NAMES_MAX || !names.every(isPinName)) return null;
  return { sheet, sheetPath, place, names: [...names] as string[] };
}

/** The apply's record `sheet-pins.json` (`{ applied, depth }`, written last) read closed: null while absent, `{ error: 'bad' }` for another shape. */
export function readApplyDone(report: Uint8Array | null): ApplyDone | null {
  if (report == null) return null;
  let r: unknown;
  try { r = JSON.parse(new TextDecoder().decode(report)); } catch { return { error: 'bad' }; }
  if (!isObj(r) || !exactKeys(r, ['applied', 'depth']) || !isCount(r.applied) || !isCount(r.depth)) return { error: 'bad' };
  return { report: { applied: r.applied, depth: r.depth } };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * sheet.pins.get (a sch frame, a schematic open): the args, the gate, then
 * each sheet's pins against its own file's hierarchical labels, paired by
 * name. A read: answered during a check.
 */
function get(args: unknown, ctx: ResponderCtx): Answer {
  const op = 'sheet.pins.get';
  const asked = parseGetArgs(args);
  if (asked == null) return fail('bad_args', op);
  const g = ctx.schematicGate(op, GET_EXPORTS);
  if (refused(g)) return g;
  let raw: string;
  try {
    raw = String((g.mod.kicadSheetPinsGet as (json: string) => unknown)(JSON.stringify(asked === 'all' ? {} : { sheets: asked })) ?? '');
  } catch (err) {
    return fail('island_error', err instanceof Error ? err.message : String(err));
  }
  if (raw === '') return fail('not_ready', op);
  const read = readSheetPins(raw);
  if (read == null) return fail('island_error', 'the engine answered sheet pins of another shape');
  return ok({ sheets: read.sheets, truncated: read.truncated });
}

/**
 * sheet.pins.apply (a sch frame, a schematic open): the args, the gate, then
 * the run queued with a fresh /tmp/cc-sheet-pins/<n>/ and its record read
 * once the apply queue is empty; the folder is removed whatever the answer.
 * The engine refuses the whole run (not_applied, nothing changed) when a pin
 * or a label named is not in the design. Else ONE commit; the responder's
 * own ev.edited follows once the depth moved.
 */
async function apply(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const op = 'sheet.pins.apply';
  const actions = parseApplyArgs(args);
  if (actions == null) return fail('bad_args', op);
  const g = ctx.schematicGate(op, APPLY_EXPORTS);
  if (refused(g)) return g;
  let dir: string;
  try {
    dir = ctx.freshRunFolder(PINS_ROOT);
  } catch (err) {
    return fail('island_error', err instanceof Error ? err.message : String(err));
  }
  try {
    const run = Number(dir.slice(dir.lastIndexOf('/') + 1));
    const t0 = Date.now();
    let thrown: string | null = null;
    const got = await ctx.queuedRun(op, dir, ctx.timing.sheetPinsMs ?? APPLY_MS,
      () => {
        try {
          return (g.mod.kicadSheetPinsApply as (json: string) => unknown)(JSON.stringify({ run, dir, actions }));
        } catch (err) {
          thrown = err instanceof Error ? err.message : String(err);
          return false;
        }
      },
      () => readApplyDone(ctx.readBytes(`${dir}/${REPORT}`)));
    if (thrown != null) return fail('island_error', thrown);
    if (!('done' in got)) return got;
    const done = got.done;
    if (!('report' in done)) return fail('island_error', 'the engine answered an apply of another shape');
    ctx.log(op, `${done.report.applied} of ${actions.length} actions`, `${Date.now() - t0} ms`);
    return ok({ applied: done.report.applied });
  } finally {
    ctx.dropRunFolder(dir);
  }
}

/**
 * sheet.pins.place (a sch frame, a schematic open): the args, the item still
 * hanging dropped first, the gate, then KiCad's own placement armed with the
 * counterparts of the names. A label enters the sheet and hangs off the
 * pointer at once: answered `{ hanging: true }` once it does, joined to the
 * place watch (Esc drops it, a press commits one undo step and the next name
 * hangs). KiCad's sheet pin tool makes its item at the reader's first press
 * on the drawing, at the sheet's edge: answered `{ hanging: false }` once
 * the tool runs with nothing hanging yet (`{ hanging: true }` when it does).
 */
async function place(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const op = 'sheet.pins.place';
  const a = parsePlaceArgs(args);
  if (a == null) return fail('bad_args', op);
  if (ctx.placeHanging() && !(await ctx.placeCancel())) return fail('busy', 'the previous item still hangs off the pointer');
  const g = ctx.schematicGate(op, PLACE_EXPORTS);
  if (refused(g)) return g;
  const before = selection(g.w);
  if (before == null) return fail('island_error', 'the selection does not read');
  const t0 = Date.now();
  let said: unknown;
  try {
    said = (g.mod.kicadSheetPinsPlace as (json: string) => unknown)(JSON.stringify(a));
  } catch (err) {
    return fail('island_error', err instanceof Error ? err.message : String(err));
  }
  if (said !== true) {
    const other = a.place === 'pin' ? 'hierarchical label' : 'sheet pin';
    return fail('not_applied', `${op}: the sheet is not there, or a name has no ${other} of its name`);
  }
  const ms = ctx.timing.placeMs ?? PLACE_MS;
  if (!(await ctx.applyIdle(ms))) return fail('not_applied', `${op}: the editor did not take the placement`);
  const end = Date.now() + (a.place === 'label' ? ms : ctx.timing.sheetPinSettleMs ?? PIN_SETTLE_MS);
  for (;;) {
    if (ctx.closed()) return fail('island_error', 'the frame closed');
    const fresh = (selection(g.w) ?? []).find((u) => u !== a.sheet && !before.includes(u));
    if (fresh != null) {
      ctx.placeStart(fresh);
      ctx.log(op, a.place, `${a.names.length} names`, `${Date.now() - t0} ms`);
      return ok({ hanging: true });
    }
    if (Date.now() >= end) break;
    await sleep(ctx.timing.placePollMs ?? POLL_MS);
  }
  if (a.place === 'label') return fail('busy', `${op}: the editor did not take the placement`);
  ctx.log(op, 'pin tool armed', `${a.names.length} names`, `${Date.now() - t0} ms`);
  return ok({ hanging: false });
}

export default {
  unit: 'm9-i',
  frames: ['sch'],
  frameRefusal: FRAME_REFUSAL,
  capNames: [PINS_CAP],
  caps: (mod, frame) => (frame === 'sch' && hasAll(mod, [...GET_EXPORTS, ...APPLY_EXPORTS, ...PLACE_EXPORTS]) ? [PINS_CAP] : []),
  held: M9_HELD_ROWS.map((r) => r.action),
  heldRows: M9_HELD_ROWS.map((r) => ({ action: r.action, frames: [...r.frames], cap: r.cap })),
  ops: {
    'sheet.pins.get': { run: get, passesCheck: true },
    'sheet.pins.apply': { run: apply },
    'sheet.pins.place': { run: place },
  },
} satisfies ExtUnit;
