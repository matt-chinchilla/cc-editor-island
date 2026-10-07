// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The library bundle, format ccl2 (LIBRARY.md): one line of JSON naming the
// library and every item with its body's length in BYTES, a newline, then the
// bodies as raw UTF-8, concatenated in item order, items sorted by name in
// code point order. A reader slices the bodies out and never re-encodes them.
// ccl2 differs from ccl1 in what a symbol body holds (the symbol alone, never
// its extends chain); the framing is the same, and a ccl1 bundle is refused.
//
//   {"v":2,"id":"sym.Device","kind":"symbol","items":[["C",1043],["R",987]]}\n<C body><R body>

export const BUNDLE_VERSION = 2;
export const KINDS = ['symbol', 'footprint'];

const NEWLINE = 0x0a;

/** Code point order. UTF-8 byte order is code point order; JS string order is UTF-16 code unit order. */
export function compareNames(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Encode one library. `items` is [name, body] pairs in any order, a body as
 * text (written as UTF-8) or bytes. Refuses a duplicate name.
 */
export function encodeBundle({ id, kind, items }) {
  if (typeof id !== 'string' || id === '') throw new Error('a bundle needs an id');
  if (!KINDS.includes(kind)) throw new Error(`${id}: kind ${JSON.stringify(kind)} is not symbol or footprint`);
  const rows = items.map(([name, body]) => [name, typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body)]);
  rows.sort((x, y) => compareNames(x[0], y[0]));
  for (let i = 1; i < rows.length; i += 1) {
    if (compareNames(rows[i - 1][0], rows[i][0]) === 0) throw new Error(`${id}: two items are named ${JSON.stringify(rows[i][0])}`);
  }
  const header = JSON.stringify({ v: BUNDLE_VERSION, id, kind, items: rows.map(([name, body]) => [name, body.length]) });
  // JSON.stringify escapes a newline inside a string, so the header is one line.
  return Buffer.concat([Buffer.from(`${header}\n`, 'utf8'), ...rows.map(([, body]) => body)]);
}

/**
 * Decode one bundle into { v, id, kind, items: [{ name, body }] }, every body a
 * slice of `buf` (bytes, never re-encoded). Refuses anything that is not a
 * well formed ccl2 bundle: a missing header line, an unknown version or kind,
 * items out of order or repeated, lengths that do not add up to the buffer.
 */
export function decodeBundle(buf) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const nl = bytes.indexOf(NEWLINE);
  if (nl < 0) throw new Error('not a ccl2 bundle: no header line');
  let header;
  try {
    header = JSON.parse(bytes.subarray(0, nl).toString('utf8'));
  } catch {
    throw new Error('not a ccl2 bundle: the header line is not JSON');
  }
  if (header === null || typeof header !== 'object' || header.v !== BUNDLE_VERSION) throw new Error(`not a ccl2 bundle: version ${JSON.stringify(header?.v)}`);
  const { id, kind, items } = header;
  if (typeof id !== 'string' || id === '') throw new Error('not a ccl2 bundle: no id');
  if (!KINDS.includes(kind)) throw new Error(`${id}: kind ${JSON.stringify(kind)} is not symbol or footprint`);
  if (!Array.isArray(items)) throw new Error(`${id}: items is not a list`);
  let at = nl + 1;
  const out = [];
  for (const row of items) {
    if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || !Number.isSafeInteger(row[1]) || row[1] < 0) {
      throw new Error(`${id}: item ${JSON.stringify(row)} is not [name, byte length]`);
    }
    const [name, length] = row;
    if (out.length > 0 && compareNames(out[out.length - 1].name, name) >= 0) throw new Error(`${id}: ${JSON.stringify(name)} is out of order`);
    if (at + length > bytes.length) throw new Error(`${id}: ${JSON.stringify(name)} runs past the end of the bundle`);
    out.push({ name, body: bytes.subarray(at, at + length) });
    at += length;
  }
  if (at !== bytes.length) throw new Error(`${id}: ${bytes.length - at} bytes after the last item`);
  return { v: header.v, id, kind, items: out };
}
