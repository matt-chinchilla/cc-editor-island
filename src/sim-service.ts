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
  return {
    request: (req) => handle.request(req),
    release: () => handle.release(),
    live: () => handle.live(),
    listen: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
}
