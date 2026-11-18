// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-ses-i (PROTOCOL.md board.session): a router's Specctra session read into
// the open board through our engine's run 15 export kicadImportSession (pcbjam
// cc_e9_pcb.inc, unit st-ses-e, K-SES). A preview loads the session and counts
// it against the board with nothing changed; an apply reads it as ONE commit
// "Import Specctra Session" (one undo step). The session's bytes are staged
// under a fresh /tmp/cc-stage/<n>/ (never the project folder: a session never
// joins the design here), the run writes its records under a fresh
// /tmp/cc-session/<n>/, and both folders are removed after the answer. KiCad's
// own Import Specctra Session is held (ev.held) so the host opens its own
// card. Feature detected: on an engine without the export the cap is not
// listed and the op answers unsupported naming it.
import { readLines } from '../annotate';
import { fail, hasAll, isObj, ok, refused, type Answer, type ExtUnit, type HeldRow, type ResponderCtx } from './contract';

/** The engine exports board.session needs (the run is queued on the apply coroutine, so the wait reads kicadCollabBusy). */
export const SESSION_EXPORTS = ['kicadImportSession', 'kicadCollabBusy'] as const;
/** The cap a host gates the door on. */
export const SESSION_CAP = 'session';
/** KiCad's own File > Import > Specctra Session, held in a pcb frame. */
export const IMPORT_SESSION = 'pcbnew.EditorControl.importSpecctraSession';
export const SESSION_ROW: HeldRow = Object.freeze({ action: IMPORT_SESSION, frames: Object.freeze(['pcb'] as const), cap: SESSION_CAP });

/** Where the session's bytes are staged, and where the engine's run writes its records (it reads no other run folder). */
export const STAGE_ROOT = '/tmp/cc-stage';
export const SESSION_ROOT = '/tmp/cc-session';
/** A session file of at most 25 MiB. */
export const SESSION_MAX_BYTES = 25 * 1024 * 1024;
/** The engine names at most 256 missing nets. */
export const MISSING_NETS_MAX = 256;
/** The message of a refused parse the engine gave without KiCad's own line. */
export const UNREADABLE_SESSION = 'KiCad read no session from this file';
/** The bound of one run when the bridge's timing names none. */
const SESSION_MS = 60_000;
const LINE_MAX = 1024;
const NAME_MAX = 1024;
const FILE_NAME_MAX = 255;
const RECORD = '.cc-session.json';
const REPORT = 'session.json';
const FRAME_REFUSAL = 'a router session is read in a pcb frame';

export interface SessionArgs { name: string; bytes: Uint8Array; preview: boolean }
export interface Counted { tracks: number; vias: number }
/** The answer (PROTOCOL.md SessionReport): `removed` and `added` on an apply only. */
export interface SessionReport {
  preview: boolean; tracks: number; vias: number; nets: number; missingNets: string[];
  removed?: Counted; added?: Counted; undoCleared: boolean; depth: number;
}
export type SessionDone = { report: SessionReport } | { error: 'session_invalid' | 'island_error'; message: string } | { error: 'bad' };

const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
};
const utf8Bytes = (s: string): number => new TextEncoder().encode(s).byteLength;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isNetName = (v: unknown): v is string => typeof v === 'string' && v !== '' && [...v].length <= NAME_MAX && !CONTROL_RE.test(v);
const isCounted = (v: unknown): v is Counted => isObj(v) && exactKeys(v, ['tracks', 'vias']) && isCount(v.tracks) && isCount(v.vias);

/**
 * board.session's args: exactly `{ name, bytes, preview }`: a file name ending
 * `.ses` (any case; 1 to 255 bytes of UTF-8, no slash, backslash, NUL or
 * control character, a stem of its own), its bytes (a Uint8Array of 1 byte to
 * 25 MiB) and a boolean. Null for anything else.
 */
export function parseSessionArgs(args: unknown): SessionArgs | null {
  if (!isObj(args) || !exactKeys(args, ['name', 'bytes', 'preview'])) return null;
  const { name, bytes, preview } = args;
  if (typeof name !== 'string' || !/^.*[^.].*\.ses$/i.test(name) || name.length < 5 || /[/\\]/.test(name) || CONTROL_RE.test(name) || utf8Bytes(name) > FILE_NAME_MAX) return null;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > SESSION_MAX_BYTES) return null;
  if (typeof preview !== 'boolean') return null;
  return { name, bytes, preview };
}

/** The staged file's name: the reader's own, its extension written `.ses` (the engine takes that ending only). */
const stagedName = (name: string): string => `${name.slice(0, -4)}.ses`;

/**
 * The run's records read closed. `done` is `.cc-session.json`, written LAST
 * (`{ error, message, lines }`); `report` is `session.json`. Null while the
 * done record is not there yet. `error` "" needs the report of THIS run and
 * form: `{ run, preview, tracks, vias, nets, missingNets (at most 256),
 * undoCleared, depth, lines }`, plus `removed` and `added` on an apply.
 * `{ error: 'bad' }` for any other shape.
 */
export function readSessionDone(done: Uint8Array | null, report: Uint8Array | null, run: number, preview: boolean): SessionDone | null {
  if (done == null) return null;
  const json = (b: Uint8Array): unknown => { try { return JSON.parse(new TextDecoder().decode(b)); } catch { return undefined; } };
  const d = json(done);
  if (!isObj(d) || !exactKeys(d, ['error', 'message', 'lines']) || typeof d.message !== 'string' || readLines(d.lines) == null) return { error: 'bad' };
  if (d.error === 'session_invalid' || d.error === 'island_error') return { error: d.error, message: d.message };
  if (d.error !== '' || report == null) return { error: 'bad' };
  const r = json(report);
  const base = ['run', 'preview', 'tracks', 'vias', 'nets', 'missingNets', 'undoCleared', 'depth', 'lines'];
  if (!isObj(r) || !exactKeys(r, preview ? base : [...base, 'removed', 'added'])) return { error: 'bad' };
  if (r.run !== run || r.preview !== preview || readLines(r.lines) == null) return { error: 'bad' };
  if (!isCount(r.tracks) || !isCount(r.vias) || !isCount(r.nets) || !isCount(r.depth) || typeof r.undoCleared !== 'boolean') return { error: 'bad' };
  if (!Array.isArray(r.missingNets) || r.missingNets.length > MISSING_NETS_MAX || !r.missingNets.every(isNetName)) return { error: 'bad' };
  const out: SessionReport = { preview, tracks: r.tracks, vias: r.vias, nets: r.nets, missingNets: [...(r.missingNets as string[])], undoCleared: r.undoCleared, depth: r.depth };
  if (!preview) {
    if (!isCounted(r.removed) || !isCounted(r.added)) return { error: 'bad' };
    out.removed = { tracks: r.removed.tracks, vias: r.removed.vias };
    out.added = { tracks: r.added.tracks, vias: r.added.vias };
  }
  return { report: out };
}

/**
 * KiCad's line as the host reads it: the first line only, no folder of the
 * frame named (the staging and run folders taken out, and any other run
 * folder under /tmp/cc-*), at most 1,024 characters; ours when KiCad gave none.
 */
export function sessionLine(message: string, dirs: readonly string[]): string {
  let line = message.split(/\r?\n/)[0] ?? '';
  for (const dir of dirs) line = line.split(`${dir}/`).join('').split(dir).join('');
  line = line.replace(/\/tmp\/cc-[a-z0-9-]+\/\d+\/?/g, '').trim();
  return line === '' ? UNREADABLE_SESSION : [...line].slice(0, LINE_MAX).join('');
}

/**
 * board.session (a pcb frame, a board open): the checks (bad_args, then the
 * board gate: the frame, the engine's exports, a board open, busy), then the
 * session staged, the run queued and its records read once the apply queue
 * is empty. Both folders are removed whatever the answer. An apply that moved
 * the undo depth is reported by the responder's own ev.edited.
 */
async function session(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const op = 'board.session';
  const a = parseSessionArgs(args);
  if (a == null) return fail('bad_args', op);
  const g = ctx.boardGate(op, SESSION_EXPORTS);
  if (refused(g)) return g;
  const FS = ctx.fs();
  if (FS == null) return fail('island_error', 'the engine has no file system');
  const folders: string[] = [];
  try {
    let stage: string;
    let dir: string;
    try {
      stage = ctx.freshRunFolder(STAGE_ROOT);
      folders.push(stage);
      FS.writeFile(`${stage}/${stagedName(a.name)}`, a.bytes);
      dir = ctx.freshRunFolder(SESSION_ROOT);
      folders.push(dir);
    } catch (err) {
      return fail('island_error', err instanceof Error ? err.message : String(err));
    }
    const run = Number(dir.slice(dir.lastIndexOf('/') + 1));
    const t0 = Date.now();
    let thrown: string | null = null;
    const got = await ctx.queuedRun(op, dir, ctx.timing.sessionMs ?? SESSION_MS,
      () => {
        try {
          return (g.mod.kicadImportSession as (json: string) => unknown)(JSON.stringify({ run, dir, path: `${stage}/${stagedName(a.name)}`, preview: a.preview }));
        } catch (err) {
          thrown = err instanceof Error ? err.message : String(err);
          return false;
        }
      },
      () => readSessionDone(ctx.readBytes(`${dir}/${RECORD}`), ctx.readBytes(`${dir}/${REPORT}`), run, a.preview));
    if (thrown != null) return fail('island_error', thrown);
    if (!('done' in got)) return got;
    const done = got.done;
    if ('report' in done) {
      ctx.log(op, a.preview ? 'preview' : 'apply', `${done.report.tracks} tracks`, `${done.report.vias} vias`, `${Date.now() - t0} ms`);
      return ok({ ...done.report });
    }
    if (done.error === 'bad') return fail('island_error', 'the engine answered a session of another shape');
    if (done.error === 'session_invalid') return fail('session_invalid', sessionLine(done.message, folders));
    return fail('island_error', sessionLine(done.message, folders));
  } finally {
    for (const f of folders) ctx.dropRunFolder(f);
  }
}

export default {
  unit: 'st-ses-i',
  frames: ['pcb'],
  frameRefusal: FRAME_REFUSAL,
  capNames: [SESSION_CAP],
  caps: (mod, frame) => (frame === 'pcb' && hasAll(mod, SESSION_EXPORTS) ? [SESSION_CAP] : []),
  held: [IMPORT_SESSION],
  heldRows: [SESSION_ROW],
  ops: {
    'board.session': { run: session },
  },
} satisfies ExtUnit;
