// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// m8-i: settings.read, the cap settingsRead feature detected on the engine's
// kicadSettingsRead and kicadCollabBusy, the args and the engine's record read
// closed, the other design staged in a fresh folder under
// /tmp/cc-settings-read and removed after every answer. The engine here is
// this test's own module of exports (at the protocol boundary); the real
// engine is the e2e's (tests/e2e/settings-read.spec.ts, engine run 15).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startResponder } from '../responder';
import type { ExtUnit, ResponderCtx } from './contract';
import unit, {
  BOARD_READ_SECTIONS, BYTES_MAX, cleanMessage, fileKindOf, parseReadArgs, READ_DONE, READ_EXPORTS, READ_REPORT, READ_ROOT, READ_SECTIONS, readDone,
  readJson, readRecord, SCH_READ_SECTIONS, SETTINGS_READ_CAP, stagedFiles,
} from './m8-i';
import { buildRegistry, REGISTRY } from './registry';

const PARENT = 'http://localhost';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));
const enc = (v: unknown): Uint8Array => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v));
const RUN15 = { kicadSettingsRead: () => false, kicadCollabBusy: () => false };
const PRO = { name: 'settings-from.kicad_pro', bytes: enc('{}') };
const PCB = { name: 'settings-from.kicad_pcb', bytes: enc('(kicad_pcb)') };
const DRU = { name: 'rules.kicad_dru', bytes: enc('(version 1)') };
const ARGS = { files: [PRO, PCB, DRU], sections: ['netClasses', 'layers', 'customRules'] };

beforeEach(() => {
  vi.stubGlobal('KeyboardEvent', class extends Event {
    constructor(type: string, init: Record<string, unknown> = {}) {
      const { bubbles, cancelable, composed, ...rest } = init as EventInit & Record<string, unknown>;
      super(type, { bubbles, cancelable, composed });
      Object.assign(this, rest);
    }
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

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

/** A responder with this unit alone, booted in `frame` on an engine with `exports` and no document open. */
async function boot(frame: string, exports: Record<string, unknown>) {
  const reg = buildRegistry(mods(unit));
  expect(reg.problems).toEqual([]);
  const { page, parent } = fakePage(`?frame=${frame}&theme=day`);
  const r = startResponder({ parentOrigin: PARENT, page, ext: reg });
  const ch = new MessageChannel();
  const got: Array<Record<string, unknown>> = [];
  ch.port1.onmessage = (m) => got.push(m.data);
  page.dispatch('message', { origin: PARENT, source: page.parent, data: { type: 'cc.connect', nonce: parent.postMessage.mock.calls[0][0].nonce }, ports: [ch.port2] });
  const typeName = frame === 'pcb' ? 'PCB_EDIT_FRAME' : frame === 'symedit' ? 'SYMBOL_EDIT_FRAME' : 'SCH_EDIT_FRAME';
  const win = {
    FS: { analyzePath: () => ({ exists: false }), mkdirTree: () => {}, readdir: () => [], readFile: () => { throw new Error('ENOENT'); } },
    Module: { kicadOpenFileBusy: () => false, ...exports },
    wxElementRegistry: { findAll: () => [{ id: 'frame', typeName, name: 'Frame', visible: true }], findByLabel: () => [] },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    dispatchEvent: () => true,
  } as unknown as ToolWindow;
  r.engineReady(win, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
  await settle();
  const ask = async (id: number, op: string, args?: unknown) => {
    ch.port1.postMessage(args === undefined ? { id, op } : { id, op, args });
    await settle();
    return got.find((m) => m.id === id);
  };
  return { ready: got.find((m) => m.type === 'ev.ready') as { caps: string[] } | undefined, ask };
}

/**
 * A ResponderCtx over a fake engine and a fake MEMFS in `frame`: `engine`
 * plays kicadSettingsRead (its records written into the run folder it is
 * given, from the files staged there).
 */
function fakeCtx(opts: { frame?: 'sch' | 'pcb'; engine?: (a: Record<string, unknown>, files: Map<string, Uint8Array>) => unknown; gate?: string; noFs?: boolean } = {}) {
  const files = new Map<string, Uint8Array>();
  const made: string[] = [];
  const dropped: string[] = [];
  const calls: Array<Record<string, unknown>> = [];
  const gates: string[] = [];
  const staged: string[][] = [];
  let n = 0;
  const mod: Record<string, unknown> = {
    ...RUN15,
    kicadSettingsRead: (json: string) => {
      const a = JSON.parse(json) as Record<string, unknown>;
      calls.push(a);
      staged.push([...files.keys()].filter((k) => k.startsWith(`${a.dir as string}/`)).sort());
      return (opts.engine ?? (() => false))(a, files);
    },
  };
  const w = { Module: mod };
  const gate = (name: string) => (_op: string, exports: readonly string[]) => {
    gates.push(name);
    if (opts.gate != null) return { ok: false, code: 'busy', message: opts.gate };
    for (const e of exports) if (typeof mod[e] !== 'function') return { ok: false, code: 'unsupported', message: e };
    return { w, mod };
  };
  const fs = { writeFile: (p: string, b: Uint8Array) => { files.set(p, b); } };
  const ctx = {
    frame: opts.frame ?? 'pcb',
    root: '/project',
    timing: { settingsReadMs: 200, applyPollMs: 5 },
    mod: () => mod,
    fs: () => (opts.noFs ? null : fs),
    closed: () => false,
    boardGate: gate('board'),
    schematicGate: gate('schematic'),
    freshRunFolder: (root: string) => { n += 1; const d = `${root}/${n}`; made.push(d); return d; },
    dropRunFolder: (dir: string) => { dropped.push(dir); for (const k of [...files.keys()]) if (k.startsWith(`${dir}/`)) files.delete(k); },
    readBytes: (abs: string) => files.get(abs) ?? null,
    queuedRun: async (op: string, _dir: string, ms: number, call: () => unknown, record: () => unknown) => {
      if (call() !== true) return { ok: false, code: 'not_applied', message: op };
      const deadline = Date.now() + ms;
      for (;;) {
        const done = record();
        if (done != null) return { done };
        if (Date.now() >= deadline) return { ok: false, code: 'not_applied', message: op };
        await settle(5);
      }
    },
    log: () => {},
  } as unknown as ResponderCtx;
  return { ctx, files, made, dropped, calls, gates, staged };
}

/** An engine that reads as kicadSettingsRead does: settings-read.json, then the done marker last. */
const reading = (sections: Record<string, unknown>, missing: string[]) => (a: Record<string, unknown>, files: Map<string, Uint8Array>) => {
  files.set(`${a.dir as string}/${READ_REPORT}`, enc({ sections, missing }));
  files.set(`${a.dir as string}/${READ_DONE}`, enc({ error: '', message: '' }));
  return true;
};
const runRead = (ctx: ResponderCtx, args: unknown) => unit.ops['settings.read'].run(args, ctx);

describe('m8-i in the registry', () => {
  it('loads in this checkout with nothing broken, owning settings.read and the cap settingsRead', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect(REGISTRY.ops.get('settings.read')?.unit).toBe('m8-i');
    expect(REGISTRY.pending.has('settings.read')).toBe(false);
    expect(REGISTRY.capNames.get(SETTINGS_READ_CAP)).toBe('m8-i');
    expect(SETTINGS_READ_CAP).toBe('settingsRead');
    expect('passesCheck' in unit.ops['settings.read']).toBe(false);
  });

  it('lists settingsRead in a sch or pcb frame only on an engine with both exports; nothing on run 14 or in another frame', () => {
    expect([...READ_EXPORTS]).toEqual(['kicadSettingsRead', 'kicadCollabBusy']);
    expect(unit.caps(RUN15, 'sch')).toEqual(['settingsRead']);
    expect(unit.caps(RUN15, 'pcb')).toEqual(['settingsRead']);
    for (const f of ['symedit', 'fpedit', 'ds']) expect(unit.caps(RUN15, f as never)).toEqual([]);
    expect(unit.caps({ kicadCollabBusy: () => false }, 'pcb')).toEqual([]);
    expect(unit.caps({ kicadSettingsRead: () => false }, 'sch')).toEqual([]);
  });

  it('run 14: the cap is not listed and the op answers unsupported naming kicadSettingsRead; bad args first', async () => {
    for (const frame of ['sch', 'pcb']) {
      const s = await boot(frame, { kicadCollabBusy: () => false });
      expect(s.ready?.caps).not.toContain('settingsRead');
      expect(await s.ask(1, 'settings.read', ARGS)).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'kicadSettingsRead' } });
      expect(await s.ask(2, 'settings.read', { files: [PCB], sections: ['layers'] })).toMatchObject({ ok: false, error: { code: 'bad_args', message: 'settings.read' } });
    }
  });

  it('run 15: the cap listed, not_ready with no document open; a symedit frame refuses the op', async () => {
    for (const frame of ['sch', 'pcb']) {
      const s = await boot(frame, RUN15);
      expect(s.ready?.caps).toContain('settingsRead');
      expect(await s.ask(1, 'settings.read', ARGS)).toMatchObject({ ok: false, error: { code: 'not_ready', message: 'settings.read' } });
    }
    const sym = await boot('symedit', RUN15);
    expect(sym.ready?.caps ?? []).not.toContain('settingsRead');
    expect(await sym.ask(1, 'settings.read', ARGS)).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'settings.read runs in a sch or pcb frame' } });
  });
});

describe('the args', () => {
  it('the sections that travel are exactly KiCad\'s Import Settings options (6.1), netClasses in both', () => {
    expect([...BOARD_READ_SECTIONS]).toEqual(['layers', 'stackup', 'finish', 'zoneHatchOffsets', 'textDefaults', 'zoneDefaults', 'boardFormatting', 'constraints',
      'predefinedSizes', 'teardrops', 'tuningPatterns', 'netClasses', 'componentClasses', 'tuningProfiles', 'customRules', 'checkSeverities']);
    expect([...SCH_READ_SECTIONS]).toEqual(['schFormatting', 'annotation', 'fieldTemplates', 'bomPresets', 'ercSeverities', 'pinMap', 'netClasses', 'busAliases',
      'textVariables']);
    expect(READ_SECTIONS).toHaveLength(24);
    for (const never of ['page', 'variants', 'router', 'origins', 'mouse', 'pcbEditing', 'schEditing', 'layerPairs']) expect(READ_SECTIONS).not.toContain(never);
  });

  it('a file name is plain with a stem and one of the three extensions', () => {
    expect(fileKindOf('a.kicad_pro')).toBe('.kicad_pro');
    expect(fileKindOf('my board.kicad_pcb')).toBe('.kicad_pcb');
    expect(fileKindOf('x.kicad_dru')).toBe('.kicad_dru');
    for (const bad of ['', '.', '..', '.kicad_pro', 'a/b.kicad_pro', '..\\b.kicad_pcb', 'a.kicad_sch', 'a.KICAD_PRO', 'a\n.kicad_pro', `${'x'.repeat(250)}.kicad_pro`, 7, null]) {
      expect(fileKindOf(bad), String(bad)).toBeNull();
    }
  });

  it('takes exactly { files, sections }: one project, at most one board and one rules file, 25 MiB together, 1 to 64 known unique sections', () => {
    const a = parseReadArgs(ARGS);
    expect(a).toEqual({ project: PRO, board: PCB, rules: DRU, sections: ['netClasses', 'layers', 'customRules'] });
    expect(parseReadArgs({ files: [PRO], sections: ['textVariables'] })).toEqual({ project: PRO, board: null, rules: null, sections: ['textVariables'] });
    const big = { name: 'b.kicad_pcb', bytes: new Uint8Array(BYTES_MAX - 1) };
    expect(parseReadArgs({ files: [{ name: 'a.kicad_pro', bytes: new Uint8Array(1) }, big], sections: ['layers'] })).not.toBeNull();
    const bad: unknown[] = [
      undefined, null, {}, { files: [PRO] }, { sections: ['layers'] }, { ...ARGS, extra: 1 },
      { files: [], sections: ['layers'] }, { files: [PCB], sections: ['layers'] }, { files: [PCB, DRU], sections: ['layers'] },
      { files: [PRO, PRO], sections: ['layers'] }, { files: [PRO, { ...PRO, name: 'other.kicad_pro' }], sections: ['layers'] },
      { files: [PRO, PCB, { ...PCB, name: 'b.kicad_pcb' }], sections: ['layers'] }, { files: [PRO, DRU, { ...DRU, name: 'b.kicad_dru' }], sections: ['layers'] },
      { files: [PRO, PCB, DRU, DRU], sections: ['layers'] }, { files: [{ ...PRO, name: '../x.kicad_pro' }], sections: ['layers'] },
      { files: [{ ...PRO, name: 'a/x.kicad_pro' }], sections: ['layers'] }, { files: [{ name: 'a.kicad_sch', bytes: enc('') }, PRO], sections: ['layers'] },
      { files: [{ ...PRO, bytes: [1, 2] }], sections: ['layers'] }, { files: [{ ...PRO, bytes: new ArrayBuffer(2) }], sections: ['layers'] },
      { files: [{ ...PRO, extra: 1 }], sections: ['layers'] }, { files: [{ name: 'a.kicad_pro', bytes: new Uint8Array(1) }, { ...big, bytes: new Uint8Array(BYTES_MAX) }], sections: ['layers'] },
      { files: [PRO], sections: [] }, { files: [PRO], sections: 'layers' }, { files: [PRO], sections: ['layers', 'layers'] }, { files: [PRO], sections: ['page'] },
      { files: [PRO], sections: ['variants'] }, { files: [PRO], sections: [1] }, { files: PRO, sections: ['layers'] },
    ];
    bad.forEach((b, i) => expect(parseReadArgs(b), `case ${i}`).toBeNull());
  });

  it('stages the rules file beside the board under the board\'s stem, and none without a board', () => {
    const a = parseReadArgs(ARGS)!;
    expect(stagedFiles(a).map((f) => f.name)).toEqual(['settings-from.kicad_pro', 'settings-from.kicad_pcb', 'settings-from.kicad_dru']);
    expect(stagedFiles(a)[2].bytes).toBe(DRU.bytes);
    expect(stagedFiles(parseReadArgs({ files: [PRO, DRU], sections: ['customRules'] })!).map((f) => f.name)).toEqual(['settings-from.kicad_pro']);
    expect(stagedFiles(parseReadArgs({ files: [PRO, PCB], sections: ['customRules'] })!).map((f) => f.name)).toEqual(['settings-from.kicad_pro', 'settings-from.kicad_pcb']);
  });

  it('the engine\'s args are closed: run, dir, project, board only when given, the sections in order', () => {
    expect(JSON.parse(readJson(3, '/tmp/cc-settings-read/3', parseReadArgs(ARGS)!))).toEqual({
      run: 3, dir: '/tmp/cc-settings-read/3', project: 'settings-from.kicad_pro', board: 'settings-from.kicad_pcb', sections: ['netClasses', 'layers', 'customRules'],
    });
    expect(JSON.parse(readJson(1, '/d', parseReadArgs({ files: [PRO], sections: ['annotation'] })!))).toEqual({ run: 1, dir: '/d', project: 'settings-from.kicad_pro', sections: ['annotation'] });
  });
});

describe('the record', () => {
  const asked = ['netClasses', 'layers', 'customRules'];
  it('is read closed: every asked section either read or missing, never both, nothing else', () => {
    const good = { sections: { netClasses: { classes: [{ name: 'HV' }] }, layers: { copperCount: 6 } }, missing: ['customRules'] };
    expect(readRecord(enc(good), asked)).toEqual(good);
    expect(readRecord(enc({ sections: { netClasses: 1, layers: [], customRules: { text: 'x' } }, missing: [] }), asked)).not.toBeNull();
    const bad: unknown[] = [
      null, '', [], { sections: {} }, { missing: [] }, { sections: {}, missing: [], extra: 1 },
      { sections: { netClasses: {} }, missing: ['layers'] },
      { sections: { netClasses: {}, layers: {}, customRules: {} }, missing: ['layers'] },
      { sections: { netClasses: {}, layers: {} }, missing: ['customRules', 'customRules'] },
      { sections: { netClasses: {}, layers: {}, page: {} }, missing: ['customRules'] },
      { sections: { netClasses: {}, layers: {} }, missing: ['page'] },
      { sections: [], missing: asked }, { sections: {}, missing: 'customRules' },
    ];
    for (const b of bad) expect(readRecord(b == null ? null : enc(b), asked), JSON.stringify(b)).toBeNull();
    expect(readRecord(enc('{'), asked)).toBeNull();
  });

  it('KiCad\'s message keeps its first line, without the run folder, at most 512 characters', () => {
    expect(cleanMessage('Failed to load /tmp/cc-settings-read/4/x.kicad_pcb\nat line 3', '/tmp/cc-settings-read/4')).toBe('Failed to load x.kicad_pcb');
    expect(cleanMessage('bad in /tmp/cc-settings-read/9/a.kicad_pcb', '/tmp/cc-settings-read/4')).toBe('bad in a.kicad_pcb');
    expect([...cleanMessage('x'.repeat(900), '/d')]).toHaveLength(512);
  });

  it('the done marker first: nothing while it is absent, a read with the record, unreadable and island_error with the message, anything else bad', () => {
    const dir = '/tmp/cc-settings-read/1';
    const rec = enc({ sections: { netClasses: {}, layers: {} }, missing: ['customRules'] });
    expect(readDone(null, rec, asked, dir)).toBeNull();
    expect(readDone(enc({ error: '', message: '' }), rec, asked, dir)).toEqual({ record: { sections: { netClasses: {}, layers: {} }, missing: ['customRules'] } });
    expect(readDone(enc({ error: 'unreadable', message: `Expecting ( in ${dir}/x.kicad_pcb` }), null, asked, dir)).toEqual({ error: 'unreadable', message: 'Expecting ( in x.kicad_pcb' });
    expect(readDone(enc({ error: 'island_error', message: 'no frame' }), null, asked, dir)).toEqual({ error: 'island_error', message: 'no frame' });
    expect(readDone(enc({ error: '', message: '' }), null, asked, dir)).toEqual({ error: 'bad' });
    expect(readDone(enc({ error: 'other', message: '' }), rec, asked, dir)).toEqual({ error: 'bad' });
    expect(readDone(enc({ error: '' }), rec, asked, dir)).toEqual({ error: 'bad' });
  });
});

describe('settings.read', () => {
  it('pcb: stages the files in a fresh folder under /tmp/cc-settings-read, reads every asked section, answers { sections, missing }, removes the folder', async () => {
    const f = fakeCtx({ engine: reading({ netClasses: { classes: [{ name: 'HV' }] }, layers: { copperCount: 6 }, customRules: { text: '(version 1)' } }, []) });
    expect(await runRead(f.ctx, ARGS)).toEqual({ ok: true, result: { sections: { netClasses: { classes: [{ name: 'HV' }] }, layers: { copperCount: 6 }, customRules: { text: '(version 1)' } }, missing: [] } });
    expect(f.gates).toEqual(['board']);
    expect(f.made).toEqual([`${READ_ROOT}/1`]);
    expect(f.calls).toEqual([{ run: 1, dir: `${READ_ROOT}/1`, project: 'settings-from.kicad_pro', board: 'settings-from.kicad_pcb', sections: ['netClasses', 'layers', 'customRules'] }]);
    expect(f.staged).toEqual([[`${READ_ROOT}/1/settings-from.kicad_dru`, `${READ_ROOT}/1/settings-from.kicad_pcb`, `${READ_ROOT}/1/settings-from.kicad_pro`]]);
    expect(f.dropped).toEqual([`${READ_ROOT}/1`]);
    expect(f.files.size).toBe(0);
  });

  it('sch: the schematic gate; a project alone goes with no board; missing comes back as the engine named it', async () => {
    const f = fakeCtx({ frame: 'sch', engine: reading({ annotation: { annotate_start_num: 100 } }, ['layers']) });
    expect(await runRead(f.ctx, { files: [PRO], sections: ['annotation', 'layers'] })).toEqual({ ok: true, result: { sections: { annotation: { annotate_start_num: 100 } }, missing: ['layers'] } });
    expect(f.gates).toEqual(['schematic']);
    expect(f.calls[0]).toEqual({ run: 1, dir: `${READ_ROOT}/1`, project: 'settings-from.kicad_pro', sections: ['annotation', 'layers'] });
    expect(f.dropped).toEqual([`${READ_ROOT}/1`]);
  });

  it('a design KiCad could not load is unreadable with KiCad\'s first line, the run folder taken out; the folder removed', async () => {
    const f = fakeCtx({
      engine: (a, files) => {
        files.set(`${a.dir as string}/${READ_REPORT}`, enc({ sections: {}, missing: [] }));
        files.set(`${a.dir as string}/${READ_DONE}`, enc({ error: 'unreadable', message: `Expecting ( in '${a.dir as string}/settings-from.kicad_pcb', line 1\nmore` }));
        return true;
      },
    });
    expect(await runRead(f.ctx, ARGS)).toEqual({ ok: false, code: 'unreadable', message: "Expecting ( in 'settings-from.kicad_pcb', line 1" });
    expect(f.dropped).toEqual([`${READ_ROOT}/1`]);
    const empty = fakeCtx({ engine: (a, files) => { files.set(`${a.dir as string}/${READ_DONE}`, enc({ error: 'unreadable', message: '' })); return true; } });
    expect(await runRead(empty.ctx, ARGS)).toEqual({ ok: false, code: 'unreadable', message: 'KiCad could not read the other design' });
  });

  it('a refused run or no record within the bound is not_applied; a throw, an island_error marker or a record of another shape island_error; the folder removed each time', async () => {
    const refused = fakeCtx();
    expect(await runRead(refused.ctx, ARGS)).toEqual({ ok: false, code: 'not_applied', message: 'settings.read' });
    expect(refused.dropped).toEqual([`${READ_ROOT}/1`]);
    const silent = fakeCtx({ engine: () => true });
    expect(await runRead(silent.ctx, ARGS)).toEqual({ ok: false, code: 'not_applied', message: 'settings.read' });
    expect(silent.dropped).toEqual([`${READ_ROOT}/1`]);
    const thrown = fakeCtx({ engine: () => { throw new Error('boom'); } });
    expect(await runRead(thrown.ctx, ARGS)).toEqual({ ok: false, code: 'island_error', message: 'boom' });
    expect(thrown.dropped).toEqual([`${READ_ROOT}/1`]);
    const marked = fakeCtx({ engine: (a, files) => { files.set(`${a.dir as string}/${READ_DONE}`, enc({ error: 'island_error', message: 'no frame' })); return true; } });
    expect(await runRead(marked.ctx, ARGS)).toEqual({ ok: false, code: 'island_error', message: 'no frame' });
    const other = fakeCtx({ engine: reading({ netClasses: {} }, []) });
    expect(await runRead(other.ctx, ARGS)).toEqual({ ok: false, code: 'island_error', message: 'the engine answered a read of another shape' });
    expect(other.dropped).toEqual([`${READ_ROOT}/1`]);
  });

  it('bad_args and the gate come before any folder; no file system is island_error', async () => {
    const f = fakeCtx();
    expect(await runRead(f.ctx, { files: [PRO, PRO], sections: ['layers'] })).toEqual({ ok: false, code: 'bad_args', message: 'settings.read' });
    expect(f.gates).toEqual([]);
    const gated = fakeCtx({ gate: 'a load is parked' });
    expect(await runRead(gated.ctx, ARGS)).toEqual({ ok: false, code: 'busy', message: 'a load is parked' });
    expect(gated.made).toEqual([]);
    const noFs = fakeCtx({ noFs: true });
    expect(await runRead(noFs.ctx, ARGS)).toEqual({ ok: false, code: 'island_error', message: 'the engine has no file system' });
    expect(noFs.made).toEqual([]);
  });
});
