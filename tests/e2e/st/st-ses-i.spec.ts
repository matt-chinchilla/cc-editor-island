// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-ses-i over the local pair (PROTOCOL.md board.session): a router's
// Specctra session read into the business card board. On engine run 14 the cap
// session is absent, board.session answers unsupported naming
// kicadImportSession, and KiCad's Import Specctra Session is left to KiCad. On
// engine run 15 (cc25): the preview counts business-card.ses (5 tracks, 1 via,
// 3 nets, missing /NFC_ANT) with nothing changed; the apply reads it as ONE
// undo step that one undo takes back; corrupt.ses answers session_invalid with
// KiCad's first line and no path; /tmp/cc-stage and /tmp/cc-session hold no
// folder after any answer; and Import Specctra Session sends ev.held.
import { expect, test, type Frame, type Page } from '@playwright/test';
import { ISLAND } from '../ports';

interface Ev { type: string; phase?: string; caps?: string[]; action?: string; depth?: number; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Engine {
  Module: { kicadCollabTestUndoDepth(): number };
  FS: { readdir(p: string): string[]; analyzePath(p: string): { exists: boolean } };
  kicadHostAction?: { onRequest?: (json: unknown) => boolean };
}

const RUN15 = 'waits for engine run 15 (pcbjam cc_e9_pcb.inc, unit st-ses-e: kicadImportSession)';
const FIXTURE = 'st-session-card';
const IMPORT_SESSION = 'pcbnew.EditorControl.importSpecctraSession';
const UNDO = { key: 'z', code: 'KeyZ', ctrl: true };

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

/** board.session with a fixture file's bytes, read in the page and sent as a Uint8Array; timed. */
const session = (page: Page, file: string, preview: boolean): Promise<{ ms: number; result: Record<string, unknown> }> =>
  page.evaluate(async ([f, p]) => {
    const bytes = new Uint8Array(await (await fetch(`/fixtures/${f}`)).arrayBuffer());
    const t0 = performance.now();
    const result = await (window as unknown as Harness).__bridge.request('board.session', { name: f.slice(f.lastIndexOf('/') + 1), bytes, preview: p });
    return { ms: Math.round((performance.now() - t0) * 100) / 100, result };
  }, [`${FIXTURE}/${file}`, preview] as const);
const sessionRefusal = (page: Page, file: string, preview: boolean): Promise<string> =>
  session(page, file, preview).then(() => 'ok', (err: Error) => err.message.split('\n')[0].replace(/^.*?page\.evaluate:\s*/, '').replace(/^Error:\s*/, ''));

/** Boots a pcb frame on the business card and answers ev.ready's caps and the island frame (null where Playwright cannot reach it). */
async function boot(page: Page): Promise<{ caps: string[]; frame: Frame | null }> {
  await page.goto(`/parent.html?fixture=${FIXTURE}&frame=pcb`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  const caps = (await of(page, 'ev.ready'))[0]?.caps ?? [];
  await expect(page.locator('#state')).toContainText('opened business-card.kicad_pcb', { timeout: 120_000 });
  await page.waitForTimeout(1_500);   // ev.edited's baseline
  return { caps, frame: page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null };
}
const undoDepth = (frame: Frame): Promise<number> => frame.evaluate(() => Number((window as unknown as Engine).Module.kicadCollabTestUndoDepth()));
/** What the run roots hold: folder names left under /tmp/cc-stage and /tmp/cc-session. */
const leftOver = (frame: Frame): Promise<string[]> => frame.evaluate(() => {
  const { FS } = window as unknown as Engine;
  return ['/tmp/cc-stage', '/tmp/cc-session'].flatMap((root) => (FS.analyzePath(root).exists ? FS.readdir(root).filter((n) => n !== '.' && n !== '..').map((n) => `${root}/${n}`) : []));
});
/** Asks the frame's held slot as the engine does: taken, and the ev.held sent for it. */
async function askHeld(page: Page, frame: Frame, action: string): Promise<{ taken: boolean; sent: string | null }> {
  const n = (await of(page, 'ev.held')).length;
  const taken = await frame.evaluate((a) => (window as unknown as Engine).kicadHostAction?.onRequest?.(JSON.stringify({ action: a })) === true, action);
  await page.waitForTimeout(300);
  const after = await of(page, 'ev.held');
  return { taken, sent: after.length > n ? after.at(-1)?.action ?? null : null };
}

test('run 14 or 15: session follows kicadImportSession; without it board.session answers unsupported naming the export and Import Specctra Session is KiCad\'s', async ({ page, browserName }) => {
  const { caps, frame } = await boot(page);
  expect(caps.includes('session')).toBe(caps.includes('kicadImportSession') && caps.includes('kicadCollabBusy'));
  if (!caps.includes('session')) {
    expect(await sessionRefusal(page, 'business-card.ses', true)).toBe('unsupported: kicadImportSession');
  }
  expect(await refusal(page, 'board.session', { name: 'business-card.dsn', bytes: new Uint8Array([40]), preview: true })).toBe('bad_args: board.session');
  expect(await refusal(page, 'board.session', { name: 'business-card.ses', bytes: new Uint8Array([40]) })).toBe('bad_args: board.session');
  test.skip(frame == null, `${browserName}: the island frame is out of Playwright's reach, so its held slot cannot be asked`);
  const held = caps.includes('session');
  expect(await askHeld(page, frame!, IMPORT_SESSION)).toEqual({ taken: held, sent: held ? IMPORT_SESSION : null });
});

test('run 15: the preview counts the session with nothing changed, the apply is one undo step, a corrupt session is session_invalid, no staged folder is left', async ({ page, browserName }) => {
  const { caps, frame } = await boot(page);
  test.skip(!caps.includes('session'), RUN15);
  test.skip(frame == null, `${browserName}: the island frame is out of Playwright's reach, so the undo depth and the run folders cannot be read`);
  const depth0 = await undoDepth(frame!);
  const edits0 = (await of(page, 'ev.edited')).length;

  const preview = await session(page, 'business-card.ses', true);
  expect(preview.result).toEqual({ preview: true, tracks: 5, vias: 1, nets: 3, missingNets: ['/NFC_ANT'], undoCleared: false, depth: depth0 });
  measure('board.session preview, business-card.ses', `${preview.ms} ms`);
  expect(await undoDepth(frame!)).toBe(depth0);
  expect(await leftOver(frame!)).toEqual([]);
  await page.waitForTimeout(1_000);
  expect((await of(page, 'ev.edited')).length).toBe(edits0);

  const apply = await session(page, 'business-card.ses', false);
  measure('board.session apply, business-card.ses', `${apply.ms} ms`);
  const r = apply.result as { undoCleared: boolean; depth: number };
  expect(apply.result).toMatchObject({ preview: false, tracks: 5, vias: 1, nets: 3, missingNets: ['/NFC_ANT'], removed: { tracks: 0, vias: 0 }, added: { tracks: 5, vias: 1 } });
  expect(await leftOver(frame!)).toEqual([]);
  if (r.undoCleared) {
    measure('board.session apply', 'the engine cleared the undo history');
  } else {
    expect(r.depth).toBe(depth0 + 1);
    expect(await undoDepth(frame!)).toBe(depth0 + 1);
    await expect.poll(async () => (await of(page, 'ev.edited')).length, { timeout: 5_000 }).toBe(edits0 + 1);
    // One undo takes the whole session back.
    expect(await request(page, 'key.press', UNDO)).toEqual({});
    await expect.poll(() => undoDepth(frame!), { timeout: 5_000 }).toBe(depth0);
  }

  const bad = await sessionRefusal(page, 'corrupt.ses', true);
  expect(bad).toMatch(/^session_invalid: \S/);
  expect(bad).not.toMatch(/\/tmp|cc-stage|cc-session/);
  measure('board.session corrupt.ses', bad);
  expect(await sessionRefusal(page, 'corrupt.ses', false)).toBe(bad);
  expect(await leftOver(frame!)).toEqual([]);
  if (!r.undoCleared) expect(await undoDepth(frame!)).toBe(depth0);
  expect(await askHeld(page, frame!, IMPORT_SESSION)).toEqual({ taken: true, sent: IMPORT_SESSION });
});
