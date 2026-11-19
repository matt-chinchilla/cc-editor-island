// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// ev.fpedit (FP spec 6.2): KiCad's footprint editor asks the page before it
// opens one of its windows (engine run 15, kicad cc/main fp-e1a, fp-e1b and
// fp-e1c through CcAskHostFpEdit), by calling
// window.kicadHostFpEdit.onRequest(json) with exactly `{ ask, uuid, isNew }`.
// A truthy answer takes the request: no window opens (an item stays the one
// selected, a frame ask changes nothing, a new text, text box, table or
// barcode is placed as the window's OK with its defaults would place it, a
// held enumerate does not start the numbering loop). A falsy answer, a
// throw or no listener leaves it to KiCad's window as before. The engine
// says it asks with the marker export kicadHostFpEdit.
//
// installFpEditAsk takes that slot; bridge/ext/fp-i2b.ts installs it in an
// fpedit frame and sends each request out as ev.fpedit. Another frame's unit
// may install it with its own `asks` and `send` (the board's Import a
// drawing, fp-i5), so the reader here is frame neutral.
import { isObj } from '../ext/contract';
import { UUID_RE } from '../symbol';

/** The marker export: the footprint editor asks the page before its windows. */
export const FPEDIT_ASK_EXPORT = 'kicadHostFpEdit';
/** The pseudo-cap an fpedit frame lists when the engine asks the page (ev.fpedit). */
export const FPEDIT_HELD_CAP = 'fpeditHeld';
/** The event an ask goes out as, and its keys. */
export const FPEDIT_EVENT = 'ev.fpedit';
export const FPEDIT_EVENT_KEYS = ['ask', 'uuid', 'isNew'] as const;

/**
 * Asks about one item, its uuid sent: E on a pad, a field, a text, a text
 * box, a shape, a dimension, a rule area, a table (a cell asks its table), a
 * barcode, a reference picture or a point, and Push Pad Properties (the
 * source pad). Never new.
 */
export const FPEDIT_ITEM_ASKS = ['pad', 'field', 'text', 'textbox', 'shape', 'dimension', 'zone', 'table', 'barcode', 'image', 'point', 'pushPad'] as const;
/** Asks about an item a drawing tool just made, its new uuid sent (isNew true). */
export const FPEDIT_NEW_ASKS = ['text', 'textbox', 'table', 'barcode'] as const;
/**
 * Asks about the footprint or the frame, uuid "": the footprint's
 * properties, the pad defaults, the pad table, Renumber Pads, the wizard,
 * New Footprint, Rename, Cleanup Graphics and Import a drawing. Never new.
 */
export const FPEDIT_FRAME_ASKS = ['footprint', 'padDefaults', 'padTable', 'enumerate', 'wizard', 'newFootprint', 'rename', 'cleanup', 'graphics'] as const;
/** Every ask the footprint editor sends (the reference picture tool's new `image` asks with uuid ""). */
export const FPEDIT_ASKS = [...FPEDIT_ITEM_ASKS, ...FPEDIT_FRAME_ASKS] as const;
export type FpEditAskKind = typeof FPEDIT_ASKS[number];

/** ev.fpedit's payload: what KiCad's frame would have opened a window for. */
export interface FpEditAsk { ask: FpEditAskKind; uuid: string; isNew: boolean }
/** The window slot the footprint editor calls (CcAskHostFpEdit). */
export type FpEditAskWindow = { kicadHostFpEdit?: { onRequest?: (json: unknown) => boolean } };

/** The frame's request is at most this long. */
const MAX_FPEDIT_REQUEST = 1024;

const among = (list: readonly string[], v: string): boolean => list.includes(v);

/**
 * The frame's request read closed: a JSON string of exactly `{ ask, uuid,
 * isNew }` in one of the forms KiCad sends: an item ask with the item's lower
 * case uuid and isNew false; a new text, text box, table or barcode with its
 * new uuid and isNew true; a new reference picture with uuid "" and isNew
 * true; a frame ask with uuid "" and isNew false. Null for any other shape,
 * which leaves the request to KiCad's window.
 */
export function readFpEditAsk(json: unknown): FpEditAsk | null {
  if (typeof json !== 'string' || json.length > MAX_FPEDIT_REQUEST) return null;
  let v: unknown;
  try { v = JSON.parse(json); } catch { return null; }
  if (!isObj(v) || Object.keys(v).length !== 3) return null;
  const { ask, uuid, isNew } = v;
  if (typeof ask !== 'string' || typeof uuid !== 'string' || typeof isNew !== 'boolean') return null;
  const item = uuid !== '' && UUID_RE.test(uuid);
  const fits = isNew
    ? (item && among(FPEDIT_NEW_ASKS, ask)) || (uuid === '' && ask === 'image')
    : (item && among(FPEDIT_ITEM_ASKS, ask)) || (uuid === '' && among(FPEDIT_FRAME_ASKS, ask));
  return fits ? { ask: ask as FpEditAskKind, uuid, isNew } : null;
}

/**
 * Takes the footprint editor's slot: each request the gate admits (after
 * ev.ready, a footprint open) that reads closed and is one of `asks` (every
 * ask by default) is handed to `send` once and answered true, so KiCad opens
 * no window; anything else, or a throwing `send`, answers false and KiCad's
 * window opens as before. The stop clears the slot when it is still this one.
 */
export function installFpEditAsk(
  w: FpEditAskWindow,
  opts: { admit: () => boolean; send: (a: FpEditAsk) => void; asks?: readonly FpEditAskKind[] },
): () => void {
  const taken: readonly string[] = opts.asks ?? FPEDIT_ASKS;
  const slot = {
    onRequest: (json: unknown): boolean => {
      try {
        if (!opts.admit()) return false;
        const a = readFpEditAsk(json);
        if (a == null || !taken.includes(a.ask)) return false;
        opts.send(a);
        return true;
      } catch {
        return false;
      }
    },
  };
  w.kicadHostFpEdit = slot;
  return () => { if (w.kicadHostFpEdit === slot) delete w.kicadHostFpEdit; };
}
