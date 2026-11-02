// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// project.plot (PROTOCOL.md): the board's Gerbers and drill files plotted with
// no KiCad dialog, through our engine's kicadPlotBoard (pcbjam cc/main 924d67c,
// engine run 7). The export runs KiCad's own JOB_EXPORT_PCB_GERBERS and
// JOB_EXPORT_PCB_DRILL on the editor's apply coroutine and answers before they
// run; the run writes .cc-plot.json LAST in its folder, so the answer waits for
// the apply queue to empty and for that file, then reads the folder whole.

/** The engine exports the op needs: the plot, the apply queue probe. */
export const PLOT_EXPORTS = ['kicadPlotBoard', 'kicadCollabBusy'] as const;
/** Each plot writes into a fresh folder under this one, outside the project folder. */
export const PLOT_ROOT = '/tmp/cc-plot';
/** The run's own record, written last: the signal that the folder is complete. Never answered as a file. */
export const PLOT_DONE = '.cc-plot.json';
/** At most this many files in one answer. */
export const MAX_PLOT_FILES = 128;
/** At most this many bytes in one answer, every file together (512 MiB). */
export const MAX_PLOT_BYTES = 512 * 1024 * 1024;

export type PlotPreset = 'fab' | 'board';
export interface PlotArgs { preset: PlotPreset; drill: boolean; job: boolean }
export type PlotSeverity = 'error' | 'warning' | 'info' | 'action';
export interface PlotLine { severity: PlotSeverity; text: string }
/** .cc-plot.json: each job's exit code (drill null when not asked) and every line the jobs reported, in order. */
export interface PlotDone { gerbers: number; drill: number | null; lines: PlotLine[] }
export interface PlotFile { path: string; bytes: Uint8Array }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const SEVERITIES: readonly string[] = ['error', 'warning', 'info', 'action'];

/** project.plot's args: exactly `{ preset, drill, job }`; null for anything else. */
export function parsePlotArgs(args: unknown): PlotArgs | null {
  if (!isObj(args)) return null;
  const keys = Object.keys(args);
  if (keys.length !== 3 || !['preset', 'drill', 'job'].every((k) => keys.includes(k))) return null;
  if (args.preset !== 'fab' && args.preset !== 'board') return null;
  if (typeof args.drill !== 'boolean' || typeof args.job !== 'boolean') return null;
  return { preset: args.preset, drill: args.drill, job: args.job };
}

/** The args as kicadPlotBoard reads them: `{ dir, preset, drill, job }`. */
export const plotJson = (dir: string, a: PlotArgs): string => JSON.stringify({ dir, preset: a.preset, drill: a.drill, job: a.job });

/** .cc-plot.json's bytes read closed: null when absent or of any other shape. */
export function readPlotDone(bytes: Uint8Array | null): PlotDone | null {
  if (bytes == null) return null;
  let v: unknown;
  try { v = JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; }
  if (!isObj(v) || !Number.isInteger(v.gerbers) || !(v.drill === null || Number.isInteger(v.drill)) || !Array.isArray(v.lines)) return null;
  const lines: PlotLine[] = [];
  for (const l of v.lines as unknown[]) {
    if (!isObj(l) || typeof l.severity !== 'string' || !SEVERITIES.includes(l.severity) || typeof l.text !== 'string') return null;
    lines.push({ severity: l.severity as PlotSeverity, text: l.text });
  }
  return { gerbers: v.gerbers as number, drill: v.drill as number | null, lines };
}

/** A line as the host may read it: the run's folder never named (the engine's absolute paths never leave the frame). */
export const plotText = (text: string, dir: string): string => text.split(`${dir}/`).join('');

/** The answer's notes: the warning and error lines, in order. */
export const plotNotes = (done: PlotDone, dir: string): string[] =>
  done.lines.filter((l) => l.severity === 'warning' || l.severity === 'error').map((l) => plotText(l.text, dir));

/**
 * Why a finished run failed, or null when it did not: a gerbers exit code
 * other than 0, or a drill run asked for that ended nonzero. The first error
 * line it reported, else the code.
 */
export function plotFailure(done: PlotDone, a: PlotArgs, dir: string): string | null {
  const drillFailed = a.drill && done.drill !== 0;
  if (done.gerbers === 0 && !drillFailed) return null;
  const first = done.lines.find((l) => l.severity === 'error');
  if (first != null) return plotText(first.text, dir);
  return done.gerbers !== 0 ? `the gerbers job ended with code ${done.gerbers}` : `the drill job ended with code ${String(done.drill)}`;
}

/** A Uint8Array that owns its whole buffer, safe to transfer (a view of a larger or shared buffer is copied). */
export function owned(b: Uint8Array): Uint8Array {
  return b.byteOffset === 0 && b.byteLength === b.buffer.byteLength && b.buffer instanceof ArrayBuffer ? b : b.slice();
}

/**
 * Every file the run wrote in `dir`, sorted by name, the run's own record and
 * any part of it left out; `too_large` past MAX_PLOT_FILES or MAX_PLOT_BYTES
 * (none of KiCad's plots comes near; `limits` lets a test lower them). A plot
 * writes one flat folder: a folder inside it is not read.
 */
export function readPlotFolder(FS: EmscriptenFS, dir: string, limits = { files: MAX_PLOT_FILES, bytes: MAX_PLOT_BYTES }): { files: PlotFile[] } | { error: 'too_large' } {
  const names = FS.readdir(dir)
    .filter((n) => n !== '.' && n !== '..' && n !== PLOT_DONE && !n.startsWith(`${PLOT_DONE}.`))
    .filter((n) => !FS.isDir(FS.stat(`${dir}/${n}`).mode))
    .sort();
  if (names.length > limits.files) return { error: 'too_large' };
  const files: PlotFile[] = [];
  let total = 0;
  for (const name of names) {
    const b = FS.readFile(`${dir}/${name}`, { encoding: 'binary' });
    if (!(b instanceof Uint8Array)) throw new Error(`the plot's ${name} did not read as bytes`);
    total += b.byteLength;
    if (total > limits.bytes) return { error: 'too_large' };
    files.push({ path: name, bytes: owned(b) });
  }
  return { files };
}
