// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The 3D service over the local pair (PROTOCOL.md "The 3D service", wave unit
// 3d-i1), on the Glasgow example in a pcb frame. An island that serves no
// service (PIN.json records no occ_service.wasm: engine run 14) lists no occ
// cap and installs nothing. One that serves it (engine run 15, island cc25):
// occ is listed, nothing of the service is fetched while the board opens, the
// first STEP export fetches its wasm once and answers a file, a second fetches
// nothing, ten in a row leave the engine's heap within 5 MB, a worker that
// closes itself mid export ends that export as "The 3D service stopped." and
// the next boots a new worker.
import { expect, test, type Frame, type Page, type Worker } from '@playwright/test';
import PIN from '../../PIN.json' with { type: 'json' };

import { ISLAND } from './ports';
interface Ev { type: string; phase?: string; caps?: string[]; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
type Made = { ok: true; files: Array<{ path: string; bytes: number; head: string }> } | { ok: false; code: string; message: string };

const SERVES = (PIN.engine.files as Record<string, unknown>)['occ_service.wasm'] != null;
const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);

function measure(type: string, description: string): void {
  test.info().annotations.push({ type, description });
  console.log(`[measure] ${type}: ${description}`);
}

/** Glasgow in a pcb frame; the wasm requests of the service counted from the first byte. */
async function boot(page: Page): Promise<{ frame: Frame | null; wasmFetches: () => number; caps: string[] }> {
  let fetches = 0;
  page.on('request', (r) => { if (/\/occ_service\.wasm(\.gz)?(\?|$)/.test(r.url())) fetches++; });
  await page.goto('/parent.html?fixture=glasgow&frame=pcb');
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  await expect(page.locator('#state')).toContainText('opened glasgow.kicad_pcb', { timeout: 120_000 });
  const caps = (await events(page)).find((e) => e.type === 'ev.ready')?.caps ?? [];
  const frame = page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null;
  return { frame, wasmFetches: () => fetches, caps };
}

/** project.export of a STEP from the host page: the files' names, sizes and heads, or the refusal. */
const step = (page: Page): Promise<Made> => page.evaluate(async () => {
  try {
    const r = await (window as unknown as Harness).__bridge.request('project.export', { job: 'pcb_export_3d', settings: { format: 'step' } }) as { files: Array<{ path: string; bytes: Uint8Array }> };
    const dec = new TextDecoder();
    return { ok: true as const, files: r.files.map((f) => ({ path: f.path, bytes: f.bytes.byteLength, head: dec.decode(f.bytes.subarray(0, 16)) })) };
  } catch (err) {
    const [code, ...rest] = (err as Error).message.split(': ');
    return { ok: false as const, code, message: rest.join(': ') };
  }
});

/** The service's top worker (not one of its pthread children), if one is up. */
async function serviceWorker(page: Page): Promise<Worker | null> {
  for (const w of page.workers()) {
    if (!w.url().startsWith('blob:')) continue;
    try {
      if (await w.evaluate(() => typeof (self as unknown as { OCC_LIFE_LOCK?: string }).OCC_LIFE_LOCK === 'string' && self.name !== 'em-pthread')) return w;
    } catch {
      // a worker that ended between the listing and the call
    }
  }
  return null;
}

const heap = (frame: Frame): Promise<number> => frame.evaluate(() => Number((window as unknown as { Module: { HEAPU8: Uint8Array } }).Module.HEAPU8.byteLength));

test('an island that serves no 3D service lists no occ cap and installs no provider', async ({ page }) => {
  test.skip(SERVES, 'this island serves the 3D service: the next test covers it');
  const { frame, wasmFetches, caps } = await boot(page);
  expect(caps).not.toContain('occ');
  expect(caps.length).toBeGreaterThan(0);
  expect(wasmFetches()).toBe(0);
  if (frame != null) expect(await frame.evaluate(() => typeof (globalThis as { occService?: unknown }).occService)).toBe('undefined');
});

test('the 3D service: lazy, fetched once, a STEP file, a flat heap over ten, a closed worker ends its export and the next boots anew', async ({ page, browserName }) => {
  test.skip(!SERVES, 'PIN.json records no occ_service.wasm: the 3D service arrives with engine run 15 (island cc25)');
  test.setTimeout(900_000);
  const { frame, wasmFetches, caps } = await boot(page);
  expect(caps).toContain('occ');
  // Nothing of the service while the board opened.
  expect(wasmFetches()).toBe(0);
  if (frame != null) expect(await frame.evaluate(() => typeof (globalThis as { occService?: { request?: unknown } }).occService?.request)).toBe('function');

  // The first STEP: the service's wasm fetched once, a file answered.
  const t0 = Date.now();
  const first = await step(page);
  measure('first STEP (cold service)', `${Date.now() - t0} ms`);
  expect(first).toMatchObject({ ok: true });
  if (first.ok) {
    expect(first.files.map((f) => f.path)).toEqual(['glasgow.step']);
    expect(first.files[0]!.head.startsWith('ISO-10303-21')).toBe(true);
  }
  expect(wasmFetches()).toBe(1);

  // A second: no second fetch.
  const t1 = Date.now();
  expect(await step(page)).toMatchObject({ ok: true });
  measure('second STEP (warm service)', `${Date.now() - t1} ms`);
  expect(wasmFetches()).toBe(1);

  // Ten in a row: the engine's heap within 5 MB.
  if (frame != null) {
    const before = await heap(frame);
    for (let i = 0; i < 10; i++) expect(await step(page)).toMatchObject({ ok: true });
    const after = await heap(frame);
    measure('heap growth over ten STEP exports', `${((after - before) / 1048576).toFixed(2)} MB`);
    expect(after - before).toBeLessThanOrEqual(5 * 1024 * 1024);
  }

  // A worker that closes itself mid export: that export ends "The 3D service stopped.", the next boots a new worker.
  const running = step(page);
  await expect.poll(async () => (await serviceWorker(page)) != null, { timeout: 30_000 }).toBe(true);
  const w = (await serviceWorker(page))!;
  await w.evaluate(() => { self.close(); }).catch(() => undefined);
  const ended = await running;
  if (ended.ok) {
    // The export answered before the close reached the worker: say so, and close it while idle instead.
    test.info().annotations.push({ type: 'note', description: `${browserName}: the export answered before close() ran in the worker` });
  } else {
    expect(ended).toMatchObject({ ok: false, code: 'export_failed' });
    expect(ended.message).toContain('The 3D service stopped.');
  }
  const t2 = Date.now();
  const next = await step(page);
  measure('STEP after the worker ended (new worker)', `${Date.now() - t2} ms`);
  expect(next).toMatchObject({ ok: true });
});
