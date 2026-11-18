// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The 3D service (PROTOCOL.md "The 3D service"): the cap occ, listed in a pcb
// frame while this island serves the service's files (PIN.json records both,
// src/main.ts installed the provider from the wasm's recorded size) and
// globalThis.occService is that provider. Without it the engine's 3D exports
// other than VRML have nothing to run on, and a host keeps their rows held.
// The bridge's close ends the service's worker at once.
import { occService } from '../../src/occ-service';
import type { ExtUnit } from './contract';

export const OCC_CAP = 'occ';

export default {
  unit: '3d-i1',
  capNames: [OCC_CAP],
  caps: (_mod, frame) => (frame === 'pcb' && occService() != null ? [OCC_CAP] : []),
  install(ctx) {
    if (ctx.frame !== 'pcb') return;
    return () => { occService()?.release(); };
  },
} satisfies ExtUnit;
