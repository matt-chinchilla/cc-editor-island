// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// ev.properties (PROTOCOL.md): KiCad's symbol properties request, taken by the host.
//
// Our engine (kicad cc/main SCH_EDIT_TOOL::Properties, engine run 11) asks the
// page before it opens KiCad's symbol properties dialog: a double-click on a
// symbol, its E key or its context menu's Properties call
// window.kicadProperties.onRequest(json) with `{type: "symbol", uuid,
// sheetPath, field?}` (a lone pin or field counts as its symbol, the field's
// name then sent). A truthy answer takes the request: no dialog opens and the
// symbol stays the one selected. Anything falsy, or a throw, leaves it to
// KiCad's dialog as before. The engine says it asks with the marker export
// kicadHostProperties.
import { SHEET_PATH_RE, UUID_RE } from './symbol';

/** The marker export of an engine whose schematic editor asks the page first. */
export const PROPERTIES_EXPORT = 'kicadHostProperties';
/** The pseudo-cap a sch frame lists in ev.ready when its engine has the marker. */
export const PROPERTIES_CAP = 'properties';
/** The engine's request is at most this long (a uuid, 64 sheet levels and a field name). */
const MAX_REQUEST = 8192;

/** What the host is told: the symbol and the sheet path it sits on, in symbol.set's form. */
export interface PropertiesRequest { uuid: string; sheetPath: string }

/** The window slot the engine calls. */
export type PropertiesWindow = { kicadProperties?: { onRequest?: (json: unknown) => boolean } };

/**
 * The engine's request, read: a symbol's uuid and its sheet path in
 * project.open's form (what symbol.set takes and sheet.enter takes); null for
 * any other type or spelling, which leaves the request to KiCad's dialog.
 */
export function readPropertiesRequest(json: unknown): PropertiesRequest | null {
  if (typeof json !== 'string' || json.length > MAX_REQUEST) return null;
  let v: unknown;
  try { v = JSON.parse(json); } catch { return null; }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (r.type !== 'symbol' || typeof r.uuid !== 'string' || !UUID_RE.test(r.uuid)) return null;
  if (typeof r.sheetPath !== 'string' || !SHEET_PATH_RE.test(r.sheetPath)) return null;
  if (r.field !== undefined && typeof r.field !== 'string') return null;
  return { uuid: r.uuid, sheetPath: r.sheetPath };
}

/**
 * Takes the engine's slot: each request the gate admits and that reads as a
 * symbol is handed to `send` and answered true; every other one false, so
 * KiCad's dialog opens. A throwing `send` answers false too.
 */
export function installProperties(w: PropertiesWindow, opts: { admit: () => boolean; send: (r: PropertiesRequest) => void }): void {
  w.kicadProperties = {
    onRequest: (json: unknown): boolean => {
      try {
        if (!opts.admit()) return false;
        const req = readPropertiesRequest(json);
        if (req == null) return false;
        opts.send(req);
        return true;
      } catch {
        return false;
      }
    },
  };
}
