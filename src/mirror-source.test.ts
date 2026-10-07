// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { describe, expect, it } from 'vitest';
import { memoryBundleStore, openIdbBundleStore, type BundleStore } from '../loader/src/wasm/libs/bundle-store';
import { checkManifest, checkSearchIndex, mirrorLibsSource, parseBundle, type MirrorSourceOptions } from '../loader/src/wasm/libs/mirror-source';

const TAG = '10.0.4';
const BASE = `/libs/${TAG}/`;
const enc = new TextEncoder();

/** A ccl2 bundle (LIBRARY.md): one JSON line, a newline, the bodies in items order. */
function bundleBytes(id: string, kind: string, items: Array<[string, string]>, header?: Record<string, unknown>): Uint8Array {
  const bodies = items.map(([, b]) => enc.encode(b));
  const head = JSON.stringify(header ?? { v: 2, id, kind, items: items.map(([n], i) => [n, bodies[i].length]) });
  const out = new Uint8Array(enc.encode(`${head}\n`).length + bodies.reduce((n, b) => n + b.length, 0));
  let off = 0;
  for (const part of [enc.encode(`${head}\n`), ...bodies]) { out.set(part, off); off += part.length; }
  return out;
}

const DEVICE: Array<[string, string]> = [['C', '(kicad_symbol_lib (symbol "C"))'], ['R', '(kicad_symbol_lib (symbol "R" (property "Value" "Ω")))']];
const POWER: Array<[string, string]> = [['GND', '(kicad_symbol_lib (symbol "GND"))']];
const RES_SMD: Array<[string, string]> = [['R_0603_1608Metric', '(footprint "R_0603_1608Metric")']];

function manifestOf(extra: Array<Record<string, unknown>> = []) {
  return {
    schema: 1,
    tag: TAG,
    libs: [
      { id: 'fp.Resistor_SMD', name: 'Resistor_SMD', kind: 'footprint', itemCount: 1, bytes: 300, description: 'Resistor SMD' },
      { id: 'sym.Device', name: 'Device', kind: 'symbol', itemCount: 2, bytes: 1000, description: 'Generic symbols' },
      { id: 'sym.power', name: 'power', kind: 'symbol', itemCount: 1, bytes: 200 },
      ...extra,
    ],
  };
}

/** A fake network over a table of path -> answer; every request is recorded. */
function fakeNet(table: Record<string, () => Response | Promise<Response>>) {
  const calls: string[] = [];
  const inits: Array<RequestInit | undefined> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    inits.push(init);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      const answer = table[url];
      return answer ? await answer() : new Response('', { status: 404 });
    } finally {
      inFlight--;
    }
  }) as typeof fetch;
  return {
    fetchImpl,
    calls,
    inits,
    max: () => maxInFlight,
    bundleCalls: () => calls.filter((c) => c.endsWith('.bin')),
    /** The priority each request to `url` was made with (undefined: none given). */
    priorities: (url: string) => calls.flatMap((c, i) => (c === url ? [inits[i]?.priority] : [])),
  };
}

const json = (v: unknown) => () => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
const bytes = (b: Uint8Array) => () => new Response(b.slice(), { status: 200 });

function standardTable(): Record<string, () => Response | Promise<Response>> {
  return {
    [`${BASE}manifest.json`]: json(manifestOf()),
    [`${BASE}sym.Device.bin`]: bytes(bundleBytes('sym.Device', 'symbol', DEVICE)),
    [`${BASE}sym.power.bin`]: bytes(bundleBytes('sym.power', 'symbol', POWER)),
    [`${BASE}fp.Resistor_SMD.bin`]: bytes(bundleBytes('fp.Resistor_SMD', 'footprint', RES_SMD)),
    [`${BASE}fp-index.json`]: () => new Response('{"schema":1,"tag":"10.0.4","libs":{"fp.Resistor_SMD":[["R_0603_1608Metric",2]]}}', { status: 200 }),
  };
}

function source(net: ReturnType<typeof fakeNet>, store: BundleStore | null = memoryBundleStore(), more: Partial<MirrorSourceOptions> = {}) {
  return mirrorLibsSource({ base: BASE, tag: TAG, fetchImpl: net.fetchImpl, storeFactory: async () => store, retryDelaysMs: [0, 0, 0], ...more });
}

describe('the mirror source', () => {
  it('lists the libraries of the kind asked for, as origin libraries with their counts and descriptions', async () => {
    const net = fakeNet(standardTable());
    const src = source(net);
    expect(await src.listLibs('symbol')).toEqual([
      { id: 'sym.Device', name: 'Device', description: 'Generic symbols', type: 'origin', itemCount: 2 },
      { id: 'sym.power', name: 'power', description: null, type: 'origin', itemCount: 1 },
    ]);
    expect((await src.listLibs('footprint')).map((l) => l.id)).toEqual(['fp.Resistor_SMD']);
    expect((await src.listLibs()).map((l) => l.id)).toEqual(['fp.Resistor_SMD', 'sym.Device', 'sym.power']);
    // The manifest was read once for all of them, and no bundle was touched.
    expect(net.calls).toEqual([`${BASE}manifest.json`]);
  });

  it('fetches a bundle once across listItems, getAllItems and getItemBody, concurrent asks included', async () => {
    const net = fakeNet(standardTable());
    const src = source(net);
    const [items, all, r, missing] = await Promise.all([
      src.listItems('sym.Device'),
      src.getAllItems!('sym.Device'),
      src.getItemBody('sym.Device', 'symbol', 'R'),
      src.getItemBody('sym.Device', 'symbol', 'X'),
    ]);
    expect(items).toEqual([{ kind: 'symbol', name: 'C' }, { kind: 'symbol', name: 'R' }]);
    expect(all.map((i) => [i.kind, i.name, new TextDecoder().decode(i.body)])).toEqual(DEVICE.map(([n, b]) => ['symbol', n, b]));
    expect(r).toBe(DEVICE[1][1]);
    expect(missing).toBeNull();
    expect(await src.getItemBody('sym.Device', 'footprint', 'R')).toBeNull();   // another kind's name is not in a symbol bundle
    expect(await src.getItemBody('sym.Device', 'symbol', 'C')).toBe(DEVICE[0][1]);
    expect(net.bundleCalls()).toEqual([`${BASE}sym.Device.bin`]);
  });

  it('answers a library the mirror does not have with nothing, and never fetches it', async () => {
    const net = fakeNet(standardTable());
    const src = source(net);
    expect(await src.listItems('sym.Nope')).toEqual([]);
    expect(await src.getAllItems!('../../etc')).toEqual([]);
    expect(await src.getItemBody('sym.Nope', 'symbol', 'R')).toBeNull();
    expect(net.bundleCalls()).toEqual([]);
  });

  it('hands the bodies over as views onto the one buffer of their bundle', async () => {
    const net = fakeNet(standardTable());
    const all = await source(net).getAllItems!('sym.Device');
    const buffers = new Set(all.map((i) => i.body.buffer));
    expect(buffers.size).toBe(1);
    const whole = new Uint8Array(all[0].body.buffer);
    const raw = bundleBytes('sym.Device', 'symbol', DEVICE);
    expect(whole.length).toBe(raw.length);
    // Each view sits where its bytes are, after the header line.
    expect(all[0].body.byteOffset).toBe(raw.indexOf(0x0a) + 1);
    expect(all[1].body.byteOffset).toBe(all[0].body.byteOffset + all[0].body.length);
  });

  it('serves a second session from the store: no bundle fetched, the manifest read once', async () => {
    const store = memoryBundleStore();
    const first = fakeNet(standardTable());
    const a = source(first, store);
    await a.getAllItems!('sym.Device');
    await a.getAllItems!('fp.Resistor_SMD');
    expect([...store.map.keys()].sort()).toEqual([`${TAG}/fp.Resistor_SMD`, `${TAG}/sym.Device`]);

    const second = fakeNet(standardTable());
    const b = source(second, store);
    expect((await b.getAllItems!('sym.Device')).map((i) => i.name)).toEqual(['C', 'R']);
    expect(await b.getItemBody('fp.Resistor_SMD', 'footprint', 'R_0603_1608Metric')).toBe(RES_SMD[0][1]);
    expect(await b.listItems('sym.Device')).toHaveLength(2);
    expect(second.bundleCalls()).toEqual([]);
    expect(second.calls).toEqual([`${BASE}manifest.json`]);
  });

  it('keeps nothing from a bundle that fails its check, and fetches it again on the next ask', async () => {
    const good = bundleBytes('sym.Device', 'symbol', DEVICE);
    const bad: Record<string, Uint8Array> = {
      'truncated': good.subarray(0, good.length - 3),
      'longer than its items': (() => { const b = new Uint8Array(good.length + 1); b.set(good); b[good.length] = 0x29; return b; })(),
      'another id': bundleBytes('sym.Device', 'symbol', DEVICE, { v: 2, id: 'sym.power', kind: 'symbol', items: [['C', 30], ['R', 50]] }),
      // ccl1: the same framing, but symbol bodies that carried their chains. Refused.
      'version 1 (ccl1)': bundleBytes('sym.Device', 'symbol', DEVICE, { v: 1, id: 'sym.Device', kind: 'symbol', items: DEVICE.map(([n, b]) => [n, enc.encode(b).length]) }),
      'version 3': bundleBytes('sym.Device', 'symbol', [], { v: 3, id: 'sym.Device', kind: 'symbol', items: [] }),
      'another kind': bundleBytes('sym.Device', 'footprint', []),
      'no header line': enc.encode('{"v":2,"id":"sym.Device","kind":"symbol","items":[]}'),
      'a header that is not JSON': enc.encode('ccl1 sym.Device\n'),
      'a name twice': bundleBytes('sym.Device', 'symbol', [['R', 'a'], ['R', 'b']]),
      'a negative length': bundleBytes('sym.Device', 'symbol', [], { v: 2, id: 'sym.Device', kind: 'symbol', items: [['R', -1]] }),
      'an empty name': bundleBytes('sym.Device', 'symbol', [['', 'a']]),
      'a short file': new Uint8Array(0),
    };
    for (const [why, b] of Object.entries(bad)) {
      const table = standardTable();
      let served = b;
      table[`${BASE}sym.Device.bin`] = () => new Response(served.slice(), { status: 200 });
      const net = fakeNet(table);
      const store = memoryBundleStore();
      const src = source(net, store);
      await expect(src.getAllItems!('sym.Device'), why).rejects.toThrow(/bundle sym\.Device/);
      expect(store.map.size, why).toBe(0);
      // The failure is not kept: once the server mends it, the next ask fetches and keeps it.
      served = good;
      expect((await src.listItems('sym.Device')).length, why).toBe(2);
      expect(net.bundleCalls(), why).toEqual([`${BASE}sym.Device.bin`, `${BASE}sym.Device.bin`]);
      expect([...store.map.keys()], why).toEqual([`${TAG}/sym.Device`]);
    }
  });

  it('does not keep a bundle the server refuses', async () => {
    const table = standardTable();
    table[`${BASE}sym.Device.bin`] = () => new Response('', { status: 503 });
    const store = memoryBundleStore();
    await expect(source(fakeNet(table), store).getAllItems!('sym.Device')).rejects.toThrow('HTTP 503');
    expect(store.map.size).toBe(0);
  });

  it('fetches again a stored bundle that no longer passes its check', async () => {
    const store = memoryBundleStore();
    store.map.set(`${TAG}/sym.Device`, enc.encode('{"v":2,"id":"sym.Device","kind":"symbol","items":[["R",999]]}\n(oops'));
    const net = fakeNet(standardTable());
    expect(await source(net, store).listItems('sym.Device')).toHaveLength(2);
    expect(net.bundleCalls()).toEqual([`${BASE}sym.Device.bin`]);
    expect(parseBundle(store.map.get(`${TAG}/sym.Device`)!, 'sym.Device', 'symbol').names).toEqual(['C', 'R']);
  });

  it('removes the stored bundles of every other tag on its first open, and keeps its own', async () => {
    const store = memoryBundleStore();
    store.map.set('10.0.3/sym.Device', enc.encode('old'));
    store.map.set('9.0.0/fp.Resistor_SMD', enc.encode('older'));
    store.map.set(`${TAG}/sym.power`, bundleBytes('sym.power', 'symbol', POWER));
    const net = fakeNet(standardTable());
    const src = source(net, store);
    expect(await src.getItemBody('sym.power', 'symbol', 'GND')).toBe(POWER[0][1]);
    expect([...store.map.keys()]).toEqual([`${TAG}/sym.power`]);
    expect(net.bundleCalls()).toEqual([]);
  });

  it('runs on memory alone when there is no IndexedDB, or the store throws, and still fetches each bundle once', async () => {
    const throwing: BundleStore = {
      get: async () => { throw new Error('IDB read'); },
      put: async () => { throw new Error('QuotaExceededError'); },
      keys: async () => { throw new Error('IDB keys'); },
      delete: async () => { throw new Error('IDB delete'); },
    };
    const refusing: BundleStore = { ...memoryBundleStore(), put: async () => false };
    for (const [name, factory] of [
      ['no IndexedDB', async () => null],
      ['an open that throws', async () => { throw new Error('SecurityError'); }],
      ['a store that throws', async () => throwing],
      ['a store that refuses writes', async () => refusing],
    ] as const) {
      const net = fakeNet(standardTable());
      const src = source(net, null, { storeFactory: factory });
      expect(await src.listItems('sym.Device'), name).toHaveLength(2);
      expect(await src.getItemBody('sym.Device', 'symbol', 'R'), name).toBe(DEVICE[1][1]);
      const state = await src.syncState!('symbol');
      expect(state?.warm, name).toBe(1);
      expect(net.bundleCalls(), name).toEqual([`${BASE}sym.Device.bin`]);
    }
  });

  it('keeps only a bounded window of bundles in memory, and reads an evicted one back from the store', async () => {
    const store = memoryBundleStore();
    const net = fakeNet(standardTable());
    const src = source(net, store, { memoryBytes: 1 });   // the newest bundle only
    await src.listItems('sym.Device');
    await src.listItems('sym.power');
    let reads = 0;
    const get = store.get.bind(store);
    store.get = async (k) => { reads++; return get(k); };
    expect(await src.getItemBody('sym.Device', 'symbol', 'C')).toBe(DEVICE[0][1]);
    expect(reads).toBe(1);
    expect(net.bundleCalls()).toEqual([`${BASE}sym.Device.bin`, `${BASE}sym.power.bin`]);
  });
});

describe('the manifest', () => {
  it('is retried after a network failure or a 5xx, and read once it answers', async () => {
    let n = 0;
    const table = standardTable();
    table[`${BASE}manifest.json`] = () => {
      n++;
      if (n === 1) throw new TypeError('Failed to fetch');
      if (n === 2) return new Response('', { status: 502 });
      return json(manifestOf())();
    };
    const net = fakeNet(table);
    const src = source(net);
    await src.ready();
    expect(n).toBe(3);
    expect(await src.listLibs('symbol')).toHaveLength(2);
    expect(n).toBe(3);
  });

  it('is not retried after a 404 or a manifest of another tag, and a failure is never kept', async () => {
    let status = 404;
    let n = 0;
    const table = standardTable();
    table[`${BASE}manifest.json`] = () => { n++; return status === 404 ? new Response('', { status }) : json({ ...manifestOf(), tag: '9.0.0' })(); };
    const src = source(fakeNet(table));
    await expect(src.ready()).rejects.toThrow('404');
    expect(n).toBe(1);
    status = 200;
    await expect(src.listLibs()).rejects.toThrow('tag "9.0.0"');
    expect(n).toBe(2);
    table[`${BASE}manifest.json`] = json(manifestOf());
    expect(await src.listLibs()).toHaveLength(3);
  });

  it('gives up after its retries', async () => {
    const table = standardTable();
    let n = 0;
    table[`${BASE}manifest.json`] = () => { n++; return new Response('', { status: 500 }); };
    await expect(source(fakeNet(table)).ready()).rejects.toThrow('HTTP 500');
    expect(n).toBe(4);
  });

  it('drops entries that do not fit the contract and keeps the rest', () => {
    const { manifest, dropped } = checkManifest(manifestOf([
      { id: 'fp.Device', name: 'Device', kind: 'symbol', itemCount: 1, bytes: 1 },   // prefix and kind disagree
      { id: 'sym.Device', name: 'Device', kind: 'symbol', itemCount: 1, bytes: 1 },  // the id twice
      { id: 'sym.X', name: 'X', kind: 'model3d', itemCount: 1, bytes: 1 },
      { id: 'sym.Y', name: '', kind: 'symbol' },
      { id: 'sym.Z', name: 'Z', kind: 'symbol', bytes: -4 },
    ]), TAG);
    expect(dropped).toBe(5);
    expect(manifest.libs.map((l) => l.id)).toEqual(['fp.Resistor_SMD', 'sym.Device', 'sym.power']);
    expect(() => checkManifest({ schema: 2, tag: TAG, libs: [] }, TAG)).toThrow('schema 1');
  });
});

describe('the footprint index', () => {
  it('is passed through as text, read once', async () => {
    const net = fakeNet(standardTable());
    const src = source(net);
    const text = await src.getFpIndex!();
    expect(text).toBe('{"schema":1,"tag":"10.0.4","libs":{"fp.Resistor_SMD":[["R_0603_1608Metric",2]]}}');
    expect(await src.getFpIndex!()).toBe(text);
    expect(net.calls.filter((c) => c.endsWith('fp-index.json'))).toHaveLength(1);
  });

  it('is null on a 404 or an error, and the null is not kept', async () => {
    const table = standardTable();
    const answers: Array<() => Response> = [() => new Response('', { status: 404 }), () => { throw new TypeError('Failed to fetch'); }, () => new Response('{"libs":{}}', { status: 200 })];
    table[`${BASE}fp-index.json`] = () => answers.shift()!();
    const net = fakeNet(table);
    const src = source(net);
    expect(await src.getFpIndex!()).toBeNull();
    expect(await src.getFpIndex!()).toBeNull();
    expect(await src.getFpIndex!()).toBe('{"libs":{}}');
    expect(await src.getFpIndex!()).toBe('{"libs":{}}');
    expect(net.calls.filter((c) => c.endsWith('fp-index.json'))).toHaveLength(3);
  });
});

describe('presync and syncState', () => {
  it('fetch the libraries of a kind with bounded concurrency, report progress per library, and skip stored ones', async () => {
    const libs = Array.from({ length: 7 }, (_, i) => ({ id: `fp.L${i}`, name: `L${i}`, kind: 'footprint', itemCount: 1, bytes: 10 + i }));
    const table: Record<string, () => Response | Promise<Response>> = { [`${BASE}manifest.json`]: json({ schema: 1, tag: TAG, libs }) };
    for (const l of libs) table[`${BASE}${l.id}.bin`] = async () => { await new Promise((r) => setTimeout(r, 5)); return bytes(bundleBytes(l.id, 'footprint', [['F', '(footprint "F")']]))(); };
    const store = memoryBundleStore();
    store.map.set(`${TAG}/fp.L3`, bundleBytes('fp.L3', 'footprint', [['F', '(footprint "F")']]));
    const net = fakeNet(table);
    const src = source(net, store);
    expect(await src.syncState!('footprint')).toEqual({ total: 7, warm: 1, coldBytes: 10 + 11 + 12 + 14 + 15 + 16, sizesKnown: true });
    const progress: Array<{ done: number; total: number; current: string }> = [];
    await src.presync!({ kind: 'footprint', concurrency: 2, onProgress: (p) => progress.push(p) });
    expect(net.max()).toBe(2 + 0);   // the manifest was read before, so only bundles were in flight
    expect(net.bundleCalls()).toHaveLength(6);
    expect(progress[0]).toEqual({ done: 0, total: 7, current: '' });
    expect(progress.map((p) => p.done)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(new Set(progress.slice(1).map((p) => p.current))).toEqual(new Set(libs.map((l) => l.name)));
    expect(await src.syncState!('footprint')).toEqual({ total: 7, warm: 7, coldBytes: 0, sizesKnown: true });
    // Warm: a second presync fetches nothing.
    await src.presync!({ kind: 'footprint' });
    expect(net.bundleCalls()).toHaveLength(6);
    // A later read of a presynced library needs no network.
    expect(await src.getItemBody('fp.L5', 'footprint', 'F')).toBe('(footprint "F")');
    expect(net.bundleCalls()).toHaveLength(6);
  });

  it('presync stops between libraries once aborted, never rejects, and shares a fetch with the engine', async () => {
    const libs = Array.from({ length: 6 }, (_, i) => ({ id: `sym.L${i}`, name: `L${i}`, kind: 'symbol', itemCount: 1, bytes: 1 }));
    const table: Record<string, () => Response | Promise<Response>> = { [`${BASE}manifest.json`]: json({ schema: 1, tag: TAG, libs }) };
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    for (const l of libs) table[`${BASE}${l.id}.bin`] = async () => { await gate; return bytes(bundleBytes(l.id, 'symbol', [['S', '(kicad_symbol_lib)']]))(); };
    const net = fakeNet(table);
    const src = source(net);
    const ctl = new AbortController();
    const done: number[] = [];
    const run = src.presync!({ kind: 'symbol', concurrency: 2, signal: ctl.signal, onProgress: (p) => done.push(p.done) });
    await new Promise((r) => setTimeout(r, 0));
    // The engine asks for L0 while the presync has it in flight: one fetch for both.
    const engine = src.listItems('sym.L0');
    await new Promise((r) => setTimeout(r, 0));
    ctl.abort();
    release();
    await expect(run).resolves.toBeUndefined();
    expect(await engine).toEqual([{ kind: 'symbol', name: 'S' }]);
    expect(net.bundleCalls()).toEqual([`${BASE}sym.L0.bin`, `${BASE}sym.L1.bin`]);
    expect(done).toEqual([0]);
  });

  it('presync goes on past a library that fails, which still loads later', async () => {
    const table = standardTable();
    let device = 0;
    table[`${BASE}sym.Device.bin`] = () => (++device === 1 ? new Response('', { status: 500 }) : bytes(bundleBytes('sym.Device', 'symbol', DEVICE))());
    const net = fakeNet(table);
    const src = source(net);
    const done: number[] = [];
    await src.presync!({ kind: 'symbol', onProgress: (p) => done.push(p.done) });
    expect(done).toEqual([0, 1, 2]);
    expect(await src.syncState!('symbol')).toMatchObject({ total: 2, warm: 1 });
    expect(await src.listItems('sym.Device')).toHaveLength(2);
    expect(net.bundleCalls()).toEqual([`${BASE}sym.Device.bin`, `${BASE}sym.power.bin`, `${BASE}sym.Device.bin`]);
  });

  it('presync is quiet when the manifest cannot be read', async () => {
    const net = fakeNet({});
    await expect(source(net).presync!({ kind: 'symbol' })).resolves.toBeUndefined();
  });

  it('syncState says when sizes are unknown', async () => {
    const m = manifestOf();
    delete (m.libs[1] as { bytes?: number }).bytes;
    const table = standardTable();
    table[`${BASE}manifest.json`] = json(m);
    expect(await source(fakeNet(table)).syncState!('symbol')).toEqual({ total: 2, warm: 0, coldBytes: 200, sizesKnown: false });
  });
});

describe('the bundle store', () => {
  it('is null without IndexedDB, or when the open throws', async () => {
    expect(await openIdbBundleStore(undefined)).toBeNull();
    const throwing = { open: () => { throw new DOMException('denied', 'SecurityError'); } } as unknown as IDBFactory;
    expect(await openIdbBundleStore(throwing)).toBeNull();
  });

  it('is null when the open never settles', async () => {
    const stuck = { open: () => ({}) } as unknown as IDBFactory;
    expect(await openIdbBundleStore(stuck, 10)).toBeNull();
  });
});

// ---------------------------------------------------------------- ccl2 symbol bodies

const HEADER = '(version 20251024)\n\t(generator "kicad_symbol_editor")';
const lib1 = (block: string, header = HEADER) => `(kicad_symbol_lib\n\t${header}\n\t${block}\n)\n`;
const BASE_BLOCK = '(symbol "Base"\n\t\t(property "Value" "Base")\n\t\t(symbol "Base_1_1"\n\t\t\t(pin passive line\n\t\t\t\t(number "1")\n\t\t\t)\n\t\t)\n\t)';
const MID_BLOCK = '(symbol "Mid"\n\t\t(extends "Base")\n\t\t(property "Value" "Mid")\n\t)';
const LEAF_BLOCK = '(symbol "Leaf"\n\t\t(extends "Mid")\n\t\t(property "Description" "a leaf (extends \\"Nope\\")")\n\t)';
const CHAIN: Array<[string, string]> = [['Base', lib1(BASE_BLOCK)], ['Leaf', lib1(LEAF_BLOCK, `${HEADER}\n\t(generator_version "10.0")`)], ['Mid', lib1(MID_BLOCK)]];

function chainSource(items: Array<[string, string]> = CHAIN, more: Partial<MirrorSourceOptions> = {}) {
  const table = standardTable();
  table[`${BASE}manifest.json`] = json(manifestOf([{ id: 'sym.Chain', name: 'Chain', kind: 'symbol', itemCount: items.length, bytes: 1 }]));
  table[`${BASE}sym.Chain.bin`] = bytes(bundleBytes('sym.Chain', 'symbol', items));
  const net = fakeNet(table);
  return { net, src: source(net, memoryBundleStore(), more) };
}

describe('a symbol read alone (ccl2)', () => {
  it('assembles a derived symbol\'s chain from the same bundle, root first, under the symbol\'s own header', async () => {
    const { net, src } = chainSource();
    expect(await src.getItemBody('sym.Chain', 'symbol', 'Leaf')).toBe(
      `(kicad_symbol_lib\n\t${HEADER}\n\t(generator_version "10.0")\n\t${BASE_BLOCK}\n\t${MID_BLOCK}\n\t${LEAF_BLOCK}\n)\n`,
    );
    expect(await src.getItemBody('sym.Chain', 'symbol', 'Mid')).toBe(`(kicad_symbol_lib\n\t${HEADER}\n\t${BASE_BLOCK}\n\t${MID_BLOCK}\n)\n`);
    // A symbol that extends nothing is its body unchanged.
    expect(await src.getItemBody('sym.Chain', 'symbol', 'Base')).toBe(CHAIN[0][1]);
    // The fat list is unchanged: each body alone, views onto the bundle.
    const all = await src.getAllItems!('sym.Chain');
    expect(all.map((i) => new TextDecoder().decode(i.body))).toEqual(CHAIN.map(([, b]) => b));
    expect(net.bundleCalls()).toEqual([`${BASE}sym.Chain.bin`]);
  });

  it('finds a parent whose name is written with KiCad escapes', async () => {
    const parent = lib1('(symbol "P\\"A"\n\t\t(property "Value" "x")\n\t)');
    const child = lib1('(symbol "Kid"\n\t\t(extends "P\\x22A")\n\t)');
    const { src } = chainSource([['Kid', child], ['P"A', parent]]);
    expect(await src.getItemBody('sym.Chain', 'symbol', 'Kid')).toBe(`(kicad_symbol_lib\n\t${HEADER}\n\t(symbol "P\\"A"\n\t\t(property "Value" "x")\n\t)\n\t(symbol "Kid"\n\t\t(extends "P\\x22A")\n\t)\n)\n`);
  });

  it('gives the body as it is, and logs, when a parent is missing, unreadable, or the chain is a cycle', async () => {
    const cases: Array<[string, Array<[string, string]>, string, RegExp]> = [
      ['missing', [['Leaf', CHAIN[1][1]], ['Mid', CHAIN[2][1]]], 'Leaf', /Leaf: its parent Base is not in the library; the body is given without its chain \(sym\.Chain\)/],
      ['unreadable', [['Base', '(kicad_symbol_lib\n\t(symbol "Base"\n'], ['Mid', CHAIN[2][1]]], 'Mid', /Mid: its parent Base is unreadable/],
      ['cycle', [['A', lib1('(symbol "A"\n\t\t(extends "B")\n\t)')], ['B', lib1('(symbol "B"\n\t\t(extends "A")\n\t)')]], 'A', /A: extends cycle at A/],
      ['self', [['S', lib1('(symbol "S"\n\t\t(extends "S")\n\t)')]], 'S', /S: extends cycle at S/],
    ];
    for (const [why, items, name, line] of cases) {
      const log: string[] = [];
      const { src } = chainSource(items, { log: (m) => log.push(m) });
      expect(await src.getItemBody('sym.Chain', 'symbol', name), why).toBe(items.find(([n]) => n === name)![1]);
      expect(log.some((m) => line.test(m)), `${why}: ${log.join(' | ')}`).toBe(true);
    }
  });

  it('never assembles a footprint: its body is the .kicad_mod text', async () => {
    const mod = '(footprint "F"\n\t(extends "G")\n)\n';
    const table = standardTable();
    table[`${BASE}fp.Resistor_SMD.bin`] = bytes(bundleBytes('fp.Resistor_SMD', 'footprint', [['R_0603_1608Metric', mod]]));
    expect(await source(fakeNet(table)).getItemBody('fp.Resistor_SMD', 'footprint', 'R_0603_1608Metric')).toBe(mod);
  });
});

// ---------------------------------------------------------------- the search indexes

const SYM_INDEX_TEXT = JSON.stringify({ schema: 1, tag: TAG, fields: ['lib', 'name', 'desc', 'keys', 'fp', 'pins', 'units', 'power'], rows: [['Device', 'R', 'Resistor', 'R res resistor', '', 2, 1, 0]] });
const FP_SEARCH_TEXT = JSON.stringify({ schema: 1, tag: TAG, fields: ['lib', 'name', 'desc', 'tags', 'pads'], rows: [['Resistor_SMD', 'R_0603_1608Metric', 'Resistor SMD 0603', 'resistor', 2]] });

function indexTable(): Record<string, () => Response | Promise<Response>> {
  const table = standardTable();
  table[`${BASE}sym-index.json`] = () => new Response(SYM_INDEX_TEXT, { status: 200 });
  table[`${BASE}fp-search.json`] = () => new Response(FP_SEARCH_TEXT, { status: 200 });
  return table;
}
const indexCalls = (net: ReturnType<typeof fakeNet>) => net.calls.filter((c) => c.endsWith('sym-index.json') || c.endsWith('fp-search.json'));

describe('getSearchIndex', () => {
  it('reads each kind\'s index once per session, concurrent asks included, and keeps it in IndexedDB under <tag>/index:<kind>', async () => {
    const store = memoryBundleStore();
    const net = fakeNet(indexTable());
    const src = source(net, store);
    const [a, b, f] = await Promise.all([src.getSearchIndex('symbol'), src.getSearchIndex('symbol'), src.getSearchIndex('footprint')]);
    expect(a).toBe(SYM_INDEX_TEXT);
    expect(b).toBe(SYM_INDEX_TEXT);
    expect(f).toBe(FP_SEARCH_TEXT);
    expect(await src.getSearchIndex('symbol')).toBe(SYM_INDEX_TEXT);
    expect(indexCalls(net)).toEqual([`${BASE}sym-index.json`, `${BASE}fp-search.json`]);
    expect(new TextDecoder().decode(store.map.get(`${TAG}/index:symbol`)!)).toBe(SYM_INDEX_TEXT);
    expect(new TextDecoder().decode(store.map.get(`${TAG}/index:footprint`)!)).toBe(FP_SEARCH_TEXT);
    // A new session on the same storage: no index request.
    const next = fakeNet(indexTable());
    expect(await source(next, store).getSearchIndex('symbol')).toBe(SYM_INDEX_TEXT);
    expect(indexCalls(next)).toEqual([]);
    // The index keys are of this tag: the next session's tag sweep keeps them, and they are no library.
    expect((await source(next, store).syncState!('symbol'))?.total).toBe(2);
    expect(store.map.has(`${TAG}/index:symbol`)).toBe(true);
  });

  it('passes the priority it is asked for to the fetch', async () => {
    const net = fakeNet(indexTable());
    const src = source(net);
    await src.getSearchIndex('footprint', { priority: 'low' });
    await src.getSearchIndex('symbol');
    expect(net.priorities(`${BASE}fp-search.json`)).toEqual(['low']);
    expect(net.priorities(`${BASE}sym-index.json`)).toEqual([undefined]);
  });

  it('is null after a 404, an error or an index that fails its check; none of that is kept, and the next ask reads again', async () => {
    const answers: Array<() => Response> = [
      () => new Response('', { status: 404 }),
      () => { throw new TypeError('Failed to fetch'); },
      () => new Response('<html>not json</html>', { status: 200 }),
      () => new Response(SYM_INDEX_TEXT.replace(`"tag":"${TAG}"`, '"tag":"9.0.0"'), { status: 200 }),
      () => new Response(FP_SEARCH_TEXT, { status: 200 }),   // the other kind's file: fields out of shape
      () => new Response(JSON.stringify({ schema: 2, tag: TAG, fields: [], rows: [] }), { status: 200 }),
      () => new Response(SYM_INDEX_TEXT, { status: 200 }),
    ];
    const table = indexTable();
    table[`${BASE}sym-index.json`] = () => answers.shift()!();
    const store = memoryBundleStore();
    const log: string[] = [];
    const net = fakeNet(table);
    const src = source(net, store, { log: (m) => log.push(m) });
    for (let i = 0; i < 6; i++) {
      expect(await src.getSearchIndex('symbol'), `answer ${i}`).toBeNull();
      expect(store.map.has(`${TAG}/index:symbol`), `answer ${i}`).toBe(false);
    }
    expect(await src.getSearchIndex('symbol')).toBe(SYM_INDEX_TEXT);
    expect(await src.getSearchIndex('symbol')).toBe(SYM_INDEX_TEXT);
    expect(indexCalls(net)).toHaveLength(7);
    expect(log.filter((m) => m.includes('sym-index.json'))).toHaveLength(6);
  });

  it('is null without a mirror, and asks for no index then', async () => {
    const table = indexTable();
    table[`${BASE}manifest.json`] = () => new Response('', { status: 404 });
    const net = fakeNet(table);
    const src = source(net);
    expect(await src.getSearchIndex('symbol')).toBeNull();
    expect(indexCalls(net)).toEqual([]);
    // Not kept: once the mirror answers, so does the index.
    table[`${BASE}manifest.json`] = json(manifestOf());
    expect(await src.getSearchIndex('symbol')).toBe(SYM_INDEX_TEXT);
  });

  it('fetches again a stored index that fails its check, and runs on memory alone without IndexedDB', async () => {
    const store = memoryBundleStore();
    store.map.set(`${TAG}/index:symbol`, enc.encode('{"schema":1,"tag":"10.0.4","fields":["lib"],"rows":[]}'));
    const net = fakeNet(indexTable());
    expect(await source(net, store).getSearchIndex('symbol')).toBe(SYM_INDEX_TEXT);
    expect(indexCalls(net)).toEqual([`${BASE}sym-index.json`]);
    expect(new TextDecoder().decode(store.map.get(`${TAG}/index:symbol`)!)).toBe(SYM_INDEX_TEXT);

    const bare = fakeNet(indexTable());
    const src = source(bare, null);
    expect(await src.getSearchIndex('symbol')).toBe(SYM_INDEX_TEXT);
    expect(await src.getSearchIndex('symbol')).toBe(SYM_INDEX_TEXT);
    expect(indexCalls(bare)).toEqual([`${BASE}sym-index.json`]);
  });

  it('answers null for a kind that is not symbol or footprint', async () => {
    const net = fakeNet(indexTable());
    expect(await source(net).getSearchIndex('model3d' as never)).toBeNull();
    expect(net.calls).toEqual([]);
  });

  it('checks the shape: schema 1, the tag, the kind\'s fields in order, a list of rows', () => {
    expect(() => checkSearchIndex(SYM_INDEX_TEXT, 'symbol', TAG)).not.toThrow();
    expect(() => checkSearchIndex(FP_SEARCH_TEXT, 'footprint', TAG)).not.toThrow();
    expect(() => checkSearchIndex(SYM_INDEX_TEXT, 'footprint', TAG)).toThrow(/fp-search\.json: fields/);
    expect(() => checkSearchIndex(SYM_INDEX_TEXT, 'symbol', '9.0.0')).toThrow(/tag "10\.0\.4", expected "9\.0\.0"/);
    expect(() => checkSearchIndex(SYM_INDEX_TEXT.replace('"rows":[', '"rowz":['), 'symbol', TAG)).toThrow(/no rows/);
    expect(() => checkSearchIndex('[]', 'symbol', TAG)).toThrow(/not schema 1/);
  });
});

// ---------------------------------------------------------------- prefetch

describe('prefetch', () => {
  it('fetches a bundle at low priority, stores it, and the read that follows needs no network', async () => {
    const store = memoryBundleStore();
    const net = fakeNet(standardTable());
    const src = source(net, store);
    await expect(src.prefetch('sym.Device')).resolves.toBeUndefined();
    expect(net.priorities(`${BASE}sym.Device.bin`)).toEqual(['low']);
    expect([...store.map.keys()]).toEqual([`${TAG}/sym.Device`]);
    let reads = 0;
    const get = store.get.bind(store);
    store.get = async (k) => { reads++; return get(k); };
    expect(await src.getItemBody('sym.Device', 'symbol', 'R')).toBe(DEVICE[1][1]);
    expect(reads).toBe(0);   // held in memory
    await src.prefetch('sym.Device');
    expect(net.bundleCalls()).toEqual([`${BASE}sym.Device.bin`]);
  });

  it('shares one fetch with every other ask of that bundle, whichever starts it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const table = standardTable();
    table[`${BASE}sym.Device.bin`] = async () => { await gate; return bytes(bundleBytes('sym.Device', 'symbol', DEVICE))(); };
    const net = fakeNet(table);
    const src = source(net);
    const engine = src.getAllItems!('sym.Device');
    const pre = [src.prefetch('sym.Device'), src.prefetch('sym.Device')];
    const one = src.getItemBody('sym.Device', 'symbol', 'C');
    await new Promise((r) => setTimeout(r, 0));
    release();
    await Promise.all([engine, one, ...pre]);
    expect(net.bundleCalls()).toEqual([`${BASE}sym.Device.bin`]);
    // The engine started it, so it went out at the default priority.
    expect(net.priorities(`${BASE}sym.Device.bin`)).toEqual([undefined]);

    // And the other way round: a prefetch in flight serves the engine's ask.
    const net2 = fakeNet(standardTable());
    const src2 = source(net2);
    const p = src2.prefetch('sym.power');
    const names = src2.listItems('sym.power');
    await p;
    expect(await names).toEqual([{ kind: 'symbol', name: 'GND' }]);
    expect(net2.priorities(`${BASE}sym.power.bin`)).toEqual(['low']);
  });

  it('fetches nothing for a stored bundle or a library the mirror does not have', async () => {
    const store = memoryBundleStore();
    store.map.set(`${TAG}/sym.power`, bundleBytes('sym.power', 'symbol', POWER));
    const net = fakeNet(standardTable());
    const src = source(net, store);
    await src.prefetch('sym.power');
    await src.prefetch('sym.Nope');
    await src.prefetch('../../etc');
    expect(net.bundleCalls()).toEqual([]);
  });

  it('never rejects: a refused, malformed or unreachable bundle is logged, not kept, and loads on demand later', async () => {
    const table = standardTable();
    const answers: Array<() => Response> = [
      () => new Response('', { status: 503 }),
      () => new Response('{"v":1,"id":"sym.Device","kind":"symbol","items":[]}\n', { status: 200 }),
      () => { throw new TypeError('Failed to fetch'); },
      () => bytes(bundleBytes('sym.Device', 'symbol', DEVICE))(),
    ];
    table[`${BASE}sym.Device.bin`] = () => answers.shift()!();
    const manifestDown = standardTable();
    manifestDown[`${BASE}manifest.json`] = () => new Response('', { status: 500 });
    const log: string[] = [];
    const store = memoryBundleStore();
    const src = source(fakeNet(table), store, { log: (m) => log.push(m) });
    for (let i = 0; i < 3; i++) await expect(src.prefetch('sym.Device')).resolves.toBeUndefined();
    expect(store.map.size).toBe(0);
    expect(log.filter((m) => m.startsWith('[libs] prefetch sym.Device: '))).toHaveLength(3);
    expect(await src.listItems('sym.Device')).toHaveLength(2);
    await expect(source(fakeNet(manifestDown), store).prefetch('sym.Device')).resolves.toBeUndefined();
  });
});
