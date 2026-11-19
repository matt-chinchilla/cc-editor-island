// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// project.import's format (st-open-foreign-i): in a sch frame a format naming
// one of the engine's eight schematic importers picks the importer, whatever
// the extension; any other format, or none, leaves the extension to choose. A
// pcb frame reads no format: the engine tells its boards apart by content.
import { describe, expect, it } from 'vitest';
import { importable, importCall, importTarget, isSchematicFormat, SCHEMATIC_FORMATS, SCHEMATIC_TYPES, schematicType } from './import';

const R = '/p';

describe('project.import format', () => {
  it('names the eight importers exactly as KiCad spells them (SCH_IO_MGR::ShowType, the eight kicadImportSchematic takes)', () => {
    expect([...SCHEMATIC_FORMATS]).toEqual([
      'Altium',
      'CADSTAR Schematic Archive',
      'EAGLE',
      'EasyEDA (JLCEDA) Std',
      'EasyEDA (JLCEDA) Pro',
      'gEDA / Lepton EDA',
      'LTspice',
      'PADS Logic',
    ]);
    for (const type of Object.values(SCHEMATIC_TYPES)) expect(SCHEMATIC_FORMATS).toContain(type);
  });

  it('a known format is authoritative in a sch frame: a gEDA .sch is read as gEDA, not Eagle; a PADS Logic .asc as PADS Logic, not LTspice', () => {
    expect(importCall('sch', R, 'g/minimal_test.sch', undefined, 'gEDA / Lepton EDA')).toEqual({ name: 'kicadImportSchematic', args: ['/p/g/minimal_test.sch', 'gEDA / Lepton EDA', '{}'] });
    expect(importCall('sch', R, 'g/minimal_test.sch')).toEqual({ name: 'kicadImportSchematic', args: ['/p/g/minimal_test.sch', 'EAGLE', '{}'] });
    expect(importCall('sch', R, 'pads.asc', undefined, 'PADS Logic')).toEqual({ name: 'kicadImportSchematic', args: ['/p/pads.asc', 'PADS Logic', '{}'] });
    expect(importCall('sch', R, 'divider.asc')).toEqual({ name: 'kicadImportSchematic', args: ['/p/divider.asc', 'LTspice', '{}'] });
  });

  it('every one of the eight formats reaches the engine as given, for any importable file', () => {
    for (const f of SCHEMATIC_FORMATS) {
      expect(importCall('sch', R, 'x.sch', undefined, f)).toEqual({ name: 'kicadImportSchematic', args: ['/p/x.sch', f, '{}'] });
      expect(schematicType('x.zip', f)).toBe(f);
    }
  });

  it('a format the island does not know (another spelling, another case, an empty string) leaves the extension to choose', () => {
    for (const f of ['eagle', 'altium', 'EAGLE ', 'gEDA', 'kicad5', '', 'pads logic']) {
      expect(isSchematicFormat(f)).toBe(false);
      expect(schematicType('x.sch', f)).toBe('EAGLE');
      expect(schematicType('x.CSA', f)).toBe('CADSTAR Schematic Archive');
    }
    expect(isSchematicFormat(undefined)).toBe(false);
    expect(isSchematicFormat(42)).toBe(false);
    expect(schematicType('x.unknown')).toBe('');
  });

  it("a pcb frame reads no format: Eagle, Allegro and KiCad 4 .brd boards all go to the engine's own open, which tells them apart by content", () => {
    for (const f of [undefined, 'EAGLE', 'allegro', 'kicad-legacy', 'PADS Logic']) {
      expect(importCall('pcb', R, 'b/rects.brd', undefined, f)).toEqual({ name: 'kicadOpenFile', args: ['/p/b/rects.brd'] });
      expect(importCall('pcb', R, 'ecc83-pp.brd', undefined, f)).toEqual({ name: 'kicadOpenFile', args: ['/p/ecc83-pp.brd'] });
    }
    expect(importable('rects.brd', 'pcb')).toBe(true);
    expect(importTarget('b/rects.brd', 'pcb')).toBe('b/rects.kicad_pcb');
    expect(importTarget('ecc83-pp.brd', 'pcb')).toBe('ecc83-pp.kicad_pcb');
  });

  it('an Altium project keeps its project import whatever the format says', () => {
    const call = importCall('sch', R, 'a.SchDoc', { project: 'p.PrjPcb', sheets: ['a.SchDoc'] }, 'EAGLE');
    expect(call).toEqual({ name: 'kicadImportSchematic', args: ['', 'Altium', JSON.stringify({ project_file: '/p/p.PrjPcb', sch0: '/p/a.SchDoc' })] });
  });

  it('the schematic files of every importer the fixtures carry are importable in a sch frame and convert beside themselves', () => {
    for (const p of ['divider.asc', 'minimal.csa', 'minimal_test.sch', 'eagle-import-testfile.sch', 'smart watch.json', 'OpenSTM ControlBoard.zip']) {
      expect(importable(p, 'sch')).toBe(true);
      expect(importTarget(`d/${p}`, 'sch')).toBe(`d/${p.slice(0, p.lastIndexOf('.'))}.kicad_sch`);
    }
  });
});
