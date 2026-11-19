// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-rescue-i over the local pair (PROTOCOL.md sch.rescue) on the
// st-rescue-myparts fixture (Glasgow with R4 and 11 more resistors drawn from
// MyParts:R, a table row naming a file the design does not carry). On engine
// run 14 the cap rescue is absent, sch.rescue answers unsupported naming
// kicadSchRescue, and Rescue Symbols and Remap Legacy Library Symbols are
// left to KiCad. On engine run 15 (cc25): the preview answers one candidate
// used by twelve placed symbols with nothing changed; the apply keeps the
// copy, sends glasgow-rescue.kicad_sym and sym-lib-table as ev.saved before
// the answer, moves the undo depth by one, and one undo takes it back; a name
// no candidate matches answers not_found; no run folder is left; both KiCad
// actions send ev.held.
import { expect, test, type Frame, type Page } from '@playwright/test';
import { ISLAND } from '../ports';

interface Ev { type: string; phase?: string; caps?: string[]; action?: string; path?: string; depth?: number; at: number }
interface Harness { __events: Ev[]; __saved: Record<string, string | Uint8Array>; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Engine {
  Module: { kicadCollabTestUndoDepth(): number };
  FS: { readdir(p: string): string[]; analyzePath(p: string): { exists: boolean } };
  kicadHostAction?: { onRequest?: (json: unknown) => boolean };
}
interface Candidate { name: string; libId: string; uses: number; rescuedAs: string }

const RUN15 = 'waits for engine run 15 (pcbjam cc_e9_sch.inc, unit st-rescue-e: kicadSchRescue, kicadSchRescueApply)';
const FIXTURE = 'st-rescue-myparts';
const HELD = ['eeschema.EditorControl.rescueSymbols', 'eeschema.EditorControl.remapSymbols'];
const UNDO = { key: 'z', code: 'KeyZ', ctrl: true };
const SAVED = ['glasgow-rescue.kicad_sym', 'sym-lib-table'];

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
const timed = (page: Page, args: unknown): Promise<{ ms: number; result: Record<string, unknown> }> =>
  page.evaluate(async (a) => {
    const t0 = performance.now();
    const result = await (window as unknown as Harness).__bridge.request('sch.rescue', a);
    return { ms: Math.round((performance.now() - t0) * 100) / 100, result };
  }, args);
/** The text of the latest ev.saved bytes the harness kept for `path`, or null. */
const savedText = (page: Page, path: string): Promise<string | null> => page.evaluate((p) => {
  const v = (window as unknown as Harness).__saved[p];
  return v == null ? null : typeof v === 'string' ? v : new TextDecoder().decode(v);
}, path);

/** Boots a sch frame on the fixture and answers ev.ready's caps and the island frame (null where Playwright cannot reach it). */
async function boot(page: Page): Promise<{ caps: string[]; frame: Frame | null }> {
  await page.goto(`/parent.html?fixture=${FIXTURE}&frame=sch`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  const caps = (await of(page, 'ev.ready'))[0]?.caps ?? [];
  await expect(page.locator('#state')).toContainText('opened glasgow.kicad_sch', { timeout: 120_000 });
  await page.waitForTimeout(1_500);   // ev.edited's baseline
  return { caps, frame: page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null };
}
const undoDepth = (frame: Frame): Promise<number> => frame.evaluate(() => Number((window as unknown as Engine).Module.kicadCollabTestUndoDepth()));
/** The folders left under /tmp/cc-rescue. */
const leftOver = (frame: Frame): Promise<string[]> => frame.evaluate(() => {
  const { FS } = window as unknown as Engine;
  return FS.analyzePath('/tmp/cc-rescue').exists ? FS.readdir('/tmp/cc-rescue').filter((n) => n !== '.' && n !== '..') : [];
});
/** Asks the frame's held slot as the engine does: taken, and the ev.held sent for it. */
async function askHeld(page: Page, frame: Frame, action: string): Promise<{ taken: boolean; sent: string | null }> {
  const n = (await of(page, 'ev.held')).length;
  const taken = await frame.evaluate((a) => (window as unknown as Engine).kicadHostAction?.onRequest?.(JSON.stringify({ action: a })) === true, action);
  await page.waitForTimeout(300);
  const after = await of(page, 'ev.held');
  return { taken, sent: after.length > n ? after.at(-1)?.action ?? null : null };
}

test('run 14 or 15: rescue follows the exports; without them sch.rescue answers unsupported and the rescue actions are KiCad\'s', async ({ page, browserName }) => {
  const { caps, frame } = await boot(page);
  expect(caps.includes('rescue')).toBe(['kicadSchRescue', 'kicadSchRescueApply', 'kicadCollabBusy'].every((e) => caps.includes(e)));
  if (!caps.includes('rescue')) {
    expect(await refusal(page, 'sch.rescue', { preview: true })).toBe('unsupported: kicadSchRescue');
    expect(await refusal(page, 'sch.rescue', { names: ['MyParts:R'] })).toBe('unsupported: kicadSchRescue');
  }
  expect(await refusal(page, 'sch.rescue', { preview: false })).toBe('bad_args: sch.rescue');
  expect(await refusal(page, 'sch.rescue', { names: [] })).toBe('bad_args: sch.rescue');
  test.skip(frame == null, `${browserName}: the island frame is out of Playwright's reach, so its held slot cannot be asked`);
  const held = caps.includes('rescue');
  for (const action of HELD) expect(await askHeld(page, frame!, action), action).toEqual({ taken: held, sent: held ? action : null });
});

test('run 15: the preview lists MyParts:R used twelve times with nothing changed; the apply keeps the copy as one undo step and sends both files', async ({ page, browserName }) => {
  const { caps, frame } = await boot(page);
  test.skip(!caps.includes('rescue'), RUN15);
  test.skip(frame == null, `${browserName}: the island frame is out of Playwright's reach, so the undo depth and the run folders cannot be read`);
  const depth0 = await undoDepth(frame!);
  const edits0 = (await of(page, 'ev.edited')).length;

  const preview = await timed(page, { preview: true });
  measure('sch.rescue preview, st-rescue-myparts', `${preview.ms} ms`);
  const candidates = preview.result.candidates as Candidate[];
  const mine = candidates.filter((c) => c.libId === 'MyParts:R');
  expect(mine).toEqual([{ name: 'R', libId: 'MyParts:R', uses: 12, rescuedAs: 'glasgow-rescue:R-MyParts' }]);
  expect(await undoDepth(frame!)).toBe(depth0);
  await page.waitForTimeout(1_000);
  expect((await of(page, 'ev.edited')).length).toBe(edits0);

  expect(await refusal(page, 'sch.rescue', { names: ['Nope:X'] })).toBe('not_found: a name matches no rescue candidate');
  expect(await undoDepth(frame!)).toBe(depth0);
  expect(await leftOver(frame!)).toEqual([]);

  const saved0 = (await of(page, 'ev.saved')).length;
  const apply = await timed(page, { names: ['MyParts:R'] });
  measure('sch.rescue apply MyParts:R', `${apply.ms} ms`);
  expect(apply.result).toEqual({ rescued: 1, symbols: 12, depth: depth0 + 1, saved: SAVED });
  const sent = (await of(page, 'ev.saved')).slice(saved0).map((e) => e.path);
  expect(sent).toEqual(SAVED);
  expect(await savedText(page, 'glasgow-rescue.kicad_sym')).toContain('R-MyParts');
  expect(await savedText(page, 'sym-lib-table')).toMatch(/\(name "glasgow-rescue"\)/);
  expect(await savedText(page, 'sym-lib-table')).toContain('${KIPRJMOD}/glasgow-rescue.kicad_sym');
  expect(await leftOver(frame!)).toEqual([]);
  expect(await undoDepth(frame!)).toBe(depth0 + 1);
  await expect.poll(async () => (await of(page, 'ev.edited')).length, { timeout: 5_000 }).toBe(edits0 + 1);

  const again = await timed(page, { preview: true });
  expect((again.result.candidates as Candidate[]).some((c) => c.libId === 'MyParts:R')).toBe(false);

  // One undo relinks the twelve parts to MyParts:R; the written files stay.
  expect(await request(page, 'key.press', UNDO)).toEqual({});
  await expect.poll(() => undoDepth(frame!), { timeout: 5_000 }).toBe(depth0);
  const back = await timed(page, { preview: true });
  expect((back.result.candidates as Candidate[]).filter((c) => c.libId === 'MyParts:R').map((c) => c.uses)).toEqual([12]);

  for (const action of HELD) expect(await askHeld(page, frame!, action), action).toEqual({ taken: true, sent: action });
});
