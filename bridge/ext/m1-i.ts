// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// Our context menu (PROTOCOL.md ev.contextMenu, the canvas commands addendum
// 3.2): KiCad's canvas menu drawn by the host in place of KiCad's popup, and
// any tool action run by name.
//
// Engine run 15 (kicad cc/main K-MENU) asks window.kicadHostMenu.onMenu with
// the menu KiCad built for a right click (TOOL_MANAGER::DispatchContextMenu,
// the clarify-selection list included) before it would pop it up. A truthy
// answer parks KiCad in the menu (a registered wait, as a modal dialog) until
// kicadContextMenuChoose resolves it; then KiCad replays the choice as its own
// popup does, so a held action still ends as ev.held. A falsy answer, a throw,
// or an engine without the slot shows KiCad's popup as before (and ev.menu
// says so). kicadRunAction runs one tool action by name with no menu.
//
// While a menu is parked the frame's document holds a hidden marker of the
// class KiCad's own popup carries (bridge/modal.ts POPUP_SELECTOR), so the
// frame treats our menu as it treats KiCad's: key.press and view.fit answer
// busy, a schematic project.save closes it with Escape and then saves, the
// picker and the fit watch wait. ctx.holdMenus keeps ev.menu quiet for it.
import { POPUP_SELECTOR, WATCH_MS } from '../modal';
import { ACTION_RE, heldTaken } from '../held';
import { drawingSurface } from '../view';
import { isIslandKey } from '../../src/keys';
import { fail, hasAll, isObj, ok, onlyKeys, type Answer, type ExtUnit, type ResponderCtx } from './contract';
import { doorOf } from './m1-i/doors';
import { buildItems, isItemId, readEngineMenu, type Sent } from './m1-i/menu';

/** The pseudo-cap: the engine hands its context menus to the host and runs actions by name. */
export const CONTEXT_MENU_CAP = 'contextMenu';
/** The engine exports the cap needs (engine run 15, K-MENU). */
export const MENU_EXPORTS = ['kicadHostContextMenu', 'kicadContextMenuChoose', 'kicadContextMenuHighlight', 'kicadRunAction'] as const;
/** KiCad's keyboard menu: a right click at its own cursor (common_tools.cpp). */
export const SHOW_CONTEXT_MENU = 'common.Control.showContextMenu';
/** Every frame dispatches through TOOL_MANAGER, so the one hook serves them all. */
export const MENU_FRAMES = ['sch', 'pcb', 'symedit', 'fpedit', 'ds'] as const;
/** The marker's attribute (its value the parked token). */
export const MARKER_ATTR = 'data-cc-host-menu';
/** The browser's keyboard contextmenu event follows our key within this long. */
const KEY_MENU_MS = 1000;
/** ev.menu stays held this long after the marker goes, so the menu watch sees it gone first. */
const RELEASE_MS = WATCH_MS + 20;

type MenuSlot = { kicadHostMenu?: { onMenu?: (json: unknown) => boolean } };
type Listen = (type: string, fn: (e: Event) => void, opts?: boolean) => void;
type MarkerElement = { className: string; hidden: boolean; setAttribute(n: string, v: string): void; addEventListener: Listen; remove(): void };
type FrameDoc = { createElement?(tag: string): unknown; body?: { appendChild?(el: unknown): unknown } | null; activeElement?: unknown };
type FrameWin = MenuSlot & { document?: FrameDoc; addEventListener?: Listen; removeEventListener?: Listen };

interface Parked { token: number; sent: ReadonlyMap<number, Sent>; marker: MarkerElement | null }
interface State { parked: Parked | null; keyMenuAt: number }

/** Each responder's state, by its ctx (one ctx per responder, read state at call time). */
const states = new WeakMap<ResponderCtx, State>();

const engineCall = (ctx: ResponderCtx, name: string, ...args: unknown[]): unknown => (ctx.mod()?.[name] as (...a: unknown[]) => unknown)(...args);
const code = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) ? v : -1);

/**
 * The menu's point in the frame document's CSS pixels. The engine's point is
 * the view's own screen point (KIGFX::VIEW::ToScreen), measured from the
 * drawing canvas's corner in KiCad's logical pixels, which are CSS pixels at
 * every screen density: it is never scaled by the canvas's backing store,
 * which is twice the canvas's CSS size from density 1.5 up.
 */
export function cssPoint(doc: unknown, at: { x: number; y: number }): { x: number; y: number } {
  const c = drawingSurface(doc) as (ReturnType<typeof drawingSurface> & { getBoundingClientRect?: () => { left: number; top: number } }) | null;
  const round = (n: number): number => Math.round(n * 100) / 100;
  if (c == null || typeof c.getBoundingClientRect !== 'function') return at;
  try {
    const r = c.getBoundingClientRect();
    return { x: round(r.left + at.x), y: round(r.top + at.y) };
  } catch { return at; }
}

/** The hidden marker KiCad's popup class names (null when the document cannot hold one). */
function addMarker(ctx: ResponderCtx, st: State, token: number): MarkerElement | null {
  const doc = (ctx.win() as unknown as FrameWin | null)?.document;
  try {
    const el = doc?.createElement?.('div') as MarkerElement | undefined;
    if (el == null || doc?.body?.appendChild == null) return null;
    el.className = POPUP_SELECTOR.replace(/^\./, '');
    el.hidden = true;
    el.setAttribute(MARKER_ATTR, String(token));
    el.setAttribute('aria-hidden', 'true');
    // bridge/modal.ts dismissPopups closes a popup as Escape does: a save closes ours first.
    el.addEventListener('keydown', (e: Event) => { if ((e as KeyboardEvent).key === 'Escape') cancel(ctx, st, 'canceled'); });
    doc.body.appendChild(el);
    return el;
  } catch { return null; }
}

/**
 * The parked menu ends: its marker goes, ev.menu is let go once the watch saw
 * it go, and (resolve) the engine's wait is canceled. `reason` sends
 * ev.contextMenuEnd (never for the host's own contextMenu.choose); an engine
 * that had already ended the wait makes it `gone`.
 */
function end(ctx: ResponderCtx, st: State, reason: 'canceled' | 'gone' | null, resolve: boolean): void {
  const p = st.parked;
  if (p == null) return;
  st.parked = null;
  try { p.marker?.remove(); } catch { /* a document that throws: nothing more to remove */ }
  setTimeout(() => ctx.holdMenus(false), RELEASE_MS);
  let gone = reason === 'gone';
  if (resolve && hasAll(ctx.mod(), ['kicadContextMenuChoose'])) {
    try { gone = code(engineCall(ctx, 'kicadContextMenuChoose', p.token, -1)) === 1 || gone; } catch { /* the wait is the engine's */ }
  }
  if (reason != null && !ctx.closed()) ctx.emitExt('ev.contextMenuEnd', { token: p.token, reason: gone ? 'gone' : reason });
}

/** A press, Escape, a save or the close cancels the parked menu (nothing chosen). */
function cancel(ctx: ResponderCtx, st: State, reason: 'canceled'): void {
  end(ctx, st, reason, true);
}

/** The engine's slot: answers whether the host takes this menu. */
function onMenu(ctx: ResponderCtx, st: State, json: unknown): boolean {
  try {
    if (ctx.closed() || !ctx.ready() || !ctx.caps().includes(CONTEXT_MENU_CAP) || !ctx.hasDocument() || ctx.importing()) return false;
    const menu = readEngineMenu(json);
    if (menu == null) return false;
    // A menu still parked here was ended by the engine itself.
    if (st.parked != null) end(ctx, st, 'gone', false);
    const caps = ctx.caps();
    const held = ctx.heldRows();
    const built = buildItems(menu.items, (action) => doorOf(action, ctx.frame, caps, held));
    ctx.holdMenus(true);
    st.parked = { token: menu.token, sent: built.sent, marker: null };
    try {
      st.parked.marker = addMarker(ctx, st, menu.token);
      ctx.emitExt('ev.contextMenu', {
        token: menu.token, clarify: menu.clarify, frame: ctx.frame, at: cssPoint(ctx.win()?.document, menu.at),
        title: menu.title, kinds: menu.kinds, items: built.items, omitted: built.omitted,
      });
    } catch {
      end(ctx, st, null, false);
      return false;
    }
    return true;
  } catch { return false; }
}

/** A text field has the keyboard: our keys stay out of it. */
function typing(target: unknown): boolean {
  const el = target as { tagName?: unknown; isContentEditable?: unknown } | null;
  if (el == null || typeof el.tagName !== 'string') return false;
  return /^(INPUT|TEXTAREA|SELECT)$/i.test(el.tagName) || el.isContentEditable === true;
}

/** The ContextMenu key or Shift+F10 asks KiCad's keyboard menu: only with nothing over the canvas. */
function keyMenuWanted(ctx: ResponderCtx, e: KeyboardEvent): boolean {
  const key = e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey);
  if (!key || isIslandKey(e) || typing(e.target)) return false;
  return ctx.ready() && !ctx.closed() && ctx.caps().includes(CONTEXT_MENU_CAP) && ctx.hasDocument() && !ctx.importing()
    && !ctx.engineBusy() && !ctx.keysBlocked() && hasAll(ctx.mod(), ['kicadRunAction']);
}

/** The engine's answer to a choose or highlight, as the op answers it. */
function menuAnswer(op: string, c: number): Answer {
  switch (c) {
    case 0: return ok();
    case 1: return fail('stale', op);
    case 2: return fail('no_item', op);
    case 3: return fail('disabled', op);
    case 4: return fail('no_item', `${op}: a submenu or a separator`);
    default: return fail('island_error', `${op}: the engine answered ${c}`);
  }
}

/** contextMenu.choose and contextMenu.highlight: the args, the parked menu and the item checked. */
function checkPick(op: string, args: unknown, ctx: ResponderCtx, cancelOk: boolean): Answer | { st: State; token: number; id: number } {
  if (!isObj(args) || !onlyKeys(args, ['token', 'id'])) return fail('bad_args', op);
  const { token, id } = args;
  if (typeof token !== 'number' || !Number.isSafeInteger(token)) return fail('bad_args', op);
  if (!((cancelOk && id === -1) || isItemId(id))) return fail('bad_args', op);
  const exp = op === 'contextMenu.choose' ? 'kicadContextMenuChoose' : 'kicadContextMenuHighlight';
  if (!hasAll(ctx.mod(), [exp])) return fail('unsupported', exp);
  const st = states.get(ctx);
  if (st?.parked == null || st.parked.token !== token) return fail('stale', op);
  if (id !== -1) {
    // Only an item the host was sent: an omitted action has no door here.
    const s = st.parked.sent.get(id as number);
    if (s == null || s.type === 'submenu') return fail('no_item', op);
    if (!s.enabled) return fail('disabled', op);
  }
  return { st, token, id: id as number };
}

export default {
  unit: 'm1-i',
  frames: [...MENU_FRAMES],
  frameRefusal: 'our context menu runs in an editor frame',
  capNames: [CONTEXT_MENU_CAP],
  caps: (mod, frame) => ((MENU_FRAMES as readonly string[]).includes(frame) && hasAll(mod, MENU_EXPORTS) ? [CONTEXT_MENU_CAP] : []),
  events: {
    'ev.contextMenu': ['token', 'clarify', 'frame', 'at', 'title', 'kinds', 'items', 'omitted'],
    'ev.contextMenuEnd': ['token', 'reason'],
  },
  ops: {
    // Answered as it arrives: the engine is parked in the menu, the queue would wait on it forever.
    'contextMenu.choose': {
      now: true,
      passesCheck: true,
      run(args, ctx) {
        const op = 'contextMenu.choose';
        const c = checkPick(op, args, ctx, true);
        if ('ok' in c) return c;
        let r: number;
        try { r = code(engineCall(ctx, 'kicadContextMenuChoose', c.token, c.id)); } catch { return fail('island_error', op); }
        // Chosen or canceled by the host, or already gone: the host closed its menu, nothing is sent.
        if (r === 0 || r === 1) end(ctx, c.st, null, false);
        return menuAnswer(op, r);
      },
    },
    'contextMenu.highlight': {
      now: true,
      passesCheck: true,
      run(args, ctx) {
        const op = 'contextMenu.highlight';
        const c = checkPick(op, args, ctx, false);
        if ('ok' in c) return c;
        let r: number;
        try { r = code(engineCall(ctx, 'kicadContextMenuHighlight', c.token, c.id)); } catch { return fail('island_error', op); }
        // The engine ended the wait itself: the host's menu is still open, so it is told.
        if (r === 1) end(ctx, c.st, 'gone', false);
        return menuAnswer(op, r);
      },
    },
    // Queued, as key.press is.
    'action.run': {
      run(args, ctx) {
        const op = 'action.run';
        if (!isObj(args) || !onlyKeys(args, ['name']) || typeof args.name !== 'string' || !ACTION_RE.test(args.name)) return fail('bad_args', op);
        const name = args.name;
        // The engine never asks whether an action is held when it runs one by name: the island refuses first.
        if (heldTaken(name, ctx.frame, ctx.caps(), ctx.heldRows())) return fail('held', name);
        if (!hasAll(ctx.mod(), ['kicadRunAction'])) return fail('unsupported', 'kicadRunAction');
        if (!ctx.hasDocument()) return fail('not_ready', op);
        if (doorOf(name, ctx.frame, ctx.caps(), ctx.heldRows()) == null) return fail('unsupported', `${name} opens a window of KiCad's with no door in this frame`);
        if (ctx.engineBusy() || ctx.keysBlocked() || ctx.placeHanging() || states.get(ctx)?.parked != null) return fail('busy', op);
        let r: number;
        try { r = code(engineCall(ctx, 'kicadRunAction', name)); } catch { return fail('island_error', op); }
        switch (r) {
          case 0: return ok();
          case 1: return fail('unknown_action', name);
          case 3: return fail('busy', op);
          case 4: return fail('not_ready', op);
          default: return fail('island_error', `${op}: the engine answered ${r}`);
        }
      },
    },
  },
  install(ctx) {
    const w = ctx.win() as unknown as FrameWin | null;
    if (w == null) return;
    const st: State = { parked: null, keyMenuAt: 0 };
    states.set(ctx, st);
    const slot = { onMenu: (json: unknown): boolean => onMenu(ctx, st, json) };
    w.kicadHostMenu = slot;
    // A press anywhere in the frame closes the menu, as a press outside KiCad's popup does.
    const onPress = (): void => { if (st.parked != null) cancel(ctx, st, 'canceled'); };
    const onKey = (ev: Event): void => {
      const e = ev as KeyboardEvent;
      if (st.parked != null) {
        if (e.key === 'Escape' && !isIslandKey(e)) {
          cancel(ctx, st, 'canceled');
          e.preventDefault();
          e.stopImmediatePropagation();
        }
        return;
      }
      if (!keyMenuWanted(ctx, e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      st.keyMenuAt = Date.now();
      try { engineCall(ctx, 'kicadRunAction', SHOW_CONTEXT_MENU); } catch { /* KiCad shows nothing */ }
    };
    // The browser's own keyboard contextmenu after our key (a pointer's is button 2 and KiCad's).
    const onContext = (ev: Event): void => {
      if ((ev as MouseEvent).button !== 2 && Date.now() - st.keyMenuAt < KEY_MENU_MS) { ev.preventDefault(); ev.stopImmediatePropagation(); }
    };
    w.addEventListener?.('pointerdown', onPress, true);
    w.addEventListener?.('keydown', onKey, true);
    w.addEventListener?.('contextmenu', onContext, true);
    return () => {
      cancel(ctx, st, 'canceled');
      w.removeEventListener?.('pointerdown', onPress, true);
      w.removeEventListener?.('keydown', onKey, true);
      w.removeEventListener?.('contextmenu', onContext, true);
      if (w.kicadHostMenu === slot) delete w.kicadHostMenu;
      states.delete(ctx);
    };
  },
} satisfies ExtUnit;
