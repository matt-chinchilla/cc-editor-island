// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-placefile-i: place.file in a sch or pcb frame, the args read closed, the
// file copied from the project folder to a fresh /tmp/cc-stage/<n>/ and that
// folder removed after every answer, the answer once the items hang off the
// pointer (joined to place's watch), the cap placeFile and the two held rows
// feature detected, and the op unsupported naming kicadPlaceFromFile on an
// engine without it. The engine here is this test's own module of exports (at
// the protocol boundary); the real engine is the e2e's
// (tests/e2e/st/st-placefile-i.spec.ts, engine run 15).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HELD_ACTIONS } from '../held';
import { startResponder } from '../responder';
import type { ExtUnit, ResponderCtx } from './contract';
import { buildRegistry, heldActions, REGISTRY } from './registry';
import unit, {
  HELD_APPEND_BOARD, HELD_IMPORT_SHEET, isProjectPath, PLACE_FILE_CAP, PLACE_FILE_EXPORTS, PLACE_FILE_MAX_BYTES, parsePlaceFileArgs, placeFile, STAGE_ROOT,
} from './st-placefile-i';

const PARENT = 'http://localhost';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const SHEET = 'imports/sub.kicad_sch';
const BOARD = 'imports/business-card.kicad_pcb';
const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

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
  const win = {
    FS: { analyzePath: () => ({ exists: false }), mkdirTree: () => {}, readdir: () => [], readFile: () => { throw new Error('ENOENT'); } },
    Module: { kicadOpenFileBusy: () => false, ...exports },
    wxElementRegistry: { findAll: () => [{ id: 'frame', typeName: frame === 'pcb' ? 'PCB_EDIT_FRAME' : 'SCH_EDIT_FRAME', name: 'Frame', visible: true }], findByLabel: () => [] },
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
 * A ResponderCtx over a fake engine and a fake MEMFS: the project folder at
 * /project holds `project`; the run folders made and dropped are recorded;
 * `engine` plays kicadPlaceFromFile (answers true and, unless told otherwise,
 * puts fresh uuids in the selection, as KiCad's move tool selects the items).
 */
function fakeCtx(opts: {
  frame?: string;
  project?: Record<string, Uint8Array>;
  engine?: (a: Record<string, unknown>, sel: string[]) => unknown;
  selected?: string[];
  gate?: string;
  missing?: string;
  writeThrows?: boolean;
} = {}) {
  const files = new Map<string, Uint8Array>(Object.entries(opts.project ?? {}).map(([k, v]) => [`/project/${k}`, v]));
  const made: string[] = [];
  const dropped: string[] = [];
  const calls: Array<Record<string, unknown>> = [];
  const staged: Array<{ path: string; bytes: Uint8Array; atCall: boolean }> = [];
  const started: string[] = [];
  const sel = [...(opts.selected ?? [])];
  let n = 0;
  const mod: Record<string, unknown> = {
    kicadCollabGetSelection: () => JSON.stringify(sel),
    kicadPlaceFromFile: (json: string) => {
      const a = JSON.parse(json) as Record<string, unknown>;
      calls.push(a);
      for (const s of staged) if (s.path === a.path) s.atCall = files.has(s.path);
      return (opts.engine ?? ((_a, s) => { s.push(UUID_B); return true; }))(a, sel);
    },
  };
  if (opts.missing != null) delete mod[opts.missing];
  const w = { Module: mod };
  const gate = (want: string) => (_op: string, exports: readonly string[]) => {
    if (opts.gate != null) return { ok: false, code: 'busy', message: opts.gate };
    for (const name of exports) if (typeof mod[name] !== 'function') return { ok: false, code: 'unsupported', message: name };
    return { w, mod, want };
  };
  const ctx = {
    frame: opts.frame ?? 'sch',
    root: '/project',
    timing: { placeFileMs: 120, placePollMs: 5 },
    mod: () => mod,
    fs: () => ({ writeFile: (p: string, b: Uint8Array) => { if (opts.writeThrows) throw new Error('ENOSPC'); files.set(p, b); staged.push({ path: p, bytes: b, atCall: false }); } }),
    closed: () => false,
    boardGate: gate('pcb'),
    schematicGate: gate('sch'),
    freshRunFolder: (root: string) => { n += 1; const d = `${root}/${n}`; made.push(d); return d; },
    dropRunFolder: (dir: string) => { dropped.push(dir); for (const k of [...files.keys()]) if (k.startsWith(`${dir}/`)) files.delete(k); },
    readBytes: (abs: string) => files.get(abs) ?? null,
    placeStart: (uuid: string) => { started.push(uuid); },
    log: () => {},
  } as unknown as ResponderCtx;
  return { ctx, files, made, dropped, calls, staged, started, sel };
}

describe('st-placefile-i in the registry', () => {
  it('loads in this checkout with nothing broken, owning place.file, no longer a placeholder', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect(REGISTRY.ops.get('place.file')?.unit).toBe('st-placefile-i');
    expect(REGISTRY.pending.has('place.file')).toBe(false);
  });

  it('holds Import Sheet in a sch frame and Append Board in a pcb frame under placeFile, neither held by a built in row', () => {
    expect(unit.held).toEqual([HELD_IMPORT_SHEET, HELD_APPEND_BOARD]);
    expect(HELD_IMPORT_SHEET).toBe('eeschema.InteractiveDrawing.importSheet');
    expect(HELD_APPEND_BOARD).toBe('pcbnew.EditorControl.appendBoard');
    expect(unit.heldRows.map((r) => [r.action, [...r.frames], r.cap])).toEqual([
      [HELD_IMPORT_SHEET, ['sch'], PLACE_FILE_CAP],
      [HELD_APPEND_BOARD, ['pcb'], PLACE_FILE_CAP],
    ]);
    const builtin = new Set(HELD_ACTIONS.map((r) => r.action));
    for (const a of unit.held) expect(builtin.has(a)).toBe(false);
    const union = heldActions().filter((r) => unit.held.includes(r.action));
    expect(union.map((r) => r.action).sort()).toEqual([...unit.held].sort());
  });

  it('lists placeFile in a sch and a pcb frame only on an engine with every export', () => {
    const full = Object.fromEntries(PLACE_FILE_EXPORTS.map((e) => [e, () => true]));
    expect(unit.capNames).toEqual([PLACE_FILE_CAP]);
    expect(unit.caps(full, 'sch')).toEqual([PLACE_FILE_CAP]);
    expect(unit.caps(full, 'pcb')).toEqual([PLACE_FILE_CAP]);
    expect(unit.caps(full, 'symedit')).toEqual([]);
    expect(unit.caps({ kicadCollabGetSelection: () => '[]' }, 'sch')).toEqual([]);
    expect(unit.caps({ kicadPlaceFromFile: () => true }, 'pcb')).toEqual([]);
  });
});

describe('the args, read closed', () => {
  it('takes a sheet named .kicad_sch and a board named .kicad_pcb, anywhere in the project folder', () => {
    expect(parsePlaceFileArgs({ kind: 'sheet', name: SHEET })).toEqual({ kind: 'sheet', name: SHEET });
    expect(parsePlaceFileArgs({ kind: 'board', name: BOARD })).toEqual({ kind: 'board', name: BOARD });
    expect(parsePlaceFileArgs({ kind: 'sheet', name: 'top.kicad_sch' })).toEqual({ kind: 'sheet', name: 'top.kicad_sch' });
  });

  it('refuses every other shape', () => {
    for (const bad of [
      null, 'x', [], {},
      { kind: 'sheet' },
      { name: SHEET },
      { kind: 'sheet', name: SHEET, bytes: new Uint8Array([1]) },
      { kind: 'symbol', name: SHEET },
      { kind: 'sheet', name: BOARD },
      { kind: 'board', name: SHEET },
      { kind: 'sheet', name: 'imports/sub.KICAD_SCH' },
      { kind: 'sheet', name: 'imports/.kicad_sch' },
      { kind: 'sheet', name: 'imports/sub.kicad_sch.bak' },
      { kind: 'sheet', name: 7 },
    ]) expect(parsePlaceFileArgs(bad)).toBeNull();
  });

  it('a project path in its normal form: relative, no empty, "." or ".." segment, no backslash or control character', () => {
    expect(isProjectPath('a/b/c.kicad_sch')).toBe(true);
    for (const bad of ['', '/abs/x.kicad_sch', 'a//b', './a', 'a/../b', 'a/.', 'a\\b', 'a\nb', 'a\u0000b', `${'x'.repeat(256)}/a`, 'x/'.repeat(600), 7, null]) {
      expect(isProjectPath(bad)).toBe(false);
    }
  });
});

describe('place.file over the engine', () => {
  it('a sheet: copied to a fresh stage folder, the engine called exactly as it reads its args, {} once the items hang, joined to the watch, the folder removed', async () => {
    const bytes = enc('(kicad_sch (version 20250114))\n');
    const t = fakeCtx({ project: { [SHEET]: bytes }, selected: [UUID_A] });
    expect(await placeFile({ kind: 'sheet', name: SHEET }, t.ctx)).toEqual({ ok: true, result: {} });
    expect(t.made).toEqual([`${STAGE_ROOT}/1`]);
    expect(t.calls).toEqual([{ kind: 'sheet', path: `${STAGE_ROOT}/1/sub.kicad_sch` }]);
    expect(t.staged).toEqual([{ path: `${STAGE_ROOT}/1/sub.kicad_sch`, bytes, atCall: true }]);
    expect(t.started).toEqual([UUID_B]);
    expect(t.dropped).toEqual([`${STAGE_ROOT}/1`]);
    expect([...t.files.keys()]).toEqual([`/project/${SHEET}`]);
  });

  it('a board in a pcb frame, the same road', async () => {
    const t = fakeCtx({ frame: 'pcb', project: { [BOARD]: enc('(kicad_pcb)') } });
    expect(await placeFile({ kind: 'board', name: BOARD }, t.ctx)).toEqual({ ok: true, result: {} });
    expect(t.calls).toEqual([{ kind: 'board', path: `${STAGE_ROOT}/1/business-card.kicad_pcb` }]);
    expect(t.started).toEqual([UUID_B]);
    expect(t.dropped).toEqual([`${STAGE_ROOT}/1`]);
  });

  it('waits for the items: the answer comes only once the selection holds a uuid it did not hold before', async () => {
    let s: string[] = [];
    const t = fakeCtx({ project: { [SHEET]: enc('x') }, engine: (_a, sel) => { s = sel; return true; } });
    const p = placeFile({ kind: 'sheet', name: SHEET }, t.ctx);
    await settle(30);
    expect(t.started).toEqual([]);
    expect(t.dropped).toEqual([]);
    s.push(UUID_A);
    expect(await p).toEqual({ ok: true, result: {} });
    expect(t.started).toEqual([UUID_A]);
    expect(t.dropped).toEqual([`${STAGE_ROOT}/1`]);
  });

  it('not_applied when nothing reaches the pointer within the bound, the folder removed', async () => {
    const t = fakeCtx({ project: { [SHEET]: enc('x') }, engine: () => true });
    const r = await placeFile({ kind: 'sheet', name: SHEET }, t.ctx);
    expect(r).toMatchObject({ ok: false, code: 'not_applied' });
    expect(t.started).toEqual([]);
    expect(t.dropped).toEqual([`${STAGE_ROOT}/1`]);
  });

  it('busy when the engine refuses the call (it cannot take a file now), or throws; the folder removed', async () => {
    for (const engine of [() => false, () => { throw new Error('x'); }, () => 'true']) {
      const t = fakeCtx({ project: { [SHEET]: enc('x') }, engine });
      expect(await placeFile({ kind: 'sheet', name: SHEET }, t.ctx)).toEqual({ ok: false, code: 'busy', message: 'place.file: the editor cannot take a file now' });
      expect(t.dropped).toEqual([`${STAGE_ROOT}/1`]);
      expect(t.started).toEqual([]);
    }
  });

  it('not_found when the project folder holds no such file, nothing staged', async () => {
    const t = fakeCtx();
    expect(await placeFile({ kind: 'sheet', name: SHEET }, t.ctx)).toEqual({ ok: false, code: 'not_found', message: SHEET });
    expect(t.made).toEqual([]);
    expect(t.calls).toEqual([]);
  });

  it('too_large over 25 MB, nothing staged', async () => {
    const t = fakeCtx({ frame: 'pcb', project: { [BOARD]: new Uint8Array(PLACE_FILE_MAX_BYTES + 1) } });
    expect(await placeFile({ kind: 'board', name: BOARD }, t.ctx)).toEqual({ ok: false, code: 'too_large', message: `place.file: ${BOARD} is over 25 MB` });
    expect(t.made).toEqual([]);
  });

  it('bad_args before anything, and for a kind of the other frame', async () => {
    const t = fakeCtx({ project: { [SHEET]: enc('x') } });
    expect(await placeFile({ kind: 'sheet', name: SHEET, bytes: new Uint8Array([1]) }, t.ctx)).toEqual({ ok: false, code: 'bad_args', message: 'place.file' });
    expect(await placeFile({ kind: 'board', name: BOARD }, t.ctx)).toEqual({ ok: false, code: 'bad_args', message: 'place.file: a sheet places in a sch frame, a board in a pcb frame' });
    const p = fakeCtx({ frame: 'pcb' });
    expect(await placeFile({ kind: 'sheet', name: SHEET }, p.ctx)).toMatchObject({ ok: false, code: 'bad_args' });
    expect([...t.calls, ...p.calls]).toEqual([]);
  });

  it('the gate\'s refusal as it stands (busy while an item hangs or a dialog is up), nothing staged', async () => {
    const t = fakeCtx({ project: { [SHEET]: enc('x') }, gate: 'place.file' });
    expect(await placeFile({ kind: 'sheet', name: SHEET }, t.ctx)).toEqual({ ok: false, code: 'busy', message: 'place.file' });
    expect(t.made).toEqual([]);
  });

  it('unsupported naming kicadPlaceFromFile on an engine without it', async () => {
    const t = fakeCtx({ project: { [SHEET]: enc('x') }, missing: 'kicadPlaceFromFile' });
    expect(await placeFile({ kind: 'sheet', name: SHEET }, t.ctx)).toEqual({ ok: false, code: 'unsupported', message: 'kicadPlaceFromFile' });
    expect(t.made).toEqual([]);
  });

  it('island_error when the stage cannot be written, nothing called', async () => {
    const t = fakeCtx({ project: { [SHEET]: enc('x') }, writeThrows: true });
    expect(await placeFile({ kind: 'sheet', name: SHEET }, t.ctx)).toEqual({ ok: false, code: 'island_error', message: 'ENOSPC' });
    expect(t.calls).toEqual([]);
  });

  it('in another frame: unsupported with the frame refusal', async () => {
    const t = fakeCtx({ frame: 'symedit', project: { [SHEET]: enc('x') } });
    expect(await placeFile({ kind: 'sheet', name: SHEET }, t.ctx)).toEqual({ ok: false, code: 'unsupported', message: 'a file places in a sch or pcb frame' });
  });
});

describe('place.file through the responder', () => {
  it('on an engine without the export: no placeFile cap, bad_args first, then unsupported naming kicadPlaceFromFile', async () => {
    const { ready, ask } = await boot('sch', { kicadCollabBusy: () => false, kicadCollabGetSelection: () => '[]' });
    expect(ready?.caps ?? []).not.toContain(PLACE_FILE_CAP);
    expect(await ask(1, 'place.file', { kind: 'sheet', name: '../x.kicad_sch' })).toMatchObject({ id: 1, ok: false, error: { code: 'bad_args', message: 'place.file' } });
    expect(await ask(2, 'place.file', { kind: 'sheet', name: SHEET })).toMatchObject({ id: 2, ok: false, error: { code: 'unsupported', message: 'kicadPlaceFromFile' } });
  });

  it('lists placeFile in ev.ready on an engine with every export', async () => {
    const { ready } = await boot('pcb', { kicadCollabBusy: () => false, kicadCollabGetSelection: () => '[]', kicadPlaceFromFile: () => false });
    expect(ready?.caps ?? []).toContain(PLACE_FILE_CAP);
  });

  it('in another frame: unsupported with the unit\'s frame refusal', async () => {
    const { ask } = await boot('symedit', { kicadCollabBusy: () => false, kicadPlaceFromFile: () => false });
    expect(await ask(1, 'place.file', { kind: 'sheet', name: SHEET })).toMatchObject({ id: 1, ok: false, error: { code: 'unsupported', message: 'a file places in a sch or pcb frame' } });
  });
});
