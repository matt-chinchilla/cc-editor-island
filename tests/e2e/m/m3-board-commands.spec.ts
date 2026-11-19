// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// m3-i: every board canvas command of the canvas addendum's section 6 driven
// once on the canvas-kinds fixture (unit m1-fx) with no KiCad window, and the
// unit's own ops, board.vertices.get and board.vertices.set. Each command runs
// through m1-i's doors, our context menu (ev.contextMenu, contextMenu.choose)
// where KiCad's own menu shows it, and action.run for our groups and the
// pencil rows; each window of KiCad's it would open is an ev.prompt answered
// with prompt.answer (convert, outset, zoneSettings: this unit's asks; entry,
// layer, message: m1x-i's; moveExact, findFootprint and the others: m6-i's).
// Each edit is one ev.edited and one undo step (KiCad's Ctrl+Z brings the
// item back), its change read back (board.item.get, board.vertices.get or the
// item's own block in the saved board), and no window of KiCad's shows: no
// dialog in the frame, no popup of KiCad's, ev.menu never open.
//
// On engine run 14 only the first test runs: the cap vertices is absent and
// both ops answer unsupported naming kicadBoardVerticesGet, and KiCad's own R
// and Ctrl+Z turn R1 and turn it back, read as the walk reads. Every other
// test waits for engine run 15 (K-MENU, K-PROMPT, units m3-e1, m3-e2, m3-e3)
// and is skipped here naming it.
import { expect, test, type Frame, type Page } from '@playwright/test';

import { ISLAND } from '../ports';

interface Item { id: number; type: string; action: string; label: string; enabled: boolean; checked: boolean; key: string; door: string; items?: Item[] }
interface Ev {
  type: string; at: number; open?: boolean; caps?: string[]; token?: number; frame?: string; items?: Item[]; omitted?: string[];
  depth?: number; action?: string; ask?: string; modal?: boolean; record?: Record<string, unknown>; reason?: string;
}
interface Harness { __events: Ev[]; __saved: Record<string, Uint8Array>; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
type Answer = { ok?: boolean; error?: { code: string; message: string } } & Record<string, unknown>;
type Record_ = Record<string, unknown>;
type Via = 'menu' | 'run' | 'either';

const FIXTURE = 'canvas-kinds';
const PCB = 'canvas-kinds.kicad_pcb';
const RUN15 = 'waits for engine run 15: our context menu, the prompts and the board corners (kicadHostContextMenu, kicadRunAction, kicadHostPrompts, kicadBoardVerticesGet; units m1-e, m1x-e1, m3-e1, m3-e2, m3-e3)';

/** The fixture's board items by name (tests/fixtures/canvas-kinds/ids.json). */
const ID = {
  R1: 'cc0ca4d5-0000-4000-8000-000000000301',
  U1: 'cc0ca4d5-0000-4000-8000-000000000302',
  R2: 'cc0ca4d5-0000-4000-8000-000000000303',
  TRACK_A: 'cc0ca4d5-0000-4000-8000-000000000310',
  TRACK_B: 'cc0ca4d5-0000-4000-8000-000000000311',
  TRACK_LOCKED: 'cc0ca4d5-0000-4000-8000-000000000312',
  ARC: 'cc0ca4d5-0000-4000-8000-000000000313',
  VIA: 'cc0ca4d5-0000-4000-8000-000000000314',
  CU_ZONE: 'cc0ca4d5-0000-4000-8000-000000000320',
  SILK_ZONE: 'cc0ca4d5-0000-4000-8000-000000000321',
  RULE_AREA: 'cc0ca4d5-0000-4000-8000-000000000322',
  POLY1: 'cc0ca4d5-0000-4000-8000-000000000330',
  POLY2: 'cc0ca4d5-0000-4000-8000-000000000331',
  CORNER_A: 'cc0ca4d5-0000-4000-8000-000000000332',
  CORNER_B: 'cc0ca4d5-0000-4000-8000-000000000333',
  OPEN_A: 'cc0ca4d5-0000-4000-8000-000000000334',
  OPEN_B: 'cc0ca4d5-0000-4000-8000-000000000335',
  OUTLINE: 'cc0ca4d5-0000-4000-8000-000000000336',
  DIMENSION: 'cc0ca4d5-0000-4000-8000-000000000338',
  TEXT: 'cc0ca4d5-0000-4000-8000-000000000339',
  TEXT_BOX: 'cc0ca4d5-0000-4000-8000-00000000033a',
} as const;

/** The footprint editor's polygon (written into the SOIC by the fpedit test) and its corners, in mm. */
const FP_POLY = 'f9ed1700-0000-4000-8000-0000000010f0';
const FP_POLY_CORNERS = [{ x: 5, y: 5 }, { x: 7, y: 5 }, { x: 7, y: 7 }, { x: 5, y: 7 }];

/** Top level items in the saved board, as KiCad writes them (one tab, then the token). */
const TOP = {
  line: /^\t\(gr_line$/gm,
  poly: /^\t\(gr_poly$/gm,
  arc: /^\t\(gr_arc$/gm,
  zone: /^\t\(zone$/gm,
  segment: /^\t\(segment$/gm,
  arcTrack: /^\t\(arc$/gm,
  via: /^\t\(via$/gm,
  footprint: /^\t\(footprint /gm,
  edgeCuts: /\(layer "Edge\.Cuts"\)/g,
};

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
/** Every item of a menu, submenus walked. */
const flat = (items: readonly Item[]): Item[] => items.flatMap((i) => [i, ...flat(i.items ?? [])]);
const matches = (text: string, re: RegExp): number => (text.match(re) ?? []).length;
const escape = (page: Page): Promise<Answer> => request(page, 'key.press', { key: 'Escape', code: 'Escape' });
const undo = (page: Page): Promise<Answer> => request(page, 'key.press', { key: 'z', code: 'KeyZ', ctrl: true });

function measure(type: string, description: string): void {
  test.info().annotations.push({ type, description });
  console.log(`[measure] ${type}: ${description}`);
}

async function open(page: Page): Promise<string[]> {
  await page.goto(`/parent.html?frame=pcb&fixture=${FIXTURE}`);
  await page.waitForFunction(() => /opened |open failed|state (blocked|fatal)/.test(document.getElementById('state')?.textContent ?? ''), null, { timeout: 170_000 });
  expect(await page.textContent('#state')).toContain(`opened ${PCB}`);
  await page.waitForTimeout(1_500);
  return (await of(page, 'ev.ready'))[0]?.caps ?? [];
}

/** Opens the fixture and skips the test on an engine before run 15. */
async function open15(page: Page, need: readonly string[] = ['contextMenu', 'prompts']): Promise<string[]> {
  const caps = await open(page);
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

async function select(page: Page, uuids: readonly string[]): Promise<void> {
  expect(await request(page, 'select', { uuids, zoom: uuids.length > 0 })).toEqual({});
  await page.waitForTimeout(600);
}

/** A right click at the canvas center (inside the zoomed selection's box, so KiCad keeps it): our menu. */
async function rightClick(page: Page, at?: { x: number; y: number }): Promise<Ev> {
  const before = await countOf(page, 'ev.contextMenu');
  const p = at ?? await canvasCenter(page);
  await page.mouse.click(p.x, p.y, { button: 'right' });
  await expect.poll(async () => (await countOf(page, 'ev.contextMenu')) - before, { timeout: 10_000 }).toBe(1);
  return (await of(page, 'ev.contextMenu')).at(-1)!;
}

/** The item of `action` in our menu, chosen. */
async function chooseFrom(page: Page, menu: Ev, action: string): Promise<Item> {
  const item = flat(menu.items ?? []).find((i) => i.action === action);
  expect(item, `${action} in our menu (omitted: ${(menu.omitted ?? []).join(', ')})`).toBeDefined();
  expect(item!.enabled, `${action} enabled`).toBe(true);
  expect(await request(page, 'contextMenu.choose', { token: menu.token, id: item!.id })).toEqual({});
  return item!;
}

/**
 * Presses `action` on `uuids`. `menu`: through our menu, which must show it;
 * `run`: through action.run (our groups, the pencil rows, the keys);
 * `either`: our menu when it shows the item, else the menu closed with -1 and
 * action.run.
 */
async function press(page: Page, action: string, uuids: readonly string[] | null, via: Via): Promise<'menu' | 'run'> {
  if (uuids != null) await select(page, uuids);
  if (via !== 'run') {
    const menu = await rightClick(page);
    const item = flat(menu.items ?? []).find((i) => i.action === action && i.enabled);
    if (item != null || via === 'menu') {
      await chooseFrom(page, menu, action);
      return 'menu';
    }
    expect(await request(page, 'contextMenu.choose', { token: menu.token, id: -1 })).toEqual({});
    await page.waitForTimeout(300);
  }
  expect(await request(page, 'action.run', { name: action }), action).toEqual({});
  return 'run';
}

/** The board as KiCad saves it now (project.save, the bytes ev.saved brought). */
async function savedText(page: Page): Promise<string> {
  const r = await request(page, 'project.save');
  expect(r.error, 'project.save').toBeUndefined();
  return page.evaluate((p) => new TextDecoder().decode((window as unknown as Harness).__saved[p]), PCB);
}

/** The top level item of the saved board holding `uuid`, as its text; null when gone. */
function block(text: string, uuid: string): string | null {
  const lines = text.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\t\(/.test(lines[i])) start = i;
    if (start >= 0 && lines[i].includes(`(uuid "${uuid}")`)) {
      let end = i;
      while (end < lines.length && lines[end] !== '\t)') end++;
      return lines.slice(start, end + 1).join('\n');
    }
  }
  return null;
}
async function snap(page: Page, uuids: readonly string[]): Promise<Array<string | null>> {
  if (uuids.length === 0) return [];
  const text = await savedText(page);
  return uuids.map((u) => block(text, u));
}

/**
 * Ctrl+Z after one edit, then its own ev.edited (the depth back down by one).
 * The frame reads the undo depth only while no request is in flight, so the
 * wait reads the page's event list alone.
 */
async function undoStep(page: Page, edited0: number, what: string): Promise<void> {
  const depth = (await of(page, 'ev.edited')).at(-1)?.depth;
  expect(await undo(page), `${what}: Ctrl+Z`).toEqual({});
  await expect.poll(async () => (await countOf(page, 'ev.edited')) - edited0, { timeout: 10_000, message: `${what}: the undo's ev.edited` }).toBe(2);
  expect((await of(page, 'ev.edited')).at(-1)?.depth, `${what}: one step back`).toBe(Number(depth) - 1);
}

/** Moves the pointer off the canvas center by (dx, dy) and presses there: a running move or placement commits. */
async function commitAt(page: Page, dx: number, dy: number): Promise<void> {
  const c = await canvasCenter(page);
  await page.mouse.move(c.x + dx, c.y + dy, { steps: 6 });
  await page.waitForTimeout(200);
  await page.mouse.click(c.x + dx, c.y + dy);
}

/** The next ev.prompt after `before` prompts, of `ask`. */
async function promptOf(page: Page, before: number, ask: string): Promise<Ev> {
  await expect.poll(async () => (await countOf(page, 'ev.prompt')) - before, { timeout: 10_000, message: `the ${ask} prompt` }).toBeGreaterThan(0);
  const p = (await of(page, 'ev.prompt')).slice(before)[0];
  expect(p.ask, `the prompt asked`).toBe(ask);
  expect(p.frame).toBe('pcb');
  return p;
}
const answer = (page: Page, p: Ev, a: Record_ = {}): Promise<Answer> => request(page, 'prompt.answer', { token: p.token, ...a });

/** Every prompt that comes within a moment answered with `a` (the defaults for {}); how many came. */
async function answerAll(page: Page, before: number, a: Record_ = {}): Promise<string[]> {
  await page.waitForTimeout(800);
  const asked: string[] = [];
  for (let seen = before; ; ) {
    const ps = (await of(page, 'ev.prompt')).slice(seen);
    if (ps.length === 0) break;
    for (const p of ps) {
      asked.push(p.ask ?? '');
      if (p.modal === false) expect(await request(page, 'prompt.cancel', { token: p.token })).toEqual({});
      else expect(await answer(page, p, a), `${p.ask} answered`).toEqual({ accepted: true });
    }
    seen += ps.length;
    await page.waitForTimeout(800);
  }
  return asked;
}

interface EditRow {
  action: string;
  on: readonly string[];
  via: Via;
  /** The items read before and after (their blocks in the saved board): they change and come back on undo. */
  watch?: readonly string[];
  /** A count in the saved board and the change the edit makes to it ('more': at least one more, 'less': at least one fewer). */
  count?: { re: RegExp; delta: number | 'more' | 'less' };
  /** The prompts the press opens, in order, and each answer; anything left asked is answered with its defaults. */
  asks?: ReadonlyArray<{ ask: string; answer: Record_; check?: (record: Record_) => void }>;
  /** After the press: what commits an interactive command. */
  then?: (page: Page) => Promise<void>;
  /** May end with no edit (KiCad makes none when there is nothing to change). */
  may?: boolean;
}

/** One edit row: the asks answered, one ev.edited, the read back, no window, one undo step back. */
async function editRow(page: Page, row: EditRow): Promise<void> {
  const watch = row.watch ?? [];
  const before = await snap(page, watch);
  const text0 = row.count != null ? await savedText(page) : '';
  const edited0 = await countOf(page, 'ev.edited');
  const prompts0 = await countOf(page, 'ev.prompt');
  const via = await press(page, row.action, row.on, row.via);
  let seen = prompts0;
  for (const a of row.asks ?? []) {
    const p = await promptOf(page, seen, a.ask);
    a.check?.(p.record ?? {});
    expect(await answer(page, p, a.answer), `${row.action}: ${a.ask}`).toEqual({ accepted: true });
    seen += 1;
    await page.waitForTimeout(300);
  }
  const extra = await answerAll(page, seen);
  if (row.then != null) await row.then(page);
  if (row.may === true) {
    await page.waitForTimeout(1_500);
    const n = (await countOf(page, 'ev.edited')) - edited0;
    measure(row.action, `${via}, ${n === 0 ? 'no edit' : 'one edit'}${extra.length > 0 ? `, asked ${extra.join(' ')}` : ''}`);
    await noWindow(page, row.action);
    if (n === 0) return;
    expect(n, row.action).toBe(1);
  } else {
    await expect.poll(async () => (await countOf(page, 'ev.edited')) - edited0, { timeout: 10_000, message: `${row.action}: one ev.edited` }).toBe(1);
    measure(row.action, `${via}${extra.length > 0 ? `, asked ${extra.join(' ')}` : ''}`);
  }
  await page.waitForTimeout(300);
  expect((await countOf(page, 'ev.edited')) - edited0, `${row.action}: one undo step`).toBe(1);
  await noWindow(page, row.action);
  const after = await snap(page, watch);
  if (watch.length > 0 && row.may !== true) expect(after, `${row.action} changed what it acts on`).not.toEqual(before);
  if (row.count != null) {
    const d = matches(await savedText(page), row.count.re) - matches(text0, row.count.re);
    if (row.count.delta === 'more') expect(d, row.action).toBeGreaterThan(0);
    else if (row.count.delta === 'less') expect(d, row.action).toBeLessThan(0);
    else expect(d, row.action).toBe(row.count.delta);
  }
  await undoStep(page, edited0, row.action);
  expect(await snap(page, watch), `${row.action}: undone`).toEqual(before);
  if (row.count != null) expect(matches(await savedText(page), row.count.re), `${row.action}: undone`).toBe(matches(text0, row.count.re));
  await noWindow(page, `${row.action}, undone`);
}

/** A command that edits nothing (a selection, a mode, a ratsnest view): no ev.edited, no window. */
async function stateRow(page: Page, action: string, on: readonly string[] | null, via: Via): Promise<void> {
  const edited0 = await countOf(page, 'ev.edited');
  const prompts0 = await countOf(page, 'ev.prompt');
  const how = await press(page, action, on, via);
  const asked = await answerAll(page, prompts0);
  await page.waitForTimeout(700);
  measure(action, `${how}${asked.length > 0 ? `, asked ${asked.join(' ')}` : ''}`);
  expect((await countOf(page, 'ev.edited')) - edited0, `${action} edits nothing`).toBe(0);
  await noWindow(page, action);
  await escape(page);
}

/**
 * A command of a running tool: the tool started by `start` (and pressed in the
 * drawing at `clicks`), the command run by name while it runs, then the tool
 * left with Escape and whatever it committed undone. No window throughout.
 */
async function insideTool(page: Page, start: string, clicks: ReadonlyArray<[number, number]>, actions: readonly string[], on: readonly string[] | null = null): Promise<void> {
  if (on != null) await select(page, on);
  const edited0 = await countOf(page, 'ev.edited');
  expect(await request(page, 'action.run', { name: start }), start).toEqual({});
  const c = await canvasCenter(page);
  for (const [dx, dy] of clicks) {
    await page.mouse.move(c.x + dx, c.y + dy, { steps: 4 });
    await page.mouse.click(c.x + dx, c.y + dy);
    await page.waitForTimeout(250);
  }
  for (const name of actions) {
    const prompts0 = await countOf(page, 'ev.prompt');
    const r = await request(page, 'action.run', { name });
    expect(r.error?.code ?? 'ran', `${name} while ${start} runs`).not.toMatch(/^(held|bad_args|island_error)$/);
    // An ask a running command opens (a via's layer) is canceled: the tool goes on.
    for (const p of (await of(page, 'ev.prompt')).slice(prompts0)) await request(page, 'prompt.cancel', { token: p.token });
    measure(name, `inside ${start}: ${r.error == null ? 'ran' : r.error.code}`);
    await page.mouse.move(c.x + 40, c.y + 30, { steps: 3 });
    await page.waitForTimeout(250);
    await noWindow(page, name);
  }
  for (let i = 0; i < 3; i++) { await escape(page); await page.waitForTimeout(200); }
  // Whatever the tool committed is taken back, one step at a time.
  const made = (await countOf(page, 'ev.edited')) - edited0;
  for (let i = 0; i < made; i++) { await undo(page); await page.waitForTimeout(400); }
  await noWindow(page, `${start}, left`);
}

const corners = async (page: Page, uuid: string): Promise<Record_> => {
  const r = await request(page, 'board.vertices.get', { uuid });
  expect(r.error, `board.vertices.get ${uuid}`).toBeUndefined();
  return r;
};

test.describe('engine run 14 and later: the ops feature detected, KiCad\'s own keys read as the walk reads', () => {
  test('vertices is not listed and both ops answer unsupported naming kicadBoardVerticesGet; R turns R1 and Ctrl+Z turns it back; no window', async ({ page }) => {
    const caps = await open(page);
    if (!caps.includes('vertices')) {
      expect(await request(page, 'board.vertices.get', { uuid: ID.SILK_ZONE })).toEqual({ error: { code: 'unsupported', message: 'kicadBoardVerticesGet' } });
      expect(await request(page, 'board.vertices.set', { uuid: ID.SILK_ZONE, outline: 0, hole: -1, index: 0, x: 120, y: 115 }))
        .toEqual({ error: { code: 'unsupported', message: 'kicadBoardVerticesGet' } });
    }
    // Args of another shape are refused before the engine on any engine.
    expect(await request(page, 'board.vertices.get', { uuid: 'nope' })).toEqual({ error: { code: 'bad_args', message: 'board.vertices.get' } });
    expect(await request(page, 'board.vertices.set', { uuid: ID.SILK_ZONE })).toEqual({ error: { code: 'bad_args', message: 'board.vertices.set' } });
    const r0 = await request(page, 'board.item.get', { uuids: [ID.R1] });
    const before = (r0.items as Record_[])[0];
    expect(before).toMatchObject({ kind: 'footprint', ref: 'R1' });
    await select(page, [ID.R1]);
    const edited0 = await countOf(page, 'ev.edited');
    expect(await request(page, 'key.press', { key: 'r', code: 'KeyR' })).toEqual({});
    await expect.poll(async () => (await countOf(page, 'ev.edited')) - edited0, { timeout: 10_000 }).toBe(1);
    const after = ((await request(page, 'board.item.get', { uuids: [ID.R1] })).items as Record_[])[0];
    expect(after.rotation).not.toEqual(before.rotation);
    await noWindow(page, 'R');
    await undoStep(page, edited0, 'R');
    expect(((await request(page, 'board.item.get', { uuids: [ID.R1] })).items as Record_[])[0]).toEqual(before);
    await noWindow(page, 'R, undone');
  });
});

test.describe('engine run 15: every board canvas command once, no window', () => {
  test.describe.configure({ timeout: 900_000 });

  test('Corners: board.vertices.get reads each kind, board.vertices.set moves one corner in one undo step, Edit Corners is held', async ({ page }) => {
    await open15(page, ['contextMenu', 'prompts', 'vertices']);
    const silk = await corners(page, ID.SILK_ZONE);
    expect(silk).toEqual({
      uuid: ID.SILK_ZONE, kind: 'nonCopper',
      outlines: [{ outline: 0, hole: -1, points: [{ x: 120, y: 115 }, { x: 130, y: 115 }, { x: 130, y: 125 }, { x: 120, y: 125 }] }],
    });
    expect((await corners(page, ID.CU_ZONE)).kind).toBe('copper');
    expect((await corners(page, ID.RULE_AREA)).kind).toBe('ruleArea');
    expect((await corners(page, ID.POLY1)).kind).toBe('polygon');
    expect(await request(page, 'board.vertices.get', { uuid: ID.TRACK_A })).toEqual({ error: { code: 'not_found', message: ID.TRACK_A } });
    // One corner moved: one ev.edited, the read back, one Ctrl+Z.
    const edited0 = await countOf(page, 'ev.edited');
    const moved = await request(page, 'board.vertices.set', { uuid: ID.SILK_ZONE, outline: 0, hole: -1, index: 2, x: 131, y: 126 });
    expect(moved.error).toBeUndefined();
    expect((moved.outlines as Array<{ points: unknown[] }>)[0].points[2]).toEqual({ x: 131, y: 126 });
    await expect.poll(async () => (await countOf(page, 'ev.edited')) - edited0, { timeout: 10_000 }).toBe(1);
    expect(await corners(page, ID.SILK_ZONE)).toEqual(moved);
    await noWindow(page, 'board.vertices.set');
    await undoStep(page, edited0, 'board.vertices.set');
    expect(await corners(page, ID.SILK_ZONE)).toEqual(silk);
    // A corner the item lacks is named and nothing is sent; a corner moved onto itself makes no step.
    expect(await request(page, 'board.vertices.set', { uuid: ID.SILK_ZONE, outline: 0, hole: -1, index: 9, x: 1, y: 1 }))
      .toEqual({ error: { code: 'bad_args', message: 'board.vertices.set: the outline has no corner 9' } });
    const edited1 = await countOf(page, 'ev.edited');
    expect((await request(page, 'board.vertices.set', { uuid: ID.SILK_ZONE, outline: 0, hole: -1, index: 0, x: 120, y: 115 })).error).toBeUndefined();
    await page.waitForTimeout(1_000);
    expect((await countOf(page, 'ev.edited')) - edited1, 'a corner onto itself is no step').toBe(0);
    // Edit Corners: our menu holds it (ev.held), action.run refuses it as held; KiCad's pane never shows.
    await select(page, [ID.SILK_ZONE]);
    expect(await request(page, 'action.run', { name: 'pcbnew.InteractiveEdit.editVertices' }))
      .toEqual({ error: { code: 'held', message: 'pcbnew.InteractiveEdit.editVertices' } });
    const held0 = await countOf(page, 'ev.held');
    const menu = await rightClick(page);
    const item = await chooseFrom(page, menu, 'pcbnew.InteractiveEdit.editVertices');
    expect(item.door).toBe('held');
    await expect.poll(async () => (await of(page, 'ev.held')).slice(held0).map((e) => e.action), { timeout: 10_000 }).toEqual(['pcbnew.InteractiveEdit.editVertices']);
    await noWindow(page, 'editVertices');
  });

  test('Convert: polygon, lines, zone, rule area, tracks and arc from a selection, each window an ask', async ({ page }) => {
    await open15(page);
    await editRow(page, {
      action: 'pcbnew.Convert.convertToPoly', on: [ID.CORNER_A, ID.CORNER_B], via: 'menu', count: { re: TOP.poly, delta: 1 },
      asks: [{
        ask: 'convert', answer: { strategy: 'centerline', deleteOriginals: false },
        check: (r) => { expect(r.strategies).toContain('centerline'); expect(r.strategies).toContain('boundingHull'); },
      }],
    });
    // Create Lines from a polygon shows no strategy: one is refused, the originals deleted.
    {
      const text0 = await savedText(page);
      const edited0 = await countOf(page, 'ev.edited');
      const prompts0 = await countOf(page, 'ev.prompt');
      await press(page, 'pcbnew.Convert.convertToLines', [ID.POLY1], 'menu');
      const p = await promptOf(page, prompts0, 'convert');
      expect(p.record?.strategies).toEqual([]);
      expect(await answer(page, p, { strategy: 'centerline' })).toMatchObject({ accepted: false, field: 'strategy' });
      expect(await answer(page, p, { deleteOriginals: true })).toEqual({ accepted: true });
      await expect.poll(async () => (await countOf(page, 'ev.edited')) - edited0, { timeout: 10_000 }).toBe(1);
      const text1 = await savedText(page);
      expect(matches(text1, TOP.poly)).toBe(matches(text0, TOP.poly) - 1);
      expect(matches(text1, TOP.line)).toBeGreaterThan(matches(text0, TOP.line));
      await noWindow(page, 'convertToLines');
      await undoStep(page, edited0, 'convertToLines');
      expect(await savedText(page)).toBe(text0);
    }
    await editRow(page, {
      action: 'pcbnew.Convert.convertToZone', on: [ID.OUTLINE], via: 'menu', count: { re: TOP.zone, delta: 1 },
      asks: [
        { ask: 'convert', answer: {} },
        {
          ask: 'zoneSettings', answer: { set: { net: 'Z' } },
          check: (r) => { expect(r.kind).toBe('copper'); expect((r.sheet as Record_).uuid).toBe(''); expect((r.sheet as Record_).netChoices).toContain('Z'); },
        },
      ],
    });
    await editRow(page, {
      action: 'pcbnew.Convert.convertToKeepout', on: [ID.POLY2], via: 'menu', count: { re: TOP.zone, delta: 1 },
      asks: [
        { ask: 'convert', answer: {} },
        { ask: 'zoneSettings', answer: { set: { noTracks: true } }, check: (r) => { expect(r.kind).toBe('ruleArea'); expect((r.sheet as Record_).uuid).toBe(''); } },
      ],
    });
    // From a non copper layer the tracks ask their layer.
    await editRow(page, {
      action: 'pcbnew.Convert.convertToTracks', on: [ID.CORNER_A, ID.CORNER_B], via: 'menu', count: { re: TOP.segment, delta: 'more' },
      asks: [{ ask: 'layer', answer: { layer: 'F.Cu' } }],
    });
    await editRow(page, { action: 'pcbnew.Convert.convertToArc', on: [ID.CORNER_A], via: 'either', may: true });
  });

  test('Outsets: the outset ask, KiCad\'s one refusal, an outset 0.5 mm outside with round corners', async ({ page }) => {
    await open15(page);
    const text0 = await savedText(page);
    const edited0 = await countOf(page, 'ev.edited');
    const prompts0 = await countOf(page, 'ev.prompt');
    await press(page, 'pcbnew.Convert.outsetItems', [ID.OUTLINE], 'menu');
    const p = await promptOf(page, prompts0, 'outset');
    const rec = p.record ?? {};
    expect(rec.layers).toContain('Edge.Cuts');
    expect(rec.layers).toContain(rec.layer);
    measure('outset record', JSON.stringify(rec));
    expect(await answer(page, p, { lineWidth: 0 })).toEqual({ accepted: false, field: 'lineWidth', message: 'Line width must be a positive value.' });
    expect(await answer(page, p, { outsetDistance: 0.5, roundCorners: true, useSourceLayers: true, lineWidth: 0.1 })).toEqual({ accepted: true });
    await expect.poll(async () => (await countOf(page, 'ev.edited')) - edited0, { timeout: 10_000 }).toBe(1);
    expect(matches(await savedText(page), TOP.edgeCuts)).toBeGreaterThan(matches(text0, TOP.edgeCuts));
    await noWindow(page, 'outsetItems');
    await undoStep(page, edited0, 'outsetItems');
    expect(await savedText(page)).toBe(text0);
  });

  test('Zones: duplicate onto a layer, merge, cut out, a similar zone, each new zone\'s settings an ask', async ({ page }) => {
    await open15(page);
    await editRow(page, {
      action: 'pcbnew.EditorControl.zoneDuplicate', on: [ID.CU_ZONE], via: 'menu', count: { re: TOP.zone, delta: 1 },
      asks: [{ ask: 'zoneSettings', answer: { set: { layers: ['B.Cu'] } }, check: (r) => expect(r.kind).toBe('copper') }],
    });
    await editRow(page, { action: 'pcbnew.EditorControl.zoneMerge', on: [ID.CU_ZONE], via: 'either', may: true });
    const inside = async (pts: ReadonlyArray<[number, number]>, page_: Page): Promise<void> => {
      const c = await canvasCenter(page_);
      for (const [dx, dy] of pts) { await page_.mouse.click(c.x + dx, c.y + dy); await page_.waitForTimeout(250); }
      await page_.mouse.dblclick(c.x + pts[0][0], c.y + pts[0][1]);
      await page_.waitForTimeout(400);
    };
    // The cutout and the similar zone are drawn inside the copper zone, zoomed to it.
    await editRow(page, {
      action: 'pcbnew.InteractiveDrawing.zoneCutout', on: [ID.CU_ZONE], via: 'either', watch: [ID.CU_ZONE], may: true,
      then: (p) => inside([[-20, -20], [20, -20], [20, 20]], p),
    });
    await escape(page);
    await editRow(page, {
      action: 'pcbnew.InteractiveDrawing.similarZone', on: [ID.CU_ZONE], via: 'either', count: { re: TOP.zone, delta: 1 }, may: true,
      then: (p) => inside([[-30, -30], [30, -30], [30, 30]], p),
    });
    await escape(page);
  });

  test('Arrange and lock: rotate, flip, mirror, lock, unlock, toggle lock, as our menu and as pencil rows', async ({ page }) => {
    await open15(page);
    for (const action of ['pcbnew.InteractiveEdit.rotateCw', 'pcbnew.InteractiveEdit.rotateCcw', 'pcbnew.InteractiveEdit.flip']) {
      await editRow(page, { action, on: [ID.R1], via: 'menu', watch: [ID.R1] });
      await editRow(page, { action, on: [ID.TEXT], via: 'run', watch: [ID.TEXT] });
    }
    for (const action of ['pcbnew.InteractiveEdit.mirrorHoriontally', 'pcbnew.InteractiveEdit.mirrorVertically']) {
      await editRow(page, { action, on: [ID.POLY1], via: 'either', watch: [ID.POLY1] });
    }
    await editRow(page, { action: 'pcbnew.EditorControl.lock', on: [ID.TEXT], via: 'run', watch: [ID.TEXT] });
    await editRow(page, { action: 'pcbnew.EditorControl.unlock', on: [ID.R2], via: 'run', watch: [ID.R2] });
    await editRow(page, { action: 'pcbnew.EditorControl.toggleLock', on: [ID.TEXT], via: 'either', watch: [ID.TEXT] });
    // The arc editing modes are the point editor's: a mode, no edit.
    for (const action of ['pcbnew.PointEditor.arcKeepCenter', 'pcbnew.PointEditor.arcKeepEndpoint', 'pcbnew.PointEditor.arcKeepRadius']) {
      await stateRow(page, action, [ID.ARC], 'run');
    }
  });

  test('Shapes: fillet, chamfer, dogbone, heal, simplify, extend, the polygon booleans, the corners', async ({ page }) => {
    await open15(page);
    const lines = [ID.CORNER_A, ID.CORNER_B];
    for (const action of ['pcbnew.InteractiveEdit.filletLines', 'pcbnew.InteractiveEdit.chamferLines', 'pcbnew.InteractiveEdit.dogboneCorners']) {
      await editRow(page, { action, on: lines, via: 'menu', watch: lines, asks: [{ ask: 'entry', answer: {} }] });
    }
    await editRow(page, { action: 'pcbnew.InteractiveEdit.healShapes', on: lines, via: 'menu', asks: [{ ask: 'entry', answer: {} }], may: true });
    await editRow(page, { action: 'pcbnew.InteractiveEdit.simplifyPolygons', on: [ID.POLY1], via: 'menu', asks: [{ ask: 'entry', answer: {} }], may: true });
    await editRow(page, { action: 'pcbnew.InteractiveEdit.extendLines', on: [ID.OPEN_A, ID.OPEN_B], via: 'menu', watch: [ID.OPEN_A, ID.OPEN_B] });
    await editRow(page, { action: 'pcbnew.InteractiveEdit.mergePolygons', on: [ID.POLY1, ID.POLY2], via: 'menu', count: { re: TOP.poly, delta: -1 } });
    await editRow(page, { action: 'pcbnew.InteractiveEdit.subtractPolygons', on: [ID.POLY1, ID.POLY2], via: 'menu', watch: [ID.POLY1] });
    await editRow(page, { action: 'pcbnew.InteractiveEdit.intersectPolygons', on: [ID.POLY1, ID.POLY2], via: 'menu', watch: [ID.POLY1] });
    for (const action of ['pcbnew.PointEditor.addCorner', 'pcbnew.PointEditor.removeCorner', 'pcbnew.PointEditor.chamferCorner']) {
      await editRow(page, { action, on: [ID.POLY1], via: 'either', watch: [ID.POLY1], may: true });
    }
    for (const action of ['pcbnew.InteractiveEdit.moveCorner', 'pcbnew.InteractiveEdit.moveMidpoint']) {
      await editRow(page, { action, on: [ID.CORNER_A], via: 'either', may: true });
    }
  });

  test('Tracks: fillet, width, layer, delete the full track, break, unroute, route, drag', async ({ page }) => {
    await open15(page);
    const tracks = [ID.TRACK_A, ID.TRACK_B];
    await editRow(page, { action: 'pcbnew.InteractiveEdit.filletTracks', on: tracks, via: 'menu', count: { re: TOP.arcTrack, delta: 'more' }, asks: [{ ask: 'entry', answer: {} }] });
    await editRow(page, { action: 'pcbnew.InteractiveEdit.changeTrackWidth', on: [ID.TRACK_A], via: 'run', watch: [ID.TRACK_A], may: true });
    await editRow(page, { action: 'pcbnew.Control.changeTrackLayerNext', on: [ID.TRACK_A], via: 'run', watch: [ID.TRACK_A], may: true });
    await editRow(page, { action: 'pcbnew.Control.changeTrackLayerPrev', on: [ID.TRACK_A], via: 'run', watch: [ID.TRACK_A], may: true });
    await editRow(page, { action: 'pcbnew.InteractiveEdit.deleteFull', on: [ID.TRACK_A], via: 'run', count: { re: TOP.segment, delta: 'less' } });
    await editRow(page, { action: 'pcbnew.InteractiveRouter.BreakTrack', on: [ID.TRACK_A], via: 'either', count: { re: TOP.segment, delta: 'more' }, may: true, then: (p) => commitAt(p, 0, 0) });
    await escape(page);
    // A locked track: KiCad's message box is the message ask.
    await editRow(page, { action: 'pcbnew.InteractiveRouter.BreakTrack', on: [ID.TRACK_LOCKED], via: 'either', may: true });
    await escape(page);
    await editRow(page, { action: 'pcbnew.InteractiveSelection.unrouteSelected', on: [ID.TRACK_A], via: 'either', may: true });
    await editRow(page, { action: 'pcbnew.InteractiveSelection.unrouteSegment', on: [ID.TRACK_A], via: 'either', may: true });
    for (const action of ['pcbnew.InteractiveRouter.RouteSelected', 'pcbnew.InteractiveRouter.RouteSelectedFromEnd', 'pcbnew.InteractiveRouter.Autoroute']) {
      await editRow(page, { action, on: [ID.R1], via: 'either', count: { re: TOP.segment, delta: 'more' }, may: true });
      for (let i = 0; i < 2; i++) await escape(page);
    }
    for (const action of ['pcbnew.InteractiveRouter.Drag45Degree', 'pcbnew.InteractiveRouter.DragFreeAngle']) {
      await editRow(page, { action, on: [ID.TRACK_B], via: 'either', watch: [ID.TRACK_B], may: true, then: (p) => commitAt(p, 30, 0) });
      await escape(page);
    }
  });

  test('Footprints: move, duplicate, swap, pack, find and move, exact moves, arrays and offsets', async ({ page }) => {
    await open15(page);
    await editRow(page, { action: 'pcbnew.InteractiveMove.move', on: [ID.R1], via: 'menu', watch: [ID.R1], then: (p) => commitAt(p, 60, 40) });
    await editRow(page, { action: 'pcbnew.InteractiveMove.moveIndividually', on: [ID.R1], via: 'either', watch: [ID.R1], then: (p) => commitAt(p, -60, 40) });
    for (const action of ['pcbnew.InteractiveMove.moveWithReference', 'pcbnew.InteractiveMove.copyWithReference']) {
      await editRow(page, { action, on: [ID.R1], via: 'either', may: true, then: async (p) => { await commitAt(p, 0, 0); await commitAt(p, 50, 50); } });
      await escape(page);
    }
    await editRow(page, { action: 'pcbnew.InteractiveEdit.moveExact', on: [ID.R1], via: 'menu', watch: [ID.R1], asks: [{ ask: 'moveExact', answer: { x: 1, y: 2 } }] });
    await editRow(page, { action: 'pcbnew.InteractiveEdit.swap', on: [ID.R1, ID.U1], via: 'menu', watch: [ID.R1, ID.U1] });
    for (const action of ['pcbnew.InteractiveEdit.swapPadNets', 'pcbnew.InteractiveEdit.swapGateNets']) {
      await editRow(page, { action, on: [ID.U1], via: 'either', may: true });
    }
    await editRow(page, { action: 'pcbnew.InteractiveEdit.packAndMoveFootprints', on: [ID.R1, ID.U1], via: 'either', watch: [ID.R1, ID.U1], then: (p) => commitAt(p, 80, 60) });
    await editRow(page, {
      action: 'pcbnew.InteractiveEdit.FindMove', on: [], via: 'run', watch: [ID.R1],
      asks: [{ ask: 'findFootprint', answer: { reference: 'R1' }, check: (r) => expect(r.references).toContain('R1') }],
      then: (p) => commitAt(p, -80, -60),
    });
    // Skip runs inside a move; the array, relative position and offset asks are modeless and canceled.
    await insideTool(page, 'pcbnew.InteractiveMove.move', [], ['pcbnew.InteractiveEdit.skip'], [ID.R1, ID.U1]);
    for (const action of ['pcbnew.Array.createArray', 'pcbnew.PositionRelative.positionRelative', 'pcbnew.PositionRelative.interactiveOffsetTool']) {
      const edited0 = await countOf(page, 'ev.edited');
      const prompts0 = await countOf(page, 'ev.prompt');
      await press(page, action, [ID.R1], 'either');
      if (action.endsWith('interactiveOffsetTool')) { await commitAt(page, 0, 0); await commitAt(page, 40, 0); }
      await expect.poll(async () => (await countOf(page, 'ev.prompt')) - prompts0, { timeout: 10_000, message: `${action}: its ask` }).toBeGreaterThan(0);
      const p = (await of(page, 'ev.prompt')).slice(prompts0)[0];
      measure(action, `ask ${p.ask}, modal ${String(p.modal)}`);
      expect(await request(page, 'prompt.cancel', { token: p.token })).toEqual({});
      for (let i = 0; i < 2; i++) await escape(page);
      await page.waitForTimeout(500);
      expect((await countOf(page, 'ev.edited')) - edited0, `${action} canceled edits nothing`).toBe(0);
      await noWindow(page, action);
    }
  });

  test('Align and distribute: the four aligns, the two centers and the four distributions', async ({ page }) => {
    await open15(page);
    const three = [ID.R1, ID.U1, ID.TEXT];
    for (const side of ['alignTop', 'alignBottom', 'alignLeft', 'alignRight', 'alignCenterY', 'alignCenterX']) {
      await editRow(page, { action: `pcbnew.AlignAndDistribute.${side}`, on: three, via: 'menu', watch: three, may: true });
    }
    for (const how of ['distributeHorizontallyCenters', 'distributeHorizontallyGaps', 'distributeVerticallyGaps', 'distributeVerticallyCenters']) {
      await editRow(page, { action: `pcbnew.AlignAndDistribute.${how}`, on: three, via: 'menu', watch: three, may: true });
    }
  });

  test('Selection and nets: connections, nets, unconnected, the same sheet, the filter, the ratsnest', async ({ page }) => {
    await open15(page);
    await stateRow(page, 'pcbnew.InteractiveSelection.SelectConnection', [ID.TRACK_A], 'either');
    await stateRow(page, 'pcbnew.InteractiveSelection.SelectNet', [ID.TRACK_A], 'either');
    await stateRow(page, 'pcbnew.InteractiveSelection.DeselectNet', [ID.TRACK_A], 'either');
    await stateRow(page, 'pcbnew.InteractiveSelection.SelectUnconnected', [ID.R1], 'either');
    await editRow(page, { action: 'pcbnew.InteractiveSelection.GrabUnconnected', on: [ID.R1], via: 'either', may: true, then: (p) => commitAt(p, 20, 20) });
    await escape(page);
    await stateRow(page, 'pcbnew.InteractiveSelection.SelectSameSheet', [ID.R1], 'either');
    // Filter Selected Items is the filterSelection ask: canceled, nothing changes.
    {
      const prompts0 = await countOf(page, 'ev.prompt');
      await press(page, 'pcbnew.InteractiveSelection.FilterSelection', [ID.R1, ID.TEXT], 'menu');
      const p = await promptOf(page, prompts0, 'filterSelection');
      expect(await request(page, 'prompt.cancel', { token: p.token })).toEqual({});
      await noWindow(page, 'FilterSelection');
    }
    await stateRow(page, 'pcbnew.EditorControl.hideNet', [ID.TRACK_A], 'either');
    await stateRow(page, 'pcbnew.EditorControl.showNet', [ID.TRACK_A], 'either');
  });

  test('Running tools: the router\'s vias, postures and corner modes, the drawing tool\'s width, posture, arrows and outline, the tuner\'s spacing and amplitude', async ({ page }) => {
    await open15(page);
    expect(await request(page, 'view.fit')).toEqual({});
    await page.waitForTimeout(600);
    await insideTool(page, 'pcbnew.InteractiveRouter.SingleTrack', [[-200, -150]], [
      'pcbnew.InteractiveRouter.SwitchPosture', 'pcbnew.InteractiveRouter.SwitchRoundingToNext', 'pcbnew.InteractiveRouter.SwitchRounding45',
      'pcbnew.InteractiveRouter.SwitchRounding90', 'pcbnew.InteractiveRouter.SwitchRoundingArc45', 'pcbnew.InteractiveRouter.SwitchRoundingArc90',
      'pcbnew.InteractiveRouter.PlaceVia', 'pcbnew.InteractiveRouter.PlaceBlindVia', 'pcbnew.InteractiveRouter.PlaceMicroVia',
      'pcbnew.InteractiveRouter.SelLayerAndPlaceVia', 'pcbnew.InteractiveRouter.SelLayerAndPlaceBlindVia', 'pcbnew.InteractiveRouter.SelLayerAndPlaceMicroVia',
      'pcbnew.InteractiveRouter.UndoLastSegment', 'pcbnew.InteractiveRouter.ContinueFromEnd', 'pcbnew.InteractiveRouter.AttemptFinish',
      'pcbnew.InteractiveRouter.CancelCurrentItem',
    ]);
    await insideTool(page, 'pcbnew.InteractiveDrawing.line', [[-200, 150]], ['pcbnew.InteractiveDrawing.incWidth', 'pcbnew.InteractiveDrawing.decWidth']);
    await insideTool(page, 'pcbnew.InteractiveDrawing.arc', [[-200, 150], [-150, 150]], ['pcbnew.InteractiveDrawing.arcPosture']);
    await insideTool(page, 'pcbnew.InteractiveDrawing.alignedDimension', [[-200, 150]], ['pcbnew.InteractiveDrawing.changeDimensionArrows']);
    await insideTool(page, 'pcbnew.InteractiveDrawing.polygon', [[-200, 150], [-150, 150], [-150, 190]], ['pcbnew.InteractiveDrawing.deleteLastPoint', 'pcbnew.InteractiveDrawing.closeOutline']);
    await insideTool(page, 'pcbnew.LengthTuner.TuneSingleTrack', [], [
      'pcbnew.lengthTuner.SpacingIncrease', 'pcbnew.lengthTuner.SpacingDecrease', 'pcbnew.lengthTuner.AmplIncrease', 'pcbnew.lengthTuner.AmplDecrease',
    ], [ID.TRACK_A]);
  });

  test('The footprint editor: Duplicate and Increment pads; Corners read and moved, Edit Corners held as on the board', async ({ page }) => {
    await page.goto('/parent.html?frame=fpedit');
    await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && /blocked|fatal/.test(String((e as { phase?: string }).phase)))), null, { timeout: 170_000 });
    const caps = (await of(page, 'ev.ready'))[0]?.caps ?? [];
    test.skip(!caps.includes('fpedit') || !caps.includes('contextMenu'), RUN15);
    // Engine fix e10-3 (builds T9 and later): the footprint editor reads corners, so vertices is listed here.
    expect(caps).toContain('vertices');
    const soic = await page.evaluate(async () => (await fetch('/fixtures/fpedit-small/fpedit-small_parts.pretty/SOIC-8_3.9x4.9mm_P1.27mm.kicad_mod')).text());
    // The SOIC with one polygon of four corners on F.Fab beside the body (written here, as KiCad 10 writes an fp_poly).
    const withPoly = soic.replace(/\)\s*$/, `\t(fp_poly\n\t\t(pts\n${FP_POLY_CORNERS.map((p) => `\t\t\t(xy ${p.x} ${p.y})\n`).join('')}\t\t)\n\t\t(stroke\n\t\t\t(width 0.1)\n\t\t\t(type solid)\n\t\t)\n\t\t(fill no)\n\t\t(layer "F.Fab")\n\t\t(uuid "${FP_POLY}")\n\t)\n)\n`);
    expect((await request(page, 'fpedit.open', { text: withPoly, name: 'SOIC-8_3.9x4.9mm_P1.27mm', lib: 'fpedit-small_parts', mode: 'library', discard: true })).error).toBeUndefined();
    await page.waitForTimeout(800);
    // Corners: the polygon read, one corner moved in one undo step, the read back, Ctrl+Z back to the start.
    const poly = await corners(page, FP_POLY);
    expect(poly).toEqual({ uuid: FP_POLY, kind: 'polygon', outlines: [{ outline: 0, hole: -1, points: FP_POLY_CORNERS }] });
    expect(await request(page, 'board.vertices.get', { uuid: 'f9ed1700-0000-4000-8000-00000000100b' }))
      .toEqual({ error: { code: 'not_found', message: 'f9ed1700-0000-4000-8000-00000000100b' } });
    const cornerEdited0 = await countOf(page, 'ev.edited');
    const moved = await request(page, 'board.vertices.set', { uuid: FP_POLY, outline: 0, hole: -1, index: 2, x: 7.5, y: 7.25 });
    expect(moved.error).toBeUndefined();
    expect((moved.outlines as Array<{ points: unknown[] }>)[0].points[2]).toEqual({ x: 7.5, y: 7.25 });
    await expect.poll(async () => (await countOf(page, 'ev.edited')) - cornerEdited0, { timeout: 10_000 }).toBe(1);
    expect(await corners(page, FP_POLY)).toEqual(moved);
    await noWindow(page, 'board.vertices.set in the footprint editor');
    await undoStep(page, cornerEdited0, 'board.vertices.set in the footprint editor');
    expect(await corners(page, FP_POLY)).toEqual(poly);
    measure('fpedit corners', 'get, set one step, undo: as on the board');
    // Edit Corners: action.run refuses it as held, our menu holds it (ev.held); KiCad's pane never shows.
    await select(page, [FP_POLY]);
    expect(await request(page, 'action.run', { name: 'pcbnew.InteractiveEdit.editVertices' }))
      .toEqual({ error: { code: 'held', message: 'pcbnew.InteractiveEdit.editVertices' } });
    const held0 = await countOf(page, 'ev.held');
    const menu = await rightClick(page);
    const item = await chooseFrom(page, menu, 'pcbnew.InteractiveEdit.editVertices');
    expect(item.door).toBe('held');
    await expect.poll(async () => (await of(page, 'ev.held')).slice(held0).map((e) => e.action), { timeout: 10_000 }).toEqual(['pcbnew.InteractiveEdit.editVertices']);
    await noWindow(page, 'editVertices in the footprint editor');
    await escape(page);
    await select(page, []);
    const pads0 = Number((await request(page, 'fpedit.state')).padCount);
    expect(await request(page, 'select', { uuids: ['f9ed1700-0000-4000-8000-00000000100b'], zoom: true })).toEqual({});
    await page.waitForTimeout(500);
    const edited0 = await countOf(page, 'ev.edited');
    expect(await request(page, 'action.run', { name: 'pcbnew.InteractiveEdit.duplicateIncrementPads' })).toEqual({});
    await commitAt(page, 40, 0);
    await expect.poll(async () => (await countOf(page, 'ev.edited')) - edited0, { timeout: 10_000 }).toBe(1);
    expect(Number((await request(page, 'fpedit.state')).padCount)).toBe(pads0 + 1);
    await noWindow(page, 'duplicateIncrementPads');
    await escape(page);
    await undoStep(page, edited0, 'duplicateIncrementPads');
    expect(Number((await request(page, 'fpedit.state')).padCount)).toBe(pads0);
  });
});
