// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { boardModelRefs, ensureWriting, MODELS_ROOT, modelSource, noteOccLoading, occLoadingPercent, PROJECT_MODELS, projectRelative, stageBoardModels, stagedModels, stageModels } from './occModels';

/** A small MEMFS: files by absolute path, folders implied. */
function memfs(files: Record<string, Uint8Array> = {}) {
  const store = new Map<string, Uint8Array>(Object.entries(files));
  const dirs = new Set<string>(['/']);
  const DIR = 0o040000;
  const isDirPath = (p: string): boolean => dirs.has(p) || [...store.keys()].some((k) => k.startsWith(`${p}/`));
  const fs = {
    mkdirTree: (p: string) => { let acc = ''; for (const part of p.split('/').filter(Boolean)) { acc += `/${part}`; dirs.add(acc); } },
    writeFile: (p: string, d: Uint8Array | string) => { store.set(p, typeof d === 'string' ? new TextEncoder().encode(d) : d); },
    readFile: (p: string) => { const b = store.get(p); if (b == null) throw new Error('ENOENT'); return b; },
    analyzePath: (p: string) => ({ exists: store.has(p) || isDirPath(p) }),
    unlink: (p: string) => { store.delete(p); },
    readdir: () => [],
    stat: (p: string) => ({ mode: store.has(p) ? 0o100644 : DIR }),
    isDir: (mode: number) => (mode & DIR) === DIR,
    rmdir: () => {},
  };
  return { fs: fs as unknown as EmscriptenFS, store };
}

const BOARD = `(kicad_pcb (version 20241229)
  (footprint "R" (property "Reference" "R1")
    (model "\${KICAD6_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.step" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))
    (model "\${KIPRJMOD}/models/cube.step" (hide yes) (offset (xyz 0 0 0)))
  )
  (footprint "C" (property "Reference" "C1")
    (model "\${KIPRJMOD}/models/cube.step" (offset (xyz 0 0 0)))
    (model "$(KIPRJMOD)/../../packages3D/x.step")
    (model "kicad-embed://cube.step")
    (model "models/part (1).wrl" (offset (xyz 0 0 "0")))
    (model "/abs/x.step")
  )
  (footprint "Old" (model legacy.wrl hide (at (xyz 0 0 0))))
)`;

describe('boardModelRefs', () => {
  it('reads every shown model line in order, a hidden one left out in both spellings', () => {
    expect(boardModelRefs(BOARD)).toEqual([
      '${KICAD6_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.step',
      '${KIPRJMOD}/models/cube.step',
      '$(KIPRJMOD)/../../packages3D/x.step',
      'kicad-embed://cube.step',
      'models/part (1).wrl',
      '/abs/x.step',
    ]);
  });

  it('reads nothing from a text with no model and stops at a list that never closes', () => {
    expect(boardModelRefs('(kicad_pcb (footprint "X"))')).toEqual([]);
    expect(boardModelRefs('(kicad_pcb (model "a.step") (model "b.step" (offset')).toEqual(['a.step']);
  });
});

describe('modelSource', () => {
  it('reads the model store, the project, embedded and nothing', () => {
    expect(modelSource('${KICAD6_3DMODEL_DIR}/L.3dshapes/N.step')).toEqual({ kind: 'library', ref: '${KICAD6_3DMODEL_DIR}/L.3dshapes/N.step', rel: 'L.3dshapes/N.step' });
    expect(modelSource('$(KICAD9_3DMODEL_DIR)/L.3dshapes/N.wrl')).toMatchObject({ kind: 'library', rel: 'L.3dshapes/N.wrl' });
    expect(modelSource('${KISYS3DMOD}/L.3dshapes/N.wrl')).toMatchObject({ kind: 'library', rel: 'L.3dshapes/N.wrl' });
    expect(modelSource('${KIPRJMOD}/a/./b/../c.step')).toMatchObject({ kind: 'project', rel: 'a/c.step' });
    expect(modelSource('$(KIPRJMOD)\\a\\c.step')).toMatchObject({ kind: 'project', rel: 'a/c.step' });
    expect(modelSource('lib/c.step')).toMatchObject({ kind: 'project', rel: 'lib/c.step' });
    expect(modelSource('kicad-embed://c.step').kind).toBe('embedded');
    for (const none of ['${KIPRJMOD}/../x.step', '../x.step', '/abs/x.step', 'C:\\x.step', 'https://x/y.step', '${OTHER}/x.step', '${KIPRJMOD)/x.step', '${KICAD6_3DMODEL_DIR}', '${KIPRJMOD}']) {
      expect(modelSource(none).kind, none).toBe('none');
    }
  });

  it('resolves a project path inside the project only', () => {
    expect(projectRelative('a/../b')).toBe('b');
    expect(projectRelative('a/../../b')).toBeNull();
    expect(projectRelative('./')).toBeNull();
  });
});

describe('stageModels', () => {
  const bytes = (n: number) => new Uint8Array(n).fill(7);

  it('copies each project body once to kiprjmod, asks the store for a library line, and names what it did not find', async () => {
    const { fs, store } = memfs({ '/project/models/cube.step': bytes(10), '/pcbjam/3dmodels/L.3dshapes/N.step': bytes(5) });
    const asked: string[] = [];
    const seen: Array<[number, number]> = [];
    const report = await stageModels(['${KIPRJMOD}/models/cube.step', 'models/cube.step', '${KICAD6_3DMODEL_DIR}/L.3dshapes/N.step', '${KICAD6_3DMODEL_DIR}/L.3dshapes/Gone.step', 'models/missing.step', 'kicad-embed://e.step', '/abs.step'], {
      fs, projectDir: '/project/',
      ensure: async (ref) => { asked.push(ref); return ref.endsWith('N.step') ? '/pcbjam/3dmodels/L.3dshapes/N.step' : null; },
      onFile: (done, total) => seen.push([done, total]),
    });
    expect(report).toEqual({
      staged: [`${PROJECT_MODELS}/models/cube.step`, '/pcbjam/3dmodels/L.3dshapes/N.step'],
      skipped: [],
      missing: ['${KICAD6_3DMODEL_DIR}/L.3dshapes/Gone.step', 'models/missing.step'],
      bytes: 15,
    });
    expect(store.get(`${PROJECT_MODELS}/models/cube.step`)).toEqual(bytes(10));
    expect(asked).toEqual(['${KICAD6_3DMODEL_DIR}/L.3dshapes/N.step', '${KICAD6_3DMODEL_DIR}/L.3dshapes/Gone.step']);
    expect(seen).toEqual([[1, 4], [2, 4], [3, 4], [4, 4]]);
  });

  it('leaves library lines to the engine when the island has no model store', async () => {
    const { fs } = memfs();
    const report = await stageModels(['${KICAD6_3DMODEL_DIR}/L.3dshapes/N.step'], { fs, projectDir: '/project', ensure: null });
    expect(report).toEqual({ staged: [], skipped: [], missing: [], bytes: 0 });
  });

  it('stops at the bounds and names every line past them', async () => {
    const files = Object.fromEntries([1, 2, 3, 4].map((i) => [`/p/m${i}.step`, bytes(4)]));
    const byFiles = await stageModels(['m1.step', 'm2.step', 'm3.step', 'm4.step'], { fs: memfs(files).fs, projectDir: '/p', ensure: null, limits: { files: 2, bytes: 1000 } });
    expect(byFiles.staged).toHaveLength(2);
    expect(byFiles.skipped).toEqual(['m3.step', 'm4.step']);
    const byBytes = await stageModels(['m1.step', 'm2.step', 'm3.step', 'm4.step'], { fs: memfs(files).fs, projectDir: '/p', ensure: null, limits: { files: 100, bytes: 10 } });
    expect(byBytes.staged).toHaveLength(2);
    expect(byBytes.bytes).toBe(8);
    expect(byBytes.skipped).toEqual(['m3.step', 'm4.step']);
  });

  it('answers the staged bodies of a board text for the 3D service, each path relative to the model root', async () => {
    // The 3D service stages only paths relative to its model root and skips any
    // that starts with a slash (occ_service stageModelFiles, engine run 15, fix
    // note e10-2): an absolute path put no body into the file.
    const { fs } = memfs({ '/project/models/cube.step': bytes(3), [`${MODELS_ROOT}/Resistor_SMD.3dshapes/R_0603_1608Metric.step`]: bytes(4) });
    const ensure = async (ref: string) => (ref.includes('R_0603') ? `${MODELS_ROOT}/Resistor_SMD.3dshapes/R_0603_1608Metric.step` : null);
    const { models, report } = await stageBoardModels(BOARD, { fs, projectDir: '/project', ensure });
    expect(models).toEqual([
      { path: 'Resistor_SMD.3dshapes/R_0603_1608Metric.step', bytes: bytes(4) },
      { path: 'kiprjmod/models/cube.step', bytes: bytes(3) },
    ]);
    for (const m of models) expect(m.path.startsWith('/') || m.path.split('/').includes('..')).toBe(false);
    expect(report.staged).toEqual([`${MODELS_ROOT}/Resistor_SMD.3dshapes/R_0603_1608Metric.step`, `${PROJECT_MODELS}/models/cube.step`]);
    expect(report.missing).toEqual(['models/part (1).wrl']);
  });

  it('never hands the 3D service a body staged outside the model root', () => {
    const { fs } = memfs({ '/elsewhere/x.step': bytes(2), [`${PROJECT_MODELS}/a.step`]: bytes(1) });
    expect(stagedModels({ staged: ['/elsewhere/x.step', `${PROJECT_MODELS}/a.step`, MODELS_ROOT], skipped: [], missing: [], bytes: 3 }, fs)).toEqual([{ path: 'kiprjmod/a.step', bytes: bytes(1) }]);
  });
});

describe('ensureWriting', () => {
  const bytes = (n: number) => new Uint8Array(n).fill(3);

  it('keeps a path the store wrote under the model root and refuses any other path', async () => {
    const { fs } = memfs();
    const answers: Record<string, unknown> = {
      a: `${MODELS_ROOT}/L.3dshapes/N.step`,
      b: '/elsewhere/N.step',
      c: `${MODELS_ROOT}/../etc/x`,
      d: null,
      e: 42,
    };
    const ensure = ensureWriting(async (ref) => answers[ref], fs);
    expect(await ensure('a')).toBe(`${MODELS_ROOT}/L.3dshapes/N.step`);
    for (const ref of ['b', 'c', 'd', 'e']) expect(await ensure(ref)).toBeNull();
  });

  it('writes a store file answered as its path and bytes once, under the model root, and answers where', async () => {
    const { fs, store } = memfs();
    let calls = 0;
    const ensure = ensureWriting(async (ref) => { calls++; return ref === 'x' ? { path: 'L.3dshapes/N.step', bytes: bytes(6) } : { path: '../up.step', bytes: bytes(1) }; }, fs);
    expect(await ensure('x')).toBe(`${MODELS_ROOT}/L.3dshapes/N.step`);
    expect(store.get(`${MODELS_ROOT}/L.3dshapes/N.step`)).toEqual(bytes(6));
    store.set(`${MODELS_ROOT}/L.3dshapes/N.step`, bytes(2));
    expect(await ensure('x')).toBe(`${MODELS_ROOT}/L.3dshapes/N.step`);
    expect(store.get(`${MODELS_ROOT}/L.3dshapes/N.step`)).toEqual(bytes(2));
    expect(await ensure('y')).toBeNull();
    expect(calls).toBe(3);
  });

  it('reads a throw or a malformed answer as not found, and stages the written body', async () => {
    const { fs } = memfs();
    expect(await ensureWriting(async () => { throw new Error('offline'); }, fs)('z')).toBeNull();
    expect(await ensureWriting(async () => ({ path: 'a.step', bytes: 'no' }), fs)('z')).toBeNull();
    const report = await stageModels(['${KICAD8_3DMODEL_DIR}/L.3dshapes/N.wrl'], {
      fs, projectDir: '/project', ensure: ensureWriting(async () => ({ path: 'L.3dshapes/N.step', bytes: bytes(9) }), fs),
    });
    expect(report).toEqual({ staged: [`${MODELS_ROOT}/L.3dshapes/N.step`], skipped: [], missing: [], bytes: 9 });
  });
});

describe('the 3D service loading', () => {
  afterEach(() => noteOccLoading(1, 1));
  it('reads a whole percent while loading and nothing once loaded', () => {
    expect(occLoadingPercent()).toBeNull();
    noteOccLoading(1, 3);
    expect(occLoadingPercent()).toBe(33);
    noteOccLoading(3, 3);
    expect(occLoadingPercent()).toBeNull();
    noteOccLoading(5, 0);
    expect(occLoadingPercent()).toBeNull();
  });
});
