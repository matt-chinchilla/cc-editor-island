// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// i-librows: libs.remove, paths.set and project.libs widened (vars, design
// block rows), through the responder with this unit alone. The engine here is
// this test's own module of exports over a file system stand in; the real
// engine is the e2e's (tests/e2e/lib-rows.spec.ts).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROJECT_FOLDER, startResponder } from '../responder';
import { createProjectLibs, prjmodOf, readProjectLibsArgs as readLibsArgs } from '../../src/project-libs';
import type { ExtUnit } from './contract';
import { buildRegistry, REGISTRY } from './registry';
import unit from './i-librows';

const PARENT = 'http://localhost';
const ROOT = PROJECT_FOLDER;
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));

function fakePage(search: string) {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const parent = { postMessage: vi.fn() };
  const page = {
    parent,
    top: {},
    location: { search },
    addEventListener: (t: string, h: (e: unknown) => void) => { const s = listeners.get(t) ?? new Set(); s.add(h); listeners.set(t, s); },
    removeEventListener: (t: string, h: (e: unknown) => void) => listeners.get(t)?.delete(h),
    dispatch: (t: string, e: unknown) => { for (const h of listeners.get(t) ?? []) h(e); },
  };
  return { page: page as unknown as Window & { dispatch: (t: string, e: unknown) => void }, parent };
}

/** A MEMFS stand in: files by absolute path, folders as a set. */
function fakeFs() {
  const dirs = new Set<string>(['/']);
  const files = new Map<string, Uint8Array>();
  const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';
  // Every folder above a path, as written (the project folder is not absolute under vitest: PROJECT_ROOT is the engine's global).
  const mkdirTree = (p: string) => { const parts = p.split('/'); for (let i = 1; i <= parts.length; i++) { const d = parts.slice(0, i).join('/'); if (d !== '') dirs.add(d); } };
  const FS = {
    mkdirTree,
    writeFile(p: string, data: Uint8Array | string) { mkdirTree(parentOf(p)); files.set(p, typeof data === 'string' ? new TextEncoder().encode(data) : data.slice()); },
    readFile(p: string) { const f = files.get(p); if (!f) throw new Error(`ENOENT ${p}`); return f.slice(); },
    analyzePath(p: string) { return { exists: files.has(p) || dirs.has(p) }; },
    readdir(p: string) {
      const names = new Set<string>(['.', '..']);
      for (const k of [...files.keys(), ...dirs]) if (k !== p && parentOf(k) === p) names.add(k.slice(p.length + 1));
      return [...names];
    },
    stat(p: string) { return { mode: dirs.has(p) ? 0o040755 : 0o100644 }; },
    isDir(mode: number) { return (mode & 0o170000) === 0o040000; },
  };
  return { FS, files, put: (rel: string, text: string) => FS.writeFile(`${ROOT}/${rel}`, text) };
}

const SYMS = '(kicad_symbol_lib (version 20241209) (generator "kicad_symbol_editor") (symbol "X1" (in_bom yes) (on_board yes) (property "Reference" "U" (at 0 0 0))))';
const FP = '(footprint "R_X" (version 20241229) (layer "F.Cu") (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu")))';
const SYM_TABLE = '(sym_lib_table (version 7) (lib (name "MyLib")(type "KiCad")(uri "${MYLIB}/x.kicad_sym")(options "")(descr "")) (lib (name "own")(type "KiCad")(uri "${KIPRJMOD}/own.kicad_sym")(options "")(descr "")))';
const FP_TABLE = '(fp_lib_table (version 7) (lib (name "MyLib")(type "KiCad")(uri "${MYLIB}/x.pretty")(options "")(descr "")))';
const BLOCK_TABLE = '(design_block_lib_table (version 7) (lib (name "small_blocks")(type "KiCad")(uri "${KIPRJMOD}/small_blocks.kicad_blocks")(options "")(descr "")))';

const RUN15 = () => ({ kicadLibsRemoveEntry: true, kicadPathVarsSet: true });

/**
 * A responder with this unit alone, its frame's project libraries over the
 * stand in, booted in `frame` on an engine with run 14's library exports and,
 * with `run15`, the run 15 ones; `answers` sets what a run 15 export answers.
 */
async function boot(frame: 'sch' | 'pcb' | 'symedit', opts: { run15?: boolean; thirdParty?: boolean; ready?: boolean; busyMs?: number } = {}) {
  const reg = buildRegistry(mods(unit));
  expect(reg.problems).toEqual([]);
  const { page, parent } = fakePage(`?frame=${frame}&theme=day`);
  const fs = fakeFs();
  const project = createProjectLibs({ root: ROOT, fs: () => fs.FS as never });
  const r = startResponder({ parentOrigin: PARENT, page, ext: reg, projectLibs: project });
  const ch = new MessageChannel();
  const got: Array<Record<string, unknown>> = [];
  ch.port1.onmessage = (m) => got.push(m.data);
  page.dispatch('message', { origin: PARENT, source: page.parent, data: { type: 'cc.connect', nonce: parent.postMessage.mock.calls[0][0].nonce }, ports: [ch.port2] });
  const calls: string[] = [];
  const queue = { until: 0 };
  const answers = { remove: true as unknown, paths: true as unknown };
  const busy = () => { queue.until = Date.now() + (opts.busyMs ?? 5); };
  const mod: Record<string, unknown> = {
    kicadOpenFileBusy: () => false,
    kicadCollabBusy: () => Date.now() < queue.until,
    kicadLibsAddEntry: vi.fn(async (k: string, n: string, u: string) => { calls.push(`add ${k} ${n} ${u}`); busy(); }),
    kicadLibsReload: vi.fn(async (k: string, n: string) => { calls.push(`reload ${k} ${n}`); busy(); }),
  };
  if (opts.run15 === true) {
    mod.kicadLibsRemoveEntry = vi.fn(async (k: string, n: string) => { calls.push(`remove ${k} ${n}`); busy(); return answers.remove; });
    mod.kicadPathVarsSet = vi.fn(async (json: string) => { calls.push(`paths ${json}`); busy(); return answers.paths; });
  }
  // The engine's word that kicadPathVarsSet takes KiCad's 3rd party variable (its marker).
  if (opts.thirdParty === true) mod.kicadPathVarsThirdParty = () => true;
  const dialogs: Array<Record<string, unknown>> = [];
  const win = {
    FS: fs.FS,
    Module: mod,
    wxElementRegistry: { findAll: () => [{ id: 'frame', typeName: 'SCH_EDIT_FRAME', name: 'SchematicFrame', visible: true }, ...dialogs], findByLabel: () => [] },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    dispatchEvent: () => true,
  } as unknown as ToolWindow;
  if (opts.ready !== false) r.engineReady(win, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
  await settle();
  let id = 0;
  const request = async (op: string, args?: unknown) => {
    const n = ++id;
    ch.port1.postMessage(args === undefined ? { id: n, op } : { id: n, op, args });
    for (let i = 0; i < 400 && !got.some((m) => m.id === n); i++) await settle(5);
    return got.find((m) => m.id === n);
  };
  const ready = got.find((m) => m.type === 'ev.ready') as { caps: string[] } | undefined;
  return { r, fs, project, calls, answers, dialogs, request, ready, mod };
}

const started: Array<{ r: { close: () => void } }> = [];
afterEach(() => { for (const s of started.splice(0)) s.r.close(); });
const frameOf = async (...a: Parameters<typeof boot>) => { const s = await boot(...a); started.push(s); return s; };

/** The fixture of the e2e in miniature: a library under ${MYLIB}, the design's own, a block library. */
function design(fs: ReturnType<typeof fakeFs>) {
  fs.put('sym-lib-table', SYM_TABLE);
  fs.put('fp-lib-table', FP_TABLE);
  fs.put('design-block-lib-table', BLOCK_TABLE);
  fs.put('mylib/x.kicad_sym', SYMS);
  fs.put('mylib/x.pretty/R_X.kicad_mod', FP);
  fs.put('own.kicad_sym', SYMS);
  fs.put('small_blocks.kicad_blocks/LDO.kicad_block/LDO.kicad_sch', '(kicad_sch)');
}

describe('the unit in the registry', () => {
  it('loads in this checkout with nothing broken, owning its two ops, its two caps and the project.libs widening', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect(REGISTRY.units.map((u) => u.unit)).toContain('i-librows');
    expect(REGISTRY.capNames.get('libRows')).toBe('i-librows');
    expect(REGISTRY.capNames.get('pathVars')).toBe('i-librows');
    expect(REGISTRY.capNames.get('addonPaths')).toBe('i-librows');
    expect(REGISTRY.ops.get('libs.remove')).toBeDefined();
    expect(REGISTRY.ops.get('paths.set')).toBeDefined();
    expect(REGISTRY.widen.get('project.libs')?.map((w) => w.unit)).toEqual(['i-librows']);
  });
});

describe('caps', () => {
  it('lists libRows and pathVars on an engine with run 15\'s exports, in sch and pcb frames only; neither on run 14', async () => {
    for (const frame of ['sch', 'pcb'] as const) {
      const s = await frameOf(frame, { run15: true });
      expect(s.ready?.caps).toEqual(expect.arrayContaining(['libRows', 'pathVars']));
      const old = await frameOf(frame);
      expect(old.ready?.caps).not.toContain('libRows');
      expect(old.ready?.caps).not.toContain('pathVars');
    }
    expect(unit.caps!({ kicadLibsRemoveEntry: () => true, kicadLibsAddEntry: () => 0, kicadLibsReload: () => 0, kicadCollabBusy: () => false, kicadPathVarsSet: () => true }, 'symedit')).toEqual([]);
    expect(unit.caps!({ kicadPathVarsSet: () => true, kicadCollabBusy: () => false }, 'pcb')).toEqual(['pathVars']);
  });

  it('lists addonPaths in sch and pcb frames only where the engine takes KiCad\'s 3rd party variable (its marker beside kicadPathVarsSet)', async () => {
    for (const frame of ['sch', 'pcb'] as const) {
      const s = await frameOf(frame, { run15: true, thirdParty: true });
      expect(s.ready?.caps).toEqual(expect.arrayContaining(['libRows', 'pathVars', 'addonPaths']));
      const plain = await frameOf(frame, { run15: true });
      expect(plain.ready?.caps).not.toContain('addonPaths');
    }
    const engine = { kicadPathVarsSet: () => true, kicadPathVarsThirdParty: () => true, kicadCollabBusy: () => false };
    expect(unit.caps!(engine, 'pcb')).toEqual(['pathVars', 'addonPaths']);
    expect(unit.caps!(engine, 'symedit')).toEqual([]);
    expect(unit.caps!({ kicadPathVarsThirdParty: () => true, kicadCollabBusy: () => false }, 'sch')).toEqual([]);
  });
});

describe('libs.remove', () => {
  it('takes back a row project.libs added, and a later project.libs adds it again', async () => {
    const s = await frameOf('sch', { run15: true });
    design(s.fs);
    expect(await s.request('project.libs', { libs: ['own'] })).toMatchObject({ ok: true, result: { symbol: ['own'], footprint: [], block: [] } });
    s.calls.length = 0;
    expect(await s.request('libs.remove', { kind: 'symbol', nickname: 'own' })).toMatchObject({ ok: true, result: {} });
    expect(s.calls).toEqual(['remove symbol own']);
    expect(s.project.registered('symbol', 'own')).toBeNull();
    s.calls.length = 0;
    expect(await s.request('project.libs', { libs: ['own'] })).toMatchObject({ ok: true, result: { symbol: ['own'], block: [] } });
    expect(s.calls).toEqual([`add symbol own /mnt/pcbjam/prj.sym.own`, 'reload symbol own']);
  });

  it('names a block row design_block to the engine, and forgets it', async () => {
    const s = await frameOf('pcb', { run15: true });
    design(s.fs);
    expect(await s.request('project.libs', { libs: ['small_blocks'] })).toMatchObject({ ok: true, result: { symbol: [], footprint: [], block: ['small_blocks'] } });
    expect(await s.request('libs.remove', { kind: 'block', nickname: 'small_blocks' })).toMatchObject({ ok: true });
    expect(s.calls.at(-1)).toBe('remove design_block small_blocks');
    expect(s.project.registeredBlock('small_blocks')).toBeNull();
  });

  it('not_found when the engine holds no run time row of that name (a boot row), nothing forgotten', async () => {
    const s = await frameOf('sch', { run15: true });
    design(s.fs);
    expect(await s.request('project.libs', { libs: ['own'] })).toMatchObject({ ok: true });
    s.answers.remove = false;
    expect(await s.request('libs.remove', { kind: 'symbol', nickname: 'own' })).toMatchObject({ ok: false, error: { code: 'not_found', message: 'own' } });
    expect(s.project.registered('symbol', 'own')).not.toBeNull();
  });

  it('refuses in order: the args, the engine, busy; and answers unsupported in a symedit frame', async () => {
    const early = await frameOf('sch', { run15: true, ready: false });
    expect(await early.request('libs.remove', { kind: 'symbol' })).toMatchObject({ ok: false, error: { code: 'bad_args', message: 'libs.remove' } });
    expect(await early.request('libs.remove', { kind: 'symbol', nickname: 'own' })).toMatchObject({ ok: false, error: { code: 'not_ready' } });
    const old = await frameOf('sch');
    expect(await old.request('libs.remove', { kind: 'symbol', nickname: 'own' })).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'kicadLibsRemoveEntry' } });
    const s = await frameOf('sch', { run15: true });
    for (const args of [undefined, {}, { kind: 'model', nickname: 'a' }, { kind: 'symbol', nickname: 'a:b' }, { kind: 'symbol', nickname: '' }, { kind: 'symbol', nickname: 'a', extra: 1 }, { kind: 'block', nickname: 3 }]) {
      expect(await s.request('libs.remove', args)).toMatchObject({ ok: false, error: { code: 'bad_args', message: 'libs.remove' } });
    }
    s.dialogs.push({ id: 'd', typeName: 'wxDialog', name: 'dialog', visible: true });
    expect(await s.request('libs.remove', { kind: 'symbol', nickname: 'own' })).toMatchObject({ ok: false, error: { code: 'busy', message: 'libs.remove' } });
    expect(s.calls).toEqual([]);
    const sym = await frameOf('symedit', { run15: true });
    expect(await sym.request('libs.remove', { kind: 'symbol', nickname: 'own' })).toMatchObject({ ok: false, error: { code: 'unsupported' } });
  });
});

describe('paths.set', () => {
  it('sets each variable to its folder made absolute, answers the names, and the island\'s project rows resolve them', async () => {
    const s = await frameOf('sch', { run15: true });
    design(s.fs);
    expect(await s.request('project.libs', { libs: ['MyLib'] })).toMatchObject({ ok: false, error: { code: 'not_found', message: 'MyLib' } });
    expect(await s.request('paths.set', { vars: { MYLIB: 'mylib', OTHER_2: 'a/b' } })).toMatchObject({ ok: true, result: { set: ['MYLIB', 'OTHER_2'] } });
    expect(s.calls).toEqual([`paths ${JSON.stringify({ vars: { MYLIB: `${ROOT}/mylib`, OTHER_2: `${ROOT}/a/b` } })}`]);
    expect(s.project.vars()).toEqual({ MYLIB: 'mylib', OTHER_2: 'a/b' });
    expect(await s.request('project.libs', { libs: ['MyLib'] })).toMatchObject({ ok: true, result: { symbol: ['MyLib'], footprint: ['MyLib'], block: [] } });
    expect(s.project.registered('footprint', 'MyLib')?.path).toBe('mylib/x.pretty');
  });

  it('bad_args for a built in name, a name out of KiCad\'s form, a folder out of the normal form, none or more than 64', async () => {
    const s = await frameOf('pcb', { run15: true });
    const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`V${i}`, 'a']));
    for (const vars of [undefined, {}, [], many, { KIPRJMOD: 'a' }, { KICAD10_SYMBOL_DIR: 'a' }, { KICAD9_3DMODEL_DIR: 'a' }, { KICAD9_3RD_PARTY: 'a' }, { KICAD_USER_TEMPLATE_DIR: 'a' }, { mylib: 'a' }, { '1A': 'a' }, { A: '' }, { A: '/abs' }, { A: '../up' }, { A: 'a//b' }, { A: 3 }]) {
      expect(await s.request('paths.set', vars === undefined ? {} : { vars })).toMatchObject({ ok: false, error: { code: 'bad_args', message: 'paths.set' } });
    }
    expect(await s.request('paths.set', { vars: { A: 'a' }, extra: true })).toMatchObject({ ok: false, error: { code: 'bad_args' } });
    expect(s.calls).toEqual([]);
  });

  it('refuses in order: the engine, busy; not_applied when the engine answers false, nothing set', async () => {
    const early = await frameOf('sch', { run15: true, ready: false });
    expect(await early.request('paths.set', { vars: { MYLIB: 'mylib' } })).toMatchObject({ ok: false, error: { code: 'not_ready' } });
    const old = await frameOf('pcb');
    expect(await old.request('paths.set', { vars: { MYLIB: 'mylib' } })).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'kicadPathVarsSet' } });
    const s = await frameOf('sch', { run15: true });
    s.dialogs.push({ id: 'd', typeName: 'wxDialog', name: 'dialog', visible: true });
    expect(await s.request('paths.set', { vars: { MYLIB: 'mylib' } })).toMatchObject({ ok: false, error: { code: 'busy' } });
    s.dialogs.length = 0;
    s.answers.paths = false;
    expect(await s.request('paths.set', { vars: { MYLIB: 'mylib' } })).toMatchObject({ ok: false, error: { code: 'not_applied', message: 'paths.set' } });
    expect(s.project.vars()).toEqual({});
  });
});

describe('project.libs widened', () => {
  it('answers block: [] beside the op as it shipped when no vars and no block row are named', async () => {
    const s = await frameOf('sch');
    design(s.fs);
    expect(await s.request('project.libs', { libs: ['own'] })).toEqual(expect.objectContaining({ ok: true, result: { symbol: ['own'], footprint: [], block: [] } }));
    // The op's own refusals are untouched.
    expect(await s.request('project.libs', { libs: ['own'], kind: 'symbol' })).toMatchObject({ ok: false, error: { code: 'bad_args', message: 'project.libs' } });
    expect(await s.request('project.libs', { libs: ['nothing'] })).toMatchObject({ ok: false, error: { code: 'not_found', message: 'nothing' } });
  });

  it('vars resolve ${NAME} rows into the project folder, on run 14\'s exports too (the island serves them)', async () => {
    const s = await frameOf('pcb');
    design(s.fs);
    expect(await s.request('project.libs', { libs: ['MyLib'], vars: { MYLIB: 'mylib' } })).toMatchObject({ ok: true, result: { symbol: ['MyLib'], footprint: ['MyLib'], block: [] } });
    expect(s.calls).toEqual(['add symbol MyLib /mnt/pcbjam/prj.sym.MyLib', 'reload symbol MyLib', 'add footprint MyLib /mnt/pcbjam/prj.fp.MyLib', 'reload footprint MyLib']);
    expect(s.project.vars()).toEqual({ MYLIB: 'mylib' });
  });

  it('puts the variables back when the request is refused', async () => {
    const s = await frameOf('sch');
    design(s.fs);
    expect(await s.request('project.libs', { libs: ['MyLib', 'nothing'], vars: { MYLIB: 'mylib' } })).toMatchObject({ ok: false, error: { code: 'not_found', message: 'nothing' } });
    expect(s.project.vars()).toEqual({});
    expect(await s.request('project.libs', { libs: ['MyLib'], vars: { KIPRJMOD: 'mylib' } })).toMatchObject({ ok: false, error: { code: 'bad_args', message: 'project.libs' } });
    expect(s.calls).toEqual([]);
  });

  it('adds a block row as a real folder KiCad reads, answered under block, and takes an earlier one out before adding it again', async () => {
    const s = await frameOf('sch', { run15: true, busyMs: 30 });
    design(s.fs);
    const t0 = Date.now();
    expect(await s.request('project.libs', { libs: ['small_blocks', 'own'] })).toMatchObject({ ok: true, result: { symbol: ['own'], footprint: [], block: ['small_blocks'] } });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    expect(s.calls).toEqual(['add symbol own /mnt/pcbjam/prj.sym.own', 'reload symbol own', `add design_block small_blocks ${ROOT}/small_blocks.kicad_blocks`]);
    s.calls.length = 0;
    expect(await s.request('project.libs', { libs: ['small_blocks'] })).toMatchObject({ ok: true, result: { block: ['small_blocks'] } });
    expect(s.calls).toEqual(['remove design_block small_blocks', `add design_block small_blocks ${ROOT}/small_blocks.kicad_blocks`]);
  });

  it('a block row on run 14 answers unsupported naming kicadLibsRemoveEntry, nothing added', async () => {
    const s = await frameOf('pcb');
    design(s.fs);
    expect(await s.request('project.libs', { libs: ['small_blocks', 'own'] })).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'kicadLibsRemoveEntry' } });
    expect(s.calls).toEqual([]);
  });

  it('a block row whose folder is missing names nothing; busy before any effect', async () => {
    const s = await frameOf('sch', { run15: true });
    s.fs.put('design-block-lib-table', BLOCK_TABLE);
    expect(await s.request('project.libs', { libs: ['small_blocks'] })).toMatchObject({ ok: false, error: { code: 'not_found', message: 'small_blocks' } });
    design(s.fs);
    s.dialogs.push({ id: 'd', typeName: 'wxDialog', name: 'dialog', visible: true });
    expect(await s.request('project.libs', { libs: ['small_blocks'] })).toMatchObject({ ok: false, error: { code: 'busy', message: 'project.libs' } });
    expect(s.calls).toEqual([]);
  });
});

describe('helpers', () => {
  it('reads the widened args closed', () => {
    expect(readLibsArgs({ libs: ['a', 'a'] })).toEqual({ nicks: ['a'], vars: null });
    expect(readLibsArgs({ libs: ['a'], vars: { X: 'x' } })).toEqual({ nicks: ['a'], vars: { X: 'x' } });
    for (const a of [null, {}, { libs: [] }, { libs: ['a'], vars: {} }, { libs: ['a'], vars: null }, { libs: ['a'], more: 1 }]) expect(readLibsArgs(a)).toBeNull();
  });

  it('takes ${KIPRJMOD} as the open document\'s folder, relative or under the project folder', () => {
    expect(prjmodOf(null, ROOT)).toBe('');
    expect(prjmodOf('a.kicad_sch', ROOT)).toBe('');
    expect(prjmodOf('Hardware/Main/a.kicad_pcb', ROOT)).toBe('Hardware/Main');
    expect(prjmodOf(`${ROOT}/Hardware/a.kicad_pcb`, ROOT)).toBe('Hardware');
  });
});

describe('paths.set and KiCad\'s 3rd party variable (addonPaths)', () => {
  const PKG_SYMS = SYMS.replace('"X1"', '"KiKit_Tab"');
  const ADDON_SYM_TABLE = '(sym_lib_table (version 7) (lib (name "PCM_kikit")(type "KiCad")(uri "${KICAD10_3RD_PARTY}/symbols/com_github_x_kikit/kikit.kicad_sym")(options "")(descr "")))';
  const ADDON_FP_TABLE = '(fp_lib_table (version 7) (lib (name "PCM_kikit")(type "KiCad")(uri "${KICAD10_3RD_PARTY}/footprints/com_github_x_kikit/kikit.pretty")(options "")(descr "")))';
  /** The add-on's files where the site writes them, under the design's .cc-addons, as KiCad lays out its 3rd party folder. */
  function addonDesign(fs: ReturnType<typeof fakeFs>) {
    fs.put('sym-lib-table', ADDON_SYM_TABLE);
    fs.put('fp-lib-table', ADDON_FP_TABLE);
    fs.put('.cc-addons/symbols/com_github_x_kikit/kikit.kicad_sym', PKG_SYMS);
    fs.put('.cc-addons/footprints/com_github_x_kikit/kikit.pretty/Tab.kicad_mod', FP);
  }

  it('points the variable at a folder of the project, made absolute for the engine, and the add-on\'s rows resolve there', async () => {
    const s = await frameOf('sch', { run15: true, thirdParty: true });
    addonDesign(s.fs);
    expect(await s.request('project.libs', { libs: ['PCM_kikit'] })).toMatchObject({ ok: false, error: { code: 'not_found', message: 'PCM_kikit' } });
    expect(await s.request('paths.set', { vars: { KICAD10_3RD_PARTY: '.cc-addons' } })).toMatchObject({ ok: true, result: { set: ['KICAD10_3RD_PARTY'] } });
    expect(s.calls).toEqual([`paths ${JSON.stringify({ vars: { KICAD10_3RD_PARTY: `${ROOT}/.cc-addons` } })}`]);
    expect(s.project.vars()).toEqual({ KICAD10_3RD_PARTY: '.cc-addons' });
    expect(await s.request('project.libs', { libs: ['PCM_kikit'] })).toMatchObject({ ok: true, result: { symbol: ['PCM_kikit'], footprint: ['PCM_kikit'], block: [] } });
    expect(s.project.registered('symbol', 'PCM_kikit')?.path).toBe('.cc-addons/symbols/com_github_x_kikit/kikit.kicad_sym');
    expect(s.project.registered('footprint', 'PCM_kikit')?.path).toBe('.cc-addons/footprints/com_github_x_kikit/kikit.pretty');
  });

  it('beside the host\'s own variables in one request, in a pcb frame too', async () => {
    const s = await frameOf('pcb', { run15: true, thirdParty: true });
    expect(await s.request('paths.set', { vars: { MYLIB: 'mylib', KICAD10_3RD_PARTY: 'sub/.cc-addons' } })).toMatchObject({ ok: true, result: { set: ['MYLIB', 'KICAD10_3RD_PARTY'] } });
    expect(s.project.vars()).toEqual({ MYLIB: 'mylib', KICAD10_3RD_PARTY: 'sub/.cc-addons' });
  });

  it('an engine without the marker answers unsupported naming it, after the args and the other exports; nothing is sent', async () => {
    const s = await frameOf('sch', { run15: true });
    expect(await s.request('paths.set', { vars: { KICAD10_3RD_PARTY: '.cc-addons' } })).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'kicadPathVarsThirdParty' } });
    expect(await s.request('paths.set', { vars: { MYLIB: 'mylib', KICAD10_3RD_PARTY: '.cc-addons' } })).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'kicadPathVarsThirdParty' } });
    const old = await frameOf('pcb');
    expect(await old.request('paths.set', { vars: { KICAD10_3RD_PARTY: '.cc-addons' } })).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'kicadPathVarsSet' } });
    expect(await s.request('paths.set', { vars: { KICAD10_3RD_PARTY: '../up' } })).toMatchObject({ ok: false, error: { code: 'bad_args', message: 'paths.set' } });
    expect(s.calls).toEqual([]);
    expect(old.calls).toEqual([]);
    expect(s.project.vars()).toEqual({});
  });

  it('every other name of KiCad\'s stays refused, and project.libs vars never take the 3rd party one', async () => {
    const s = await frameOf('sch', { run15: true, thirdParty: true });
    for (const vars of [{ KIPRJMOD: 'a' }, { KICAD9_3RD_PARTY: 'a' }, { KICAD10_SYMBOL_DIR: 'a' }, { KICAD10_DESIGN_BLOCK_DIR: 'a' }, { KICAD_PTEMPLATES: 'a' }]) {
      expect(await s.request('paths.set', { vars })).toMatchObject({ ok: false, error: { code: 'bad_args', message: 'paths.set' } });
    }
    addonDesign(s.fs);
    expect(await s.request('project.libs', { libs: ['PCM_kikit'], vars: { KICAD10_3RD_PARTY: '.cc-addons' } })).toMatchObject({ ok: false, error: { code: 'bad_args', message: 'project.libs' } });
    expect(s.calls).toEqual([]);
  });

  it('refuses in a symedit frame', async () => {
    const s = await frameOf('symedit', { run15: true, thirdParty: true });
    expect(await s.request('paths.set', { vars: { KICAD10_3RD_PARTY: '.cc-addons' } })).toMatchObject({ ok: false, error: { code: 'unsupported' } });
  });
});
