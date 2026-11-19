// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// si1-i: the compiled model scan on text (pre_osdi, codemodel, d_cosim, each
// file ending refused; a plain .model and .include pass), the included files
// read from a file system of this test's own, and the two widenings as the
// responder calls them, with a ctx and a `next` of this test's own at the
// protocol boundary.
import { describe, expect, it, vi } from 'vitest';
import { fail, ok, type Answer, type ExtUnit, type ResponderCtx } from './contract';
import { REGISTRY } from './registry';
import unit, {
  BINARY_ENDINGS, MAX_SCAN_FILES, isBinaryModelProblem, isBinaryName, logicalLines, refOf, resolvePath, scanNetlist, scanText, widenNetlist, widenRun,
} from './si1-i';

const ROOT = '/tmp/cc-proj/p1';
const OPTS = { voltages: true, currents: true, dissipations: false, events: false };
const enc = new TextEncoder();
const fsOf = (files: Record<string, string | Uint8Array>) => (abs: string): Uint8Array | null => {
  const f = files[abs];
  return f == null ? null : typeof f === 'string' ? enc.encode(f) : f;
};
const src = (files: Record<string, string | Uint8Array> = {}) => ({ root: ROOT, netlistName: 'sim-binary.kicad_sch', read: fsOf(files) });

const RC = [
  '.title KiCad schematic',
  'V1 /in 0 PULSE( 0 5 0 1n 1n 10m 20m )',
  'R1 /in /out 1k',
  'C1 /out 0 1u',
  '.tran 1u 5m',
  '.end',
].join('\n');

describe('the scan on text', () => {
  it('passes a plain circuit, a plain .model and a plain .include', () => {
    const text = `${RC}\n.model DMOD D(is=1e-14)\n.include "${ROOT}/models/bjt.lib"\n.lib "${ROOT}/models/opamps.lib" typ`;
    const r = scanText(text, 'x.kicad_sch');
    expect(r.hits).toEqual([]);
    expect(r.includes).toEqual([`${ROOT}/models/bjt.lib`, `${ROOT}/models/opamps.lib`]);
  });

  it('refuses a line starting pre_osdi or codemodel, with or without a dot, in any case', () => {
    for (const line of ['pre_osdi models/adder.osdi', '  PRE_OSDI adder.osdi', 'codemodel /usr/lib/spice/analog.cm', '.codemodel foo', 'pre_osdi']) {
      const r = scanText(`.control\n${line}\n.endc`, 'x.kicad_sch');
      expect(r.hits, line).toHaveLength(1);
      expect(r.hits[0]!.code).toBe('binary_model');
      expect(r.hits[0]!.severity).toBe('error');
      expect(r.hits[0]!.ref).toBeUndefined();
      expect(r.hits[0]!.text).toBe(line.trim());
    }
    expect(scanText('pre_osdi models/adder.osdi', 'x').hits[0]!.path).toBe('models/adder.osdi');
    expect(scanText('codemodel foo', 'x').hits[0]!.path).toBe('foo');
    // No argument: the file it was read in.
    expect(scanText('pre_osdi', 'x.kicad_sch').hits[0]!.path).toBe('x.kicad_sch');
  });

  it('refuses a d_cosim model and a d_cosim instance, naming the instance designator', () => {
    const model = scanText('.model cosim1 d_cosim simulation="./counter.so"', 'a.lib').hits;
    expect(model).toEqual([{ code: 'binary_model', severity: 'error', path: './counter.so', text: '.model cosim1 d_cosim simulation="./counter.so"' }]);
    const bare = scanText('.model cosim2 d_cosim', 'a.lib').hits;
    expect(bare).toEqual([{ code: 'binary_model', severity: 'error', path: 'a.lib', text: '.model cosim2 d_cosim' }]);
    const inst = scanText('AU3 [ /a /b ] [ /y ] d_cosim', 'net').hits;
    expect(inst).toEqual([{ code: 'binary_model', severity: 'error', ref: 'U3', path: 'net', text: 'AU3 [ /a /b ] [ /y ] d_cosim' }]);
    // A word that only contains it is not it.
    expect(scanText('.model x d_cosimulated', 'a').hits).toEqual([]);
    expect(scanText('.model xd_cosim D', 'a').hits).toEqual([]);
  });

  it('refuses a reference to each compiled file ending, quoted or not, in any case', () => {
    for (const end of BINARY_ENDINGS) {
      for (const line of [`.include "${ROOT}/models/thing${end}"`, `.include models/THING${end.toUpperCase()}`, `.model m1 x file='lib/thing${end}'`]) {
        const r = scanText(line, 'n');
        expect(r.hits, line).toHaveLength(1);
        expect(r.hits[0]!.path.toLowerCase().endsWith(end)).toBe(true);
        // A compiled file is never read as an include.
        expect(r.includes).toEqual([]);
      }
    }
    expect(isBinaryName('.so')).toBe(false);
    expect(isBinaryName('a.lib')).toBe(false);
    expect(isBinaryName('a.cmx')).toBe(false);
    expect(isBinaryName('model.sub')).toBe(false);
  });

  it('reads comments and continuations as ngspice does: one problem per logical line', () => {
    expect(scanText('* pre_osdi models/a.osdi\nR1 1 0 1k ; uses b.so\nR2 1 0 1k $ c.dll', 'n').hits).toEqual([]);
    const cont = scanText('XU1 /a /b\n+ mymodel\n+ lib=models/m.cm', 'n').hits;
    expect(cont).toEqual([{ code: 'binary_model', severity: 'error', ref: 'U1', path: 'models/m.cm', text: 'XU1 /a /b mymodel lib=models/m.cm' }]);
    expect(logicalLines('a\r\n+b\rc\n\n* x\n')).toEqual([{ text: 'a b', tokens: ['a', 'b'] }, { text: 'c', tokens: ['c'] }]);
  });

  it('names a designator from an instance name as KiCad writes it', () => {
    expect(refOf('XU1')).toBe('U1');
    expect(refOf('AU2')).toBe('U2');
    expect(refOf('R1')).toBe('R1');
    expect(refOf('X1')).toBe('X1');
  });

  it('cuts a long line to the problem text limit', () => {
    const long = `pre_osdi ${'a'.repeat(5000)}.osdi`;
    expect(scanText(long, 'n').hits[0]!.text).toHaveLength(4096);
  });
});

describe('the scan of a netlist and its includes', () => {
  it('reads every included file the file system holds, nested ones from their own folder, each once', () => {
    const files = {
      [`${ROOT}/models/top.lib`]: '.include sub/inner.lib\n.include ../models/top.lib\n.model ok D',
      [`${ROOT}/models/sub/inner.lib`]: '.model c1 d_cosim simulation="counter.so"',
    };
    const found = scanNetlist(`${RC}\n.include "${ROOT}/models/top.lib"\n.include "${ROOT}/models/absent.lib"`, src(files));
    expect(found).toEqual([{ code: 'binary_model', severity: 'error', path: 'counter.so', text: '.model c1 d_cosim simulation="counter.so"' }]);
    expect(found.every(isBinaryModelProblem)).toBe(true);
  });

  it('shows a path inside the project folder relative to it', () => {
    const found = scanNetlist(`.include "${ROOT}/models/adder.cm"\n.include "/opt/other/x.so"`, src());
    expect(found.map((p) => p.path)).toEqual(['models/adder.cm', '/opt/other/x.so']);
    const nested = scanNetlist(`.include "${ROOT}/a.lib"`, src({ [`${ROOT}/a.lib`]: 'pre_osdi' }));
    expect(nested[0]!.path).toBe('a.lib');
  });

  it('reads relative includes of the netlist from the project folder, and normalizes paths', () => {
    const found = scanNetlist('.include models/a.lib', src({ [`${ROOT}/models/a.lib`]: 'codemodel x.cm' }));
    expect(found).toHaveLength(1);
    expect(resolvePath('/a/b', '../c/./d.lib')).toBe('/a/c/d.lib');
    expect(resolvePath('/a/b', '/x//y.lib')).toBe('/x/y.lib');
  });

  it('reads at most 64 included files, and each to at most 4 MiB', () => {
    const files: Record<string, string> = {};
    const lines: string[] = [];
    for (let i = 0; i < MAX_SCAN_FILES + 6; i++) {
      files[`${ROOT}/m${i}.lib`] = 'pre_osdi a.osdi';
      lines.push(`.include m${i}.lib`);
    }
    const read = vi.fn(fsOf(files));
    expect(scanNetlist(lines.join('\n'), { ...src(), read })).toHaveLength(MAX_SCAN_FILES);
    expect(read).toHaveBeenCalledTimes(MAX_SCAN_FILES);
    const big = new Uint8Array(4 * 1024 * 1024 + 64).fill(0x20);
    big.set(enc.encode('\npre_osdi late.osdi\n'), 4 * 1024 * 1024 + 2);
    big.set(enc.encode('codemodel early.cm\n'), 0);
    expect(scanNetlist('.include big.lib', src({ [`${ROOT}/big.lib`]: big })).map((p) => p.path)).toEqual(['early.cm']);
  });

  it('takes a file system that throws as one that holds nothing', () => {
    expect(scanNetlist('.include a.lib', { ...src(), read: () => { throw new Error('ENOENT'); } })).toEqual([]);
  });
});

/** A ctx of this test's own with only what the widenings read. */
function ctxOf(over: Partial<Record<string, unknown>> = {}, netlist: string | (() => unknown) = RC, files: Record<string, string> = {}) {
  const kicadSimNetlist = vi.fn(typeof netlist === 'function' ? netlist : () => JSON.stringify({ netlist, problems: [], directive: '.tran 1u 5m' }));
  const mod: Record<string, unknown> = { kicadSimNetlist, kicadSimRun: () => true, kicadSimStop: () => true, kicadSimOpOnSheet: () => true, kicadCollabBusy: () => false };
  const ctx = {
    frame: 'sch', root: ROOT,
    mod: () => mod, has: (names: readonly string[]) => names.every((n) => typeof mod[n] === 'function'),
    hasDocument: () => true, opened: () => `${ROOT}/sim-binary.kicad_sch`,
    simRun: () => null, engineBusy: () => false, keysBlocked: () => false, placeHanging: () => false,
    readBytes: fsOf(files), log: () => undefined,
    ...over,
  } as unknown as ResponderCtx;
  return { ctx, kicadSimNetlist };
}
const RUN = { analysis: { kind: 'sheet' }, options: OPTS, overrides: [] };
const BINARY = `${RC}\n.control\npre_osdi models/adder.osdi\n.endc\n.include "${ROOT}/models/adder.cm"\nXU1 /out 0 adder`;

describe('sim.netlist widened', () => {
  it('lists each compiled model after KiCad\'s own problems', async () => {
    const { ctx } = ctxOf();
    const kicad = { code: 'no_model', severity: 'warning', ref: 'U9', text: 'no model' };
    const next = vi.fn(async (): Promise<Answer> => ok({ netlist: BINARY, problems: [kicad], directive: '.tran 1u 5m' }));
    const a = await widenNetlist({ analysis: { kind: 'sheet' }, options: OPTS }, ctx, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(a.ok).toBe(true);
    const r = (a as { result: Record<string, unknown> }).result;
    expect(r.netlist).toBe(BINARY);
    expect(r.directive).toBe('.tran 1u 5m');
    expect(r.problems).toEqual([
      kicad,
      { code: 'binary_model', severity: 'error', path: 'models/adder.osdi', text: 'pre_osdi models/adder.osdi' },
      { code: 'binary_model', severity: 'error', path: 'models/adder.cm', text: `.include "${ROOT}/models/adder.cm"` },
    ]);
  });

  it('answers as the op did for a plain circuit and for a refusal', async () => {
    const { ctx } = ctxOf();
    const plain = ok({ netlist: RC, problems: [], directive: '.tran 1u 5m' });
    expect(await widenNetlist({}, ctx, async () => plain)).toBe(plain);
    const refusal = fail('busy', 'a run is live');
    expect(await widenNetlist({}, ctx, async () => refusal)).toBe(refusal);
  });
});

describe('sim.run widened', () => {
  it('answers circuit with the first compiled model and never runs', async () => {
    const { ctx, kicadSimNetlist } = ctxOf({}, BINARY);
    const next = vi.fn(async (): Promise<Answer> => ok({ run: 1, problems: [] }));
    const a = await widenRun(RUN, ctx, next);
    expect(a).toEqual({ ok: false, code: 'circuit', message: 'pre_osdi models/adder.osdi' });
    expect(next).not.toHaveBeenCalled();
    expect(JSON.parse(String((kicadSimNetlist.mock.calls[0] as unknown[])[0]))).toEqual({ command: '.op', options: OPTS });
  });

  it('finds a compiled model in an included file too', async () => {
    const { ctx } = ctxOf({}, `${RC}\n.include "${ROOT}/models/top.lib"`, { [`${ROOT}/models/top.lib`]: '.model c d_cosim simulation="c.so"' });
    const next = vi.fn(async (): Promise<Answer> => ok({ run: 1, problems: [] }));
    expect(await widenRun(RUN, ctx, next)).toEqual({ ok: false, code: 'circuit', message: '.model c d_cosim simulation="c.so"' });
    expect(next).not.toHaveBeenCalled();
  });

  it('runs a plain circuit through the op as it stood', async () => {
    const { ctx } = ctxOf();
    const ran = ok({ run: 1, problems: [] });
    const next = vi.fn(async () => ran);
    expect(await widenRun(RUN, ctx, next)).toBe(ran);
    expect(next).toHaveBeenCalledWith(RUN);
  });

  it('leaves every request it cannot scan to the op, which answers it as before', async () => {
    const cases: Array<[string, unknown, Partial<Record<string, unknown>>]> = [
      ['bad args', { analysis: { kind: 'op' } }, {}],
      ['an FFT', { analysis: { kind: 'fft', of: 1, signals: ['V(/out)'] }, options: OPTS, overrides: [] }, {}],
      ['a pcb frame', RUN, { frame: 'pcb' }],
      ['no document', RUN, { hasDocument: () => false }],
      ['a live run', RUN, { simRun: () => 3 }],
      ['a parked load', RUN, { engineBusy: () => true }],
      ['a dialog up', RUN, { keysBlocked: () => true }],
      ['a hanging placement', RUN, { placeHanging: () => true }],
      ['no engine export', RUN, { has: () => false }],
    ];
    for (const [name, args, over] of cases) {
      const { ctx, kicadSimNetlist } = ctxOf(over, BINARY);
      const refusal = fail('x', name);
      const next = vi.fn(async () => refusal);
      expect(await widenRun(args, ctx, next), name).toBe(refusal);
      expect(kicadSimNetlist, name).not.toHaveBeenCalled();
    }
    for (const netlist of [() => '', () => { throw new Error('boom'); }, () => '{"netlist":1}']) {
      const { ctx } = ctxOf({}, netlist);
      const ran = ok({ run: 1, problems: [] });
      expect(await widenRun(RUN, ctx, async () => ran)).toBe(ran);
    }
  });
});

describe('si1-i in the registry', () => {
  it('loads from its own file with nothing broken, widening sim.run and sim.netlist and adding nothing of its own', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect(REGISTRY.units.map((u) => u.unit)).toContain('si1-i');
    expect(REGISTRY.widen.get('sim.run')?.map((w) => w.unit)).toContain('si1-i');
    expect(REGISTRY.widen.get('sim.netlist')?.map((w) => w.unit)).toContain('si1-i');
    const own = unit as ExtUnit;
    expect(own.ops).toBeUndefined();
    expect(own.capNames).toBeUndefined();
    expect(own.events).toBeUndefined();
    expect(own.heldRows).toBeUndefined();
  });
});
