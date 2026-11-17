// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// ev.properties and ev.boardProperties (PROTOCOL.md): KiCad's properties
// request, taken by the host.
//
// Our engine asks the page before it opens KiCad's properties dialogs, through
// window.kicadProperties.onRequest(json). The schematic editor (kicad cc/main
// SCH_EDIT_TOOL::Properties, engine run 11; and editFieldText, the U, V and F
// keys, engine run 12) sends `{type: "symbol", uuid, sheetPath, field?}` for a
// symbol, a lone pin or field counting as its symbol and the field's name then
// sent. The board editor (EDIT_TOOL::Properties, engine run 12) sends `{type:
// "board", uuid, kind, field?}` for one footprint (a field or text of it asked
// as the footprint), track, arc, via, copper area, board text or check mark.
// A truthy answer takes the request: no dialog opens and the item stays the
// one selected. Anything falsy, or a throw, leaves it to KiCad's dialog as
// before. The engine says it asks with the marker exports kicadHostProperties
// (the schematic) and kicadHostBoardProperties (the board).
import type { Frame } from '../src/types';
import { SHEET_PATH_RE, UUID_RE } from './symbol';

/** The marker export of an engine whose schematic editor asks the page first. */
export const PROPERTIES_EXPORT = 'kicadHostProperties';
/** The pseudo-cap a sch frame lists in ev.ready when its engine has the marker. */
export const PROPERTIES_CAP = 'properties';
/** The marker export of an engine whose board editor asks the page first (engine run 12). */
export const BOARD_PROPERTIES_EXPORT = 'kicadHostBoardProperties';
/** The pseudo-cap ev.ready lists when the engine has the board marker. */
export const BOARD_PROPERTIES_CAP = 'boardProperties';
/** The engine's request is at most this long (a uuid, 64 sheet levels and a field name). */
const MAX_REQUEST = 8192;
/** A field's name the host is told is 1 to this many characters; another is dropped and the request taken for its item. */
export const FIELD_MAX = 128;
/** The board items whose properties the host's window shows. */
export const BOARD_PROPERTIES_KINDS = ['footprint', 'track', 'arc', 'via', 'zone', 'text', 'marker'] as const;
export type BoardPropertiesKind = typeof BOARD_PROPERTIES_KINDS[number];

/**
 * What the host is told: a symbol, the sheet path it sits on in symbol.set's
 * form and the field KiCad named (ev.properties); or a board item and its kind
 * (ev.boardProperties).
 */
export type PropertiesRequest =
  | { type: 'symbol'; uuid: string; sheetPath: string; field?: string }
  | { type: 'board'; uuid: string; kind: BoardPropertiesKind };

/** The window slot the engine calls. */
export type PropertiesWindow = { kicadProperties?: { onRequest?: (json: unknown) => boolean } };

/**
 * The engine's request, read for the frame's own kind: in a sch frame a
 * symbol's uuid, its sheet path in project.open's form (what symbol.set takes
 * and sheet.enter takes) and the field KiCad named when it is 1 to FIELD_MAX
 * characters; in a pcb frame a board item's uuid and kind, any field dropped.
 * Null for any other type, kind or spelling, which leaves the request to
 * KiCad's dialog.
 */
export function readPropertiesRequest(json: unknown, frame: Frame = 'sch'): PropertiesRequest | null {
  if (typeof json !== 'string' || json.length > MAX_REQUEST) return null;
  let v: unknown;
  try { v = JSON.parse(json); } catch { return null; }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.uuid !== 'string' || !UUID_RE.test(r.uuid)) return null;
  if (r.field !== undefined && typeof r.field !== 'string') return null;
  if (frame === 'symedit') return null;   // the symbol editor asks through kicadHostSymEdit (ev.symedit)
  if (frame === 'pcb') {
    if (r.type !== 'board' || !Object.keys(r).every((k) => ['type', 'uuid', 'kind', 'field'].includes(k))) return null;
    if (typeof r.kind !== 'string' || !(BOARD_PROPERTIES_KINDS as readonly string[]).includes(r.kind)) return null;
    return { type: 'board', uuid: r.uuid, kind: r.kind as BoardPropertiesKind };
  }
  if (r.type !== 'symbol' || typeof r.sheetPath !== 'string' || !SHEET_PATH_RE.test(r.sheetPath)) return null;
  const field = typeof r.field === 'string' && r.field.length > 0 && [...r.field].length <= FIELD_MAX ? r.field : undefined;
  return field === undefined ? { type: 'symbol', uuid: r.uuid, sheetPath: r.sheetPath } : { type: 'symbol', uuid: r.uuid, sheetPath: r.sheetPath, field };
}

/**
 * Takes the engine's slot: each request the gate admits and that reads as the
 * frame's own kind (a symbol in a sch frame, a board item in a pcb frame) is
 * handed to `send` and answered true; every other one false, so KiCad's
 * dialog opens. A throwing `send` answers false too.
 */
export function installProperties(w: PropertiesWindow, opts: { frame: Frame; admit: () => boolean; send: (r: PropertiesRequest) => void }): void {
  w.kicadProperties = {
    onRequest: (json: unknown): boolean => {
      try {
        if (!opts.admit()) return false;
        const req = readPropertiesRequest(json, opts.frame);
        if (req == null) return false;
        opts.send(req);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** What KiCad's symbol editor asks the page about (kicad cc/main K3): the item whose dialog it would open. */
export const SYMEDIT_ASKS = ['pin', 'field', 'text', 'textbox', 'shape', 'symbol'] as const;
export type SymEditAskKind = typeof SYMEDIT_ASKS[number];
/** ev.symedit's payload: the item's kind, its uuid ("" for the symbol) and whether a tool just made it. */
export interface SymEditAsk { ask: SymEditAskKind; uuid: string; isNew: boolean }
/** The window slot the symbol editor calls (CcAskHostSymEdit). */
export type SymEditAskWindow = { kicadHostSymEdit?: { onRequest?: (json: unknown) => boolean } };
/** The symbol editor's request is at most this long. */
const MAX_SYMEDIT_REQUEST = 1024;

/**
 * The symbol editor's request read closed: a JSON string of exactly `{ ask,
 * uuid, isNew }`, `uuid` a lower case uuid for an item and `""` for the
 * symbol. Null for any other shape, which leaves the request to KiCad's dialog.
 */
export function readSymEditAsk(json: unknown): SymEditAsk | null {
  if (typeof json !== 'string' || json.length > MAX_SYMEDIT_REQUEST) return null;
  let v: unknown;
  try { v = JSON.parse(json); } catch { return null; }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (Object.keys(r).length !== 3 || typeof r.ask !== 'string' || !(SYMEDIT_ASKS as readonly string[]).includes(r.ask) || typeof r.isNew !== 'boolean') return null;
  const ask = r.ask as SymEditAskKind;
  if (typeof r.uuid !== 'string' || (ask === 'symbol' ? r.uuid !== '' : !UUID_RE.test(r.uuid))) return null;
  return { ask, uuid: r.uuid, isNew: r.isNew };
}

/**
 * Takes the symbol editor's slot (ev.symedit): each request the gate admits
 * (after ev.ready, a symbol open) is handed to `send` and answered true, so
 * KiCad's dialog does not open and the item stays selected (a new pin is
 * placed as the dialog's OK with its defaults would place it); anything else,
 * or a throwing `send`, answers false and KiCad's dialog opens as before.
 */
export function installSymEditAsk(w: SymEditAskWindow, opts: { admit: () => boolean; send: (a: SymEditAsk) => void }): void {
  w.kicadHostSymEdit = {
    onRequest: (json: unknown): boolean => {
      try {
        if (!opts.admit()) return false;
        const a = readSymEditAsk(json);
        if (a == null) return false;
        opts.send(a);
        return true;
      } catch {
        return false;
      }
    },
  };
}
