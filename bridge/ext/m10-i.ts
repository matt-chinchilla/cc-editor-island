// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// m10-i (PROTOCOL.md buses.migration.get, buses.migration.apply): the buses
// whose labels give them two names, read with KiCad's own proposals through
// our engine's run 15 export kicadBusMigrationGet, and named by the host's
// choices through kicadBusMigrationApply, ONE commit "Name buses" (one undo
// step), in a sch frame. KiCad's Migrate Buses window never opens on this
// engine (unit m10-e): the labels stay as the file holds them until the host
// applies. The apply writes its records under a fresh /tmp/cc-buses/<n>/,
// removed after every answer. Feature detected: on an engine without the
// exports the cap busMigration is not listed and each op answers unsupported
// naming the first missing export.
import { fail, hasAll, isObj, noArgs, ok, refused, type Answer, type ExtUnit, type ResponderCtx } from './contract';

/** The engine export the read needs (a synchronous read of the connection graph). */
export const GET_EXPORTS = ['kicadBusMigrationGet'] as const;
/** The engine exports the apply needs (the run is queued on the apply coroutine, so the wait reads kicadCollabBusy). */
export const APPLY_EXPORTS = ['kicadBusMigrationApply', 'kicadCollabBusy'] as const;
/** The cap a host gates its Bus names door on. */
export const BUS_CAP = 'busMigration';
/** At most this many buses in a read, and choices in an apply (the engine's bound). */
export const BUSES_MAX = 1024;
/** At most this many labels in one choice (the engine's bound). */
export const LABELS_MAX = 64;
/** A chosen name: 1 to 1,024 UTF-8 bytes, no line break, no NUL. */
export const NAME_MAX_BYTES = 1024;
/** Where the apply writes its records (the engine takes no other run folder). */
export const BUSES_ROOT = '/tmp/cc-buses';
/** The engine's code for a label uuid it cannot resolve to a label (nothing changed). */
export const LABEL_UNKNOWN = 'bus_label_unknown';
/** The bound of one apply when the bridge's timing names none. */
const APPLY_MS = 30_000;
const RECORD = '.cc-buses.json';
const REPORT = 'buses.json';
const FRAME_REFUSAL = 'a bus op runs in a sch frame';
const SHEET_PATH_MAX = 4096;
const TEXT_MAX_BYTES = 4096;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface BusLabel { uuid: string; text: string }
export interface Bus { id: number; sheetPath: string; labels: BusLabel[]; proposals: string[] }
export interface BusChoice { labels: string[]; name: string }
export interface ApplyReport { applied: number; labels: number; depth: number }
export type ApplyDone = { report: ApplyReport } | { error: 'unknown' } | { error: 'bad' };

const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
};
const utf8Bytes = (s: string): number => new TextEncoder().encode(s).byteLength;
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isText = (v: unknown, maxBytes: number): v is string => typeof v === 'string' && !v.includes('\0') && utf8Bytes(v) <= maxBytes;

/** One bus of the engine's read, closed: `{ id, sheetPath, labels: [{ uuid, text }] (1 to 64), proposals: string[] }`, or null. */
export function readBus(v: unknown): Bus | null {
  if (!isObj(v) || !exactKeys(v, ['id', 'sheetPath', 'labels', 'proposals'])) return null;
  const { id, sheetPath, labels, proposals } = v;
  if (!isCount(id) || !isText(sheetPath, SHEET_PATH_MAX)) return null;
  if (!Array.isArray(labels) || labels.length < 1 || labels.length > LABELS_MAX) return null;
  if (!Array.isArray(proposals) || proposals.length > LABELS_MAX) return null;
  const out: BusLabel[] = [];
  for (const l of labels) {
    if (!isObj(l) || !exactKeys(l, ['uuid', 'text'])) return null;
    if (typeof l.uuid !== 'string' || !UUID_RE.test(l.uuid) || !isText(l.text, TEXT_MAX_BYTES)) return null;
    out.push({ uuid: l.uuid, text: l.text });
  }
  const props: string[] = [];
  for (const p of proposals) {
    if (!isText(p, TEXT_MAX_BYTES)) return null;
    props.push(p);
  }
  return { id, sheetPath, labels: out, proposals: props };
}

/** kicadBusMigrationGet's answer read closed: `{ buses (at most 1,024) }`, null for any other shape. */
export function readBuses(raw: string): Bus[] | null {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!isObj(v) || !exactKeys(v, ['buses']) || !Array.isArray(v.buses) || v.buses.length > BUSES_MAX) return null;
  const buses: Bus[] = [];
  for (const b of v.buses) {
    const bus = readBus(b);
    if (bus == null) return null;
    buses.push(bus);
  }
  return buses;
}

/**
 * buses.migration.apply's args: exactly `{ choices }`, 1 to 1,024 of exactly
 * `{ labels, name }`: 1 to 64 label uuids (lowercase, as the read answered
 * them; no uuid twice in the whole request) and the name (1 to 1,024 UTF-8
 * bytes, no line break, no NUL). Null for anything else.
 */
export function parseApplyArgs(args: unknown): BusChoice[] | null {
  if (!isObj(args) || !exactKeys(args, ['choices'])) return null;
  const c = args.choices;
  if (!Array.isArray(c) || c.length < 1 || c.length > BUSES_MAX) return null;
  const seen = new Set<string>();
  const out: BusChoice[] = [];
  for (const ch of c) {
    if (!isObj(ch) || !exactKeys(ch, ['labels', 'name'])) return null;
    const { labels, name } = ch;
    if (typeof name !== 'string' || name.length === 0 || /[\r\n\0]/.test(name) || utf8Bytes(name) > NAME_MAX_BYTES) return null;
    if (!Array.isArray(labels) || labels.length < 1 || labels.length > LABELS_MAX) return null;
    for (const u of labels) {
      if (typeof u !== 'string' || !UUID_RE.test(u) || seen.has(u)) return null;
      seen.add(u);
    }
    out.push({ labels: [...labels] as string[], name });
  }
  return out;
}

/**
 * The apply's records read closed. `done` is `.cc-buses.json`, written LAST
 * (`{ error, message, lines }`, error "" or "bus_label_unknown"); `report` is
 * `buses.json` (`{ run, applied, labels, depth, lines }`). Null while the
 * done record is not there yet; `{ error: 'bad' }` for any other shape.
 */
export function readApplyDone(done: Uint8Array | null, report: Uint8Array | null, run: number): ApplyDone | null {
  if (done == null) return null;
  const json = (b: Uint8Array): unknown => { try { return JSON.parse(new TextDecoder().decode(b)); } catch { return undefined; } };
  const d = json(done);
  if (!isObj(d) || !exactKeys(d, ['error', 'message', 'lines']) || typeof d.message !== 'string' || !Array.isArray(d.lines)) return { error: 'bad' };
  if (d.error === LABEL_UNKNOWN) return { error: 'unknown' };
  if (d.error !== '' || report == null) return { error: 'bad' };
  const r = json(report);
  if (!isObj(r) || !exactKeys(r, ['run', 'applied', 'labels', 'depth', 'lines']) || !Array.isArray(r.lines)) return { error: 'bad' };
  if (r.run !== run || !isCount(r.applied) || !isCount(r.labels) || !isCount(r.depth) || r.applied === 0 || r.labels === 0) return { error: 'bad' };
  return { report: { applied: r.applied, labels: r.labels, depth: r.depth } };
}

/**
 * buses.migration.get (a sch frame, a schematic open): no args, then the
 * gate (the engine's export, a schematic open, busy), then KiCad's own list
 * of the buses that need a name, each with its labels and KiCad's proposals.
 * A read: answered during a check.
 */
function get(args: unknown, ctx: ResponderCtx): Answer {
  const op = 'buses.migration.get';
  if (!noArgs(args)) return fail('bad_args', op);
  const g = ctx.schematicGate(op, GET_EXPORTS);
  if (refused(g)) return g;
  let raw: string;
  try {
    raw = String((g.mod.kicadBusMigrationGet as () => unknown)() ?? '');
  } catch (err) {
    return fail('island_error', err instanceof Error ? err.message : String(err));
  }
  if (raw === '') return fail('not_ready', op);
  const buses = readBuses(raw);
  if (buses == null) return fail('island_error', 'the engine answered buses of another shape');
  return ok({ buses });
}

/**
 * buses.migration.apply (a sch frame, a schematic open): the args (bad_args),
 * the gate, then the run queued with a fresh /tmp/cc-buses/<n>/ and its
 * records read once the apply queue is empty; the folder is removed whatever
 * the answer. Every label is resolved first: one the schematic does not hold
 * as a label answers bus_label_unknown with nothing changed. Else each label
 * takes its choice's name in ONE commit; the responder's own ev.edited
 * follows once the depth moved.
 */
async function apply(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const op = 'buses.migration.apply';
  const choices = parseApplyArgs(args);
  if (choices == null) return fail('bad_args', op);
  const g = ctx.schematicGate(op, APPLY_EXPORTS);
  if (refused(g)) return g;
  let dir: string;
  try {
    dir = ctx.freshRunFolder(BUSES_ROOT);
  } catch (err) {
    return fail('island_error', err instanceof Error ? err.message : String(err));
  }
  try {
    const run = Number(dir.slice(dir.lastIndexOf('/') + 1));
    const t0 = Date.now();
    let thrown: string | null = null;
    const got = await ctx.queuedRun(op, dir, ctx.timing.busesMs ?? APPLY_MS,
      () => {
        try {
          return (g.mod.kicadBusMigrationApply as (json: string) => unknown)(JSON.stringify({ run, dir, choices }));
        } catch (err) {
          thrown = err instanceof Error ? err.message : String(err);
          return false;
        }
      },
      () => readApplyDone(ctx.readBytes(`${dir}/${RECORD}`), ctx.readBytes(`${dir}/${REPORT}`), run));
    if (thrown != null) return fail('island_error', thrown);
    if (!('done' in got)) return got;
    const done = got.done;
    if ('report' in done) {
      ctx.log(op, `${done.report.applied} buses`, `${done.report.labels} labels`, `${Date.now() - t0} ms`);
      return ok({ applied: done.report.applied, labels: done.report.labels });
    }
    if (done.error === 'unknown') return fail(LABEL_UNKNOWN, op);
    return fail('island_error', 'the engine answered an apply of another shape');
  } finally {
    ctx.dropRunFolder(dir);
  }
}

export default {
  unit: 'm10-i',
  frames: ['sch'],
  frameRefusal: FRAME_REFUSAL,
  capNames: [BUS_CAP],
  caps: (mod, frame) => (frame === 'sch' && hasAll(mod, [...GET_EXPORTS, ...APPLY_EXPORTS]) ? [BUS_CAP] : []),
  ops: {
    'buses.migration.get': { run: get, passesCheck: true },
    'buses.migration.apply': { run: apply },
  },
} satisfies ExtUnit;
