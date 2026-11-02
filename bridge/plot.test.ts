// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { describe, expect, it } from 'vitest';
import { MAX_PLOT_BYTES, MAX_PLOT_FILES, owned, parsePlotArgs, plotFailure, plotJson, plotNotes, plotText, PLOT_DONE, readPlotDone, readPlotFolder, type PlotDone } from './plot';

const DIR = '/tmp/cc-plot/3';
const enc = (s: string) => new TextEncoder().encode(s);

/** A flat MEMFS folder stand-in: files by absolute path, folders by path. */
function folder(files: Record<string, string | Uint8Array>, dirs: string[] = []) {
  const all = new Map(Object.entries(files).map(([k, v]) => [`${DIR}/${k}`, typeof v === 'string' ? enc(v) : v]));
  const folders = new Set([DIR, ...dirs.map((d) => `${DIR}/${d}`)]);
  const FS = {
    readdir: (p: string) => ['.', '..', ...[...all.keys(), ...folders].filter((k) => k !== p && k.slice(0, k.lastIndexOf('/')) === p).map((k) => k.slice(p.length + 1))],
    stat: (p: string) => ({ mode: folders.has(p) ? 0o040755 : 0o100644 }),
    isDir: (mode: number) => (mode & 0o170000) === 0o040000,
    readFile: (p: string) => { const f = all.get(p); if (f == null) throw new Error(`ENOENT ${p}`); return f.slice(); },
  };
  return FS as unknown as EmscriptenFS;
}

describe('project.plot args', () => {
  it('takes exactly a preset and the two booleans', () => {
    expect(parsePlotArgs({ preset: 'fab', drill: true, job: true })).toEqual({ preset: 'fab', drill: true, job: true });
    expect(parsePlotArgs({ job: false, preset: 'board', drill: false })).toEqual({ preset: 'board', drill: false, job: false });
  });

  it('refuses anything else', () => {
    for (const args of [
      undefined, null, [], 'fab', {},
      { preset: 'fab', drill: true },
      { preset: 'fab', drill: true, job: true, dir: '/tmp/x' },
      { preset: 'gerber', drill: true, job: true },
      { preset: 'FAB', drill: true, job: true },
      { preset: 'fab', drill: 1, job: true },
      { preset: 'fab', drill: true, job: 'yes' },
    ]) expect(parsePlotArgs(args)).toBeNull();
  });

  it('hands kicadPlotBoard the folder with the args', () => {
    expect(JSON.parse(plotJson(DIR, { preset: 'board', drill: true, job: false }))).toEqual({ dir: DIR, preset: 'board', drill: true, job: false });
  });
});

describe('the run\'s record', () => {
  const done: PlotDone = {
    gerbers: 0,
    drill: 0,
    lines: [
      { severity: 'action', text: `Plotted to '${DIR}/glasgow-F_Cu.gbr'.` },
      { severity: 'warning', text: `Unconnected item in '${DIR}/glasgow-B_Cu.gbr'` },
      { severity: 'info', text: 'Done.' },
      { severity: 'error', text: `Failed to create file '${DIR}/glasgow-PTH.drl'.` },
    ],
  };

  it('reads the record the engine writes, and nothing else', () => {
    expect(readPlotDone(enc(JSON.stringify(done)))).toEqual(done);
    expect(readPlotDone(enc(JSON.stringify({ gerbers: 0, drill: null, lines: [] })))).toEqual({ gerbers: 0, drill: null, lines: [] });
    for (const bad of [
      null,
      enc('{"gerbers": 0, "drill": 0, "lines": ['),
      enc(JSON.stringify({ gerbers: 0.5, drill: null, lines: [] })),
      enc(JSON.stringify({ gerbers: 0, drill: 'no', lines: [] })),
      enc(JSON.stringify({ gerbers: 0, drill: null })),
      enc(JSON.stringify({ gerbers: 0, drill: null, lines: [{ severity: 'loud', text: 'x' }] })),
      enc(JSON.stringify({ gerbers: 0, drill: null, lines: [{ severity: 'info' }] })),
      enc('[]'),
    ]) expect(readPlotDone(bad)).toBeNull();
  });

  it('notes the warning and error lines in order, the run\'s folder never named', () => {
    expect(plotText(`a '${DIR}/x.gbr' b '${DIR}/y.drl'`, DIR)).toBe("a 'x.gbr' b 'y.drl'");
    expect(plotNotes(done, DIR)).toEqual(["Unconnected item in 'glasgow-B_Cu.gbr'", "Failed to create file 'glasgow-PTH.drl'."]);
  });

  it('fails on a gerbers code other than 0, or a drill asked for that ended nonzero, with the first error line', () => {
    const fab = { preset: 'fab' as const, drill: true, job: true };
    expect(plotFailure(done, fab, DIR)).toBeNull();
    expect(plotFailure({ ...done, gerbers: 4 }, fab, DIR)).toBe("Failed to create file 'glasgow-PTH.drl'.");
    expect(plotFailure({ ...done, drill: 4 }, fab, DIR)).toBe("Failed to create file 'glasgow-PTH.drl'.");
    expect(plotFailure({ gerbers: 4, drill: 0, lines: [] }, fab, DIR)).toBe('the gerbers job ended with code 4');
    expect(plotFailure({ gerbers: 0, drill: -1, lines: [] }, fab, DIR)).toBe('the drill job ended with code -1');
    // No drill asked for: its null code is no failure.
    expect(plotFailure({ gerbers: 0, drill: null, lines: [] }, { ...fab, drill: false }, DIR)).toBeNull();
  });
});

describe('the folder', () => {
  it('reads every file sorted by name, the record, its part and any folder left out', () => {
    const FS = folder({
      'glasgow-job.gbrjob': '{}',
      'glasgow-F_Cu.gbr': '%TF.FileFunction,Copper,L1,Top*%',
      'glasgow-B_Cu.gbr': '%TF.FileFunction,Copper,L4,Bot*%',
      'glasgow-PTH.drl': 'M48',
      [PLOT_DONE]: '{"gerbers":0,"drill":0,"lines":[]}',
      [`${PLOT_DONE}.part`]: '{',
    }, ['nested']);
    const read = readPlotFolder(FS, DIR);
    expect('files' in read && read.files.map((f) => f.path)).toEqual(['glasgow-B_Cu.gbr', 'glasgow-F_Cu.gbr', 'glasgow-PTH.drl', 'glasgow-job.gbrjob']);
    expect('files' in read && new TextDecoder().decode(read.files[2].bytes)).toBe('M48');
  });

  it('refuses past the file count or the byte total', () => {
    expect(MAX_PLOT_FILES).toBe(128);
    expect(MAX_PLOT_BYTES).toBe(512 * 1024 * 1024);
    const many = Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`f${String(i).padStart(3, '0')}.gbr`, 'x']));
    expect(readPlotFolder(folder(many), DIR)).toEqual({ error: 'too_large' });
    expect('files' in readPlotFolder(folder(Object.fromEntries(Object.entries(many).slice(0, 128))), DIR)).toBe(true);
    expect(readPlotFolder(folder({ 'a.gbr': '12345', 'b.gbr': '678' }), DIR, { files: 128, bytes: 7 })).toEqual({ error: 'too_large' });
    expect('files' in readPlotFolder(folder({ 'a.gbr': '12345', 'b.gbr': '67' }), DIR, { files: 128, bytes: 7 })).toBe(true);
  });

  it('answers bytes that own their whole buffer, so the answer may transfer them', () => {
    const whole = new Uint8Array([1, 2, 3]);
    expect(owned(whole)).toBe(whole);
    const view = new Uint8Array(new ArrayBuffer(16), 4, 3);
    const copy = owned(view);
    expect(copy).not.toBe(view);
    expect(copy.byteOffset).toBe(0);
    expect(copy.buffer.byteLength).toBe(3);
  });
});
