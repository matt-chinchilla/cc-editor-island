// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// Our context menu's model (the canvas commands addendum 3.1 and 3.2): the
// engine's menu as KiCad built it, read closed, and the ev.contextMenu items
// made from it. Pure: no window, no engine.
import { ACTION_RE } from '../../held';

/** The kinds of a wx menu item the engine reports (wxMenu::WasmItemsToJson's). */
export type EngineKind = 'normal' | 'check' | 'radio' | 'submenu' | 'separator';
/** One item as the engine reports it. */
export interface EngineItem { id: number; kind: EngineKind; label: string; enabled: boolean; checked: boolean; action: string; key: string; items?: EngineItem[] }
/** The menu the engine parks while the host shows it (window.kicadHostMenu.onMenu's argument). */
export interface EngineMenu { token: number; clarify: boolean; tool: string; title: string; at: { x: number; y: number }; kinds: string[]; items: EngineItem[]; cut: boolean }

/** An item's type in ev.contextMenu. */
export type ItemType = 'action' | 'choice' | 'check' | 'radio' | 'submenu' | 'separator';
/** How a choice of the item reaches its window: run (none, or the engine's own hand-off), held (ev.held), prompt (ev.prompt). */
export type Door = 'run' | 'held' | 'prompt';
/** One item of ev.contextMenu, exactly these keys (and `items` on a submenu). */
export interface MenuItem { id: number; type: ItemType; action: string; label: string; enabled: boolean; checked: boolean; key: string; door: Door; items?: MenuItem[] }

/** The engine's bounds (addendum 3.1): past them it cuts the menu and says so. */
export const MAX_ITEMS = 400;
export const MAX_DEPTH = 3;
export const MAX_LABEL = 128;
/** A key name as KeyNameFromKeyCode writes it ("Ctrl+Shift+M"). */
const MAX_KEY = 48;
/** The longest raw model read at all. */
export const MAX_MODEL = 256 * 1024;
const KINDS = new Set<EngineKind>(['normal', 'check', 'radio', 'submenu', 'separator']);
const ITEM_KEYS = ['id', 'kind', 'label', 'enabled', 'checked', 'action', 'key', 'items'];
const MENU_KEYS = ['token', 'clarify', 'tool', 'title', 'at', 'kinds', 'items', 'cut'];
const KIND_RE = /^[a-z]{1,24}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const only = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).every((k) => keys.includes(k));
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** A wx id: any safe integer but -1 (wxID_ANY is replaced by a fresh id, and -1 is our cancel). */
export const isItemId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v !== -1;

function readItems(raw: unknown, depth: number, count: { n: number }): EngineItem[] | null {
  if (!Array.isArray(raw) || depth > MAX_DEPTH) return null;
  const out: EngineItem[] = [];
  for (const r of raw) {
    if (++count.n > MAX_ITEMS || !isObj(r) || !only(r, ITEM_KEYS)) return null;
    const { id, kind, label, enabled, checked, action, key } = r;
    if (!isItemId(id) || typeof kind !== 'string' || !KINDS.has(kind as EngineKind)) return null;
    if (typeof label !== 'string' || label.length > MAX_LABEL || typeof enabled !== 'boolean' || typeof checked !== 'boolean') return null;
    if (typeof action !== 'string' || (action !== '' && !ACTION_RE.test(action)) || typeof key !== 'string' || key.length > MAX_KEY) return null;
    const item: EngineItem = { id, kind: kind as EngineKind, label, enabled, checked, action, key };
    if (kind === 'submenu') {
      const sub = readItems(r.items ?? [], depth + 1, count);
      if (sub == null) return null;
      item.items = sub;
    } else if (r.items !== undefined) return null;
    out.push(item);
  }
  return out;
}

/** The engine's menu read closed (addendum 3.1's MODEL), or null for any other shape: KiCad's own popup then shows. */
export function readEngineMenu(json: unknown): EngineMenu | null {
  if (typeof json !== 'string' || json.length > MAX_MODEL) return null;
  let v: unknown;
  try { v = JSON.parse(json); } catch { return null; }
  if (!isObj(v) || !only(v, MENU_KEYS)) return null;
  const { token, clarify, tool, title, at, kinds, cut } = v;
  if (typeof token !== 'number' || !Number.isSafeInteger(token) || typeof clarify !== 'boolean') return null;
  if (typeof tool !== 'string' || tool.length > MAX_LABEL || typeof title !== 'string' || title.length > MAX_LABEL) return null;
  if (!isObj(at) || !only(at, ['x', 'y']) || !finite(at.x) || !finite(at.y)) return null;
  if (!Array.isArray(kinds) || kinds.length > 32 || !kinds.every((k) => typeof k === 'string' && KIND_RE.test(k))) return null;
  if (cut !== undefined && cut !== true) return null;
  const items = readItems(v.items, 1, { n: 0 });
  if (items == null) return null;
  return { token, clarify, tool, title, at: { x: at.x, y: at.y }, kinds: [...kinds].sort(), items, cut: cut === true };
}

/** A sent item as contextMenu.choose and contextMenu.highlight check it. */
export interface Sent { type: ItemType; enabled: boolean }

/** The ev.contextMenu items, the actions left out, and every sent item by id. */
export interface Built { items: MenuItem[]; omitted: string[]; sent: Map<number, Sent> }

/**
 * The event's items from the engine's: an action whose door is null (no door
 * of ours in this frame, or its cap not listed) is left out and named in
 * `omitted`; a submenu left with no item goes too; separators are collapsed
 * (none first, last or doubled). The labels are KiCad's (the host words them).
 */
export function buildItems(items: readonly EngineItem[], doorOf: (action: string) => Door | null): Built {
  const omitted = new Set<string>();
  const sent = new Map<number, Sent>();
  const walk = (list: readonly EngineItem[]): MenuItem[] => {
    const out: MenuItem[] = [];
    for (const it of list) {
      const base = { id: it.id, action: '', label: it.label, enabled: it.enabled, checked: it.checked, key: it.key };
      if (it.kind === 'separator') { out.push({ ...base, label: '', enabled: false, checked: false, key: '', type: 'separator', door: 'run' }); continue; }
      if (it.kind === 'submenu') {
        const sub = walk(it.items ?? []);
        if (sub.some((s) => s.type !== 'separator')) out.push({ ...base, checked: false, key: '', type: 'submenu', door: 'run', items: sub });
        continue;
      }
      const type: ItemType = it.kind === 'check' ? 'check' : it.kind === 'radio' ? 'radio' : it.action !== '' ? 'action' : 'choice';
      let door: Door = 'run';
      if (it.action !== '') {
        const d = doorOf(it.action);
        if (d == null) { omitted.add(it.action); continue; }
        door = d;
      }
      out.push({ ...base, action: it.action, type, door });
    }
    return collapse(out);
  };
  const built = walk(items);
  const index = (list: readonly MenuItem[]): void => {
    for (const m of list) {
      if (m.type !== 'separator') sent.set(m.id, { type: m.type, enabled: m.enabled });
      if (m.items != null) index(m.items);
    }
  };
  index(built);
  return { items: built, omitted: [...omitted].sort(), sent };
}

/** No separator first, last, or after another. */
export function collapse(list: MenuItem[]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const m of list) {
    if (m.type === 'separator' && (out.length === 0 || out[out.length - 1].type === 'separator')) continue;
    out.push(m);
  }
  while (out.length > 0 && out[out.length - 1].type === 'separator') out.pop();
  return out;
}
