// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// fp-i5: graphics.import, its cap feature detected on the engine's exports in
// each of the four frames, its args, the drawing's kind by content and the
// engine's answer read closed, and KiCad's Import Graphics held in a pcb and a
// sch frame. The engine here is this test's own module of exports (at the
// protocol boundary); the real engine is the e2e's
// (tests/e2e/graphics-import.spec.ts, engine run 15).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startResponder } from '../responder';
import { heldTaken } from '../held';
import { FPEDIT_EXPORTS } from '../fpedit/common';
import { SYMEDIT_EXPORTS } from '../symedit';
import type { Answer, ExtUnit, ResponderCtx } from './contract';
import { buildRegistry, heldActions, REGISTRY } from './registry';
import unit, {
  DRAWING_MAX_BYTES, DRAWING_ROOT, drawingFileName, drawingKind, HELD_BOARD, HELD_SCHEMATIC, IMPORT_CAP, IMPORT_FRAME_ONLY, NOTHING_READ,
  parseImportArgs, readImported,
} from './fp-i5';

const PARENT = 'http://localhost';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));
const FIXTURES = import.meta.glob(['../../tests/fixtures/drawings/*.dxf', '../../tests/fixtures/drawings/*.svg'], { query: '?raw', import: 'default', eager: true });
const fixture = (name: string): Uint8Array => new TextEncoder().encode(String(FIXTURES[`../../tests/fixtures/drawings/${name}`]));
const bytesOf = (s: string): Uint8Array => new TextEncoder().encode(s);

const DXF = fixture('outline.dxf');
const SVG = fixture('logo.svg');
const A = 'f0075000-0000-4000-8000-000000000001';
const B = 'f0075000-0000-4000-8000-000000000002';
const fns = (names: readonly string[]): Record<string, unknown> => Object.fromEntries(names.map((n) => [n, () => '']));
const RUN15_DOC = fns(['kicadImportGraphics', 'kicadCollabBusy']);

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
  const reg = buildRegistry(mods(unit), {}, { fpedit: 'fp-i1' });
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
    wxElementRegistry: { findAll: () => [{ id: 'frame', typeName: 'PCB_EDIT_FRAME', name: 'PcbFrame', visible: true }], findByLabel: () => [] },
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

/** A ResponderCtx over a fake engine: the import's calls, the files written and dropped, the place watch joined. */
function fakeCtx(opts: { frame?: string; answer?: (json: string) => string; idle?: boolean; mod?: Record<string, unknown>; gate?: Answer } = {}) {
  const files = new Map<string, Uint8Array>();
  const dropped: string[] = [];
  const calls: Array<Record<string, unknown>> = [];
  const placed: string[] = [];
  const mod: Record<string, unknown> = opts.mod ?? {
    kicadCollabBusy: () => false,
    kicadImportGraphics: (json: string) => {
      const a = JSON.parse(json) as Record<string, unknown>;
      calls.push({ ...a, there: files.has(a.path as string) });
      return opts.answer == null ? JSON.stringify({ items: 2, uuids: [A, B], warnings: [] }) : opts.answer(json);
    },
  };
  const gate = (_op: string, exports: readonly string[]) => {
    if (opts.gate != null) return opts.gate;
    for (const name of exports) if (typeof mod[name] !== 'function') return { ok: false, code: 'unsupported', message: name };
    return { w: {}, mod };
  };
  const ctx = {
    frame: opts.frame ?? 'pcb',
    root: '/project',
    timing: { symeditMs: 50, applyPollMs: 5 },
    win: () => ({}),
    mod: () => mod,
    fs: () => ({ writeFile: (p: string, b: Uint8Array) => { files.set(p, b); } }),
    closed: () => false,
    engineBusy: () => false,
    keysBlocked: () => false,
    boardGate: gate,
    schematicGate: gate,
    applyIdle: async () => opts.idle ?? true,
    freshRunFolder: (root: string) => `${root}/7`,
    dropRunFolder: (dir: string) => { dropped.push(dir); },
    placeStart: (uuid: string) => { placed.push(uuid); },
    log: () => {},
  } as unknown as ResponderCtx;
  return { ctx, files, dropped, calls, placed };
}

describe('fp-i5 in the registry', () => {
  it('loads in this checkout with nothing broken, owning graphics.import, importGraphics and its two held rows', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect(REGISTRY.ops.get('graphics.import')?.unit).toBe('fp-i5');
    expect(REGISTRY.pending.has('graphics.import')).toBe(false);
    expect(REGISTRY.capNames.get(IMPORT_CAP)).toBe('fp-i5');
    const rows = heldActions();
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: HELD_BOARD, frames: ['pcb'], cap: IMPORT_CAP }),
      expect.objectContaining({ action: HELD_SCHEMATIC, frames: ['sch'], cap: IMPORT_CAP }),
    ]));
  });

  it('holds Ctrl+Shift+F in a pcb and a sch frame only under importGraphics; the symbol editor keeps its own row', () => {
    const rows = heldActions();
    expect(heldTaken(HELD_BOARD, 'pcb', [IMPORT_CAP], rows)).toBe(true);
    expect(heldTaken(HELD_BOARD, 'pcb', [], rows)).toBe(false);
    expect(heldTaken(HELD_SCHEMATIC, 'sch', [IMPORT_CAP], rows)).toBe(true);
    expect(heldTaken(HELD_SCHEMATIC, 'sch', ['heldKeys'], rows)).toBe(false);
    expect(heldTaken(HELD_SCHEMATIC, 'symedit', ['symedit'], rows)).toBe(true);
    expect(heldTaken(HELD_BOARD, 'sch', [IMPORT_CAP], rows)).toBe(false);
  });

  it('lists importGraphics from the engine\'s exports in each of the four frames, never on run 14 or in a ds frame', () => {
    const caps = unit.caps;
    expect(caps(RUN15_DOC, 'pcb')).toEqual([IMPORT_CAP]);
    expect(caps(RUN15_DOC, 'sch')).toEqual([IMPORT_CAP]);
    expect(caps(RUN15_DOC, 'symedit')).toEqual([]);
    expect(caps({ ...RUN15_DOC, ...fns(SYMEDIT_EXPORTS) }, 'symedit')).toEqual([IMPORT_CAP]);
    expect(caps(RUN15_DOC, 'fpedit' as never)).toEqual([]);
    expect(caps({ ...RUN15_DOC, ...fns(FPEDIT_EXPORTS) }, 'fpedit' as never)).toEqual([IMPORT_CAP]);
    expect(caps({ ...RUN15_DOC, ...fns(FPEDIT_EXPORTS) }, 'ds' as never)).toEqual([]);
    expect(caps(fns(['kicadCollabBusy', ...SYMEDIT_EXPORTS, ...FPEDIT_EXPORTS]), 'pcb')).toEqual([]);
    expect(caps({}, 'sch')).toEqual([]);
  });

  it('a pcb and a sch frame on run 14 list no importGraphics and answer graphics.import unsupported naming kicadImportGraphics', async () => {
    for (const frame of ['pcb', 'sch']) {
      const s = await boot(frame, { kicadCollabBusy: () => false });
      expect(s.ready?.caps, frame).not.toContain(IMPORT_CAP);
      expect(await s.ask(1, 'graphics.import', { name: 'outline.dxf', bytes: DXF, place: 'at' })).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'kicadImportGraphics' } });
      expect(await s.ask(2, 'graphics.import', { name: 'outline.dxf', bytes: DXF })).toMatchObject({ ok: false, error: { code: 'bad_args', message: 'graphics.import' } });
    }
  });

  it('a pcb frame on run 15 lists importGraphics and, with no board open, answers not_ready', async () => {
    const s = await boot('pcb', RUN15_DOC);
    expect(s.ready?.caps).toContain(IMPORT_CAP);
    expect(await s.ask(1, 'graphics.import', { name: 'outline.dxf', bytes: DXF, place: 'at' })).toMatchObject({ ok: false, error: { code: 'not_ready', message: 'graphics.import' } });
  });
});

describe('graphics.import args', () => {
  const base = { name: 'outline.dxf', bytes: DXF, place: 'at' };
  it('takes the closed shape and hands the engine every optional key as given', () => {
    expect(parseImportArgs(base)).toEqual({ name: 'outline.dxf', bytes: DXF, engine: { place: 'at' } });
    const all = { ...base, place: 'pointer', layer: 'Dwgs.User', scale: 2, origin: [50, -50], lineWidth: 0.2, dxfUnits: 'mm', group: true, fixDiscontinuities: true, tolerance: 0.5 };
    expect(parseImportArgs(all)?.engine).toEqual({ place: 'pointer', layer: 'Dwgs.User', scale: 2, origin: [50, -50], lineWidth: 0.2, dxfUnits: 'mm', group: true, fixDiscontinuities: true, tolerance: 0.5 });
    expect(parseImportArgs({ ...base, lineWidth: null })?.engine).toEqual({ place: 'at', lineWidth: null });
    expect(parseImportArgs({ ...base, layer: 'In1.Cu' })?.engine.layer).toBe('In1.Cu');
  });
  it('refuses any other key, a missing or wrong place, a bad name, empty or oversized bytes, and every number out of bounds', () => {
    const bad: unknown[] = [
      null, [], {}, { ...base, path: '/tmp/x.dxf' }, { name: 'a.dxf', bytes: DXF }, { ...base, place: 'here' },
      { ...base, name: '' }, { ...base, name: '../a.dxf' }, { ...base, name: 'a\\b.dxf' }, { ...base, name: 'a\nb.dxf' }, { ...base, name: 'x'.repeat(256) },
      { ...base, bytes: new Uint8Array(0) }, { ...base, bytes: [1, 2] }, { ...base, bytes: 'text' },
      { ...base, layer: '' }, { ...base, layer: 'F Cu' }, { ...base, layer: 3 },
      { ...base, scale: 0 }, { ...base, scale: -1 }, { ...base, scale: Infinity }, { ...base, scale: 10_001 },
      { ...base, origin: [1] }, { ...base, origin: [1, 2, 3] }, { ...base, origin: [1, NaN] }, { ...base, origin: [2_001, 0] }, { ...base, origin: { x: 1, y: 2 } },
      { ...base, lineWidth: 0 }, { ...base, lineWidth: -0.1 }, { ...base, lineWidth: 101 }, { ...base, lineWidth: '0.2' },
      { ...base, dxfUnits: 'in' }, { ...base, group: 1 }, { ...base, fixDiscontinuities: 'yes' }, { ...base, tolerance: -1 }, { ...base, tolerance: 101 },
    ];
    for (const a of bad) expect(parseImportArgs(a), JSON.stringify(a, (_k, v) => (v instanceof Uint8Array ? `bytes(${v.length})` : v))).toBeNull();
  });
  it('takes 25 MB and not a byte more', () => {
    const big = new Uint8Array(DRAWING_MAX_BYTES);
    expect(parseImportArgs({ ...base, bytes: big })).not.toBeNull();
    expect(parseImportArgs({ ...base, bytes: new Uint8Array(DRAWING_MAX_BYTES + 1) })).toBeNull();
  });
});

describe('the drawing\'s kind, by content', () => {
  it('reads the two fixtures', () => {
    expect(drawingKind(DXF)).toBe('dxf');
    expect(drawingKind(SVG)).toBe('svg');
  });
  it('takes a DXF past comments and blank lines, and an SVG past a BOM, comments, a doctype with an internal subset and processing instructions', () => {
    expect(drawingKind(bytesOf('\n999\nmade by hand\n  0\nSECTION\n  2\nENTITIES\n'))).toBe('dxf');
    expect(drawingKind(bytesOf('0\r\nSECTION\r\n'))).toBe('dxf');
    expect(drawingKind(new Uint8Array([0xef, 0xbb, 0xbf, ...bytesOf('<svg xmlns="http://www.w3.org/2000/svg"/>')]))).toBe('svg');
    expect(drawingKind(bytesOf('<?xml version="1.0"?>\n<!-- a comment -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd" [ <!ENTITY a "b"> ]>\n<?pi x?>\n<svg>'))).toBe('svg');
    expect(drawingKind(bytesOf('<svg\n width="1"></svg>'))).toBe('svg');
  });
  it('is never fooled by the name or by a near miss: anything else is null', () => {
    for (const s of ['', 'hello', '  0\nENTITIES\n', '0\nSECTIONS\n', 'SECTION\n0\n', '<html><svg></svg></html>', '<svgx/>', '<svg:svg xmlns:svg="x"/>', '<!-- unclosed', '<?xml version="1.0"?>', '{"svg":1}']) {
      expect(drawingKind(bytesOf(s)), s).toBeNull();
    }
    expect(drawingKind(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBeNull();
  });
  it('writes the file under the name\'s stem with the extension of its kind', () => {
    expect(drawingFileName('outline.dxf', 'dxf')).toBe('outline.dxf');
    expect(drawingFileName('logo.png', 'svg')).toBe('logo.svg');
    expect(drawingFileName('board.outline.DXF', 'dxf')).toBe('board.outline.dxf');
    expect(drawingFileName('noext', 'svg')).toBe('noext.svg');
    expect(drawingFileName('.svg', 'svg')).toBe('drawing.svg');
  });
});

describe('the engine\'s answer, read closed', () => {
  it('takes { items, uuids, warnings }, cutting each warning to 1,024 characters', () => {
    expect(readImported(JSON.stringify({ items: 2, uuids: [A, B], warnings: ['a'] }))).toEqual({ items: 2, uuids: [A, B], warnings: ['a'] });
    expect(readImported(JSON.stringify({ items: 5000, uuids: [A], warnings: [] }))?.items).toBe(5000);
    expect(readImported(JSON.stringify({ items: 0, uuids: [], warnings: ['x'.repeat(2000)] }))?.warnings[0]).toHaveLength(1024);
  });
  it('answers null for "" and for any other shape', () => {
    for (const t of ['', 'nope', '[]', '{}', JSON.stringify({ items: 1, uuids: [A] }), JSON.stringify({ items: 1, uuids: [A], warnings: [], extra: 1 }),
      JSON.stringify({ items: -1, uuids: [], warnings: [] }), JSON.stringify({ items: 1.5, uuids: [], warnings: [] }), JSON.stringify({ items: 1, uuids: [A, B], warnings: [] }),
      JSON.stringify({ items: 1, uuids: ['U1'], warnings: [] }), JSON.stringify({ items: 1, uuids: [A], warnings: [1] }),
      JSON.stringify({ items: 1, uuids: [A], warnings: Array(65).fill('w') })]) {
      expect(readImported(t), t).toBeNull();
    }
    expect(readImported(undefined)).toBeNull();
  });
});

describe('graphics.import', () => {
  const op = async (ctx: ResponderCtx, args: unknown) => (unit.ops['graphics.import'].run(args, ctx) as Promise<Answer>);

  it('at: writes the drawing under a fresh folder with the extension of its kind, hands the engine its path and args, drops the folder and answers once the queue is empty', async () => {
    const f = fakeCtx();
    expect(await op(f.ctx, { name: 'logo.png', bytes: SVG, place: 'at', layer: 'Dwgs.User', origin: [5, 5] })).toEqual({ ok: true, result: { items: 2, uuids: [A, B], warnings: [] } });
    expect(f.calls).toEqual([{ path: `${DRAWING_ROOT}/7/logo.svg`, place: 'at', layer: 'Dwgs.User', origin: [5, 5], there: true }]);
    expect(f.files.get(`${DRAWING_ROOT}/7/logo.svg`)).toBe(SVG);
    expect(f.dropped).toEqual([`${DRAWING_ROOT}/7`]);
    expect(f.placed).toEqual([]);
  });

  it('at: not_applied when the apply queue does not empty', async () => {
    const f = fakeCtx({ idle: false });
    expect(await op(f.ctx, { name: 'outline.dxf', bytes: DXF, place: 'at' })).toEqual({ ok: false, code: 'not_applied', message: 'graphics.import' });
  });

  it('pointer: answers at once and joins the place watch in a pcb and a sch frame, not in a symbol or footprint editor', async () => {
    for (const frame of ['pcb', 'sch']) {
      const f = fakeCtx({ frame, idle: false });
      expect(await op(f.ctx, { name: 'outline.dxf', bytes: DXF, place: 'pointer' })).toMatchObject({ ok: true, result: { items: 2 } });
      expect(f.placed, frame).toEqual([A]);
    }
    const st = { token: '', open: true, name: 'R', lib: 'L', mode: 'library', modified: false, depth: 0, unit: 1, unitCount: 1, bodyStyle: 1, bodyStyles: { mode: 'one', names: [] }, parent: '', syncedPins: true };
    const sym = fakeCtx({ frame: 'symedit' });
    Object.assign(sym.ctx.mod() as Record<string, unknown>, fns(SYMEDIT_EXPORTS), { kicadSymEditState: () => JSON.stringify(st), kicadImportGraphics: () => JSON.stringify({ items: 1, uuids: [A], warnings: [] }) });
    expect(await op(sym.ctx, { name: 'outline.dxf', bytes: DXF, place: 'pointer' })).toMatchObject({ ok: true, result: { items: 1 } });
    expect(sym.placed).toEqual([]);
  });

  it('answers not_a_drawing for a file that is neither by content, after the gate, writing nothing', async () => {
    const f = fakeCtx();
    expect(await op(f.ctx, { name: 'outline.dxf', bytes: bytesOf('just text'), place: 'at' })).toMatchObject({ ok: false, code: 'not_a_drawing' });
    expect(f.files.size).toBe(0);
    const g = fakeCtx({ gate: { ok: false, code: 'unsupported', message: 'kicadImportGraphics' } });
    expect(await op(g.ctx, { name: 'x.txt', bytes: bytesOf('just text'), place: 'at' })).toEqual({ ok: false, code: 'unsupported', message: 'kicadImportGraphics' });
  });

  it('answers bad_args when the importer refuses, unreadable when it read nothing, island_error for another shape', async () => {
    expect(await op(fakeCtx({ answer: () => '' }).ctx, { name: 'a.dxf', bytes: DXF, place: 'at', layer: 'Nope' })).toMatchObject({ ok: false, code: 'bad_args' });
    expect(await op(fakeCtx({ answer: () => JSON.stringify({ items: 0, uuids: [], warnings: ['Unsupported entity SPLINE'] }) }).ctx, { name: 'a.dxf', bytes: DXF, place: 'at' }))
      .toEqual({ ok: false, code: 'unreadable', message: 'Unsupported entity SPLINE' });
    expect(await op(fakeCtx({ answer: () => JSON.stringify({ items: 0, uuids: [], warnings: [] }) }).ctx, { name: 'a.dxf', bytes: DXF, place: 'at' }))
      .toEqual({ ok: false, code: 'unreadable', message: NOTHING_READ });
    expect(await op(fakeCtx({ answer: () => '{"items":1}' }).ctx, { name: 'a.dxf', bytes: DXF, place: 'at' })).toMatchObject({ ok: false, code: 'island_error' });
    const f = fakeCtx({ answer: () => { throw new Error('boom'); } });
    expect(await op(f.ctx, { name: 'a.dxf', bytes: DXF, place: 'at' })).toMatchObject({ ok: false, code: 'bad_args' });
    expect(f.dropped).toEqual([`${DRAWING_ROOT}/7`]);
  });

  it('a symbol editor needs a symbol open, a footprint editor a footprint, and any other frame refuses', async () => {
    const st = { token: '', open: false, name: '', lib: '', mode: 'library', modified: false, depth: 0, unit: 1, unitCount: 1, bodyStyle: 1, bodyStyles: { mode: 'one', names: [] }, parent: '', syncedPins: true };
    const sym = fakeCtx({ frame: 'symedit' });
    Object.assign(sym.ctx.mod() as Record<string, unknown>, fns(SYMEDIT_EXPORTS), { kicadSymEditState: () => JSON.stringify(st) });
    expect(await op(sym.ctx, { name: 'a.dxf', bytes: DXF, place: 'at' })).toEqual({ ok: false, code: 'no_symbol', message: 'graphics.import' });
    const noImport = fakeCtx({ frame: 'symedit', mod: { ...fns(SYMEDIT_EXPORTS) } });
    expect(await op(noImport.ctx, { name: 'a.dxf', bytes: DXF, place: 'at' })).toEqual({ ok: false, code: 'unsupported', message: 'kicadImportGraphics' });
    const fp = { token: '', open: false, name: '', lib: '', mode: 'library', modified: false, depth: 0, padCount: 0, type: 'smd', padEditMode: false };
    const fpe = fakeCtx({ frame: 'fpedit' });
    Object.assign(fpe.ctx.mod() as Record<string, unknown>, fns(FPEDIT_EXPORTS), { kicadFpEditState: () => JSON.stringify(fp), kicadCollabBusy: () => false });
    expect(await op(fpe.ctx, { name: 'a.dxf', bytes: DXF, place: 'at' })).toEqual({ ok: false, code: 'no_footprint', message: 'graphics.import' });
    const fpOld = fakeCtx({ frame: 'fpedit', mod: { ...fns(FPEDIT_EXPORTS), kicadFpEditState: () => JSON.stringify({ ...fp, open: true }) } });
    expect(await op(fpOld.ctx, { name: 'a.dxf', bytes: DXF, place: 'at' })).toEqual({ ok: false, code: 'unsupported', message: 'kicadImportGraphics' });
    expect(await op(fakeCtx({ frame: 'ds' }).ctx, { name: 'a.dxf', bytes: DXF, place: 'at' })).toEqual({ ok: false, code: 'unsupported', message: IMPORT_FRAME_ONLY });
  });
});
