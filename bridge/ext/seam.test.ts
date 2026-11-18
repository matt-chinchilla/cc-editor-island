// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The island seam: the registry's rules, and a unit's file as the responder
// runs it (placeholders, new ops on and off the queue, widening, frames, caps,
// events, held rows, installs, a new frame). The units here are this test's
// own, fed to buildRegistry; the checkout's registry holds none of them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startResponder } from '../responder';
import { HELD_ACTIONS } from '../held';
import { BUILTIN_OPS } from './builtins';
import { fail, ok, SEAM_PLACEHOLDER, type ExtUnit } from './contract';
import { buildRegistry, exportJobs, heldActions, REGISTRY, requestOps } from './registry';
import { bootFrame, documentExtension, frameForToolName, frameToken, frameTool, ownDocument, unitsPerMm } from '../../src/frames';

const PARENT = 'http://localhost';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));

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

/** A booted engine with only what engineReady reads, and `extra` exports. */
function fakeEngine(extra: Record<string, unknown> = {}) {
  const Module: Record<string, unknown> = { kicadOpenFileBusy: () => false, ...extra };
  const win = {
    FS: { analyzePath: () => ({ exists: false }), mkdirTree: () => {}, readdir: () => [], readFile: () => { throw new Error('ENOENT'); } },
    Module,
    wxElementRegistry: { findAll: () => [{ id: 'frame', typeName: 'SCH_EDIT_FRAME', name: 'SchematicFrame', visible: true }], findByLabel: () => [] },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    dispatchEvent: () => true,
  } as unknown as ToolWindow & { kicadHostAction?: { onRequest?: (json: unknown) => boolean } };
  return { win, Module };
}

/** A responder on `units`, connected and booted; `got` collects what the host hears. */
async function boot(units: ExtUnit[], opts: { frame?: string; exports?: Record<string, unknown>; pending?: Record<string, string> } = {}) {
  const reg = buildRegistry(mods(...units), opts.pending ?? {});
  expect(reg.problems).toEqual([]);
  const { page, parent } = fakePage(`?frame=${opts.frame ?? 'sch'}&theme=day`);
  const r = startResponder({ parentOrigin: PARENT, page, ext: reg });
  const ch = new MessageChannel();
  const got: Array<Record<string, unknown>> = [];
  ch.port1.onmessage = (m) => got.push(m.data);
  page.dispatch('message', { origin: PARENT, source: page.parent, data: { type: 'cc.connect', nonce: parent.postMessage.mock.calls[0][0].nonce }, ports: [ch.port2] });
  const eng = fakeEngine(opts.exports);
  r.engineReady(eng.win, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
  await settle();
  const ask = async (id: number, op: string, args?: unknown, wait = 20) => {
    ch.port1.postMessage(args === undefined ? { id, op } : { id, op, args });
    await settle(wait);
    return got.find((m) => m.id === id);
  };
  return { r, reg, got, port: ch.port1, eng, ask, ready: got.find((m) => m.type === 'ev.ready') as { caps: string[] } | undefined };
}

describe('the registry', () => {
  it('loads this checkout\'s units with nothing broken, after the built ins', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect(requestOps()).toEqual([...BUILTIN_OPS, ...[...REGISTRY.ops.keys()].sort()]);
    expect(heldActions()).toEqual([...HELD_ACTIONS, ...REGISTRY.heldRows]);
  });

  it('answers every manifest op of bridge/ext/pending.json with its unit, none of them an op that ships', () => {
    expect(REGISTRY.pending.size).toBeGreaterThan(0);
    for (const [op, unit] of REGISTRY.pending) {
      expect(BUILTIN_OPS).not.toContain(op);
      expect(unit).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });

  it('takes a unit only under its own file stem, and refuses what would replace a built in', () => {
    const reg = buildRegistry({
      './a-i.ts': { default: { unit: 'b-i' } },
      './c-i.ts': { default: { unit: 'c-i', ops: { 'project.open': { run: () => ok() }, 'c.op': { run: () => ok() } }, events: { 'ev.held': ['action'], 'ev.cOne': ['x'] }, exportJobs: { pcb_export_gerbers: 'pcb', c_job: 'sch' } } },
      './d-i.ts': { default: { unit: 'd-i', ops: { 'c.op': { run: () => ok() } }, opsWidened: { 'no.such': async () => ok() }, heldRows: [{ action: 'pcbnew.DRCTool.runDRC', frames: ['pcb'], cap: 'drc' }] } },
      './e-i.ts': { default: { unit: 'e-i', frames: ['nowhere'], held: ['x.y.z'], caps: () => [] } },
      './f-i.ts': {},
    });
    expect(reg.units.map((u) => u.unit)).toEqual(['c-i', 'd-i', 'e-i']);
    expect([...reg.ops.keys()]).toEqual(['c.op']);
    expect(reg.ops.get('c.op')?.unit).toBe('c-i');
    expect([...reg.events.keys()]).toEqual(['ev.cOne']);
    expect(reg.exportJobs).toEqual({ c_job: 'sch' });
    expect(reg.heldRows).toEqual([]);
    expect(reg.problems).toEqual([
      "./a-i.ts: unit 'b-i' is not the file stem 'a-i'",
      './f-i.ts: no default export (an ExtUnit)',
      "c-i: op 'project.open' ships already (widen it through opsWidened)",
      "d-i: op 'c.op' is already c-i's",
      'e-i: frames names a frame no one defines',
      "d-i: opsWidened 'no.such' is no op",
      "c-i: event 'ev.held' is no new event type",
      'd-i: held pcbnew.DRCTool.runDRC in pcb is held already',
      "e-i: held 'x.y.z' has no held row of the unit",
      "c-i: export job 'pcb_export_gerbers' is no new job",
      'e-i: caps needs capNames, the caps it may list',
    ]);
  });

  it('keeps an op pending only until a unit answers it', () => {
    const reg = buildRegistry(mods({ unit: 'g-i', ops: { 'g.one': { run: () => ok() } } }), { 'g.one': 'g-i', 'g.two': 'g-i', 'project.open': 'x-i' });
    expect([...reg.pending]).toEqual([['g.two', 'g-i']]);
    expect(requestOps(reg)).toEqual([...BUILTIN_OPS, 'g.one']);
  });

  it('reads the held rows and export jobs as one union with the built ins', () => {
    const reg = buildRegistry(mods({ unit: 'h-i', held: ['pcbnew.Foo.bar'], heldRows: [{ action: 'pcbnew.Foo.bar', frames: ['pcb'], cap: 'foo' }], exportJobs: { h_job: 'pcb' } }));
    expect(heldActions(reg).slice(-1)).toEqual([{ action: 'pcbnew.Foo.bar', frames: ['pcb'], cap: 'foo' }]);
    expect(heldActions(reg)).toHaveLength(HELD_ACTIONS.length + 1);
    expect(exportJobs(reg).h_job).toBe('pcb');
    expect(exportJobs(reg).pcb_export_gerbers).toBe('pcb');
  });
});

describe('the frame registry', () => {
  const tf: ExtUnit = {
    unit: 'tf-i',
    defineFrames: {
      tframe: {
        token: 'tframe', tool: { name: 'tool_x', bundle: 'kicad_editor', argv0: '/usr/bin/tool_x', needsConfigSeed: true, libKind: null },
        toolNames: ['tool_x'], document: null, extension: '.kicad_wks', unitsPerMm: 1e3, pickKind: 'footprint', picker: false,
        refuses: ['project.open', 'place'], refusal: 'a test frame opens no documents', caps: ['write', 'tcap'],
      },
    },
  };
  it('answers the built in frames as before and a unit frame from its descriptor', () => {
    const reg = buildRegistry(mods(tf));
    expect(reg.problems).toEqual([]);
    expect(bootFrame('pcb', reg)).toBe('pcb');
    expect(bootFrame('tframe', reg)).toBe('tframe');
    expect(bootFrame('nothing', reg)).toBe('sch');
    expect(bootFrame('tframe')).toBe('sch');
    expect([frameToken('symedit'), frameTool('symedit'), frameTool('pcb')]).toEqual(['symedit', 'eeschema', 'pcbnew']);
    expect([frameToken('tframe' as never, reg), frameTool('tframe' as never, reg)]).toEqual(['tframe', 'tool_x']);
    expect([frameForToolName('C:/x/pcbnew.exe', reg), frameForToolName('tool_x', reg), frameForToolName('gerbview', reg)]).toEqual(['pcb', 'tframe', null]);
    expect([ownDocument('sch'), ownDocument('symedit'), ownDocument('tframe' as never, reg)]).toEqual(['.kicad_sch', null, null]);
    expect([documentExtension('pcb'), documentExtension('tframe' as never, reg)]).toEqual(['.kicad_pcb', '.kicad_wks']);
    expect([unitsPerMm('pcb'), unitsPerMm('sch'), unitsPerMm('tframe' as never, reg)]).toEqual([1e6, 1e4, 1e3]);
  });

  it('refuses a frame named as a built in or with a descriptor of another shape', () => {
    const reg = buildRegistry(mods({ unit: 'bad-i', defineFrames: { pcb: tf.defineFrames!.tframe, other: { ...tf.defineFrames!.tframe, refuses: ['no.op'] } } }));
    expect(reg.frames.size).toBe(0);
    expect(reg.problems).toEqual(["bad-i: frame 'pcb' is no new frame name", "bad-i: frame 'other': refuses must list ops that ship"]);
  });

  it('boots a unit frame: its refusals, its caps alone, its unit ops only there', async () => {
    const unit: ExtUnit = { ...tf, frames: ['tframe' as never], frameRefusal: 'a test op runs in a test frame', ops: { 't.op': { run: (_a, ctx) => ok({ frame: ctx.frame }) } }, capNames: ['tcap', 'tother'], caps: () => ['tcap', 'tother'] };
    const t = await boot([unit], { frame: 'tframe', exports: { kicadThing: () => 1, kicadHostActions: () => true } });
    expect(t.ready?.caps).toEqual(['kicadHostActions', 'kicadOpenFileBusy', 'kicadThing', 'tcap', 'write']);
    expect(await t.ask(1, 'project.open', { name: 'x', files: [] })).toEqual({ id: 1, ok: false, error: { code: 'unsupported', message: 'a test frame opens no documents' } });
    expect(await t.ask(2, 't.op')).toEqual({ id: 2, ok: true, result: { frame: 'tframe' } });
    const s = await boot([unit]);
    expect(await s.ask(3, 't.op')).toEqual({ id: 3, ok: false, error: { code: 'unsupported', message: 'a test op runs in a test frame' } });
    expect(s.ready?.caps).toContain('tcap');
    expect(s.ready?.caps).toContain('hostKeys');
  });
});

describe('a unit in the responder', () => {
  it('answers a pending op with the seam placeholder, and an op no one names unknown_op', async () => {
    const t = await boot([], { pending: { 'fpedit.open': 'fp-i1' } });
    expect(await t.ask(1, 'fpedit.open', {})).toEqual({ id: 1, ok: false, error: { code: 'unsupported', message: `${SEAM_PLACEHOLDER}: fpedit.open waits for unit fp-i1` } });
    expect(await t.ask(2, 'no.such')).toEqual({ id: 2, ok: false, error: { code: 'unknown_op', message: 'no.such' } });
  });

  it('runs a unit op on the request queue with the ctx, a throw answered island_error, extra keys bad_args', async () => {
    const seen: unknown[] = [];
    const t = await boot([{ unit: 'q-i', ops: {
      'q.echo': { run: (args, ctx) => { seen.push(ctx.has(['kicadOpenFileBusy']), ctx.ready(), ctx.root.length > 0); return ok({ args: args as Record<string, unknown> }); } },
      'q.boom': { run: () => { throw new Error('boom'); } },
    } }]);
    expect(await t.ask(1, 'q.echo', { a: 1 })).toEqual({ id: 1, ok: true, result: { args: { a: 1 } } });
    expect(seen).toEqual([true, true, true]);
    expect(await t.ask(2, 'q.boom')).toEqual({ id: 2, ok: false, error: { code: 'island_error', message: 'boom' } });
    t.port.postMessage({ id: 3, op: 'q.echo', extra: 1 });
    await settle();
    expect(t.got.find((m) => m.id === 3)).toEqual({ id: 3, ok: false, error: { code: 'bad_args', message: 'q.echo' } });
  });

  it('answers a now op as it arrives, while the queue is held', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => { release = r; });
    const t = await boot([{ unit: 'n-i', ops: {
      'n.slow': { run: async () => { await held; return ok({ slow: true }); } },
      'n.now': { now: true, run: () => ok({ now: true }) },
    } }]);
    t.port.postMessage({ id: 1, op: 'n.slow' });
    t.port.postMessage({ id: 2, op: 'n.now' });
    await settle();
    expect(t.got.filter((m) => 'id' in m)).toEqual([{ id: 2, ok: true, result: { now: true } }]);
    release();
    await settle();
    expect(t.got.find((m) => m.id === 1)).toEqual({ id: 1, ok: true, result: { slow: true } });
  });

  it('widens an op that ships from the unit file: its own answer for its own args, the op for the rest, hooks in unit order', async () => {
    const order: string[] = [];
    const t = await boot([
      { unit: 'w1-i', opsWidened: { 'view.fit': async (args, _ctx, next) => { order.push('w1'); return args != null && (args as { mine?: boolean }).mine === true ? ok({ widened: 'w1' }) : next(args); } } },
      { unit: 'w2-i', opsWidened: { 'view.fit': async (args, _ctx, next) => { order.push('w2'); return next(args); } } },
    ]);
    expect(await t.ask(1, 'view.fit', { mine: true })).toEqual({ id: 1, ok: true, result: { widened: 'w1' } });
    expect(order).toEqual(['w2', 'w1']);
    expect(await t.ask(2, 'view.fit', { other: 1 })).toEqual({ id: 2, ok: false, error: { code: 'bad_args', message: 'view.fit' } });
  });

  it('widens the runs answered off the chain (project.import) the same way', async () => {
    const t = await boot([{ unit: 'imp-i', opsWidened: { 'project.import': async (args, _ctx, next) => ((args as { format?: string } | undefined)?.format === 'unit' ? fail('import_failed', 'the unit answered') : next(args)) } }]);
    expect(await t.ask(1, 'project.import', { format: 'unit' })).toEqual({ id: 1, ok: false, error: { code: 'import_failed', message: 'the unit answered' } });
    expect((await t.ask(2, 'project.import', { nonsense: true }))?.ok).toBe(false);
  });

  it('lists only declared caps a unit finds, sends its events with exactly their keys, and refuses an event it never declared', async () => {
    let ctxOf: Parameters<NonNullable<ExtUnit['install']>>[0] | null = null;
    const stop = vi.fn();
    const t = await boot([{
      unit: 'ev-i', capNames: ['evCap'], caps: (mod) => (typeof mod.kicadEvThing === 'function' ? ['evCap', 'undeclared'] : []),
      events: { 'ev.thing': ['a', 'b'] },
      install: (ctx) => { ctxOf = ctx; return stop; },
    }], { exports: { kicadEvThing: () => 1 } });
    expect(t.ready?.caps).toContain('evCap');
    expect(t.ready?.caps).not.toContain('undeclared');
    expect(ctxOf).not.toBeNull();
    const ctx = ctxOf as unknown as NonNullable<Parameters<NonNullable<ExtUnit['install']>>[0]>;
    expect(ctx.caps()).toEqual(t.ready?.caps);
    ctx.emitExt('ev.thing', { a: 1, b: 'two', c: 3 });
    await settle();
    expect(t.got.at(-1)).toEqual({ type: 'ev.thing', a: 1, b: 'two' });
    expect(() => ctx.emitExt('ev.other', {})).toThrow();
    expect(() => ctx.emit({ type: 'ev.thing' })).toThrow();
    ctx.emit({ type: 'ev.held', action: 'x.y', extra: 1 });
    await settle();
    expect(t.got.at(-1)).toEqual({ type: 'ev.held', action: 'x.y' });
    await t.ask(9, 'shutdown');
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('holds a unit row in its frame under its cap, beside the built in rows', async () => {
    const t = await boot([{ unit: 'hr-i', held: ['eeschema.Unit.thing'], heldRows: [{ action: 'eeschema.Unit.thing', frames: ['sch'], cap: 'heldKeys' }] }], { exports: { kicadHostActions: () => true } });
    const slot = t.eng.win.kicadHostAction?.onRequest;
    expect(typeof slot).toBe('function');
    // No document is open: nothing reaches the host, so KiCad runs it.
    expect(slot?.(JSON.stringify({ action: 'eeschema.Unit.thing' }))).toBe(false);
  });
});
