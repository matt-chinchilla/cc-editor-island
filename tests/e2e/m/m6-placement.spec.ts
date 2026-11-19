// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// m6-i: the placement windows of KiCad's board editor asked of the host with
// no KiCad window (the canvas commands addendum 7: moveExact, offset, array,
// positionRelative, filterSelection, findFootprint, read through m1x-i's
// prompt host and answered with prompt.answer and prompt.pick), and the
// selection filter read and written (selectFilter.get, selectFilter.set), on
// the canvas-kinds fixture (unit m1-fx). Each edit is one ev.edited and one
// undo step, its change read back with board.item.get or the saved board,
// and no window of KiCad's shows: no dialog in the frame, no popup of KiCad's,
// ev.menu never open.
//
// On engine run 14 only the first describe runs: the cap selectFilter is
// absent and both ops answer unsupported naming kicadSelectionFilterGet, in
// a pcb and a sch frame. Every other test waits for engine run 15 (K-PROMPT
// and units m6-e1, m6-e2, m6-e3) and is skipped here naming it.
import { expect, test, type Frame, type Page } from '@playwright/test';

import { ISLAND } from '../ports';

interface Ev {
  type: string; at: number; open?: boolean; caps?: string[]; token?: number; frame?: string; uuids?: string[];
  depth?: number; ask?: string; modal?: boolean; record?: Record<string, unknown>; reason?: string;
}
interface Harness { __events: Ev[]; __saved: Record<string, Uint8Array>; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
type Answer = { ok?: boolean; error?: { code: string; message: string } } & Record<string, unknown>;
type Rec = Record<string, unknown>;

const FIXTURE = 'canvas-kinds';
const PCB = 'canvas-kinds.kicad_pcb';
const SCH = 'canvas-kinds.kicad_sch';
const RUN15 = 'waits for engine run 15: the prompts, the placement asks and the selection filter (kicadHostPrompts, kicadSelectionFilterGet; units m1x-e1, m6-e1, m6-e2, m6-e3)';

/** The fixture's board items by name (tests/fixtures/canvas-kinds/ids.json). */
const ID = {
  R1: 'cc0ca4d5-0000-4000-8000-000000000301',
  U1: 'cc0ca4d5-0000-4000-8000-000000000302',
  R2: 'cc0ca4d5-0000-4000-8000-000000000303',
  TRACK_A: 'cc0ca4d5-0000-4000-8000-000000000310',
} as const;

const BOARD_KEYS = ['lockedItems', 'footprints', 'text', 'tracks', 'vias', 'pads', 'graphics', 'zones', 'keepouts', 'dimensions', 'points', 'otherItems'];
const SCH_KEYS = ['lockedItems', 'symbols', 'text', 'wires', 'labels', 'pins', 'graphics', 'images', 'ruleAreas', 'otherItems'];
const OPS = ['selectFilter.get', 'selectFilter.set'];
const UNSUPPORTED = { error: { code: 'unsupported', message: 'kicadSelectionFilterGet' } };

const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const of = async (page: Page, type: string): Promise<Ev[]> => (await events(page)).filter((e) => e.type === type);
const countOf = async (page: Page, type: string): Promise<number> => (await of(page, type)).length;
/** The bridge's answer, or its refusal as { error }. */
const request = (page: Page, op: string, args?: unknown): Promise<Answer> =>
  page.evaluate(async ([o, a]) => {
    try { return await (window as unknown as Harness).__bridge.request(o as string, a); } catch (e) {
      // The harness rejects with "<code>: <message>".
      const m = /^([a-z_]+): ([\s\S]*)$/.exec(String((e as { message?: string }).message ?? e));
      return { error: { code: m?.[1] ?? 'thrown', message: m?.[2] ?? String(e) } };
    }
  }, [op, args] as const);
const islandFrame = (page: Page): Frame | null => page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null;
const undo = (page: Page): Promise<Answer> => request(page, 'key.press', { key: 'z', code: 'KeyZ', ctrl: true });

function measure(type: string, description: string): void {
  test.info().annotations.push({ type, description });
  console.log(`[measure] ${type}: ${description}`);
}

async function open(page: Page, frame: 'pcb' | 'sch' = 'pcb'): Promise<string[]> {
  await page.goto(`/parent.html?frame=${frame}&fixture=${FIXTURE}`);
  await page.waitForFunction(() => /opened |open failed|state (blocked|fatal)/.test(document.getElementById('state')?.textContent ?? ''), null, { timeout: 170_000 });
  expect(await page.textContent('#state')).toContain(`opened ${frame === 'pcb' ? PCB : SCH}`);
  await page.waitForTimeout(1_500);
  return (await of(page, 'ev.ready'))[0]?.caps ?? [];
}

/** Opens the fixture and skips the test on an engine before run 15. */
async function open15(page: Page, need: readonly string[], frame: 'pcb' | 'sch' = 'pcb'): Promise<string[]> {
  const caps = await open(page, frame);
  test.skip(!need.every((c) => caps.includes(c)), RUN15);
  return caps;
}

/** The drawing canvas's center, in the page's coordinates. */
async function canvasCenter(page: Page): Promise<{ x: number; y: number }> {
  const frame = islandFrame(page);
  const box = await page.locator('iframe').boundingBox();
  if (frame == null || box == null) throw new Error('no island frame');
  const c = await frame.evaluate(() => {
    const all = [...document.querySelectorAll('canvas')].filter((e) => e.getBoundingClientRect().width > 0);
    all.sort((a, b) => b.width * b.height - a.width * a.height);
    const r = all[0]?.getBoundingClientRect();
    return r == null ? null : { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (c == null) throw new Error('no drawing canvas');
  return { x: box.x + c.x, y: box.y + c.y };
}

/** No window of KiCad's: no dialog in the frame, no popup of KiCad's, ev.menu never open. */
async function noWindow(page: Page, what: string): Promise<void> {
  const frame = islandFrame(page);
  if (frame == null) throw new Error('no island frame');
  const shown = await frame.evaluate(() => {
    const reg = (window as unknown as { wxElementRegistry?: { findAll(f: object): Array<{ typeName: string; name: string }> } }).wxElementRegistry;
    const dialogs = (reg?.findAll({ visible: true }) ?? []).filter((e) => /Dialog/.test(e.typeName)).map((e) => `${e.typeName}:${e.name}`);
    return { dialogs, popup: document.querySelector('.wx-menu-popup') != null };
  });
  expect(shown, what).toEqual({ dialogs: [], popup: false });
  expect((await of(page, 'ev.menu')).filter((e) => e.open === true), what).toEqual([]);
}

async function select(page: Page, uuids: readonly string[], zoom = uuids.length > 0): Promise<void> {
  expect(await request(page, 'select', { uuids, zoom })).toEqual({});
  await page.waitForTimeout(600);
}

/** A footprint as board.item.get answers it. */
async function item(page: Page, uuid: string): Promise<Rec> {
  const r = await request(page, 'board.item.get', { uuids: [uuid] });
  expect(r.error, `board.item.get ${uuid}`).toBeUndefined();
  return (r.items as Rec[])[0];
}

/** The board as KiCad saves it now (project.save, the bytes ev.saved brought). */
async function savedText(page: Page): Promise<string> {
  const r = await request(page, 'project.save');
  expect(r.error, 'project.save').toBeUndefined();
  return page.evaluate((p) => new TextDecoder().decode((window as unknown as Harness).__saved[p]), PCB);
}
const footprints = (text: string): number => (text.match(/^\t\(footprint /gm) ?? []).length;

/** action.run of `name`, then the next ev.prompt, of `ask`. */
async function ask(page: Page, name: string, want: string, modal: boolean): Promise<Ev> {
  const before = await countOf(page, 'ev.prompt');
  expect(await request(page, 'action.run', { name }), name).toEqual({});
  await expect.poll(async () => (await countOf(page, 'ev.prompt')) - before, { timeout: 10_000, message: `the ${want} prompt` }).toBe(1);
  const p = (await of(page, 'ev.prompt')).at(-1)!;
  expect(p.ask).toBe(want);
  expect(p.modal).toBe(modal);
  expect(p.frame).toBe('pcb');
  return p;
}
const answer = (page: Page, p: Ev, a: Rec = {}): Promise<Answer> => request(page, 'prompt.answer', { token: p.token, ...a });

/** The next ev.promptUpdate after `before` updates, for the prompt `p`. */
async function updateOf(page: Page, p: Ev, before: number, what: string): Promise<Rec> {
  await expect.poll(async () => (await of(page, 'ev.promptUpdate')).slice(before).filter((u) => u.token === p.token).length, { timeout: 10_000, message: what }).toBeGreaterThan(0);
  return (await of(page, 'ev.promptUpdate')).slice(before).filter((u) => u.token === p.token).at(-1)!.record ?? {};
}

/** Ctrl+Z after one edit: its own ev.edited, the depth back down by one. */
async function undoStep(page: Page, edited0: number, what: string): Promise<void> {
  const depth = (await of(page, 'ev.edited')).at(-1)?.depth;
  expect(await undo(page), `${what}: Ctrl+Z`).toEqual({});
  await expect.poll(async () => (await countOf(page, 'ev.edited')) - edited0, { timeout: 10_000, message: `${what}: the undo's ev.edited` }).toBe(2);
  expect((await of(page, 'ev.edited')).at(-1)?.depth, `${what}: one step back`).toBe(Number(depth) - 1);
}
async function oneEdit(page: Page, edited0: number, what: string): Promise<void> {
  await expect.poll(async () => (await countOf(page, 'ev.edited')) - edited0, { timeout: 10_000, message: `${what}: one ev.edited` }).toBe(1);
  await page.waitForTimeout(300);
  expect((await countOf(page, 'ev.edited')) - edited0, `${what}: one undo step`).toBe(1);
}
const near = (a: unknown, b: number, tol = 0.01): boolean => typeof a === 'number' && Math.abs(a - b) <= tol;

test.describe('engine run 14 and later: the ops feature detected', () => {
  test('island.json lists both ops', async ({ page }) => {
    const res = await page.goto(`${ISLAND}/island.json`);
    const island = (await res!.json()) as { ops?: string[] };
    for (const op of OPS) expect(island.ops ?? []).toContain(op);
  });

  for (const frame of ['pcb', 'sch'] as const) {
    test(`a ${frame} frame: selectFilter is listed exactly with the exports; without them both ops answer unsupported naming kicadSelectionFilterGet; args of another shape refused`, async ({ page }) => {
      const caps = await open(page, frame);
      const has = await islandFrame(page)!.evaluate(() => {
        const m = (window as unknown as { Module?: Record<string, unknown> }).Module ?? {};
        return typeof m.kicadSelectionFilterGet === 'function' && typeof m.kicadSelectionFilterSet === 'function';
      });
      expect(caps.includes('selectFilter'), 'the cap follows the exports').toBe(has);
      if (!has) {
        expect(await request(page, 'selectFilter.get')).toEqual(UNSUPPORTED);
        expect(await request(page, 'selectFilter.set', { filter: { lockedItems: false } })).toEqual(UNSUPPORTED);
      }
      expect(await request(page, 'selectFilter.get', { frame })).toEqual({ error: { code: 'bad_args', message: 'selectFilter.get' } });
      expect(await request(page, 'selectFilter.set', { filter: {} })).toEqual({ error: { code: 'bad_args', message: 'selectFilter.set' } });
      expect(await request(page, 'selectFilter.set', { filter: { [frame === 'pcb' ? 'wires' : 'tracks']: false } }))
        .toEqual({ error: { code: 'bad_args', message: 'selectFilter.set' } });
      await noWindow(page, 'the selection filter ops');
    });
  }
});

test.describe('engine run 15: the placement asks and the selection filter, no window', () => {
  test.describe.configure({ timeout: 600_000 });

  test('selectFilter in a pcb frame: twelve switches, tracks set off reads back off, set back on', async ({ page }) => {
    await open15(page, ['selectFilter']);
    const r = await request(page, 'selectFilter.get');
    expect(r.frame).toBe('pcb');
    expect(Object.keys(r.filter as Rec)).toEqual(BOARD_KEYS);
    const t0 = performance.now();
    const off = await request(page, 'selectFilter.set', { filter: { tracks: false } });
    measure('selectFilter.set', `${Math.round(performance.now() - t0)} ms over the bridge`);
    expect(off).toEqual({ frame: 'pcb', filter: { ...(r.filter as Rec), tracks: false } });
    expect(await request(page, 'selectFilter.get')).toEqual({ frame: 'pcb', filter: { ...(r.filter as Rec), tracks: false } });
    expect(await request(page, 'selectFilter.set', { filter: { tracks: true } })).toEqual({ frame: 'pcb', filter: r.filter });
    await noWindow(page, 'selectFilter in a pcb frame');
  });

  test('selectFilter in a sch frame: ten switches, wires set off reads back off', async ({ page }) => {
    await open15(page, ['selectFilter'], 'sch');
    const r = await request(page, 'selectFilter.get');
    expect(r.frame).toBe('sch');
    expect(Object.keys(r.filter as Rec)).toEqual(SCH_KEYS);
    expect(await request(page, 'selectFilter.set', { filter: { wires: false } })).toEqual({ frame: 'sch', filter: { ...(r.filter as Rec), wires: false } });
    expect(await request(page, 'selectFilter.set', { filter: { wires: true } })).toEqual({ frame: 'sch', filter: r.filter });
    await noWindow(page, 'selectFilter in a sch frame');
  });

  test('Move Exactly with R1 selected asks moveExact; x 2 moves R1 2 mm right in one undo step', async ({ page }) => {
    await open15(page, ['prompts']);
    const before = await item(page, ID.R1);
    await select(page, [ID.R1]);
    const edited0 = await countOf(page, 'ev.edited');
    const p = await ask(page, 'pcbnew.InteractiveEdit.moveExact', 'moveExact', true);
    expect(p.record).toMatchObject({ anchor: expect.any(String), anchors: expect.arrayContaining(['item', 'drillOrigin']) });
    // An anchor the window does not offer is refused with its field; the prompt stays.
    const refused = await answer(page, p, { anchor: 'gridOrigin' });
    expect(refused).toMatchObject({ accepted: false, field: 'anchor' });
    expect(await answer(page, p, { x: 2, y: 0, rotation: 0 })).toEqual({ accepted: true });
    await oneEdit(page, edited0, 'moveExact');
    const after = await item(page, ID.R1);
    expect(near(after.x, Number(before.x) + 2), `R1 x ${String(after.x)} after ${String(before.x)}`).toBe(true);
    expect(near(after.y, Number(before.y))).toBe(true);
    await noWindow(page, 'moveExact');
    await undoStep(page, edited0, 'moveExact');
    expect(await item(page, ID.R1)).toEqual(before);
  });

  test('Interactive Offset: two clicks, then the offset ask; its answer moves the selection once', async ({ page }) => {
    await open15(page, ['prompts']);
    const before = await item(page, ID.R1);
    await select(page, [ID.R1]);
    const edited0 = await countOf(page, 'ev.edited');
    const prompts0 = await countOf(page, 'ev.prompt');
    expect(await request(page, 'action.run', { name: 'pcbnew.PositionRelative.interactiveOffsetTool' })).toEqual({});
    const c = await canvasCenter(page);
    await page.mouse.click(c.x, c.y);
    await page.waitForTimeout(300);
    await page.mouse.click(c.x + 60, c.y);
    await expect.poll(async () => (await countOf(page, 'ev.prompt')) - prompts0, { timeout: 10_000, message: 'the offset prompt' }).toBe(1);
    const p = (await of(page, 'ev.prompt')).at(-1)!;
    expect(p.ask).toBe('offset');
    expect(p.modal).toBe(true);
    measure('offset', `the measured vector ${JSON.stringify(p.record)}`);
    expect(await answer(page, p, { x: 1.5, y: 1 })).toEqual({ accepted: true });
    await oneEdit(page, edited0, 'offset');
    const after = await item(page, ID.R1);
    expect(near(after.x, Number(before.x) + 1.5) && near(after.y, Number(before.y) + 1), `R1 at ${String(after.x)}, ${String(after.y)}`).toBe(true);
    await noWindow(page, 'offset');
    await undoStep(page, edited0, 'offset');
    expect(await item(page, ID.R1)).toEqual(before);
  });

  test('Create Array asks array (modeless); a picked center arrives as ev.promptUpdate; a circle of 6 makes 5 more footprints in one undo step', async ({ page }) => {
    await open15(page, ['prompts']);
    const u1 = await item(page, ID.U1);
    // The view centered on U1, then R1 selected without moving the view: the canvas center is U1.
    await select(page, [ID.U1]);
    await select(page, [ID.R1], false);
    const text0 = await savedText(page);
    const edited0 = await countOf(page, 'ev.edited');
    const p = await ask(page, 'pcbnew.Array.createArray', 'array', false);
    expect(p.record).toMatchObject({ padNumbering: false, grid: expect.any(Object), circular: expect.any(Object) });
    const updates0 = await countOf(page, 'ev.promptUpdate');
    expect(await request(page, 'prompt.pick', { token: p.token, kind: 'point' })).toEqual({});
    await page.waitForTimeout(400);
    const c = await canvasCenter(page);
    await page.mouse.click(c.x, c.y);
    const rec = await updateOf(page, p, updates0, 'the picked center');
    const circ = rec.circular as Rec;
    measure('array center', `picked ${String(circ.centreX)}, ${String(circ.centreY)}; U1 at ${String(u1.x)}, ${String(u1.y)}`);
    expect(near(circ.centreX, Number(u1.x), 5) && near(circ.centreY, Number(u1.y), 5), 'the center picked on U1').toBe(true);
    expect(await answer(page, p, { shape: 'circular', arrangeSelection: false, circular: { count: 6, angle: 60 } })).toEqual({ accepted: true });
    await oneEdit(page, edited0, 'array');
    // KiCad counts the original as the circle's first point.
    expect(footprints(await savedText(page)) - footprints(text0), 'five more footprints').toBe(5);
    // Accepted: the prompt ended with its answer.
    expect(await answer(page, p, {})).toEqual({ error: { code: 'stale', message: 'prompt.answer' } });
    await noWindow(page, 'array');
    await undoStep(page, edited0, 'array');
    expect(footprints(await savedText(page))).toBe(footprints(text0));
  });

  test('Position Relative asks positionRelative (modeless); Pick an item on U1, then x 5 puts R1 5 mm right of U1 and ends the prompt', async ({ page }) => {
    await open15(page, ['prompts']);
    const u1 = await item(page, ID.U1);
    const before = await item(page, ID.R1);
    await select(page, [ID.U1]);
    await select(page, [ID.R1], false);
    const edited0 = await countOf(page, 'ev.edited');
    const p = await ask(page, 'pcbnew.PositionRelative.positionRelative', 'positionRelative', false);
    const updates0 = await countOf(page, 'ev.promptUpdate');
    expect(await request(page, 'prompt.pick', { token: p.token, kind: 'item' })).toEqual({});
    await page.waitForTimeout(400);
    const c = await canvasCenter(page);
    await page.mouse.click(c.x, c.y);
    const rec = await updateOf(page, p, updates0, 'the picked item');
    const anchor = rec.anchor as Rec;
    measure('positionRelative anchor', JSON.stringify(anchor));
    expect(anchor.kind).toBe('item');
    expect(near(anchor.x, Number(u1.x)) && near(anchor.y, Number(u1.y)), 'the anchor is U1').toBe(true);
    expect(await answer(page, p, { x: 5, y: 0 })).toEqual({ accepted: true });
    await oneEdit(page, edited0, 'positionRelative');
    const after = await item(page, ID.R1);
    expect(near(after.x, Number(u1.x) + 5) && near(after.y, Number(u1.y)), `R1 at ${String(after.x)}, ${String(after.y)}`).toBe(true);
    // KiCad 10's OK hides its window: the prompt ended.
    expect(await answer(page, p, { x: 5 })).toEqual({ error: { code: 'stale', message: 'prompt.answer' } });
    await noWindow(page, 'positionRelative');
    await undoStep(page, edited0, 'positionRelative');
    expect(await item(page, ID.R1)).toEqual(before);
  });

  test('Filter Selected Items asks filterSelection; a non boolean is refused, tracks off leaves the track out of the selection', async ({ page }) => {
    await open15(page, ['prompts']);
    await select(page, [ID.R1, ID.U1, ID.TRACK_A]);
    const sel0 = await countOf(page, 'ev.selected');
    const p = await ask(page, 'pcbnew.InteractiveSelection.FilterSelection', 'filterSelection', true);
    expect(Object.keys(p.record ?? {}).sort()).toEqual([
      'includeBoardOutlineLayer', 'includeFootprints', 'includeItemsOnTechLayers', 'includeLockedFootprints', 'includePcbTexts', 'includeTracks', 'includeVias', 'includeZones',
    ]);
    expect(await answer(page, p, { includeTracks: 1 })).toMatchObject({ accepted: false, field: 'includeTracks' });
    expect(await answer(page, p, { includeTracks: false })).toEqual({ accepted: true });
    await expect.poll(async () => (await countOf(page, 'ev.selected')) - sel0, { timeout: 10_000, message: 'the filtered selection' }).toBeGreaterThan(0);
    const uuids = (await of(page, 'ev.selected')).at(-1)?.uuids ?? [];
    expect(uuids).toContain(ID.R1);
    expect(uuids).toContain(ID.U1);
    expect(uuids).not.toContain(ID.TRACK_A);
    await noWindow(page, 'filterSelection');
  });

  test('Get and Move Footprint asks findFootprint; an unknown reference is refused, u1 hangs U1 on the pointer and a click places it in one undo step', async ({ page }) => {
    await open15(page, ['prompts']);
    const before = await item(page, ID.U1);
    await select(page, []);
    const edited0 = await countOf(page, 'ev.edited');
    const p = await ask(page, 'pcbnew.InteractiveEdit.FindMove', 'findFootprint', true);
    expect((p.record?.references as string[] | undefined) ?? []).toEqual(expect.arrayContaining(['R1', 'R2', 'U1']));
    expect(await answer(page, p, { reference: 'Q9' })).toMatchObject({ accepted: false, field: 'reference' });
    expect(await answer(page, p, { reference: 'u1' })).toEqual({ accepted: true });
    const c = await canvasCenter(page);
    await page.mouse.move(c.x + 50, c.y + 40, { steps: 6 });
    await page.waitForTimeout(300);
    await page.mouse.click(c.x + 50, c.y + 40);
    await oneEdit(page, edited0, 'findFootprint');
    const after = await item(page, ID.U1);
    expect([after.x, after.y]).not.toEqual([before.x, before.y]);
    await noWindow(page, 'findFootprint');
    await undoStep(page, edited0, 'findFootprint');
    expect(await item(page, ID.U1)).toEqual(before);
  });
});
