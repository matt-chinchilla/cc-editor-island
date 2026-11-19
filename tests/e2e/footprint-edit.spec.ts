// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// fp-i4 over the local pair (PROTOCOL.md footprint.forEditor, footprint.push
// and footprint.convert): the board side of the footprint editor and its file
// reader. On engine run 14 the caps footprintEdit and footprintConvert are
// absent and each op answers unsupported naming the export it lacks. On engine
// run 15 (cc25): on fpedit-small's board a placed U1 goes to the footprint
// editor as text with the board's uuids and comes back as ONE undo step
// "Update footprint", relinked or not, with its position, angle, side and nets
// unchanged; and a KiCad 5 footprint file and an Eagle package read as one
// footprint each in a pcb and an fpedit frame.
import { expect, test, type Page } from '@playwright/test';

interface Ev { type: string; phase?: string; caps?: string[]; path?: string; bytes?: number; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }

const RUN15 = 'waits for engine run 15 (pcbjam cc_e5, unit fp-e7: kicadFootprintForEditor, kicadFootprintPushToBoard, kicadFootprintConvert)';
const UNDO = { key: 'z', code: 'KeyZ', ctrl: true };
const LIB = 'fpedit-small_parts';
const SOIC = 'SOIC-8_3.9x4.9mm_P1.27mm';
const NO_SUCH = 'f0071000-0000-4000-8000-0000000009ff';

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
const timed = (page: Page, op: string, args?: unknown): Promise<{ ms: number; result: Record<string, unknown> }> => page.evaluate(async ([o, a]) => {
  const t0 = performance.now();
  const result = await (window as unknown as Harness).__bridge.request(o as string, a);
  return { ms: Math.round((performance.now() - t0) * 100) / 100, result };
}, [op, args] as const);

/** Boots `frame` on `fixture` (none: the frame alone) and answers ev.ready's caps. */
async function boot(page: Page, frame: 'pcb' | 'fpedit', fixture: string | null): Promise<string[]> {
  await page.goto(fixture == null ? `/parent.html?frame=${frame}` : `/parent.html?fixture=${fixture}&frame=${frame}`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  const caps = (await of(page, 'ev.ready'))[0]?.caps ?? [];
  if (fixture != null) {
    await expect(page.locator('#state')).toContainText(`opened ${fixture}.kicad_pcb`, { timeout: 120_000 });
    await page.waitForTimeout(1_500);   // ev.edited's baseline
  }
  return caps;
}

/** A fixture file's bytes, as a request carries them. */
const fixtureBytes = (page: Page, path: string): Promise<number[]> =>
  page.evaluate(async (p) => [...new Uint8Array(await (await fetch(`/fixtures/${p}`)).arrayBuffer())], path);
const convert = (page: Page, name: string, bytes: number[]): Promise<{ format: string; footprints: Array<{ name: string; text: string }> }> =>
  page.evaluate(([n, b]) => (window as unknown as Harness).__bridge.request('footprint.convert', { name: n, bytes: new Uint8Array(b as number[]) }), [name, bytes] as const) as never;

/** The board text the last project.save reported. */
async function savedBoard(page: Page): Promise<string> {
  const n = (await of(page, 'ev.saved')).length;
  await request(page, 'project.save');
  await expect.poll(async () => (await of(page, 'ev.saved')).slice(n).some((e) => e.path?.endsWith('.kicad_pcb')), { timeout: 10_000 }).toBe(true);
  const ev = (await of(page, 'ev.saved')).slice(n).find((e) => e.path?.endsWith('.kicad_pcb'));
  // The harness records an event's size and its first 4 KiB as text; the whole bytes of each saved path are in __saved.
  return page.evaluate((path) => new TextDecoder().decode((window as unknown as { __saved: Record<string, Uint8Array> }).__saved[path]), ev?.path as string);
}

/** The `(footprint ...)` block of the board text whose own uuid is `uuid`. */
function footprintBlock(board: string, uuid: string): string {
  const at = board.indexOf(`(uuid "${uuid}")`);
  expect(at, `the board holds ${uuid}`).toBeGreaterThan(0);
  const start = board.lastIndexOf('(footprint ', at);
  let depth = 0;
  for (let i = start; i < board.length; i++) {
    if (board[i] === '(') depth++;
    else if (board[i] === ')' && --depth === 0) return board.slice(start, i + 1);
  }
  throw new Error('an unclosed footprint');
}
/** What a push must keep: the footprint's place, side and every pad's net, by pad number. */
function kept(block: string): { at: string; layer: string; nets: string[] } {
  const at = /\n\t\t\(at ([^)]*)\)/.exec(block)?.[1] ?? '';
  const layer = /\n\t\t\(layer "([^"]*)"\)/.exec(block)?.[1] ?? '';
  const nets = [...block.matchAll(/\(pad "([^"]*)"[\s\S]*?\(net (?:\d+ )?"([^"]*)"\)/g)].map((m) => `${m[1]}=${m[2]}`);
  return { at, layer, nets };
}

test('run 14 or 15: the caps follow the engine\'s exports, and an engine without them answers each op unsupported naming the export', async ({ page }) => {
  const caps = await boot(page, 'pcb', 'glasgow');
  expect(caps.includes('footprintEdit')).toBe(caps.includes('kicadFootprintForEditor') && caps.includes('kicadFootprintPushToBoard'));
  expect(caps.includes('footprintConvert')).toBe(caps.includes('kicadFootprintConvert'));
  if (!caps.includes('footprintEdit')) {
    expect(await refusal(page, 'footprint.forEditor', { uuid: NO_SUCH })).toBe('unsupported: kicadFootprintForEditor');
    expect(await refusal(page, 'footprint.push', { uuid: NO_SUCH, text: '(footprint "x")', libId: '' })).toBe('unsupported: kicadFootprintForEditor');
  }
  if (!caps.includes('footprintConvert')) {
    expect(await refusal(page, 'footprint.convert', { name: 'legacy.mod', bytes: new Uint8Array([1]) })).toBe('unsupported: kicadFootprintConvert');
  }
  expect(await refusal(page, 'footprint.forEditor', { uuid: 'U1' })).toBe('bad_args: footprint.forEditor');
  expect(await refusal(page, 'footprint.convert', { name: 'a/b.mod', bytes: new Uint8Array([1]) })).toBe('bad_args: footprint.convert');
});

test('run 15: footprint.forEditor, then footprint.push without and with a lib id: one undo step each, U1 kept in place with its nets', async ({ page }) => {
  const caps = await boot(page, 'pcb', 'fpedit-small');
  test.skip(!caps.includes('footprintEdit'), RUN15);
  const rows = (await request(page, 'board.footprints')).footprints as Array<{ uuid: string; ref: string; libId: string }>;
  const u1 = rows.find((r) => r.ref === 'U1');
  expect(u1).toBeDefined();
  const t = await timed(page, 'footprint.forEditor', { uuid: u1!.uuid });
  const got = t.result as { name: string; libId: string; ref: string; text: string };
  expect(got).toMatchObject({ name: SOIC, ref: 'U1' });
  expect(got.text.startsWith(`(footprint "${SOIC}"`)).toBe(true);
  expect(got.text).not.toMatch(/\(net /);
  measure('footprint.forEditor, U1', `${t.ms} ms, ${got.text.length} characters`);
  expect(await refusal(page, 'footprint.forEditor', { uuid: NO_SUCH })).toBe(`not_found: ${NO_SUCH}`);

  const before = footprintBlock(await savedBoard(page), u1!.uuid);
  // Every pad uuid U1 has on the board is in the text the editor gets.
  for (const m of before.matchAll(/\(pad "[^"]*"[\s\S]*?\(uuid "([0-9a-f-]{36})"\)/g)) expect(got.text).toContain(m[1]);
  // Pad 1 moved by 0.1 mm in x; nothing else changed.
  const edited = got.text.replace(/(\(pad "1"[\s\S]*?\(at )(-?[0-9.]+)/, (_, head: string, x: string) => `${head}${(Number(x) + 0.1).toFixed(4).replace(/\.?0+$/, '')}`);
  expect(edited).not.toBe(got.text);
  const edits0 = (await of(page, 'ev.edited')).length;
  const pushed = await timed(page, 'footprint.push', { uuid: u1!.uuid, text: edited, libId: '' });
  expect(pushed.result).toEqual({ uuid: u1!.uuid });
  measure('footprint.push, U1', `${pushed.ms} ms`);
  await expect.poll(async () => (await of(page, 'ev.edited')).length, { timeout: 5_000 }).toBe(edits0 + 1);
  const after = footprintBlock(await savedBoard(page), u1!.uuid);
  expect(kept(after)).toEqual(kept(before));
  expect(kept(before).nets.length).toBeGreaterThan(0);
  expect(after).not.toBe(before);

  const relinked = await request(page, 'footprint.push', { uuid: u1!.uuid, text: edited, libId: `${LIB}:${SOIC}_EDIT` });
  expect(relinked).toEqual({ uuid: u1!.uuid });
  await expect.poll(async () => (await of(page, 'ev.edited')).length, { timeout: 5_000 }).toBe(edits0 + 2);
  expect(((await request(page, 'board.item.get', { uuids: [u1!.uuid] })).items as Array<{ libId: string }>)[0].libId).toBe(`${LIB}:${SOIC}_EDIT`);
  expect(await request(page, 'key.press', UNDO)).toEqual({});
  await expect.poll(async () => ((await request(page, 'board.item.get', { uuids: [u1!.uuid] })).items as Array<{ libId: string }>)[0].libId, { timeout: 5_000 }).toBe(u1!.libId);
  expect(await refusal(page, 'footprint.push', { uuid: u1!.uuid, text: '(footprint "x"', libId: '' })).toBe('bad_args: footprint.push: the text holds no footprint KiCad reads');
  expect(await refusal(page, 'footprint.push', { uuid: NO_SUCH, text: edited, libId: '' })).toBe(`not_found: ${NO_SUCH}`);
});

for (const frame of ['pcb', 'fpedit'] as const) {
  test(`run 15: footprint.convert reads a KiCad 5 footprint and an Eagle package in a ${frame} frame`, async ({ page }) => {
    const caps = await boot(page, frame, frame === 'pcb' ? 'glasgow' : null);
    test.skip(!caps.includes('footprintConvert'), RUN15);
    expect(caps.includes('footprintEdit')).toBe(frame === 'pcb');
    const legacy = await convert(page, 'legacy.mod', await fixtureBytes(page, 'footprint-convert/legacy.mod'));
    expect(legacy.format).toBe('Legacy');
    expect(legacy.footprints.map((f) => f.name)).toEqual(['LEGACY_R0805']);
    expect(legacy.footprints[0].text).toMatch(/^\(footprint "LEGACY_R0805"/);
    const eagle = await convert(page, 'package.lbr', await fixtureBytes(page, 'footprint-convert/package.lbr'));
    expect(eagle.format).toBe('Eagle');
    expect(eagle.footprints.map((f) => f.name)).toEqual(['EAGLE_R0603']);
    expect((eagle.footprints[0].text.match(/\(pad "/g) ?? []).length).toBe(2);
    expect(await refusal(page, 'footprint.convert', { name: 'x.bad', bytes: new Uint8Array([63]) })).toMatch(/^unreadable: /);
    if (frame === 'fpedit') expect(await refusal(page, 'footprint.forEditor', { uuid: NO_SUCH })).toBe('unsupported: a footprint editor opens footprints, not documents');
  });
}
