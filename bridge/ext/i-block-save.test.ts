// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// i-block-save: block.save in a sch or pcb frame, every arg and every engine
// answer read closed, the scopes each frame writes, the run folder under
// /tmp/cc-blocksave removed after every answer, and the op unsupported naming
// kicadDesignBlockSave on an engine without it. The engine here is this
// test's own module of exports (at the protocol boundary); the real engine
// is the e2e's (tests/e2e/blocks-save.spec.ts, engine run 15).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startResponder } from '../responder';
import type { ExtUnit, ResponderCtx } from './contract';
import { buildRegistry, REGISTRY } from './registry';
import unit, {
  BLOCK_NAME_MAX, BLOCK_SAVE_EXPORTS, BLOCK_SAVE_RECORD, BLOCK_SAVE_ROOT, blockSave, isBlockName, parseBlockSaveArgs, readBlockSaveRecord, scopesOf,
} from './i-block-save';

const PARENT = 'http://localhost';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));
const enc = (v: unknown): Uint8Array => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v));
const SHEET = '/00000000-0000-0000-0000-00005c7b59b0/00000000-0000-0000-0000-00005c9e337e/';
const SCH_TEXT = '(kicad_sch (version 20250114) (generator "eeschema"))\n';
const PCB_TEXT = '(kicad_pcb (version 20250324) (generator "pcbnew"))\n';

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
 * A ResponderCtx over a fake engine and a fake MEMFS: the run folders made and
 * dropped are recorded; `engine` plays kicadDesignBlockSave (its file and
 * record written into the run folder it is given).
 */
function fakeCtx(opts: { engine?: (a: Record<string, unknown>, files: Map<string, Uint8Array>) => unknown; idle?: () => boolean; gate?: string; frame?: string; missing?: string } = {}) {
  const files = new Map<string, Uint8Array>();
  const made: string[] = [];
  const dropped: string[] = [];
  const calls: Array<Record<string, unknown>> = [];
  let n = 0;
  const mod: Record<string, unknown> = {
    kicadCollabBusy: () => false,
    kicadDesignBlockSave: (json: string) => { const a = JSON.parse(json) as Record<string, unknown>; calls.push(a); return (opts.engine ?? (() => false))(a, files); },
  };
  if (opts.missing != null) delete mod[opts.missing];
  const gate = (want: string) => (_op: string, exports: readonly string[]) => {
    if (opts.gate != null) return { ok: false, code: 'busy', message: opts.gate };
    for (const name of exports) if (typeof mod[name] !== 'function') return { ok: false, code: 'unsupported', message: name };
    return { w: {}, mod, want };
  };
  const ctx = {
    frame: opts.frame ?? 'sch',
    root: '/project',
    timing: { blockSaveMs: 200, applyPollMs: 5 },
    mod: () => mod,
    closed: () => false,
    boardGate: gate('pcb'),
    schematicGate: gate('sch'),
    freshRunFolder: (root: string) => { n += 1; const d = `${root}/${n}`; made.push(d); return d; },
    dropRunFolder: (dir: string) => { dropped.push(dir); for (const k of [...files.keys()]) if (k.startsWith(`${dir}/`)) files.delete(k); },
    readBytes: (abs: string) => files.get(abs) ?? null,
    queuedRun: async (op: string, dir: string, ms: number, call: () => unknown, record: () => unknown) => {
      if (call() !== true) return { ok: false, code: 'not_applied', message: op };
      const deadline = Date.now() + ms;
      for (;;) {
        if ((opts.idle ?? (() => true))()) { const done = record(); if (done != null) return { done }; }
        if (Date.now() >= deadline) return { ok: false, code: 'not_applied', message: op };
        await settle(5);
      }
    },
    log: () => {},
  } as unknown as ResponderCtx;
  return { ctx, files, made, dropped, calls };
}

/** An engine that answers as kicadDesignBlockSave does: the file, then the record last. */
const engineOf = (ext: 'sch' | 'pcb', record: unknown = { code: 0, lines: [] }, text = ext === 'sch' ? SCH_TEXT : PCB_TEXT) =>
  (a: Record<string, unknown>, files: Map<string, Uint8Array>) => {
    const dir = a.dir as string;
    const name = a.name as string;
    if (isObj(record) && record.code === 0) files.set(`${dir}/${name}.kicad_block/${name}.kicad_${ext}`, enc(text));
    files.set(`${dir}/${BLOCK_SAVE_RECORD}`, enc(record));
    return true;
  };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

describe('i-block-save in the registry', () => {
  it('loads in this checkout with nothing broken, owning block.save, no longer a placeholder', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect(REGISTRY.ops.get('block.save')?.unit).toBe('i-block-save');
    expect(REGISTRY.pending.has('block.save')).toBe(false);
  });

  it('lists no cap of its own (blocks is i-block-place\'s)', () => {
    expect((unit as ExtUnit).capNames ?? []).toEqual([]);
    expect((unit as ExtUnit).caps).toBeUndefined();
  });
});

describe('the args, read closed', () => {
  it('takes each scope with a name, and sheetPath only with sheet', () => {
    expect(parseBlockSaveArgs({ scope: 'sheet', name: 'iobuf', sheetPath: SHEET })).toEqual({ scope: 'sheet', name: 'iobuf', sheetPath: SHEET });
    expect(parseBlockSaveArgs({ scope: 'sheet', name: 'root', sheetPath: '/' })).toEqual({ scope: 'sheet', name: 'root', sheetPath: '/' });
    for (const scope of ['selection', 'board', 'linkedGroup']) expect(parseBlockSaveArgs({ scope, name: 'b' })).toEqual({ scope, name: 'b' });
  });

  it('refuses every other shape', () => {
    for (const bad of [
      null, 'x', [], {},
      { scope: 'sheet', name: 'a' },
      { scope: 'sheet', name: 'a', sheetPath: 'io_buffer' },
      { scope: 'sheet', name: 'a', sheetPath: '/nope/' },
      { scope: 'sheet', name: 'a', sheetPath: 7 },
      { scope: 'selection', name: 'a', sheetPath: '/' },
      { scope: 'board', name: 'a', more: 1 },
      { scope: 'all', name: 'a' },
      { scope: 'board' },
      { name: 'a' },
      { scope: 'board', name: 7 },
    ]) expect(parseBlockSaveArgs(bad)).toBeNull();
  });

  it('a name of 1 to 120 characters, none of / \\ : or a control character, never . or ..', () => {
    expect(isBlockName('x'.repeat(BLOCK_NAME_MAX))).toBe(true);
    expect(isBlockName('\u{1F50C}'.repeat(BLOCK_NAME_MAX))).toBe(true);   // code points, not UTF-16 units
    expect(isBlockName('LDO 3.3 V')).toBe(true);
    for (const bad of ['', '.', '..', 'x'.repeat(BLOCK_NAME_MAX + 1), 'a/b', 'a\\b', 'a:b', 'a\nb', 'a\u0000b', 7, null]) expect(isBlockName(bad)).toBe(false);
  });

  it('the scopes of each frame', () => {
    expect(scopesOf('sch')).toEqual(['sheet', 'selection']);
    expect(scopesOf('pcb')).toEqual(['board', 'selection', 'linkedGroup']);
    expect(scopesOf('fpedit')).toBeNull();
  });
});

describe('the record, read closed', () => {
  it('reads code and lines', () => {
    expect(readBlockSaveRecord(null)).toBeNull();
    expect(readBlockSaveRecord(enc({ code: 0, lines: [] }))).toEqual({ code: 0, lines: [] });
    expect(readBlockSaveRecord(enc({ code: 1, lines: ['No sheet has that path.'] }))).toEqual({ code: 1, lines: ['No sheet has that path.'] });
  });

  it('refuses any other shape', () => {
    for (const bad of ['{', '[]', { code: 0 }, { lines: [] }, { code: 2, lines: [] }, { code: '0', lines: [] }, { code: 0, lines: [1] }, { code: 0, lines: [], more: 1 }]) {
      expect(readBlockSaveRecord(enc(bad))).toBe('bad');
    }
  });
});

describe('block.save over the engine', () => {
  it('a sheet: the engine is called exactly as it reads its args, the file answered, the folder removed', async () => {
    const { ctx, calls, made, dropped } = fakeCtx({ engine: engineOf('sch') });
    const r = await blockSave({ scope: 'sheet', name: 'iobuf', sheetPath: SHEET }, ctx);
    expect(r).toEqual({ ok: true, result: { files: [{ path: 'iobuf.kicad_sch', text: SCH_TEXT }] } });
    expect(calls).toEqual([{ run: 1, dir: `${BLOCK_SAVE_ROOT}/1`, name: 'iobuf', scope: 'sheet', sheetPath: SHEET }]);
    expect(Object.keys(calls[0])).toEqual(['run', 'dir', 'name', 'scope', 'sheetPath']);
    expect(dropped).toEqual(made);
  });

  it('a schematic selection sends four keys, no sheetPath', async () => {
    const { ctx, calls } = fakeCtx({ engine: engineOf('sch') });
    const r = await blockSave({ scope: 'selection', name: 'two' }, ctx);
    expect(r).toMatchObject({ ok: true, result: { files: [{ path: 'two.kicad_sch' }] } });
    expect(calls[0]).toEqual({ run: 1, dir: `${BLOCK_SAVE_ROOT}/1`, name: 'two', scope: 'selection' });
  });

  for (const scope of ['board', 'selection', 'linkedGroup'] as const) {
    it(`a pcb frame, scope ${scope}: the layout answered as <name>.kicad_pcb`, async () => {
      const { ctx, calls, made, dropped } = fakeCtx({ frame: 'pcb', engine: engineOf('pcb') });
      const r = await blockSave({ scope, name: 'LDO' }, ctx);
      expect(r).toEqual({ ok: true, result: { files: [{ path: 'LDO.kicad_pcb', text: PCB_TEXT }] } });
      expect(calls[0].scope).toBe(scope);
      expect(dropped).toEqual(made);
    });
  }

  it('a name with spaces and letters past ASCII reaches the engine as is', async () => {
    const { ctx, calls } = fakeCtx({ frame: 'pcb', engine: engineOf('pcb') });
    const r = await blockSave({ scope: 'board', name: 'Régulateur 3V3' }, ctx);
    expect(r).toMatchObject({ ok: true, result: { files: [{ path: 'Régulateur 3V3.kicad_pcb' }] } });
    expect(calls[0].name).toBe('Régulateur 3V3');
  });

  it('a record with code 1 answers block_failed with KiCad\'s first line', async () => {
    const { ctx, made, dropped } = fakeCtx({ engine: engineOf('sch', { code: 1, lines: ['', 'Design blocks with nested sheets are not supported.', 'more'] }) });
    expect(await blockSave({ scope: 'sheet', name: 'root', sheetPath: '/' }, ctx)).toEqual({ ok: false, code: 'block_failed', message: 'Design blocks with nested sheets are not supported.' });
    expect(dropped).toEqual(made);
  });

  it('a record with code 1 and no line answers block_failed naming the op', async () => {
    const { ctx } = fakeCtx({ frame: 'pcb', engine: engineOf('pcb', { code: 1, lines: [] }) });
    expect(await blockSave({ scope: 'linkedGroup', name: 'g' }, ctx)).toEqual({ ok: false, code: 'block_failed', message: 'block.save' });
  });

  it('a record of another shape, or code 0 with no file, answers island_error', async () => {
    const bad = fakeCtx({ engine: engineOf('sch', { code: 0, lines: [], extra: true }) });
    expect(await blockSave({ scope: 'selection', name: 'x' }, bad.ctx)).toMatchObject({ ok: false, code: 'island_error' });
    const nofile = fakeCtx({ engine: (a, files) => { files.set(`${a.dir as string}/${BLOCK_SAVE_RECORD}`, enc({ code: 0, lines: [] })); return true; } });
    expect(await blockSave({ scope: 'selection', name: 'x' }, nofile.ctx)).toEqual({ ok: false, code: 'island_error', message: 'the engine wrote no x.kicad_sch' });
    expect(nofile.dropped).toEqual(nofile.made);
  });

  it('the engine refusing the call answers not_applied, a throw island_error; the folder removed', async () => {
    const no = fakeCtx({ engine: () => false });
    expect(await blockSave({ scope: 'selection', name: 'x' }, no.ctx)).toEqual({ ok: false, code: 'not_applied', message: 'block.save' });
    expect(no.dropped).toEqual(no.made);
    const thrown = fakeCtx({ engine: () => { throw new Error('boom'); } });
    expect(await blockSave({ scope: 'selection', name: 'x' }, thrown.ctx)).toEqual({ ok: false, code: 'island_error', message: 'boom' });
    expect(thrown.dropped).toEqual(thrown.made);
  });

  it('no record within the bound answers not_applied', async () => {
    const { ctx, made, dropped } = fakeCtx({ engine: () => true });
    expect(await blockSave({ scope: 'selection', name: 'x' }, ctx)).toEqual({ ok: false, code: 'not_applied', message: 'block.save' });
    expect(dropped).toEqual(made);
  });

  it('checks in order: the args, the frame\'s scopes, then the gate; nothing queued before', async () => {
    const sch = fakeCtx({ engine: engineOf('sch') });
    expect(await blockSave({ scope: 'board', name: 'a/b' }, sch.ctx)).toEqual({ ok: false, code: 'bad_args', message: 'block.save' });
    expect(await blockSave({ scope: 'sheet', name: 'x'.repeat(121), sheetPath: '/' }, sch.ctx)).toEqual({ ok: false, code: 'bad_args', message: 'block.save' });
    expect(await blockSave({ scope: 'board', name: 'b' }, sch.ctx)).toEqual({ ok: false, code: 'unsupported', message: 'scope board is saved in a pcb frame' });
    expect(await blockSave({ scope: 'linkedGroup', name: 'b' }, sch.ctx)).toEqual({ ok: false, code: 'unsupported', message: 'scope linkedGroup is saved in a pcb frame' });
    const pcb = fakeCtx({ frame: 'pcb', engine: engineOf('pcb') });
    expect(await blockSave({ scope: 'sheet', name: 'b', sheetPath: '/' }, pcb.ctx)).toEqual({ ok: false, code: 'unsupported', message: 'scope sheet is saved in a sch frame' });
    const busy = fakeCtx({ gate: 'a dialog is up', engine: engineOf('sch') });
    expect(await blockSave({ scope: 'selection', name: 'b' }, busy.ctx)).toEqual({ ok: false, code: 'busy', message: 'a dialog is up' });
    for (const c of [sch, pcb, busy]) { expect(c.calls).toEqual([]); expect(c.made).toEqual([]); }
  });

  it('an engine without kicadDesignBlockSave (run 14) answers unsupported naming it', async () => {
    const { ctx, made } = fakeCtx({ missing: 'kicadDesignBlockSave' });
    expect(await blockSave({ scope: 'selection', name: 'b' }, ctx)).toEqual({ ok: false, code: 'unsupported', message: 'kicadDesignBlockSave' });
    expect(made).toEqual([]);
    expect(BLOCK_SAVE_EXPORTS[0]).toBe('kicadDesignBlockSave');
  });
});

describe('block.save through the responder', () => {
  it('on an engine without the export: bad_args first, then unsupported naming kicadDesignBlockSave', async () => {
    const { ask } = await boot('sch', { kicadCollabBusy: () => false });
    expect(await ask(1, 'block.save', { scope: 'sheet', name: 'a:b', sheetPath: '/' })).toMatchObject({ id: 1, ok: false, error: { code: 'bad_args', message: 'block.save' } });
    expect(await ask(2, 'block.save', { scope: 'selection', name: 'x' })).toMatchObject({ id: 2, ok: false, error: { code: 'unsupported', message: 'kicadDesignBlockSave' } });
  });

  it('in another frame: unsupported with the unit\'s frame refusal', async () => {
    const { ask } = await boot('symedit', { kicadCollabBusy: () => false, kicadDesignBlockSave: () => false });
    const r = await ask(1, 'block.save', { scope: 'selection', name: 'x' });
    expect(r).toMatchObject({ id: 1, ok: false, error: { code: 'unsupported', message: 'a design block is saved in a sch or pcb frame' } });
  });
});
