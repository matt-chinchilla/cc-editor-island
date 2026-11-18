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
import { bootFrame, documentExtension, frameForToolName, framePickKind, frameToken, frameTool, hostToolFor, ownDocument, unitsPerMm } from '../../src/frames';
import { parseSettingsGetArgs, parseSettingsSetArgs, sectionFrames } from '../settings';
import { kindOf, pickFor } from '../../src/picker';
import type { ResponderCtx } from './contract';

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
async function boot(units: ExtUnit[], opts: { frame?: string; exports?: Record<string, unknown>; pending?: Record<string, string>; pendingFrames?: Record<string, string> } = {}) {
  const reg = buildRegistry(mods(...units), opts.pending ?? {}, opts.pendingFrames ?? {});
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

  it('boots a unit frame: its refusals, its built in caps alone and every unit cap its unit finds there, its unit ops only there', async () => {
    const unit: ExtUnit = { ...tf, frames: ['tframe' as never], frameRefusal: 'a test op runs in a test frame', ops: { 't.op': { run: (_a, ctx) => ok({ frame: ctx.frame }) } }, capNames: ['tcap', 'tother'], caps: () => ['tcap', 'tother'] };
    const t = await boot([unit], { frame: 'tframe', exports: { kicadThing: () => 1, kicadHostActions: () => true } });
    // The descriptor's caps list governs the built in pseudo-caps; a unit's own caps are its caps(mod, frame) answer (tother too).
    expect(t.ready?.caps).toEqual(['kicadHostActions', 'kicadOpenFileBusy', 'kicadThing', 'tcap', 'tother', 'write']);
    expect(await t.ask(1, 'project.open', { name: 'x', files: [] })).toEqual({ id: 1, ok: false, error: { code: 'unsupported', message: 'a test frame opens no documents' } });
    expect(await t.ask(2, 't.op')).toEqual({ id: 2, ok: true, result: { frame: 'tframe' } });
    const s = await boot([unit]);
    expect(await s.ask(3, 't.op')).toEqual({ id: 3, ok: false, error: { code: 'unsupported', message: 'a test op runs in a test frame' } });
    expect(s.ready?.caps).toContain('tcap');
    expect(s.ready?.caps).toContain('hostKeys');
  });
});

describe('a unit frame refuses the ops answered off the queue too', () => {
  const OFF_QUEUE = ['lib.index', 'lib.item', 'lib.prefetch', 'keys.claim', 'sim.stop', 'sim.release'];
  const offf: ExtUnit = {
    unit: 'off-i',
    defineFrames: {
      offframe: {
        token: 'offframe', tool: { name: 'tool_off', bundle: 'kicad_editor', argv0: '/usr/bin/tool_off', needsConfigSeed: true, libKind: null },
        document: null, extension: '.kicad_wks', unitsPerMm: 1e3, pickKind: 'symbol', picker: false,
        refuses: OFF_QUEUE, refusal: 'an off frame refuses these',
      },
    },
  };
  it('answers the library reads, keys.claim, sim.stop and sim.release with the frame\'s refusal, before their args are read', async () => {
    const t = await boot([offf], { frame: 'offframe', exports: { kicadHostActions: () => true } });
    let id = 1;
    for (const op of OFF_QUEUE) {
      expect(await t.ask(id, op, { not: 'its args' }), op).toEqual({ id, ok: false, error: { code: 'unsupported', message: 'an off frame refuses these' } });
      id += 1;
    }
    // The closed key check still comes first.
    t.port.postMessage({ id: 99, op: 'lib.index', extra: 1 });
    await settle();
    expect(t.got.find((m) => m.id === 99)).toEqual({ id: 99, ok: false, error: { code: 'bad_args', message: 'lib.index' } });
  });

  it('leaves them as they ship in a built in frame', async () => {
    const t = await boot([offf]);
    expect(await t.ask(1, 'lib.index', { not: 'its args' })).toMatchObject({ id: 1, ok: false, error: { code: 'bad_args' } });
    expect(await t.ask(2, 'keys.claim', { chords: [] })).toEqual({ id: 2, ok: true, result: { claimed: 0, refused: [] } });
  });
});

describe('a unit tool\'s appearance seed', () => {
  const kind = (appearanceFiles: unknown, needsConfigSeed = true): ExtUnit => ({
    unit: 'ap-i',
    defineFrames: {
      apframe: {
        token: 'apframe', tool: { name: 'tool_ap', bundle: 'kicad_editor', argv0: '/usr/bin/tool_ap', needsConfigSeed, libKind: null, appearanceFiles: appearanceFiles as readonly string[] },
        document: null, extension: '.kicad_wks', unitsPerMm: 1e3, pickKind: 'symbol', picker: false, refuses: [], refusal: 'no',
      },
    },
  });
  it('takes settings file names of the tool\'s own, and refuses a path, a file seeded already, or a tool that seeds nothing', () => {
    expect(buildRegistry(mods(kind(['pl_editor.json']))).problems).toEqual([]);
    for (const bad of [['../x.json'], ['eeschema.json'], ['kicad_common.json'], 'pl_editor.json', ['pl_editor']]) {
      expect(buildRegistry(mods(kind(bad))).problems, String(bad)).toEqual(["ap-i: frame 'apframe': appearanceFiles"]);
    }
    expect(buildRegistry(mods(kind(['pl_editor.json'], false))).problems).toEqual(["ap-i: frame 'apframe': appearanceFiles"]);
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

describe('the seam join fixes', () => {
  it('names a pending frame in frames and held rows before its unit lands; the frame never matches until then', async () => {
    const unit: ExtUnit = { unit: 'm-i', frames: ['sch', 'fpedit'], ops: { 'm.op': { run: () => ok() } }, held: ['common.Control.foo'], heldRows: [{ action: 'common.Control.foo', frames: ['fpedit'], cap: 'mcap' }] };
    const reg = buildRegistry(mods(unit), {}, { fpedit: 'fp-i1', ds: 'ds-i1' });
    expect(reg.problems).toEqual([]);
    expect([...reg.pendingFrames.keys()]).toEqual(['fpedit', 'ds']);
    expect(reg.ops.get('m.op')?.frames).toEqual(['sch', 'fpedit']);
    expect(bootFrame('fpedit', reg)).toBe('sch');
    // Without the pending name the same unit breaks the rule.
    expect(buildRegistry(mods(unit)).problems).toContain('m-i: frames names a frame no one defines');
    // A landed frame takes the name off the pending list.
    const fp: ExtUnit = { unit: 'fp-i1', defineFrames: { fpedit: { token: 'fpedit', tool: 'pcbnew', document: null, extension: '.kicad_mod', unitsPerMm: 1e6, pickKind: 'footprint', picker: true, refuses: [], refusal: 'x' } } };
    const both = buildRegistry(mods(unit, fp), {}, { fpedit: 'fp-i1' });
    expect(both.problems).toEqual([]);
    expect([...both.pendingFrames.keys()]).toEqual([]);
    expect(framePickKind('fpedit' as never, both)).toBe('footprint');
    expect(framePickKind('pcb', both)).toBeNull();
    expect(kindOf('fpedit' as never, framePickKind('fpedit' as never, both))).toBe('footprint');
    expect(pickFor('fpedit' as never, { key: 'a' }, 'footprint')).toEqual({ kind: 'footprint' });
    const t = await boot([unit], { pendingFrames: { fpedit: 'fp-i1' } });
    expect(await t.ask(1, 'm.op')).toEqual({ id: 1, ok: true, result: {} });
  });

  it('runs a unit export job through project.export (never bad_args), with the hooks heard', async () => {
    const unit: ExtUnit = { unit: 'x3-i', exportJobs: { pcb_render: 'pcb' }, exportHooks: { msFor: (job) => (job === 'pcb_render' ? 600_000 : null) } };
    const t = await boot([unit], { frame: 'pcb' });
    // The engine has no kicadExportBoardOutput here: the job got past the parse to the export check.
    expect(await t.ask(1, 'project.export', { job: 'pcb_render', settings: {} })).toEqual({ id: 1, ok: false, error: { code: 'unsupported', message: 'kicadExportBoardOutput' } });
    expect(await t.ask(2, 'project.export', { job: 'pcb_nothing', settings: {} })).toEqual({ id: 2, ok: false, error: { code: 'bad_args', message: 'project.export' } });
    const s = await boot([unit], { frame: 'sch' });
    expect(await s.ask(3, 'project.export', { job: 'pcb_render', settings: {} })).toEqual({ id: 3, ok: false, error: { code: 'unsupported', message: 'a board output runs in a pcb frame' } });
    expect(buildRegistry(mods({ unit: 'bad-i', exportHooks: { msFor: 3 as never } })).problems).toEqual(['bad-i: exportHooks must be functions msFor, before, tick, after']);
  });

  it('widens sim.stop and sim.release off the queue, and drops a built in event a unit guard refuses', async () => {
    let ctxSeen: ResponderCtx | null = null;
    const unit: ExtUnit = {
      unit: 'se-i',
      opsWidened: { 'sim.stop': async (args, _ctx, next) => (args === 'mine' ? ok({ hooked: true }) : next(args)) },
      eventGuards: { 'ev.held': (ev) => ev.action !== 'drop.this.one' },
      install: (ctx) => { ctxSeen = ctx; },
    };
    const t = await boot([unit]);
    expect(await t.ask(1, 'sim.stop', 'mine')).toEqual({ id: 1, ok: true, result: { hooked: true } });
    // The op's own answer for the rest (no simulator exports here).
    expect((await t.ask(2, 'sim.stop'))?.ok).toBe(false);
    const ctx = ctxSeen as unknown as ResponderCtx;
    expect(ctx.simRun()).toBeNull();
    ctx.emit({ type: 'ev.held', action: 'keep.this.one' });
    ctx.emit({ type: 'ev.held', action: 'drop.this.one' });
    await settle();
    expect(t.got.filter((m) => m.type === 'ev.held').map((m) => m.action)).toEqual(['keep.this.one']);
    expect(buildRegistry(mods({ unit: 'bad-i', eventGuards: { 'ev.nothing': () => true } })).problems).toEqual(["bad-i: eventGuards 'ev.nothing' is no built in event"]);
  });

  it('gives a unit the held union, the ask readers, the place watch and the menu hold through ctx', async () => {
    let ctxSeen: ResponderCtx | null = null;
    const reader = (r: unknown) => (typeof r === 'object' && r !== null && Object.keys(r).join() === 'x' ? (r as Record<string, unknown>) : null);
    const a: ExtUnit = { unit: 'ask-i', asks: ['vertex'], askReaders: { vertex: reader } };
    const b: ExtUnit = { unit: 'use-i', held: ['pcbnew.Foo.bar'], heldRows: [{ action: 'pcbnew.Foo.bar', frames: ['pcb'], cap: 'foo' }], install: (ctx) => { ctxSeen = ctx; } };
    const t = await boot([a, b]);
    const ctx = ctxSeen as unknown as ResponderCtx;
    expect(ctx.heldRows()).toEqual(heldActions(t.reg));
    expect(ctx.heldRows().at(-1)).toEqual({ action: 'pcbnew.Foo.bar', frames: ['pcb'], cap: 'foo' });
    expect(ctx.readAsk('vertex', { x: 1 })).toEqual({ x: 1 });
    expect(ctx.readAsk('vertex', { y: 1 })).toBeNull();
    expect(ctx.readAsk('nobody', { x: 1 })).toBeNull();
    expect(ctx.placeHanging()).toBe(false);
    expect(await ctx.placeCancel()).toBe(true);
    ctx.holdMenus(true);
    ctx.holdMenus(false);
    expect(buildRegistry(mods({ unit: 'bad-i', askReaders: { vertex: reader } })).problems).toEqual(["bad-i: askReaders 'vertex' is no ask the unit declares"]);
  });

  it('takes a unit settings section in settings.get and settings.set, in its frames only', async () => {
    const unit: ExtUnit = { unit: 'st-i', settingsSections: { router: { frames: ['pcb'], check: (v) => typeof v.mode === 'string' }, annotation: { frames: ['sch'], projectFile: true } } };
    const reg = buildRegistry(mods(unit));
    expect(reg.problems).toEqual([]);
    expect(sectionFrames('router', reg.settingsSections)).toEqual(['pcb']);
    expect(sectionFrames('router')).toEqual([]);
    expect(parseSettingsGetArgs({ section: 'router' })).toBeNull();
    expect(parseSettingsGetArgs({ section: 'router' }, reg.settingsSections)).toEqual({ section: 'router' });
    expect(parseSettingsSetArgs({ section: 'router', value: { mode: 'walk' } }, reg.settingsSections)).toEqual({ section: 'router', value: { mode: 'walk' } });
    expect(parseSettingsSetArgs({ section: 'router', value: { mode: 3 } }, reg.settingsSections)).toBeNull();
    expect(parseSettingsSetArgs({ section: 'annotation', value: { a: null } }, reg.settingsSections)).toBeNull();
    const t = await boot([unit], { exports: { kicadSettingsGet: () => '{}' } });
    expect(await t.ask(1, 'settings.get', { section: 'router' })).toEqual({ id: 1, ok: false, error: { code: 'unsupported', message: 'router is a board setting' } });
    expect(buildRegistry(mods({ unit: 'bad-i', settingsSections: { page: { frames: ['sch'] } } })).problems).toEqual(["bad-i: settings section 'page' is no new section"]);
  });

  it('sends a host tool that boots no frame as ev.openTool with its host name', () => {
    const reg = buildRegistry(mods({ unit: 'calc-i', hostTools: { pcb_calculator: 'calculator' } }));
    expect(reg.problems).toEqual([]);
    expect(hostToolFor('/bin/pcb_calculator.exe', reg)).toBe('calculator');
    expect(frameForToolName('pcb_calculator', reg)).toBeNull();
    expect(hostToolFor('pcbnew', reg)).toBeNull();
    expect(buildRegistry(mods({ unit: 'bad-i', hostTools: { pcbnew: 'calculator', x_tool: 'pcb' } })).problems).toEqual([
      "bad-i: host tool 'pcbnew' is no new tool name",
      "bad-i: host tool 'x_tool' needs a host name that is no frame",
    ]);
  });
});

// The default run's include, read from vite.config.ts as text (the config imports
// node modules the type check does not know), and every test file of the checkout.
const viteConfigText = Object.values(import.meta.glob('../../vite.config.ts', { query: '?raw', import: 'default', eager: true }))[0] as string;
const testFiles = Object.keys(import.meta.glob(['/**/*.test.ts', '!/**/node_modules/**', '!/dist/**'])).map((f) => f.slice(1));
const globRe = (g: string) => new RegExp('^' + g.split('**/').map((p) => p.split('*').map((q) => q.replace(/[.+?^$|()[\]{}\\]/g, '\\$&')).join('[^/]*')).join('(?:.*/)?') + '$');

describe('the default test run', () => {
  it('takes every test file of the checkout, wherever the manifest put it, but the join test', () => {
    const list = /include:\s*\[([^\]]*)\]/.exec(viteConfigText)?.[1] ?? '';
    const include = [...list.matchAll(/'([^']+)'/g)].map((m) => globRe(m[1]));
    const inRun = (f: string) => include.some((re) => re.test(f));
    expect(testFiles.filter((f) => !inRun(f))).toEqual(['scripts/ext/join.test.ts']);
    for (const f of ['loader/src/wasm/libs/model-store.test.ts', 'scripts/build-models.test.ts', 'bridge/ext/3d-i3/export.test.ts', 'src/new-files.test.ts']) expect(inRun(f)).toBe(true);
    expect(inRun('scripts/ext/join.test.ts')).toBe(false);
  });
});
