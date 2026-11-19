// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// fp-i1 over the local pair (PROTOCOL.md "The footprint editor: an fpedit
// frame and the fpedit ops"): KiCad's own footprint editor booted with
// ?frame=fpedit, canvas only, driven through the fpedit ops on our engine's
// fpedit exports (engine run 15): a footprint opened from its text with no
// library row, taken back as text by KiCad's own formatter, byte stable over
// open, take, open, take; a new one made of a type; marked saved; KiCad's pad
// tool placing a pad that Ctrl+Z takes back; ten opens in a row with the heap
// flat. The fixtures are tests/fixtures/fpedit-small (written by hand).
//
// The first test needs no fpedit frame and runs on every engine: outside an
// fpedit frame every fpedit op is unsupported, no frame lists fpedit, and
// fpedit-small's board opens in a pcb frame. Every other test boots an fpedit
// frame, which needs engine run 15 (the fpedit exports, unit fp-e2 and the
// footprint editor's other engine units); it is skipped on an engine whose
// schematic frame lists no kicadFpEditOpen, or whose fpedit frame lists no
// fpedit. The pad tool's key is the one the pencil table
// seeds for the frame (theme/pencil-tools.json); Firefox's pad placement
// rides the engine's pointer fix (sy2-e) as the symbol editor's pin does.
import { expect, test, type Frame, type Page } from '@playwright/test';
import TOOLS from '../../theme/pencil-tools.json' with { type: 'json' };
import palette from '../../theme/colors/circuitcenter.json' with { type: 'json' };

import { ISLAND } from './ports';
interface Ev { type: string; phase?: string; open?: boolean; shown?: boolean; depth?: number; caps?: string[]; uuids?: string[]; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Engine { Module: { HEAP8: { length: number } } }
interface State { token: string; open: boolean; name: string; lib: string; mode: string; modified: boolean; depth: number; padCount: number; type: string; padEditMode: boolean }
interface Key { key: string; code: string; ctrl?: boolean; shift?: boolean; alt?: boolean }
interface ToolRow { editor: string; action: string; defaultKey: string | null; seededKey: string | null }

const RUN15 = 'waits for engine run 15 (the fpedit exports: unit fp-e2 and the footprint editor\'s other engine units)';
const SMALL = '/fixtures/fpedit-small';
const LIB = 'fpedit-small_parts';
const SOIC = 'SOIC-8_3.9x4.9mm_P1.27mm';
const SOIC_PATH = `${SMALL}/${LIB}.pretty/${SOIC}.kicad_mod`;
const FPEDIT_REFUSAL = 'unsupported: a footprint editor opens footprints, not documents';
const FPEDIT_FRAME_ONLY = 'unsupported: a footprint edits in an fpedit frame';
const FP_OPS = ['fpedit.open', 'fpedit.new', 'fpedit.state', 'fpedit.take', 'fpedit.markSaved'];
/**
 * The island's built in pseudo-caps (bridge/responder.ts) an fpedit frame never
 * lists: its descriptor allows only heldKeys, hostKeys, write and projectLibs
 * (FP spec 6.1). The wave units' own caps (fpedit, fpeditHeld,
 * footprintConvert, importGraphics, m1-i's contextMenu and others as units
 * land) are each unit's caps(mod, frame) answer and are not this list's.
 */
const BUILTIN_DOCUMENT_CAPS = [
  'picker', 'fields', 'identity', 'selection', 'symbolConvert', 'symedit', 'symeditHeld', 'symbolEdit', 'libUpdate', 'models', 'plot',
  'symbol', 'annotate', 'check', 'boardUpdate', 'drc', 'explain', 'boardItem', 'export', 'rules', 'symbols', 'symbolExchange', 'schEdit',
  'boardFootprints', 'boardEdit', 'footprintExchange', 'settings', 'simModel', 'sim', 'boardProperties', 'properties',
];
const UNDO: Key = { key: 'z', code: 'KeyZ', ctrl: true };

function measure(type: string, description: string): void {
  test.info().annotations.push({ type, description });
  console.log(`[measure] ${type}: ${description}`);
}
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
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
const text = (page: Page, path: string): Promise<string> => page.evaluate(async (p) => (await fetch(p)).text(), path);
const heap = async (frame: Frame | null): Promise<number | null> => (frame == null ? null : frame.evaluate(() => (window as unknown as Engine).Module.HEAP8.length));
const mb = (n: number | null): string => (n == null ? 'unread' : `${Math.round(n / 1048576)} MiB`);
/** The viewer palette's board background (theme/colors/circuitcenter.json, the theme every frame selects) as "r,g,b,255". */
const BOARD_BG = `${(/^rgb\((\d+), (\d+), (\d+)\)$/.exec((palette as { board: { background: string } }).board.background) ?? []).slice(1, 4).join(',')},255`;
/** The four corner pixels of the drawing (the largest shown GL canvas, read back whole), each "r,g,b,a". */
const corners = (frame: Frame): Promise<string[]> => frame.evaluate(() => {
  const gls = [...document.querySelectorAll('canvas.gl-canvas')] as HTMLCanvasElement[];
  const src = gls.filter((c) => c.style.display !== 'none' && c.width > 0).sort((a, b) => b.width * b.height - a.width * a.height)[0] ?? (document.getElementById('canvas') as HTMLCanvasElement);
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0);
  const at = (x: number, y: number): string => [...ctx.getImageData(x, y, 1, 1).data].join(',');
  return [at(3, 3), at(c.width - 4, 3), at(3, c.height - 4), at(c.width - 4, c.height - 4)];
});

/** Boots `frame` (on `fixture`, none: the frame alone); answers the island's frame, ev.ready's caps and the time to ready. */
async function boot(page: Page, frame: string, fixture: string | null = null): Promise<{ frame: Frame | null; caps: string[]; readyMs: number }> {
  const t0 = Date.now();
  await page.goto(fixture == null ? `/parent.html?frame=${frame}` : `/parent.html?fixture=${fixture}&frame=${frame}`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  const readyMs = Date.now() - t0;
  const caps = (await of(page, 'ev.ready'))[0]?.caps ?? [];
  return { frame: page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null, caps, readyMs };
}
/**
 * Boots an fpedit frame, skipping the test on an engine without the fpedit
 * exports (before run 15): read from a schematic frame first, as an fpedit
 * frame on such an engine never reaches ev.ready.
 */
async function bootFpedit(page: Page): Promise<{ frame: Frame | null; caps: string[]; readyMs: number }> {
  test.skip(!(await boot(page, 'sch')).caps.includes('kicadFpEditOpen'), RUN15);
  const b = await boot(page, 'fpedit');
  test.skip(!b.caps.includes('fpedit'), RUN15);
  expect((await of(page, 'ev.state')).filter((e) => e.phase === 'fatal' || e.phase === 'blocked')).toEqual([]);
  return b;
}
const state = async (page: Page): Promise<State> => (await request(page, 'fpedit.state')) as unknown as State;
async function openText(page: Page, path: string, name: string, discard = true, mode = 'library'): Promise<State> {
  return (await request(page, 'fpedit.open', { text: await text(page, path), name, lib: LIB, mode, discard })) as unknown as State;
}
const take = async (page: Page): Promise<{ name: string; text: string }> => (await request(page, 'fpedit.take')) as { name: string; text: string };

/** A chord of the pencil table ("Ctrl+Alt+Shift+I", "F2") as key.press takes it (a shifted letter keeps its capital). */
function chordKey(chord: string): Key {
  const parts = chord.split('+');
  const last = parts.pop() ?? '';
  const code = /^[0-9]$/.test(last) ? `Digit${last}` : /^[A-Z]$/.test(last) ? `Key${last}` : last;
  const shift = parts.includes('Shift');
  const key = /^[A-Z]$/.test(last) && !shift ? last.toLowerCase() : last;
  return { key, code, ctrl: parts.includes('Ctrl'), shift, alt: parts.includes('Alt') };
}

test('run 14 or 15: outside an fpedit frame every fpedit op is unsupported, no frame lists fpedit, and fpedit-small\'s board opens', async ({ page }) => {
  const { caps } = await boot(page, 'pcb', 'fpedit-small');
  expect((await of(page, 'ev.state')).filter((e) => e.phase === 'fatal' || e.phase === 'blocked')).toEqual([]);
  expect(caps).not.toContain('fpedit');
  await expect(page.locator('#state')).toContainText('opened fpedit-small.kicad_pcb', { timeout: 120_000 });
  for (const op of FP_OPS) expect(await refusal(page, op, {}), op).toBe(FPEDIT_FRAME_ONLY);
  // select is the board's own in a pcb frame: an empty selection clears it as it ships.
  expect(await request(page, 'select', { uuids: [] })).toEqual({});
  const sch = await boot(page, 'sch');
  expect(sch.caps).not.toContain('fpedit');
  for (const op of FP_OPS) expect(await refusal(page, op, {}), `sch ${op}`).toBe(FPEDIT_FRAME_ONLY);
});

test('run 15: boots canvas only: no KiCad window at boot, its own caps only, a document op refused, the heap measured', async ({ page }) => {
  const { frame, caps, readyMs } = await bootFpedit(page);
  await page.waitForTimeout(5_000);
  expect(await of(page, 'ev.menu')).toEqual([]);
  const own = caps.filter((c) => !/^kicad/.test(c));
  expect(own).toEqual(expect.arrayContaining(['fpedit', 'hostKeys', 'write']));
  expect(own.filter((c) => BUILTIN_DOCUMENT_CAPS.includes(c))).toEqual([]);
  expect((await of(page, 'ev.chrome')).at(-1)?.shown ?? false).toBe(false);
  expect(await state(page)).toMatchObject({ open: false, token: '', name: '', modified: false });
  measure('fpedit boot', `ev.ready ${readyMs} ms after navigation; engine heap 5 s after ready ${mb(await heap(frame))}`);
  expect(frame).not.toBeNull();
  // The frame's fpedit.json is seeded with the viewer's appearance: KiCad's own footprint editor theme would draw 0,16,35.
  expect(await corners(frame as Frame), 'the footprint editor draws on the viewer palette\'s board background').toEqual([BOARD_BG, BOARD_BG, BOARD_BG, BOARD_BG]);
  for (const op of ['project.open', 'project.save', 'project.plot', 'place', 'layers.get', 'board.check', 'footprint.models', 'symedit.open']) expect(await refusal(page, op, {}), op).toBe(FPEDIT_REFUSAL);
  expect(await refusal(page, 'fpedit.take')).toBe('no_footprint: fpedit.take');
  expect(await refusal(page, 'select', { uuids: [] })).toBe('no_footprint: select');
});

test('run 15: opens the design\'s SOIC by its text; take, open, take is byte stable; every fixture footprint and a new one open', async ({ page }) => {
  await bootFpedit(page);
  const s = await openText(page, SOIC_PATH, SOIC, false);
  expect(s).toMatchObject({ open: true, name: SOIC, lib: LIB, mode: 'library', modified: false, depth: 0, padCount: 8, type: 'smd', padEditMode: false });
  expect(s.token).toMatch(/^[\x20-\x7e]{1,64}$/);
  expect(await of(page, 'ev.menu')).toEqual([]);
  const first = await take(page);
  expect(first.name).toBe(SOIC);
  expect(first.text).toMatch(/^\(footprint "SOIC-8_3\.9x4\.9mm_P1\.27mm"/);
  const again = (await request(page, 'fpedit.open', { text: first.text, name: SOIC, lib: LIB, mode: 'library', discard: false })) as unknown as State;
  expect(again.padCount).toBe(8);
  expect((await take(page)).text, 'take, open, take').toBe(first.text);
  for (const [file, pads, type] of [['CUSTOMPAD', 2, 'smd'], ['CHECKME', 3, 'through_hole']] as const) {
    const opened = await openText(page, `${SMALL}/${file}.kicad_mod`, file);
    expect(opened, file).toMatchObject({ open: true, name: file, padCount: pads, type, depth: 0 });
  }
  const placed = (await request(page, 'fpedit.open', { text: first.text, name: SOIC, lib: '', mode: 'placed', discard: false })) as unknown as State;
  expect(placed).toMatchObject({ mode: 'placed', lib: '', padCount: 8 });
  const made = (await request(page, 'fpedit.new', { name: 'NEW1', lib: '', type: 'smd', discard: false })) as unknown as State;
  expect(made).toMatchObject({ open: true, name: 'NEW1', mode: 'new', type: 'smd', padCount: 0, depth: 0, modified: false });
  expect(await refusal(page, 'fpedit.open', { text: '(kicad_pcb (version 20240108))', name: 'X', lib: '', mode: 'library', discard: true })).toBe('unreadable: fpedit.open: the text holds no footprint KiCad reads');
  expect(await state(page)).toMatchObject({ name: 'NEW1' });
  expect(await refusal(page, 'fpedit.markSaved', { token: 'not-the-open-token' })).toBe("bad_args: fpedit.markSaved: the token is not the open footprint's");
  expect(await request(page, 'fpedit.markSaved', { token: made.token })).toMatchObject({ modified: false, token: made.token });
  // A pad of the SOIC selects by its uuid (the fixture's own).
  await openText(page, SOIC_PATH, SOIC);
  const pad = /\(pad "1"[\s\S]*?\(uuid "([0-9a-f-]{36})"\)/.exec(first.text)?.[1];
  expect(pad).toBeDefined();
  expect(await request(page, 'select', { uuids: [pad], zoom: true })).toEqual({});
  const opens: number[] = [];
  const takes: number[] = [];
  const doc = await text(page, SOIC_PATH);
  for (let i = 0; i < 5; i++) {
    opens.push((await timed(page, 'fpedit.open', { text: doc, name: SOIC, lib: LIB, mode: 'library', discard: true })).ms);
    takes.push((await timed(page, 'fpedit.take')).ms);
  }
  measure('fpedit.open and take, the SOIC', `open median ${median(opens)} ms of ${opens.join(', ')}; take median ${median(takes)} ms of ${takes.join(', ')}`);
});

test('run 15: KiCad\'s pad tool places a pad (ev.edited, one undo step) and Ctrl+Z takes it back', async ({ page }) => {
  await bootFpedit(page);
  const row = (TOOLS as ToolRow[]).find((r) => r.editor === 'fpedit' && r.action === 'pcbnew.PadTool.placePad');
  expect(row, 'the pencil table seeds a key for the pad tool in an fpedit frame').toBeDefined();
  const chord = row?.defaultKey ?? row?.seededKey;
  expect(chord, 'the pad tool has a key').toBeTruthy();
  const s = await openText(page, SOIC_PATH, SOIC);
  const edits = (await of(page, 'ev.edited')).length;
  expect(await request(page, 'key.press', chordKey(chord as string))).toEqual({});
  await page.mouse.click(400, 400);
  await expect.poll(async () => (await state(page)).padCount, { timeout: 5_000, message: 'the pad tool places a pad' }).toBe(s.padCount + 1);
  expect(await request(page, 'key.press', { key: 'Escape', code: 'Escape' })).toEqual({});
  await expect.poll(async () => (await of(page, 'ev.edited')).length, { timeout: 5_000 }).toBeGreaterThan(edits);
  expect(await state(page)).toMatchObject({ depth: 1, modified: true });
  await page.screenshot({ path: test.info().outputPath('pad-placed.png') });
  expect(await request(page, 'key.press', UNDO)).toEqual({});
  await expect.poll(async () => (await state(page)).padCount, { timeout: 5_000, message: 'Ctrl+Z takes the pad back' }).toBe(s.padCount);
  expect(await of(page, 'ev.menu')).toEqual([]);
});

test('run 15: ten opens and takes in a row keep the engine heap flat past noise', async ({ page }) => {
  const { frame } = await bootFpedit(page);
  const doc = await text(page, SOIC_PATH);
  const custom = await text(page, `${SMALL}/CUSTOMPAD.kicad_mod`);
  await request(page, 'fpedit.open', { text: doc, name: SOIC, lib: LIB, mode: 'library', discard: true });
  const before = await heap(frame);
  for (let i = 0; i < 10; i++) {
    await request(page, 'fpedit.open', { text: i % 2 === 0 ? custom : doc, name: i % 2 === 0 ? 'CUSTOMPAD' : SOIC, lib: LIB, mode: 'library', discard: true });
    await take(page);
  }
  const after = await heap(frame);
  measure('fpedit heap over ten opens', `${mb(before)} before, ${mb(after)} after`);
  expect(before).not.toBeNull();
  // WebAssembly memory only grows; ten opens of a small footprint may grow it by at most one step of noise.
  expect((after ?? 0) - (before ?? 0)).toBeLessThanOrEqual(32 * 1048576);
});
