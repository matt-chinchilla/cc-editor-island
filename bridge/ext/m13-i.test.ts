// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// m13-i: embedded.get, embedded.set and embedded.extract in both document
// frames, the cap designEmbedded feature detected on the engine's exports,
// every check made before anything is written, the file staged in one fresh
// /tmp/cc-embed/<n>/ and the extract read from one fresh /tmp/cc-embed-out/<n>/,
// both removed after every answer. The engine here is this test's own module
// of exports (at the protocol boundary); the real engine is the e2e's
// (tests/e2e/embedded-files.spec.ts, engine run 15).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startResponder } from '../responder';
import type { Answer, ExtUnit, ResponderCtx } from './contract';
import { buildRegistry, REGISTRY } from './registry';
import unit, {
  EMBED_MAX_BYTES, EMBED_ROOT, EMBEDDED_CAP, EXTRACT_RECORD, EXTRACT_ROOT, SET_RECORD,
  parseEmbeddedSetArgs, readEmbedded, type EmbeddedRead, type EmbedType,
} from './m13-i';

const PARENT = 'http://localhost';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const RUN15 = { kicadEmbeddedFilesGet: () => '', kicadEmbeddedFilesSet: () => false, kicadEmbeddedFileExtract: () => false, kicadCollabBusy: () => false };
const OPS = ['embedded.get', 'embedded.set', 'embedded.extract'];

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
  const typeName = frame === 'pcb' ? 'PCB_EDIT_FRAME' : 'SCH_EDIT_FRAME';
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
    for (let i = 0; i < 100 && !got.some((m) => m.id === id); i += 1) await settle();
    return got.find((m) => m.id === id);
  };
  return { ready: got.find((m) => m.type === 'ev.ready') as { caps: string[] } | undefined, ask };
}

/** The document the fake engine holds: a font in two footprints, a datasheet, and the fonts the drawing uses. */
function startRead(owner: 'board' | 'schematic' = 'board'): EmbeddedRead {
  return {
    owner,
    fontsEmbedded: false,
    files: [
      { name: 'NotoSans-Regular.ttf', type: 'font', bytes: 513_000, heldBy: 2 },
      { name: 'sheet.pdf', type: 'datasheet', bytes: 1_977, heldBy: 0 },
    ],
    fonts: [{ name: 'Noto Sans', embedded: false }],
  };
}

interface FakeOpts { frame?: 'pcb' | 'sch'; gate?: string; setAnswer?: unknown; record?: (a: Record<string, unknown>) => unknown; apply?: boolean; extractAnswer?: unknown; extractRecord?: (name: string) => unknown; getText?: () => string }

/**
 * A ResponderCtx over a fake engine and a fake MEMFS: kicadEmbeddedFilesGet
 * reads `state`, kicadEmbeddedFilesSet records its args, checks the staged file
 * and queues the change and its record (embedded.json) for the next idle,
 * kicadEmbeddedFileExtract writes the file and its record at once.
 */
function fakeCtx(opts: FakeOpts = {}) {
  const state = { read: startRead(opts.frame === 'sch' ? 'schematic' : 'board') };
  const bodies = new Map<string, Uint8Array>([['NotoSans-Regular.ttf', enc('ttf body')], ['sheet.pdf', enc('%PDF-1.4 one page')]]);
  const files = new Map<string, Uint8Array>();
  const made: string[] = [];
  const dropped: string[] = [];
  const sets: Array<{ args: Record<string, unknown>; staged: Record<string, number> }> = [];
  const extracts: string[] = [];
  let pending: (() => void) | null = null;
  let n = 0;
  const mod: Record<string, unknown> = {
    ...RUN15,
    kicadEmbeddedFilesGet: () => (opts.getText != null ? opts.getText() : JSON.stringify(state.read)),
    kicadEmbeddedFilesSet: (json: string) => {
      const a = JSON.parse(json) as Record<string, unknown>;
      const staged: Record<string, number> = {};
      for (const [k, v] of files) if (k.startsWith(`${EMBED_ROOT}/`)) staged[k] = v.byteLength;
      sets.push({ args: a, staged });
      if (opts.setAnswer !== undefined) return opts.setAnswer;
      const r = state.read;
      pending = () => {
        if (opts.apply !== false) {
          if (a.op === 'add') {
            const size = files.get(a.path as string)?.byteLength ?? 0;
            r.files = [...r.files.filter((f) => f.name !== a.name), { name: a.name as string, type: a.type as EmbedType, bytes: size, heldBy: 0 }];
            bodies.set(a.name as string, files.get(a.path as string)!);
          } else if (a.op === 'remove') {
            r.files = r.files.filter((f) => f.name !== a.name);
          } else if (a.op === 'fonts') {
            r.fontsEmbedded = a.embed as boolean;
            r.fonts = r.fonts.map((f) => ({ ...f, embedded: a.embed as boolean }));
          }
        }
        const rec = opts.record != null ? opts.record(a) : { files: r.files.map((f) => f.name), error: '' };
        files.set(`${a.dir as string}/${SET_RECORD}`, enc(typeof rec === 'string' ? rec : JSON.stringify(rec)));
      };
      return true;
    },
    kicadEmbeddedFileExtract: (json: string) => {
      extracts.push(json);
      if (opts.extractAnswer !== undefined) return opts.extractAnswer;
      const a = JSON.parse(json) as { dir: string; name: string };
      const body = bodies.get(a.name);
      if (body != null) files.set(`${a.dir}/${a.name}`, body);
      const rec = opts.extractRecord != null ? opts.extractRecord(a.name) : { name: a.name, bytes: body?.byteLength ?? 0, error: body == null ? 'extract_failed' : '' };
      files.set(`${a.dir}/${EXTRACT_RECORD}`, enc(JSON.stringify(rec)));
      return true;
    },
  };
  const frame = opts.frame ?? 'pcb';
  const gate = (_op: string, exports: readonly string[]): Answer | { w: object; mod: Record<string, unknown> } => {
    if (opts.gate != null) return { ok: false, code: 'busy', message: opts.gate };
    for (const name of exports) if (typeof mod[name] !== 'function') return { ok: false, code: 'unsupported', message: name };
    return { w: {}, mod };
  };
  const wrongFrame = (want: string) => (op: string, exports: readonly string[]) =>
    frame === want ? gate(op, exports) : { ok: false, code: 'unsupported', message: `${op} needs a ${want} frame` };
  const ctx = {
    frame,
    root: '/project',
    timing: { applyMs: 200, applyPollMs: 5 },
    mod: () => mod,
    fs: () => ({ writeFile: (p: string, b: Uint8Array) => { files.set(p, b); } }),
    closed: () => false,
    boardGate: wrongFrame('pcb'),
    schematicGate: wrongFrame('sch'),
    applyIdle: async () => { if (pending != null) { pending(); pending = null; } return true; },
    freshRunFolder: (root: string) => { n += 1; const d = `${root}/${n}`; made.push(d); return d; },
    dropRunFolder: (dir: string) => { dropped.push(dir); for (const k of [...files.keys()]) if (k.startsWith(`${dir}/`)) files.delete(k); },
    readBytes: (abs: string) => files.get(abs) ?? null,
    queuedRun: async <T,>(op: string, dir: string, ms: number, call: () => unknown, record: () => T | null) => {
      if ((await call()) !== true) { dropped.push(dir); return { ok: false, code: 'not_applied', message: op }; }
      const deadline = Date.now() + ms;
      for (;;) {
        if (await ctx.applyIdle(ms)) { const done = record(); if (done != null) return { done }; }
        if (Date.now() >= deadline) { ctx.dropRunFolder(dir); return { ok: false, code: 'not_applied', message: op }; }
        await settle(5);
      }
    },
    log: () => {},
  } as unknown as ResponderCtx;
  return { ctx, state, files, made, dropped, sets, extracts };
}

const run = (op: string, args: unknown, ctx: ResponderCtx) => Promise.resolve((unit.ops as NonNullable<ExtUnit['ops']>)[op].run(args, ctx));
const leftUnder = (files: Map<string, Uint8Array>): string[] => [...files.keys()].filter((k) => k.startsWith(`${EMBED_ROOT}/`) || k.startsWith(`${EXTRACT_ROOT}/`));

describe('m13-i in the registry', () => {
  it('loads in this checkout with nothing broken, owning the three ops and the cap designEmbedded', () => {
    expect(REGISTRY.problems).toEqual([]);
    for (const op of OPS) {
      expect(REGISTRY.ops.get(op)?.unit).toBe('m13-i');
      expect(REGISTRY.pending.has(op)).toBe(false);
    }
    expect(REGISTRY.capNames.get(EMBEDDED_CAP)).toBe('m13-i');
    expect(EMBEDDED_CAP).toBe('designEmbedded');
    expect([...unit.frames!]).toEqual(['sch', 'pcb']);
  });

  it('lists designEmbedded in both document frames on an engine with the four exports, nothing on run 14 or in a symedit frame', () => {
    expect(unit.caps!(RUN15, 'pcb')).toEqual(['designEmbedded']);
    expect(unit.caps!(RUN15, 'sch')).toEqual(['designEmbedded']);
    expect(unit.caps!(RUN15, 'symedit')).toEqual([]);
    expect(unit.caps!({ kicadEmbeddedFilesGet: () => '', kicadEmbeddedFilesSet: () => false, kicadCollabBusy: () => false }, 'pcb')).toEqual([]);
    expect(unit.caps!({}, 'sch')).toEqual([]);
  });

  it('on run 14 neither frame lists designEmbedded and each op answers unsupported naming kicadEmbeddedFilesGet; bad args first', async () => {
    for (const frame of ['sch', 'pcb']) {
      const s = await boot(frame, { kicadCollabBusy: () => false });
      expect(s.ready?.caps).not.toContain('designEmbedded');
      const unsupported = { ok: false, error: { code: 'unsupported', message: 'kicadEmbeddedFilesGet' } };
      expect(await s.ask(1, 'embedded.get')).toMatchObject(unsupported);
      expect(await s.ask(2, 'embedded.set', { op: 'fonts', embed: true })).toMatchObject(unsupported);
      expect(await s.ask(3, 'embedded.extract', { name: 'a.ttf' })).toMatchObject(unsupported);
      expect(await s.ask(4, 'embedded.get', { x: 1 })).toMatchObject({ ok: false, error: { code: 'bad_args', message: 'embedded.get' } });
      expect(await s.ask(5, 'embedded.set', { op: 'add', name: 'big.pdf', type: 'datasheet', bytes: new Uint8Array(EMBED_MAX_BYTES + 1) })).toMatchObject({ ok: false, error: { code: 'bad_args', message: 'embedded.set' } });
      expect(await s.ask(6, 'embedded.extract', { name: '../a' })).toMatchObject({ ok: false, error: { code: 'bad_args', message: 'embedded.extract' } });
    }
  });

  it('on run 15 both frames list designEmbedded and answer not_ready with no document open; a symedit frame lists none and refuses the ops', async () => {
    for (const frame of ['sch', 'pcb']) {
      const s = await boot(frame, RUN15);
      expect(s.ready?.caps).toContain('designEmbedded');
      expect(await s.ask(1, 'embedded.get')).toMatchObject({ ok: false, error: { code: 'not_ready', message: 'embedded.get' } });
    }
    const sym = await boot('symedit', RUN15);
    expect(sym.ready?.caps).not.toContain('designEmbedded');
    expect(await sym.ask(1, 'embedded.get')).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'the design\'s embedded files are kept in a sch or a pcb frame' } });
  });
});

describe('readEmbedded', () => {
  it('reads the engine\'s answer closed: the four keys, each file and font of its shape, at most 1,024 files', () => {
    const r = startRead();
    expect(readEmbedded(JSON.stringify(r))).toEqual(r);
    expect(readEmbedded(JSON.stringify({ ...r, owner: 'symbol' }))).toBeNull();
    expect(readEmbedded(JSON.stringify({ ...r, files: [{ ...r.files[0], type: 'picture' }] }))).toBeNull();
    expect(readEmbedded(JSON.stringify({ ...r, files: [{ ...r.files[0], bytes: -1 }] }))).toBeNull();
    expect(readEmbedded(JSON.stringify({ ...r, fonts: [{ name: 'Noto Sans' }] }))).toBeNull();
    expect(readEmbedded(JSON.stringify({ ...r, files: Array.from({ length: 1025 }, (_, i) => ({ ...r.files[1], name: `f${i}.pdf` })) }))).toBeNull();
    expect(readEmbedded('{')).toBeNull();
    expect(readEmbedded(JSON.stringify({ ...r, extra: 1 }))).toBeNull();
  });
});

describe('embedded.get', () => {
  it('answers the engine\'s read in either frame; busy on ""; island_error on another shape; the gate\'s refusal as it is; a read during a check', async () => {
    const f = fakeCtx();
    expect(await run('embedded.get', {}, f.ctx)).toEqual({ ok: true, result: startRead() });
    const s = fakeCtx({ frame: 'sch' });
    expect(await run('embedded.get', undefined, s.ctx)).toEqual({ ok: true, result: startRead('schematic') });
    expect(unit.ops!['embedded.get'].passesCheck).toBe(true);
    expect(await run('embedded.get', {}, fakeCtx({ getText: () => '' }).ctx)).toEqual({ ok: false, code: 'busy', message: 'embedded.get' });
    expect(await run('embedded.get', {}, fakeCtx({ getText: () => '{"files":3}' }).ctx)).toMatchObject({ ok: false, code: 'island_error' });
    expect(await run('embedded.get', {}, fakeCtx({ gate: 'embedded.get' }).ctx)).toEqual({ ok: false, code: 'busy', message: 'embedded.get' });
  });
});

describe('embedded.set', () => {
  it('reads its three forms closed', () => {
    const bytes = enc('x');
    expect(parseEmbeddedSetArgs({ op: 'add', name: 'a.pdf', type: 'datasheet', bytes })).toEqual({ op: 'add', name: 'a.pdf', type: 'datasheet', bytes });
    expect(parseEmbeddedSetArgs({ op: 'remove', name: 'a.pdf', alsoHeld: false })).toEqual({ op: 'remove', name: 'a.pdf', alsoHeld: false });
    expect(parseEmbeddedSetArgs({ op: 'fonts', embed: true })).toEqual({ op: 'fonts', embed: true });
    for (const t of ['font', 'model', 'worksheet', 'datasheet', 'other']) expect(parseEmbeddedSetArgs({ op: 'add', name: 'a', type: t, bytes })).not.toBeNull();
    for (const bad of [
      undefined, {}, { op: 'add', name: 'a', type: 'datasheet' }, { op: 'add', name: 'a', type: 'picture', bytes },
      { op: 'add', name: 'a/b', type: 'other', bytes }, { op: 'add', name: 'a\\b', type: 'other', bytes }, { op: 'add', name: '..', type: 'other', bytes },
      { op: 'add', name: '', type: 'other', bytes }, { op: 'add', name: 'x'.repeat(256), type: 'other', bytes },
      { op: 'add', name: 'a', type: 'other', bytes: new Uint8Array(0) }, { op: 'add', name: 'a', type: 'other', bytes: [1, 2] },
      { op: 'add', name: 'a', type: 'other', bytes: new Uint8Array(EMBED_MAX_BYTES + 1) },
      { op: 'add', name: 'a', type: 'other', bytes, x: 1 }, { op: 'remove', name: 'a' }, { op: 'remove', name: 'a', alsoHeld: 1 },
      { op: 'fonts', embed: 'yes' }, { op: 'fonts', embed: true, run: 1 }, { op: 'rename', name: 'a' },
    ]) expect(parseEmbeddedSetArgs(bad)).toBeNull();
    expect(parseEmbeddedSetArgs({ op: 'add', name: 'x'.repeat(255), type: 'other', bytes: new Uint8Array(EMBED_MAX_BYTES) })).not.toBeNull();
  });

  it('add stages the file in one fresh /tmp/cc-embed/<n>/, queues ONE set with run and dir, and answers the read once it shows the file; the folder removed', async () => {
    const f = fakeCtx();
    const pdf = enc('%PDF-1.4 a datasheet');
    const a = await run('embedded.set', { op: 'add', name: 'ds.pdf', type: 'datasheet', bytes: pdf }, f.ctx);
    expect(a).toMatchObject({ ok: true });
    expect((a as unknown as { result: EmbeddedRead }).result.files.at(-1)).toEqual({ name: 'ds.pdf', type: 'datasheet', bytes: pdf.byteLength, heldBy: 0 });
    expect(f.made).toEqual([`${EMBED_ROOT}/1`]);
    expect(f.sets).toEqual([{ args: { run: 1, dir: `${EMBED_ROOT}/1`, op: 'add', path: `${EMBED_ROOT}/1/ds.pdf`, name: 'ds.pdf', type: 'datasheet' }, staged: { [`${EMBED_ROOT}/1/ds.pdf`]: pdf.byteLength } }]);
    expect(f.dropped).toEqual([`${EMBED_ROOT}/1`]);
    expect(leftUnder(f.files)).toEqual([]);
  });

  it('remove and fonts carry run and dir too, and answer the read once it shows the change', async () => {
    const f = fakeCtx();
    const r = await run('embedded.set', { op: 'remove', name: 'NotoSans-Regular.ttf', alsoHeld: true }, f.ctx);
    expect((r as unknown as { result: EmbeddedRead }).result.files.map((x) => x.name)).toEqual(['sheet.pdf']);
    expect(f.sets[0].args).toEqual({ run: 1, dir: `${EMBED_ROOT}/1`, op: 'remove', name: 'NotoSans-Regular.ttf', alsoHeld: true });
    const on = await run('embedded.set', { op: 'fonts', embed: true }, f.ctx);
    expect(on).toMatchObject({ ok: true, result: { fontsEmbedded: true, fonts: [{ name: 'Noto Sans', embedded: true }] } });
    expect(f.sets[1].args).toEqual({ run: 2, dir: `${EMBED_ROOT}/2`, op: 'fonts', embed: true });
    expect(await run('embedded.set', { op: 'fonts', embed: false }, f.ctx)).toMatchObject({ ok: true, result: { fontsEmbedded: false } });
    expect(f.dropped).toEqual([`${EMBED_ROOT}/1`, `${EMBED_ROOT}/2`, `${EMBED_ROOT}/3`]);
    expect(leftUnder(f.files)).toEqual([]);
  });

  it('a remove of a name the document does not hold answers not_found naming it, nothing staged or sent', async () => {
    const f = fakeCtx();
    expect(await run('embedded.set', { op: 'remove', name: 'gone.pdf', alsoHeld: false }, f.ctx)).toEqual({ ok: false, code: 'not_found', message: 'gone.pdf' });
    expect(f.sets).toEqual([]);
    expect(f.made).toEqual([]);
  });

  it('bad args and the gate answer before anything is staged; the engine\'s refusal of an add is bad_args, of the others not_applied; the folder removed', async () => {
    const big = fakeCtx();
    expect(await run('embedded.set', { op: 'add', name: 'big.pdf', type: 'datasheet', bytes: new Uint8Array(EMBED_MAX_BYTES + 1) }, big.ctx)).toEqual({ ok: false, code: 'bad_args', message: 'embedded.set' });
    expect(big.made).toEqual([]);
    const gated = fakeCtx({ gate: 'embedded.set' });
    expect(await run('embedded.set', { op: 'fonts', embed: true }, gated.ctx)).toEqual({ ok: false, code: 'busy', message: 'embedded.set' });
    expect(gated.made).toEqual([]);
    const no = fakeCtx({ setAnswer: false });
    expect(await run('embedded.set', { op: 'add', name: 'a.pdf', type: 'datasheet', bytes: enc('x') }, no.ctx)).toEqual({ ok: false, code: 'bad_args', message: 'embedded.set: KiCad refused the file' });
    expect(await run('embedded.set', { op: 'fonts', embed: true }, no.ctx)).toEqual({ ok: false, code: 'not_applied', message: 'embedded.set' });
    expect(no.dropped).toEqual(no.made);
    expect(leftUnder(no.files)).toEqual([]);
    const thrown = fakeCtx({ setAnswer: undefined });
    (thrown.ctx.mod() as Record<string, unknown>).kicadEmbeddedFilesSet = () => { throw new Error('trap'); };
    expect(await run('embedded.set', { op: 'fonts', embed: true }, thrown.ctx)).toEqual({ ok: false, code: 'island_error', message: 'trap' });
    expect(thrown.dropped).toEqual(thrown.made);
  });

  it('a record saying not_applied, a change that never shows, or no record within the wait answer not_applied; the folder removed', async () => {
    const said = fakeCtx({ record: () => ({ files: [], error: 'not_applied' }) });
    expect(await run('embedded.set', { op: 'fonts', embed: true }, said.ctx)).toEqual({ ok: false, code: 'not_applied', message: 'embedded.set' });
    expect(said.dropped).toEqual(said.made);
    const unseen = fakeCtx({ apply: false });
    expect(await run('embedded.set', { op: 'add', name: 'a.pdf', type: 'datasheet', bytes: enc('x') }, unseen.ctx)).toEqual({ ok: false, code: 'not_applied', message: 'embedded.set' });
    expect(leftUnder(unseen.files)).toEqual([]);
    const none = fakeCtx({ record: () => '{' });
    expect(await run('embedded.set', { op: 'fonts', embed: true }, none.ctx)).toEqual({ ok: false, code: 'not_applied', message: 'embedded.set' });
    expect(leftUnder(none.files)).toEqual([]);
  });
});

describe('embedded.extract', () => {
  it('answers the file\'s exact bytes with their buffer transferred, read from one fresh /tmp/cc-embed-out/<n>/ removed after', async () => {
    const f = fakeCtx({ frame: 'sch' });
    const a = await run('embedded.extract', { name: 'sheet.pdf' }, f.ctx);
    expect(a.ok).toBe(true);
    const got = a as unknown as { result: { name: string; bytes: Uint8Array }; transfer: ArrayBuffer[] };
    expect(got.result.name).toBe('sheet.pdf');
    expect(new TextDecoder().decode(got.result.bytes)).toBe('%PDF-1.4 one page');
    expect(got.transfer).toEqual([got.result.bytes.buffer]);
    expect(f.extracts).toEqual([JSON.stringify({ dir: `${EXTRACT_ROOT}/1`, name: 'sheet.pdf' })]);
    expect(f.dropped).toEqual([`${EXTRACT_ROOT}/1`]);
    expect(leftUnder(f.files)).toEqual([]);
    expect(unit.ops!['embedded.extract'].passesCheck).toBe(true);
  });

  it('not_found for a name the document does not hold, too_large past 25 MiB, not_applied when refused or the record says extract_failed, island_error for bytes of another length', async () => {
    const f = fakeCtx();
    expect(await run('embedded.extract', { name: 'gone.ttf' }, f.ctx)).toEqual({ ok: false, code: 'not_found', message: 'gone.ttf' });
    expect(f.extracts).toEqual([]);
    f.state.read.files.push({ name: 'huge.step', type: 'model', bytes: EMBED_MAX_BYTES + 1, heldBy: 0 });
    expect(await run('embedded.extract', { name: 'huge.step' }, f.ctx)).toEqual({ ok: false, code: 'too_large', message: 'huge.step' });
    const no = fakeCtx({ extractAnswer: false });
    expect(await run('embedded.extract', { name: 'sheet.pdf' }, no.ctx)).toEqual({ ok: false, code: 'not_applied', message: 'embedded.extract' });
    expect(no.dropped).toEqual(no.made);
    const failed = fakeCtx({ extractRecord: (name) => ({ name, bytes: 0, error: 'extract_failed' }) });
    expect(await run('embedded.extract', { name: 'sheet.pdf' }, failed.ctx)).toEqual({ ok: false, code: 'not_applied', message: 'embedded.extract: extract_failed' });
    expect(leftUnder(failed.files)).toEqual([]);
    const short = fakeCtx({ extractRecord: (name) => ({ name, bytes: 3, error: '' }) });
    expect(await run('embedded.extract', { name: 'sheet.pdf' }, short.ctx)).toMatchObject({ ok: false, code: 'island_error' });
    expect(leftUnder(short.files)).toEqual([]);
    expect(await run('embedded.extract', { name: 'sheet.pdf', x: 1 }, f.ctx)).toEqual({ ok: false, code: 'bad_args', message: 'embedded.extract' });
  });
});
