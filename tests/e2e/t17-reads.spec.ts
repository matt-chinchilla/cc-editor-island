// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// t17-i over the local pair (PROTOCOL.md, Engine build T17's reads) on the
// canvas-kinds fixture: libs.problems, actions.state, ev.tool, the cap
// menuClarify, and keys.claim's observe (ev.key observed). On an engine
// before build T17 the caps are absent, both ops answer unsupported naming the
// export and no ev.tool is sent; the T17 steps are skipped there.
import { expect, test, type Frame, type Page } from '@playwright/test';

import { ISLAND } from './ports';

interface Ev { type: string; caps?: string[]; name?: string; code?: string; shift?: boolean; observed?: boolean; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
type Answer = { error?: { code: string; message: string } } & Record<string, unknown>;

const FIXTURE = 'canvas-kinds';
const T17 = 'waits for engine build T17 (kicadActionStates, kicadLibraryTableProblems, kicadHostToolChanges)';
const GRID = 'common.Control.toggleGrid';
const ROUTE = 'pcbnew.InteractiveRouter.SingleTrack';
const SELECTION_TOOL = 'common.InteractiveSelection.selectionTool';

const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const of = async (page: Page, type: string): Promise<Ev[]> => (await events(page)).filter((e) => e.type === type);
/** The bridge's answer, or its refusal as { error }. */
const request = (page: Page, op: string, args?: unknown): Promise<Answer> =>
  page.evaluate(async ([o, a]) => {
    try { return await (window as unknown as Harness).__bridge.request(o as string, a); } catch (e) {
      const m = /^([a-z_]+): ([\s\S]*)$/.exec(String((e as { message?: string }).message ?? e));
      return { error: { code: m?.[1] ?? 'thrown', message: m?.[2] ?? String(e) } };
    }
  }, [op, args] as const);
const islandFrame = (page: Page): Frame | null => page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null;

async function open(page: Page, frame: 'sch' | 'pcb'): Promise<string[]> {
  await page.goto(`/parent.html?frame=${frame}&fixture=${FIXTURE}`);
  await page.waitForFunction(() => /opened |open failed|state (blocked|fatal)/.test(document.getElementById('state')?.textContent ?? ''), null, { timeout: 170_000 });
  expect(await page.textContent('#state')).toContain(`opened ${FIXTURE}.kicad_${frame}`);
  await page.waitForTimeout(1_500);
  return (await of(page, 'ev.ready'))[0]?.caps ?? [];
}

/** The drawing's center, in the page's coordinates. */
async function canvasCenter(page: Page): Promise<{ x: number; y: number }> {
  const frame = islandFrame(page);
  const box = await page.locator('iframe').boundingBox();
  if (frame == null || box == null) throw new Error('no island frame');
  const c = await frame.evaluate(() => {
    const all = [...document.querySelectorAll('canvas')].filter((e) => e.getBoundingClientRect().width > 0);
    all.sort((a, b) => b.width * b.height - a.width * a.height);
    const r = all[0]?.getBoundingClientRect();
    return r == null ? null : { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (c == null) throw new Error('no drawing canvas');
  return { x: box.x + c.x, y: box.y + c.y };
}

/**
 * Escape as a reader presses it, the pointer on the drawing and wx's focus there:
 * up to three presses (KiCad's router takes one to end a route in progress and one
 * to leave the tool), until ev.tool names the selection tool.
 */
async function escapeToSelection(page: Page, press: () => Promise<unknown>): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await press();
    try {
      await expect.poll(async () => (await of(page, 'ev.tool')).at(-1)?.name, { timeout: 3_000 }).toBe(SELECTION_TOOL);
      return;
    } catch { /* the next press */ }
  }
  expect((await of(page, 'ev.tool')).at(-1)?.name, 'Esc leaves the tool').toBe(SELECTION_TOOL);
}

const isT17 = (caps: readonly string[]): boolean => ['libTableProblems', 'actionStates', 'menuClarify', 'activeTool'].every((c) => caps.includes(c));

test('island.json lists libs.problems and actions.state', async ({ page }) => {
  const res = await page.goto(`${ISLAND}/island.json`);
  const island = (await res!.json()) as { ops?: string[] };
  for (const op of ['libs.problems', 'actions.state']) expect(island.ops ?? []).toContain(op);
});

test('before build T17: no caps, both ops unsupported naming the export, no ev.tool; observeKeys listed all the same', async ({ page }) => {
  const caps = await open(page, 'pcb');
  test.skip(caps.includes('actionStates'), 'this engine is build T17: the tests below cover it');
  for (const c of ['libTableProblems', 'actionStates', 'menuClarify', 'activeTool']) expect(caps).not.toContain(c);
  expect(caps).toContain('observeKeys');
  expect(await request(page, 'libs.problems')).toEqual({ error: { code: 'unsupported', message: 'kicadLibraryTableProblems' } });
  expect(await request(page, 'actions.state', { actions: [GRID] })).toEqual({ error: { code: 'unsupported', message: 'kicadActionStates' } });
  expect(await of(page, 'ev.tool')).toEqual([]);
});

for (const kind of ['sch', 'pcb'] as const) {
  test(`build T17, ${kind}: the four caps, libs.problems answers a list, the grid's state follows a press`, async ({ page }) => {
    const caps = await open(page, kind);
    test.skip(!isT17(caps), T17);
    const libs = await request(page, 'libs.problems');
    expect(libs.error).toBeUndefined();
    expect(Array.isArray(libs.tables)).toBe(true);
    const first = await request(page, 'actions.state', { actions: [GRID, 'no.such.action'] });
    const states = first.states as Record<string, boolean | null>;
    expect(typeof states[GRID]).toBe('boolean');
    expect(states['no.such.action']).toBeNull();
    expect(await request(page, 'action.run', { name: GRID })).toEqual({});
    // actions.state waits for the apply queue: the press has run.
    const after = await request(page, 'actions.state', { actions: [GRID] });
    expect((after.states as Record<string, boolean | null>)[GRID]).toBe(!states[GRID]);
    expect(await request(page, 'action.run', { name: GRID })).toEqual({});
  });
}

test('build T17, pcb: ev.tool right after ev.ready, then the router, then the selection tool on Esc', async ({ page }) => {
  const caps = await open(page, 'pcb');
  test.skip(!isT17(caps), T17);
  const all = await events(page);
  const ready = all.findIndex((e) => e.type === 'ev.ready');
  const firstTool = all.findIndex((e) => e.type === 'ev.tool');
  expect(firstTool).toBeGreaterThan(ready);
  expect(all[firstTool].name).toBe(SELECTION_TOOL);
  const n = (await of(page, 'ev.tool')).length;
  // A press on the drawing first, as a reader's: wx's keyboard focus on the canvas.
  const c = await canvasCenter(page);
  await page.mouse.click(c.x, c.y);
  expect(await request(page, 'action.run', { name: ROUTE })).toEqual({});
  await expect.poll(async () => (await of(page, 'ev.tool')).slice(n).map((e) => e.name), { timeout: 10_000 }).toContain(ROUTE);
  await page.mouse.move(c.x + 10, c.y + 10, { steps: 3 });
  await escapeToSelection(page, () => request(page, 'key.press', { key: 'Escape', code: 'Escape' }));
  // Never twice in a row with the same name.
  const names = (await of(page, 'ev.tool')).map((e) => e.name);
  names.forEach((name, i) => { if (i > 0) expect(name).not.toBe(names[i - 1]); });
});

test('keys.claim observe: a real Escape in the frame is one ev.key observed and still cancels KiCad\'s tool', async ({ page }) => {
  const caps = await open(page, 'pcb');
  test.skip(!caps.includes('observeKeys'), 'this island takes no observe');
  expect(await request(page, 'keys.claim', { chords: [], observe: ['Escape'] })).toEqual({ claimed: 0, refused: [] });
  const frame = islandFrame(page);
  test.skip(frame == null, 'the island frame is out of Playwright\'s reach in this browser');
  const c = await canvasCenter(page);
  await page.mouse.click(c.x, c.y);
  if (isT17(caps)) {
    expect(await request(page, 'action.run', { name: ROUTE })).toEqual({});
    await expect.poll(async () => (await of(page, 'ev.tool')).at(-1)?.name, { timeout: 10_000 }).toBe(ROUTE);
    await page.mouse.move(c.x + 10, c.y + 10, { steps: 3 });
  }
  const keys = (await of(page, 'ev.key')).length;
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await of(page, 'ev.key')).slice(keys).map((e) => ({ code: e.code, shift: e.shift, observed: e.observed })), { timeout: 5_000 })
    .toEqual([{ code: 'Escape', shift: false, observed: true }]);
  // KiCad got the key too: the router is dropped (build T17 says so with ev.tool); each further press is observed as well.
  if (isT17(caps)) await escapeToSelection(page, () => page.keyboard.press('Escape'));
});
