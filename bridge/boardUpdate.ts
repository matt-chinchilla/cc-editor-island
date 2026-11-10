// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// board.preview and board.update (PROTOCOL.md): KiCad's Update PCB from
// Schematic with no KiCad dialog, through our engine's
// kicadUpdateBoardFromSchematic (engine run 12). The export queues the job on
// the editor's apply coroutine (the hidden schematic editor's netlist, then
// KiCad's own BOARD_NETLIST_UPDATER, a dry run for a preview) and answers
// before it runs; the run writes its report (report.json, the changes as
// records) when it reached the updater, then .cc-update.json LAST, so the
// answer waits for the apply queue to empty and for that file.

import { readLines, type RunLine } from './annotate';
import { TEXT_MAX } from './symbol';

/** The engine exports the ops need: the update, the apply queue probe. */
export const BOARD_UPDATE_EXPORTS = ['kicadUpdateBoardFromSchematic', 'kicadCollabBusy'] as const;
/** Each run writes into a fresh folder under this one, outside the project folder. */
export const BOARD_UPDATE_ROOT = '/tmp/cc-update';
/** The run's own record, written last. */
export const BOARD_UPDATE_DONE = '.cc-update.json';
/** The run's report, beside the record. */
export const BOARD_UPDATE_REPORT = 'report.json';
/** At most this many records listed in one answer (past it `truncated`), pins listed for one new part, and sheets read. */
export const MAX_UPDATE_CHANGES = 4096;
export const MAX_PINS = 4096;
export const MAX_UPDATE_SHEETS = 4096;
/** A token is 1 to this many characters. */
export const TOKEN_MAX = 128;

export interface BoardOptions { replaceFootprints: boolean; deleteExtra: boolean; relinkByReference: boolean }
export interface BoardUpdateArgs extends BoardOptions { token: string }
export type UpdateError = '' | 'schematic_unreadable' | 'stale' | 'not_annotated' | 'island_error';
export interface BoardUpdateDone { error: UpdateError; message: string; lines: RunLine[] }

export type DetailTopic = 'fields' | 'link' | 'sheet' | 'filters' | 'attribute' | 'jumpers' | 'group' | 'class' | 'units' | 'variant';
export type ProblemCode =
  | 'no_footprint' | 'footprint_not_found' | 'footprint_without_library' | 'locked'
  | 'pad_without_pin' | 'pin_without_pad' | 'pins_unnumbered' | 'via_unknown_net'
  | 'zone_without_pads' | 'variant_footprint' | 'unannotated' | 'duplicate_designator'
  | 'duplicate_sheet_names';
export type BoardChange =
  | { kind: 'add'; ref: string; footprint: string; pins: Array<{ pin: string; net: string; pad: boolean }>; extraPads: string[]; sameName: boolean; message: string }
  | { kind: 'remove'; ref: string; footprint: string; message: string }
  | { kind: 'footprint'; ref: string; from: string; to: string; message: string }
  | { kind: 'reference'; ref: string; to: string; message: string }
  | { kind: 'value'; ref: string; from: string; to: string; message: string }
  | { kind: 'detail'; ref: string; topic: DetailTopic; name: string; from: string; to: string; message: string }
  | { kind: 'connect'; ref: string; pin: string; to: string; message: string }
  | { kind: 'reconnect'; ref: string; pin: string; from: string; to: string; message: string }
  | { kind: 'disconnect'; ref: string; pin: string; from: string; message: string }
  | { kind: 'net'; net: string; message: string }
  | { kind: 'unusedNet'; net: string; message: string }
  | { kind: 'copper'; item: 'via' | 'zone'; name: string; from: string; to: string; message: string }
  | { kind: 'problem'; code: ProblemCode; severity: 'warning' | 'error'; ref: string; pin: string; footprint: string; net: string; name: string; message: string };

/** report.json as the island reads it: the engine report with its sheets as project paths. */
export interface BoardReport {
  run: number; ok: boolean; token: string; blocked: '' | 'not_annotated'; sheets: string[];
  changes: BoardChange[]; added: string[]; warnings: number; errors: number; truncated: boolean; unmapped: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
};
const isText = (v: unknown, max = TEXT_MAX): v is string => typeof v === 'string' && [...v].length <= max;
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const cut = (s: string, max = TEXT_MAX): string => (s.length <= max ? s : [...s].slice(0, max).join(''));
const parseJson = (bytes: Uint8Array): unknown => {
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return undefined; }
};

const OPTION_KEYS = ['replaceFootprints', 'deleteExtra', 'relinkByReference'] as const;
const optionsOf = (o: Record<string, unknown>): BoardOptions | null =>
  OPTION_KEYS.every((k) => typeof o[k] === 'boolean')
    ? { replaceFootprints: o.replaceFootprints as boolean, deleteExtra: o.deleteExtra as boolean, relinkByReference: o.relinkByReference as boolean }
    : null;

/** board.preview's args: exactly the three options, each a boolean; null for anything else. */
export function parseBoardPreviewArgs(args: unknown): BoardOptions | null {
  return isObj(args) && exactKeys(args, OPTION_KEYS) ? optionsOf(args) : null;
}

/** board.update's args: the three options and the preview's token (1 to TOKEN_MAX characters); null for anything else. */
export function parseBoardUpdateArgs(args: unknown): BoardUpdateArgs | null {
  if (!isObj(args) || !exactKeys(args, [...OPTION_KEYS, 'token'])) return null;
  const o = optionsOf(args);
  if (o == null || typeof args.token !== 'string' || args.token.length < 1 || [...args.token].length > TOKEN_MAX) return null;
  return { ...o, token: args.token };
}

/** The args as kicadUpdateBoardFromSchematic reads them: the seven keys, `apply` and the token from whether a token is given. */
export const boardUpdateJson = (run: number, dir: string, o: BoardOptions, token: string | null): string =>
  JSON.stringify({ run, dir, apply: token != null, replaceFootprints: o.replaceFootprints, deleteExtra: o.deleteExtra, relinkByReference: o.relinkByReference, token: token ?? '' });

/** The schematic the update reads, as a project path: beside the opened board, with its stem. */
export const schematicBeside = (board: string): string => `${board.replace(/\.kicad_pcb$/i, '')}.kicad_sch`;

const UPDATE_ERRORS: readonly string[] = ['', 'schematic_unreadable', 'stale', 'not_annotated', 'island_error'];

/** .cc-update.json's bytes read closed: null when absent or of any other shape. */
export function readBoardUpdateDone(bytes: Uint8Array | null): BoardUpdateDone | null {
  if (bytes == null) return null;
  const v = parseJson(bytes);
  if (!isObj(v) || !exactKeys(v, ['error', 'message', 'lines']) || typeof v.error !== 'string' || !UPDATE_ERRORS.includes(v.error) || typeof v.message !== 'string') return null;
  const lines = readLines(v.lines);
  return lines == null ? null : { error: v.error as UpdateError, message: cut(v.message), lines };
}

const DETAIL_TOPICS: readonly string[] = ['fields', 'link', 'sheet', 'filters', 'attribute', 'jumpers', 'group', 'class', 'units', 'variant'];
const PROBLEM_CODES: readonly string[] = [
  'no_footprint', 'footprint_not_found', 'footprint_without_library', 'locked', 'pad_without_pin', 'pin_without_pad', 'pins_unnumbered',
  'via_unknown_net', 'zone_without_pads', 'variant_footprint', 'unannotated', 'duplicate_designator', 'duplicate_sheet_names',
];
/** Each kind's text keys besides `kind` and `message` (KiCad's sentence, cut, never shown). */
const TEXT_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  add: ['ref', 'footprint'],
  remove: ['ref', 'footprint'],
  footprint: ['ref', 'from', 'to'],
  reference: ['ref', 'to'],
  value: ['ref', 'from', 'to'],
  detail: ['ref', 'name', 'from', 'to'],
  connect: ['ref', 'pin', 'to'],
  reconnect: ['ref', 'pin', 'from', 'to'],
  disconnect: ['ref', 'pin', 'from'],
  net: ['net'],
  unusedNet: ['net'],
  copper: ['name', 'from', 'to'],
  problem: ['ref', 'pin', 'footprint', 'net', 'name'],
});
/** Each kind's keys besides those: their checks. */
const OTHER_KEYS: Readonly<Record<string, Readonly<Record<string, (v: unknown) => boolean>>>> = Object.freeze({
  add: {
    pins: (v: unknown) => Array.isArray(v) && v.length <= MAX_PINS && v.every((p) => isObj(p) && exactKeys(p, ['pin', 'net', 'pad']) && isText(p.pin) && isText(p.net) && typeof p.pad === 'boolean'),
    extraPads: (v: unknown) => Array.isArray(v) && v.length <= MAX_PINS && v.every((p) => isText(p)),
    sameName: (v: unknown) => typeof v === 'boolean',
  },
  detail: { topic: (v: unknown) => typeof v === 'string' && DETAIL_TOPICS.includes(v) },
  copper: { item: (v: unknown) => v === 'via' || v === 'zone' },
  problem: { code: (v: unknown) => typeof v === 'string' && PROBLEM_CODES.includes(v), severity: (v: unknown) => v === 'warning' || v === 'error' },
});

/** One record read closed: exactly its kind's keys; null for any other shape. */
function readChange(v: unknown): BoardChange | null {
  if (!isObj(v) || typeof v.kind !== 'string' || !Object.prototype.hasOwnProperty.call(TEXT_KEYS, v.kind)) return null;
  const texts = TEXT_KEYS[v.kind];
  const others = OTHER_KEYS[v.kind] ?? {};
  if (!exactKeys(v, ['kind', 'message', ...texts, ...Object.keys(others)]) || typeof v.message !== 'string') return null;
  if (!texts.every((k) => isText(v[k]))) return null;
  if (!Object.entries(others).every(([k, ok]) => ok(v[k]))) return null;
  const out: Record<string, unknown> = { kind: v.kind };
  for (const k of [...texts, ...Object.keys(others)]) out[k] = k === 'pins' ? (v.pins as Array<Record<string, unknown>>).map((p) => ({ pin: p.pin, net: p.net, pad: p.pad })) : Array.isArray(v[k]) ? [...(v[k] as unknown[])] : v[k];
  out.message = cut(v.message);
  return out as BoardChange;
}

const REPORT_KEYS = ['run', 'ok', 'token', 'blocked', 'sheets', 'changes', 'added', 'warnings', 'errors', 'truncated', 'unmapped'] as const;

/**
 * report.json (the engine report: run A's design 5.1 and the Update spec 6.4)
 * read closed for the run asked: every record with exactly its kind's keys,
 * KiCad's sentence cut at TEXT_MAX, the sheets turned from engine paths into
 * project paths by `toRel` (one outside the project folder makes the report
 * unreadable). At most MAX_UPDATE_CHANGES records are kept, past them
 * `truncated` is set; the counts are the engine's. Null for another run's
 * report or any other shape.
 */
export function readBoardReport(bytes: Uint8Array | null, run: number, toRel: (abs: string) => string | null): BoardReport | null {
  if (bytes == null) return null;
  const v = parseJson(bytes);
  if (!isObj(v) || !exactKeys(v, REPORT_KEYS) || v.run !== run || typeof v.ok !== 'boolean') return null;
  if (typeof v.token !== 'string' || [...v.token].length > TOKEN_MAX || (v.blocked !== '' && v.blocked !== 'not_annotated')) return null;
  if (!isCount(v.warnings) || !isCount(v.errors) || !isCount(v.unmapped) || typeof v.truncated !== 'boolean') return null;
  if (!Array.isArray(v.sheets) || v.sheets.length > MAX_UPDATE_SHEETS || !Array.isArray(v.changes) || !Array.isArray(v.added) || v.added.length > MAX_UPDATE_CHANGES) return null;
  if (!v.added.every((a) => isText(a))) return null;
  const sheets: string[] = [];
  for (const s of v.sheets as unknown[]) {
    const rel = typeof s === 'string' ? toRel(s) : null;
    if (rel == null) return null;
    sheets.push(rel);
  }
  const changes: BoardChange[] = [];
  let truncated = v.truncated;
  for (const c of v.changes as unknown[]) {
    const change = readChange(c);
    if (change == null) return null;
    if (changes.length >= MAX_UPDATE_CHANGES) { truncated = true; continue; }
    changes.push(change);
  }
  return {
    run, ok: v.ok, token: v.token, blocked: v.blocked, sheets, changes, added: [...v.added] as string[],
    warnings: v.warnings, errors: v.errors, truncated, unmapped: v.unmapped,
  };
}

/** board.preview's answer from a report. */
export const previewAnswer = (r: BoardReport): Record<string, unknown> =>
  ({ token: r.token, blocked: r.blocked, sheets: r.sheets, changes: r.changes, warnings: r.warnings, errors: r.errors, truncated: r.truncated, unmapped: r.unmapped });

/** board.update's answer from a report. */
export const updateAnswer = (r: BoardReport): Record<string, unknown> =>
  ({ changes: r.changes, added: r.added, warnings: r.warnings, errors: r.errors, truncated: r.truncated, unmapped: r.unmapped });
