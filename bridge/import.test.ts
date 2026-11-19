// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// project.import's format (st-open-foreign-i): in a sch frame a format naming
// one of the engine's eight schematic importers picks the importer, whatever
// the extension; any other format, or none, leaves the extension to choose. A
// pcb frame reads no format: the engine tells its boards apart by content.
import { describe, expect, it, vi } from 'vitest';
import { armLegacyRun, foldLines, LEGACY_LINE_CHARS, LEGACY_MAX_LINES, legacySheetOf, legacyWarnings, readLegacyRecord } from './ext/st-open-kicad5-i/legacy';
import { driveImport, importable, importCall, importTarget, isSchematicFormat, MAX_WARNINGS, reportLines, SCHEMATIC_FORMATS, SCHEMATIC_TYPES, schematicType, WARNING_CHARS, type ImportWindow } from './import';

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
    expect(schematicType('x.txt')).toBe('PADS Logic');
    expect(importCall('sch', R, 'pads/simple_schematic.txt')).toEqual({ name: 'kicadImportSchematic', args: ['/p/pads/simple_schematic.txt', 'PADS Logic', '{}'] });
    expect(importable('simple_schematic.TXT', 'sch')).toBe(true);
    expect(importTarget('pads/simple_schematic.txt', 'sch')).toBe('pads/simple_schematic.kicad_sch');
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

describe('project.import format kicad5 (st-open-kicad5-i)', () => {
  it("calls kicadImportLegacyProject on the root sheet's <stem>.pro, with the armed run folder once", () => {
    expect(importCall('sch', R, 'demos/ecc83-pp.sch', undefined, 'kicad5')).toEqual({ name: 'kicadImportLegacyProject', args: ['{"path":"/p/demos/ecc83-pp.pro"}'] });
    expect(importCall('sch', R, 'ecc83-pp.pro', undefined, 'kicad5')).toEqual({ name: 'kicadImportLegacyProject', args: ['{"path":"/p/ecc83-pp.pro"}'] });
    armLegacyRun('/tmp/cc-legacy/4');
    expect(importCall('sch', R, 'ecc83-pp.sch', undefined, 'kicad5')).toEqual({ name: 'kicadImportLegacyProject', args: ['{"path":"/p/ecc83-pp.pro","run":4,"dir":"/tmp/cc-legacy/4"}'] });
    expect(importCall('sch', R, 'ecc83-pp.sch', undefined, 'kicad5')).toEqual({ name: 'kicadImportLegacyProject', args: ['{"path":"/p/ecc83-pp.pro"}'] });
  });

  it('kicad5 is not one of the schematic importers, reads nothing in a pcb frame, and never turns an Altium project', () => {
    expect(isSchematicFormat('kicad5')).toBe(false);
    expect(importCall('pcb', R, 'ecc83-pp.brd', undefined, 'kicad5')).toEqual({ name: 'kicadOpenFile', args: ['/p/ecc83-pp.brd'] });
    expect(importCall('sch', R, 'a.SchDoc', { project: 'p.PrjPcb', sheets: ['a.SchDoc'] }, 'kicad5').name).toBe('kicadImportSchematic');
    expect(importCall('sch', R, 'x.csa', undefined, 'kicad5')).toEqual({ name: 'kicadImportSchematic', args: ['/p/x.csa', 'CADSTAR Schematic Archive', '{}'] });
  });

  it('names the root sheet of a project or a sheet, in lower case only', () => {
    expect(legacySheetOf('ecc83-pp.pro')).toBe('ecc83-pp.sch');
    expect(legacySheetOf('d/electric.sch')).toBe('d/electric.sch');
    for (const x of ['x.PRO', 'x.Sch', '.pro', 'd/.sch', 'x.kicad_pro', 'x.lib']) expect(legacySheetOf(x)).toBeNull();
  });

  it("reads the engine's record closed and keeps only its warnings and errors", () => {
    const enc = (o: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(o));
    const rec = { opened: true, saved: true, files: ['/p/x.kicad_sch'], lines: [{ severity: 'action', text: 'Rescue R' }, { severity: 'warning', text: 'lib  gone' }, { severity: 'info', text: 'i' }, { severity: 'error', text: 'bad' }] };
    expect(legacyWarnings(readLegacyRecord(enc(rec)))).toEqual(['lib gone', 'bad']);
    for (const x of [null, new Uint8Array([123]), enc([]), enc({ ...rec, more: 1 }), enc({ ...rec, files: [1] }), enc({ ...rec, lines: [{ severity: 'error' }] })]) expect(readLegacyRecord(x)).toBeNull();
    expect(legacyWarnings(null)).toEqual([]);
  });

  it("folds the record's lines exactly as the answer's other warnings are folded", () => {
    expect([LEGACY_MAX_LINES, LEGACY_LINE_CHARS]).toEqual([MAX_WARNINGS, WARNING_CHARS]);
    const texts = ['a  b', ' a b ', '', 'x'.repeat(300), ...Array.from({ length: 50 }, (_, i) => `line ${i}`)];
    expect(foldLines(texts)).toEqual(reportLines(texts));
  });

  it('drives the legacy call as a schematic import and awaits its Promise (RULINGS 18)', async () => {
    const call = vi.fn(async () => true);
    const w = { Module: { kicadImportLegacyProject: call } } as unknown as ImportWindow;
    const timing = { importMs: 5_000, importPollMs: 5, importQuietMs: 20, importStepMs: 10, importRefusedMs: 50, importCloseMs: 50 };
    const r = await driveImport(w, importCall('sch', R, 'x.sch', undefined, 'kicad5'), { deadline: Date.now() + 5_000, timing, closed: () => false, engineBusy: () => false });
    expect(r).toEqual({ ok: true, warnings: [] });
    expect(call).toHaveBeenCalledWith('{"path":"/p/x.pro"}');
    const refused = await driveImport({ Module: { kicadImportLegacyProject: async () => false } } as unknown as ImportWindow, importCall('sch', R, 'x.sch', undefined, 'kicad5'), { deadline: Date.now() + 5_000, timing, closed: () => false, engineBusy: () => false });
    expect(refused).toEqual({ ok: false, message: 'the engine could not import the file' });
    expect(await driveImport({ Module: {} } as unknown as ImportWindow, importCall('sch', R, 'x.sch', undefined, 'kicad5'), { deadline: Date.now() + 5_000, timing, closed: () => false, engineBusy: () => false }))
      .toEqual({ ok: false, message: 'kicadImportLegacyProject is missing' });
  });
});
