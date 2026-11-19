// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// i-placebody over the local pair: place with `body` puts a part whose
// definition the host holds on the pointer as <nickname>:<name>, with no
// symbol file behind the nickname (the http-lib fixture's "Remote" is an HTTP
// source row, and "Parts" names no row at all), one undo step per press; a
// body over 4 MiB answers bad_args. No engine change: this runs on engine
// run 14 as on run 15.
import { expect, test, type Page } from '@playwright/test';

interface Ev { type: string; phase?: string; depth?: number; caps?: string[] }
interface Harness { __events: Ev[]; __saved: Record<string, Uint8Array>; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }

const FIXTURE = 'http-lib';
const SHEET = 'httplib.kicad_sch';
const MAX_BYTES = 4 * 1024 * 1024;

const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const of = async (page: Page, type: string): Promise<Ev[]> => (await events(page)).filter((e) => e.type === type);
const request = (page: Page, op: string, args?: unknown): Promise<Record<string, unknown>> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const);
/** A request's refusal as "code: message", or "ok" (Playwright's own prefix taken off, as on Chromium and Firefox). */
const refusal = (page: Page, op: string, args?: unknown): Promise<string> =>
  request(page, op, args).then(() => 'ok', (err: Error) => err.message.split('\n')[0].replace(/^.*?page\.evaluate:\s*/, '').replace(/^Error:\s*/, ''));
const savedText = (page: Page, path: string): Promise<string> =>
  page.evaluate((p) => new TextDecoder().decode((window as unknown as Harness).__saved[p]), path);

/** A part's body as the host gives it: a resistor renamed to the part's own name, self contained. */
function bodyOf(name: string): string {
  return `(kicad_symbol_lib (version 20251024) (generator "kicad_symbol_editor")
  (symbol "${name}" (pin_numbers hide) (pin_names (offset 0)) (exclude_from_sim no) (in_bom yes) (on_board yes)
    (property "Reference" "R" (at 2.032 0 90) (effects (font (size 1.27 1.27))))
    (property "Value" "${name}" (at 0 0 90) (effects (font (size 1.27 1.27))))
    (property "Footprint" "Resistor_SMD:R_0603_1608Metric" (at -1.778 0 90) (effects (font (size 1.27 1.27)) (hide yes)))
    (property "Datasheet" "~" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
    (property "Description" "A part from an HTTP source" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
    (symbol "${name}_0_1"
      (rectangle (start -1.016 -2.54) (end 1.016 2.54) (stroke (width 0.254) (type default)) (fill (type none))))
    (symbol "${name}_1_1"
      (pin passive line (at 0 3.81 270) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
      (pin passive line (at 0 -3.81 90) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27))))))))`;
}

async function boot(page: Page): Promise<void> {
  await page.goto(`/parent.html?fixture=${FIXTURE}&frame=sch`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  expect(await of(page, 'ev.state').then((s) => s.filter((e) => e.phase === 'blocked' || e.phase === 'fatal'))).toEqual([]);
  await expect(page.locator('#state')).toContainText(`opened ${SHEET}`, { timeout: 120_000 });
}

async function at(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const box = await page.locator('iframe').boundingBox();
  if (box == null) throw new Error('no iframe box');
  return { x: box.x + x, y: box.y + y };
}

/** The pointer goes to (x, y), the body is placed, and a press there commits it: resolves with the undo depth after the press. */
async function placeAt(page: Page, args: Record<string, unknown>, [x, y]: [number, number]): Promise<number> {
  const p = await at(page, x, y);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  expect(await request(page, 'place', args)).toEqual({});
  // As a host does after the answer (PROTOCOL.md place): the frame takes the focus.
  await page.locator('iframe').evaluate((f) => (f as HTMLIFrameElement).focus());
  const before = (await of(page, 'ev.edited')).length;
  const q = await at(page, x + 6, y + 6);
  await page.mouse.move(q.x, q.y, { steps: 4 });
  await page.mouse.click(q.x, q.y);
  await expect.poll(async () => (await of(page, 'ev.edited')).length, { timeout: 15_000 }).toBeGreaterThan(before);
  return (await of(page, 'ev.edited')).at(-1)?.depth ?? -1;
}

/** The placed symbols' lib_ids and the names the sheet's lib_symbols caches, read from the saved sheet. */
function sheetFacts(text: string): { placed: string[]; cached: string[] } {
  const placed = [...text.matchAll(/\(lib_id\s+"((?:[^"\\]|\\.)*)"\)/g)].map((m) => m[1]);
  const start = text.indexOf('(lib_symbols');
  const cached: string[] = [];
  if (start >= 0) {
    // The cache's direct children: a symbol form at depth 2 under lib_symbols.
    let depth = 0;
    let quoted = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (quoted) { if (c === '\\') i++; else if (c === '"') quoted = false; continue; }
      if (c === '"') { quoted = true; continue; }
      if (c === '(') {
        depth++;
        if (depth === 2) { const m = /^\(symbol\s+"((?:[^"\\]|\\.)*)"/.exec(text.slice(i, i + 300)); if (m != null) cached.push(m[1]); }
      } else if (c === ')') { depth--; if (depth === 0) break; }
    }
  }
  return { placed, cached };
}

test('ev.ready lists placeBody, and a body placed under a nickname with no symbol file lands as <nickname>:<name>, one undo step', async ({ page }) => {
  await boot(page);
  expect((await of(page, 'ev.ready'))[0]?.caps).toContain('placeBody');
  // "Remote" is the fixture's HTTP source row: no symbol file behind it.
  const first = 'RC0603FR-0710KL';
  const d1 = await placeAt(page, { kind: 'symbol', lib: 'Remote', name: first, body: bodyOf(first), value: '10k', mpn: first, manufacturer: 'Yageo' }, [500, 400]);
  expect(d1).toBe(1);
  // "Parts" names no row at all.
  const second = 'ERJ-3EKF1002V';
  const d2 = await placeAt(page, { kind: 'symbol', lib: 'Parts', name: second, body: bodyOf(second) }, [700, 400]);
  expect(d2).toBe(2);
  await request(page, 'project.save');
  let facts = sheetFacts(await savedText(page, SHEET));
  expect(facts.placed).toEqual(expect.arrayContaining(['Remote:R', `Remote:${first}`, `Parts:${second}`]));
  expect(facts.cached).toEqual(expect.arrayContaining([`Remote:${first}`, `Parts:${second}`]));
  const saved = await savedText(page, SHEET);
  expect(saved).toContain('(property "MPN" "RC0603FR-0710KL"');
  expect(saved).toContain('(property "Manufacturer" "Yageo"');
  // One undo step: a single Ctrl+Z takes the second part back and leaves the first.
  const before = (await of(page, 'ev.edited')).length;
  expect(await request(page, 'key.press', { key: 'z', code: 'KeyZ', ctrl: true })).toEqual({});
  await expect.poll(async () => (await of(page, 'ev.edited')).length, { timeout: 15_000 }).toBeGreaterThan(before);
  expect((await of(page, 'ev.edited')).at(-1)?.depth).toBe(1);
  await request(page, 'project.save');
  facts = sheetFacts(await savedText(page, SHEET));
  expect(facts.placed).toContain(`Remote:${first}`);
  expect(facts.placed).not.toContain(`Parts:${second}`);
});

test('place with body refuses a body over 4 MiB (bad_args), a name the body does not hold (not_found), and a footprint (bad_args), changing nothing', async ({ page }) => {
  await boot(page);
  const name = 'RC0603FR-0710KL';
  const body = bodyOf(name);
  const over = body.replace(/\)$/, `${' '.repeat(MAX_BYTES + 1 - body.length)})`);
  expect(await refusal(page, 'place', { kind: 'symbol', lib: 'Remote', name, body: over })).toBe('bad_args: place');
  expect(await refusal(page, 'place', { kind: 'symbol', lib: 'Remote', name: 'Other', body })).toBe('not_found: Remote:Other');
  expect(await refusal(page, 'place', { kind: 'footprint', lib: 'Remote', name, body })).toBe('bad_args: place');
  // The bound itself is taken.
  const exact = body.replace(/\)$/, `${' '.repeat(MAX_BYTES - body.length)})`);
  expect(await request(page, 'place', { kind: 'symbol', lib: 'Remote', name, body: exact })).toEqual({});
  expect(await request(page, 'key.press', { key: 'Escape', code: 'Escape' })).toEqual({});
  await page.waitForTimeout(2_000);
  expect(await of(page, 'ev.edited')).toEqual([]);
});
