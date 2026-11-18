// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// project.export (PROTOCOL.md): one output of the design made with no KiCad
// dialog, through our engine's kicadExportBoardOutput (a pcb frame) or
// kicadExportSchematicOutput (a sch frame), engine run 14. Each export takes
// KiCad's own job name and its settings JSON (a .kicad_jobset's), or one of our
// cc_* outputs, queues the job on the editor's apply coroutine and answers
// before it runs; the run writes .cc-export.json LAST in its folder, so the
// answer waits for the apply queue to empty and for that file, then reads the
// folder (one level of folders at most: Allegro's devices/, a .pretty).
// Modified by Circuit Center Inc on 2026-11-18: each job's time bound
// (exportMsFor, bridge/exportTiming.json) and the render's progress lines
// (EXPORT_LINES, renderPercent) for the 3D outputs.

import EXPORT_FACES from './exports.builtin.json';
import EXPORT_TIMING from './exportTiming.json';
import { runText, type RunLine, readLines } from './annotate';

/** A face: the frame kind a job runs in. */
export type ExportFace = 'pcb' | 'sch';
/** The engine exports each face's op needs: its export, the apply queue probe. */
export const EXPORT_EXPORTS: Readonly<Record<ExportFace, readonly string[]>> = Object.freeze({
  pcb: ['kicadExportBoardOutput', 'kicadCollabBusy'],
  sch: ['kicadExportSchematicOutput', 'kicadCollabBusy'],
});
/** The engine's list of the jobs it runs, with their defaults: read only by the e2e check. */
export const OUTPUT_JOBS_EXPORT = 'kicadOutputJobs';
/** Each run writes into a fresh folder under this one, outside the project folder. */
export const EXPORT_ROOT = '/tmp/cc-out';
/** The run's own record, written last (through a .part file): never answered as a file. */
export const EXPORT_DONE = '.cc-export.json';
/**
 * The lines the run reports while it goes, one per line as reported, beside
 * its record (engine run 15: the render's "Rendering <n> percent" lines).
 * Its name starts with the record's, so the folder read never answers it.
 */
export const EXPORT_LINES = `${EXPORT_DONE}.lines`;
/** A named job's bound is at least this and at most this (3D exports spec 8.3). */
export const MIN_JOB_MS = 60_000;
export const MAX_JOB_MS = 900_000;

/**
 * The time one run of `job` may take before it answers not_applied: the job's
 * own bound in bridge/exportTiming.json (five times its slowest measured run,
 * held between MIN_JOB_MS and MAX_JOB_MS), else the file's default.
 */
export function exportMsFor(job: string, timing: Readonly<Record<string, number>> = EXPORT_TIMING): number {
  const fallback = timing.default;
  if (job !== 'default' && Object.prototype.hasOwnProperty.call(timing, job) && Number.isFinite(timing[job])) {
    return Math.max(MIN_JOB_MS, Math.min(MAX_JOB_MS, timing[job]));
  }
  return fallback;
}

/** The last "Rendering <n> percent" line of a run's lines, as n held to 0 to 100; null when there is none. */
export function renderPercent(text: string): number | null {
  let last: number | null = null;
  for (const m of text.matchAll(/Rendering (\d{1,3}) percent/g)) last = Math.min(100, Number(m[1]));
  return last;
}

/** At most this many files in one answer, and this many bytes together (512 MiB). */
export const MAX_EXPORT_FILES = 1024;
export const MAX_EXPORT_BYTES = 512 * 1024 * 1024;
/** The args' bounds (outputs spec 7.1). */
export const MAX_SETTINGS = 128;
export const MAX_SETTING_TEXT = 1024;
export const MAX_SETTING_LIST = 256;
export const MAX_PAGES = 1024;
/** A page number: 1 to 32 bytes of UTF-8, the engine's own bound. */
export const MAX_PAGE_BYTES = 32;
/** At most this many dropped setting keys in an answer (one per sent key). */
export const MAX_DROPPED = MAX_SETTINGS;

/**
 * The jobs this island runs, each with its face (bridge/exports.json, outputs
 * spec 6.3): KiCad's registry names, then ours. scripts/build.mjs writes their
 * sorted names into island.json as `exportKinds`.
 */
export const EXPORT_JOBS: Readonly<Record<string, ExportFace>> = Object.freeze({ ...(EXPORT_FACES as Record<string, ExportFace>) });
/** The jobs that take `pages`: KiCad's schematic plots. */
export const PAGED_JOBS: readonly string[] = ['sch_export_plot_pdf', 'sch_export_plot_svg', 'sch_export_plot_dxf', 'sch_export_plot_ps'];

export type SettingValue = boolean | number | string | string[];
export interface ExportArgs { job: string; settings: Record<string, SettingValue>; pages?: string[] }
/** .cc-export.json: the run's exit code, every line it reported, the setting keys the job does not have. */
export interface ExportDone { code: number; lines: RunLine[]; dropped: string[] }
export interface ExportFile { path: string; bytes: Uint8Array }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPlain = (v: unknown): v is Record<string, unknown> => isObj(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const isText = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_SETTING_TEXT;
const utf8Bytes = (s: string): number => new TextEncoder().encode(s).byteLength;

function isSetting(v: unknown): v is SettingValue {
  if (typeof v === 'boolean' || isText(v)) return true;
  if (typeof v === 'number') return Number.isFinite(v);
  return Array.isArray(v) && v.length <= MAX_SETTING_LIST && v.every(isText);
}

/**
 * project.export's args: exactly `{ job, settings }` and, for a schematic plot
 * job only, `pages`; null for anything else. `job` is one of EXPORT_JOBS;
 * `settings` a plain object of at most 128 keys, each value a boolean, a
 * finite number, a string of at most 1,024 characters or a list of at most 256
 * such strings; `pages` at most 1,024 page numbers of 1 to 32 bytes.
 */
export function parseExportArgs(args: unknown, jobs: Readonly<Record<string, ExportFace>> = EXPORT_JOBS): ExportArgs | null {
  if (!isObj(args)) return null;
  const keys = Object.keys(args);
  if (!keys.every((k) => k === 'job' || k === 'settings' || k === 'pages') || !own(args, 'job') || !own(args, 'settings')) return null;
  const { job, settings, pages } = args;
  if (typeof job !== 'string' || !own(jobs, job)) return null;
  if (!isPlain(settings)) return null;
  const names = Object.keys(settings);
  if (names.length > MAX_SETTINGS || !names.every((k) => isSetting(settings[k]))) return null;
  const out: ExportArgs = { job, settings: Object.fromEntries(names.map((k) => { const v = settings[k] as SettingValue; return [k, Array.isArray(v) ? [...v] : v]; })) };
  if (own(args, 'pages')) {
    if (!PAGED_JOBS.includes(job) || !Array.isArray(pages) || pages.length > MAX_PAGES) return null;
    if (!(pages as unknown[]).every((p) => typeof p === 'string' && p !== '' && utf8Bytes(p) <= MAX_PAGE_BYTES)) return null;
    out.pages = [...(pages as string[])];
  }
  return out;
}

/** The face a job runs in. */
export const exportFace = (job: string, jobs: Readonly<Record<string, ExportFace>> = EXPORT_JOBS): ExportFace => jobs[job];

/** The args as the engine's export reads them: `{ run, dir, job, settings }`, and `pages` when sent. */
export const exportJson = (run: number, dir: string, a: ExportArgs): string =>
  JSON.stringify(a.pages === undefined ? { run, dir, job: a.job, settings: a.settings } : { run, dir, job: a.job, settings: a.settings, pages: a.pages });

/** .cc-export.json's bytes read closed: null when absent or of any other shape. */
export function readExportDone(bytes: Uint8Array | null): ExportDone | null {
  if (bytes == null) return null;
  let v: unknown;
  try { v = JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; }
  if (!isObj(v) || Object.keys(v).length !== 3 || !own(v, 'code') || !own(v, 'lines') || !own(v, 'dropped')) return null;
  if (!Number.isSafeInteger(v.code) || !Array.isArray(v.dropped) || v.dropped.length > MAX_DROPPED) return null;
  if (!(v.dropped as unknown[]).every((k) => typeof k === 'string' && k.length <= MAX_SETTING_TEXT)) return null;
  const lines = readLines(v.lines);
  return lines == null ? null : { code: v.code as number, lines, dropped: [...(v.dropped as string[])] };
}

/** The code the engine's own refusals end with (a 3D format other than VRML, VRML's empty scene): its line is the run's last. */
export const ENGINE_REFUSAL_CODE = -1;

/**
 * Why a finished run failed, or null when it did not (code 0): its first
 * error line; else, for the engine's own refusal (code -1), its last line
 * (the engine reports it as info: "Only VRML is made here.", "The VRML
 * exporter wrote no board (an empty scene)."); else the code. A KiCad job
 * that fails without an error line (the drill job's report, code 4) is never
 * answered by a line that says it went well. The run's folder taken out.
 */
export function exportFailure(done: ExportDone, dir: string): string | null {
  if (done.code === 0) return null;
  const line = done.lines.find((l) => l.severity === 'error') ?? (done.code === ENGINE_REFUSAL_CODE ? done.lines.at(-1) : undefined);
  return line != null ? kicadProblem(runText(line.text, dir)) : `the export ended with code ${done.code}`;
}

/**
 * KiCad's own sentence out of an IO_ERROR's text: its "IO_ERROR: " head and
 * the "from <file> : <function>() line <n>" of KiCad's source it ends with
 * are for a developer (Specctra DSN on Glasgow, measured on engine run 14:
 * "IO_ERROR: Multiple footprints have the reference designator 'REF**'.
 * from specctra_export.cpp : FromBOARD() line 1095"). Any other text as is.
 */
export function kicadProblem(text: string): string {
  const cut = text.replace(/^IO_ERROR:\s*/, '').replace(/\s*\bfrom\s+\S+\s*:\s*\S+\(\)\s+line\s+\d+\s*$/, '').trim();
  return cut === '' ? text : cut;
}

/** A Uint8Array that owns its whole buffer, safe to transfer (a view of a larger or shared buffer is copied). */
function owned(b: Uint8Array): Uint8Array {
  return b.byteOffset === 0 && b.byteLength === b.buffer.byteLength && b.buffer instanceof ArrayBuffer ? b : b.slice();
}

/** MEMFS with its link reads, which EmscriptenFS does not declare. */
type LinkFS = EmscriptenFS & { lstat?(path: string): { mode: number }; isLink?(mode: number): boolean };

/** Why a folder could not be answered: too many files or bytes, a folder in a folder, or a link. */
export type FolderRefusal = 'too_large' | 'too_deep' | 'link';

/**
 * Every file the run wrote in `dir`, by its path relative to `dir` (a name, or
 * one folder and a name), sorted, the run's record and its .part left out. A
 * folder inside a folder is `too_deep`, a link `link`; past MAX_EXPORT_FILES
 * or MAX_EXPORT_BYTES `too_large` (`limits` lets a test lower them). A folder
 * with nothing in it adds nothing.
 */
export function readExportFolder(FS: EmscriptenFS, dir: string, limits = { files: MAX_EXPORT_FILES, bytes: MAX_EXPORT_BYTES }): { files: ExportFile[] } | { error: FolderRefusal } {
  const fs = FS as LinkFS;
  const entries = (p: string): string[] => fs.readdir(p).filter((n) => n !== '.' && n !== '..');
  const isLink = (p: string): boolean => typeof fs.lstat === 'function' && typeof fs.isLink === 'function' && fs.isLink(fs.lstat(p).mode);
  const paths: string[] = [];
  for (const name of entries(dir)) {
    if (name === EXPORT_DONE || name.startsWith(`${EXPORT_DONE}.`)) continue;
    const abs = `${dir}/${name}`;
    if (isLink(abs)) return { error: 'link' };
    if (!fs.isDir(fs.stat(abs).mode)) { paths.push(name); continue; }
    for (const inner of entries(abs)) {
      const innerAbs = `${abs}/${inner}`;
      if (isLink(innerAbs)) return { error: 'link' };
      if (fs.isDir(fs.stat(innerAbs).mode)) return { error: 'too_deep' };
      paths.push(`${name}/${inner}`);
    }
  }
  paths.sort();
  if (paths.length > limits.files) return { error: 'too_large' };
  const files: ExportFile[] = [];
  let total = 0;
  for (const path of paths) {
    const b = fs.readFile(`${dir}/${path}`, { encoding: 'binary' });
    if (!(b instanceof Uint8Array)) throw new Error(`the export's ${path} did not read as bytes`);
    total += b.byteLength;
    if (total > limits.bytes) return { error: 'too_large' };
    files.push({ path, bytes: owned(b) });
  }
  return { files };
}
