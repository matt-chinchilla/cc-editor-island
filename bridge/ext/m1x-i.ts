// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The prompt host (PROTOCOL.md ev.prompt, the canvas commands addendum 4):
// KiCad's small dialogs asked of the host in place of their windows, and
// KiCad's Clearance and Constraints reports held for the board form's Rules
// block.
//
// Engine run 15 (kicad cc/main K-PROMPT) asks window.kicadHostPrompt.onAsk
// with JSON text { token, ask, modal, record } from a hooked dialog's own
// ShowModal (or Show, for a modeless one) before it would show. A truthy
// answer parks a modal dialog in the port's modal wait until
// kicadPromptAnswer accepts an answer or kicadPromptCancel cancels it; a
// modeless one stays open as KiCad's does. A falsy answer, a throw, or an
// engine without the slot shows KiCad's dialog as before. onUpdate carries a
// modeless prompt's new record (a pick's result), onEnd a prompt the engine
// ended itself (its tool canceled, its dialog destroyed).
//
// The frame takes an ask only when a unit declared its record shape
// (ctx.readAsk: this unit's entry, layer, message and assignNetclass, the
// placement, convert, zone and table units' own) and the record reads closed.
//
// While a modal prompt is parked the frame's document holds a hidden marker of
// the class KiCad's popup carries (bridge/modal.ts POPUP_SELECTOR), so the
// frame treats the prompt as it treats a dialog of KiCad's: key.press,
// view.fit and action.run answer busy, a save answers busy (the marker takes
// no Escape), the picker and the fit watch wait. ctx.holdMenus
// keeps ev.menu quiet for it: nothing of KiCad's is drawn.
import { POPUP_SELECTOR, WATCH_MS } from '../modal';
import { fail, hasAll, isObj, ok, onlyKeys, type Answer, type ExtUnit, type HeldRow, type ResponderCtx } from './contract';
import { answerFits, ASK_READERS, GENERIC_ASKS, isGenericAsk, MAX_ANSWER } from './m1x-i/asks';

/** The pseudo-cap: the engine asks the host in place of its small dialogs. */
export const PROMPTS_CAP = 'prompts';
/** The engine exports the cap needs (engine run 15, K-PROMPT, unit m1x-e1). */
export const PROMPT_EXPORTS = ['kicadHostPrompts', 'kicadPromptAnswer', 'kicadPromptCancel', 'kicadPromptPick'] as const;
/** Every editor frame's dialogs ask through the one header. */
export const PROMPT_FRAMES = ['sch', 'pcb', 'symedit', 'fpedit', 'ds'] as const;
/** The marker's attribute (its value the parked token). */
export const MARKER_ATTR = 'data-cc-host-prompt';
/** The cap of the board rules read (bridge/responder.ts RULES_CAP): the board form's Rules block. */
const RULES_CAP = 'rules';
/** KiCad's two resolution reports, held: the page opens the board form's Rules block for them. */
export const M1X_HELD_ROWS: readonly HeldRow[] = Object.freeze([
  Object.freeze({ action: 'pcbnew.InspectionTool.InspectClearance', frames: Object.freeze(['pcb']), cap: RULES_CAP }),
  Object.freeze({ action: 'pcbnew.InspectionTool.InspectConstraints', frames: Object.freeze(['pcb']), cap: RULES_CAP }),
]);
/** ev.menu stays held this long after the marker goes, so the menu watch sees it gone first. */
const RELEASE_MS = WATCH_MS + 20;
/** An ask's name as the engine writes it. */
const ASK_RE = /^[a-z][A-Za-z]{0,31}$/;
/** The longest engine text read at all. */
const MAX_EVENT = 4 * 1024 * 1024;
const PICK_KINDS = ['item', 'point'] as const;

type PromptSlot = { kicadHostPrompt?: { onAsk?: (json: unknown) => boolean; onUpdate?: (json: unknown) => void; onEnd?: (json: unknown) => void } };
type MarkerElement = { className: string; hidden: boolean; setAttribute(n: string, v: string): void; remove(): void };
type FrameDoc = { createElement?(tag: string): unknown; body?: { appendChild?(el: unknown): unknown } | null };
type FrameWin = PromptSlot & { document?: FrameDoc };

interface Parked { token: number; ask: string; modal: boolean; marker: MarkerElement | null }
interface State { parked: Map<number, Parked> }

/** Each responder's state, by its ctx (one ctx per responder). */
const states = new WeakMap<ResponderCtx, State>();

const engineCall = (ctx: ResponderCtx, name: string, ...args: unknown[]): unknown => (ctx.mod()?.[name] as (...a: unknown[]) => unknown)(...args);
const code = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) ? v : -1);
const isToken = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

/** The engine's JSON text (or an object), parsed; null for anything else. */
function parse(json: unknown): Record<string, unknown> | null {
  if (isObj(json)) return json;
  if (typeof json !== 'string' || json.length > MAX_EVENT) return null;
  try { const v: unknown = JSON.parse(json); return isObj(v) ? v : null; } catch { return null; }
}
const exact = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).length === keys.length && onlyKeys(o, keys);

/** The hidden marker KiCad's popup class names (null when the document cannot hold one). */
function addMarker(ctx: ResponderCtx, token: number): MarkerElement | null {
  const doc = (ctx.win() as unknown as FrameWin | null)?.document;
  try {
    const el = doc?.createElement?.('div') as MarkerElement | undefined;
    if (el == null || doc?.body?.appendChild == null) return null;
    el.className = POPUP_SELECTOR.replace(/^\./, '');
    el.hidden = true;
    el.setAttribute(MARKER_ATTR, String(token));
    el.setAttribute('aria-hidden', 'true');
    doc.body.appendChild(el);
    return el;
  } catch { return null; }
}

/** The prompt `token` is no longer parked: its marker goes, and ev.menu is let go once the watch saw it go. */
function forget(ctx: ResponderCtx, st: State, token: number): Parked | null {
  const p = st.parked.get(token);
  if (p == null) return null;
  st.parked.delete(token);
  if (p.modal) {
    try { p.marker?.remove(); } catch { /* a document that throws: nothing more to remove */ }
    setTimeout(() => ctx.holdMenus(false), RELEASE_MS);
  }
  return p;
}

/** The engine's ask: answers whether the host takes it. */
function onAsk(ctx: ResponderCtx, st: State, json: unknown): boolean {
  try {
    if (ctx.closed() || !ctx.ready() || !ctx.caps().includes(PROMPTS_CAP) || !ctx.hasDocument() || ctx.importing()) return false;
    const a = parse(json);
    if (a == null || !exact(a, ['token', 'ask', 'modal', 'record'])) return false;
    const { token, ask, modal } = a;
    if (!isToken(token) || typeof ask !== 'string' || !ASK_RE.test(ask) || typeof modal !== 'boolean') return false;
    const record = ctx.readAsk(ask, a.record);
    // No unit reads this ask, or its record is of another shape: KiCad's dialog shows.
    if (record == null) return false;
    if (st.parked.has(token)) forget(ctx, st, token);
    const p: Parked = { token, ask, modal, marker: null };
    st.parked.set(token, p);
    if (modal) {
      ctx.holdMenus(true);
      p.marker = addMarker(ctx, token);
    }
    try {
      ctx.emitExt('ev.prompt', { token, ask, modal, frame: ctx.frame, record });
    } catch {
      forget(ctx, st, token);
      return false;
    }
    return true;
  } catch { return false; }
}

/** A parked modeless prompt's new record (a pick's result, a later Show). */
function onUpdate(ctx: ResponderCtx, st: State, json: unknown): void {
  try {
    const u = parse(json);
    if (u == null || !exact(u, ['token', 'record']) || !isToken(u.token) || ctx.closed()) return;
    const p = st.parked.get(u.token);
    if (p == null) return;
    const record = ctx.readAsk(p.ask, u.record);
    if (record == null) { ctx.log('ev.promptUpdate dropped: a record of another shape for', p.ask); return; }
    ctx.emitExt('ev.promptUpdate', { token: p.token, record });
  } catch { /* the engine's call never unwinds through the host */ }
}

/** A prompt the engine ended itself. */
function onEnd(ctx: ResponderCtx, st: State, json: unknown): void {
  try {
    const e = parse(json);
    if (e == null || !exact(e, ['token', 'reason']) || !isToken(e.token)) return;
    // A prompt the host answered or canceled is already forgotten: nothing is sent for it.
    if (forget(ctx, st, e.token) == null || ctx.closed()) return;
    ctx.emitExt('ev.promptEnd', { token: e.token, reason: e.reason === 'canceled' ? 'canceled' : 'gone' });
  } catch { /* the engine's call never unwinds through the host */ }
}

/** Every parked prompt ends: canceled in the engine, the host told `reason` (none while closing). */
function endAll(ctx: ResponderCtx, st: State, reason: 'gone' | null): void {
  for (const token of [...st.parked.keys()]) {
    forget(ctx, st, token);
    if (hasAll(ctx.mod(), ['kicadPromptCancel'])) {
      try { engineCall(ctx, 'kicadPromptCancel', token); } catch { /* the wait is the engine's */ }
    }
    if (reason != null && !ctx.closed()) ctx.emitExt('ev.promptEnd', { token, reason });
  }
}

/** The common checks of the three ops: the args' token, the export, a parked prompt with that token. */
function parkedFor(op: string, exp: string, token: unknown, ctx: ResponderCtx): Answer | { st: State; p: Parked } {
  if (!isToken(token)) return fail('bad_args', op);
  if (!hasAll(ctx.mod(), [exp])) return fail('unsupported', exp);
  const st = states.get(ctx);
  const p = st?.parked.get(token);
  if (st == null || p == null) return fail('stale', op);
  return { st, p };
}

/** kicadPromptAnswer's text, as the op answers it. */
function readAnswer(op: string, raw: unknown): { accepted: true } | { accepted: false; field: string; message: string } | 'stale' | Answer {
  if (raw === '') return fail('bad_args', op);
  const v = parse(raw);
  if (v == null) return fail('island_error', `${op}: the engine answered another shape`);
  if (exact(v, ['stale']) && v.stale === true) return 'stale';
  if (exact(v, ['accepted']) && v.accepted === true) return { accepted: true };
  if (exact(v, ['accepted', 'field', 'message']) && v.accepted === false && typeof v.field === 'string' && typeof v.message === 'string') {
    return { accepted: false, field: v.field, message: v.message };
  }
  return fail('island_error', `${op}: the engine answered another shape`);
}

export default {
  unit: 'm1x-i',
  frames: [...PROMPT_FRAMES],
  frameRefusal: 'a prompt is answered in an editor frame',
  capNames: [PROMPTS_CAP],
  caps: (mod, frame) => ((PROMPT_FRAMES as readonly string[]).includes(frame) && hasAll(mod, PROMPT_EXPORTS) ? [PROMPTS_CAP] : []),
  held: M1X_HELD_ROWS.map((r) => r.action),
  heldRows: M1X_HELD_ROWS,
  events: {
    'ev.prompt': ['token', 'ask', 'modal', 'frame', 'record'],
    'ev.promptUpdate': ['token', 'record'],
    'ev.promptEnd': ['token', 'reason'],
  },
  asks: [...GENERIC_ASKS],
  askReaders: ASK_READERS,
  ops: {
    // The three are answered as they arrive: the engine is parked in the prompt, the queue would wait on it.
    'prompt.answer': {
      now: true,
      passesCheck: true,
      run(args, ctx) {
        const op = 'prompt.answer';
        if (!isObj(args)) return fail('bad_args', op);
        const { token, ...answer } = args;
        const c = parkedFor(op, 'kicadPromptAnswer', token, ctx);
        if ('ok' in c) return c;
        if (isGenericAsk(c.p.ask) && !answerFits(c.p.ask, answer)) return fail('bad_args', op);
        let json: string;
        try { json = JSON.stringify(answer); } catch { return fail('bad_args', op); }
        if (json.length > MAX_ANSWER) return fail('bad_args', op);
        let raw: unknown;
        try { raw = engineCall(ctx, 'kicadPromptAnswer', c.p.token, json); } catch { return fail('island_error', op); }
        const r = readAnswer(op, raw);
        if (r === 'stale') { forget(ctx, c.st, c.p.token); return fail('stale', op); }
        if ('ok' in r) return r;
        // A modal prompt resumes on an accepted answer; a modeless one may stay open (KiCad's Apply), so it is kept until the engine says otherwise.
        if (r.accepted && c.p.modal) forget(ctx, c.st, c.p.token);
        // The answer may change the selection inside the engine (Filter Selected Items) with no canvas event: read it.
        if (r.accepted) ctx.nudgeSelection();
        return ok(r);
      },
    },
    'prompt.cancel': {
      now: true,
      passesCheck: true,
      run(args, ctx) {
        const op = 'prompt.cancel';
        if (!isObj(args) || !exact(args, ['token'])) return fail('bad_args', op);
        const c = parkedFor(op, 'kicadPromptCancel', args.token, ctx);
        if ('ok' in c) return c;
        let r: number;
        try { r = code(engineCall(ctx, 'kicadPromptCancel', c.p.token)); } catch { return fail('island_error', op); }
        if (r !== 0 && r !== 1) return fail('island_error', `${op}: the engine answered ${r}`);
        // Canceled by the host, or already gone: the host closed its card, nothing is sent.
        forget(ctx, c.st, c.p.token);
        return r === 0 ? ok() : fail('stale', op);
      },
    },
    'prompt.pick': {
      now: true,
      passesCheck: true,
      run(args, ctx) {
        const op = 'prompt.pick';
        if (!isObj(args) || !exact(args, ['token', 'kind']) || !(PICK_KINDS as readonly unknown[]).includes(args.kind)) return fail('bad_args', op);
        const c = parkedFor(op, 'kicadPromptPick', args.token, ctx);
        if ('ok' in c) return c;
        let r: number;
        try { r = code(engineCall(ctx, 'kicadPromptPick', c.p.token, args.kind)); } catch { return fail('island_error', op); }
        switch (r) {
          case 0: return ok();
          case 1: forget(ctx, c.st, c.p.token); return fail('stale', op);
          case 2: return fail('no_picker', `${c.p.ask} has no ${String(args.kind)} picker`);
          default: return fail('island_error', `${op}: the engine answered ${r}`);
        }
      },
    },
  },
  opsWidened: {
    // The document goes: every parked prompt goes with it, and the host is told.
    'project.forget': async (args, ctx, next) => {
      const st = states.get(ctx);
      if (st != null) endAll(ctx, st, 'gone');
      return next(args);
    },
  },
  install(ctx) {
    const w = ctx.win() as unknown as FrameWin | null;
    if (w == null) return;
    const st: State = { parked: new Map() };
    states.set(ctx, st);
    const slot = {
      onAsk: (json: unknown): boolean => onAsk(ctx, st, json),
      onUpdate: (json: unknown): void => onUpdate(ctx, st, json),
      onEnd: (json: unknown): void => onEnd(ctx, st, json),
    };
    w.kicadHostPrompt = slot;
    return () => {
      endAll(ctx, st, null);
      if (w.kicadHostPrompt === slot) delete w.kicadHostPrompt;
      states.delete(ctx);
    };
  },
} satisfies ExtUnit;
