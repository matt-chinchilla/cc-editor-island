// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The simulator's faults, island side (wave 2 E2, ledger SI1 to SI3): the run
// guard on ev.sim (a progress or end notice of a run that is not the live one
// is dropped, one end per run) and on sim.result (an answer is the asked
// run's own result, or no_simulation), and Stop's watch: after a Stop, a
// service worker that cannot carry it out is ended so the run ends
// (docs/si1-stop-diagnosis.md). The guard is pure, in bridge/sim.ts, the watch
// in src/sim-service.ts; this file wires both into the responder.
import { fail, type ExtUnit, type ResponderCtx } from './contract';
import { guardResult, parseResultArgs, SimRunGuard } from '../sim';
import { currentSimService, endIfWedged } from '../../src/sim-service';

/** The run each frame's Stop watch watches: one watch at a time, a second Stop of the same run starts none. */
const watching = new WeakMap<ResponderCtx, number>();
/** Each frame's guard: the responder's ctx is one object for the frame's life. */
const guards = new WeakMap<ResponderCtx, SimRunGuard>();
const guardOf = (ctx: ResponderCtx): SimRunGuard => {
  let g = guards.get(ctx);
  if (g == null) { g = new SimRunGuard(); guards.set(ctx, g); }
  return g;
};

export default {
  unit: 'lo-e2-i',
  eventGuards: {
    'ev.sim': (ev, ctx) => guardOf(ctx).keep(ev, ctx.simRun()),
  },
  opsWidened: {
    // Stop, then the watch while the run is still live (answered at once, off the queue, as before).
    'sim.stop': async (args, ctx, next) => {
      const answer = await next(args);
      const run = ctx.simRun();
      const service = currentSimService();
      if (answer.ok && run != null && service != null && watching.get(ctx) !== run) {
        watching.set(ctx, run);
        const call = (name: string): unknown => {
          const f = ctx.mod()?.[name];
          return typeof f === 'function' ? (f as () => unknown)() : undefined;
        };
        void endIfWedged(service, {
          live: () => !ctx.closed() && ctx.simRun() === run,
          engineBusy: () => { try { return call('kicadCollabBusy') === true; } catch { return true; } },
          restop: () => { try { call('kicadSimStop'); } catch { /* the record or the death path ends it */ } },
          log: (m) => ctx.log(m),
        }).catch(() => undefined).finally(() => { if (watching.get(ctx) === run) watching.delete(ctx); });
      }
      return answer;
    },
    // sim.result's run guard: the result answered is the asked run's own.
    'sim.result': async (args, _ctx, next) => {
      const answer = await next(args);
      const a = parseResultArgs(args);
      if (a == null || guardResult(a.run, answer) === 'keep') return answer;
      return fail('no_simulation', `run ${a.run}`);
    },
  },
} satisfies ExtUnit;
