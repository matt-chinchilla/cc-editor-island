// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-ap-i over the local pair (PROTOCOL.md ev.autoplace, cap autoplace): the
// auto-placer's working state around a key.press of the seeded chords. On
// engine run 14 the cap is absent (KiCad's progress window would show, so the
// chord is not pressed here). On engine run 15 (cc25, marker
// kicadAutoplaceQuiet): first-board's empty outlined board with two parts
// written beside the outline, Ctrl+Alt+L (Place Off-Board Footprints) sends
// ev.autoplace { working: true } then { working: false }, both parts land
// inside the outline, the undo depth moves by one and one undo takes both back,
// and no window of KiCad's opens (no ev.menu).
import { expect, test, type Page } from '@playwright/test';

interface Ev { type: string; phase?: string; caps?: string[]; working?: boolean; depth?: number; open?: boolean; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Item { uuid: string; ref?: string; x: number; y: number }

const RUN15 = 'waits for engine run 15 (pcbjam cc_e2_pcb.inc, unit st-ap-e: kicadAutoplaceQuiet)';
const FIRST = ['first-board.kicad_pro', 'first-board.kicad_sch', 'first-board.kicad_pcb'];
/** first-board's Edge.Cuts rectangle, mm (tests/fixtures/first-board/SOURCE). */
const OUTLINE = { x0: 100, y0: 100, x1: 130, y1: 120 };
const OFFBOARD = { key: 'l', code: 'KeyL', ctrl: true, alt: true };
const PARTS = [
  { ref: 'R1', uuid: '5a7e0001-0000-4000-8000-000000000001', x: 150, y: 105 },
  { ref: 'R2', uuid: '5a7e0001-0000-4000-8000-000000000002', x: 160, y: 115 },
];

/** A two pad 0603 sized part written inline (no footprint of the mirror needed), its courtyard 3 by 1.6 mm. */
function part(p: { ref: string; uuid: string; x: number; y: number }, n: number): string {
  const id = (k: number) => `5a7e00${String(n).padStart(2, '0')}-0000-4000-8000-0000000001${String(k).padStart(2, '0')}`;
  const font = '(effects (font (size 1 1) (thickness 0.15)))';
  return `\t(footprint "Fixture:R_0603" (layer "F.Cu") (uuid "${p.uuid}") (at ${p.x} ${p.y})
\t\t(property "Reference" "${p.ref}" (at 0 -1.6 0) (layer "F.SilkS") (uuid "${id(1)}") ${font})
\t\t(property "Value" "1k" (at 0 1.6 0) (layer "F.Fab") (uuid "${id(2)}") ${font})
\t\t(fp_rect (start -1.5 -0.8) (end 1.5 0.8) (stroke (width 0.05) (type default)) (fill none) (layer "F.CrtYd") (uuid "${id(3)}"))
\t\t(pad "1" smd rect (at -0.8 0) (size 0.8 0.9) (layers "F.Cu" "F.Paste" "F.Mask") (uuid "${id(4)}"))
\t\t(pad "2" smd rect (at 0.8 0) (size 0.8 0.9) (layers "F.Cu" "F.Paste" "F.Mask") (uuid "${id(5)}"))
\t)
`;
}

function measure(type: string, description: string): void {
  test.info().annotations.push({ type, description });
  console.log(`[measure] ${type}: ${description}`);
}
const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const of = async (page: Page, type: string): Promise<Ev[]> => (await events(page)).filter((e) => e.type === type);
const request = (page: Page, op: string, args?: unknown): Promise<Record<string, unknown>> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const);
const lastDepth = async (page: Page): Promise<number | undefined> => (await of(page, 'ev.edited')).at(-1)?.depth;

/** Boots a pcb frame and opens first-board, its board passed through `edit`; answers ev.ready's caps. */
async function open(page: Page, edit: (board: string) => string = (b) => b): Promise<string[]> {
  await page.goto('/parent.html?frame=pcb');
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  const caps = (await of(page, 'ev.ready'))[0]?.caps ?? [];
  const texts: Record<string, string> = {};
  for (const name of FIRST) texts[name] = await page.evaluate(async (n) => (await fetch(`/fixtures/first-board/${n}`)).text(), name);
  texts['first-board.kicad_pcb'] = edit(texts['first-board.kicad_pcb']);
  const answer = await page.evaluate(async (ts) => {
    const enc = new TextEncoder();
    const files = Object.entries(ts).map(([path, text]) => ({ path, bytes: enc.encode(text) }));
    return (window as unknown as Harness).__bridge.request('project.open', { name: 'first-board', files });
  }, texts);
  expect(answer).toMatchObject({ opened: expect.stringMatching(/\.kicad_pcb$/) });
  await page.waitForTimeout(1_500);   // the open's baseline read
  return caps;
}

test('run 14 or 15: autoplace follows kicadAutoplaceQuiet in a pcb frame, and a sch frame never lists it', async ({ page }) => {
  const caps = await open(page);
  expect(caps.includes('autoplace')).toBe(caps.includes('kicadAutoplaceQuiet') && caps.includes('kicadCollabBusy'));
  expect(await of(page, 'ev.autoplace')).toEqual([]);
  await page.goto('/parent.html?fixture=glasgow&frame=sch');
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  expect((await of(page, 'ev.ready'))[0]?.caps ?? []).not.toContain('autoplace');
});

test('run 15: the off board chord places both parts inside the outline, working true then false, one undo step, no window', async ({ page }) => {
  const caps = await open(page, (b) => b.replace(/\)\s*$/, `${PARTS.map(part).join('')})\n`));
  test.skip(!caps.includes('autoplace'), RUN15);
  expect(caps).toContain('boardItem');

  const uuids = PARTS.map((p) => p.uuid);
  const before = ((await request(page, 'board.item.get', { uuids })) as { items: Item[] }).items;
  expect(before).toHaveLength(2);
  for (const it of before) expect(it.x).toBeGreaterThan(OUTLINE.x1);
  const depth0 = (await lastDepth(page)) ?? 0;

  const t0 = Date.now();
  expect(await request(page, 'key.press', OFFBOARD)).toEqual({});
  await expect.poll(async () => (await of(page, 'ev.autoplace')).length, { timeout: 60_000 }).toBe(2);
  measure('Place Off-Board Footprints, two parts on first-board', `${Date.now() - t0} ms from the press to working false`);
  expect((await of(page, 'ev.autoplace')).map((e) => e.working)).toEqual([true, false]);

  await expect.poll(() => lastDepth(page), { timeout: 5_000 }).toBe(depth0 + 1);
  const after = ((await request(page, 'board.item.get', { uuids })) as { items: Item[] }).items;
  expect(after).toHaveLength(2);
  for (const it of after) {
    expect(it.x, it.uuid).toBeGreaterThan(OUTLINE.x0);
    expect(it.x, it.uuid).toBeLessThan(OUTLINE.x1);
    expect(it.y, it.uuid).toBeGreaterThan(OUTLINE.y0);
    expect(it.y, it.uuid).toBeLessThan(OUTLINE.y1);
  }
  // No progress window, no dialog of any kind.
  expect(await of(page, 'ev.menu')).toEqual([]);

  // One undo step takes both back.
  expect(await request(page, 'key.press', { key: 'z', code: 'KeyZ', ctrl: true })).toEqual({});
  await expect.poll(() => lastDepth(page), { timeout: 5_000 }).toBe(depth0);
  const undone = ((await request(page, 'board.item.get', { uuids })) as { items: Item[] }).items;
  for (const it of undone) expect(it.x).toBeGreaterThan(OUTLINE.x1);
  // Another key sends no ev.autoplace.
  expect(await request(page, 'key.press', { key: 'y', code: 'KeyY', ctrl: true })).toEqual({});
  await page.waitForTimeout(1_500);
  expect(await of(page, 'ev.autoplace')).toHaveLength(2);
});
