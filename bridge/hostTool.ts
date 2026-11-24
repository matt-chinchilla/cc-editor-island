// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The tool KiCad holds (build T17, engine item 15): our engine calls
// window.kicadHostTool.onChange(json) with exactly `{ tool }`, KiCad's
// CurrentToolName(), each time the top frame's tool stack changes it (never
// twice in a row with the same name; the engine keeps the last name even with
// no listener). The engine says it tells with the marker export
// kicadHostToolChanges, and kicadActiveTool() reads the name now.
//
// The slot is taken before the engine boots (src/main.ts), so no change made
// while it starts is called into an empty slot; it remembers the last name
// read and hands each later one to a listener, which bridge/ext/t17-i.ts
// attaches at engineReady. A listener never sees a shape it cannot read.

/** The marker export: the engine tells the page the tool it holds. */
export const HOST_TOOL_EXPORT = 'kicadHostToolChanges';
/** The read of the tool held now (the top frame's CurrentToolName(), "" with no frame). */
export const ACTIVE_TOOL_EXPORT = 'kicadActiveTool';
/** KiCad's name for its selection tool: the tool a frame holds when no other one is armed. */
export const SELECTION_TOOL = 'common.InteractiveSelection.selectionTool';
/** A tool name: KiCad's dotted name, at most 128 characters. */
export const TOOL_NAME_RE = /^(?=.{1,128}$)[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/;
/** The frame's call is at most this long. */
const MAX_TOOL_CHANGE = 256;

/** The window slot the engine calls (CcTellHostTool). */
export type HostToolWindow = { kicadHostTool?: { onChange?: (json: unknown) => void } };

/** The engine's call read closed: a JSON string of exactly `{ tool }`, a tool name. Null for any other shape. */
export function readToolChange(json: unknown): string | null {
  if (typeof json !== 'string' || json.length > MAX_TOOL_CHANGE) return null;
  let v: unknown;
  try { v = JSON.parse(json); } catch { return null; }
  if (typeof v !== 'object' || v === null || Array.isArray(v) || Object.keys(v).length !== 1) return null;
  const tool = (v as { tool?: unknown }).tool;
  return typeof tool === 'string' && TOOL_NAME_RE.test(tool) ? tool : null;
}

/** kicadActiveTool()'s answer read closed: a tool name, null for "" (no frame) or anything else. */
export function readActiveTool(raw: unknown): string | null {
  return typeof raw === 'string' && TOOL_NAME_RE.test(raw) ? raw : null;
}

/** The slot's handle. */
export interface HostToolSlot {
  /** The last name the engine told, null before the first. */
  latest(): string | null;
  /** Hands every later name read to `fn` (one listener: a later call replaces it); the stop detaches it. */
  listen(fn: (name: string) => void): () => void;
}

const SLOTS = new WeakMap<object, HostToolSlot>();

/**
 * The window's slot, taken now when it is not ours yet. Each call the engine
 * makes is read closed; a name is remembered and handed to the listener, a
 * throwing listener is the host side's (the engine is never told).
 */
export function hostToolSlot(w: HostToolWindow): HostToolSlot {
  const have = w.kicadHostTool;
  if (have != null) {
    const known = SLOTS.get(have);
    if (known != null) return known;
  }
  let last: string | null = null;
  let listener: ((name: string) => void) | null = null;
  const slot = {
    onChange: (json: unknown): void => {
      const name = readToolChange(json);
      if (name == null) return;
      last = name;
      try { listener?.(name); } catch { /* the host side's */ }
    },
  };
  const handle: HostToolSlot = {
    latest: () => last,
    listen(fn) {
      listener = fn;
      return () => { if (listener === fn) listener = null; };
    },
  };
  SLOTS.set(slot, handle);
  w.kicadHostTool = slot;
  return handle;
}
