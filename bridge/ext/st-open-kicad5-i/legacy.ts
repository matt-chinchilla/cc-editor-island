// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// A KiCad 5 project (st-open-kicad5-i): project.import with `format` 'kicad5'
// in a sch frame. The engine's kicadImportLegacyProject (engine run 15) opens
// `<stem>.pro` with its root sheet `<stem>.sch` beside it (both spelled in lower
// case, as the engine reads them), remaps and rescues every symbol with no
// window, and saves the project as KiCad 10 files in the same folder
// (`<stem>.kicad_sch`, `.kicad_pro`, `sym-lib-table`, `<stem>-rescue.kicad_sym`).
// It answers a Promise of a boolean (RULINGS 18). This module imports nothing:
// bridge/import.ts (importCall) and the unit's widening both read it, and the
// widening must not load bridge/import.ts (its imports reach the frame
// registry, which loads the units).

export const LEGACY_FORMAT = 'kicad5';
export const LEGACY_PROJECT = '.pro';
export const LEGACY_SHEET = '.sch';
/** The export, and the root of the run folders it writes its record in (`<root>/<n>/.cc-legacy.json`). */
export const LEGACY_EXPORT = 'kicadImportLegacyProject';
export const LEGACY_RUN_ROOT = '/tmp/cc-legacy';
export const LEGACY_RECORD = '.cc-legacy.json';
/** The answer's warnings, as bridge/import.ts bounds them (MAX_WARNINGS, WARNING_CHARS). */
export const LEGACY_MAX_LINES = 40;
export const LEGACY_LINE_CHARS = 200;

/** The run folder the next KiCad 5 import call writes its record in; armed by the widening, taken once. */
let armed: string | null = null;
/** Names the run folder (`/tmp/cc-legacy/<n>`) the next KiCad 5 import writes its record in, or none (null). */
export function armLegacyRun(dir: string | null): void {
  armed = dir;
}
/** The armed run folder, once: a later call writes no record unless armed again. */
export function takeLegacyRun(): string | null {
  const dir = armed;
  armed = null;
  return dir;
}

const named = (path: string, ext: string): boolean => path.endsWith(ext) && path.length > ext.length && !path.endsWith(`/${ext}`);

/** The root sheet of a KiCad 5 project named by `open`: `<stem>.sch` for `<stem>.pro` or for that sheet itself; null for any other name. */
export function legacySheetOf(open: string): string | null {
  if (named(open, LEGACY_PROJECT)) return `${open.slice(0, -LEGACY_PROJECT.length)}${LEGACY_SHEET}`;
  if (named(open, LEGACY_SHEET)) return open;
  return null;
}

/** The project file beside a KiCad 5 root sheet: `<stem>.pro` for `<stem>.sch`. */
export function legacyProjectOf(sheet: string): string {
  return `${sheet.slice(0, -LEGACY_SHEET.length)}${LEGACY_PROJECT}`;
}

/** kicadImportLegacyProject's argument: `{ path }`, and `run` and `dir` when a run folder `/tmp/cc-legacy/<n>` is given. */
export function legacyCallArgs(path: string, dir: string | null): string {
  const run = dir == null || !dir.startsWith(`${LEGACY_RUN_ROOT}/`) ? NaN : Number(dir.slice(LEGACY_RUN_ROOT.length + 1));
  return JSON.stringify(dir != null && Number.isSafeInteger(run) && run >= 0 ? { path, run, dir } : { path });
}

/** One line of the engine's legacy record: KiCad's boxes and reports turned into lines. */
export type LegacyLine = { severity: string; text: string };
/** The engine's record of a KiCad 5 import, `.cc-legacy.json`. */
export type LegacyRecord = { opened: boolean; saved: boolean; files: string[]; lines: LegacyLine[] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Reads `.cc-legacy.json` closed: null for anything but its exact shape. */
export function readLegacyRecord(bytes: Uint8Array | null): LegacyRecord | null {
  if (bytes == null) return null;
  let r: unknown;
  try { r = JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; }
  if (!isRecord(r) || Object.keys(r).some((k) => !['opened', 'saved', 'files', 'lines'].includes(k))) return null;
  if (typeof r.opened !== 'boolean' || typeof r.saved !== 'boolean' || !Array.isArray(r.files) || !Array.isArray(r.lines)) return null;
  if (!r.files.every((f): f is string => typeof f === 'string')) return null;
  const lines: LegacyLine[] = [];
  for (const l of r.lines as unknown[]) {
    if (!isRecord(l) || typeof l.severity !== 'string' || typeof l.text !== 'string') return null;
    lines.push({ severity: l.severity, text: l.text });
  }
  return { opened: r.opened, saved: r.saved, files: r.files, lines };
}

/** Lines as an answer's warnings: whitespace folded, trimmed, cut, each once, in order, at most LEGACY_MAX_LINES. */
export function foldLines(texts: readonly string[]): string[] {
  const out: string[] = [];
  for (const t of texts) {
    const line = t.replace(/\s+/g, ' ').trim().slice(0, LEGACY_LINE_CHARS);
    if (line !== '' && !out.includes(line)) out.push(line);
    if (out.length >= LEGACY_MAX_LINES) break;
  }
  return out;
}

/**
 * The record's lines a reader is told: KiCad's warnings and errors (a library
 * the project names that the browser does not hold, a missing cache file),
 * never its per symbol rescue actions nor its information lines.
 */
export function legacyWarnings(record: LegacyRecord | null): string[] {
  if (record == null) return [];
  return foldLines(record.lines.filter((l) => l.severity === 'error' || l.severity === 'warning').map((l) => l.text));
}

/** The files the frame's own Save reports itself (every sheet, the project file) or never reports (the display settings). */
const SAVE_REPORTS = ['.kicad_sch', '.kicad_pro', '.kicad_prl'];

/**
 * The files the engine's import wrote that only it writes, as paths relative
 * to the project folder `root`: the symbol table (`sym-lib-table`) and every
 * table row's file (`<stem>-rescue.kicad_sym`, each migrated library), each
 * once, in the record's order. The sheets and the `.kicad_pro` are left out:
 * the frame's own Save after the import reports them. A path outside `root`,
 * or holding `..`, is never named.
 */
export function legacyTableFiles(record: LegacyRecord | null, root: string): string[] {
  if (record == null || !record.opened || !record.saved) return [];
  const out: string[] = [];
  for (const abs of record.files) {
    if (!abs.startsWith(`${root}/`)) continue;
    const rel = abs.slice(root.length + 1);
    if (rel === '' || rel.split('/').some((p) => p === '' || p === '.' || p === '..')) continue;
    if (SAVE_REPORTS.some((ext) => rel.endsWith(ext)) || out.includes(rel)) continue;
    out.push(rel);
  }
  return out;
}
