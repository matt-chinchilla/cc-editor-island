// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// 3d-i4: board.models, board.setModels and board.embedModels, the cap
// boardModels feature detected on the engine's three exports, every check made
// before anything is written, the bodies read by the island and written into
// one fresh /tmp/cc-embed/<n>/ removed after every answer, and the held Update
// 3D model paths and Embed 3D models. The engine here is this test's own module
// of exports (at the protocol boundary); the real engine is the e2e's
// (tests/e2e/board-models.spec.ts, engine run 15).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOARD_MODELS_CAP, EMBED_ROOT, MAX_FILE_BYTES, type BoardModelsRead, type ModelLine } from '../boardModels';
import { HELD_ACTIONS, heldTaken } from '../held';
import { startResponder } from '../responder';
import type { ExtUnit, ResponderCtx } from './contract';
import { buildRegistry, heldActions, REGISTRY } from './registry';
import unit, { COLLECT_MODELS, HELD_ROWS, MIGRATE_MODELS, storeEnsure, unitOf, type StoreBody } from './3d-i4';

const PARENT = 'http://localhost';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const RUN15 = { kicadBoardModels: () => '', kicadBoardSetModels: () => false, kicadBoardEmbedModels: () => '', kicadCollabBusy: () => false };

const U = (n: number): string => `3d1a2000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const line = (path: string, extra: Partial<ModelLine> = {}): ModelLine => ({ path, offset: [0, 0, 0], rotate: [0, 0, 0], scale: [1, 1, 1], opacity: 1, show: true, ...extra });
const KIND = { smd: true, tht: false, virtual: false, notInPos: false, dnp: false };
const LIB = '${KICAD10_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.step';
const LIB_WRL = '${KICAD6_3DMODEL_DIR}/Package_SO.3dshapes/SOIC-8.wrl';

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
    wxElementRegistry: { findAll: () => [{ id: 'frame', typeName: 'PCB_EDIT_FRAME', name: 'PcbFrame', visible: true }], findByLabel: () => [] },
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

/** The board the fake engine holds: R1 a library line, U1 three project lines, one inside the board, one missing. */
function startBoard(): BoardModelsRead {
  return {
    footprints: [
      { uuid: U(100), ref: 'R1', kind: KIND, models: [{ ...line(LIB), found: 'staged' }] },
      { uuid: U(101), ref: 'R2', kind: KIND, models: [{ ...line(LIB), found: 'staged' }] },
      { uuid: U(102), ref: 'U2', kind: KIND, models: [{ ...line(LIB_WRL), found: 'staged' }] },
      { uuid: U(200), ref: 'U1', kind: KIND, models: [
        { ...line('${KIPRJMOD}/cube.step'), found: 'project' }, { ...line('${KIPRJMOD}/block.wrl'), found: 'project' },
        { ...line('kicad-embed://x.step'), found: 'embedded' }, { ...line('${KIPRJMOD}/gone.step'), found: 'missing' },
        { ...line('sub/cube.step'), found: 'project' }, { ...line('${KIPRJMOD}/only.wrl'), found: 'project' },
      ] },
    ],
    embedded: [],
  };
}

/**
 * A ResponderCtx over a fake board engine and a fake MEMFS: kicadBoardModels
 * reads `state`, kicadBoardSetModels queues the change for the next idle,
 * kicadBoardEmbedModels records its args and the files it was handed.
 */
function fakeCtx(opts: { gate?: string; setAnswer?: unknown; embedAnswer?: (a: Record<string, unknown>) => unknown; idle?: () => boolean; apply?: boolean } = {}) {
  const state = { board: startBoard() };
  const files = new Map<string, Uint8Array>([
    ['/project/cube.step', enc('ISO-10303-21; cube')],
    ['/project/block.step', enc('ISO-10303-21; block')],
    ['/project/sub/cube.step', enc('ISO-10303-21; other cube')],
    ['/project/only.step', enc('ISO-10303-21; only')],
  ]);
  const made: string[] = [];
  const dropped: string[] = [];
  const sets: string[] = [];
  const embeds: Array<{ args: Record<string, unknown>; files: Record<string, string> }> = [];
  let pending: (() => void) | null = null;
  let n = 0;
  const mod: Record<string, unknown> = {
    ...RUN15,
    kicadBoardModels: () => JSON.stringify(state.board),
    kicadBoardSetModels: (json: string) => {
      sets.push(json);
      if (opts.setAnswer !== undefined) return opts.setAnswer;
      const a = JSON.parse(json) as { items: Array<{ uuid: string; models: ModelLine[] }> };
      if (opts.apply !== false) {
        pending = () => {
          for (const it of a.items) {
            const fp = state.board.footprints.find((f) => f.uuid === it.uuid);
            if (fp != null) fp.models = it.models.map((m) => ({ ...m, found: 'project' as const }));
          }
        };
      }
      return true;
    },
    kicadBoardEmbedModels: (json: string) => {
      const a = JSON.parse(json) as Record<string, unknown>;
      const seen: Record<string, string> = {};
      for (const [k, v] of files) if (k.startsWith(`${EMBED_ROOT}/`)) seen[k] = new TextDecoder().decode(v);
      embeds.push({ args: a, files: seen });
      if (opts.embedAnswer != null) return opts.embedAnswer(a);
      const items = a.items as Array<{ file: string; alt?: string }>;
      const names = [...new Set(items.flatMap((i) => [i.file, i.alt].filter((x): x is string => x != null).map((f) => f.slice(f.lastIndexOf('/') + 1))))].sort();
      return JSON.stringify({ embedded: names.length, names, bytes: 42 });
    },
  };
  const ctx = {
    frame: 'pcb',
    root: '/project',
    timing: { boardModelsMs: 200, applyPollMs: 5 },
    mod: () => mod,
    fs: () => ({ writeFile: (p: string, b: Uint8Array) => { files.set(p, b); } }),
    opened: () => '/project/models3d-small.kicad_pcb',
    closed: () => false,
    boardGate: (_op: string, exports: readonly string[]) => {
      if (opts.gate != null) return { ok: false, code: 'busy', message: opts.gate };
      for (const name of exports) if (typeof mod[name] !== 'function') return { ok: false, code: 'unsupported', message: name };
      return { w: {}, mod };
    },
    applyIdle: async () => {
      if (!(opts.idle ?? (() => true))()) { await settle(5); return false; }
      if (pending != null) { pending(); pending = null; }
      return true;
    },
    freshRunFolder: (root: string) => { n += 1; const d = `${root}/${n}`; made.push(d); return d; },
    dropRunFolder: (dir: string) => { dropped.push(dir); for (const k of [...files.keys()]) if (k.startsWith(`${dir}/`)) files.delete(k); },
    readBytes: (abs: string) => files.get(abs) ?? null,
    log: () => {},
  } as unknown as ResponderCtx;
  return { ctx, state, files, made, dropped, sets, embeds };
}

const STORE: Record<string, StoreBody> = {
  [LIB]: { path: 'Resistor_SMD.3dshapes/R_0603_1608Metric.step', bytes: enc('ISO-10303-21; R0603') },
  [LIB_WRL]: { path: 'Package_SO.3dshapes/SOIC-8.step', bytes: enc('ISO-10303-21; SOIC-8') },
};
const withStore = (store: Record<string, StoreBody> = STORE) => unitOf({ ensure: () => async (ref: string) => store[ref] ?? null });
const run = (u: ExtUnit, op: string, args: unknown, ctx: ResponderCtx) => Promise.resolve(u.ops![op].run(args, ctx));

describe('3d-i4 in the registry', () => {
  it('loads in this checkout with nothing broken, owning the three ops and the cap boardModels', () => {
    expect(REGISTRY.problems).toEqual([]);
    for (const op of ['board.models', 'board.setModels', 'board.embedModels']) {
      expect(REGISTRY.ops.get(op)?.unit).toBe('3d-i4');
      expect(REGISTRY.pending.has(op)).toBe(false);
    }
    expect(REGISTRY.capNames.get(BOARD_MODELS_CAP)).toBe('3d-i4');
    expect(BOARD_MODELS_CAP).toBe('boardModels');
  });

  it('lists boardModels in a pcb frame on an engine with the three exports, nothing on run 14 or in a sch frame', () => {
    expect(unit.caps!(RUN15, 'pcb')).toEqual(['boardModels']);
    expect(unit.caps!(RUN15, 'sch')).toEqual([]);
    expect(unit.caps!({ kicadBoardModels: () => '', kicadBoardSetModels: () => false }, 'pcb')).toEqual([]);
    expect(unit.caps!({}, 'pcb')).toEqual([]);
  });

  it('a pcb frame on run 14 lists no boardModels and answers each op unsupported naming the export; bad args first', async () => {
    const s = await boot('pcb', { kicadCollabBusy: () => false });
    expect(s.ready?.caps).not.toContain('boardModels');
    expect(await s.ask(1, 'board.models', {})).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'kicadBoardModels' } });
    expect(await s.ask(2, 'board.setModels', { label: 'Change models', items: [{ uuid: U(1), models: [] }] })).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'kicadBoardModels' } });
    expect(await s.ask(3, 'board.embedModels', { items: [{ uuid: U(1), index: 0 }] })).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'kicadBoardModels' } });
    expect(await s.ask(4, 'board.embedModels', { items: [{ uuid: U(1), index: 64 }] })).toMatchObject({ ok: false, error: { code: 'bad_args', message: 'board.embedModels' } });
    expect(await s.ask(5, 'board.models', { x: 1 })).toMatchObject({ ok: false, error: { code: 'bad_args', message: 'board.models' } });
  });

  it('a pcb frame on run 15 lists boardModels and answers not_ready with no board open; a sch frame lists none and refuses the ops', async () => {
    const pcb = await boot('pcb', RUN15);
    expect(pcb.ready?.caps).toContain('boardModels');
    expect(await pcb.ask(1, 'board.models')).toMatchObject({ ok: false, error: { code: 'not_ready', message: 'board.models' } });
    const sch = await boot('sch', RUN15);
    expect(sch.ready?.caps).not.toContain('boardModels');
    expect(await sch.ask(1, 'board.models', {})).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'the board\'s models are read in a pcb frame' } });
  });
});

describe('the held Update 3D model paths and Embed 3D models', () => {
  const union = heldActions(buildRegistry(mods(unit)));
  it('holds exactly the two, in a pcb frame under boardModels, no built in row holding either', () => {
    expect(unit.held).toEqual([MIGRATE_MODELS, COLLECT_MODELS]);
    expect([MIGRATE_MODELS, COLLECT_MODELS]).toEqual(['pcbnew.GlobalEdit.migrate3DModels', 'pcbnew.EditorControl.collect3DModels']);
    expect(unit.heldRows!.map((r) => ({ ...r, frames: [...r.frames] }))).toEqual(HELD_ROWS.map((r) => ({ action: r.action, frames: ['pcb'], cap: 'boardModels' })));
    for (const a of [MIGRATE_MODELS, COLLECT_MODELS]) {
      expect(HELD_ACTIONS.some((h) => h.action === a)).toBe(false);
      expect(heldTaken(a, 'pcb', ['boardModels'], union)).toBe(true);
      expect(heldTaken(a, 'pcb', ['heldKeys'], union)).toBe(false);
      expect(heldTaken(a, 'sch', ['boardModels'], union)).toBe(false);
    }
  });
});

describe('board.models', () => {
  it('answers the engine\'s read; busy on ""; island_error on another shape; the gate\'s refusal as it is', async () => {
    const f = fakeCtx();
    expect(await run(unit, 'board.models', {}, f.ctx)).toEqual({ ok: true, result: { footprints: f.state.board.footprints, embedded: [] } });
    expect(unit.ops!['board.models'].passesCheck).toBe(true);
    const empty = fakeCtx();
    (empty.ctx.mod() as Record<string, unknown>).kicadBoardModels = () => '';
    expect(await run(unit, 'board.models', undefined, empty.ctx)).toMatchObject({ ok: false, code: 'busy' });
    (empty.ctx.mod() as Record<string, unknown>).kicadBoardModels = () => '{"footprints":3}';
    expect(await run(unit, 'board.models', {}, empty.ctx)).toMatchObject({ ok: false, code: 'island_error' });
    expect(await run(unit, 'board.models', {}, fakeCtx({ gate: 'board.models' }).ctx)).toEqual({ ok: false, code: 'busy', message: 'board.models' });
  });
});

describe('board.setModels', () => {
  const rename = (uuids: string[]) => ({ label: 'Update model names', items: uuids.map((u) => ({ uuid: u, models: [line(LIB.replace('KICAD10', 'KICAD9'))] })) });

  it('queues ONE request with the args as sent and answers the footprints changed once they read back', async () => {
    const f = fakeCtx();
    const args = rename([U(100), U(101)]);
    expect(await run(unit, 'board.setModels', args, f.ctx)).toEqual({ ok: true, result: { changed: 2 } });
    expect(f.sets).toEqual([JSON.stringify(args)]);
    expect(f.state.board.footprints[0].models[0].path).toBe(args.items[0].models[0].path);
  });

  it('counts only the footprints whose lines changed', async () => {
    const f = fakeCtx();
    const same = { uuid: U(100), models: [line(LIB)] };
    expect(await run(unit, 'board.setModels', { label: 'Change models', items: [same, rename([U(101)]).items[0]] }, f.ctx)).toEqual({ ok: true, result: { changed: 1 } });
  });

  it('every check before any effect: bad args, an unknown footprint (not_found), the gate, an engine busy reading', async () => {
    const f = fakeCtx();
    expect(await run(unit, 'board.setModels', { ...rename([U(100)]), label: 'Other' }, f.ctx)).toEqual({ ok: false, code: 'bad_args', message: 'board.setModels' });
    expect(await run(unit, 'board.setModels', { label: 'Change models', items: [] }, f.ctx)).toMatchObject({ code: 'bad_args' });
    expect(await run(unit, 'board.setModels', rename([U(100).toUpperCase()]), f.ctx)).toMatchObject({ code: 'bad_args' });
    expect(await run(unit, 'board.setModels', rename([U(100), U(999)]), f.ctx)).toEqual({ ok: false, code: 'not_found', message: U(999) });
    expect(await run(unit, 'board.setModels', rename([U(100)]), fakeCtx({ gate: 'board.setModels' }).ctx)).toMatchObject({ code: 'busy' });
    (f.ctx.mod() as Record<string, unknown>).kicadBoardModels = () => '';
    expect(await run(unit, 'board.setModels', rename([U(100)]), f.ctx)).toMatchObject({ code: 'busy' });
    expect(f.sets).toEqual([]);
  });

  it('not_applied when the engine refuses the list or nothing reads back in time', async () => {
    expect(await run(unit, 'board.setModels', rename([U(100)]), fakeCtx({ setAnswer: false }).ctx)).toEqual({ ok: false, code: 'not_applied', message: 'board.setModels' });
    expect(await run(unit, 'board.setModels', rename([U(100)]), fakeCtx({ apply: false }).ctx)).toMatchObject({ code: 'not_applied' });
    expect(await run(unit, 'board.setModels', rename([U(100)]), fakeCtx({ idle: () => false }).ctx)).toMatchObject({ code: 'not_applied' });
  });
});

describe('board.embedModels', () => {
  it('reads each body, writes them into one fresh /tmp/cc-embed/<n>/, hands the engine the files and removes the folder', async () => {
    const f = fakeCtx();
    const items = [{ uuid: U(100), index: 0 }, { uuid: U(101), index: 0 }, { uuid: U(102), index: 0 }, { uuid: U(200), index: 0 }, { uuid: U(200), index: 1 }, { uuid: U(200), index: 4 }, { uuid: U(200), index: 5 }];
    const got = await run(withStore(), 'board.embedModels', { items }, f.ctx);
    const dir = `${EMBED_ROOT}/1`;
    expect(f.made).toEqual([dir]);
    expect(f.embeds).toHaveLength(1);
    expect(f.embeds[0].args).toEqual({ items: [
      { uuid: U(100), index: 0, file: `${dir}/R_0603_1608Metric.step` },
      { uuid: U(101), index: 0, file: `${dir}/R_0603_1608Metric.step` },
      { uuid: U(102), index: 0, file: `${dir}/SOIC-8.step` },
      { uuid: U(200), index: 0, file: `${dir}/cube.step` },
      { uuid: U(200), index: 1, file: `${dir}/block.step` },
      { uuid: U(200), index: 4, file: `${dir}/cube-2.step` },
      { uuid: U(200), index: 5, file: `${dir}/only.step` },
    ] });
    expect(f.embeds[0].files).toEqual({
      [`${dir}/R_0603_1608Metric.step`]: 'ISO-10303-21; R0603',
      [`${dir}/SOIC-8.step`]: 'ISO-10303-21; SOIC-8',
      [`${dir}/cube.step`]: 'ISO-10303-21; cube',
      [`${dir}/block.step`]: 'ISO-10303-21; block',
      [`${dir}/cube-2.step`]: 'ISO-10303-21; other cube',
      [`${dir}/only.step`]: 'ISO-10303-21; only',
    });
    expect(got).toEqual({ ok: true, result: { embedded: 6, names: ['R_0603_1608Metric.step', 'SOIC-8.step', 'block.step', 'cube-2.step', 'cube.step', 'only.step'], bytes: 42 } });
    expect(f.dropped).toEqual([dir]);
    expect([...f.files.keys()].filter((k) => k.startsWith(EMBED_ROOT))).toEqual([]);
  });

  it('a VRML line whose own file is in the project keeps its STEP sibling as alt', async () => {
    const f = fakeCtx();
    f.files.set('/project/block.wrl', enc('#VRML V2.0 utf8'));
    await run(withStore(), 'board.embedModels', { items: [{ uuid: U(200), index: 1 }] }, f.ctx);
    expect(f.embeds[0].args).toEqual({ items: [{ uuid: U(200), index: 1, file: `${EMBED_ROOT}/1/block.wrl`, alt: `${EMBED_ROOT}/1/block.step` }] });
    expect(Object.keys(f.embeds[0].files).sort()).toEqual([`${EMBED_ROOT}/1/block.step`, `${EMBED_ROOT}/1/block.wrl`]);
  });

  it('every check before anything is written: args, an embedded or missing line by name, a body the island cannot read, the bounds', async () => {
    const f = fakeCtx();
    const u = withStore();
    expect(await run(u, 'board.embedModels', { items: [{ uuid: U(200), index: 64 }] }, f.ctx)).toEqual({ ok: false, code: 'bad_args', message: 'board.embedModels' });
    expect(await run(u, 'board.embedModels', { items: [] }, f.ctx)).toMatchObject({ code: 'bad_args' });
    expect(await run(u, 'board.embedModels', { items: [{ uuid: U(200).toUpperCase(), index: 0 }] }, f.ctx)).toMatchObject({ code: 'bad_args' });
    expect(await run(u, 'board.embedModels', { items: [{ uuid: U(100), index: 0 }, { uuid: U(200), index: 2 }] }, f.ctx)).toEqual({ ok: false, code: 'bad_args', message: 'U1 kicad-embed://x.step' });
    expect(await run(u, 'board.embedModels', { items: [{ uuid: U(200), index: 3 }] }, f.ctx)).toEqual({ ok: false, code: 'bad_args', message: 'U1 ${KIPRJMOD}/gone.step' });
    expect(await run(u, 'board.embedModels', { items: [{ uuid: U(200), index: 9 }] }, f.ctx)).toEqual({ ok: false, code: 'bad_args', message: `${U(200)} line 9` });
    expect(await run(withStore({}), 'board.embedModels', { items: [{ uuid: U(100), index: 0 }] }, f.ctx)).toEqual({ ok: false, code: 'bad_args', message: `R1 ${LIB}` });
    expect(await run(unitOf({ ensure: () => null }), 'board.embedModels', { items: [{ uuid: U(100), index: 0 }] }, f.ctx)).toEqual({ ok: false, code: 'bad_args', message: `R1 ${LIB}` });
    f.files.delete('/project/cube.step');
    expect(await run(u, 'board.embedModels', { items: [{ uuid: U(200), index: 0 }] }, f.ctx)).toEqual({ ok: false, code: 'bad_args', message: 'U1 ${KIPRJMOD}/cube.step' });
    f.files.set('/project/sub/cube.step', new Uint8Array(MAX_FILE_BYTES + 1));
    expect(await run(u, 'board.embedModels', { items: [{ uuid: U(200), index: 4 }] }, f.ctx)).toEqual({ ok: false, code: 'too_large', message: 'U1 sub/cube.step' });
    expect(await run(u, 'board.embedModels', { items: [{ uuid: U(100), index: 0 }] }, fakeCtx({ gate: 'board.embedModels' }).ctx)).toMatchObject({ code: 'busy' });
    expect(f.made).toEqual([]);
    expect(f.embeds).toEqual([]);
  });

  it('not_applied when the engine refuses ("") or its queue never empties; island_error on another answer; the folder removed every time', async () => {
    const refused = fakeCtx({ embedAnswer: () => '' });
    expect(await run(withStore(), 'board.embedModels', { items: [{ uuid: U(100), index: 0 }] }, refused.ctx)).toEqual({ ok: false, code: 'not_applied', message: 'board.embedModels' });
    expect(refused.dropped).toEqual(refused.made);
    const odd = fakeCtx({ embedAnswer: () => '{"embedded":1}' });
    expect(await run(withStore(), 'board.embedModels', { items: [{ uuid: U(100), index: 0 }] }, odd.ctx)).toMatchObject({ ok: false, code: 'island_error' });
    expect(odd.dropped).toEqual(odd.made);
    const stuck = fakeCtx({ idle: () => false });
    expect(await run(withStore(), 'board.embedModels', { items: [{ uuid: U(100), index: 0 }] }, stuck.ctx)).toMatchObject({ ok: false, code: 'not_applied' });
    expect(stuck.dropped).toEqual(stuck.made);
    expect(stuck.made).toHaveLength(1);
  });
});

describe('the model store', () => {
  it('reads the store module\'s ensureModel as { path, bytes }, null for anything else or a throw', async () => {
    const bytes = enc('x');
    const e = storeEnsure({ './m.ts': { ensureModel: async (r: string) => (r === 'a' ? { path: 'A.3dshapes/a.step', bytes } : r === 'b' ? 'nope' : r === 'c' ? Promise.reject(new Error('x')) : null) } });
    expect(await e!('a')).toEqual({ path: 'A.3dshapes/a.step', bytes });
    expect(await e!('b')).toBeNull();
    expect(await e!('c')).toBeNull();
    expect(await e!('d')).toBeNull();
    expect(storeEnsure({})).toBeNull();
    expect(storeEnsure({ './m.ts': {} })).toBeNull();
  });
});
