// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// lo-e4-i: board.padNets and sch.renameNets, their caps boardPadNets and
// renameNets feature detected on the engine's kicadBoardPadNets and
// kicadSchRenameNets, every arg and every engine answer read closed, the run
// folder under /tmp/cc-renameNets removed after every answer. The engine here
// is this test's own module of exports (at the protocol boundary); the real
// engine is the e2e's (tests/e2e/lo/rename-nets.spec.ts, engine run 15).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startResponder } from '../responder';
import type { ExtUnit, ResponderCtx } from './contract';
import { buildRegistry, REGISTRY } from './registry';
import unit, {
  PAD_NETS_CAP, PAD_NETS_EXPORTS, PADS_MAX, parseRenameNetsArgs, readPadNets, readRenameNetsRecord, RENAME_NETS_CAP, RENAME_NETS_EXPORTS, RENAME_ROOT, TEXT_MAX,
} from './lo-e4-i';

const PARENT = 'http://localhost';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));
const enc = (v: unknown): Uint8Array => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v));
const RUN15 = { kicadBoardPadNets: () => '', kicadSchRenameNets: () => false, kicadCollabBusy: () => false };
const LABEL = 'cc0e4a11-0000-4000-8000-000000000c10';
const PADS = [{ ref: 'R1', pad: '2', net: 'DATA' }, { ref: 'R2', pad: '1', net: 'DATA' }];
const ROW = { ref: 'R1', pin: '2', from: 'SIG', to: 'DATA', sheetPath: '/', outcome: 'rename', label: LABEL };
const PREVIEW = { preview: true, rows: [ROW], applied: 0, truncated: false, depth: 0 };
const APPLY = { preview: false, rows: [ROW], applied: 1, truncated: false, depth: 1 };

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
 * dropped are recorded; `engine` plays kicadSchRenameNets (its record written
 * into the run folder it is given), `pads` kicadBoardPadNets.
 */
function fakeCtx(opts: { engine?: (a: Record<string, unknown>, files: Map<string, Uint8Array>) => unknown; pads?: () => unknown; idle?: () => boolean; gate?: string; frame?: string } = {}) {
  const files = new Map<string, Uint8Array>();
  const made: string[] = [];
  const dropped: string[] = [];
  const calls: Array<Record<string, unknown>> = [];
  let n = 0;
  const mod: Record<string, unknown> = {
    ...RUN15,
    kicadBoardPadNets: () => (opts.pads ?? (() => JSON.stringify({ pads: PADS, truncated: false })))(),
    kicadSchRenameNets: (json: string) => { const a = JSON.parse(json) as Record<string, unknown>; calls.push(a); return (opts.engine ?? (() => false))(a, files); },
  };
  const gate = (want: string, refusal: string) => (_op: string, exports: readonly string[]) => {
    if ((opts.frame ?? want) !== want) return { ok: false, code: 'unsupported', message: refusal };
    if (opts.gate != null) return { ok: false, code: 'busy', message: opts.gate };
    for (const name of exports) if (typeof mod[name] !== 'function') return { ok: false, code: 'unsupported', message: name };
    return { w: {}, mod };
  };
  const ctx = {
    frame: opts.frame ?? 'sch',
    root: '/project',
    timing: { renameNetsMs: 200, applyPollMs: 5 },
    mod: () => mod,
    closed: () => false,
    boardGate: gate('pcb', 'a board op runs in a pcb frame'),
    schematicGate: gate('sch', 'a schematic edits in a sch frame'),
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

/** An engine that answers as kicadSchRenameNets does: the record written last, `body` per preview. */
const engineOf = (body: (preview: boolean) => unknown) => (a: Record<string, unknown>, files: Map<string, Uint8Array>) => {
  files.set(`${a.dir as string}/renameNets.json`, enc(body(a.preview === true)));
  return true;
};
const goodEngine = engineOf((preview) => (preview ? PREVIEW : APPLY));

describe('lo-e4-i in the registry', () => {
  it('loads in this checkout with nothing broken, owning both ops and both caps', () => {
    expect(REGISTRY.problems).toEqual([]);
    for (const op of ['board.padNets', 'sch.renameNets']) {
      expect(REGISTRY.ops.get(op)?.unit).toBe('lo-e4-i');
      expect(REGISTRY.pending.has(op)).toBe(false);
    }
    expect(REGISTRY.capNames.get(PAD_NETS_CAP)).toBe('lo-e4-i');
    expect(REGISTRY.capNames.get(RENAME_NETS_CAP)).toBe('lo-e4-i');
    expect([PAD_NETS_CAP, RENAME_NETS_CAP]).toEqual(['boardPadNets', 'renameNets']);
    expect(unit.ops['board.padNets'].passesCheck).toBe(true);
    expect('passesCheck' in unit.ops['sch.renameNets']).toBe(false);
  });

  it('lists boardPadNets in a pcb frame with kicadBoardPadNets, renameNets in a sch frame with kicadSchRenameNets and kicadCollabBusy, nothing on run 14', () => {
    expect([...PAD_NETS_EXPORTS]).toEqual(['kicadBoardPadNets']);
    expect([...RENAME_NETS_EXPORTS]).toEqual(['kicadSchRenameNets', 'kicadCollabBusy']);
    expect(unit.caps(RUN15, 'pcb')).toEqual(['boardPadNets']);
    expect(unit.caps(RUN15, 'sch')).toEqual(['renameNets']);
    expect(unit.caps(RUN15, 'symedit')).toEqual([]);
    expect(unit.caps({ kicadSchRenameNets: () => false }, 'sch')).toEqual([]);
    expect(unit.caps({ kicadCollabBusy: () => false }, 'pcb')).toEqual([]);
    expect(unit.caps({}, 'sch')).toEqual([]);
  });

  it('run 14: neither cap is listed, each op answers unsupported naming its export; bad args first', async () => {
    const pcb = await boot('pcb', { kicadCollabBusy: () => false });
    expect(pcb.ready?.caps).not.toContain('boardPadNets');
    expect(await pcb.ask(1, 'board.padNets')).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'kicadBoardPadNets' } });
    expect(await pcb.ask(2, 'board.padNets', { x: 1 })).toMatchObject({ ok: false, error: { code: 'bad_args', message: 'board.padNets' } });
    const sch = await boot('sch', { kicadCollabBusy: () => false });
    expect(sch.ready?.caps).not.toContain('renameNets');
    expect(await sch.ask(1, 'sch.renameNets', { preview: true, pads: PADS })).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'kicadSchRenameNets' } });
    expect(await sch.ask(2, 'sch.renameNets', { preview: true, pads: [] })).toMatchObject({ ok: false, error: { code: 'bad_args', message: 'sch.renameNets' } });
  });

  it('run 15: each frame lists its own cap and refuses the other frame\'s op unsupported; not_ready with no document open', async () => {
    const pcb = await boot('pcb', RUN15);
    expect(pcb.ready?.caps).toContain('boardPadNets');
    expect(pcb.ready?.caps).not.toContain('renameNets');
    expect(await pcb.ask(1, 'board.padNets')).toMatchObject({ ok: false, error: { code: 'not_ready', message: 'board.padNets' } });
    expect(await pcb.ask(2, 'sch.renameNets', { preview: true, pads: PADS })).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'a schematic edits in a sch frame' } });
    const sch = await boot('sch', RUN15);
    expect(sch.ready?.caps).toContain('renameNets');
    expect(sch.ready?.caps).not.toContain('boardPadNets');
    expect(await sch.ask(1, 'sch.renameNets', { preview: false, pads: PADS })).toMatchObject({ ok: false, error: { code: 'not_ready', message: 'sch.renameNets' } });
    expect(await sch.ask(2, 'board.padNets')).toMatchObject({ ok: false, error: { code: 'unsupported' } });
  });

  it('a symbol editor frame refuses both ops with the unit\'s frame line', async () => {
    const sym = await boot('symedit', RUN15);
    for (const [id, op, args] of [[1, 'board.padNets', undefined], [2, 'sch.renameNets', { preview: true, pads: PADS }]] as const) {
      expect(await sym.ask(id, op, args)).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'board.padNets runs in a pcb frame, sch.renameNets in a sch frame' } });
    }
  });
});

describe('sch.renameNets args', () => {
  it('takes exactly preview and 1 to 32,768 pads of ref, pad and net', () => {
    expect(parseRenameNetsArgs({ preview: true, pads: PADS })).toEqual({ preview: true, pads: PADS });
    expect(parseRenameNetsArgs({ preview: false, pads: [{ ref: 'U1', pad: 'EP', net: '/Power/+3V3' }] })).toEqual({ preview: false, pads: [{ ref: 'U1', pad: 'EP', net: '/Power/+3V3' }] });
    const many = Array.from({ length: PADS_MAX }, (_, i) => ({ ref: `R${i}`, pad: '1', net: 'N' }));
    expect(parseRenameNetsArgs({ preview: true, pads: many })?.pads).toHaveLength(PADS_MAX);
    const long = 'é'.repeat(TEXT_MAX);
    expect(parseRenameNetsArgs({ preview: true, pads: [{ ref: long, pad: long, net: long }] })).not.toBeNull();
  });

  it('refuses every other count, key and string', () => {
    const pad = (p: Record<string, unknown>) => ({ preview: true, pads: [{ ref: 'R1', pad: '1', net: 'N', ...p }] });
    for (const bad of [
      undefined, null, [], {}, { preview: true }, { pads: PADS }, { preview: 1, pads: PADS }, { preview: 'yes', pads: PADS },
      { preview: true, pads: PADS, run: 1 }, { preview: true, pads: PADS, dir: '/tmp/cc-renameNets/1' },
      { preview: true, pads: [] }, { preview: true, pads: {} }, { preview: true, pads: 'R1' },
      { preview: true, pads: Array.from({ length: PADS_MAX + 1 }, () => ({ ref: 'R1', pad: '1', net: 'N' })) },
      { preview: true, pads: [null] }, { preview: true, pads: [['R1', '1', 'N']] },
      { preview: true, pads: [{ ref: 'R1', pad: '1' }] }, { preview: true, pads: [{ ref: 'R1', net: 'N' }] }, { preview: true, pads: [{ pad: '1', net: 'N' }] },
      pad({ x: 1 }), pad({ ref: '' }), pad({ pad: '' }), pad({ net: '' }), pad({ ref: 1 }), pad({ pad: 2 }), pad({ net: null }),
      pad({ ref: 'x'.repeat(TEXT_MAX + 1) }), pad({ pad: 'é'.repeat(TEXT_MAX + 1) }), pad({ net: 'N'.repeat(TEXT_MAX + 1) }),
      pad({ net: 'A\nB' }), pad({ ref: 'R\u00001' }), pad({ pad: '1\t' }), pad({ net: '\u007f' }),
    ]) {
      expect(parseRenameNetsArgs(bad), JSON.stringify(bad)?.slice(0, 80)).toBeNull();
    }
  });
});

describe('the engine\'s answers read closed', () => {
  it('kicadBoardPadNets: the rows and truncated; a row with no reference or pad number left out', () => {
    expect(readPadNets(JSON.stringify({ pads: PADS, truncated: false }))).toEqual({ pads: PADS, truncated: false });
    expect(readPadNets(JSON.stringify({ pads: [], truncated: true }))).toEqual({ pads: [], truncated: true });
    expect(readPadNets(JSON.stringify({ pads: [{ ref: 'U1', pad: '', net: 'GND' }, ...PADS, { ref: '', pad: '1', net: 'X' }], truncated: false }))).toEqual({ pads: PADS, truncated: false });
  });

  it('kicadBoardPadNets: any other shape is refused', () => {
    for (const bad of [
      '', '{', 'null', '[]', 1, null, JSON.stringify({ pads: PADS }), JSON.stringify({ truncated: false }), JSON.stringify({ pads: PADS, truncated: 'no' }),
      JSON.stringify({ pads: PADS, truncated: false, x: 1 }), JSON.stringify({ pads: {}, truncated: false }),
      JSON.stringify({ pads: [{ ref: 'R1', pad: '1' }], truncated: false }), JSON.stringify({ pads: [{ ref: 'R1', pad: '1', net: '' }], truncated: false }),
      JSON.stringify({ pads: [{ ref: 'R1', pad: '1', net: 'N', x: 1 }], truncated: false }), JSON.stringify({ pads: [{ ref: 'R1', pad: 1, net: 'N' }], truncated: false }),
      JSON.stringify({ pads: Array.from({ length: PADS_MAX + 1 }, () => ({ ref: 'R1', pad: '1', net: 'N' })), truncated: true }),
    ]) {
      expect(readPadNets(bad), String(bad).slice(0, 80)).toBeNull();
    }
  });

  it('renameNets.json: waits (null) until it is there; a preview and an apply', () => {
    expect(readRenameNetsRecord(null, true, 2)).toBeNull();
    expect(readRenameNetsRecord(enc(PREVIEW), true, 2)).toEqual(PREVIEW);
    expect(readRenameNetsRecord(enc(APPLY), false, 2)).toEqual(APPLY);
    const add = { ref: 'R2', pin: '1', from: 'Net-(R1-Pad2)', to: 'DATA', sheetPath: '/cc0e4a11-0000-4000-8000-000000000a50/', outcome: 'add', label: LABEL };
    const refusedRow = { ref: 'R3', pin: '1', from: 'GND', to: 'AGND', sheetPath: '/', outcome: 'refused' };
    const both = { preview: false, rows: [add, refusedRow], applied: 1, truncated: false, depth: 4 };
    expect(readRenameNetsRecord(enc(both), false, 2)).toEqual(both);
    const noLabel = { ...PREVIEW, rows: [{ ...ROW, label: undefined, from: '' }].map(({ label: _l, ...r }) => r) };
    expect(readRenameNetsRecord(enc(noLabel), true, 1)).toEqual(noLabel);
  });

  it('renameNets.json: any other shape is bad', () => {
    for (const [body, preview, pads] of [
      ['{', true, 2], [[], true, 2], [{ ...PREVIEW, preview: false }, true, 2], [APPLY, true, 2], [{ ...PREVIEW, x: 1 }, true, 2],
      [{ preview: true, rows: [], applied: 0, truncated: false }, true, 2], [{ ...PREVIEW, applied: 1 }, true, 2], [{ ...APPLY, applied: 2 }, false, 2],
      [{ ...PREVIEW, depth: -1 }, true, 2], [{ ...PREVIEW, depth: 1.5 }, true, 2], [{ ...PREVIEW, truncated: 0 }, true, 2], [{ ...PREVIEW, rows: {} }, true, 2],
      [{ ...PREVIEW, rows: [ROW, ROW, ROW] }, true, 2], [{ ...PREVIEW, rows: [{ ...ROW, outcome: 'moved' }] }, true, 2],
      [{ ...PREVIEW, rows: [{ ...ROW, label: 'not-a-uuid' }] }, true, 2], [{ ...PREVIEW, rows: [{ ...ROW, outcome: 'refused' }] }, true, 2],
      [{ ...PREVIEW, rows: [{ ...ROW, extra: 1 }] }, true, 2], [{ ...PREVIEW, rows: [{ ...ROW, to: '' }] }, true, 2], [{ ...PREVIEW, rows: [{ ...ROW, ref: '' }] }, true, 2],
      [{ ...PREVIEW, rows: [{ ...ROW, sheetPath: 'root' }] }, true, 2], [{ ...PREVIEW, rows: [{ ...ROW, pin: 2 }] }, true, 2],
      [{ ...APPLY, rows: [{ ...ROW, outcome: 'refused', label: undefined }].map(({ label: _l, ...r }) => r), applied: 1 }, false, 2],
    ] as Array<[unknown, boolean, number]>) {
      expect(readRenameNetsRecord(enc(body), preview, pads), JSON.stringify(body).slice(0, 80)).toBe('bad');
    }
  });
});

describe('board.padNets on an engine with the export', () => {
  const run = unit.ops['board.padNets'].run;
  it('answers the board\'s pads and their nets', async () => {
    const f = fakeCtx({ frame: 'pcb' });
    expect(await run(undefined, f.ctx)).toEqual({ ok: true, result: { pads: PADS, truncated: false } });
    expect(await run({}, f.ctx)).toEqual({ ok: true, result: { pads: PADS, truncated: false } });
  });
  it('bad args, then the gate; "" is busy; another shape or a throw is island_error', async () => {
    expect(await run({ all: true }, fakeCtx({ frame: 'pcb' }).ctx)).toEqual({ ok: false, code: 'bad_args', message: 'board.padNets' });
    expect(await run(undefined, fakeCtx({ frame: 'sch' }).ctx)).toEqual({ ok: false, code: 'unsupported', message: 'a board op runs in a pcb frame' });
    expect(await run(undefined, fakeCtx({ frame: 'pcb', gate: 'board.padNets' }).ctx)).toEqual({ ok: false, code: 'busy', message: 'board.padNets' });
    expect(await run(undefined, fakeCtx({ frame: 'pcb', pads: () => '' }).ctx)).toEqual({ ok: false, code: 'busy', message: 'board.padNets' });
    expect(await run(undefined, fakeCtx({ frame: 'pcb', pads: () => '{"pads":[]}' }).ctx)).toEqual({ ok: false, code: 'island_error', message: 'the engine answered pad nets of another shape' });
    expect(await run(undefined, fakeCtx({ frame: 'pcb', pads: () => { throw new Error('boom'); } }).ctx)).toEqual({ ok: false, code: 'island_error', message: 'boom' });
  });
});

describe('sch.renameNets on an engine with the export', () => {
  const run = unit.ops['sch.renameNets'].run;

  it('a preview runs in a fresh /tmp/cc-renameNets/<n>, hands the pads over as they came, answers the rows and removes the folder', async () => {
    const f = fakeCtx({ engine: goodEngine });
    expect(await run({ preview: true, pads: PADS }, f.ctx)).toEqual({ ok: true, result: PREVIEW });
    expect(f.made).toEqual([`${RENAME_ROOT}/1`]);
    expect(f.calls).toEqual([{ run: 1, dir: `${RENAME_ROOT}/1`, preview: true, pads: PADS }]);
    expect(f.dropped).toEqual([`${RENAME_ROOT}/1`]);
    expect(f.files.size).toBe(0);
  });

  it('an apply answers applied and the undo depth after', async () => {
    const f = fakeCtx({ engine: goodEngine });
    expect(await run({ preview: false, pads: PADS }, f.ctx)).toEqual({ ok: true, result: APPLY });
    expect(f.calls[0]).toMatchObject({ preview: false });
    expect(f.files.size).toBe(0);
  });

  it('a record of another shape is island_error; a refused run or a throw answers as it should; the folder always gone', async () => {
    const odd = fakeCtx({ engine: engineOf(() => ({ ...PREVIEW, preview: false })) });
    expect(await run({ preview: true, pads: PADS }, odd.ctx)).toEqual({ ok: false, code: 'island_error', message: 'the engine answered net renames of another shape' });
    const refused = fakeCtx({ engine: () => false });
    expect(await run({ preview: true, pads: PADS }, refused.ctx)).toEqual({ ok: false, code: 'not_applied', message: 'sch.renameNets' });
    const thrown = fakeCtx({ engine: () => { throw new Error('boom'); } });
    expect(await run({ preview: true, pads: PADS }, thrown.ctx)).toEqual({ ok: false, code: 'island_error', message: 'boom' });
    for (const f of [odd, refused, thrown]) {
      expect(f.dropped).toEqual(f.made);
      expect(f.files.size).toBe(0);
    }
  });

  it('answers not_applied past its bound when the apply queue never empties, the folder gone', async () => {
    const f = fakeCtx({ engine: goodEngine, idle: () => false });
    expect(await run({ preview: false, pads: PADS }, f.ctx)).toEqual({ ok: false, code: 'not_applied', message: 'sch.renameNets' });
    expect(f.dropped).toEqual(f.made);
  });

  it('the checks answer before any folder: bad args, then the schematic gate', async () => {
    const busy = fakeCtx({ engine: goodEngine, gate: 'sch.renameNets' });
    expect(await run({ preview: true, pads: PADS }, busy.ctx)).toEqual({ ok: false, code: 'busy', message: 'sch.renameNets' });
    expect(await run({ preview: true, pads: [{ ref: 'R1', pad: '1', net: '' }] }, busy.ctx)).toEqual({ ok: false, code: 'bad_args', message: 'sch.renameNets' });
    const pcb = fakeCtx({ engine: goodEngine, frame: 'pcb' });
    expect(await run({ preview: true, pads: PADS }, pcb.ctx)).toEqual({ ok: false, code: 'unsupported', message: 'a schematic edits in a sch frame' });
    for (const f of [busy, pcb]) {
      expect(f.made).toEqual([]);
      expect(f.calls).toEqual([]);
    }
  });
});
