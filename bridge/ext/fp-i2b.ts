// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The footprint editor's asks, pad defaults and numbering (FP spec 6.2):
// fpedit.padDefaults.get and .set, the master pad KiCad gives every new pad
// (kicadFpEditPadDefaultsGet and Set, engine run 15); fpedit.enumerate,
// KiCad's own click in order pad numbering started with the page's numbers
// and no window (kicadFpEditEnumerate); and ev.fpedit, KiCad's footprint
// editor asking the page before each of its windows (kicadHostFpEdit,
// bridge/fpedit/ask.ts). Every op passes fp-i1's gate (feature detected on
// the engine's fpedit exports: on an engine without them each op answers
// unsupported naming the first missing export). The cap fpeditHeld is listed
// in an fpedit frame when the engine has every fpedit export and asks the
// page.
//
// Build T17 (engine item 5): the end of KiCad's pad numbering loop is told
// through the same slot's onNotice and sent as ev.fpeditNotice { notice,
// kept }; the cap fpeditNotice is listed beside fpeditHeld when the engine
// has the marker kicadHostFpEditEnumerateEnd.
import { fail, hasAll, isObj, noArgs, ok, type Answer, type ExtUnit, type ResponderCtx } from './contract';
import { readItemRecord, readItemSet, type PadRecord } from '../itemRecords';
import { callFpBool, callFpText, FPEDIT_EXPORTS, FPEDIT_FRAME, FPEDIT_FRAME_ONLY, fpEditGate, fpGated } from '../fpedit/common';
import {
  FPEDIT_ASK_EXPORT, FPEDIT_EVENT, FPEDIT_EVENT_KEYS, FPEDIT_HELD_CAP, FPEDIT_NOTICE_CAP, FPEDIT_NOTICE_EVENT, FPEDIT_NOTICE_EXPORT, FPEDIT_NOTICE_KEYS,
  installFpEditAsk, type FpEditAskWindow,
} from '../fpedit/ask';

/** What the asks need of the engine: every fpedit export and the marker. */
export const FPEDIT_ASK_EXPORTS = [...FPEDIT_EXPORTS, FPEDIT_ASK_EXPORT] as const;
/** What the numbering's end notice needs (build T17): the asks' exports and its own marker. */
export const FPEDIT_NOTICE_EXPORTS = [...FPEDIT_ASK_EXPORTS, FPEDIT_NOTICE_EXPORT] as const;
/** The master pad: a pad record with no kind and no uuid, positions from 0, 0. */
export type PadDefaults = Omit<PadRecord, 'kind' | 'uuid'>;
/** The numbers KiCad's numbering starts with (its Renumber Pads window's fields). */
export interface FpEnumerateArgs { start: number; step: number; prefix: string }
/** The window's ranges: a start and a step 0 to 999, a prefix of at most 64 characters. */
export const ENUMERATE_MAX = 999;
export const PREFIX_MAX = 64;

// A uuid for the reader only: the master pad has none.
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= ENUMERATE_MAX;

/** kicadFpEditPadDefaultsGet's answer read closed: every key of a pad record, no kind and no uuid. Null for "" or any other shape. */
export function readPadDefaults(text: unknown): PadDefaults | null {
  if (typeof text !== 'string' || text === '') return null;
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (!isObj(v) || 'kind' in v || 'uuid' in v) return null;
  const pad = readItemRecord('pad', { ...v, kind: 'pad', uuid: NIL_UUID });
  if (pad == null || pad.kind !== 'pad') return null;
  const { kind: _k, uuid: _u, ...rest } = pad;
  void _k; void _u;
  return rest;
}

/** fpedit.padDefaults.set's args: exactly `{ set }`, a non empty partial of a pad's keys read as a pad set is (itemRecords readItemSet). Null for anything else. */
export function parsePadDefaultsSetArgs(args: unknown): { set: Record<string, unknown> } | null {
  if (!isObj(args) || Object.keys(args).length !== 1 || !('set' in args)) return null;
  const set = readItemSet('pad', args.set);
  return set == null ? null : { set };
}

/** fpedit.enumerate's args: exactly `{ start, step, prefix }`, start and step whole numbers 0 to 999, prefix 0 to 64 characters with no control character. Null for anything else. */
export function parseEnumerateArgs(args: unknown): FpEnumerateArgs | null {
  if (!isObj(args) || Object.keys(args).length !== 3) return null;
  const { start, step, prefix } = args;
  if (!isCount(start) || !isCount(step) || typeof prefix !== 'string' || [...prefix].length > PREFIX_MAX || CONTROL_RE.test(prefix)) return null;
  return { start, step, prefix };
}

const padAnswer = (p: PadDefaults): Answer => ok(p as unknown as Record<string, unknown>);
const ODD_PAD = 'the engine answered a pad of another shape';

/** fpedit.padDefaults.get: the master pad, a footprint open or not. A read. */
export function fpPadDefaultsGet(args: unknown, ctx: ResponderCtx): Answer {
  const op = 'fpedit.padDefaults.get';
  if (!noArgs(args)) return fail('bad_args', op);
  const g = fpEditGate(ctx, op, false);
  if (fpGated(g)) return g;
  const pad = readPadDefaults(callFpText(g.mod, 'kicadFpEditPadDefaultsGet'));
  return pad == null ? fail('island_error', ODD_PAD) : padAnswer(pad);
}

/**
 * fpedit.padDefaults.set: the set onto the master pad by the pad window's own
 * rules (a refusal of KiCad's answers bad_args), at once, with no undo step
 * and the footprint not modified; a number given becomes the pad tool's
 * next. The answer is the master pad read back (KiCad's rules may reset a
 * key given, as on a pad).
 */
export function fpPadDefaultsSet(args: unknown, ctx: ResponderCtx): Answer {
  const op = 'fpedit.padDefaults.set';
  const a = parsePadDefaultsSetArgs(args);
  if (a == null) return fail('bad_args', op);
  const g = fpEditGate(ctx, op, false);
  if (fpGated(g)) return g;
  if (!callFpBool(g.mod, 'kicadFpEditPadDefaultsSet', JSON.stringify({ set: a.set }))) return fail('bad_args', `${op}: KiCad's pad rules refuse the set`);
  const pad = readPadDefaults(callFpText(g.mod, 'kicadFpEditPadDefaultsGet'));
  if (pad == null) return fail('island_error', ODD_PAD);
  ctx.log(op, Object.keys(a.set).join(' '));
  return padAnswer(pad);
}

/**
 * fpedit.enumerate: starts KiCad's own numbering on the open footprint with
 * the page's numbers and no window; the reader clicks or drags across the
 * pads, each taking the next number, and KiCad commits the run as ONE undo
 * step (ev.edited) on a double click or a tool change, Esc taking it back.
 * Answers `{}` as the loop starts (it does not wait for the reader).
 * bad_args for a footprint with no pads, busy in pad edit mode, not_applied
 * when KiCad does not start it.
 */
export function fpEnumerate(args: unknown, ctx: ResponderCtx): Answer {
  const op = 'fpedit.enumerate';
  const a = parseEnumerateArgs(args);
  if (a == null) return fail('bad_args', op);
  const g = fpEditGate(ctx, op, true);
  if (fpGated(g)) return g;
  if (g.state.padCount === 0) return fail('bad_args', `${op}: the footprint has no pads`);
  if (g.state.padEditMode) return fail('busy', `${op}: a pad is taken apart`);
  if (!callFpBool(g.mod, 'kicadFpEditEnumerate', JSON.stringify({ start: a.start, step: a.step, prefix: a.prefix }))) return fail('not_applied', op);
  ctx.log(op, a.start, a.step, a.prefix.length);
  return ok();
}

export default {
  unit: 'fp-i2b',
  frames: [FPEDIT_FRAME],
  frameRefusal: FPEDIT_FRAME_ONLY,
  ops: {
    'fpedit.padDefaults.get': { run: fpPadDefaultsGet, passesCheck: true },
    'fpedit.padDefaults.set': { run: fpPadDefaultsSet },
    'fpedit.enumerate': { run: fpEnumerate },
  },
  capNames: [FPEDIT_HELD_CAP, FPEDIT_NOTICE_CAP],
  caps: (mod, frame) => {
    if ((frame as string) !== FPEDIT_FRAME || !hasAll(mod, FPEDIT_ASK_EXPORTS)) return [];
    return hasAll(mod, FPEDIT_NOTICE_EXPORTS) ? [FPEDIT_HELD_CAP, FPEDIT_NOTICE_CAP] : [FPEDIT_HELD_CAP];
  },
  events: { [FPEDIT_EVENT]: FPEDIT_EVENT_KEYS, [FPEDIT_NOTICE_EVENT]: FPEDIT_NOTICE_KEYS },
  // KiCad's footprint editor asks the page before each of its windows (ev.fpedit),
  // once per request, after ev.ready while a footprint is open; it opens no window.
  install(ctx) {
    const w = ctx.win();
    if ((ctx.frame as string) !== FPEDIT_FRAME || w == null || !ctx.has(FPEDIT_ASK_EXPORTS)) return undefined;
    return installFpEditAsk(w as unknown as FpEditAskWindow, {
      admit: () => ctx.admit(),
      send: (a) => ctx.emitExt(FPEDIT_EVENT, { ask: a.ask, uuid: a.uuid, isNew: a.isNew }),
      // The numbering's end (build T17), only on an engine that tells it.
      ...(ctx.has([FPEDIT_NOTICE_EXPORT]) ? { notice: (n) => ctx.emitExt(FPEDIT_NOTICE_EVENT, { notice: n.notice, kept: n.kept }) } : {}),
    });
  },
} satisfies ExtUnit;
