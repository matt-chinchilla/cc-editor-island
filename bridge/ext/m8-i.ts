// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// m8-i (PROTOCOL.md settings.read): the setup of ANOTHER design, read by
// KiCad and applied to nothing. The host brings that design's project file,
// and at most its board and its custom rules file; the frame stages them in a
// fresh /tmp/cc-settings-read/<n>/ (outside the project folder), and our
// engine's run 15 export kicadSettingsRead (unit m8-e) loads the other project
// with KiCad's own SETTINGS_MANAGER::LoadProject, its board with KiCad's own
// board reader, reads each asked section with the same readers settings.get
// uses, and unloads them again: nothing of the open design changes. The answer
// is { sections, missing }; the host applies what it wants with settings.set.
// The folder is removed after every answer. Feature detected: on an engine
// without the export the cap settingsRead is not listed and the op answers
// unsupported naming it.
import { fail, hasAll, isObj, ok, refused, type Answer, type ExtUnit, type ResponderCtx } from './contract';

/** The engine exports the read needs (queued on the apply coroutine, so the wait reads kicadCollabBusy). */
export const READ_EXPORTS = ['kicadSettingsRead', 'kicadCollabBusy'] as const;
/** The cap a host gates Take settings from another design on. */
export const SETTINGS_READ_CAP = 'settingsRead';
/** Where the other design is staged (the engine takes no other folder). */
export const READ_ROOT = '/tmp/cc-settings-read';
/** The record, then the done marker written last. */
export const READ_REPORT = 'settings-read.json';
export const READ_DONE = '.cc-settings-read.json';
/** The files of one read: 1 to 3, at most this many bytes together. */
export const FILES_MAX = 3;
export const BYTES_MAX = 25 * 1024 * 1024;
/** A file name: 1 to this many bytes of UTF-8 (the engine's bound on a plain name). */
export const FILE_NAME_MAX = 255;
/** The bound of one read when the bridge's timing names none. */
export const READ_MS = 60_000;
/** KiCad's message on an unreadable design: at most this many characters (the engine's bound). */
export const MESSAGE_MAX = 512;
/** A record of at most this many bytes is read. */
const RECORD_MAX = 32 * 1024 * 1024;
/** The kinds of file a read takes, by extension. */
export const FILE_KINDS = ['.kicad_pro', '.kicad_pcb', '.kicad_dru'] as const;
export type FileKind = (typeof FILE_KINDS)[number];
/**
 * The sections that travel (properties addendum 6.1: exactly KiCad's Import
 * Settings options), in that table's order. A board section asked in a sch
 * frame, or the reverse, comes back in `missing`: the host asks each frame for
 * its own.
 */
export const BOARD_READ_SECTIONS = [
  'layers', 'stackup', 'finish', 'zoneHatchOffsets', 'textDefaults', 'zoneDefaults', 'boardFormatting', 'constraints', 'predefinedSizes',
  'teardrops', 'tuningPatterns', 'netClasses', 'componentClasses', 'tuningProfiles', 'customRules', 'checkSeverities',
] as const;
export const SCH_READ_SECTIONS = [
  'schFormatting', 'annotation', 'fieldTemplates', 'bomPresets', 'ercSeverities', 'pinMap', 'netClasses', 'busAliases', 'textVariables',
] as const;
export const READ_SECTIONS: readonly string[] = [...new Set<string>([...BOARD_READ_SECTIONS, ...SCH_READ_SECTIONS])];
const FRAME_REFUSAL = 'settings.read runs in a sch or pcb frame';
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export interface ReadFile { name: string; bytes: Uint8Array }
export interface ReadArgs { project: ReadFile; board: ReadFile | null; rules: ReadFile | null; sections: string[] }
export interface ReadRecord { sections: Record<string, unknown>; missing: string[] }
export type ReadDone = { record: ReadRecord } | { error: 'unreadable' | 'island_error'; message: string } | { error: 'bad' };

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).length === keys.length && keys.every((k) => own(o, k));
const utf8Bytes = (s: string): number => new TextEncoder().encode(s).byteLength;
const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A JSON value with nothing JSON cannot carry. */
function plainJson(v: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every((x) => plainJson(x, depth + 1));
  if (isObj(v)) return Object.values(v).every((x) => plainJson(x, depth + 1));
  return false;
}

/** A file's kind by its name: a plain name (no folder, no control character, never "." or "..") with a stem and one of the three extensions; null otherwise. */
export function fileKindOf(name: unknown): FileKind | null {
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..' || /[/\\]/.test(name) || CONTROL_RE.test(name)) return null;
  if (utf8Bytes(name) > FILE_NAME_MAX) return null;
  return FILE_KINDS.find((k) => name.length > k.length && name.endsWith(k)) ?? null;
}

/**
 * settings.read's args: exactly `{ files, sections }`. `files` 1 to 3 of
 * exactly `{ name, bytes }` (a Uint8Array), one `.kicad_pro`, at most one
 * `.kicad_pcb` and one `.kicad_dru`, 25 MiB together; `sections` 1 to 64
 * unique names of the sections that travel. Null for anything else: no
 * project file, a name with a folder, two of a kind, another extension.
 */
export function parseReadArgs(args: unknown): ReadArgs | null {
  if (!isObj(args) || !exactKeys(args, ['files', 'sections'])) return null;
  const { files, sections } = args;
  if (!Array.isArray(files) || files.length < 1 || files.length > FILES_MAX) return null;
  if (!Array.isArray(sections) || sections.length < 1 || sections.length > 64) return null;
  if (!sections.every((s) => typeof s === 'string' && READ_SECTIONS.includes(s)) || new Set(sections).size !== sections.length) return null;
  const byKind = new Map<FileKind, ReadFile>();
  let total = 0;
  for (const f of files as unknown[]) {
    if (!isObj(f) || !exactKeys(f, ['name', 'bytes']) || !(f.bytes instanceof Uint8Array)) return null;
    const kind = fileKindOf(f.name);
    if (kind == null || byKind.has(kind)) return null;
    total += f.bytes.byteLength;
    if (total > BYTES_MAX) return null;
    byKind.set(kind, { name: f.name as string, bytes: f.bytes });
  }
  const project = byKind.get('.kicad_pro');
  if (project == null) return null;
  return { project, board: byKind.get('.kicad_pcb') ?? null, rules: byKind.get('.kicad_dru') ?? null, sections: [...sections as string[]] };
}

/**
 * The staged files, by the names the engine reads: the project and the board
 * under their own names, the custom rules beside the board under the board's
 * stem (KiCad reads `<board>.kicad_dru` beside its board), and no rules file
 * without a board (customRules is a board section).
 */
export function stagedFiles(a: ReadArgs): ReadFile[] {
  const out: ReadFile[] = [a.project];
  if (a.board != null) {
    out.push(a.board);
    if (a.rules != null) out.push({ name: `${a.board.name.slice(0, -'.kicad_pcb'.length)}.kicad_dru`, bytes: a.rules.bytes });
  }
  return out;
}

/** The args kicadSettingsRead reads, with the run's folder. */
export const readJson = (run: number, dir: string, a: ReadArgs): string =>
  JSON.stringify(a.board == null ? { run, dir, project: a.project.name, sections: a.sections } : { run, dir, project: a.project.name, board: a.board.name, sections: a.sections });

const jsonOf = (bytes: Uint8Array | null): unknown => {
  if (bytes == null || bytes.byteLength > RECORD_MAX) return undefined;
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return undefined; }
};

/**
 * settings-read.json read closed against the asked sections: exactly
 * `{ sections, missing }`, each asked name either a key of `sections` (its
 * value any JSON) or once in `missing`, never both, and nothing else; null
 * otherwise.
 */
export function readRecord(bytes: Uint8Array | null, asked: readonly string[]): ReadRecord | null {
  const v = jsonOf(bytes);
  if (!isObj(v) || !exactKeys(v, ['sections', 'missing']) || !isObj(v.sections) || !Array.isArray(v.missing)) return null;
  const read = Object.keys(v.sections);
  const missing = v.missing as unknown[];
  if (!missing.every((m) => typeof m === 'string' && asked.includes(m)) || new Set(missing).size !== missing.length) return null;
  if (!read.every((k) => asked.includes(k) && !missing.includes(k)) || read.length + missing.length !== asked.length) return null;
  if (!plainJson(v.sections)) return null;
  return { sections: { ...v.sections }, missing: [...missing as string[]] };
}

/** KiCad's message as the host gets it: its first line, the run folder taken out, at most 512 characters. */
export function cleanMessage(message: string, dir: string): string {
  const first = message.split(/\r?\n/)[0] ?? '';
  const out = first.split(`${dir}/`).join('').split(dir).join('').replace(/\/tmp\/cc-settings-read\/\d+\/?/g, '').trim();
  return [...out].slice(0, MESSAGE_MAX).join('');
}

/** The done marker, then (for a read) the record: what the run answered, null while the marker is not there. */
export function readDone(done: Uint8Array | null, record: Uint8Array | null, asked: readonly string[], dir: string): ReadDone | null {
  if (done == null) return null;
  const v = jsonOf(done);
  if (!isObj(v) || !exactKeys(v, ['error', 'message']) || typeof v.error !== 'string' || typeof v.message !== 'string') return { error: 'bad' };
  if (v.error === 'unreadable' || v.error === 'island_error') return { error: v.error, message: cleanMessage(v.message, dir) };
  if (v.error !== '') return { error: 'bad' };
  const read = readRecord(record, asked);
  return read == null ? { error: 'bad' } : { record: read };
}

/**
 * settings.read (a sch or pcb frame, a document open): the args, the frame's
 * own gate, the files staged in a fresh /tmp/cc-settings-read/<n>/, then the
 * read queued and its record taken once the apply queue is empty and the done
 * marker is there; the folder is removed whatever the answer.
 */
async function read(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const op = 'settings.read';
  const a = parseReadArgs(args);
  if (a == null) return fail('bad_args', op);
  const g = ctx.frame === 'pcb' ? ctx.boardGate(op, READ_EXPORTS) : ctx.schematicGate(op, READ_EXPORTS);
  if (refused(g)) return g;
  const FS = ctx.fs();
  if (FS == null) return fail('island_error', 'the engine has no file system');
  let dir: string;
  try { dir = ctx.freshRunFolder(READ_ROOT); } catch (err) { return fail('island_error', describe(err)); }
  try {
    try {
      for (const f of stagedFiles(a)) FS.writeFile(`${dir}/${f.name}`, f.bytes);
    } catch (err) {
      return fail('island_error', describe(err));
    }
    const run = Number(dir.slice(dir.lastIndexOf('/') + 1));
    const t0 = Date.now();
    let thrown: string | null = null;
    const got = await ctx.queuedRun(op, dir, ctx.timing.settingsReadMs ?? READ_MS,
      () => {
        try {
          return (g.mod.kicadSettingsRead as (json: string) => unknown)(readJson(run, dir, a));
        } catch (err) {
          thrown = describe(err);
          return false;
        }
      },
      () => readDone(ctx.readBytes(`${dir}/${READ_DONE}`), ctx.readBytes(`${dir}/${READ_REPORT}`), a.sections, dir));
    if (thrown != null) return fail('island_error', thrown);
    if (!('done' in got)) return got;
    const done = got.done;
    if ('record' in done) {
      ctx.log(op, `${Object.keys(done.record.sections).length} read`, `${done.record.missing.length} missing`, `${Date.now() - t0} ms`);
      return ok({ sections: done.record.sections, missing: done.record.missing });
    }
    if (done.error === 'unreadable') return fail('unreadable', done.message === '' ? 'KiCad could not read the other design' : done.message);
    if (done.error === 'island_error') return fail('island_error', done.message === '' ? op : done.message);
    return fail('island_error', 'the engine answered a read of another shape');
  } finally {
    ctx.dropRunFolder(dir);
  }
}

export default {
  unit: 'm8-i',
  frames: ['sch', 'pcb'],
  frameRefusal: FRAME_REFUSAL,
  capNames: [SETTINGS_READ_CAP],
  caps: (mod, frame) => ((frame === 'sch' || frame === 'pcb') && hasAll(mod, READ_EXPORTS) ? [SETTINGS_READ_CAP] : []),
  ops: {
    'settings.read': { run: read },
  },
} satisfies ExtUnit;
