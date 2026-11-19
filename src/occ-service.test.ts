// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The island's 3D service installer (3d-i1): installed only when the island
// serves the service, once, and reachable as occService() while its provider
// is the one the engine calls.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error a plain ES module of the scripts folder, with no types
import { leadingComment, readNotices } from '../scripts/notices.mjs';
import pristineService from '../loader/pristine/wasm/occ-service.ts?raw';
import pristineWorker from '../loader/pristine/wasm/occ-worker.js?raw';
import srcService from '../loader/src/wasm/occ-service.ts?raw';
import srcWorker from '../loader/src/wasm/occ-worker.js?raw';
import { forgetOccService, installOccService, occService } from './occ-service';

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

// RULINGS 33h: the two files restored from PCBJam are listed on the licenses
// page as files we changed: each has PCBJam's unmodified copy in
// loader/pristine, keeps that copy's leading comment verbatim, differs from it
// and carries our dated notices, as scripts/notices.mjs census() reads them.
describe('the restored 3D service files in the notices census', () => {
  it('each has its unmodified PCBJam copy, keeps its leading comment and carries dated notices', () => {
    for (const [rel, orig, src] of [['occ-service.ts', pristineService, srcService], ['occ-worker.js', pristineWorker, srcWorker]] as const) {
      expect(src, rel).not.toBe(orig);
      expect(src.includes((leadingComment(orig) as string[]).join('\n')), `${rel} keeps PCBJam's leading comment verbatim`).toBe(true);
      const notices = readNotices(src) as Array<{ date: string }>;
      expect(notices.length, rel).toBeGreaterThan(0);
    }
  });
});
