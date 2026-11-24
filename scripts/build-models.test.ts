// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// scripts/build-models.mjs over a fake GitLab: the arguments, the reference
// grammar (the loader's twin), the listing, the blob check, the store it
// writes (gzip twins, one index per folder, store.json, SHA256SUMS), resuming,
// the dry run's figures, and --verify.
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error a plain Node script, no declarations
import * as bm from './build-models.mjs';
import { normalizeModelRef as loaderNormalize, storeCandidates as loaderCandidates } from '../loader/src/wasm/libs/model-store';

const TAG = '10.0.4';
const COMMIT = 'a'.repeat(40);
const enc = (s: string) => new TextEncoder().encode(s);

const FILES: Record<string, Uint8Array> = {
  'Resistor_SMD.3dshapes/R_0603_1608Metric.step': enc('ISO-10303-21; R0603\n'.repeat(40)),
  'Resistor_SMD.3dshapes/R_0805_2012Metric.step': enc('ISO-10303-21; R0805\n'.repeat(30)),
  'Capacitor_SMD.3dshapes/C_0603_1608Metric.step': enc('ISO-10303-21; C0603\n'.repeat(20)),
  'LICENSE.md': enc('CC BY-SA 4.0 with the KiCad libraries exception\n'),
};
const TREE = [
  { type: 'tree', path: 'Resistor_SMD.3dshapes', id: 't1' },
  ...Object.keys(FILES).map((path) => ({ type: 'blob', path, id: bm.gitBlobId(FILES[path]) })),
  { type: 'blob', path: 'Resistor_SMD.3dshapes/R_0603_1608Metric.wrl', id: 'w' },
  { type: 'blob', path: 'README.md', id: 'r' },
];

/** A fake gitlab.com: the tag, the listing in pages of two (keyset links), and raw files; every URL asked is kept. */
function gitlab(over: { corrupt?: string; failOnce?: string } = {}) {
  const asked: string[] = [];
  let failed = false;
  const fetchImpl = async (input: string) => {
    const url = new URL(input);
    asked.push(url.pathname + url.search);
    if (url.pathname.endsWith(`/repository/tags/${TAG}`)) return Response.json({ commit: { id: COMMIT } });
    if (url.pathname.endsWith('/repository/tree')) {
      const page = Number(url.searchParams.get('page_token') ?? '0');
      const rows = TREE.slice(page * 2, page * 2 + 2);
      const next = page * 2 + 2 < TREE.length ? `<https://gitlab.com/api/v4/projects/x/repository/tree?page_token=${page + 1}>; rel="next"` : '';
      return Response.json(rows, { headers: next ? { link: next } : {} });
    }
    const raw = `/kicad/libraries/kicad-packages3D/-/raw/${COMMIT}/`;
    if (url.pathname.startsWith(raw)) {
      const path = decodeURIComponent(url.pathname.slice(raw.length));
      if (over.failOnce === path && !failed) { failed = true; return new Response(null, { status: 404 }); }
      const f = FILES[path];
      if (f == null) return new Response(null, { status: 404 });
      return new Response(over.corrupt === path ? enc('not it') : f);
    }
    return new Response(null, { status: 404 });
  };
  return { asked, fetchImpl };
}

let dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'build-models-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });
const quiet = () => { const lines: string[] = []; return { lines, log: (m: string) => lines.push(m) }; };
const deps = (g: ReturnType<typeof gitlab>, root: string, log: (m: string) => void) => ({ fetchImpl: g.fetchImpl, root, log, pinTag: TAG, concurrency: 2 });

describe('parseArgs', () => {
  it('takes a tag, --dry-run, --only lists and --out; --verify alone', () => {
    expect(bm.parseArgs(['10.0.4', '--dry-run', '--only', 'a,b', '--only', 'c'])).toMatchObject({ tag: '10.0.4', dryRun: true, only: ['a', 'b', 'c'] });
    expect(bm.parseArgs(['--verify', 'dist/models/10.0.4'])).toMatchObject({ verify: 'dist/models/10.0.4', tag: null });
    expect(() => bm.parseArgs([])).toThrow(bm.UsageError);
    expect(() => bm.parseArgs(['10.0.4', '10.0.3'])).toThrow(bm.UsageError);
    expect(() => bm.parseArgs(['../x'])).toThrow(bm.UsageError);
    expect(() => bm.parseArgs(['10.0.4', '--only'])).toThrow(bm.UsageError);
    expect(() => bm.parseArgs(['10.0.4', '--verify', 'x'])).toThrow(bm.UsageError);
    expect(() => bm.parseArgs(['10.0.4', '--force'])).toThrow(bm.UsageError);
  });
});

describe('the reference grammar is the loader\'s', () => {
  const cases = [
    '${KICAD10_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.step',
    '${KICAD6_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.wrl',
    '$(KICAD8_3DMODEL_DIR)/A.3dshapes/b.STP',
    '${KISYS3DMOD}/A.3dshapes/b.wrz',
    '${KIPRJMOD}/cube.step',
    '/abs/A.3dshapes/b.step',
    'kicad-embed://b.step',
    'A.3dshapes/sub/b.step',
    '../A.3dshapes/b.step',
    '${KICAD10_3DMODEL_DIR',
    '',
  ];
  it.each(cases)('%s', (raw) => {
    expect(bm.normalizeModelRef(raw)).toBe(loaderNormalize(raw));
    expect(bm.storeCandidates(bm.normalizeModelRef(raw))).toEqual(loaderCandidates(loaderNormalize(raw)));
  });
});

describe('the pure parts', () => {
  it('boardModelRefs reads every distinct library model line', () => {
    const text = '(footprint "R" (model "${KICAD10_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.step" (offset (xyz 0 0 0))))'
      + '(footprint "X" (model "${KIPRJMOD}/cube.step") (model "${KICAD6_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.step"))'
      + '(footprint "Q" (model "Capacitor_SMD.3dshapes/C \\"q\\".wrl"))';
    expect(bm.boardModelRefs(text)).toEqual(['Resistor_SMD.3dshapes/R_0603_1608Metric.step', 'Capacitor_SMD.3dshapes/C "q".wrl']);
  });

  it('gitBlobId is git\'s blob id', () => {
    // git hash-object of "hello\n"
    expect(bm.gitBlobId(enc('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });

  it('folderIndexes sorts folders and names', () => {
    expect(bm.folderIndexes([
      { path: 'B.3dshapes/z.step', raw: 1 }, { path: 'B.3dshapes/a.step', raw: 2 }, { path: 'A.3dshapes/m.stp', raw: 3 },
    ])).toEqual({ 'A.3dshapes': { 'm.stp': 3 }, 'B.3dshapes': { 'a.step': 2, 'z.step': 1 } });
    expect(Object.keys(bm.folderIndexes([{ path: 'B.3dshapes/z.step', raw: 1 }, { path: 'A.3dshapes/a.step', raw: 1 }]))).toEqual(['A.3dshapes', 'B.3dshapes']);
    expect(() => bm.folderIndexes([{ path: 'x.step', raw: 1 }])).toThrow();
  });

  it('resolveOnly takes store paths, model lines and boards, a .wrl by its STEP', () => {
    const set = Object.keys(FILES).filter((p) => p.endsWith('.step'));
    const board = '(model "${KICAD6_3DMODEL_DIR}/Capacitor_SMD.3dshapes/C_0603_1608Metric.wrl") (model "${KICAD6_3DMODEL_DIR}/Gone.3dshapes/x.step")';
    expect(bm.resolveOnly(['Resistor_SMD.3dshapes/R_0603_1608Metric.step', 'b.kicad_pcb', '${KIPRJMOD}/c.step'], set, () => board)).toEqual({
      picked: ['Resistor_SMD.3dshapes/R_0603_1608Metric.step', 'Capacitor_SMD.3dshapes/C_0603_1608Metric.step'],
      missing: ['Gone.3dshapes/x.step'],
      foreign: ['${KIPRJMOD}/c.step'],
    });
  });

  it('fetchRetry retries a 5xx and a 429, then answers', async () => {
    let n = 0;
    const f = async () => (++n < 3 ? new Response(null, { status: n === 1 ? 503 : 429 }) : new Response('ok'));
    const r = await bm.fetchRetry('https://x', undefined, f, [0, 0, 0]);
    expect(await r.text()).toBe('ok');
    expect(n).toBe(3);
  });
});

describe('run', () => {
  it('refuses a tag PIN.json does not pin', async () => {
    const root = tmp();
    await expect(bm.run({ tag: '9.0.0', dryRun: true, only: null, out: join(root, 'out') }, deps(gitlab(), root, () => {}))).rejects.toThrow(bm.Refusal);
  });

  it('a dry run weighs the STEP files and writes nothing but its cache', async () => {
    const root = tmp();
    const g = gitlab();
    const q = quiet();
    const out = join(root, 'out');
    const f = await bm.run({ tag: TAG, dryRun: true, only: null, out }, deps(g, root, q.log));
    const steps = Object.keys(FILES).filter((p) => p.endsWith('.step'));
    expect(f.files).toBe(3);
    expect(f.setFiles).toBe(3);
    expect(f.raw).toBe(steps.reduce((a, p) => a + FILES[p].length, 0));
    expect(f.gz).toBeGreaterThan(0);
    expect(f.gz).toBeLessThan(f.raw);
    expect(existsSync(join(out, TAG))).toBe(false);
    expect(q.lines.join('\n')).toMatch(/the set at 10\.0\.4 .*: 3 STEP files in 2 folders/);
    // a second dry run fetches nothing: the listing and the weights are remembered
    const again = gitlab();
    await bm.run({ tag: TAG, dryRun: true, only: null, out }, deps(again, root, () => {}));
    expect(again.asked).toEqual([]);
  });

  it('weighs the reference board beside the set', async () => {
    const root = tmp();
    mkdirSync(join(root, 'tests/fixtures/glasgow'), { recursive: true });
    writeFileSync(join(root, bm.REFERENCE_BOARD), '(model "${KICAD6_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.step") (model "${KICAD6_3DMODEL_DIR}/Gone.3dshapes/x.step") (model "../../packages3D/own.step")');
    const f = await bm.run({ tag: TAG, dryRun: true, only: ['Capacitor_SMD.3dshapes/C_0603_1608Metric.step'], out: join(root, 'out') }, deps(gitlab(), root, () => {}));
    expect(f.files).toBe(1);
    expect(f.reference).toMatchObject({ named: 2, files: 1, raw: FILES['Resistor_SMD.3dshapes/R_0603_1608Metric.step'].length, missing: ['Gone.3dshapes/x.step'] });
  });

  it('builds the store: gzip twins, an index per folder, the license, store.json and SHA256SUMS, then verifies it', async () => {
    const root = tmp();
    const out = join(root, 'out');
    const q = quiet();
    const f = await bm.run({ tag: TAG, dryRun: false, only: null, out }, deps(gitlab(), root, q.log));
    const dir = join(out, TAG);
    const p = 'Resistor_SMD.3dshapes/R_0603_1608Metric.step';
    expect(readFileSync(join(dir, p))).toEqual(Buffer.from(FILES[p]));
    const gz = readFileSync(join(dir, `${p}.gz`));
    expect(gunzipSync(gz)).toEqual(Buffer.from(FILES[p]));
    expect(gz.readUInt32LE(4)).toBe(0); // mtime 0
    expect(JSON.parse(gunzipSync(readFileSync(join(dir, 'Resistor_SMD.3dshapes/index.json.gz'))).toString())).toEqual({
      'R_0603_1608Metric.step': FILES[p].length,
      'R_0805_2012Metric.step': FILES['Resistor_SMD.3dshapes/R_0805_2012Metric.step'].length,
    });
    expect(existsSync(join(dir, 'Resistor_SMD.3dshapes/index.json'))).toBe(false);
    expect(readFileSync(join(dir, 'LICENSE.md'), 'utf8')).toContain('CC BY-SA');
    expect(f.store).toMatchObject({ schema: 1, tag: TAG, commit: COMMIT, full: true, files: 3 });
    expect(readFileSync(join(dir, 'SHA256SUMS'), 'utf8')).toContain(`  ${p}\n`);
    expect(q.lines.join('\n')).toContain(`verified ${dir} (tag ${TAG}): 3 STEP files, the whole set`);
    expect(bm.verifyStore(dir, () => {})).toMatchObject({ full: true });
  });

  it('an --only build is a partial store, and a later build adds to it', async () => {
    const root = tmp();
    const out = join(root, 'out');
    const one = await bm.run({ tag: TAG, dryRun: false, only: ['${KICAD6_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.wrl'], out }, deps(gitlab(), root, () => {}));
    expect(one.store).toMatchObject({ full: false, files: 1 });
    const g = gitlab();
    const two = await bm.run({ tag: TAG, dryRun: false, only: ['Capacitor_SMD.3dshapes/C_0603_1608Metric.step'], out }, deps(g, root, () => {}));
    expect(two.store).toMatchObject({ full: false, files: 2 });
    expect(g.asked.filter((u) => u.includes('/-/raw/') && u.includes('R_0603'))).toEqual([]);
  });

  it('a file whose bytes are not its listed blob is never written; the run fails and resumes', async () => {
    const root = tmp();
    const out = join(root, 'out');
    const bad = 'Capacitor_SMD.3dshapes/C_0603_1608Metric.step';
    await expect(bm.run({ tag: TAG, dryRun: false, only: null, out }, deps(gitlab({ corrupt: bad }), root, () => {}))).rejects.toThrow(/could not be fetched/);
    expect(existsSync(join(out, TAG, bad))).toBe(false);
    const g = gitlab();
    const f = await bm.run({ tag: TAG, dryRun: false, only: null, out }, deps(g, root, () => {}));
    expect(f.store.full).toBe(true);
    expect(g.asked.filter((u) => u.includes('/-/raw/') && u.endsWith('.step'))).toEqual([`/kicad/libraries/kicad-packages3D/-/raw/${COMMIT}/Capacitor_SMD.3dshapes/C_0603_1608Metric.step`]);
  });
});

describe('verifyStore', () => {
  it('refuses a store whose files no longer agree', async () => {
    const root = tmp();
    const out = join(root, 'out');
    await bm.run({ tag: TAG, dryRun: false, only: null, out }, deps(gitlab(), root, () => {}));
    const dir = join(out, TAG);
    writeFileSync(join(dir, 'Resistor_SMD.3dshapes/stray.txt'), 'x');
    expect(() => bm.verifyStore(dir, () => {})).toThrow(/stray\.txt is not a file of the store/);
    rmSync(join(dir, 'Resistor_SMD.3dshapes/stray.txt'));
    writeFileSync(join(dir, 'Resistor_SMD.3dshapes/R_0805_2012Metric.step'), 'changed');
    expect(() => bm.verifyStore(dir, () => {})).toThrow(/gz does not hold/);
  });
});

describe('shippedSums', () => {
  it('lists every file the edge serves and no raw STEP file', async () => {
    const root = tmp();
    const out = join(root, 'out');
    await bm.run({ tag: TAG, dryRun: false, only: null, out }, deps(gitlab(), root, () => {}));
    const dir = join(out, TAG);
    const all = readFileSync(join(dir, 'SHA256SUMS'), 'utf8').trim().split('\n');
    const kept = bm.shippedSums(dir);
    const paths = kept.map((l: string) => l.slice(66));
    expect(paths.some((p: string) => /\.(step|stp)$/i.test(p))).toBe(false);
    expect(paths).toEqual(expect.arrayContaining([
      'Resistor_SMD.3dshapes/R_0603_1608Metric.step.gz',
      'Resistor_SMD.3dshapes/index.json.gz',
      'LICENSE.md', 'LICENSE.md.gz', 'store.json',
    ]));
    expect(kept.length).toBe(all.length - 3);
    for (const line of kept) expect(all).toContain(line);
  });

  it('refuses a list where a STEP file has no gzip twin', async () => {
    const root = tmp();
    const out = join(root, 'out');
    await bm.run({ tag: TAG, dryRun: false, only: null, out }, deps(gitlab(), root, () => {}));
    const dir = join(out, TAG);
    const sums = readFileSync(join(dir, 'SHA256SUMS'), 'utf8').split('\n').filter((l) => !l.endsWith('R_0805_2012Metric.step.gz'));
    writeFileSync(join(dir, 'SHA256SUMS'), sums.join('\n'));
    expect(() => bm.shippedSums(dir)).toThrow(/R_0805_2012Metric\.step has no gzip twin/);
  });
});
