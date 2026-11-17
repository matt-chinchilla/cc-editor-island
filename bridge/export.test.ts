// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { describe, expect, it } from 'vitest';
import FACES from './exports.json';
import {
  EXPORT_DONE, EXPORT_JOBS, exportFace, exportFailure, exportJson, kicadProblem, MAX_EXPORT_BYTES, MAX_EXPORT_FILES, PAGED_JOBS, parseExportArgs,
  readExportDone, readExportFolder, type ExportDone,
} from './export';

const DIR = '/tmp/cc-out/3';
const enc = (s: string) => new TextEncoder().encode(s);

/** A MEMFS folder stand-in: files by path under DIR, folders by path, links by path. */
function folder(files: Record<string, string>, dirs: string[] = [], links: string[] = [], lstat = true) {
  const all = new Map(Object.entries(files).map(([k, v]) => [`${DIR}/${k}`, enc(v)]));
  const folders = new Set([DIR, ...dirs.map((d) => `${DIR}/${d}`)]);
  const linked = new Set(links.map((l) => `${DIR}/${l}`));
  const parent = (p: string) => p.slice(0, p.lastIndexOf('/'));
  const FS = {
    readdir: (p: string) => ['.', '..', ...[...all.keys(), ...folders, ...linked].filter((k) => k !== p && parent(k) === p).map((k) => k.slice(p.length + 1))],
    stat: (p: string) => ({ mode: folders.has(p) ? 0o040755 : 0o100644 }),
    isDir: (mode: number) => (mode & 0o170000) === 0o040000,
    readFile: (p: string) => { const f = all.get(p); if (f == null) throw new Error(`ENOENT ${p}`); return f.slice(); },
    ...(lstat ? { lstat: (p: string) => ({ mode: linked.has(p) ? 0o120777 : folders.has(p) ? 0o040755 : 0o100644 }), isLink: (mode: number) => (mode & 0o170000) === 0o120000 } : {}),
  };
  return FS as unknown as EmscriptenFS;
}

describe('the jobs', () => {
  it('names section 6.3\'s nineteen board jobs and seven schematic jobs, each with its face', () => {
    expect(EXPORT_JOBS).toEqual(FACES);
    expect(Object.values(EXPORT_JOBS).filter((f) => f === 'pcb')).toHaveLength(19);
    expect(Object.values(EXPORT_JOBS).filter((f) => f === 'sch')).toHaveLength(7);
    expect(exportFace('pcb_export_ipc2581')).toBe('pcb');
    expect(exportFace('cc_symbols')).toBe('sch');
    for (const job of PAGED_JOBS) expect(EXPORT_JOBS[job]).toBe('sch');
  });
});

describe('project.export args', () => {
  it('takes a job, its settings and, for a schematic plot, its pages', () => {
    expect(parseExportArgs({ job: 'pcb_export_pos', settings: {} })).toEqual({ job: 'pcb_export_pos', settings: {} });
    const settings = { format: 'csv', units: 'mm', use_drill_place_file_origin: false, precision: 6, layers: ['F.Cu', 'B.Cu'], scale: 1.5 };
    expect(parseExportArgs({ settings, job: 'pcb_export_pdf' })).toEqual({ job: 'pcb_export_pdf', settings });
    expect(parseExportArgs({ job: 'sch_export_plot_pdf', settings: {}, pages: [] })).toEqual({ job: 'sch_export_plot_pdf', settings: {}, pages: [] });
    expect(parseExportArgs({ job: 'sch_export_plot_svg', settings: {}, pages: ['1', '2', 'a'.repeat(32)] })).toEqual({ job: 'sch_export_plot_svg', settings: {}, pages: ['1', '2', 'a'.repeat(32)] });
    expect(parseExportArgs({ job: 'pcb_export_pos', settings: Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`k${i}`, i])) })).not.toBeNull();
    expect(parseExportArgs({ job: 'pcb_export_pos', settings: { list: Array.from({ length: 256 }, () => 'x'), text: 'a'.repeat(1024) } })).not.toBeNull();
  });

  it('refuses each other shape, one at a time', () => {
    const ok = { job: 'pcb_export_pos', settings: {} };
    for (const args of [
      undefined, null, [], 'pcb_export_pos', {},
      { job: 'pcb_export_pos' },
      { settings: {} },
      { ...ok, extra: 1 },
      { ...ok, job: 'pcb_export_hpgl' },
      { ...ok, job: 'PCB_EXPORT_POS' },
      { ...ok, job: 'toString' },
      { ...ok, job: 7 },
      { ...ok, settings: null },
      { ...ok, settings: [] },
      { ...ok, settings: new Map() },
      { ...ok, settings: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`k${i}`, i])) },
      { ...ok, settings: { a: null } },
      { ...ok, settings: { a: { b: 1 } } },
      { ...ok, settings: { a: NaN } },
      { ...ok, settings: { a: Infinity } },
      { ...ok, settings: { a: 'a'.repeat(1025) } },
      { ...ok, settings: { a: [1, 2] } },
      { ...ok, settings: { a: [true] } },
      { ...ok, settings: { a: ['a'.repeat(1025)] } },
      { ...ok, settings: { a: Array.from({ length: 257 }, () => 'x') } },
      { ...ok, pages: [] },
      { job: 'sch_export_netlist', settings: {}, pages: [] },
      { job: 'cc_symbols', settings: {}, pages: ['1'] },
      { job: 'sch_export_plot_pdf', settings: {}, pages: '1' },
      { job: 'sch_export_plot_pdf', settings: {}, pages: [''] },
      { job: 'sch_export_plot_pdf', settings: {}, pages: [1] },
      { job: 'sch_export_plot_pdf', settings: {}, pages: ['a'.repeat(33)] },
      { job: 'sch_export_plot_pdf', settings: {}, pages: ['é'.repeat(17)] },
      { job: 'sch_export_plot_pdf', settings: {}, pages: Array.from({ length: 1025 }, () => '1') },
    ]) expect(parseExportArgs(args), JSON.stringify(args)).toBeNull();
  });

  it('copies what it takes, and hands the engine the run, the folder, the job, the settings and the pages', () => {
    const settings = { layers: ['F.Cu'] };
    const a = parseExportArgs({ job: 'pcb_export_svg', settings })!;
    settings.layers.push('B.Cu');
    expect(a.settings.layers).toEqual(['F.Cu']);
    expect(JSON.parse(exportJson(4, DIR, a))).toEqual({ run: 4, dir: DIR, job: 'pcb_export_svg', settings: { layers: ['F.Cu'] } });
    expect(JSON.parse(exportJson(4, DIR, { job: 'sch_export_plot_ps', settings: {}, pages: ['3'] }))).toEqual({ run: 4, dir: DIR, job: 'sch_export_plot_ps', settings: {}, pages: ['3'] });
  });
});

describe('the run\'s record', () => {
  const done: ExportDone = { code: 0, lines: [{ severity: 'info', text: 'x' }, { severity: 'warning', text: 'y' }], dropped: ['hpgl_page_size'] };

  it('reads exactly { code, lines, dropped }, and nothing else', () => {
    expect(readExportDone(enc(JSON.stringify(done)))).toEqual(done);
    for (const bad of [
      null, enc('not json'), enc('[]'),
      enc(JSON.stringify({ code: 0, lines: [] })),
      enc(JSON.stringify({ ...done, extra: 1 })),
      enc(JSON.stringify({ ...done, code: 0.5 })),
      enc(JSON.stringify({ ...done, code: '0' })),
      enc(JSON.stringify({ ...done, lines: [{ severity: 'fatal', text: 'x' }] })),
      enc(JSON.stringify({ ...done, dropped: [1] })),
      enc(JSON.stringify({ ...done, dropped: 'x' })),
    ]) expect(readExportDone(bad)).toBeNull();
  });

  it('fails a nonzero code with the first error line, else the first line, else the code, the folder taken out', () => {
    expect(exportFailure(done, DIR)).toBeNull();
    expect(exportFailure({ code: 1, lines: [{ severity: 'warning', text: 'w' }, { severity: 'error', text: `Cannot write '${DIR}/a.dsn'` }], dropped: [] }, DIR)).toBe("Cannot write 'a.dsn'");
    expect(exportFailure({ code: -1, lines: [{ severity: 'info', text: 'Only VRML is made here.' }], dropped: [] }, DIR)).toBe('Only VRML is made here.');
    expect(exportFailure({ code: -1, lines: [{ severity: 'info', text: `Successfully exported VRML to ${DIR}/g.wrl` }, { severity: 'info', text: 'The VRML exporter wrote no board (an empty scene).' }], dropped: [] }, DIR)).toBe('The VRML exporter wrote no board (an empty scene).');
    // A KiCad job's failure with no error line says its code, never its last line ("Done.").
    expect(exportFailure({ code: 4, lines: [{ severity: 'action', text: `Created file '${DIR}/g-PTH.drl'` }, { severity: 'info', text: 'Done.' }], dropped: [] }, DIR)).toBe('the export ended with code 4');
    expect(exportFailure({ code: 2, lines: [], dropped: [] }, DIR)).toBe('the export ended with code 2');
    // KiCad's IO_ERROR text keeps only its sentence (Specctra DSN on Glasgow, engine run 14).
    expect(exportFailure({ code: 1, lines: [{ severity: 'error', text: "IO_ERROR: Multiple footprints have the reference designator 'REF**'.\nfrom specctra_export.cpp : FromBOARD() line 1095" }], dropped: [] }, DIR)).toBe("Multiple footprints have the reference designator 'REF**'.");
  });
});

describe('the folder', () => {
  it('reads every file by its path, one folder deep, sorted, the record and its .part left out', () => {
    const FS = folder({ 'b.csv': 'b', 'a.d356': 'a', [EXPORT_DONE]: '{}', [`${EXPORT_DONE}.part`]: '{', 'devices/z.txt': 'z', 'devices/y.txt': 'y', 'g.pretty/R.kicad_mod': 'r' }, ['devices', 'g.pretty', 'empty']);
    const read = readExportFolder(FS, DIR);
    expect('files' in read && read.files.map((f) => f.path)).toEqual(['a.d356', 'b.csv', 'devices/y.txt', 'devices/z.txt', 'g.pretty/R.kicad_mod']);
    if ('files' in read) for (const f of read.files) expect(f.bytes.byteOffset === 0 && f.bytes.byteLength === f.bytes.buffer.byteLength).toBe(true);
  });

  it('refuses a folder in a folder, a link at either level, and more than the protocol carries', () => {
    expect(readExportFolder(folder({ 'a/b/c': 'x' }, ['a', 'a/b']), DIR)).toEqual({ error: 'too_deep' });
    expect(readExportFolder(folder({ 'a.csv': 'x' }, [], ['l']), DIR)).toEqual({ error: 'link' });
    expect(readExportFolder(folder({ 'a/x': 'x' }, ['a'], ['a/l']), DIR)).toEqual({ error: 'link' });
    // Without MEMFS's link reads, a link is read as what it names.
    expect('files' in readExportFolder(folder({ 'a.csv': 'x' }, [], [], false), DIR)).toBe(true);
    expect(readExportFolder(folder({ a: 'x', b: 'y', c: 'z' }), DIR, { files: 2, bytes: 100 })).toEqual({ error: 'too_large' });
    expect(readExportFolder(folder({ a: 'xx', b: 'yy' }), DIR, { files: 10, bytes: 3 })).toEqual({ error: 'too_large' });
    expect(MAX_EXPORT_FILES).toBe(1024);
    expect(MAX_EXPORT_BYTES).toBe(512 * 1024 * 1024);
  });
});

describe('kicadProblem', () => {
  it('keeps the sentence of an IO_ERROR and leaves any other text as it is', () => {
    expect(kicadProblem("IO_ERROR: Multiple footprints have the reference designator 'REF**'. from specctra_export.cpp : FromBOARD() line 1095")).toBe("Multiple footprints have the reference designator 'REF**'.");
    expect(kicadProblem('Only VRML is made here.')).toBe('Only VRML is made here.');
    expect(kicadProblem('IO_ERROR: ')).toBe('IO_ERROR: ');
    expect(kicadProblem("Cannot write 'a.dsn' from here")).toBe("Cannot write 'a.dsn' from here");
  });
});
