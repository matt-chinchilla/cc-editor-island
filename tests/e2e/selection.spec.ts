// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// Selection both ways on the real engine (PROTOCOL.md select and ev.selected),
// over the local pair (tests/serve.mjs) and the harness: the selection cap, a
// select by uuid that the editor takes and fits the view to (the engine's own
// viewport scale grows), the editor's own clicks and Escape reaching the host
// as ev.selected, an unknown uuid selecting nothing, and a schematic symbol
// selected by its uuid and by a footprint path.
import { expect, test, type Frame, type Page } from '@playwright/test';

const ISLAND = 'http://editor.circuitcenter.localhost:4174';

interface Ev { type: string; caps?: string[]; uuids?: string[]; fpPaths?: string[]; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }

const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const request = (page: Page, op: string, args?: unknown): Promise<Record<string, unknown>> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const);
const selected = async (page: Page): Promise<Ev[]> => (await events(page)).filter((e) => e.type === 'ev.selected');
const fixtureText = (page: Page, path: string): Promise<string> => page.evaluate(async (p) => (await fetch(`/fixtures/glasgow/${p}`)).text(), path);
/** The engine's viewport ({cx, cy, scale, w, h}, scale in pixels per internal unit). */
const viewport = (frame: Frame): Promise<{ scale: number }> =>
  frame.evaluate(() => JSON.parse(String((window as unknown as { Module: { kicadCollabGetViewport(): string } }).Module.kicadCollabGetViewport())));

function measure(type: string, description: string): void {
  test.info().annotations.push({ type, description });
  console.log(`[measure] ${type}: ${description}`);
}

async function boot(page: Page, query: string, opened: string): Promise<Frame> {
  await page.goto(`/parent.html?${query}`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready'), null, { timeout: 170_000 });
  await expect(page.locator('#state')).toContainText(`opened ${opened}`, { timeout: 120_000 });
  const frame = page.frames().find((f) => f.url().startsWith(`${ISLAND}/`));
  if (frame == null) throw new Error('no island frame');
  return frame;
}

/**
 * Each footprint of a board file: its own uuid (the first uuid or tstamp of
 * its block: KiCad 7 writes `(tstamp <uuid>)` unquoted, KiCad 8 and later
 * `(uuid "<uuid>")`) and its schematic path.
 */
function footprints(text: string): Array<{ uuid: string; path: string | null }> {
  const blocks = text.split(/\(footprint "/).slice(1);
  return blocks.map((b) => ({
    uuid: /\((?:uuid|tstamp) "?([0-9a-f-]{36})"?\)/.exec(b)?.[1] ?? '',
    path: /\(path "([^"]+)"\)/.exec(b)?.[1] ?? null,
  })).filter((f) => f.uuid !== '');
}

test('a board: select fits the view to a footprint and comes back as ev.selected; clicks, Escape and an unknown uuid too', async ({ page }) => {
  const frame = await boot(page, 'fixture=glasgow&frame=pcb', 'glasgow.kicad_pcb');
  const ready = (await events(page)).find((e) => e.type === 'ev.ready');
  expect(ready?.caps).toContain('selection');
  const fp = footprints(await fixtureText(page, 'glasgow.kicad_pcb')).find((f) => f.path != null);
  if (fp == null) throw new Error('no footprint with a path in the fixture');
  await request(page, 'view.fit');
  await page.waitForTimeout(1500);
  const before = await viewport(frame);

  const t0 = Date.now();
  expect(await request(page, 'select', { uuids: [fp.uuid], zoom: true })).toEqual({});
  measure('select answered', `${Date.now() - t0} ms`);
  await expect.poll(async () => (await selected(page)).at(-1), { timeout: 5_000 }).toMatchObject({ uuids: [fp.uuid], fpPaths: [fp.path] });
  measure('ev.selected after select', `${Date.now() - t0} ms`);
  await expect.poll(async () => (await viewport(frame)).scale, { timeout: 5_000 }).toBeGreaterThan(before.scale * 2);
  measure('zoom', `scale ${before.scale.toExponential(3)} -> ${(await viewport(frame)).scale.toExponential(3)}`);

  // The reader's Escape in the editor clears the selection: ev.selected says so, with empty arrays.
  const n = (await selected(page)).length;
  await request(page, 'key.press', { key: 'Escape', code: 'Escape' });
  await expect.poll(async () => (await selected(page)).length, { timeout: 5_000 }).toBe(n + 1);
  expect((await selected(page)).at(-1)).toMatchObject({ uuids: [], fpPaths: [] });

  // A real click on the footprint the view is now fitted to selects something there.
  const box = await page.locator('iframe').boundingBox();
  if (box == null) throw new Error('no iframe box');
  const t1 = Date.now();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(async () => (await selected(page)).at(-1)?.uuids?.length ?? 0, { timeout: 5_000 }).toBeGreaterThan(0);
  const clicked = (await selected(page)).at(-1);
  measure('ev.selected after a click', `${Date.now() - t1} ms: ${JSON.stringify(clicked?.uuids)} ${JSON.stringify(clicked?.fpPaths)}`);

  // An unknown uuid selects nothing and is answered all the same.
  expect(await request(page, 'select', { uuids: ['ffffffff-ffff-4fff-8fff-ffffffffffff'] })).toEqual({});
  await expect.poll(async () => (await selected(page)).at(-1), { timeout: 5_000 }).toMatchObject({ uuids: [], fpPaths: [] });
  // Each ev.selected carries exactly its keys.
  for (const e of await selected(page)) expect(Object.keys(e).sort()).toEqual(['at', 'fpPaths', 'type', 'uuids']);
});

test('a schematic: a symbol selected by its uuid and by a footprint path, sent back without paths', async ({ page }) => {
  await boot(page, 'fixture=glasgow&frame=sch', 'glasgow.kicad_sch');
  const text = await fixtureText(page, 'glasgow.kicad_sch');
  // The root sheet's first placed symbol: the first uuid after its lib_id.
  const sym = /\(symbol\s+\(lib_id "[^"]+"\)[\s\S]*?\(uuid "?([0-9a-f-]{36})"?\)/.exec(text)?.[1];
  if (sym == null) throw new Error('no symbol in the fixture');
  expect(await request(page, 'select', { uuids: [sym], zoom: true })).toEqual({});
  await expect.poll(async () => (await selected(page)).at(-1), { timeout: 5_000 }).toMatchObject({ uuids: [sym], fpPaths: [] });
  expect(await request(page, 'select', { uuids: [] })).toEqual({});
  await expect.poll(async () => (await selected(page)).at(-1), { timeout: 5_000 }).toMatchObject({ uuids: [], fpPaths: [] });
  // A footprint path on the root sheet: "/" and the symbol's uuid.
  expect(await request(page, 'select', { uuids: [], fpPaths: [`/${sym}`] })).toEqual({});
  await expect.poll(async () => (await selected(page)).at(-1), { timeout: 5_000 }).toMatchObject({ uuids: [sym], fpPaths: [] });
});
