// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// t17-i as the responder runs it: libs.problems, actions.state, ev.tool and
// the caps libTableProblems, actionStates, menuClarify and activeTool, each
// feature detected on build T17's exports. The engine here is this test's own
// fake of those exports, at the protocol boundary.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startResponder, timing } from '../responder';
import type { ExtUnit } from './contract';
import { buildRegistry, REGISTRY } from './registry';
import { hostToolSlot, SELECTION_TOOL, type HostToolWindow } from '../hostTool';
import unit, { parseActionsState, readActionStates, readTableProblems } from './t17-i';

const PARENT = 'http://localhost';
const ROUTE = 'pcbnew.InteractiveRouter.SingleTrack';
const GRID = 'common.Control.toggleGrid';
const RATS = 'pcbnew.Control.showRatsnest';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));
const err = (code: string, message: string) => ({ ok: false, error: { code, message } });
type Rec = Record<string, unknown>;
const SYM_TABLE = { path: '/project/sym-lib-table', kind: 'symbol', message: 'Syntax error at line 5, column 131' };

const saved = { applyPollMs: timing.applyPollMs };
beforeEach(() => { timing.applyPollMs = 5; });
afterEach(() => { Object.assign(timing, saved); });

/** Build T17's exports: the tables KiCad could not read, the action states, and the tool KiCad holds. */
function fakeT17(o: { states?: boolean; tables?: boolean; tool?: boolean } = {}) {
  const st = { grid: true, rats: false, tool: SELECTION_TOOL, busy: false, tables: [SYM_TABLE] as unknown[] };
  const calls: string[] = [];
  const exports: Rec = {
    kicadCollabBusy: () => st.busy,
    ...(o.tables === false ? {} : { kicadLibraryTableProblems: () => JSON.stringify({ tables: st.tables }) }),
    ...(o.states === false ? {} : {
      kicadActionStates: (json: string) => {
        calls.push(json);
        const a = JSON.parse(json) as { actions: string[] };
        const states: Record<string, boolean | null> = {};
        for (const n of a.actions) states[n] = n === GRID ? st.grid : n === RATS ? st.rats : null;
        return JSON.stringify({ states });
      },
    }),
    ...(o.tool === false ? {} : { kicadHostToolChanges: () => true, kicadActiveTool: () => st.tool }),
  };
  return { st, exports, calls };
}

/** A responder with t17-i alone, connected and booted on a fake engine; `got` collects what the host hears. */
async function boot(frame: string, exports: Rec, pre?: (win: HostToolWindow) => void) {
  const reg = buildRegistry(mods(unit));
  expect(reg.problems).toEqual([]);
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const parent = { postMessage: vi.fn() };
  const page = {
    parent, top: {}, location: { search: `?frame=${frame}&theme=day` },
    addEventListener: (t: string, h: (e: unknown) => void) => { const s = listeners.get(t) ?? new Set(); s.add(h); listeners.set(t, s); },
    removeEventListener: (t: string, h: (e: unknown) => void) => listeners.get(t)?.delete(h),
  } as unknown as Window;
  const r = startResponder({ parentOrigin: PARENT, page, ext: reg });
  const ch = new MessageChannel();
  const got: Rec[] = [];
  ch.port1.onmessage = (m) => got.push(m.data);
  for (const h of listeners.get('message') ?? []) h({ origin: PARENT, source: parent, data: { type: 'cc.connect', nonce: parent.postMessage.mock.calls[0][0].nonce }, ports: [ch.port2] });
  const win = {
    FS: { analyzePath: () => ({ exists: false }), mkdirTree: () => {}, readdir: () => [], readFile: () => { throw new Error('ENOENT'); } },
    Module: { kicadOpenFileBusy: () => false, ...exports },
    wxElementRegistry: { findAll: () => [], findByLabel: () => [] },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  } as unknown as ToolWindow & HostToolWindow;
  pre?.(win);
  r.engineReady(win, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
  await settle();
  let next = 1;
  const ask = async (op: string, args?: unknown) => {
    const id = next++;
    ch.port1.postMessage(args === undefined ? { id, op } : { id, op, args });
    for (let i = 0; i < 200 && got.find((m) => m.id === id) == null; i++) await settle(10);
    const m = got.find((x) => x.id === id);
    if (m == null) return undefined;
    const { id: _id, ...rest } = m;
    void _id;
    return rest;
  };
  const ready = got.find((m) => m.type === 'ev.ready') as { caps: string[] } | undefined;
  const pseudo = (ready?.caps ?? []).filter((c) => ['libTableProblems', 'actionStates', 'menuClarify', 'activeTool'].includes(c));
  return { r, got, win, ask, pseudo, say: (text: string) => win.kicadHostTool?.onChange?.(text) };
}

describe('t17-i in the registry', () => {
  it('loads with this checkout\'s units: its two ops (reads, answered during a check), four caps and ev.tool', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect([...REGISTRY.ops.entries()].filter(([, op]) => op.unit === 't17-i').map(([op]) => op).sort()).toEqual(['actions.state', 'libs.problems']);
    for (const op of ['actions.state', 'libs.problems']) expect(REGISTRY.ops.get(op)?.op.passesCheck).toBe(true);
    for (const cap of ['libTableProblems', 'actionStates', 'menuClarify', 'activeTool']) expect(REGISTRY.capNames.get(cap)).toBe('t17-i');
    expect(REGISTRY.events.get('ev.tool')?.keys).toEqual(['name']);
  });
});

describe('the caps, feature detected', () => {
  it('build T17 lists all four in every frame', async () => {
    for (const frame of ['sch', 'pcb', 'symedit']) {
      expect((await boot(frame, fakeT17().exports)).pseudo, frame).toEqual(['actionStates', 'activeTool', 'libTableProblems', 'menuClarify']);
    }
  });

  it('each is listed only with its own exports; T16b (none of them) lists none and answers both ops unsupported naming the export', async () => {
    expect((await boot('pcb', fakeT17({ states: false }).exports)).pseudo).toEqual(['activeTool', 'libTableProblems', 'menuClarify']);
    expect((await boot('pcb', fakeT17({ tables: false, tool: false }).exports)).pseudo).toEqual(['actionStates']);
    // menuClarify follows kicadHostToolChanges alone (the clarify fix came with it in build T17).
    expect((await boot('pcb', { ...fakeT17({ states: false, tables: false, tool: false }).exports, kicadHostToolChanges: () => true })).pseudo).toEqual(['menuClarify']);
    const old = await boot('pcb', fakeT17({ states: false, tables: false, tool: false }).exports);
    expect(old.pseudo).toEqual([]);
    expect(await old.ask('libs.problems')).toEqual(err('unsupported', 'kicadLibraryTableProblems'));
    expect(await old.ask('actions.state', { actions: [GRID] })).toEqual(err('unsupported', 'kicadActionStates'));
    expect(old.got.filter((m) => m.type === 'ev.tool')).toEqual([]);
  });
});

describe('libs.problems', () => {
  it('answers the tables KiCad could not read, [] when none', async () => {
    const f = fakeT17();
    const t = await boot('sch', f.exports);
    expect(await t.ask('libs.problems')).toEqual({ ok: true, result: { tables: [SYM_TABLE] } });
    f.st.tables = [];
    expect(await t.ask('libs.problems', {})).toEqual({ ok: true, result: { tables: [] } });
  });

  it('refuses args, and answers island_error for another shape or a throw', async () => {
    const t = await boot('pcb', fakeT17().exports);
    expect(await t.ask('libs.problems', { x: 1 })).toEqual(err('bad_args', 'libs.problems'));
    const odd = await boot('pcb', { ...fakeT17().exports, kicadLibraryTableProblems: () => '{"tables":[{"path":"x","kind":"model","message":""}]}' });
    expect(await odd.ask('libs.problems')).toEqual(err('island_error', 'libs.problems: the engine answered another shape'));
    const throws = await boot('pcb', { ...fakeT17().exports, kicadLibraryTableProblems: () => { throw new Error('trap'); } });
    expect(await throws.ask('libs.problems')).toEqual(err('island_error', 'libs.problems'));
  });

  it('reads the engine\'s answer closed', () => {
    expect(readTableProblems('{"tables":[]}')).toEqual([]);
    expect(readTableProblems(JSON.stringify({ tables: [SYM_TABLE, { path: '/g/fp-lib-table', kind: 'footprint', message: 'x' }, { path: '/g/design-block-lib-table', kind: 'designBlock', message: '' }] }))).toHaveLength(3);
    for (const bad of [
      '', 'x', '[]', '{}', '{"tables":{}}', '{"tables":[],"more":1}',
      JSON.stringify({ tables: [{ ...SYM_TABLE, more: 1 }] }), JSON.stringify({ tables: [{ ...SYM_TABLE, path: '' }] }),
      JSON.stringify({ tables: [{ ...SYM_TABLE, kind: 'model' }] }), JSON.stringify({ tables: [{ ...SYM_TABLE, message: 3 }] }),
      JSON.stringify({ tables: [SYM_TABLE, SYM_TABLE] }), JSON.stringify({ tables: Array.from({ length: 65 }, (_, i) => ({ ...SYM_TABLE, path: `/p${i}` })) }),
    ]) expect(readTableProblems(bad), bad).toBeNull();
    expect(readTableProblems({ tables: [] })).toBeNull();
  });
});

describe('actions.state', () => {
  it('answers each action\'s state, null for one that is no toggle or no action of the frame', async () => {
    const f = fakeT17();
    const t = await boot('pcb', f.exports);
    const r = await t.ask('actions.state', { actions: [GRID, RATS, 'no.such.action'] });
    expect(r).toEqual({ ok: true, result: { states: { [GRID]: true, [RATS]: false, 'no.such.action': null } } });
    expect(f.calls).toEqual([JSON.stringify({ actions: [GRID, RATS, 'no.such.action'] })]);
  });

  it('waits for the apply queue first, so an action just run reads flipped; busy when the queue stays busy', async () => {
    const f = fakeT17();
    const t = await boot('pcb', f.exports);
    f.st.busy = true;
    setTimeout(() => { f.st.grid = false; f.st.busy = false; }, 40);
    expect(await t.ask('actions.state', { actions: [GRID] })).toEqual({ ok: true, result: { states: { [GRID]: false } } });
    f.st.busy = true;
    expect(await t.ask('actions.state', { actions: [GRID] })).toEqual(err('busy', 'actions.state'));
    expect(f.calls).toHaveLength(1);
  });

  it('refuses other args before the engine; "" is not_ready; another shape is island_error', async () => {
    const f = fakeT17();
    const t = await boot('pcb', f.exports);
    for (const bad of [undefined, {}, { actions: [] }, { actions: [GRID], more: 1 }, { actions: ['bad name'] }, { actions: [7] }, { actions: Array.from({ length: 257 }, () => GRID) }])
      expect(await t.ask('actions.state', bad), JSON.stringify(bad)).toEqual(err('bad_args', 'actions.state'));
    expect(f.calls).toEqual([]);
    const none = await boot('pcb', { ...f.exports, kicadActionStates: () => '' });
    expect(await none.ask('actions.state', { actions: [GRID] })).toEqual(err('not_ready', 'actions.state'));
    const odd = await boot('pcb', { ...f.exports, kicadActionStates: () => '{"states":{"x.y":true}}' });
    expect(await odd.ask('actions.state', { actions: [GRID] })).toEqual(err('island_error', 'actions.state: the engine answered another shape'));
  });

  it('parses the args and reads the answer closed against the names asked (a name asked twice is one key)', () => {
    expect(parseActionsState({ actions: [GRID, GRID] })).toEqual([GRID, GRID]);
    expect(parseActionsState({ actions: Array.from({ length: 256 }, () => GRID) })).toHaveLength(256);
    expect(readActionStates(JSON.stringify({ states: { [GRID]: true } }), [GRID, GRID])).toEqual({ [GRID]: true });
    for (const bad of [
      '', '{}', JSON.stringify({ states: {} }), JSON.stringify({ states: { [GRID]: 1 } }), JSON.stringify({ states: { [GRID]: true, [RATS]: true } }),
      JSON.stringify({ states: { [GRID]: true }, more: 1 }), JSON.stringify({ states: [true] }),
    ]) expect(readActionStates(bad, [GRID]), bad).toBeNull();
  });
});

describe('ev.tool', () => {
  it('goes out right after ev.ready with the tool held now, then once per change, never twice in a row', async () => {
    const f = fakeT17();
    const t = await boot('pcb', f.exports);
    const order = t.got.filter((m) => m.type === 'ev.ready' || m.type === 'ev.tool').map((m) => m.type);
    expect(order).toEqual(['ev.ready', 'ev.tool']);
    t.say(JSON.stringify({ tool: ROUTE }));
    t.say(JSON.stringify({ tool: ROUTE }));
    t.say('{"tool":3}');
    t.say(JSON.stringify({ tool: SELECTION_TOOL }));
    await settle();
    expect(t.got.filter((m) => m.type === 'ev.tool')).toEqual([
      { type: 'ev.tool', name: SELECTION_TOOL },
      { type: 'ev.tool', name: ROUTE },
      { type: 'ev.tool', name: SELECTION_TOOL },
    ]);
  });

  it('uses the slot taken before boot: a change told while the engine started is kept for after ev.ready', async () => {
    const f = fakeT17();
    f.st.tool = '';
    const t = await boot('sch', f.exports, (win) => {
      // src/main.ts takes the slot before the engine's scripts load; the engine tells a change while it starts.
      hostToolSlot(win);
      win.kicadHostTool?.onChange?.(JSON.stringify({ tool: ROUTE }));
    });
    expect(t.got.filter((m) => m.type === 'ev.tool')).toEqual([{ type: 'ev.tool', name: ROUTE }]);
  });

  it('falls back to the last name told when kicadActiveTool answers "" (no frame yet)', async () => {
    const f = fakeT17();
    f.st.tool = '';
    const t = await boot('pcb', f.exports);
    expect(t.got.filter((m) => m.type === 'ev.tool')).toEqual([]);
    t.say(JSON.stringify({ tool: ROUTE }));
    await settle();
    expect(t.got.filter((m) => m.type === 'ev.tool')).toEqual([{ type: 'ev.tool', name: ROUTE }]);
  });
});
