// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// m12-i over the local pair (PROTOCOL.md, Tables) on the canvas-kinds
// fixture (unit m1-fx): the schematic's 3 by 3 table (its first cell spans
// two columns) and the board's 2 by 2 table on F.SilkS. On engine run 14 the
// engine has no kicadTableCsv: the cap tableCsv is absent, table.csv is listed
// in island.json and answers unsupported naming the export, and the frame's
// prompt slot declines the table asks. The recipe's run 15 steps wait for
// engine run 15 (units m12-e, m1x-e1 and m1-e: kicadTableCsv, the prompts
// and our context menu) and are skipped here with the exports they wait for.
import { expect, test, type Frame, type Page } from '@playwright/test';

import { ISLAND } from '../ports';

interface Item { id: number; type: string; action: string; label: string; enabled: boolean; door: string; items?: Item[] }
interface Ev { type: string; caps?: string[]; token?: number; ask?: string; modal?: boolean; frame?: string; record?: Record<string, unknown>; items?: Item[]; uuids?: string[]; action?: string; depth?: number; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
type Answer = { ok?: boolean; error?: { code: string; message: string } } & Record<string, unknown>;
type Kind = 'sch' | 'pcb';

const FIXTURE = 'canvas-kinds';
const WIRE = 'cc0ca4d5-0000-4000-8000-000000000110';
/** Each frame's table, its cells by the fixture's names, and the cells the steps press on. */
const TABLES = {
  sch: {
    table: 'cc0ca4d5-0000-4000-8000-00000000012f', rows: 3, cols: 3,
    texts: { 'cc0ca4d5-0000-4000-8000-000000000134': 'R1C1' },
    // x: the adds and the row delete; y and z: the merge, the selects, the column delete; y outlives them all.
    x: 'cc0ca4d5-0000-4000-8000-000000000134', y: 'cc0ca4d5-0000-4000-8000-000000000137', z: 'cc0ca4d5-0000-4000-8000-000000000138',
  },
  pcb: {
    table: 'cc0ca4d5-0000-4000-8000-000000000340', rows: 2, cols: 2,
    texts: { 'cc0ca4d5-0000-4000-8000-000000000341': 'A1' },
    x: 'cc0ca4d5-0000-4000-8000-000000000341', y: 'cc0ca4d5-0000-4000-8000-000000000343', z: 'cc0ca4d5-0000-4000-8000-000000000344',
  },
} as const;
const EXPORT_CSV = 'common.TableEditor.exportTableCSV';
const RUN15 = 'waits for engine run 15: kicadTableCsv (unit m12-e), the prompts (kicadHostPrompts, m1x-e1) and our context menu (kicadHostContextMenu, kicadRunAction, m1-e)';

const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const of = async (page: Page, type: string): Promise<Ev[]> => (await events(page)).filter((e) => e.type === type);
/** The bridge's answer, or its refusal as { error }. */
const request = (page: Page, op: string, args?: unknown): Promise<Answer> =>
  page.evaluate(async ([o, a]) => {
    try { return await (window as unknown as Harness).__bridge.request(o as string, a); } catch (e) {
      const m = /^([a-z_]+): ([\s\S]*)$/.exec(String((e as { message?: string }).message ?? e));
      return { error: { code: m?.[1] ?? 'thrown', message: m?.[2] ?? String(e) } };
    }
  }, [op, args] as const);
const islandFrame = (page: Page): Frame | null => page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null;
const flat = (items: readonly Item[]): Item[] => items.flatMap((i) => [i, ...flat(i.items ?? [])]);

async function open(page: Page, frame: Kind): Promise<string[]> {
  await page.goto(`/parent.html?frame=${frame}&fixture=${FIXTURE}`);
  await page.waitForFunction(() => /opened |open failed|state (blocked|fatal)/.test(document.getElementById('state')?.textContent ?? ''), null, { timeout: 170_000 });
  expect(await page.textContent('#state')).toContain(`opened ${FIXTURE}.kicad_${frame}`);
  await page.waitForTimeout(1_500);
  return (await of(page, 'ev.ready'))[0]?.caps ?? [];
}
const run15 = (caps: readonly string[]): boolean => ['tableCsv', 'prompts', 'contextMenu'].every((c) => caps.includes(c));

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

async function select(page: Page, uuids: string[]): Promise<void> {
  expect(await request(page, 'select', { uuids, zoom: true })).toEqual({});
  await page.waitForTimeout(600);
}

/** Waits for the next ev.prompt after `before` of them. */
async function nextPrompt(page: Page, before: number): Promise<Ev> {
  await expect.poll(async () => (await of(page, 'ev.prompt')).length - before, { timeout: 10_000 }).toBe(1);
  return (await of(page, 'ev.prompt')).at(-1)!;
}

/** E on the selected cells: the tableCell prompt. */
async function cellPrompt(page: Page, uuids: string[]): Promise<Ev> {
  await select(page, uuids);
  const before = (await of(page, 'ev.prompt')).length;
  expect(await request(page, 'key.press', { key: 'e', code: 'KeyE' })).toEqual({});
  const p = await nextPrompt(page, before);
  expect(p).toMatchObject({ ask: 'tableCell' });
  return p;
}

/** Edit Table on `cell`'s table, its record read, then canceled. */
async function readTable(page: Page, cell: string): Promise<{ rows: number; cols: number; cells: Array<Array<string | null>>; border: Record<string, unknown> }> {
  await select(page, [cell]);
  const before = (await of(page, 'ev.prompt')).length;
  expect(await request(page, 'action.run', { name: 'pcbnew.TableEditor.editTable' })).toEqual({});
  const p = await nextPrompt(page, before);
  expect(p.ask).toBe('table');
  expect(await request(page, 'prompt.cancel', { token: p.token })).toEqual({});
  return p.record as never;
}
const covered = (cells: Array<Array<string | null>>): number => cells.flat().filter((c) => c === null).length;

/** A right click on the selected `uuids`: our menu, `action` chosen from it. */
async function choose(page: Page, uuids: string[], action: string): Promise<void> {
  await select(page, uuids);
  const before = (await of(page, 'ev.contextMenu')).length;
  const at = await canvasCenter(page);
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await expect.poll(async () => (await of(page, 'ev.contextMenu')).length - before, { timeout: 10_000 }).toBe(1);
  const menu = (await of(page, 'ev.contextMenu')).at(-1)!;
  const item = flat(menu.items ?? []).find((i) => i.action === action);
  expect(item, `${action} in the menu`).toBeDefined();
  expect(item!.enabled).toBe(true);
  expect(await request(page, 'contextMenu.choose', { token: menu.token, id: item!.id })).toEqual({});
}

test.describe('engine run 14: table.csv is listed and refuses cleanly, the asks are declined', () => {
  test('island.json lists table.csv', async ({ page }) => {
    const res = await page.goto(`${ISLAND}/island.json`);
    const island = (await res!.json()) as { ops?: string[] };
    expect(island.ops ?? []).toContain('table.csv');
  });

  for (const kind of ['sch', 'pcb'] as const) {
    test(`a ${kind} frame: no tableCsv cap, table.csv answers unsupported, the slot declines a table ask`, async ({ page }) => {
      const caps = await open(page, kind);
      test.skip(caps.includes('tableCsv'), 'this engine has kicadTableCsv: the run 15 tests below cover it');
      const t = TABLES[kind];
      expect(await request(page, 'table.csv', { uuid: t.table })).toEqual({ error: { code: 'unsupported', message: 'kicadTableCsv' } });
      expect(await request(page, 'table.csv', { uuid: 'nope' })).toEqual({ error: { code: 'bad_args', message: 'table.csv' } });
      expect(await request(page, 'table.csv', { uuid: t.table, more: 1 })).toEqual({ error: { code: 'bad_args', message: 'table.csv' } });
      const record = { uuids: [t.x], text: 'x', font: null, bold: null, italic: null, hAlign: null, vAlign: null, margins: null, size: null, width: null, height: null, thickness: null, autoThickness: null, textColor: null, fill: null };
      const frame = islandFrame(page);
      expect(await frame!.evaluate((r) => (window as unknown as { kicadHostPrompt?: { onAsk?: (j: unknown) => boolean } }).kicadHostPrompt?.onAsk?.(JSON.stringify({ token: 1, ask: 'tableCell', modal: true, record: r })) ?? false, record)).toBe(false);
      expect(await of(page, 'ev.prompt')).toEqual([]);
      // Not held without the cap: action.run reaches its own export check.
      const r = await request(page, 'action.run', { name: EXPORT_CSV });
      expect(r.error?.code).not.toBe('held');
    });
  }
});

test.describe('engine run 15: tables', () => {
  for (const kind of ['sch', 'pcb'] as const) {
    test(`${kind}: E on a cell asks tableCell; an answer edits once and reads back; Edit Table from the cell asks table`, async ({ page }) => {
      const caps = await open(page, kind);
      test.skip(!run15(caps), RUN15);
      const t = TABLES[kind];
      const first = await cellPrompt(page, [t.x]);
      expect(first.frame).toBe(kind);
      expect(first.record!.uuids).toEqual([t.x]);
      expect(first.record!.text).toBe(t.texts[t.x as keyof typeof t.texts]);
      // A key while the modal prompt is parked: busy.
      expect(await request(page, 'key.press', { key: 'Home', code: 'Home' })).toEqual({ error: { code: 'busy', message: 'key.press' } });
      const edited = (await of(page, 'ev.edited')).length;
      expect(await request(page, 'prompt.answer', { token: first.token, text: 'X' })).toEqual({ accepted: true });
      await expect.poll(async () => (await of(page, 'ev.edited')).length - edited, { timeout: 10_000 }).toBe(1);
      const second = await cellPrompt(page, [t.x]);
      expect(second.record!.text).toBe('X');
      const before = (await of(page, 'ev.prompt')).length;
      expect(await request(page, 'prompt.answer', { token: second.token, editTable: true })).toEqual({ accepted: true });
      const table = await nextPrompt(page, before);
      expect(table).toMatchObject({ ask: 'table', frame: kind });
      expect(table.record).toMatchObject({ uuid: t.table, rows: t.rows, cols: t.cols });
      expect(await request(page, 'prompt.answer', { token: table.token, border: { header: false } })).toEqual({ accepted: true });
      expect((await readTable(page, t.x)).border.header).toBe(false);
    });

    test(`${kind}: each table command from our menu changes the grid as read back`, async ({ page }) => {
      const caps = await open(page, kind);
      test.skip(!run15(caps), RUN15);
      const t = TABLES[kind];
      let g = await readTable(page, t.x);
      expect([g.rows, g.cols]).toEqual([t.rows, t.cols]);
      const step = async (uuids: string[], action: string, rows: number, cols: number): Promise<void> => {
        const edited = (await of(page, 'ev.edited')).length;
        await choose(page, uuids, action);
        await expect.poll(async () => (await of(page, 'ev.edited')).length - edited, { timeout: 10_000 }).toBeGreaterThan(0);
        // y outlives every step: read through it.
        g = await readTable(page, t.y);
        expect([g.rows, g.cols], action).toEqual([rows, cols]);
      };
      await step([t.x], 'common.TableEditor.addRowAbove', t.rows + 1, t.cols);
      await step([t.x], 'common.TableEditor.addRowBelow', t.rows + 2, t.cols);
      await step([t.x], 'common.TableEditor.addColBefore', t.rows + 2, t.cols + 1);
      await step([t.x], 'common.TableEditor.addColAfter', t.rows + 2, t.cols + 2);
      const open0 = covered(g.cells);
      await step([t.y, t.z], 'common.TableEditor.mergeCells', t.rows + 2, t.cols + 2);
      expect(covered(g.cells)).toBe(open0 + 1);
      await step([t.y], 'common.TableEditor.unmergeCell', t.rows + 2, t.cols + 2);
      expect(covered(g.cells)).toBe(open0);
      // The three selects change the selection, not the grid.
      for (const [action, want] of [
        ['common.InteractiveSelection.Rows', t.cols + 2],
        ['common.InteractiveSelection.SelectColumns', t.rows + 2],
      ] as const) {
        const sel = (await of(page, 'ev.selected')).length;
        await choose(page, [t.y], action);
        await expect.poll(async () => (await of(page, 'ev.selected')).length - sel, { timeout: 10_000 }).toBeGreaterThan(0);
        const uuids = (await of(page, 'ev.selected')).at(-1)!.uuids ?? [];
        expect(uuids, action).toContain(t.y);
        // A row or a column holds its cells, a merged cell counted once.
        expect(uuids.length, action).toBeGreaterThanOrEqual(want - 1);
      }
      const sel = (await of(page, 'ev.selected')).length;
      await choose(page, [t.y], 'common.InteractiveSelection.SelectTable');
      await expect.poll(async () => (await of(page, 'ev.selected')).length - sel, { timeout: 10_000 }).toBeGreaterThan(0);
      const whole = (await of(page, 'ev.selected')).at(-1)!.uuids ?? [];
      // The table itself, or every cell of it.
      expect(whole.includes(t.table) || whole.length >= (t.rows + 2) * (t.cols + 2) - open0).toBe(true);
      await step([t.z], 'common.TableEditor.deleteColumns', t.rows + 2, t.cols + 1);
      await step([t.x], 'common.TableEditor.deleteRows', t.rows + 1, t.cols + 1);
    });

    test(`${kind}: table.csv answers the grid's text; Export Table to CSV is held`, async ({ page }) => {
      const caps = await open(page, kind);
      test.skip(!run15(caps), RUN15);
      const t = TABLES[kind];
      const a = await request(page, 'table.csv', { uuid: t.table });
      expect(a.error).toBeUndefined();
      expect(a.name).toBe('canvas-kinds-table');
      const lines = String(a.text).split('\n');
      expect(lines.at(-1)).toBe('');
      expect(lines.slice(0, -1).map((l) => l.split(',').length)).toEqual(Array(t.rows).fill(t.cols));
      expect(String(a.text)).toContain(t.texts[t.x as keyof typeof t.texts]);
      // A cell names its table.
      expect(await request(page, 'table.csv', { uuid: t.x })).toEqual(a);
      expect(await request(page, 'table.csv', { uuid: kind === 'sch' ? WIRE : 'cc0ca4d5-0000-4000-8000-000000000339' })).toMatchObject({ error: { code: 'not_found' } });
      // action.run refuses a held action first (m1-i); our menu ends the choice in ev.held, no window.
      expect(await request(page, 'action.run', { name: EXPORT_CSV })).toEqual({ error: { code: 'held', message: EXPORT_CSV } });
      const held = (await of(page, 'ev.held')).length;
      await choose(page, [t.x], EXPORT_CSV);
      await expect.poll(async () => (await of(page, 'ev.held')).slice(held).map((e) => e.action), { timeout: 10_000 }).toEqual([EXPORT_CSV]);
      await page.waitForTimeout(1_000);
      expect(await of(page, 'ev.menu')).toEqual(expect.not.arrayContaining([expect.objectContaining({ open: true })]));
    });
  }
});
