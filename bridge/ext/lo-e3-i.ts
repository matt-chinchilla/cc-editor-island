// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// lo-e3-i (PROTOCOL.md settings.set, the stackup section): Board Setup's Add
// Dielectric Layer and Remove Dielectric Layer, with no KiCad window. A
// settings.set of the stackup section may carry exactly one of
// { addDielectric: { after } } and { removeDielectric: { index, sub } } in place
// of { rows }: the forms engine run 15 takes (lo-e3s-e, BOARD_STACKUP_ITEM's own
// AddDielectricPrms and RemoveDielectricPrms). The engine says it takes them by
// naming the section stackupLayers in kicadSettingsSections(); the cap
// settings:stackupLayers is listed exactly then, and on any other engine the
// forms answer unsupported naming what is missing. Every other form of
// settings.set goes on to the op as it ships.
import { fail, isObj, type Answer, type ExtUnit, type ResponderCtx } from './contract';

/** The engine marker that lists the settings sections it takes (engine run 15). */
export const SECTIONS_EXPORT = 'kicadSettingsSections';
/** The section name the marker lists when the stackup set takes the dielectric forms. */
export const STACKUP_LAYERS = 'stackupLayers';
/** The cap a host reads before it shows Add and Remove on the stackup list. */
export const STACKUP_LAYERS_CAP = `settings:${STACKUP_LAYERS}`;
/** The two dielectric forms of a stackup set. */
export const DIELECTRIC_KEYS = ['addDielectric', 'removeDielectric'] as const;
/** A stackup item index: the stackup section reads at most 256 rows, so no index reaches this. */
export const MAX_STACKUP_INDEX = 255;

export type DielectricValue = { addDielectric: { after: number } } | { removeDielectric: { index: number; sub: number } };

const OP = 'settings.set';
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const plain = (v: unknown): v is Record<string, unknown> =>
  isObj(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(o).length === keys.length && keys.every((k) => own(o, k));
const indexOf = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= MAX_STACKUP_INDEX;

/** A settings.set request whose stackup value names a dielectric form (well formed or not). */
export function asksDielectric(args: unknown): boolean {
  if (!isObj(args) || args.section !== 'stackup' || !isObj(args.value)) return false;
  return DIELECTRIC_KEYS.some((k) => own(args.value as Record<string, unknown>, k));
}

/**
 * A stackup value read closed: exactly one key, `addDielectric` with exactly
 * `{ after }` or `removeDielectric` with exactly `{ index, sub }`, each an
 * integer from 0 to 255. Null for anything else.
 */
export function parseDielectricValue(value: unknown): DielectricValue | null {
  if (!plain(value) || Object.keys(value).length !== 1) return null;
  const add = value.addDielectric;
  if (own(value, 'addDielectric')) {
    if (!plain(add) || !exactKeys(add, ['after']) || !indexOf(add.after)) return null;
    return { addDielectric: { after: add.after } };
  }
  const remove = value.removeDielectric;
  if (own(value, 'removeDielectric')) {
    if (!plain(remove) || !exactKeys(remove, ['index', 'sub']) || !indexOf(remove.index) || !indexOf(remove.sub)) return null;
    return { removeDielectric: { index: remove.index, sub: remove.sub } };
  }
  return null;
}

/** The whole request read closed: exactly `{ section: "stackup", value, dryRun? }`, the value a dielectric form. */
export function parseDielectricSet(args: unknown): { section: 'stackup'; value: DielectricValue; dryRun?: boolean } | null {
  if (!plain(args) || !Object.keys(args).every((k) => k === 'section' || k === 'value' || k === 'dryRun')) return null;
  if (args.section !== 'stackup' || !own(args, 'value')) return null;
  if (own(args, 'dryRun') && typeof args.dryRun !== 'boolean') return null;
  const value = parseDielectricValue(args.value);
  if (value == null) return null;
  return typeof args.dryRun === 'boolean' ? { section: 'stackup', value, dryRun: args.dryRun } : { section: 'stackup', value };
}

/**
 * The board sections the engine says it takes: kicadSettingsSections()
 * answers `{ board: [names], schematic: [names] }`. Null when the engine has
 * no such marker or answers another shape (a throw included).
 */
export function boardSections(mod: Record<string, unknown> | null | undefined): string[] | null {
  const read = mod?.[SECTIONS_EXPORT];
  if (typeof read !== 'function') return null;
  let v: unknown;
  try { v = JSON.parse(String((read as () => unknown)())); } catch { return null; }
  if (!isObj(v) || !Array.isArray(v.board) || !v.board.every((s) => typeof s === 'string')) return null;
  return v.board as string[];
}

/** The engine's stackup set takes the dielectric forms. */
export const takesDielectrics = (mod: Record<string, unknown> | null | undefined): boolean =>
  boardSections(mod)?.includes(STACKUP_LAYERS) === true;

/**
 * The widening of settings.set: a dielectric form is checked closed
 * (bad_args), then, in a pcb frame with the engine up, refused unsupported
 * unless the engine takes it (naming the marker when it is missing, the
 * section when the marker does not list it); then it goes to the op as it
 * ships, which makes every other check (the frame, a board open, busy) and
 * the set itself. Anything else goes to the op untouched.
 */
export async function widenSettingsSet(args: unknown, ctx: ResponderCtx, next: (args: unknown) => Promise<Answer>): Promise<Answer> {
  if (!asksDielectric(args)) return next(args);
  const a = parseDielectricSet(args);
  if (a == null) return fail('bad_args', OP);
  const mod = ctx.mod();
  if (ctx.frame === 'pcb' && mod != null) {
    if (typeof mod[SECTIONS_EXPORT] !== 'function') return fail('unsupported', SECTIONS_EXPORT);
    if (!takesDielectrics(mod)) return fail('unsupported', STACKUP_LAYERS);
  }
  return next(a);
}

export default {
  unit: 'lo-e3-i',
  frames: ['pcb'],
  opsWidened: { 'settings.set': widenSettingsSet },
  capNames: [STACKUP_LAYERS_CAP],
  caps: (mod, frame) => (frame === 'pcb' && takesDielectrics(mod) ? [STACKUP_LAYERS_CAP] : []),
} satisfies ExtUnit;
