// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// fp-i1 as the responder runs it: the fpedit frame (its tool, its refusals,
// its caps per frame), fpedit.open, fpedit.new, fpedit.state, fpedit.take,
// fpedit.markSaved and select in an fpedit frame, each check in its order,
// ev.edited from the footprint's undo depth and ev.selected from its
// selection. The engine here is this test's own fake of the fpedit exports
// (FP spec 5.1 and 11), at the protocol boundary.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startResponder, timing } from '../responder';
import { BUILTIN_OPS } from './builtins';
import type { ExtUnit } from './contract';
import { buildRegistry, REGISTRY } from './registry';
import { bootFrame, documentExtension, framePickKind, framePicks, frameToken, frameTool, ownDocument, unitsPerMm } from '../../src/frames';
import { FPEDIT_EXPORTS, FPEDIT_REFUSAL, FPEDIT_WORKS } from '../fpedit/common';
import unit from './fp-i1';

const PARENT = 'http://localhost';
const P1 = '55555555-0000-4000-8000-000000000001';
const P2 = '55555555-0000-4000-8000-000000000002';
const P3 = '55555555-0000-4000-8000-000000000003';
const SOIC = '(footprint "SOIC-8_3.9x4.9mm_P1.27mm"\n\t(version 20240108)\n)\n';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));
const err = (code: string, message: string) => ({ ok: false, error: { code, message } });
const OPS = ['fpedit.open', 'fpedit.new', 'fpedit.state', 'fpedit.take', 'fpedit.markSaved'];

const saved = { editPollMs: timing.editPollMs, symeditMs: timing.symeditMs, selectMs: timing.selectMs };
beforeEach(() => {
  timing.editPollMs = 20;
  timing.symeditMs = 150;
  timing.selectMs = 150;
  vi.stubGlobal('KeyboardEvent', class extends Event {
    constructor(type: string, init: Record<string, unknown> = {}) {
      const { bubbles, cancelable, composed, ...rest } = init as EventInit & Record<string, unknown>;
      super(type, { bubbles, cancelable, composed });
      Object.assign(this, rest);
    }
  });
});
afterEach(() => {
  Object.assign(timing, saved);
  vi.unstubAllGlobals();
});

/** The fake engine's fpedit exports over one footprint of three pads (P1, P2, P3). */
function fakeFp(o: { apply?: boolean } = {}) {
  const st = { token: '', open: false, name: '', lib: '', mode: 'library', modified: false, depth: 0, padCount: 0, type: 'unspecified', padEditMode: false };
  const doc = { text: '' };
  let selection: string[] = [];
  const held = [P1, P2, P3];
  const calls: unknown[] = [];
  const exports: Record<string, unknown> = {
    ...Object.fromEntries(FPEDIT_EXPORTS.map((n) => [n, () => false])),
    kicadFpEditOpen: (j: string) => {
      const a = JSON.parse(j) as { text: string; name: string; lib: string; mode: string; discard: boolean; token: string };
      calls.push(a);
      if (!a.text.startsWith('(footprint')) return false;
      if (st.open && st.modified && !a.discard) return false;
      if (o.apply !== false) Object.assign(st, { token: a.token, open: true, name: a.name, lib: a.lib, mode: a.mode, modified: false, depth: 0, padCount: 3, type: 'smd' });
      doc.text = a.text;
      selection = [];
      return true;
    },
    kicadFpEditNew: (j: string) => {
      const a = JSON.parse(j) as { name: string; lib: string; type: string; discard: boolean; token: string };
      calls.push({ new: a });
      if (a.name === 'REFUSED') return false;
      Object.assign(st, { token: a.token, open: true, name: a.name, lib: a.lib, mode: 'new', modified: false, depth: 0, padCount: 0, type: a.type });
      doc.text = `(footprint "${a.name}")\n`;
      return true;
    },
    kicadFpEditState: () => JSON.stringify(st),
    kicadFpEditTake: () => (st.open ? JSON.stringify({ name: st.name, text: doc.text }) : ''),
    kicadFpEditMarkSaved: (t: string) => { if (t !== st.token) return false; st.modified = false; return true; },
    kicadFpEditItemsGet: (j: string) => {
      const want = (JSON.parse(j) as { uuids?: string[] }).uuids;
      return JSON.stringify({ items: held.filter((u) => want == null || want.includes(u)).map((uuid) => ({ kind: 'pad', uuid })) });
    },
    kicadFpEditSelect: (j: string) => { const a = JSON.parse(j) as { uuids: string[]; zoom: boolean }; calls.push({ select: a }); selection = a.uuids; return true; },
    kicadFpEditSelection: () => JSON.stringify({ uuids: selection }),
    kicadCollabBusy: () => false,
    kicadCollabPresenceStart: () => true,
  };
  const edit = () => { st.depth++; st.modified = true; };
  const pick = (uuids: string[]) => { selection = uuids; };
  return { st, exports, calls, edit, pick };
}

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

/** A responder with fp-i1 alone, connected and booted on a fake engine with `exports`; `got` collects what the host hears. */
async function boot(frame: string, exports: Record<string, unknown>, busy = { now: false }) {
  const reg = buildRegistry(mods(unit));
  expect(reg.problems).toEqual([]);
  const { page, parent } = fakePage(`?frame=${frame}&theme=day`);
  const r = startResponder({ parentOrigin: PARENT, page, ext: reg });
  const ch = new MessageChannel();
  const got: Array<Record<string, unknown>> = [];
  ch.port1.onmessage = (m) => got.push(m.data);
  page.dispatch('message', { origin: PARENT, source: page.parent, data: { type: 'cc.connect', nonce: parent.postMessage.mock.calls[0][0].nonce }, ports: [ch.port2] });
  const Module: Record<string, unknown> = { kicadOpenFileBusy: () => busy.now, ...exports };
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const win = {
    FS: { analyzePath: () => ({ exists: false }), mkdirTree: () => {}, readdir: () => [], readFile: () => { throw new Error('ENOENT'); } },
    Module,
    wxElementRegistry: { findAll: () => [{ id: 'frame', typeName: 'FOOTPRINT_EDIT_FRAME', name: 'FootprintEditor', visible: true }], findByLabel: () => [] },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    addEventListener: (t: string, h: (e: unknown) => void) => { const s = listeners.get(t) ?? new Set(); s.add(h); listeners.set(t, s); },
    removeEventListener: (t: string, h: (e: unknown) => void) => listeners.get(t)?.delete(h),
    dispatchEvent: () => true,
  } as unknown as ToolWindow;
  r.engineReady(win, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
  await settle();
  let next = 1;
  const ask = async (op: string, args?: unknown, wait = 30) => {
    const id = next++;
    ch.port1.postMessage(args === undefined ? { id, op } : { id, op, args });
    for (let i = 0; i < 40 && got.find((m) => m.id === id) == null; i++) await settle(wait / 3);
    const m = got.find((x) => x.id === id);
    if (m == null) return undefined;
    const { id: _id, ...rest } = m;
    void _id;
    return rest;
  };
  const pointer = (type: string) => { for (const h of listeners.get(type) ?? []) h({ type, isTrusted: true }); };
  const ready = got.find((m) => m.type === 'ev.ready') as { caps: string[] } | undefined;
  return { r, got, win, ask, pointer, caps: (ready?.caps ?? []).filter((c) => !/^kicad/.test(c)) };
}
type Ok = { ok: true; result: Record<string, unknown> };

describe('the fpedit frame in the registry', () => {
  it('loads with this checkout\'s units, nothing broken, and the frame named', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect(REGISTRY.frames.get('fpedit')?.unit).toBe('fp-i1');
    expect(REGISTRY.pendingFrames.has('fpedit')).toBe(false);
    expect([...REGISTRY.ops.entries()].filter(([, o]) => o.unit === 'fp-i1').map(([op]) => op).sort()).toEqual([...OPS].sort());
    expect(REGISTRY.capNames.get('fpedit')).toBe('fp-i1');
    expect(REGISTRY.widen.get('select')?.map((w) => w.unit)).toContain('fp-i1');
  });

  it('boots pcbnew with the frame token fpedit, opens .kicad_mod, pcbnew\'s units, no picker', () => {
    const reg = buildRegistry(mods(unit));
    expect(bootFrame('fpedit', reg)).toBe('fpedit');
    expect(frameToken('fpedit' as never, reg)).toBe('fpedit');
    expect(frameTool('fpedit' as never, reg)).toBe('pcbnew');
    expect([ownDocument('fpedit' as never, reg), documentExtension('fpedit' as never, reg), unitsPerMm('fpedit' as never, reg), framePicks('fpedit' as never, reg), framePickKind('fpedit' as never, reg)])
      .toEqual([null, '.kicad_mod', 1e6, false, 'footprint']);
  });

  it('holds no action of its own (the held rows are fp-i2b\'s)', () => {
    expect(buildRegistry(mods(unit)).heldRows).toEqual([]);
  });
});

describe('caps per frame', () => {
  it('an fpedit frame on an engine with every export lists fpedit and only the built in caps its descriptor allows', async () => {
    const t = await boot('fpedit', { ...fakeFp().exports, kicadHostActions: () => true });
    expect(t.caps).toEqual(['fpedit', 'heldKeys', 'hostKeys', 'write']);
  });

  it('an fpedit frame on an engine without the exports (engine run 14) lists no fpedit, and every op names the first missing export', async () => {
    const t = await boot('fpedit', {});
    expect(t.caps).toEqual(['hostKeys', 'write']);
    for (const op of ['fpedit.state', 'fpedit.take']) expect(await t.ask(op)).toEqual(err('unsupported', 'kicadFpEditOpen'));
    expect(await t.ask('fpedit.open', { text: SOIC, name: 'SOIC-8', lib: '', mode: 'library', discard: false })).toEqual(err('unsupported', 'kicadFpEditOpen'));
    expect(await t.ask('fpedit.new', { name: 'NEW1', lib: '', type: 'smd', discard: false })).toEqual(err('unsupported', 'kicadFpEditOpen'));
    expect(await t.ask('fpedit.markSaved', { token: 'abc' })).toEqual(err('unsupported', 'kicadFpEditOpen'));
    expect(await t.ask('select', { uuids: [] })).toEqual(err('unsupported', 'kicadFpEditOpen'));
    // A later engine short of one export: that export is named.
    const { kicadFpEditPlotSvg: _gone, ...short } = fakeFp().exports;
    void _gone;
    const s = await boot('fpedit', short);
    expect(s.caps).not.toContain('fpedit');
    expect(await s.ask('fpedit.state')).toEqual(err('unsupported', 'kicadFpEditPlotSvg'));
  });

  it('a sch, pcb or symedit frame never lists fpedit and answers every fpedit op unsupported, its select as it ships', async () => {
    for (const frame of ['sch', 'pcb', 'symedit']) {
      const f = fakeFp();
      const t = await boot(frame, f.exports);
      expect(t.caps, frame).not.toContain('fpedit');
      for (const op of OPS) expect(await t.ask(op, {}), `${frame} ${op}`).toEqual(err('unsupported', 'a footprint edits in an fpedit frame'));
      // select is the frame's own there: the footprint editor's select is never called.
      await t.ask('select', { uuids: [P1] });
      expect(f.calls.filter((c) => (c as { select?: unknown }).select != null)).toEqual([]);
    }
  });
});

describe('an fpedit frame refuses what reads, saves or edits a document', () => {
  it('answers every built in op but its own eleven unsupported, whatever the args', async () => {
    const t = await boot('fpedit', fakeFp().exports);
    for (const op of ['project.open', 'project.import', 'project.save', 'project.plot', 'board.check', 'board.item.get', 'footprint.models', 'place', 'layers.get', 'layers.visible', 'symedit.open', 'settings.get', 'readonly', 'project.forget']) {
      expect(await t.ask(op, {}), op).toEqual(err('unsupported', FPEDIT_REFUSAL));
    }
    expect(BUILTIN_OPS.filter((op) => !REGISTRY.frames.get('fpedit')?.kind.refuses.includes(op)))
      .toEqual([...FPEDIT_WORKS].sort((a, b) => BUILTIN_OPS.indexOf(a) - BUILTIN_OPS.indexOf(b)));
  });

  it('runs the library reads, project.write and the keys (not refused)', async () => {
    const t = await boot('fpedit', fakeFp().exports);
    for (const op of ['lib.index', 'lib.item', 'project.write', 'project.libs', 'key.press']) {
      const a = await t.ask(op, {}) as { ok: boolean; error?: { message: string } };
      expect(a?.error?.message, op).not.toBe(FPEDIT_REFUSAL);
    }
  });
});

describe('the fpedit ops', () => {
  it('opens a footprint from text, reads its state, takes it back and marks it saved', async () => {
    const f = fakeFp();
    const t = await boot('fpedit', f.exports);
    expect(await t.ask('fpedit.state')).toEqual({ ok: true, result: { token: '', open: false, name: '', lib: '', mode: 'library', modified: false, depth: 0, padCount: 0, type: 'unspecified', padEditMode: false } });
    expect(await t.ask('fpedit.take')).toEqual(err('no_footprint', 'fpedit.take'));
    expect(await t.ask('fpedit.markSaved', { token: 'abc' })).toEqual(err('no_footprint', 'fpedit.markSaved'));
    const opened = await t.ask('fpedit.open', { text: SOIC, name: 'SOIC-8_3.9x4.9mm_P1.27mm', lib: 'fpedit-small_parts', mode: 'library', discard: false }) as Ok;
    expect(opened.ok).toBe(true);
    expect(opened.result).toMatchObject({ open: true, name: 'SOIC-8_3.9x4.9mm_P1.27mm', lib: 'fpedit-small_parts', mode: 'library', modified: false, depth: 0, padCount: 3, type: 'smd', padEditMode: false });
    expect(opened.result.token).toMatch(/^[\x20-\x7e]{1,64}$/);
    expect(f.calls[0]).toEqual({ text: SOIC, name: 'SOIC-8_3.9x4.9mm_P1.27mm', lib: 'fpedit-small_parts', mode: 'library', discard: false, token: opened.result.token });
    expect(await t.ask('fpedit.take')).toEqual({ ok: true, result: { name: 'SOIC-8_3.9x4.9mm_P1.27mm', text: SOIC } });
    f.edit();
    expect(await t.ask('fpedit.markSaved', { token: 'not-the-one' })).toEqual(err('bad_args', "fpedit.markSaved: the token is not the open footprint's"));
    expect(f.st.modified).toBe(true);
    const marked = await t.ask('fpedit.markSaved', { token: opened.result.token }) as Ok;
    expect(marked.result).toMatchObject({ modified: false, depth: 1 });
  });

  it('opens a placed footprint under no nickname, and makes a new one of each type', async () => {
    const f = fakeFp();
    const t = await boot('fpedit', f.exports);
    expect((await t.ask('fpedit.open', { text: SOIC, name: 'U1', lib: '', mode: 'placed', discard: false }) as Ok).result).toMatchObject({ mode: 'placed', lib: '' });
    for (const type of ['smd', 'through_hole', 'unspecified']) {
      const made = await t.ask('fpedit.new', { name: 'NEW1', lib: '', type, discard: true }) as Ok;
      expect(made.result, type).toMatchObject({ open: true, name: 'NEW1', mode: 'new', type, padCount: 0, depth: 0, modified: false });
    }
    expect(f.calls.at(-1)).toEqual({ new: { name: 'NEW1', lib: '', type: 'unspecified', discard: true, token: expect.any(String) } });
    expect(await t.ask('fpedit.new', { name: 'REFUSED', lib: '', type: 'smd', discard: true })).toEqual(err('bad_args', 'fpedit.new: KiCad refused the new footprint'));
  });

  it('refuses text KiCad reads no footprint from, a footprint past 8 MiB, and an open over held edits', async () => {
    const f = fakeFp();
    const t = await boot('fpedit', f.exports);
    expect(await t.ask('fpedit.open', { text: '(kicad_pcb)', name: 'X', lib: '', mode: 'library', discard: false })).toEqual(err('unreadable', 'fpedit.open: the text holds no footprint KiCad reads'));
    expect(f.st.open).toBe(false);
    expect(await t.ask('fpedit.open', { text: `(footprint "BIG" ${'x'.repeat(8 * 1024 * 1024)})`, name: 'BIG', lib: '', mode: 'library', discard: false }, 200)).toEqual(err('too_large', 'fpedit.open'));
    expect(f.calls).toHaveLength(1);
    await t.ask('fpedit.open', { text: SOIC, name: 'A', lib: '', mode: 'library', discard: false });
    f.edit();
    expect(await t.ask('fpedit.open', { text: SOIC, name: 'B', lib: '', mode: 'library', discard: false })).toEqual(err('held_edits', 'fpedit.open'));
    expect(await t.ask('fpedit.new', { name: 'C', lib: '', type: 'smd', discard: false })).toEqual(err('held_edits', 'fpedit.new'));
    expect(f.st.name).toBe('A');
    expect((await t.ask('fpedit.open', { text: SOIC, name: 'B', lib: '', mode: 'library', discard: true }) as Ok).result).toMatchObject({ name: 'B', modified: false });
  });

  it('says not_applied when the engine took the open but never shows it', async () => {
    const f = fakeFp({ apply: false });
    const t = await boot('fpedit', f.exports);
    expect(await t.ask('fpedit.open', { text: SOIC, name: 'A', lib: '', mode: 'library', discard: false }, 400)).toEqual(err('not_applied', 'fpedit.open'));
  });

  it('checks the args first, then busy, before any effect', async () => {
    const f = fakeFp();
    const busy = { now: false };
    const t = await boot('fpedit', f.exports, busy);
    const bad: Array<[string, unknown]> = [
      ['fpedit.open', { text: SOIC, name: 'A', lib: '', mode: 'library', discard: false, x: 1 }],
      ['fpedit.open', { text: SOIC, name: '', lib: '', mode: 'library', discard: false }],
      ['fpedit.open', { text: SOIC, name: 'A', lib: '', mode: 'board', discard: false }],
      ['fpedit.open', { text: '', name: 'A', lib: '', mode: 'library', discard: false }],
      ['fpedit.open', { text: SOIC, name: 'A\nB', lib: '', mode: 'library', discard: false }],
      ['fpedit.new', { name: 'A', lib: '', type: 'virtual', discard: false }],
      ['fpedit.new', { name: 'A', lib: '', type: 'smd' }],
      ['fpedit.state', { x: 1 }],
      ['fpedit.take', { x: 1 }],
      ['fpedit.markSaved', {}],
      ['select', { uuids: ['nope'] }],
    ];
    for (const [op, args] of bad) expect(await t.ask(op, args), `${op} ${JSON.stringify(args)}`).toEqual(err('bad_args', op));
    busy.now = true;
    expect(await t.ask('fpedit.open', { text: SOIC, name: 'A', lib: '', mode: 'library', discard: false })).toEqual(err('busy', 'fpedit.open'));
    expect(await t.ask('fpedit.state')).toEqual(err('busy', 'fpedit.state'));
    expect(f.calls).toEqual([]);
  });

  it('answers island_error for a state or a take of another shape', async () => {
    const f = fakeFp();
    const t = await boot('fpedit', { ...f.exports, kicadFpEditState: () => '{"open":true}' });
    expect(await t.ask('fpedit.state')).toEqual(err('island_error', 'the engine answered a state of another shape'));
    const g = fakeFp();
    const s = await boot('fpedit', { ...g.exports, kicadFpEditTake: () => JSON.stringify({ name: 'A', text: '(kicad_pcb)' }) });
    await s.ask('fpedit.open', { text: SOIC, name: 'A', lib: '', mode: 'library', discard: false });
    expect(await s.ask('fpedit.take')).toEqual(err('island_error', 'the engine answered a footprint of another shape'));
  });
});

describe('select in an fpedit frame', () => {
  it('selects the footprint\'s own items, an id it does not hold selecting nothing', async () => {
    const f = fakeFp();
    const t = await boot('fpedit', f.exports);
    expect(await t.ask('select', { uuids: [P1] })).toEqual(err('no_footprint', 'select'));
    await t.ask('fpedit.open', { text: SOIC, name: 'A', lib: '', mode: 'library', discard: false });
    const other = '66666666-0000-4000-8000-000000000009';
    expect(await t.ask('select', { uuids: [P2, other], zoom: true })).toEqual({ ok: true, result: {} });
    expect(f.calls.at(-1)).toEqual({ select: { uuids: [P2], zoom: true } });
    expect(await t.ask('select', { uuids: [] })).toEqual({ ok: true, result: {} });
    expect(f.calls.at(-1)).toEqual({ select: { uuids: [], zoom: false } });
  });
});

describe('the frame\'s events', () => {
  it('sends ev.edited from kicadFpEditState().depth, never for an open or a new', async () => {
    const f = fakeFp();
    const t = await boot('fpedit', f.exports);
    await t.ask('fpedit.open', { text: SOIC, name: 'A', lib: '', mode: 'library', discard: false });
    await settle(80);
    f.edit();
    await settle(80);
    f.edit();
    await settle(80);
    await t.ask('fpedit.new', { name: 'B', lib: '', type: 'smd', discard: true });
    await settle(80);
    f.edit();
    await settle(80);
    expect(t.got.filter((m) => m.type === 'ev.edited').map((m) => m.depth)).toEqual([1, 2, 1]);
  });

  it('sends ev.selected from kicadFpEditSelection() with fpPaths [], only while a footprint is open', async () => {
    const f = fakeFp();
    const t = await boot('fpedit', f.exports);
    f.pick([P1]);
    t.pointer('pointerup');
    await settle(400);
    expect(t.got.filter((m) => m.type === 'ev.selected')).toEqual([]);
    await t.ask('fpedit.open', { text: SOIC, name: 'A', lib: '', mode: 'library', discard: false });
    f.pick([P1, P3]);
    t.pointer('pointerup');
    await settle(400);
    expect(t.got.filter((m) => m.type === 'ev.selected').at(-1)).toEqual({ type: 'ev.selected', uuids: [P1, P3], fpPaths: [] });
  });
});
