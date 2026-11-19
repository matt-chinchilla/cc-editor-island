// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-keys-i (PROTOCOL.md keys.editor.get and keys.editor.set): the editor's
// own hotkeys, read and set in a sch or pcb frame by our engine's run 15
// exports kicadHotkeysGet and kicadHotkeysSet (unit st-keys-e) with no KiCad
// window. The get answers every action of the frame's editor with the key it
// holds now, KiCad's default and its second key; the set writes PRIMARY keys
// only (the second key stays) and is no edit (no undo step, no modified flag).
// The keys last for the engine's life: a host sends its keys again at each
// ev.ready, so neither op waits for a document. A set never takes a chord the
// island seeds for a tool of the pencil case (theme/pencil-tools.json), but an
// action's own seeded chord given back to it (code taken). Feature detected:
// on an engine without both exports the cap hotkeys is not listed and the ops
// answer unsupported naming the export. KiCad's hotkey list (Ctrl+F1, its
// Help menu item) is held in the sch and pcb frames under heldKeys: the host
// opens its own Keys window instead.
import TABLE from '../../theme/pencil-tools.json';
import { ACTION_RE } from '../held';
import { fail, hasAll, isObj, noArgs, ok, type Answer, type ExtUnit, type HeldRow, type ResponderCtx } from './contract';

/** The engine exports both ops call. */
export const HOTKEYS_EXPORTS = ['kicadHotkeysGet', 'kicadHotkeysSet'] as const;
/** The cap a host gates its In the editor section on. */
export const HOTKEYS_CAP = 'hotkeys';
/** KiCad's hotkey list window, held in the sch and pcb frames. */
export const LIST_HOTKEYS = 'common.SuiteControl.listHotKeys';
/** keys.editor.set takes at most this many keys (the engine's bound). */
export const KEYS_MAX = 2048;
/** A get answers at most this many actions (a frame holds a few hundred). */
export const ACTIONS_MAX = 4096;
/** A key text is at most this long ("Ctrl+Alt+Shift+Num Pad 9" is 24). */
export const KEY_MAX = 32;
/** A friendly name is at most this long. */
export const LABEL_MAX = 256;

const GET = 'keys.editor.get';
const SET = 'keys.editor.set';
const FRAME_REFUSAL = 'the editor\'s keys are a sch or pcb frame\'s';
type Editor = 'sch' | 'pcb';

/** One action as keys.editor.get answers it. */
export interface EditorKey {
  action: string;
  key: string;
  default: string;
  /** KiCad's friendly name, absent when KiCad gives none. */
  label?: string;
  /** The second key ('' none). */
  alt: string;
}

const MODS = ['Ctrl', 'Alt', 'Shift'] as const;

/** A key text: a string of at most 32 characters with no control character ('' for none). */
export const isKeyText = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= KEY_MAX && !/[\u0000-\u001f\u007f]/.test(v);

/**
 * A key in one spelling for comparing two keys: the modifiers in KiCad's
 * order Ctrl, Alt, Shift, a letter in capitals ("shift+w" and "Shift+W" are
 * one key). '' stays ''; a text that is no chord of these parts compares as
 * written.
 */
export function keyOf(text: string): string {
  if (text === '') return '';
  let base: string;
  let mods: string[];
  if (text === '+') { base = '+'; mods = []; } else if (text.endsWith('++')) {
    base = '+';
    mods = text.slice(0, -2).split('+');
  } else {
    const parts = text.split('+');
    base = parts.pop() ?? '';
    mods = parts;
  }
  const lower = mods.map((m) => m.toLowerCase());
  const known = MODS.filter((m) => lower.includes(m.toLowerCase()));
  if (base === '' || known.length !== mods.length) return text;
  if (/^[a-z]$/.test(base)) base = base.toUpperCase();
  return [...known, base].join('+');
}

interface PencilRow { editor: string; action: string; seededKey: string | null }

/** Every chord the island seeds for a tool (any editor), with the actions it is seeded for: editor, then action. */
export const SEEDED: ReadonlyMap<string, ReadonlyArray<{ editor: string; action: string }>> = (() => {
  const m = new Map<string, Array<{ editor: string; action: string }>>();
  for (const r of TABLE as PencilRow[]) {
    if (typeof r.seededKey !== 'string' || r.seededKey === '') continue;
    const k = keyOf(r.seededKey);
    const list = m.get(k) ?? [];
    list.push({ editor: r.editor, action: r.action });
    m.set(k, list);
  }
  return m;
})();

/**
 * The seeded chord `key` would take from a tool, or null when it is free for
 * `action` in `editor`: no tool's seeded chord, or the action's own seeded
 * chord in that editor (a host putting the action's key back).
 */
export function seededHolder(editor: Editor, action: string, key: string): string | null {
  if (key === '') return null;
  const holders = SEEDED.get(keyOf(key));
  if (holders == null) return null;
  if (holders.some((h) => h.editor === editor && h.action === action)) return null;
  return holders[0].action;
}

/** keys.editor.set's args read closed: exactly `{ keys }`, 1 to 2,048 actions, each a key text ('' none). Null for any other shape. */
export function parseSetArgs(args: unknown): Record<string, string> | null {
  if (!isObj(args) || Object.keys(args).length !== 1 || !('keys' in args)) return null;
  const keys = args.keys;
  if (!isObj(keys)) return null;
  const entries = Object.entries(keys);
  if (entries.length < 1 || entries.length > KEYS_MAX) return null;
  const out: Record<string, string> = {};
  for (const [action, key] of entries) {
    if (!ACTION_RE.test(action) || !isKeyText(key)) return null;
    out[action] = key;
  }
  return out;
}

const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
};

/** kicadHotkeysGet's answer read closed for `editor`: `{ editor, actions: [{ name, label, key, default, alt }] }`. Null for any other shape (an action twice, the other editor). */
export function readHotkeys(raw: unknown, editor: Editor): EditorKey[] | null {
  if (typeof raw !== 'string' || raw === '') return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!isObj(v) || !exactKeys(v, ['editor', 'actions']) || v.editor !== editor) return null;
  if (!Array.isArray(v.actions) || v.actions.length > ACTIONS_MAX) return null;
  const out: EditorKey[] = [];
  const seen = new Set<string>();
  for (const a of v.actions) {
    if (!isObj(a) || !exactKeys(a, ['name', 'label', 'key', 'default', 'alt'])) return null;
    const { name, label, key, default: dflt, alt } = a;
    if (typeof name !== 'string' || !ACTION_RE.test(name) || seen.has(name)) return null;
    if (typeof label !== 'string' || label.length > LABEL_MAX || /[\u0000-\u001f\u007f]/.test(label)) return null;
    if (!isKeyText(key) || !isKeyText(dflt) || !isKeyText(alt)) return null;
    seen.add(name);
    const row: EditorKey = { action: name, key, default: dflt, alt };
    if (label.trim() !== '') row.label = label;
    out.push(row);
  }
  return out;
}

/**
 * The checks of both ops after their args, in order: the engine (not_ready
 * before ev.ready, unsupported naming a missing export), then busy while a
 * load is parked or a popup menu or a dialog is up. No document is needed:
 * the keys are the editor's, not the design's.
 */
function gate(ctx: ResponderCtx, op: string): Answer | { mod: Record<string, unknown> } {
  const mod = ctx.mod();
  if (!ctx.ready() || ctx.win() == null || mod == null) return fail('not_ready', op);
  for (const name of HOTKEYS_EXPORTS) if (typeof mod[name] !== 'function') return fail('unsupported', name);
  if (ctx.engineBusy() || ctx.keysBlocked()) return fail('busy', op);
  return { mod };
}
const gateRefused = (g: Answer | { mod: Record<string, unknown> }): g is Answer => 'ok' in g;
const editorOf = (ctx: ResponderCtx): Editor => (ctx.frame === 'pcb' ? 'pcb' : 'sch');

/** keys.editor.get: no args; one call of kicadHotkeysGet, read closed. A read: answered during a check. */
function get(args: unknown, ctx: ResponderCtx): Answer {
  if (!noArgs(args)) return fail('bad_args', GET);
  const g = gate(ctx, GET);
  if (gateRefused(g)) return g;
  let raw: unknown;
  try { raw = (g.mod.kicadHotkeysGet as () => unknown)(); } catch { return fail('island_error', 'the engine could not read the keys'); }
  if (raw === '') return fail('busy', GET);
  const editor = editorOf(ctx);
  const actions = readHotkeys(raw, editor);
  if (actions == null) return fail('island_error', 'the engine answered keys of another shape');
  return ok({ editor, actions });
}

/**
 * keys.editor.set: the args (bad_args), a seeded chord of another action
 * (taken, nothing sent), the gate, then one call of kicadHotkeysSet, all or
 * nothing: false (an action this editor lacks, a key KiCad cannot read) is
 * bad_args and nothing changed.
 */
function set(args: unknown, ctx: ResponderCtx): Answer {
  const keys = parseSetArgs(args);
  if (keys == null) return fail('bad_args', SET);
  const editor = editorOf(ctx);
  for (const [action, key] of Object.entries(keys)) {
    const holder = seededHolder(editor, action, key);
    if (holder != null) return fail('taken', `${key} is the island's chord for ${holder}`);
  }
  const g = gate(ctx, SET);
  if (gateRefused(g)) return g;
  let done: unknown;
  try { done = (g.mod.kicadHotkeysSet as (json: string) => unknown)(JSON.stringify({ keys })); } catch { return fail('island_error', 'the engine could not set the keys'); }
  if (done !== true) return fail('bad_args', 'the engine refused the keys');
  return ok({});
}

const HELD_ROWS: readonly HeldRow[] = [{ action: LIST_HOTKEYS, frames: ['sch', 'pcb'], cap: 'heldKeys' }];

export default {
  unit: 'st-keys-i',
  frames: ['sch', 'pcb'],
  frameRefusal: FRAME_REFUSAL,
  capNames: [HOTKEYS_CAP],
  caps: (mod, frame) => ((frame === 'sch' || frame === 'pcb') && hasAll(mod, HOTKEYS_EXPORTS) ? [HOTKEYS_CAP] : []),
  held: [LIST_HOTKEYS],
  heldRows: HELD_ROWS,
  ops: {
    [GET]: { run: get, passesCheck: true },
    [SET]: { run: set },
  },
} satisfies ExtUnit;
