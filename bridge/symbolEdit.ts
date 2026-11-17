// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The symbol editor's schematic side and its file reader (PROTOCOL.md
// symbol.forEditor, symbol.push, symbol.convert and lib.update), through our
// engine's exports (engine run 14): kicadSymbolForEditor and
// kicadSymbolPushToSchematic (eeschema_embind.cpp, a sch frame: a placed
// symbol to the symbol editor and back, as KiCad's Edit with Symbol Editor and
// its save to the schematic), kicadSymbolLibConvert (symedit_embind.cpp, any
// eeschema frame: a symbol file of another tool read by KiCad's own readers)
// and kicadUpdateFromLibrary (the engine's Update Symbols from Library, with
// its pcbjam:lib-update-done event). This module holds the closed parsers and
// readers; the responder holds the gates and the waits.
import { DOC_MAX_BYTES, isText } from './symedit';
import { isFootprintId, SHEET_PATH_RE, UUID_RE } from './symbol';

/** The engine exports symbol.forEditor and symbol.push need. */
export const SYMBOL_EDIT_EXPORTS = ['kicadSymbolForEditor', 'kicadSymbolPushToSchematic', 'kicadSymbolGet', 'kicadCollabBusy'] as const;
/** The pseudo-cap a sch frame lists when they answer. */
export const SYMBOL_EDIT_CAP = 'symbolEdit';
/** The engine exports symbol.convert needs, and its cap (a sch or a symedit frame). */
export const CONVERT_EXPORTS = ['kicadSymbolLibConvert'] as const;
export const CONVERT_CAP = 'symbolConvert';
/** The engine exports lib.update needs, and its cap (a sch frame). */
export const LIB_UPDATE_EXPORTS = ['kicadUpdateFromLibrary', 'kicadCollabBusy'] as const;
export const LIB_UPDATE_CAP = 'libUpdate';
/** The engine's event when an update from a library has run. */
export const LIB_UPDATE_EVENT = 'pcbjam:lib-update-done';

/** symbol.convert takes a file of at most 25 MiB; the engine answers at most 2,000 symbols and 4 MiB of text. */
export const CONVERT_MAX_BYTES = 25 * 1024 * 1024;
export const CONVERT_MAX_SYMBOLS = 2000;
/** Each conversion writes its file under a fresh folder of this one, outside the project folder. */
export const CONVERT_ROOT = '/tmp/cc-import';
/** lib.update names 1 to this many symbols. */
export const LIB_UPDATE_NAMES_MAX = 64;
/** A file name the island writes: 1 to 255 bytes of UTF-8, no slash, backslash or NUL, never "." or "..". */
const FILE_NAME_MAX = 255;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
};
const utf8Bytes = (s: string): number => new TextEncoder().encode(s).byteLength;
/** A symbol document: 1 byte to 4 MiB of UTF-8, no NUL (KiCad's s-expression text). */
const isDocument = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= DOC_MAX_BYTES && !v.includes('\0') && utf8Bytes(v) <= DOC_MAX_BYTES;
/** A library nickname as project.libs takes one: 1 to 255 characters, no control character and none of / \ :. */
// eslint-disable-next-line no-control-regex
const NICK_RE = /^[^\u0000-\u001f\u007f/\\:]{1,255}$/;

export interface ForEditorArgs { uuid: string; sheetPath: string }
export interface ForEditor { name: string; libId: string; text: string }
export interface PushArgs { uuid: string; sheetPath: string; text: string; name: string; libId: string }
export interface ConvertArgs { name: string; bytes: Uint8Array }
export type Converted = { format: string; symbols: Array<{ name: string; text: string }> } | { error: 'too_large' } | { error: 'unreadable'; message: string };
export interface LibUpdateArgs { lib: string; names: string[] }

/** symbol.forEditor's args: exactly `{ uuid, sheetPath }` (symbol.get's forms); null for anything else. */
export function parseForEditorArgs(args: unknown): ForEditorArgs | null {
  if (!isObj(args) || !exactKeys(args, ['uuid', 'sheetPath'])) return null;
  if (typeof args.uuid !== 'string' || !UUID_RE.test(args.uuid) || typeof args.sheetPath !== 'string' || !SHEET_PATH_RE.test(args.sheetPath)) return null;
  return { uuid: args.uuid, sheetPath: args.sheetPath };
}

/** kicadSymbolForEditor's answer read closed: `{ name, libId, text }`; null for "" (no such symbol) or any other shape. */
export function readForEditor(text: unknown): ForEditor | null {
  if (typeof text !== 'string' || text === '') return null;
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (!isObj(v) || !exactKeys(v, ['name', 'libId', 'text'])) return null;
  if (typeof v.name !== 'string' || v.name === '' || [...v.name].length > 1024 || typeof v.libId !== 'string' || [...v.libId].length > 1024 || !isDocument(v.text)) return null;
  return { name: v.name, libId: v.libId, text: v.text };
}

/**
 * symbol.push's args: exactly `{ uuid, sheetPath, text, name, libId }`: a
 * symbol document of at most 4 MiB holding `name` (1 to 1,024 characters, no
 * control character), and `libId` `""` (each unit keeps its own) or
 * `lib:name` with both halves. Null for anything else.
 */
export function parsePushArgs(args: unknown): PushArgs | null {
  if (!isObj(args) || !exactKeys(args, ['uuid', 'sheetPath', 'text', 'name', 'libId'])) return null;
  const f = parseForEditorArgs({ uuid: args.uuid, sheetPath: args.sheetPath });
  if (f == null || !isDocument(args.text) || !isText(args.name, 1) || typeof args.libId !== 'string') return null;
  if (args.libId !== '' && (!isFootprintId(args.libId) || [...args.libId].length > 1024)) return null;
  return { ...f, text: args.text, name: args.name, libId: args.libId };
}

/** symbol.convert's args: exactly `{ name, bytes }`, a file name and its bytes (a Uint8Array of 1 byte to 25 MiB); null for anything else. */
export function parseConvertArgs(args: unknown): ConvertArgs | null {
  if (!isObj(args) || !exactKeys(args, ['name', 'bytes'])) return null;
  const { name, bytes } = args;
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..' || /[/\\\0]/.test(name) || utf8Bytes(name) > FILE_NAME_MAX) return null;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > CONVERT_MAX_BYTES) return null;
  return { name, bytes };
}

/** kicadSymbolLibConvert's answer read closed; null for "" (refused) or any other shape. */
export function readConverted(text: unknown): Converted | null {
  if (typeof text !== 'string' || text === '') return null;
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (!isObj(v)) return null;
  if (v.error === 'too_large' && exactKeys(v, ['error'])) return { error: 'too_large' };
  if (v.error === 'unreadable' && exactKeys(v, ['error', 'message']) && typeof v.message === 'string') return { error: 'unreadable', message: [...v.message].slice(0, 1024).join('') };
  if (!exactKeys(v, ['format', 'symbols']) || typeof v.format !== 'string' || v.format === '' || [...v.format].length > 64) return null;
  if (!Array.isArray(v.symbols) || v.symbols.length > CONVERT_MAX_SYMBOLS) return null;
  const symbols: Array<{ name: string; text: string }> = [];
  let bytes = 0;
  for (const s of v.symbols as unknown[]) {
    if (!isObj(s) || !exactKeys(s, ['name', 'text']) || typeof s.name !== 'string' || s.name === '' || [...s.name].length > 1024 || !isDocument(s.text)) return null;
    bytes += utf8Bytes(s.text);
    if (bytes > DOC_MAX_BYTES) return null;
    symbols.push({ name: s.name, text: s.text });
  }
  return { format: v.format, symbols };
}

/** lib.update's args: exactly `{ lib, names }`, a nickname as project.libs takes one and 1 to 64 symbol names (1 to 1,024 characters, no control character), none twice. */
export function parseLibUpdateArgs(args: unknown): LibUpdateArgs | null {
  if (!isObj(args) || !exactKeys(args, ['lib', 'names']) || typeof args.lib !== 'string' || !NICK_RE.test(args.lib)) return null;
  const n = args.names;
  if (!Array.isArray(n) || n.length < 1 || n.length > LIB_UPDATE_NAMES_MAX || !n.every((x) => isText(x, 1)) || new Set(n).size !== n.length) return null;
  return { lib: args.lib, names: [...n] as string[] };
}

/** kicadUpdateFromLibrary's synchronous answer: whether the run was queued. */
export function readLibUpdateQueued(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  try {
    const v: unknown = JSON.parse(text);
    return isObj(v) && v.ok === true && v.queued === true;
  } catch { return false; }
}

/** The pcbjam:lib-update-done event's detail read closed: `{ updated, missing }`; null for any other shape. */
export function readLibUpdateDone(detail: unknown): { updated: number; missing: string[] } | null {
  if (!isObj(detail) || detail.ok !== true || !Number.isSafeInteger(detail.updated) || (detail.updated as number) < 0) return null;
  if (!Array.isArray(detail.missing) || detail.missing.length > 4096 || !detail.missing.every((m) => typeof m === 'string' && [...m].length <= 2048)) return null;
  return { updated: detail.updated as number, missing: [...detail.missing] as string[] };
}
