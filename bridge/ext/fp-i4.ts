// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// fp-i4 (PROTOCOL.md footprint.forEditor, footprint.push, footprint.convert):
// the footprint editor's board side and its file reader, through our engine's
// run 15 exports (pcbjam cc_e5_pcb.inc and cc_e5_dispatch.inc, unit fp-e7).
// kicadFootprintForEditor gives a placed footprint as KiCad's Load Footprint
// from Board copies it (the board's uuids kept, at the origin, front, angle 0);
// kicadFootprintPushToBoard takes an edited one back as KiCad's Save Footprint
// to Board does (ExchangeFootprint, nets by name, an optional relink, ONE
// commit "Update footprint"); kicadFootprintConvert reads a footprint file of
// another tool (or of KiCad 5) with KiCad's own readers. Every export is
// feature detected: on an engine without it the cap is not listed and the op
// answers unsupported naming the missing export.
import { readBoardItems, type FootprintSheet } from '../boardItem';
import { isFootprintId, UUID_RE } from '../symbol';
import { makeToken } from '../symedit';
import { fail, hasAll, isObj, ok, refused, type Answer, type ExtUnit, type ResponderCtx } from './contract';

/** The engine exports footprint.forEditor and footprint.push need (the push reads the part back through the board form's read). */
export const FOOTPRINT_EDIT_EXPORTS = ['kicadFootprintForEditor', 'kicadFootprintPushToBoard', 'kicadBoardItemGet', 'kicadCollabBusy'] as const;
/** The engine export footprint.convert needs. */
export const FOOTPRINT_CONVERT_EXPORTS = ['kicadFootprintConvert'] as const;
/** The caps: a pcb frame lists both, an fpedit frame footprintConvert alone. */
export const FOOTPRINT_EDIT_CAP = 'footprintEdit';
export const FOOTPRINT_CONVERT_CAP = 'footprintConvert';

/** footprint.convert takes a file of at most 25 MiB, written under a fresh folder of CONVERT_ROOT (the engine reads only there). */
export const CONVERT_MAX_BYTES = 25 * 1024 * 1024;
export const CONVERT_ROOT = '/tmp/cc-import';
/** The engine answers at most 2,000 footprints and 8 MiB of text; one footprint's text is at most 8 MiB. */
export const CONVERT_MAX_FOOTPRINTS = 2000;
export const FOOTPRINT_TEXT_MAX = 8 * 1024 * 1024;
/** A name, a lib id, a designator or a format the engine answers: at most this many characters. */
const NAME_MAX = 1024;
const FORMAT_MAX = 64;
/** A file name the island writes: 1 to 255 bytes of UTF-8, no slash, backslash or NUL, never "." or "..". */
const FILE_NAME_MAX = 255;
/** The message of an unreadable answer the engine gave without KiCad's own line. */
export const UNREADABLE_LINE = 'KiCad read no footprint from this file';

const FPEDIT_REFUSAL = 'a footprint editor opens footprints, not documents';
const FRAME_REFUSAL = 'footprints are read in a pcb or an fpedit frame';

const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
};
const utf8Bytes = (s: string): number => new TextEncoder().encode(s).byteLength;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
/** A short text the engine answers: 1 to `max` characters, no control character. */
const isName = (v: unknown, max = NAME_MAX): v is string => typeof v === 'string' && v !== '' && [...v].length <= max && !CONTROL_RE.test(v);
/** One footprint's text: 1 byte to 8 MiB of UTF-8, no NUL. */
const isFootprintText = (v: unknown): v is string => typeof v === 'string' && v !== '' && v.length <= FOOTPRINT_TEXT_MAX && !v.includes('\0') && utf8Bytes(v) <= FOOTPRINT_TEXT_MAX;
/** A text that starts (after white space) with `(footprint`: what KiCad's footprint reader takes. */
const isFootprintSexpr = (v: string): boolean => /^[ \t\r\n]*\(footprint[ \t\r\n"]/.test(v);
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
const isFrame = (ctx: ResponderCtx, name: string): boolean => (ctx.frame as string) === name;

export interface ForEditorArgs { uuid: string }
export interface ForEditor { name: string; libId: string; ref: string; text: string }
export interface PushArgs { uuid: string; text: string; libId: string }
export interface ConvertArgs { name: string; bytes: Uint8Array }
export type Converted = { format: string; footprints: Array<{ name: string; text: string }> } | { error: 'too_large' } | { error: 'unreadable'; message: string };

/** footprint.forEditor's args: exactly `{ uuid }`, a placed footprint's lowercase uuid; null for anything else. */
export function parseForEditorArgs(args: unknown): ForEditorArgs | null {
  if (!isObj(args) || !exactKeys(args, ['uuid']) || !isUuid(args.uuid)) return null;
  return { uuid: args.uuid };
}

/** kicadFootprintForEditor's answer read closed: `{ name, libId, ref, text }`; null for "" (no such footprint, refused) or any other shape. */
export function readForEditor(text: unknown): ForEditor | null {
  if (typeof text !== 'string' || text === '') return null;
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (!isObj(v) || !exactKeys(v, ['name', 'libId', 'ref', 'text'])) return null;
  if (!isName(v.name) || typeof v.libId !== 'string' || [...v.libId].length > NAME_MAX || CONTROL_RE.test(v.libId)) return null;
  if (typeof v.ref !== 'string' || [...v.ref].length > NAME_MAX || CONTROL_RE.test(v.ref) || !isFootprintText(v.text) || !isFootprintSexpr(v.text)) return null;
  return { name: v.name, libId: v.libId, ref: v.ref, text: v.text };
}

/**
 * footprint.push's args: exactly `{ uuid, text, libId }`: a placed
 * footprint's uuid, ONE `(footprint ...)` of at most 8 MiB, and `libId` ""
 * (the part keeps the footprint it names) or `lib:name` with both halves (the
 * part names that copy from now on). Null for anything else.
 */
export function parsePushArgs(args: unknown): PushArgs | null {
  if (!isObj(args) || !exactKeys(args, ['uuid', 'text', 'libId'])) return null;
  if (!isUuid(args.uuid) || !isFootprintText(args.text) || !isFootprintSexpr(args.text) || typeof args.libId !== 'string') return null;
  if (args.libId !== '' && (!isFootprintId(args.libId) || [...args.libId].length > NAME_MAX)) return null;
  return { uuid: args.uuid, text: args.text, libId: args.libId };
}

/** footprint.convert's args: exactly `{ name, bytes }`, a file name and its bytes (a Uint8Array of 1 byte to 25 MiB); null for anything else. */
export function parseConvertArgs(args: unknown): ConvertArgs | null {
  if (!isObj(args) || !exactKeys(args, ['name', 'bytes'])) return null;
  const { name, bytes } = args;
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..' || /[/\\\0]/.test(name) || utf8Bytes(name) > FILE_NAME_MAX) return null;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > CONVERT_MAX_BYTES) return null;
  return { name, bytes };
}

/**
 * kicadFootprintConvert's answer read closed: `{ format, footprints }` (at
 * most 2,000 footprints and 8 MiB of text, each a `(footprint ...)`),
 * `{ error: "too_large" }`, or `{ error: "unreadable", message? }` (KiCad's
 * line, cut to 1,024 characters, else UNREADABLE_LINE). Null for "" (refused)
 * or any other shape.
 */
export function readConverted(text: unknown): Converted | null {
  if (typeof text !== 'string' || text === '') return null;
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (!isObj(v)) return null;
  if (v.error === 'too_large' && exactKeys(v, ['error'])) return { error: 'too_large' };
  if (v.error === 'unreadable' && exactKeys(v, ['error'])) return { error: 'unreadable', message: UNREADABLE_LINE };
  if (v.error === 'unreadable' && exactKeys(v, ['error', 'message']) && typeof v.message === 'string') {
    const message = [...v.message].slice(0, NAME_MAX).join('');
    return { error: 'unreadable', message: message === '' ? UNREADABLE_LINE : message };
  }
  if (!exactKeys(v, ['format', 'footprints']) || !isName(v.format, FORMAT_MAX)) return null;
  if (!Array.isArray(v.footprints) || v.footprints.length > CONVERT_MAX_FOOTPRINTS) return null;
  const footprints: Array<{ name: string; text: string }> = [];
  let bytes = 0;
  for (const f of v.footprints as unknown[]) {
    if (!isObj(f) || !exactKeys(f, ['name', 'text']) || !isName(f.name) || !isFootprintText(f.text) || !isFootprintSexpr(f.text)) return null;
    bytes += utf8Bytes(f.text);
    if (bytes > FOOTPRINT_TEXT_MAX) return null;
    footprints.push({ name: f.name, text: f.text });
  }
  return { format: v.format, footprints };
}

/** The placed footprint `uuid` as the board form reads it (kicadBoardItemGet), null when the board holds no footprint by that uuid. */
function placedFootprint(mod: Record<string, unknown>, uuid: string): FootprintSheet | null {
  let items;
  try { items = readBoardItems((mod.kicadBoardItemGet as (json: string) => unknown)(JSON.stringify([uuid]))); } catch { return null; }
  const it = items?.find((i) => i.uuid === uuid);
  return it != null && it.kind === 'footprint' ? it : null;
}

const callText = (mod: Record<string, unknown>, name: string, arg: string): string => {
  try { return String((mod[name] as (a: string) => unknown)(arg) ?? ''); } catch { return ''; }
};
const callBool = (mod: Record<string, unknown>, name: string, arg: string): boolean => {
  try { return (mod[name] as (a: string) => unknown)(arg) === true; } catch { return false; }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** footprint.forEditor (a pcb frame): the placed footprint as KiCad's Load Footprint from Board copies it, as text. */
function forEditor(args: unknown, ctx: ResponderCtx): Answer {
  const op = 'footprint.forEditor';
  const a = parseForEditorArgs(args);
  if (a == null) return fail('bad_args', op);
  if (isFrame(ctx, 'fpedit')) return fail('unsupported', FPEDIT_REFUSAL);
  const g = ctx.boardGate(op, FOOTPRINT_EDIT_EXPORTS);
  if (refused(g)) return g;
  const got = readForEditor(callText(g.mod, 'kicadFootprintForEditor', JSON.stringify(a)));
  return got == null ? fail('not_found', a.uuid) : ok({ name: got.name, libId: got.libId, ref: got.ref, text: got.text });
}

/**
 * footprint.push (a pcb frame): KiCad's Save Footprint to Board of an edited
 * footprint (ExchangeFootprint: position, angle, side and the pads' nets by
 * name kept, a child of the placed footprint keeping its uuid), `libId`
 * relinking the part in the same commit: ONE undo step "Update footprint".
 * The answer is `{ uuid }` once the apply queue is empty and the part reads
 * back (with a libId, naming it).
 */
async function push(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const op = 'footprint.push';
  const a = parsePushArgs(args);
  if (a == null) return fail('bad_args', op);
  if (isFrame(ctx, 'fpedit')) return fail('unsupported', FPEDIT_REFUSAL);
  const g = ctx.boardGate(op, FOOTPRINT_EDIT_EXPORTS);
  if (refused(g)) return g;
  const { mod } = g;
  if (placedFootprint(mod, a.uuid) == null) return fail('not_found', a.uuid);
  const t0 = Date.now();
  if (!callBool(mod, 'kicadFootprintPushToBoard', JSON.stringify({ uuid: a.uuid, text: a.text, libId: a.libId, token: makeToken() }))) {
    return fail('bad_args', `${op}: the text holds no footprint KiCad reads`);
  }
  const ms = ctx.timing.symbolPushMs ?? 5_000;
  const poll = ctx.timing.applyPollMs ?? 10;
  const deadline = Date.now() + ms;
  for (;;) {
    if (ctx.closed()) return fail('not_applied', op);
    if (await ctx.applyIdle(Math.max(0, deadline - Date.now()))) {
      const after = placedFootprint(mod, a.uuid);
      if (after != null && (a.libId === '' || after.libId === a.libId)) {
        ctx.log(op, a.uuid, `${Date.now() - t0} ms`);
        return ok({ uuid: after.uuid });
      }
    }
    if (Date.now() >= deadline) return fail('not_applied', op);
    await sleep(poll);
  }
}

/**
 * footprint.convert (a pcb or an fpedit frame): the file is written under a
 * fresh /tmp/cc-import/<n>/, read by the engine's KiCad readers (a file of
 * many footprints, or one), and the folder removed. unreadable when no reader
 * takes it (message KiCad's line), too_large past 2,000 footprints or 8 MiB
 * of text.
 */
function convert(args: unknown, ctx: ResponderCtx): Answer {
  const op = 'footprint.convert';
  const a = parseConvertArgs(args);
  if (a == null) return fail('bad_args', op);
  if (!isFrame(ctx, 'pcb') && !isFrame(ctx, 'fpedit')) return fail('unsupported', FRAME_REFUSAL);
  const mod = ctx.mod();
  if (mod == null) return fail('not_ready', op);
  for (const name of FOOTPRINT_CONVERT_EXPORTS) if (typeof mod[name] !== 'function') return fail('unsupported', name);
  if (ctx.engineBusy() || ctx.keysBlocked()) return fail('busy', op);
  const FS = ctx.fs();
  if (FS == null) return fail('island_error', 'the engine has no file system');
  let dir: string;
  try {
    dir = ctx.freshRunFolder(CONVERT_ROOT);
    FS.writeFile(`${dir}/${a.name}`, a.bytes);
  } catch (err) {
    return fail('island_error', err instanceof Error ? err.message : String(err));
  }
  const t0 = Date.now();
  let raw: string;
  try {
    raw = callText(mod, 'kicadFootprintConvert', JSON.stringify({ path: `${dir}/${a.name}` }));
  } finally {
    ctx.dropRunFolder(dir);
  }
  const out = readConverted(raw);
  if (out == null) return fail('island_error', 'the engine answered a reading of another shape');
  if ('error' in out) return out.error === 'too_large' ? fail('too_large', op) : fail('unreadable', out.message);
  ctx.log(op, out.format, `${out.footprints.length} footprints`, `${Date.now() - t0} ms`);
  return ok({ format: out.format, footprints: out.footprints });
}

export default {
  unit: 'fp-i4',
  frames: ['pcb', 'fpedit'],
  frameRefusal: FRAME_REFUSAL,
  capNames: [FOOTPRINT_EDIT_CAP, FOOTPRINT_CONVERT_CAP],
  caps: (mod, frame) => {
    const out: string[] = [];
    if (frame === 'pcb' && hasAll(mod, FOOTPRINT_EDIT_EXPORTS)) out.push(FOOTPRINT_EDIT_CAP);
    if ((frame === 'pcb' || (frame as string) === 'fpedit') && hasAll(mod, FOOTPRINT_CONVERT_EXPORTS)) out.push(FOOTPRINT_CONVERT_CAP);
    return out;
  },
  ops: {
    'footprint.forEditor': { passesCheck: true, run: forEditor },
    'footprint.push': { run: push },
    'footprint.convert': { run: convert },
  },
} satisfies ExtUnit;
