// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// fp-i3: fpedit.footprint.get and set, fpedit.embed, fpedit.check,
// fpedit.cleanup and fpedit.svg, each check in its order and each read back,
// against this test's own fake of the engine's run 15 exports
// (kicadFpEditFootprintGet, Set, Embed, Check, Cleanup, PlotSvg and the
// rest of the fpedit set) at the protocol boundary; and, as the responder
// runs the unit, every frame but the footprint editor's answering the six
// ops unsupported.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FPEDIT_EXPORTS } from '../fpedit/common';
import { startResponder, timing } from '../responder';
import type { ExtUnit, ResponderCtx } from './contract';
import { buildRegistry, REGISTRY } from './registry';
import unit, {
  EMBED_MAX_BYTES, FP_CHECK_CODES, fpCheck, fpCleanup, fpEmbed, fpFootprintGet, fpFootprintSet, fpSvg, parseFootprintSet,
  parseFootprintSetArgs, parseFpCleanupArgs, parseFpEmbedArgs, readFootprintProps, readFpCleanup, readFpFindings, showsFootprintSet,
  type FootprintProps,
} from './fp-i3';

const PARENT = 'http://localhost';
const FRAME_ONLY = 'a footprint edits in an fpedit frame';
const OPS = ['fpedit.footprint.get', 'fpedit.footprint.set', 'fpedit.embed', 'fpedit.check', 'fpedit.cleanup', 'fpedit.svg'];
const U = (n: number): string => `abcdef33-0000-4000-8000-${String(n).padStart(12, '0')}`;
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const err = (code: string, message: string) => ({ ok: false, code, message });

const model = { path: '${KICAD10_3DMODEL_DIR}/Package_SO.3dshapes/SOIC-8_3.9x4.9mm_P1.27mm.step', offset: [0, 0, 0], rotate: [0, 0, 0], scale: [1, 1, 1], opacity: 1, show: true };
const baseProps = (): FootprintProps => ({
  name: 'SOIC-8_3.9x4.9mm_P1.27mm', description: 'SOIC, 8 Pin', keywords: 'SOIC SO',
  fields: [
    { name: 'Reference', value: 'REF**', visible: true, layer: 'F.SilkS', kind: 'reference' },
    { name: 'Value', value: 'SOIC-8', visible: true, layer: 'F.Fab', kind: 'value' },
    { name: 'Datasheet', value: '', visible: false, layer: 'F.Fab', kind: 'datasheet' },
    { name: 'Description', value: '', visible: false, layer: 'F.Fab', kind: 'description' },
  ],
  type: 'smd', boardOnly: false, excludeFromPos: false, excludeFromBom: false, dnp: false, allowMissingCourtyard: false, allowSolderMaskBridges: false,
  clearance: null, maskMargin: null, pasteMargin: null, pasteRatio: null, zoneConnection: 'inherit',
  netTieGroups: [], jumpers: { duplicateNumbersAreJumpers: false, groups: [] }, privateLayers: [], customStackup: { on: false, copperLayers: 2 },
  userLayerNames: { 'User.1': 'User.1' }, models: [structuredClone(model) as FootprintProps['models'][number]], embedded: [],
});

type Mem = Map<string, Uint8Array>;
/** A tiny MEMFS: files by absolute path, folders implied. */
function fakeFs(mem: Mem) {
  return {
    writeFile: (p: string, b: Uint8Array | string) => { mem.set(p, typeof b === 'string' ? new TextEncoder().encode(b) : b.slice()); },
  };
}

/** The fake engine: one open footprint; each change applied on the next turn, one undo step. */
function fakeEngine(o: { refuse?: boolean; never?: boolean; open?: boolean; svg?: 'ok' | 'failed' | 'empty' | 'huge'; get?: string } = {}) {
  const st = { open: o.open ?? true, depth: 0 };
  let props = baseProps();
  const mem: Mem = new Map();
  const calls: Array<{ name: string; arg: unknown }> = [];
  const later = (f: () => void, step = true) => { if (!o.never) setTimeout(() => { f(); if (step) st.depth++; }, 1); };
  const mod: Record<string, unknown> = Object.fromEntries(FPEDIT_EXPORTS.map((n) => [n, () => '']));
  Object.assign(mod, {
    kicadFpEditState: () => JSON.stringify({ token: 't', open: st.open, name: props.name, lib: 'parts', mode: 'library', modified: st.depth > 0, depth: st.depth, padCount: 8, type: 'smd', padEditMode: false }),
    kicadFpEditFootprintGet: () => (o.get != null ? o.get : st.open ? JSON.stringify(props) : ''),
    kicadFpEditFootprintSet: (j: string) => {
      const a = JSON.parse(j) as { set: Record<string, unknown> };
      calls.push({ name: 'set', arg: a });
      if (o.refuse) return false;
      later(() => {
        const s = a.set;
        for (const [k, v] of Object.entries(s)) {
          if (k === 'fields') for (const p of v as Array<Record<string, unknown>>) Object.assign(props.fields.find((f) => f.name === p.name) ?? {}, p);
          else if (k === 'addField') props.fields.push({ ...(v as FootprintProps['fields'][number]), kind: 'user' });
          else if (k === 'removeField') props.fields = props.fields.filter((f) => f.name !== v);
          else if (k === 'netTieGroups') props.netTieGroups = (v as string[]).filter((g) => g !== '');
          else (props as unknown as Record<string, unknown>)[k] = structuredClone(v);
        }
      });
      return true;
    },
    kicadFpEditEmbed: (j: string) => {
      const a = JSON.parse(j) as { path?: string; name?: string; type?: string; remove?: string };
      calls.push({ name: 'embed', arg: a });
      if (o.refuse) return false;
      if (a.remove != null) { later(() => { props.embedded = props.embedded.filter((e) => e.name !== a.remove); }); return true; }
      const bytes = mem.get(a.path as string);
      if (bytes == null || !(a.path as string).startsWith('/tmp/cc-embed/')) return false;
      later(() => { props.embedded = [...props.embedded.filter((e) => e.name !== a.name), { name: a.name as string, type: a.type as 'model', bytes: bytes.byteLength }]; });
      return true;
    },
    kicadFpEditCheck: () => JSON.stringify({ findings: [
      { code: 'missing_courtyard', severity: 'error', message: 'Footprint has no courtyard defined', uuids: [U(1)], pads: [], x: null, y: null },
      { code: 'shorting_items', severity: 'error', message: 'Items shorting two nets', uuids: [U(2), U(3)], pads: ['2', '3'], x: 1.27, y: -0.5 },
    ] }),
    kicadFpEditCleanup: (j: string) => {
      const a = JSON.parse(j) as { dryRun: boolean; repair: boolean };
      calls.push({ name: 'cleanup', arg: a });
      const items = props.description === 'tidy' ? [{ code: 'null_graphic', uuids: [U(7)] }] : [];
      if (!a.dryRun && items.length > 0) later(() => { props.description = 'tidied'; });
      return JSON.stringify({ items, repaired: 0 });
    },
    kicadFpEditPlotSvg: (j: string) => {
      const a = JSON.parse(j) as { dir: string };
      calls.push({ name: 'svg', arg: a });
      if (o.refuse) return false;
      later(() => {
        const svg = o.svg === 'empty' ? new Uint8Array(0) : o.svg === 'huge' ? new Uint8Array(4 * 1024 * 1024 + 1) : new TextEncoder().encode('<svg/>');
        mem.set(`${a.dir}/footprint.svg`, svg);
        mem.set(`${a.dir}/.cc-svg.json`, new TextEncoder().encode(JSON.stringify({ error: o.svg === 'failed' ? 'plot_failed' : '' })));
      }, false);
      return true;
    },
    kicadCollabBusy: () => false,
  });
  return { st, mod, mem, calls, props: () => props, setProps: (p: FootprintProps) => { props = p; } };
}

/** The responder's ctx in an fpedit frame as these ops read it, over the fake engine. */
function fakeCtx(f: ReturnType<typeof fakeEngine> | null, o: { frame?: string; busy?: boolean; blocked?: boolean } = {}): ResponderCtx & { dropped: string[] } {
  let runs = 0;
  const dropped: string[] = [];
  const mod = f?.mod ?? null;
  return {
    dropped,
    frame: o.frame ?? 'fpedit',
    root: '/project',
    timing: { symeditMs: 150, svgMs: 150, applyPollMs: 2 },
    win: () => (mod == null ? null : ({} as never)),
    mod: () => mod,
    fs: () => (f == null ? null : fakeFs(f.mem)),
    engineBusy: () => o.busy === true,
    keysBlocked: () => o.blocked === true,
    closed: () => false,
    applyIdle: async () => true,
    freshRunFolder: (root: string) => `${root}/${++runs}`,
    dropRunFolder: (dir: string) => { dropped.push(dir); if (f != null) for (const k of [...f.mem.keys()]) if (k.startsWith(`${dir}/`)) f.mem.delete(k); },
    readBytes: (abs: string) => f?.mem.get(abs) ?? null,
    queuedRun: async (op: string, dir: string, ms: number, call: () => unknown, record: () => unknown) => {
      if (call() !== true) { dropped.push(dir); return err('not_applied', op); }
      const deadline = Date.now() + ms;
      for (;;) {
        const done = record();
        if (done != null) return { done };
        if (Date.now() >= deadline) { dropped.push(dir); return err('not_applied', op); }
        await settle(2);
      }
    },
    log: () => {},
  } as unknown as ResponderCtx & { dropped: string[] };
}

describe('the unit in the registry', () => {
  it('loads with nothing broken and owns the six ops, answered in the fpedit frame only; the reads pass a check', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect([...REGISTRY.ops.entries()].filter(([, op]) => op.unit === 'fp-i3').map(([op]) => op).sort()).toEqual([...OPS].sort());
    const reg = buildRegistry({ './fp-i3.ts': { default: unit as ExtUnit } }, {}, { fpedit: 'fp-i1' });
    expect(reg.problems).toEqual([]);
    expect(unit.frames).toEqual(['fpedit']);
    expect(unit.ops['fpedit.footprint.get'].passesCheck).toBe(true);
    expect(unit.ops['fpedit.check'].passesCheck).toBe(true);
    expect(unit.ops['fpedit.footprint.set']).not.toHaveProperty('passesCheck');
  });
});

describe('outside the footprint editor', () => {
  const saved = { editPollMs: timing.editPollMs };
  beforeEach(() => { timing.editPollMs = 20; });
  afterEach(() => { Object.assign(timing, saved); vi.unstubAllGlobals(); });

  it('a sch, pcb or symedit frame answers every op unsupported and never calls the engine', async () => {
    for (const frame of ['sch', 'pcb', 'symedit']) {
      const reg = buildRegistry({ './fp-i3.ts': { default: unit as ExtUnit } }, {}, { fpedit: 'fp-i1' });
      const listeners = new Map<string, Set<(e: unknown) => void>>();
      const parent = { postMessage: vi.fn() };
      const page = {
        parent, top: {}, location: { search: `?frame=${frame}&theme=day` },
        addEventListener: (t: string, h: (e: unknown) => void) => { const s = listeners.get(t) ?? new Set(); s.add(h); listeners.set(t, s); },
        removeEventListener: (t: string, h: (e: unknown) => void) => listeners.get(t)?.delete(h),
      };
      const r = startResponder({ parentOrigin: PARENT, page: page as unknown as Window, ext: reg });
      const ch = new MessageChannel();
      const got: Array<Record<string, unknown>> = [];
      ch.port1.onmessage = (m) => got.push(m.data);
      for (const h of listeners.get('message') ?? []) h({ origin: PARENT, source: parent, data: { type: 'cc.connect', nonce: parent.postMessage.mock.calls[0][0].nonce }, ports: [ch.port2] });
      const f = fakeEngine();
      const win = {
        FS: { analyzePath: () => ({ exists: false }), mkdirTree: () => {}, readdir: () => [], readFile: () => { throw new Error('ENOENT'); } },
        Module: { kicadOpenFileBusy: () => false, kicadHostActions: () => true, ...f.mod },
        wxElementRegistry: { findAll: () => [], findByLabel: () => [] },
        document: { querySelector: () => null, querySelectorAll: () => [] },
        dispatchEvent: () => true,
      };
      r.engineReady(win as never, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
      await settle();
      for (const [i, op] of OPS.entries()) {
        ch.port1.postMessage({ id: i + 1, op, args: {} });
        for (let n = 0; n < 40 && got.find((m) => m.id === i + 1) == null; n++) await settle(5);
        expect(got.find((m) => m.id === i + 1), `${frame} ${op}`).toEqual({ id: i + 1, ok: false, error: { code: 'unsupported', message: FRAME_ONLY } });
      }
      expect(f.calls).toEqual([]);
      r.close?.();
    }
  });
});

describe('the engine\'s answers, read closed', () => {
  it('FootprintProps: exactly its keys, each of its type; "" and any other shape are null', () => {
    const p = baseProps();
    expect(readFootprintProps(JSON.stringify(p))).toEqual(p);
    expect(readFootprintProps('')).toBeNull();
    expect(readFootprintProps('{')).toBeNull();
    const bad: Array<(q: Record<string, unknown>) => void> = [
      (q) => { q.more = 1; }, (q) => { delete q.embedded; }, (q) => { q.type = 'tht'; }, (q) => { q.clearance = '0'; },
      (q) => { q.zoneConnection = 'full'; }, (q) => { (q.fields as Array<Record<string, unknown>>)[0].kind = 'ref'; },
      (q) => { (q.fields as Array<Record<string, unknown>>)[0].layer = 'F Silk'; }, (q) => { q.privateLayers = ['User.1', 'User.1']; },
      (q) => { q.models = Array.from({ length: 33 }, () => model); }, (q) => { (q.models as Array<Record<string, unknown>>)[0].offset = [0, 0]; },
      (q) => { q.embedded = [{ name: 'a', type: 'step', bytes: 1 }]; }, (q) => { q.embedded = [{ name: 'a', type: 'model', bytes: -1 }]; },
      (q) => { q.jumpers = { duplicateNumbersAreJumpers: false, groups: [['']] }; }, (q) => { q.customStackup = { on: true }; },
      (q) => { q.userLayerNames = { 'not a layer': 'x' }; }, (q) => { q.pasteRatio = '0.1'; },
    ];
    for (const b of bad) {
      const q = structuredClone(p) as unknown as Record<string, unknown>;
      b(q);
      expect(readFootprintProps(JSON.stringify(q)), b.toString()).toBeNull();
    }
  });

  it('findings: each exactly its keys, x and y both numbers or both null; any other shape is null', () => {
    const f = { code: 'through_hole_pad_without_hole', severity: 'error', message: 'm', uuids: [U(1)], pads: ['1'], x: 0, y: 1.27 };
    expect(readFpFindings(JSON.stringify({ findings: [f] }))).toEqual([f]);
    expect(readFpFindings(JSON.stringify({ findings: [] }))).toEqual([]);
    expect(readFpFindings('')).toBeNull();
    for (const b of [{ ...f, code: '' }, { ...f, code: 'Shorting Items' }, { ...f, severity: 'info' }, { ...f, x: null }, { ...f, uuids: ['x'] }, { ...f, more: 1 }]) {
      expect(readFpFindings(JSON.stringify({ findings: [b] })), JSON.stringify(b)).toBeNull();
    }
    expect(FP_CHECK_CODES).toContain('silk_over_copper');
    expect(FP_CHECK_CODES).not.toContain('pad_th_with_no_hole');
  });

  it('a tidy: items of the four codes or other, and a count', () => {
    expect(readFpCleanup('{"items":[{"code":"null_graphic","uuids":[]}],"repaired":2}')).toEqual({ items: [{ code: 'null_graphic', uuids: [] }], repaired: 2 });
    for (const b of ['', '{"items":[]}', '{"items":[{"code":"x","uuids":[]}],"repaired":0}', '{"items":[],"repaired":-1}']) expect(readFpCleanup(b), b).toBeNull();
  });
});

describe('the args, read closed', () => {
  it('a footprint set: at least one known key within the engine\'s bounds', () => {
    const ok = { description: 'probe\nline two', addField: { name: 'MPN', value: 'X', visible: false, layer: 'F.Fab' }, allowMissingCourtyard: true,
      clearance: null, maskMargin: -0.05, pasteRatio: -0.1, fields: [{ name: 'Value', value: 'V' }], jumpers: { duplicateNumbersAreJumpers: true, groups: [['1', '2']] },
      customStackup: { on: true, copperLayers: 4 }, models: [{ ...model, offset: [0, 0, 1], scale: [2, 2, 2] }] };
    expect(parseFootprintSet(ok)).toEqual(ok);
    expect(parseFootprintSetArgs({ set: { dnp: true } })).toEqual({ set: { dnp: true } });
    for (const bad of [{}, { embedded: [] }, { other: 1 }, { name: '' }, { keywords: 'a\nb' }, { clearance: -1 }, { maskMargin: 101 }, { pasteRatio: 2 },
      { customStackup: { on: true, copperLayers: 3 } }, { customStackup: { on: true, copperLayers: 34 } }, { fields: [{ name: 'Value' }, { name: 'Value' }] },
      { fields: [{ name: 'Value', kind: 'value' }] }, { addField: { name: 'A', value: 'B', visible: true } }, { models: [{ ...model, scale: [0, 1, 1] }] },
      { models: [{ ...model, rotate: [361, 0, 0] }] }, { type: 'tht' }, { privateLayers: ['User.1', 'User.1'] }, { zoneConnection: 'full' }]) {
      expect(parseFootprintSet(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(parseFootprintSetArgs({ set: { dnp: true }, more: 1 })).toBeNull();
    expect(parseFootprintSetArgs({ dnp: true })).toBeNull();
  });

  it('embed: a name, a type and 1 byte to 25 MiB, or a remove', () => {
    const b = new Uint8Array([1, 2]);
    expect(parseFpEmbedArgs({ name: 'body.step', type: 'model', bytes: b })).toEqual({ name: 'body.step', type: 'model', bytes: b });
    expect(parseFpEmbedArgs({ remove: 'body.step' })).toEqual({ remove: 'body.step' });
    for (const bad of [{ name: 'a/b', type: 'model', bytes: b }, { name: '..', type: 'model', bytes: b }, { name: 'a', type: 'step', bytes: b },
      { name: 'a', type: 'model', bytes: new Uint8Array(0) }, { name: 'a', type: 'model', bytes: [1] }, { name: 'x'.repeat(256), type: 'model', bytes: b },
      { remove: '' }, { remove: 'a', name: 'a' }, { name: 'a', type: 'model', bytes: b, more: 1 }]) {
      expect(parseFpEmbedArgs(bad), JSON.stringify(bad).slice(0, 80)).toBeNull();
    }
    expect(EMBED_MAX_BYTES).toBe(25 * 1024 * 1024);
  });

  it('cleanup: exactly the five booleans', () => {
    const a = { mergeRects: true, deleteRedundant: true, mergePads: false, repair: true, dryRun: true };
    expect(parseFpCleanupArgs(a)).toEqual(a);
    expect(parseFpCleanupArgs({ ...a, dryRun: 1 })).toBeNull();
    expect(parseFpCleanupArgs({ mergeRects: true })).toBeNull();
  });

  it('a set shows when every key reads back: lengths to KiCad\'s rounding, lists as sets, empty net tie groups dropped', () => {
    const p = baseProps();
    expect(showsFootprintSet({ clearance: 0.1 }, { ...p, clearance: 0.10000001 })).toBe(true);
    expect(showsFootprintSet({ clearance: 0.1 }, p)).toBe(false);
    expect(showsFootprintSet({ netTieGroups: ['1,2', ''] }, { ...p, netTieGroups: ['1,2'] })).toBe(true);
    expect(showsFootprintSet({ jumpers: { duplicateNumbersAreJumpers: false, groups: [['2', '1']] } }, { ...p, jumpers: { duplicateNumbersAreJumpers: false, groups: [['1', '2']] } })).toBe(true);
    expect(showsFootprintSet({ removeField: 'Datasheet' }, p)).toBe(false);
    expect(showsFootprintSet({ customStackup: { on: false, copperLayers: 4 } }, p)).toBe(true);
  });
});

describe('the gate, in order, before any effect', () => {
  it('bad_args, then the frame, then the engine, then busy, then no_footprint', async () => {
    const f = fakeEngine();
    expect(fpFootprintGet({ x: 1 }, fakeCtx(f))).toEqual(err('bad_args', 'fpedit.footprint.get'));
    expect(fpFootprintGet({}, fakeCtx(f, { frame: 'pcb' }))).toEqual(err('unsupported', FRAME_ONLY));
    expect(fpFootprintGet({}, fakeCtx(null))).toEqual(err('not_ready', 'fpedit.footprint.get'));
    const noCheck = fakeEngine();
    delete noCheck.mod.kicadFpEditCheck;
    expect(fpCheck({}, fakeCtx(noCheck))).toEqual(err('unsupported', 'kicadFpEditCheck'));
    expect(await fpSvg({}, fakeCtx(f, { busy: true }))).toEqual(err('busy', 'fpedit.svg'));
    expect(await fpCleanup({ mergeRects: true, deleteRedundant: true, mergePads: true, repair: true, dryRun: true }, fakeCtx(f, { blocked: true }))).toEqual(err('busy', 'fpedit.cleanup'));
    expect(await fpEmbed({ remove: 'x' }, fakeCtx(fakeEngine({ open: false })))).toEqual(err('no_footprint', 'fpedit.embed'));
    expect(f.calls).toEqual([]);
  });

  it('an engine of run 14 (no fpedit exports) answers unsupported naming the first of the set', () => {
    const f = fakeEngine();
    for (const n of FPEDIT_EXPORTS) delete f.mod[n];
    expect(fpFootprintGet({}, fakeCtx(f))).toEqual(err('unsupported', 'kicadFpEditOpen'));
  });
});

describe('the ops', () => {
  it('get answers the properties; a shape it does not know is an island_error', () => {
    expect(fpFootprintGet({}, fakeCtx(fakeEngine()))).toEqual({ ok: true, result: baseProps() });
    expect(fpFootprintGet(undefined, fakeCtx(fakeEngine()))).toEqual({ ok: true, result: baseProps() });
    expect(fpFootprintGet({}, fakeCtx(fakeEngine({ get: '{"name":1}' })))).toEqual(err('island_error', 'the engine answered footprint properties of another shape'));
  });

  it('set sends exactly { set } and answers the properties read back', async () => {
    const f = fakeEngine();
    const set = { description: 'probe', addField: { name: 'MPN', value: 'X', visible: false, layer: 'F.Fab' }, models: [{ ...model, offset: [0, 0, 1] }] };
    const r = await fpFootprintSet({ set }, fakeCtx(f));
    expect(r.ok).toBe(true);
    expect(f.calls).toEqual([{ name: 'set', arg: { set } }]);
    const p = (r as unknown as { result: FootprintProps }).result;
    expect(p.description).toBe('probe');
    expect(p.fields.map((x) => x.name)).toEqual(['Reference', 'Value', 'Datasheet', 'Description', 'MPN']);
    expect(p.models[0].offset).toEqual([0, 0, 1]);
  });

  it('set: userLayerNames other than the get\'s is read only; an engine refusal is bad_args; no read back is not_applied', async () => {
    const f = fakeEngine();
    expect(await fpFootprintSet({ set: { userLayerNames: { 'User.1': 'Mine' } } }, fakeCtx(f))).toEqual(err('bad_args', 'fpedit.footprint.set: userLayerNames is the editor\'s and read only'));
    expect(f.calls).toEqual([]);
    expect((await fpFootprintSet({ set: { userLayerNames: { 'User.1': 'User.1' } } }, fakeCtx(f))).ok).toBe(true);
    expect(await fpFootprintSet({ set: { removeField: 'Reference' } }, fakeCtx(fakeEngine({ refuse: true })))).toEqual(err('bad_args', 'fpedit.footprint.set'));
    expect(await fpFootprintSet({ set: { dnp: true } }, fakeCtx(fakeEngine({ never: true })))).toEqual(err('not_applied', 'fpedit.footprint.set'));
    expect(await fpFootprintSet({ set: {} }, fakeCtx(f))).toEqual(err('bad_args', 'fpedit.footprint.set'));
  });

  it('embed writes the bytes under a fresh /tmp/cc-embed/<n>/, answers once embedded shows the file, and removes the folder', async () => {
    const f = fakeEngine();
    const ctx = fakeCtx(f);
    const bytes = new Uint8Array(1234).fill(7);
    const r = await fpEmbed({ name: 'body.step', type: 'model', bytes }, ctx);
    expect(r.ok).toBe(true);
    expect((r as unknown as { result: FootprintProps }).result.embedded).toEqual([{ name: 'body.step', type: 'model', bytes: 1234 }]);
    expect(f.calls).toEqual([{ name: 'embed', arg: { path: '/tmp/cc-embed/1/body.step', name: 'body.step', type: 'model' } }]);
    expect(ctx.dropped).toEqual(['/tmp/cc-embed/1']);
    expect(f.mem.size).toBe(0);
    const gone = await fpEmbed({ remove: 'body.step' }, ctx);
    expect((gone as unknown as { result: FootprintProps }).result.embedded).toEqual([]);
    expect(await fpEmbed({ remove: 'body.step' }, ctx)).toEqual(err('not_found', 'body.step'));
    expect(f.st.depth).toBe(2);
  });

  it('embed: an engine refusal is bad_args and the folder is still removed', async () => {
    const f = fakeEngine({ refuse: true });
    const ctx = fakeCtx(f);
    expect(await fpEmbed({ name: 'a.pdf', type: 'datasheet', bytes: new Uint8Array([1]) }, ctx)).toEqual(err('bad_args', 'fpedit.embed: KiCad refused the file'));
    expect(ctx.dropped).toEqual(['/tmp/cc-embed/1']);
  });

  it('check answers the findings in KiCad\'s order', () => {
    const r = fpCheck({}, fakeCtx(fakeEngine()));
    expect(r.ok).toBe(true);
    expect(((r as unknown as { result: { findings: Array<{ code: string }> } }).result.findings).map((x) => x.code)).toEqual(['missing_courtyard', 'shorting_items']);
  });

  it('cleanup: a dry run changes nothing; a real one answers once its one undo step shows; nothing found waits for nothing', async () => {
    const f = fakeEngine();
    f.setProps({ ...baseProps(), description: 'tidy' });
    const a = { mergeRects: true, deleteRedundant: true, mergePads: false, repair: true, dryRun: true };
    expect(await fpCleanup(a, fakeCtx(f))).toEqual({ ok: true, result: { items: [{ code: 'null_graphic', uuids: [U(7)] }], repaired: 0 } });
    await settle(10);
    expect(f.st.depth).toBe(0);
    expect(await fpCleanup({ ...a, dryRun: false }, fakeCtx(f))).toEqual({ ok: true, result: { items: [{ code: 'null_graphic', uuids: [U(7)] }], repaired: 0 } });
    expect(f.st.depth).toBe(1);
    expect(await fpCleanup({ ...a, dryRun: false }, fakeCtx(f))).toEqual({ ok: true, result: { items: [], repaired: 0 } });
    expect(f.st.depth).toBe(1);
    const stuck = fakeEngine({ never: true });
    stuck.setProps({ ...baseProps(), description: 'tidy' });
    expect(await fpCleanup({ ...a, dryRun: false }, fakeCtx(stuck))).toEqual(err('not_applied', 'fpedit.cleanup'));
  });

  it('svg plots into a fresh /tmp/cc-svg/<n>, answers the bytes transferred, removes the folder', async () => {
    const f = fakeEngine();
    const ctx = fakeCtx(f);
    const r = await fpSvg({}, ctx);
    expect(r.ok).toBe(true);
    const bytes = (r as unknown as { result: { bytes: Uint8Array }; transfer: ArrayBuffer[] }).result.bytes;
    expect(new TextDecoder().decode(bytes)).toBe('<svg/>');
    expect((r as unknown as { transfer: ArrayBuffer[] }).transfer).toEqual([bytes.buffer]);
    expect(f.calls).toEqual([{ name: 'svg', arg: { dir: '/tmp/cc-svg/1' } }]);
    expect(ctx.dropped).toEqual(['/tmp/cc-svg/1']);
  });

  it('svg: KiCad\'s failure or an empty file is plot_failed, past 4 MiB an island_error, a refusal not_applied', async () => {
    expect(await fpSvg({}, fakeCtx(fakeEngine({ svg: 'failed' })))).toEqual(err('plot_failed', 'KiCad wrote no SVG'));
    expect(await fpSvg({}, fakeCtx(fakeEngine({ svg: 'empty' })))).toEqual(err('plot_failed', 'KiCad wrote no SVG'));
    expect(await fpSvg({}, fakeCtx(fakeEngine({ svg: 'huge' })))).toEqual(err('island_error', 'the SVG is larger than the protocol carries'));
    expect(await fpSvg({}, fakeCtx(fakeEngine({ refuse: true })))).toEqual(err('not_applied', 'fpedit.svg'));
    expect(await fpSvg({ x: 1 }, fakeCtx(fakeEngine()))).toEqual(err('bad_args', 'fpedit.svg'));
  });
});
