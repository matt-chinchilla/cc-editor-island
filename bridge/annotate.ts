// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// sheet.annotate (PROTOCOL.md): the parts numbered with no KiCad dialog, through
// our engine's kicadAnnotate (pcbjam cc/main e8b2abe; engine run 10 serves it).
// The export queues KiCad's own numbering (SCH_EDIT_FRAME::AnnotateSymbols, or
// its reference lists with the kept designators as additional references) on
// the editor's apply coroutine as ONE commit, and answers before it runs; the
// run writes .cc-annotate.json LAST in its folder, so the answer waits for the
// apply queue to empty and for that file.

import { UUID_RE, SHEET_PATH_RE, REF_MAX, TEXT_MAX } from './symbol';

/** The engine exports the op needs: the numbering, the apply queue probe. */
export const ANNOTATE_EXPORTS = ['kicadAnnotate', 'kicadCollabBusy'] as const;
/** Each run writes into a fresh folder under this one, outside the project folder. */
export const ANNOTATE_ROOT = '/tmp/cc-annotate';
/** The run's own record, written last: what moved and the lines KiCad reported. */
export const ANNOTATE_DONE = '.cc-annotate.json';
/** At most this many kept designators in one request (the engine's bound). */
export const MAX_KEEP = 4096;
/** At most this many changes in one answer. */
export const MAX_CHANGES = 65_536;
/** At most this many notes in one answer, each at most this many characters. */
export const MAX_NOTES = 200;
export const MAX_NOTE_CHARS = 2000;

export type Scope = 'all' | 'sheet';
export type Order = 'x' | 'y';
export interface AnnotateArgs { scope: Scope; order: Order; reset: boolean; keep: string[] }
export interface Change { uuid: string; sheetPath: string; from: string; to: string }
export type Severity = 'error' | 'warning' | 'info' | 'action';
export interface RunLine { severity: Severity; text: string }
export interface AnnotateDone { changes: Change[]; lines: RunLine[] }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const SEVERITIES: readonly string[] = ['error', 'warning', 'info', 'action'];

/** sheet.annotate's args: exactly `{ scope, order, reset, keep }`; a uuid kept twice counts once. Null for anything else. */
export function parseAnnotateArgs(args: unknown): AnnotateArgs | null {
  if (!isObj(args)) return null;
  const keys = Object.keys(args);
  if (keys.length !== 4 || !['scope', 'order', 'reset', 'keep'].every((k) => keys.includes(k))) return null;
  if ((args.scope !== 'all' && args.scope !== 'sheet') || (args.order !== 'x' && args.order !== 'y') || typeof args.reset !== 'boolean') return null;
  if (!Array.isArray(args.keep) || args.keep.length > MAX_KEEP) return null;
  if (!(args.keep as unknown[]).every((u) => typeof u === 'string' && UUID_RE.test(u))) return null;
  return { scope: args.scope, order: args.order, reset: args.reset, keep: [...new Set(args.keep as string[])] };
}

/** The args as kicadAnnotate reads them: `{ run, dir, scope, order, reset, keep }`. */
export const annotateJson = (run: number, dir: string, a: AnnotateArgs): string =>
  JSON.stringify({ run, dir, scope: a.scope, order: a.order, reset: a.reset, keep: a.keep });

/** A run's lines read closed: null for anything but `[{ severity, text }]`. */
export function readLines(v: unknown): RunLine[] | null {
  if (!Array.isArray(v)) return null;
  const lines: RunLine[] = [];
  for (const l of v as unknown[]) {
    if (!isObj(l) || typeof l.severity !== 'string' || !SEVERITIES.includes(l.severity) || typeof l.text !== 'string') return null;
    lines.push({ severity: l.severity as Severity, text: l.text });
  }
  return lines;
}

/** .cc-annotate.json's bytes read closed: null when absent or of any other shape. */
export function readAnnotateDone(bytes: Uint8Array | null): AnnotateDone | null {
  if (bytes == null) return null;
  let v: unknown;
  try { v = JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; }
  if (!isObj(v) || !Array.isArray(v.changes)) return null;
  const lines = readLines(v.lines);
  if (lines == null) return null;
  const changes: Change[] = [];
  for (const c of v.changes as unknown[]) {
    if (!isObj(c) || typeof c.uuid !== 'string' || !UUID_RE.test(c.uuid) || typeof c.sheetPath !== 'string' || !SHEET_PATH_RE.test(c.sheetPath)) return null;
    if (typeof c.from !== 'string' || c.from.length > TEXT_MAX || typeof c.to !== 'string' || c.to === '' || [...c.to].length > REF_MAX) return null;
    changes.push({ uuid: c.uuid, sheetPath: c.sheetPath, from: c.from, to: c.to });
  }
  return { changes, lines };
}

/** A line as the host may read it: the run's folder never named (the engine's absolute paths never leave the frame). */
export const runText = (text: string, dir: string): string => text.split(`${dir}/`).join('').split(dir).join('');

/** The answer's notes: the warning and error lines, in order, the folder taken out, at most MAX_NOTES of at most MAX_NOTE_CHARS. */
export const runNotes = (lines: RunLine[], dir: string): string[] =>
  lines.filter((l) => l.severity === 'warning' || l.severity === 'error').slice(0, MAX_NOTES).map((l) => [...runText(l.text, dir)].slice(0, MAX_NOTE_CHARS).join(''));
