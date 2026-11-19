// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// sim.userSignals, the pure half (wave 2 M11, spec addendum-properties-setup
// 9.2): the closed check of the request, the one expression grammar check
// that keeps every expression a single ngspice `let`, the engine's args, and
// the closed reader of the record engine run 15's kicadSimUserSignals writes
// (<dir>/user-signals.json, its only file and so written last).

/** The engine exports the op needs (feature detected: absent on engine run 14). */
export const USER_SIGNALS_EXPORTS = ['kicadSimUserSignals', 'kicadCollabBusy'] as const;
/** The cap ev.ready lists in a sch frame whose engine has kicadSimUserSignals. */
export const USER_SIGNALS_CAP = 'simUserSignals';
/** The record the engine writes into the run's folder. */
export const USER_SIGNALS_RECORD = 'user-signals.json';
/** At most this many signals in one request (ids 0 to 15). */
export const MAX_SIGNALS = 16;
/** An expression is 1 to this many characters. */
export const MAX_EXPRESSION = 256;
/** The record's wait: the queued body asks the service once per signal. */
export const USER_SIGNALS_MS = 30_000;

/** The name ngspice gives signal `id`. */
export const userVector = (id: number): string => `user${id}`;
/** A vector name sim.userSignals makes, user0 to user15. */
export const USER_VECTOR_RE = /^user(?:[0-9]|1[0-5])$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keysExactly = (o: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(o).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
const isRunNumber = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;

/** Printable ASCII only: no line break, tab or other control character, nothing past `~`. */
const PRINTABLE_RE = /^[\x20-\x7e]+$/;
/** What could end the `let` or start a second command or a quoted word: `;`, both quotes, a backslash, a backtick, a brace. */
const BREAKS_RE = /[;"'\\`{}]/;

/**
 * The one expression grammar check: 1 to 256 printable ASCII characters with
 * no `;`, quote, backslash, backtick or brace. A `let` takes one expression,
 * so nothing that passes can become a second command; the engine refuses the
 * same set, so the island refuses it first and nothing reaches ngspice.
 */
export function isExpression(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= MAX_EXPRESSION && PRINTABLE_RE.test(v) && !BREAKS_RE.test(v);
}

/** sim.userSignals' args read closed: `{ run, signals }`, 0 to 16 expressions. */
export function parseUserSignalsArgs(args: unknown): { run: number; signals: string[] } | null {
  if (!isObj(args) || !keysExactly(args, ['run', 'signals']) || !isRunNumber(args.run)) return null;
  const signals = args.signals;
  if (!Array.isArray(signals) || signals.length > MAX_SIGNALS || !signals.every(isExpression)) return null;
  return { run: args.run, signals: [...signals as string[]] };
}

/** kicadSimUserSignals' args: signal i is `user<i>`. */
export function userSignalsJson(run: number, dir: string, plot: string, signals: readonly string[]): string {
  return JSON.stringify({ run, dir, plot, signals: signals.map((expr, id) => ({ id, expr })) });
}

/** A plot name the engine takes (`[A-Za-z0-9_]{1,64}`); `const` is ngspice's own constants, no run's. */
export const isRunPlot = (name: unknown): name is string => typeof name === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(name) && name !== 'const';

export interface UserSignalsRecord {
  run: number;
  plot: string;
  error: '' | 'no_simulation' | 'sim_failed';
  message?: string;
  vectors: Array<{ id: number; name: string; length: number; complex: boolean }>;
  errors: Array<{ id: number; line: string }>;
}

const isId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < MAX_SIGNALS;

/** The record read closed, null for anything else (absent, partial, another shape). */
export function readUserSignals(bytes: Uint8Array | null): UserSignalsRecord | null {
  if (bytes == null) return null;
  let v: unknown;
  try { v = JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; }
  if (!isObj(v)) return null;
  const keys = ['run', 'plot', 'error', 'vectors', 'errors'];
  if (!keysExactly(v, Object.prototype.hasOwnProperty.call(v, 'message') ? [...keys, 'message'] : keys)) return null;
  if (typeof v.run !== 'number' || !Number.isSafeInteger(v.run) || typeof v.plot !== 'string') return null;
  if (v.error !== '' && v.error !== 'no_simulation' && v.error !== 'sim_failed') return null;
  if (v.message !== undefined && typeof v.message !== 'string') return null;
  if (!Array.isArray(v.vectors) || !Array.isArray(v.errors)) return null;
  const vectors: UserSignalsRecord['vectors'] = [];
  for (const x of v.vectors as unknown[]) {
    if (!isObj(x) || !keysExactly(x, ['id', 'name', 'length', 'complex']) || !isId(x.id) || x.name !== userVector(x.id)) return null;
    if (typeof x.length !== 'number' || !Number.isSafeInteger(x.length) || x.length < 0 || typeof x.complex !== 'boolean') return null;
    vectors.push({ id: x.id, name: x.name, length: x.length, complex: x.complex });
  }
  const errors: UserSignalsRecord['errors'] = [];
  for (const x of v.errors as unknown[]) {
    if (!isObj(x) || !keysExactly(x, ['id', 'line']) || !isId(x.id) || typeof x.line !== 'string') return null;
    errors.push({ id: x.id, line: x.line });
  }
  return { run: v.run, plot: v.plot, error: v.error, ...(v.message !== undefined ? { message: v.message as string } : {}), vectors, errors };
}

/**
 * The answer from a record of `signals`: each vector named by its expression
 * (`signal`), trace `other`; each refused expression by its index and
 * ngspice's line. Null when the record names a signal the request did not send.
 */
export function answerOf(record: UserSignalsRecord, signals: readonly string[]): {
  vectors: Array<{ name: string; signal: string; trace: 'other'; complex: boolean; length: number }>;
  errors: Array<{ index: number; line: string }>;
} | null {
  if (record.vectors.some((x) => x.id >= signals.length) || record.errors.some((x) => x.id >= signals.length)) return null;
  return {
    vectors: record.vectors.map((x) => ({ name: x.name, signal: signals[x.id]!, trace: 'other' as const, complex: x.complex, length: x.length })),
    errors: record.errors.map((x) => ({ index: x.id, line: x.line })),
  };
}
