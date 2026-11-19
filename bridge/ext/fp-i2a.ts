// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// fpedit.items.get, fpedit.items.set, fpedit.items.add and fpedit.items.remove
// (FP spec 6.2, 7.2): the open footprint's items in the footprint editor's
// frame, read and changed through our engine's item exports
// (kicadFpEditItemsGet, Set, Add, Remove, engine run 15), each change ONE
// undo step of KiCad's ("Edit", "Add", "Delete"). The records are
// bridge/itemRecords.ts's, frame neutral. Every op is feature detected: on an
// engine without the exports it answers unsupported naming the first missing one.
import { fail, isObj, ok, type Answer, type ExtUnit, type ResponderCtx } from './contract';
import {
  ITEM_RECORD_KINDS, LAYERS_MAX, isLayerName, isUuid, itemSetMisfit, readItemRecord, readItemSet, readNewItem, showsItemSet,
  type ItemRecord, type ItemRecordKind,
} from '../itemRecords';

/** The footprint editor's frame (fp-i1). */
export const FPEDIT_FRAME = 'fpedit';
/** The answer outside it. */
export const FPEDIT_FRAME_ONLY = 'a footprint edits in an fpedit frame';
/** The engine exports the item ops need, the editor's state and the apply queue probe last. */
export const FP_ITEMS_EXPORTS = [
  'kicadFpEditItemsGet', 'kicadFpEditItemsSet', 'kicadFpEditItemsAdd', 'kicadFpEditItemsRemove', 'kicadFpEditState', 'kicadCollabBusy',
] as const;
/** uuids of one request (the engine's UUIDS_MAX). */
export const FP_UUIDS_MAX = 4096;
/** New items of one add (the engine's NEW_ITEMS_MAX). */
export const FP_NEW_ITEMS_MAX = 512;
/** Items of one answer. */
export const FP_ITEMS_MAX = 65_536;

export interface FpItemsGetArgs { uuids?: string[]; kinds?: ItemRecordKind[]; layers?: string[] }
export interface FpItemsSetArgs { uuids: string[]; set: Record<string, unknown> }
export interface FpItemsAddArgs { items: Array<Record<string, unknown> & { kind: ItemRecordKind; uuid: string }> }

const has = (o: Record<string, unknown>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const within = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).every((k) => keys.includes(k));
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).length === keys.length && within(o, keys);
/** `min` to `max` items each passing `c`, none twice. */
function uniqueList<T>(v: unknown, min: number, max: number, c: (x: unknown) => x is T): T[] | null {
  if (!Array.isArray(v) || v.length < min || v.length > max || !v.every(c)) return null;
  return new Set(v).size === v.length ? [...(v as T[])] : null;
}
const isKind = (v: unknown): v is ItemRecordKind => typeof v === 'string' && (ITEM_RECORD_KINDS as readonly string[]).includes(v);

// ── args ───────────────────────────────────────────────────────────────────────────────

/** fpedit.items.get's args: `{ uuids?, kinds?, layers? }`, 1 to 4,096 uuids, 1 to 11 kinds, 1 to 256 layer names, none twice; null for anything else. */
export function parseFpItemsGetArgs(args: unknown): FpItemsGetArgs | null {
  if (args === undefined) return {};
  if (!isObj(args) || !within(args, ['uuids', 'kinds', 'layers'])) return null;
  const out: FpItemsGetArgs = {};
  if (has(args, 'uuids')) {
    const u = uniqueList(args.uuids, 1, FP_UUIDS_MAX, isUuid);
    if (u == null) return null;
    out.uuids = u;
  }
  if (has(args, 'kinds')) {
    const k = uniqueList(args.kinds, 1, ITEM_RECORD_KINDS.length, isKind);
    if (k == null) return null;
    out.kinds = k;
  }
  if (has(args, 'layers')) {
    const l = uniqueList(args.layers, 1, LAYERS_MAX, isLayerName);
    if (l == null) return null;
    out.layers = l;
  }
  return out;
}

/** fpedit.items.set's args: exactly `{ uuids, set }`, 1 to 4,096 uuids none twice and a non empty object (checked against the items' kind once they are read); null for anything else. */
export function parseFpItemsSetArgs(args: unknown): FpItemsSetArgs | null {
  if (!isObj(args) || !exactKeys(args, ['uuids', 'set'])) return null;
  const uuids = uniqueList(args.uuids, 1, FP_UUIDS_MAX, isUuid);
  if (uuids == null || !isObj(args.set) || Object.keys(args.set).length === 0) return null;
  return { uuids, set: args.set };
}

/** fpedit.items.add's args: exactly `{ items }`, 1 to 512 new items (itemRecords readNewItem), no uuid twice; null for anything else. */
export function parseFpItemsAddArgs(args: unknown): FpItemsAddArgs | null {
  if (!isObj(args) || !exactKeys(args, ['items']) || !Array.isArray(args.items)) return null;
  if (args.items.length < 1 || args.items.length > FP_NEW_ITEMS_MAX) return null;
  const items: FpItemsAddArgs['items'] = [];
  const seen = new Set<string>();
  for (const it of args.items as unknown[]) {
    const n = readNewItem(it);
    if (n == null || seen.has(n.uuid)) return null;
    seen.add(n.uuid);
    items.push(n);
  }
  return { items };
}

/** fpedit.items.remove's args: exactly `{ uuids }`, 1 to 4,096 uuids none twice; null for anything else. */
export function parseFpItemsRemoveArgs(args: unknown): { uuids: string[] } | null {
  if (!isObj(args) || !exactKeys(args, ['uuids'])) return null;
  const uuids = uniqueList(args.uuids, 1, FP_UUIDS_MAX, isUuid);
  return uuids == null ? null : { uuids };
}

// ── the engine's answers ───────────────────────────────────────────────────────────────

/**
 * kicadFpEditItemsGet's answer (`{"items":[...]}`) read closed: each item a
 * record of its kind (itemRecords readItemRecord), no uuid twice, in the
 * engine's order. Null for the empty answer (a listed uuid the footprint does
 * not hold) and any other shape.
 */
export function readFpItems(text: unknown): ItemRecord[] | null {
  if (typeof text !== 'string' || text === '') return null;
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (!isObj(v) || !exactKeys(v, ['items']) || !Array.isArray(v.items) || v.items.length > FP_ITEMS_MAX) return null;
  const out: ItemRecord[] = [];
  const seen = new Set<string>();
  for (const it of v.items as unknown[]) {
    if (!isObj(it) || typeof it.kind !== 'string') return null;
    const r = readItemRecord(it.kind, it);
    if (r == null || seen.has(r.uuid)) return null;
    seen.add(r.uuid);
    out.push(r);
  }
  return out;
}

/** The editor's state as far as these ops read it (FP spec 7.1): a footprint open, and the undo depth. */
export interface FpOpenState { open: boolean; depth: number }
/** kicadFpEditState's answer: open and depth read, the rest of FpEditState its own reader's (fp-i1); null for another shape. */
export function readFpOpenState(text: unknown): FpOpenState | null {
  if (typeof text !== 'string' || text === '') return null;
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (!isObj(v) || typeof v.open !== 'boolean' || !Number.isSafeInteger(v.depth) || (v.depth as number) < 0) return null;
  return { open: v.open, depth: v.depth as number };
}

const callText = (mod: Record<string, unknown>, name: string, ...args: unknown[]): string => {
  const r = (mod[name] as (...a: unknown[]) => unknown)(...args);
  return typeof r === 'string' ? r : '';
};
const callBool = (mod: Record<string, unknown>, name: string, ...args: unknown[]): boolean => (mod[name] as (...a: unknown[]) => unknown)(...args) === true;

// ── the gate and the waits ─────────────────────────────────────────────────────────────

type Gate = Answer | { mod: Record<string, unknown>; state: FpOpenState };
const gated = (g: Gate): g is Answer => 'ok' in g;

/**
 * The checks every item op makes after its args, in order, each before any
 * effect: the frame (unsupported outside fpedit), the engine (not_ready before
 * it is up, unsupported naming the first missing export), busy while a load
 * is parked or a popup menu or a dialog is up, then a footprint open (no_footprint).
 */
export function fpItemsGate(ctx: ResponderCtx, op: string): Gate {
  if ((ctx.frame as string) !== FPEDIT_FRAME) return fail('unsupported', FPEDIT_FRAME_ONLY);
  const mod = ctx.win() == null ? null : ctx.mod();
  if (mod == null) return fail('not_ready', op);
  for (const name of FP_ITEMS_EXPORTS) if (typeof mod[name] !== 'function') return fail('unsupported', name);
  if (ctx.engineBusy() || ctx.keysBlocked()) return fail('busy', op);
  const state = readFpOpenState(callText(mod, 'kicadFpEditState'));
  if (state == null) return fail('island_error', 'the engine answered a state of another shape');
  if (!state.open) return fail('no_footprint', op);
  return { mod, state };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** How long a queued change may take to show (the bridge's editor wait, about 5 s). */
const changeMs = (ctx: ResponderCtx): number => ctx.timing.symeditMs ?? 5_000;

/** Waits for a queued change: the apply queue empty and `read` giving a value, at most `ms`; null when it never did. */
async function readBack<T>(ctx: ResponderCtx, ms: number, read: () => T | null): Promise<T | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (ctx.closed()) return null;
    if (await ctx.applyIdle(Math.max(0, deadline - Date.now()))) {
      const got = read();
      if (got != null) return got;
    }
    if (Date.now() >= deadline) return null;
    await sleep(ctx.timing.applyPollMs ?? 10);
  }
}

/** Every item of the open footprint, null for an answer of another shape. */
const allItems = (mod: Record<string, unknown>): ItemRecord[] | null => readFpItems(callText(mod, 'kicadFpEditItemsGet', '{}'));
/** The items of `uuids` as the engine reads them now, in the order asked (the engine answers in KiCad's child order): null while one is missing or the answer is of another shape. */
function itemsOf(mod: Record<string, unknown>, uuids: string[]): ItemRecord[] | null {
  const items = readFpItems(callText(mod, 'kicadFpEditItemsGet', JSON.stringify({ uuids })));
  if (items == null) return null;
  const byUuid = new Map(items.map((i) => [i.uuid, i]));
  return uuids.every((u) => byUuid.has(u)) ? uuids.map((u) => byUuid.get(u) as ItemRecord) : null;
}

/** The items of `uuids`, every one of them in the order asked, or the refusal: not_found naming the first the footprint does not hold. */
function heldItems(op: string, mod: Record<string, unknown>, uuids: string[]): ItemRecord[] | Answer {
  const all = allItems(mod);
  if (all == null) return fail('island_error', 'the engine answered items of another shape');
  const byUuid = new Map(all.map((i) => [i.uuid, i]));
  const missing = uuids.find((u) => !byUuid.has(u));
  return missing != null ? fail('not_found', missing) : uuids.map((u) => byUuid.get(u) as ItemRecord);
}

// ── the ops ────────────────────────────────────────────────────────────────────────────

/** fpedit.items.get: the open footprint's items in KiCad's order, filtered by uuids, kinds and layers (all given must hold); not_found names the first uuid the footprint does not hold. */
export function fpItemsGet(args: unknown, ctx: ResponderCtx): Answer {
  const op = 'fpedit.items.get';
  const a = parseFpItemsGetArgs(args);
  if (a == null) return fail('bad_args', op);
  const g = fpItemsGate(ctx, op);
  if (gated(g)) return g;
  const answer = callText(g.mod, 'kicadFpEditItemsGet', JSON.stringify(a));
  if (answer === '' && a.uuids != null) {
    const held = heldItems(op, g.mod, a.uuids);
    if (!Array.isArray(held)) return held;
  }
  const items = readFpItems(answer);
  return items == null ? fail('island_error', 'the engine answered items of another shape') : ok({ items });
}

/**
 * fpedit.items.set: the items read first (not_found), all of one kind
 * (bad_args), the set read closed for that kind and fitting every item
 * (bad_args naming the key); the engine's own refusals (the pad dialog's,
 * a field's name, a table's size) answer bad_args. The answer is the items
 * read back once the change shows: every key, or the undo step it made
 * (KiCad's dialog rules may reset a value given), else not_applied.
 */
export async function fpItemsSet(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const op = 'fpedit.items.set';
  const a = parseFpItemsSetArgs(args);
  if (a == null) return fail('bad_args', op);
  const g = fpItemsGate(ctx, op);
  if (gated(g)) return g;
  const { mod, state } = g;
  const before = heldItems(op, mod, a.uuids);
  if (!Array.isArray(before)) return before;
  const kind = before[0].kind;
  if (before.some((i) => i.kind !== kind)) return fail('bad_args', `${op}: the items are of more than one kind`);
  const set = readItemSet(kind, a.set);
  if (set == null) return fail('bad_args', op);
  const why = itemSetMisfit(set, before);
  if (why != null) return fail('bad_args', `${op}: ${why}`);
  const t0 = Date.now();
  if (!callBool(mod, 'kicadFpEditItemsSet', JSON.stringify({ uuids: a.uuids, set }))) return fail('bad_args', op);
  const after = await readBack(ctx, changeMs(ctx), () => {
    const items = itemsOf(mod, a.uuids);
    if (items == null || items.length !== a.uuids.length) return null;
    if (items.every((i) => showsItemSet(set, i))) return items;
    const now = readFpOpenState(callText(mod, 'kicadFpEditState'));
    return now != null && now.depth > state.depth ? items : null;
  });
  if (after == null) return fail('not_applied', op);
  ctx.log(op, kind, Object.keys(set).join(' '), `${Date.now() - t0} ms`);
  return ok({ items: after });
}

/** fpedit.items.add: each new uuid none the footprint holds (bad_args "<uuid> is taken"); the engine's refusals answer bad_args; the answer is the new items read back. */
export async function fpItemsAdd(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const op = 'fpedit.items.add';
  const a = parseFpItemsAddArgs(args);
  if (a == null) return fail('bad_args', op);
  const g = fpItemsGate(ctx, op);
  if (gated(g)) return g;
  const { mod } = g;
  const all = allItems(mod);
  if (all == null) return fail('island_error', 'the engine answered items of another shape');
  const held = new Set(all.map((i) => i.uuid));
  const taken = a.items.find((n) => held.has(n.uuid));
  if (taken != null) return fail('bad_args', `${op}: ${taken.uuid} is taken`);
  const uuids = a.items.map((n) => n.uuid);
  const t0 = Date.now();
  if (!callBool(mod, 'kicadFpEditItemsAdd', JSON.stringify({ items: a.items }))) return fail('bad_args', op);
  const after = await readBack(ctx, changeMs(ctx), () => {
    const items = itemsOf(mod, uuids);
    return items != null && items.length === uuids.length ? items : null;
  });
  if (after == null) return fail('not_applied', op);
  ctx.log(op, a.items.length, `${Date.now() - t0} ms`);
  return ok({ items: after });
}

/** fpedit.items.remove: every uuid held (not_found), never the Reference or Value field (bad_args); the answer once none reads back. */
export async function fpItemsRemove(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const op = 'fpedit.items.remove';
  const a = parseFpItemsRemoveArgs(args);
  if (a == null) return fail('bad_args', op);
  const g = fpItemsGate(ctx, op);
  if (gated(g)) return g;
  const { mod } = g;
  const before = heldItems(op, mod, a.uuids);
  if (!Array.isArray(before)) return before;
  const kept = before.find((i) => i.kind === 'field' && (i.name === 'Reference' || i.name === 'Value'));
  if (kept != null && kept.kind === 'field') return fail('bad_args', `${op}: ${kept.name} is a field every footprint keeps`);
  if (!callBool(mod, 'kicadFpEditItemsRemove', JSON.stringify({ uuids: a.uuids }))) return fail('bad_args', op);
  const gone = await readBack(ctx, changeMs(ctx), () => {
    const items = allItems(mod);
    return items != null && !items.some((i) => a.uuids.includes(i.uuid)) ? true : null;
  });
  return gone == null ? fail('not_applied', op) : ok({ removed: a.uuids });
}

export default {
  unit: 'fp-i2a',
  frames: [FPEDIT_FRAME],
  frameRefusal: FPEDIT_FRAME_ONLY,
  ops: {
    'fpedit.items.get': { run: fpItemsGet, passesCheck: true },
    'fpedit.items.set': { run: fpItemsSet },
    'fpedit.items.add': { run: fpItemsAdd },
    'fpedit.items.remove': { run: fpItemsRemove },
  },
} satisfies ExtUnit;
