// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// place.file (PROTOCOL.md, small tools spec 6.1): a file the design holds put
// on the pointer by KiCad's own Import Sheet (a sch frame) or Append Board (a
// pcb frame), with no file chooser and no window of KiCad's (engine run 15's
// kicadPlaceFromFile, unit st-placefile-e). The page has already written the
// file into the project folder under imports/ through project.write; the
// args name that project path, never bytes. The engine reads only a file
// directly inside a stage run folder, so the frame copies the file to a fresh
// /tmp/cc-stage/<n>/ (never the project folder), calls the export with that
// path, and removes the folder after the answer.
//
// A sheet is always placed as its contents: nothing here turns KiCad's place
// as sheet option on (RULINGS 34); a page wanting a sheet uses block.place
// with asSheet (i-block-place), which keeps its stage until the press.
//
// The answer comes once the items hang off the pointer (the selection holds a
// uuid it did not hold before the call); the placement is then joined to
// place's watch, so every gate answers busy until a click lands it as ONE
// commit or Esc leaves nothing.
//
// KiCad's own Import Sheet and Append Board are held under the cap placeFile,
// so each sends ev.held and opens nothing; the host opens its own Import card.
// Everything is feature detected: on an engine without kicadPlaceFromFile no
// frame lists placeFile and the op answers unsupported naming it.
import { fail, hasAll, isObj, ok, onlyKeys, refused, type Answer, type ExtUnit, type ResponderCtx } from './contract';
import { selection, tapRefusals } from '../place';

/** The engine export and the op. */
export const PLACE_FILE_EXPORT = 'kicadPlaceFromFile';
export const PLACE_FILE_OP = 'place.file';
/** The pseudo-cap a frame that places files lists. */
export const PLACE_FILE_CAP = 'placeFile';
/** The exports a frame needs: the placement and the selection read that tells the items hang. */
export const PLACE_FILE_EXPORTS = [PLACE_FILE_EXPORT, 'kicadCollabGetSelection'] as const;
/** KiCad's actions held here, each in its frame. */
export const HELD_IMPORT_SHEET = 'eeschema.InteractiveDrawing.importSheet';
export const HELD_APPEND_BOARD = 'pcbnew.EditorControl.appendBoard';
export const PLACE_FILE_FRAME_ONLY = 'a file places in a sch or pcb frame';

/** The kinds, each with its frame and its file extension. */
export const KINDS = { sheet: { frame: 'sch', extension: '.kicad_sch' }, board: { frame: 'pcb', extension: '.kicad_pcb' } } as const;
export type PlaceKind = keyof typeof KINDS;

/** A file is at most 25 MB (the engine's bound). */
export const PLACE_FILE_MAX_BYTES = 25_000_000;
/** The stage root the engine reads from (outside the project folder; each run's folder removed after its answer). */
export const STAGE_ROOT = '/tmp/cc-stage';
/** How long KiCad may take to put the items on the pointer (a large board loads first), unless the bridge's timing says placeFileMs. */
export const PLACE_FILE_MS = 30_000;
/** How often the selection is read meanwhile, unless the bridge's timing says placePollMs. */
export const PLACE_FILE_POLL_MS = 25;
/** A project path: at most this many bytes of UTF-8, each segment at most 255. */
const PATH_MAX = 1024;
const SEGMENT_MAX = 255;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const utf8Bytes = (s: string): number => new TextEncoder().encode(s).byteLength;

export interface PlaceFileArgs { kind: PlaceKind; name: string }

/** A path inside the project folder in its normal form: relative, segments joined by "/", none empty, "." or "..", no backslash or control character. */
export function isProjectPath(name: unknown): name is string {
  if (typeof name !== 'string' || name === '' || utf8Bytes(name) > PATH_MAX) return false;
  if (name.includes('\\') || CONTROL_RE.test(name)) return false;
  return name.split('/').every((s) => s !== '' && s !== '.' && s !== '..' && utf8Bytes(s) <= SEGMENT_MAX);
}

/**
 * place.file's args read closed: exactly `kind` ("sheet" or "board") and
 * `name` (a project path in its normal form whose extension is the kind's:
 * .kicad_sch for a sheet, .kicad_pcb for a board). Null for anything else.
 */
export function parsePlaceFileArgs(args: unknown): PlaceFileArgs | null {
  if (!isObj(args) || !onlyKeys(args, ['kind', 'name'])) return null;
  const { kind, name } = args;
  if (kind !== 'sheet' && kind !== 'board') return null;
  if (!isProjectPath(name)) return null;
  const base = name.slice(name.lastIndexOf('/') + 1);
  const ext = KINDS[kind].extension;
  if (!base.endsWith(ext) || base.length === ext.length) return null;
  return { kind, name };
}

/**
 * place.file: the checks in run A's order (the args, the frame and the kind's
 * frame, the engine, a document open, busy), then the file read from the
 * project folder (not_found when the folder holds none, too_large over 25 MB),
 * copied to a fresh /tmp/cc-stage/<n>/ and handed to kicadPlaceFromFile. The
 * answer is {} once the items hang off the pointer; busy when the engine
 * refuses the call (it cannot take a file now); not_applied when KiCad put
 * nothing on the pointer within the bound (the file holds no items, or KiCad
 * did not take it); island_error when the engine logged a refusal or the frame
 * closed. The stage folder is removed after every answer.
 */
export async function placeFile(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const op = PLACE_FILE_OP;
  const a = parsePlaceFileArgs(args);
  if (a == null) return fail('bad_args', op);
  const frame = ctx.frame as string;
  if (frame !== 'sch' && frame !== 'pcb') return fail('unsupported', PLACE_FILE_FRAME_ONLY);
  if (KINDS[a.kind].frame !== frame) return fail('bad_args', `${op}: a sheet places in a sch frame, a board in a pcb frame`);
  const g = frame === 'pcb' ? ctx.boardGate(op, PLACE_FILE_EXPORTS) : ctx.schematicGate(op, PLACE_FILE_EXPORTS);
  if (refused(g)) return g;
  const { w, mod } = g;

  const bytes = ctx.readBytes(`${ctx.root}/${a.name}`);
  if (bytes == null) return fail('not_found', a.name);
  if (bytes.byteLength > PLACE_FILE_MAX_BYTES) return fail('too_large', `${op}: ${a.name} is over 25 MB`);
  const before = selection(w);
  if (before == null) return fail('unsupported', 'kicadCollabGetSelection');
  const FS = ctx.fs();
  if (FS == null) return fail('island_error', 'the engine has no file system');

  let dir: string;
  let path: string;
  try {
    dir = ctx.freshRunFolder(STAGE_ROOT);
    path = `${dir}/${a.name.slice(a.name.lastIndexOf('/') + 1)}`;
    FS.writeFile(path, bytes);
  } catch (err) {
    return fail('island_error', err instanceof Error ? err.message : String(err));
  }

  const t0 = Date.now();
  const tap = tapRefusals(w);
  try {
    let taken: unknown = false;
    try { taken = (mod[PLACE_FILE_EXPORT] as (json: string) => unknown)(JSON.stringify({ kind: a.kind, path })); } catch { taken = false; }
    if (taken !== true) return fail('busy', `${op}: the editor cannot take a file now`);
    const ms = ctx.timing.placeFileMs ?? PLACE_FILE_MS;
    const poll = ctx.timing.placePollMs ?? PLACE_FILE_POLL_MS;
    const end = Date.now() + ms;
    for (;;) {
      if (ctx.closed()) return fail('island_error', 'the frame closed');
      const refusedLine = tap.first();
      if (refusedLine != null) return fail('island_error', refusedLine);
      const fresh = (selection(w) ?? []).find((u) => !before.includes(u));
      if (fresh != null) {
        ctx.placeStart(fresh);
        ctx.log(op, a.kind, 'on the pointer', `${Date.now() - t0} ms`);
        return ok({});
      }
      if (Date.now() >= end) return fail('not_applied', `${op}: KiCad put nothing on the pointer (the file holds no items, or KiCad did not take it)`);
      await new Promise((r) => setTimeout(r, poll));
    }
  } finally {
    tap.stop();
    ctx.dropRunFolder(dir);
  }
}

export default {
  unit: 'st-placefile-i',
  frames: ['sch', 'pcb'],
  frameRefusal: PLACE_FILE_FRAME_ONLY,
  ops: { [PLACE_FILE_OP]: { run: placeFile } },
  capNames: [PLACE_FILE_CAP],
  caps: (mod, frame) => ((frame === 'sch' || frame === 'pcb') && hasAll(mod, PLACE_FILE_EXPORTS) ? [PLACE_FILE_CAP] : []),
  held: [HELD_IMPORT_SHEET, HELD_APPEND_BOARD],
  heldRows: [
    { action: HELD_IMPORT_SHEET, frames: ['sch'], cap: PLACE_FILE_CAP },
    { action: HELD_APPEND_BOARD, frames: ['pcb'], cap: PLACE_FILE_CAP },
  ],
} satisfies ExtUnit;
