// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// m5-i: sch.item.get, sch.item.set, sch.image.place and ev.schItem, their caps
// schItem and schImagePlace feature detected on engine run 15's exports, every
// arg, record and ask read closed, the run folders removed after every answer.
// The engine here is this test's own module of exports (at the protocol
// boundary); the real engine is the e2e's (tests/e2e/sch-items.spec.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startResponder } from '../responder';
import type { ExtUnit, ResponderCtx } from './contract';
import { buildRegistry, REGISTRY } from './registry';
import unit, {
  FILE_MODE_REQUIRED, IMAGE_ROOT, ITEMS_ROOT, SCH_IMAGE_CAP, SCH_IMAGE_EXPORTS, SCH_ITEM_CAP, SCH_ITEM_EVENT, SCH_ITEM_EXPORTS,
  installSchItemAsk, parseSchImagePlaceArgs, readSchItemAsk, schImagePlace, schItemGet, schItemSet, type SchItemAskWindow,
} from './m5-i';
import {
  SCH_EDITABLE_KEYS, SCH_ITEM_KINDS, SCH_TEXT_READ_MAX, parseSchItemGetArgs, parseSchItemSetArgs, readSchItem, readSchItems, readSchItemsDone, schItemSetMisfit,
  type SchItemRecord,
} from './m5-i/records';

const PARENT = 'http://localhost';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));
const enc = (v: unknown): Uint8Array => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v));
const id = (n: number): string => `cc05a11e-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SUB = id(900);
const STROKE = { width: 0, style: 'default', color: '' };
const FILL = { type: 'none', color: '' };
const TEXT_KEYS = { name: '', text: 'Note', x: 25.4, y: 25.4, angle: 0, size: 1.27, bold: false, italic: false, hJustify: 'left', vJustify: 'bottom', visible: true, showName: false };
const BOX_KEYS = {
  text: 'Box', x: 25.4, y: 114.3, x2: 50.8, y2: 124.46, angle: 0, size: 1.27, bold: false, italic: false, hJustify: 'left', vJustify: 'top', visible: true,
  stroke: STROKE, fill: FILL, margins: [0.9525, 0.9525, 0.9525, 0.9525],
};

/** One record per kind, as kicadSchItemGet writes them (pcbjam cc_e8_sch.inc itemRecord). */
const RECORDS: Record<string, Record<string, unknown>> = {
  label: {
    kind: 'label', uuid: id(1), sheetPath: '/', labelKind: 'local', text: 'IN1', x: 76.2, y: 50.8, orientation: 'right', size: 1.27, bold: false, italic: false,
    color: '', shape: null, pinLength: null, fields: [],
  },
  global: {
    kind: 'label', uuid: id(2), sheetPath: '/', labelKind: 'global', text: 'GOUT', x: 50.8, y: 50.8, orientation: 'left', size: 1.27, bold: false, italic: false,
    color: '', shape: 'input', pinLength: null, fields: [{ name: 'Intersheetrefs', value: '${INTERSHEET_REFS}', visible: false, x: 43.18, y: 50.8 }],
  },
  directive: {
    kind: 'label', uuid: id(3), sheetPath: '/', labelKind: 'directive', text: '', x: 76.2, y: 101.6, orientation: 'up', size: 1.27, bold: false, italic: false,
    color: '', shape: 'round', pinLength: 2.54, fields: [{ name: 'Netclass', value: 'Default', visible: true, x: 76.8985, y: 99.06 }],
  },
  wire: { kind: 'wire', uuid: id(4), sheetPath: '/', bus: false, points: [[63.5, 59.69], [63.5, 50.8]], width: 0, style: 'default', color: '' },
  line: { kind: 'line', uuid: id(5), sheetPath: '/', points: [[25.4, 150], [50.8, 150]], width: 0.254, style: 'dash', color: '#ff0000ff' },
  busEntry: { kind: 'busEntry', uuid: id(6), sheetPath: '/', x: 127, y: 55.88, size: [2.54, 2.54], width: 0, style: 'default', color: '' },
  junction: { kind: 'junction', uuid: id(7), sheetPath: '/', x: 63.5, y: 50.8, diameter: 0, color: '' },
  text: { kind: 'text', uuid: id(8), sheetPath: '/', unit: 0, bodyStyle: 0, ...TEXT_KEYS, color: '' },
  textbox: { kind: 'textbox', uuid: id(9), sheetPath: '/', unit: 0, bodyStyle: 0, ...BOX_KEYS, color: '' },
  shape: { kind: 'shape', uuid: id(10), sheetPath: '/', unit: 0, bodyStyle: 0, points: [[25.4, 127], [50.8, 139.7]], shape: 'rectangle', stroke: STROKE, fill: FILL },
  ruleArea: {
    kind: 'ruleArea', uuid: id(11), sheetPath: '/', unit: 0, bodyStyle: 0, points: [[100, 100], [120, 100], [120, 120], [100, 120]], shape: 'polyline',
    stroke: { width: 0, style: 'dash', color: '' }, fill: FILL,
  },
  image: { kind: 'image', uuid: id(12), sheetPath: '/', x: 127, y: 133.35, scale: 1, bytes: 197, png: 'iVBORw0KGgo=' },
  sheet: {
    kind: 'sheet', uuid: SUB, sheetPath: '/', name: 'sub', file: 'sub.kicad_sch', page: '2', x: 152.4, y: 76.2, size: [25.4, 15.24],
    borderWidth: 0.1524, borderColor: '', fillColor: '#00000000', inBom: true, onBoard: true, inSim: true, dnp: false, fields: [], pins: 1,
  },
  sheetPin: { kind: 'sheetPin', uuid: id(13), sheetPath: '/', sheet: SUB, name: 'A_PIN', shape: 'input', side: 'left', size: 1.27, x: 152.4, y: 81.28 },
  table: {
    kind: 'table', uuid: id(14), sheetPath: '/', rows: 2, cols: 2, cells: [['a', 'b'], ['c', '']], borderExternal: true, borderHeader: true,
    border: { width: 0, style: 'solid', color: '' }, separatorsRows: true, separatorsCols: true, separators: { width: 0, style: 'solid', color: '' },
    colWidths: [12.7, 12.7], rowHeights: [5.08, 5.08],
  },
  tableCell: { kind: 'tableCell', uuid: id(15), sheetPath: '/', unit: 0, bodyStyle: 0, ...BOX_KEYS, color: '', table: id(14), row: 0, col: 1, rowSpan: 1, colSpan: 1 },
  group: { kind: 'group', uuid: id(16), sheetPath: '/', name: '', members: 2, designBlock: '' },
};
const R = (k: string): Record<string, unknown> => structuredClone(RECORDS[k]);

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
  const ask = async (n: number, op: string, args?: unknown) => {
    ch.port1.postMessage(args === undefined ? { id: n, op } : { id: n, op, args });
    await settle();
    return got.find((m) => m.id === n);
  };
  return { ready: got.find((m) => m.type === 'ev.ready') as { caps: string[] } | undefined, ask, win };
}

const RUN15 = {
  kicadSchItemGet: () => '', kicadSchItemSet: () => false, kicadHostSchItems: () => true, kicadCollabBusy: () => false,
  kicadSchPlaceImage: () => false, kicadCollabGetSelection: () => '[]',
};

/** A fake engine holding `records` by uuid; `set` plays kicadSchItemSet (it may write items.json into its run folder). */
function fakeCtx(opts: {
  records?: Record<string, unknown>[]; set?: (a: Record<string, unknown>, files: Map<string, Uint8Array>, recs: Map<string, Record<string, unknown>>) => unknown;
  place?: (a: Record<string, unknown>) => unknown; selection?: () => string[]; files?: Record<string, string>; opened?: string; frame?: string; gate?: string;
} = {}) {
  const files = new Map<string, Uint8Array>(Object.entries(opts.files ?? {}).map(([k, v]) => [k, enc(v)]));
  const recs = new Map((opts.records ?? Object.values(RECORDS)).map((r) => [r.uuid as string, structuredClone(r)]));
  const made: string[] = [];
  const dropped: string[] = [];
  const sets: Array<Record<string, unknown>> = [];
  const gets: Array<Record<string, unknown>> = [];
  const started: string[] = [];
  const written: string[] = [];
  let n = 0;
  const mod: Record<string, unknown> = {
    ...RUN15,
    kicadSchItemGet: (json: string) => {
      const a = JSON.parse(json) as { items: Array<{ uuid: string; sheetPath: string }> };
      gets.push(a);
      return JSON.stringify({ items: a.items.map((i) => recs.get(i.uuid)).filter((r) => r != null && (r.sheetPath === '/' || true)) });
    },
    kicadSchItemSet: (json: string) => { const a = JSON.parse(json) as Record<string, unknown>; sets.push(a); return (opts.set ?? (() => false))(a, files, recs); },
    kicadSchPlaceImage: (json: string) => (opts.place ?? (() => true))(JSON.parse(json) as Record<string, unknown>),
    kicadCollabGetSelection: () => JSON.stringify((opts.selection ?? (() => []))()),
  };
  const ctx = {
    frame: opts.frame ?? 'sch',
    root: '/project',
    timing: { schItemsMs: 200, applyPollMs: 5, placeMs: 200, placePollMs: 5 },
    mod: () => mod,
    win: () => ({}),
    fs: () => ({ writeFile: (p: string, b: Uint8Array) => { written.push(p); files.set(p, b); } }),
    closed: () => false,
    opened: () => opts.opened ?? '/project/items-sch.kicad_sch',
    schematicGate: (_op: string, exports: readonly string[]) => {
      if ((opts.frame ?? 'sch') !== 'sch') return { ok: false, code: 'unsupported', message: 'a schematic edits in a sch frame' };
      for (const name of exports) if (typeof mod[name] !== 'function') return { ok: false, code: 'unsupported', message: name };
      if (opts.gate != null) return { ok: false, code: 'busy', message: opts.gate };
      return { w: {}, mod };
    },
    freshRunFolder: (root: string) => { n += 1; const d = `${root}/${n}`; made.push(d); return d; },
    dropRunFolder: (dir: string) => { dropped.push(dir); for (const k of [...files.keys()]) if (k.startsWith(`${dir}/`)) files.delete(k); },
    readBytes: (abs: string) => files.get(abs) ?? null,
    queuedRun: async (op: string, dir: string, ms: number, call: () => unknown, record: () => unknown) => {
      if (call() !== true) return { ok: false, code: 'not_applied', message: op };
      const deadline = Date.now() + ms;
      for (;;) {
        const done = record();
        if (done != null) return { done };
        if (Date.now() >= deadline) return { ok: false, code: 'not_applied', message: op };
        await settle(5);
      }
    },
    placeStart: (u: string) => { started.push(u); },
    log: () => {},
  } as unknown as ResponderCtx;
  return { ctx, files, recs, made, dropped, sets, gets, started, written, mod };
}

/** An engine that applies a set as kicadSchItemSet does: every key onto every item, items.json written last. */
const applyingEngine = (extra: Record<string, unknown> = {}) => (a: Record<string, unknown>, files: Map<string, Uint8Array>, recs: Map<string, Record<string, unknown>>) => {
  const items = a.items as Array<{ uuid: string }>;
  for (const it of items) Object.assign(recs.get(it.uuid) ?? {}, a.set as object);
  files.set(`${a.dir as string}/items.json`, enc({ applied: items.length, depth: 1, renamed: [], replaced: [], ...extra }));
  return true;
};

describe('m5-i in the registry', () => {
  it('loads in this checkout with nothing broken, owning its three ops, two caps and its event', () => {
    expect(REGISTRY.problems).toEqual([]);
    for (const op of ['sch.item.get', 'sch.item.set', 'sch.image.place']) {
      expect(REGISTRY.ops.get(op)?.unit).toBe('m5-i');
      expect(REGISTRY.pending.has(op)).toBe(false);
    }
  });

  it('lists schItem and schImagePlace in a sch frame only, each on its own exports', () => {
    const caps = unit.caps;
    expect(caps({ ...RUN15 }, 'sch')).toEqual([SCH_ITEM_CAP, SCH_IMAGE_CAP]);
    expect(caps({ ...RUN15 }, 'pcb')).toEqual([]);
    for (const name of SCH_ITEM_EXPORTS) {
      const m: Record<string, unknown> = { ...RUN15 };
      delete m[name];
      expect(caps(m, 'sch')).not.toContain(SCH_ITEM_CAP);
    }
    for (const name of SCH_IMAGE_EXPORTS) {
      const m: Record<string, unknown> = { ...RUN15 };
      delete m[name];
      expect(caps(m, 'sch')).toEqual([SCH_ITEM_CAP]);
    }
    expect(unit.events).toEqual({ [SCH_ITEM_EVENT]: ['uuid', 'sheetPath', 'kind', 'isNew'] });
  });
});

describe('m5-i over the responder', () => {
  it('on an engine without the exports (run 14): no cap, each op unsupported naming its first missing export; bad args first', async () => {
    const { ready, ask } = await boot('sch', { kicadCollabBusy: () => false, kicadCollabGetSelection: () => '[]' });
    expect(ready?.caps).not.toContain(SCH_ITEM_CAP);
    expect(ready?.caps).not.toContain(SCH_IMAGE_CAP);
    expect(await ask(1, 'sch.item.get', { items: [{ uuid: id(1), sheetPath: '' }] })).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'kicadSchItemGet' } });
    expect(await ask(2, 'sch.item.set', { items: [{ uuid: id(1), sheetPath: '' }], kind: 'label', set: { bold: true } })).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'kicadSchItemGet' } });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
    expect(await ask(3, 'sch.image.place', { name: 'a.png', bytes: png })).toMatchObject({ ok: false, error: { code: 'unsupported', message: 'kicadSchPlaceImage' } });
    expect(await ask(4, 'sch.item.get', { items: [] })).toMatchObject({ ok: false, error: { code: 'bad_args', message: 'sch.item.get' } });
  });

  it('on engine run 15: both caps listed by a sch frame; a pcb frame lists neither and refuses the ops', async () => {
    const sch = await boot('sch', RUN15);
    expect(sch.ready?.caps).toEqual(expect.arrayContaining([SCH_ITEM_CAP, SCH_IMAGE_CAP]));
    // No schematic open yet: not_ready past the export checks.
    expect(await sch.ask(1, 'sch.item.get', { items: [{ uuid: id(1), sheetPath: '/' }] })).toMatchObject({ ok: false, error: { code: 'not_ready' } });
    const pcb = await boot('pcb', RUN15);
    expect(pcb.ready?.caps).not.toContain(SCH_ITEM_CAP);
    expect(await pcb.ask(2, 'sch.item.get', { items: [{ uuid: id(1), sheetPath: '/' }] })).toMatchObject({ ok: false, error: { code: 'unsupported' } });
  });

  it('takes window.kicadHostSchItem only on an engine with the marker', async () => {
    const run15 = await boot('sch', RUN15);
    expect(typeof (run15.win as unknown as SchItemAskWindow).kicadHostSchItem?.onRequest).toBe('function');
    // No schematic open: the gate does not admit, KiCad's window opens.
    expect((run15.win as unknown as SchItemAskWindow).kicadHostSchItem?.onRequest?.(JSON.stringify({ kind: 'label', uuid: id(1), sheetPath: '/', isNew: false }))).toBe(false);
    const run14 = await boot('sch', { kicadCollabBusy: () => false });
    expect((run14.win as unknown as SchItemAskWindow).kicadHostSchItem).toBeUndefined();
  });
});

describe('the records', () => {
  it('reads one record of every kind as the engine writes it', () => {
    for (const [name, r] of Object.entries(RECORDS)) expect(readSchItem(structuredClone(r)), name).toEqual(r);
    expect(new Set(Object.values(RECORDS).map((r) => r.kind))).toEqual(new Set(SCH_ITEM_KINDS));
  });

  it('refuses a record with a key missing or added, of another type, or a label shape its kind has no word for', () => {
    for (const r of Object.values(RECORDS)) {
      const extra = { ...structuredClone(r), more: 1 };
      expect(readSchItem(extra)).toBeNull();
      const less = structuredClone(r);
      delete less[Object.keys(less).find((k) => !['kind', 'uuid', 'sheetPath'].includes(k)) as string];
      expect(readSchItem(less)).toBeNull();
    }
    expect(readSchItem({ ...R('label'), shape: 'input' })).toBeNull();
    expect(readSchItem({ ...R('global'), shape: 'round' })).toBeNull();
    expect(readSchItem({ ...R('directive'), pinLength: null })).toBeNull();
    expect(readSchItem({ ...R('text'), unit: 1 })).toBeNull();
    expect(readSchItem({ ...R('text'), color: 'red' })).toBeNull();
    expect(readSchItem({ ...R('wire'), points: [[0, 0]] })).toBeNull();
    expect(readSchItem({ ...R('image'), png: '' })).toBeNull();
    expect(readSchItem({ ...R('image'), png: null })).toMatchObject({ png: null });
    expect(readSchItem({ ...R('table'), cells: [['a', 'b']] })).toBeNull();
    expect(readSchItem({ ...R('sheet'), sheetPath: '' })).toBeNull();
    expect(readSchItem({ ...R('label'), uuid: id(1).toUpperCase() })).toBeNull();
  });

  it('reads a text, a text box and a table cell of any length KiCad holds, up to SCH_TEXT_READ_MAX characters (RULINGS 33f)', () => {
    const long = 'x'.repeat(5000) + '\n' + '\u00e9'.repeat(SCH_TEXT_READ_MAX - 5001);
    for (const kind of ['text', 'textbox', 'tableCell']) {
      expect(readSchItem({ ...R(kind), text: long }), kind).toMatchObject({ kind, text: long });
      expect(readSchItem({ ...R(kind), text: long + 'y' }), kind).toBeNull();
    }
    // The whole get answer is read with the long text in it.
    expect(readSchItems(JSON.stringify({ items: [R('wire'), { ...R('text'), text: long }] }), 2)).toHaveLength(2);
    // A set still takes the symbol editor's 1,024: the engine's own set bound.
    expect(parseSchItemSetArgs({ items: [{ uuid: id(8), sheetPath: '' }], kind: 'text', set: { text: 'x'.repeat(1024) } })).not.toBeNull();
    expect(parseSchItemSetArgs({ items: [{ uuid: id(8), sheetPath: '' }], kind: 'text', set: { text: 'x'.repeat(1025) } })).toBeNull();
  });

  it('reads the get answer whole, refusing it for one record of another shape or more records than asked', () => {
    expect(readSchItems(JSON.stringify({ items: [R('wire'), R('sheet')] }), 2)).toHaveLength(2);
    expect(readSchItems(JSON.stringify({ items: [R('wire'), R('sheet')] }), 1)).toBeNull();
    expect(readSchItems(JSON.stringify({ items: [R('wire'), { ...R('sheet'), pins: -1 }] }), 2)).toBeNull();
    expect(readSchItems('', 1)).toBeNull();
    expect(readSchItems(JSON.stringify({ items: [], more: 1 }), 1)).toBeNull();
  });

  it('reads items.json closed', () => {
    expect(readSchItemsDone(null)).toBeNull();
    expect(readSchItemsDone(enc({ applied: 1, depth: 2, renamed: [], replaced: [{ from: id(1), to: id(99) }] }))).toEqual({
      applied: 1, depth: 2, renamed: [], replaced: [{ from: id(1), to: id(99) }], error: null,
    });
    expect(readSchItemsDone(enc({ applied: 0, depth: 2, renamed: [], replaced: [], error: 'in_use' }))).toMatchObject({ error: 'in_use' });
    expect(readSchItemsDone(enc({ applied: 0, depth: 2, renamed: [] }))).toBe('bad');
    expect(readSchItemsDone(enc('{'))).toBe('bad');
  });
});

describe('the args', () => {
  const one = [{ uuid: id(1), sheetPath: '' }];
  it('reads a get closed: 1 to 512 items, each exactly { uuid, sheetPath }', () => {
    expect(parseSchItemGetArgs({ items: one })).toEqual({ items: one });
    expect(parseSchItemGetArgs({ items: [{ uuid: id(1), sheetPath: `/${SUB}/` }] })).not.toBeNull();
    for (const bad of [{}, { items: [] }, { items: one, more: 1 }, { items: [{ uuid: id(1) }] }, { items: [{ uuid: id(1), sheetPath: 'x' }] },
      { items: [...one, ...one] }, { items: Array.from({ length: 513 }, (_, i) => ({ uuid: id(i), sheetPath: '' })) }]) {
      expect(parseSchItemGetArgs(bad)).toBeNull();
    }
  });

  it('reads one set per key of each settable kind, and refuses a key of another kind, a table, and a fileMode without a file', () => {
    const OK: Record<string, Record<string, unknown>> = {
      label: { labelKind: 'global', text: 'X', x: 1, y: 2, orientation: 'up', size: 2, bold: true, italic: true, color: '#11223344', shape: 'output', pinLength: 3, fields: [{ name: 'Netclass', value: 'Power' }] },
      wire: { points: [[0, 0], [10, 0]], width: 0.2, style: 'dot', color: '' },
      line: { points: [[0, 0], [10, 0]], width: 0.2, style: 'dash_dot', color: '' },
      busEntry: { width: 0.2, style: 'solid', color: '' },
      junction: { diameter: 1, color: '' },
      text: { text: 'two\nlines', angle: 90, color: '#000000ff', hJustify: 'center' },
      textbox: { x2: 60, margins: [1, 1, 1, 1], color: '' },
      shape: { points: [[0, 0], [5, 5]], stroke: STROKE, fill: { type: 'color', color: '#ffffffff' } },
      ruleArea: { stroke: { width: 0.1, style: 'dash', color: '' } },
      image: { x: 1, y: 2, scale: 2, png: 'iVBORw0KGgo=' },
      sheet: { name: 'sub2', file: 'sub2.kicad_sch', page: '3', x: 1, y: 2, size: [30, 20], borderWidth: 0.2, borderColor: '', fillColor: '', inBom: false, onBoard: false, inSim: false, dnp: true, fields: [{ name: 'Note', value: 'x', visible: true }] },
      sheetPin: { name: 'B', shape: 'output', side: 'right', size: 1.5 },
      group: { name: '' },
    };
    for (const [kind, set] of Object.entries(OK)) {
      expect(Object.keys(set).every((k) => SCH_EDITABLE_KEYS[kind as keyof typeof SCH_EDITABLE_KEYS].includes(k)), kind).toBe(true);
      expect(parseSchItemSetArgs({ items: one, kind, set }), kind).toEqual({ items: one, kind, set });
      for (const k of Object.keys(set)) expect(parseSchItemSetArgs({ items: one, kind, set: { [k]: set[k] } }), `${kind}.${k}`).not.toBeNull();
    }
    expect(parseSchItemSetArgs({ items: one, kind: 'sheet', set: { file: 'b.kicad_sch' }, fileMode: 'rename' })).toMatchObject({ fileMode: 'rename' });
    for (const bad of [
      { items: one, kind: 'table', set: { rows: 2 } }, { items: one, kind: 'tableCell', set: { text: 'x' } },
      { items: one, kind: 'wire', set: { bus: true } }, { items: one, kind: 'busEntry', set: { size: [1, 1] } }, { items: one, kind: 'sheet', set: { pins: 2 } },
      { items: one, kind: 'label', set: {} }, { items: one, kind: 'label', set: { text: 'a\nb' } }, { items: one, kind: 'label', set: { size: 0 } },
      { items: one, kind: 'label', set: { color: 'red' } }, { items: one, kind: 'label', set: { fields: [{ name: 'A' }, { name: 'A' }] } },
      { items: one, kind: 'text', set: { unit: 1 } }, { items: one, kind: 'shape', set: { shape: 'circle' } }, { items: one, kind: 'sheetPin', set: { shape: 'dot' } },
      { items: one, kind: 'sheet', set: { file: '../up.kicad_sch' } }, { items: one, kind: 'sheet', set: { file: 'a.sch' } }, { items: one, kind: 'sheet', set: { file: '/abs.kicad_sch' } },
      { items: one, kind: 'sheet', set: { page: '' } }, { items: one, kind: 'image', set: { png: 'not base64!' } }, { items: one, kind: 'image', set: { scale: 0 } },
      { items: one, kind: 'sheet', set: { name: 'x' }, fileMode: 'rename' }, { items: one, kind: 'sheet', set: { file: 'b.kicad_sch' }, fileMode: 'keep' },
      { items: one, kind: 'label', set: { bold: true }, more: 1 }, { items: [...one, { uuid: id(1), sheetPath: '/' }], kind: 'label', set: { bold: true } },
      { items: one, kind: 'symbol', set: { bold: true } },
    ]) {
      expect(parseSchItemSetArgs(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('finds the misfits the engine would apply per item', () => {
    const label = readSchItem(R('label')) as SchItemRecord;
    const global = readSchItem(R('global')) as SchItemRecord;
    const directive = readSchItem(R('directive')) as SchItemRecord;
    const shape = readSchItem(R('shape')) as SchItemRecord;
    const sheet = readSchItem(R('sheet')) as SchItemRecord;
    expect(schItemSetMisfit('label', { shape: 'input' }, [label])).toBe('a local label takes no shape');
    expect(schItemSetMisfit('label', { labelKind: 'global', shape: 'input' }, [label])).toBeNull();
    expect(schItemSetMisfit('label', { shape: 'dot' }, [global])).toBe('a global label takes another shape');
    expect(schItemSetMisfit('label', { shape: 'dot', pinLength: 4 }, [directive])).toBeNull();
    expect(schItemSetMisfit('label', { pinLength: 4 }, [global])).toBe('only a directive label has a flag length');
    expect(schItemSetMisfit('shape', { points: [[0, 0], [1, 1], [2, 2]] }, [shape])).toBe('a rectangle takes another count of points');
    expect(schItemSetMisfit('sheet', { file: 'x.kicad_sch' }, [sheet, sheet])).toBe('a sheet file changes one sheet at a time');
    expect(schItemSetMisfit('label', { bold: true }, [label, shape])).toBe('the items are of more than one kind');
  });

  it('reads a picture closed: a PNG or a JPEG and a plain file name', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    expect(parseSchImagePlaceArgs({ name: 'logo.png', bytes: png })).toEqual({ name: 'logo.png', bytes: png });
    expect(parseSchImagePlaceArgs({ name: 'photo.jpg', bytes: jpg })).not.toBeNull();
    for (const bad of [{ name: 'a.png', bytes: new Uint8Array([1, 2, 3]) }, { name: '', bytes: png }, { name: 'a/b.png', bytes: png }, { name: '..', bytes: png },
      { name: 'a.png', bytes: [0x89] }, { name: 'a.png', bytes: png, more: 1 }, { name: 'a\u0001.png', bytes: png }]) {
      expect(parseSchImagePlaceArgs(bad)).toBeNull();
    }
  });
});

describe('the ops', () => {
  it('sch.item.get answers the records in the order asked, an unknown uuid left out', () => {
    const { ctx } = fakeCtx();
    const a = schItemGet({ items: [{ uuid: SUB, sheetPath: '/' }, { uuid: id(500), sheetPath: '' }, { uuid: id(4), sheetPath: '' }] }, ctx);
    expect(a).toEqual({ ok: true, result: { items: [RECORDS.sheet, RECORDS.wire] } });
    expect(schItemGet({ items: [{ uuid: id(4), sheetPath: '' }] }, fakeCtx({ gate: 'sch.item.get' }).ctx)).toMatchObject({ ok: false, code: 'busy' });
    expect(schItemGet({ items: [{ uuid: id(4), sheetPath: '' }] }, fakeCtx({ frame: 'pcb' }).ctx)).toMatchObject({ ok: false, code: 'unsupported' });
    const odd = fakeCtx({ records: [{ ...R('wire'), bus: 'no' }] });
    expect(schItemGet({ items: [{ uuid: id(4), sheetPath: '' }] }, odd.ctx)).toMatchObject({ ok: false, code: 'island_error' });
  });

  it('sch.item.set sends ONE run with the items as read, answers them read back, and drops the folder', async () => {
    const f = fakeCtx({ set: applyingEngine() });
    const a = await schItemSet({ items: [{ uuid: id(4), sheetPath: '' }], kind: 'wire', set: { width: 0.3, style: 'dot' } }, f.ctx);
    expect(a).toMatchObject({ ok: true, result: { items: [{ ...RECORDS.wire, width: 0.3, style: 'dot' }], renamed: [], replaced: [] } });
    expect(f.sets).toEqual([{ run: 1, dir: `${ITEMS_ROOT}/1`, items: [{ uuid: id(4), sheetPath: '/' }], kind: 'wire', set: { width: 0.3, style: 'dot' } }]);
    expect(f.dropped).toEqual(f.made);
  });

  it('sch.item.set answers a converted label under its new uuid with replaced', async () => {
    const NEW = id(77);
    const f = fakeCtx({
      set: (a, files, recs) => {
        const old = recs.get(id(1)) as Record<string, unknown>;
        recs.delete(id(1));
        recs.set(NEW, { ...old, uuid: NEW, labelKind: 'global', shape: 'output', fields: [] });
        files.set(`${a.dir as string}/items.json`, enc({ applied: 1, depth: 3, renamed: [], replaced: [{ from: id(1), to: NEW }] }));
        return true;
      },
    });
    const a = await schItemSet({ items: [{ uuid: id(1), sheetPath: '' }], kind: 'label', set: { labelKind: 'global', shape: 'output' } }, f.ctx);
    expect(a).toMatchObject({ ok: true, result: { items: [{ uuid: NEW, labelKind: 'global', shape: 'output' }], replaced: [{ from: id(1), to: NEW }] } });
  });

  it('sch.item.set refuses before any run: not_found, another kind, a misfit, a picture past 4 MiB, a read only kind', async () => {
    const f = fakeCtx({ set: applyingEngine() });
    expect(await schItemSet({ items: [{ uuid: id(500), sheetPath: '' }], kind: 'wire', set: { width: 1 } }, f.ctx)).toEqual({ ok: false, code: 'not_found', message: id(500) });
    expect(await schItemSet({ items: [{ uuid: id(5), sheetPath: '' }], kind: 'wire', set: { width: 1 } }, f.ctx)).toMatchObject({ ok: false, code: 'bad_args', message: 'sch.item.set: the items are of more than one kind' });
    expect(await schItemSet({ items: [{ uuid: id(1), sheetPath: '' }], kind: 'label', set: { shape: 'input' } }, f.ctx)).toMatchObject({ ok: false, code: 'bad_args' });
    expect(await schItemSet({ items: [{ uuid: id(4), sheetPath: '/sub/' }], kind: 'wire', set: { width: 1 } }, f.ctx)).toMatchObject({ ok: false, code: 'bad_args' });
    const big = 'A'.repeat(Math.ceil((4 * 1024 * 1024 + 3) / 3) * 4);
    expect(await schItemSet({ items: [{ uuid: id(12), sheetPath: '' }], kind: 'image', set: { png: big } }, f.ctx)).toMatchObject({ ok: false, code: 'too_large' });
    expect(await schItemSet({ items: [{ uuid: id(14), sheetPath: '' }], kind: 'table', set: { rows: 3 } }, f.ctx)).toEqual({ ok: false, code: 'bad_args', message: 'sch.item.set: a table is read only here' });
    expect(f.sets).toEqual([]);
    expect(f.made).toEqual([]);
  });

  it('sch.item.set asks for fileMode when the new file exists, sends rename when it does not, and answers sheet_file with KiCad\'s word', async () => {
    const f = fakeCtx({ files: { '/project/spare.kicad_sch': '(kicad_sch)' }, set: applyingEngine({ renamed: [{ from: 'sub.kicad_sch', to: 'new.kicad_sch' }] }) });
    const sheet = [{ uuid: SUB, sheetPath: '' }];
    expect(await schItemSet({ items: sheet, kind: 'sheet', set: { file: 'spare.kicad_sch' } }, f.ctx)).toEqual({ ok: false, code: 'bad_args', message: FILE_MODE_REQUIRED });
    expect(await schItemSet({ items: sheet, kind: 'sheet', set: { file: './spare.kicad_sch' } }, f.ctx)).toEqual({ ok: false, code: 'bad_args', message: FILE_MODE_REQUIRED });
    expect(f.sets).toEqual([]);
    const renamed = await schItemSet({ items: sheet, kind: 'sheet', set: { file: 'new.kicad_sch' } }, f.ctx);
    expect(renamed).toMatchObject({ ok: true, result: { renamed: [{ from: 'sub.kicad_sch', to: 'new.kicad_sch' }] } });
    expect(f.sets[0]).not.toHaveProperty('fileMode');
    const linked = await schItemSet({ items: sheet, kind: 'sheet', set: { file: 'spare.kicad_sch' }, fileMode: 'useExisting' }, f.ctx);
    expect(linked).toMatchObject({ ok: true });
    expect(f.sets[1]).toMatchObject({ fileMode: 'useExisting', set: { file: 'spare.kicad_sch' } });

    const refused = fakeCtx({ set: (a, files) => { files.set(`${a.dir as string}/items.json`, enc({ applied: 0, depth: 0, renamed: [], replaced: [], error: 'in_use' })); return true; } });
    expect(await schItemSet({ items: sheet, kind: 'sheet', set: { file: 'other.kicad_sch' }, fileMode: 'rename' }, refused.ctx)).toEqual({ ok: false, code: 'sheet_file', message: 'in_use' });
    expect(refused.dropped).toEqual(refused.made);
  });

  it('sch.item.set resolves a sheet file below a sub sheet against that sheet\'s own folder', async () => {
    const inner = { ...R('sheet'), uuid: id(901), sheetPath: `/${SUB}/`, file: 'deep.kicad_sch' };
    const outer = { ...R('sheet'), file: 'parts/sub.kicad_sch' };
    const f = fakeCtx({ records: [outer, inner], files: { '/project/parts/spare.kicad_sch': 'x' }, set: applyingEngine() });
    expect(await schItemSet({ items: [{ uuid: id(901), sheetPath: `/${SUB}/` }], kind: 'sheet', set: { file: 'spare.kicad_sch' } }, f.ctx)).toEqual({ ok: false, code: 'bad_args', message: FILE_MODE_REQUIRED });
    expect(await schItemSet({ items: [{ uuid: id(901), sheetPath: `/${SUB}/` }], kind: 'sheet', set: { file: 'other.kicad_sch' } }, f.ctx)).toMatchObject({ ok: true });
  });

  it('sch.item.set: an engine refusal is bad_args, a short apply not_applied, no record not_applied', async () => {
    const no = fakeCtx({ set: () => false });
    expect(await schItemSet({ items: [{ uuid: id(1), sheetPath: '' }], kind: 'label', set: { labelKind: 'global' } }, no.ctx))
      .toEqual({ ok: false, code: 'bad_args', message: 'sch.item.set: a label kind or a sheet file changes only on the sheet shown' });
    expect(await schItemSet({ items: [{ uuid: id(1), sheetPath: '' }], kind: 'label', set: { bold: true } }, no.ctx)).toEqual({ ok: false, code: 'bad_args', message: 'sch.item.set' });
    const short = fakeCtx({ set: applyingEngine({ applied: 0 }) });
    expect(await schItemSet({ items: [{ uuid: id(7), sheetPath: '' }], kind: 'junction', set: { diameter: 1 } }, short.ctx)).toMatchObject({ ok: false, code: 'not_applied' });
    const silent = fakeCtx({ set: () => true });
    expect(await schItemSet({ items: [{ uuid: id(7), sheetPath: '' }], kind: 'junction', set: { diameter: 1 } }, silent.ctx)).toMatchObject({ ok: false, code: 'not_applied' });
    expect(silent.dropped).toEqual(silent.made);
  });

  it('sch.image.place writes the picture, waits for it on the pointer, joins the place watch and drops the folder', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);
    let placed = false;
    const f = fakeCtx({ place: () => { placed = true; return true; }, selection: () => (placed ? [id(300)] : []) });
    expect(await schImagePlace({ name: 'logo.png', bytes: png }, f.ctx)).toEqual({ ok: true, result: {} });
    expect(f.written).toEqual([`${IMAGE_ROOT}/1/logo.png`]);
    expect(f.started).toEqual([id(300)]);
    expect(f.dropped).toEqual([`${IMAGE_ROOT}/1`]);

    const unread = fakeCtx({ place: () => false });
    expect(await schImagePlace({ name: 'logo.png', bytes: png }, unread.ctx)).toMatchObject({ ok: false, code: 'not_applied' });
    const stuck = fakeCtx({ place: () => true });
    expect(await schImagePlace({ name: 'logo.png', bytes: png }, stuck.ctx)).toMatchObject({ ok: false, code: 'busy' });
    expect(stuck.started).toEqual([]);
    const big = new Uint8Array(4 * 1024 * 1024 + 1);
    big.set(png);
    expect(await schImagePlace({ name: 'big.png', bytes: big }, fakeCtx().ctx)).toEqual({ ok: false, code: 'too_large', message: 'sch.image.place' });
    expect(await schImagePlace({ name: 'x.png', bytes: new Uint8Array([1]) }, fakeCtx().ctx)).toEqual({ ok: false, code: 'bad_args', message: 'sch.image.place' });
  });
});

describe('ev.schItem', () => {
  const ask = (v: Record<string, unknown>): string => JSON.stringify(v);
  it('reads the editor\'s ask closed', () => {
    expect(readSchItemAsk(ask({ kind: 'label', uuid: id(1), sheetPath: '/', isNew: false }))).toEqual({ kind: 'label', uuid: id(1), sheetPath: '/', isNew: false });
    expect(readSchItemAsk(ask({ kind: 'sheet', uuid: id(2), sheetPath: `/${SUB}/`, isNew: true }))).not.toBeNull();
    expect(readSchItemAsk(ask({ kind: 'image', uuid: '00000000-0000-0000-0000-000000000000', sheetPath: '/', isNew: true }))).not.toBeNull();
    for (const bad of [
      { kind: 'symbol', uuid: id(1), sheetPath: '/', isNew: false }, { kind: 'table', uuid: id(1), sheetPath: '/', isNew: false },
      { kind: 'label', uuid: id(1), sheetPath: '', isNew: false }, { kind: 'label', uuid: id(1), sheetPath: '/', isNew: 'no' },
      { kind: 'label', uuid: id(1), sheetPath: '/', isNew: false, more: 1 }, { kind: 'wire', uuid: id(1), sheetPath: '/', isNew: true },
      { kind: 'image', uuid: id(1), sheetPath: '/', isNew: true }, { kind: 'label', uuid: '00000000-0000-0000-0000-000000000000', sheetPath: '/', isNew: false },
    ]) {
      expect(readSchItemAsk(ask(bad)), JSON.stringify(bad)).toBeNull();
    }
    expect(readSchItemAsk({ kind: 'label' })).toBeNull();
  });

  it('takes each admitted ask once and answers true; anything else false; the stop clears the slot', () => {
    const w: SchItemAskWindow = {};
    const sent: unknown[] = [];
    let admit = true;
    const stop = installSchItemAsk(w, { admit: () => admit, send: (a) => sent.push(a) });
    const req = ask({ kind: 'junction', uuid: id(7), sheetPath: '/', isNew: false });
    expect(w.kicadHostSchItem?.onRequest?.(req)).toBe(true);
    expect(sent).toEqual([{ kind: 'junction', uuid: id(7), sheetPath: '/', isNew: false }]);
    expect(w.kicadHostSchItem?.onRequest?.(ask({ kind: 'no_connect', uuid: id(8), sheetPath: '/', isNew: false }))).toBe(false);
    admit = false;
    expect(w.kicadHostSchItem?.onRequest?.(req)).toBe(false);
    admit = true;
    const w2: SchItemAskWindow = {};
    installSchItemAsk(w2, { admit: () => true, send: () => { throw new Error('x'); } });
    expect(w2.kicadHostSchItem?.onRequest?.(req)).toBe(false);
    stop();
    expect(w.kicadHostSchItem).toBeUndefined();
    expect(sent).toHaveLength(1);
  });

  it('the unit sends ev.schItem with exactly its keys', () => {
    const w: SchItemAskWindow = {};
    const emitted: Array<[string, Record<string, unknown>]> = [];
    const ctx = {
      frame: 'sch', win: () => w, has: () => true, admit: () => true,
      emitExt: (t: string, p: Record<string, unknown>) => emitted.push([t, p]),
    } as unknown as ResponderCtx;
    const stop = unit.install?.(ctx);
    expect(w.kicadHostSchItem?.onRequest?.(ask({ kind: 'text', uuid: id(9), sheetPath: '/', isNew: true }))).toBe(true);
    expect(emitted).toEqual([[SCH_ITEM_EVENT, { uuid: id(9), sheetPath: '/', kind: 'text', isNew: true }]]);
    if (typeof stop === 'function') stop();
    expect(w.kicadHostSchItem).toBeUndefined();
    expect(unit.install?.({ ...ctx, frame: 'pcb' } as unknown as ResponderCtx)).toBeUndefined();
  });
});
