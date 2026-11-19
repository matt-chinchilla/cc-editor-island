// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-keys-i: keys.editor.get and keys.editor.set, the cap hotkeys feature
// detected on kicadHotkeysGet and kicadHotkeysSet, the args and the engine's
// answer read closed, the seeded chords refused (taken), and KiCad's hotkey
// list held in the sch and pcb frames. The engine here is this test's own
// module of exports (at the protocol boundary); the real engine is the e2e's
// (tests/e2e/st/st-keys-i.spec.ts, engine run 15).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TABLE from '../../theme/pencil-tools.json';
import { HELD_ACTIONS, heldTaken } from '../held';
import { startResponder } from '../responder';
import type { ExtUnit } from './contract';
import unit, {
  ACTIONS_MAX, HOTKEYS_CAP, HOTKEYS_EXPORTS, KEYS_MAX, LIST_HOTKEYS, SEEDED, keyOf, parseSetArgs, readHotkeys, seededHolder,
} from './st-keys-i';
import { buildRegistry, heldActions, REGISTRY } from './registry';

const PARENT = 'http://localhost';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));

const WIRE = 'eeschema.InteractiveDrawingLineWireBus.drawWires';
const ROUTE = 'pcbnew.InteractiveRouter.SingleTrack';
const SCH_LIST = { editor: 'sch', actions: [
  { name: 'common.Interactive.selectSetRect', label: 'Select Rectangle', key: 'Ctrl+Alt+1', default: '', alt: '' },
  { name: 'eeschema.InteractiveDrawingLineWireBus.drawWires', label: 'Draw Wires', key: 'W', default: 'W', alt: '' },
  { name: 'eeschema.InteractiveEdit.rotateCCW', label: '', key: 'R', default: 'R', alt: '' },
] };
const PCB_LIST = { editor: 'pcb', actions: [{ name: ROUTE, label: 'Route Single Track', key: 'X', default: 'X', alt: '' }] };
const RUN14 = { kicadHostActions: () => true };

/** The seeded chord of a sch tool in the pencil table, and a chord seeded in no editor for `WIRE`. */
const seededSch = (TABLE as Array<{ editor: string; action: string; seededKey: string | null }>).find((r) => r.editor === 'sch' && r.seededKey != null && r.action !== WIRE)!;

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

/** A responder with this unit alone, booted in `frame` on an engine with `exports` (no document open: the keys need none). */
async function boot(frame: 'sch' | 'pcb' | 'symedit', exports: Record<string, unknown>, opts: { blocked?: boolean } = {}) {
  const reg = buildRegistry(mods(unit));
  expect(reg.problems).toEqual([]);
  const { page, parent } = fakePage(`?frame=${frame}&theme=day`);
  const r = startResponder({ parentOrigin: PARENT, page, ext: reg });
  const ch = new MessageChannel();
  const got: Array<Record<string, unknown>> = [];
  ch.port1.onmessage = (m) => got.push(m.data);
  page.dispatch('message', { origin: PARENT, source: page.parent, data: { type: 'cc.connect', nonce: parent.postMessage.mock.calls[0][0].nonce }, ports: [ch.port2] });
  const typeName = frame === 'pcb' ? 'PCB_EDIT_FRAME' : frame === 'symedit' ? 'SYMBOL_EDIT_FRAME' : 'SCH_EDIT_FRAME';
  const elements = [{ id: 'frame', typeName, name: 'Frame', visible: true }, ...(opts.blocked === true ? [{ id: 'd', typeName: 'wxDialog', name: 'Dialog', visible: true }] : [])];
  const win = {
    FS: { analyzePath: () => ({ exists: false }), mkdirTree: () => {}, readdir: () => [], readFile: () => { throw new Error('ENOENT'); } },
    Module: { kicadOpenFileBusy: () => false, ...exports },
    wxElementRegistry: { findAll: () => elements, findByLabel: () => [] },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    dispatchEvent: () => true,
  } as unknown as ToolWindow & { kicadHostAction?: { onRequest?: (json: unknown) => boolean } };
  r.engineReady(win, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
  await settle();
  const ask = async (id: number, op: string, args?: unknown) => {
    ch.port1.postMessage(args === undefined ? { id, op } : { id, op, args });
    await settle();
    return got.find((m) => m.id === id);
  };
  return { r, win, got, ready: got.find((m) => m.type === 'ev.ready') as { caps: string[] } | undefined, ask };
}

/** An engine of run 15: the get answers `list`, the set records each call and answers `setAnswer`. */
function run15(list: unknown, setAnswer: unknown = true) {
  const sets: string[] = [];
  const get = vi.fn(() => JSON.stringify(list));
  const set = vi.fn((json: string) => { sets.push(json); return setAnswer; });
  return { exports: { ...RUN14, kicadHotkeysGet: get, kicadHotkeysSet: set }, get, set, sets };
}

describe('st-keys-i in the registry', () => {
  it('loads in this checkout with nothing broken, owning both ops, the cap and the held row', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect(REGISTRY.ops.get('keys.editor.get')?.unit).toBe('st-keys-i');
    expect(REGISTRY.ops.get('keys.editor.set')?.unit).toBe('st-keys-i');
    expect(REGISTRY.pending.has('keys.editor.get')).toBe(false);
    expect(REGISTRY.pending.has('keys.editor.set')).toBe(false);
    expect(REGISTRY.capNames.get(HOTKEYS_CAP)).toBe('st-keys-i');
    expect(HOTKEYS_CAP).toBe('hotkeys');
    expect(unit.ops['keys.editor.get'].passesCheck).toBe(true);
    expect(unit.ops['keys.editor.set']).not.toHaveProperty('passesCheck');
    expect(unit.held).toEqual([LIST_HOTKEYS]);
    expect(unit.heldRows).toEqual([{ action: 'common.SuiteControl.listHotKeys', frames: ['sch', 'pcb'], cap: 'heldKeys' }]);
  });

  it('lists hotkeys in a sch or pcb frame on an engine with both exports; nothing on run 14, with one export, or in another frame', () => {
    expect([...HOTKEYS_EXPORTS]).toEqual(['kicadHotkeysGet', 'kicadHotkeysSet']);
    const both = run15(SCH_LIST).exports;
    expect(unit.caps(both, 'sch')).toEqual(['hotkeys']);
    expect(unit.caps(both, 'pcb')).toEqual(['hotkeys']);
    expect(unit.caps(both, 'symedit')).toEqual([]);
    expect(unit.caps(RUN14, 'sch')).toEqual([]);
    expect(unit.caps({ kicadHotkeysGet: () => '' }, 'pcb')).toEqual([]);
  });

  it('ev.ready lists hotkeys on run 15 and not on run 14', async () => {
    for (const f of ['sch', 'pcb'] as const) {
      expect((await boot(f, run15(SCH_LIST).exports)).ready?.caps).toEqual(expect.arrayContaining(['hotkeys', 'heldKeys']));
      const caps14 = (await boot(f, RUN14)).ready?.caps ?? [];
      expect(caps14).toContain('heldKeys');
      expect(caps14).not.toContain('hotkeys');
    }
  });
});

describe('the keys read closed', () => {
  it('keyOf spells a key one way: modifiers Ctrl, Alt, Shift, a letter in capitals', () => {
    expect(keyOf('shift+w')).toBe('Shift+W');
    expect(keyOf('Shift+Ctrl+Alt+x')).toBe('Ctrl+Alt+Shift+X');
    expect(keyOf('Ctrl++')).toBe('Ctrl++');
    expect(keyOf('+')).toBe('+');
    expect(keyOf('Num Pad 1')).toBe('Num Pad 1');
    expect(keyOf('')).toBe('');
    expect(keyOf('Hyper+W')).toBe('Hyper+W');
  });

  it('parseSetArgs takes exactly { keys } of 1 to 2,048 action names and key texts', () => {
    expect(parseSetArgs({ keys: { [WIRE]: 'Shift+W' } })).toEqual({ [WIRE]: 'Shift+W' });
    expect(parseSetArgs({ keys: { [WIRE]: '' } })).toEqual({ [WIRE]: '' });
    for (const bad of [undefined, {}, { keys: {} }, { keys: [] }, { keys: { [WIRE]: 'W' }, more: 1 }, { keys: { nodot: 'W' } }, { keys: { [WIRE]: 5 } },
      { keys: { [WIRE]: 'x'.repeat(33) } }, { keys: { [WIRE]: 'W\n' } }, { keys: null }]) {
      expect(parseSetArgs(bad)).toBeNull();
    }
    const many = Object.fromEntries(Array.from({ length: KEYS_MAX + 1 }, (_, i) => [`eeschema.A.a${i}`, '']));
    expect(parseSetArgs({ keys: many })).toBeNull();
    delete (many as Record<string, string>)[`eeschema.A.a${KEYS_MAX}`];
    expect(Object.keys(parseSetArgs({ keys: many }) ?? {})).toHaveLength(KEYS_MAX);
  });

  it('readHotkeys reads the engine closed for its editor, a nameless label left out', () => {
    expect(readHotkeys(JSON.stringify(SCH_LIST), 'sch')).toEqual([
      { action: 'common.Interactive.selectSetRect', label: 'Select Rectangle', key: 'Ctrl+Alt+1', default: '', alt: '' },
      { action: WIRE, label: 'Draw Wires', key: 'W', default: 'W', alt: '' },
      { action: 'eeschema.InteractiveEdit.rotateCCW', key: 'R', default: 'R', alt: '' },
    ]);
    expect(readHotkeys(JSON.stringify(SCH_LIST), 'pcb')).toBeNull();
    expect(readHotkeys('', 'sch')).toBeNull();
    expect(readHotkeys('{', 'sch')).toBeNull();
    const row = SCH_LIST.actions[1];
    for (const actions of [[row, row], [{ ...row, extra: 1 }], [{ ...row, key: 5 }], [{ ...row, name: 'nodot' }], [{ ...row, alt: undefined }], [{ ...row, label: 'x'.repeat(257) }]]) {
      expect(readHotkeys(JSON.stringify({ editor: 'sch', actions }), 'sch')).toBeNull();
    }
    expect(readHotkeys(JSON.stringify({ editor: 'sch', actions: [], more: 1 }), 'sch')).toBeNull();
    const big = Array.from({ length: ACTIONS_MAX + 1 }, (_, i) => ({ ...row, name: `eeschema.A.a${i}` }));
    expect(readHotkeys(JSON.stringify({ editor: 'sch', actions: big }), 'sch')).toBeNull();
  });

  it('a seeded chord is another tool\'s, but an action\'s own chord is free for it in its editor', () => {
    expect(SEEDED.size).toBeGreaterThan(0);
    const chord = seededSch.seededKey as string;
    expect(seededHolder('sch', WIRE, chord)).toBe(seededSch.action);
    expect(seededHolder('sch', WIRE, chord.toLowerCase())).not.toBeNull();
    expect(seededHolder('sch', seededSch.action, chord)).toBeNull();
    expect(seededHolder('sch', WIRE, 'Shift+W')).toBeNull();
    expect(seededHolder('sch', WIRE, '')).toBeNull();
  });
});

describe('keys.editor.get and keys.editor.set in the responder', () => {
  it('get answers the editor and its actions with no document open, in both frames', async () => {
    const sch = run15(SCH_LIST);
    const t = await boot('sch', sch.exports);
    expect(await t.ask(1, 'keys.editor.get')).toEqual({ id: 1, ok: true, result: { editor: 'sch', actions: readHotkeys(JSON.stringify(SCH_LIST), 'sch') } });
    expect(await t.ask(2, 'keys.editor.get', {})).toMatchObject({ id: 2, ok: true });
    expect(await t.ask(3, 'keys.editor.get', { all: true })).toEqual({ id: 3, ok: false, error: { code: 'bad_args', message: 'keys.editor.get' } });
    const pcb = run15(PCB_LIST);
    const p = await boot('pcb', pcb.exports);
    expect(await p.ask(4, 'keys.editor.get')).toEqual({ id: 4, ok: true, result: { editor: 'pcb', actions: [{ action: ROUTE, label: 'Route Single Track', key: 'X', default: 'X', alt: '' }] } });
  });

  it('get answers busy for an empty answer and island_error for another shape', async () => {
    const t = await boot('sch', { ...RUN14, kicadHotkeysGet: () => '', kicadHotkeysSet: () => true });
    expect(await t.ask(1, 'keys.editor.get')).toEqual({ id: 1, ok: false, error: { code: 'busy', message: 'keys.editor.get' } });
    const u = await boot('sch', run15(PCB_LIST).exports);
    expect(await u.ask(2, 'keys.editor.get')).toEqual({ id: 2, ok: false, error: { code: 'island_error', message: 'the engine answered keys of another shape' } });
  });

  it('set sends exactly the keys and answers {}; the engine\'s false is bad_args', async () => {
    const e = run15(SCH_LIST);
    const t = await boot('sch', e.exports);
    expect(await t.ask(1, 'keys.editor.set', { keys: { [WIRE]: 'Shift+W' } })).toEqual({ id: 1, ok: true, result: {} });
    expect(e.sets).toEqual([JSON.stringify({ keys: { [WIRE]: 'Shift+W' } })]);
    const no = run15(SCH_LIST, false);
    const u = await boot('sch', no.exports);
    expect(await u.ask(2, 'keys.editor.set', { keys: { 'eeschema.Nope.nope': 'Q' } })).toEqual({ id: 2, ok: false, error: { code: 'bad_args', message: 'the engine refused the keys' } });
  });

  it('set refuses a seeded chord of another tool as taken before the engine is asked, and takes an action\'s own back', async () => {
    const e = run15(SCH_LIST);
    const t = await boot('sch', e.exports);
    const chord = seededSch.seededKey as string;
    expect(await t.ask(1, 'keys.editor.set', { keys: { [WIRE]: chord } })).toEqual({ id: 1, ok: false, error: { code: 'taken', message: `${chord} is the island's chord for ${seededSch.action}` } });
    expect(e.set).not.toHaveBeenCalled();
    expect(await t.ask(2, 'keys.editor.set', { keys: { [seededSch.action]: chord } })).toEqual({ id: 2, ok: true, result: {} });
  });

  it('checks the args first, then the engine: bad_args, unsupported naming the export on run 14, busy under a dialog', async () => {
    const t = await boot('pcb', RUN14);
    expect(await t.ask(1, 'keys.editor.set', { keys: {} })).toEqual({ id: 1, ok: false, error: { code: 'bad_args', message: 'keys.editor.set' } });
    expect(await t.ask(2, 'keys.editor.get')).toEqual({ id: 2, ok: false, error: { code: 'unsupported', message: 'kicadHotkeysGet' } });
    expect(await t.ask(3, 'keys.editor.set', { keys: { [ROUTE]: 'Shift+Q' } })).toEqual({ id: 3, ok: false, error: { code: 'unsupported', message: 'kicadHotkeysGet' } });
    const e = run15(PCB_LIST);
    const b = await boot('pcb', e.exports, { blocked: true });
    expect(await b.ask(4, 'keys.editor.get')).toEqual({ id: 4, ok: false, error: { code: 'busy', message: 'keys.editor.get' } });
    expect(await b.ask(5, 'keys.editor.set', { keys: { [ROUTE]: 'Shift+Q' } })).toEqual({ id: 5, ok: false, error: { code: 'busy', message: 'keys.editor.set' } });
    expect(e.get).not.toHaveBeenCalled();
    expect(e.set).not.toHaveBeenCalled();
  });

  it('answers unsupported in another frame, the engine never asked', async () => {
    const e = run15(SCH_LIST);
    const t = await boot('symedit', e.exports);
    const a = await t.ask(1, 'keys.editor.get');
    expect(a).toMatchObject({ id: 1, ok: false, error: { code: 'unsupported' } });
    expect(e.get).not.toHaveBeenCalled();
  });
});

describe('KiCad\'s hotkey list, held', () => {
  const union = heldActions(buildRegistry(mods(unit)));

  it('is taken in sch and pcb under heldKeys, on run 14 as on run 15, and stays the symedit frame\'s own row there', () => {
    for (const f of ['sch', 'pcb'] as const) {
      expect(heldTaken(LIST_HOTKEYS, f, ['heldKeys'], union)).toBe(true);
      expect(heldTaken(LIST_HOTKEYS, f, [], union)).toBe(false);
      expect(heldTaken(LIST_HOTKEYS, f, ['heldKeys'], HELD_ACTIONS)).toBe(false);
    }
    expect(heldTaken(LIST_HOTKEYS, 'symedit', ['symedit'], union)).toBe(true);
    expect(heldTaken(LIST_HOTKEYS, 'symedit', ['heldKeys'], union)).toBe(false);
  });

  it('with no document open the slot lets KiCad run it (admit stands first)', async () => {
    for (const f of ['sch', 'pcb'] as const) {
      const t = await boot(f, RUN14);
      expect(t.win.kicadHostAction?.onRequest?.(JSON.stringify({ action: LIST_HOTKEYS }))).toBe(false);
      expect(t.got.filter((m) => m.type === 'ev.held')).toEqual([]);
      t.r.close();
    }
  });
});
