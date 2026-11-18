// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The simulator service in the island (PROTOCOL.md sim.*): PCBJam's provider
// (loader/src/wasm/ngspice-service.ts) installed as globalThis.ngspiceService,
// which KiCad's NGSPICE reaches through the engine's sharedspice client. The
// worker is made on the engine's first request (KiCad's NGSPICE::Init, which
// the island's first sim.run makes), so a frame that never runs a simulation
// never fetches the service. The island hears every notice the provider sends
// (the run's progress lines, the wasm's loading, the worker's end) and reads
// vectors straight from it (sim.vectors), never through the editor's heap.

import { installNgspiceService, type NgspiceNotice, type NgspiceRequest, type NgspiceResponse } from '../loader/src/wasm/ngspice-service';

export interface SimService {
  request(req: NgspiceRequest): Promise<NgspiceResponse>;
  /** Ends the worker now when there is one; the next request boots a fresh one. */
  release(): boolean;
  /** Whether a worker is booted or booting. */
  live(): boolean;
  /** Hears every notice from now on; the answer stops it. */
  listen(fn: (n: NgspiceNotice) => void): () => void;
}

/** The frame's service once installSimService made it (one per window: the provider is a global). */
let installed: SimService | null = null;
/** The service installSimService made in this window, or null. */
export const currentSimService = (): SimService | null => installed;

/**
 * Stop's watch (SI1, docs/si1-stop-diagnosis.md). A Stop reaches ngspice as a
 * request to the service's worker (KiCad's NGSPICE::Stop, bg_halt), and the
 * engine then waits for ngspice's thread to end. Measured on engine run 14
 * with a transient whose step is very small against its span (1 ns over
 * 200 ms or 2 s), two ways the run never ended: ngspice's output storage
 * passed the service's 4 GiB memory and its worker answered nothing more, the
 * halt included, while the engine waited on it; or ngspice's allocation
 * failed ("malloc: can't allocate"), its thread ended with "cannot recover and
 * awaits to be reset", and no record was written, a halt then finding no
 * thread to end. So after a Stop, while the run is still live, the island
 * reads the worker every `graceMs`: running, it is left to end the run; not
 * answering within `probeMs`, or answering that ngspice runs nothing while the
 * engine is idle twice in a row, the worker is ended (release, which settles
 * what the engine waits on) and the engine asked to stop again: it finds no
 * run in the fresh service and finishes the run itself (kicadSimStop's own
 * path for a service with no run; the end's phase is the engine's record). The next run boots a
 * fresh worker. Stop's watch gives up after `maxMs`.
 */
export const STOP_WATCH = { graceMs: 300, probeMs: 250, maxMs: 30_000 } as const;
export type StopWatchTiming = { graceMs: number; probeMs: number; maxMs: number };
export type StopWatchEnd = 'ended' | 'over' | 'answering';
export interface StopWatchRun {
  /** The stopped run is still live. */
  live(): boolean;
  /** The engine is working (its apply coroutine: a finish reading the results). */
  engineBusy(): boolean;
  /** Asks the engine to stop the run again (kicadSimStop). */
  restop(): void;
  log(m: string): void;
}

export async function endIfWedged(service: SimService, run: StopWatchRun, timing: StopWatchTiming = STOP_WATCH): Promise<StopWatchEnd> {
  const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });
  const t0 = Date.now();
  let idle = 0;
  for (;;) {
    await wait(timing.graceMs);
    if (!run.live()) return 'over';
    if (Date.now() - t0 >= timing.maxMs) return 'answering';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = await Promise.race([
      service.request({ kind: 'running' }).then((r) => (r.error === undefined && typeof r.running === 'boolean' ? (r.running ? 'running' : 'idle') : 'silent'), () => 'silent' as const),
      new Promise<'silent'>((resolve) => { timer = setTimeout(() => resolve('silent'), timing.probeMs); }),
    ]);
    clearTimeout(timer);
    if (!run.live()) return 'over';
    idle = read === 'idle' && !run.engineBusy() ? idle + 1 : 0;
    if (read === 'silent' || idle >= 2) {
      run.log(read === 'silent'
        ? `[sim] the service did not answer within ${timing.probeMs} ms of a Stop: its worker is ended`
        : '[sim] ngspice runs nothing and the engine waits on no end: the worker is ended');
      service.release();
      run.restop();
      return 'ended';
    }
  }
}

/**
 * Installs the provider once per frame: null when one is already installed or
 * there is no service to serve (`wasmBytes` 0: PIN.json lists no
 * ngspice_service.wasm, so the island's dist carries none).
 */
export function installSimService(opts: { base: string; wasmBytes: number; log: (m: string) => void }): SimService | null {
  if (!(Number.isSafeInteger(opts.wasmBytes) && opts.wasmBytes > 0)) return null;
  const listeners = new Set<(n: NgspiceNotice) => void>();
  const handle = installNgspiceService({
    base: opts.base,
    wasmBytes: opts.wasmBytes,
    log: opts.log,
    onNotice: (n) => {
      for (const fn of [...listeners]) {
        try { fn(n); } catch (err) { opts.log(`[sim] a listener failed: ${String(err)}`); }
      }
    },
  });
  if (handle == null) return null;
  installed = {
    request: (req) => handle.request(req),
    release: () => handle.release(),
    live: () => handle.live(),
    listen: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
  return installed;
}
