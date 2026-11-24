// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// fp-i6 over the local pair (PROTOCOL.md "The footprint editor's held actions
// and the board's footprint doors"), on the fixture fpedit-small. On every
// engine: each of the 43 action names is in the engine's own strings, and a
// pcb frame without footprintEdit (engine run 14) leaves KiCad's three doors
// to KiCad. On engine run 15 (cc25): an fpedit frame with the SOIC open takes
// every footprint editor action, sends ev.held { action } once per ask,
// answers action.run held, and holds no window of KiCad's afterwards; Ctrl+S
// and Ctrl+N pressed there are held the same way; a pcb frame under
// footprintEdit takes the three doors and Ctrl+E on U1 sends ev.held for
// Open in Footprint Editor with no window of KiCad's.
import { expect, test, type Frame, type Page } from '@playwright/test';

import { ISLAND, ISLAND_ADDR } from './ports';

interface Ev { type: string; action?: string; phase?: string; caps?: string[]; uuids?: string[]; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface ToolWindowLike { wxElementRegistry: { findAll(f: object): Array<{ typeName: string; name: string }> }; kicadHostAction?: { onRequest?: (json: unknown) => boolean } }
interface Key { key: string; code: string; ctrl?: boolean; shift?: boolean; alt?: boolean }

const RUN15 = 'waits for engine run 15 (the fpedit exports of units fp-e1a to fp-e3, and fp-e7\'s kicadFootprintForEditor and kicadFootprintPushToBoard)';
const FIXTURE = 'fpedit-small';
const LIB = 'fpedit-small_parts';
const SOIC = 'SOIC-8_3.9x4.9mm_P1.27mm';
const SOIC_PATH = `/fixtures/${FIXTURE}/${LIB}.pretty/${SOIC}.kicad_mod`;
/** U1, the SOIC placed on the fixture's board (tests/fixtures/fpedit-small/fpedit-small.kicad_pcb). */
const U1 = 'f9ed1700-0000-4000-8000-000000004001';

/** The footprint editor's held actions, in an fpedit frame under fpedit (bridge/ext/fp-i6.ts). */
const FPEDIT_HELD = [
  'common.Control.save', 'common.Control.saveAs', 'common.Control.revert', 'common.Control.print', 'common.Control.quit',
  'common.Interactive.find', 'common.Control.showDatasheet', 'common.Control.showProperties', 'common.Control.showLibraryTree',
  'common.Control.show3DViewer', 'common.Control.showFootprintBrowser', 'common.Control.newLibrary', 'common.Control.addLibrary',
  'pcbnew.ModuleEditor.newFootprint', 'pcbnew.ModuleEditor.createFootprint', 'pcbnew.ModuleEditor.editFootprint',
  'pcbnew.ModuleEditor.duplicateFootprint', 'pcbnew.ModuleEditor.renameFootprint', 'pcbnew.ModuleEditor.deleteFootprint',
  'pcbnew.ModuleEditor.cutFootprint', 'pcbnew.ModuleEditor.copyFootprint', 'pcbnew.ModuleEditor.pasteFootprint',
  'pcbnew.ModuleEditor.importFootprint', 'pcbnew.ModuleEditor.exportFootprint', 'pcbnew.ModuleEditor.footprintProperties',
  'pcbnew.ModuleEditor.padTable', 'pcbnew.ModuleEditor.checkFootprint', 'pcbnew.ModuleEditor.loadFootprintFromBoard',
  'pcbnew.ModuleEditor.saveFootprintToBoard', 'pcbnew.ModuleEditor.repairFootprint', 'pcbnew.EditorControl.EditLibFpInFpEditor',
  'pcbnew.Control.previousFootprint', 'pcbnew.Control.nextFootprint', 'pcbnew.PadTool.defaultPadProperties',
  'pcbnew.PadTool.enumeratePads', 'pcbnew.PadTool.PushPadSettings', 'pcbnew.GlobalEdit.cleanupGraphics',
  'pcbnew.GlobalEdit.editTextAndGraphics', 'pcbnew.InteractiveDrawing.placeImportedGraphics',
  'pcbnew.InteractiveDrawing.placeReferenceImage', 'pcbnew.FpWizard.showWizards',
];
/** The board's doors into the footprint editor, in a pcb frame under footprintEdit. */
const BOARD_DOORS = ['pcbnew.EditorControl.EditFpInFpEditor', 'pcbnew.EditorControl.EditLibFpInFpEditor', 'common.Control.showFootprintEditor'];

const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const of = async (page: Page, type: string): Promise<Ev[]> => (await events(page)).filter((e) => e.type === type);
const request = (page: Page, op: string, args?: unknown): Promise<Record<string, unknown>> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const);
const refusal = (page: Page, op: string, args?: unknown): Promise<string> =>
  request(page, op, args).then(() => 'ok', (err: Error) => err.message.split('\n')[0].replace(/^.*?page\.evaluate:\s*/, '').replace(/^Error:\s*/, ''));
const islandFrame = (page: Page): Frame | null => page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null;

/** Boots `frame` on `fixture` (none: the frame alone) and answers ev.ready's caps. */
async function boot(page: Page, frame: 'pcb' | 'fpedit' | 'sch', fixture: string | null): Promise<string[]> {
  await page.goto(fixture == null ? `/parent.html?frame=${frame}` : `/parent.html?fixture=${fixture}&frame=${frame}`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  expect((await of(page, 'ev.state')).filter((e) => e.phase === 'fatal' || e.phase === 'blocked')).toEqual([]);
  if (fixture != null) {
    await expect(page.locator('#state')).toContainText(`opened ${fixture}.kicad_pcb`, { timeout: 120_000 });
    await page.waitForTimeout(1_500);
  }
  return (await of(page, 'ev.ready'))[0]?.caps ?? [];
}

/** KiCad's visible top level frames and dialogs. */
const windows = (frame: Frame): Promise<string[]> => frame.evaluate(() => (window as unknown as ToolWindowLike).wxElementRegistry.findAll({ visible: true }).filter((e) => /Frame|Dialog/.test(e.typeName)).map((e) => `${e.typeName}:${e.name}`).sort());
const dialogs = async (frame: Frame): Promise<string[]> => (await windows(frame)).filter((w) => /Dialog/.test(w));

/** Asks the frame's slot as the engine does: its answer and the ev.held sent for it, if any. */
async function ask(page: Page, frame: Frame, action: string): Promise<{ taken: boolean; sent: string | null }> {
  const n = (await of(page, 'ev.held')).length;
  const taken = await frame.evaluate((a) => (window as unknown as ToolWindowLike).kicadHostAction?.onRequest?.(JSON.stringify({ action: a })) === true, action);
  await page.waitForTimeout(150);
  const after = await of(page, 'ev.held');
  return { taken, sent: after.length > n ? after.at(-1)?.action ?? null : null };
}

/** Presses `key` through key.press and waits for exactly one more ev.held, which names `action`; no dialog of KiCad's opens. */
async function pressHeld(page: Page, frame: Frame, key: Key, action: string): Promise<void> {
  const n = (await of(page, 'ev.held')).length;
  await request(page, 'key.press', key);
  await expect.poll(async () => (await of(page, 'ev.held')).length, { timeout: 5_000, message: `${JSON.stringify(key)} is held` }).toBe(n + 1);
  expect((await of(page, 'ev.held')).at(-1)?.action).toBe(action);
  await page.waitForTimeout(1_000);
  expect((await of(page, 'ev.held')).length, `${action} sends once`).toBe(n + 1);
  expect(await dialogs(frame), `${action} opens no window`).toEqual([]);
}

test('every held action\'s name is in the engine\'s own strings', async ({ request: http }) => {
  // The engine the island serves (action names are ASCII, so a text read keeps them whole).
  const res = await http.get(`${ISLAND_ADDR}/current/wasm/kicad_editor/v0.2.3/kicad_editor.wasm`);
  expect(res.ok()).toBe(true);
  const wasm = await res.text();
  for (const n of [...FPEDIT_HELD, ...BOARD_DOORS]) expect(wasm.includes(n), n).toBe(true);
});

test('a pcb frame takes the board\'s three doors only under footprintEdit', async ({ page, browserName }) => {
  const caps = await boot(page, 'pcb', FIXTURE);
  expect(caps).toContain('heldKeys');
  const frame = islandFrame(page);
  test.skip(frame == null, `${browserName}: the island frame is out of Playwright's reach, so its slot cannot be asked`);
  const before = await windows(frame!);
  // A footprint editor action is never taken in a board, but the ones a board frame holds on its own
  // account: the two panes, and since island v0.2.3-cc25 Save As and Revert, Find, the two cleanup and
  // edit windows and Import Graphics (each held by its own unit in a pcb frame).
  const boardsOwn = ['common.Control.show3DViewer', 'common.Control.showProperties', 'common.Control.saveAs', 'common.Control.revert', 'common.Interactive.find',
    'pcbnew.GlobalEdit.cleanupGraphics', 'pcbnew.GlobalEdit.editTextAndGraphics', 'pcbnew.InteractiveDrawing.placeImportedGraphics'];
  const taken: string[] = [];
  for (const a of FPEDIT_HELD.filter((x) => !BOARD_DOORS.includes(x))) {
    const got = await ask(page, frame!, a);
    if (got.taken) { expect(got.sent, a).toBe(a); taken.push(a); } else expect(got, a).toEqual({ taken: false, sent: null });
  }
  expect(taken.sort()).toEqual([...boardsOwn].sort());
  if (!caps.includes('footprintEdit')) {
    // Engine run 14: KiCad keeps its doors (asked through the slot only: nothing of KiCad's is run).
    for (const a of BOARD_DOORS) expect(await ask(page, frame!, a), a).toEqual({ taken: false, sent: null });
    expect(await windows(frame!)).toEqual(before);
    return;
  }
  for (const a of BOARD_DOORS) expect(await ask(page, frame!, a), a).toEqual({ taken: true, sent: a });
  for (const a of BOARD_DOORS) expect(await refusal(page, 'action.run', { name: a }), a).toBe(`held: ${a}`);
  expect(await windows(frame!)).toEqual(before);
  // Ctrl+E on U1: KiCad's Open in Footprint Editor, held.
  expect(await request(page, 'select', { uuids: [U1] })).toEqual({});
  await pressHeld(page, frame!, { key: 'e', code: 'KeyE', ctrl: true }, 'pcbnew.EditorControl.EditFpInFpEditor');
  expect(await windows(frame!)).toEqual(before);
});

test('run 15: an fpedit frame with a footprint open takes every footprint editor action and opens no window', async ({ page, browserName }) => {
  // An fpedit frame on an engine without the fpedit exports never reaches ev.ready: a schematic frame reads them first.
  test.skip(!(await boot(page, 'sch', null)).includes('kicadFpEditOpen'), RUN15);
  const caps = await boot(page, 'fpedit', null);
  test.skip(!caps.includes('fpedit'), RUN15);
  expect(caps).toContain('heldKeys');
  const frame = islandFrame(page);
  test.skip(frame == null, `${browserName}: the island frame is out of Playwright's reach, so its slot cannot be asked`);
  // Nothing is held before a footprint is open.
  for (const a of FPEDIT_HELD.slice(0, 3)) expect(await ask(page, frame!, a), a).toEqual({ taken: false, sent: null });
  const text = await page.evaluate(async (p) => (await fetch(p)).text(), SOIC_PATH);
  await request(page, 'fpedit.open', { text, name: SOIC, lib: LIB, mode: 'library', discard: true });
  await page.waitForTimeout(1_000);
  const before = await windows(frame!);
  for (const a of FPEDIT_HELD) expect(await ask(page, frame!, a), a).toEqual({ taken: true, sent: a });
  // The board's own doors are KiCad's here (and Edit Library Footprint is the footprint editor's row).
  for (const a of BOARD_DOORS.filter((x) => !FPEDIT_HELD.includes(x))) expect(await ask(page, frame!, a), a).toEqual({ taken: false, sent: null });
  for (const a of FPEDIT_HELD) expect(await refusal(page, 'action.run', { name: a }), a).toBe(`held: ${a}`);
  expect(await windows(frame!)).toEqual(before);
  expect(await dialogs(frame!)).toEqual([]);
  // KiCad's own keys: Save and New Footprint.
  await pressHeld(page, frame!, { key: 's', code: 'KeyS', ctrl: true }, 'common.Control.save');
  await pressHeld(page, frame!, { key: 'n', code: 'KeyN', ctrl: true }, 'pcbnew.ModuleEditor.newFootprint');
  expect(await windows(frame!)).toEqual(before);
  expect((await request(page, 'fpedit.state')).name).toBe(SOIC);
});
