// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import unit, { ensureOfStore, ExportProgress, exportHooksOf, installOcc, MODEL_STORE, OCC_SERVICE, PROGRESS_MS, renderListed, stageNote, type OccHandleView } from './3d-i3';
import { occLoadingPercent } from '../occModels';
import { buildRegistry, heldActions } from './registry';
import { HELD_ACTIONS } from '../held';
import { EXPORT_LINES } from '../export';
import TIMING from '../exportTiming.json';
import type { ExportRun, ResponderCtx } from './contract';

const jobsOf = (board: Record<string, unknown>) => ({ kicadOutputJobs: () => JSON.stringify({ board, schematic: {} }) });

describe('the unit in the registry', () => {
  const reg = buildRegistry({ './3d-i3.ts': { default: unit } });

  it('loads with no problem: pcb_render a board job, ev.export with exactly its keys, the four held rows', () => {
    expect(reg.problems).toEqual([]);
    expect(reg.exportJobs).toMatchObject({ pcb_render: 'pcb' });
    expect(reg.events.get('ev.export')).toEqual({ unit: '3d-i3', keys: ['job', 'phase', 'percent'] });
    expect(heldActions(reg)).toEqual([
      ...HELD_ACTIONS,
      { action: 'pcbnew.EditorControl.exportSTEP', frames: ['pcb'], cap: 'export' },
      { action: 'pcbnew.EditorControl.exportVRML', frames: ['pcb'], cap: 'export' },
      { action: '3DViewer.Control.exportImage', frames: ['pcb'], cap: 'heldKeys' },
      { action: '3DViewer.Control.copyToClipboard', frames: ['pcb'], cap: 'heldKeys' },
    ]);
    expect(reg.exportHooks.map((h) => h.unit)).toEqual(['3d-i3']);
  });

  it('lists render only in a pcb frame whose engine lists pcb_render', () => {
    const caps = unit.caps;
    expect(caps(jobsOf({ pcb_render: {}, pcb_export_3d: {} }), 'pcb')).toEqual(['render']);
    expect(caps(jobsOf({ pcb_render: {} }), 'sch')).toEqual([]);
    expect(caps(jobsOf({ pcb_export_3d: {} }), 'pcb')).toEqual([]);
    expect(caps({}, 'pcb')).toEqual([]);
    expect(renderListed({ kicadOutputJobs: () => 'not json' })).toBe(false);
  });

  // The units this one reads by glob (3d-i2's model store, 3d-i1's 3D service): a
  // rename in either would leave the wiring silently empty, so once a file is
  // in the island its names are asserted here.
  it('finds the model store\'s ensureModel once the model store is in the island', () => {
    for (const mod of Object.values(MODEL_STORE)) expect(typeof mod.ensureModel).toBe('function');
  });

  it('finds the 3D service\'s occService, setStage and onProgress once the 3D service is in the island', () => {
    for (const mod of Object.values(OCC_SERVICE)) expect(typeof mod.occService).toBe('function');
    const sources = import.meta.glob<string>('../../loader/src/wasm/occ-service.ts', { query: '?raw', import: 'default', eager: true });
    for (const text of Object.values(sources)) {
      expect(text).toMatch(/\bsetStage\(fn\b/);
      expect(text).toMatch(/\bonProgress\(fn\b/);
    }
  });

  it('reads the model store\'s answer as a path or as a store path and its bytes, written under the model root', async () => {
    const files = new Map<string, Uint8Array>();
    const fs = {
      analyzePath: (p: string) => ({ exists: files.has(p) }), mkdirTree: () => {},
      writeFile: (p: string, d: Uint8Array) => { files.set(p, d); },
    } as unknown as EmscriptenFS;
    expect(ensureOfStore(fs, {})).toBeNull();
    expect(ensureOfStore(fs, { './m.ts': {} })).toBeNull();
    const asPath = ensureOfStore(fs, { './m.ts': { ensureModel: async () => '/pcbjam/3dmodels/L.3dshapes/N.step' } });
    expect(await asPath!('${KICAD9_3DMODEL_DIR}/L.3dshapes/N.step')).toBe('/pcbjam/3dmodels/L.3dshapes/N.step');
    const asBytes = ensureOfStore(fs, { './m.ts': { ensureModel: async () => ({ path: 'L.3dshapes/M.step', bytes: new Uint8Array([1]) }) } });
    expect(await asBytes!('${KICAD9_3DMODEL_DIR}/L.3dshapes/M.step')).toBe('/pcbjam/3dmodels/L.3dshapes/M.step');
    expect(files.get('/pcbjam/3dmodels/L.3dshapes/M.step')).toEqual(new Uint8Array([1]));
  });
});

describe('ExportProgress', () => {
  it('sends at most every 250 ms, the latest held one by the next flush, the same event once', () => {
    let t = 0;
    const sent: Array<Record<string, unknown>> = [];
    const p = new ExportProgress('pcb_render', (e) => sent.push({ ...e, at: t }), () => t);
    p.push('loading', 10);
    t = 100; p.push('loading', 20);
    t = 200; p.push('loading', 30);
    p.flush();
    t = PROGRESS_MS; p.flush();
    t = 300; p.push('running', null);
    t = 600; p.push('running', null);
    p.push('running', 5);
    expect(sent).toEqual([
      { job: 'pcb_render', phase: 'loading', percent: 10, at: 0 },
      { job: 'pcb_render', phase: 'loading', percent: 30, at: 250 },
      { job: 'pcb_render', phase: 'running', at: 600 },
    ]);
    t = 900; p.flush();
    expect(sent.at(-1)).toEqual({ job: 'pcb_render', phase: 'running', percent: 5, at: 900 });
  });
});

/** A ctx with what the hooks read: the board's file, the caps, the module, the run's lines file; emitExt collected. */
function fakeCtx(opts: { files?: Record<string, string | Uint8Array>; caps?: string[]; mod?: Record<string, unknown> | null; opened?: string | null } = {}) {
  const files = new Map<string, Uint8Array>(Object.entries(opts.files ?? {}).map(([k, v]) => [k, typeof v === 'string' ? new TextEncoder().encode(v) : v]));
  const DIR = 0o040000;
  const fs = {
    mkdirTree: () => {}, writeFile: (p: string, d: Uint8Array) => { files.set(p, d); },
    readFile: (p: string) => { const b = files.get(p); if (b == null) throw new Error('ENOENT'); return b; },
    analyzePath: (p: string) => ({ exists: files.has(p) }), stat: (p: string) => ({ mode: files.has(p) ? 0o100644 : DIR }),
    isDir: (m: number) => (m & DIR) === DIR, readdir: () => [], unlink: () => {}, rmdir: () => {},
  } as unknown as EmscriptenFS;
  const events: Array<[string, Record<string, unknown>]> = [];
  const ctx = {
    frame: 'pcb', root: '/project',
    fs: () => fs, mod: () => opts.mod ?? null, caps: () => opts.caps ?? [], closed: () => false,
    opened: () => (opts.opened === undefined ? '/project/b.kicad_pcb' : opts.opened),
    readBytes: (p: string) => files.get(p) ?? null,
    emitExt: (type: string, payload: Record<string, unknown>) => events.push([type, payload]),
    log: () => {},
  } as unknown as ResponderCtx;
  return { ctx, files, events };
}

const run = (job: string, settings: Record<string, unknown> = {}): ExportRun => ({ job, dir: '/tmp/cc-out/7', run: 7, settings });
const BOARD = '(kicad_pcb (footprint "X" (model "${KIPRJMOD}/m/a.step") (model "${KIPRJMOD}/m/b.step") (model "${KICAD6_3DMODEL_DIR}/L.3dshapes/N.step")))';

describe('the export hooks', () => {
  it('bound each 3D job by its own time and leave the others', () => {
    const hooks = exportHooksOf({ ensure: () => null, loading: () => null, now: () => 0 });
    expect(hooks.msFor?.('pcb_render')).toBe(TIMING.pcb_render);
    expect(hooks.msFor?.('pcb_export_3d')).toBe(TIMING.pcb_export_3d);
    expect(hooks.msFor?.('pcb_export_gerbers')).toBeNull();
  });

  it('stage the board\'s bodies before a 3D run, reporting the models phase, and leave other jobs alone', async () => {
    let t = 0;
    const asked: string[] = [];
    const hooks = exportHooksOf({ ensure: () => async (ref) => { asked.push(ref); t += 300; return null; }, loading: () => null, now: () => t });
    const { ctx, files, events } = fakeCtx({ files: { '/project/b.kicad_pcb': BOARD, '/project/m/a.step': 'A', '/project/m/b.step': 'BB' } });
    expect(await hooks.before?.(run('pcb_export_gerbers'), ctx)).toBeNull();
    expect(events).toEqual([]);
    expect(await hooks.before?.(run('pcb_render', { width: 800 }), ctx)).toBeNull();
    expect(new TextDecoder().decode(files.get('/pcbjam/3dmodels/kiprjmod/m/a.step'))).toBe('A');
    expect(new TextDecoder().decode(files.get('/pcbjam/3dmodels/kiprjmod/m/b.step'))).toBe('BB');
    expect(asked).toEqual(['${KICAD6_3DMODEL_DIR}/L.3dshapes/N.step']);
    // a, b at t 0 (the second within 250 ms is held), the store's line at t 300.
    expect(events).toEqual([['ev.export', { job: 'pcb_render', phase: 'models', percent: 33 }], ['ev.export', { job: 'pcb_render', phase: 'models', percent: 100 }]]);
    hooks.after?.(run('pcb_render'), ctx);
  });

  it('send cc_occ false with every 3D export while the 3D service is not listed, and never with a render', async () => {
    const hooks = exportHooksOf({ ensure: () => null, loading: () => null, now: () => 0 });
    const mod = jobsOf({ pcb_export_3d: { format: 'step' }, pcb_render: {} });
    expect(await hooks.before?.(run('pcb_export_3d', { format: 'step' }), fakeCtx({ mod }).ctx)).toEqual({ settings: { format: 'step', cc_occ: false } });
    expect(await hooks.before?.(run('pcb_export_3d', { format: 'vrml', cc_occ: true }), fakeCtx({ mod }).ctx)).toEqual({ settings: { format: 'vrml', cc_occ: false } });
    expect(await hooks.before?.(run('pcb_export_3d', { format: 'step' }), fakeCtx({ mod, caps: ['occ'] }).ctx)).toBeNull();
    expect(await hooks.before?.(run('pcb_render'), fakeCtx({ mod }).ctx)).toBeNull();
    expect(await hooks.before?.(run('pcb_export_3d'), fakeCtx({ opened: null }).ctx)).toEqual({ settings: { cc_occ: false } });
    expect(await hooks.before?.(run('pcb_export_gerbers'), fakeCtx({ mod }).ctx)).toBeNull();
  });

  it('report loading from the 3D service and running from the render\'s lines on each tick', () => {
    let t = 0;
    let loading: number | null = 40;
    const hooks = exportHooksOf({ ensure: () => null, loading: () => loading, now: () => t });
    const { ctx, files, events } = fakeCtx();
    const r = run('pcb_render');
    hooks.tick?.(r, ctx);
    loading = null;
    files.set(`${r.dir}/${EXPORT_LINES}`, new TextEncoder().encode('Rendering 12 percent\n'));
    t = 100; hooks.tick?.(r, ctx);
    t = 250; hooks.tick?.(r, ctx);
    files.set(`${r.dir}/${EXPORT_LINES}`, new TextEncoder().encode('Rendering 12 percent\nRendering 34 percent\n'));
    t = 500; hooks.tick?.(r, ctx);
    hooks.tick?.(run('pcb_export_gerbers'), ctx);
    expect(events.map(([, e]) => e)).toEqual([
      { job: 'pcb_render', phase: 'loading', percent: 40 },
      { job: 'pcb_render', phase: 'running', percent: 12 },
      { job: 'pcb_render', phase: 'running', percent: 34 },
    ]);
    // A 3D export reads no render lines.
    const x = fakeCtx();
    x.files.set(`/tmp/cc-out/8/${EXPORT_LINES}`, new TextEncoder().encode('Rendering 50 percent'));
    hooks.tick?.({ ...run('pcb_export_3d'), dir: '/tmp/cc-out/8', run: 8 }, x.ctx);
    expect(x.events).toEqual([]);
  });
});

describe('the 3D service', () => {
  it('stages the board text its export sends, feeds the loading phase, and undoes both at the stop', async () => {
    let stage: Parameters<OccHandleView['setStage']>[0] = null;
    let listener: ((l: number, t: number) => void) | null = null;
    const handle: OccHandleView = { setStage: (fn) => { stage = fn; }, onProgress: (fn) => { listener = fn; return () => { listener = null; }; } };
    const { ctx } = fakeCtx({ files: { '/project/m/a.step': 'A' } });
    expect(installOcc({ ...ctx, frame: 'sch' } as ResponderCtx, handle, () => null)).toBeUndefined();
    const stop = installOcc(ctx, handle, () => null);
    expect(stage).not.toBeNull();
    const staged = await stage!({ board: new TextEncoder().encode(BOARD) });
    // Paths relative to the model root: the 3D service skips an absolute one (fix note e10-2).
    expect(staged).toEqual({ models: [{ path: 'kiprjmod/m/a.step', bytes: new TextEncoder().encode('A') }] });
    listener!(25, 100);
    expect(occLoadingPercent()).toBe(25);
    stop?.();
    expect(stage).toBeNull();
    expect(listener).toBeNull();
    expect(occLoadingPercent()).toBeNull();
    expect(installOcc(ctx, null, () => null)).toBeUndefined();
  });

  it('names the bodies past the bounds in the report line', () => {
    expect(stageNote({ staged: [], skipped: [], missing: ['x'], bytes: 0 })).toBeNull();
    expect(stageNote({ staged: [], skipped: ['a.step', 'b.step'], missing: [], bytes: 0 })).toBe("2 parts' bodies went past the bounds of 2,000 files and 512 MiB and are not in the file: a.step, b.step.");
  });
});
