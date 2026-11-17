// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The simulator (PROTOCOL.md sim.*): KiCad's own NGSPICE class driven through
// our engine's run 14 exports (pcbjam cc/main, kicadSimModelCatalog,
// kicadSimModelGet, kicadSimModelSet, kicadSimFileRead, kicadSimNetlist,
// kicadSimRun, kicadSimStop, kicadSimOpOnSheet), with ngspice itself in the
// simulator service's worker (loader/src/wasm/ngspice-service.ts).
//
// This module is pure: the closed checks of every op's args, the analysis line
// the island writes from them (commandOf: the page never sends SPICE text),
// the SPICE number grammar, the reading of ngspice's progress lines, and the
// closed readers of everything the engine answers or writes. A run writes
// accepted.json once ngspice took it, then result.json, then its record
// .cc-sim.json LAST, each in a fresh folder under /tmp/cc-sim/.

import { SHEET_PATH_RE, UUID_RE } from './symbol';
import { readLines, type RunLine } from './annotate';

/** The pseudo-caps ev.ready lists: the model ops, and the runs (the service files served too). */
export const SIM_CAP = 'sim';
export const SIM_MODEL_CAP = 'simModel';
/** The engine exports the model ops need. */
export const SIM_MODEL_EXPORTS = ['kicadSimModelCatalog', 'kicadSimModelGet', 'kicadSimModelSet', 'kicadSimFileRead', 'kicadCollabBusy'] as const;
/** The engine exports the runs need. */
export const SIM_RUN_EXPORTS = ['kicadSimNetlist', 'kicadSimRun', 'kicadSimStop', 'kicadSimOpOnSheet', 'kicadCollabBusy'] as const;
/** KiCad's Inspect > Simulator (menu, toolbar and key), held for the host's Simulate page. */
export const SIM_HELD_ACTION = 'eeschema.EditorControl.showSimulator';
/** Each run writes into a fresh folder under this one, outside the project folder. */
export const SIM_ROOT = '/tmp/cc-sim';
/** Written once ngspice accepted the run. */
export const SIM_ACCEPTED = 'accepted.json';
/** The run's result (SimResult), written before the record. */
export const SIM_RESULT = 'result.json';
/** The run's own record, written last: the run is over. */
export const SIM_DONE = '.cc-sim.json';
/** What a sim op answers outside a sch frame. */
export const SIM_FRAME_ONLY = 'the simulator runs in a sch frame';

/** sim.vectors: at most this many names in one request. */
export const MAX_VECTOR_NAMES = 32;
/** sim.vectors: at most this many bytes of numbers in one answer, every vector together (256 MiB). */
export const MAX_VECTOR_BYTES = 256 * 1024 * 1024;
/** sim.run: at most this many tuner overrides. */
export const MAX_OVERRIDES = 64;
/** SimResult.console keeps the last this many lines. */
export const CONSOLE_MAX = 2000;
/** A Problem's text, cut to this many characters. */
export const PROBLEM_TEXT_MAX = 4096;
/** At most this many problems kept in one answer. */
export const MAX_PROBLEMS = 4096;
/** An AC, noise or S-parameter sweep: at most this many points per decade, octave or in all. */
export const MAX_POINTS = 1_000_000;
/** A netlist's text is at most 4 MiB (the engine cuts it and says `truncated`). */
export const MAX_NETLIST = 4 * 1024 * 1024;

export type SimKind = 'op' | 'dc' | 'ac' | 'tran' | 'noise' | 'pz' | 'sp' | 'fft';
export type Scale = 'dec' | 'oct' | 'lin';
export interface DcSweep { source: string; start: string; stop: string; step: string }
export type SimAnalysis =
  | { kind: 'op' }
  | ({ kind: 'dc'; second?: DcSweep } & DcSweep)
  | { kind: 'ac'; scale: Scale; points: number; fStart: string; fStop: string }
  | { kind: 'tran'; step: string; stop: string; start?: string; maxStep?: string; useIc?: boolean }
  | { kind: 'noise'; output: string; reference?: string; source: string; scale: Scale; points: number; fStart: string; fStop: string }
  | { kind: 'pz'; input: [string, string]; output: [string, string]; transfer: 'vol' | 'cur'; find: 'pz' | 'pol' | 'zer' }
  | { kind: 'sp'; scale: Scale; points: number; fStart: string; fStop: string }
  | { kind: 'fft'; of: number; signals: string[]; window?: string }
  | { kind: 'sheet' };
export interface SimOptions { voltages: boolean; currents: boolean; dissipations: boolean; events: boolean }
export interface Override { ref: string; value: string }

export type ProblemCode = 'no_model' | 'model_error' | 'file_missing' | 'file_error' | 'pin_map' | 'other';
export interface Problem { code: ProblemCode; severity: 'error' | 'warning'; ref?: string; uuid?: string; sheetPath?: string; path?: string; text: string }
export type SimModelSource = 'inferred' | 'builtin' | 'file' | 'none';
export interface PinMap { symbolPin: string; modelPin: string }
export interface SimParam { name: string; value: string; default: string; unit: string; given: boolean }
export interface SimIbis { pin: string; model: string; diff: boolean; type: string }
export interface SimModelSheet {
  uuid: string; sheetPath: string; ref: string; enabled: boolean;
  source: SimModelSource; device: string; type: string; typeName: string;
  file: { path: string; model: string } | null;
  pins: PinMap[];
  params: SimParam[];
  problems: Problem[];
  ibis?: SimIbis;
}
export type SimModelSet =
  | { source: 'builtin'; type: string; params: Record<string, string>; pins: PinMap[] }
  | { source: 'file'; path: string; model: string; params: Record<string, string>; pins: PinMap[] };
export interface SimFileModel { name: string; kind: 'model' | 'subckt' | 'ibis'; type: string; pins: string[] }
export interface SimFile { kind: 'spice' | 'ibis'; models: SimFileModel[]; problems: Problem[] }
export type TraceKind = 'voltage' | 'current' | 'power' | 'gain' | 'phase' | 'noise' | 'event' | 'other';
export interface SimVector { name: string; signal: string; trace: TraceKind; complex: boolean; length: number }
export interface SimPlot { name: string; x: string | null; vectors: SimVector[] }
export interface SimOp { signal: string; trace: 'voltage' | 'current' | 'power'; value: number }
export interface SimResult {
  run: number; kind: SimKind; ended: 'done' | 'stopped' | 'failed'; depth: number;
  plots: SimPlot[];
  op: SimOp[] | null;
  console: string[];
  problems: Problem[];
}
export interface SimNetlist { netlist: string; problems: Problem[]; directive: string; truncated?: true }
export interface CatalogType { type: string; name: string; description: string }
export interface CatalogDevice { device: string; description: string; types: CatalogType[] }
export interface CatalogParam { name: string; unit: string; default: string; category: string; description: string; kind: 'instance' | 'model' | 'other'; tuner: boolean }
export interface CatalogEntry { type: string; device: string; name: string; description: string; pins: Array<{ name: string; symbolPinHint: string }>; params: CatalogParam[] }

/** The errors a run's record may carry ("" for none). */
export type SimError = '' | 'circuit' | 'no_directive' | 'no_simulation' | 'sim_failed' | 'stopped' | 'service_failed';
const SIM_ERRORS: readonly string[] = ['', 'circuit', 'no_directive', 'no_simulation', 'sim_failed', 'stopped', 'service_failed'];
export interface SimDone { run: number; error: SimError; message: string; lines: RunLine[]; problems: Problem[] }
export interface SimAccepted { run: number; plot: string; problems: Problem[] }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keysExactly = (o: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(o).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
const keysWithin = (o: Record<string, unknown>, allowed: readonly string[], required: readonly string[] = []): boolean =>
  Object.keys(o).every((k) => allowed.includes(k)) && required.every((k) => Object.prototype.hasOwnProperty.call(o, k));
/** No C0 control, DEL or lone surrogate. */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const plainText = (v: unknown, min: number, max: number): v is string =>
  typeof v === 'string' && [...v].length >= min && [...v].length <= max && !CONTROL_RE.test(v) && !LONE_SURROGATE_RE.test(v);
const isRunNumber = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
const cut = (s: string, max: number): string => (s.length <= max ? s : [...s].slice(0, max).join(''));

// ---------------------------------------------------------------- numbers

/** A SPICE number: digits, an exponent, a scale word (spec 7.2's grammar), any case. */
export const SPICE_NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?(f|p|n|u|m|k|meg|g|t)?$/i;
/** A number field: a SPICE number of at most 64 characters. */
export const isSpiceNumber = (v: unknown): v is string => typeof v === 'string' && v.length <= 64 && SPICE_NUMBER_RE.test(v);
const SCALE: Readonly<Record<string, number>> = { f: 1e-15, p: 1e-12, n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, meg: 1e6, g: 1e9, t: 1e12 };
/** A SPICE number's value ("1meg" is a million, "1m" a thousandth); null for any other text. */
export function spiceValue(text: string): number | null {
  const m = SPICE_NUMBER_RE.exec(text);
  if (m == null) return null;
  const base = Number(`${m[1]}${m[2] ?? ''}`) * (text.trim().startsWith('-') ? -1 : 1);
  const scale = m[3] == null ? 1 : SCALE[m[3].toLowerCase()] ?? 1;
  return Number.isFinite(base) ? base * scale : null;
}
/** A value written back as SPICE takes it: plain digits and an exponent, six significant figures. */
export const spiceText = (n: number): string => String(Number(n.toPrecision(6)));

// ---------------------------------------------------------------- names

/**
 * A net or a source as a netlist names it: no white space, quote, comma,
 * parenthesis, equals sign, semicolon or backslash, so nothing written into
 * the analysis line can be more than one word of it.
 */
export const NAME_RE = /^[^\s"'`(),=;\\]{1,128}$/;
/** A vector's name as ngspice spells it (`v(out)`, `i(v1)`, `@r1[i]`): one word, parentheses allowed. */
export const VECTOR_RE = /^[^\s"'`,;\\]{1,256}$/;
/** A designator a tuner names. */
const REF_RE = /^[^\s"'`(),=;\\]{1,64}$/;
/** A model type's key as the engine writes it ("R", "V.PULSE", "NMOS.BSIM4"). */
const TYPE_KEY_RE = /^[A-Za-z0-9_]{1,32}(\.[A-Za-z0-9_]{1,32})?$/;
/** The FFT windows ngspice's specwindow takes. */
export const FFT_WINDOWS: readonly string[] = ['none', 'rectangular', 'bartlet', 'blackman', 'hanning', 'hamming', 'gaussian', 'flattop'];

/** The words of a netlist the analysis line may name: its nodes, and its element names that can be swept or measured. */
export interface NetNames { nodes: ReadonlySet<string>; sources: ReadonlySet<string> }

/**
 * The names a netlist holds, lower case (SPICE reads names in any case): every
 * word of its element lines and their continuations is a node it may name, and
 * every element whose name starts V, I or R a source (DC sweep takes all
 * three, noise the first two). Comment and dot lines name nothing.
 */
export function namesOf(netlist: string): NetNames {
  const nodes = new Set<string>(['0']);
  const sources = new Set<string>();
  for (const raw of netlist.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('*') || line.startsWith('.')) continue;
    const words = line.replace(/^\+/, '').split(/[\s(),=]+/).filter((w) => w !== '');
    if (words.length === 0) continue;
    if (!line.startsWith('+') && /^[vir]/i.test(words[0]!)) sources.add(words[0]!.toLowerCase());
    for (const w of words) nodes.add(w.toLowerCase());
  }
  return { nodes, sources };
}

// ---------------------------------------------------------------- args

/** A model file's path: relative to the project folder, or `kicad-embed://<name>` (a file KiCad desktop embedded). */
export function isModelPath(v: unknown): v is string {
  if (!plainText(v, 1, 512) || v.includes('\\') || v.includes('$')) return false;
  if (v.startsWith('kicad-embed://')) {
    const name = v.slice('kicad-embed://'.length);
    return name !== '' && !name.includes('/') && !name.includes('..');
  }
  if (v.startsWith('/') || v.startsWith('~') || v.includes(':')) return false;
  return v.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

export function parseCatalogArgs(args: unknown): { type?: string } | null {
  if (args === undefined) return {};
  if (!isObj(args)) return null;
  if (Object.keys(args).length === 0) return {};
  if (!keysExactly(args, ['type']) || typeof args.type !== 'string' || !TYPE_KEY_RE.test(args.type)) return null;
  return { type: args.type };
}

export interface ModelRef { uuid: string; sheetPath: string }
export function parseModelGetArgs(args: unknown): ModelRef | null {
  if (!isObj(args) || !keysExactly(args, ['uuid', 'sheetPath'])) return null;
  if (typeof args.uuid !== 'string' || !UUID_RE.test(args.uuid) || typeof args.sheetPath !== 'string' || !SHEET_PATH_RE.test(args.sheetPath)) return null;
  return { uuid: args.uuid, sheetPath: args.sheetPath };
}

function parseParams(v: unknown): Record<string, string> | null {
  if (!isObj(v) || Object.keys(v).length > 1024) return null;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(v)) {
    if (!plainText(name, 1, 64) || !plainText(value, 0, 1024)) return null;
    out[name] = value;
  }
  return out;
}

function parsePins(v: unknown): PinMap[] | null {
  if (!Array.isArray(v) || v.length > 1024) return null;
  const out: PinMap[] = [];
  const seenSymbol = new Set<string>();
  const seenModel = new Set<string>();
  for (const p of v as unknown[]) {
    if (!isObj(p) || !keysExactly(p, ['symbolPin', 'modelPin']) || !plainText(p.symbolPin, 1, 64) || !plainText(p.modelPin, 1, 64)) return null;
    if (seenSymbol.has(p.symbolPin) || seenModel.has(p.modelPin)) return null;
    seenSymbol.add(p.symbolPin);
    seenModel.add(p.modelPin);
    out.push({ symbolPin: p.symbolPin, modelPin: p.modelPin });
  }
  return out;
}

export interface ModelSetArgs extends ModelRef { model: SimModelSet | null }
export function parseModelSetArgs(args: unknown): ModelSetArgs | null {
  if (!isObj(args) || !keysExactly(args, ['uuid', 'sheetPath', 'model'])) return null;
  const ref = parseModelGetArgs({ uuid: args.uuid, sheetPath: args.sheetPath });
  if (ref == null) return null;
  const m = args.model;
  if (m === null) return { ...ref, model: null };
  if (!isObj(m)) return null;
  if (m.source === 'builtin') {
    if (!keysExactly(m, ['source', 'type', 'params', 'pins']) || typeof m.type !== 'string' || !TYPE_KEY_RE.test(m.type)) return null;
    const params = parseParams(m.params);
    const pins = parsePins(m.pins);
    if (params == null || pins == null) return null;
    return { ...ref, model: { source: 'builtin', type: m.type, params, pins } };
  }
  if (m.source === 'file') {
    if (!keysExactly(m, ['source', 'path', 'model', 'params', 'pins']) || !isModelPath(m.path) || !plainText(m.model, 1, 256)) return null;
    const params = parseParams(m.params);
    const pins = parsePins(m.pins);
    if (params == null || pins == null) return null;
    return { ...ref, model: { source: 'file', path: m.path, model: m.model, params, pins } };
  }
  return null;
}

export function parseFileArgs(args: unknown): { path: string } | null {
  if (!isObj(args) || !keysExactly(args, ['path']) || !isModelPath(args.path)) return null;
  return { path: args.path };
}

export function parseOptions(v: unknown): SimOptions | null {
  if (!isObj(v) || !keysExactly(v, ['voltages', 'currents', 'dissipations', 'events'])) return null;
  if (typeof v.voltages !== 'boolean' || typeof v.currents !== 'boolean' || typeof v.dissipations !== 'boolean' || typeof v.events !== 'boolean') return null;
  return { voltages: v.voltages, currents: v.currents, dissipations: v.dissipations, events: v.events };
}

const isScale = (v: unknown): v is Scale => v === 'dec' || v === 'oct' || v === 'lin';
const isPoints = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= MAX_POINTS;
const isName = (v: unknown): v is string => typeof v === 'string' && NAME_RE.test(v);

function parseSweep(v: Record<string, unknown>): DcSweep | null {
  if (!isName(v.source) || !isSpiceNumber(v.start) || !isSpiceNumber(v.stop) || !isSpiceNumber(v.step)) return null;
  return { source: v.source, start: v.start, stop: v.stop, step: v.step };
}

/** One SimAnalysis read closed: each kind's keys and no other, each number a SPICE number, each name one word. */
export function parseAnalysis(v: unknown): SimAnalysis | null {
  if (!isObj(v)) return null;
  switch (v.kind) {
    case 'op':
    case 'sheet':
      return keysExactly(v, ['kind']) ? { kind: v.kind } : null;
    case 'dc': {
      if (!keysWithin(v, ['kind', 'source', 'start', 'stop', 'step', 'second'], ['source', 'start', 'stop', 'step'])) return null;
      const first = parseSweep(v);
      if (first == null) return null;
      if (v.second === undefined) return { kind: 'dc', ...first };
      if (!isObj(v.second) || !keysExactly(v.second, ['source', 'start', 'stop', 'step'])) return null;
      const second = parseSweep(v.second);
      if (second == null || second.source.toLowerCase() === first.source.toLowerCase()) return null;
      return { kind: 'dc', ...first, second };
    }
    case 'ac':
    case 'sp':
      if (!keysExactly(v, ['kind', 'scale', 'points', 'fStart', 'fStop'])) return null;
      if (!isScale(v.scale) || !isPoints(v.points) || !isSpiceNumber(v.fStart) || !isSpiceNumber(v.fStop)) return null;
      return { kind: v.kind, scale: v.scale, points: v.points, fStart: v.fStart, fStop: v.fStop };
    case 'tran': {
      if (!keysWithin(v, ['kind', 'step', 'stop', 'start', 'maxStep', 'useIc'], ['step', 'stop'])) return null;
      if (!isSpiceNumber(v.step) || !isSpiceNumber(v.stop)) return null;
      if (v.start !== undefined && !isSpiceNumber(v.start)) return null;
      if (v.maxStep !== undefined && !isSpiceNumber(v.maxStep)) return null;
      if (v.useIc !== undefined && typeof v.useIc !== 'boolean') return null;
      const out: SimAnalysis = { kind: 'tran', step: v.step, stop: v.stop };
      if (v.start !== undefined) out.start = v.start as string;
      if (v.maxStep !== undefined) out.maxStep = v.maxStep as string;
      if (v.useIc !== undefined) out.useIc = v.useIc as boolean;
      return out;
    }
    case 'noise': {
      if (!keysWithin(v, ['kind', 'output', 'reference', 'source', 'scale', 'points', 'fStart', 'fStop'], ['output', 'source', 'scale', 'points', 'fStart', 'fStop'])) return null;
      if (!isName(v.output) || !isName(v.source) || !isScale(v.scale) || !isPoints(v.points) || !isSpiceNumber(v.fStart) || !isSpiceNumber(v.fStop)) return null;
      if (v.reference !== undefined && !isName(v.reference)) return null;
      const out: SimAnalysis = { kind: 'noise', output: v.output, source: v.source, scale: v.scale, points: v.points, fStart: v.fStart, fStop: v.fStop };
      if (v.reference !== undefined) out.reference = v.reference as string;
      return out;
    }
    case 'pz': {
      if (!keysExactly(v, ['kind', 'input', 'output', 'transfer', 'find'])) return null;
      const pair = (p: unknown): p is [string, string] => Array.isArray(p) && p.length === 2 && isName(p[0]) && isName(p[1]);
      if (!pair(v.input) || !pair(v.output)) return null;
      if (v.transfer !== 'vol' && v.transfer !== 'cur') return null;
      if (v.find !== 'pz' && v.find !== 'pol' && v.find !== 'zer') return null;
      return { kind: 'pz', input: [v.input[0], v.input[1]], output: [v.output[0], v.output[1]], transfer: v.transfer, find: v.find };
    }
    case 'fft': {
      if (!keysWithin(v, ['kind', 'of', 'signals', 'window'], ['of', 'signals'])) return null;
      if (!isRunNumber(v.of) || !Array.isArray(v.signals) || v.signals.length < 1 || v.signals.length > 64) return null;
      if (!v.signals.every((s) => typeof s === 'string' && VECTOR_RE.test(s))) return null;
      if (v.window !== undefined && (typeof v.window !== 'string' || !FFT_WINDOWS.includes(v.window))) return null;
      const out: SimAnalysis = { kind: 'fft', of: v.of, signals: [...v.signals as string[]] };
      if (v.window !== undefined) out.window = v.window as string;
      return out;
    }
  }
  return null;
}

export interface NetlistArgs { analysis: Exclude<SimAnalysis, { kind: 'fft' }>; options: SimOptions }
/** sim.netlist's args: exactly `{ analysis, options }`; an FFT makes no netlist (it reads a transient). */
export function parseNetlistArgs(args: unknown): NetlistArgs | null {
  if (!isObj(args) || !keysExactly(args, ['analysis', 'options'])) return null;
  const analysis = parseAnalysis(args.analysis);
  const options = parseOptions(args.options);
  if (analysis == null || options == null || analysis.kind === 'fft') return null;
  return { analysis, options };
}

export interface RunArgs { analysis: SimAnalysis; options: SimOptions; overrides: Override[] }
/** sim.run's args: exactly `{ analysis, options, overrides }`; an FFT takes no overrides (it reruns nothing). */
export function parseRunArgs(args: unknown): RunArgs | null {
  if (!isObj(args) || !keysExactly(args, ['analysis', 'options', 'overrides'])) return null;
  const analysis = parseAnalysis(args.analysis);
  const options = parseOptions(args.options);
  if (analysis == null || options == null || !Array.isArray(args.overrides) || args.overrides.length > MAX_OVERRIDES) return null;
  const overrides: Override[] = [];
  const seen = new Set<string>();
  for (const o of args.overrides as unknown[]) {
    if (!isObj(o) || !keysExactly(o, ['ref', 'value']) || typeof o.ref !== 'string' || !REF_RE.test(o.ref) || !isSpiceNumber(o.value)) return null;
    if (seen.has(o.ref.toLowerCase())) return null;
    seen.add(o.ref.toLowerCase());
    overrides.push({ ref: o.ref, value: o.value });
  }
  if (analysis.kind === 'fft' && overrides.length > 0) return null;
  return { analysis, options, overrides };
}

export function parseResultArgs(args: unknown): { run: number } | null {
  if (!isObj(args) || !keysExactly(args, ['run']) || !isRunNumber(args.run)) return null;
  return { run: args.run };
}

export function parseVectorsArgs(args: unknown): { run: number; names: string[] } | null {
  if (!isObj(args) || !keysExactly(args, ['run', 'names']) || !isRunNumber(args.run)) return null;
  const names = args.names;
  if (!Array.isArray(names) || names.length < 1 || names.length > MAX_VECTOR_NAMES) return null;
  if (!names.every((n) => typeof n === 'string' && VECTOR_RE.test(n))) return null;
  if (new Set(names).size !== names.length) return null;
  return { run: args.run, names: [...names as string[]] };
}

export function parseOpOnSheetArgs(args: unknown): { voltages: boolean; currents: boolean } | null {
  if (!isObj(args) || !keysExactly(args, ['voltages', 'currents']) || typeof args.voltages !== 'boolean' || typeof args.currents !== 'boolean') return null;
  return { voltages: args.voltages, currents: args.currents };
}

// ---------------------------------------------------------------- the analysis line

/** What commandOf answers: the line, or the name the netlist does not hold. */
export type Command = { command: string } | { unknown: string };

/**
 * The SPICE analysis line for one analysis (spec 7.2), written by the island
 * from fixed fields, each field set as KiCad's simulation command dialog
 * writes it (eeschema/dialogs/dialog_sim_command.cpp, read 2026-11-16; this is
 * our own TypeScript). Each net and source must be a name of the netlist
 * (`names`); the first that is not is answered as `unknown`. `{ kind: "sheet" }`
 * is the empty line: the schematic's own directive. FFT is fftLines'.
 */
export function commandOf(a: Exclude<SimAnalysis, { kind: 'fft' }>, names: NetNames): Command {
  const node = (n: string): boolean => names.nodes.has(n.toLowerCase());
  const source = (n: string, kinds: string): boolean => kinds.includes(n[0]!.toLowerCase()) && names.sources.has(n.toLowerCase());
  switch (a.kind) {
    case 'sheet': return { command: '' };
    case 'op': return { command: '.op' };
    case 'dc': {
      const sweep = (s: DcSweep): string | null => {
        if (s.source.toLowerCase() !== 'temp' && !source(s.source, 'vir')) return null;
        return `${s.source.toLowerCase() === 'temp' ? 'TEMP' : s.source} ${s.start} ${s.stop} ${s.step}`;
      };
      const first = sweep(a);
      if (first == null) return { unknown: a.source };
      if (a.second == null) return { command: `.dc ${first}` };
      const second = sweep(a.second);
      if (second == null) return { unknown: a.second.source };
      return { command: `.dc ${first} ${second}` };
    }
    case 'ac': return { command: `.ac ${a.scale} ${a.points} ${a.fStart} ${a.fStop}` };
    case 'sp': return { command: `.sp ${a.scale} ${a.points} ${a.fStart} ${a.fStop}` };
    case 'tran': {
      // The dialog's optionals: an initial time, a largest step, uic. With uic
      // and no largest step it writes the smaller of a fiftieth of the span and the step.
      let optionals = a.useIc === true ? 'uic' : '';
      if (a.maxStep != null) optionals = `${a.maxStep} ${optionals}`;
      else if (optionals !== '') {
        const step = spiceValue(a.step) ?? 0;
        const span = (spiceValue(a.stop) ?? 0) - (a.start != null ? spiceValue(a.start) ?? 0 : 0);
        optionals = `${spiceText(Math.min(span / 50, step))} ${optionals}`;
      }
      if (a.start != null) optionals = `${a.start} ${optionals}`;
      else if (optionals !== '') optionals = `0 ${optionals}`;
      return { command: `.tran ${a.step} ${a.stop} ${optionals}`.trim() };
    }
    case 'noise': {
      if (!node(a.output)) return { unknown: a.output };
      if (a.reference != null && !node(a.reference)) return { unknown: a.reference };
      if (!source(a.source, 'vi')) return { unknown: a.source };
      const v = a.reference != null ? `v(${a.output},${a.reference})` : `v(${a.output})`;
      return { command: `.noise ${v} ${a.source} ${a.scale} ${a.points} ${a.fStart} ${a.fStop}` };
    }
    case 'pz': {
      for (const n of [...a.input, ...a.output]) if (!node(n)) return { unknown: n };
      return { command: `.pz ${a.input[0]} ${a.input[1]} ${a.output[0]} ${a.output[1]} ${a.transfer} ${a.find}` };
    }
  }
}

/**
 * An FFT's lines, as KiCad's dialog writes them with Linearize on (the window
 * first, when asked): each signal one of the transient's own vectors (`vectors`,
 * matched in any case, written in the transient's spelling). The first signal
 * the transient lacks is answered as `unknown`.
 */
export function fftLines(a: Extract<SimAnalysis, { kind: 'fft' }>, vectors: readonly string[]): Command {
  const byLower = new Map(vectors.map((v) => [v.toLowerCase(), v]));
  const signals: string[] = [];
  for (const s of a.signals) {
    const own = byLower.get(s.toLowerCase());
    if (own == null || !VECTOR_RE.test(own)) return { unknown: s };
    signals.push(own);
  }
  const words = signals.join(' ');
  const lines = [`linearize ${words}`, `fft ${words}`];
  if (a.window != null) lines.unshift(`set specwindow=${a.window}`);
  return { command: lines.join('\n') };
}

/** The args kicadSimRun reads: `{ run, dir, command, options, overrides, fftOf }`. */
export const runJson = (run: number, dir: string, command: string, options: SimOptions, overrides: readonly Override[], fftOf: number | null): string =>
  JSON.stringify({ run, dir, command, options, overrides: overrides.map((o) => ({ ref: o.ref, value: o.value })), fftOf });

// ---------------------------------------------------------------- progress

/**
 * ngspice's progress line ("tran: 34.5%", SetAnalyse's "%s: %3.1f%%" in
 * sharedspice.c of ngspice 46) as a whole percent 0 to 100; null for any other
 * line ("--ready--", "Source Deck").
 */
export function statPercent(line: string): number | null {
  const m = /^\s*[A-Za-z][\w.-]*\s*:\s*(\d{1,3}(?:\.\d+)?)\s*%\s*$/.exec(line);
  if (m == null) return null;
  const p = Number(m[1]);
  return Number.isFinite(p) ? Math.max(0, Math.min(100, Math.round(p))) : null;
}

/** At most one loading or running event this often for one run. */
export const PROGRESS_MS = 250;

// ---------------------------------------------------------------- readers

const PROBLEM_CODES: readonly string[] = ['no_model', 'model_error', 'file_missing', 'file_error', 'pin_map', 'other'];

function readProblem(v: unknown): Problem | null {
  if (!isObj(v) || !keysWithin(v, ['code', 'severity', 'ref', 'uuid', 'sheetPath', 'path', 'text'], ['code', 'severity', 'text'])) return null;
  if (typeof v.code !== 'string' || !PROBLEM_CODES.includes(v.code) || (v.severity !== 'error' && v.severity !== 'warning') || typeof v.text !== 'string') return null;
  const out: Problem = { code: v.code as ProblemCode, severity: v.severity, text: cut(v.text, PROBLEM_TEXT_MAX) };
  if (v.ref !== undefined) { if (typeof v.ref !== 'string') return null; out.ref = cut(v.ref, 256); }
  if (v.uuid !== undefined) { if (typeof v.uuid !== 'string' || !UUID_RE.test(v.uuid)) return null; out.uuid = v.uuid; }
  if (v.sheetPath !== undefined) { if (typeof v.sheetPath !== 'string' || !SHEET_PATH_RE.test(v.sheetPath)) return null; out.sheetPath = v.sheetPath; }
  if (v.path !== undefined) { if (typeof v.path !== 'string') return null; out.path = cut(v.path, 512); }
  return out;
}

export function readProblems(v: unknown): Problem[] | null {
  if (!Array.isArray(v)) return null;
  const out: Problem[] = [];
  for (const p of v as unknown[]) {
    const problem = readProblem(p);
    if (problem == null) return null;
    if (out.length < MAX_PROBLEMS) out.push(problem);
  }
  return out;
}

function parseJson(text: string | Uint8Array | null): unknown {
  if (text == null) return undefined;
  try { return JSON.parse(typeof text === 'string' ? text : new TextDecoder().decode(text)); } catch { return undefined; }
}

/** .cc-sim.json read closed: null when absent or of any other shape. */
export function readSimDone(bytes: Uint8Array | null): SimDone | null {
  const v = parseJson(bytes);
  if (!isObj(v) || !keysWithin(v, ['run', 'error', 'message', 'lines', 'problems'], ['run', 'error', 'message', 'lines', 'problems'])) return null;
  if (!isRunNumber(v.run) || typeof v.error !== 'string' || !SIM_ERRORS.includes(v.error) || typeof v.message !== 'string') return null;
  const lines = readLines(v.lines);
  const problems = readProblems(v.problems);
  if (lines == null || problems == null) return null;
  return { run: v.run, error: v.error as SimError, message: cut(v.message, PROBLEM_TEXT_MAX), lines, problems };
}

/** accepted.json read closed. */
export function readAccepted(bytes: Uint8Array | null): SimAccepted | null {
  const v = parseJson(bytes);
  if (!isObj(v) || !keysExactly(v, ['run', 'plot', 'problems']) || !isRunNumber(v.run) || typeof v.plot !== 'string') return null;
  const problems = readProblems(v.problems);
  return problems == null ? null : { run: v.run, plot: v.plot, problems };
}

const KINDS: readonly string[] = ['op', 'dc', 'ac', 'tran', 'noise', 'pz', 'sp', 'fft'];
const TRACES: readonly string[] = ['voltage', 'current', 'power', 'gain', 'phase', 'noise', 'event', 'other'];

function readVector(v: unknown): SimVector | null {
  if (!isObj(v) || !keysExactly(v, ['name', 'signal', 'trace', 'complex', 'length'])) return null;
  if (typeof v.name !== 'string' || typeof v.signal !== 'string' || typeof v.trace !== 'string' || !TRACES.includes(v.trace)) return null;
  if (typeof v.complex !== 'boolean' || typeof v.length !== 'number' || !Number.isSafeInteger(v.length) || v.length < 0) return null;
  return { name: v.name, signal: v.signal, trace: v.trace as TraceKind, complex: v.complex, length: v.length };
}

/** result.json read closed (SimResult, spec 8.3): the console cut to its last CONSOLE_MAX lines. */
export function readSimResult(bytes: Uint8Array | null): SimResult | null {
  const v = parseJson(bytes);
  if (!isObj(v) || !keysExactly(v, ['run', 'kind', 'ended', 'depth', 'plots', 'op', 'console', 'problems'])) return null;
  if (!isRunNumber(v.run) || typeof v.kind !== 'string' || !KINDS.includes(v.kind)) return null;
  if (v.ended !== 'done' && v.ended !== 'stopped' && v.ended !== 'failed') return null;
  if (typeof v.depth !== 'number' || !Number.isSafeInteger(v.depth)) return null;
  if (!Array.isArray(v.plots) || !Array.isArray(v.console) || !v.console.every((l) => typeof l === 'string')) return null;
  const plots: SimPlot[] = [];
  for (const p of v.plots as unknown[]) {
    if (!isObj(p) || !keysExactly(p, ['name', 'x', 'vectors']) || typeof p.name !== 'string' || !(p.x === null || typeof p.x === 'string') || !Array.isArray(p.vectors)) return null;
    const vectors: SimVector[] = [];
    for (const vec of p.vectors as unknown[]) {
      const read = readVector(vec);
      if (read == null) return null;
      vectors.push(read);
    }
    plots.push({ name: p.name, x: p.x as string | null, vectors });
  }
  let op: SimOp[] | null = null;
  if (v.op !== null) {
    if (!Array.isArray(v.op)) return null;
    op = [];
    for (const o of v.op as unknown[]) {
      if (!isObj(o) || !keysExactly(o, ['signal', 'trace', 'value']) || typeof o.signal !== 'string') return null;
      if (o.trace !== 'voltage' && o.trace !== 'current' && o.trace !== 'power') return null;
      if (typeof o.value !== 'number' || !Number.isFinite(o.value)) return null;
      op.push({ signal: o.signal, trace: o.trace, value: o.value });
    }
  }
  const problems = readProblems(v.problems);
  if (problems == null) return null;
  const console = (v.console as string[]).slice(-CONSOLE_MAX);
  return { run: v.run, kind: v.kind as SimKind, ended: v.ended, depth: v.depth, plots, op, console, problems };
}

/** kicadSimNetlist's answer read closed; null for "" (refused) or another shape. */
export function readNetlist(raw: string): SimNetlist | null {
  const v = parseJson(raw === '' ? null : raw);
  if (!isObj(v) || !keysWithin(v, ['netlist', 'problems', 'directive', 'truncated'], ['netlist', 'problems', 'directive'])) return null;
  if (typeof v.netlist !== 'string' || typeof v.directive !== 'string' || (v.truncated !== undefined && v.truncated !== true)) return null;
  const problems = readProblems(v.problems);
  if (problems == null) return null;
  const truncated = v.truncated === true || new TextEncoder().encode(v.netlist).length > MAX_NETLIST;
  return truncated ? { netlist: v.netlist, problems, directive: v.directive, truncated: true } : { netlist: v.netlist, problems, directive: v.directive };
}

const CATEGORY_RE = /^[a-z_]{1,32}$/;

/** kicadSimModelCatalog's `{}` answer read closed. */
export function readCatalog(raw: string): { devices: CatalogDevice[] } | null {
  const v = parseJson(raw === '' ? null : raw);
  if (!isObj(v) || !keysExactly(v, ['devices']) || !Array.isArray(v.devices)) return null;
  const devices: CatalogDevice[] = [];
  for (const d of v.devices as unknown[]) {
    if (!isObj(d) || !keysExactly(d, ['device', 'description', 'types']) || typeof d.device !== 'string' || typeof d.description !== 'string' || !Array.isArray(d.types)) return null;
    const types: CatalogType[] = [];
    for (const t of d.types as unknown[]) {
      if (!isObj(t) || !keysExactly(t, ['type', 'name', 'description']) || typeof t.type !== 'string' || !TYPE_KEY_RE.test(t.type) || typeof t.name !== 'string' || typeof t.description !== 'string') return null;
      types.push({ type: t.type, name: t.name, description: t.description });
    }
    devices.push({ device: d.device, description: d.description, types });
  }
  return { devices };
}

/** kicadSimModelCatalog's `{ type }` answer read closed. */
export function readCatalogEntry(raw: string): CatalogEntry | null {
  const v = parseJson(raw === '' ? null : raw);
  if (!isObj(v) || !keysExactly(v, ['type', 'device', 'name', 'description', 'pins', 'params'])) return null;
  if (typeof v.type !== 'string' || typeof v.device !== 'string' || typeof v.name !== 'string' || typeof v.description !== 'string' || !Array.isArray(v.pins) || !Array.isArray(v.params)) return null;
  const pins: CatalogEntry['pins'] = [];
  for (const p of v.pins as unknown[]) {
    if (!isObj(p) || !keysExactly(p, ['name', 'symbolPinHint']) || typeof p.name !== 'string' || typeof p.symbolPinHint !== 'string') return null;
    pins.push({ name: p.name, symbolPinHint: p.symbolPinHint });
  }
  const params: CatalogParam[] = [];
  for (const p of v.params as unknown[]) {
    if (!isObj(p) || !keysExactly(p, ['name', 'unit', 'default', 'category', 'description', 'kind', 'tuner'])) return null;
    if (typeof p.name !== 'string' || typeof p.unit !== 'string' || typeof p.default !== 'string' || typeof p.category !== 'string' || !CATEGORY_RE.test(p.category) || typeof p.description !== 'string') return null;
    if ((p.kind !== 'instance' && p.kind !== 'model' && p.kind !== 'other') || typeof p.tuner !== 'boolean') return null;
    params.push({ name: p.name, unit: p.unit, default: p.default, category: p.category, description: p.description, kind: p.kind, tuner: p.tuner });
  }
  return { type: v.type, device: v.device, name: v.name, description: v.description, pins, params };
}

const SOURCES: readonly string[] = ['inferred', 'builtin', 'file', 'none'];

/** kicadSimModelGet's answer read closed (SimModelSheet, and `ibis` for an IBIS part). */
export function readModelSheet(raw: string): SimModelSheet | null {
  const v = parseJson(raw === '' ? null : raw);
  const keys = ['uuid', 'sheetPath', 'ref', 'enabled', 'source', 'device', 'type', 'typeName', 'file', 'pins', 'params', 'problems'];
  if (!isObj(v) || !keysWithin(v, [...keys, 'ibis'], keys)) return null;
  if (typeof v.uuid !== 'string' || !UUID_RE.test(v.uuid) || typeof v.sheetPath !== 'string' || !SHEET_PATH_RE.test(v.sheetPath)) return null;
  if (typeof v.ref !== 'string' || typeof v.enabled !== 'boolean' || typeof v.source !== 'string' || !SOURCES.includes(v.source)) return null;
  if (typeof v.device !== 'string' || typeof v.type !== 'string' || typeof v.typeName !== 'string') return null;
  let file: SimModelSheet['file'] = null;
  if (v.file !== null) {
    if (!isObj(v.file) || !keysExactly(v.file, ['path', 'model']) || typeof v.file.path !== 'string' || typeof v.file.model !== 'string') return null;
    file = { path: v.file.path, model: v.file.model };
  }
  if (!Array.isArray(v.pins) || !Array.isArray(v.params)) return null;
  const pins: PinMap[] = [];
  for (const p of v.pins as unknown[]) {
    if (!isObj(p) || !keysExactly(p, ['symbolPin', 'modelPin']) || typeof p.symbolPin !== 'string' || typeof p.modelPin !== 'string') return null;
    pins.push({ symbolPin: p.symbolPin, modelPin: p.modelPin });
  }
  const params: SimParam[] = [];
  for (const p of v.params as unknown[]) {
    if (!isObj(p) || !keysExactly(p, ['name', 'value', 'default', 'unit', 'given'])) return null;
    if (typeof p.name !== 'string' || typeof p.value !== 'string' || typeof p.default !== 'string' || typeof p.unit !== 'string' || typeof p.given !== 'boolean') return null;
    params.push({ name: p.name, value: p.value, default: p.default, unit: p.unit, given: p.given });
  }
  const problems = readProblems(v.problems);
  if (problems == null) return null;
  const out: SimModelSheet = {
    uuid: v.uuid, sheetPath: v.sheetPath, ref: v.ref, enabled: v.enabled, source: v.source as SimModelSource,
    device: v.device, type: v.type, typeName: v.typeName, file, pins, params, problems,
  };
  if (v.ibis !== undefined) {
    const i = v.ibis;
    if (!isObj(i) || !keysExactly(i, ['pin', 'model', 'diff', 'type']) || typeof i.pin !== 'string' || typeof i.model !== 'string' || typeof i.diff !== 'boolean' || typeof i.type !== 'string') return null;
    out.ibis = { pin: i.pin, model: i.model, diff: i.diff, type: i.type };
  }
  return out;
}

/**
 * Whether a model sheet read back shows a sim.model.set: null leaves no file
 * and no built in type of its own (the model is inferred again, or there is
 * none); a built in model reads that source and type; a file model that
 * source, file and model.
 */
export function showsModelSet(set: SimModelSet | null, after: SimModelSheet): boolean {
  if (set == null) return after.source === 'inferred' || after.source === 'none';
  if (set.source === 'builtin') return after.source === 'builtin' && after.type === set.type;
  return after.source === 'file' && after.file != null && after.file.path === set.path && after.file.model === set.model;
}

/** kicadSimFileRead's answer read closed. */
export function readSimFile(raw: string): SimFile | null {
  const v = parseJson(raw === '' ? null : raw);
  if (!isObj(v) || !keysExactly(v, ['kind', 'models', 'problems']) || (v.kind !== 'spice' && v.kind !== 'ibis') || !Array.isArray(v.models)) return null;
  const models: SimFileModel[] = [];
  for (const m of v.models as unknown[]) {
    if (!isObj(m) || !keysExactly(m, ['name', 'kind', 'type', 'pins']) || typeof m.name !== 'string' || typeof m.type !== 'string') return null;
    if ((m.kind !== 'model' && m.kind !== 'subckt' && m.kind !== 'ibis') || !Array.isArray(m.pins) || !m.pins.every((p) => typeof p === 'string')) return null;
    models.push({ name: m.name, kind: m.kind, type: m.type, pins: [...m.pins as string[]] });
  }
  const problems = readProblems(v.problems);
  return problems == null ? null : { kind: v.kind, models, problems };
}

/** The vectors a result lists for names asked: each name's plot, or the first name no plot of the run holds. */
export function vectorsOf(result: SimResult, names: readonly string[]): { found: Array<{ name: string; plot: string; vector: SimVector }> } | { missing: string } {
  const found: Array<{ name: string; plot: string; vector: SimVector }> = [];
  for (const name of names) {
    let hit: { plot: string; vector: SimVector } | null = null;
    for (const p of result.plots) {
      const vector = p.vectors.find((v) => v.name === name);
      if (vector != null) { hit = { plot: p.name, vector }; break; }
    }
    if (hit == null) return { missing: name };
    found.push({ name, ...hit });
  }
  return { found };
}

/** The bytes the vectors' numbers take: 8 a value, twice for a complex one. */
export const vectorBytes = (vectors: ReadonlyArray<{ vector: SimVector }>): number =>
  vectors.reduce((n, v) => n + v.vector.length * 8 * (v.vector.complex ? 2 : 1), 0);

/** A plot's name ngspice may be asked by: `<plot>.<vector>` reaches a vector of any plot, whichever is current. */
export const qualifiedVector = (plot: string, name: string): string => `${plot}.${name}`;

/**
 * One vector as the service answers it (get_vec_info) split for the host:
 * `real` the real parts (the real data, or each complex value's real half),
 * `imag` the imaginary halves for a complex vector, else null. Null when the
 * service holds no such vector or answered something else.
 */
export function splitVector(res: unknown): { real: Float64Array; imag: Float64Array | null } | null {
  if (!isObj(res) || res.error !== undefined || res.found !== true) return null;
  const comp = res.comp;
  const real = res.real;
  if (comp instanceof Float64Array) {
    if (comp.length % 2 !== 0) return null;
    const n = comp.length / 2;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) { re[i] = comp[2 * i]!; im[i] = comp[2 * i + 1]!; }
    return { real: re, imag: im };
  }
  if (real instanceof Float64Array) return { real: real.slice(), imag: null };
  return null;
}
