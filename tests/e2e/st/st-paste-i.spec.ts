// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-paste-i over the local pair (PROTOCOL.md paste.special): KiCad's own
// Paste Special with the host's choice and no KiCad window. On engine run 14
// the cap pasteSpecial is absent, paste.special answers unsupported naming
// kicadPasteSpecial, and KiCad's Paste Special is left to KiCad. On engine run
// 15 (cc25), on Glasgow: R4 copied by Ctrl+C, paste.special { mode: "unique" }
// answers {} once the copy hangs off the pointer, every gate answers busy
// while it hangs, Esc leaves nothing, a click lands it as R<next> in ONE undo
// step that one Ctrl+Z takes back; "keep" lands R4 again and "remove" R?; the
// board takes R4's footprint with clearNets; the held action sends ev.held.
import { expect, test, type Frame, type Page } from '@playwright/test';
import { ISLAND } from '../ports';

interface Ev { type: string; phase?: string; caps?: string[]; action?: string; depth?: number; uuids?: string[]; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Engine {
  Module: { kicadCollabGetSelection?: () => string };
  kicadHostAction?: { onRequest?: (json: unknown) => boolean };
}
interface Key { key: string; code: string; ctrl?: boolean; shift?: boolean; alt?: boolean }

const RUN15 = 'waits for engine run 15 (pcbjam, unit st-paste-e: kicadPasteSpecial)';
const HELD = 'common.Interactive.pasteSpecial';
const COPY: Key = { key: 'c', code: 'KeyC', ctrl: true };
const UNDO: Key = { key: 'z', code: 'KeyZ', ctrl: true };
const ESC: Key = { key: 'Escape', code: 'Escape' };
/** R4 in Glasgow: the schematic symbol and its footprint on the board. */
const R4_SYMBOL = '00000000-0000-0000-0000-00005f06d941';
const R4_FOOTPRINT = '00000000-0000-0000-0000-00005f03c4a2';
const FRAMES = [
  { frame: 'sch', doc: 'glasgow.kicad_sch', copy: R4_SYMBOL },
  { frame: 'pcb', doc: 'glasgow.kicad_pcb', copy: R4_FOOTPRINT },
] as const;

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

/** paste.special timed; a refusal reads as "code: message". */
const paste = (page: Page, args: unknown): Promise<{ ms: number; got: Record<string, unknown> | string }> =>
  page.evaluate(async (a) => {
    const t0 = performance.now();
    const got = await (window as unknown as Harness).__bridge.request('paste.special', a)
      .then((r) => r, (e: Error) => e.message.replace(/^Error:\s*/, ''));
    return { ms: Math.round((performance.now() - t0) * 100) / 100, got };
  }, args);

/** Boots Glasgow in `frame` and answers ev.ready's caps and the island frame (null where Playwright cannot reach it). */
async function boot(page: Page, frame: string, doc: string): Promise<{ caps: string[]; island: Frame | null }> {
  await page.goto(`/parent.html?fixture=glasgow&frame=${frame}`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  expect((await of(page, 'ev.state')).filter((e) => e.phase === 'fatal' || e.phase === 'blocked')).toEqual([]);
  const caps = (await of(page, 'ev.ready'))[0]?.caps ?? [];
  await expect(page.locator('#state')).toContainText(`opened ${doc}`, { timeout: 120_000 });
  await page.waitForTimeout(1_500);   // ev.edited's baseline
  return { caps, island: page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null };
}
/** Asks the frame's held slot as the engine does: taken, and the ev.held sent for it. */
async function askHeld(page: Page, island: Frame, action: string): Promise<{ taken: boolean; sent: string | null }> {
  const n = (await of(page, 'ev.held')).length;
  const taken = await island.evaluate((a) => (window as unknown as Engine).kicadHostAction?.onRequest?.(JSON.stringify({ action: a })) === true, action);
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
async function clickDrawing(page: Page, dx = 20): Promise<void> {
  const box = await page.locator('iframe').boundingBox();
  expect(box).not.toBeNull();
  if (box == null) return;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + 20);
  await page.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2 + 20);
}
/** The engine's selection now, read in the island frame. */
const selectionNow = (island: Frame): Promise<string[]> =>
  island.evaluate(() => JSON.parse((window as unknown as Engine).Module.kicadCollabGetSelection?.() ?? '[]') as string[]);
/** Selects `uuid` and copies it with KiCad's own Ctrl+C. */
async function copy(page: Page, uuid: string): Promise<void> {
  expect(await request(page, 'select', { uuids: [uuid] })).toEqual({});
  await page.waitForTimeout(300);
  expect(await request(page, 'key.press', COPY)).toEqual({});
  await page.waitForTimeout(300);
}
const refOf = async (page: Page, uuid: string): Promise<string> => ((await request(page, 'symbol.get', { uuid })) as { ref: string }).ref;

for (const f of FRAMES) {
  test(`run 14 or 15, ${f.frame}: pasteSpecial follows kicadPasteSpecial; without it paste.special answers unsupported naming the export and KiCad's Paste Special is KiCad's`, async ({ page, browserName }) => {
    const { caps, island } = await boot(page, f.frame, f.doc);
    expect(caps.includes('pasteSpecial')).toBe(caps.includes('kicadPasteSpecial') && caps.includes('kicadCollabGetSelection'));
    expect(await refusal(page, 'paste.special', { mode: 'new' })).toBe('bad_args: paste.special');
    expect(await refusal(page, 'paste.special', { mode: 'unique', clearNets: 1 })).toBe('bad_args: paste.special');
    if (!caps.includes('pasteSpecial')) {
      expect(await refusal(page, 'paste.special', { mode: 'unique' })).toBe('unsupported: kicadPasteSpecial');
    }
    test.skip(island == null, `${browserName}: the island frame is out of Playwright's reach, so its held slot cannot be asked`);
    const held = caps.includes('pasteSpecial');
    expect(await askHeld(page, island!, HELD)).toEqual({ taken: held, sent: held ? HELD : null });
  });
}

test('run 15, sch: R4 copied, Give new designators hangs off the pointer, Esc leaves nothing, a click lands R<next> as one undo step; Keep and Clear land R4 and R?', async ({ page, browserName }) => {
  const { caps, island } = await boot(page, 'sch', 'glasgow.kicad_sch');
  test.skip(!caps.includes('pasteSpecial'), RUN15);
  test.skip(island == null, `${browserName}: the island frame is out of Playwright's reach, so the pasted item's uuid cannot be read`);
  expect(await refusal(page, 'paste.special', { mode: 'unique', clearNets: true })).toBe('bad_args: paste.special: clearNets is a board choice');
  const menus = (await of(page, 'ev.menu')).length;
  await copy(page, R4_SYMBOL);
  const edits = (await of(page, 'ev.edited')).length;

  const first = await paste(page, { mode: 'unique' });
  expect(first.got, String(first.got)).toEqual({});
  measure('paste.special unique, on the pointer', `${first.ms} ms`);
  // While it hangs every gate answers busy.
  expect((await paste(page, { mode: 'unique' })).got).toBe('busy: paste.special');
  expect(await request(page, 'key.press', ESC)).toEqual({});
  await page.waitForTimeout(1_500);
  expect((await of(page, 'ev.edited')).length, 'Esc leaves no undo step').toBe(edits);

  let count = edits;
  const landed: Record<string, string> = {};
  for (const [i, mode] of (['unique', 'keep', 'remove'] as const).entries()) {
    const got = await paste(page, { mode });
    expect(got.got, `${mode}: ${String(got.got)}`).toEqual({});
    const pasted = (await selectionNow(island!)).filter((u) => u !== R4_SYMBOL);
    expect(pasted.length, `${mode}: the copy hangs selected`).toBeGreaterThan(0);
    await clickDrawing(page, 20 + 40 * i);
    count += 1;
    await depthAfter(page, count);
    landed[mode] = await refOf(page, pasted[0]);
  }
  expect(landed.unique).toMatch(/^R\d+$/);
  expect(landed.unique).not.toBe('R4');
  expect(landed.keep).toBe('R4');
  expect(landed.remove).toBe('R?');
  const d = await depthAfter(page, count);
  expect(await request(page, 'key.press', UNDO)).toEqual({});
  expect(await depthAfter(page, count + 1), 'one Ctrl+Z takes one paste back').toBe(d - 1);
  expect((await of(page, 'ev.menu')).length, 'no KiCad window').toBe(menus);
  expect(await askHeld(page, island!, HELD)).toEqual({ taken: true, sent: HELD });
});

test('run 15, pcb: R4\'s footprint copied, Clear net names hangs off the pointer and a click lands it as one undo step', async ({ page, browserName }) => {
  const { caps, island } = await boot(page, 'pcb', 'glasgow.kicad_pcb');
  test.skip(!caps.includes('pasteSpecial'), RUN15);
  const menus = (await of(page, 'ev.menu')).length;
  await copy(page, R4_FOOTPRINT);
  const edits = (await of(page, 'ev.edited')).length;
  const got = await paste(page, { mode: 'unique', clearNets: true });
  expect(got.got, String(got.got)).toEqual({});
  measure('paste.special board clearNets, on the pointer', `${got.ms} ms`);
  expect((await paste(page, { mode: 'keep' })).got).toBe('busy: paste.special');
  await clickDrawing(page);
  const d = await depthAfter(page, edits + 1);
  expect(await request(page, 'key.press', UNDO)).toEqual({});
  expect(await depthAfter(page, edits + 2), 'one Ctrl+Z takes the whole paste back').toBe(d - 1);
  expect((await of(page, 'ev.menu')).length, 'no KiCad window').toBe(menus);
  test.skip(island == null, `${browserName}: the island frame is out of Playwright's reach, so its held slot cannot be asked`);
  expect(await askHeld(page, island!, HELD)).toEqual({ taken: true, sent: HELD });
});
