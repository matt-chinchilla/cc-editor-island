// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// A ccl2 symbol body is the symbol alone; a single read assembles its extends
// chain. The assembled body must be what a ccl1 bundle carried for the same
// symbol, byte for byte: built here by the builder from the test kit's
// sources and read back through the client, against the previous code path
// (resolveChain + buildSelfContainedLib over the source files).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memoryBundleStore } from '../loader/src/wasm/libs/bundle-store';
import { mirrorLibsSource } from '../loader/src/wasm/libs/mirror-source';
import { assembleSymbolBody, decodeKicadString, splitSymbolBody } from '../loader/src/wasm/libs/symbol-body';
import { buildMirror } from '../scripts/libs/mirror.mjs';
import { buildSelfContainedLib, decodeString, parseSymbolLib, resolveChain, type ParsedSymbol } from '../scripts/libs/kicad-symdir.mjs';
import { fixtureSources, gunzip, listDir, readBytes, readStoredJson, removeDir, tempDir } from './libs-builder/kit.mjs';

const TAG = '10.0.4';
const text = (b: Uint8Array) => new TextDecoder().decode(b);
let dir: string;
let mirror: string;
let symbolsSrc: string;

beforeAll(async () => {
  dir = tempDir('cc-libs-assemble');
  const src = fixtureSources(dir);
  symbolsSrc = src.symbolsSrc;
  mirror = (await buildMirror({ ...src, out: `${dir}/out`, tag: TAG })).dir;
});
afterAll(() => removeDir(dir));

/** What ccl1 carried: every symbol of a source library with its chain, root first, under its own file's header. */
function ccl1Bodies(nick: string): Map<string, string> {
  const files = listDir(symbolsSrc).includes(`${nick}.kicad_symdir`)
    ? listDir(`${symbolsSrc}/${nick}.kicad_symdir`).filter((f) => f.endsWith('.kicad_sym')).map((f) => `${symbolsSrc}/${nick}.kicad_symdir/${f}`)
    : [`${symbolsSrc}/${nick}.kicad_sym`];
  const byName = new Map<string, ParsedSymbol & { header: string }>();
  for (const f of files) {
    const lib = parseSymbolLib(text(readBytes(f)));
    for (const s of lib.symbols) byName.set(s.name, { ...s, header: lib.header });
  }
  const out = new Map<string, string>();
  for (const s of byName.values()) out.set(s.name, buildSelfContainedLib(s.header, resolveChain(byName, s).map((p) => p.block), s.block));
  return out;
}

describe('the assembled symbol body', () => {
  it('equals the ccl1 body of every symbol in the built mirror, read through the client', async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const name = decodeURIComponent(String(input).slice(`/libs/${TAG}/`.length));
      try {
        return new Response(gunzip(readBytes(`${mirror}/${name}.gz`)).slice(), { status: 200 });
      } catch {
        return new Response('', { status: 404 });
      }
    }) as typeof fetch;
    const src = mirrorLibsSource({ base: `/libs/${TAG}/`, tag: TAG, fetchImpl, storeFactory: async () => memoryBundleStore() });
    const libs = readStoredJson(mirror, 'manifest.json').libs.filter((l: { kind: string }) => l.kind === 'symbol');
    let derived = 0;
    let checked = 0;
    for (const lib of libs as Array<{ id: string; name: string }>) {
      const want = ccl1Bodies(lib.name);
      const items = await src.listItems(lib.id);
      expect(items.map((i) => i.name).sort()).toEqual([...want.keys()].sort());
      for (const { name } of items) {
        const got = await src.getItemBody(lib.id, 'symbol', name);
        expect(got, `${lib.id}:${name}`).toBe(want.get(name));
        if (parseSymbolLib(got!).symbols.length > 1) derived++;
        checked++;
      }
    }
    expect(checked).toBe(9);
    expect(derived).toBe(3);   // D_Mid, D_Leaf (two levels) and the plain file's P2
  });
});

describe('the body scanner', () => {
  it('splits a body into its header, name, parent and block, and refuses anything but one symbol', () => {
    const body = '(kicad_symbol_lib\n\t(version 1)\n\t(generator "x (symbol \\"no\\")")\n\t(symbol "K"\n\t\t(property "D" "(extends \\"no\\")")\n\t\t(extends "P")\n\t)\n)\n';
    expect(splitSymbolBody(body)).toEqual({ header: '(version 1)\n\t(generator "x (symbol \\"no\\")")', name: 'K', parent: 'P', block: '(symbol "K"\n\t\t(property "D" "(extends \\"no\\")")\n\t\t(extends "P")\n\t)' });
    expect(splitSymbolBody('(kicad_symbol_lib\n\t(symbol "A")\n\t(symbol "B")\n)\n')).toBeNull();
    expect(splitSymbolBody('(kicad_symbol_lib\n\t(version 1)\n)\n')).toBeNull();
    expect(splitSymbolBody('(footprint "A"\n)\n')).toBeNull();
    expect(splitSymbolBody('(kicad_symbol_lib\n\t(symbol "A"\n')).toBeNull();
    expect(splitSymbolBody('')).toBeNull();
  });

  it('only scans a body that mentions extends, and never invents a chain', () => {
    const lone = '(kicad_symbol_lib\n\t(symbol "A")\n)\n';
    let asked = 0;
    expect(assembleSymbolBody('A', (n) => { asked++; return n === 'A' ? lone : null; })).toBe(lone);
    expect(asked).toBe(1);
    // A description that mentions "(extends" is scanned, and still has no parent.
    const quoted = '(kicad_symbol_lib\n\t(symbol "Q"\n\t\t(property "Description" "(extends \\"A\\")")\n\t)\n)\n';
    expect(assembleSymbolBody('Q', (n) => (n === 'Q' ? quoted : lone))).toBe(quoted);
    expect(assembleSymbolBody('Nope', () => null)).toBeNull();
  });

  it('decodes quoted text exactly as the builder does (KiCad\'s lexer rules)', () => {
    for (const raw of ['plain', 'a\\"b', 'back\\\\slash', '\\x41\\101\\n\\t', '\\xg', '\\9', '10 kΩ', '\\xce\\xa9', '\\377', 'end\\']) {
      expect(decodeKicadString(raw), raw).toBe(decodeString(raw));
    }
  });
});
