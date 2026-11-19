// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// i-placebody (PROTOCOL.md place): place widened with `body`, a self
// contained kicad_symbol_lib the host sends with the request, so a part whose
// definition the host holds (a row of a design's HTTP source, given its name
// and fields by the host) is put on the pointer as `<lib>:<name>` with no
// symbol file behind its nickname, as KiCad's own HTTP source places it: the
// definition cached in the sheet, never read from lib.item. The blob is built
// by the same builder as the op that ships (loader/src/wasm/import-item.ts)
// and handed to the same engine export, kicadPlaceImportedItem, through
// bridge/place.ts's placeBlob, then joined to the responder's place watch:
// one item at a time, Escape drops it, a press commits it as one undo step.
// No engine change: the cap placeBody is listed in a sch frame whose engine
// has the place exports (run 14 has them).
import { buildInteractiveImport } from '../../loader/src/wasm/import-item';
import { parsePlaceArgs } from '../../src/picker';
import { placeBlob, type PlaceTiming } from '../place';
import { fail, hasAll, isObj, ok, type Answer, type ExtUnit, type ResponderCtx } from './contract';

/** The cap a host gates `place { body }` on. */
export const PLACE_BODY_CAP = 'placeBody';
/** The engine exports `place` uses (bridge/responder.ts placeItem), in the order the op names a missing one. */
export const PLACE_EXPORTS = ['kicadPlaceImportedItem', 'kicadCollabGetSelection'] as const;
/** A body's size bound in bytes as UTF-8: 4 MiB. */
export const PLACE_BODY_MAX_BYTES = 4 * 1024 * 1024;
/** The only frame a body places in. */
const FRAME = 'sch';
/** The builder's own words for a name the body does not hold (import-item.ts resolveSymbol). */
const NOT_IN_BODY = /^symbol ".*" not found in the library body$/;
/** The place watch's waits, when the bridge names none (bridge/responder.ts timing). */
const PLACE_TIMING: PlaceTiming = { placePollMs: 25, placeMs: 10_000, placeWatchMs: 100, placeCancelMs: 1_000 };

const timingOf = (ctx: ResponderCtx): PlaceTiming => ({
  placePollMs: ctx.timing.placePollMs ?? PLACE_TIMING.placePollMs,
  placeMs: ctx.timing.placeMs ?? PLACE_TIMING.placeMs,
  placeWatchMs: ctx.timing.placeWatchMs ?? PLACE_TIMING.placeWatchMs,
  placeCancelMs: ctx.timing.placeCancelMs ?? PLACE_TIMING.placeCancelMs,
});

/** The size of a string as UTF-8, counted without encoding it. */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

/** What a body request asks for, read closed: the place args, the body and the blob built from it (or the name the body lacks). */
export type BodyPlace = { lib: string; name: string; sexpr: string | null };

/**
 * place's args with `body`: the op's own args (parsePlaceArgs: `kind`, `lib`,
 * `name`, `value`, `footprint`, `mpn`, `manufacturer`) with `kind` "symbol",
 * and `lib` with no colon, and `body` a string of 1 to PLACE_BODY_MAX_BYTES
 * bytes whose first form is a kicad_symbol_lib. The blob is built here (the builder reads no engine):
 * a body the builder refuses (unbalanced, a parent outside it) is null
 * (bad_args); a body that holds no symbol of that name gives `sexpr: null`
 * (not_found, after the engine and document checks).
 */
export function readBodyPlace(args: Record<string, unknown>): BodyPlace | null {
  const { body, ...rest } = args;
  const a = parsePlaceArgs(rest);
  if (a == null || a.kind !== 'symbol') return null;
  // The placed part is <lib>:<name>, split by KiCad on the first colon: a nickname holds none.
  if (a.lib.includes(':')) return null;
  if (typeof body !== 'string' || body.length === 0 || utf8Bytes(body) > PLACE_BODY_MAX_BYTES) return null;
  if (!/^\s*\(\s*kicad_symbol_lib\b/.test(body)) return null;
  try {
    const built = buildInteractiveImport('symbol', body, a.lib, a.name, { value: a.value, footprint: a.footprint, mpn: a.mpn, manufacturer: a.manufacturer });
    return { lib: a.lib, name: a.name, sexpr: built.sexpr };
  } catch (err) {
    return NOT_IN_BODY.test(err instanceof Error ? err.message : '') ? { lib: a.lib, name: a.name, sexpr: null } : null;
  }
}

/**
 * place widened (PROTOCOL.md place): a request without `body` is the op as it
 * ships. With it, the checks, in order: the args (bad_args); the frame's kind
 * (unsupported outside a sch frame); the engine (not_ready, unsupported
 * naming a missing export); a document opened (not_ready); no load parked,
 * no popup menu and no dialog up (busy); the name in the body (not_found
 * naming lib:name). Then a hanging item of ours is dropped first, and the
 * blob goes to the engine; the answer comes once the item hangs off the
 * pointer, which the responder's place watch then follows.
 */
export async function placeWithBody(args: unknown, ctx: ResponderCtx, next: (args: unknown) => Promise<Answer>): Promise<Answer> {
  const op = 'place';
  if (!isObj(args) || !('body' in args)) return next(args);
  const a = readBodyPlace(args);
  if (a == null) return fail('bad_args', op);
  if (ctx.frame !== FRAME) return fail('unsupported', `a symbol does not place in a ${ctx.frame} frame`);
  const w = ctx.win();
  const mod = ctx.mod();
  if (w == null || mod == null) return fail('not_ready', op);
  const lacking = PLACE_EXPORTS.find((n) => typeof mod[n] !== 'function');
  if (lacking != null) return fail('unsupported', lacking);
  if (ctx.staged() == null || ctx.opened() == null) return fail('not_ready', op);
  if (ctx.engineBusy() || ctx.keysBlocked()) return fail('busy', op);
  if (a.sexpr == null) return fail('not_found', `${a.lib}:${a.name}`);
  // The editor places one item at a time: one still hanging is dropped first.
  if (!(await ctx.placeCancel())) return fail('busy', 'the previous item still hangs off the pointer');
  if (ctx.closed()) return fail('island_error', 'the frame closed');
  if (ctx.engineBusy() || ctx.keysBlocked()) return fail('busy', op);
  const placed = await placeBlob(w, a.sexpr, { timing: timingOf(ctx), closed: () => ctx.closed() });
  if (!placed.ok) return fail(placed.code, placed.message);
  ctx.log('[place]', `${a.lib}:${a.name}`, 'from its body');
  ctx.placeStart(placed.uuid);
  return ok();
}

export default {
  unit: 'i-placebody',
  frames: [FRAME],
  frameRefusal: 'a body places in a sch frame',
  capNames: [PLACE_BODY_CAP],
  caps: (mod, frame) => (frame === FRAME && hasAll(mod, PLACE_EXPORTS) ? [PLACE_BODY_CAP] : []),
  opsWidened: { place: placeWithBody },
} satisfies ExtUnit;
