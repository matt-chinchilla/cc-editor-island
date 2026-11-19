// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// m13-i (PROTOCOL.md embedded.get, embedded.set, embedded.extract): the files a
// design keeps inside its own board or schematic file (KiCad's EMBEDDED_FILES:
// fonts, 3D models, drawing sheets, datasheets), read, added, removed and taken
// out with no KiCad window, in both document frames, over engine run 15's
// kicadEmbeddedFilesGet, kicadEmbeddedFilesSet and kicadEmbeddedFileExtract
// (unit m13-e). The cap designEmbedded is listed exactly when the engine has
// them; on any other engine each op answers unsupported naming the export.
import { fail, hasAll, isObj, noArgs, ok, refused, type Answer, type ExtUnit, type Gated, type ResponderCtx } from './contract';

/** The cap a host reads before it shows Setup's Embedded files with its controls live. */
export const EMBEDDED_CAP = 'designEmbedded';
export const GET_EXPORT = 'kicadEmbeddedFilesGet';
export const SET_EXPORT = 'kicadEmbeddedFilesSet';
export const EXTRACT_EXPORT = 'kicadEmbeddedFileExtract';
export const BUSY_EXPORT = 'kicadCollabBusy';
/** Every export the three ops need: the cap is listed only when all are there. */
export const EMBEDDED_EXPORTS = [GET_EXPORT, SET_EXPORT, EXTRACT_EXPORT, BUSY_EXPORT] as const;
const GET_EXPORTS = [GET_EXPORT] as const;
const SET_EXPORTS = [GET_EXPORT, SET_EXPORT, BUSY_EXPORT] as const;
const EXTRACT_EXPORTS = [GET_EXPORT, EXTRACT_EXPORT] as const;

/** An added file is staged under a fresh folder of EMBED_ROOT (the engine reads only there); the set's record is written last in it. */
export const EMBED_ROOT = '/tmp/cc-embed';
export const SET_RECORD = 'embedded.json';
/** An extract writes the file, then its record, in a fresh folder of EXTRACT_ROOT. */
export const EXTRACT_ROOT = '/tmp/cc-embed-out';
export const EXTRACT_RECORD = '.cc-embed-out.json';
/** A file added or taken out is at most 25 MiB (the engine's own bound). */
export const EMBED_MAX_BYTES = 25 * 1024 * 1024;
/** An embedded file's name: 1 to 255 characters, no slash or backslash, never "." or "..". */
export const EMBED_NAME_MAX = 255;
/** The engine lists at most this many files, and this answer carries at most as many fonts. */
export const EMBEDDED_FILES_MAX = 1024;
export const EMBEDDED_FONTS_MAX = 1024;
/** KiCad's kinds of an embedded file. */
export const EMBED_TYPES = ['font', 'model', 'worksheet', 'datasheet', 'other'] as const;
export type EmbedType = typeof EMBED_TYPES[number];

const FRAME_REFUSAL = 'the design\'s embedded files are kept in a sch or a pcb frame';

export interface EmbeddedFile { name: string; type: EmbedType; bytes: number; heldBy: number }
export interface EmbeddedFont { name: string; embedded: boolean }
/** kicadEmbeddedFilesGet's answer, and the answer of embedded.get and embedded.set. */
export interface EmbeddedRead { owner: 'board' | 'schematic'; fontsEmbedded: boolean; files: EmbeddedFile[]; fonts: EmbeddedFont[] }

export type EmbeddedSetArgs =
  | { op: 'add'; name: string; type: EmbedType; bytes: Uint8Array }
  | { op: 'remove'; name: string; alsoHeld: boolean }
  | { op: 'fonts'; embed: boolean };

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(o).length === keys.length && keys.every((k) => own(o, k));
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isType = (v: unknown): v is EmbedType => typeof v === 'string' && (EMBED_TYPES as readonly string[]).includes(v);
/** A name a request may carry: 1 to 255 characters, no slash or backslash, never "." or "..". */
export const isEmbedName = (v: unknown): v is string =>
  typeof v === 'string' && v.length >= 1 && v.length <= EMBED_NAME_MAX && v !== '.' && v !== '..' && !/[/\\]/.test(v);

/** The engine's read, closed: exactly the four keys, each file and font of its shape, at most 1,024 of each. Null for anything else. */
export function readEmbedded(text: string): EmbeddedRead | null {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (!isObj(v) || !exactKeys(v, ['owner', 'fontsEmbedded', 'files', 'fonts'])) return null;
  if ((v.owner !== 'board' && v.owner !== 'schematic') || typeof v.fontsEmbedded !== 'boolean') return null;
  if (!Array.isArray(v.files) || v.files.length > EMBEDDED_FILES_MAX || !Array.isArray(v.fonts) || v.fonts.length > EMBEDDED_FONTS_MAX) return null;
  const files: EmbeddedFile[] = [];
  for (const f of v.files as unknown[]) {
    if (!isObj(f) || !exactKeys(f, ['name', 'type', 'bytes', 'heldBy'])) return null;
    if (typeof f.name !== 'string' || f.name === '' || !isType(f.type) || !isCount(f.bytes) || !isCount(f.heldBy)) return null;
    files.push({ name: f.name, type: f.type, bytes: f.bytes, heldBy: f.heldBy });
  }
  const fonts: EmbeddedFont[] = [];
  for (const f of v.fonts as unknown[]) {
    if (!isObj(f) || !exactKeys(f, ['name', 'embedded']) || typeof f.name !== 'string' || typeof f.embedded !== 'boolean') return null;
    fonts.push({ name: f.name, embedded: f.embedded });
  }
  return { owner: v.owner, fontsEmbedded: v.fontsEmbedded, files, fonts };
}

/**
 * embedded.set's args, closed: exactly `{ op: "add", name, type, bytes }` (a
 * name of 1 to 255 characters, no slash or backslash, never "." or ".."; one of
 * KiCad's five kinds; the file's bytes, a Uint8Array of 1 byte to 25 MiB),
 * `{ op: "remove", name, alsoHeld }` or `{ op: "fonts", embed }` (booleans).
 * Null for anything else.
 */
export function parseEmbeddedSetArgs(args: unknown): EmbeddedSetArgs | null {
  if (!isObj(args)) return null;
  if (args.op === 'add') {
    if (!exactKeys(args, ['op', 'name', 'type', 'bytes']) || !isEmbedName(args.name) || !isType(args.type)) return null;
    const { bytes } = args;
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > EMBED_MAX_BYTES) return null;
    return { op: 'add', name: args.name, type: args.type, bytes };
  }
  if (args.op === 'remove') {
    if (!exactKeys(args, ['op', 'name', 'alsoHeld']) || !isEmbedName(args.name) || typeof args.alsoHeld !== 'boolean') return null;
    return { op: 'remove', name: args.name, alsoHeld: args.alsoHeld };
  }
  if (args.op === 'fonts') {
    if (!exactKeys(args, ['op', 'embed']) || typeof args.embed !== 'boolean') return null;
    return { op: 'fonts', embed: args.embed };
  }
  return null;
}

/** embedded.extract's args: exactly `{ name }`; null for anything else. */
export function parseExtractArgs(args: unknown): { name: string } | null {
  return isObj(args) && exactKeys(args, ['name']) && isEmbedName(args.name) ? { name: args.name } : null;
}

/** The set's record (embedded.json): `{ files, error }`, error "" or the engine's word. Null until it is whole. */
export function readSetRecord(bytes: Uint8Array | null): { error: string } | null {
  if (bytes == null) return null;
  let v: unknown;
  try { v = JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; }
  return isObj(v) && Array.isArray(v.files) && typeof v.error === 'string' ? { error: v.error } : null;
}

/** The extract's record (.cc-embed-out.json): `{ name, bytes, error }`. Null for another shape. */
export function readExtractRecord(bytes: Uint8Array | null): { name: string; bytes: number; error: string } | null {
  if (bytes == null) return null;
  let v: unknown;
  try { v = JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; }
  return isObj(v) && typeof v.name === 'string' && isCount(v.bytes) && typeof v.error === 'string' ? { name: v.name, bytes: v.bytes, error: v.error } : null;
}

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The document frame's own gate: a board's in a pcb frame, a schematic's in a sch frame. */
function gate(ctx: ResponderCtx, op: string, exports: readonly string[]): Gated {
  if (ctx.frame === 'pcb') return ctx.boardGate(op, exports);
  if (ctx.frame === 'sch') return ctx.schematicGate(op, exports);
  return fail('unsupported', FRAME_REFUSAL);
}

/** The document's embedded files now: busy while the engine answers "" (a load, a dialog), island_error for another shape. */
function readNow(mod: Record<string, unknown>, op: string): EmbeddedRead | Answer {
  let text: unknown;
  try { text = (mod[GET_EXPORT] as () => unknown)(); } catch (err) { return fail('island_error', describe(err)); }
  if (text === '') return fail('busy', op);
  const read = typeof text === 'string' ? readEmbedded(text) : null;
  return read ?? fail('island_error', 'the engine answered embedded files of another shape');
}
const isAnswer = (v: EmbeddedRead | Answer): v is Answer => 'ok' in v;

/** embedded.get: the open document's embedded files, the fonts it draws with and whether they are kept inside. A read. */
export function embeddedGet(args: unknown, ctx: ResponderCtx): Answer {
  const op = 'embedded.get';
  if (!noArgs(args)) return fail('bad_args', op);
  const g = gate(ctx, op, GET_EXPORTS);
  if (refused(g)) return g;
  const read = readNow(g.mod, op);
  return isAnswer(read) ? read : ok({ ...read });
}

/** Whether `read` shows the asked change. */
function shows(a: EmbeddedSetArgs, read: EmbeddedRead): boolean {
  if (a.op === 'add') return read.files.some((f) => f.name === a.name);
  if (a.op === 'remove') return !read.files.some((f) => f.name === a.name);
  return read.fontsEmbedded === a.embed;
}

/**
 * embedded.set: an add stages the file in a fresh /tmp/cc-embed/<n>/ and asks
 * the engine to keep it in the document (a file of that name replaced); a
 * remove takes one out (with `alsoHeld`, from the footprints or symbols that
 * carry it as well; not_found naming it when the document holds none); fonts
 * sets whether the document keeps its fonts inside (and with `embed` adds the
 * fonts it draws with now). No undo step (KiCad's Setup makes none), the
 * document marked modified. The answer is the read once the engine's record
 * is there and the read shows the change; the folder is removed in every case.
 */
export async function embeddedSet(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const op = 'embedded.set';
  const a = parseEmbeddedSetArgs(args);
  if (a == null) return fail('bad_args', op);
  const g = gate(ctx, op, SET_EXPORTS);
  if (refused(g)) return g;
  const { mod } = g;
  const before = readNow(mod, op);
  if (isAnswer(before)) return before;
  if (a.op === 'remove' && !before.files.some((f) => f.name === a.name)) return fail('not_found', a.name);
  const FS = ctx.fs();
  if (FS == null) return fail('island_error', 'the engine has no file system');
  let dir: string;
  try {
    dir = ctx.freshRunFolder(EMBED_ROOT);
  } catch (err) {
    return fail('island_error', describe(err));
  }
  const run = Number(dir.slice(dir.lastIndexOf('/') + 1));
  let json: string;
  if (a.op === 'add') {
    const path = `${dir}/${a.name}`;
    try {
      FS.writeFile(path, a.bytes);
    } catch (err) {
      ctx.dropRunFolder(dir);
      return fail('island_error', describe(err));
    }
    json = JSON.stringify({ run, dir, op: 'add', path, name: a.name, type: a.type });
  } else if (a.op === 'remove') {
    json = JSON.stringify({ run, dir, op: 'remove', name: a.name, alsoHeld: a.alsoHeld });
  } else {
    json = JSON.stringify({ run, dir, op: 'fonts', embed: a.embed });
  }
  const t0 = Date.now();
  let accepted: unknown;
  try {
    accepted = (mod[SET_EXPORT] as (j: string) => unknown)(json);
  } catch (err) {
    ctx.dropRunFolder(dir);
    return fail('island_error', describe(err));
  }
  if (accepted !== true) {
    ctx.dropRunFolder(dir);
    return a.op === 'add' ? fail('bad_args', `${op}: KiCad refused the file`) : fail('not_applied', op);
  }
  const done = await ctx.queuedRun(op, dir, ctx.timing.applyMs ?? 30_000, () => true, () => readSetRecord(ctx.readBytes(`${dir}/${SET_RECORD}`)));
  ctx.dropRunFolder(dir);
  if (!('done' in done)) return done;
  if (done.done.error !== '') return fail('not_applied', op);
  const after = readNow(mod, op);
  if (isAnswer(after)) return after;
  if (!shows(a, after)) return fail('not_applied', op);
  ctx.log(op, a.op, `${Date.now() - t0} ms`);
  return ok({ ...after });
}

/**
 * embedded.extract: the named file's bytes as KiCad holds them (decompressed),
 * written by the engine into a fresh /tmp/cc-embed-out/<n>/ and read back; the
 * buffer is transferred and the folder removed. not_found naming it when the
 * document holds no such file, too_large past 25 MiB. A read.
 */
export function embeddedExtract(args: unknown, ctx: ResponderCtx): Answer {
  const op = 'embedded.extract';
  const a = parseExtractArgs(args);
  if (a == null) return fail('bad_args', op);
  const g = gate(ctx, op, EXTRACT_EXPORTS);
  if (refused(g)) return g;
  const { mod } = g;
  const read = readNow(mod, op);
  if (isAnswer(read)) return read;
  const file = read.files.find((f) => f.name === a.name);
  if (file == null) return fail('not_found', a.name);
  if (file.bytes > EMBED_MAX_BYTES) return fail('too_large', a.name);
  let dir: string;
  try {
    dir = ctx.freshRunFolder(EXTRACT_ROOT);
  } catch (err) {
    return fail('island_error', describe(err));
  }
  try {
    let wrote: unknown;
    try {
      wrote = (mod[EXTRACT_EXPORT] as (j: string) => unknown)(JSON.stringify({ dir, name: a.name }));
    } catch (err) {
      return fail('island_error', describe(err));
    }
    if (wrote !== true) return fail('not_applied', op);
    const record = readExtractRecord(ctx.readBytes(`${dir}/${EXTRACT_RECORD}`));
    if (record == null) return fail('island_error', 'the engine wrote no record of the extract');
    if (record.error !== '') return fail('not_applied', `${op}: ${record.error}`);
    const body = ctx.readBytes(`${dir}/${a.name}`);
    if (body == null || body.byteLength !== record.bytes || body.byteLength > EMBED_MAX_BYTES) {
      return fail('island_error', 'the extracted file is not the size its record names');
    }
    const bytes = body.slice();
    return { ok: true, result: { name: a.name, bytes }, transfer: [bytes.buffer] };
  } finally {
    ctx.dropRunFolder(dir);
  }
}

export default {
  unit: 'm13-i',
  frames: ['sch', 'pcb'],
  frameRefusal: FRAME_REFUSAL,
  capNames: [EMBEDDED_CAP],
  caps: (mod, frame) => ((frame === 'sch' || frame === 'pcb') && hasAll(mod, EMBEDDED_EXPORTS) ? [EMBEDDED_CAP] : []),
  ops: {
    'embedded.get': { passesCheck: true, run: embeddedGet },
    'embedded.set': { run: embeddedSet },
    'embedded.extract': { passesCheck: true, run: embeddedExtract },
  },
} satisfies ExtUnit;
