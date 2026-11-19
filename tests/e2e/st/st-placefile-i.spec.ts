// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-placefile-i over the local pair (PROTOCOL.md place.file): a file the
// design holds put on the pointer by KiCad's own Import Sheet or Append Board,
// with no file chooser. The host writes the file under imports/ through
// project.write first, then names it. On engine run 14 the cap placeFile is
// absent, place.file answers unsupported naming kicadPlaceFromFile, and KiCad's
// Import Sheet and Append Board are left to KiCad. On engine run 15 (cc25):
// Glasgow's schematic takes first-board's sheet and first-board's board takes
// the business card's board, each answered {} once on the pointer, landed by
// one click as ONE undo step that one Ctrl+Z takes back, Esc leaving nothing;
// /tmp/cc-stage holds no folder after any answer; both held actions send
// ev.held.
import { expect, test, type Frame, type Page } from '@playwright/test';
import { ISLAND } from '../ports';

interface Ev { type: string; phase?: string; caps?: string[]; action?: string; depth?: number; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Engine {
  FS: { readdir(p: string): string[]; analyzePath(p: string): { exists: boolean } };
  kicadHostAction?: { onRequest?: (json: unknown) => boolean };
}
interface Key { key: string; code: string; ctrl?: boolean; shift?: boolean; alt?: boolean }

const RUN15 = 'waits for engine run 15 (pcbjam cc_e5_dispatch, unit st-placefile-e: kicadPlaceFromFile)';
const UNDO: Key = { key: 'z', code: 'KeyZ', ctrl: true };
const ESC: Key = { key: 'Escape', code: 'Escape' };
/** The two roads: the frame, the fixture it opens, the file written under imports/ (from another fixture) and KiCad's action held. */
const ROADS = [
  { frame: 'sch', fixture: 'glasgow', doc: 'glasgow.kicad_sch', kind: 'sheet', name: 'imports/sub.kicad_sch', from: '/fixtures/first-board/first-board.kicad_sch', held: 'eeschema.InteractiveDrawing.importSheet' },
  { frame: 'pcb', fixture: 'first-board', doc: 'first-board.kicad_pcb', kind: 'board', name: 'imports/business-card.kicad_pcb', from: '/fixtures/st-session-card/business-card.kicad_pcb', held: 'pcbnew.EditorControl.appendBoard' },
] as const;
type Road = typeof ROADS[number];

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

/** The road's file written into the project folder under imports/, as the page does. */
const writeImport = (page: Page, road: Road): Promise<Record<string, unknown>> =>
  page.evaluate(async ([from, name]) => {
    const text = await (await fetch(from)).text();
    return (window as unknown as Harness).__bridge.request('project.write', { files: [{ path: name, text }] });
  }, [road.from, road.name] as const);

/** place.file for the road, timed; a refusal reads as "code: message". */
const placeFile = (page: Page, road: Road): Promise<{ ms: number; got: Record<string, unknown> | string }> =>
  page.evaluate(async ([kind, name]) => {
    const t0 = performance.now();
    const got = await (window as unknown as Harness).__bridge.request('place.file', { kind, name })
      .then((r) => r, (e: Error) => e.message.replace(/^Error:\s*/, ''));
    return { ms: Math.round((performance.now() - t0) * 100) / 100, got };
  }, [road.kind, road.name] as const);

/** Boots the road's frame on its fixture and answers ev.ready's caps and the island frame (null where Playwright cannot reach it). */
async function boot(page: Page, road: Road): Promise<{ caps: string[]; frame: Frame | null }> {
  await page.goto(`/parent.html?fixture=${road.fixture}&frame=${road.frame}`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  expect((await of(page, 'ev.state')).filter((e) => e.phase === 'fatal' || e.phase === 'blocked')).toEqual([]);
  const caps = (await of(page, 'ev.ready'))[0]?.caps ?? [];
  await expect(page.locator('#state')).toContainText(`opened ${road.doc}`, { timeout: 120_000 });
  await page.waitForTimeout(1_500);   // ev.edited's baseline
  return { caps, frame: page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null };
}
/** What the stage root holds: folder names left under /tmp/cc-stage. */
const leftOver = (frame: Frame): Promise<string[]> => frame.evaluate(() => {
  const { FS } = window as unknown as Engine;
  return FS.analyzePath('/tmp/cc-stage').exists ? FS.readdir('/tmp/cc-stage').filter((n) => n !== '.' && n !== '..') : [];
});
/** Asks the frame's held slot as the engine does: taken, and the ev.held sent for it. */
async function askHeld(page: Page, frame: Frame, action: string): Promise<{ taken: boolean; sent: string | null }> {
  const n = (await of(page, 'ev.held')).length;
  const taken = await frame.evaluate((a) => (window as unknown as Engine).kicadHostAction?.onRequest?.(JSON.stringify({ action: a })) === true, action);
  await page.waitForTimeout(300);
  const after = await of(page, 'ev.held');
  return { taken, sent: after.length > n ? after.at(-1)?.action ?? null : null };
}
/** The last ev.edited's depth once at least `count` of them came. */
async function depthAfter(page: Page, count: number): Promise<number> {
  await expect.poll(async () => (await of(page, 'ev.edited')).length, { timeout: 5_000 }).toBeGreaterThanOrEqual(count);
  return (await of(page, 'ev.edited')).at(-1)?.depth ?? -1;
}
/** A click on the drawing, the pointer moved there first so the hanging items follow it. */
async function clickDrawing(page: Page): Promise<void> {
  const box = await page.locator('iframe').boundingBox();
  expect(box).not.toBeNull();
  if (box == null) return;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2 + 20);
  await page.mouse.click(box.x + box.width / 2 + 20, box.y + box.height / 2 + 20);
}

for (const road of ROADS) {
  test(`run 14 or 15, ${road.frame}: placeFile follows kicadPlaceFromFile; without it place.file answers unsupported naming the export and KiCad's action is KiCad's`, async ({ page, browserName }) => {
    const { caps, frame } = await boot(page, road);
    expect(caps.includes('placeFile')).toBe(caps.includes('kicadPlaceFromFile') && caps.includes('kicadCollabGetSelection'));
    expect(await refusal(page, 'place.file', { kind: road.kind, name: `../${road.name}` })).toBe('bad_args: place.file');
    expect(await refusal(page, 'place.file', { kind: road.kind, name: road.name, bytes: new Uint8Array([40]) })).toBe('bad_args: place.file');
    if (!caps.includes('placeFile')) {
      expect(await refusal(page, 'place.file', { kind: road.kind, name: road.name })).toBe('unsupported: kicadPlaceFromFile');
    }
    test.skip(frame == null, `${browserName}: the island frame is out of Playwright's reach, so its held slot cannot be asked`);
    const held = caps.includes('placeFile');
    expect(await askHeld(page, frame!, road.held)).toEqual({ taken: held, sent: held ? road.held : null });
  });

  test(`run 15, ${road.frame}: the written ${road.kind} hangs on the pointer, Esc leaves nothing, a click lands it as one undo step, no stage folder is left`, async ({ page, browserName }) => {
    const { caps, frame } = await boot(page, road);
    test.skip(!caps.includes('placeFile'), RUN15);
    expect(await writeImport(page, road)).toEqual({ written: [road.name] });
    expect(await refusal(page, 'place.file', { kind: road.kind, name: 'imports/none.kicad_' + (road.kind === 'sheet' ? 'sch' : 'pcb') })).toBe(`not_found: imports/none.kicad_${road.kind === 'sheet' ? 'sch' : 'pcb'}`);
    const menus = (await of(page, 'ev.menu')).length;
    const edits = (await of(page, 'ev.edited')).length;

    const first = await placeFile(page, road);
    expect(first.got, String(first.got)).toEqual({});
    measure(`place.file ${road.kind}, on the pointer`, `${first.ms} ms`);
    if (frame != null) expect(await leftOver(frame)).toEqual([]);
    // While it hangs every gate answers busy.
    expect((await placeFile(page, road)).got).toBe('busy: place.file');
    expect(await request(page, 'key.press', ESC)).toEqual({});
    await page.waitForTimeout(1_500);
    expect((await of(page, 'ev.edited')).length, 'Esc leaves no undo step').toBe(edits);

    const second = await placeFile(page, road);
    expect(second.got, String(second.got)).toEqual({});
    await clickDrawing(page);
    const d1 = await depthAfter(page, edits + 1);
    expect(await request(page, 'key.press', UNDO)).toEqual({});
    expect(await depthAfter(page, edits + 2), 'one Ctrl+Z takes the whole placement back').toBe(d1 - 1);
    expect((await of(page, 'ev.menu')).length, 'no KiCad window').toBe(menus);
    test.skip(frame == null, `${browserName}: the island frame is out of Playwright's reach, so the stage root and the held slot cannot be read`);
    expect(await leftOver(frame!)).toEqual([]);
    expect(await askHeld(page, frame!, road.held)).toEqual({ taken: true, sent: road.held });
  });
}
