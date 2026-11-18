// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// fp-i4: footprint.forEditor, footprint.push and footprint.convert, their caps
// feature detected on the engine's exports, their args and the engine's
// answers read closed. The engine here is this test's own module of exports
// (at the protocol boundary); the real engine is the e2e's
// (tests/e2e/footprint-edit.spec.ts, engine run 15).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startResponder } from '../responder';
import type { ExtUnit, ResponderCtx } from './contract';
import { buildRegistry, REGISTRY } from './registry';
import unit, {
  CONVERT_MAX_BYTES, CONVERT_MAX_FOOTPRINTS, CONVERT_ROOT, FOOTPRINT_CONVERT_CAP, FOOTPRINT_EDIT_CAP, parseConvertArgs, parseForEditorArgs, parsePushArgs,
  readConverted, readForEditor, UNREADABLE_LINE,
} from './fp-i4';

const PARENT = 'http://localhost';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));

const U1 = 'f0071000-0000-4000-8000-000000000001';
const PAD = 'f0071000-0000-4000-8000-000000000101';
const FP = `(footprint "SOIC-8_3.9x4.9mm_P1.27mm"\n\t(version 20260206)\n\t(pad "1" smd roundrect (at -2.475 -1.905) (uuid "${PAD}"))\n)\n`;
const RUN15 = {
  kicadFootprintForEditor: () => '', kicadFootprintPushToBoard: () => false, kicadBoardItemGet: () => '{"items":[]}', kicadCollabBusy: () => false,
  kicadFootprintConvert: () => '',
};

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
  const reg = buildRegistry(mods(unit), {}, { fpedit: 'fp-i1' });
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

/** A ResponderCtx over a fake board engine: `items` is the board form's read of U1, the calls are recorded. */
function fakeCtx(opts: { frame?: string; mod?: Record<string, unknown>; idle?: () => boolean } = {}) {
  const files = new Map<string, Uint8Array>();
  const dropped: string[] = [];
  const mod = opts.mod ?? {};
  const ctx = {
    frame: opts.frame ?? 'pcb',
    root: '/project',
    timing: { symbolPushMs: 200, applyPollMs: 5 },
    mod: () => mod,
    fs: () => ({ writeFile: (p: string, b: Uint8Array) => { files.set(p, b); } }),
    closed: () => false,
    engineBusy: () => false,
    keysBlocked: () => false,
    boardGate: (op: string, exports: readonly string[]) => {
      for (const name of exports) if (typeof mod[name] !== 'function') return { ok: false, code: 'unsupported', message: name };
      return { w: {}, mod };
    },
    applyIdle: async () => (opts.idle ?? (() => true))(),
    freshRunFolder: (root: string) => `${root}/7`,
    dropRunFolder: (dir: string) => { dropped.push(dir); },
    log: () => {},
  } as unknown as ResponderCtx;
  return { ctx, files, dropped };
}

const footprintItem = (libId: string) => ({
  kind: 'footprint', uuid: U1, locked: false, ref: 'U1', value: 'LM358', libId, side: 'front', x: 10, y: 20, rotation: 90,
  inBom: true, inPos: true, dnp: false, boardOnly: false, variant: '', symbolPath: '',
});

describe('fp-i4 in the registry', () => {
  it('loads in this checkout with nothing broken, owning its three ops and two caps', () => {
    expect(REGISTRY.problems).toEqual([]);
    for (const op of ['footprint.forEditor', 'footprint.push', 'footprint.convert']) {
      expect(REGISTRY.ops.get(op)?.unit).toBe('fp-i4');
      expect(REGISTRY.pending.has(op)).toBe(false);
    }
    expect(REGISTRY.capNames.get(FOOTPRINT_EDIT_CAP)).toBe('fp-i4');
    expect(REGISTRY.capNames.get(FOOTPRINT_CONVERT_CAP)).toBe('fp-i4');
  });

  it('lists its caps from the engine\'s exports: footprintEdit in a pcb frame, footprintConvert in a pcb or an fpedit frame, nothing on run 14', () => {
    const caps = unit.caps;
    expect(caps(RUN15, 'pcb')).toEqual(['footprintEdit', 'footprintConvert']);
    expect(caps(RUN15, 'fpedit' as never)).toEqual(['footprintConvert']);
    expect(caps(RUN15, 'sch')).toEqual([]);
    expect(caps(RUN15, 'symedit')).toEqual([]);
    expect(caps({}, 'pcb')).toEqual([]);
    expect(caps({ ...RUN15, kicadBoardItemGet: undefined }, 'pcb')).toEqual(['footprintConvert']);
  });

  it('a pcb frame on run 14 lists neither cap and answers each op unsupported naming the export it lacks', async () => {
    const s = await boot('pcb', {});
    expect(s.ready?.caps).not.toContain('footprintEdit');
    expect(s.ready?.caps).not.toContain('footprintConvert');
    expect(await s.ask(1, 'footprint.forEditor', { uuid: U1 })).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'kicadFootprintForEditor' } });
    expect(await s.ask(2, 'footprint.push', { uuid: U1, text: FP, libId: '' })).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'kicadFootprintForEditor' } });
    expect(await s.ask(3, 'footprint.convert', { name: 'legacy.mod', bytes: new Uint8Array([1]) })).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'kicadFootprintConvert' } });
    expect(await s.ask(4, 'footprint.forEditor', { uuid: 'U1' })).toMatchObject({ ok: false, error: { code: 'bad_args', message: 'footprint.forEditor' } });
  });

  it('a pcb frame on run 15 lists both caps; a sch frame lists neither and refuses every op', async () => {
    const pcb = await boot('pcb', RUN15);
    expect(pcb.ready?.caps).toEqual(expect.arrayContaining(['footprintEdit', 'footprintConvert']));
    const sch = await boot('sch', RUN15);
    expect(sch.ready?.caps).not.toContain('footprintEdit');
    expect(sch.ready?.caps).not.toContain('footprintConvert');
    for (const [i, op] of ['footprint.forEditor', 'footprint.push', 'footprint.convert'].entries()) {
      expect(await sch.ask(i + 1, op, {})).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'footprints are read in a pcb or an fpedit frame' } });
    }
  });
});

describe('the args', () => {
  it('footprint.forEditor takes exactly a placed footprint\'s uuid', () => {
    expect(parseForEditorArgs({ uuid: U1 })).toEqual({ uuid: U1 });
    for (const bad of [{}, { uuid: U1.toUpperCase() }, { uuid: U1, sheetPath: '/' }, { uuid: 1 }, null, [U1]]) expect(parseForEditorArgs(bad), JSON.stringify(bad)).toBeNull();
  });
  it('footprint.push takes one (footprint ...) and a lib id of both halves or none', () => {
    const P = { uuid: U1, text: FP, libId: '' };
    expect(parsePushArgs(P)).toEqual(P);
    expect(parsePushArgs({ ...P, libId: 'fpedit-small_parts:SOIC-8_3.9x4.9mm_P1.27mm' })).toMatchObject({ libId: 'fpedit-small_parts:SOIC-8_3.9x4.9mm_P1.27mm' });
    for (const b of [{ libId: 'SOIC' }, { libId: ':SOIC' }, { libId: 'a:' }, { libId: 'a:b:c' }, { text: '' }, { text: '(kicad_pcb)' }, { text: '(footprint' + '\0' + ')' },
      { text: `(footprint "x" ${' '.repeat(8 * 1024 * 1024)})` }, { token: 't' }, { uuid: 'x' }]) {
      expect(parsePushArgs({ ...P, ...b }), JSON.stringify(b).slice(0, 60)).toBeNull();
    }
  });
  it('footprint.convert takes a file name and 1 byte to 25 MiB', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(parseConvertArgs({ name: 'package.lbr', bytes })).toEqual({ name: 'package.lbr', bytes });
    for (const bad of [{ name: '', bytes }, { name: '.', bytes }, { name: '..', bytes }, { name: 'a/b.mod', bytes }, { name: 'a\\b.mod', bytes }, { name: 'é'.repeat(128), bytes },
      { name: 'a.mod', bytes: bytes.buffer }, { name: 'a.mod', bytes: new Uint8Array() }, { name: 'a.mod', bytes: new Uint8Array(CONVERT_MAX_BYTES + 1) }, { name: 'a.mod', bytes, x: 1 }]) {
      expect(parseConvertArgs(bad)).toBeNull();
    }
  });
});

describe('the engine\'s answers read closed', () => {
  it('kicadFootprintForEditor: name, lib id, designator and the footprint as text', () => {
    const A = { name: 'SOIC-8_3.9x4.9mm_P1.27mm', libId: 'fpedit-small_parts:SOIC-8_3.9x4.9mm_P1.27mm', ref: 'U1', text: FP };
    expect(readForEditor(JSON.stringify(A))).toEqual(A);
    for (const bad of ['', '{', JSON.stringify({ ...A, text: '(kicad_pcb)' }), JSON.stringify({ name: A.name, libId: A.libId, text: FP }), JSON.stringify({ ...A, extra: 1 }), JSON.stringify({ ...A, name: '' })]) {
      expect(readForEditor(bad), bad.slice(0, 60)).toBeNull();
    }
  });
  it('kicadFootprintConvert: the footprints, too_large, or unreadable with KiCad\'s line or ours', () => {
    expect(readConverted(JSON.stringify({ format: 'Legacy', footprints: [{ name: 'LEGACY_R0805', text: FP }] }))).toEqual({ format: 'Legacy', footprints: [{ name: 'LEGACY_R0805', text: FP }] });
    expect(readConverted(JSON.stringify({ error: 'too_large' }))).toEqual({ error: 'too_large' });
    expect(readConverted(JSON.stringify({ error: 'unreadable', message: 'Not a footprint file.' }))).toEqual({ error: 'unreadable', message: 'Not a footprint file.' });
    expect(readConverted(JSON.stringify({ error: 'unreadable' }))).toEqual({ error: 'unreadable', message: UNREADABLE_LINE });
    for (const bad of ['', '{', JSON.stringify({ format: '', footprints: [] }), JSON.stringify({ format: 'Eagle', footprints: [{ name: 'R' }] }), JSON.stringify({ error: 'other' }),
      JSON.stringify({ format: 'Eagle', footprints: [{ name: 'R', text: '(kicad_symbol_lib)' }] }),
      JSON.stringify({ format: 'Eagle', footprints: Array.from({ length: CONVERT_MAX_FOOTPRINTS + 1 }, () => ({ name: 'R', text: FP })) })]) {
      expect(readConverted(bad), bad.slice(0, 60)).toBeNull();
    }
  });
});

describe('the ops on an engine with the exports', () => {
  it('footprint.forEditor answers the placed footprint, not_found for a uuid the board does not place', async () => {
    const calls: string[] = [];
    const A = { name: 'SOIC-8_3.9x4.9mm_P1.27mm', libId: 'fpedit-small_parts:SOIC-8_3.9x4.9mm_P1.27mm', ref: 'U1', text: FP };
    const { ctx } = fakeCtx({ mod: { ...RUN15, kicadFootprintForEditor: (a: string) => { calls.push(a); return JSON.parse(a).uuid === U1 ? JSON.stringify(A) : ''; } } });
    const run = unit.ops['footprint.forEditor'].run;
    expect(await run({ uuid: U1 }, ctx)).toEqual({ ok: true, result: A });
    expect(calls).toEqual([JSON.stringify({ uuid: U1 })]);
    expect(await run({ uuid: PAD }, ctx)).toEqual({ ok: false, code: 'not_found', message: PAD });
    expect(await run({ uuid: U1 }, fakeCtx({ frame: 'fpedit', mod: RUN15 }).ctx)).toEqual({ ok: false, code: 'unsupported', message: 'a footprint editor opens footprints, not documents' });
  });

  it('footprint.push queues one push with a token and answers once the part reads back, relinked when asked', async () => {
    let libId = 'fpedit-small_parts:SOIC-8_3.9x4.9mm_P1.27mm';
    const pushed: Array<Record<string, unknown>> = [];
    const mod = {
      ...RUN15,
      kicadBoardItemGet: (j: string) => JSON.stringify({ items: (JSON.parse(j) as string[]).includes(U1) ? [footprintItem(libId)] : [] }),
      kicadFootprintPushToBoard: (j: string) => {
        const a = JSON.parse(j) as Record<string, unknown>;
        pushed.push(a);
        if (a.text !== FP) return false;
        if (a.libId !== '') libId = a.libId as string;
        return true;
      },
    };
    const { ctx } = fakeCtx({ mod });
    const run = unit.ops['footprint.push'].run;
    expect(await run({ uuid: U1, text: FP, libId: '' }, ctx)).toEqual({ ok: true, result: { uuid: U1 } });
    expect(Object.keys(pushed[0]).sort()).toEqual(['libId', 'text', 'token', 'uuid']);
    expect(pushed[0]).toMatchObject({ uuid: U1, text: FP, libId: '' });
    expect(pushed[0].token).toMatch(/^[\x21-\x7e]{1,64}$/);
    expect(await run({ uuid: U1, text: FP, libId: 'design_parts:SOIC-8' }, ctx)).toEqual({ ok: true, result: { uuid: U1 } });
    expect(libId).toBe('design_parts:SOIC-8');
    expect(await run({ uuid: PAD, text: FP, libId: '' }, ctx)).toEqual({ ok: false, code: 'not_found', message: PAD });
    expect(pushed).toHaveLength(2);
    const other = `(footprint "R_0603_1608Metric"\n)\n`;
    expect(await run({ uuid: U1, text: other, libId: '' }, ctx)).toEqual({ ok: false, code: 'bad_args', message: 'footprint.push: the text holds no footprint KiCad reads' });
  });

  it('footprint.push answers not_applied when the apply queue never empties, or the relink never shows', async () => {
    const mod = { ...RUN15, kicadBoardItemGet: () => JSON.stringify({ items: [footprintItem('a:b')] }), kicadFootprintPushToBoard: () => true };
    const run = unit.ops['footprint.push'].run;
    expect(await run({ uuid: U1, text: FP, libId: '' }, fakeCtx({ mod, idle: () => false }).ctx)).toEqual({ ok: false, code: 'not_applied', message: 'footprint.push' });
    expect(await run({ uuid: U1, text: FP, libId: 'c:d' }, fakeCtx({ mod }).ctx)).toEqual({ ok: false, code: 'not_applied', message: 'footprint.push' });
  });

  it('footprint.convert writes the file under a fresh /tmp/cc-import/<n>/, reads it, and removes the folder', async () => {
    const asked: string[] = [];
    const answers: Record<string, string> = {
      'legacy.mod': JSON.stringify({ format: 'Legacy', footprints: [{ name: 'LEGACY_R0805', text: FP }] }),
      'big.lbr': JSON.stringify({ error: 'too_large' }),
      'x.bad': JSON.stringify({ error: 'unreadable', message: 'Not a footprint file.' }),
      'odd.mod': '{"format":"Legacy"}',
    };
    const mod = { ...RUN15, kicadFootprintConvert: (j: string) => { const p = (JSON.parse(j) as { path: string }).path; asked.push(p); return answers[p.slice(p.lastIndexOf('/') + 1)] ?? ''; } };
    const run = unit.ops['footprint.convert'].run;
    for (const frame of ['pcb', 'fpedit']) {
      const { ctx, files, dropped } = fakeCtx({ frame, mod });
      const bytes = new Uint8Array([80, 67, 66]);
      expect(await run({ name: 'legacy.mod', bytes }, ctx)).toEqual({ ok: true, result: { format: 'Legacy', footprints: [{ name: 'LEGACY_R0805', text: FP }] } });
      expect(files.get(`${CONVERT_ROOT}/7/legacy.mod`)).toBe(bytes);
      expect(dropped).toEqual([`${CONVERT_ROOT}/7`]);
      expect(await run({ name: 'big.lbr', bytes }, ctx)).toEqual({ ok: false, code: 'too_large', message: 'footprint.convert' });
      expect(await run({ name: 'x.bad', bytes }, ctx)).toEqual({ ok: false, code: 'unreadable', message: 'Not a footprint file.' });
      expect(await run({ name: 'odd.mod', bytes }, ctx)).toEqual({ ok: false, code: 'island_error', message: 'the engine answered a reading of another shape' });
      expect(dropped).toHaveLength(4);
    }
    expect(asked[0]).toBe('/tmp/cc-import/7/legacy.mod');
  });

  it('footprint.convert waits for nothing: busy while the engine loads or a dialog is up, not_ready before the engine', async () => {
    const run = unit.ops['footprint.convert'].run;
    const args = { name: 'legacy.mod', bytes: new Uint8Array([1]) };
    const busy = fakeCtx({ mod: RUN15 }).ctx;
    expect(await run(args, { ...busy, engineBusy: () => true })).toEqual({ ok: false, code: 'busy', message: 'footprint.convert' });
    expect(await run(args, { ...busy, keysBlocked: () => true })).toEqual({ ok: false, code: 'busy', message: 'footprint.convert' });
    expect(await run(args, { ...busy, mod: () => null })).toEqual({ ok: false, code: 'not_ready', message: 'footprint.convert' });
  });
});
