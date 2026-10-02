// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { describe, expect, it } from 'vitest';
import { DISPLAY_OPACITY, localSettingsPath, normalizePath, PROJECT_ROOT, stageLocalSettings, stageProject } from './stage';

describe('normalizePath', () => {
  it('accepts plain relative paths', () => {
    expect(normalizePath('blink.kicad_sch')).toBe('blink.kicad_sch');
    expect(normalizePath('lib/parts.pretty/R_0805.kicad_mod')).toBe('lib/parts.pretty/R_0805.kicad_mod');
    expect(normalizePath('sub\\board.kicad_pcb')).toBe('sub/board.kicad_pcb');
  });
  it('rejects traversal, absolute, empty, dotted, NUL and long paths', () => {
    for (const bad of ['../../home/.config/kicad/kicad_common.json', '/etc/passwd', 'a/../b', 'a/./b', 'a//b', 'a\u0000b', '', '.', '..', 'x'.repeat(256)]) {
      expect(normalizePath(bad)).toBeNull();
    }
  });
});

function fakeFs() {
  const dirs = new Set<string>(['/']);
  const files = new Map<string, Uint8Array>();
  const FS = {
    mkdirTree(p: string) { let acc = ''; for (const s of p.split('/').filter(Boolean)) { acc += `/${s}`; dirs.add(acc); } },
    writeFile(p: string, data: Uint8Array | string) {
      const parent = p.slice(0, p.lastIndexOf('/')) || '/';
      if (!dirs.has(parent)) throw new Error(`ENOENT ${parent}`);
      if (dirs.has(p)) throw new Error(`EISDIR ${p}`);
      files.set(p, typeof data === 'string' ? new TextEncoder().encode(data) : data.slice());
    },
    readFile(p: string) { const f = files.get(p); if (!f) throw new Error(`ENOENT ${p}`); return f.slice(); },
    analyzePath(p: string) { return { exists: files.has(p) || dirs.has(p) }; },
    unlink(p: string) { files.delete(p); },
  };
  return { FS, dirs, files };
}

describe('stageProject', () => {
  it('writes only under the project root and reports rejected paths as dropped', () => {
    const { FS, files } = fakeFs();
    const win = { FS } as unknown as ToolWindow;
    const b = (s: string) => new TextEncoder().encode(s);
    const staged = stageProject(win, 'cc', [
      { path: 'blink.kicad_sch', bytes: b('(kicad_sch)') },
      { path: 'sub\\power.kicad_sch', bytes: b('(kicad_sch)') },
      { path: '../../../.config/kicad/kicad/10.0/kicad_common.json', bytes: b('{}') },
      { path: '/etc/passwd', bytes: b('x') },
    ]);
    const root = `${PROJECT_ROOT}/cc`;
    expect(staged.root).toBe(root);
    expect(staged.written).toEqual(['blink.kicad_sch', 'sub/power.kicad_sch']);
    expect(staged.dropped).toEqual(['../../../.config/kicad/kicad/10.0/kicad_common.json', '/etc/passwd']);
    expect([...files.keys()].sort()).toEqual([`${root}/blink.kicad_sch`, `${root}/sub/power.kicad_sch`]);
  });

  it('drops a file the filesystem refuses and lists a repeated path once', () => {
    const { FS } = fakeFs();
    const win = { FS } as unknown as ToolWindow;
    const b = new Uint8Array([1]);
    const staged = stageProject(win, 'cc', [
      { path: 'a/b.kicad_sch', bytes: b },
      { path: 'a', bytes: b },
      { path: 'a/b.kicad_sch', bytes: b },
    ]);
    expect(staged.written).toEqual(['a/b.kicad_sch']);
    expect(staged.dropped).toEqual(['a']);
  });

  it('refuses an id that is not one plain segment', () => {
    const { FS } = fakeFs();
    const win = { FS } as unknown as ToolWindow;
    expect(() => stageProject(win, '../x', [])).toThrow();
    expect(() => stageProject(win, '', [])).toThrow();
  });
});

describe('stageLocalSettings', () => {
  const b = (s: string) => new TextEncoder().encode(s);
  const root = `${PROJECT_ROOT}/cc`;

  it('names KiCad\'s local settings after the file it opens, beside it', () => {
    expect(localSettingsPath('glasgow.kicad_pcb')).toBe('glasgow.kicad_prl');
    expect(localSettingsPath('boards/aht20.brd')).toBe('boards/aht20.kicad_prl');
    expect(localSettingsPath('v1.2/main.kicad_sch')).toBe('v1.2/main.kicad_prl');
    expect(localSettingsPath('../x.kicad_pcb')).toBeNull();
    expect(localSettingsPath('noext')).toBeNull();
  });

  it('writes every display opacity at 1 with the schema\'s meta block, when the host sent none', () => {
    const { FS, files } = fakeFs();
    const win = { FS } as unknown as ToolWindow;
    const staged = stageProject(win, 'cc', [{ path: 'sub/board.kicad_pcb', bytes: b('(kicad_pcb)') }, { path: 'sub/board.kicad_pro', bytes: b('{}') }]);
    expect(stageLocalSettings(win, staged, 'sub/board.kicad_pcb')).toBe('sub/board.kicad_prl');
    const prl = JSON.parse(new TextDecoder().decode(files.get(`${root}/sub/board.kicad_prl`)));
    // KiCad 10 at the pin (project_local_settings.cpp): zones and images default to 0.6, the rest to 1.
    expect(DISPLAY_OPACITY).toEqual({ images: 1, pads: 1, shapes: 1, tracks: 1, vias: 1, zones: 1 });
    expect(prl).toEqual({ board: { opacity: DISPLAY_OPACITY }, meta: { filename: 'board.kicad_prl', version: 5 } });
    // Not one of the host's files: never listed as written, so nothing reports it.
    expect(staged.written).toEqual(['sub/board.kicad_pcb', 'sub/board.kicad_pro']);
  });

  it('keeps the host\'s own settings: nothing is written over them', () => {
    const { FS, files } = fakeFs();
    const win = { FS } as unknown as ToolWindow;
    const staged = stageProject(win, 'cc', [{ path: 'board.kicad_pcb', bytes: b('(kicad_pcb)') }, { path: 'board.kicad_prl', bytes: b('{"host":true}') }]);
    expect(stageLocalSettings(win, staged, 'board.kicad_pcb')).toBeNull();
    expect(new TextDecoder().decode(files.get(`${root}/board.kicad_prl`))).toBe('{"host":true}');
  });

  it('writes nothing when the file system refuses the path (a folder of that name)', () => {
    const { FS, dirs } = fakeFs();
    const win = { FS } as unknown as ToolWindow;
    const staged = stageProject(win, 'cc', [{ path: 'board.kicad_pcb', bytes: b('(kicad_pcb)') }]);
    dirs.add(`${root}/board.kicad_prl`);
    expect(stageLocalSettings(win, staged, 'board.kicad_pcb')).toBeNull();
  });
});
