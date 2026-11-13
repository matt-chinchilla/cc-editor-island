// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The loader's wasm fetch (loader/src/wasm/boot.ts fetchWasmWithProgress): the
// engine is compiled from the fetch's own Response, and the download progress
// and the provenance line are read from a clone of it. A browser keeps its
// compiled code for a wasm module only for a Response its network stack made;
// one built in script (new Response(stream)) carries no cache handle, and the
// loader's old byte-counting stream was one (measured 2026-11-13: no cache hit
// in any boot, 9,272 functions compiled lazily on the main thread per two
// engines; with the fetch's Response, a hit and 15).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWasmWithProgress } from '../loader/src/wasm/boot';

const URL_ = 'http://editor.localhost/r/v0/wasm/kicad_editor/v0.2.3/kicad_editor.wasm';

/** A network-like Response: `chunks` as its body, served as wasm. */
function wasmResponse(chunks: Uint8Array[], headers: Record<string, string> = {}): Response {
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < chunks.length) c.enqueue(chunks[i++]);
      else c.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/wasm', ...headers } });
}

/** `n` bytes, each its index modulo 251. */
function bytes(n: number, from = 0): Uint8Array<ArrayBuffer> {
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = (from + i) % 251;
  return a;
}

function stubFetch(res: Response) {
  const fetchMock = vi.fn(async () => res);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The first 24 hex digits of the sha256 of `data`, as the provenance line prints them. */
const sha24 = async (data: Uint8Array<ArrayBuffer>): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', data)).slice(0, 12)].map((x) => x.toString(16).padStart(2, '0')).join('');
const until = async (cond: () => boolean): Promise<void> => {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < 2_000) await new Promise((r) => setTimeout(r, 2));
};

describe('fetchWasmWithProgress', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('answers the fetch\'s own Response with its body unread, so the engine is compiled from it and the compiled code can be cached', async () => {
    const chunks = [bytes(1000), bytes(2000, 1000), bytes(500, 3000)];
    const res = wasmResponse(chunks, { 'content-length': '3500' });
    const fetchMock = stubFetch(res);
    const progress: Array<[number, number]> = [];
    const got = await fetchWasmWithProgress(URL_, (loaded, total) => progress.push([loaded, total]));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(URL_);
    expect(got).toBe(res);   // the same object: never a Response built in script
    expect(got.bodyUsed).toBe(false);
    expect(got.headers.get('content-type')).toBe('application/wasm');
    // The compile still reads every byte, whatever the counter read.
    const all = new Uint8Array(await got.arrayBuffer());
    expect(all.byteLength).toBe(3500);
    expect(await sha24(all)).toBe(await sha24(bytes(3500)));
    await until(() => progress.length === 3);
    expect(progress).toEqual([[1000, 3500], [3000, 3500], [3500, 3500]]);
  });

  it('counts the download on a clone: every chunk as progress, the last byte once as done, and the provenance line of the head', async () => {
    const head = 128 * 1024;
    const chunks = [bytes(100_000), bytes(100_000, 100_000), bytes(50_000, 200_000)];
    stubFetch(wasmResponse(chunks, { 'content-length': '70000', etag: '"abc-1"' }));
    const progress: number[] = [];
    const done = vi.fn();
    const lines: string[] = [];
    const got = await fetchWasmWithProgress(URL_, (loaded) => progress.push(loaded), null, done, (line) => lines.push(line));
    expect(done).not.toHaveBeenCalled();   // nothing is read before the caller has the Response
    await got.arrayBuffer();
    await until(() => done.mock.calls.length > 0 && lines.length > 0);
    expect(progress).toEqual([100_000, 200_000, 250_000]);
    expect(done).toHaveBeenCalledTimes(1);
    // One line, as before: the file, the ETag, the first 128 KiB hashed, the Content-Length as the bytes on the wire.
    expect(lines).toEqual([`[build] wasm kicad_editor/v0.2.3/kicad_editor.wasm etag="abc-1" head128k-sha256=${await sha24(bytes(head))} streamed=70000B`]);
  });

  it('a file shorter than the hashed head says its own length, and an expected size wins over Content-Length as the total', async () => {
    stubFetch(wasmResponse([bytes(300), bytes(200, 300)], { 'content-length': '120' }));
    const progress: Array<[number, number]> = [];
    const lines: string[] = [];
    const done = vi.fn();
    const got = await fetchWasmWithProgress(URL_, (loaded, total) => progress.push([loaded, total]), 500, done, (line) => lines.push(line));
    await got.arrayBuffer();
    await until(() => lines.length > 0);
    expect(progress).toEqual([[300, 500], [500, 500]]);
    expect(lines).toEqual([`[build] wasm kicad_editor/v0.2.3/kicad_editor.wasm etag=none head128k-sha256=${await sha24(bytes(500))} streamed=500B`]);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('with no progress to report it answers the Response untouched, and a failed fetch throws its status', async () => {
    const res = wasmResponse([bytes(10)]);
    const clone = vi.spyOn(res, 'clone');
    stubFetch(res);
    expect(await fetchWasmWithProgress(URL_)).toBe(res);
    expect(clone).not.toHaveBeenCalled();
    stubFetch(new Response('no', { status: 404 }));
    await expect(fetchWasmWithProgress(URL_, () => undefined)).rejects.toThrow(`HTTP 404 fetching ${URL_}`);
  });

  it('a download that breaks ends the count quietly: the compile reading the Response reports it', async () => {
    let n = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        n += 1;
        if (n === 1) c.enqueue(bytes(100));
        else c.error(new Error('the connection dropped'));
      },
    });
    stubFetch(new Response(body, { status: 200, headers: { 'content-type': 'application/wasm' } }));
    const done = vi.fn();
    const got = await fetchWasmWithProgress(URL_, () => undefined, null, done);
    await expect(got.arrayBuffer()).rejects.toThrow('the connection dropped');
    // The count's own read failed too: it says no last byte, and leaves nothing unhandled (the run would fail on it).
    await new Promise((r) => setTimeout(r, 20));
    expect(done).not.toHaveBeenCalled();
  });
});
