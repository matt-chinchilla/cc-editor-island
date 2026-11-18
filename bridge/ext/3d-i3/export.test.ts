// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { EXPORT_DONE, EXPORT_LINES, exportMsFor, MAX_JOB_MS, MIN_JOB_MS, readExportFolder, renderPercent } from '../../export';
import TIMING from '../../exportTiming.json';

describe('exportMsFor', () => {
  it('reads each 3D job its own bound and every other job the default', () => {
    expect(TIMING.default).toBe(45_000);
    expect(exportMsFor('pcb_export_3d')).toBe(TIMING.pcb_export_3d);
    expect(exportMsFor('pcb_render')).toBe(TIMING.pcb_render);
    expect(exportMsFor('pcb_export_gerbers')).toBe(45_000);
    expect(exportMsFor('default')).toBe(45_000);
  });

  it('holds a named bound between one and fifteen minutes', () => {
    for (const job of ['pcb_export_3d', 'pcb_render'] as const) {
      expect(TIMING[job]).toBeGreaterThanOrEqual(MIN_JOB_MS);
      expect(TIMING[job]).toBeLessThanOrEqual(MAX_JOB_MS);
    }
    expect(exportMsFor('a', { default: 1, a: 10 })).toBe(MIN_JOB_MS);
    expect(exportMsFor('a', { default: 1, a: 10_000_000 })).toBe(MAX_JOB_MS);
    expect(exportMsFor('b', { default: 7, a: 70_000 })).toBe(7);
  });
});

describe('renderPercent', () => {
  it('reads the last render line, plain or inside a record line', () => {
    expect(renderPercent('')).toBeNull();
    expect(renderPercent('Rendering 3 percent\nRendering 34 percent\n')).toBe(34);
    expect(renderPercent('{"severity":"info","text":"Rendering 100 percent"}\n')).toBe(100);
    expect(renderPercent('Rendering 400 percent')).toBe(100);
    expect(renderPercent('Rendered the board')).toBeNull();
  });

  it('is never answered as a file of the run', () => {
    expect(EXPORT_LINES.startsWith(`${EXPORT_DONE}.`)).toBe(true);
    const DIR = 0o040000;
    const names = ['out.png', EXPORT_LINES];
    const fs = {
      readdir: () => ['.', '..', ...names],
      stat: () => ({ mode: 0o100644 }),
      isDir: (m: number) => (m & DIR) === DIR,
      readFile: () => new Uint8Array([1, 2]),
    } as unknown as EmscriptenFS;
    const read = readExportFolder(fs, '/tmp/cc-out/1');
    expect('files' in read && read.files.map((f) => f.path)).toEqual(['out.png']);
  });
});
