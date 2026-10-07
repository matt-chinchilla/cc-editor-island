// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { describe, expect, it, vi } from 'vitest';
import { memoryBundleStore } from '../loader/src/wasm/libs/bundle-store';
import { mirrorLibsSource } from '../loader/src/wasm/libs/mirror-source';
import type { LibsSource } from '../loader/src/wasm/libs/source';
import { chooseLibs, libsBase, warmUpOnEnumerate, WARM_UP_CONCURRENCY } from './libs';

const TAG = '10.0.4';
const mirrorOver = (fetchImpl: typeof fetch) =>
  mirrorLibsSource({ base: libsBase(TAG), tag: TAG, fetchImpl, storeFactory: async () => memoryBundleStore(), retryDelaysMs: [0, 0, 0] });

describe('the libraries the island boots on', () => {
  it('the mirror lives at /libs/<tag>/ on the island origin', () => {
    expect(libsBase('10.0.4')).toBe('/libs/10.0.4/');
  });

  it('are the mirror when its manifest reads', async () => {
    const manifest = { schema: 1, tag: TAG, libs: [{ id: 'sym.Device', name: 'Device', kind: 'symbol', itemCount: 1, bytes: 9 }] };
    const fetchImpl = (async () => new Response(JSON.stringify(manifest), { status: 200 })) as typeof fetch;
    const mirror = mirrorOver(fetchImpl);
    const log = vi.fn();
    const choice = await chooseLibs(mirror, log);
    expect(choice.mirror).toBe(mirror);
    expect(choice.source).toBe(mirror);
    expect((await choice.source.listLibs('symbol')).map((l) => l.name)).toEqual(['Device']);
    expect(log).not.toHaveBeenCalled();
  });

  it('are the built-in examples when the manifest cannot be read, and that is logged', async () => {
    for (const fetchImpl of [
      async () => new Response('', { status: 404 }),
      async () => new Response('', { status: 503 }),
      async () => { throw new TypeError('Failed to fetch'); },
      async () => new Response('<html>not json</html>', { status: 200 }),
      async () => new Response(JSON.stringify({ schema: 1, tag: '9.0.0', libs: [] }), { status: 200 }),
    ]) {
      const log = vi.fn();
      const choice = await chooseLibs(mirrorOver(fetchImpl as typeof fetch), log);
      expect(choice.mirror).toBeNull();
      expect(await choice.source.listLibs('symbol')).toEqual([{ id: 'examples', name: 'pcbjam-examples', description: 'Built-in example symbols (offline)' }]);
      expect(await choice.source.listLibs('footprint')).toEqual([]);
      expect(await choice.source.getItemBody('examples', 'symbol', 'R')).toContain('(symbol "R"');
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0][0]).toMatch(/^\[libs\] the library mirror could not be read \(.+\); booting on the built-in example library$/);
    }
  });
});

describe('the warm-up on the first enumerate', () => {
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('starts the kind\'s presync once, several bundles at a time, and never holds the crossing', async () => {
    let finish!: () => void;
    const presync = vi.fn<NonNullable<LibsSource['presync']>>(() => new Promise<void>((r) => { finish = r; }));
    const log = vi.fn();
    const settled: string[] = [];
    const gate = warmUpOnEnumerate({ presync }, log, undefined, (k) => settled.push(k));
    // Resolved at once, while the presync is still running.
    await expect(gate('symbol')).resolves.toBeUndefined();
    await expect(gate('symbol')).resolves.toBeUndefined();
    expect(presync).toHaveBeenCalledTimes(1);
    expect(presync.mock.calls[0][0]).toMatchObject({ kind: 'symbol', concurrency: WARM_UP_CONCURRENCY });
    expect(WARM_UP_CONCURRENCY).toBeGreaterThanOrEqual(6);
    expect(WARM_UP_CONCURRENCY).toBeLessThanOrEqual(8);
    // Each kind once.
    await gate('footprint');
    expect(presync).toHaveBeenCalledTimes(2);
    expect(presync.mock.calls[1][0]).toMatchObject({ kind: 'footprint' });
    finish();
    await settle();
    expect(settled).toEqual(['footprint']);
    expect(log.mock.calls.at(-1)?.[0]).toMatch(/^\[libs\] footprint warm-up done: /);
  });

  it('starts nothing once the frame is going, and survives a presync that rejects', async () => {
    const presync = vi.fn<NonNullable<LibsSource['presync']>>(async () => { throw new Error('boom'); });
    const ctl = new AbortController();
    const settled: string[] = [];
    const gate = warmUpOnEnumerate({ presync }, () => undefined, ctl.signal, (k) => settled.push(k));
    await gate('symbol');
    await settle();
    expect(settled).toEqual(['symbol']);
    ctl.abort();
    await gate('footprint');
    expect(presync).toHaveBeenCalledTimes(1);
    expect(presync.mock.calls[0][0]?.signal).toBe(ctl.signal);
  });

  it('is a no-op over a source with no presync', async () => {
    await expect(warmUpOnEnumerate({}, () => undefined)('symbol')).resolves.toBeUndefined();
  });
});
