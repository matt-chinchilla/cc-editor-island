// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-mw-i over the local pair (PROTOCOL.md microwave.arm): the values of
// KiCad's microwave tools given before the press, on Glasgow. On engine run 14
// the cap microwave is absent and microwave.arm answers unsupported naming
// kicadMicrowaveArm. On engine run 15 (cc25): { shape: 'stub', value: 5 }
// answers {}, then key.press of the Stub row's seeded chord hangs a stub on
// the pointer at the first click, the second click places it as ONE undo step
// that one Ctrl+Z takes back, a third click places nothing (the tool ended),
// and no KiCad window or ask comes; Shape, armed with five points, places the
// same way. In a sch frame the op is unsupported.
import { expect, test, type Page } from '@playwright/test';
import tableJson from '../../../theme/pencil-tools.json' with { type: 'json' };

interface Ev { type: string; phase?: string; caps?: string[]; open?: boolean; depth?: number; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Key { key: string; code: string; ctrl?: boolean; shift?: boolean; alt?: boolean }
interface Row { editor: string; action: string; seededKey: string | null }

const RUN15 = 'waits for engine run 15 (pcbjam cc_e2_pcb.inc, unit st-mw-e: kicadMicrowaveArm)';
const UNDO: Key = { key: 'z', code: 'KeyZ', ctrl: true };
const SHAPE = { points: [[0, 0], [0.25, 0.5], [0.5, 0.7], [0.75, 0.5], [1, 0]], kind: 'symmetrical', size: [4, 2] };

function measure(type: string, description: string): void {
  test.info().annotations.push({ type, description });
  console.log(`[measure] ${type}: ${description}`);
}
const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const of = async (page: Page, type: string): Promise<Ev[]> => (await events(page)).filter((e) => e.type === type);
const request = (page: Page, op: string, args?: unknown): Promise<Record<string, unknown>> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const);
const refusal = (page: Page, op: string, args?: unknown): Promise<string> =>
  request(page, op, args).then(() => 'ok', (err: Error) => err.message.split('\n')[0].replace(/^.*?page\.evaluate:\s*/, '').replace(/^Error:\s*/, ''));
/** microwave.arm, timed. */
const arm = (page: Page, args: unknown): Promise<{ ms: number; got: Record<string, unknown> }> =>
  page.evaluate(async (a) => {
    const t0 = performance.now();
    const got = await (window as unknown as Harness).__bridge.request('microwave.arm', a);
    return { ms: Math.round((performance.now() - t0) * 100) / 100, got };
  }, args);

/** A chord as key.press sends it: KiCad's name ("Ctrl+Alt+A") to its key, code and modifiers. */
function keyArgs(chord: string): Key {
  const parts = chord.split('+');
  const last = parts.pop()!;
  const code = /^[0-9]$/.test(last) ? `Digit${last}` : /^[A-Z]$/.test(last) ? `Key${last}` : last;
  const shift = parts.includes('Shift');
  const key = /^[A-Z]$/.test(last) && !shift ? last.toLowerCase() : last;
  return { key, code, ctrl: parts.includes('Ctrl'), shift, alt: parts.includes('Alt') };
}
/** The board row's seeded chord, from the island's own pencil table. */
function chordOf(action: string): Key {
  const row = (tableJson as Row[]).find((r) => r.editor === 'pcb' && r.action === action);
  if (row?.seededKey == null || row.seededKey === '') throw new Error(`no chord for ${action}`);
  return keyArgs(row.seededKey);
}

/** Boots Glasgow in `frame` and answers ev.ready's caps once the document is open. */
async function boot(page: Page, frame: 'pcb' | 'sch'): Promise<string[]> {
  await page.goto(`/parent.html?fixture=glasgow&frame=${frame}`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  expect((await of(page, 'ev.state')).filter((e) => e.phase === 'fatal' || e.phase === 'blocked')).toEqual([]);
  const caps = (await of(page, 'ev.ready'))[0]?.caps ?? [];
  await expect(page.locator('#state')).toContainText(`opened glasgow.kicad_${frame}`, { timeout: 120_000 });
  await page.waitForTimeout(1_500);   // ev.edited's baseline
  return caps;
}
/** The last ev.edited's depth once at least `count` of them came. */
async function depthAfter(page: Page, count: number): Promise<number> {
  await expect.poll(async () => (await of(page, 'ev.edited')).length, { timeout: 5_000 }).toBeGreaterThanOrEqual(count);
  return (await of(page, 'ev.edited')).at(-1)?.depth ?? -1;
}
/** A click on the drawing at an offset from its middle, the pointer moved there first so a hanging item follows it. */
async function clickDrawing(page: Page, dx: number, dy: number): Promise<void> {
  const box = await page.locator('iframe').boundingBox();
  expect(box).not.toBeNull();
  if (box == null) return;
  const x = box.x + box.width / 2 + dx;
  const y = box.y + box.height / 2 + dy;
  await page.mouse.move(x - 10, y - 10);
  await page.mouse.move(x, y);
  await page.mouse.click(x, y);
  await page.waitForTimeout(400);
}
/** KiCad windows and asks seen so far: ev.menu opens and ev.prompt. */
const windowsSeen = async (page: Page): Promise<number> =>
  (await of(page, 'ev.menu')).filter((e) => e.open === true).length + (await of(page, 'ev.prompt')).length;

test('run 14 or 15: microwave follows kicadMicrowaveArm; without it microwave.arm answers unsupported naming the export; bad args first', async ({ page }) => {
  const caps = await boot(page, 'pcb');
  expect(caps.includes('microwave')).toBe(caps.includes('kicadMicrowaveArm'));
  if (!caps.includes('microwave')) {
    expect(await refusal(page, 'microwave.arm', { shape: 'stub', value: 5 })).toBe('unsupported: kicadMicrowaveArm');
    expect(await refusal(page, 'microwave.arm', { shape: 'polygon', polygon: SHAPE })).toBe('unsupported: kicadMicrowaveArm');
  }
  expect(await refusal(page, 'microwave.arm', { shape: 'stub', value: 0 })).toBe('bad_args: microwave.arm');
  expect(await refusal(page, 'microwave.arm', { shape: 'arcStub', value: 3, angle: 190 })).toBe('bad_args: microwave.arm');
  expect(await refusal(page, 'microwave.arm', { shape: 'polygon', polygon: { ...SHAPE, kind: 'normal' } })).toBe('bad_args: microwave.arm');
  expect(await refusal(page, 'microwave.arm')).toBe('bad_args: microwave.arm');
});

test('a sch frame: no microwave cap and microwave.arm is unsupported', async ({ page }) => {
  const caps = await boot(page, 'sch');
  expect(caps).not.toContain('microwave');
  expect(await refusal(page, 'microwave.arm', { shape: 'stub', value: 5 })).toBe('unsupported: a board op runs in a pcb frame');
});

for (const road of [
  { name: 'Stub, 5 mm', action: 'pcbnew.MicrowaveTool.createStub', arm: { shape: 'stub', value: 5 } },
  { name: 'Shape, five points, symmetrical, 4 by 2 mm', action: 'pcbnew.MicrowaveTool.createFunctionShape', arm: { shape: 'polygon', polygon: SHAPE } },
]) {
  test(`run 15, ${road.name}: armed, the chord hangs it on the pointer with no window, a click places it as one undo step, the tool ends`, async ({ page }) => {
    const caps = await boot(page, 'pcb');
    test.skip(!caps.includes('microwave'), RUN15);
    const seen = await windowsSeen(page);
    const edits = (await of(page, 'ev.edited')).length;

    const armed = await arm(page, road.arm);
    expect(armed.got).toEqual({});
    measure(`microwave.arm ${road.name}`, `${armed.ms} ms`);
    expect(await request(page, 'key.press', chordOf(road.action))).toEqual({});
    await clickDrawing(page, 0, 0);       // the item is made and hangs on the pointer
    await clickDrawing(page, 30, 20);     // placed
    const d1 = await depthAfter(page, edits + 1);
    expect((await of(page, 'ev.edited')).length, 'one placement, one undo step').toBe(edits + 1);
    await clickDrawing(page, -30, 20);    // the tool ended after one placement: nothing more
    expect((await of(page, 'ev.edited')).length, 'a third click places nothing').toBe(edits + 1);
    expect(await windowsSeen(page), 'no KiCad window and no ask').toBe(seen);

    expect(await request(page, 'key.press', UNDO)).toEqual({});
    expect(await depthAfter(page, edits + 2), 'one Ctrl+Z takes the placement back').toBe(d1 - 1);
  });
}
