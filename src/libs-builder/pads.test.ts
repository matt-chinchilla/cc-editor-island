// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// fp-index's pad count is the engine's FOOTPRINT::GetUniquePadCount(
// DO_NOT_INCLUDE_NPTH ) (pcbnew/footprint.cpp at the kicad-source-mirror commit
// PIN.json pcbjam.kicad names): GetUniquePadNumbers inserts pad->GetNumber()
// into a std::set, skipping a pad whose layer set misses LSET::AllCuMask(), a
// pad whose number IsEmpty(), and, without NPTH, a PAD_ATTRIB::NPTH pad. The
// inputs come from PCB_IO_KICAD_SEXPR_PARSER::parsePAD: the number is the
// lexer's decoded token, np_thru_hole is NPTH, each (layers ...) replaces the
// set through m_layerMasks (an unknown name is Rescue), and a pad with no
// layers keeps PAD's default PTH mask.
import { describe, expect, it } from 'vitest';
import { assertForkReads, countUniquePads, FORK_MAX_BOARD_VERSION, parseFootprintFile } from '../../scripts/libs/kicad-pretty.mjs';
import { ODD, R0603, USB_C_LIKE } from './kit.mjs';

const fp = (...pads: string[]) => `(footprint "T"\n\t(version 20260206)\n${pads.map((p) => `\t${p}\n`).join('')})\n`;

describe('the unique pad count', () => {
  it('counts distinct numbers once: duplicates collapse', () => {
    expect(countUniquePads(fp('(pad "1" smd rect (layers "F.Cu"))', '(pad "1" smd rect (layers "F.Cu"))', '(pad "2" smd rect (layers "F.Cu"))'))).toBe(2);
    expect(countUniquePads(USB_C_LIKE)).toBe(3);   // A1, B12, S1
  });

  it('leaves out NPTH pads, numbered or not', () => {
    expect(countUniquePads(fp('(pad "1" smd rect (layers "F.Cu"))', '(pad "" np_thru_hole circle (layers "*.Cu" "*.Mask"))', '(pad "H1" np_thru_hole circle (layers "*.Cu" "*.Mask"))'))).toBe(1);
  });

  it('leaves out unnumbered pads, even on copper', () => {
    expect(countUniquePads(fp('(pad "" smd rect (layers "F.Cu"))', '(pad "" thru_hole circle (layers "*.Cu"))'))).toBe(0);
  });

  it('leaves out pads on no copper layer, and keeps every copper name the fork knows', () => {
    expect(countUniquePads(R0603)).toBe(2);   // the paste-only aperture pad is not counted
    for (const layer of ['F.Cu', 'B.Cu', 'In1.Cu', 'In30.Cu', '*.Cu', '*In.Cu', 'F&B.Cu']) {
      expect(countUniquePads(fp(`(pad "1" smd rect (layers "${layer}"))`)), layer).toBe(1);
    }
    for (const layer of ['F.Paste', 'F.Mask', '*.Mask', 'Dwgs.User', 'Edge.Cuts', 'In31.Cu', 'In0.Cu', 'F.CU', 'Cu']) {
      expect(countUniquePads(fp(`(pad "1" smd rect (layers "${layer}"))`)), layer).toBe(0);
    }
  });

  it('follows the parser on every other case', () => {
    // 1 A 7 8 9 10 12 a Ω1: see kit.mjs ODD for each pad's reason.
    expect(countUniquePads(ODD)).toBe(9);
  });

  it('decodes a quoted number before comparing (\\x41 and \\101 are A)', () => {
    expect(countUniquePads(fp('(pad "A" smd rect (layers "F.Cu"))', '(pad "\\x41" smd rect (layers "F.Cu"))', '(pad "\\101" smd rect (layers "F.Cu"))'))).toBe(1);
    expect(countUniquePads(fp('(pad "A" smd rect (layers "F.Cu"))', '(pad "a" smd rect (layers "F.Cu"))'))).toBe(2);
  });

  it('reads a pre-KiCad 6 module with bare numbers and layers', () => {
    expect(countUniquePads('(module R_Old (layer F.Cu)\n  (pad 1 smd rect (at 0 0) (size 1 1) (layers F.Cu F.Paste F.Mask))\n  (pad 2 smd rect (at 1 0) (size 1 1) (layers F.Cu F.Paste F.Mask))\n)\n')).toBe(2);
  });

  it('keeps the footprint text unchanged and refuses a format newer than the pinned fork reads', () => {
    const parsed = parseFootprintFile(R0603, 'R_0603');
    expect(parsed).toEqual({ name: 'R_0603', version: 20260206, body: R0603 });
    expect(FORK_MAX_BOARD_VERSION).toBe(20260206);
    expect(() => assertForkReads(20260206, 'R_0603.kicad_mod')).not.toThrow();
    expect(() => assertForkReads(20260301, 'R_0603.kicad_mod')).toThrow(/declares footprint version 20260301, newer than the engine's pinned fork reads \(20260206\)/);
    expect(() => countUniquePads('(kicad_symbol_lib)')).toThrow(/not \(footprint/);
  });
});
