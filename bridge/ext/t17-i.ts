// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// Engine build T17's reads (engine run 15, items 8, 12, 14 and 15), each
// feature detected on the export it needs, so an older engine lists none of
// their caps and answers each op unsupported naming the export:
//
// - libs.problems (cap libTableProblems, kicadLibraryTableProblems): the
//   library tables KiCad could not read at its last pass over them, in place
//   of the warning window KiCad showed at engine start.
// - actions.state (cap actionStates, kicadActionStates): whether each named
//   KiCad action reads checked now, as KiCad marks it in its menus.
// - ev.tool (cap activeTool, kicadHostToolChanges and kicadActiveTool): the
//   tool KiCad holds, once right after ev.ready and on each change after
//   (bridge/hostTool.ts, whose slot src/main.ts takes before boot).
// - the cap menuClarify (kicadActionStates, a name only build T17 has): this
//   engine marks ev.contextMenu clarify only for KiCad's clarify list (item 12).
import { ACTION_RE } from '../held';
import { ACTIVE_TOOL_EXPORT, HOST_TOOL_EXPORT, hostToolSlot, readActiveTool, type HostToolWindow } from '../hostTool';
import { fail, hasAll, isObj, noArgs, ok, type Answer, type ExtUnit, type ResponderCtx } from './contract';

/** kicadLibraryTableProblems: the tables KiCad could not read. */
export const LIB_PROBLEMS_EXPORT = 'kicadLibraryTableProblems';
export const LIB_PROBLEMS_CAP = 'libTableProblems';
/** kicadActionStates: the checked state of named actions. */
export const ACTION_STATES_EXPORT = 'kicadActionStates';
export const ACTION_STATES_CAP = 'actionStates';
/** The engine marks clarify on its clarify list only (build T17; kicadActionStates is the build's own name). */
export const MENU_CLARIFY_CAP = 'menuClarify';
/** The tool KiCad holds. */
export const ACTIVE_TOOL_CAP = 'activeTool';
export const TOOL_EXPORTS = [HOST_TOOL_EXPORT, ACTIVE_TOOL_EXPORT] as const;
export const TOOL_EVENT = 'ev.tool';

/** The table kinds KiCad reads. */
export const TABLE_KINDS = ['symbol', 'footprint', 'designBlock'] as const;
export type TableKind = typeof TABLE_KINDS[number];
export interface TableProblem { path: string; kind: TableKind; message: string }
/** At most this many tables (a project and the global scope, three kinds each, with room). */
export const TABLES_MAX = 64;
/** A path or a message is at most this long. */
export const TEXT_MAX = 4096;
/** actions.state takes 1 to this many names (the engine's bound). */
export const ACTIONS_MAX = 256;
/** How long actions.state waits for the apply queue, so an action.run just sent has run. */
export const STATES_IDLE_MS = 1000;

const LIBS_OP = 'libs.problems';
const STATES_OP = 'actions.state';
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const isText = (v: unknown): v is string => typeof v === 'string' && v.length <= TEXT_MAX && !CONTROL_RE.test(v);

/** kicadLibraryTableProblems()'s answer read closed: exactly `{ tables: [{ path, kind, message }] }`, no path twice. Null otherwise. */
export function readTableProblems(raw: unknown): TableProblem[] | null {
  if (typeof raw !== 'string' || raw === '') return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!isObj(v) || Object.keys(v).length !== 1 || !Array.isArray(v.tables) || v.tables.length > TABLES_MAX) return null;
  const out: TableProblem[] = [];
  const seen = new Set<string>();
  for (const t of v.tables as unknown[]) {
    if (!isObj(t) || Object.keys(t).length !== 3) return null;
    const { path, kind, message } = t;
    if (!isText(path) || path === '' || !isText(message) || typeof kind !== 'string' || !(TABLE_KINDS as readonly string[]).includes(kind)) return null;
    if (seen.has(path)) return null;
    seen.add(path);
    out.push({ path, kind: kind as TableKind, message });
  }
  return out;
}

/** actions.state's args read closed: exactly `{ actions }`, 1 to 256 action names. Null otherwise. */
export function parseActionsState(args: unknown): string[] | null {
  if (!isObj(args) || Object.keys(args).length !== 1 || !Array.isArray(args.actions)) return null;
  const list = args.actions as unknown[];
  if (list.length < 1 || list.length > ACTIONS_MAX) return null;
  return list.every((a) => typeof a === 'string' && ACTION_RE.test(a)) ? (list as string[]) : null;
}

/**
 * kicadActionStates' answer read closed against the names asked: exactly
 * `{ states }`, one key per distinct name asked and no other, each true,
 * false or null. Null for "" or any other shape.
 */
export function readActionStates(raw: unknown, asked: readonly string[]): Record<string, boolean | null> | null {
  if (typeof raw !== 'string' || raw === '') return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!isObj(v) || Object.keys(v).length !== 1 || !isObj(v.states)) return null;
  const states = v.states;
  const want = new Set(asked);
  const keys = Object.keys(states);
  if (keys.length !== want.size || !keys.every((k) => want.has(k))) return null;
  const out: Record<string, boolean | null> = {};
  for (const k of keys) {
    const s = states[k];
    if (s !== true && s !== false && s !== null) return null;
    out[k] = s;
  }
  return out;
}

/** The engine up and holding `name`: its module, or the refusal. */
function engineWith(op: string, ctx: ResponderCtx, name: string): Answer | { mod: Record<string, unknown> } {
  const mod = ctx.win() == null ? null : ctx.mod();
  if (mod == null) return fail('not_ready', op);
  if (typeof mod[name] !== 'function') return fail('unsupported', name);
  return { mod };
}
const refusedBy = (g: Answer | { mod: Record<string, unknown> }): g is Answer => 'ok' in g;

/** libs.problems: the tables KiCad could not read. A read, in any frame, a document open or not. */
export function libsProblems(args: unknown, ctx: ResponderCtx): Answer {
  if (!noArgs(args)) return fail('bad_args', LIBS_OP);
  const g = engineWith(LIBS_OP, ctx, LIB_PROBLEMS_EXPORT);
  if (refusedBy(g)) return g;
  let raw: unknown;
  try { raw = (g.mod[LIB_PROBLEMS_EXPORT] as () => unknown)(); } catch { return fail('island_error', LIBS_OP); }
  const tables = readTableProblems(raw);
  return tables == null ? fail('island_error', `${LIBS_OP}: the engine answered another shape`) : ok({ tables });
}

/**
 * actions.state: each action's checked state as KiCad's own menus read it.
 * Waits first for the apply queue (1 s at most), so an action.run sent just
 * before has run: busy when it has not.
 */
export async function actionsState(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const actions = parseActionsState(args);
  if (actions == null) return fail('bad_args', STATES_OP);
  const g = engineWith(STATES_OP, ctx, ACTION_STATES_EXPORT);
  if (refusedBy(g)) return g;
  if (ctx.engineBusy()) return fail('busy', STATES_OP);
  if (!(await ctx.applyIdle(STATES_IDLE_MS))) return fail('busy', STATES_OP);
  let raw: unknown;
  try { raw = (g.mod[ACTION_STATES_EXPORT] as (json: string) => unknown)(JSON.stringify({ actions })); } catch { return fail('island_error', STATES_OP); }
  // "" for args we checked: no frame of KiCad's up, or an open in flight.
  if (raw === '') return fail('not_ready', STATES_OP);
  const states = readActionStates(raw, actions);
  return states == null ? fail('island_error', `${STATES_OP}: the engine answered another shape`) : ok({ states });
}

/**
 * ev.tool: the listener on the slot src/main.ts took before boot (taken here
 * when it was not), each name sent only after ev.ready and only when it is
 * not the one sent last; right after ev.ready, kicadActiveTool() once.
 */
function installToolWatch(ctx: ResponderCtx): (() => void) | undefined {
  const w = ctx.win();
  if (w == null || !ctx.has(TOOL_EXPORTS)) return undefined;
  const slot = hostToolSlot(w as unknown as HostToolWindow);
  let sent: string | null = null;
  let stopped = false;
  const send = (name: string): void => {
    if (stopped || !ctx.ready() || ctx.closed() || name === sent) return;
    sent = name;
    ctx.emitExt(TOOL_EVENT, { name });
  };
  const unlisten = slot.listen(send);
  // install runs before ev.ready goes out, in the same task: this runs after it.
  queueMicrotask(() => {
    if (stopped) return;
    let now: string | null = null;
    try { now = readActiveTool((ctx.mod()?.[ACTIVE_TOOL_EXPORT] as () => unknown)()); } catch { now = null; }
    const name = now ?? slot.latest();
    if (name != null) send(name);
  });
  return () => { stopped = true; unlisten(); };
}

export default {
  unit: 't17-i',
  ops: {
    [LIBS_OP]: { run: libsProblems, passesCheck: true },
    [STATES_OP]: { run: actionsState, passesCheck: true },
  },
  capNames: [LIB_PROBLEMS_CAP, ACTION_STATES_CAP, MENU_CLARIFY_CAP, ACTIVE_TOOL_CAP],
  caps: (mod) => [
    ...(hasAll(mod, [LIB_PROBLEMS_EXPORT]) ? [LIB_PROBLEMS_CAP] : []),
    ...(hasAll(mod, [ACTION_STATES_EXPORT]) ? [ACTION_STATES_CAP, MENU_CLARIFY_CAP] : []),
    ...(hasAll(mod, TOOL_EXPORTS) ? [ACTIVE_TOOL_CAP] : []),
  ],
  events: { [TOOL_EVENT]: ['name'] },
  install: installToolWatch,
} satisfies ExtUnit;
