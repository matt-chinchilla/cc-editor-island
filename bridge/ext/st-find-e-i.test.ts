// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-find-e-i: find and find.replace, the caps find and replace feature
// detected on the engine's kicadFind, kicadSchReplace and kicadCollabBusy, the
// args and the engine's answers read closed, the run folder under
// /tmp/cc-replace removed after every answer, and KiCad's six find actions
// held. The engine here is this test's own module of exports (at the protocol
// boundary); the real engine is the e2e's (tests/e2e/st/st-find-e-i.spec.ts,
// engine run 15).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HELD_ACTIONS, heldTaken } from '../held';
import { startResponder } from '../responder';
import type { ExtUnit, ResponderCtx } from './contract';
import { buildRegistry, heldActions, REGISTRY } from './registry';
import unit, {
  BAD_PATTERN, FIND, FIND_AND_REPLACE, FIND_CAP, FIND_EXPORTS, FIND_NEXT, FIND_PREVIOUS, FIND_ROWS, HITS_MAX, parseFindArgs, parseReplaceArgs,
  readFindResult, readHit, readReplaceDone, REPLACE_AND_FIND_NEXT, REPLACE_CAP, REPLACE_EXPORTS, REPLACE_ROOT, SEARCH,
} from './st-find-e-i';

const PARENT = 'http://localhost';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));
const enc = (v: unknown): Uint8Array => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v));
const RUN15 = { kicadFind: () => '', kicadSchReplace: () => false, kicadCollabBusy: () => false };

const SCH = { refs: true, values: false, fields: false, hidden: false, pins: false, labels: false, nets: false, thisSheet: false, selected: false };
const PCB = { refs: false, values: false, texts: false, nets: true, markers: false };
const FIND_R4 = { text: 'R4', matchCase: false, wholeWord: true, wildcards: false, regex: false, sch: SCH };
const FIND_GND = { text: 'GND', matchCase: false, wholeWord: false, wildcards: false, regex: false, pcb: PCB };
const R4 = { uuid: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', sheetPath: '/', kind: 'symbol', ref: 'R4', field: 'Reference', text: 'R4', start: 0, length: 2 };
const SDA = { uuid: '1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', sheetPath: '/', kind: 'label', ref: '', field: '', text: 'SDA', start: 0, length: 3 };
const LABELS = { ...SCH, refs: false, labels: true };
const FIND_SDA = { text: 'SDA', matchCase: true, wholeWord: true, wildcards: false, regex: false, sch: LABELS };

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
    await settle();
    return got.find((m) => m.id === id);
  };
  return { ready: got.find((m) => m.type === 'ev.ready') as { caps: string[] } | undefined, ask };
}

/**
 * A ResponderCtx over a fake engine in `frame` and a fake MEMFS: the folders
 * the op makes and drops are recorded; `find` plays kicadFind and `engine`
 * kicadSchReplace (its records written into the run folder it is given).
 */
function fakeCtx(opts: {
  frame?: 'sch' | 'pcb'; find?: (a: Record<string, unknown>) => unknown;
  engine?: (a: Record<string, unknown>, files: Map<string, Uint8Array>) => unknown; idle?: () => boolean; gate?: string;
} = {}) {
  const files = new Map<string, Uint8Array>();
  const made: string[] = [];
  const dropped: string[] = [];
  const finds: Array<Record<string, unknown>> = [];
  const calls: Array<Record<string, unknown>> = [];
  let n = 0;
  const frame = opts.frame ?? 'sch';
  const mod: Record<string, unknown> = {
    ...RUN15,
    kicadFind: (json: string) => { const a = JSON.parse(json) as Record<string, unknown>; finds.push(a); return (opts.find ?? (() => JSON.stringify({ hits: [], truncated: false })))(a); },
    kicadSchReplace: (json: string) => { const a = JSON.parse(json) as Record<string, unknown>; calls.push(a); return (opts.engine ?? (() => false))(a, files); },
  };
  const gated = (want: string) => (_op: string, exports: readonly string[]) => {
    if (frame !== want) return { ok: false, code: 'unsupported', message: `the ${want} gate in a ${frame} frame` };
    if (opts.gate != null) return { ok: false, code: 'busy', message: opts.gate };
    for (const name of exports) if (typeof mod[name] !== 'function') return { ok: false, code: 'unsupported', message: name };
    return { w: {}, mod };
  };
  const ctx = {
    frame,
    root: '/project',
    timing: { replaceMs: 200, applyPollMs: 5 },
    mod: () => mod,
    closed: () => false,
    schematicGate: gated('sch'),
    boardGate: gated('pcb'),
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
  return { ctx, files, made, dropped, finds, calls };
}

/** An engine that replaces as kicadSchReplace does: replace.json, then the done record LAST. */
const replacing = (replaced: number, skipped: number, depth: number) => (a: Record<string, unknown>, files: Map<string, Uint8Array>) => {
  const dir = a.dir as string;
  files.set(`${dir}/replace.json`, enc({ replaced, skipped, depth }));
  files.set(`${dir}/.cc-replace.json`, enc({ error: replaced > 0 ? '' : 'no_match', message: '' }));
  return true;
};

describe('st-find-e-i in the registry', () => {
  it('loads in this checkout with nothing broken, owning find, find.replace and the caps find and replace', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect(REGISTRY.ops.get('find')?.unit).toBe('st-find-e-i');
    expect(REGISTRY.ops.get('find.replace')?.unit).toBe('st-find-e-i');
    expect(REGISTRY.pending.has('find')).toBe(false);
    expect(REGISTRY.pending.has('find.replace')).toBe(false);
    expect(REGISTRY.capNames.get(FIND_CAP)).toBe('st-find-e-i');
    expect(REGISTRY.capNames.get(REPLACE_CAP)).toBe('st-find-e-i');
    expect([FIND_CAP, REPLACE_CAP]).toEqual(['find', 'replace']);
    expect(unit.ops.find.passesCheck).toBe(true);
    expect('passesCheck' in unit.ops['find.replace']).toBe(false);
  });

  it('lists find in a sch and a pcb frame on an engine with kicadFind, replace in a sch frame with the replace exports too, nothing on run 14', () => {
    expect([...FIND_EXPORTS]).toEqual(['kicadFind']);
    expect([...REPLACE_EXPORTS]).toEqual(['kicadSchReplace', 'kicadCollabBusy']);
    expect(unit.caps(RUN15, 'sch')).toEqual(['find', 'replace']);
    expect(unit.caps(RUN15, 'pcb')).toEqual(['find']);
    expect(unit.caps(RUN15, 'symedit')).toEqual([]);
    expect(unit.caps({ kicadFind: () => '' }, 'sch')).toEqual(['find']);
    expect(unit.caps({ kicadSchReplace: () => false, kicadCollabBusy: () => false }, 'sch')).toEqual([]);
    expect(unit.caps({ kicadCollabBusy: () => false }, 'pcb')).toEqual([]);
    expect(unit.caps({}, 'sch')).toEqual([]);
  });

  it('run 14: no cap listed in either frame, both ops answer unsupported naming the export; bad args first', async () => {
    for (const frame of ['sch', 'pcb']) {
      const s = await boot(frame, { kicadCollabBusy: () => false });
      expect(s.ready?.caps).not.toContain('find');
      expect(s.ready?.caps).not.toContain('replace');
      expect(await s.ask(1, 'find', frame === 'sch' ? FIND_R4 : FIND_GND)).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'kicadFind' } });
      expect(await s.ask(2, 'find', { text: '' })).toMatchObject({ ok: false, error: { code: 'bad_args', message: 'find' } });
      expect(await s.ask(3, 'find.replace', { find: FIND_SDA, with: 'X' })).toMatchObject({ ok: false, error: { code: 'bad_args', message: 'find.replace' } });
    }
    const sch = await boot('sch', { kicadCollabBusy: () => false });
    expect(await sch.ask(1, 'find.replace', { find: FIND_SDA, with: 'I2C_SDA', targets: 'all' })).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'kicadSchReplace' } });
  });

  it('run 15: the caps listed, not_ready with no document open; a pcb frame refuses find.replace; a symedit frame refuses both', async () => {
    const sch = await boot('sch', RUN15);
    expect(sch.ready?.caps).toEqual(expect.arrayContaining(['find', 'replace']));
    expect(await sch.ask(1, 'find', FIND_R4)).toMatchObject({ ok: false, error: { code: 'not_ready', message: 'find' } });
    expect(await sch.ask(2, 'find.replace', { find: FIND_SDA, with: 'I2C_SDA', targets: 'all' })).toMatchObject({ ok: false, error: { code: 'not_ready', message: 'find.replace' } });
    expect(await sch.ask(3, 'find', FIND_GND)).toMatchObject({ ok: false, error: { code: 'bad_args', message: 'find' } });
    const pcb = await boot('pcb', RUN15);
    expect(pcb.ready?.caps).toContain('find');
    expect(pcb.ready?.caps).not.toContain('replace');
    expect(await pcb.ask(1, 'find', FIND_GND)).toMatchObject({ ok: false, error: { code: 'not_ready', message: 'find' } });
    expect(await pcb.ask(2, 'find.replace', { find: FIND_SDA, with: 'I2C_SDA', targets: 'all' })).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'a replace runs in a sch frame' } });
    const sym = await boot('symedit', RUN15);
    expect(sym.ready?.caps ?? []).not.toContain('find');
    expect(await sym.ask(1, 'find', FIND_R4)).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'find runs in a sch or pcb frame' } });
  });
});

describe('the held find actions', () => {
  const union = heldActions(buildRegistry(mods(unit)));
  it('holds KiCad\'s six find actions, the replace ones in a sch frame under replace, the rest in both frames under find', () => {
    expect([FIND, FIND_AND_REPLACE, SEARCH, FIND_NEXT, FIND_PREVIOUS, REPLACE_AND_FIND_NEXT]).toEqual([
      'common.Interactive.find', 'common.Interactive.findAndReplace', 'common.Interactive.search',
      'common.Interactive.findNext', 'common.Interactive.findPrevious', 'common.Interactive.replaceAndFindNext',
    ]);
    expect(unit.held).toEqual(FIND_ROWS.map((h) => h.action));
    expect(FIND_ROWS.map((h) => ({ ...h, frames: [...h.frames] }))).toEqual([
      { action: FIND, frames: ['sch', 'pcb'], cap: 'find' },
      { action: FIND_AND_REPLACE, frames: ['sch'], cap: 'replace' },
      { action: SEARCH, frames: ['sch', 'pcb'], cap: 'find' },
      { action: FIND_NEXT, frames: ['sch', 'pcb'], cap: 'find' },
      { action: FIND_PREVIOUS, frames: ['sch', 'pcb'], cap: 'find' },
      { action: REPLACE_AND_FIND_NEXT, frames: ['sch'], cap: 'replace' },
    ]);
    for (const r of FIND_ROWS) expect(heldActions()).toContainEqual(r);
  });
  it('no built in row holds them in a sch or a pcb frame; the symbol editor\'s own find rows stand', () => {
    for (const r of FIND_ROWS) {
      expect(HELD_ACTIONS.some((h) => h.action === r.action && (h.frames.includes('sch') || h.frames.includes('pcb')))).toBe(false);
    }
    expect(heldTaken(FIND, 'symedit', ['symedit'], union)).toBe(true);
  });
  it('the responder takes each only in its frames while ev.ready listed its cap', () => {
    for (const a of [FIND, SEARCH, FIND_NEXT, FIND_PREVIOUS]) {
      expect(heldTaken(a, 'sch', ['find'], union)).toBe(true);
      expect(heldTaken(a, 'pcb', ['find'], union)).toBe(true);
      expect(heldTaken(a, 'pcb', ['heldKeys'], union)).toBe(false);
    }
    for (const a of [FIND_AND_REPLACE, REPLACE_AND_FIND_NEXT]) {
      expect(heldTaken(a, 'sch', ['replace'], union)).toBe(true);
      expect(heldTaken(a, 'sch', ['find'], union)).toBe(false);
      expect(heldTaken(a, 'pcb', ['find', 'replace'], union)).toBe(false);
    }
  });
});

describe('the args', () => {
  it('find takes exactly the text, the four options and one face object with its own flags', () => {
    expect(parseFindArgs(FIND_R4)).toEqual(FIND_R4);
    expect(parseFindArgs(FIND_GND)).toEqual(FIND_GND);
    expect(parseFindArgs({ ...FIND_R4, text: 'é'.repeat(256) })).not.toBeNull();
    expect(parseFindArgs({ ...FIND_R4, text: '😀'.repeat(256) })).not.toBeNull();
    for (const bad of [
      null, [], {}, { ...FIND_R4, text: '' }, { ...FIND_R4, text: 'x'.repeat(257) }, { ...FIND_R4, text: 'a\0b' }, { ...FIND_R4, text: 4 },
      { ...FIND_R4, regex: 'yes' }, { ...FIND_R4, matchCase: undefined }, { ...FIND_R4, extra: 1 }, { ...FIND_R4, pcb: PCB },
      { text: 'R4', matchCase: false, wholeWord: true, wildcards: false, regex: false }, { ...FIND_R4, sch: { ...SCH, texts: true } },
      { ...FIND_R4, sch: { ...SCH, refs: 1 } }, { ...FIND_R4, sch: { refs: true } }, { ...FIND_GND, pcb: SCH }, { ...FIND_GND, pcb: { ...PCB, markers: null } },
    ]) {
      expect(parseFindArgs(bad), JSON.stringify(bad)?.slice(0, 80)).toBeNull();
    }
  });
  it('a Hit is read closed: the eight keys, a lowercase uuid, a known kind, whole counts, the engine\'s cuts', () => {
    expect(readHit(R4)).toEqual(R4);
    expect(readHit({ ...R4, kind: 'footprint', sheetPath: '' })).toEqual({ ...R4, kind: 'footprint', sheetPath: '' });
    expect(readHit({ ...R4, text: 'é'.repeat(1024) })).not.toBeNull();
    for (const bad of [
      null, {}, { ...R4, extra: 1 }, { ...R4, uuid: R4.uuid.toUpperCase() }, { ...R4, uuid: 'r4' }, { ...R4, kind: 'sheet' }, { ...R4, start: -1 },
      { ...R4, length: 1.5 }, { ...R4, ref: 4 }, { ...R4, text: 'x'.repeat(1025) }, { ...R4, sheetPath: '/'.repeat(4097) },
      (({ field: _f, ...rest }) => rest)(R4),
    ]) {
      expect(readHit(bad), JSON.stringify(bad)?.slice(0, 80)).toBeNull();
    }
  });
  it('find.replace takes exactly a sch find, a replacement of 0 to 256 code points and all or 1 to 4,096 Hits', () => {
    expect(parseReplaceArgs({ find: FIND_SDA, with: 'I2C_SDA', targets: 'all' })).toEqual({ find: FIND_SDA, with: 'I2C_SDA', targets: 'all' });
    expect(parseReplaceArgs({ find: FIND_SDA, with: '', targets: [SDA] })).toEqual({ find: FIND_SDA, with: '', targets: [SDA] });
    expect(parseReplaceArgs({ find: FIND_SDA, with: 'x', targets: Array.from({ length: HITS_MAX }, () => SDA) })).not.toBeNull();
    for (const bad of [
      null, {}, { find: FIND_SDA, with: 'x' }, { find: FIND_SDA, with: 'x', targets: 'all', extra: 1 }, { find: FIND_GND, with: 'x', targets: 'all' },
      { find: { ...FIND_SDA, text: '' }, with: 'x', targets: 'all' }, { find: FIND_SDA, with: 'x'.repeat(257), targets: 'all' },
      { find: FIND_SDA, with: 'a\0', targets: 'all' }, { find: FIND_SDA, with: 3, targets: 'all' }, { find: FIND_SDA, with: 'x', targets: 'ALL' },
      { find: FIND_SDA, with: 'x', targets: [] }, { find: FIND_SDA, with: 'x', targets: [{ ...SDA, uuid: 'x' }] },
      { find: FIND_SDA, with: 'x', targets: Array.from({ length: HITS_MAX + 1 }, () => SDA) },
    ]) {
      expect(parseReplaceArgs(bad), JSON.stringify(bad)?.slice(0, 80)).toBeNull();
    }
  });
});

describe('the engine\'s answers read closed', () => {
  it('kicadFind: hits and truncated, at most 4,096 hits; anything else null', () => {
    expect(readFindResult(JSON.stringify({ hits: [R4], truncated: false }))).toEqual({ hits: [R4], truncated: false });
    expect(readFindResult(JSON.stringify({ hits: [], truncated: true }))).toEqual({ hits: [], truncated: true });
    for (const bad of ['', '{', '[]', JSON.stringify({ hits: [] }), JSON.stringify({ hits: [R4], truncated: 'no' }), JSON.stringify({ hits: [R4], truncated: false, more: 1 }),
      JSON.stringify({ hits: [{ ...R4, kind: 'x' }], truncated: false }), JSON.stringify({ hits: Array.from({ length: HITS_MAX + 1 }, () => R4), truncated: true })]) {
      expect(readFindResult(bad), bad.slice(0, 60)).toBeNull();
    }
  });
  it('the replace: null until the done record, the counts once both records are there, no_match for nothing replaced, bad for any other shape', () => {
    const done = enc({ error: '', message: '' });
    expect(readReplaceDone(null, enc({ replaced: 6, skipped: 0, depth: 3 }))).toBeNull();
    expect(readReplaceDone(done, enc({ replaced: 6, skipped: 1, depth: 3 }))).toEqual({ report: { replaced: 6, skipped: 1, depth: 3 } });
    expect(readReplaceDone(enc({ error: 'no_match', message: '' }), enc({ replaced: 0, skipped: 2, depth: 2 }))).toEqual({ error: 'no_match' });
    for (const [d, r] of [
      [enc('{'), enc({ replaced: 1, skipped: 0, depth: 1 })], [enc({ error: 'other', message: '' }), enc({ replaced: 1, skipped: 0, depth: 1 })],
      [enc({ error: '' }), enc({ replaced: 1, skipped: 0, depth: 1 })], [done, null], [done, enc('{')], [done, enc({ replaced: 1, skipped: 0 })],
      [done, enc({ replaced: 1, skipped: 0, depth: 1, run: 1 })], [done, enc({ replaced: -1, skipped: 0, depth: 1 })], [done, enc({ replaced: 0, skipped: 0, depth: 1 })],
      [enc({ error: 'no_match', message: '' }), enc({ replaced: 2, skipped: 0, depth: 1 })],
    ] as Array<[Uint8Array, Uint8Array | null]>) {
      expect(readReplaceDone(d, r)).toEqual({ error: 'bad' });
    }
  });
});

describe('find on an engine with the export', () => {
  const run = unit.ops.find.run;
  it('sends the args as given to kicadFind and answers its hits in a sch frame and in a pcb frame', async () => {
    const sch = fakeCtx({ find: () => JSON.stringify({ hits: [R4], truncated: false }) });
    expect(await run(FIND_R4, sch.ctx)).toEqual({ ok: true, result: { hits: [R4], truncated: false } });
    expect(sch.finds).toEqual([FIND_R4]);
    const net = { ...R4, sheetPath: '', kind: 'net', ref: '', field: '', text: 'GND', length: 3 };
    const pcb = fakeCtx({ frame: 'pcb', find: () => JSON.stringify({ hits: [net], truncated: true }) });
    expect(await run(FIND_GND, pcb.ctx)).toEqual({ ok: true, result: { hits: [net], truncated: true } });
    expect(pcb.finds).toEqual([FIND_GND]);
  });
  it('a face of the other frame, or any other bad args, is bad_args before the engine is asked', async () => {
    const f = fakeCtx({ frame: 'pcb' });
    expect(await run(FIND_R4, f.ctx)).toEqual({ ok: false, code: 'bad_args', message: 'find' });
    expect(await run({ ...FIND_GND, text: '' }, f.ctx)).toEqual({ ok: false, code: 'bad_args', message: 'find' });
    expect(f.finds).toEqual([]);
  });
  it('the gate answers first: busy, then nothing asked', async () => {
    const f = fakeCtx({ gate: 'find' });
    expect(await run(FIND_R4, f.ctx)).toEqual({ ok: false, code: 'busy', message: 'find' });
    expect(f.finds).toEqual([]);
  });
  it('an empty answer for a regular expression is a pattern the engine cannot compile; otherwise, another shape or a throw, island_error', async () => {
    const regex = fakeCtx({ find: () => '' });
    expect(await run({ ...FIND_R4, wholeWord: false, regex: true, text: '(' }, regex.ctx)).toEqual({ ok: false, code: 'bad_args', message: BAD_PATTERN });
    expect(await run(FIND_R4, regex.ctx)).toEqual({ ok: false, code: 'island_error', message: 'the engine refused the find' });
    const odd = fakeCtx({ find: () => JSON.stringify({ hits: 'R4', truncated: false }) });
    expect(await run(FIND_R4, odd.ctx)).toEqual({ ok: false, code: 'island_error', message: 'the engine answered hits of another shape' });
    const thrown = fakeCtx({ find: () => { throw new Error('boom'); } });
    expect(await run(FIND_R4, thrown.ctx)).toEqual({ ok: false, code: 'island_error', message: 'boom' });
  });
});

describe('find.replace on an engine with the exports', () => {
  const run = unit.ops['find.replace'].run;
  it('runs in a fresh /tmp/cc-replace/<n> with every target, answers replaced and skipped, removes the folder', async () => {
    const f = fakeCtx({ engine: replacing(6, 0, 4) });
    expect(await run({ find: FIND_SDA, with: 'I2C_SDA', targets: 'all' }, f.ctx)).toEqual({ ok: true, result: { replaced: 6, skipped: 0 } });
    expect(f.made).toEqual([`${REPLACE_ROOT}/1`]);
    expect(f.calls).toEqual([{ run: 1, dir: `${REPLACE_ROOT}/1`, find: FIND_SDA, with: 'I2C_SDA', targets: 'all' }]);
    expect(f.dropped).toEqual([`${REPLACE_ROOT}/1`]);
    expect(f.files.size).toBe(0);
  });
  it('sends the hits back as targets; one no longer found is counted in skipped', async () => {
    const f = fakeCtx({ engine: replacing(1, 1, 2) });
    expect(await run({ find: FIND_SDA, with: 'X', targets: [SDA, { ...SDA, uuid: '2a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' }] }, f.ctx)).toEqual({ ok: true, result: { replaced: 1, skipped: 1 } });
    expect(f.calls[0].targets).toHaveLength(2);
  });
  it('nothing replaced answers no_match; another shape island_error; a refused run not_applied; a throw island_error; the folder always gone', async () => {
    const none = fakeCtx({ engine: replacing(0, 0, 2) });
    expect(await run({ find: FIND_SDA, with: 'X', targets: 'all' }, none.ctx)).toEqual({ ok: false, code: 'no_match', message: 'find.replace' });
    const odd = fakeCtx({ engine: (a, files) => { files.set(`${a.dir as string}/.cc-replace.json`, enc({ error: '', message: '' })); return true; } });
    expect(await run({ find: FIND_SDA, with: 'X', targets: 'all' }, odd.ctx)).toEqual({ ok: false, code: 'island_error', message: 'the engine answered a replace of another shape' });
    const refusedRun = fakeCtx({ engine: () => false });
    expect(await run({ find: FIND_SDA, with: 'X', targets: 'all' }, refusedRun.ctx)).toEqual({ ok: false, code: 'not_applied', message: 'find.replace' });
    const thrown = fakeCtx({ engine: () => { throw new Error('boom'); } });
    expect(await run({ find: FIND_SDA, with: 'X', targets: 'all' }, thrown.ctx)).toEqual({ ok: false, code: 'island_error', message: 'boom' });
    const late = fakeCtx({ engine: replacing(1, 0, 1), idle: () => false });
    expect(await run({ find: FIND_SDA, with: 'X', targets: 'all' }, late.ctx)).toEqual({ ok: false, code: 'not_applied', message: 'find.replace' });
    for (const f of [none, odd, refusedRun, thrown, late]) {
      expect(f.dropped).toEqual(f.made);
      expect(f.files.size).toBe(0);
    }
  });
  it('the checks answer before any folder is made: bad args, the frame, then the gate', async () => {
    const busy = fakeCtx({ engine: replacing(1, 0, 1), gate: 'find.replace' });
    expect(await run({ find: FIND_SDA, with: 'X', targets: 'all' }, busy.ctx)).toEqual({ ok: false, code: 'busy', message: 'find.replace' });
    expect(await run({ find: FIND_SDA, with: 'X' }, busy.ctx)).toEqual({ ok: false, code: 'bad_args', message: 'find.replace' });
    const pcb = fakeCtx({ frame: 'pcb', engine: replacing(1, 0, 1) });
    expect(await run({ find: FIND_SDA, with: 'X', targets: 'all' }, pcb.ctx)).toEqual({ ok: false, code: 'unsupported', message: 'a replace runs in a sch frame' });
    for (const f of [busy, pcb]) {
      expect(f.made).toEqual([]);
      expect(f.calls).toEqual([]);
    }
  });
});
