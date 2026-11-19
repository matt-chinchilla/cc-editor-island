// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// si1-i: a compiled model is refused before ngspice runs (ledger SI1). The
// simulator service is ngspice built for the browser: it loads no OSDI device,
// no XSPICE code model and no shared object, so a circuit that asks for one
// can only fail inside ngspice. The island reads the netlist KiCad writes
// (kicadSimNetlist) and every file it includes that the engine's file system
// holds (each at most 4 MiB, at most 64 files) and lists one problem
// { code: 'binary_model', severity: 'error', ref?, path, text } per line that
// names a compiled model: a line starting pre_osdi or codemodel, a d_cosim
// model or an XSPICE instance of one, or a model or include line naming a
// file ending .osdi, .cm, .va, .vams, .so, .dll or .dylib (a net or node name
// is never read as a file). sim.netlist lists them beside KiCad's own problems;
// sim.run answers circuit with the first one's text and runs nothing (no run
// is numbered, so no ev.sim is sent). The scan is pure and the island's own;
// no engine change.
import { fail, isObj, ok, type Answer, type ExtUnit, type ResponderCtx } from './contract';
import { MAX_PROBLEMS, PROBLEM_TEXT_MAX, SIM_RUN_EXPORTS, parseRunArgs, readNetlist } from '../sim';

/** The problem code of a compiled model. */
export const BINARY_MODEL = 'binary_model';
/** The file endings of a compiled model (OSDI, XSPICE code models, Verilog-A sources, shared objects). */
export const BINARY_ENDINGS = ['.osdi', '.cm', '.va', '.vams', '.so', '.dll', '.dylib'] as const;
/** Each scanned file is read to at most this many bytes. */
export const MAX_SCAN_BYTES = 4 * 1024 * 1024;
/** At most this many included files are read for one scan. */
export const MAX_SCAN_FILES = 64;

export interface BinaryModelProblem { code: 'binary_model'; severity: 'error'; ref?: string; path: string; text: string }

/** One logical line of a SPICE text: its text (continuations joined) and its tokens, quotes removed. */
interface Logical { text: string; tokens: string[] }

const TOKEN = /"([^"]*)"|'([^']*)'|([^\s"'=(),]+)/g;

function tokensOf(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(TOKEN)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out.filter((t) => t !== '');
}

/** Whether a name ends in one of the compiled model endings (any case). */
export function isBinaryName(name: string): boolean {
  const lower = name.toLowerCase();
  return BINARY_ENDINGS.some((end) => lower.endsWith(end) && lower.length > end.length);
}

/** The dot commands that read another file: their tokens are the only ones a file ending is read in, beside .model's. */
const INCLUDE_WORDS: readonly string[] = ['.include', '.inc', '.lib'];
/** The XSPICE co-simulation device, which loads a shared object. */
const COSIM = 'd_cosim';

/** The logical lines of a SPICE text: comments dropped, "+" continuations joined to the line before. */
export function logicalLines(text: string): Logical[] {
  const out: Logical[] = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    let line = raw.trim();
    if (line === '' || line.startsWith('*')) continue;
    // ngspice's inline comments: ";" anywhere, "$" between blanks.
    const semi = line.indexOf(';');
    if (semi >= 0) line = line.slice(0, semi);
    line = line.replace(/\s\$(\s.*)?$/, '').trim();
    if (line === '') continue;
    if (line.startsWith('+') && out.length > 0) {
      const prev = out[out.length - 1]!;
      prev.text = `${prev.text} ${line.slice(1).trim()}`.trim();
      prev.tokens = tokensOf(prev.text);
      continue;
    }
    out.push({ text: line, tokens: tokensOf(line) });
  }
  return out;
}

/** The designator of a netlist instance name: KiCad writes a device letter before a reference that lacks it (XU1 for U1). */
export function refOf(instance: string): string {
  return /^[A-Za-z][A-Za-z]/.test(instance) ? instance.slice(1) : instance;
}

/** What one file's text names: its compiled model lines and the files it includes. */
export function scanText(text: string, file: string): { hits: BinaryModelProblem[]; includes: string[] } {
  const hits: BinaryModelProblem[] = [];
  const includes: string[] = [];
  for (const line of logicalLines(text)) {
    const first = (line.tokens[0] ?? '').toLowerCase();
    const word = first.replace(/^\./, '');
    const model = first === '.model';
    const include = INCLUDE_WORDS.includes(first);
    // A file ending is read only in the tokens of a model or include line, never in a net or node name.
    const named = model || include ? line.tokens.slice(1).find(isBinaryName) : undefined;
    const loader = word === 'pre_osdi' || word === 'codemodel';
    // d_cosim only as a model's type or as the model an XSPICE instance (an A line) names last.
    const last = line.tokens.length > 1 ? (line.tokens[line.tokens.length - 1] ?? '').toLowerCase() : '';
    const cosim = model ? (line.tokens[2] ?? '').toLowerCase() === COSIM : first.startsWith('a') && last === COSIM;
    if (loader || cosim || named != null) {
      const p: BinaryModelProblem = { code: BINARY_MODEL, severity: 'error', path: named ?? (loader ? line.tokens[1] : undefined) ?? file, text: line.text.slice(0, PROBLEM_TEXT_MAX) };
      // An instance line (not a dot command or a control line) names its part.
      if (!first.startsWith('.') && !loader && /^[a-z]/.test(first)) p.ref = refOf(line.tokens[0]!);
      hits.push(p);
      continue;
    }
    if (include && line.tokens[1] != null) includes.push(line.tokens[1]);
  }
  return { hits, includes };
}

/** A path joined to a folder and normalized (no "." or ".." segment, no empty one). */
export function resolvePath(dir: string, path: string): string {
  const parts = (path.startsWith('/') ? path : `${dir}/${path}`).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') out.pop(); else out.push(p);
  }
  return `/${out.join('/')}`;
}

const dirOf = (abs: string): string => abs.slice(0, Math.max(0, abs.lastIndexOf('/'))) || '/';

/** A path as the host knows it: relative to the project folder when inside it. */
export function shownPath(abs: string, root: string): string {
  const r = root.replace(/\/+$/, '');
  return r !== '' && abs.startsWith(`${r}/`) ? abs.slice(r.length + 1) : abs;
}

export interface ScanSource {
  /** The project folder: the netlist's relative includes are read from it. */
  root: string;
  /** The name the netlist's own lines carry as their file (the schematic that makes it). */
  netlistName: string;
  /** A file's bytes from the engine's file system, or null when it holds none there. */
  read(abs: string): Uint8Array | null;
}

/** Every compiled model the netlist and its included files name, in reading order. */
export function scanNetlist(netlist: string, src: ScanSource): BinaryModelProblem[] {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const out: BinaryModelProblem[] = [];
  const first = scanText(netlist.slice(0, MAX_SCAN_BYTES), src.netlistName);
  out.push(...first.hits);
  const seen = new Set<string>();
  const queue = first.includes.map((p) => resolvePath(src.root, p));
  let files = 0;
  while (queue.length > 0 && files < MAX_SCAN_FILES && out.length < MAX_PROBLEMS) {
    const abs = queue.shift()!;
    if (seen.has(abs)) continue;
    seen.add(abs);
    let bytes: Uint8Array | null = null;
    try { bytes = src.read(abs); } catch { bytes = null; }
    if (bytes == null) continue;
    files += 1;
    const text = decoder.decode(bytes.subarray(0, MAX_SCAN_BYTES));
    const found = scanText(text, shownPath(abs, src.root));
    out.push(...found.hits);
    for (const inc of found.includes) queue.push(resolvePath(dirOf(abs), inc));
  }
  return out.slice(0, MAX_PROBLEMS).map((p) => (p.path.startsWith('/') ? { ...p, path: shownPath(p.path, src.root) } : p));
}

/** The scan's reads, from the engine's file system as the ctx holds it now. */
function sourceOf(ctx: ResponderCtx): ScanSource {
  const opened = ctx.opened() ?? '';
  return {
    root: ctx.root,
    netlistName: opened.slice(opened.lastIndexOf('/') + 1) || 'netlist',
    read: (abs) => ctx.readBytes(abs),
  };
}

/** sim.netlist widened: the compiled models listed after KiCad's own problems. */
export async function widenNetlist(args: unknown, ctx: ResponderCtx, next: (args: unknown) => Promise<Answer>): Promise<Answer> {
  const answer = await next(args);
  if (!answer.ok) return answer;
  const r = answer.result;
  if (typeof r.netlist !== 'string' || !Array.isArray(r.problems)) return answer;
  const found = scanNetlist(r.netlist, sourceOf(ctx));
  if (found.length === 0) return answer;
  return ok({ ...r, problems: [...r.problems, ...found].slice(0, MAX_PROBLEMS) });
}

/**
 * sim.run widened: before the run is queued, the netlist is read with the run's
 * options and scanned; a compiled model answers circuit with the first one's
 * text, and nothing runs. Every request the scan cannot take (bad args, an FFT,
 * which reruns no circuit, another frame, no engine export, no document, a live
 * run, a busy editor, a netlist of another shape) goes on to the op as it stood,
 * which answers it as before.
 */
export async function widenRun(args: unknown, ctx: ResponderCtx, next: (args: unknown) => Promise<Answer>): Promise<Answer> {
  const a = parseRunArgs(args);
  if (a == null || a.analysis.kind === 'fft') return next(args);
  if (ctx.frame !== 'sch' || !ctx.has(SIM_RUN_EXPORTS) || !ctx.hasDocument()) return next(args);
  if (ctx.simRun() != null || ctx.engineBusy() || ctx.keysBlocked() || ctx.placeHanging()) return next(args);
  const mod = ctx.mod();
  if (mod == null) return next(args);
  let raw = '';
  try { raw = String(await (mod.kicadSimNetlist as (json: string) => unknown)(JSON.stringify({ command: '.op', options: a.options })) ?? ''); } catch { raw = ''; }
  const read = readNetlist(raw);
  if (read == null) return next(args);
  const found = scanNetlist(read.netlist, sourceOf(ctx));
  if (found.length === 0) return next(args);
  ctx.log('[sim]', `refused: ${found.length} compiled model${found.length === 1 ? '' : 's'}`);
  return fail('circuit', found[0]!.text.slice(0, 1024));
}

export default {
  unit: 'si1-i',
  opsWidened: {
    'sim.netlist': widenNetlist,
    'sim.run': widenRun,
  },
} satisfies ExtUnit;

/** For tests: whether a value reads as one of this unit's problems. */
export const isBinaryModelProblem = (v: unknown): v is BinaryModelProblem =>
  isObj(v) && v.code === BINARY_MODEL && v.severity === 'error' && typeof v.path === 'string' && typeof v.text === 'string';
