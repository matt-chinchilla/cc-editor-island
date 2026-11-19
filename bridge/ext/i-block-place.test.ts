// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// i-block-place: block.place in a sch or pcb frame, every arg read closed, the
// files written under a fresh /tmp/cc-block/<n>/<name>.kicad_block/, the
// engine called exactly as it reads its args (the nickname only when given),
// one placement at a time, the contents joined to the place watch, a sheet's
// box kept by the unit and dropped by the next placement, and the op
// unsupported naming kicadDesignBlockPlace on an engine without it. The engine
// here is this test's own module of exports (at the protocol boundary); the
// real engine is the e2e's (tests/e2e/blocks-place.spec.ts, engine run 15).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startResponder } from '../responder';
import type { ExtUnit, ResponderCtx } from './contract';
import { buildRegistry, REGISTRY } from './registry';
import unit, {
  BLOCK_FILES_MAX, BLOCK_PLACE_EXPORTS, BLOCK_PLACE_ROOT, BLOCKS_CAP, blockFilePaths, blockPlace, engineCall, frameFileOf, isNickname, parseBlockPlaceArgs,
} from './i-block-place';

const PARENT = 'http://localhost';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));
const SCH_TEXT = '(kicad_sch (version 20250114) (generator "eeschema"))\n';
const PCB_TEXT = '(kicad_pcb (version 20250324) (generator "pcbnew"))\n';
const JSON_TEXT = '{"description":"LDO"}\n';
const LDO = (extra: Record<string, unknown> = {}) => ({
  name: 'LDO',
  files: [{ path: 'LDO.kicad_sch', text: SCH_TEXT }, { path: 'LDO.kicad_pcb', text: PCB_TEXT }, { path: 'LDO.json', text: JSON_TEXT }],
  asSheet: false,
  keepAnnotations: false,
  asGroup: true,
  ...extra,
});

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

interface FakeOpts {
  frame?: string;
  /** Plays kicadDesignBlockPlace: answers what the engine answers; may change the selection. */
  engine?: (a: Record<string, unknown>, sel: string[]) => unknown;
  missing?: string;
  noDocument?: boolean;
  busy?: boolean;
  cancel?: boolean;
  idle?: boolean;
}

/**
 * A ResponderCtx over a fake engine and a fake MEMFS: the run folders made and
 * dropped, the files written, the keys pressed and the place watch are recorded.
 */
function fakeCtx(opts: FakeOpts = {}) {
  const files = new Map<string, string>();
  const made: string[] = [];
  const dropped: string[] = [];
  const calls: Array<Record<string, unknown>> = [];
  const presses: string[] = [];
  const started: string[] = [];
  let canceled = 0;
  const order: string[] = [];
  let sel: string[] = ['old-1'];
  let depth = 3;
  let n = 0;
  const mod: Record<string, unknown> = {
    kicadCollabBusy: () => false,
    kicadCollabGetSelection: () => JSON.stringify(sel),
    kicadCollabTestUndoDepth: () => depth,
    kicadDesignBlockSave: () => false,
    kicadDesignBlockPlace: (json: string) => {
      const a = JSON.parse(json) as Record<string, unknown>;
      calls.push(a);
      order.push('engine');
      const said = (opts.engine ?? (() => { sel = [...sel, 'new-1']; return true; }))(a, sel);
      return said;
    },
  };
  if (opts.missing != null) delete mod[opts.missing];
  const ctx = {
    frame: opts.frame ?? 'pcb',
    root: '/project',
    timing: { placeMs: 120, placePollMs: 5 },
    win: () => ({}),
    mod: () => mod,
    fs: () => ({
      mkdirTree: (p: string) => { order.push(`mkdir ${p}`); },
      writeFile: (p: string, d: Uint8Array) => { files.set(p, new TextDecoder().decode(d)); },
    }),
    closed: () => false,
    hasDocument: () => opts.noDocument !== true,
    engineBusy: () => opts.busy === true,
    keysBlocked: () => false,
    placeCancel: async () => { canceled += 1; order.push('cancel'); return opts.cancel !== false; },
    placeStart: (uuid: string) => { started.push(uuid); },
    pressKey: (k: { key: string }) => { presses.push(k.key); },
    applyIdle: async () => opts.idle !== false,
    freshRunFolder: (root: string) => { n += 1; const d = `${root}/${n}`; made.push(d); order.push(`fresh ${d}`); return d; },
    dropRunFolder: (dir: string) => { dropped.push(dir); for (const k of [...files.keys()]) if (k.startsWith(`${dir}/`)) files.delete(k); },
    log: () => {},
  } as unknown as ResponderCtx;
  return {
    ctx, files, made, dropped, calls, presses, started, order,
    canceled: () => canceled,
    setSel: (s: string[]) => { sel = s; },
    setDepth: (d: number) => { depth = d; },
  };
}

describe('i-block-place in the registry', () => {
  it('loads in this checkout with nothing broken, owning block.place and the cap blocks, no longer a placeholder', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect(REGISTRY.ops.get('block.place')?.unit).toBe('i-block-place');
    expect(REGISTRY.pending.has('block.place')).toBe(false);
    expect((unit as ExtUnit).capNames).toEqual([BLOCKS_CAP]);
  });

  it('lists blocks in a sch or pcb frame only on an engine with the place and the save', () => {
    const caps = (unit as ExtUnit).caps!;
    const both = { kicadDesignBlockPlace: () => true, kicadDesignBlockSave: () => true };
    expect(caps(both, 'sch')).toEqual(['blocks']);
    expect(caps(both, 'pcb')).toEqual(['blocks']);
    expect(caps(both, 'symedit')).toEqual([]);
    expect(caps({ kicadDesignBlockSave: () => true }, 'pcb')).toEqual([]);
    expect(caps({ kicadDesignBlockPlace: () => true }, 'sch')).toEqual([]);
    expect(caps({}, 'sch')).toEqual([]);
  });
});

describe('the args, read closed', () => {
  it('takes a block with its files and the three options, and a nickname when given', () => {
    expect(parseBlockPlaceArgs(LDO())).toEqual(LDO());
    expect(parseBlockPlaceArgs(LDO({ nickname: 'blocks-small_blocks' }))).toEqual(LDO({ nickname: 'blocks-small_blocks' }));
    expect(parseBlockPlaceArgs({ ...LDO(), files: [{ path: 'LDO.kicad_sch', text: '' }] })?.files).toEqual([{ path: 'LDO.kicad_sch', text: '' }]);
  });

  it('refuses every other shape', () => {
    const bad: unknown[] = [
      null, [], 'LDO', {},
      { ...LDO(), more: 1 },
      (({ asGroup: _g, ...rest }) => rest)(LDO()),
      { ...LDO(), name: 'a/b' }, { ...LDO(), name: '' }, { ...LDO(), name: 'x'.repeat(121) }, { ...LDO(), name: 7 },
      { ...LDO(), asSheet: 'yes' }, { ...LDO(), keepAnnotations: 1 }, { ...LDO(), asGroup: null },
      { ...LDO(), files: [] }, { ...LDO(), files: 'x' },
      { ...LDO(), files: [{ path: 'LDO.kicad_sch', text: SCH_TEXT }, { path: 'LDO.kicad_sch', text: SCH_TEXT }] },
      { ...LDO(), files: [{ path: 'RC.kicad_sch', text: SCH_TEXT }] },
      { ...LDO(), files: [{ path: '../LDO.kicad_sch', text: SCH_TEXT }] },
      { ...LDO(), files: [{ path: 'LDO.kicad_sch', text: SCH_TEXT, more: 1 }] },
      { ...LDO(), files: [{ path: 'LDO.kicad_sch', text: new Uint8Array(1) }] },
      { ...LDO(), files: [{ path: 'LDO.kicad_sch', text: SCH_TEXT }, { path: 'LDO.kicad_pcb', text: PCB_TEXT }, { path: 'LDO.json', text: '' }, { path: 'LDO.kicad_sch', text: '' }] },
      LDO({ nickname: '' }), LDO({ nickname: 'a:b' }), LDO({ nickname: 'a\nb' }), LDO({ nickname: 'x'.repeat(121) }), LDO({ nickname: 3 }), LDO({ nickname: undefined }),
    ];
    for (const b of bad) expect(parseBlockPlaceArgs(b)).toBeNull();
  });

  it('a nickname of 1 to 120 characters, no colon or control character', () => {
    expect(isNickname('blocks-small_blocks')).toBe(true);
    expect(isNickname('x'.repeat(120))).toBe(true);
    expect(isNickname('é'.repeat(120))).toBe(true);
    expect(isNickname('x'.repeat(121))).toBe(false);
    expect(isNickname('a:b')).toBe(false);
    expect(isNickname('a\u0000')).toBe(false);
  });

  it('the files of a block and the file each frame places from', () => {
    expect(blockFilePaths('LDO')).toEqual(['LDO.kicad_sch', 'LDO.kicad_pcb', 'LDO.json']);
    expect(frameFileOf('sch', 'LDO')).toBe('LDO.kicad_sch');
    expect(frameFileOf('pcb', 'LDO')).toBe('LDO.kicad_pcb');
    expect(frameFileOf('symedit', 'LDO')).toBeNull();
  });

  it('the engine call: five keys, the nickname sixth only when given', () => {
    const a = parseBlockPlaceArgs(LDO())!;
    expect(engineCall('/tmp/cc-block/3', a)).toEqual({ dir: '/tmp/cc-block/3', name: 'LDO', asSheet: false, keepAnnotations: false, asGroup: true });
    const b = parseBlockPlaceArgs(LDO({ nickname: 'lib' }))!;
    expect(Object.keys(engineCall('/tmp/cc-block/3', b))).toEqual(['dir', 'name', 'asSheet', 'keepAnnotations', 'asGroup', 'nickname']);
  });
});

describe('block.place over the engine', () => {
  it('a layout: the files written under a fresh run folder, the engine called, the placement watched, the folder removed', async () => {
    const f = fakeCtx();
    expect(await blockPlace(LDO({ nickname: 'blocks-small_blocks' }), f.ctx)).toEqual({ ok: true, result: {} });
    expect(f.made).toEqual([`${BLOCK_PLACE_ROOT}/1`]);
    expect(f.calls).toEqual([{ dir: '/tmp/cc-block/1', name: 'LDO', asSheet: false, keepAnnotations: false, asGroup: true, nickname: 'blocks-small_blocks' }]);
    expect(f.started).toEqual(['new-1']);
    expect(f.dropped).toEqual(['/tmp/cc-block/1']);
    expect(f.order).toEqual(['cancel', 'fresh /tmp/cc-block/1', 'mkdir /tmp/cc-block/1/LDO.kicad_block', 'engine']);
  });

  it('every file reaches the block folder as given, letters past ASCII and a name with spaces included', async () => {
    let seen: string[] = [];
    const f = fakeCtx({ frame: 'sch' });
    f.ctx.fs = () => ({ mkdirTree: () => {}, writeFile: (p: string, d: Uint8Array) => { f.files.set(p, new TextDecoder().decode(d)); seen = [...f.files.keys()]; } }) as never;
    const name = 'ré gulateur';
    const args = { name, files: [{ path: `${name}.kicad_sch`, text: '(kicad_sch "Ω")' }, { path: `${name}.json`, text: '{}' }], asSheet: false, keepAnnotations: true, asGroup: false };
    expect(await blockPlace(args, f.ctx)).toEqual({ ok: true, result: {} });
    expect(seen).toEqual([`/tmp/cc-block/1/${name}.kicad_block/${name}.kicad_sch`, `/tmp/cc-block/1/${name}.kicad_block/${name}.json`]);
    expect(f.calls[0]).toEqual({ dir: '/tmp/cc-block/1', name, asSheet: false, keepAnnotations: true, asGroup: false });
  });

  it('a schematic block placed as its contents is watched as a place is', async () => {
    const f = fakeCtx({ frame: 'sch' });
    expect(await blockPlace(LDO(), f.ctx)).toEqual({ ok: true, result: {} });
    expect(f.started).toEqual(['new-1']);
    expect(f.dropped).toEqual(['/tmp/cc-block/1']);
  });

  it('a schematic block placed as a sheet: answered once the apply queue ran, the folder kept for the press, no place watch', async () => {
    const f = fakeCtx({ frame: 'sch', engine: () => true });
    expect(await blockPlace(LDO({ asSheet: true }), f.ctx)).toEqual({ ok: true, result: {} });
    expect(f.started).toEqual([]);
    expect(f.dropped).toEqual([]);
    expect([...f.files.keys()]).toContain('/tmp/cc-block/1/LDO.kicad_block/LDO.kicad_sch');
  });

  it('the next placement drops a sheet box still hanging (two Escapes) and its fresh folder clears the old one', async () => {
    const f = fakeCtx({ frame: 'sch', engine: () => true });
    expect(await blockPlace(LDO({ asSheet: true }), f.ctx)).toEqual({ ok: true, result: {} });
    expect(f.presses).toEqual([]);
    expect(await blockPlace(LDO({ asSheet: true }), f.ctx)).toEqual({ ok: true, result: {} });
    expect(f.presses).toEqual(['Escape', 'Escape']);
    expect(f.made).toEqual(['/tmp/cc-block/1', '/tmp/cc-block/2']);
  });

  it('a sheet box whose press committed (the undo depth moved) is left alone', async () => {
    const f = fakeCtx({ frame: 'sch', engine: () => true });
    expect(await blockPlace(LDO({ asSheet: true }), f.ctx)).toEqual({ ok: true, result: {} });
    f.setDepth(4);
    expect(await blockPlace(LDO({ asSheet: true }), f.ctx)).toEqual({ ok: true, result: {} });
    expect(f.presses).toEqual([]);
  });

  it('a sheet whose apply queue never runs answers not_applied', async () => {
    const f = fakeCtx({ frame: 'sch', engine: () => true, idle: false });
    expect(await blockPlace(LDO({ asSheet: true }), f.ctx)).toMatchObject({ ok: false, code: 'not_applied' });
  });

  it('asSheet in a pcb frame places the layout as contents', async () => {
    const f = fakeCtx({ frame: 'pcb' });
    expect(await blockPlace(LDO({ asSheet: true }), f.ctx)).toEqual({ ok: true, result: {} });
    expect(f.started).toEqual(['new-1']);
  });

  it('one at a time: the item still hanging is dropped first, busy when it would not go, nothing written', async () => {
    const ok1 = fakeCtx();
    await blockPlace(LDO(), ok1.ctx);
    expect(ok1.canceled()).toBe(1);
    const f = fakeCtx({ cancel: false });
    expect(await blockPlace(LDO(), f.ctx)).toEqual({ ok: false, code: 'busy', message: 'the previous item still hangs off the pointer' });
    expect(f.made).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it('the engine refusing the block answers not_applied, a throw island_error; the folder removed', async () => {
    const f = fakeCtx({ engine: () => false });
    expect(await blockPlace(LDO(), f.ctx)).toEqual({ ok: false, code: 'not_applied', message: 'block.place: KiCad did not take the block' });
    expect(f.dropped).toEqual(['/tmp/cc-block/1']);
    const g = fakeCtx({ engine: () => { throw new Error('boom'); } });
    expect(await blockPlace(LDO(), g.ctx)).toEqual({ ok: false, code: 'island_error', message: 'boom' });
    expect(g.dropped).toEqual(['/tmp/cc-block/1']);
    expect(g.started).toEqual([]);
  });

  it('a block the editor never takes answers busy, the folder removed, nothing watched', async () => {
    const f = fakeCtx({ engine: () => true });
    expect(await blockPlace(LDO(), f.ctx)).toEqual({ ok: false, code: 'busy', message: 'block.place: the editor did not take the block' });
    expect(f.dropped).toEqual(['/tmp/cc-block/1']);
    expect(f.started).toEqual([]);
  });

  it('checks in order: the args, the size, the frame, the frame\'s file, the engine, a document, busy; nothing written before', async () => {
    const at = (o: FakeOpts) => fakeCtx(o);
    let f = at({});
    expect(await blockPlace({ ...LDO(), name: 'a:b' }, f.ctx)).toEqual({ ok: false, code: 'bad_args', message: 'block.place' });
    f = at({ frame: 'symedit' });
    const huge = { ...LDO(), files: [{ path: 'LDO.kicad_pcb', text: 'x'.repeat(BLOCK_FILES_MAX + 1) }] };
    expect(await blockPlace(huge, f.ctx)).toEqual({ ok: false, code: 'too_large', message: 'block.place' });
    expect(await blockPlace(LDO(), f.ctx)).toEqual({ ok: false, code: 'unsupported', message: 'a design block is placed in a sch or pcb frame' });
    f = at({ frame: 'pcb', missing: 'kicadDesignBlockPlace' });
    const rc = { name: 'RC', files: [{ path: 'RC.kicad_sch', text: SCH_TEXT }], asSheet: false, keepAnnotations: false, asGroup: false };
    expect(await blockPlace(rc, f.ctx)).toEqual({ ok: false, code: 'bad_args', message: 'block.place: a block placed in a pcb frame needs RC.kicad_pcb' });
    expect(await blockPlace(LDO(), f.ctx)).toEqual({ ok: false, code: 'unsupported', message: 'kicadDesignBlockPlace' });
    f = at({ noDocument: true });
    expect(await blockPlace(LDO(), f.ctx)).toEqual({ ok: false, code: 'not_ready', message: 'block.place' });
    f = at({ busy: true });
    expect(await blockPlace(LDO(), f.ctx)).toEqual({ ok: false, code: 'busy', message: 'block.place' });
    expect(f.made).toEqual([]);
    expect(f.canceled()).toBe(0);
  });

  it('an engine without kicadDesignBlockPlace (run 14) answers unsupported naming it', async () => {
    const f = fakeCtx({ missing: 'kicadDesignBlockPlace' });
    expect(await blockPlace(LDO(), f.ctx)).toEqual({ ok: false, code: 'unsupported', message: 'kicadDesignBlockPlace' });
    expect(BLOCK_PLACE_EXPORTS[0]).toBe('kicadDesignBlockPlace');
  });
});

describe('block.place through the responder', () => {
  it('on an engine without the export: bad_args first, then unsupported naming kicadDesignBlockPlace, and no cap blocks', async () => {
    const { ask, ready } = await boot('sch', { kicadCollabBusy: () => false, kicadCollabGetSelection: () => '[]' });
    expect(ready?.caps ?? []).not.toContain('blocks');
    expect(await ask(1, 'block.place', { ...LDO(), name: 'a:b' })).toMatchObject({ id: 1, ok: false, error: { code: 'bad_args', message: 'block.place' } });
    expect(await ask(2, 'block.place', LDO())).toMatchObject({ id: 2, ok: false, error: { code: 'unsupported', message: 'kicadDesignBlockPlace' } });
  });

  it('on an engine with the place and the save: blocks in ev.ready, and no document answers not_ready', async () => {
    const { ask, ready } = await boot('pcb', { kicadCollabBusy: () => false, kicadCollabGetSelection: () => '[]', kicadDesignBlockPlace: () => true, kicadDesignBlockSave: () => true });
    expect(ready?.caps ?? []).toContain('blocks');
    expect(await ask(1, 'block.place', LDO())).toMatchObject({ id: 1, ok: false, error: { code: 'not_ready', message: 'block.place' } });
  });

  it('in another frame: unsupported with the unit\'s frame refusal', async () => {
    const { ask } = await boot('symedit', { kicadCollabBusy: () => false, kicadDesignBlockPlace: () => false });
    const r = await ask(1, 'block.place', LDO());
    expect(r).toMatchObject({ id: 1, ok: false, error: { code: 'unsupported', message: 'a design block is placed in a sch or pcb frame' } });
  });
});
