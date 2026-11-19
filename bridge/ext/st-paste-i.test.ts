// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-paste-i: paste.special in a sch or pcb frame, the args read closed (mode
// one of unique, keep, remove; clearNets a board choice), the engine called
// with exactly { mode, clearNets }, the answer once the items hang off the
// pointer (joined to place's watch), the cap pasteSpecial and the held row
// feature detected, and the op unsupported naming kicadPasteSpecial on an
// engine without it. The engine here is this test's own module of exports (at
// the protocol boundary); the real engine is the e2e's
// (tests/e2e/st/st-paste-i.spec.ts, engine run 15).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HELD_ACTIONS } from '../held';
import { startResponder } from '../responder';
import type { ExtUnit, ResponderCtx } from './contract';
import { buildRegistry, heldActions, REGISTRY } from './registry';
import unit, {
  HELD_PASTE_SPECIAL, PASTE_MODES, PASTE_SPECIAL_CAP, PASTE_SPECIAL_EXPORTS, parsePasteSpecialArgs, pasteSpecial,
} from './st-paste-i';

const PARENT = 'http://localhost';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));
const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

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
 * A ResponderCtx over a fake engine: `engine` plays kicadPasteSpecial (answers
 * true and, unless told otherwise, puts a fresh uuid in the selection, as
 * KiCad's move tool selects the pasted items); the calls and the place watch
 * joins are recorded.
 */
function fakeCtx(opts: {
  frame?: string;
  engine?: (a: Record<string, unknown>, sel: string[]) => unknown;
  selected?: string[];
  gate?: string;
  missing?: string;
  closed?: boolean;
} = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const raw: string[] = [];
  const started: string[] = [];
  const gates: string[] = [];
  const sel = [...(opts.selected ?? [])];
  const mod: Record<string, unknown> = {
    kicadCollabGetSelection: () => JSON.stringify(sel),
    kicadPasteSpecial: (json: string) => {
      raw.push(json);
      const a = JSON.parse(json) as Record<string, unknown>;
      calls.push(a);
      return (opts.engine ?? ((_a, s) => { s.push(UUID_B); return true; }))(a, sel);
    },
  };
  if (opts.missing != null) delete mod[opts.missing];
  const w = { Module: mod };
  const gate = (want: string) => (_op: string, exports: readonly string[]) => {
    gates.push(want);
    if (opts.gate != null) return { ok: false, code: 'busy', message: opts.gate };
    for (const name of exports) if (typeof mod[name] !== 'function') return { ok: false, code: 'unsupported', message: name };
    return { w, mod };
  };
  const ctx = {
    frame: opts.frame ?? 'sch',
    root: '/project',
    timing: { placeMs: 120, placePollMs: 5 },
    mod: () => mod,
    closed: () => opts.closed === true,
    boardGate: gate('pcb'),
    schematicGate: gate('sch'),
    placeStart: (uuid: string) => { started.push(uuid); },
    log: () => {},
  } as unknown as ResponderCtx;
  return { ctx, calls, raw, started, gates, sel };
}

describe('st-paste-i in the registry', () => {
  it('loads in this checkout with nothing broken, owning paste.special, no longer a placeholder', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect(REGISTRY.ops.get('paste.special')?.unit).toBe('st-paste-i');
    expect(REGISTRY.pending.has('paste.special')).toBe(false);
  });

  it('holds KiCad\'s Paste Special in a sch and a pcb frame under pasteSpecial, not held by a built in row', () => {
    expect(HELD_PASTE_SPECIAL).toBe('common.Interactive.pasteSpecial');
    expect(unit.held).toEqual([HELD_PASTE_SPECIAL]);
    expect(unit.heldRows.map((r) => [r.action, [...r.frames], r.cap])).toEqual([[HELD_PASTE_SPECIAL, ['sch', 'pcb'], PASTE_SPECIAL_CAP]]);
    expect(HELD_ACTIONS.some((r) => r.action === HELD_PASTE_SPECIAL)).toBe(false);
    expect(heldActions().filter((r) => r.action === HELD_PASTE_SPECIAL).length).toBe(1);
  });

  it('lists pasteSpecial in a sch and a pcb frame only on an engine with every export', () => {
    const full = Object.fromEntries(PASTE_SPECIAL_EXPORTS.map((e) => [e, () => true]));
    expect(PASTE_SPECIAL_EXPORTS).toEqual(['kicadPasteSpecial', 'kicadCollabGetSelection']);
    expect(unit.capNames).toEqual([PASTE_SPECIAL_CAP]);
    expect(PASTE_SPECIAL_CAP).toBe('pasteSpecial');
    expect(unit.caps(full, 'sch')).toEqual([PASTE_SPECIAL_CAP]);
    expect(unit.caps(full, 'pcb')).toEqual([PASTE_SPECIAL_CAP]);
    expect(unit.caps(full, 'symedit')).toEqual([]);
    expect(unit.caps({ kicadCollabGetSelection: () => '[]' }, 'sch')).toEqual([]);
    expect(unit.caps({ kicadPasteSpecial: () => true }, 'pcb')).toEqual([]);
  });
});

describe('the args, read closed', () => {
  it('takes each mode, clearNets false when absent', () => {
    expect(PASTE_MODES).toEqual(['unique', 'keep', 'remove']);
    for (const mode of PASTE_MODES) {
      expect(parsePasteSpecialArgs({ mode })).toEqual({ mode, clearNets: false });
      expect(parsePasteSpecialArgs({ mode, clearNets: true })).toEqual({ mode, clearNets: true });
      expect(parsePasteSpecialArgs({ mode, clearNets: false })).toEqual({ mode, clearNets: false });
    }
  });

  it('refuses every other shape', () => {
    for (const bad of [
      null, undefined, 'unique', [], {},
      { clearNets: true },
      { mode: 'Unique' },
      { mode: 'new' },
      { mode: 7 },
      { mode: 'unique', clearNets: 'yes' },
      { mode: 'unique', clearNets: null },
      { mode: 'unique', clearNets: 1 },
      { mode: 'unique', extra: true },
      { mode: 'unique', clearNets: false, run: 1 },
    ]) expect(parsePasteSpecialArgs(bad)).toBeNull();
  });
});

describe('paste.special over the engine', () => {
  it('a schematic: the engine called with exactly { mode, clearNets }, {} once the items hang, joined to the watch', async () => {
    const t = fakeCtx({ selected: [UUID_A] });
    expect(await pasteSpecial({ mode: 'unique' }, t.ctx)).toEqual({ ok: true, result: {} });
    expect(t.gates).toEqual(['sch']);
    expect(t.raw).toEqual(['{"mode":"unique","clearNets":false}']);
    expect(t.started).toEqual([UUID_B]);
  });

  it('every mode reaches the engine as it is given', async () => {
    for (const mode of PASTE_MODES) {
      const t = fakeCtx();
      expect(await pasteSpecial({ mode }, t.ctx)).toEqual({ ok: true, result: {} });
      expect(t.calls).toEqual([{ mode, clearNets: false }]);
    }
  });

  it('a board: clearNets reaches the engine, through the board gate', async () => {
    const t = fakeCtx({ frame: 'pcb' });
    expect(await pasteSpecial({ mode: 'keep', clearNets: true }, t.ctx)).toEqual({ ok: true, result: {} });
    expect(t.gates).toEqual(['pcb']);
    expect(t.calls).toEqual([{ mode: 'keep', clearNets: true }]);
    expect(t.started).toEqual([UUID_B]);
  });

  it('waits for the items: the answer comes only once the selection holds a uuid it did not hold before', async () => {
    let s: string[] = [];
    const t = fakeCtx({ selected: [UUID_A], engine: (_a, sel) => { s = sel; return true; } });
    const p = pasteSpecial({ mode: 'unique' }, t.ctx);
    await settle(30);
    expect(t.started).toEqual([]);
    s.push(UUID_A);
    await settle(15);
    expect(t.started).toEqual([]);
    s.push(UUID_B);
    expect(await p).toEqual({ ok: true, result: {} });
    expect(t.started).toEqual([UUID_B]);
  });

  it('not_applied when nothing reaches the pointer within the bound (an empty clipboard)', async () => {
    const t = fakeCtx({ engine: () => true });
    expect(await pasteSpecial({ mode: 'unique' }, t.ctx)).toEqual({
      ok: false, code: 'not_applied', message: 'paste.special: KiCad put nothing on the pointer (the clipboard holds nothing it pastes)',
    });
    expect(t.started).toEqual([]);
  });

  it('busy when the engine refuses the call, throws or answers anything but true', async () => {
    for (const engine of [() => false, () => { throw new Error('x'); }, () => 'true', () => 1]) {
      const t = fakeCtx({ engine });
      expect(await pasteSpecial({ mode: 'remove' }, t.ctx)).toEqual({ ok: false, code: 'busy', message: 'paste.special: the editor cannot paste now' });
      expect(t.started).toEqual([]);
    }
  });

  it('island_error when the frame closes while it waits', async () => {
    const t = fakeCtx({ engine: () => true, closed: true });
    expect(await pasteSpecial({ mode: 'unique' }, t.ctx)).toEqual({ ok: false, code: 'island_error', message: 'the frame closed' });
  });

  it('bad_args before anything, and for clearNets true in a schematic', async () => {
    const t = fakeCtx();
    expect(await pasteSpecial({ mode: 'unique', clearNets: 'no' }, t.ctx)).toEqual({ ok: false, code: 'bad_args', message: 'paste.special' });
    expect(await pasteSpecial({ mode: 'unique', clearNets: true }, t.ctx)).toEqual({ ok: false, code: 'bad_args', message: 'paste.special: clearNets is a board choice' });
    expect(await pasteSpecial({ mode: 'unique', clearNets: false }, t.ctx)).toEqual({ ok: true, result: {} });
    expect(t.calls).toEqual([{ mode: 'unique', clearNets: false }]);
  });

  it('the gate\'s refusal as it stands (busy while an item hangs or a dialog is up), nothing called', async () => {
    const t = fakeCtx({ gate: 'paste.special' });
    expect(await pasteSpecial({ mode: 'unique' }, t.ctx)).toEqual({ ok: false, code: 'busy', message: 'paste.special' });
    expect(t.calls).toEqual([]);
  });

  it('unsupported naming kicadPasteSpecial on an engine without it', async () => {
    for (const frame of ['sch', 'pcb']) {
      const t = fakeCtx({ frame, missing: 'kicadPasteSpecial' });
      expect(await pasteSpecial({ mode: 'unique' }, t.ctx)).toEqual({ ok: false, code: 'unsupported', message: 'kicadPasteSpecial' });
    }
  });

  it('in another frame: unsupported with the frame refusal', async () => {
    const t = fakeCtx({ frame: 'symedit' });
    expect(await pasteSpecial({ mode: 'unique' }, t.ctx)).toEqual({ ok: false, code: 'unsupported', message: 'a paste runs in a sch or pcb frame' });
    expect(t.calls).toEqual([]);
  });
});

describe('paste.special through the responder', () => {
  it('on an engine without the export: no pasteSpecial cap, bad_args first, then unsupported naming kicadPasteSpecial', async () => {
    const { ready, ask } = await boot('sch', { kicadCollabBusy: () => false, kicadCollabGetSelection: () => '[]' });
    expect(ready?.caps ?? []).not.toContain(PASTE_SPECIAL_CAP);
    expect(await ask(1, 'paste.special', { mode: 'new' })).toMatchObject({ id: 1, ok: false, error: { code: 'bad_args', message: 'paste.special' } });
    expect(await ask(2, 'paste.special', { mode: 'unique' })).toMatchObject({ id: 2, ok: false, error: { code: 'unsupported', message: 'kicadPasteSpecial' } });
  });

  it('lists pasteSpecial in ev.ready on an engine with every export; with no document the op answers not_ready', async () => {
    const { ready, ask } = await boot('pcb', { kicadCollabBusy: () => false, kicadCollabGetSelection: () => '[]', kicadPasteSpecial: () => false });
    expect(ready?.caps ?? []).toContain(PASTE_SPECIAL_CAP);
    expect(await ask(1, 'paste.special', { mode: 'keep', clearNets: true })).toMatchObject({ id: 1, ok: false, error: { code: 'not_ready', message: 'paste.special' } });
  });

  it('in another frame: unsupported with the unit\'s frame refusal', async () => {
    const { ask } = await boot('symedit', { kicadCollabBusy: () => false, kicadPasteSpecial: () => false });
    expect(await ask(1, 'paste.special', { mode: 'unique' })).toMatchObject({ id: 1, ok: false, error: { code: 'unsupported', message: 'a paste runs in a sch or pcb frame' } });
  });
});
