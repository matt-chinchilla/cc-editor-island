// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The symbol side of the builder: a symbol body is a self-contained
// kicad_symbol_lib holding, before the symbol, every symbol of its extends
// chain, root first, under the library header of KiCad's own file; a symbol
// with no extends comes out as its file byte for byte; a cycle or a missing
// parent is refused, and so is a format newer than the engine's pinned fork.
import { describe, expect, it } from 'vitest';
import {
  assertForkReads,
  buildSelfContainedLib,
  decodeString,
  FORK_MAX_SYMBOL_LIB_VERSION,
  libHeader,
  parseSymbolLib,
  resolveChain,
  type ParsedSymbol,
} from '../../scripts/libs/kicad-symdir.mjs';
import { baseBlock, derivedBlock, symbolFile } from './kit.mjs';

const HEADER = '(version 20251024)\n\t(generator "kicad_symbol_editor")\n\t(generator_version "10.0")';

function library(files: string[]): Map<string, ParsedSymbol & { header: string }> {
  const byName = new Map<string, ParsedSymbol & { header: string }>();
  for (const f of files) {
    const lib = parseSymbolLib(f);
    for (const s of lib.symbols) byName.set(s.name, { ...s, header: lib.header });
  }
  return byName;
}

const bodyOf = (byName: ReturnType<typeof library>, name: string) => {
  const sym = byName.get(name)!;
  return buildSelfContainedLib(sym.header, resolveChain(byName, sym).map((p) => p.block), sym.block);
};

describe('the symbol library parser', () => {
  it('reads the header, the version and the top-level symbols only (sub-units are not symbols)', () => {
    const lib = parseSymbolLib(symbolFile([baseBlock('R')]));
    expect(lib.header).toBe(HEADER);
    expect(lib.version).toBe(20251024);
    expect(lib.symbols.map((s) => [s.name, s.extends])).toEqual([['R', null]]);
    expect(lib.symbols[0].block.startsWith('(symbol "R"\n')).toBe(true);
    expect(lib.symbols[0].block.endsWith('\n\t)')).toBe(true);
    expect(lib.symbols[0].block).toContain('(symbol "R_1_1"');
  });

  it('never takes a symbol form inside a quoted header string for a symbol', () => {
    const src = '(kicad_symbol_lib\n\t(version 20251024)\n\t(generator "tool (symbol \\"fake\\")")\n\t(symbol "P1"\n\t)\n)\n';
    const lib = parseSymbolLib(src);
    expect(lib.symbols.map((s) => s.name)).toEqual(['P1']);
    expect(libHeader(src)).toBe('(version 20251024)\n\t(generator "tool (symbol \\"fake\\")")');
  });

  it('decodes quoted names and strings with KiCad\'s lexer rules', () => {
    expect(decodeString('a\\"b')).toBe('a"b');
    expect(decodeString('back\\\\slash')).toBe('back\\slash');
    expect(decodeString('\\x41\\101\\n\\t')).toBe('AA\n\t');
    expect(decodeString('\\xg')).toBe('xg');       // a goofed hex escape reads as x
    expect(decodeString('\\9')).toBe('\\9');       // a goofed octal escape reads as a backslash
    expect(decodeString('10 kΩ')).toBe('10 kΩ');
    const lib = parseSymbolLib('(kicad_symbol_lib\n\t(symbol "Say \\"hi\\""\n\t\t(extends "P\\x41")\n\t)\n)\n');
    expect(lib.symbols.map((s) => [s.name, s.extends])).toEqual([['Say "hi"', 'PA']]);
  });

  it('refuses a document that is not a symbol library', () => {
    expect(() => parseSymbolLib('(footprint "X"\n)\n')).toThrow(/not \(kicad_symbol_lib/);
    expect(() => parseSymbolLib('(kicad_symbol_lib\n\t(version 20251024)\n)\n')).toThrow(/no \(symbol/);
    expect(() => parseSymbolLib('(kicad_symbol_lib\n\t(symbol "R"\n)\n')).toThrow(/unbalanced/);
  });
});

describe('a self-contained symbol body', () => {
  it('is the symbol\'s KiCad file byte for byte when it extends nothing', () => {
    const file = symbolFile([baseBlock('Thermistor_µ', '\n\t\t(property "Description" "10 kΩ"\n\t\t\t(at 0 0 0)\n\t\t)')]);
    expect(bodyOf(library([file]), 'Thermistor_µ')).toBe(file);
  });

  it('bundles the extends chain root first, under the derived symbol\'s own header', () => {
    const base = symbolFile([baseBlock('D_Base')]);
    const mid = symbolFile([derivedBlock('D_Mid', 'D_Base')]);
    const leaf = symbolFile([derivedBlock('D_Leaf', 'D_Mid')]).replace('(generator_version "10.0")', '(generator_version "10.0")\n\t(embedded_fonts no)');
    const byName = library([leaf, base, mid]);
    const body = bodyOf(byName, 'D_Leaf');
    expect(body).toBe(`(kicad_symbol_lib\n\t${HEADER}\n\t(embedded_fonts no)\n\t${baseBlock('D_Base')}\n\t${derivedBlock('D_Mid', 'D_Base')}\n\t${derivedBlock('D_Leaf', 'D_Mid')}\n)\n`);
    const back = parseSymbolLib(body).symbols;
    expect(back.map((s) => [s.name, s.extends])).toEqual([['D_Base', null], ['D_Mid', 'D_Base'], ['D_Leaf', 'D_Mid']]);
    expect(parseSymbolLib(bodyOf(byName, 'D_Mid')).symbols.map((s) => s.name)).toEqual(['D_Base', 'D_Mid']);
  });

  it('resolves a parent from the same plain library file', () => {
    const file = symbolFile([baseBlock('P1'), derivedBlock('P2', 'P1')]);
    const body = bodyOf(library([file]), 'P2');
    expect(parseSymbolLib(body).symbols.map((s) => s.name)).toEqual(['P1', 'P2']);
    expect(bodyOf(library([file]), 'P1')).toBe(symbolFile([baseBlock('P1')]));
  });

  it('refuses an extends cycle and a missing parent', () => {
    const cyclic = library([symbolFile([derivedBlock('A', 'B')]), symbolFile([derivedBlock('B', 'A')])]);
    expect(() => bodyOf(cyclic, 'A')).toThrow(/extends cycle at A/);
    const selfish = library([symbolFile([derivedBlock('S', 'S')])]);
    expect(() => bodyOf(selfish, 'S')).toThrow(/extends cycle at S/);
    const orphan = library([symbolFile([derivedBlock('X', 'Nope')])]);
    expect(() => bodyOf(orphan, 'X')).toThrow(/X extends Nope, which is not in the library/);
  });

  it('refuses a library newer than the engine\'s pinned fork reads, and passes 10.0.4\'s', () => {
    expect(FORK_MAX_SYMBOL_LIB_VERSION).toBe(20251024);
    expect(() => assertForkReads(20251024, 'R.kicad_sym')).not.toThrow();
    expect(() => assertForkReads(null, 'R.kicad_sym')).not.toThrow();
    expect(() => assertForkReads(20260101, 'R.kicad_sym')).toThrow(/R.kicad_sym declares symbol library version 20260101, newer than the engine's pinned fork reads \(20251024\)/);
  });
});
