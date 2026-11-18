// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-ses-i: board.session, its cap session feature detected on the engine's
// kicadImportSession, the args and the engine's records read closed, the
// staging folder under /tmp/cc-stage and the run folder under /tmp/cc-session
// removed after every answer, and the held Import Specctra Session. The engine
// here is this test's own module of exports (at the protocol boundary); the
// real engine is the e2e's (tests/e2e/st/st-ses-i.spec.ts, engine run 15).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HELD_ACTIONS, heldTaken } from '../held';
import { startResponder } from '../responder';
import type { ExtUnit, ResponderCtx } from './contract';
import { buildRegistry, heldActions, REGISTRY } from './registry';
import unit, {
  IMPORT_SESSION, parseSessionArgs, readSessionDone, SESSION_CAP, SESSION_EXPORTS, SESSION_MAX_BYTES, SESSION_ROOT, SESSION_ROW, sessionLine, STAGE_ROOT,
  UNREADABLE_SESSION,
} from './st-ses-i';

const PARENT = 'http://localhost';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));
const enc = (v: unknown): Uint8Array => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v));
const RUN15 = { kicadImportSession: () => false, kicadCollabBusy: () => false };
const SES = new TextEncoder().encode('(session "business-card.ses" (base_design "business-card.dsn"))');

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

/**
 * A ResponderCtx over a fake board engine and a fake MEMFS: the folders the
 * op makes and drops are recorded, `engine` plays kicadImportSession (its
 * records written into the run folder it is given).
 */
function fakeCtx(engine: (a: Record<string, unknown>, files: Map<string, Uint8Array>) => unknown, opts: { idle?: () => boolean; gate?: string } = {}) {
  const files = new Map<string, Uint8Array>();
  const made: string[] = [];
  const dropped: string[] = [];
  const calls: Array<Record<string, unknown>> = [];
  let n = 0;
  const mod: Record<string, unknown> = {
    ...RUN15,
    kicadImportSession: (json: string) => { const a = JSON.parse(json) as Record<string, unknown>; calls.push(a); return engine(a, files); },
  };
  const ctx = {
    frame: 'pcb',
    root: '/project',
    timing: { sessionMs: 200, applyPollMs: 5 },
    mod: () => mod,
    fs: () => ({ writeFile: (p: string, b: Uint8Array) => { files.set(p, b); } }),
    closed: () => false,
    boardGate: (_op: string, exports: readonly string[]) => {
      if (opts.gate != null) return { ok: false, code: 'busy', message: opts.gate };
      for (const name of exports) if (typeof mod[name] !== 'function') return { ok: false, code: 'unsupported', message: name };
      return { w: {}, mod };
    },
    freshRunFolder: (root: string) => { n += 1; const d = `${root}/${n}`; made.push(d); return d; },
    dropRunFolder: (dir: string) => { dropped.push(dir); for (const k of [...files.keys()]) if (k.startsWith(`${dir}/`)) files.delete(k); },
    readBytes: (abs: string) => files.get(abs) ?? null,
    queuedRun: async (op: string, dir: string, ms: number, call: () => unknown, record: () => unknown) => {
      if (call() !== true) { dropped.push(dir); return { ok: false, code: 'not_applied', message: op }; }
      const deadline = Date.now() + ms;
      for (;;) {
        if ((opts.idle ?? (() => true))()) { const done = record(); if (done != null) return { done }; }
        if (Date.now() >= deadline) { dropped.push(dir); return { ok: false, code: 'not_applied', message: op }; }
        await settle(5);
      }
    },
    log: () => {},
  } as unknown as ResponderCtx;
  return { ctx, files, made, dropped, calls };
}

const LINES = [{ severity: 'info', text: 'Session file imported and merged OK.' }];
const PREVIEW = { preview: true, tracks: 5, vias: 1, nets: 3, missingNets: ['/NFC_ANT'], undoCleared: false, depth: 0 };
const APPLY = { ...PREVIEW, preview: false, removed: { tracks: 0, vias: 0 }, added: { tracks: 5, vias: 1 }, depth: 1 };
const record = (run: unknown, r: Record<string, unknown>) => ({ run, ...r, lines: LINES });

/** An engine that answers as kicadImportSession does: the report, then the done record LAST. */
const goodEngine = (a: Record<string, unknown>, files: Map<string, Uint8Array>) => {
  const dir = a.dir as string;
  files.set(`${dir}/session.json`, enc(record(a.run, a.preview === true ? PREVIEW : APPLY)));
  files.set(`${dir}/.cc-session.json`, enc({ error: '', message: '', lines: LINES }));
  return true;
};

describe('st-ses-i in the registry', () => {
  it('loads in this checkout with nothing broken, owning board.session and the cap session', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect(REGISTRY.ops.get('board.session')?.unit).toBe('st-ses-i');
    expect(REGISTRY.pending.has('board.session')).toBe(false);
    expect(REGISTRY.capNames.get(SESSION_CAP)).toBe('st-ses-i');
    expect(SESSION_CAP).toBe('session');
  });

  it('lists session in a pcb frame on an engine with kicadImportSession and kicadCollabBusy, nothing on run 14 or in a sch frame', () => {
    expect([...SESSION_EXPORTS]).toEqual(['kicadImportSession', 'kicadCollabBusy']);
    expect(unit.caps(RUN15, 'pcb')).toEqual(['session']);
    expect(unit.caps(RUN15, 'sch')).toEqual([]);
    expect(unit.caps(RUN15, 'symedit')).toEqual([]);
    expect(unit.caps({ kicadCollabBusy: () => false }, 'pcb')).toEqual([]);
    expect(unit.caps({}, 'pcb')).toEqual([]);
  });

  it('a pcb frame on run 14 lists no session cap and answers board.session unsupported naming the export; bad args first', async () => {
    const s = await boot('pcb', { kicadCollabBusy: () => false });
    expect(s.ready?.caps).not.toContain('session');
    expect(await s.ask(1, 'board.session', { name: 'business-card.ses', bytes: SES, preview: true })).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'kicadImportSession' } });
    expect(await s.ask(2, 'board.session', { name: 'business-card.dsn', bytes: SES, preview: true })).toMatchObject({ ok: false, error: { code: 'bad_args', message: 'board.session' } });
  });

  it('a pcb frame on run 15 lists session and answers not_ready with no board open; a sch frame lists none and refuses the op', async () => {
    const pcb = await boot('pcb', RUN15);
    expect(pcb.ready?.caps).toContain('session');
    expect(await pcb.ask(1, 'board.session', { name: 'business-card.ses', bytes: SES, preview: true })).toMatchObject({ ok: false, error: { code: 'not_ready', message: 'board.session' } });
    const sch = await boot('sch', RUN15);
    expect(sch.ready?.caps).not.toContain('session');
    expect(await sch.ask(1, 'board.session', { name: 'business-card.ses', bytes: SES, preview: true })).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'a router session is read in a pcb frame' } });
  });
});

describe('the held Import Specctra Session', () => {
  const union = heldActions(buildRegistry(mods(unit)));
  it('holds exactly KiCad\'s Import Specctra Session, in a pcb frame under the cap session, no built in row holding it', () => {
    expect(unit.held).toEqual([IMPORT_SESSION]);
    expect(IMPORT_SESSION).toBe('pcbnew.EditorControl.importSpecctraSession');
    expect(unit.heldRows).toEqual([SESSION_ROW]);
    expect({ ...SESSION_ROW, frames: [...SESSION_ROW.frames] }).toEqual({ action: IMPORT_SESSION, frames: ['pcb'], cap: 'session' });
    expect(HELD_ACTIONS.some((h) => h.action === IMPORT_SESSION)).toBe(false);
    expect(heldActions()).toContainEqual(SESSION_ROW);
  });
  it('the responder takes it only in a pcb frame whose ev.ready listed session', () => {
    expect(heldTaken(IMPORT_SESSION, 'pcb', ['session'], union)).toBe(true);
    expect(heldTaken(IMPORT_SESSION, 'pcb', ['heldKeys'], union)).toBe(false);
    expect(heldTaken(IMPORT_SESSION, 'sch', ['session'], union)).toBe(false);
  });
});

describe('the args', () => {
  it('takes exactly a .ses name, 1 byte to 25 MiB and preview', () => {
    expect(parseSessionArgs({ name: 'business-card.ses', bytes: SES, preview: true })).toEqual({ name: 'business-card.ses', bytes: SES, preview: true });
    expect(parseSessionArgs({ name: 'ROUTED.SES', bytes: SES, preview: false })).toEqual({ name: 'ROUTED.SES', bytes: SES, preview: false });
    for (const bad of [
      {}, { name: 'a.ses', bytes: SES }, { name: 'a.ses', bytes: SES, preview: 1 }, { name: 'a.ses', bytes: SES, preview: true, x: 1 },
      { name: 'a.dsn', bytes: SES, preview: true }, { name: '.ses', bytes: SES, preview: true }, { name: 'a/b.ses', bytes: SES, preview: true },
      { name: 'a\\b.ses', bytes: SES, preview: true }, { name: 'a\0.ses', bytes: SES, preview: true }, { name: '..ses', bytes: SES, preview: true },
      { name: `${'é'.repeat(126)}.ses`, bytes: SES, preview: true }, { name: 'a.ses', bytes: SES.buffer, preview: true },
      { name: 'a.ses', bytes: new Uint8Array(), preview: true }, { name: 'a.ses', bytes: new Uint8Array(SESSION_MAX_BYTES + 1), preview: true },
      { name: 'a.ses', bytes: [1, 2], preview: true }, null, [],
    ]) {
      expect(parseSessionArgs(bad), JSON.stringify(bad)?.slice(0, 60)).toBeNull();
    }
  });
});

describe('the engine\'s records read closed', () => {
  const R = 4;
  it('waits (null) until the done record is there', () => {
    expect(readSessionDone(null, null, R, true)).toBeNull();
    expect(readSessionDone(null, enc(record(R, PREVIEW)), R, true)).toBeNull();
  });
  it('a preview: the counts and the missing nets, nothing removed or added', () => {
    expect(readSessionDone(enc({ error: '', message: '', lines: [] }), enc(record(R, PREVIEW)), R, true)).toEqual({ report: PREVIEW });
  });
  it('an apply: the counts, removed and added, the undo depth', () => {
    expect(readSessionDone(enc({ error: '', message: '', lines: LINES }), enc(record(R, APPLY)), R, false)).toEqual({ report: APPLY });
  });
  it('session_invalid and island_error carry the engine\'s message', () => {
    expect(readSessionDone(enc({ error: 'session_invalid', message: 'Reference \'X\' not found.', lines: [] }), null, R, true)).toEqual({ error: 'session_invalid', message: 'Reference \'X\' not found.' });
    expect(readSessionDone(enc({ error: 'island_error', message: 'no board editor', lines: [] }), null, R, false)).toEqual({ error: 'island_error', message: 'no board editor' });
  });
  it('any other shape is a bad record: another run, another form, a missing report, a key too many or too few', () => {
    const done = enc({ error: '', message: '', lines: [] });
    for (const [d, rep, preview] of [
      [enc('{'), enc(record(R, PREVIEW)), true], [enc({ error: 'other', message: '', lines: [] }), null, true], [enc({ error: '', lines: [] }), enc(record(R, PREVIEW)), true],
      [done, null, true], [done, enc('{'), true], [done, enc(record(R + 1, PREVIEW)), true], [done, enc(record(R, PREVIEW)), false], [done, enc(record(R, APPLY)), true],
      [done, enc(record(R, { ...PREVIEW, extra: 1 })), true], [done, enc(record(R, { ...APPLY, added: undefined })), false],
      [done, enc(record(R, { ...PREVIEW, tracks: -1 })), true], [done, enc(record(R, { ...PREVIEW, vias: 1.5 })), true],
      [done, enc(record(R, { ...PREVIEW, missingNets: [''] })), true], [done, enc(record(R, { ...PREVIEW, missingNets: Array.from({ length: 257 }, (_, i) => `n${i}`) })), true],
      [done, enc(record(R, { ...PREVIEW, undoCleared: 'no' })), true], [done, enc(record(R, { ...APPLY, removed: { tracks: 1 } })), false],
      [done, enc({ run: R, ...PREVIEW, lines: 'x' }), true],
    ] as Array<[Uint8Array, Uint8Array | null, boolean]>) {
      expect(readSessionDone(d, rep, R, preview)).toEqual({ error: 'bad' });
    }
  });
  it('KiCad\'s line: the first line, no folder of the frame named, at most 1,024 characters, ours when empty', () => {
    const stage = `${STAGE_ROOT}/3`;
    const dir = `${SESSION_ROOT}/4`;
    expect(sessionLine(`Expecting ')' in '${stage}/corrupt.ses', line 9, offset 1.\nfrom pcbnew`, [stage, dir])).toBe('Expecting \')\' in \'corrupt.ses\', line 9, offset 1.');
    expect(sessionLine(`Unable to read ${dir}/x and ${stage}`, [stage, dir])).toBe('Unable to read x and');
    expect(sessionLine('Bad /tmp/cc-stage/77/other.ses here', [stage, dir])).toBe('Bad other.ses here');
    expect(sessionLine('', [stage, dir])).toBe(UNREADABLE_SESSION);
    expect(sessionLine('\n\nsecond', [stage, dir])).toBe(UNREADABLE_SESSION);
    expect([...sessionLine('x'.repeat(5000), [stage, dir])]).toHaveLength(1024);
  });
});

describe('board.session on an engine with the export', () => {
  const run = unit.ops['board.session'].run;

  it('stages the bytes under a fresh /tmp/cc-stage/<n>/, runs the session in a fresh /tmp/cc-session/<m>, answers the preview, removes both folders', async () => {
    const f = fakeCtx(goodEngine);
    expect(await run({ name: 'business-card.ses', bytes: SES, preview: true }, f.ctx)).toEqual({ ok: true, result: PREVIEW });
    expect(f.made).toEqual([`${STAGE_ROOT}/1`, `${SESSION_ROOT}/2`]);
    expect(f.calls).toEqual([{ run: 2, dir: `${SESSION_ROOT}/2`, path: `${STAGE_ROOT}/1/business-card.ses`, preview: true }]);
    expect([...f.dropped].sort()).toEqual([`${SESSION_ROOT}/2`, `${STAGE_ROOT}/1`]);
    expect(f.files.size).toBe(0);
  });

  it('an apply answers what was removed and added and the undo depth; an upper case name is staged as .ses', async () => {
    const f = fakeCtx(goodEngine);
    expect(await run({ name: 'ROUTED.SES', bytes: SES, preview: false }, f.ctx)).toEqual({ ok: true, result: APPLY });
    expect(f.calls[0]).toEqual({ run: 2, dir: `${SESSION_ROOT}/2`, path: `${STAGE_ROOT}/1/ROUTED.ses`, preview: false });
    expect(f.files.size).toBe(0);
  });

  it('a session KiCad cannot read answers session_invalid with KiCad\'s first line and no path, both folders gone', async () => {
    const f = fakeCtx((a, files) => {
      const msg = `Expecting ')' in input/source '${a.path as string}', line 31, offset 3.\nmore`;
      files.set(`${a.dir as string}/.cc-session.json`, enc({ error: 'session_invalid', message: msg, lines: [{ severity: 'error', text: msg }] }));
      return true;
    });
    const got = await run({ name: 'corrupt.ses', bytes: SES, preview: true }, f.ctx);
    expect(got).toEqual({ ok: false, code: 'session_invalid', message: 'Expecting \')\' in input/source \'corrupt.ses\', line 31, offset 3.' });
    expect(JSON.stringify(got)).not.toContain('/tmp');
    expect(f.dropped).toEqual(expect.arrayContaining([`${STAGE_ROOT}/1`, `${SESSION_ROOT}/2`]));
    expect(f.files.size).toBe(0);
  });

  it('the engine\'s island_error passes; a record of another shape is island_error; a refused run not_applied; every folder gone', async () => {
    const ie = fakeCtx((a, files) => { files.set(`${a.dir as string}/.cc-session.json`, enc({ error: 'island_error', message: 'no board editor', lines: [] })); return true; });
    expect(await run({ name: 'a.ses', bytes: SES, preview: false }, ie.ctx)).toEqual({ ok: false, code: 'island_error', message: 'no board editor' });
    const odd = fakeCtx((a, files) => { files.set(`${a.dir as string}/.cc-session.json`, enc({ error: '', message: '', lines: [] })); return true; });
    expect(await run({ name: 'a.ses', bytes: SES, preview: true }, odd.ctx)).toEqual({ ok: false, code: 'island_error', message: 'the engine answered a session of another shape' });
    const refused = fakeCtx(() => false);
    expect(await run({ name: 'a.ses', bytes: SES, preview: true }, refused.ctx)).toEqual({ ok: false, code: 'not_applied', message: 'board.session' });
    const thrown = fakeCtx(() => { throw new Error('boom'); });
    expect(await run({ name: 'a.ses', bytes: SES, preview: true }, thrown.ctx)).toEqual({ ok: false, code: 'island_error', message: 'boom' });
    for (const f of [ie, odd, refused, thrown]) {
      expect(f.dropped).toEqual(expect.arrayContaining(f.made));
      expect(f.files.size).toBe(0);
    }
  });

  it('answers not_applied past its bound when the apply queue never empties, the folders gone', async () => {
    const f = fakeCtx(goodEngine, { idle: () => false });
    expect(await run({ name: 'a.ses', bytes: SES, preview: false }, f.ctx)).toEqual({ ok: false, code: 'not_applied', message: 'board.session' });
    expect(f.dropped).toEqual(expect.arrayContaining(f.made));
    expect(f.files.size).toBe(0);
  });

  it('the gate answers before anything is staged: bad args, then the board gate', async () => {
    const f = fakeCtx(goodEngine, { gate: 'board.session' });
    expect(await run({ name: 'a.ses', bytes: SES, preview: true }, f.ctx)).toEqual({ ok: false, code: 'busy', message: 'board.session' });
    expect(await run({ name: 'a.txt', bytes: SES, preview: true }, f.ctx)).toEqual({ ok: false, code: 'bad_args', message: 'board.session' });
    expect(f.made).toEqual([]);
    expect(f.calls).toEqual([]);
  });
});
