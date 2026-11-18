// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// ds-i2 as the responder runs it, beside ds-i1 (which defines the ds frame):
// the items, defaults, preview, append and picture ops, each check in its
// order, each change answered with its read back once the engine shows it, the
// cap dseditHeld per frame and ev.dsedit from KiCad's Place Bitmaps. The engine
// here is this test's own fake of the dsedit exports (spec 5.2), at the
// protocol boundary: a change is applied a tick after it is queued, one undo
// step each, as the engine's apply coroutine does.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startResponder, timing } from '../responder';
import type { ExtUnit } from './contract';
import { buildRegistry, REGISTRY } from './registry';
import { DSEDIT_EXPORTS } from '../dsedit';
import { DS_FRAME_ONLY } from '../dsedit';
import ds1 from './ds-i1';
import unit from './ds-i2';

const PARENT = 'http://localhost';
const U = (n: number) => `66666666-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P = (x = 1, y = 2, corner = 'rbcorner') => ({ x, y, corner });
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));
const err = (code: string, message: string) => ({ ok: false, error: { code, message } });
const OPS = ['dsedit.items.get', 'dsedit.items.set', 'dsedit.items.add', 'dsedit.items.remove', 'dsedit.defaults.get', 'dsedit.defaults.set', 'dsedit.preview.get', 'dsedit.preview.set', 'dsedit.append', 'dsedit.image.arm'];
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const ASK = '{"ask":"image","uuid":"","isNew":true}';

const common = (kind: string, n: number) => ({ kind, uuid: U(n), name: '', comment: '', pages: 'all', start: P(), repeat: 1, step: [0, 0] });
const LINE = { ...common('line', 1), end: P(5, 6), lineWidth: 0 };
const TEXT = {
  ...common('text', 2), text: '${TITLE}', labelStep: 1, font: '', bold: false, italic: false, color: '',
  hJustify: 'left', vJustify: 'center', rotation: 0, size: [0, 0], maxLength: 0, maxHeight: 0, lineWidth: 0,
};
const POLY = { ...common('polygon', 3), rotation: 0, lineWidth: 0, outlines: 1, points: 3 };
const BMP = { ...common('bitmap', 4), ppi: 300, width: 16, height: 16 };

const saved = { editPollMs: timing.editPollMs, symeditMs: timing.symeditMs, selectMs: timing.selectMs };
beforeEach(() => {
  timing.editPollMs = 20;
  timing.symeditMs = 150;
  timing.selectMs = 150;
  vi.stubGlobal('KeyboardEvent', class extends Event {
    constructor(type: string, init: Record<string, unknown> = {}) {
      const { bubbles, cancelable, composed, ...rest } = init as EventInit & Record<string, unknown>;
      super(type, { bubbles, cancelable, composed });
      Object.assign(this, rest);
    }
  });
});
afterEach(() => {
  Object.assign(timing, saved);
  vi.unstubAllGlobals();
});

type Rec = Record<string, unknown>;
/**
 * The fake engine's dsedit exports over one open sheet of a line, a text, a
 * polygon and a bitmap. `apply: false` queues changes that never run.
 */
function fakeDs(o: { apply?: boolean; marker?: boolean } = {}) {
  const st = { token: '', open: false, name: '', modified: false, depth: 0, page: 1, values: true, items: 0 };
  let items: Rec[] = [];
  let defaults = { lineWidth: 0.15, textSize: [1.5, 1.5], textThickness: 0.15, margins: { left: 10, right: 10, top: 10, bottom: 10 } };
  let preview: Rec = { paper: 'A4', portrait: false, width: 297, height: 210, title: '', date: '', revision: '', company: '', comments: Array(9).fill('') };
  let pending = 0;
  const calls: Array<[string, unknown]> = [];
  const later = (change: () => void): boolean => {
    pending++;
    setTimeout(() => {
      pending--;
      if (o.apply === false) return;
      change();
      st.depth++;
      st.modified = true;
      st.items = items.length;
    }, 5);
    return true;
  };
  const exports: Rec = {
    ...Object.fromEntries(DSEDIT_EXPORTS.map((n) => [n, () => false])),
    kicadDsEditOpen: (j: string) => {
      const a = JSON.parse(j) as { name: string; token: string };
      items = [LINE, TEXT, POLY, BMP].map((i) => JSON.parse(JSON.stringify(i)) as Rec);
      Object.assign(st, { token: a.token, open: true, name: a.name, modified: false, depth: 0, items: items.length });
      return '{"error":""}';
    },
    kicadDsEditState: () => JSON.stringify(st),
    kicadDsEditItemsGet: (j: string) => {
      calls.push(['get', JSON.parse(j)]);
      const a = JSON.parse(j) as { uuids?: string[]; kinds?: string[] };
      return JSON.stringify({ items: items.filter((i) => (a.uuids == null || a.uuids.includes(i.uuid as string)) && (a.kinds == null || a.kinds.includes(i.kind as string))) });
    },
    kicadDsEditItemsSet: (j: string) => {
      const a = JSON.parse(j) as { uuids: string[]; set: Rec };
      calls.push(['set', a]);
      return later(() => { for (const i of items) if (a.uuids.includes(i.uuid as string)) Object.assign(i, a.set); });
    },
    kicadDsEditItemsAdd: (j: string) => {
      const a = JSON.parse(j) as { items: Rec[] };
      calls.push(['add', a]);
      return later(() => {
        for (const n of a.items) {
          const { png, ...rest } = n;
          items.push(n.kind === 'bitmap' ? { ...rest, width: 64, height: 64 } : rest);
          void png;
        }
      });
    },
    kicadDsEditItemsRemove: (j: string) => {
      const a = JSON.parse(j) as { uuids: string[] };
      calls.push(['remove', a]);
      return later(() => { items = items.filter((i) => !a.uuids.includes(i.uuid as string)); });
    },
    kicadDsEditDefaultsGet: () => JSON.stringify(defaults),
    kicadDsEditDefaultsSet: (j: string) => {
      const a = JSON.parse(j) as { set: Rec };
      calls.push(['defaults', a]);
      return later(() => { defaults = { ...defaults, ...a.set }; });
    },
    kicadDsEditPreviewGet: () => JSON.stringify(preview),
    kicadDsEditPreviewSet: (j: string) => {
      const a = JSON.parse(j) as { set: Rec };
      calls.push(['preview', a]);
      return later(() => { preview = { ...preview, ...a.set, ...(a.set.paper === 'A3' ? { width: 420, height: 297 } : {}) }; });
    },
    kicadDsEditAppend: (j: string) => {
      const a = JSON.parse(j) as { text: string };
      calls.push(['append', a]);
      if (a.text.includes('BROKEN')) return JSON.stringify({ error: 'unreadable', message: 'Expecting ) in appended.kicad_wks, line 7' });
      const added = [U(90), U(91)];
      later(() => { for (const uuid of added) items.push({ ...LINE, uuid }); });
      return JSON.stringify({ error: '', message: '', added });
    },
    kicadDsEditArmImage: (j: string) => { calls.push(['arm', JSON.parse(j)]); return true; },
    kicadDsEditSelection: () => '{"uuids":[]}',
    kicadCollabBusy: () => pending > 0,
    kicadHostActions: () => true,
    ...(o.marker === false ? {} : { kicadHostDsEdit: () => true }),
  };
  return { st, exports, calls, items: () => items };
}

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

/** A responder with ds-i1 and ds-i2, connected and booted on a fake engine with `exports`; `got` collects what the host hears. */
async function boot(frame: string, exports: Rec, busy = { now: false }) {
  const reg = buildRegistry(mods(ds1, unit));
  expect(reg.problems).toEqual([]);
  const { page, parent } = fakePage(`?frame=${frame}&theme=day`);
  const r = startResponder({ parentOrigin: PARENT, page, ext: reg });
  const ch = new MessageChannel();
  const got: Rec[] = [];
  ch.port1.onmessage = (m) => got.push(m.data);
  page.dispatch('message', { origin: PARENT, source: page.parent, data: { type: 'cc.connect', nonce: parent.postMessage.mock.calls[0][0].nonce }, ports: [ch.port2] });
  const Module: Rec = { kicadOpenFileBusy: () => busy.now, ...exports };
  const win = {
    FS: { analyzePath: () => ({ exists: false }), mkdirTree: () => {}, readdir: () => [], readFile: () => { throw new Error('ENOENT'); } },
    Module,
    wxElementRegistry: { findAll: () => [{ id: 'frame', typeName: 'PL_EDITOR_FRAME', name: 'DrawFrame', visible: true }], findByLabel: () => [] },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    dispatchEvent: () => true,
  } as unknown as ToolWindow & { kicadHostDsEdit?: { onRequest?: (json: unknown) => boolean } };
  r.engineReady(win, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
  await settle();
  let next = 1;
  const ask = async (op: string, args?: unknown, wait = 60) => {
    const id = next++;
    ch.port1.postMessage(args === undefined ? { id, op } : { id, op, args });
    for (let i = 0; i < 40 && got.find((m) => m.id === id) == null; i++) await settle(wait / 3);
    const m = got.find((x) => x.id === id);
    if (m == null) return undefined;
    const { id: _id, ...rest } = m;
    void _id;
    return rest;
  };
  const open = () => ask('dsedit.open', { source: 'default', name: 'a.kicad_wks', discard: true });
  const ready = got.find((m) => m.type === 'ev.ready') as { caps: string[] } | undefined;
  return { r, got, win, ask, open, caps: (ready?.caps ?? []).filter((c) => !/^kicad/.test(c)) };
}
const result = (a: unknown) => (a as { result: Rec }).result;

describe('ds-i2 in the registry', () => {
  it('loads with this checkout\'s units, its ten ops, the cap dseditHeld and ev.dsedit', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect([...REGISTRY.ops.entries()].filter(([, op]) => op.unit === 'ds-i2').map(([op]) => op).sort()).toEqual([...OPS].sort());
    expect(REGISTRY.capNames.get('dseditHeld')).toBe('ds-i2');
    expect(REGISTRY.events.get('ev.dsedit')?.keys).toEqual(['ask', 'uuid', 'isNew']);
  });
});

describe('caps per frame', () => {
  it('a ds frame on an engine that asks the page lists dseditHeld beside dsedit', async () => {
    const t = await boot('ds', fakeDs().exports);
    expect(t.caps).toEqual(['dsedit', 'dseditHeld', 'heldKeys', 'hostKeys']);
  });

  it('without the marker, no dseditHeld and no slot; on engine run 14 neither cap and every op names the first missing export', async () => {
    const t = await boot('ds', fakeDs({ marker: false }).exports);
    expect(t.caps).toEqual(['dsedit', 'heldKeys', 'hostKeys']);
    expect(t.win.kicadHostDsEdit).toBeUndefined();
    const old = await boot('ds', { kicadHostActions: () => true, kicadHostDsEdit: () => true });
    expect(old.caps).toEqual(['heldKeys', 'hostKeys']);
    expect(old.win.kicadHostDsEdit).toBeUndefined();
    for (const op of ['dsedit.items.get', 'dsedit.defaults.get', 'dsedit.preview.get']) expect(await old.ask(op), op).toEqual(err('unsupported', 'kicadDsEditOpen'));
  });

  it('a sch, pcb or symedit frame lists neither, takes no slot and answers every op unsupported', async () => {
    for (const frame of ['sch', 'pcb', 'symedit']) {
      const t = await boot(frame, fakeDs().exports);
      expect(t.caps).not.toContain('dseditHeld');
      expect(t.win.kicadHostDsEdit).toBeUndefined();
      for (const op of OPS) expect(await t.ask(op, {}), `${frame} ${op}`).toEqual(err('unsupported', DS_FRAME_ONLY));
    }
  });
});

describe('the items', () => {
  it('reads every item, by uuid and by kind; no_sheet before an open; island_error for a record of another shape', async () => {
    const f = fakeDs();
    const t = await boot('ds', f.exports);
    expect(await t.ask('dsedit.items.get')).toEqual(err('no_sheet', 'dsedit.items.get'));
    await t.open();
    expect(result(await t.ask('dsedit.items.get')).items).toEqual([LINE, TEXT, POLY, BMP]);
    expect(result(await t.ask('dsedit.items.get', { uuids: [U(2), U(77)] })).items).toEqual([TEXT]);
    expect(result(await t.ask('dsedit.items.get', { kinds: ['polygon', 'bitmap'] })).items).toEqual([POLY, BMP]);
    const odd = await boot('ds', { ...f.exports, kicadDsEditItemsGet: () => JSON.stringify({ items: [{ ...LINE, extra: 1 }] }) });
    await odd.open();
    expect(await odd.ask('dsedit.items.get')).toEqual(err('island_error', 'dsedit.items.get: the engine answered items of another shape'));
  });

  it('sets the text\'s size, the line\'s end and the bitmap\'s ppi, each answered with its read back and one undo step', async () => {
    const f = fakeDs();
    const t = await boot('ds', f.exports);
    await t.open();
    await settle(80);
    const size = result(await t.ask('dsedit.items.set', { uuids: [U(2)], set: { size: [3, 3] } }));
    expect(size.items).toEqual([{ ...TEXT, size: [3, 3] }]);
    expect(f.st.depth).toBe(1);
    const end = result(await t.ask('dsedit.items.set', { uuids: [U(1)], set: { end: P(50, 60, 'ltcorner') } }));
    expect((end.items as Rec[])[0].end).toEqual(P(50, 60, 'ltcorner'));
    expect(result(await t.ask('dsedit.items.set', { uuids: [U(4)], set: { ppi: 600 } })).items).toEqual([{ ...BMP, ppi: 600 }]);
    expect(f.st.depth).toBe(3);
    await settle(80);
    // ev.edited follows the undo depth (ds-i1's poll; two quick steps may share one poll).
    const edited = t.got.filter((m) => m.type === 'ev.edited').map((m) => m.depth as number);
    expect(edited.at(-1)).toBe(3);
    expect(edited).toEqual([...new Set(edited)].sort());
  });

  it('refuses an id not on the sheet and a key an item\'s kind lacks before any change; not_applied when the change never shows', async () => {
    const f = fakeDs();
    const t = await boot('ds', f.exports);
    await t.open();
    expect(await t.ask('dsedit.items.set', { uuids: [U(1), U(77)], set: { name: 'x' } })).toEqual(err('bad_args', `dsedit.items.set: ${U(77)} is not on the sheet`));
    expect(await t.ask('dsedit.items.set', { uuids: [U(1), U(4)], set: { lineWidth: 0.2 } })).toEqual(err('bad_args', 'dsedit.items.set: a bitmap has no lineWidth'));
    expect(await t.ask('dsedit.items.set', { uuids: [U(3)], set: { end: P() } })).toEqual(err('bad_args', 'dsedit.items.set: a polygon has no end'));
    expect(f.calls.filter(([c]) => c === 'set')).toEqual([]);
    const g = fakeDs({ apply: false });
    const s = await boot('ds', g.exports);
    await s.open();
    expect(await s.ask('dsedit.items.set', { uuids: [U(1)], set: { name: 'x' } }, 400)).toEqual(err('not_applied', 'dsedit.items.set'));
  });

  it('adds a line with the page\'s own uuid and a bitmap from a PNG; a taken uuid and a polygon are refused', async () => {
    const f = fakeDs();
    const t = await boot('ds', f.exports);
    await t.open();
    const line = { ...LINE, uuid: U(10), name: 'new' };
    expect(result(await t.ask('dsedit.items.add', { items: [line] })).items).toEqual([line]);
    const png = btoa(String.fromCharCode(...PNG));
    const bmp = { ...common('bitmap', 11), ppi: 300, png };
    expect(result(await t.ask('dsedit.items.add', { items: [bmp] })).items).toEqual([{ ...common('bitmap', 11), ppi: 300, width: 64, height: 64 }]);
    expect(f.calls.filter(([c]) => c === 'add').map(([, a]) => a)).toEqual([{ items: [line] }, { items: [bmp] }]);
    expect(await t.ask('dsedit.items.add', { items: [{ ...LINE, uuid: U(10) }] })).toEqual(err('bad_args', `dsedit.items.add: ${U(10)} is on the sheet already`));
    expect(await t.ask('dsedit.items.add', { items: [{ ...POLY, uuid: U(12) }] })).toEqual(err('bad_args', 'dsedit.items.add'));
    expect(f.st.depth).toBe(2);
  });

  it('removes items and answers { removed }; an id not on the sheet is refused', async () => {
    const f = fakeDs();
    const t = await boot('ds', f.exports);
    await t.open();
    expect(await t.ask('dsedit.items.remove', { uuids: [U(1), U(77)] })).toEqual(err('bad_args', `dsedit.items.remove: ${U(77)} is not on the sheet`));
    expect(result(await t.ask('dsedit.items.remove', { uuids: [U(1), U(3)] }))).toEqual({ removed: [U(1), U(3)] });
    expect(f.items().map((i) => i.uuid)).toEqual([U(2), U(4)]);
    expect(f.st.depth).toBe(1);
  });
});

describe('the defaults and the preview', () => {
  it('sets a 0.3 mm line width, then the title Checked on A3, each read back', async () => {
    const f = fakeDs();
    const t = await boot('ds', f.exports);
    await t.open();
    expect(result(await t.ask('dsedit.defaults.get'))).toMatchObject({ lineWidth: 0.15 });
    expect(result(await t.ask('dsedit.defaults.set', { set: { lineWidth: 0.3 } }))).toMatchObject({ lineWidth: 0.3, textSize: [1.5, 1.5] });
    expect(result(await t.ask('dsedit.preview.get'))).toMatchObject({ paper: 'A4', title: '' });
    expect(result(await t.ask('dsedit.preview.set', { set: { title: 'Checked', paper: 'A3' } }))).toMatchObject({ paper: 'A3', title: 'Checked', width: 420, height: 297 });
    expect(f.st.depth).toBe(2);
  });

  it('refuses a size on a paper that is not User and an orientation on a User paper, against the paper shown', async () => {
    const f = fakeDs();
    const t = await boot('ds', f.exports);
    await t.open();
    expect(await t.ask('dsedit.preview.set', { set: { width: 300, height: 200 } })).toEqual(err('bad_args', 'dsedit.preview.set: a size is set only on a User paper'));
    expect(await t.ask('dsedit.preview.set', { set: { paper: 'User', portrait: true } })).toEqual(err('bad_args', 'dsedit.preview.set: a User paper takes its orientation from its size'));
    expect(result(await t.ask('dsedit.preview.set', { set: { paper: 'User', width: 300, height: 200 } }))).toMatchObject({ paper: 'User', width: 300, height: 200 });
    expect(await t.ask('dsedit.preview.set', { set: { portrait: true } })).toEqual(err('bad_args', 'dsedit.preview.set: a User paper takes its orientation from its size'));
    expect(f.calls.filter(([c]) => c === 'preview')).toHaveLength(1);
  });
});

describe('append and the armed picture', () => {
  it('appends another sheet and answers its added uuids once the sheet holds them; KiCad\'s line for an unreadable one; too_large past 8 MiB', async () => {
    const f = fakeDs();
    const t = await boot('ds', f.exports);
    await t.open();
    expect(result(await t.ask('dsedit.append', { text: '(kicad_wks)' }))).toEqual({ added: [U(90), U(91)] });
    expect(f.items().slice(-2).map((i) => i.uuid)).toEqual([U(90), U(91)]);
    expect(await t.ask('dsedit.append', { text: '(kicad_wks BROKEN' })).toEqual(err('unreadable', 'Expecting ) in appended.kicad_wks, line 7'));
    expect(await t.ask('dsedit.append', { text: 'x'.repeat(8 * 1024 * 1024 + 1) }, 300)).toEqual(err('too_large', 'dsedit.append'));
    expect(f.calls.filter(([c]) => c === 'append')).toHaveLength(2);
  });

  it('arms a PNG as base64 for the next Place Bitmaps, disarms with no bytes, refuses another file and anything past 4 MiB', async () => {
    const f = fakeDs();
    const t = await boot('ds', f.exports);
    await t.open();
    expect(await t.ask('dsedit.image.arm', { bytes: PNG, name: 'logo.png' })).toEqual({ ok: true, result: {} });
    expect(await t.ask('dsedit.image.arm', { bytes: new Uint8Array(0), name: '' })).toEqual({ ok: true, result: {} });
    expect(f.calls.filter(([c]) => c === 'arm').map(([, a]) => a)).toEqual([{ png: btoa(String.fromCharCode(...PNG)), name: 'logo.png' }, { png: '', name: '' }]);
    expect(await t.ask('dsedit.image.arm', { bytes: new Uint8Array([1, 2, 3]), name: 'x.txt' })).toEqual(err('bad_args', 'dsedit.image.arm'));
    const big = new Uint8Array(4 * 1024 * 1024 + 1);
    big.set(PNG);
    expect(await t.ask('dsedit.image.arm', { bytes: big, name: 'big.png' }, 300)).toEqual(err('too_large', 'dsedit.image.arm'));
    expect(f.calls.filter(([c]) => c === 'arm')).toHaveLength(2);
  });
});

describe('the checks in order', () => {
  it('bad_args first, then busy, then no_sheet, every one before any effect', async () => {
    const f = fakeDs();
    const busy = { now: false };
    const t = await boot('ds', f.exports, busy);
    for (const op of OPS) expect(await t.ask(op, { x: 1 }), op).toEqual(err('bad_args', op));
    busy.now = true;
    expect(await t.ask('dsedit.items.get', {})).toEqual(err('busy', 'dsedit.items.get'));
    busy.now = false;
    expect(await t.ask('dsedit.defaults.set', { set: { lineWidth: 0.3 } })).toEqual(err('no_sheet', 'dsedit.defaults.set'));
    expect(f.calls).toEqual([]);
  });
});

describe('ev.dsedit', () => {
  it('Place Bitmaps with nothing armed sends ev.dsedit once per request, only after ev.ready with a sheet open', async () => {
    const f = fakeDs();
    const t = await boot('ds', f.exports);
    const press = (json: string) => t.win.kicadHostDsEdit?.onRequest?.(json);
    expect(press(ASK)).toBe(false);
    await t.open();
    expect(press(ASK)).toBe(true);
    expect(press('{"ask":"pin","uuid":"","isNew":true}')).toBe(false);
    expect(press(ASK)).toBe(true);
    await settle();
    expect(t.got.filter((m) => m.type === 'ev.dsedit')).toEqual([{ type: 'ev.dsedit', ask: 'image', uuid: '', isNew: true }, { type: 'ev.dsedit', ask: 'image', uuid: '', isNew: true }]);
  });
});
