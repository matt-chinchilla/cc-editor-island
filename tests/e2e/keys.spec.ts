// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// keys.claim and ev.key (PROTOCOL.md, island v0.2.3-cc17) over the local pair:
// the reader's real Alt chords inside a booted frame reach the host and never
// any listener of the frame's window after the island's own; an unclaimed
// chord, a plain key and the host's own key.press of a claimed chord still do.
// The probe is a capture listener on the frame's window registered after boot,
// as late as any of the engine's (which register at boot, after the island's).
import { expect, test, type Frame, type Page } from '@playwright/test';

const ISLAND = 'http://editor.localhost:4174';
interface Ev { type: string; phase?: string; code?: string; shift?: boolean; caps?: string[]; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
type Probe = Window & { __probe: string[] };

const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const of = async (page: Page, type: string): Promise<Ev[]> => (await events(page)).filter((e) => e.type === type);
const request = (page: Page, op: string, args?: unknown): Promise<Record<string, unknown>> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const);
const probe = (frame: Frame): Promise<string[]> => frame.evaluate(() => (window as unknown as Probe).__probe.splice(0));

async function boot(page: Page): Promise<Frame> {
  await page.goto('/parent.html?fixture=blank&frame=sch');
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  expect(await of(page, 'ev.state').then((s) => s.filter((e) => e.phase === 'blocked' || e.phase === 'fatal'))).toEqual([]);
  await expect(page.locator('#state')).toContainText('opened blank.kicad_sch', { timeout: 120_000 });
  const frame = page.frames().find((f) => f.url().startsWith(`${ISLAND}/`));
  if (frame == null) throw new Error('no island frame');
  return frame;
}

test('claimed Alt chords become ev.key and reach no window listener after the island\'s; the rest, and key.press, still reach the frame', async ({ page, browserName }) => {
  // Playwright's Firefox reaches no context in the cross-site island frame since the local pair moved (2026-10-26), and the probe lives there.
  test.skip(browserName === 'firefox', 'Playwright Firefox reaches no context in the cross-site island frame');
  const frame = await boot(page);
  expect((await of(page, 'ev.ready'))[0]?.caps).toContain('hostKeys');
  await frame.evaluate(() => {
    const w = window as unknown as Probe;
    w.__probe = [];
    for (const t of ['keydown', 'keyup']) window.addEventListener(t, (e) => { const k = e as KeyboardEvent; w.__probe.push(`${t}:${k.altKey ? 'Alt+' : ''}${k.code}`); }, true);
  });
  expect(await request(page, 'keys.claim', { chords: [{ code: 'KeyM' }, { code: 'Slash', shift: true }, { code: 'KeyS' }] }))
    .toEqual({ claimed: 2, refused: [{ code: 'KeyS', shift: false }] });
  // A real press in the drawing gives the frame the keyboard; then the reader's own keys.
  const box = await page.locator('iframe').boundingBox();
  if (box == null) throw new Error('no iframe box');
  await page.mouse.click(box.x + box.width - 40, box.y + box.height - 40);
  await probe(frame);
  await page.keyboard.press('Alt+KeyM');
  await page.keyboard.press('Alt+Shift+Slash');
  await expect.poll(async () => (await of(page, 'ev.key')).map(({ at: _at, ...e }) => e)).toEqual([{ type: 'ev.key', code: 'KeyM', shift: false }, { type: 'ev.key', code: 'Slash', shift: true }]);
  // Only the modifiers' own keydowns and keyups got past the island; no part of either chord did.
  expect((await probe(frame)).filter((l) => !/(Alt|Shift)(Left|Right)$/.test(l))).toEqual([]);
  // An unclaimed Alt chord and a plain key are KiCad's, as before.
  await page.keyboard.press('Alt+KeyN');
  await page.keyboard.press('KeyM');
  expect((await probe(frame)).filter((l) => /Key[MN]$/.test(l))).toEqual(['keydown:Alt+KeyN', 'keyup:Alt+KeyN', 'keydown:KeyM', 'keyup:KeyM']);
  // The host's own key.press of a claimed chord still reaches the engine's window, and sends nothing.
  expect(await request(page, 'key.press', { key: 'm', code: 'KeyM', alt: true })).toEqual({});
  expect(await probe(frame)).toEqual(['keydown:Alt+KeyM', 'keyup:Alt+KeyM']);
  // An empty claim gives the chord back.
  expect(await request(page, 'keys.claim', { chords: [] })).toEqual({ claimed: 0, refused: [] });
  await page.keyboard.press('Alt+KeyM');
  expect((await probe(frame)).filter((l) => /KeyM$/.test(l))).toEqual(['keydown:Alt+KeyM', 'keyup:Alt+KeyM']);
  expect(await of(page, 'ev.key')).toHaveLength(2);
});
