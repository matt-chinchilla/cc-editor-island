// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// ds-i1 as the responder runs it: the ds frame (its tool, its refusals, its
// caps per frame, its held actions), dsedit.open, dsedit.state, dsedit.take,
// dsedit.markSaved, dsedit.show and select in a ds frame, each check in its
// order, ev.edited from the sheet's undo depth. The engine here is this
// test's own fake of the dsedit exports (spec 5.2), at the protocol boundary.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startResponder, timing } from '../responder';
import { HELD_ACTIONS } from '../held';
import { BUILTIN_OPS } from './builtins';
import type { ExtUnit } from './contract';
import { buildRegistry, heldActions, REGISTRY } from './registry';
import { bootFrame, documentExtension, extTool, framePicks, frameToken, frameTool, ownDocument, unitsPerMm } from '../../src/frames';
import { DS_HELD, DS_REFUSAL, DS_WORKS, DSEDIT_EXPORTS } from '../dsedit';
import unit from './ds-i1';

const PARENT = 'http://localhost';
const U1 = '33333333-0000-4000-8000-000000000001';
const U2 = '33333333-0000-4000-8000-000000000002';
const U3 = '33333333-0000-4000-8000-000000000003';
const WKS = '(kicad_wks (version 20231118) (generator "pl_editor"))';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));
const err = (code: string, message: string) => ({ ok: false, error: { code, message } });

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

/** The fake engine's dsedit exports over one sheet of three items (U1, U2, U3). */
function fakeDs(o: { show?: boolean } = {}) {
  const st = { token: '', open: false, name: '', modified: false, depth: 0, page: 1, values: true, items: 0 };
  const sheet = { text: '' };
  let selection: string[] = [];
  const held = [U1, U2, U3];
  const calls: unknown[] = [];
  const exports: Record<string, unknown> = {
    ...Object.fromEntries(DSEDIT_EXPORTS.map((n) => [n, () => false])),
    kicadDsEditOpen: (j: string) => {
      const a = JSON.parse(j) as { source: string; text?: string; name: string; discard: boolean; token: string };
      calls.push(a);
      if (a.text?.includes('BROKEN')) return JSON.stringify({ error: 'unreadable', message: 'Expecting ) in input/source line 7, offset 3' });
      if (st.open && st.modified && !a.discard) return '{"error":"held_edits"}';
      Object.assign(st, { token: a.token, open: true, name: a.name, modified: false, depth: 0, page: 1, values: true, items: a.source === 'empty' ? 0 : 3 });
      sheet.text = a.source === 'text' ? (a.text as string) : WKS;
      selection = [];
      return '{"error":""}';
    },
    kicadDsEditState: () => JSON.stringify(st),
    kicadDsEditTake: () => JSON.stringify({ name: st.name, text: sheet.text }),
    kicadDsEditMarkSaved: (t: string) => { if (t !== st.token) return false; st.modified = false; return true; },
    kicadDsEditShow: (j: string) => {
      const a = JSON.parse(j) as { page: 1 | 2; values: boolean };
      calls.push({ show: a });
      if (o.show !== false) { st.page = a.page; st.values = a.values; }
      return true;
    },
    kicadDsEditItemsGet: (j: string) => {
      const want = (JSON.parse(j) as { uuids?: string[] }).uuids;
      return JSON.stringify({ items: held.filter((u) => want == null || want.includes(u)).map((uuid) => ({ kind: 'line', uuid })) });
    },
    kicadDsEditSelect: (j: string) => { const a = JSON.parse(j) as { uuids: string[]; zoom: boolean }; calls.push({ select: a }); selection = a.uuids; return true; },
    kicadDsEditSelection: () => JSON.stringify({ uuids: selection }),
    kicadCollabBusy: () => false,
    kicadHostActions: () => true,
  };
  const edit = () => { st.depth++; st.modified = true; };
  return { st, exports, calls, edit };
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

/** A responder with ds-i1 alone, connected and booted on a fake engine with `exports`; `got` collects what the host hears. */
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
  const win = {
    FS: { analyzePath: () => ({ exists: false }), mkdirTree: () => {}, readdir: () => [], readFile: () => { throw new Error('ENOENT'); } },
    Module,
    wxElementRegistry: { findAll: () => [{ id: 'frame', typeName: 'PL_EDITOR_FRAME', name: 'DrawFrame', visible: true }], findByLabel: () => [] },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    dispatchEvent: () => true,
  } as unknown as ToolWindow & { kicadHostAction?: { onRequest?: (json: unknown) => boolean } };
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
  const ready = got.find((m) => m.type === 'ev.ready') as { caps: string[] } | undefined;
  return { r, got, win, ask, caps: (ready?.caps ?? []).filter((c) => !/^kicad/.test(c)) };
}

describe('the ds frame in the registry', () => {
  it('loads with this checkout\'s units, nothing broken, and the frame named', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect(REGISTRY.frames.get('ds')?.unit).toBe('ds-i1');
    expect(REGISTRY.pendingFrames.has('ds')).toBe(false);
    expect([...REGISTRY.ops.entries()].filter(([, o]) => o.unit === 'ds-i1').map(([op]) => op).sort())
      .toEqual(['dsedit.markSaved', 'dsedit.open', 'dsedit.show', 'dsedit.state', 'dsedit.take']);
    expect(REGISTRY.capNames.get('dsedit')).toBe('ds-i1');
    expect(REGISTRY.widen.get('select')?.map((w) => w.unit)).toContain('ds-i1');
  });

  it('boots pl_editor in the merged image with the frame token ds', () => {
    const reg = buildRegistry(mods(unit));
    expect(bootFrame('ds', reg)).toBe('ds');
    expect(frameToken('ds' as never, reg)).toBe('ds');
    expect(frameTool('ds' as never, reg)).toBe('pl_editor');
    expect(extTool('pl_editor', reg)).toEqual({ name: 'pl_editor', bundle: 'kicad_editor', argv0: '/usr/bin/pl_editor', needsConfigSeed: true, libKind: null });
    expect([ownDocument('ds' as never, reg), documentExtension('ds' as never, reg), unitsPerMm('ds' as never, reg), framePicks('ds' as never, reg)]).toEqual([null, '.kicad_wks', 1e3, false]);
  });

  it('holds the frame\'s twelve actions in a ds frame under dsedit, and nothing in another frame', () => {
    const reg = buildRegistry(mods(unit));
    expect(reg.heldRows).toEqual(DS_HELD.map((action) => ({ action, frames: ['ds'], cap: 'dsedit' })));
    expect(heldActions(reg)).toHaveLength(HELD_ACTIONS.length + 12);
  });
});

describe('caps per frame', () => {
  it('a ds frame on an engine with every export lists dsedit, the held keys and the host\'s keys only', async () => {
    const t = await boot('ds', fakeDs().exports);
    expect(t.caps).toEqual(['dsedit', 'hostKeys', 'heldKeys'].sort());
  });

  it('a ds frame on an engine without the exports (engine run 14) lists no dsedit, and every op names the first missing export', async () => {
    const t = await boot('ds', { kicadHostActions: () => true });
    expect(t.caps).toEqual(['heldKeys', 'hostKeys']);
    for (const op of ['dsedit.state', 'dsedit.take']) expect(await t.ask(op)).toEqual(err('unsupported', 'kicadDsEditOpen'));
    expect(await t.ask('dsedit.open', { source: 'default', name: 'a.kicad_wks', discard: false })).toEqual(err('unsupported', 'kicadDsEditOpen'));
    expect(await t.ask('select', { uuids: [] })).toEqual(err('unsupported', 'kicadDsEditOpen'));
  });

  it('a sch or a pcb frame never lists dsedit and answers every dsedit op unsupported, its select as it ships', async () => {
    for (const frame of ['sch', 'pcb', 'symedit']) {
      const f = fakeDs();
      const t = await boot(frame, f.exports);
      expect(t.caps).not.toContain('dsedit');
      for (const op of ['dsedit.open', 'dsedit.state', 'dsedit.take', 'dsedit.markSaved', 'dsedit.show']) {
        expect(await t.ask(op, {}), `${frame} ${op}`).toEqual(err('unsupported', 'a drawing sheet edits in a ds frame'));
      }
      // select is the frame's own: the ds editor's select is never called there.
      await t.ask('select', { uuids: [U1] });
      expect(f.calls.filter((c) => (c as { select?: unknown }).select != null)).toEqual([]);
    }
  });
});

describe('a ds frame refuses what reads, saves or edits a document', () => {
  it('answers every built in op but its own six unsupported, whatever the args', async () => {
    const t = await boot('ds', fakeDs().exports);
    for (const op of ['project.open', 'project.write', 'project.libs', 'project.forget', 'project.save', 'symedit.open', 'symedit.state', 'place', 'settings.get', 'sheet.check', 'readonly']) {
      expect(await t.ask(op, {}), op).toEqual(err('unsupported', DS_REFUSAL));
    }
    expect(BUILTIN_OPS.filter((op) => !REGISTRY.frames.get('ds')?.kind.refuses.includes(op))).toEqual([...DS_WORKS].sort((a, b) => BUILTIN_OPS.indexOf(a) - BUILTIN_OPS.indexOf(b)));
  });
});

describe('the dsedit ops', () => {
  it('opens a sheet from text, reads its state, takes it back and marks it saved', async () => {
    const f = fakeDs();
    const t = await boot('ds', f.exports);
    expect(await t.ask('dsedit.state')).toEqual({ ok: true, result: { token: '', open: false, name: '', modified: false, depth: 0, page: 1, values: true, items: 0 } });
    expect(await t.ask('dsedit.take')).toEqual(err('no_sheet', 'dsedit.take'));
    expect(await t.ask('dsedit.show', { page: 2, values: false })).toEqual(err('no_sheet', 'dsedit.show'));
    const opened = await t.ask('dsedit.open', { source: 'text', text: WKS, name: 'sheets/custom.kicad_wks', discard: false }) as { ok: true; result: Record<string, unknown> };
    expect(opened.ok).toBe(true);
    expect(opened.result).toMatchObject({ open: true, name: 'sheets/custom.kicad_wks', modified: false, depth: 0, page: 1, values: true, items: 3 });
    expect(opened.result.token).toMatch(/^[\x20-\x7e]{1,64}$/);
    expect(f.calls[0]).toEqual({ source: 'text', text: WKS, name: 'sheets/custom.kicad_wks', discard: false, token: opened.result.token });
    expect(await t.ask('dsedit.take')).toEqual({ ok: true, result: { name: 'sheets/custom.kicad_wks', text: WKS } });
    f.edit();
    expect(await t.ask('dsedit.markSaved', { token: 'not-the-one' })).toEqual(err('bad_args', "dsedit.markSaved: the token is not the open sheet's"));
    expect(f.st.modified).toBe(true);
    const marked = await t.ask('dsedit.markSaved', { token: opened.result.token }) as { ok: true; result: Record<string, unknown> };
    expect(marked.result).toMatchObject({ modified: false, depth: 1 });
  });

  it('opens KiCad\'s default and an empty sheet with no text sent', async () => {
    const f = fakeDs();
    const t = await boot('ds', f.exports);
    expect((await t.ask('dsedit.open', { source: 'default', name: 'new.kicad_wks', discard: false }))?.ok).toBe(true);
    expect((await t.ask('dsedit.open', { source: 'empty', name: 'blank.kicad_wks', discard: false }) as { result: { items: number } }).result.items).toBe(0);
    expect(f.calls.map((c) => Object.keys(c as object).sort())).toEqual([['discard', 'name', 'source', 'token'], ['discard', 'name', 'source', 'token']]);
  });

  it('refuses an unreadable sheet with KiCad\'s line, a sheet past 8 MiB, and an open over held edits', async () => {
    const f = fakeDs();
    const t = await boot('ds', f.exports);
    expect(await t.ask('dsedit.open', { source: 'text', text: '(kicad_wks BROKEN', name: 'b.kicad_wks', discard: false })).toEqual(err('unreadable', 'Expecting ) in input/source line 7, offset 3'));
    expect(f.st.open).toBe(false);
    expect(await t.ask('dsedit.open', { source: 'text', text: 'x'.repeat(8 * 1024 * 1024 + 1), name: 'big.kicad_wks', discard: false }, 200)).toEqual(err('too_large', 'dsedit.open'));
    expect(f.calls).toHaveLength(1);
    await t.ask('dsedit.open', { source: 'default', name: 'a.kicad_wks', discard: false });
    f.edit();
    expect(await t.ask('dsedit.open', { source: 'empty', name: 'b.kicad_wks', discard: false })).toEqual(err('held_edits', 'dsedit.open'));
    expect(f.st.name).toBe('a.kicad_wks');
    expect((await t.ask('dsedit.open', { source: 'empty', name: 'b.kicad_wks', discard: true }) as { result: { name: string; modified: boolean } }).result).toMatchObject({ name: 'b.kicad_wks', modified: false });
  });

  it('shows the other pages with the names, no undo step, and says not_applied when the engine never shows it', async () => {
    const f = fakeDs();
    const t = await boot('ds', f.exports);
    await t.ask('dsedit.open', { source: 'default', name: 'a.kicad_wks', discard: false });
    const shown = await t.ask('dsedit.show', { page: 2, values: false }) as { ok: true; result: Record<string, unknown> };
    expect(shown.result).toMatchObject({ page: 2, values: false, depth: 0, modified: false });
    const g = fakeDs({ show: false });
    const s = await boot('ds', g.exports);
    await s.ask('dsedit.open', { source: 'default', name: 'a.kicad_wks', discard: false });
    expect(await s.ask('dsedit.show', { page: 2, values: true }, 400)).toEqual(err('not_applied', 'dsedit.show'));
  });

  it('checks the args first, then busy, before any effect', async () => {
    const f = fakeDs();
    const busy = { now: false };
    const t = await boot('ds', f.exports, busy);
    for (const [op, args] of [['dsedit.open', { source: 'default', name: 'a', discard: false, x: 1 }], ['dsedit.state', { x: 1 }], ['dsedit.take', { x: 1 }], ['dsedit.markSaved', {}], ['dsedit.show', { page: 3, values: true }], ['select', { uuids: ['nope'] }]] as const) {
      expect(await t.ask(op, args), op).toEqual(err('bad_args', op));
    }
    busy.now = true;
    expect(await t.ask('dsedit.open', { source: 'default', name: 'a', discard: false })).toEqual(err('busy', 'dsedit.open'));
    expect(await t.ask('dsedit.state')).toEqual(err('busy', 'dsedit.state'));
    expect(f.calls).toEqual([]);
  });

  it('answers island_error for a state of another shape', async () => {
    const f = fakeDs();
    const t = await boot('ds', { ...f.exports, kicadDsEditState: () => '{"open":true}' });
    expect(await t.ask('dsedit.state')).toEqual(err('island_error', 'the engine answered a state of another shape'));
  });
});

describe('select in a ds frame', () => {
  it('selects the sheet\'s own items, an id it does not hold selecting nothing', async () => {
    const f = fakeDs();
    const t = await boot('ds', f.exports);
    expect(await t.ask('select', { uuids: [U1] })).toEqual(err('no_sheet', 'select'));
    await t.ask('dsedit.open', { source: 'default', name: 'a.kicad_wks', discard: false });
    const other = '44444444-0000-4000-8000-000000000009';
    expect(await t.ask('select', { uuids: [U2, other], zoom: true })).toEqual({ ok: true, result: {} });
    expect(f.calls.at(-1)).toEqual({ select: { uuids: [U2], zoom: true } });
    expect(await t.ask('select', { uuids: [] })).toEqual({ ok: true, result: {} });
    expect(f.calls.at(-1)).toEqual({ select: { uuids: [], zoom: false } });
  });
});

describe('the frame\'s events', () => {
  it('sends ev.held for a held action only in a ds frame, after ev.ready with a sheet open', async () => {
    const f = fakeDs();
    const t = await boot('ds', f.exports);
    const ask = (action: string) => t.win.kicadHostAction?.onRequest?.(JSON.stringify({ action }));
    expect(ask('common.Control.save')).toBe(false);
    await t.ask('dsedit.open', { source: 'default', name: 'a.kicad_wks', discard: false });
    for (const action of DS_HELD) expect(ask(action), action).toBe(true);
    expect(ask('plEditor.InteractiveDrawing.drawLine')).toBe(false);
    await settle();
    expect(t.got.filter((m) => m.type === 'ev.held').map((m) => m.action)).toEqual([...DS_HELD]);
    // The same actions are KiCad's in a sch frame (only its own rows there).
    const s = await boot('sch', fakeDs().exports);
    expect(s.win.kicadHostAction?.onRequest?.(JSON.stringify({ action: 'plEditor.EditorControl.ShowInspector' }))).toBe(false);
  });

  it('sends ev.edited from the sheet\'s undo depth, never for an open', async () => {
    const f = fakeDs();
    const t = await boot('ds', f.exports);
    await t.ask('dsedit.open', { source: 'default', name: 'a.kicad_wks', discard: false });
    await settle(80);
    f.edit();
    await settle(80);
    f.edit();
    await settle(80);
    await t.ask('dsedit.open', { source: 'empty', name: 'b.kicad_wks', discard: true });
    await settle(80);
    expect(t.got.filter((m) => m.type === 'ev.edited').map((m) => m.depth)).toEqual([1, 2]);
  });
});
