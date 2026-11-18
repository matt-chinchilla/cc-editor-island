// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The 3D service in the island (PROTOCOL.md "The 3D service"): PCBJam's
// provider (loader/src/wasm/occ-service.ts) installed as globalThis.occService
// in a pcb frame, which KiCad's STEP exporter and its STEP model reader reach
// through the engine's stubs. The worker is made on the engine's first such
// request, so a frame that never exports in 3D never fetches the service.
// src/main.ts calls installOccService (read by glob); the island's own code
// reaches the installed service through occService() (the cap occ, the
// export's staging and its loading progress).
import { installOccService as installProvider, type OccServiceHandle } from '../loader/src/wasm/occ-service';

export type OccService = OccServiceHandle;

let installed: OccService | null = null;

/**
 * Installs the provider once per frame: null when one is already installed or
 * there is no service to serve (`wasmBytes` 0: PIN.json lists no
 * occ_service.wasm, so the island's dist carries none).
 */
export function installOccService(opts: { base: string; wasmBytes: number; log: (m: string) => void; fs?: () => EmscriptenFS | null | undefined }): OccService | null {
  if (!(Number.isSafeInteger(opts.wasmBytes) && opts.wasmBytes > 0)) return null;
  const handle = installProvider({
    base: opts.base,
    wasmBytes: opts.wasmBytes,
    log: opts.log,
    fs: opts.fs ?? (() => (globalThis as { FS?: EmscriptenFS }).FS ?? null),
  });
  if (handle == null) return null;
  installed = handle;
  return handle;
}

/** The service this frame installed, while its provider is still the one the engine calls; null otherwise. */
export function occService(): OccService | null {
  if (installed == null || globalThis.occService?.request !== installed.request) return null;
  return installed;
}

/** Forgets the installed service (the unit tests, between cases). */
export function forgetOccService(): void {
  installed = null;
}
