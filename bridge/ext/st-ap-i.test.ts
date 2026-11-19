// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-ap-i: the cap autoplace feature detected on the engine's marker
// kicadAutoplaceQuiet, and ev.autoplace { working } around a key.press of the
// seeded auto-place chords. The engine here is this test's own module of
// exports (at the protocol boundary); the real engine is the e2e's
// (tests/e2e/st/st-ap-i.spec.ts, engine run 15).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import hotkeysText from '../../theme/user.hotkeys?raw';
import { startResponder } from '../responder';
import type { ExtUnit } from './contract';
import unit, { apTiming, AUTOPLACE_ACTIONS, AUTOPLACE_CAP, AUTOPLACE_EVENT, AUTOPLACE_EXPORTS, autoplaceChords, isAutoplacePress, SEEDED_CHORDS } from './st-ap-i';
import { buildRegistry, REGISTRY } from './registry';

const PARENT = 'http://localhost';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));
const OFFBOARD = { key: 'l', code: 'KeyL', ctrl: true, alt: true };
const SELECTED = { key: 'p', code: 'KeyP', ctrl: true, alt: true };
const SAVED = { ...apTiming };

beforeEach(() => {
  vi.stubGlobal('KeyboardEvent', class extends Event {
    constructor(type: string, init: Record<string, unknown> = {}) {
      const { bubbles, cancelable, composed, ...rest } = init as EventInit & Record<string, unknown>;
      super(type, { bubbles, cancelable, composed });
      Object.assign(this, rest);
    }
  });
  Object.assign(apTiming, { pollMs: 10, settleTicks: 3, maxMs: 2_000 });
});
afterEach(() => { vi.unstubAllGlobals(); Object.assign(apTiming, SAVED); });

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

/** The engine's state the test drives: the apply queue, the undo depth, what a key does. */
interface Engine { busy: boolean; depth: number; keys: string[]; onKey?: (code: string) => void; dialog: boolean }

/** A responder with this unit alone, booted in `frame` on an engine with `exports`. */
async function boot(frame: string, exports: Record<string, unknown>, engine: Engine) {
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
    Module: { kicadOpenFileBusy: () => false, kicadCollabTestUndoDepth: () => engine.depth, ...exports },
    wxElementRegistry: {
      findAll: () => [
        { id: 'frame', typeName, name: 'Frame', visible: true },
        ...(engine.dialog ? [{ id: 'dlg', typeName: 'wxDialog', name: 'Dialog', visible: true }] : []),
      ],
      findByLabel: () => [],
    },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    dispatchEvent: (e: Event & { code?: string }) => {
      if (e.type === 'keydown') { engine.keys.push(String(e.code)); engine.onKey?.(String(e.code)); }
      return true;
    },
  } as unknown as ToolWindow;
  r.engineReady(win, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
  await settle();
  const ask = async (id: number, op: string, args?: unknown) => {
    ch.port1.postMessage(args === undefined ? { id, op } : { id, op, args });
    await settle();
    return got.find((m) => m.id === id);
  };
  const autoplace = () => got.filter((m) => m.type === AUTOPLACE_EVENT);
  return { ready: got.find((m) => m.type === 'ev.ready') as { caps: string[] } | undefined, ask, autoplace, got };
}

const engine = (over: Partial<Engine> = {}): Engine => ({ busy: false, depth: 3, keys: [], dialog: false, ...over });
const busyProbe = (e: Engine) => ({ kicadAutoplaceQuiet: () => true, kicadCollabBusy: () => e.busy });

describe('st-ap-i in the registry', () => {
  it('loads in this checkout with nothing broken, owning the cap autoplace, the event ev.autoplace and a widening of key.press', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect(REGISTRY.capNames.get(AUTOPLACE_CAP)).toBe('st-ap-i');
    expect(AUTOPLACE_CAP).toBe('autoplace');
    expect(REGISTRY.events.get('ev.autoplace')).toEqual({ unit: 'st-ap-i', keys: ['working'] });
    expect((REGISTRY.widen.get('key.press') ?? []).map((w) => w.unit)).toContain('st-ap-i');
  });

  it('lists autoplace in a pcb frame on an engine with kicadAutoplaceQuiet and kicadCollabBusy; nothing on run 14 or in another frame', () => {
    const run15 = { kicadAutoplaceQuiet: () => true, kicadCollabBusy: () => false };
    expect([...AUTOPLACE_EXPORTS]).toEqual(['kicadAutoplaceQuiet', 'kicadCollabBusy']);
    expect(unit.caps(run15, 'pcb')).toEqual(['autoplace']);
    expect(unit.caps(run15, 'sch')).toEqual([]);
    expect(unit.caps(run15, 'symedit')).toEqual([]);
    expect(unit.caps({ kicadCollabBusy: () => false }, 'pcb')).toEqual([]);
    expect(unit.caps({}, 'pcb')).toEqual([]);
  });
});

describe('the chords', () => {
  it('reads the two actions\' seeded chords from theme/user.hotkeys, each one key.press can carry', () => {
    for (const action of AUTOPLACE_ACTIONS) expect(hotkeysText).toMatch(new RegExp(`^${action.replace(/\./g, '\\.')}\\t\\S`, 'm'));
    expect(SEEDED_CHORDS.size).toBe(2);
    expect(isAutoplacePress(OFFBOARD)).toBe(true);
    expect(isAutoplacePress(SELECTED)).toBe(true);
  });

  it('takes both keys of a line, Shift and digits, and leaves out what it cannot press', () => {
    const text = [
      'pcbnew.Autoplacer.autoplaceOffboard\tCtrl+Alt+Shift+7\tAlt+K',
      'pcbnew.Autoplacer.autoplaceSelected\tMeta+Q\t',
      'pcbnew.Other.action\tCtrl+Alt+M\t',
    ].join('\r\n');
    const chords = autoplaceChords(text);
    expect(chords.size).toBe(2);
    expect(isAutoplacePress({ key: '7', code: 'Digit7', ctrl: true, alt: true, shift: true }, chords)).toBe(true);
    expect(isAutoplacePress({ key: 'k', code: 'KeyK', alt: true }, chords)).toBe(true);
    expect(isAutoplacePress({ key: 'm', code: 'KeyM', ctrl: true, alt: true }, chords)).toBe(false);
  });

  it('is no auto-place press for another key, other modifiers, or args key.press refuses', () => {
    expect(isAutoplacePress({ key: 'l', code: 'KeyL' })).toBe(false);
    expect(isAutoplacePress({ key: 'l', code: 'KeyL', ctrl: true })).toBe(false);
    expect(isAutoplacePress({ key: 'L', code: 'KeyL', ctrl: true, alt: true, shift: true })).toBe(false);
    expect(isAutoplacePress({ key: 'm', code: 'KeyM', ctrl: true, alt: true })).toBe(false);
    for (const bad of [null, 3, 'Ctrl+Alt+L', {}, { ...OFFBOARD, meta: true }, { ...OFFBOARD, ctrl: 'yes' }]) expect(isAutoplacePress(bad)).toBe(false);
  });
});

describe('ev.autoplace', () => {
  it('run 14: no cap, and the chord is pressed with no event', async () => {
    const e = engine();
    const s = await boot('pcb', {}, e);
    expect(s.ready?.caps).not.toContain('autoplace');
    expect(await s.ask(1, 'key.press', OFFBOARD)).toMatchObject({ ok: true });
    await settle(80);
    expect(e.keys).toEqual(['KeyL']);
    expect(s.autoplace()).toEqual([]);
  });

  it('a sch frame lists no cap and sends no event', async () => {
    const e = engine();
    const s = await boot('sch', busyProbe(e), e);
    expect(s.ready?.caps ?? []).not.toContain('autoplace');
    expect(await s.ask(1, 'key.press', OFFBOARD)).toMatchObject({ ok: true });
    await settle(80);
    expect(s.autoplace()).toEqual([]);
  });

  it('a run that holds the thread: working true, then false at the first read after the key (the depth moved)', async () => {
    const e = engine();
    e.onKey = () => { e.depth += 1; };
    const s = await boot('pcb', busyProbe(e), e);
    expect(s.ready?.caps).toContain('autoplace');
    expect(await s.ask(1, 'key.press', OFFBOARD)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(s.autoplace()).toHaveLength(2), { timeout: 1_000 });
    expect(s.autoplace()).toEqual([{ type: 'ev.autoplace', working: true }, { type: 'ev.autoplace', working: false }]);
    expect(e.keys).toEqual(['KeyL']);
  });

  it('a run on the apply queue: working stays true while kicadCollabBusy holds, false once it clears and the depth moved', async () => {
    const e = engine();
    e.onKey = () => { e.busy = true; };
    const s = await boot('pcb', busyProbe(e), e);
    expect(await s.ask(1, 'key.press', SELECTED)).toMatchObject({ ok: true });
    await settle(120);   // many reads while busy
    expect(s.autoplace()).toEqual([{ type: 'ev.autoplace', working: true }]);
    e.busy = false;
    e.depth += 1;
    await vi.waitFor(() => expect(s.autoplace()).toHaveLength(2), { timeout: 1_000 });
    expect(s.autoplace().at(-1)).toEqual({ type: 'ev.autoplace', working: false });
  });

  it('nothing placed (no part off the board, or no outline): false after the settle with the depth unchanged', async () => {
    const e = engine();
    const s = await boot('pcb', busyProbe(e), e);
    expect(await s.ask(1, 'key.press', OFFBOARD)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(s.autoplace()).toHaveLength(2), { timeout: 1_000 });
    expect(s.autoplace()).toEqual([{ type: 'ev.autoplace', working: true }, { type: 'ev.autoplace', working: false }]);
    expect(e.depth).toBe(3);
  });

  it('a second press while one run is watched joins it: one true, one false', async () => {
    const e = engine();
    e.onKey = () => { e.busy = true; };
    const s = await boot('pcb', busyProbe(e), e);
    expect(await s.ask(1, 'key.press', OFFBOARD)).toMatchObject({ ok: true });
    expect(await s.ask(2, 'key.press', SELECTED)).toMatchObject({ ok: true });
    expect(e.keys).toEqual(['KeyL', 'KeyP']);
    e.busy = false;
    e.depth += 1;
    await vi.waitFor(() => expect(s.autoplace()).toHaveLength(2), { timeout: 1_000 });
    await settle(80);
    expect(s.autoplace()).toEqual([{ type: 'ev.autoplace', working: true }, { type: 'ev.autoplace', working: false }]);
    // A later press is a new run.
    e.onKey = () => { e.depth += 1; };
    expect(await s.ask(3, 'key.press', OFFBOARD)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(s.autoplace()).toHaveLength(4), { timeout: 1_000 });
  });

  it('a refused press (a dialog of KiCad\'s up) sends false at once and presses nothing', async () => {
    const e = engine({ dialog: true });
    const s = await boot('pcb', busyProbe(e), e);
    expect(await s.ask(1, 'key.press', OFFBOARD)).toMatchObject({ ok: false, error: { code: 'busy', message: 'key.press' } });
    expect(e.keys).toEqual([]);
    expect(s.autoplace()).toEqual([{ type: 'ev.autoplace', working: true }, { type: 'ev.autoplace', working: false }]);
  });

  it('other keys are pressed as before with no event', async () => {
    const e = engine();
    const s = await boot('pcb', busyProbe(e), e);
    expect(await s.ask(1, 'key.press', { key: 'z', code: 'KeyZ', ctrl: true })).toMatchObject({ ok: true });
    expect(await s.ask(2, 'key.press', { key: 'l', code: 'KeyL' })).toMatchObject({ ok: true });
    expect(await s.ask(3, 'key.press', { bad: true })).toMatchObject({ ok: false, error: { code: 'bad_args', message: 'key.press' } });
    await settle(80);
    expect(e.keys).toEqual(['KeyZ', 'KeyL']);
    expect(s.autoplace()).toEqual([]);
  });

  it('a run that never ends is bounded: false after apTiming.maxMs', async () => {
    Object.assign(apTiming, { maxMs: 60 });
    const e = engine();
    e.onKey = () => { e.busy = true; };
    const s = await boot('pcb', busyProbe(e), e);
    expect(await s.ask(1, 'key.press', OFFBOARD)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(s.autoplace()).toHaveLength(2), { timeout: 1_000 });
    expect(s.autoplace().at(-1)).toEqual({ type: 'ev.autoplace', working: false });
  });
});
