// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// graphics.import (PROTOCOL.md, FP spec 10): a DXF or SVG drawing brought into
// the open document of a sch, pcb, symedit or fpedit frame by KiCad's own
// importer, with no window of KiCad's (engine run 15's kicadImportGraphics,
// unit fp-e8: DIALOG_IMPORT_GRAPHICS' body and the schematic dialog's, the
// half picked by the top frame). The drawing lands as ONE commit at a point
// (place "at"), or hangs on the pointer through KiCad's move tool (place
// "pointer": a click places it, Esc leaves nothing). The file's kind is read
// from its content, never its name: a DXF by its SECTION head, an SVG by its
// svg root; anything else answers not_a_drawing.
//
// KiCad's own Import Graphics (Ctrl+Shift+F) is held in a pcb and a sch frame
// under the cap importGraphics, so it sends ev.held and opens nothing; the
// symbol editor holds it already (bridge/held.ts) and the footprint editor
// asks the page with its `graphics` ask (fp-i2b, kicad cc/main fp-e1c).
// Everything is feature detected: on an engine without kicadImportGraphics no
// frame lists importGraphics and the op answers unsupported naming it.
import { fail, hasAll, isObj, ok, refused, type Answer, type ExtUnit, type ResponderCtx } from './contract';
import { FPEDIT_EXPORTS, FPEDIT_FRAME, fpEditGate, fpGated } from '../fpedit/common';
import { readState, SYMEDIT_EXPORTS } from '../symedit';
import { UUID_RE } from '../symbol';

/** The engine export and the op. */
export const IMPORT_EXPORT = 'kicadImportGraphics';
export const IMPORT_OP = 'graphics.import';
/** The pseudo-cap every frame that imports lists. */
export const IMPORT_CAP = 'importGraphics';
/** The exports a sch or pcb frame needs: the import and the apply queue probe. */
export const DOCUMENT_IMPORT_EXPORTS = [IMPORT_EXPORT, 'kicadCollabBusy'] as const;
/** What a symbol editor and a footprint editor need: the frame's own exports and the import. */
export const SYMEDIT_IMPORT_EXPORTS = [...SYMEDIT_EXPORTS, IMPORT_EXPORT] as const;
export const FPEDIT_IMPORT_EXPORTS = [...FPEDIT_EXPORTS, IMPORT_EXPORT] as const;
/** The frames a drawing imports into. */
export const IMPORT_FRAMES = ['sch', 'pcb', 'symedit', FPEDIT_FRAME] as const;
export const IMPORT_FRAME_ONLY = 'a drawing imports in a sch, pcb, symedit or fpedit frame';
/** KiCad's Import Graphics actions held here (the symbol editor's is held already, the footprint editor asks). */
export const HELD_BOARD = 'pcbnew.InteractiveDrawing.placeImportedGraphics';
export const HELD_SCHEMATIC = 'eeschema.EditorControl.importGraphics';

/** A drawing is 1 byte to 25 MB (the engine's bound). */
export const DRAWING_MAX_BYTES = 25_000_000;
/** The folder the frame writes a drawing under (outside the project folder, removed after each read). */
export const DRAWING_ROOT = '/tmp/cc-gfx';
/** How much of the file's start the content test reads. */
export const HEAD_BYTES = 64 * 1024;
/** The bounds of the numbers, in mm. */
export const SCALE_MIN = 0.0001;
export const SCALE_MAX = 10_000;
export const ORIGIN_MAX_MM = 2_000;
export const LINE_WIDTH_MAX_MM = 100;
export const TOLERANCE_MAX_MM = 100;
/** The engine answers at most 4,096 uuids and 64 warnings. */
export const UUIDS_MAX = 4096;
export const WARNINGS_MAX = 64;
const LINE_MAX = 1024;
const FILE_NAME_MAX = 255;
/** The line of an import that placed nothing when KiCad said nothing about it. */
export const NOTHING_READ = 'KiCad read nothing it can place from this drawing';

export const PLACES = ['at', 'pointer'] as const;
export const DXF_UNITS = ['mm', 'cm', 'inch', 'mil', 'feet'] as const;
export type DrawingKind = 'dxf' | 'svg';

/** The engine's args less `path`. */
export interface EngineImportArgs {
  place: typeof PLACES[number];
  layer?: string;
  scale?: number;
  origin?: [number, number];
  lineWidth?: number | null;
  dxfUnits?: typeof DXF_UNITS[number];
  group?: boolean;
  fixDiscontinuities?: boolean;
  tolerance?: number;
}
export interface ImportArgs { name: string; bytes: Uint8Array; engine: EngineImportArgs }
export interface Imported { items: number; uuids: string[]; warnings: string[] }

const KEYS = ['name', 'bytes', 'place', 'layer', 'scale', 'origin', 'lineWidth', 'dxfUnits', 'group', 'fixDiscontinuities', 'tolerance'];
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
/** A KiCad layer's canonical name ("Dwgs.User", "F.SilkS", "In1.Cu", "User.1"). */
const LAYER_RE = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;
const utf8Bytes = (s: string): number => new TextEncoder().encode(s).byteLength;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const within = (v: unknown, lo: number, hi: number): v is number => isNum(v) && v >= lo && v <= hi;
const among = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);

/**
 * graphics.import's args read closed: `name` (the file's name, 1 to 255 bytes
 * of UTF-8, no slash, backslash or NUL), `bytes` (a Uint8Array of 1 byte to
 * 25 MB), `place` ("at" or "pointer"), and the optional `layer`, `scale`,
 * `origin`, `lineWidth`, `dxfUnits`, `group`, `fixDiscontinuities` and
 * `tolerance` in their engine shapes. Null for anything else.
 */
export function parseImportArgs(args: unknown): ImportArgs | null {
  if (!isObj(args) || !Object.keys(args).every((k) => KEYS.includes(k))) return null;
  const { name, bytes, place } = args;
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..' || /[/\\\0]/.test(name) || CONTROL_RE.test(name) || utf8Bytes(name) > FILE_NAME_MAX) return null;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > DRAWING_MAX_BYTES) return null;
  if (!among(PLACES, place)) return null;
  const engine: EngineImportArgs = { place };
  if ('layer' in args) { if (typeof args.layer !== 'string' || !LAYER_RE.test(args.layer)) return null; engine.layer = args.layer; }
  if ('scale' in args) { if (!within(args.scale, SCALE_MIN, SCALE_MAX)) return null; engine.scale = args.scale; }
  if ('origin' in args) {
    const o = args.origin;
    if (!Array.isArray(o) || o.length !== 2 || !o.every((v) => within(v, -ORIGIN_MAX_MM, ORIGIN_MAX_MM))) return null;
    engine.origin = [o[0] as number, o[1] as number];
  }
  if ('lineWidth' in args) {
    const w = args.lineWidth;
    if (w !== null && !(isNum(w) && w > 0 && w <= LINE_WIDTH_MAX_MM)) return null;
    engine.lineWidth = w;
  }
  if ('dxfUnits' in args) { if (!among(DXF_UNITS, args.dxfUnits)) return null; engine.dxfUnits = args.dxfUnits; }
  for (const k of ['group', 'fixDiscontinuities'] as const) {
    if (k in args) { if (typeof args[k] !== 'boolean') return null; engine[k] = args[k] as boolean; }
  }
  if ('tolerance' in args) { if (!within(args.tolerance, 0, TOLERANCE_MAX_MM)) return null; engine.tolerance = args.tolerance; }
  return { name, bytes, engine };
}

const head = (bytes: Uint8Array, encoding: string): string => {
  let b = bytes.subarray(0, HEAD_BYTES);
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
  return new TextDecoder(encoding).decode(b);
};

/** A DXF by its head: after any 999 comment pairs, the first group is code 0 with the value SECTION. */
function isDxf(bytes: Uint8Array): boolean {
  const lines = head(bytes, 'latin1').split(/\r\n|\r|\n/).map((l) => l.trim());
  let i = 0;
  while (i < lines.length && lines[i] === '') i += 1;
  while (i + 1 < lines.length && lines[i] === '999') i += 2;
  return i + 1 < lines.length && /^0+$/.test(lines[i]) && lines[i + 1] === 'SECTION';
}

/** An SVG by its root: past the XML declaration, processing instructions, comments and a doctype, the first element is `svg`. */
function isSvg(bytes: Uint8Array): boolean {
  let s = head(bytes, 'utf-8');
  for (;;) {
    s = s.replace(/^\s+/, '');
    let end = -1;
    if (s.startsWith('<?')) end = s.indexOf('?>') + 2;
    else if (s.startsWith('<!--')) end = s.indexOf('-->') + 3;
    else if (/^<!DOCTYPE/i.test(s)) end = s.match(/^<!DOCTYPE[^[>]*(?:\[[\s\S]*?\])?\s*>/i)?.[0].length ?? -1;
    else break;
    if (end <= 0) return false;
    s = s.slice(end);
  }
  return /^<svg[\s/>]/.test(s);
}

/** The drawing's kind by its content, never its name: "dxf", "svg", or null for anything else. */
export function drawingKind(bytes: Uint8Array): DrawingKind | null {
  if (isDxf(bytes)) return 'dxf';
  if (isSvg(bytes)) return 'svg';
  return null;
}

/** The name the drawing is written under: the name's stem with the extension of its kind (KiCad picks its reader by the extension). */
export function drawingFileName(name: string, kind: DrawingKind): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return `${stem === '' || stem.startsWith('.') ? 'drawing' : stem}.${kind}`;
}

/** kicadImportGraphics' answer read closed: `{ items, uuids, warnings }`, null for "" (refused) or any other shape. */
export function readImported(text: unknown): Imported | null {
  if (typeof text !== 'string' || text === '') return null;
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (!isObj(v) || Object.keys(v).length !== 3 || !('items' in v) || !('uuids' in v) || !('warnings' in v)) return null;
  const { items, uuids, warnings } = v;
  if (!Number.isSafeInteger(items) || (items as number) < 0) return null;
  if (!Array.isArray(uuids) || uuids.length > UUIDS_MAX || uuids.length > (items as number) || !uuids.every((u) => typeof u === 'string' && UUID_RE.test(u))) return null;
  if (!Array.isArray(warnings) || warnings.length > WARNINGS_MAX || !warnings.every((w) => typeof w === 'string')) return null;
  return { items: items as number, uuids: uuids as string[], warnings: (warnings as string[]).map((w) => [...w].slice(0, LINE_MAX).join('')) };
}

/** The symbol editor's checks: the frame, the engine, busy, a symbol open. */
function symEditImportGate(ctx: ResponderCtx, op: string): Answer | { mod: Record<string, unknown> } {
  const mod = ctx.win() == null ? null : ctx.mod();
  if (mod == null) return fail('not_ready', op);
  for (const name of SYMEDIT_IMPORT_EXPORTS) if (typeof mod[name] !== 'function') return fail('unsupported', name);
  if (ctx.engineBusy() || ctx.keysBlocked()) return fail('busy', op);
  let state;
  try { state = readState((mod.kicadSymEditState as () => unknown)()); } catch { state = null; }
  if (state == null) return fail('island_error', 'the engine answered a state of another shape');
  if (!state.open) return fail('no_symbol', op);
  return { mod };
}

/**
 * The checks before any effect, in run A's order after the args: the frame,
 * the engine (not_ready, unsupported naming the first missing export), a
 * document open (not_ready in a sch or pcb frame, no_symbol, no_footprint),
 * busy while a load is parked, a popup or a dialog is up, or (sch, pcb) an
 * item hangs off the pointer.
 */
export function importGate(ctx: ResponderCtx, op: string): Answer | { mod: Record<string, unknown> } {
  const frame = ctx.frame as string;
  if (frame === 'pcb' || frame === 'sch') {
    const g = frame === 'pcb' ? ctx.boardGate(op, DOCUMENT_IMPORT_EXPORTS) : ctx.schematicGate(op, DOCUMENT_IMPORT_EXPORTS);
    return refused(g) ? g : { mod: g.mod };
  }
  if (frame === 'symedit') return symEditImportGate(ctx, op);
  if (frame === FPEDIT_FRAME) {
    const g = fpEditGate(ctx, op, true);
    if (fpGated(g)) return g;
    if (typeof g.mod[IMPORT_EXPORT] !== 'function') return fail('unsupported', IMPORT_EXPORT);
    return { mod: g.mod };
  }
  return fail('unsupported', IMPORT_FRAME_ONLY);
}

/**
 * graphics.import: the drawing written under a fresh /tmp/cc-gfx/<n>/ with
 * the extension of its kind, read and turned into items by KiCad's importer
 * (the folder removed right after: the engine reads it at once), then placed:
 * with "at" as ONE commit, answered once the apply queue is empty (else
 * not_applied); with "pointer" answered at once, the drawing hanging on the
 * pointer (in a sch or pcb frame joined to the place watch, so every gate
 * answers busy until a click or Esc ends it). unreadable when KiCad read
 * nothing it can place (its warnings, or NOTHING_READ), bad_args when the
 * importer refuses the args (a layer the document does not enable).
 */
export async function graphicsImport(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const op = IMPORT_OP;
  const a = parseImportArgs(args);
  if (a == null) return fail('bad_args', op);
  const g = importGate(ctx, op);
  if ('ok' in g) return g;
  const { mod } = g;
  const kind = drawingKind(a.bytes);
  if (kind == null) return fail('not_a_drawing', `${op}: the file is neither a DXF nor an SVG drawing`);
  const FS = ctx.fs();
  if (FS == null) return fail('island_error', 'the engine has no file system');
  let dir: string;
  let path: string;
  try {
    dir = ctx.freshRunFolder(DRAWING_ROOT);
    path = `${dir}/${drawingFileName(a.name, kind)}`;
    FS.writeFile(path, a.bytes);
  } catch (err) {
    return fail('island_error', err instanceof Error ? err.message : String(err));
  }
  const t0 = Date.now();
  let raw = '';
  try {
    raw = String((mod[IMPORT_EXPORT] as (json: string) => unknown)(JSON.stringify({ path, ...a.engine })) ?? '');
  } catch {
    raw = '';
  } finally {
    ctx.dropRunFolder(dir);
  }
  if (raw === '') return fail('bad_args', `${op}: KiCad's importer refused it (a layer this document does not enable, or the document cannot take a drawing now)`);
  const got = readImported(raw);
  if (got == null) return fail('island_error', 'the engine answered an import of another shape');
  if (got.items === 0) return fail('unreadable', got.warnings.length > 0 ? got.warnings.join(' ').slice(0, LINE_MAX) : NOTHING_READ);
  const answer = { items: got.items, uuids: got.uuids, warnings: got.warnings };
  if (a.engine.place === 'pointer') {
    const frame = ctx.frame as string;
    if ((frame === 'pcb' || frame === 'sch') && got.uuids.length > 0) ctx.placeStart(got.uuids[0]);
    ctx.log(op, kind, 'pointer', got.items, `${Date.now() - t0} ms`);
    return ok(answer);
  }
  if (!(await ctx.applyIdle(ctx.timing.symeditMs ?? 5_000))) return fail('not_applied', op);
  ctx.log(op, kind, 'at', got.items, `${Date.now() - t0} ms`);
  return ok(answer);
}

export default {
  unit: 'fp-i5',
  frames: [...IMPORT_FRAMES],
  frameRefusal: IMPORT_FRAME_ONLY,
  ops: { [IMPORT_OP]: { run: graphicsImport } },
  capNames: [IMPORT_CAP],
  caps: (mod, frame) => {
    const f = frame as string;
    const need = f === 'sch' || f === 'pcb' ? DOCUMENT_IMPORT_EXPORTS : f === 'symedit' ? SYMEDIT_IMPORT_EXPORTS : f === FPEDIT_FRAME ? FPEDIT_IMPORT_EXPORTS : null;
    return need != null && hasAll(mod, need) ? [IMPORT_CAP] : [];
  },
  held: [HELD_BOARD, HELD_SCHEMATIC],
  heldRows: [
    { action: HELD_BOARD, frames: ['pcb'], cap: IMPORT_CAP },
    { action: HELD_SCHEMATIC, frames: ['sch'], cap: IMPORT_CAP },
  ],
} satisfies ExtUnit;
