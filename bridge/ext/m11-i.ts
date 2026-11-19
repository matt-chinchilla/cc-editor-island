// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// sim.userSignals (PROTOCOL.md, wave 2 M11): the reader's own signals over an
// ended run, KiCad's user defined signals (SIMULATOR_FRAME_UI's
// applyUserDefinedSignals) worked out by ngspice through engine run 15's
// kicadSimUserSignals with no KiCad window. Each expression passes the one
// grammar check first (a single `let`, nothing that could become a second
// command); the run's plot is the one the engine recorded for that run and
// the service still holds, so a run superseded by a newer run of its kind
// answers no_simulation. sim.vectors then reads user0 to user15 of that run
// as any other vector, straight from the service.
import { fail, ok, refused, hasAll, type Answer, type ExtUnit, type ResponderCtx } from './contract';
import { MAX_VECTOR_BYTES, parseVectorsArgs, qualifiedVector, SIM_FRAME_ONLY, SIM_ROOT, splitVector } from '../sim';
import { currentSimService } from '../../src/sim-service';
import {
  answerOf, isRunPlot, parseUserSignalsArgs, readUserSignals, USER_SIGNALS_CAP, USER_SIGNALS_EXPORTS,
  USER_SIGNALS_MS, USER_SIGNALS_RECORD, USER_VECTOR_RE, userSignalsJson,
} from './m11-i/userSignals';

/** What sim.userSignals made for a run: the plot it went into and each user vector's size. */
interface Made { plot: string; vectors: Map<string, { length: number; complex: boolean }> }
/** Each frame's made signals by run: the responder's ctx is one object for the frame's life. */
const madeByFrame = new WeakMap<ResponderCtx, Map<number, Made>>();
const madeOf = (ctx: ResponderCtx): Map<number, Made> => {
  let m = madeByFrame.get(ctx);
  if (m == null) { m = new Map(); madeByFrame.set(ctx, m); }
  return m;
};

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function userSignals(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const op = 'sim.userSignals';
  const a = parseUserSignalsArgs(args);
  if (a == null) return fail('bad_args', op);
  const g = ctx.schematicGate(op, USER_SIGNALS_EXPORTS);
  if (refused(g)) return g;
  const service = currentSimService();
  if (service == null) return fail('unsupported', 'ngspice_service.wasm');
  if (ctx.simRun() != null) return fail('busy', 'a run is live');
  if (!service.live()) return fail('no_simulation', `run ${a.run}: the simulator was released`);
  const listed = await service.request({ kind: 'all_plots' });
  if (listed.error !== undefined || !Array.isArray(listed.names)) return fail('island_error', 'the simulator answered its plots in another shape');
  if (ctx.simRun() != null) return fail('busy', 'a run is live');
  let dir: string;
  try { dir = ctx.freshRunFolder(SIM_ROOT); } catch (err) { return fail('island_error', describe(err)); }
  // The engine takes only a plot the run's finish recorded and the service
  // still holds (false, nothing queued, for any other): the first it takes is
  // the run's. None taken: the run ended no plot, or a newer run replaced it.
  let plot: string | null = null;
  try {
    const call = g.mod.kicadSimUserSignals as (json: string) => unknown;
    for (const name of listed.names.filter(isRunPlot)) {
      if (call(userSignalsJson(a.run, dir, name, a.signals)) === true) { plot = name; break; }
    }
  } catch (err) {
    ctx.dropRunFolder(dir);
    return fail('island_error', describe(err));
  }
  if (plot == null) { ctx.dropRunFolder(dir); return fail('no_simulation', `run ${a.run}`); }
  const ran = await ctx.queuedRun(op, dir, USER_SIGNALS_MS, () => true, () => readUserSignals(ctx.readBytes(`${dir}/${USER_SIGNALS_RECORD}`)));
  if ('ok' in ran) return ran;
  ctx.dropRunFolder(dir);
  const record = ran.done;
  if (record.run !== a.run || record.plot !== plot) return fail('island_error', 'the engine answered the signals of another run');
  if (record.error === 'no_simulation') return fail('no_simulation', `run ${a.run}`);
  if (record.error === 'sim_failed') return fail('sim_failed', record.message ?? 'ngspice did not work the signals out');
  const answer = answerOf(record, a.signals);
  if (answer == null) return fail('island_error', 'the engine answered a signal that was not asked');
  madeOf(ctx).set(a.run, { plot, vectors: new Map(answer.vectors.map((v) => [v.name, { length: v.length, complex: v.complex }])) });
  return ok(answer);
}

/**
 * sim.vectors widened: a name sim.userSignals made for the asked run is read
 * from the service in its plot, as the op reads any other; every other name
 * goes to the op as before, and the answer keeps the order asked.
 */
async function vectorsWithUserSignals(args: unknown, ctx: ResponderCtx, next: (args: unknown) => Promise<Answer>): Promise<Answer> {
  const a = parseVectorsArgs(args);
  const made = a == null ? undefined : madeByFrame.get(ctx)?.get(a.run);
  if (a == null || made == null || ctx.frame !== 'sch') return next(args);
  const users = a.names.filter((n) => USER_VECTOR_RE.test(n) && made.vectors.has(n));
  if (users.length === 0) return next(args);
  const service = currentSimService();
  if (service == null) return next(args);
  if (ctx.simRun() != null) return fail('busy', 'a run is live');
  if (!service.live()) return fail('no_simulation', `run ${a.run}: the simulator was released`);
  const others = a.names.filter((n) => !users.includes(n));
  let bytes = users.reduce((n, name) => { const v = made.vectors.get(name)!; return n + v.length * 8 * (v.complex ? 2 : 1); }, 0);
  if (bytes > MAX_VECTOR_BYTES) return fail('island_error', 'the vectors are more than the protocol carries');
  const read = new Map<string, { name: string; real: Float64Array; imag: Float64Array | null }>();
  const transfer: ArrayBuffer[] = [];
  if (others.length > 0) {
    const base = await next({ run: a.run, names: others });
    if (!base.ok) return base;
    const vs = base.result.vectors;
    if (!Array.isArray(vs)) return fail('island_error', 'sim.vectors answered another shape');
    for (const v of vs as Array<{ name: string; real: Float64Array; imag: Float64Array | null }>) {
      read.set(v.name, v);
      bytes += v.real.byteLength + (v.imag?.byteLength ?? 0);
    }
    if (bytes > MAX_VECTOR_BYTES) return fail('island_error', 'the vectors are more than the protocol carries');
    transfer.push(...(base.transfer ?? []));
  }
  for (const name of users) {
    const split = splitVector(await service.request({ kind: 'get_vec_info', name: qualifiedVector(made.plot, name) }));
    // The plot is gone (a newer run of its kind, a released or dead service): the run is no longer held.
    if (split == null) { madeByFrame.get(ctx)?.delete(a.run); return fail('no_simulation', `run ${a.run}: the simulator holds no ${name}`); }
    read.set(name, { name, real: split.real, imag: split.imag });
    transfer.push(split.real.buffer as ArrayBuffer);
    if (split.imag != null) transfer.push(split.imag.buffer as ArrayBuffer);
  }
  const vectors = a.names.map((n) => read.get(n));
  if (vectors.some((v) => v == null)) return fail('island_error', 'sim.vectors answered another shape');
  return { ok: true, result: { vectors }, transfer };
}

export default {
  unit: 'm11-i',
  frames: ['sch'],
  frameRefusal: SIM_FRAME_ONLY,
  capNames: [USER_SIGNALS_CAP],
  caps: (mod, frame) => (frame === 'sch' && hasAll(mod, ['kicadSimUserSignals']) ? [USER_SIGNALS_CAP] : []),
  ops: {
    'sim.userSignals': { run: userSignals },
  },
  opsWidened: {
    'sim.vectors': vectorsWithUserSignals,
  },
} satisfies ExtUnit;
