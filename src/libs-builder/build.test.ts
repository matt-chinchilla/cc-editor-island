// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The whole mirror, built from the fixture checkouts exactly as LIBRARY.md lays
// it out: manifest.json sorted by id with each bundle's stored size, fp-index
// keyed by fp.<nick>, the picker's sym-index and fp-search, ccl2 symbol bodies
// (the symbol alone), every file gzipped only (level 9, mtime 0) and listed in
// SHA256SUMS, the same sources giving the same bytes, --only limiting the
// build and its indexes, and the read-back check catching a changed file.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeBundle, encodeBundle } from '../../scripts/libs/bundle.mjs';
import { buildMirror, gz, verifyMirror } from '../../scripts/libs/mirror.mjs';
import { parseSymbolLib } from '../../scripts/libs/kicad-symdir.mjs';
import {
  baseBlock, derivedBlock, FP_LICENSE, fixtureSources, gunzip, listDir, ODD, R0603, readBytes, readStoredJson, readStoredText,
  removeDir, sha256, SYM_LICENSE, symbolFile, tempDir, USB_C_LIKE, writeBytes,
} from './kit.mjs';

const text = (b: Uint8Array) => new TextDecoder().decode(b);
const TAG = '10.0.4';
const dirs: string[] = [];
const scratch = (p: string) => { const d = tempDir(p); dirs.push(d); return d; };

let sources: { symbolsSrc: string; footprintsSrc: string };
let mirror: string;
const log: string[] = [];

beforeAll(async () => {
  sources = fixtureSources(scratch('cc-libs-src'));
  const built = await buildMirror({ ...sources, out: scratch('cc-libs-out'), tag: TAG, log: (l) => log.push(l) });
  mirror = built.dir;
  expect(built.skipped).toEqual(['fp.Empty']);
});
afterAll(() => { for (const d of dirs) removeDir(d); });

const bundle = (id: string) => decodeBundle(gunzip(readBytes(`${mirror}/${id}.bin.gz`)));

describe('the built mirror', () => {
  it('holds exactly LIBRARY.md\'s files, every one stored gzipped only', () => {
    expect(listDir(mirror)).toEqual([
      'LICENSE.md.gz', 'SHA256SUMS.gz', 'fp-index.json.gz', 'fp-search.json.gz', 'fp.Connector.bin.gz', 'fp.Resistor_SMD.bin.gz', 'manifest.json.gz',
      'sym-index.json.gz', 'sym.Connector.bin.gz', 'sym.Device.bin.gz', 'sym.Diode.bin.gz', 'sym.Legacy.bin.gz',
    ]);
    for (const name of listDir(mirror)) {
      const z = readBytes(`${mirror}/${name}`);
      expect([z[0], z[1], z[2]], name).toEqual([0x1f, 0x8b, 8]);
      expect([z[4], z[5], z[6], z[7]], `${name} mtime`).toEqual([0, 0, 0, 0]);
      expect(z[8], `${name} level 9 flag`).toBe(2);
    }
  });

  it('writes the manifest sorted by id, with each bundle\'s stored size, item count and lib-table description', () => {
    const m = readStoredJson(mirror, 'manifest.json');
    expect(m.schema).toBe(1);
    expect(m.tag).toBe(TAG);
    const size = (id: string) => readBytes(`${mirror}/${id}.bin.gz`).length;
    expect(m.libs).toEqual([
      { id: 'fp.Connector', name: 'Connector', kind: 'footprint', itemCount: 2, bytes: size('fp.Connector') },
      { id: 'fp.Resistor_SMD', name: 'Resistor_SMD', kind: 'footprint', itemCount: 1, bytes: size('fp.Resistor_SMD'), description: 'Resistors, "SMD"' },
      { id: 'sym.Connector', name: 'Connector', kind: 'symbol', itemCount: 1, bytes: size('sym.Connector'), description: 'Connector symbols' },
      { id: 'sym.Device', name: 'Device', kind: 'symbol', itemCount: 3, bytes: size('sym.Device'), description: 'Generic symbols' },
      { id: 'sym.Diode', name: 'Diode', kind: 'symbol', itemCount: 3, bytes: size('sym.Diode'), description: 'Diodes, "µ" sized' },
      { id: 'sym.Legacy', name: 'Legacy', kind: 'symbol', itemCount: 2, bytes: size('sym.Legacy') },
    ]);
    // An empty descr and a library with no lib-table row both leave description out.
    expect('description' in m.libs[0]).toBe(false);
    expect('description' in m.libs[5]).toBe(false);
  });

  it('writes fp-index keyed by fp.<nick>, each footprint\'s name and unique pad count in bundle order', () => {
    const idx = readStoredJson(mirror, 'fp-index.json');
    expect(idx).toEqual({ schema: 1, tag: TAG, libs: { 'fp.Connector': [['Odd', 9], ['USB_C_Like', 3]], 'fp.Resistor_SMD': [['R_0603', 2]] } });
    expect(bundle('fp.Connector').items.map((i) => i.name)).toEqual(['Odd', 'USB_C_Like']);
  });

  it('stores footprint bodies as the .kicad_mod text, unchanged', () => {
    const b = bundle('fp.Connector');
    expect(b.kind).toBe('footprint');
    expect(b.items.map((i) => text(i.body))).toEqual([ODD, USB_C_LIKE]);
    expect(text(bundle('fp.Resistor_SMD').items[0].body)).toBe(R0603);
  });

  it('stores each symbol body as the symbol alone under its library header (ccl2), a derived one with no chain', () => {
    const device = bundle('sym.Device');
    expect(device.v).toBe(2);
    expect(device.items.map((i) => i.name)).toEqual(['C', 'R', 'Thermistor_µ']);
    expect(text(device.items[1].body)).toBe(symbolFile([baseBlock('R')]));
    expect(text(device.items[2].body)).toContain('10 kΩ NTC, ±1 %');
    const diode = bundle('sym.Diode');
    expect(diode.items.map((i) => i.name)).toEqual(['D_Base', 'D_Leaf', 'D_Mid']);
    // Each is its KiCad file byte for byte: D_Leaf carries neither D_Mid nor D_Base.
    expect(text(diode.items[0].body)).toBe(symbolFile([baseBlock('D_Base')]));
    expect(text(diode.items[1].body)).toBe(symbolFile([derivedBlock('D_Leaf', 'D_Mid')]));
    expect(text(diode.items[2].body)).toBe(symbolFile([derivedBlock('D_Mid', 'D_Base')]));
    // A plain library file: each symbol alone, under that file's header.
    const legacy = bundle('sym.Legacy');
    expect(legacy.items.map((i) => parseSymbolLib(text(i.body)).symbols.map((s) => s.name))).toEqual([['P1'], ['P2']]);
    expect(parseSymbolLib(text(legacy.items[1].body)).header).toBe('(version 20251024)\n\t(generator "tool (symbol \\"fake\\")")');
    expect(text(legacy.items[1].body)).toBe(`(kicad_symbol_lib\n\t(version 20251024)\n\t(generator "tool (symbol \\"fake\\")")\n\t${derivedBlock('P2', 'P1')}\n)\n`);
  });

  it('writes sym-index, one row per symbol sorted by lib then name, desc, keys and fp inherited down the chain', () => {
    const idx = readStoredJson(mirror, 'sym-index.json');
    expect(idx.schema).toBe(1);
    expect(idx.tag).toBe(TAG);
    expect(idx.fields).toEqual(['lib', 'name', 'desc', 'keys', 'fp', 'pins', 'units', 'power']);
    expect(idx.rows).toEqual([
      ['Connector', 'Conn_01x02', '', '', '', 1, 1, 0],
      ['Device', 'C', '', '', '', 1, 1, 0],
      ['Device', 'R', '', '', '', 1, 1, 0],
      ['Device', 'Thermistor_µ', '10 kΩ NTC, ±1 %', '', '', 1, 1, 0],
      ['Diode', 'D_Base', '', '', '', 1, 1, 0],
      ['Diode', 'D_Leaf', '', '', '', 1, 1, 0],
      ['Diode', 'D_Mid', '', '', '', 1, 1, 0],
      ['Legacy', 'P1', '', '', '', 1, 1, 0],
      ['Legacy', 'P2', '', '', '', 1, 1, 0],
    ]);
  });

  it('writes fp-search, one row per footprint with its descr, tags and unique pad count', () => {
    const idx = readStoredJson(mirror, 'fp-search.json');
    expect(idx).toEqual({
      schema: 1, tag: TAG, fields: ['lib', 'name', 'desc', 'tags', 'pads'],
      rows: [['Connector', 'Odd', '', '', 9], ['Connector', 'USB_C_Like', '', '', 3], ['Resistor_SMD', 'R_0603', 'Résistance 0603, 10 kΩ', '', 2]],
    });
  });

  it('ships both repositories\' licenses under a heading each', () => {
    const license = readStoredText(mirror, 'LICENSE.md');
    expect(license).toBe(`# kicad-symbols\n\nAt tag ${TAG}.\n\n${SYM_LICENSE}\n# kicad-footprints\n\nAt tag ${TAG}.\n\n${FP_LICENSE}`);
  });

  it('lists every other file in SHA256SUMS with the sha256 of its stored bytes', () => {
    const lines = readStoredText(mirror, 'SHA256SUMS').split('\n').filter(Boolean);
    const names = listDir(mirror).filter((n) => n !== 'SHA256SUMS.gz');
    expect(lines).toEqual(names.map((n) => `${sha256(readBytes(`${mirror}/${n}`))}  ${n}`));
  });

  it('reads back clean, with its figures', () => {
    const f = verifyMirror(mirror);
    expect(f.tag).toBe(TAG);
    const sym = ['sym.Connector', 'sym.Device', 'sym.Diode', 'sym.Legacy'];
    expect(f.symbol).toEqual({
      libs: 4,
      items: 9,
      bytes: sym.reduce((n, id) => n + readBytes(`${mirror}/${id}.bin.gz`).length, 0),
      raw: sym.reduce((n, id) => n + gunzip(readBytes(`${mirror}/${id}.bin.gz`)).length, 0),
    });
    expect(f.footprint.libs).toBe(2);
    expect(f.footprint.items).toBe(3);
    expect(f.sumsSha256).toBe(sha256(readBytes(`${mirror}/SHA256SUMS.gz`)));
    expect(f.indexes['sym-index.json']).toEqual({ rows: 9, bytes: readBytes(`${mirror}/sym-index.json.gz`).length, raw: gunzip(readBytes(`${mirror}/sym-index.json.gz`)).length });
    expect(f.indexes['fp-search.json'].rows).toBe(3);
  });

  it('is deterministic: a second build from the same sources is byte for byte the same', async () => {
    const again = await buildMirror({ ...sources, out: scratch('cc-libs-again'), tag: TAG, concurrency: 1 });
    expect(listDir(again.dir)).toEqual(listDir(mirror));
    expect(sha256(readBytes(`${again.dir}/SHA256SUMS.gz`))).toBe(sha256(readBytes(`${mirror}/SHA256SUMS.gz`)));
    for (const name of listDir(mirror)) expect(sha256(readBytes(`${again.dir}/${name}`)), name).toBe(sha256(readBytes(`${mirror}/${name}`)));
  });

  it('replaces an earlier local build in place, and never a directory holding anything else', async () => {
    const out = scratch('cc-libs-replace');
    await buildMirror({ ...sources, out, tag: TAG, only: ['sym.Device'] });
    const second = await buildMirror({ ...sources, out, tag: TAG, only: ['fp.Connector'] });
    expect(listDir(second.dir)).toEqual(['LICENSE.md.gz', 'SHA256SUMS.gz', 'fp-index.json.gz', 'fp-search.json.gz', 'fp.Connector.bin.gz', 'manifest.json.gz', 'sym-index.json.gz']);
    writeBytes(`${second.dir}/notes.txt`, 'mine');
    await expect(buildMirror({ ...sources, out, tag: TAG })).rejects.toThrow(/holds more than a mirror's \*\.gz files/);
  });
});

describe('--only', () => {
  it('builds just the named libraries, and the indexes just the libraries among them', async () => {
    const built = await buildMirror({ ...sources, out: scratch('cc-libs-only'), tag: TAG, only: ['sym.Device', 'fp.Resistor_SMD'] });
    expect(listDir(built.dir)).toEqual(['LICENSE.md.gz', 'SHA256SUMS.gz', 'fp-index.json.gz', 'fp-search.json.gz', 'fp.Resistor_SMD.bin.gz', 'manifest.json.gz', 'sym-index.json.gz', 'sym.Device.bin.gz']);
    expect(readStoredJson(built.dir, 'manifest.json').libs.map((l: { id: string }) => l.id)).toEqual(['fp.Resistor_SMD', 'sym.Device']);
    expect(Object.keys(readStoredJson(built.dir, 'fp-index.json').libs)).toEqual(['fp.Resistor_SMD']);
    expect(readStoredJson(built.dir, 'sym-index.json').rows.map((r: string[]) => `${r[0]}:${r[1]}`)).toEqual(['Device:C', 'Device:R', 'Device:Thermistor_µ']);
    expect(readStoredJson(built.dir, 'fp-search.json').rows.map((r: string[]) => `${r[0]}:${r[1]}`)).toEqual(['Resistor_SMD:R_0603']);
    expect(() => verifyMirror(built.dir)).not.toThrow();
    // The same library builds to the same bundle bytes alone or in the full set.
    expect(sha256(readBytes(`${built.dir}/sym.Device.bin.gz`))).toBe(sha256(readBytes(`${mirror}/sym.Device.bin.gz`)));
  });

  it('keeps the symbol-only build\'s fp-index and fp-search empty', async () => {
    const built = await buildMirror({ ...sources, out: scratch('cc-libs-only-sym'), tag: TAG, only: ['sym.Diode'] });
    expect(readStoredJson(built.dir, 'fp-index.json')).toEqual({ schema: 1, tag: TAG, libs: {} });
    expect(readStoredJson(built.dir, 'fp-search.json')).toEqual({ schema: 1, tag: TAG, fields: ['lib', 'name', 'desc', 'tags', 'pads'], rows: [] });
    expect(readStoredJson(built.dir, 'sym-index.json').rows).toHaveLength(3);
    expect(() => verifyMirror(built.dir)).not.toThrow();
  });

  it('refuses an id the sources do not hold, and a bare nickname', async () => {
    await expect(buildMirror({ ...sources, out: scratch('cc-libs-bad'), tag: TAG, only: ['sym.Device', 'sym.Nope', 'Device'] }))
      .rejects.toThrow(/--only names sym\.Nope, Device, which the sources do not hold/);
  });
});

describe('the build refuses', () => {
  it('an extends cycle, a missing parent and a format the pinned fork cannot read', async () => {
    const cyc = fixtureSources(scratch('cc-libs-cycle'), 'cycle');
    await expect(buildMirror({ ...cyc, out: scratch('cc-libs-x'), tag: TAG })).rejects.toThrow(/sym\.Cyclic: extends cycle/);
    const orphan = fixtureSources(scratch('cc-libs-orphan'), 'orphan');
    await expect(buildMirror({ ...orphan, out: scratch('cc-libs-x'), tag: TAG })).rejects.toThrow(/sym\.Orphan: X extends Nope/);
    const future = fixtureSources(scratch('cc-libs-future'), 'future');
    await expect(buildMirror({ ...future, out: scratch('cc-libs-x'), tag: TAG })).rejects.toThrow(/F\.kicad_mod declares footprint version 20990101/);
  });

  it('a tag that cannot be a directory name', async () => {
    await expect(buildMirror({ ...sources, out: scratch('cc-libs-x'), tag: '../up' })).rejects.toThrow(/not one the mirror can use/);
  });
});

describe('the read-back check', () => {
  async function copy(): Promise<string> {
    const built = await buildMirror({ ...sources, out: scratch('cc-libs-tamper'), tag: TAG });
    return built.dir;
  }

  it('catches a file that no longer matches SHA256SUMS', async () => {
    const dir = await copy();
    const z = readBytes(`${dir}/sym.Device.bin.gz`);
    z[z.length - 9] ^= 1;
    writeBytes(`${dir}/sym.Device.bin.gz`, z);
    expect(() => verifyMirror(dir)).toThrow(/sym\.Device\.bin\.gz does not match its SHA256SUMS line/);
  });

  /** Replace a stored file's content and its SHA256SUMS line, so only the deeper checks can catch it. */
  async function restamp(dir: string, name: string, data: Uint8Array | string) {
    const z = await gz(typeof data === 'string' ? new TextEncoder().encode(data) : data);
    writeBytes(`${dir}/${name}.gz`, z);
    const sums = readStoredText(dir, 'SHA256SUMS').split('\n').filter(Boolean)
      .map((line) => (line.endsWith(`  ${name}.gz`) ? `${sha256(z)}  ${name}.gz` : line)).join('\n');
    writeBytes(`${dir}/SHA256SUMS.gz`, await gz(new TextEncoder().encode(`${sums}\n`)));
    return z.length;
  }

  /** Replace sym.Diode's bundle, and its manifest entry to match. */
  async function replaceDiode(dir: string, items: [string, string][], v = 2) {
    let bytes = encodeBundle({ id: 'sym.Diode', kind: 'symbol', items });
    if (v !== 2) bytes = new TextEncoder().encode(new TextDecoder().decode(bytes).replace('{"v":2,', `{"v":${v},`));
    const size = await restamp(dir, 'sym.Diode.bin', bytes);
    const m = readStoredJson(dir, 'manifest.json');
    const lib = m.libs.find((l: { id: string }) => l.id === 'sym.Diode');
    lib.bytes = size;
    lib.itemCount = items.length;
    await restamp(dir, 'manifest.json', JSON.stringify(m));
  }

  it('catches a sym-index row the bundles do not give, a row missing, and fp-search fields out of shape', async () => {
    const dir = await copy();
    const idx = readStoredJson(dir, 'sym-index.json');
    idx.rows[5][4] = 'Diode_THT:D_DO-35';
    await restamp(dir, 'sym-index.json', JSON.stringify(idx));
    expect(() => verifyMirror(dir)).toThrow(/sym-index\.json: row 5 is \["Diode","D_Leaf","","","Diode_THT:D_DO-35",1,1,0\], the bundle says \["Diode","D_Leaf","","","",1,1,0\]/);
    idx.rows[5][4] = '';
    idx.rows.pop();
    await restamp(dir, 'sym-index.json', JSON.stringify(idx));
    expect(() => verifyMirror(dir)).toThrow(/sym-index\.json: row 8 is undefined/);
    idx.rows.push(['Legacy', 'P2', '', '', '', 1, 1, 0], ['Legacy', 'P3', '', '', '', 1, 1, 0]);
    await restamp(dir, 'sym-index.json', JSON.stringify(idx));
    expect(() => verifyMirror(dir)).toThrow(/sym-index\.json has 10 rows, the bundles hold 9 symbols/);
    idx.rows.pop();
    await restamp(dir, 'sym-index.json', JSON.stringify(idx));
    expect(() => verifyMirror(dir)).not.toThrow();
    const fp = readStoredJson(dir, 'fp-search.json');
    await restamp(dir, 'fp-search.json', JSON.stringify({ ...fp, fields: ['lib', 'name', 'desc', 'pads'] }));
    expect(() => verifyMirror(dir)).toThrow(/fp-search\.json fields are \["lib","name","desc","pads"\]/);
  });

  it('catches a symbol body that carries its chain (ccl1), a parent missing from its bundle, and a ccl1 bundle', async () => {
    const dir = await copy();
    const base = symbolFile([baseBlock('D_Base')]);
    const mid = symbolFile([derivedBlock('D_Mid', 'D_Base')]);
    await replaceDiode(dir, [['D_Base', base], ['D_Leaf', symbolFile([baseBlock('D_Base'), derivedBlock('D_Mid', 'D_Base'), derivedBlock('D_Leaf', 'D_Mid')])], ['D_Mid', mid]]);
    expect(() => verifyMirror(dir)).toThrow(/sym\.Diode:D_Leaf: the body holds D_Base, D_Mid, D_Leaf, not the item alone/);
    await replaceDiode(dir, [['D_Leaf', symbolFile([derivedBlock('D_Leaf', 'D_Mid')])], ['D_Mid', mid]]);
    expect(() => verifyMirror(dir)).toThrow(/sym\.Diode: D_Mid extends D_Base, which is not in the library/);
    await replaceDiode(dir, [['D_Base', base], ['D_Leaf', symbolFile([derivedBlock('D_Leaf', 'D_Mid')])], ['D_Mid', mid]], 1);
    expect(() => verifyMirror(dir)).toThrow(/not a ccl2 bundle: version 1/);
    await replaceDiode(dir, [['D_Base', base], ['D_Leaf', symbolFile([derivedBlock('D_Leaf', 'D_Mid')])], ['D_Mid', mid]]);
    expect(() => verifyMirror(dir)).not.toThrow();
  });

  it('catches a file SHA256SUMS does not list, and a stray uncompressed file', async () => {
    const dir = await copy();
    writeBytes(`${dir}/extra.gz`, readBytes(`${dir}/LICENSE.md.gz`));
    expect(() => verifyMirror(dir)).toThrow(/extra\.gz is not in SHA256SUMS/);
    const dir2 = await copy();
    writeBytes(`${dir2}/README`, 'x');
    expect(() => verifyMirror(dir2)).toThrow(/README is not stored gzipped/);
  });
});
