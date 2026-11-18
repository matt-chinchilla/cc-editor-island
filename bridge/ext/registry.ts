// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// Every wave unit's file, bridge/ext/<unit>.ts, loaded by glob, checked and
// merged with the built ins: the one place the responder (bridge/responder.ts),
// the frames (src/frames.ts) and the generator (scripts/ext/gen.mjs) read the
// units from. A unit that breaks a rule is reported in `problems` (the
// registry test fails on any) and the offending entry is left out; nothing a
// unit declares can replace a built in.
import { ACTION_RE, HELD_ACTIONS, type HeldAction } from '../held';
import { BUILTIN_EVENTS, BUILTIN_EXPORT_JOBS, BUILTIN_OPS } from './builtins';
import {
  CAP_RE, EVENT_RE, FRAME_RE, JOB_RE, OP_RE, UNIT_ID_RE,
  type ExtOp, type ExtUnit, type FrameKind, type Widen,
} from './contract';
import PENDING from './pending.json';
import type { Frame } from '../../src/types';

const BUILTIN_FRAMES: readonly string[] = ['sch', 'pcb', 'symedit'];

export interface RegOp { unit: string; op: ExtOp; frames: readonly string[] | null; frameRefusal: string }

export interface Registry {
  /** The units loaded, by id order. */
  units: readonly ExtUnit[];
  /** New request ops, each with its unit. */
  ops: ReadonlyMap<string, RegOp>;
  /** Widening hooks per shipping op, in unit id order (the first wraps the op, each later one the one before). */
  widen: ReadonlyMap<string, ReadonlyArray<{ unit: string; fn: Widen }>>;
  /** New event types with their keys. */
  events: ReadonlyMap<string, { unit: string; keys: readonly string[] }>;
  /** The units' held rows (the built ins are bridge/held.ts HELD_ACTIONS). */
  heldRows: readonly HeldAction[];
  /** The units' export jobs (the built ins are bridge/exports.builtin.json). */
  exportJobs: Readonly<Record<string, 'pcb' | 'sch'>>;
  /** New frames with their descriptors. */
  frames: ReadonlyMap<string, { unit: string; kind: FrameKind }>;
  /** Pseudo-caps the units may list, each with its unit. */
  capNames: ReadonlyMap<string, string>;
  /** ev.prompt ask names, each with its unit. */
  asks: ReadonlyMap<string, string>;
  /** Ops the manifest names whose unit has not landed: answered unsupported with SEAM_PLACEHOLDER (never in island.json). */
  pending: ReadonlyMap<string, string>;
  /** Every rule a unit broke, one line each. */
  problems: readonly string[];
}

/** A glob path's stem: './fp-i1.ts' is 'fp-i1'. */
export const stemOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1).replace(/\.ts$/, '');

const strings = (v: unknown): v is readonly string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');

/**
 * The registry from the loaded modules (glob path to module) and the pending
 * ops (bridge/ext/pending.json: op to unit). Pure: the tests feed it units of
 * their own.
 */
export function buildRegistry(modules: Readonly<Record<string, unknown>>, pending: Readonly<Record<string, string>> = {}): Registry {
  const problems: string[] = [];
  const units: ExtUnit[] = [];
  for (const path of Object.keys(modules).sort()) {
    const stem = stemOf(path);
    const mod = modules[path] as { default?: unknown } | null;
    const u = mod?.default as ExtUnit | undefined;
    if (u == null || typeof u !== 'object') { problems.push(`${path}: no default export (an ExtUnit)`); continue; }
    if (typeof u.unit !== 'string' || !UNIT_ID_RE.test(u.unit)) { problems.push(`${path}: unit must be a unit id`); continue; }
    if (u.unit !== stem) { problems.push(`${path}: unit '${u.unit}' is not the file stem '${stem}'`); continue; }
    units.push(u);
  }
  units.sort((a, b) => (a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0));

  // Frames first: the ops, rows and descriptors below may name them.
  const frames = new Map<string, { unit: string; kind: FrameKind }>();
  for (const u of units) {
    for (const [name, kind] of Object.entries(u.defineFrames ?? {})) {
      if (!FRAME_RE.test(name) || BUILTIN_FRAMES.includes(name)) { problems.push(`${u.unit}: frame '${name}' is no new frame name`); continue; }
      if (frames.has(name)) { problems.push(`${u.unit}: frame '${name}' is already defined by ${frames.get(name)?.unit}`); continue; }
      const bad = frameKindProblem(kind);
      if (bad != null) { problems.push(`${u.unit}: frame '${name}': ${bad}`); continue; }
      frames.set(name, { unit: u.unit, kind });
    }
  }
  const isFrame = (f: unknown): boolean => typeof f === 'string' && (BUILTIN_FRAMES.includes(f) || frames.has(f));

  const ops = new Map<string, RegOp>();
  for (const u of units) {
    if (u.frames !== undefined && (!strings(u.frames) || !u.frames.every(isFrame))) problems.push(`${u.unit}: frames names a frame no one defines`);
    const opFrames = u.frames !== undefined && strings(u.frames) ? u.frames.filter(isFrame) : null;
    for (const [name, op] of Object.entries(u.ops ?? {})) {
      if (!OP_RE.test(name)) { problems.push(`${u.unit}: op '${name}' is no op name`); continue; }
      if (BUILTIN_OPS.includes(name)) { problems.push(`${u.unit}: op '${name}' ships already (widen it through opsWidened)`); continue; }
      if (ops.has(name)) { problems.push(`${u.unit}: op '${name}' is already ${ops.get(name)?.unit}'s`); continue; }
      if (op == null || typeof op.run !== 'function') { problems.push(`${u.unit}: op '${name}' has no run`); continue; }
      ops.set(name, { unit: u.unit, op, frames: opFrames, frameRefusal: typeof u.frameRefusal === 'string' && u.frameRefusal !== '' ? u.frameRefusal : `${name} does not run in this frame` });
    }
  }

  const widen = new Map<string, Array<{ unit: string; fn: Widen }>>();
  for (const u of units) {
    for (const [name, fn] of Object.entries(u.opsWidened ?? {})) {
      if (!BUILTIN_OPS.includes(name) && !ops.has(name)) { problems.push(`${u.unit}: opsWidened '${name}' is no op`); continue; }
      if (typeof fn !== 'function') { problems.push(`${u.unit}: opsWidened '${name}' is no function`); continue; }
      const list = widen.get(name) ?? [];
      list.push({ unit: u.unit, fn });
      widen.set(name, list);
    }
  }

  const events = new Map<string, { unit: string; keys: readonly string[] }>();
  for (const u of units) {
    for (const [type, keys] of Object.entries(u.events ?? {})) {
      if (!EVENT_RE.test(type) || BUILTIN_EVENTS.includes(type)) { problems.push(`${u.unit}: event '${type}' is no new event type`); continue; }
      if (events.has(type)) { problems.push(`${u.unit}: event '${type}' is already ${events.get(type)?.unit}'s`); continue; }
      if (!strings(keys) || keys.includes('type') || new Set(keys).size !== keys.length || !keys.every((k) => /^[a-z][A-Za-z0-9]*$/.test(k))) { problems.push(`${u.unit}: event '${type}' keys must be distinct words, never 'type'`); continue; }
      events.set(type, { unit: u.unit, keys: Object.freeze([...keys]) });
    }
  }

  const heldRows: HeldAction[] = [];
  const taken = new Set(HELD_ACTIONS.flatMap((h) => h.frames.map((f) => `${h.action} ${f}`)));
  for (const u of units) {
    const own = new Set<string>();
    for (const row of u.heldRows ?? []) {
      if (row == null || typeof row.action !== 'string' || !ACTION_RE.test(row.action)) { problems.push(`${u.unit}: a held row's action is no KiCad action name`); continue; }
      if (!strings(row.frames) || row.frames.length === 0 || !row.frames.every(isFrame)) { problems.push(`${u.unit}: held ${row.action}: frames must name defined frames`); continue; }
      if (typeof row.cap !== 'string' || !CAP_RE.test(row.cap)) { problems.push(`${u.unit}: held ${row.action}: cap is no cap`); continue; }
      const clash = row.frames.find((f) => taken.has(`${row.action} ${f}`));
      if (clash != null) { problems.push(`${u.unit}: held ${row.action} in ${clash} is held already`); continue; }
      for (const f of row.frames) taken.add(`${row.action} ${f}`);
      own.add(row.action);
      heldRows.push(Object.freeze({ action: row.action, frames: Object.freeze([...row.frames]) as readonly Frame[], cap: row.cap }));
    }
    for (const name of u.held ?? []) if (!own.has(name)) problems.push(`${u.unit}: held '${name}' has no held row of the unit`);
  }

  const exportJobs: Record<string, 'pcb' | 'sch'> = {};
  const jobUnit = new Map<string, string>();
  for (const u of units) {
    for (const [job, face] of Object.entries(u.exportJobs ?? {})) {
      if (!JOB_RE.test(job) || job in BUILTIN_EXPORT_JOBS) { problems.push(`${u.unit}: export job '${job}' is no new job`); continue; }
      if (jobUnit.has(job)) { problems.push(`${u.unit}: export job '${job}' is already ${jobUnit.get(job)}'s`); continue; }
      if (face !== 'pcb' && face !== 'sch') { problems.push(`${u.unit}: export job '${job}' face must be pcb or sch`); continue; }
      exportJobs[job] = face;
      jobUnit.set(job, u.unit);
    }
  }

  const capNames = new Map<string, string>();
  for (const u of units) {
    if (u.caps !== undefined && typeof u.caps !== 'function') problems.push(`${u.unit}: caps must be a function (mod, frame)`);
    if (u.caps !== undefined && u.capNames === undefined) problems.push(`${u.unit}: caps needs capNames, the caps it may list`);
    for (const cap of u.capNames ?? []) {
      if (typeof cap !== 'string' || !CAP_RE.test(cap)) { problems.push(`${u.unit}: cap '${String(cap)}' is no cap`); continue; }
      if (capNames.has(cap)) { problems.push(`${u.unit}: cap '${cap}' is already ${capNames.get(cap)}'s`); continue; }
      capNames.set(cap, u.unit);
    }
  }

  const asks = new Map<string, string>();
  for (const u of units) {
    for (const ask of u.asks ?? []) {
      if (typeof ask !== 'string' || !/^[a-z][A-Za-z0-9]*$/.test(ask)) { problems.push(`${u.unit}: ask '${String(ask)}' is no ask name`); continue; }
      if (asks.has(ask)) { problems.push(`${u.unit}: ask '${ask}' is already ${asks.get(ask)}'s`); continue; }
      asks.set(ask, u.unit);
    }
    if (u.install !== undefined && typeof u.install !== 'function') problems.push(`${u.unit}: install must be a function`);
  }

  const waiting = new Map<string, string>();
  for (const [op, unit] of Object.entries(pending)) if (!BUILTIN_OPS.includes(op) && !ops.has(op)) waiting.set(op, unit);

  return { units, ops, widen, events, heldRows, exportJobs, frames, capNames, asks, pending: waiting, problems };
}

/** What is wrong with a frame descriptor, or null. */
function frameKindProblem(k: FrameKind): string | null {
  if (k == null || typeof k !== 'object') return 'no descriptor';
  if (typeof k.token !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test(k.token)) return 'token';
  if (typeof k.tool === 'string' ? !['pcbnew', 'eeschema'].includes(k.tool) : (k.tool == null || typeof k.tool.name !== 'string' || !/^[a-z][a-z_]{0,31}$/.test(k.tool.name) || ['pcbnew', 'eeschema'].includes(k.tool.name) || k.tool.bundle !== 'kicad_editor' || typeof k.tool.argv0 !== 'string')) return 'tool';
  if (k.document !== null && (typeof k.document !== 'string' || !/^\.[a-z_]+$/.test(k.document))) return 'document';
  if (typeof k.extension !== 'string' || !/^\.[a-z_]+$/.test(k.extension)) return 'extension';
  if (typeof k.unitsPerMm !== 'number' || !(k.unitsPerMm > 0)) return 'unitsPerMm';
  if (k.pickKind !== 'symbol' && k.pickKind !== 'footprint') return 'pickKind';
  if (typeof k.picker !== 'boolean') return 'picker';
  if (!strings(k.refuses) || !k.refuses.every((op) => BUILTIN_OPS.includes(op))) return 'refuses must list ops that ship';
  if (typeof k.refusal !== 'string' || k.refusal === '') return 'refusal';
  if (k.caps !== undefined && !strings(k.caps)) return 'caps';
  return null;
}

const MODULES = import.meta.glob(['./*.ts', '!./*.test.ts', '!./contract.ts', '!./registry.ts', '!./builtins.ts'], { eager: true });

/** The registry of this checkout's units. */
export const REGISTRY: Registry = buildRegistry(MODULES, PENDING as Record<string, string>);

/** The held actions read at run time: the built ins and every unit's rows (m1-i's doors table reads this). */
export function heldActions(reg: Registry = REGISTRY): readonly HeldAction[] {
  return [...HELD_ACTIONS, ...reg.heldRows];
}

/** The export jobs project.export runs: the built ins and every unit's. */
export function exportJobs(reg: Registry = REGISTRY): Readonly<Record<string, 'pcb' | 'sch'>> {
  return { ...BUILTIN_EXPORT_JOBS, ...reg.exportJobs };
}

/** The request ops this island answers: the built ins, then every unit's, sorted (bridge/ops.json, island.json ops). */
export function requestOps(reg: Registry = REGISTRY): string[] {
  return [...BUILTIN_OPS, ...[...reg.ops.keys()].sort()];
}
