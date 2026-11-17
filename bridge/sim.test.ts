// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { describe, expect, it } from 'vitest';
import {
  CONSOLE_MAX, commandOf, fftLines, isModelPath, isSpiceNumber, MAX_OVERRIDES, MAX_VECTOR_NAMES, namesOf, parseAnalysis, parseCatalogArgs,
  parseFileArgs, parseModelGetArgs, parseModelSetArgs, parseNetlistArgs, parseOpOnSheetArgs, parseOptions, parseResultArgs, parseRunArgs,
  parseVectorsArgs, qualifiedVector, readAccepted, readCatalog, readCatalogEntry, readModelSheet, readNetlist, readProblems, readSimDone,
  readSimFile, readSimResult, runJson, showsModelSet, spiceValue, splitVector, statPercent, vectorBytes, vectorsOf, type SimAnalysis, type SimResult,
} from './sim';

const U = '0f3a1c2e-1111-4222-8333-444455556666';
const OPTS = { voltages: true, currents: true, dissipations: false, events: false };
const enc = (v: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(v));
/** Each key of a valid object dropped, then each key given a wrong type, then an unknown key added: every one refused. */
function refusesEachKey(parse: (a: unknown) => unknown, good: Record<string, unknown>, wrong: unknown = Symbol('x')): void {
  expect(parse(good)).not.toBeNull();
  for (const k of Object.keys(good)) {
    const less = { ...good };
    delete less[k];
    expect(parse(less), `without ${k}`).toBeNull();
    expect(parse({ ...good, [k]: wrong }), `${k} of another type`).toBeNull();
  }
  expect(parse({ ...good, extra: 1 }), 'an unknown key').toBeNull();
}

describe('the SPICE number grammar', () => {
  it('takes digits, an exponent and a scale word in any case', () => {
    for (const s of ['1', '1.', '.5', '-2.5e-3', '+3E6', '10k', '4.7K', '1meg', '1MEG', '2u', '100n', '5p', '1f', '3g', '2t', '1m']) expect(isSpiceNumber(s), s).toBe(true);
  });
  it('refuses words, units, spaces and anything longer than 64 characters', () => {
    for (const s of ['', 'k', '1 k', '1kohm', '1V', '1e', '1..2', 'abc', '1;', '1)', '1'.repeat(65), '--1']) expect(isSpiceNumber(s), s).toBe(false);
    expect(isSpiceNumber(5)).toBe(false);
  });
  it('reads meg apart from m', () => {
    expect(spiceValue('1meg')).toBe(1e6);
    expect(spiceValue('1m')).toBe(1e-3);
    expect(spiceValue('-2.5k')).toBe(-2500);
    expect(spiceValue('1u')).toBeCloseTo(1e-6, 20);
    expect(spiceValue('x')).toBeNull();
  });
});

describe('the args of each op, closed', () => {
  it('sim.catalog takes none, or one type key', () => {
    expect(parseCatalogArgs(undefined)).toEqual({});
    expect(parseCatalogArgs({})).toEqual({});
    expect(parseCatalogArgs({ type: 'V.PULSE' })).toEqual({ type: 'V.PULSE' });
    expect(parseCatalogArgs({ type: 'NMOS.BSIM4' })).toEqual({ type: 'NMOS.BSIM4' });
    // KiCad's behavioral types are spelled "=" (measured on engine run 14: R.=, C.=, L.=, V.=, I.=).
    expect(parseCatalogArgs({ type: 'V.=' })).toEqual({ type: 'V.=' });
    expect(parseCatalogArgs({ type: 'V.==' })).toBeNull();
    for (const bad of [{ type: '' }, { type: 'a b' }, { type: 'A.B.C' }, { type: 1 }, { type: 'R', x: 1 }, [], null, 'R']) expect(parseCatalogArgs(bad)).toBeNull();
  });
  it('sim.model.get takes exactly a uuid and a sheet path', () => {
    refusesEachKey(parseModelGetArgs, { uuid: U, sheetPath: '/' });
    expect(parseModelGetArgs({ uuid: U.toUpperCase(), sheetPath: '/' })).toBeNull();
    expect(parseModelGetArgs({ uuid: U, sheetPath: 'x' })).toBeNull();
    expect(parseModelGetArgs({ uuid: U, sheetPath: `/${U}/` })).toEqual({ uuid: U, sheetPath: `/${U}/` });
  });
  it('sim.model.set takes null, a built in model or a file model, each closed', () => {
    expect(parseModelSetArgs({ uuid: U, sheetPath: '/', model: null })).toEqual({ uuid: U, sheetPath: '/', model: null });
    const builtin = { source: 'builtin', type: 'V.PULSE', params: { y1: '0', y2: '5' }, pins: [{ symbolPin: '1', modelPin: '+' }] };
    refusesEachKey((m) => parseModelSetArgs({ uuid: U, sheetPath: '/', model: m }), builtin);
    const file = { source: 'file', path: 'models/bjt.lib', model: '2N3904', params: {}, pins: [] };
    refusesEachKey((m) => parseModelSetArgs({ uuid: U, sheetPath: '/', model: m }), file);
    expect(parseModelSetArgs({ uuid: U, sheetPath: '/', model: { ...builtin, source: 'inferred' } })).toBeNull();
    expect(parseModelSetArgs({ uuid: U, sheetPath: '/', model: { ...builtin, params: { y1: 1 } } })).toBeNull();
    expect(parseModelSetArgs({ uuid: U, sheetPath: '/', model: { ...builtin, params: { 'a\nb': '1' } } })).toBeNull();
    expect(parseModelSetArgs({ uuid: U, sheetPath: '/', model: { ...builtin, pins: [{ symbolPin: '1', modelPin: '+' }, { symbolPin: '1', modelPin: '-' }] } })).toBeNull();
    expect(parseModelSetArgs({ uuid: U, sheetPath: '/', model: { ...file, path: '../x.lib' } })).toBeNull();
    refusesEachKey(parseModelSetArgs, { uuid: U, sheetPath: '/', model: null });
  });
  it('a model path stays in the project folder or names an embedded file', () => {
    for (const p of ['models/bjt.lib', 'x.ibs', 'kicad-embed://opamp.lib', 'a/b/c.sub']) expect(isModelPath(p), p).toBe(true);
    for (const p of ['', '/etc/x', '~/x', '../x', 'a/../x', 'a//x', 'a/./x', 'C:x', '${KIPRJMOD}/x', 'a\\x', 'kicad-embed://', 'kicad-embed://a/b', 'a\nb']) expect(isModelPath(p), p).toBe(false);
    expect(parseFileArgs({ path: 'models/x.lib' })).toEqual({ path: 'models/x.lib' });
    refusesEachKey(parseFileArgs, { path: 'models/x.lib' });
  });
  it('the options are exactly KiCad\'s four save switches', () => {
    refusesEachKey(parseOptions, OPTS);
  });
  it('each analysis takes its own keys and no other', () => {
    const goods: Array<Record<string, unknown>> = [
      { kind: 'op' },
      { kind: 'sheet' },
      { kind: 'dc', source: 'V1', start: '0', stop: '5', step: '0.1' },
      { kind: 'ac', scale: 'dec', points: 10, fStart: '1', fStop: '1meg' },
      { kind: 'sp', scale: 'lin', points: 100, fStart: '1k', fStop: '1g' },
      { kind: 'tran', step: '1u', stop: '5m' },
      { kind: 'noise', output: 'out', source: 'V1', scale: 'oct', points: 5, fStart: '10', fStop: '100k' },
      { kind: 'pz', input: ['in', '0'], output: ['out', '0'], transfer: 'vol', find: 'pz' },
      { kind: 'fft', of: 3, signals: ['v(out)'] },
    ];
    for (const g of goods) {
      expect(parseAnalysis(g), String(g.kind)).toEqual(g);
      expect(parseAnalysis({ ...g, extra: 1 }), `${String(g.kind)} with an unknown key`).toBeNull();
      for (const k of Object.keys(g)) {
        if (k === 'kind') continue;
        const less = { ...g };
        delete less[k];
        expect(parseAnalysis(less), `${String(g.kind)} without ${k}`).toBeNull();
        expect(parseAnalysis({ ...g, [k]: { x: 1 } }), `${String(g.kind)} with ${k} an object`).toBeNull();
      }
    }
    expect(parseAnalysis({ kind: 'disto' })).toBeNull();
    expect(parseAnalysis({ kind: 'tran', step: '1u', stop: '5m', start: '1m', maxStep: '10u', useIc: true })).not.toBeNull();
    expect(parseAnalysis({ kind: 'noise', output: 'out', reference: 'ref', source: 'V1', scale: 'dec', points: 5, fStart: '1', fStop: '2' })).not.toBeNull();
    expect(parseAnalysis({ kind: 'fft', of: 3, signals: ['v(out)'], window: 'hanning' })).not.toBeNull();
    expect(parseAnalysis({ kind: 'fft', of: 3, signals: ['v(out)'], window: 'kaiser' })).toBeNull();
    expect(parseAnalysis({ kind: 'fft', of: 0, signals: ['v(out)'] })).toBeNull();
    expect(parseAnalysis({ kind: 'fft', of: 3, signals: [] })).toBeNull();
    expect(parseAnalysis({ kind: 'dc', source: 'V1', start: '0', stop: '5', step: '1', second: { source: 'v1', start: '0', stop: '1', step: '1' } })).toBeNull();
    expect(parseAnalysis({ kind: 'dc', source: 'V1', start: '0', stop: '5', step: '1', second: { source: 'R1', start: '1k', stop: '2k', step: '100' } })).not.toBeNull();
  });
  it('bounds: points, names, numbers', () => {
    expect(parseAnalysis({ kind: 'ac', scale: 'dec', points: 0, fStart: '1', fStop: '2' })).toBeNull();
    expect(parseAnalysis({ kind: 'ac', scale: 'dec', points: 1.5, fStart: '1', fStop: '2' })).toBeNull();
    expect(parseAnalysis({ kind: 'ac', scale: 'dec', points: 1_000_001, fStart: '1', fStop: '2' })).toBeNull();
    expect(parseAnalysis({ kind: 'ac', scale: 'log', points: 1, fStart: '1', fStop: '2' })).toBeNull();
    for (const name of ['a b', 'v(x)', 'a,b', 'a;b', 'a=b', '"a"', '', 'x'.repeat(129)]) {
      expect(parseAnalysis({ kind: 'dc', source: name, start: '0', stop: '1', step: '1' }), name).toBeNull();
    }
    expect(parseAnalysis({ kind: 'tran', step: '1us', stop: '5m' })).toBeNull();
    expect(parseAnalysis({ kind: 'tran', step: '1u', stop: '5m; .control' })).toBeNull();
  });
  it('sim.netlist takes an analysis but an FFT, and the options', () => {
    refusesEachKey(parseNetlistArgs, { analysis: { kind: 'op' }, options: OPTS });
    expect(parseNetlistArgs({ analysis: { kind: 'fft', of: 1, signals: ['v(a)'] }, options: OPTS })).toBeNull();
  });
  it('sim.run takes overrides of distinct designators with SPICE numbers, none for an FFT', () => {
    refusesEachKey(parseRunArgs, { analysis: { kind: 'op' }, options: OPTS, overrides: [{ ref: 'R1', value: '2k' }] });
    expect(parseRunArgs({ analysis: { kind: 'op' }, options: OPTS, overrides: [{ ref: 'R1', value: '2kohm' }] })).toBeNull();
    expect(parseRunArgs({ analysis: { kind: 'op' }, options: OPTS, overrides: [{ ref: 'R1', value: '2k' }, { ref: 'r1', value: '3k' }] })).toBeNull();
    expect(parseRunArgs({ analysis: { kind: 'op' }, options: OPTS, overrides: [{ ref: 'R 1', value: '2k' }] })).toBeNull();
    expect(parseRunArgs({ analysis: { kind: 'op' }, options: OPTS, overrides: Array.from({ length: MAX_OVERRIDES + 1 }, (_, i) => ({ ref: `R${i}`, value: '1' })) })).toBeNull();
    expect(parseRunArgs({ analysis: { kind: 'fft', of: 1, signals: ['v(a)'] }, options: OPTS, overrides: [{ ref: 'R1', value: '1' }] })).toBeNull();
    expect(parseRunArgs({ analysis: { kind: 'fft', of: 1, signals: ['v(a)'] }, options: OPTS, overrides: [] })).not.toBeNull();
  });
  it('sim.result, sim.vectors and sim.opOnSheet', () => {
    refusesEachKey(parseResultArgs, { run: 1 });
    expect(parseResultArgs({ run: 0 })).toBeNull();
    refusesEachKey(parseVectorsArgs, { run: 2, names: ['time', 'v(out)'] });
    expect(parseVectorsArgs({ run: 2, names: [] })).toBeNull();
    expect(parseVectorsArgs({ run: 2, names: Array.from({ length: MAX_VECTOR_NAMES + 1 }, (_, i) => `v(n${i})`) })).toBeNull();
    expect(parseVectorsArgs({ run: 2, names: ['time', 'time'] })).toBeNull();
    expect(parseVectorsArgs({ run: 2, names: ['v(a b)'] })).toBeNull();
    refusesEachKey(parseOpOnSheetArgs, { voltages: true, currents: false });
  });
});

describe('the analysis line', () => {
  const names = namesOf([
    '.title KiCad schematic',
    '.include "/tmp/models/x.lib"',
    '* a comment naming nowhere',
    'V1 in 0 PULSE( 0 5 0 1n 1n 10m 20m )',
    'R1 in out 1k',
    'C1 out 0 1u',
    'XU1 out fb 0 OPAMP',
    '+ extra_node',
    '.tran 1u 5m',
    '.end',
  ].join('\n'));
  const line = (a: SimAnalysis): unknown => (a.kind === 'fft' ? null : commandOf(a, names));
  it('reads the netlist\'s nodes and sources, lower case', () => {
    for (const n of ['in', 'out', '0', 'fb', 'extra_node']) expect(names.nodes.has(n), n).toBe(true);
    expect([...names.sources].sort()).toEqual(['r1', 'v1']);
    expect(names.nodes.has('nowhere')).toBe(false);
  });
  it('writes each kind as KiCad\'s dialog does', () => {
    expect(line({ kind: 'op' })).toEqual({ command: '.op' });
    expect(line({ kind: 'sheet' })).toEqual({ command: '' });
    expect(line({ kind: 'dc', source: 'V1', start: '0', stop: '5', step: '0.1' })).toEqual({ command: '.dc V1 0 5 0.1' });
    expect(line({ kind: 'dc', source: 'temp', start: '-40', stop: '85', step: '5', second: { source: 'R1', start: '1k', stop: '2k', step: '500' } })).toEqual({ command: '.dc TEMP -40 85 5 R1 1k 2k 500' });
    expect(line({ kind: 'ac', scale: 'dec', points: 10, fStart: '1', fStop: '1meg' })).toEqual({ command: '.ac dec 10 1 1meg' });
    expect(line({ kind: 'sp', scale: 'lin', points: 100, fStart: '1k', fStop: '1g' })).toEqual({ command: '.sp lin 100 1k 1g' });
    expect(line({ kind: 'tran', step: '1u', stop: '5m' })).toEqual({ command: '.tran 1u 5m' });
    expect(line({ kind: 'tran', step: '1u', stop: '5m', start: '1m' })).toEqual({ command: '.tran 1u 5m 1m' });
    expect(line({ kind: 'tran', step: '1u', stop: '5m', maxStep: '10u' })).toEqual({ command: '.tran 1u 5m 0 10u' });
    expect(line({ kind: 'tran', step: '1u', stop: '5m', start: '1m', maxStep: '10u', useIc: true })).toEqual({ command: '.tran 1u 5m 1m 10u uic' });
    // uic with no largest step: the smaller of a fiftieth of the span and the step.
    expect(line({ kind: 'tran', step: '1m', stop: '10m', useIc: true })).toEqual({ command: '.tran 1m 10m 0 0.0002 uic' });
    expect(line({ kind: 'tran', step: '1u', stop: '10m', useIc: true })).toEqual({ command: '.tran 1u 10m 0 0.000001 uic' });
    expect(line({ kind: 'noise', output: 'out', source: 'V1', scale: 'dec', points: 10, fStart: '10', fStop: '100k' })).toEqual({ command: '.noise v(out) V1 dec 10 10 100k' });
    expect(line({ kind: 'noise', output: 'OUT', reference: 'in', source: 'v1', scale: 'oct', points: 3, fStart: '1', fStop: '2' })).toEqual({ command: '.noise v(OUT,in) v1 oct 3 1 2' });
    expect(line({ kind: 'pz', input: ['in', '0'], output: ['out', '0'], transfer: 'cur', find: 'pol' })).toEqual({ command: '.pz in 0 out 0 cur pol' });
  });
  it('answers the first name the netlist does not hold', () => {
    expect(line({ kind: 'dc', source: 'V9', start: '0', stop: '1', step: '1' })).toEqual({ unknown: 'V9' });
    expect(line({ kind: 'dc', source: 'C1', start: '0', stop: '1', step: '1' })).toEqual({ unknown: 'C1' });
    expect(line({ kind: 'dc', source: 'V1', start: '0', stop: '1', step: '1', second: { source: 'R9', start: '0', stop: '1', step: '1' } })).toEqual({ unknown: 'R9' });
    expect(line({ kind: 'noise', output: 'nowhere', source: 'V1', scale: 'dec', points: 1, fStart: '1', fStop: '2' })).toEqual({ unknown: 'nowhere' });
    expect(line({ kind: 'noise', output: 'out', source: 'R1', scale: 'dec', points: 1, fStart: '1', fStop: '2' })).toEqual({ unknown: 'R1' });
    expect(line({ kind: 'pz', input: ['in', '0'], output: ['x9', '0'], transfer: 'vol', find: 'pz' })).toEqual({ unknown: 'x9' });
  });
  it('an FFT reads the transient\'s own vectors, linearized first, the window before both', () => {
    const vectors = ['time', 'v(out)', 'v(in)', 'i(v1)'];
    expect(fftLines({ kind: 'fft', of: 1, signals: ['V(OUT)'] }, vectors)).toEqual({ command: 'linearize v(out)\nfft v(out)' });
    expect(fftLines({ kind: 'fft', of: 1, signals: ['v(out)', 'i(v1)'], window: 'hanning' }, vectors)).toEqual({ command: 'set specwindow=hanning\nlinearize v(out) i(v1)\nfft v(out) i(v1)' });
    expect(fftLines({ kind: 'fft', of: 1, signals: ['v(nowhere)'] }, vectors)).toEqual({ unknown: 'v(nowhere)' });
  });
  it('the engine\'s args carry the run, its folder and nothing the host wrote as SPICE', () => {
    expect(JSON.parse(runJson(3, '/tmp/cc-sim/3', '.op', OPTS, [{ ref: 'R1', value: '2k' }], null))).toEqual({ run: 3, dir: '/tmp/cc-sim/3', command: '.op', options: OPTS, overrides: [{ ref: 'R1', value: '2k' }], fftOf: null });
  });
});

describe('ngspice\'s progress lines', () => {
  it('reads the percent of "<analysis>: <percent>%"', () => {
    expect(statPercent('tran: 34.5%')).toBe(35);
    expect(statPercent('tran:  5.0%')).toBe(5);
    expect(statPercent('ac: 100.0%')).toBe(100);
    expect(statPercent('dc: 0.0%')).toBe(0);
    expect(statPercent('noise: 12%')).toBe(12);
  });
  it('reads no percent from any other line', () => {
    for (const l of ['--ready--', 'Source Deck', 'tran', 'tran: abc%', ': 5%', 'tran: 5', '']) expect(statPercent(l), l).toBeNull();
  });
});

describe('the readers', () => {
  const problem = { code: 'model_error', severity: 'error', ref: 'Q1', uuid: U, sheetPath: '/', text: 'no model' };
  it('problems are closed: codes, severities and keys', () => {
    expect(readProblems([problem])).toEqual([problem]);
    expect(readProblems([{ ...problem, code: 'oops' }])).toBeNull();
    expect(readProblems([{ ...problem, severity: 'info' }])).toBeNull();
    expect(readProblems([{ ...problem, extra: 1 }])).toBeNull();
    expect(readProblems([{ code: 'other', severity: 'warning', text: 'x'.repeat(5000) }])?.[0]?.text.length).toBe(4096);
  });
  it('the record, the acceptance and a result', () => {
    const done = { run: 2, error: '', message: '', lines: [{ severity: 'info', text: 'ok' }], problems: [] };
    expect(readSimDone(enc(done))).toEqual(done);
    expect(readSimDone(enc({ ...done, error: 'nope' }))).toBeNull();
    expect(readSimDone(enc({ ...done, run: 0 }))).toBeNull();
    expect(readSimDone(null)).toBeNull();
    expect(readSimDone(new TextEncoder().encode('{'))).toBeNull();
    for (const error of ['circuit', 'no_directive', 'no_simulation', 'sim_failed', 'stopped', 'service_failed']) expect(readSimDone(enc({ ...done, error }))?.error).toBe(error);
    expect(readAccepted(enc({ run: 2, plot: 'tran1', problems: [] }))).toEqual({ run: 2, plot: 'tran1', problems: [] });
    expect(readAccepted(enc({ run: 2, plot: 'tran1' }))).toBeNull();
    const result = {
      run: 2, kind: 'tran', ended: 'done', depth: 4,
      plots: [{ name: 'tran1', x: 'time', vectors: [{ name: 'time', signal: 'time', trace: 'other', complex: false, length: 5 }, { name: 'v(out)', signal: 'V(out)', trace: 'voltage', complex: false, length: 5 }] }],
      op: null, console: Array.from({ length: CONSOLE_MAX + 5 }, (_, i) => `line ${i}`), problems: [],
    };
    const read = readSimResult(enc(result));
    expect(read?.console.length).toBe(CONSOLE_MAX);
    expect(read?.console[0]).toBe('line 5');
    expect(readSimResult(enc({ ...result, kind: 'disto' }))).toBeNull();
    expect(readSimResult(enc({ ...result, op: [{ signal: 'V(mid)', trace: 'voltage', value: 'x' }] }))).toBeNull();
    expect(readSimResult(enc({ ...result, op: [{ signal: 'V(mid)', trace: 'voltage', value: 3.8 }] }))?.op).toEqual([{ signal: 'V(mid)', trace: 'voltage', value: 3.8 }]);
  });
  it('the netlist, the catalog, a model sheet and a model file', () => {
    expect(readNetlist('')).toBeNull();
    expect(readNetlist(JSON.stringify({ netlist: 'V1 a 0 1', problems: [], directive: '.op' }))).toEqual({ netlist: 'V1 a 0 1', problems: [], directive: '.op' });
    expect(readNetlist(JSON.stringify({ netlist: 'x', problems: [], directive: '', truncated: true }))?.truncated).toBe(true);
    expect(readNetlist(JSON.stringify({ netlist: 'x', problems: [] }))).toBeNull();
    const catalog = { devices: [{ device: 'V', description: 'Voltage Source', types: [{ type: 'V.PULSE', name: 'PULSE', description: 'Pulse' }] }] };
    expect(readCatalog(JSON.stringify(catalog))).toEqual(catalog);
    expect(readCatalog(JSON.stringify({ devices: [{ device: 'V', types: [] }] }))).toBeNull();
    const entry = { type: 'R', device: 'R', name: '', description: 'Ideal', pins: [{ name: '+', symbolPinHint: '1' }], params: [{ name: 'r', unit: 'Ω', default: '', category: 'principal', description: 'Resistance', kind: 'instance', tuner: true }] };
    expect(readCatalogEntry(JSON.stringify(entry))).toEqual(entry);
    expect(readCatalogEntry(JSON.stringify({ ...entry, params: [{ ...entry.params[0], kind: 'x' }] }))).toBeNull();
    const sheet = { uuid: U, sheetPath: '/', ref: 'R1', enabled: true, source: 'inferred', device: 'R', type: 'R', typeName: 'Ideal', file: null, pins: [{ symbolPin: '1', modelPin: '+' }], params: [{ name: 'r', value: '1k', default: '', unit: 'Ω', given: true }], problems: [] };
    expect(readModelSheet(JSON.stringify(sheet))).toEqual(sheet);
    expect(readModelSheet(JSON.stringify({ ...sheet, ibis: { pin: '1', model: 'm', diff: false, type: 'DEVICE' } }))?.ibis).toEqual({ pin: '1', model: 'm', diff: false, type: 'DEVICE' });
    expect(readModelSheet(JSON.stringify({ ...sheet, source: 'magic' }))).toBeNull();
    expect(readModelSheet(JSON.stringify({ ...sheet, extra: 1 }))).toBeNull();
    const file = { kind: 'spice', models: [{ name: '2N3904', kind: 'model', type: 'NPN.GUMMELPOON', pins: ['C', 'B', 'E'] }], problems: [] };
    expect(readSimFile(JSON.stringify(file))).toEqual(file);
    expect(readSimFile(JSON.stringify({ ...file, kind: 'verilog' }))).toBeNull();
  });
  it('a set reads back by its source, type and file', () => {
    const base = { uuid: U, sheetPath: '/', ref: 'V1', enabled: true, device: 'V', typeName: '', pins: [], params: [], problems: [] };
    expect(showsModelSet(null, { ...base, source: 'inferred', type: 'V', file: null })).toBe(true);
    expect(showsModelSet(null, { ...base, source: 'builtin', type: 'V.PULSE', file: null })).toBe(false);
    expect(showsModelSet({ source: 'builtin', type: 'V.PULSE', params: {}, pins: [] }, { ...base, source: 'builtin', type: 'V.PULSE', file: null })).toBe(true);
    expect(showsModelSet({ source: 'builtin', type: 'V.SIN', params: {}, pins: [] }, { ...base, source: 'builtin', type: 'V.PULSE', file: null })).toBe(false);
    expect(showsModelSet({ source: 'file', path: 'm.lib', model: 'Q', params: {}, pins: [] }, { ...base, source: 'file', type: 'NPN', file: { path: 'm.lib', model: 'Q' } })).toBe(true);
  });
});

describe('vectors', () => {
  const result: SimResult = {
    run: 4, kind: 'noise', ended: 'done', depth: 0, op: null, console: [], problems: [],
    plots: [
      { name: 'noise1', x: 'frequency', vectors: [{ name: 'frequency', signal: 'frequency', trace: 'other', complex: false, length: 10 }, { name: 'onoise_spectrum', signal: 'onoise_spectrum', trace: 'noise', complex: false, length: 10 }] },
      { name: 'noise2', x: null, vectors: [{ name: 'onoise_total', signal: 'onoise_total', trace: 'noise', complex: false, length: 1 }] },
    ],
  };
  it('finds each name in the first plot holding it, and the bytes they take', () => {
    const got = vectorsOf(result, ['onoise_total', 'frequency']);
    expect(got).toEqual({ found: [{ name: 'onoise_total', plot: 'noise2', vector: result.plots[1]!.vectors[0] }, { name: 'frequency', plot: 'noise1', vector: result.plots[0]!.vectors[0] }] });
    expect(vectorsOf(result, ['v(out)'])).toEqual({ missing: 'v(out)' });
    if ('found' in got) expect(vectorBytes(got.found)).toBe(8 + 80);
    expect(vectorBytes([{ vector: { name: 'a', signal: 'a', trace: 'gain', complex: true, length: 3 } }])).toBe(48);
    expect(qualifiedVector('tran1', 'v(out)')).toBe('tran1.v(out)');
  });
  it('splits a complex answer into its halves, keeps a real one, refuses the rest', () => {
    expect(splitVector({ found: true, comp: new Float64Array([1, 2, 3, 4]), real: null })).toEqual({ real: new Float64Array([1, 3]), imag: new Float64Array([2, 4]) });
    expect(splitVector({ found: true, real: new Float64Array([5, 6]), comp: null })).toEqual({ real: new Float64Array([5, 6]), imag: null });
    expect(splitVector({ found: false })).toBeNull();
    expect(splitVector({ error: 'gone' })).toBeNull();
    expect(splitVector({ found: true, comp: new Float64Array([1, 2, 3]) })).toBeNull();
  });
});
