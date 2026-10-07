// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The ccl1 bundle (LIBRARY.md): one JSON line, a newline, the bodies as raw
// UTF-8 in item order, items sorted by name in code point order, every length
// in BYTES. The decoder hands back slices of the buffer, never re-encoded text.
import { describe, expect, it } from 'vitest';
import { compareNames, decodeBundle, encodeBundle } from '../../scripts/libs/bundle.mjs';

const utf8 = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe('the ccl1 bundle', () => {
  it('round trips non-ASCII names and bodies, with every length in bytes', () => {
    const items: [string, string][] = [
      ['R_10kΩ', '(kicad_symbol_lib (symbol "R_10kΩ" (property "Description" "±1 % µ")))\n'],
      ['C', '(kicad_symbol_lib (symbol "C"))\n'],
      ['Thermistor_µ', 'π 😀 ü\n'],
    ];
    const buf = encodeBundle({ id: 'sym.Device', kind: 'symbol', items });
    const nl = buf.indexOf(0x0a);
    const header = JSON.parse(text(buf.subarray(0, nl)));
    expect(header).toEqual({
      v: 1, id: 'sym.Device', kind: 'symbol',
      items: [['C', utf8(items[1][1]).length], ['R_10kΩ', utf8(items[0][1]).length], ['Thermistor_µ', utf8(items[2][1]).length]],
    });
    // Bytes, not UTF-16 code units: the Ω, ±, µ and the emoji each take more than one.
    expect(header.items[1][1]).toBeGreaterThan(items[0][1].length);
    expect(header.items[2][1]).toBe(utf8('π 😀 ü\n').length);
    expect(buf.length).toBe(nl + 1 + header.items.reduce((n: number, [, len]: [string, number]) => n + len, 0));

    const back = decodeBundle(buf);
    expect(back.v).toBe(1);
    expect(back.id).toBe('sym.Device');
    expect(back.kind).toBe('symbol');
    expect(back.items.map((i) => i.name)).toEqual(['C', 'R_10kΩ', 'Thermistor_µ']);
    for (const item of back.items) expect(text(item.body)).toBe(items.find(([n]) => n === item.name)![1]);
    // A body is a slice of the bundle's own bytes.
    expect(back.items[0].body.buffer).toBe(buf.buffer);
  });

  it('takes bodies as bytes and keeps them exactly', () => {
    const raw = new Uint8Array([0xce, 0xa9, 0x0a, 0x00, 0xff]);
    const back = decodeBundle(encodeBundle({ id: 'fp.X', kind: 'footprint', items: [['a', raw], ['b', '']] }));
    expect([...back.items[0].body]).toEqual([...raw]);
    expect(back.items[1].body.length).toBe(0);
  });

  it('sorts names in code point order, which is not JavaScript\'s UTF-16 order', () => {
    const names = ['😀', 'ｚ', 'é', 'a', 'Z', '_', '0'];
    const buf = encodeBundle({ id: 'sym.L', kind: 'symbol', items: names.map((n) => [n, n] as [string, string]) });
    const order = decodeBundle(buf).items.map((i) => i.name);
    expect(order).toEqual(['0', 'Z', '_', 'a', 'é', 'ｚ', '😀']);
    // U+FF5A sorts before U+1F600 by code point, after it by UTF-16 code unit (0xD83D).
    expect([...names].sort()).not.toEqual(order);
    expect(compareNames('ｚ', '😀')).toBeLessThan(0);
  });

  it('keeps the header on one line when a name holds a newline', () => {
    const buf = encodeBundle({ id: 'sym.N', kind: 'symbol', items: [['two\nlines', 'x']] });
    expect(text(buf).split('\n')[0]).toBe('{"v":1,"id":"sym.N","kind":"symbol","items":[["two\\nlines",1]]}');
    expect(decodeBundle(buf).items[0].name).toBe('two\nlines');
  });

  it('refuses a duplicate name and an unknown kind', () => {
    expect(() => encodeBundle({ id: 'sym.D', kind: 'symbol', items: [['R', 'a'], ['R', 'b']] })).toThrow(/two items are named "R"/);
    expect(() => encodeBundle({ id: 'sym.D', kind: 'board' as never, items: [] })).toThrow(/not symbol or footprint/);
  });

  it('refuses anything that is not a well formed bundle', () => {
    const good = encodeBundle({ id: 'sym.D', kind: 'symbol', items: [['A', 'aaa'], ['B', 'bb']] });
    const cut = good.subarray(0, good.length - 1);
    expect(() => decodeBundle(cut)).toThrow(/runs past the end/);
    const longer = new Uint8Array(good.length + 1);
    longer.set(good);
    expect(() => decodeBundle(longer)).toThrow(/1 bytes after the last item/);
    expect(() => decodeBundle(utf8('{"v":1,"id":"x","kind":"symbol","items":[]}'))).toThrow(/no header line/);
    expect(() => decodeBundle(utf8('{"v":2,"id":"x","kind":"symbol","items":[]}\n'))).toThrow(/version 2/);
    expect(() => decodeBundle(utf8('not json\n'))).toThrow(/not JSON/);
    expect(() => decodeBundle(utf8('{"v":1,"id":"x","kind":"symbol","items":[["B",0],["A",0]]}\n'))).toThrow(/"A" is out of order/);
    expect(() => decodeBundle(utf8('{"v":1,"id":"x","kind":"symbol","items":[["A",0],["A",0]]}\n'))).toThrow(/out of order/);
    expect(() => decodeBundle(utf8('{"v":1,"id":"x","kind":"symbol","items":[["A",-1]]}\n'))).toThrow(/not \[name, byte length\]/);
  });
});
