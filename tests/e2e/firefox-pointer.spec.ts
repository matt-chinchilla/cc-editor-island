// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// sy2-i over the local pair (ledger row SY2, docs/sy2-diagnosis.md): one press
// on the canvas after a tool's key. In the symbol editor P arms KiCad's pin
// tool (its host ask comes on the key) and the next press places the pin; in
// the footprint editor the pad tool's key arms it and one press places a pad.
//
// The diagnosis: in Playwright's Firefox no press reaches the island's
// document at all, for no reason of the island, the engine's wx port or
// KiCad. Its driver delivers no pointer, mouse or click event into a cross
// site frame whose top page is cross origin isolated (COOP same-origin with
// COEP), as the pair is and as /viewer is, whatever the frame holds: a bare
// page with one canvas and the pair's own headers gets none, while the same
// frame under a page that is not isolated gets every one, in Firefox as in
// Chromium. Keys pressed through key.press reach KiCad in both browsers.
//
// So each press test measures first, with that bare frame, whether this
// browser's presses reach an isolated cross site frame, and presses only
// where they do: Chromium today, Firefox once its driver delivers them.
// The footprint editor's test needs engine run 15 (the fpedit exports) and
// is skipped on an engine whose schematic frame lists no kicadFpEditOpen.
import { expect, test, type Page } from '@playwright/test';
import TOOLS from '../../theme/pencil-tools.json' with { type: 'json' };

import { ISLAND, ISLAND_ADDR, PAGE } from './ports';
interface Ev { type: string; phase?: string; depth?: number; ask?: string; uuid?: string; isNew?: boolean; caps?: string[]; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Key { key: string; code: string; ctrl?: boolean; shift?: boolean; alt?: boolean }
interface ToolRow { editor: string; action: string; defaultKey: string | null; seededKey: string | null }

const RUN15 = 'waits for engine run 15 (the fpedit exports: unit fp-e2 and the footprint editor\'s other engine units)';
const NO_PRESS = 'this browser\'s driver delivers no press into a cross site frame under a cross origin isolated page (measured by the bare frame first; docs/sy2-diagnosis.md)';
const SYM_FIX = '/fixtures/symedit-small';
const SYM_LIB = 'symedit-small_parts';
const FP_FIX = '/fixtures/fpedit-small';
const FP_LIB = 'fpedit-small_parts';
const SOIC = 'SOIC-8_3.9x4.9mm_P1.27mm';
const UNDO: Key = { key: 'z', code: 'KeyZ', ctrl: true };
const ESCAPE: Key = { key: 'Escape', code: 'Escape' };
/** The press, in the page's coordinates: inside the 1280 by 800 frame, clear of the symbol's and the footprint's items. */
const AT = { x: 400, y: 400 } as const;
/** What a whole press is, as the frame's window sees it. */
const PRESS = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'] as const;

function measure(type: string, description: string): void {
  test.info().annotations.push({ type, description });
  console.log(`[measure] ${type}: ${description}`);
}
const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const of = async (page: Page, type: string): Promise<Ev[]> => (await events(page)).filter((e) => e.type === type);
const request = (page: Page, op: string, args?: unknown): Promise<Record<string, unknown>> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const);
const text = (page: Page, path: string): Promise<string> => page.evaluate(async (p) => (await fetch(p)).text(), path);

/** The isolation headers a response carries (Cross-Origin-*), nothing else. */
function isolation(h: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(h).filter(([k]) => /^cross-origin-/i.test(k)));
}

/**
 * Loads a page holding one frame on the island's origin that holds one canvas
 * and reports every event of a press to its parent, presses once on the
 * canvas and answers which events arrived. `isolated` gives both pages the
 * pair's own isolation headers (read from the two servers), and the frame the
 * harness's own attributes; otherwise neither page carries any. It runs in a
 * page of its own, closed after, so the test's page boots the island fresh
 * (Firefox measured: a navigation from the isolated control page to the
 * harness never reached its load).
 */
async function pressReaches(host: Page, isolated: boolean): Promise<string[]> {
  const page = await host.context().newPage();
  try {
    return await pressIn(page, isolated);
  } finally {
    await page.close();
  }
}
async function pressIn(page: Page, isolated: boolean): Promise<string[]> {
  const head = isolated
    ? { page: isolation((await page.request.get(`${PAGE}/parent.html`)).headers()), island: isolation((await page.request.get(`${ISLAND_ADDR}/`)).headers()) }
    : { page: {}, island: {} };
  const tag = isolated ? 'iso' : 'plain';
  const childJs = `for (const t of ${JSON.stringify(PRESS)}) window.addEventListener(t, () => parent.postMessage({ sy2: t }, '*'), true);\nparent.postMessage({ sy2: 'loaded' }, '*');\n`;
  await page.route(`${ISLAND}/sy2-i-${tag}.js`, (r) => r.fulfill({ status: 200, contentType: 'text/javascript', headers: head.island, body: childJs }));
  await page.route(`${ISLAND}/sy2-i-${tag}.html`, (r) => r.fulfill({ status: 200, contentType: 'text/html', headers: head.island, body: `<!doctype html><body style="margin:0"><canvas width="1280" height="800" style="display:block"></canvas><script src="/sy2-i-${tag}.js"></script></body>` }));
  const attrs = isolated ? "f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-modals allow-downloads'); f.setAttribute('allow', 'cross-origin-isolated; clipboard-write');" : '';
  await page.route(`${PAGE}/sy2-i-${tag}.html`, (r) => r.fulfill({ status: 200, contentType: 'text/html', headers: head.page, body: `<!doctype html><body style="margin:0"><script>
window.__sy2 = [];
window.addEventListener('message', (e) => { if (e.data && typeof e.data.sy2 === 'string') window.__sy2.push(e.data.sy2); });
const f = document.createElement('iframe');
${attrs}
f.style.cssText = 'border:0;width:1280px;height:800px;display:block';
f.src = '${ISLAND}/sy2-i-${tag}.html';
document.body.appendChild(f);
</script></body>` }));
  await page.goto(`${PAGE}/sy2-i-${tag}.html`);
  const got = (): Promise<string[]> => page.evaluate(() => (window as unknown as { __sy2: string[] }).__sy2);
  await expect.poll(async () => (await got()).includes('loaded'), { timeout: 15_000, message: 'the bare frame loads' }).toBe(true);
  expect(await page.evaluate(() => self.crossOriginIsolated), 'the page is isolated as the pair is').toBe(isolated);
  await page.mouse.move(AT.x - 40, AT.y);
  await page.mouse.move(AT.x, AT.y, { steps: 4 });
  await page.mouse.click(AT.x, AT.y);
  // The frame posts each event as it comes; a press that arrives is answered within a frame or two.
  await page.waitForTimeout(800);
  return [...new Set((await got()).filter((t) => t !== 'loaded'))];
}
/** Whether a whole press reaches a cross site frame under a cross origin isolated page in this browser. */
async function pressesReachTheIsland(page: Page): Promise<boolean> {
  const got = await pressReaches(page, true);
  measure('a press into the isolated bare frame', got.length === 0 ? 'nothing arrived' : got.join(', '));
  return PRESS.every((t) => got.includes(t));
}

async function boot(page: Page, query: string): Promise<string[]> {
  await page.goto(`/parent.html?${query}`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  return (await of(page, 'ev.ready'))[0]?.caps ?? [];
}

/** A chord of the pencil table ("Ctrl+Alt+Shift+I", "F2") as key.press takes it (a shifted letter keeps its capital). */
function chordKey(chord: string): Key {
  const parts = chord.split('+');
  const last = parts.pop() ?? '';
  const code = /^[0-9]$/.test(last) ? `Digit${last}` : /^[A-Z]$/.test(last) ? `Key${last}` : last;
  const shift = parts.includes('Shift');
  const key = /^[A-Z]$/.test(last) && !shift ? last.toLowerCase() : last;
  return { key, code, ctrl: parts.includes('Ctrl'), shift, alt: parts.includes('Alt') };
}

test('the control: a press reaches a bare cross site frame under a plain page in every browser, and under an isolated page where the driver delivers it', async ({ page, browserName }) => {
  const plain = await pressReaches(page, false);
  measure('a press into the plain bare frame', plain.join(', '));
  expect(plain, 'a press reaches a cross site frame under a page that is not isolated').toEqual(expect.arrayContaining([...PRESS]));
  const reaches = await pressesReachTheIsland(page);
  // Chromium delivers the press; Playwright's Firefox delivers none of it (measured
  // 2026-11-19, Playwright 1.63): the loss is the driver's, before any page code runs.
  if (browserName === 'chromium') expect(reaches, 'Chromium delivers a press into the isolated frame').toBe(true);
  else measure(`${browserName}: a press into an isolated cross site frame`, reaches ? 'delivered' : 'not delivered');
});

test('the symbol editor: P arms KiCad\'s pin tool (its ask comes on the key) and one press places the pin, one undo step', async ({ page }) => {
  const reaches = await pressesReachTheIsland(page);
  await boot(page, 'frame=symedit');
  expect((await of(page, 'ev.state')).filter((e) => e.phase === 'fatal' || e.phase === 'blocked')).toEqual([]);
  const doc = await text(page, `${SYM_FIX}/${SYM_LIB}.kicad_sym`);
  await request(page, 'symedit.open', { text: doc, name: 'OPAMP2', lib: SYM_LIB, mode: 'library', discard: true });
  await page.waitForTimeout(1_200);
  const depth = async (): Promise<number> => ((await request(page, 'symedit.state')) as { depth: number }).depth;
  const d0 = await depth();
  await page.mouse.move(AT.x, AT.y);
  const asks = (await of(page, 'ev.symedit')).length;
  // KiCad's tool key carries the pointer's place, so P itself makes the pin and asks the host.
  expect(await request(page, 'key.press', { key: 'p', code: 'KeyP' })).toEqual({});
  await expect.poll(async () => (await of(page, 'ev.symedit')).length, { timeout: 5_000, message: 'P asks the host for the new pin' }).toBe(asks + 1);
  expect((await of(page, 'ev.symedit')).at(-1)).toMatchObject({ ask: 'pin', isNew: true });
  expect(await depth(), 'the pin follows the pointer, not yet placed').toBe(d0);
  if (!reaches) {
    expect(await request(page, 'key.press', ESCAPE)).toEqual({});
    test.skip(true, NO_PRESS);
  }
  const edits = (await of(page, 'ev.edited')).length;
  await page.mouse.click(AT.x, AT.y);
  await expect.poll(depth, { timeout: 5_000, message: 'one press places the pin' }).toBe(d0 + 1);
  await expect.poll(async () => (await of(page, 'ev.edited')).length, { timeout: 5_000 }).toBeGreaterThan(edits);
  expect(await request(page, 'key.press', ESCAPE)).toEqual({});
  expect(await request(page, 'key.press', UNDO)).toEqual({});
  await expect.poll(depth, { timeout: 5_000, message: 'Ctrl+Z takes the pin back' }).toBe(d0);
  expect(await of(page, 'ev.menu')).toEqual([]);
});

test('run 15: the footprint editor: the pad tool\'s key and one press place a pad, one undo step', async ({ page }) => {
  test.skip(!(await boot(page, 'frame=sch')).includes('kicadFpEditOpen'), RUN15);
  const reaches = await pressesReachTheIsland(page);
  const caps = await boot(page, 'frame=fpedit');
  test.skip(!caps.includes('fpedit'), RUN15);
  expect((await of(page, 'ev.state')).filter((e) => e.phase === 'fatal' || e.phase === 'blocked')).toEqual([]);
  const row = (TOOLS as ToolRow[]).find((r) => r.editor === 'fpedit' && r.action === 'pcbnew.PadTool.placePad');
  const chord = row?.defaultKey ?? row?.seededKey;
  expect(chord, 'the pencil table gives the pad tool a key in an fpedit frame').toBeTruthy();
  const doc = await text(page, `${FP_FIX}/${FP_LIB}.pretty/${SOIC}.kicad_mod`);
  const s = (await request(page, 'fpedit.open', { text: doc, name: SOIC, lib: FP_LIB, mode: 'library', discard: true })) as { padCount: number; depth: number };
  const state = async (): Promise<{ padCount: number; depth: number }> => (await request(page, 'fpedit.state')) as { padCount: number; depth: number };
  await page.mouse.move(AT.x, AT.y);
  expect(await request(page, 'key.press', chordKey(chord as string))).toEqual({});
  await page.waitForTimeout(300);
  expect((await state()).padCount, 'the key arms the tool and places nothing').toBe(s.padCount);
  if (!reaches) {
    expect(await request(page, 'key.press', ESCAPE)).toEqual({});
    test.skip(true, NO_PRESS);
  }
  await page.mouse.click(AT.x, AT.y);
  await expect.poll(async () => (await state()).padCount, { timeout: 5_000, message: 'one press places a pad' }).toBe(s.padCount + 1);
  expect(await request(page, 'key.press', ESCAPE)).toEqual({});
  expect(await request(page, 'key.press', UNDO)).toEqual({});
  await expect.poll(async () => (await state()).padCount, { timeout: 5_000, message: 'Ctrl+Z takes the pad back' }).toBe(s.padCount);
  expect(await of(page, 'ev.menu')).toEqual([]);
});
