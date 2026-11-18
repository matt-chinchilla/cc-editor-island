// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The 3D service's cap and close (3d-i1): occ is listed in a pcb frame only
// while the frame's service is installed, never in a sch frame, and the
// bridge's close releases the service's worker.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startResponder } from '../responder';
import { buildRegistry, REGISTRY } from './registry';
import unit, { OCC_CAP } from './3d-i1';
import { forgetOccService, installOccService } from '../../src/occ-service';

const PARENT = 'http://localhost';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function fakePage(search: string) {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const parent = { postMessage: vi.fn() };
  const page = {
    parent,
    top: {},
    location: { search },
    addEventListener: (t: string, h: (e: unknown) => void) => { const s = listeners.get(t) ?? new Set(); s.add(h); listeners.set(t, s); },
    removeEventListener: (t: string, h: (e: unknown) => void) => listeners.get(t)?.delete(h),
    dispatch: (t: string, e: unknown) => { for (const h of listeners.get(t) ?? []) h(e); },
  };
  return { page: page as unknown as Window & { dispatch: (t: string, e: unknown) => void }, parent };
}

function fakeEngine(frameType: string) {
  const Module: Record<string, unknown> = { kicadOpenFileBusy: () => false };
  const win = {
    FS: { analyzePath: () => ({ exists: false }), mkdirTree: () => {}, readdir: () => [], readFile: () => { throw new Error('ENOENT'); } },
    Module,
    wxElementRegistry: { findAll: () => [{ id: 'frame', typeName: frameType, name: 'Frame', visible: true }], findByLabel: () => [] },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    dispatchEvent: () => true,
  } as unknown as ToolWindow;
  return win;
}

async function boot(frame: 'pcb' | 'sch') {
  const reg = buildRegistry({ './3d-i1.ts': { default: unit } }, {}, {});
  expect(reg.problems).toEqual([]);
  const { page, parent } = fakePage(`?frame=${frame}&theme=day`);
  const r = startResponder({ parentOrigin: PARENT, page, ext: reg });
  const ch = new MessageChannel();
  const got: Array<Record<string, unknown>> = [];
  ch.port1.onmessage = (m) => got.push(m.data);
  page.dispatch('message', { origin: PARENT, source: page.parent, data: { type: 'cc.connect', nonce: parent.postMessage.mock.calls[0][0].nonce }, ports: [ch.port2] });
  r.engineReady(fakeEngine(frame === 'pcb' ? 'PCB_EDIT_FRAME' : 'SCH_EDIT_FRAME'), { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
  await settle();
  const ready = got.find((m) => m.type === 'ev.ready') as { caps: string[] } | undefined;
  return { r, got, ready, port: ch.port1 };
}

beforeEach(() => {
  vi.stubGlobal('KeyboardEvent', class extends Event {
    constructor(type: string, init: Record<string, unknown> = {}) {
      const { bubbles, cancelable, composed, ...rest } = init as EventInit & Record<string, unknown>;
      super(type, { bubbles, cancelable, composed });
      Object.assign(this, rest);
    }
  });
  delete globalThis.occService;
  forgetOccService();
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete globalThis.occService;
  forgetOccService();
});

describe('3d-i1: the cap occ', () => {
  it('is in the checkout registry, owning its cap', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect(REGISTRY.units.map((u) => u.unit)).toContain('3d-i1');
    expect(REGISTRY.capNames.get(OCC_CAP)).toBe('3d-i1');
  });

  it('is listed in a pcb frame while the service is installed', async () => {
    installOccService({ base: '/b/', wasmBytes: 1234, log: () => undefined });
    const { ready } = await boot('pcb');
    expect(ready?.caps).toContain(OCC_CAP);
  });

  it('is absent in a pcb frame with no service (an island that serves none)', async () => {
    expect(installOccService({ base: '/b/', wasmBytes: 0, log: () => undefined })).toBeNull();
    const { ready } = await boot('pcb');
    expect(ready).toBeDefined();
    expect(ready?.caps).not.toContain(OCC_CAP);
  });

  it('is never listed in a sch frame', async () => {
    installOccService({ base: '/b/', wasmBytes: 1234, log: () => undefined });
    const { ready } = await boot('sch');
    expect(ready).toBeDefined();
    expect(ready?.caps).not.toContain(OCC_CAP);
  });

  it('caps() answers by frame and installation alone', () => {
    expect(unit.caps({}, 'pcb')).toEqual([]);
    installOccService({ base: '/b/', wasmBytes: 1234, log: () => undefined });
    expect(unit.caps({}, 'pcb')).toEqual([OCC_CAP]);
    expect(unit.caps({}, 'sch')).toEqual([]);
  });
});

describe('3d-i1: the close', () => {
  it('releases the service when the bridge stops, in a pcb frame', () => {
    const s = installOccService({ base: '/b/', wasmBytes: 1234, log: () => undefined })!;
    const release = vi.spyOn(s, 'release');
    const stop = unit.install({ frame: 'pcb' } as Parameters<typeof unit.install>[0]);
    expect(typeof stop).toBe('function');
    (stop as () => void)();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('installs nothing in a sch frame', () => {
    expect(unit.install({ frame: 'sch' } as Parameters<typeof unit.install>[0])).toBeUndefined();
  });
});
