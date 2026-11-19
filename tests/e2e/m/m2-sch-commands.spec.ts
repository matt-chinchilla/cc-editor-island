// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// m2-i: every schematic canvas command of the canvas addendum's section 5
// driven once on the canvas-kinds fixture (unit m1-fx) with no KiCad window.
// The unit has no op of its own: each command runs through m1-i's doors, our
// context menu (ev.contextMenu, contextMenu.choose) where KiCad's own menu
// shows it, and action.run for our groups and the pencil rows. Each edit is
// one ev.edited and one undo step (KiCad's Ctrl+Z brings the item's snapshot
// back), its change is read back (symbol.get for a symbol, sch.item.get for
// any other item, the saved schematic for what an edit adds or removes), and
// no window of KiCad's shows: no dialog in the frame, no popup of KiCad's,
// ev.menu never open.
//
// On engine run 14 only the first test runs: KiCad's own keys (R, X, Ctrl+Z)
// turn and mirror R1 with the same read backs, which proves this file's
// reads on the engine that ships today. Every other test waits for engine
// run 15 (K-MENU: kicadHostContextMenu, kicadContextMenuChoose,
// kicadContextMenuHighlight, kicadRunAction) and is skipped here naming it.
import { expect, test, type Frame, type Page } from '@playwright/test';

import { ISLAND } from '../ports';

interface Item { id: number; type: string; action: string; label: string; enabled: boolean; checked: boolean; key: string; door: string; items?: Item[] }
interface Ev {
  type: string; at: number; open?: boolean; caps?: string[]; token?: number; clarify?: boolean; frame?: string;
  items?: Item[]; omitted?: string[]; kinds?: string[]; depth?: number; action?: string; ask?: string; uuid?: string; kind?: string;
}
interface Harness { __events: Ev[]; __saved: Record<string, Uint8Array>; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
type Answer = { ok?: boolean; error?: { code: string; message: string } } & Record<string, unknown>;
type Record_ = Record<string, unknown>;

const FIXTURE = 'canvas-kinds';
const SCH = 'canvas-kinds.kicad_sch';
const RUN15 = 'waits for engine run 15: our context menu and action.run (kicadHostContextMenu, kicadContextMenuChoose, kicadContextMenuHighlight, kicadRunAction; unit m1-e)';

/** The fixture's items by name (tests/fixtures/canvas-kinds/ids.json). */
const ID = {
  R1: 'cc0ca4d5-0000-4000-8000-000000000101',
  U1A: 'cc0ca4d5-0000-4000-8000-000000000104',
  U1A_PIN1: 'cc0ca4d5-0000-4000-8000-000000000105',
  U1A_PIN2: 'cc0ca4d5-0000-4000-8000-000000000106',
  U1B: 'cc0ca4d5-0000-4000-8000-000000000108',
  WIRE_LEFT: 'cc0ca4d5-0000-4000-8000-000000000111',
  WIRE_RIGHT: 'cc0ca4d5-0000-4000-8000-000000000112',
  BUS: 'cc0ca4d5-0000-4000-8000-000000000115',
  IN1: 'cc0ca4d5-0000-4000-8000-00000000011a',
  LD0: 'cc0ca4d5-0000-4000-8000-00000000011c',
  LD1: 'cc0ca4d5-0000-4000-8000-00000000011d',
  GOUT: 'cc0ca4d5-0000-4000-8000-00000000011e',
  TEXT: 'cc0ca4d5-0000-4000-8000-000000000121',
  TEXT_BOX: 'cc0ca4d5-0000-4000-8000-000000000122',
  ARC: 'cc0ca4d5-0000-4000-8000-000000000142',
  POLYLINE: 'cc0ca4d5-0000-4000-8000-000000000143',
  SHEET: 'cc0ca4d5-0000-4000-8000-000000000150',
  SHEET_PIN_B: 'cc0ca4d5-0000-4000-8000-000000000151',
  SHEET_PIN_A: 'cc0ca4d5-0000-4000-8000-000000000152',
  GROUP: 'cc0ca4d5-0000-4000-8000-000000000160',
} as const;
/** The symbols among them: read by symbol.get, every other item by sch.item.get. */
const SYMBOLS = new Set<string>([ID.R1, ID.U1A, ID.U1B]);

/** Top level items in the saved schematic, as KiCad writes them (one tab, then the token). */
const TOP = {
  wire: /^\t\(wire$/gm,
  symbol: /^\t\(symbol$/gm,
  group: /^\t\(group /gm,
  ruleArea: /^\t\(rule_area$/gm,
  label: (t: string) => new RegExp(`^\\t\\(label "${t}"$`, 'gm'),
  global: (t: string) => new RegExp(`^\\t\\(global_label "${t}"$`, 'gm'),
  hier: (t: string) => new RegExp(`^\\t\\(hierarchical_label "${t}"$`, 'gm'),
  directive: /^\t\(netclass_flag /gm,
  text: (t: string) => new RegExp(`^\\t\\(text "${t}"$`, 'gm'),
  textBox: (t: string) => new RegExp(`^\\t\\(text_box "${t}"$`, 'gm'),
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

function measure(type: string, description: string): void {
  test.info().annotations.push({ type, description });
  console.log(`[measure] ${type}: ${description}`);
}

async function open(page: Page): Promise<string[]> {
  await page.goto(`/parent.html?frame=sch&fixture=${FIXTURE}`);
  await page.waitForFunction(() => /opened |open failed|state (blocked|fatal)/.test(document.getElementById('state')?.textContent ?? ''), null, { timeout: 170_000 });
  expect(await page.textContent('#state')).toContain(`opened ${SCH}`);
  await page.waitForTimeout(1_500);
  return (await of(page, 'ev.ready'))[0]?.caps ?? [];
}

/** Opens the fixture and skips the test on an engine before run 15. */
async function open15(page: Page): Promise<string[]> {
  const caps = await open(page);
  test.skip(!caps.includes('contextMenu'), RUN15);
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
 * Presses `action` on `uuids`. `menu`: through our menu, which must show it
 * (KiCad's own menu shows it for that selection); `run`: through action.run
 * (our groups, the pencil rows); `either`: our menu when it shows the item,
 * else the menu closed with -1 and action.run, as the recipe says.
 */
async function press(page: Page, action: string, uuids: readonly string[] | null, via: 'menu' | 'run' | 'either'): Promise<'menu' | 'run'> {
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

/** One item's snapshot: symbol.get for a symbol, sch.item.get for the others (null when gone). */
async function snapOne(page: Page, uuid: string): Promise<Record_ | null> {
  if (SYMBOLS.has(uuid)) {
    const r = await request(page, 'symbol.get', { uuid });
    if (r.error?.code === 'not_found') return null;
    expect(r.error, `symbol.get ${uuid}`).toBeUndefined();
    return r;
  }
  const r = await request(page, 'sch.item.get', { items: [{ uuid, sheetPath: '' }] });
  expect(r.error, `sch.item.get ${uuid}`).toBeUndefined();
  return ((r.items as Record_[]) ?? [])[0] ?? null;
}
const snap = async (page: Page, uuids: readonly string[]): Promise<Array<Record_ | null>> => {
  const out: Array<Record_ | null> = [];
  for (const u of uuids) out.push(await snapOne(page, u));
  return out;
};

/** The schematic as KiCad saves it now (project.save, the bytes ev.saved brought). */
async function savedText(page: Page): Promise<string> {
  const r = await request(page, 'project.save');
  expect(r.error, 'project.save').toBeUndefined();
  return page.evaluate((p) => new TextDecoder().decode((window as unknown as Harness).__saved[p]), SCH);
}

const undo = (page: Page): Promise<Answer> => request(page, 'key.press', { key: 'z', code: 'KeyZ', ctrl: true });

/**
 * Ctrl+Z after one edit, then its own ev.edited (the depth back down by one).
 * The frame reads the undo depth only while no request is in flight, so the
 * wait reads the page's event list alone: a read of the bridge meanwhile could
 * hide the step back, and the next edit would then leave the depth unchanged.
 */
async function undoStep(page: Page, edited0: number, what: string): Promise<void> {
  const depth = (await of(page, 'ev.edited')).at(-1)?.depth;
  expect(await undo(page), `${what}: Ctrl+Z`).toEqual({});
  await expect.poll(async () => (await countOf(page, 'ev.edited')) - edited0, { timeout: 10_000, message: `${what}: the undo's ev.edited` }).toBe(2);
  expect((await of(page, 'ev.edited')).at(-1)?.depth, `${what}: one step back`).toBe(Number(depth) - 1);
}

/** Moves the pointer off the canvas center by (dx, dy) and presses there: a running move, drag, break or placement commits. */
async function commitAt(page: Page, dx: number, dy: number): Promise<void> {
  const c = await canvasCenter(page);
  await page.mouse.move(c.x + dx, c.y + dy, { steps: 6 });
  await page.waitForTimeout(200);
  await page.mouse.click(c.x + dx, c.y + dy);
}

interface EditRow {
  /** The KiCad action. */
  action: string;
  /** What is selected first. */
  on: readonly string[];
  via: 'menu' | 'run' | 'either';
  /** The items read before and after; their snapshot must change (unless `may`) and come back on undo. */
  watch?: readonly string[];
  /** A count in the saved schematic and the change the edit makes to it ('more': at least one more). */
  count?: { re: RegExp; delta: number | 'more' };
  /** The read back the row expects, past "changed". */
  expect?: (before: Array<Record_ | null>, after: Array<Record_ | null>) => void;
  /** After the press: what commits an interactive command (a press in the drawing). */
  then?: (page: Page) => Promise<void>;
  /** May end with no edit (KiCad makes none when there is nothing to change): then nothing changed. */
  may?: boolean;
}

/** One edit row: one ev.edited, the read back, no window, one undo step back to the snapshot. */
async function editRow(page: Page, row: EditRow): Promise<void> {
  const watch = row.watch ?? [];
  const before = await snap(page, watch);
  const text0 = row.count != null ? await savedText(page) : '';
  const edited0 = await countOf(page, 'ev.edited');
  const via = await press(page, row.action, row.on, row.via);
  if (row.then != null) await row.then(page);
  if (row.may === true) {
    await page.waitForTimeout(1_500);
    const n = (await countOf(page, 'ev.edited')) - edited0;
    measure(row.action, `${via}, ${n === 0 ? 'no edit' : 'one edit'}`);
    await noWindow(page, row.action);
    if (n === 0) {
      expect(await snap(page, watch), row.action).toEqual(before);
      return;
    }
    expect(n, row.action).toBe(1);
  } else {
    await expect.poll(async () => (await countOf(page, 'ev.edited')) - edited0, { timeout: 10_000, message: `${row.action}: one ev.edited` }).toBe(1);
    measure(row.action, via);
  }
  await page.waitForTimeout(300);
  expect((await countOf(page, 'ev.edited')) - edited0, `${row.action}: one undo step`).toBe(1);
  await noWindow(page, row.action);
  const after = await snap(page, watch);
  if (watch.length > 0 && row.may !== true) expect(after, `${row.action} changed what it acts on`).not.toEqual(before);
  row.expect?.(before, after);
  if (row.count != null) {
    const d = matches(await savedText(page), row.count.re) - matches(text0, row.count.re);
    if (row.count.delta === 'more') expect(d, row.action).toBeGreaterThan(0);
    else expect(d, row.action).toBe(row.count.delta);
  }
  // One undo step brings the snapshot back.
  await undoStep(page, edited0, row.action);
  expect(await snap(page, watch), `${row.action}: undone`).toEqual(before);
  if (row.count != null) expect(matches(await savedText(page), row.count.re), `${row.action}: undone`).toBe(matches(text0, row.count.re));
  await noWindow(page, `${row.action}, undone`);
}

/** A command that edits nothing (a selection, a mode, the net walk): no ev.edited, no window. */
async function stateRow(page: Page, action: string, on: readonly string[] | null, via: 'menu' | 'run' | 'either'): Promise<void> {
  const edited0 = await countOf(page, 'ev.edited');
  const how = await press(page, action, on, via);
  await page.waitForTimeout(1_000);
  measure(action, how);
  expect((await countOf(page, 'ev.edited')) - edited0, `${action} edits nothing`).toBe(0);
  await noWindow(page, action);
}

const field = (r: Record_ | null, k: string): unknown => (r == null ? undefined : r[k]);

test.describe('engine run 14 and later: KiCad\'s own keys, read back as the walk reads', () => {
  test('R and X turn and mirror R1, one undo step each, read back by symbol.get; the saved schematic holds five wires; no window', async ({ page }) => {
    await open(page);
    const wires = matches(await savedText(page), TOP.wire);
    expect(wires).toBe(5);
    await select(page, [ID.R1]);
    for (const [key, code, k] of [['r', 'KeyR', 'rotation'], ['x', 'KeyX', 'mirror']] as const) {
      const before = await snapOne(page, ID.R1);
      expect(before).toMatchObject({ ref: 'R1', rotation: 0, mirror: 'none', unit: 1 });
      const edited0 = await countOf(page, 'ev.edited');
      expect(await request(page, 'key.press', { key, code }), key).toEqual({});
      await expect.poll(async () => (await countOf(page, 'ev.edited')) - edited0, { timeout: 10_000 }).toBe(1);
      const after = await snapOne(page, ID.R1);
      expect(field(after, k), key).not.toEqual(field(before, k));
      await noWindow(page, key);
      await undoStep(page, edited0, key);
      expect(await snapOne(page, ID.R1)).toEqual(before);
      await noWindow(page, `${key}, undone`);
    }
  });
});

test.describe('engine run 15: every schematic canvas command once, no window', () => {
  test.describe.configure({ timeout: 600_000 });

  test('Arrange: rotate and mirror through our menu and as pencil rows', async ({ page }) => {
    await open15(page);
    const turns: Array<[string, (b: Record_ | null, a: Record_ | null) => void]> = [
      ['eeschema.InteractiveEdit.rotateCCW', (b, a) => expect(field(a, 'rotation')).toBe(((Number(field(b, 'rotation')) + 90) % 360))],
      ['eeschema.InteractiveEdit.rotateCW', (b, a) => expect(field(a, 'rotation')).toBe(((Number(field(b, 'rotation')) + 270) % 360))],
      ['eeschema.InteractiveEdit.mirrorV', (b, a) => expect(field(a, 'mirror')).not.toBe(field(b, 'mirror'))],
      ['eeschema.InteractiveEdit.mirrorH', (b, a) => expect(field(a, 'mirror')).not.toBe(field(b, 'mirror'))],
    ];
    for (const via of ['menu', 'run'] as const) {
      for (const [action, check] of turns) {
        await editRow(page, { action, on: [ID.R1], via, watch: [ID.R1], expect: (b, a) => check(b[0], a[0]) });
      }
    }
  });

  test('Change to: a label becomes each other kind and comes back', async ({ page }) => {
    await open15(page);
    const gone = (_b: Array<Record_ | null>, a: Array<Record_ | null>): void => expect(a[0]).toBeNull();
    const rows: Array<[string, string, RegExp, string]> = [
      ['eeschema.InteractiveEdit.toGLabel', ID.IN1, TOP.global('IN1'), 'IN1'],
      ['eeschema.InteractiveEdit.toHLabel', ID.IN1, TOP.hier('IN1'), 'IN1'],
      ['eeschema.InteractiveEdit.toCLabel', ID.IN1, TOP.directive, 'IN1'],
      ['eeschema.InteractiveEdit.toText', ID.IN1, TOP.text('IN1'), 'IN1'],
      ['eeschema.InteractiveEdit.toTextBox', ID.IN1, TOP.textBox('IN1'), 'IN1'],
      ['eeschema.InteractiveEdit.toLabel', ID.GOUT, TOP.label('GOUT'), 'GOUT'],
    ];
    for (const [action, on, re] of rows) {
      // The converted item is a new one under a new uuid: the old one is gone until the undo.
      await editRow(page, { action, on: [on], via: 'menu', watch: [on], count: { re, delta: 1 }, expect: gone });
    }
  });

  test('Wires: break and slice split a wire, Select Node and Select Connection select', async ({ page }) => {
    await open15(page);
    await editRow(page, { action: 'eeschema.InteractiveEdit.breakWire', on: [ID.WIRE_LEFT], via: 'menu', watch: [ID.WIRE_LEFT], count: { re: TOP.wire, delta: 1 }, then: (p) => commitAt(p, 0, 40) });
    await editRow(page, { action: 'eeschema.InteractiveEdit.slice', on: [ID.WIRE_LEFT], via: 'menu', watch: [ID.WIRE_LEFT], count: { re: TOP.wire, delta: 'more' }, then: (p) => commitAt(p, 0, 40) });
    for (const action of ['eeschema.InteractiveSelection.SelectConnection', 'eeschema.InteractiveSelection.SelectNode']) {
      const selected = await countOf(page, 'ev.selected');
      await stateRow(page, action, [ID.WIRE_LEFT], action.endsWith('SelectConnection') ? 'menu' : 'either');
      expect(await countOf(page, 'ev.selected'), `${action} selects`).toBeGreaterThan(selected);
      await request(page, 'select', { uuids: [] });
    }
    for (const action of ['eeschema.EditorControl.nextNetItem', 'eeschema.EditorControl.previousNetItem']) await stateRow(page, action, [ID.WIRE_LEFT], 'run');
  });

  test('Units: next and previous unit, the next unit placed', async ({ page }) => {
    await open15(page);
    await editRow(page, { action: 'eeschema.EditorControl.nextUnit', on: [ID.U1A], via: 'run', watch: [ID.U1A], expect: (b, a) => { expect(field(b[0], 'unit')).toBe(1); expect(field(a[0], 'unit')).toBe(2); } });
    await editRow(page, { action: 'eeschema.EditorControl.previousUnit', on: [ID.U1A], via: 'run', watch: [ID.U1A], expect: (b, a) => expect(field(a[0], 'unit')).not.toBe(field(b[0], 'unit')) });
    await editRow(page, { action: 'eeschema.InteractiveDrawing.placeNextSymbolUnit', on: [ID.U1A], via: 'run', count: { re: TOP.symbol, delta: 1 }, then: (p) => commitAt(p, 120, 0) });
  });

  test('Increment: IN1 becomes IN2, IN0 the other way', async ({ page }) => {
    await open15(page);
    const text = (want: string) => (_b: Array<Record_ | null>, a: Array<Record_ | null>): void => expect(field(a[0], 'text')).toBe(want);
    await editRow(page, { action: 'eeschema.Interactive.increment', on: [ID.IN1], via: 'run', watch: [ID.IN1], expect: text('IN2') });
    await editRow(page, { action: 'eeschema.Interactive.incrementPrimary', on: [ID.IN1], via: 'run', watch: [ID.IN1], expect: text('IN2') });
    await editRow(page, { action: 'eeschema.Interactive.decrementPrimary', on: [ID.IN1], via: 'run', watch: [ID.IN1], expect: text('IN0') });
    // IN1 has one number: KiCad's secondary field may be the letters or nothing.
    for (const action of ['eeschema.Interactive.incrementSecondary', 'eeschema.Interactive.decrementSecondary']) {
      await editRow(page, { action, on: [ID.IN1], via: 'run', watch: [ID.IN1], may: true });
    }
  });

  test('Text: justify right, center and left', async ({ page }) => {
    await open15(page);
    await editRow(page, { action: 'common.Control.rightJustify', on: [ID.TEXT], via: 'run', watch: [ID.TEXT] });
    await editRow(page, { action: 'common.Control.centerJustify', on: [ID.TEXT], via: 'run', watch: [ID.TEXT] });
    // The text stands left justified already.
    await editRow(page, { action: 'common.Control.leftJustify', on: [ID.TEXT], via: 'run', watch: [ID.TEXT], may: true });
  });

  test('Groups: group, ungroup, add, remove, enter, leave and the group form', async ({ page }) => {
    const caps = await open15(page);
    await editRow(page, { action: 'common.Interactive.group', on: [ID.WIRE_LEFT, ID.WIRE_RIGHT], via: 'run', count: { re: TOP.group, delta: 1 } });
    await editRow(page, { action: 'common.Interactive.ungroup', on: [ID.GROUP], via: 'run', watch: [ID.GROUP], count: { re: TOP.group, delta: -1 }, expect: (_b, a) => expect(a[0]).toBeNull() });
    await editRow(page, { action: 'common.Interactive.addToGroup', on: [ID.GROUP, ID.TEXT_BOX], via: 'either', watch: [ID.GROUP], expect: (b, a) => expect(field(a[0], 'members')).toBe(Number(field(b[0], 'members')) + 1) });
    await editRow(page, { action: 'common.Interactive.removeFromGroup', on: [ID.TEXT], via: 'either', watch: [ID.GROUP], expect: (b, a) => expect(field(a[0], 'members')).toBe(Number(field(b[0], 'members')) - 1) });
    await stateRow(page, 'common.Interactive.groupEnter', [ID.GROUP], 'menu');
    await stateRow(page, 'common.Interactive.groupLeave', null, 'either');
    // The group form: KiCad's Edit Group Properties asks the host as E does (ev.schItem, unit m5-i).
    if (!caps.includes('schItem')) {
      measure('common.Groups.groupProperties', 'not pressed: the group form waits for the schItem cap (kicadHostSchItems, unit m5-e)');
      return;
    }
    const asks = await countOf(page, 'ev.schItem');
    await stateRow(page, 'common.Groups.groupProperties', [ID.GROUP], 'run');
    await expect.poll(async () => (await of(page, 'ev.schItem')).slice(asks).map((e) => [e.kind, e.uuid]), { timeout: 10_000 }).toEqual([['group', ID.GROUP]]);
  });

  test('Align, align to grid, swap, autoplace fields', async ({ page }) => {
    await open15(page);
    for (const a of ['alignTop', 'alignBottom', 'alignLeft', 'alignRight', 'alignCenterX', 'alignCenterY']) {
      // R1 stands at 63.5, 63.5 and the text at 25.4, 25.4: every alignment moves one of them.
      await editRow(page, { action: `eeschema.Align.${a}`, on: [ID.R1, ID.TEXT], via: 'menu', watch: [ID.R1, ID.TEXT] });
    }
    await editRow(page, { action: 'eeschema.AlignToGrid', on: [ID.R1], via: 'either', watch: [ID.R1], may: true });
    await editRow(page, {
      action: 'eeschema.InteractiveEdit.swap', on: [ID.LD0, ID.LD1], via: 'menu', watch: [ID.LD0, ID.LD1],
      expect: (b, a) => expect([field(a[0], 'x'), field(a[0], 'y')]).toEqual([field(b[1], 'x'), field(b[1], 'y')]),
    });
    await editRow(page, { action: 'eeschema.InteractiveEdit.autoplaceFields', on: [ID.R1], via: 'either', watch: [ID.R1], may: true });
  });

  test('Pins: swap pins, swap pin labels, swap unit labels', async ({ page }) => {
    await open15(page);
    // KiCad shows pin swaps only where the project allows them, and swaps labels only where labels sit on the pins.
    await editRow(page, { action: 'eeschema.InteractiveEdit.swapPins', on: [ID.U1A_PIN1, ID.U1A_PIN2], via: 'either', watch: [ID.U1A], may: true });
    await editRow(page, { action: 'eeschema.InteractiveEdit.swapPinLabels', on: [ID.U1A_PIN1, ID.U1A_PIN2], via: 'either', watch: [ID.U1A], may: true });
    await editRow(page, { action: 'eeschema.InteractiveEdit.swapUnitLabels', on: [ID.U1A, ID.U1B], via: 'either', watch: [ID.U1A, ID.U1B], may: true });
  });

  test('Move, drag and duplicate commit at a press', async ({ page }) => {
    await open15(page);
    const moved = (b: Array<Record_ | null>, a: Array<Record_ | null>): void => expect([field(a[0], 'x'), field(a[0], 'y')]).not.toEqual([field(b[0], 'x'), field(b[0], 'y')]);
    await editRow(page, { action: 'eeschema.InteractiveMove.move', on: [ID.R1], via: 'menu', watch: [ID.R1], expect: moved, then: (p) => commitAt(p, 80, 50) });
    await editRow(page, { action: 'eeschema.InteractiveMove.drag', on: [ID.R1], via: 'menu', watch: [ID.R1], expect: moved, then: (p) => commitAt(p, 80, 50) });
    await editRow(page, { action: 'common.Interactive.duplicate', on: [ID.R1], via: 'menu', count: { re: TOP.symbol, delta: 1 }, then: (p) => commitAt(p, 120, 60) });
  });

  test('Sheets: autoplace the pins, clean up the pins, sync the pins', async ({ page }) => {
    const caps = await open15(page);
    await editRow(page, { action: 'eeschema.InteractiveDrawing.autoplaceAllSheetPins', on: [ID.SHEET], via: 'menu', watch: [ID.SHEET_PIN_A, ID.SHEET_PIN_B], may: true });
    // Cleanup Sheet Pins asks KiCad's IsOK when pins have no label in the child (the message ask); here every pin has one.
    const prompts = await countOf(page, 'ev.prompt');
    const edited0 = await countOf(page, 'ev.edited');
    await press(page, 'eeschema.InteractiveEdit.cleanupSheetPins', [ID.SHEET], 'either');
    await page.waitForTimeout(1_500);
    const asked = (await of(page, 'ev.prompt')).slice(prompts);
    for (const p of asked) {
      expect(p.ask).toBe('message');
      expect(await request(page, 'prompt.cancel', { token: p.token })).toEqual({});
    }
    measure('eeschema.InteractiveEdit.cleanupSheetPins', `${asked.length} prompt(s)`);
    expect((await countOf(page, 'ev.edited')) - edited0).toBe(0);
    await noWindow(page, 'cleanupSheetPins');
    // Sync Selected Sheet Pins is held for its page (unit m9-i, cap syncPins); without the cap it is left out of our menu.
    await select(page, [ID.SHEET]);
    const menu = await rightClick(page);
    const sync = 'eeschema.InteractiveDrawing.syncSheetPins';
    const item = flat(menu.items ?? []).find((i) => i.action === sync);
    if (!caps.includes('syncPins')) {
      expect(item).toBeUndefined();
      expect(await request(page, 'contextMenu.choose', { token: menu.token, id: -1 })).toEqual({});
    } else {
      expect(item?.door).toBe('held');
      const held = await countOf(page, 'ev.held');
      await chooseFrom(page, menu, sync);
      await expect.poll(async () => (await of(page, 'ev.held')).slice(held).map((e) => e.action), { timeout: 10_000 }).toEqual([sync]);
    }
    await noWindow(page, sync);
  });

  test('Running tools: the rule area\'s outline points, the wire tool\'s segment and posture, unfold from the bus', async ({ page }) => {
    await open15(page);
    expect(await request(page, 'view.fit')).toEqual({});
    await page.waitForTimeout(600);
    const c = await canvasCenter(page);
    const pt = (dx: number, dy: number): { x: number; y: number } => ({ x: c.x + dx, y: c.y + dy });
    // A rule area drawn in a corner of the sheet: three points, the last taken back, put again, the outline closed.
    const text0 = await savedText(page);
    const edited0 = await countOf(page, 'ev.edited');
    expect(await request(page, 'action.run', { name: 'eeschema.InteractiveDrawing.drawRuleArea' })).toEqual({});
    for (const [dx, dy] of [[-260, -200], [-180, -200], [-180, -130]]) { await page.mouse.click(pt(dx, dy).x, pt(dx, dy).y); await page.waitForTimeout(200); }
    await chooseFrom(page, await rightClick(page, pt(-180, -130)), 'eeschema.InteractiveDrawing.deleteLastPoint');
    await page.waitForTimeout(400);
    expect((await countOf(page, 'ev.edited')) - edited0).toBe(0);
    await page.mouse.click(pt(-180, -130).x, pt(-180, -130).y);
    await page.waitForTimeout(200);
    await chooseFrom(page, await rightClick(page, pt(-180, -130)), 'eeschema.InteractiveDrawing.closeOutline');
    await expect.poll(async () => (await countOf(page, 'ev.edited')) - edited0, { timeout: 10_000 }).toBe(1);
    await noWindow(page, 'closeOutline');
    expect(await request(page, 'key.press', { key: 'Escape', code: 'Escape' })).toEqual({});
    expect(matches(await savedText(page), TOP.ruleArea) - matches(text0, TOP.ruleArea)).toBe(1);
    await undoStep(page, edited0, 'closeOutline');
    expect(matches(await savedText(page), TOP.ruleArea)).toBe(matches(text0, TOP.ruleArea));
    // The wire tool: a segment started, its posture switched, the segment taken back, nothing committed.
    const edited1 = await countOf(page, 'ev.edited');
    expect(await request(page, 'action.run', { name: 'eeschema.InteractiveDrawingLineWireBus.drawWires' })).toEqual({});
    await page.mouse.click(pt(160, 160).x, pt(160, 160).y);
    await page.mouse.move(pt(220, 200).x, pt(220, 200).y, { steps: 6 });
    await chooseFrom(page, await rightClick(page, pt(220, 200)), 'eeschema.InteractiveDrawingLineWireBus.switchPosture');
    await page.waitForTimeout(300);
    await chooseFrom(page, await rightClick(page, pt(220, 200)), 'eeschema.InteractiveDrawingLineWireBus.undoLastSegment');
    await page.waitForTimeout(300);
    for (let i = 0; i < 2; i++) { expect(await request(page, 'key.press', { key: 'Escape', code: 'Escape' })).toEqual({}); await page.waitForTimeout(200); }
    expect((await countOf(page, 'ev.edited')) - edited1, 'the wire tool committed nothing').toBe(0);
    await noWindow(page, 'the wire tool');
    // Unfold from Bus: C over the bus is KiCad's unfold list, our menu of its members.
    await select(page, [ID.BUS]);
    await request(page, 'select', { uuids: [] });
    const at = await canvasCenter(page);
    await page.mouse.move(at.x, at.y);
    const menus = await countOf(page, 'ev.contextMenu');
    expect(await request(page, 'key.press', { key: 'c', code: 'KeyC' })).toEqual({});
    await expect.poll(async () => (await countOf(page, 'ev.contextMenu')) - menus, { timeout: 10_000 }).toBe(1);
    const unfold = (await of(page, 'ev.contextMenu')).at(-1)!;
    const members = flat(unfold.items ?? []).filter((i) => i.type === 'choice').map((i) => i.label);
    measure('unfoldBus', members.join(', '));
    expect(members.length).toBeGreaterThan(0);
    expect(await request(page, 'contextMenu.choose', { token: unfold.token, id: -1 })).toEqual({});
    for (let i = 0; i < 2; i++) { await request(page, 'key.press', { key: 'Escape', code: 'Escape' }); await page.waitForTimeout(200); }
    await noWindow(page, 'unfoldBus');
  });

  test('Corners and arcs: create and remove a corner, cycle the arc mode', async ({ page }) => {
    await open15(page);
    await editRow(page, { action: 'eeschema.PointEditor.addCorner', on: [ID.POLYLINE], via: 'either', watch: [ID.POLYLINE], may: true });
    await editRow(page, { action: 'eeschema.PointEditor.removeCorner', on: [ID.POLYLINE], via: 'either', watch: [ID.POLYLINE], may: true });
    await stateRow(page, 'common.Interactive.cycleArcEditMode', [ID.ARC], 'either');
  });

  test('The rest by name: our keyboard menu, repeat the last item, the user signals', async ({ page }) => {
    await open15(page);
    // Show Context Menu is M1 itself: our menu at KiCad's cursor.
    await select(page, [ID.R1]);
    const c = await canvasCenter(page);
    await page.mouse.move(c.x, c.y);
    const menus = await countOf(page, 'ev.contextMenu');
    expect(await request(page, 'action.run', { name: 'common.Control.showContextMenu' })).toEqual({});
    await expect.poll(async () => (await countOf(page, 'ev.contextMenu')) - menus, { timeout: 10_000 }).toBe(1);
    expect(await request(page, 'contextMenu.choose', { token: (await of(page, 'ev.contextMenu')).at(-1)!.token, id: -1 })).toEqual({});
    await noWindow(page, 'showContextMenu');
    // Repeat Last Item with nothing drawn yet in this session: KiCad repeats nothing.
    await editRow(page, { action: 'eeschema.InteractiveEdit.repeatDrawItem', on: [], via: 'run', count: { re: TOP.wire, delta: 'more' }, may: true });
    // User-defined Signals is the simulator's (M11: the plot sheet); in a schematic it opens nothing.
    const edited0 = await countOf(page, 'ev.edited');
    const r = await request(page, 'action.run', { name: 'eeschema.Simulation.editUserDefinedSignals' });
    measure('editUserDefinedSignals', JSON.stringify(r));
    expect([undefined, 'unknown_action', 'held', 'unsupported']).toContain(r.error?.code);
    await page.waitForTimeout(1_000);
    expect((await countOf(page, 'ev.edited')) - edited0).toBe(0);
    await noWindow(page, 'editUserDefinedSignals');
  });

  test('The symbol editor: convert stacked pins and explode a stacked pin', async ({ page }) => {
    await page.goto('/parent.html?frame=symedit');
    await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready'), null, { timeout: 170_000 });
    const caps = (await of(page, 'ev.ready'))[0]?.caps ?? [];
    test.skip(!caps.includes('contextMenu'), RUN15);
    const made = await request(page, 'symedit.new', {
      name: 'M2_STACK', lib: 'm2', parentText: '', parent: '', refPrefix: 'U', unitCount: 1, unitsInterchangeable: false, bodyStyles: 'one', power: 'none',
      pinNameOffset: 0.508, showPinNames: true, showPinNumbers: true, pinNamesInside: true, inBom: true, onBoard: true, inSim: true, keepParentFields: false, discard: true,
    });
    expect(made.error).toBeUndefined();
    const pin = (uuid: string, number: string, y: number): Record_ => ({
      kind: 'pin', uuid, unit: 0, bodyStyle: 0, number, name: '~', type: 'passive', shape: 'line', x: 0, y,
      orientation: 'right', length: 2.54, nameSize: 1.27, numberSize: 1.27, visible: true, alternates: [],
    });
    const P1 = 'cc0ca4d5-0000-4000-8000-0000000002a1';
    const P2 = 'cc0ca4d5-0000-4000-8000-0000000002a2';
    const P3 = 'cc0ca4d5-0000-4000-8000-0000000002a3';
    const added = await request(page, 'symedit.items.add', { items: [pin(P1, '1', 0), pin(P2, '2', 0), pin(P3, '[3,4]', 5.08)] });
    expect(added.error).toBeUndefined();
    const pins = async (): Promise<string[]> => {
      const r = await request(page, 'symedit.items.get', { kinds: ['pin'], unit: 0, bodyStyle: 0 });
      return ((r.items as Record_[]) ?? []).map((p) => String(p.number)).sort();
    };
    expect(await pins()).toEqual(['1', '2', '[3,4]']);
    const rows: Array<[string, string, (n: string[]) => void]> = [
      // Two pins at one place become one pin numbered with KiCad's stacked notation.
      ['eeschema.InteractiveEdit.convertStackedPins', P1, (n) => { expect(n).toHaveLength(2); expect(n.some((x) => x.startsWith('['))).toBe(true); expect(n).toContain('[3,4]'); }],
      // A stacked pin becomes one pin per number.
      ['eeschema.InteractiveEdit.explodeStackedPin', P3, (n) => expect(n).toEqual(['1', '2', '3', '4'])],
    ];
    for (const [action, on, check] of rows) {
      const before = await pins();
      const edited0 = await countOf(page, 'ev.edited');
      const how = await press(page, action, [on], 'either');
      await expect.poll(async () => (await countOf(page, 'ev.edited')) - edited0, { timeout: 10_000, message: `${action}: one ev.edited` }).toBe(1);
      measure(action, how);
      check(await pins());
      await noWindow(page, action);
      await undoStep(page, edited0, action);
      expect(await pins()).toEqual(before);
    }
  });
});
