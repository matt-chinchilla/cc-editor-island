// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The whole mirror, built from the fixture checkouts exactly as LIBRARY.md lays
// it out: manifest.json sorted by id with each bundle's stored size, fp-index
// keyed by fp.<nick>, every file gzipped only (level 9, mtime 0) and listed in
// SHA256SUMS, the same sources giving the same bytes, --only limiting the
// build, and the read-back check catching a changed file.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeBundle } from '../../scripts/libs/bundle.mjs';
import { buildMirror, verifyMirror } from '../../scripts/libs/mirror.mjs';
import { parseSymbolLib } from '../../scripts/libs/kicad-symdir.mjs';
import {
  baseBlock, derivedBlock, FP_LICENCE, fixtureSources, gunzip, listDir, ODD, R0603, readBytes, readStoredJson, readStoredText,
  removeDir, sha256, SYM_LICENCE, symbolFile, tempDir, USB_C_LIKE, writeBytes,
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
      'LICENSE.md.gz', 'SHA256SUMS.gz', 'fp-index.json.gz', 'fp.Connector.bin.gz', 'fp.Resistor_SMD.bin.gz', 'manifest.json.gz',
      'sym.Connector.bin.gz', 'sym.Device.bin.gz', 'sym.Diode.bin.gz', 'sym.Legacy.bin.gz',
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

  it('stores symbol bodies self-contained: the file itself, or the chain root first', () => {
    const device = bundle('sym.Device');
    expect(device.items.map((i) => i.name)).toEqual(['C', 'R', 'Thermistor_µ']);
    expect(text(device.items[1].body)).toBe(symbolFile([baseBlock('R')]));
    expect(text(device.items[2].body)).toContain('10 kΩ NTC, ±1 %');
    const diode = bundle('sym.Diode');
    expect(diode.items.map((i) => i.name)).toEqual(['D_Base', 'D_Leaf', 'D_Mid']);
    expect(text(diode.items[1].body)).toBe(symbolFile([baseBlock('D_Base'), derivedBlock('D_Mid', 'D_Base'), derivedBlock('D_Leaf', 'D_Mid')]));
    const legacy = bundle('sym.Legacy');
    expect(parseSymbolLib(text(legacy.items[1].body)).symbols.map((s) => s.name)).toEqual(['P1', 'P2']);
    expect(parseSymbolLib(text(legacy.items[1].body)).header).toBe('(version 20251024)\n\t(generator "tool (symbol \\"fake\\")")');
  });

  it('ships both repositories\' licences under a heading each', () => {
    const licence = readStoredText(mirror, 'LICENSE.md');
    expect(licence).toBe(`# kicad-symbols\n\nAt tag ${TAG}.\n\n${SYM_LICENCE}\n# kicad-footprints\n\nAt tag ${TAG}.\n\n${FP_LICENCE}`);
  });

  it('lists every other file in SHA256SUMS with the sha256 of its stored bytes', () => {
    const lines = readStoredText(mirror, 'SHA256SUMS').split('\n').filter(Boolean);
    const names = listDir(mirror).filter((n) => n !== 'SHA256SUMS.gz');
    expect(lines).toEqual(names.map((n) => `${sha256(readBytes(`${mirror}/${n}`))}  ${n}`));
  });

  it('reads back clean, with its figures', () => {
    const f = verifyMirror(mirror);
    expect(f.tag).toBe(TAG);
    expect(f.symbol).toEqual({ libs: 4, items: 9, bytes: ['sym.Connector', 'sym.Device', 'sym.Diode', 'sym.Legacy'].reduce((n, id) => n + readBytes(`${mirror}/${id}.bin.gz`).length, 0) });
    expect(f.footprint.libs).toBe(2);
    expect(f.footprint.items).toBe(3);
    expect(f.sumsSha256).toBe(sha256(readBytes(`${mirror}/SHA256SUMS.gz`)));
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
    expect(listDir(second.dir)).toEqual(['LICENSE.md.gz', 'SHA256SUMS.gz', 'fp-index.json.gz', 'fp.Connector.bin.gz', 'manifest.json.gz']);
    writeBytes(`${second.dir}/notes.txt`, 'mine');
    await expect(buildMirror({ ...sources, out, tag: TAG })).rejects.toThrow(/holds more than a mirror's \*\.gz files/);
  });
});

describe('--only', () => {
  it('builds just the named libraries, and fp-index just the footprint ones among them', async () => {
    const built = await buildMirror({ ...sources, out: scratch('cc-libs-only'), tag: TAG, only: ['sym.Device', 'fp.Resistor_SMD'] });
    expect(listDir(built.dir)).toEqual(['LICENSE.md.gz', 'SHA256SUMS.gz', 'fp-index.json.gz', 'fp.Resistor_SMD.bin.gz', 'manifest.json.gz', 'sym.Device.bin.gz']);
    expect(readStoredJson(built.dir, 'manifest.json').libs.map((l: { id: string }) => l.id)).toEqual(['fp.Resistor_SMD', 'sym.Device']);
    expect(Object.keys(readStoredJson(built.dir, 'fp-index.json').libs)).toEqual(['fp.Resistor_SMD']);
    expect(() => verifyMirror(built.dir)).not.toThrow();
    // The same library builds to the same bundle bytes alone or in the full set.
    expect(sha256(readBytes(`${built.dir}/sym.Device.bin.gz`))).toBe(sha256(readBytes(`${mirror}/sym.Device.bin.gz`)));
  });

  it('keeps the symbol-only build\'s fp-index empty', async () => {
    const built = await buildMirror({ ...sources, out: scratch('cc-libs-only-sym'), tag: TAG, only: ['sym.Diode'] });
    expect(readStoredJson(built.dir, 'fp-index.json')).toEqual({ schema: 1, tag: TAG, libs: {} });
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

  it('catches a file SHA256SUMS does not list, and a stray uncompressed file', async () => {
    const dir = await copy();
    writeBytes(`${dir}/extra.gz`, readBytes(`${dir}/LICENSE.md.gz`));
    expect(() => verifyMirror(dir)).toThrow(/extra\.gz is not in SHA256SUMS/);
    const dir2 = await copy();
    writeBytes(`${dir2}/README`, 'x');
    expect(() => verifyMirror(dir2)).toThrow(/README is not stored gzipped/);
  });
});
