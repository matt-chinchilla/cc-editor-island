// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The place op's blobs (loader/src/wasm/import-item.ts): a symbol as the
// clipboard dialect KiCad's schematic paste reads, a derived symbol flattened
// onto its extends chain, a footprint named by its LIB_ID.
import { describe, expect, it } from 'vitest';
import { buildFootprintImport, buildInteractiveImport, buildSymbolImport, flattenSymbol, hasInteractivePlacement } from '../loader/src/wasm/import-item';

const LIB_HEAD = '(kicad_symbol_lib\n\t(version 20251024)\n\t(generator "kicad_symbol_editor")\n\t(generator_version "10.0")';

const R = `${LIB_HEAD}
	(symbol "R"
		(pin_numbers (hide yes))
		(pin_names (offset 0))
		(exclude_from_sim no)
		(in_bom yes)
		(on_board yes)
		(property "Reference" "R" (at 2.032 0 90) (show_name no) (effects (font (size 1.27 1.27))))
		(property "Value" "R" (at 0 -1.5 90) (effects (font (size 1.27 1.27))))
		(property "Footprint" "" (at -1.778 0 90) (hide yes) (effects (font (size 1.27 1.27))))
		(property "Datasheet" "~" (at 0 0 0) (hide yes) (effects (font (size 1.27 1.27))))
		(property "Description" "Resistor (generic)" (at 0 0 0) (hide yes) (effects (font (size 1.27 1.27))))
		(property "ki_keywords" "R res resistor" (at 0 0 0) (hide yes) (effects (font (size 1.27 1.27))))
		(symbol "R_0_1" (rectangle (start -1.016 -2.54) (end 1.016 2.54)))
		(symbol "R_1_1"
			(pin passive line (at 0 3.81 270) (length 1.27) (name "~") (number "1"))
			(pin passive line (at 0 -3.81 90) (length 1.27) (name "~") (number "2"))
		)
		(embedded_fonts no)
	)
)
`;

/** A chain of three, root first, as a mirror body holds it: MCU_X <- MCU_XA <- MCU_XA1. */
const CHAIN = `${LIB_HEAD}
	(symbol "MCU_X"
		(exclude_from_sim no) (in_bom yes) (on_board yes) (in_pos_files yes)
		(property "Reference" "U" (at -5 10 0) (effects (font (size 1.27 1.27)) (justify left)))
		(property "Value" "MCU_X" (at 5 10 0) (effects (font (size 1.27 1.27))))
		(property "Footprint" "Package_QFP:LQFP-48_7x7mm_P0.5mm" (at 0 0 0) (hide yes) (effects (font (size 1.27 1.27))))
		(property "Datasheet" "https://example.test/x.pdf" (at 0 0 0) (hide yes) (effects (font (size 1.27 1.27))))
		(property "Description" "The family" (at 0 0 0) (hide yes) (effects (font (size 1.27 1.27))))
		(property "ki_keywords" "mcu family" (at 0 0 0) (hide yes) (effects (font (size 1.27 1.27))))
		(property "ki_fp_filters" "LQFP*" (at 0 0 0) (hide yes) (effects (font (size 1.27 1.27))))
		(property "Sim.Device" "SPICE" (at 0 0 0) (hide yes) (effects (font (size 1.27 1.27))))
		(symbol "MCU_X_0_1" (rectangle (start -5 8) (end 5 -8)))
		(symbol "MCU_X_1_1"
			(pin power_in line (at 0 10 270) (length 2) (name "VDD") (number "1"))
			(pin power_in line (at 0 -10 90) (length 2) (name "VSS") (number "2"))
			(pin bidirectional line (at -7 0 0) (length 2) (name "PA0") (number "3"))
		)
		(embedded_fonts no)
	)
	(symbol "MCU_XA"
		(extends "MCU_X")
		(property "Reference" "U" (at -5 10 0) (effects (font (size 1.27 1.27)) (justify left)))
		(property "Value" "MCU_XA" (at 5 10 0) (effects (font (size 1.27 1.27))))
		(property "Footprint" "" (at 0 0 0) (hide yes) (effects (font (size 1.27 1.27))))
		(property "Description" "The A part" (at 0 0 0) (hide yes) (effects (font (size 1.27 1.27))))
		(property "ki_keywords" "" (at 0 0 0) (hide yes) (effects (font (size 1.27 1.27))))
		(property "Sim.Device" "" (at 0 0 0) (hide yes) (effects (font (size 1.27 1.27))))
		(embedded_fonts no)
	)
	(symbol "MCU_XA1"
		(extends "MCU_XA")
		(property "Value" "MCU_XA1" (at 5 10 0) (effects (font (size 1.27 1.27))))
		(property "Datasheet" "https://example.test/xa1.pdf" (at 0 0 0) (hide yes) (effects (font (size 1.27 1.27))))
		(property "Grade" "Automotive (AEC-Q100)" (at 0 0 0) (hide yes) (effects (font (size 1.27 1.27))))
		(embedded_fonts no)
	)
)
`;

/** The direct child forms of one s-expression (quote-aware), for the assertions. */
function forms(sx: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let quoted = false;
  for (let i = 0; i < sx.length; i++) {
    const c = sx[i];
    if (quoted) { if (c === '\\') i++; else if (c === '"') quoted = false; continue; }
    if (c === '"') quoted = true;
    else if (c === '(') { depth++; if (depth === 2) start = i; }
    else if (c === ')') { if (depth === 2) out.push(sx.slice(start, i + 1)); depth--; }
  }
  return out;
}
const props = (block: string): Record<string, string> => Object.fromEntries(forms(block).flatMap((f) => {
  const m = /^\(property "((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)"/.exec(f);
  return m ? [[m[1], m[2]]] : [];
}));
const units = (block: string): string[] => forms(block).filter((f) => f.startsWith('(symbol ')).map((f) => /^\(symbol "([^"]*)"/.exec(f)?.[1] ?? '');
const pins = (block: string): number => (block.match(/\(pin /g) ?? []).length;
/** The blob's two top-level forms: the lib_symbols cache and the placed symbol. */
function blobParts(sexpr: string): { cache: string; placed: string } {
  const wrapped = forms(`(blob ${sexpr})`);
  expect(wrapped.map((f) => /^\(([a-z_]+)/.exec(f)?.[1])).toEqual(['lib_symbols', 'symbol']);
  return { cache: forms(wrapped[0])[0], placed: wrapped[1] };
}

describe('flattenSymbol', () => {
  it('returns a plain symbol as its body has it', () => {
    const flat = flattenSymbol(R, 'R');
    expect(flat.startsWith('(symbol "R"')).toBe(true);
    expect(units(flat)).toEqual(['R_0_1', 'R_1_1']);
    expect(pins(flat)).toBe(2);
  });

  it('lays a derived symbol over its chain, root first: the parent\'s graphics, pins and flags under its own name, no extends', () => {
    const flat = flattenSymbol(CHAIN, 'MCU_XA1');
    expect(flat.startsWith('(symbol "MCU_XA1"')).toBe(true);
    expect(flat).not.toContain('(extends');
    // KiCad checks a unit's name starts with its symbol's: the root's units are renamed.
    expect(units(flat)).toEqual(['MCU_XA1_0_1', 'MCU_XA1_1_1']);
    expect(pins(flat)).toBe(3);
    expect(flat).toContain('(in_pos_files yes)');
    expect((flat.match(/\(embedded_fonts/g) ?? []).length).toBe(1);
  });

  it('merges the fields as KiCad\'s Flatten does: a filled field of the child wins, an empty one inherits, any other field is replaced', () => {
    const p = props(flattenSymbol(CHAIN, 'MCU_XA1'));
    expect(p.Value).toBe('MCU_XA1');                              // the leaf's own
    expect(p.Datasheet).toBe('https://example.test/xa1.pdf');     // the leaf's own
    expect(p.Description).toBe('The A part');                     // the middle's
    expect(p.Footprint).toBe('Package_QFP:LQFP-48_7x7mm_P0.5mm'); // empty in the middle: the root's
    expect(p.ki_keywords).toBe('mcu family');                     // empty in the middle: the root's
    expect(p.ki_fp_filters).toBe('LQFP*');
    expect(p['Sim.Device']).toBe('');                             // not inherited when empty: the middle replaced it
    expect(p.Grade).toBe('Automotive (AEC-Q100)');                // the leaf's own extra field
    expect(Object.keys(p)).toEqual(['Reference', 'Value', 'Footprint', 'Datasheet', 'Description', 'ki_keywords', 'ki_fp_filters', 'Sim.Device', 'Grade']);
  });

  it('throws for a symbol the body lacks, a parent it lacks, and a chain that loops', () => {
    expect(() => flattenSymbol(R, 'C')).toThrow(/not found/);
    expect(() => flattenSymbol(CHAIN.replace(/\(symbol "MCU_X"\n[\s\S]*?\n\t\)\n\t\(symbol "MCU_XA"/, '(symbol "MCU_XA"'), 'MCU_XA1')).toThrow(/parent "MCU_X"/);
    const loop = `${LIB_HEAD}\n(symbol "A" (extends "B"))\n(symbol "B" (extends "A")))`;
    expect(() => flattenSymbol(loop, 'A')).toThrow(/loops/);
  });

  it('reads a name that holds a parenthesis as a name, never as a form', () => {
    const odd = R.replaceAll('"R"', '"R (odd)"').replaceAll('"R_0_1"', '"R (odd)_0_1"').replaceAll('"R_1_1"', '"R (odd)_1_1"');
    expect(units(flattenSymbol(odd, 'R (odd)'))).toEqual(['R (odd)_0_1', 'R (odd)_1_1']);
  });
});

describe('buildSymbolImport', () => {
  it('caches the symbol under its LIB_ID and places an unannotated instance with the library\'s fields at their library positions', () => {
    const r = buildSymbolImport(R, 'R', 'Device', 0, 0, '11111111-2222-3333-4444-555555555555');
    expect(r.libId).toBe('Device:R');
    expect(r.reference).toBe('R?');
    const { cache, placed } = blobParts(r.sexpr);
    expect(cache.startsWith('(symbol "Device:R"')).toBe(true);
    expect(units(cache)).toEqual(['R_0_1', 'R_1_1']);   // sub-units keep their short names
    expect(placed).toContain('(lib_id "Device:R") (at 0 0 0) (unit 1)');
    expect(placed).toContain('(uuid "11111111-2222-3333-4444-555555555555")');
    expect(placed).toContain('(exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no)');
    expect(props(placed)).toEqual({ Reference: 'R?', Value: 'R', Footprint: '', Datasheet: '~', Description: 'Resistor (generic)' });
    // A library position is y-up and a sheet's y-down; the angle and the effects travel.
    expect(placed).toContain('(property "Reference" "R?" (at 2.032 0 90) (show_name no) (effects (font (size 1.27 1.27))))');
    expect(placed).toContain('(property "Value" "R" (at 0 1.5 90)');
    expect(placed).toContain('(property "Footprint" "" (at -1.778 0 90) (hide yes)');
    expect(r.sexpr).not.toContain('kicad_symbol_lib');
    expect(placed).not.toContain('ki_keywords');   // library-only: in the cache, never on the instance
    expect(cache).toContain('(property "ki_keywords" "R res resistor"');
  });

  it('places a derived symbol flattened, with its own Footprint inherited down the chain', () => {
    const { sexpr } = buildInteractiveImport('symbol', CHAIN, 'MCU_Test', 'MCU_XA1');
    const { cache, placed } = blobParts(sexpr);
    expect(cache.startsWith('(symbol "MCU_Test:MCU_XA1"')).toBe(true);
    expect(sexpr).not.toContain('(extends');
    expect(units(cache)).toEqual(['MCU_XA1_0_1', 'MCU_XA1_1_1']);
    expect(pins(cache)).toBe(3);
    expect(placed).toContain('(lib_id "MCU_Test:MCU_XA1")');
    expect(props(placed)).toMatchObject({ Reference: 'U?', Value: 'MCU_XA1', Footprint: 'Package_QFP:LQFP-48_7x7mm_P0.5mm', Grade: 'Automotive (AEC-Q100)' });
    expect(placed).toContain('(property "Reference" "U?" (at -5 -10 0)');
  });

  it('takes a power symbol\'s flags from the library and keeps a reference that already ends in ?', () => {
    const pwr = R.replace('(in_bom yes)', '(in_bom no)').replace('(on_board yes)', '(on_board no)').replace('"Reference" "R"', '"Reference" "#PWR?"');
    const r = buildSymbolImport(pwr, 'R', 'power', 0, 0);
    expect(r.reference).toBe('#PWR?');
    expect(r.sexpr).toContain('(in_bom no) (on_board no)');
  });

  it('escapes quotes in names and values', () => {
    const q = R.replace('"Resistor (generic)"', '"A \\"quoted\\" one"');
    expect(buildSymbolImport(q, 'R', 'My "Lib"', 0, 0).sexpr).toContain('(lib_id "My \\"Lib\\":R")');
    expect(buildSymbolImport(q, 'R', 'Device', 0, 0).sexpr).toContain('"Description" "A \\"quoted\\" one"');
  });
});

describe('buildFootprintImport', () => {
  const FP = `(footprint "LQFP-48_7x7mm_P0.5mm"
	(version 20260206)
	(generator "kicad-footprint-generator")
	(layer "F.Cu")
	(descr "LQFP, 48 Pin (https://example.test (x))")
	(property "Reference" "REF**" (at 0 -5.85 0) (layer "F.SilkS") (effects (font (size 1 1))))
	(pad "1" smd roundrect (at -4.1625 -2.75) (size 1.475 0.3) (layers "F.Cu" "F.Mask" "F.Paste"))
	(pad "2" smd roundrect (at -4.1625 -2.25) (size 1.475 0.3) (layers "F.Cu" "F.Mask" "F.Paste"))
)`;

  it('names the footprint by its LIB_ID, puts (at x y) after the layer and keeps the version the body declares', () => {
    const r = buildFootprintImport(FP, 0, 0, 'Package_QFP');
    expect(r.name).toBe('LQFP-48_7x7mm_P0.5mm');
    expect(r.sexpr.startsWith('(footprint "Package_QFP:LQFP-48_7x7mm_P0.5mm"')).toBe(true);
    expect(r.sexpr).toMatch(/\(layer "F\.Cu"\)\n\t\(at 0 0\)/);
    expect(r.sexpr).toContain('(version 20260206)');
    expect(r.sexpr).toContain('(pad "1" smd roundrect (at -4.1625 -2.75)');   // nested positions untouched
    expect(r.sexpr.match(/\(at 0 0\)/g)).toHaveLength(1);
  });

  it('replaces a top-level at, and leaves the name alone without a nickname', () => {
    const r = buildFootprintImport(FP.replace('(layer "F.Cu")', '(layer "F.Cu")\n\t(at 1 2 90)'), 3, 4);
    expect(r.sexpr.startsWith('(footprint "LQFP-48_7x7mm_P0.5mm"')).toBe(true);
    expect(r.sexpr).not.toContain('(at 1 2 90)');
    expect(r.sexpr).toContain('(at 3 4)');
  });

  it('rejects text that is no footprint, and buildInteractiveImport labels it by LIB_ID', () => {
    expect(() => buildFootprintImport('(kicad_pcb)', 0, 0)).toThrow(/footprint/);
    expect(buildInteractiveImport('footprint', FP, 'Package_QFP', 'LQFP-48_7x7mm_P0.5mm').label).toBe('Package_QFP:LQFP-48_7x7mm_P0.5mm');
  });
});

describe('hasInteractivePlacement', () => {
  it('is true only when the editor exports kicadPlaceImportedItem', () => {
    expect(hasInteractivePlacement({ kicadCollabApplyItems: () => 0 })).toBe(false);
    expect(hasInteractivePlacement({ kicadCollabApplyItems: () => 0, kicadPlaceImportedItem: () => '{}' })).toBe(true);
    expect(hasInteractivePlacement(undefined)).toBe(false);
  });
});
