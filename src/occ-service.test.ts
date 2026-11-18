// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The island's 3D service installer (3d-i1): installed only when the island
// serves the service, once, and reachable as occService() while its provider
// is the one the engine calls.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetOccService, installOccService, occService } from './occ-service';
// The provider's own cases live beside it (loader/src/wasm/occ-service.test.ts),
// outside the test include of vite.config.ts (src, bridge and theme): imported
// here so they run with the suite.
import '../loader/src/wasm/occ-service.test';

beforeEach(() => {
  vi.stubGlobal('window', { location: { href: 'https://editor.example/r/x/index.html' } });
  delete globalThis.occService;
  forgetOccService();
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete globalThis.occService;
  forgetOccService();
});

describe('installOccService', () => {
  it('installs nothing when the island serves no service', () => {
    expect(installOccService({ base: '/b/', wasmBytes: 0, log: () => undefined })).toBeNull();
    expect(globalThis.occService).toBeUndefined();
    expect(occService()).toBeNull();
  });

  it('installs the provider once, lazily, and answers it as occService()', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const s = installOccService({ base: '/b/', wasmBytes: 1234, log: () => undefined });
    expect(s).not.toBeNull();
    expect(globalThis.occService?.request).toBe(s!.request);
    expect(occService()).toBe(s);
    expect(s!.live()).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(installOccService({ base: '/b/', wasmBytes: 1234, log: () => undefined })).toBeNull();
    expect(occService()).toBe(s);
  });

  it('answers null once another provider took globalThis.occService', () => {
    installOccService({ base: '/b/', wasmBytes: 1234, log: () => undefined });
    globalThis.occService = { request: async () => ({ ok: false }) };
    expect(occService()).toBeNull();
  });
});
