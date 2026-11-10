// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// island v0.2.3-cc18 over the local pair (PROTOCOL.md ev.held,
// ev.boardProperties and ev.properties's field): our engine (engine run 12)
// asks the frame before a hotkey's action runs (ACTION_MANAGER::RunHotKey),
// before the board's properties dialogs (EDIT_TOOL::Properties) and before the
// symbol's field dialogs (U, V and F). The frame takes the keys whose windows
// the host replaces and sends them as events; KiCad's window never opens. The
// keys are pressed through key.press, held the same way a reader's are.
import { expect, test, type Frame, type Page } from '@playwright/test';

const ISLAND = 'http://editor.localhost:4174';
interface Ev { type: string; phase?: string; open?: boolean; caps?: string[]; action?: string; uuid?: string; kind?: string; uuids?: string[]; sheetPath?: string; field?: string; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Key { key: string; code: string; ctrl?: boolean; shift?: boolean; alt?: boolean }

/** drc-small's items (tests/fixtures/drc-small/ids.json). */
const R1 = 'cc0d5a11-0000-4000-8000-000000000100';
const R1_PAD1 = 'cc0d5a11-0000-4000-8000-000000000107';
const TRACK = 'cc0d5a11-0000-4000-8000-000000000302';
const TEXT = 'cc0d5a11-0000-4000-8000-000000000400';
const ZONE = 'cc0d5a11-0000-4000-8000-000000000500';
const SYM_R1 = 'cc0d5a11-0000-4000-8000-000000000900';
const STUB = 'cc0d5a11-0000-4000-8000-000000000305';
/** A board's internal unit is the nanometer. */
const IU_PER_MM = 1_000_000;

const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const of = async (page: Page, type: string): Promise<Ev[]> => (await events(page)).filter((e) => e.type === type);
const request = (page: Page, op: string, args?: unknown): Promise<Record<string, unknown>> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const);
const strip = ({ at, ...rest }: Ev): Omit<Ev, 'at'> => { void at; return rest; };

async function ready(page: Page, url: string, name: string): Promise<Frame | null> {
  await page.goto(url);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  if (name !== '') await expect(page.locator('#state')).toContainText(`opened ${name}`, { timeout: 120_000 });
  await page.waitForTimeout(1_500);
  return page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null;
}

/** Presses a key and waits for the next event of `type`; no KiCad window opens within a second after. */
async function pressFor(page: Page, key: Key, type: string): Promise<Omit<Ev, 'at'>> {
  const n = (await of(page, type)).length;
  const menus = (await of(page, 'ev.menu')).length;
  expect(await request(page, 'key.press', key)).toEqual({});
  await expect.poll(async () => (await of(page, type)).length, { timeout: 5_000, message: `${JSON.stringify(key)} sends ${type}` }).toBe(n + 1);
  await page.waitForTimeout(1_000);
  expect((await of(page, 'ev.menu')).length, `${JSON.stringify(key)} opens no window`).toBe(menus);
  return strip((await of(page, type)).at(-1) as Ev);
}
async function selectOnly(page: Page, uuid: string): Promise<void> {
  expect(await request(page, 'select', { uuids: [uuid] })).toEqual({});
  await expect.poll(async () => (await of(page, 'ev.selected')).at(-1)?.uuids, { timeout: 5_000 }).toEqual([uuid]);
}

test('a board frame: F8, the board check\'s key, Alt+3 and the panes\' keys are held as ev.held; E on each board kind is ev.boardProperties; E on a pad keeps KiCad\'s dialog', async ({ page }) => {
  const frame = await ready(page, '/parent.html?fixture=drc-small&frame=pcb', 'drc-small.kicad_pcb');
  expect((await of(page, 'ev.ready'))[0]?.caps).toEqual(expect.arrayContaining(['heldKeys', 'boardProperties']));
  const held: Array<[Key, string]> = [
    [{ key: 'F8', code: 'F8' }, 'common.Control.updatePcbFromSchematic'],
    [{ key: 'K', code: 'KeyK', ctrl: true, alt: true, shift: true }, 'pcbnew.DRCTool.runDRC'],
    [{ key: '3', code: 'Digit3', alt: true }, 'common.Control.show3DViewer'],
    [{ key: 'Y', code: 'KeyY', ctrl: true, alt: true, shift: true }, 'pcbnew.Control.showLayersManager'],
    [{ key: 'J', code: 'KeyJ', ctrl: true, alt: true, shift: true }, 'common.Control.showProperties'],
  ];
  for (const [key, action] of held) expect(await pressFor(page, key, 'ev.held')).toEqual({ type: 'ev.held', action });

  for (const [uuid, kind] of [[R1, 'footprint'], [TRACK, 'track'], [ZONE, 'zone'], [TEXT, 'text']] as const) {
    await selectOnly(page, uuid);
    expect(await pressFor(page, { key: 'e', code: 'KeyE' }, 'ev.boardProperties')).toEqual({ type: 'ev.boardProperties', uuid, kind });
    expect((await of(page, 'ev.selected')).at(-1)?.uuids).toEqual([uuid]);
  }
  // A check that compared with the schematic opened the hidden schematic editor: the keys still reach KiCad after it.
  expect(await request(page, 'board.check', { fill: false, parity: true, allTrackErrors: false })).toMatchObject({ parityRun: 'yes' });
  expect(await pressFor(page, { key: 'F8', code: 'F8' }, 'ev.held')).toEqual({ type: 'ev.held', action: 'common.Control.updatePcbFromSchematic' });

  // A pad: KiCad's pad dialog, as before, and no event.
  await selectOnly(page, R1_PAD1);
  const before = (await of(page, 'ev.boardProperties')).length;
  expect(await request(page, 'key.press', { key: 'e', code: 'KeyE' })).toEqual({});
  await expect.poll(async () => (await of(page, 'ev.menu')).at(-1)?.open, { timeout: 10_000 }).toBe(true);
  expect((await of(page, 'ev.boardProperties')).length).toBe(before);
  if (frame == null) return;
  // Its Cancel closes it.
  const cancel = await frame.evaluate(() => (window as unknown as { wxElementRegistry: { findAll(f: object): Array<{ centerX: number; centerY: number }> } }).wxElementRegistry.findAll({ label: 'Cancel', visible: true })[0] ?? null);
  const box = await page.locator('iframe').boundingBox();
  if (cancel == null || box == null) throw new Error('no Cancel');
  await page.mouse.click(box.x + cancel.centerX, box.y + cancel.centerY);
  await expect.poll(async () => (await of(page, 'ev.menu')).at(-1)?.open, { timeout: 10_000 }).toBe(false);
});

test('a schematic frame: F8, the checker\'s and numbering\'s keys, Ctrl+H, D and the properties pane\'s key are held; U, V and F send ev.properties with their field; Ctrl+F keeps KiCad\'s Find', async ({ page }) => {
  await ready(page, '/parent.html?fixture=drc-small&frame=sch', 'drc-small.kicad_sch');
  expect((await of(page, 'ev.ready'))[0]?.caps).toEqual(expect.arrayContaining(['heldKeys', 'properties']));
  await selectOnly(page, SYM_R1);
  const held: Array<[Key, string]> = [
    [{ key: 'F8', code: 'F8' }, 'common.Control.updatePcbFromSchematic'],
    [{ key: '7', code: 'Digit7', ctrl: true, alt: true }, 'eeschema.InspectionTool.runERC'],
    [{ key: '0', code: 'Digit0', ctrl: true, alt: true }, 'eeschema.EditorControl.annotate'],
    [{ key: 'h', code: 'KeyH', ctrl: true }, 'eeschema.EditorTool.showHierarchy'],
    [{ key: 'd', code: 'KeyD' }, 'common.Control.showDatasheet'],
    [{ key: 'J', code: 'KeyJ', ctrl: true, alt: true, shift: true }, 'common.Control.showProperties'],
  ];
  for (const [key, action] of held) expect(await pressFor(page, key, 'ev.held')).toEqual({ type: 'ev.held', action });
  for (const [key, field] of [['u', 'Reference'], ['v', 'Value'], ['f', 'Footprint']] as const) {
    await selectOnly(page, SYM_R1);
    expect(await pressFor(page, { key, code: `Key${key.toUpperCase()}` }, 'ev.properties')).toEqual({ type: 'ev.properties', uuids: [SYM_R1], sheetPath: '/', field });
  }
  // A key whose window the host does not replace yet: KiCad's Find opens, and nothing is sent.
  const heldCount = (await of(page, 'ev.held')).length;
  expect(await request(page, 'key.press', { key: 'f', code: 'KeyF', ctrl: true })).toEqual({});
  await expect.poll(async () => (await of(page, 'ev.menu')).at(-1)?.open, { timeout: 10_000 }).toBe(true);
  expect((await of(page, 'ev.held')).length).toBe(heldCount);
});

test('a double-click on a check\'s mark is ev.boardProperties of kind marker, the mark selected and KiCad\'s design rules checker closed', async ({ page }) => {
  await ready(page, '/parent.html?frame=pcb', '');
  // drc-small with its exclusion dropped, so the stub's mark is drawn alone in open board.
  await page.evaluate(async () => {
    const text = async (p: string) => (await fetch(`/fixtures/drc-small/${p}`)).text();
    const pro = JSON.parse(await text('drc-small.kicad_pro')) as { board: { design_settings: { drc_exclusions: unknown[] } } };
    pro.board.design_settings.drc_exclusions = [];
    const enc = new TextEncoder();
    const files = [
      ...await Promise.all(['drc-small.kicad_pcb', 'drc-small.kicad_sch', 'drc-small.kicad_dru'].map(async (path) => ({ path, bytes: enc.encode(await text(path)) }))),
      { path: 'drc-small.kicad_pro', bytes: enc.encode(JSON.stringify(pro)) },
    ];
    await (window as unknown as Harness).__bridge.request('project.open', { name: 'drc-small', files });
  });
  await page.waitForTimeout(1_500);
  const frame = page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null;
  const check = await request(page, 'board.check', { fill: false, parity: false, allTrackErrors: false }) as { violations: Array<{ type: string; marker: string; x: number; y: number; excluded: boolean }> };
  const mark = check.violations.find((f) => f.type === 'track_dangling');
  expect(mark?.excluded).toBe(false);
  if (frame == null) { test.info().annotations.push({ type: 'unreached', description: 'the island frame is out of Playwright\'s reach in this browser: the mark\'s place on screen was not read' }); return; }
  // The stub and the board text in view, then a double-click just inside the mark's tip (KiCad draws it from its point down and right).
  expect(await request(page, 'select', { uuids: [STUB, TEXT], zoom: true })).toEqual({});
  await page.waitForTimeout(800);
  expect(await request(page, 'key.press', { key: 'Escape', code: 'Escape' })).toEqual({});
  const v = JSON.parse(await frame.evaluate(() => String((window as unknown as { Module: { kicadCollabGetViewport(): string } }).Module.kicadCollabGetViewport()))) as { cx: number; cy: number; scale: number; w: number; h: number };
  const canvas = await frame.evaluate(() => {
    const all = [...document.querySelectorAll('canvas')].map((c) => c.getBoundingClientRect()).sort((a, b) => b.width * b.height - a.width * a.height);
    return { left: all[0].left, top: all[0].top };
  });
  const box = await page.locator('iframe').boundingBox();
  if (mark == null || box == null) throw new Error('no mark');
  const at = (mm: number) => box.x + canvas.left + v.w / 2 + (mm * IU_PER_MM - v.cx) * v.scale;
  const atY = (mm: number) => box.y + canvas.top + v.h / 2 + (mm * IU_PER_MM - v.cy) * v.scale;
  const menus = (await of(page, 'ev.menu')).length;
  await page.mouse.dblclick(at(mark.x + 0.15), atY(mark.y + 0.15));
  await expect.poll(async () => (await of(page, 'ev.boardProperties')).map(strip), { timeout: 5_000 }).toEqual([{ type: 'ev.boardProperties', uuid: mark.marker, kind: 'marker' }]);
  await expect.poll(async () => (await of(page, 'ev.selected')).at(-1)?.uuids, { timeout: 5_000 }).toEqual([mark.marker]);
  await page.waitForTimeout(1_000);
  expect((await of(page, 'ev.menu')).length).toBe(menus);
});
