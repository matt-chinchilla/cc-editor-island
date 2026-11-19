// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// m1x-i: the prompt host. The engine here is this test's own module of
// exports and a small document; the real engine is the e2e's
// (tests/e2e/m/m1x-prompts.spec.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startResponder } from '../responder';
import { dismissPopups, keysBlocked } from '../modal';
import { heldTaken } from '../held';
import type { Answer, ExtUnit, ResponderCtx } from './contract';
import { buildRegistry, heldActions, REGISTRY } from './registry';
import unit, { M1X_HELD_ROWS, MARKER_ATTR, PROMPT_EXPORTS, PROMPTS_CAP } from './m1x-i';
import { answerFits, readAssignNetclass, readEntry, readLayer, readMessage } from './m1x-i/asks';
import { doorOf, PROMPTS_CAP as DOORS_PROMPTS_CAP } from './m1-i/doors';

const PARENT = 'http://localhost';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  vi.stubGlobal('KeyboardEvent', class extends Event {
    constructor(type: string, init: Record<string, unknown> = {}) {
      const { bubbles, cancelable, composed, ...rest } = init as EventInit & Record<string, unknown>;
      super(type, { bubbles, cancelable, composed });
      Object.assign(this, rest);
    }
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

/** A document with a body, createElement and a class querySelector: enough for the marker and bridge/modal.ts. */
function fakeDoc() {
  type El = { className: string; hidden: boolean; attrs: Record<string, string>; on: Map<string, Array<(e: Event) => void>>; setAttribute(n: string, v: string): void; addEventListener(t: string, f: (e: Event) => void): void; dispatchEvent(e: Event): boolean; remove(): void };
  const children: El[] = [];
  return {
    children,
    body: { appendChild: (el: El) => { children.push(el); return el; } },
    createElement: (): El => ({
      className: '', hidden: false, attrs: {}, on: new Map(),
      setAttribute(n, v) { this.attrs[n] = v; },
      addEventListener(t, f) { const l = this.on.get(t) ?? []; l.push(f); this.on.set(t, l); },
      dispatchEvent(e) { for (const f of this.on.get(e.type) ?? []) f(e); return true; },
      remove() { const i = children.indexOf(this); if (i >= 0) children.splice(i, 1); },
    }),
    querySelector: (sel: string) => (sel.startsWith('.') ? children.find((c) => c.className.split(' ').includes(sel.slice(1))) ?? null : null),
    querySelectorAll: () => [],
  };
}

type Slot = { onAsk?: (j: unknown) => boolean; onUpdate?: (j: unknown) => void; onEnd?: (j: unknown) => void };
const RUN15 = (over: Record<string, unknown> = {}) => ({
  kicadHostPrompts: () => true,
  kicadPromptAnswer: vi.fn((): unknown => '{"accepted":true}'),
  kicadPromptCancel: vi.fn((): unknown => 0),
  kicadPromptPick: vi.fn((): unknown => 0),
  ...over,
});

/** A ctx over a fake window, as the responder builds one; `state` steers what it reads. */
function fakeCtx(frame: string, mod: Record<string, unknown>, state: Partial<{ caps: string[]; doc: boolean; importing: boolean; ready: boolean; closed: boolean }> = {}) {
  const document = fakeDoc();
  const w = { Module: mod, document, kicadHostPrompt: undefined as Slot | undefined };
  const s = { caps: [PROMPTS_CAP, 'rules'], doc: true, importing: false, ready: true, closed: false, ...state };
  const emitted: Array<{ type: string } & Record<string, unknown>> = [];
  let held = 0;
  const ctx = {
    frame, root: '/p', timing: {},
    win: () => w, mod: () => w.Module, fs: () => null, has: (n: readonly string[]) => n.every((x) => typeof w.Module[x] === 'function'),
    ready: () => s.ready, closed: () => s.closed, caps: () => s.caps,
    opened: () => (s.doc ? 'x.kicad_pcb' : null), staged: () => null, hasDocument: () => s.doc, admit: () => s.doc,
    engineBusy: () => false, keysBlocked: () => keysBlocked(w as never), placeHanging: () => false, importing: () => s.importing,
    checking: () => false, simRun: () => null, heldRows: () => heldActions(),
    readAsk: (ask: string, record: unknown) => REGISTRY.askReaders.get(ask)?.read(record) ?? null,
    inFlight: () => 0,
    holdMenus: (on: boolean) => { held = Math.max(0, held + (on ? 1 : -1)); },
    emitExt: (type: string, payload: Record<string, unknown>) => { emitted.push({ type, ...payload }); },
    emit: (ev: { type: string }) => { emitted.push(ev); },
    log: () => {},
  } as unknown as ResponderCtx;
  const stop = unit.install!(ctx) as () => void;
  return { ctx, w, s, emitted, stop, held: () => held, slot: () => w.kicadHostPrompt as Slot };
}

const FILLET = { title: 'Fillet Tracks', fields: [{ key: 'value', label: 'Radius:', kind: 'length', value: 0.5, tip: '' }] };
const ASK = (token: number, ask = 'entry', record: unknown = FILLET, modal = true) => JSON.stringify({ token, ask, modal, record });
const MESSAGE = { title: 'Confirmation', text: 'Items are locked.', extra: '', icon: 'warning', buttons: [{ id: 'ok', label: 'Drag Anyway' }, { id: 'cancel', label: 'Cancel' }], dontAsk: false };
const of = (e: Array<{ type: string }>, type: string) => e.filter((m) => m.type === type) as Array<Record<string, unknown>>;
const run = (op: string, args: unknown, ctx: ResponderCtx): Promise<Answer> => Promise.resolve((unit as ExtUnit).ops![op].run(args, ctx));

describe('the unit in the registry', () => {
  it('loads in this checkout with nothing broken: its ops, cap, events and asks its own', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect(REGISTRY.capNames.get(PROMPTS_CAP)).toBe('m1x-i');
    for (const op of ['prompt.answer', 'prompt.cancel', 'prompt.pick']) {
      expect(REGISTRY.ops.get(op)?.unit).toBe('m1x-i');
      expect(REGISTRY.ops.get(op)?.op.now).toBe(true);
      expect(REGISTRY.pending.has(op)).toBe(false);
    }
    expect(REGISTRY.events.get('ev.prompt')?.keys).toEqual(['token', 'ask', 'modal', 'frame', 'record']);
    expect(REGISTRY.events.get('ev.promptUpdate')?.keys).toEqual(['token', 'record']);
    expect(REGISTRY.events.get('ev.promptEnd')?.keys).toEqual(['token', 'reason']);
    for (const ask of ['entry', 'layer', 'message', 'assignNetclass']) {
      expect(REGISTRY.asks.get(ask)).toBe('m1x-i');
      expect(REGISTRY.askReaders.get(ask)?.unit).toBe('m1x-i');
    }
    expect((REGISTRY.widen.get('project.forget') ?? []).map((w) => w.unit)).toContain('m1x-i');
  });

  it('the cap is the one the doors table reads', () => {
    expect(PROMPTS_CAP).toBe(DOORS_PROMPTS_CAP);
  });

  it('holds KiCad\'s Clearance and Constraints reports in a pcb frame under the rules cap', () => {
    expect((unit as ExtUnit).held).toEqual(['pcbnew.InspectionTool.InspectClearance', 'pcbnew.InspectionTool.InspectConstraints']);
    const union = heldActions();
    for (const r of M1X_HELD_ROWS) {
      expect(heldTaken(r.action, 'pcb', ['rules'], union)).toBe(true);
      expect(heldTaken(r.action, 'pcb', [], union)).toBe(false);
      expect(heldTaken(r.action, 'sch', ['rules'], union)).toBe(false);
      // Our menu ends a choice of it in ev.held, and action.run refuses it for the host's own door.
      expect(doorOf(r.action, 'pcb', ['rules'], union)).toBe('held');
    }
  });
});

describe('prompts, feature detected', () => {
  it('lists the cap in every editor frame only with all four exports', () => {
    const caps = unit.caps!;
    for (const f of ['sch', 'pcb', 'symedit', 'fpedit', 'ds']) expect(caps(RUN15(), f as never)).toEqual([PROMPTS_CAP]);
    for (const name of PROMPT_EXPORTS) {
      const mod: Record<string, unknown> = RUN15();
      delete mod[name];
      expect(caps(mod, 'pcb')).toEqual([]);
    }
    expect(caps({}, 'sch')).toEqual([]);
    expect(caps(RUN15(), 'calculator' as never)).toEqual([]);
  });

  it('ev.ready lists prompts on a run 15 engine and not on run 14; the ops answer unsupported there; the slot is set either way', async () => {
    const boot = async (exports: Record<string, unknown>) => {
      const definers = REGISTRY.units.filter((u) => u.defineFrames != null && u.unit !== 'm1x-i');
      const reg = buildRegistry(Object.fromEntries([...definers, unit].map((u) => [`./${u.unit}.ts`, { default: u }])), {}, Object.fromEntries(REGISTRY.pendingFrames));
      expect(reg.problems).toEqual([]);
      const listeners = new Map<string, Set<(e: unknown) => void>>();
      const parent = { postMessage: vi.fn() };
      const page = {
        parent, top: {}, location: { search: '?frame=pcb&theme=day' },
        addEventListener: (t: string, h: (e: unknown) => void) => { const s = listeners.get(t) ?? new Set(); s.add(h); listeners.set(t, s); },
        removeEventListener: (t: string, h: (e: unknown) => void) => listeners.get(t)?.delete(h),
      };
      const r = startResponder({ parentOrigin: PARENT, page: page as unknown as Window, ext: reg });
      const ch = new MessageChannel();
      const got: Array<Record<string, unknown>> = [];
      ch.port1.onmessage = (m) => got.push(m.data);
      for (const h of listeners.get('message') ?? []) h({ origin: PARENT, source: parent, data: { type: 'cc.connect', nonce: parent.postMessage.mock.calls[0][0].nonce }, ports: [ch.port2] });
      const win = {
        FS: { analyzePath: () => ({ exists: false }), mkdirTree: () => {}, readdir: () => [], readFile: () => { throw new Error('ENOENT'); } },
        Module: { kicadOpenFileBusy: () => false, ...exports },
        wxElementRegistry: { findAll: () => [], findByLabel: () => [] },
        document: fakeDoc(),
        dispatchEvent: () => true, addEventListener: () => {}, removeEventListener: () => {},
      } as unknown as ToolWindow & { kicadHostPrompt?: Slot };
      r.engineReady(win, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
      await settle();
      ch.port1.postMessage({ id: 1, op: 'prompt.answer', args: { token: 3, values: { value: 1 } } });
      ch.port1.postMessage({ id: 2, op: 'prompt.cancel', args: { token: 3 } });
      ch.port1.postMessage({ id: 3, op: 'prompt.pick', args: { token: 3, kind: 'point' } });
      ch.port1.postMessage({ id: 4, op: 'project.forget' });
      await settle();
      return { ready: got.find((m) => m.type === 'ev.ready') as { caps: string[] }, got, win };
    };
    const t15 = await boot(RUN15());
    expect(t15.ready.caps).toContain(PROMPTS_CAP);
    expect(typeof t15.win.kicadHostPrompt?.onAsk).toBe('function');
    // No document is open, so the frame takes no ask.
    expect(t15.win.kicadHostPrompt!.onAsk!(ASK(5))).toBe(false);
    expect(t15.got.find((m) => m.id === 1)).toEqual({ id: 1, ok: false, error: { code: 'stale', message: 'prompt.answer' } });
    expect(t15.got.find((m) => m.id === 2)).toEqual({ id: 2, ok: false, error: { code: 'stale', message: 'prompt.cancel' } });
    expect(t15.got.find((m) => m.id === 3)).toEqual({ id: 3, ok: false, error: { code: 'stale', message: 'prompt.pick' } });
    expect(t15.got.find((m) => m.id === 4)).toEqual({ id: 4, ok: true, result: {} });
    const t14 = await boot({ kicadHostActions: () => true });
    expect(t14.ready.caps).not.toContain(PROMPTS_CAP);
    expect(typeof t14.win.kicadHostPrompt?.onAsk).toBe('function');
    expect(t14.got.find((m) => m.id === 1)).toEqual({ id: 1, ok: false, error: { code: 'unsupported', message: 'kicadPromptAnswer' } });
    expect(t14.got.find((m) => m.id === 2)).toEqual({ id: 2, ok: false, error: { code: 'unsupported', message: 'kicadPromptCancel' } });
    expect(t14.got.find((m) => m.id === 3)).toEqual({ id: 3, ok: false, error: { code: 'unsupported', message: 'kicadPromptPick' } });
  });
});

describe('the generic asks read closed', () => {
  it('entry: the four dialogs\' records', () => {
    expect(readEntry(FILLET)).toEqual(FILLET);
    const point = { title: 'Move Corner To', fields: [{ key: 'point', label: 'X, Y', kind: 'point', value: { x: 1.5, y: -2 }, tip: '' }] };
    expect(readEntry(point)).toEqual(point);
    const textEntry = { title: 'Line', fields: [{ key: 'value', label: '', kind: 'text', value: 'L1', tip: '' }] };
    expect(readEntry(textEntry)).toEqual(textEntry);
    const multi = { title: 'Dogbone Corners', fields: [{ key: 'f0', label: 'Arc radius:', kind: 'length', value: 0.25, tip: '' }, { key: 'f1', label: 'Add slots', kind: 'check', value: false, tip: 'x' }] };
    expect(readEntry(multi)).toEqual(multi);
    const angle = { title: 'A', fields: [{ key: 'value', label: 'Angle:', kind: 'angle', value: 45, tip: '' }] };
    expect(readEntry(angle)).toEqual(angle);
  });

  it('entry: any other shape is refused (KiCad\'s dialog shows)', () => {
    expect(readEntry({ ...FILLET, extra: 1 })).toBeNull();
    expect(readEntry({ title: 'x', fields: [] })).toBeNull();
    expect(readEntry({ title: 'x', fields: [{ ...FILLET.fields[0], extra: 1 }] })).toBeNull();
    expect(readEntry({ title: 'x', fields: [{ ...FILLET.fields[0], value: '1' }] })).toBeNull();
    expect(readEntry({ title: 'x', fields: [{ ...FILLET.fields[0], kind: 'shade' }] })).toBeNull();
    expect(readEntry({ title: 'x', fields: [{ ...FILLET.fields[0], key: 'radius' }] })).toBeNull();
    expect(readEntry({ title: 'x', fields: [FILLET.fields[0], FILLET.fields[0]] })).toBeNull();
    expect(readEntry({ title: 'x', fields: [{ ...FILLET.fields[0], kind: 'point', value: { x: 1 } }] })).toBeNull();
    expect(readEntry({ title: 'x', fields: [{ ...FILLET.fields[0], value: Number.NaN }] })).toBeNull();
  });

  it('layer, message and assignNetclass', () => {
    const layer = { current: 'F.Cu', layers: [{ canonical: 'F.Cu', name: 'F.Cu', color: '#c83434ff' }, { canonical: 'B.Cu', name: 'B.Cu', color: '#4d7fc4ff' }] };
    expect(readLayer(layer)).toEqual(layer);
    expect(readLayer({ ...layer, current: '' })).toEqual({ ...layer, current: '' });
    expect(readLayer({ ...layer, layers: [{ ...layer.layers[0], color: '#c83434' }] })).toBeNull();
    expect(readLayer({ ...layer, layers: [layer.layers[0], layer.layers[0]] })).toBeNull();
    expect(readLayer({ ...layer, layers: [] })).toBeNull();
    expect(readMessage(MESSAGE)).toEqual(MESSAGE);
    expect(readMessage({ ...MESSAGE, icon: 'stop' })).toBeNull();
    expect(readMessage({ ...MESSAGE, buttons: [{ id: 'maybe', label: 'Maybe' }] })).toBeNull();
    expect(readMessage({ ...MESSAGE, buttons: [] })).toBeNull();
    expect(readMessage({ ...MESSAGE, dontAsk: 'no' })).toBeNull();
    const nc = { pattern: 'GND', netclass: 'Default', netclasses: ['Default', 'Power'] };
    expect(readAssignNetclass(nc)).toEqual(nc);
    expect(readAssignNetclass({ ...nc, netclasses: [1] })).toBeNull();
    expect(readAssignNetclass({ pattern: 'GND', netclass: 'Default' })).toBeNull();
  });

  it('answers: the addendum\'s keys only, each of its type', () => {
    expect(answerFits('entry', { values: { value: 1 } })).toBe(true);
    expect(answerFits('entry', { values: { point: { x: 1, y: 2 }, f0: true, f1: 'x' } })).toBe(true);
    expect(answerFits('entry', {})).toBe(true);
    expect(answerFits('entry', { value: 1 })).toBe(false);
    expect(answerFits('entry', { values: { radius: 1 } })).toBe(false);
    expect(answerFits('entry', { values: { value: null } })).toBe(false);
    expect(answerFits('layer', { layer: 'B.Cu' })).toBe(true);
    expect(answerFits('layer', { layer: 3 })).toBe(false);
    expect(answerFits('message', { button: 'ok', dontAsk: true })).toBe(true);
    expect(answerFits('message', { button: 'ok', remember: true })).toBe(false);
    expect(answerFits('assignNetclass', { pattern: 'GND', netclass: 'Power' })).toBe(true);
    expect(answerFits('assignNetclass', { netclass: 1 })).toBe(false);
  });
});

describe('an ask on run 15: ev.prompt', () => {
  it('a modal ask is taken: one ev.prompt, a busy marker, ev.menu held', () => {
    const f = fakeCtx('pcb', RUN15());
    expect(f.slot().onAsk!(ASK(7))).toBe(true);
    expect(of(f.emitted, 'ev.prompt')).toEqual([{ type: 'ev.prompt', token: 7, ask: 'entry', modal: true, frame: 'pcb', record: FILLET }]);
    expect(f.w.document.children.map((c) => c.attrs[MARKER_ATTR])).toEqual(['7']);
    expect(keysBlocked(f.w as never)).toBe(true);
    expect(f.held()).toBe(1);
    // A save closes popups with Escape: the prompt's marker takes none, so the save answers busy.
    expect(dismissPopups(f.w as never)).toBe(false);
    expect(keysBlocked(f.w as never)).toBe(true);
  });

  it('a modeless ask is taken with no marker: the canvas stays the reader\'s', () => {
    const f = fakeCtx('pcb', RUN15());
    expect(f.slot().onAsk!(ASK(8, 'message', MESSAGE, false))).toBe(true);
    expect(of(f.emitted, 'ev.prompt')[0]).toMatchObject({ token: 8, modal: false });
    expect(keysBlocked(f.w as never)).toBe(false);
    expect(f.held()).toBe(0);
  });

  it('declines (KiCad\'s dialog shows) without the cap, a document, while importing, before ready, after close', () => {
    for (const st of [{ caps: [] }, { doc: false }, { importing: true }, { ready: false }, { closed: true }]) {
      const f = fakeCtx('pcb', RUN15(), st);
      expect(f.slot().onAsk!(ASK(1))).toBe(false);
      expect(f.emitted).toEqual([]);
    }
  });

  it('declines an ask no unit reads, a record of another shape, and a model of another shape', () => {
    const f = fakeCtx('pcb', RUN15());
    expect(f.slot().onAsk!(ASK(1, 'noSuchAsk', {}))).toBe(false);
    expect(f.slot().onAsk!(ASK(1, 'entry', { title: 'x' }))).toBe(false);
    expect(f.slot().onAsk!('{')).toBe(false);
    expect(f.slot().onAsk!(JSON.stringify({ token: 1, ask: 'entry', modal: true, record: FILLET, extra: 1 }))).toBe(false);
    expect(f.slot().onAsk!(JSON.stringify({ token: 1.5, ask: 'entry', modal: true, record: FILLET }))).toBe(false);
    expect(f.emitted).toEqual([]);
    expect(f.w.document.children).toEqual([]);
  });

  it('reads another unit\'s ask through ctx.readAsk', () => {
    const f = fakeCtx('pcb', RUN15());
    const read = vi.fn(() => ({ kept: 1 }));
    (f.ctx as unknown as { readAsk: unknown }).readAsk = read;
    expect(f.slot().onAsk!(ASK(9, 'convert', { raw: 1 }))).toBe(true);
    expect(read).toHaveBeenCalledWith('convert', { raw: 1 });
    expect(of(f.emitted, 'ev.prompt')[0]).toMatchObject({ ask: 'convert', record: { kept: 1 } });
  });
});

describe('prompt.answer, prompt.cancel and prompt.pick', () => {
  it('an accepted answer resumes the dialog: the marker goes, no ev.promptEnd', async () => {
    vi.useFakeTimers();
    const mod = RUN15();
    const f = fakeCtx('pcb', mod);
    f.slot().onAsk!(ASK(7));
    expect(await run('prompt.answer', { token: 7, values: { value: 1 } }, f.ctx)).toEqual({ ok: true, result: { accepted: true } });
    expect(mod.kicadPromptAnswer).toHaveBeenCalledWith(7, '{"values":{"value":1}}');
    expect(keysBlocked(f.w as never)).toBe(false);
    vi.advanceTimersByTime(500);
    expect(f.held()).toBe(0);
    // The engine's own onEnd for it, if any, is not passed on: the host closed its card.
    f.slot().onEnd!(JSON.stringify({ token: 7, reason: 'gone' }));
    expect(of(f.emitted, 'ev.promptEnd')).toEqual([]);
    expect(await run('prompt.answer', { token: 7, values: { value: 1 } }, f.ctx)).toEqual({ ok: false, code: 'stale', message: 'prompt.answer' });
  });

  it('a refusal keeps the prompt parked and says which field and why', async () => {
    const mod = RUN15({ kicadPromptAnswer: vi.fn(() => '{"accepted":false,"field":"f0","message":"The radius must be greater than zero."}') });
    const f = fakeCtx('pcb', mod);
    f.slot().onAsk!(ASK(4));
    expect(await run('prompt.answer', { token: 4, values: { f0: -1 } }, f.ctx)).toEqual({ ok: true, result: { accepted: false, field: 'f0', message: 'The radius must be greater than zero.' } });
    expect(keysBlocked(f.w as never)).toBe(true);
    expect(await run('prompt.cancel', { token: 4 }, f.ctx)).toEqual({ ok: true, result: {} });
    expect(keysBlocked(f.w as never)).toBe(false);
  });

  it('checks the answer closed for this unit\'s asks, and passes another unit\'s whole', async () => {
    const mod = RUN15();
    const f = fakeCtx('pcb', mod);
    f.slot().onAsk!(ASK(3));
    expect(await run('prompt.answer', { token: 3, value: 1 }, f.ctx)).toEqual({ ok: false, code: 'bad_args', message: 'prompt.answer' });
    expect(await run('prompt.answer', { values: { value: 1 } }, f.ctx)).toEqual({ ok: false, code: 'bad_args', message: 'prompt.answer' });
    expect(await run('prompt.answer', 'x', f.ctx)).toEqual({ ok: false, code: 'bad_args', message: 'prompt.answer' });
    expect(mod.kicadPromptAnswer).not.toHaveBeenCalled();
    (f.ctx as unknown as { readAsk: unknown }).readAsk = () => ({});
    f.slot().onAsk!(ASK(10, 'array', {}, false));
    expect(await run('prompt.answer', { token: 10, shape: 'grid', grid: { nx: 2 } }, f.ctx)).toEqual({ ok: true, result: { accepted: true } });
    expect(mod.kicadPromptAnswer).toHaveBeenLastCalledWith(10, '{"shape":"grid","grid":{"nx":2}}');
    // A modeless prompt may stay open after an accepted answer: it is kept until the engine says it is gone.
    mod.kicadPromptAnswer.mockReturnValueOnce('{"stale":true}');
    expect(await run('prompt.answer', { token: 10, x: 1 }, f.ctx)).toEqual({ ok: false, code: 'stale', message: 'prompt.answer' });
    expect(await run('prompt.answer', { token: 10, x: 1 }, f.ctx)).toEqual({ ok: false, code: 'stale', message: 'prompt.answer' });
  });

  it('reads the engine\'s answer closed', async () => {
    for (const [raw, want] of [
      ['', { ok: false, code: 'bad_args', message: 'prompt.answer' }],
      ['{"accepted":"yes"}', { ok: false, code: 'island_error', message: 'prompt.answer: the engine answered another shape' }],
      [7, { ok: false, code: 'island_error', message: 'prompt.answer: the engine answered another shape' }],
    ] as const) {
      const f = fakeCtx('pcb', RUN15({ kicadPromptAnswer: vi.fn(() => raw) }));
      f.slot().onAsk!(ASK(2));
      expect(await run('prompt.answer', { token: 2 }, f.ctx)).toEqual(want);
    }
  });

  it('prompt.cancel: no edit, no ev.promptEnd; stale once gone', async () => {
    const mod = RUN15();
    const f = fakeCtx('pcb', mod);
    f.slot().onAsk!(ASK(6));
    expect(await run('prompt.cancel', { token: 6 }, f.ctx)).toEqual({ ok: true, result: {} });
    expect(mod.kicadPromptCancel).toHaveBeenCalledWith(6);
    expect(of(f.emitted, 'ev.promptEnd')).toEqual([]);
    expect(await run('prompt.cancel', { token: 6 }, f.ctx)).toEqual({ ok: false, code: 'stale', message: 'prompt.cancel' });
    expect(await run('prompt.cancel', { token: 6, x: 1 }, f.ctx)).toEqual({ ok: false, code: 'bad_args', message: 'prompt.cancel' });
    mod.kicadPromptCancel.mockReturnValueOnce(1);
    f.slot().onAsk!(ASK(11));
    expect(await run('prompt.cancel', { token: 11 }, f.ctx)).toEqual({ ok: false, code: 'stale', message: 'prompt.cancel' });
    expect(keysBlocked(f.w as never)).toBe(false);
  });

  it('prompt.pick: runs the dialog\'s own picker, or says the ask has none', async () => {
    const mod = RUN15();
    const f = fakeCtx('pcb', mod);
    (f.ctx as unknown as { readAsk: unknown }).readAsk = () => ({});
    f.slot().onAsk!(ASK(12, 'positionRelative', {}, false));
    expect(await run('prompt.pick', { token: 12, kind: 'item' }, f.ctx)).toEqual({ ok: true, result: {} });
    expect(mod.kicadPromptPick).toHaveBeenCalledWith(12, 'item');
    mod.kicadPromptPick.mockReturnValueOnce(2);
    expect(await run('prompt.pick', { token: 12, kind: 'point' }, f.ctx)).toEqual({ ok: false, code: 'no_picker', message: 'positionRelative has no point picker' });
    expect(await run('prompt.pick', { token: 12, kind: 'line' }, f.ctx)).toEqual({ ok: false, code: 'bad_args', message: 'prompt.pick' });
    mod.kicadPromptPick.mockReturnValueOnce(1);
    expect(await run('prompt.pick', { token: 12, kind: 'point' }, f.ctx)).toEqual({ ok: false, code: 'stale', message: 'prompt.pick' });
  });
});

describe('the engine\'s updates and ends', () => {
  it('ev.promptUpdate carries a parked prompt\'s new record, read by its ask\'s reader', () => {
    const f = fakeCtx('pcb', RUN15());
    f.slot().onAsk!(ASK(5, 'entry', FILLET, false));
    const next = { ...FILLET, title: 'Fillet' };
    f.slot().onUpdate!(JSON.stringify({ token: 5, record: next }));
    f.slot().onUpdate!(JSON.stringify({ token: 5, record: { title: 1 } }));
    f.slot().onUpdate!(JSON.stringify({ token: 99, record: next }));
    expect(of(f.emitted, 'ev.promptUpdate')).toEqual([{ type: 'ev.promptUpdate', token: 5, record: next }]);
  });

  it('ev.promptEnd for a prompt the engine ended: canceled or gone, the marker away', () => {
    const f = fakeCtx('pcb', RUN15());
    f.slot().onAsk!(ASK(5));
    f.slot().onAsk!(ASK(6, 'message', MESSAGE, false));
    f.slot().onEnd!(JSON.stringify({ token: 5, reason: 'canceled' }));
    f.slot().onEnd!(JSON.stringify({ token: 6, reason: 'destroyed' }));
    f.slot().onEnd!(JSON.stringify({ token: 6, reason: 'gone' }));
    expect(of(f.emitted, 'ev.promptEnd')).toEqual([{ type: 'ev.promptEnd', token: 5, reason: 'canceled' }, { type: 'ev.promptEnd', token: 6, reason: 'gone' }]);
    expect(keysBlocked(f.w as never)).toBe(false);
  });

  it('project.forget ends every parked prompt (ev.promptEnd gone) and then forgets', async () => {
    const mod = RUN15();
    const f = fakeCtx('pcb', mod);
    f.slot().onAsk!(ASK(5));
    const next = vi.fn(async (): Promise<Answer> => ({ ok: true, result: {} }));
    expect(await unit.opsWidened!['project.forget'](undefined, f.ctx, next)).toEqual({ ok: true, result: {} });
    expect(next).toHaveBeenCalledWith(undefined);
    expect(mod.kicadPromptCancel).toHaveBeenCalledWith(5);
    expect(of(f.emitted, 'ev.promptEnd')).toEqual([{ type: 'ev.promptEnd', token: 5, reason: 'gone' }]);
    expect(keysBlocked(f.w as never)).toBe(false);
  });

  it('the close cancels what is parked, sends nothing and takes the slot back', () => {
    const mod = RUN15();
    const f = fakeCtx('pcb', mod);
    f.slot().onAsk!(ASK(5));
    f.s.closed = true;
    f.stop();
    expect(mod.kicadPromptCancel).toHaveBeenCalledWith(5);
    expect(of(f.emitted, 'ev.promptEnd')).toEqual([]);
    expect(f.w.kicadHostPrompt).toBeUndefined();
  });
});
