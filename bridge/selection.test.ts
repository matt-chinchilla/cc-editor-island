// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pin from '../PIN.json' with { type: 'json' };
import hotkeysText from '../theme/user.hotkeys?raw';
import { hasKicadClone, kicadFileAt, kicadGrepAt } from '../src/engine-source.mjs';
import { MAX_SELECT, parseSelectArgs, parseSelectionEmit, selectIds, selectItems, SelectionFeed, ZOOM_SELECTION_KEY, type Selection, type SelectionWindow } from './selection';

const U1 = '0b9b3c55-6d0e-4c6c-9e86-2f3f1d6f7a01';
const U2 = '1c8a2d44-5e1f-4b7b-8f75-3e2e0c5e6b02';
const U3 = '2d7b1e33-4f20-4a8a-9e64-4d1dfb4d5c03';
const SHEET = '9f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f';

describe('the engine\'s selection emit', () => {
  it('reads both shapes: the schematic editor\'s bare uuid array and the board editor\'s {uuids, fpPaths}', () => {
    expect(parseSelectionEmit(JSON.stringify([U1, U2]))).toEqual({ uuids: [U1, U2], fpPaths: [] });
    expect(parseSelectionEmit(JSON.stringify({ uuids: [U1], fpPaths: [`/${SHEET}/${U2}`] }))).toEqual({ uuids: [U1], fpPaths: [`/${SHEET}/${U2}`] });
    expect(parseSelectionEmit(JSON.stringify({ uuids: [U1] }))).toEqual({ uuids: [U1], fpPaths: [] });
    expect(parseSelectionEmit('[]')).toEqual({ uuids: [], fpPaths: [] });
  });

  it('refuses anything else, so the last selection stands', () => {
    for (const bad of ['', 'not json', '{"uuids":[1]}', '{"fpPaths":[]}', '[null]', '"x"', '{"uuids":[],"fpPaths":"x"}', null, 3]) {
      expect(parseSelectionEmit(bad), String(bad)).toBeNull();
    }
  });
});

describe('select\'s args', () => {
  it('take item uuids, footprint paths and zoom, each kept once in order', () => {
    expect(parseSelectArgs({ uuids: [U1] })).toEqual({ uuids: [U1], fpPaths: [], zoom: false });
    expect(parseSelectArgs({ uuids: [U1, U2, U1], fpPaths: [`/${U3}`, `/${SHEET}/${U3}`, `/${U3}`], zoom: true })).toEqual({ uuids: [U1, U2], fpPaths: [`/${U3}`, `/${SHEET}/${U3}`], zoom: true });
    expect(parseSelectArgs({ uuids: [] })).toEqual({ uuids: [], fpPaths: [], zoom: false });
  });

  it('are closed: any other key, type or shape is refused', () => {
    const bad: unknown[] = [
      undefined, null, [], 'x',
      {},                                         // uuids is required
      { uuids: [U1], extra: 1 },
      { uuids: U1 },
      { uuids: [U1.toUpperCase()] },              // KiCad writes uuids in lower case
      { uuids: ['R1'] },
      { uuids: [`${U1}x`] },
      { uuids: [1] },
      { uuids: [U1], fpPaths: [U1] },             // a path starts with a slash
      { uuids: [U1], fpPaths: [`/${U1}/`] },      // and ends with a uuid
      { uuids: [U1], fpPaths: ['/'] },
      { uuids: [U1], fpPaths: `/${U1}` },
      { uuids: [U1], zoom: 'yes' },
      { uuids: Array.from({ length: MAX_SELECT + 1 }, () => U1) },
    ];
    for (const a of bad) expect(parseSelectArgs(a), JSON.stringify(a)).toBeNull();
  });

  it('hand a schematic each footprint path\'s symbol uuid, and a board only its uuids (no export finds a footprint by its path)', () => {
    const a = { uuids: [U1], fpPaths: [`/${SHEET}/${U2}`, `/${U1}`], zoom: false };
    expect(selectIds('sch', a)).toEqual([U1, U2]);
    expect(selectIds('pcb', a)).toEqual([U1]);
  });
});

/** An engine whose selection hook, reads and select calls behave as PCBJam's presence core does. */
function fakeEngine(shape: 'sch' | 'pcb' = 'pcb') {
  const sel: string[] = [];
  const paths = new Map<string, string>();
  const listeners = new Map<string, Set<(e: Event) => void>>();
  const payload = () => (shape === 'pcb' ? JSON.stringify({ uuids: sel, fpPaths: sel.filter((u) => paths.has(u)).map((u) => paths.get(u)) }) : JSON.stringify(sel));
  const known = new Set([U1, U2, U3]);
  /** Calls queued on the editor's loop (CallAfter), run in order 1 ms later. */
  const later = (fn: () => void) => { setTimeout(fn, 1); };
  const Module = {
    kicadCollabPresenceStart: vi.fn(() => undefined),
    kicadCollabGetSelection: vi.fn(() => JSON.stringify(sel)),
    kicadCollabGetSelectionFull: vi.fn(() => (shape === 'pcb' ? payload() : JSON.stringify({ uuids: sel, fpPaths: [] }))),
    kicadCollabTestClearSelection: vi.fn((): unknown => { later(() => { sel.length = 0; }); return true; }),
    kicadCollabTestSelectByUuid: vi.fn((u: string): unknown => { if (!known.has(u)) return false; later(() => { if (!sel.includes(u)) sel.push(u); }); return true; }),
  };
  const win = {
    Module,
    kicadCollab: {} as SelectionWindow['kicadCollab'],
    addEventListener: (t: string, h: (e: Event) => void) => { const s = listeners.get(t) ?? new Set(); s.add(h); listeners.set(t, s); },
    removeEventListener: (t: string, h: (e: Event) => void) => { listeners.get(t)?.delete(h); },
  };
  /** The engine's emit: what the presence core hands window.kicadCollab.onSelection. */
  const emitNow = () => win.kicadCollab?.onSelection?.(payload());
  const dispatch = (t: string) => { for (const h of listeners.get(t) ?? []) h(new Event(t)); };
  return { win: win as unknown as SelectionWindow & typeof win, Module, sel, paths, known, emitNow, dispatch, listeners };
}

describe('ev.selected\'s feed', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function feed(opts: { shape?: 'sch' | 'pcb'; live?: () => boolean } = {}) {
    const eng = fakeEngine(opts.shape);
    const sent: Selection[] = [];
    const f = new SelectionFeed(eng.win, { timing: { selectSettleMs: 50, selectPullMs: 200 }, frame: opts.shape ?? 'pcb', live: opts.live ?? (() => true), send: (s) => sent.push(s) });
    return { eng, f, sent };
  }

  it('takes the selection slot once, keeping a listener already in it, and arms a board\'s hook at boot', () => {
    const { eng, f } = feed();
    const prior = vi.fn();
    eng.win.kicadCollab = { onSave: () => undefined, onSelection: prior };
    expect(f.start()).toBe(true);
    expect(f.start()).toBe(false);
    expect(eng.Module.kicadCollabPresenceStart).toHaveBeenCalledTimes(1);
    f.reset();
    f.reset();
    expect(eng.Module.kicadCollabPresenceStart).toHaveBeenCalledTimes(1);
    expect(typeof eng.win.kicadCollab?.onSave).toBe('function');
    eng.win.kicadCollab?.onSelection?.('[]');
    expect(prior).toHaveBeenCalledWith('[]');
  });

  it('arms a schematic\'s hook at its first document, once (registered before an import, the engine\'s listener cost the import its sheet switches)', () => {
    const { eng, f } = feed({ shape: 'sch' });
    expect(f.start()).toBe(true);
    expect(eng.Module.kicadCollabPresenceStart).not.toHaveBeenCalled();
    f.reset();
    f.reset();
    expect(eng.Module.kicadCollabPresenceStart).toHaveBeenCalledTimes(1);
  });

  it('arms nothing on an engine without kicadCollabPresenceStart', () => {
    const { eng, f } = feed();
    delete (eng.Module as Partial<typeof eng.Module>).kicadCollabPresenceStart;
    expect(f.start()).toBe(false);
    expect(eng.win.kicadCollab?.onSelection).toBeUndefined();
  });

  it('sends a burst once, after it settles, with the selection it settled on', async () => {
    const { eng, f, sent } = feed();
    f.start();
    eng.paths.set(U2, `/${SHEET}/${U2}`);
    eng.sel.push(U1); eng.emitNow();
    await vi.advanceTimersByTimeAsync(20);
    eng.sel.push(U2); eng.emitNow();
    await vi.advanceTimersByTimeAsync(20);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(40);
    expect(sent).toEqual([{ uuids: [U1, U2], fpPaths: [`/${SHEET}/${U2}`] }]);
  });

  it('keeps a pending send\'s time when the same selection is seen again (the reads after a release repeat it)', async () => {
    const { eng, f, sent } = feed();
    f.start();
    eng.sel.push(U1); eng.emitNow();
    await vi.advanceTimersByTimeAsync(40);
    eng.emitNow();
    await vi.advanceTimersByTimeAsync(15);
    expect(sent).toEqual([{ uuids: [U1], fpPaths: [] }]);
  });

  it('sends nothing for a selection the host already holds, nor for a burst that comes back to it', async () => {
    const { eng, f, sent } = feed();
    f.start();
    eng.emitNow();   // empty, as a new document starts
    await vi.advanceTimersByTimeAsync(100);
    eng.sel.push(U1); eng.emitNow();
    await vi.advanceTimersByTimeAsync(10);
    eng.sel.length = 0; eng.emitNow();
    await vi.advanceTimersByTimeAsync(100);
    expect(sent).toEqual([]);
    eng.sel.push(U1); eng.emitNow();
    await vi.advanceTimersByTimeAsync(100);
    eng.emitNow();
    await vi.advanceTimersByTimeAsync(100);
    expect(sent).toEqual([{ uuids: [U1], fpPaths: [] }]);
  });

  it('sends an emptied selection as empty arrays', async () => {
    const { eng, f, sent } = feed({ shape: 'sch' });
    f.start();
    eng.sel.push(U1, U2); eng.emitNow();
    await vi.advanceTimersByTimeAsync(100);
    eng.sel.length = 0; eng.emitNow();
    await vi.advanceTimersByTimeAsync(100);
    expect(sent).toEqual([{ uuids: [U1, U2], fpPaths: [] }, { uuids: [], fpPaths: [] }]);
  });

  it('ignores a malformed emit', async () => {
    const { eng, f, sent } = feed();
    f.start();
    eng.win.kicadCollab?.onSelection?.('{broken');
    eng.win.kicadCollab?.onSelection?.('{"uuids":[7]}');
    await vi.advanceTimersByTimeAsync(100);
    expect(sent).toEqual([]);
  });

  it('drops a selection that settles while it may not be sent, and starts each document from empty', async () => {
    let live = false;
    const { eng, f, sent } = feed({ live: () => live });
    f.start();
    eng.sel.push(U1); eng.emitNow();
    await vi.advanceTimersByTimeAsync(100);
    expect(sent).toEqual([]);
    live = true;
    eng.sel.length = 0;
    f.reset();   // a document opened: the engine's selection is read, and an empty one is never sent
    await vi.advanceTimersByTimeAsync(100);
    expect(sent).toEqual([]);
    eng.sel.push(U3);
    f.reset();   // a selection already made when the document opened is sent
    await vi.advanceTimersByTimeAsync(100);
    expect(sent).toEqual([{ uuids: [U3], fpPaths: [] }]);
  });

  it('reads the selection after a pointer or key release, which a selection made outside the canvas needs', async () => {
    const { eng, f, sent } = feed();
    f.start();
    eng.paths.set(U2, `/${U2}`);
    eng.sel.push(U2);   // chosen in KiCad's clarify-selection menu: no emit
    eng.dispatch('pointerup');
    await vi.advanceTimersByTimeAsync(100);
    expect(sent).toEqual([{ uuids: [U2], fpPaths: [`/${U2}`] }]);
    eng.sel.length = 0;
    eng.dispatch('keyup');
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toEqual([{ uuids: [U2], fpPaths: [`/${U2}`] }, { uuids: [], fpPaths: [] }]);
    // Three reads per release, and a read that finds nothing new sends nothing.
    const reads = eng.Module.kicadCollabGetSelectionFull.mock.calls.length;
    eng.dispatch('pointerup');
    await vi.advanceTimersByTimeAsync(1000);
    expect(eng.Module.kicadCollabGetSelectionFull.mock.calls.length - reads).toBe(3);
    expect(sent).toHaveLength(2);
  });

  it('stops for good: nothing is read or sent, and the hook leaves its slot', async () => {
    const { eng, f, sent } = feed();
    f.start();
    eng.sel.push(U1); eng.emitNow();
    f.stop();
    await vi.advanceTimersByTimeAsync(100);
    eng.dispatch('pointerup');
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toEqual([]);
    expect(eng.win.kicadCollab?.onSelection).toBeUndefined();
    expect(eng.listeners.get('pointerup')?.size ?? 0).toBe(0);
  });
});

describe('select\'s engine half', () => {
  const T = { selectPollMs: 2, selectMs: 100, applyMs: 100 };

  it('clears, then selects each item through the engine\'s select by uuid, and answers once the editor holds exactly those found', async () => {
    const eng = fakeEngine('pcb');
    eng.sel.push(U3);
    const press = vi.fn();
    const r = await selectItems(eng.win, { uuids: [U1, U2], fpPaths: [], zoom: false }, { frame: 'pcb', timing: T, closed: () => false, press });
    expect(r).toEqual({ ok: true });
    expect(eng.sel).toEqual([U1, U2]);
    expect(eng.Module.kicadCollabTestClearSelection).toHaveBeenCalledTimes(1);
    expect(eng.Module.kicadCollabTestSelectByUuid.mock.calls.map((c) => c[0])).toEqual([U1, U2]);
    expect(press).not.toHaveBeenCalled();
  });

  it('selects nothing for an id the editor does not hold, and answers all the same', async () => {
    const eng = fakeEngine('sch');
    eng.sel.push(U1);
    const unknown = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const press = vi.fn();
    expect(await selectItems(eng.win, { uuids: [unknown], fpPaths: [], zoom: true }, { frame: 'sch', timing: T, closed: () => false, press })).toEqual({ ok: true });
    expect(eng.sel).toEqual([]);
    expect(press).not.toHaveBeenCalled();   // nothing to fit the view to
    expect(await selectItems(eng.win, { uuids: [unknown, U2], fpPaths: [`/${SHEET}/${U3}`], zoom: false }, { frame: 'sch', timing: T, closed: () => false, press })).toEqual({ ok: true });
    expect(eng.sel).toEqual([U2, U3]);
  });

  it('with zoom, presses Zoom to Selected Objects once the selection holds', async () => {
    const eng = fakeEngine('pcb');
    const press = vi.fn(() => { expect(eng.sel).toEqual([U1]); });
    expect(await selectItems(eng.win, { uuids: [U1], fpPaths: [], zoom: true }, { frame: 'pcb', timing: T, closed: () => false, press })).toEqual({ ok: true });
    expect(press).toHaveBeenCalledWith(ZOOM_SELECTION_KEY);
  });

  it('answers not_applied, zooming nothing, when the clear is refused or the selection never settles', async () => {
    const eng = fakeEngine('pcb');
    const press = vi.fn();
    eng.Module.kicadCollabTestClearSelection.mockImplementationOnce(() => false);
    expect(await selectItems(eng.win, { uuids: [U1], fpPaths: [], zoom: true }, { frame: 'pcb', timing: T, closed: () => false, press })).toMatchObject({ ok: false, code: 'not_applied' });
    eng.Module.kicadCollabTestSelectByUuid.mockImplementation(() => true);   // finds it, never selects it
    expect(await selectItems(eng.win, { uuids: [U1], fpPaths: [], zoom: true }, { frame: 'pcb', timing: T, closed: () => false, press })).toMatchObject({ ok: false, code: 'not_applied' });
    expect(press).not.toHaveBeenCalled();
  });
});

describe('Zoom to Selected Objects\' key', () => {
  it('is seeded in theme/user.hotkeys, and no other action takes it', () => {
    const lines = hotkeysText.split('\n').filter((l) => l !== '');
    expect(lines).toContain('common.Control.zoomFitSelection\tCtrl+Shift+Home\t');
    expect(ZOOM_SELECTION_KEY).toEqual({ key: 'Home', code: 'Home', ctrl: true, shift: true, alt: false });
    expect(lines.filter((l) => l.split('\t')[1] === 'Ctrl+Shift+Home')).toHaveLength(1);
  });

  // KiCad's own actions at the engine's kicad commit: the action is there, it ships with no key,
  // and no default key of any action is Shift with Home (only Home, Zoom to Fit, and Ctrl+Home, Zoom to Objects).
  it.skipIf(!hasKicadClone())('is free in the engine\'s KiCad: the action has no default key, and no action defaults to Shift with Home', () => {
    const actions = kicadFileAt(pin.engine.build.kicad, 'common/tool/actions.cpp') ?? '';
    const block = /TOOL_ACTION ACTIONS::zoomFitSelection\(([\s\S]*?)\);/.exec(actions)?.[1] ?? '';
    expect(block).toContain('"common.Control.zoomFitSelection"');
    expect(block).not.toContain('DefaultHotkey');
    const homes = (kicadGrepAt(pin.engine.build.kicad, 'DefaultHotkey.*WXK_HOME', '*.cpp') ?? []).map((l) => l.replace(/^.*DefaultHotkey\(\s*/, '').replace(/\s*\).*$/, ''));
    expect(homes.length).toBeGreaterThan(0);
    for (const h of homes) expect(h, h).not.toMatch(/MD_SHIFT/);
  });
});
