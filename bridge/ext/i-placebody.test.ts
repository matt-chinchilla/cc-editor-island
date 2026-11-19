// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// i-placebody: place widened with `body`, read closed, checked in the op's
// order, built by the op's own builder and handed to the same engine export,
// then joined to the place watch; the cap placeBody in a sch frame whose
// engine has the place exports. The engine here is this test's own module of
// exports (at the protocol boundary); the real engine is the e2e's
// (tests/e2e/place-body.spec.ts).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startResponder } from '../responder';
import type { Answer, ExtUnit, ResponderCtx } from './contract';
import { buildRegistry, REGISTRY } from './registry';
import unit, { PLACE_BODY_CAP, PLACE_BODY_MAX_BYTES, PLACE_EXPORTS, placeWithBody, readBodyPlace, utf8Bytes } from './i-placebody';

const PARENT = 'http://localhost';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));

/** A part's body as a host gives it: the source's R renamed to the part's own name. */
const BODY = `(kicad_symbol_lib (version 20251024) (generator "kicad_symbol_editor")
  (symbol "RC0603FR-0710KL" (in_bom yes) (on_board yes)
    (property "Reference" "R" (at 2.032 0 90) (effects (font (size 1.27 1.27))))
    (property "Value" "RC0603FR-0710KL" (at 0 0 90) (effects (font (size 1.27 1.27))))
    (property "Footprint" "Resistor_SMD:R_0603_1608Metric" (at -1.778 0 90) (effects (font (size 1.27 1.27)) (hide yes)))
    (symbol "RC0603FR-0710KL_1_1"
      (pin passive line (at 0 3.81 270) (length 1.27) (name "~") (number "1"))
      (pin passive line (at 0 -3.81 90) (length 1.27) (name "~") (number "2")))))`;
const ARGS = { kind: 'symbol', lib: 'Remote', name: 'RC0603FR-0710KL', body: BODY };

describe('the unit as the registry reads it', () => {
  it('loads with no problem, widens place alone, and names its cap', () => {
    const reg = buildRegistry(mods(unit));
    expect(reg.problems).toEqual([]);
    expect(unit.unit).toBe('i-placebody');
    expect(Object.keys(unit.opsWidened)).toEqual(['place']);
    expect(unit.capNames).toEqual([PLACE_BODY_CAP]);
    expect(PLACE_BODY_CAP).toBe('placeBody');
  });

  it('is in the built registry beside every other unit, with no problem of its own', () => {
    expect(REGISTRY.problems.filter((p) => p.startsWith('i-placebody'))).toEqual([]);
  });

  it('lists placeBody in a sch frame whose engine has the place exports, and nowhere else', () => {
    const both = Object.fromEntries(PLACE_EXPORTS.map((n) => [n, () => '']));
    expect(unit.caps(both, 'sch')).toEqual([PLACE_BODY_CAP]);
    expect(unit.caps(both, 'pcb')).toEqual([]);
    expect(unit.caps(both, 'symedit')).toEqual([]);
    expect(unit.caps({ kicadPlaceImportedItem: () => '' }, 'sch')).toEqual([]);
    expect(unit.caps({ kicadCollabGetSelection: () => '[]' }, 'sch')).toEqual([]);
  });
});

describe('readBodyPlace: the args read closed', () => {
  it('builds the blob from the body as lib:name, the fields on the instance', () => {
    const a = readBodyPlace({ ...ARGS, value: '10k', mpn: 'RC0603FR-0710KL', manufacturer: 'Yageo' });
    expect(a).not.toBeNull();
    expect(a!.lib).toBe('Remote');
    expect(a!.sexpr).toMatch(/^\(lib_symbols \(symbol "Remote:RC0603FR-0710KL"/);
    expect(a!.sexpr).toContain('(lib_id "Remote:RC0603FR-0710KL")');
    expect(a!.sexpr).toContain('(property "Value" "10k"');
    expect(a!.sexpr).toContain('(property "MPN" "RC0603FR-0710KL"');
    expect(a!.sexpr).toContain('(property "Manufacturer" "Yageo"');
  });

  it('answers sexpr null for a name the body does not hold', () => {
    expect(readBodyPlace({ ...ARGS, name: 'Other' })).toEqual({ lib: 'Remote', name: 'Other', sexpr: null });
  });

  it('refuses every shape outside the closed one', () => {
    const bad: unknown[] = [
      { ...ARGS, body: 7 }, { ...ARGS, body: '' }, { ...ARGS, body: '(kicad_sch (version 1))' }, { ...ARGS, body: '(footprint "X")' },
      { ...ARGS, kind: 'footprint' }, { ...ARGS, extra: 1 }, { ...ARGS, lib: 'a:b' }, { ...ARGS, name: '' }, { ...ARGS, value: '' },
      // Unbalanced, and a parent outside the body: not self contained.
      { ...ARGS, body: BODY.slice(0, -2) },
      { ...ARGS, body: BODY.replace('(in_bom yes)', '(extends "Base") (in_bom yes)') },
    ];
    for (const b of bad) expect(readBodyPlace(b as Record<string, unknown>)).toBeNull();
  });

  it('takes a body of exactly 4 MiB as UTF-8 and refuses one byte more', () => {
    const pad = (n: number) => BODY.replace(/\)$/, `${' '.repeat(n - utf8Bytes(BODY))})`);
    expect(utf8Bytes(pad(PLACE_BODY_MAX_BYTES))).toBe(PLACE_BODY_MAX_BYTES);
    expect(readBodyPlace({ ...ARGS, body: pad(PLACE_BODY_MAX_BYTES) })?.sexpr).toEqual(expect.any(String));
    expect(readBodyPlace({ ...ARGS, body: pad(PLACE_BODY_MAX_BYTES + 1) })).toBeNull();
  });

  it('counts UTF-8 bytes as TextEncoder does', () => {
    for (const s of ['', 'abc', 'µF', 'Ω 10k', '😀 x', 'a\ud800b', '€']) expect(utf8Bytes(s)).toBe(new TextEncoder().encode(s).length);
  });
});

/** A ctx over an engine with the place exports: the editor selects the placed item after the call unless `take` is false. */
function fakeCtx(opts: { frame?: string; exports?: readonly string[]; opened?: boolean; busy?: boolean; blocked?: boolean; take?: boolean; answer?: string; cancel?: boolean; win?: boolean } = {}) {
  const sel: string[] = [];
  const blobs: string[] = [];
  const mod: Record<string, unknown> = {};
  const exports = opts.exports ?? PLACE_EXPORTS;
  if (exports.includes('kicadPlaceImportedItem')) {
    mod.kicadPlaceImportedItem = vi.fn((sx: string) => {
      blobs.push(sx);
      if (opts.take !== false) setTimeout(() => sel.splice(0, sel.length, 'u1'), 2);
      return opts.answer ?? '{"ok":true}';
    });
  }
  if (exports.includes('kicadCollabGetSelection')) mod.kicadCollabGetSelection = () => JSON.stringify(sel);
  const win = { Module: mod } as unknown as ToolWindow;
  const placeStart = vi.fn();
  const placeCancel = vi.fn(async () => opts.cancel !== false);
  const ctx = {
    frame: opts.frame ?? 'sch',
    root: '/project',
    timing: { placePollMs: 1, placeMs: 60, placeWatchMs: 5, placeCancelMs: 20 },
    win: () => (opts.win === false ? null : win),
    mod: () => (opts.win === false ? null : mod),
    staged: () => (opts.opened === false ? null : ({} as never)),
    opened: () => (opts.opened === false ? null : '/project/httplib.kicad_sch'),
    engineBusy: () => opts.busy === true,
    keysBlocked: () => opts.blocked === true,
    closed: () => false,
    placeStart,
    placeCancel,
    log: () => {},
  } as unknown as ResponderCtx;
  const next = vi.fn(async (_a: unknown): Promise<Answer> => ({ ok: true, result: { builtin: true } }));
  return { ctx, next, blobs, placeStart, placeCancel, mod };
}

describe('placeWithBody: the widened op', () => {
  it('leaves a request without body to the op as it ships, its args untouched', async () => {
    const f = fakeCtx();
    const args = { kind: 'symbol', lib: 'Device', name: 'R' };
    expect(await placeWithBody(args, f.ctx, f.next)).toEqual({ ok: true, result: { builtin: true } });
    expect(f.next).toHaveBeenCalledWith(args);
    expect(await placeWithBody(undefined, f.ctx, f.next)).toEqual({ ok: true, result: { builtin: true } });
    expect(f.blobs).toEqual([]);
  });

  it('places the body as lib:name: the blob to the engine, the previous item dropped first, the new one joined to the place watch', async () => {
    const f = fakeCtx();
    expect(await placeWithBody(ARGS, f.ctx, f.next)).toEqual({ ok: true, result: {} });
    expect(f.next).not.toHaveBeenCalled();
    expect(f.blobs).toHaveLength(1);
    expect(f.blobs[0]).toMatch(/^\(lib_symbols \(symbol "Remote:RC0603FR-0710KL"/);
    expect(f.blobs[0]).toContain('(lib_id "Remote:RC0603FR-0710KL")');
    expect(f.placeCancel).toHaveBeenCalledTimes(1);
    expect(f.placeStart).toHaveBeenCalledWith('u1');
    expect(f.placeCancel.mock.invocationCallOrder[0]).toBeLessThan((f.mod.kicadPlaceImportedItem as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]);
  });

  it('refuses in the op\'s order: args, frame, engine, document, busy, the name', async () => {
    const run = async (o: Parameters<typeof fakeCtx>[0], args: unknown = ARGS) => { const f = fakeCtx(o); const r = await placeWithBody(args, f.ctx, f.next); expect(f.blobs).toEqual([]); expect(f.placeStart).not.toHaveBeenCalled(); return r; };
    expect(await run({ frame: 'pcb' }, { ...ARGS, body: 3 })).toEqual({ ok: false, code: 'bad_args', message: 'place' });
    expect(await run({ frame: 'pcb' })).toEqual({ ok: false, code: 'unsupported', message: 'a symbol does not place in a pcb frame' });
    expect(await run({ win: false })).toEqual({ ok: false, code: 'not_ready', message: 'place' });
    expect(await run({ exports: ['kicadCollabGetSelection'] })).toEqual({ ok: false, code: 'unsupported', message: 'kicadPlaceImportedItem' });
    expect(await run({ exports: ['kicadPlaceImportedItem'] })).toEqual({ ok: false, code: 'unsupported', message: 'kicadCollabGetSelection' });
    expect(await run({ opened: false })).toEqual({ ok: false, code: 'not_ready', message: 'place' });
    expect(await run({ busy: true })).toEqual({ ok: false, code: 'busy', message: 'place' });
    expect(await run({ blocked: true })).toEqual({ ok: false, code: 'busy', message: 'place' });
    expect(await run({}, { ...ARGS, name: 'Other' })).toEqual({ ok: false, code: 'not_found', message: 'Remote:Other' });
    expect(await run({ cancel: false })).toEqual({ ok: false, code: 'busy', message: 'the previous item still hangs off the pointer' });
  });

  it('answers the engine\'s refusal and its silence as place does', async () => {
    const refused = fakeCtx({ answer: '{"ok":false,"error":"bad clipboard text"}' });
    expect(await placeWithBody(ARGS, refused.ctx, refused.next)).toEqual({ ok: false, code: 'island_error', message: 'bad clipboard text' });
    const silent = fakeCtx({ take: false });
    expect(await placeWithBody(ARGS, silent.ctx, silent.next)).toEqual({ ok: false, code: 'busy', message: 'the editor did not take the item' });
    expect(silent.placeStart).not.toHaveBeenCalled();
  });
});

describe('through the responder', () => {
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

  const started: Array<{ close: () => void }> = [];
  afterEach(() => { for (const r of started.splice(0)) r.close(); });

  async function boot(frame: 'sch' | 'pcb', exports: Record<string, unknown>) {
    const reg = buildRegistry(mods(unit));
    expect(reg.problems).toEqual([]);
    const { page, parent } = fakePage(`?frame=${frame}&theme=day`);
    const r = startResponder({ parentOrigin: PARENT, page, ext: reg });
    started.push(r);
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
    const ask = async (n: number, op: string, args?: unknown) => {
      ch.port1.postMessage(args === undefined ? { id: n, op } : { id: n, op, args });
      for (let i = 0; i < 50 && !got.some((m) => m.id === n); i++) await settle(5);
      return got.find((m) => m.id === n);
    };
    return { ready: got.find((m) => m.type === 'ev.ready') as { caps: string[] } | undefined, ask };
  }

  const PLACE = { kicadPlaceImportedItem: () => '{"ok":true}', kicadCollabGetSelection: () => '[]' };

  it('ev.ready lists placeBody in a sch frame on an engine with the place exports, never in a pcb frame or without them', async () => {
    expect((await boot('sch', PLACE)).ready?.caps).toContain(PLACE_BODY_CAP);
    expect((await boot('pcb', PLACE)).ready?.caps).not.toContain(PLACE_BODY_CAP);
    expect((await boot('sch', { kicadCollabGetSelection: () => '[]' })).ready?.caps).not.toContain(PLACE_BODY_CAP);
  });

  it('routes a request with body to the widening and one without to the op as it ships', async () => {
    const sch = await boot('sch', PLACE);
    // With body: a footprint is bad_args; the op as it ships calls it unsupported in a sch frame.
    expect(await sch.ask(1, 'place', { kind: 'footprint', lib: 'X', name: 'Y', body: BODY })).toMatchObject({ ok: false, error: { code: 'bad_args', message: 'place' } });
    expect(await sch.ask(2, 'place', { kind: 'footprint', lib: 'X', name: 'Y' })).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'a footprint does not place in a sch frame' } });
    expect(await sch.ask(3, 'place', { ...ARGS, body: 'x'.repeat(PLACE_BODY_MAX_BYTES + 1) })).toMatchObject({ ok: false, error: { code: 'bad_args', message: 'place' } });
    // No document open.
    expect(await sch.ask(4, 'place', ARGS)).toMatchObject({ ok: false, error: { code: 'not_ready', message: 'place' } });
    const pcb = await boot('pcb', PLACE);
    expect(await pcb.ask(1, 'place', ARGS)).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'a symbol does not place in a pcb frame' } });
  });
});
