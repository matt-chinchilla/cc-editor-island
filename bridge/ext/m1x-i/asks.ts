// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The generic asks of the prompt host (the canvas commands addendum 4.2): the
// record of each ask as the engine sends it, read closed, and the answer the
// host may give it, checked closed before it reaches the engine. Pure: no
// window, no engine.

/** The asks this unit declares (ev.prompt's `ask`). */
export const GENERIC_ASKS = ['entry', 'layer', 'message', 'assignNetclass'] as const;
export type GenericAsk = (typeof GENERIC_ASKS)[number];

/** An entry field's kinds (lengths in mm, angles in degrees, a point in mm). */
export const FIELD_KINDS = ['length', 'angle', 'text', 'check', 'point'] as const;
/** A message box's icons and its buttons' ids, in KiCad's words. */
export const MESSAGE_ICONS = ['info', 'warning', 'error', 'question'] as const;
export const MESSAGE_BUTTONS = ['ok', 'cancel', 'yes', 'no'] as const;

/** Bounds of a record: past them the record is not ours to show. */
export const MAX_FIELDS = 64;
export const MAX_LAYERS = 256;
export const MAX_NETCLASSES = 1024;
export const MAX_TEXT = 8192;
/** The longest answer sent to the engine at all (a table's cells are the largest). */
export const MAX_ANSWER = 1_000_000;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exact = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const k = Object.keys(o);
  return k.length === keys.length && keys.every((x) => k.includes(x));
};
const only = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).every((k) => keys.includes(k));
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const text = (v: unknown, max = MAX_TEXT): v is string => typeof v === 'string' && v.length <= max;
const isPoint = (v: unknown): v is { x: number; y: number } => isObj(v) && exact(v, ['x', 'y']) && finite(v.x) && finite(v.y);
/** A field key: `value` and `point` for the one-field dialogs, `f0`, `f1` and on for the multi dialog. */
const FIELD_KEY_RE = /^(?:value|point|f(?:0|[1-9][0-9]{0,2}))$/;
/** A layer's canonical name (`F.Cu`, `In1.Cu`, `User.Drawings`). */
const LAYER_RE = /^[A-Za-z0-9_.]{1,64}$/;
const COLOR_RE = /^#[0-9a-fA-F]{8}$/;

/** One entry field: exactly its keys, its value of its kind's type. */
function readField(f: unknown): Record<string, unknown> | null {
  if (!isObj(f) || !exact(f, ['key', 'label', 'kind', 'value', 'tip'])) return null;
  const { key, label, kind, value, tip } = f;
  if (typeof key !== 'string' || !FIELD_KEY_RE.test(key) || !text(label) || !text(tip)) return null;
  if (typeof kind !== 'string' || !(FIELD_KINDS as readonly string[]).includes(kind)) return null;
  const typed = kind === 'length' || kind === 'angle' ? finite(value)
    : kind === 'text' ? text(value)
      : kind === 'check' ? typeof value === 'boolean'
        : isPoint(value);
  if (!typed) return null;
  return { key, label, kind, value: kind === 'point' ? { x: (value as { x: number }).x, y: (value as { y: number }).y } : value, tip };
}

/** `entry`: `{ title, fields: [{ key, label, kind, value, tip }] }`, every key once. */
export function readEntry(r: unknown): Record<string, unknown> | null {
  if (!isObj(r) || !exact(r, ['title', 'fields']) || !text(r.title) || !Array.isArray(r.fields)) return null;
  if (r.fields.length === 0 || r.fields.length > MAX_FIELDS) return null;
  const fields: Record<string, unknown>[] = [];
  const keys = new Set<string>();
  for (const f of r.fields) {
    const field = readField(f);
    if (field == null || keys.has(field.key as string)) return null;
    keys.add(field.key as string);
    fields.push(field);
  }
  return { title: r.title, fields };
}

/** `layer`: `{ current, layers: [{ canonical, name, color }] }`, the allowed layers only. */
export function readLayer(r: unknown): Record<string, unknown> | null {
  if (!isObj(r) || !exact(r, ['current', 'layers']) || typeof r.current !== 'string' || !Array.isArray(r.layers)) return null;
  if (r.current !== '' && !LAYER_RE.test(r.current)) return null;
  if (r.layers.length === 0 || r.layers.length > MAX_LAYERS) return null;
  const layers: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const l of r.layers) {
    if (!isObj(l) || !exact(l, ['canonical', 'name', 'color'])) return null;
    const { canonical, name, color } = l;
    if (typeof canonical !== 'string' || !LAYER_RE.test(canonical) || seen.has(canonical) || !text(name, 128) || typeof color !== 'string' || !COLOR_RE.test(color)) return null;
    seen.add(canonical);
    layers.push({ canonical, name, color });
  }
  return { current: r.current, layers };
}

/** `message`: `{ title, text, extra, icon, buttons: [{ id, label }], dontAsk }`, buttons in KiCad's order. */
export function readMessage(r: unknown): Record<string, unknown> | null {
  if (!isObj(r) || !exact(r, ['title', 'text', 'extra', 'icon', 'buttons', 'dontAsk'])) return null;
  const { title, extra, icon, buttons, dontAsk } = r;
  if (!text(title) || !text(r.text) || !text(extra) || typeof dontAsk !== 'boolean') return null;
  if (typeof icon !== 'string' || !(MESSAGE_ICONS as readonly string[]).includes(icon)) return null;
  if (!Array.isArray(buttons) || buttons.length === 0 || buttons.length > MESSAGE_BUTTONS.length) return null;
  const out: Record<string, unknown>[] = [];
  const ids = new Set<string>();
  for (const b of buttons) {
    if (!isObj(b) || !exact(b, ['id', 'label'])) return null;
    if (typeof b.id !== 'string' || !(MESSAGE_BUTTONS as readonly string[]).includes(b.id) || ids.has(b.id) || !text(b.label, 128)) return null;
    ids.add(b.id);
    out.push({ id: b.id, label: b.label });
  }
  return { title, text: r.text, extra, icon, buttons: out, dontAsk };
}

/** `assignNetclass`: `{ pattern, netclass, netclasses }`. */
export function readAssignNetclass(r: unknown): Record<string, unknown> | null {
  if (!isObj(r) || !exact(r, ['pattern', 'netclass', 'netclasses'])) return null;
  const { pattern, netclass, netclasses } = r;
  if (!text(pattern) || !text(netclass, 256) || !Array.isArray(netclasses) || netclasses.length > MAX_NETCLASSES) return null;
  if (!netclasses.every((n) => text(n, 256))) return null;
  return { pattern, netclass, netclasses: [...netclasses] };
}

/** Each declared ask's closed record reader (ExtUnit.askReaders). */
export const ASK_READERS: Readonly<Record<GenericAsk, (record: unknown) => Record<string, unknown> | null>> = {
  entry: readEntry,
  layer: readLayer,
  message: readMessage,
  assignNetclass: readAssignNetclass,
};

/** An entry answer's value: a length or an angle, a text, a check, a point. */
const isEntryValue = (v: unknown): boolean => finite(v) || text(v) || typeof v === 'boolean' || isPoint(v);

/**
 * The answer to one of this unit's asks, checked closed (the keys of the
 * addendum's table, each optional, each of its type). The engine still
 * checks each value against its dialog and refuses with the field it names.
 */
export function answerFits(ask: GenericAsk, a: Record<string, unknown>): boolean {
  switch (ask) {
    case 'entry': {
      if (!only(a, ['values'])) return false;
      if (a.values === undefined) return true;
      if (!isObj(a.values) || Object.keys(a.values).length > MAX_FIELDS) return false;
      return Object.entries(a.values).every(([k, v]) => FIELD_KEY_RE.test(k) && isEntryValue(v));
    }
    case 'layer':
      return only(a, ['layer']) && (a.layer === undefined || (typeof a.layer === 'string' && LAYER_RE.test(a.layer)));
    case 'message':
      return only(a, ['button', 'dontAsk']) && (a.button === undefined || typeof a.button === 'string') && (a.dontAsk === undefined || typeof a.dontAsk === 'boolean');
    case 'assignNetclass':
      return only(a, ['pattern', 'netclass']) && (a.pattern === undefined || text(a.pattern)) && (a.netclass === undefined || text(a.netclass, 256));
  }
}

/** One of this unit's asks. */
export const isGenericAsk = (ask: string): ask is GenericAsk => (GENERIC_ASKS as readonly string[]).includes(ask);
