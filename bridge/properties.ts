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
