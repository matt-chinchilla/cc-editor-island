// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// island v0.2.3-cc16 over the local pair (PROTOCOL.md ev.properties): our
// engine (kicad cc/main ffe73d65, pcbjam cc/main b1b5635; engine run 11) asks
// the page before KiCad's symbol properties dialog opens, and the island takes
// the request for a symbol: a double-click on its body, or E over it, sends
// ev.properties with its uuid and sheet path, the symbol stays selected and no
// KiCad dialog opens. A label keeps KiCad's own dialog. The fixture is the
// unnumbered sheet (three resistors in a row) with one label added here.
import { expect, test, type Frame, type Page } from '@playwright/test';

const ISLAND = 'http://editor.localhost:4174';
interface Ev { type: string; open?: boolean; caps?: string[]; uuids?: string[]; sheetPath?: string; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Viewport { cx: number; cy: number; scale: number; w: number; h: number }

/** The unnumbered fixture's left resistor: Device:R at (50.8, 63.5) mm, its body 2.032 by 5.08 mm, its value text at the center. */
const LEFT = '7a1f0c2e-3b4d-4e5f-8a9b-0c1d2e3f4a51';
/** A point on the left resistor's body, clear of its value text (the text runs along the body's middle). */
const BODY = { x: 50.8, y: 61.3 };
/** The label added to the fixture, its text running right and up from its anchor. */
const LABEL = '7a1f0c2e-3b4d-4e5f-8a9b-0c1d2e3f4b01';
const LABEL_AT = { x: 63.5, y: 50.8 };
/** A schematic internal unit is 100 nm. */
const IU_PER_MM = 10_000;

function measure(type: string, description: string): void {
  test.info().annotations.push({ type, description });
  console.log(`[measure] ${type}: ${description}`);
}
const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const of = async (page: Page, type: string): Promise<Ev[]> => (await events(page)).filter((e) => e.type === type);
const request = (page: Page, op: string, args?: unknown): Promise<Record<string, unknown>> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const);
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** The unnumbered sheet with one local label "SIG" added above the resistors. */
async function bootWithLabel(page: Page): Promise<Frame> {
  await page.goto('/parent.html?frame=sch');
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready'), null, { timeout: 170_000 });
  const frame = page.frames().find((f) => f.url().startsWith(`${ISLAND}/`));
  if (frame == null) throw new Error('no island frame');
  const opened = await page.evaluate(async ([uuid, x, y]) => {
    const get = async (p: string) => (await fetch(`/fixtures/unnumbered/${p}`)).text();
    const sch = (await get('unnumbered.kicad_sch')).trimEnd();
    const label = `  (label "SIG" (at ${x} ${y} 0) (fields_autoplaced)\n    (effects (font (size 1.27 1.27)) (justify left bottom))\n    (uuid ${uuid})\n  )\n`;
    const text = `${sch.slice(0, sch.lastIndexOf(')'))}${label})\n`;
    const enc = new TextEncoder();
    const files = [{ path: 'unnumbered.kicad_pro', bytes: enc.encode(await get('unnumbered.kicad_pro')) }, { path: 'unnumbered.kicad_sch', bytes: enc.encode(text) }];
    return (window as unknown as Harness).__bridge.request('project.open', { name: 'unnumbered', files });
  }, [LABEL, LABEL_AT.x, LABEL_AT.y] as const);
  expect(opened).toMatchObject({ opened: 'unnumbered.kicad_sch' });
  await page.waitForTimeout(1_500);   // the open's baseline read and its fit
  return frame;
}

/** A sheet point (mm) in page coordinates, through the engine's own viewport and its canvas's place in the frame. */
async function pageAt(page: Page, frame: Frame, mm: { x: number; y: number }): Promise<{ x: number; y: number }> {
  const v = JSON.parse(await frame.evaluate(() => String((window as unknown as { Module: { kicadCollabGetViewport(): string } }).Module.kicadCollabGetViewport()))) as Viewport;
  const canvas = await frame.evaluate(() => {
    const all = [...document.querySelectorAll('canvas')].map((c) => c.getBoundingClientRect()).sort((a, b) => b.width * b.height - a.width * a.height);
    return all[0] == null ? null : { left: all[0].left, top: all[0].top };
  });
  const box = await page.locator('iframe').boundingBox();
  if (canvas == null || box == null) throw new Error('no canvas');
  return {
    x: box.x + canvas.left + v.w / 2 + (mm.x * IU_PER_MM - v.cx) * v.scale,
    y: box.y + canvas.top + v.h / 2 + (mm.y * IU_PER_MM - v.cy) * v.scale,
  };
}

/** Clears the editor's selection and waits for ev.selected to say so. */
async function clear(page: Page): Promise<void> {
  expect(await request(page, 'key.press', { key: 'Escape', code: 'Escape' })).toEqual({});
  await expect.poll(async () => (await of(page, 'ev.selected')).at(-1)?.uuids ?? [], { timeout: 5_000 }).toEqual([]);
}

test('a symbol double-clicked or E over it goes to the host as ev.properties, selected and with no KiCad dialog; a label keeps its dialog', async ({ page }) => {
  const frame = await bootWithLabel(page);
  expect((await of(page, 'ev.ready'))[0]?.caps).toEqual(expect.arrayContaining(['properties', 'kicadHostProperties']));
  // Zoomed onto the left resistor, so the body is many pixels across.
  expect(await request(page, 'select', { uuids: [LEFT], zoom: true })).toEqual({});
  await page.waitForTimeout(800);
  await clear(page);
  const body = await pageAt(page, frame, BODY);
  // The mapping is right: a click there selects the resistor.
  await page.mouse.click(body.x, body.y);
  await expect.poll(async () => (await of(page, 'ev.selected')).at(-1)?.uuids, { timeout: 5_000 }).toEqual([LEFT]);
  await clear(page);

  // The dblclick's own time in the frame, on the same clock as the harness's event times.
  await frame.evaluate(() => {
    const w = window as unknown as { __dbl: number[] };
    w.__dbl = [];
    window.addEventListener('dblclick', (e) => w.__dbl.push(performance.timeOrigin + e.timeStamp), true);
  });
  const origin = await page.evaluate(() => performance.timeOrigin);
  const times: number[] = [];
  for (let i = 0; i < 5; i++) {
    const n = (await of(page, 'ev.properties')).length;
    await page.mouse.dblclick(body.x, body.y);
    await expect.poll(async () => (await of(page, 'ev.properties')).length, { timeout: 5_000 }).toBe(n + 1);
    const ev = (await of(page, 'ev.properties')).at(-1);
    expect(ev).toEqual({ type: 'ev.properties', uuids: [LEFT], sheetPath: '/', at: expect.any(Number) });
    const dbl = await frame.evaluate(() => (window as unknown as { __dbl: number[] }).__dbl.at(-1) ?? NaN);
    times.push(Math.round((origin + (ev?.at ?? NaN) - dbl) * 10) / 10);
    await expect.poll(async () => (await of(page, 'ev.selected')).at(-1)?.uuids, { timeout: 5_000 }).toEqual([LEFT]);
    if (i < 4) await clear(page);
  }
  measure('double-click to ev.properties', `median ${median(times)} ms of ${times.join(', ')} ms from the frame's dblclick to the harness's ev.properties`);
  // No dialog: no ev.menu open within 1.5 s, and the symbol is still the one selected.
  await page.waitForTimeout(1_500);
  expect(await of(page, 'ev.menu')).toEqual([]);
  expect((await of(page, 'ev.selected')).at(-1)?.uuids).toEqual([LEFT]);

  // E over the symbol with nothing selected: the same request, the symbol left selected.
  await clear(page);
  const n = (await of(page, 'ev.properties')).length;
  await page.mouse.move(body.x, body.y);
  await page.mouse.move(body.x + 1, body.y);
  await page.keyboard.press('e');
  await expect.poll(async () => (await of(page, 'ev.properties')).length, { timeout: 5_000 }).toBe(n + 1);
  expect((await of(page, 'ev.properties')).at(-1)).toMatchObject({ uuids: [LEFT], sheetPath: '/' });
  await expect.poll(async () => (await of(page, 'ev.selected')).at(-1)?.uuids, { timeout: 5_000 }).toEqual([LEFT]);
  await page.waitForTimeout(1_500);
  expect((await of(page, 'ev.selected')).at(-1)?.uuids).toEqual([LEFT]);
  expect(await of(page, 'ev.menu')).toEqual([]);

  // A label: KiCad's own label dialog, as before, and no ev.properties.
  await clear(page);
  expect(await request(page, 'select', { uuids: [LABEL], zoom: true })).toEqual({});
  await page.waitForTimeout(800);
  const label = await pageAt(page, frame, { x: LABEL_AT.x + 1.2, y: LABEL_AT.y - 0.6 });
  const before = (await of(page, 'ev.properties')).length;
  await page.mouse.dblclick(label.x, label.y);
  await expect.poll(async () => (await of(page, 'ev.menu')).map((e) => e.open), { timeout: 10_000 }).toEqual([true]);
  expect((await of(page, 'ev.properties')).length).toBe(before);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await of(page, 'ev.menu')).map((e) => e.open), { timeout: 10_000 }).toEqual([true, false]);
});
