// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// sim.command (PROTOCOL.md): the lines a KiCad simulator workbook carries for
// one setup. The analysis line is written by the island's own commandOf (or
// fftLines for an FFT), the one writer of SPICE text and the line sim.run
// sends, followed by the option lines KiCad's workbook writes from the
// options: .save all, .probe alli, .probe allp, and .kicad esavenone when
// events are not kept. Never .kicad adjustpaths: the model paths are the
// design's own. A read: no engine call, no document needed. The names of a
// DC sweep or a noise analysis are not checked against the netlist (the
// workbook is read again at run time, where sim.run checks them); a name
// that is not a source of its kind (a DC sweep over C1) is refused, as
// sim.run refuses it.
import { fail, hasAll, isObj, ok, type ExtUnit } from './contract';
import {
  commandOf, fftLines, parseAnalysis, parseOptions, SIM_FRAME_ONLY, SIM_RUN_EXPORTS, type NetNames, type SimAnalysis, type SimOptions,
} from '../sim';

export const SIM_COMMAND = 'sim.command';
export const SIM_COMMAND_CAP = 'simCommand';

/** The option lines of KiCad's workbook, in its order, for one setup's options. */
export function optionLines(o: SimOptions): string[] {
  const lines: string[] = [];
  if (o.voltages) lines.push('.save all');
  if (o.currents) lines.push('.probe alli');
  if (o.dissipations) lines.push('.probe allp');
  if (!o.events) lines.push('.kicad esavenone');
  return lines;
}

/** The names an analysis line may name, taken from the analysis itself: every node it names, and every swept or noise source. */
function namesIn(a: Exclude<SimAnalysis, { kind: 'fft' }>): NetNames {
  const nodes = new Set<string>(['0']);
  const sources = new Set<string>();
  const add = (set: Set<string>, n: string): void => { set.add(n.toLowerCase()); };
  switch (a.kind) {
    case 'dc':
      add(sources, a.source);
      if (a.second != null) add(sources, a.second.source);
      break;
    case 'noise':
      add(nodes, a.output);
      if (a.reference != null) add(nodes, a.reference);
      add(sources, a.source);
      break;
    case 'pz':
      for (const n of [...a.input, ...a.output]) add(nodes, n);
      break;
    default:
      break;
  }
  return { nodes, sources };
}

/** sim.command's args read closed and answered: the lines, or the refusal's message (bad_args). */
export function simCommandLines(args: unknown): { commands: string[] } | { refused: string } {
  const refused = { refused: SIM_COMMAND };
  if (!isObj(args)) return refused;
  const keys = Object.keys(args);
  if (keys.length !== 2 || !keys.includes('analysis') || !keys.includes('options')) return refused;
  const analysis = parseAnalysis(args.analysis);
  const options = parseOptions(args.options);
  if (analysis == null || options == null) return refused;
  // An FFT's signals are written as the page names them: KiCad's own signal names (V(/out)), as sim.run writes them.
  const line = analysis.kind === 'fft'
    ? fftLines(analysis, analysis.signals.map((s) => ({ name: s, signal: s })))
    : commandOf(analysis, namesIn(analysis));
  if ('unknown' in line) return { refused: `${SIM_COMMAND}: ${line.unknown} is not a source` };
  const head = line.command === '' ? [] : line.command.split('\n');
  return { commands: [...head, ...optionLines(options)] };
}

export default {
  unit: 'si5-i',
  frames: ['sch'],
  frameRefusal: SIM_FRAME_ONLY,
  capNames: [SIM_COMMAND_CAP],
  caps: (mod, frame) => (frame === 'sch' && hasAll(mod, SIM_RUN_EXPORTS) ? [SIM_COMMAND_CAP] : []),
  ops: {
    [SIM_COMMAND]: {
      passesCheck: true,   // a read
      run(args, ctx) {
        const r = simCommandLines(args);
        if ('refused' in r) return fail('bad_args', r.refused);
        const mod = ctx.mod();
        for (const name of SIM_RUN_EXPORTS) if (typeof mod?.[name] !== 'function') return fail('unsupported', name);
        return ok({ commands: r.commands });
      },
    },
  },
} satisfies ExtUnit;
