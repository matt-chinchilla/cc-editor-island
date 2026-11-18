// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The model store's client: the reference grammar KiCad's NormalizeModelRef
// reads, the STEP sibling of a .wrl line, IndexedDB first, the index check,
// and the provider's model3d answer through installLibsProvider.
import { afterEach, describe, expect, it } from 'vitest';
import {
  MODELS_ROOT,
  createModelStore,
  handleModel3dRequest,
  memoryModelFileStore,
  modelsBase,
  normalizeModelRef,
  storeCandidates,
  type ModelFileStore,
} from './model-store';
import { installLibsProvider, type LibsSource } from './source';

const TAG = '10.0.4';
const R0603 = 'Resistor_SMD.3dshapes/R_0603_1608Metric.step';
const BODY = new TextEncoder().encode('ISO-10303-21;\nHEADER;\nENDSEC;\nEND-ISO-10303-21;\n');

/** The store over a fake origin: `files` by URL path, every request counted. */
function origin(files: Record<string, Uint8Array | string>) {
  const asked: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const path = decodeURIComponent(new URL(String(input), 'http://editor.localhost').pathname);
    asked.push(path);
    const f = files[path];
    if (f === undefined) return new Response(null, { status: 404 });
    return new Response((typeof f === 'string' ? new TextEncoder().encode(f) : f) as BodyInit, { status: 200 });
  }) as typeof fetch;
  return { asked, fetchImpl };
}

function memFs() {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>();
  return {
    files,
    dirs,
    mkdirTree(p: string) { dirs.add(p); },
    writeFile(p: string, d: Uint8Array | string) { files.set(p, typeof d === 'string' ? new TextEncoder().encode(d) : d); },
    analyzePath(p: string) { return { exists: files.has(p) }; },
  };
}

const index = (o: Record<string, number>) => JSON.stringify(o);
const base = `/models/${TAG}/`;
const standard = (): Record<string, Uint8Array | string> => ({
  [`${base}Resistor_SMD.3dshapes/index.json`]: index({ 'R_0603_1608Metric.step': BODY.length, 'R_0805_2012Metric.step': 3 }),
  [`${base}${R0603}`]: BODY,
  [`${base}Resistor_SMD.3dshapes/R_0805_2012Metric.step`]: new Uint8Array([1, 2]),
});

describe('normalizeModelRef: the engine\'s NormalizeModelRef', () => {
  it.each([
    ['${KICAD10_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.step', R0603],
    ['${KICAD6_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.wrl', 'Resistor_SMD.3dshapes/R_0603_1608Metric.wrl'],
    ['$(KICAD8_3DMODEL_DIR)/Resistor_SMD.3dshapes/R_0603_1608Metric.step', R0603],
    ['${KISYS3DMOD}/Resistor_SMD.3dshapes/R_0603_1608Metric.step', R0603],
    ['${KICAD9_3DMODEL_DIR}\\\\Resistor_SMD.3dshapes/R_0603_1608Metric.step', R0603],
    ['  Resistor_SMD.3dshapes/R_0603_1608Metric.step  ', R0603],
    ['${KIPRJMOD}/cube.step', null],
    ['$(KIPRJMOD)/../../packages3D/x.3dshapes/y.step', null],
    ['/usr/share/kicad/3dmodels/Resistor_SMD.3dshapes/R_0603_1608Metric.step', null],
    ['kicad-embed://R_0603_1608Metric.step', null],
    ['${KICAD10_3DMODEL_DIR', null],
    ['${KICAD10_3DMODEL_DIR}/', null],
    ['', null],
  ])('%s', (raw, want) => {
    expect(normalizeModelRef(raw)).toBe(want);
  });
});

describe('storeCandidates', () => {
  it('a STEP line is itself, a .wrl or .wrz line its STEP siblings, anything else none', () => {
    expect(storeCandidates(R0603)).toEqual([R0603]);
    expect(storeCandidates('A.3dshapes/b.STP')).toEqual(['A.3dshapes/b.STP']);
    expect(storeCandidates('A.3dshapes/b.wrl')).toEqual(['A.3dshapes/b.step', 'A.3dshapes/b.stp']);
    expect(storeCandidates('A.3dshapes/b.WRZ')).toEqual(['A.3dshapes/b.step', 'A.3dshapes/b.stp']);
    expect(storeCandidates('A.3dshapes/b.iges')).toEqual([]);
    expect(storeCandidates('b.step')).toEqual([]);
    expect(storeCandidates('A.3dshapes/sub/b.step')).toEqual([]);
    expect(storeCandidates('../A.3dshapes/b.step')).toEqual([]);
    expect(storeCandidates(null)).toEqual([]);
  });

  it('modelsBase is the tag directory on the island origin', () => {
    expect(modelsBase(TAG)).toBe('/models/10.0.4/');
  });
});

describe('createModelStore', () => {
  it('fetches the index and the file once, keeps both, and answers the bytes', async () => {
    const o = origin(standard());
    const kept = memoryModelFileStore();
    const s = createModelStore({ tag: TAG, fetchImpl: o.fetchImpl, storeFactory: async () => kept, fs: () => null });
    const got = await s.ensureModel('${KICAD10_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.step');
    expect(got?.path).toBe(R0603);
    expect([...got!.bytes]).toEqual([...BODY]);
    expect(o.asked).toEqual([`${base}Resistor_SMD.3dshapes/index.json`, `${base}${R0603}`]);
    expect([...kept.map.keys()].sort()).toEqual([`${TAG}/${R0603}`, `${TAG}/Resistor_SMD.3dshapes/index.json`]);
    await s.ensureModel(R0603);
    expect(o.asked).toHaveLength(2);
  });

  it('a later session reads IndexedDB with no request, an unknown name included', async () => {
    const kept = memoryModelFileStore();
    const first = origin(standard());
    await createModelStore({ tag: TAG, fetchImpl: first.fetchImpl, storeFactory: async () => kept, fs: () => null }).ensureModel(R0603);
    const later = origin(standard());
    const s = createModelStore({ tag: TAG, fetchImpl: later.fetchImpl, storeFactory: async () => kept, fs: () => null });
    expect((await s.ensureModel(R0603))?.path).toBe(R0603);
    expect(await s.ensureModel('Resistor_SMD.3dshapes/R_9999_Metric.step')).toBeNull();
    expect(later.asked).toEqual([]);
  });

  it('a .wrl line is answered by its STEP sibling under the STEP name', async () => {
    const o = origin(standard());
    const s = createModelStore({ tag: TAG, fetchImpl: o.fetchImpl, storeFactory: async () => null, fs: () => null });
    const got = await s.ensureModel('${KICAD6_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.wrl');
    expect(got?.path).toBe(R0603);
    expect(o.asked).not.toContain(`${base}Resistor_SMD.3dshapes/R_0603_1608Metric.wrl`);
  });

  it('answers null for a name the index lacks, a folder the store lacks, and lines that are not the store\'s, with no file request', async () => {
    const o = origin(standard());
    const s = createModelStore({ tag: TAG, fetchImpl: o.fetchImpl, storeFactory: async () => null, fs: () => null });
    expect(await s.ensureModel('Resistor_SMD.3dshapes/R_1206.step')).toBeNull();
    expect(await s.ensureModel('Nothing.3dshapes/x.step')).toBeNull();
    expect(await s.ensureModel('Nothing.3dshapes/y.step')).toBeNull();
    expect(await s.ensureModel('${KIPRJMOD}/cube.step')).toBeNull();
    expect(await s.ensureModel('Resistor_SMD.3dshapes/R_0603_1608Metric.iges')).toBeNull();
    expect(o.asked).toEqual([`${base}Resistor_SMD.3dshapes/index.json`, `${base}Nothing.3dshapes/index.json`]);
  });

  it('a file whose size is not the index\'s is a miss, never kept', async () => {
    const files = standard();
    files[`${base}${R0603}`] = new Uint8Array([9]);
    const kept = memoryModelFileStore();
    const s = createModelStore({ tag: TAG, fetchImpl: origin(files).fetchImpl, storeFactory: async () => kept, fs: () => null });
    const lines: string[] = [];
    const s2 = createModelStore({ tag: TAG, fetchImpl: origin(files).fetchImpl, storeFactory: async () => kept, fs: () => null, log: (m) => lines.push(m) });
    expect(await s.ensureModel(R0603)).toBeNull();
    expect(await s2.ensureModel(R0603)).toBeNull();
    expect(kept.map.has(`${TAG}/${R0603}`)).toBe(false);
    expect(lines.join('\n')).toContain('1 bytes, the index says');
  });

  it('a failed index read is not kept: the next ask reads it again', async () => {
    const files = standard();
    let fail = true;
    const asked: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const path = decodeURIComponent(new URL(String(input), 'http://x').pathname);
      asked.push(path);
      if (fail) return new Response(null, { status: 503 });
      return new Response(files[path] as BodyInit, { status: 200 });
    }) as typeof fetch;
    const s = createModelStore({ tag: TAG, fetchImpl, storeFactory: async () => null, fs: () => null });
    expect(await s.ensureModel(R0603)).toBeNull();
    fail = false;
    expect((await s.ensureModel(R0603))?.path).toBe(R0603);
  });

  it('an index of another shape is refused', async () => {
    const files = standard();
    files[`${base}Resistor_SMD.3dshapes/index.json`] = '{"R_0603_1608Metric.step":"many"}';
    const s = createModelStore({ tag: TAG, fetchImpl: origin(files).fetchImpl, storeFactory: async () => null, fs: () => null });
    expect(await s.ensureModel(R0603)).toBeNull();
  });

  it('concurrent asks of one model share one fetch', async () => {
    const o = origin(standard());
    const s = createModelStore({ tag: TAG, fetchImpl: o.fetchImpl, storeFactory: async () => null, fs: () => null });
    const [a, b] = await Promise.all([s.ensureModel(R0603), s.ensureModel(`\${KICAD10_3DMODEL_DIR}/${R0603}`)]);
    expect(a?.path).toBe(R0603);
    expect(b?.path).toBe(R0603);
    expect(o.asked.filter((p) => p.endsWith('.step'))).toHaveLength(1);
  });

  it('deletes the keys of another tag on its first open', async () => {
    const kept = memoryModelFileStore();
    await kept.put(`10.0.3/${R0603}`, BODY);
    await kept.put(`${TAG}/${R0603}`, BODY);
    const s = createModelStore({ tag: TAG, fetchImpl: origin({}).fetchImpl, storeFactory: async () => kept, fs: () => null });
    await s.ensureModel(R0603);
    expect([...kept.map.keys()]).toEqual([`${TAG}/${R0603}`]);
  });

  it('a store that throws is a miss, never a rejection', async () => {
    const broken: ModelFileStore = {
      get: async () => { throw new Error('gone'); },
      put: async () => false,
      keys: async () => [],
      delete: async () => undefined,
    };
    const s = createModelStore({ tag: TAG, fetchImpl: origin(standard()).fetchImpl, storeFactory: async () => broken, fs: () => null });
    await expect(s.ensureModel(R0603)).resolves.toBeNull();
  });
});

describe('ensureModelFile', () => {
  it('writes the model under the engine\'s model root and answers its absolute path', async () => {
    const fs = memFs();
    const s = createModelStore({ tag: TAG, fetchImpl: origin(standard()).fetchImpl, storeFactory: async () => null, fs: () => fs });
    const path = await s.ensureModelFile('${KICAD6_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.wrl');
    expect(path).toBe(`${MODELS_ROOT}/${R0603}`);
    expect(fs.dirs.has(`${MODELS_ROOT}/Resistor_SMD.3dshapes`)).toBe(true);
    expect([...fs.files.get(path!)!]).toEqual([...BODY]);
  });

  it('answers null with no engine file system, and for a miss', async () => {
    const s = createModelStore({ tag: TAG, fetchImpl: origin(standard()).fetchImpl, storeFactory: async () => null, fs: () => null });
    expect(await s.ensureModelFile(R0603)).toBeNull();
    const fs = memFs();
    const s2 = createModelStore({ tag: TAG, fetchImpl: origin(standard()).fetchImpl, storeFactory: async () => null, fs: () => fs });
    expect(await s2.ensureModelFile('Resistor_SMD.3dshapes/Unknown.step')).toBeNull();
    expect(fs.files.size).toBe(0);
  });
});

describe('handleModel3dRequest', () => {
  it('answers ensure only', async () => {
    const fs = memFs();
    const s = createModelStore({ tag: TAG, fetchImpl: origin(standard()).fetchImpl, storeFactory: async () => null, fs: () => fs });
    expect(await handleModel3dRequest('ensure', R0603, () => {}, s)).toBe(`${MODELS_ROOT}/${R0603}`);
    expect(await handleModel3dRequest('list', R0603, () => {}, s)).toBeNull();
    expect(await handleModel3dRequest('ensure', R0603, () => {}, null)).toBeNull();
  });
});

describe('installLibsProvider: kind model3d', () => {
  const g = globalThis as unknown as { window?: unknown };
  afterEach(() => { delete g.window; });

  it('reaches the model store before the lib id parse (the engine passes an empty lib)', async () => {
    const events: unknown[] = [];
    const fs = memFs();
    g.window = { kicadLibs: undefined, location: { search: '' }, dispatchEvent: (e: unknown) => events.push(e), FS: fs };
    const listed: string[] = [];
    const source: LibsSource = {
      async listLibs() { return []; },
      async listItems(id) { listed.push(id); return []; },
      async getItemBody() { return null; },
    };
    const lines: string[] = [];
    installLibsProvider(source, (m) => lines.push(m));
    const request = (g.window as { kicadLibs: { request: (op: string, lib: string, arg: string, kind?: string) => Promise<unknown> } }).kicadLibs.request;
    // The island's store needs the build's tag; vitest reads vite.config.ts's defines, so it is the pinned one.
    const answer = await request('ensure', '', 'Nothing_At_All.3dshapes/x.step', 'model3d');
    expect(answer).toBeNull();
    expect(listed).toEqual([]);
    expect(lines.some((l) => l.includes('[libs] request op=ensure kind=model3d arg=Nothing_At_All.3dshapes/x.step'))).toBe(true);
    expect(await request('list', '', 'x', 'model3d')).toBeNull();
  });
});
