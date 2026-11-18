// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The canvas-kinds fixture (tests/fixtures/canvas-kinds, unit m1-fx) on the
// real engine: it opens in a sch frame and a pcb frame with project.open, the
// frame's own reads answer what section 11 of the canvas addendum puts in it
// (sheet.tree lists the root and the child; board.item.get answers every
// board item by its fixed uuid, each as wave 1's kinds), and a save through
// the engine writes every file back byte for byte, which holds the fixture to
// KiCad's own normalized form. Nothing here waits for a later engine.
import { expect, test, type Page } from '@playwright/test';

interface Ev { type: string; phase?: string; caps?: string[]; at: number }
interface Harness { __events: Ev[]; __saved: Record<string, Uint8Array>; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Id { uuid: string; file: string; kind: string }
type Sheet = Record<string, unknown> & { kind: string; uuid: string; type?: string };

const FIXTURE = 'canvas-kinds';
const SCH_FILES = ['canvas-kinds.kicad_pro', 'canvas-kinds.kicad_sch', 'child.kicad_sch'];
const PCB_FILES = ['canvas-kinds.kicad_pcb'];
/** ids.json's board kinds as board.item.get answers them: a kind of its own, or other with a type. */
const BOARD_ANSWER: Record<string, { kind: string; type?: string }> = {
  footprint: { kind: 'footprint' }, track: { kind: 'track' }, arc: { kind: 'arc' }, via: { kind: 'via' }, zone: { kind: 'zone' }, text: { kind: 'text' },
  rulearea: { kind: 'other', type: 'rulearea' }, shape: { kind: 'other', type: 'shape' }, dimension: { kind: 'other', type: 'dimension' },
  textbox: { kind: 'other', type: 'textbox' }, table: { kind: 'other', type: 'table' }, tablecell: { kind: 'other', type: 'table' }, group: { kind: 'other', type: 'group' },
};

function measure(type: string, description: string): void {
  test.info().annotations.push({ type, description });
  console.log(`[measure] ${type}: ${description}`);
}
const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const request = (page: Page, op: string, args?: unknown): Promise<Record<string, unknown>> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const);
const ids = (page: Page): Promise<Record<string, Id>> => page.evaluate(async (f) => (await fetch(`/fixtures/${f}/ids.json`)).json(), FIXTURE);

/** Boots the frame with the fixture and waits for its open. */
async function open(page: Page, frame: 'sch' | 'pcb'): Promise<Ev | undefined> {
  await page.goto(`/parent.html?frame=${frame}&fixture=${FIXTURE}`);
  await page.waitForFunction(() => /opened |open failed|state (blocked|fatal)/.test(document.getElementById('state')?.textContent ?? ''), null, { timeout: 170_000 });
  expect(await page.textContent('#state')).toContain(`opened ${FIXTURE}.kicad_${frame}`);
  return (await events(page)).find((e) => e.type === 'ev.ready');
}

/** Saves through the engine and answers, per file, whether the bytes it wrote are the fixture's. */
async function saveAndCompare(page: Page): Promise<{ saved: string[]; same: Record<string, boolean> }> {
  const r = await request(page, 'project.save');
  const saved = [...(r.saved as string[])].sort();
  const same = await page.evaluate(async ([f, paths]) => {
    const out: Record<string, boolean> = {};
    for (const p of paths) {
      const want = new Uint8Array(await (await fetch(`/fixtures/${f}/${p}`)).arrayBuffer());
      const got = (window as unknown as Harness).__saved[p];
      out[p] = got != null && got.byteLength === want.byteLength && got.every((b, i) => b === want[i]);
    }
    return out;
  }, [FIXTURE, saved] as const);
  return { saved, same };
}

test('the schematic opens, its sheet tree holds the root and the child, and a save writes every file back unchanged', async ({ page }) => {
  await open(page, 'sch');
  const tree = await request(page, 'sheet.tree');
  expect(tree).toEqual({
    current: '/',
    currentFile: 'canvas-kinds.kicad_sch',
    sheets: [
      { path: '/', name: 'canvas-kinds', page: '1', depth: 0, parent: '', file: 'canvas-kinds.kicad_sch' },
      { path: '/cc0ca4d5-0000-4000-8000-000000000150/', name: 'child', page: '2', depth: 1, parent: '/', file: 'child.kicad_sch' },
    ],
  });
  const t0 = Date.now();
  const { saved, same } = await saveAndCompare(page);
  measure('project.save, the canvas-kinds schematic', `${Date.now() - t0} ms, ${saved.join(', ')}`);
  expect(saved).toEqual(SCH_FILES);
  expect(same).toEqual(Object.fromEntries(SCH_FILES.map((p) => [p, true])));
});

test('the board opens, board.item.get answers every item by its fixed uuid, and a save writes the board back unchanged', async ({ page }) => {
  const ready = await open(page, 'pcb');
  expect(ready?.caps).toEqual(expect.arrayContaining(['boardItem']));
  const board = Object.values(await ids(page)).filter((i) => i.file === 'canvas-kinds.kicad_pcb');
  expect(board.length).toBeGreaterThan(20);
  const answer = (await request(page, 'board.item.get', { uuids: board.map((i) => i.uuid) })).items as Sheet[];
  expect(answer.map((s) => s.uuid)).toEqual(board.map((i) => i.uuid));
  for (const [i, s] of board.map((it, n) => [it, answer[n]] as const)) {
    // A table cell answers under its own uuid, as other with the type table.
    const want = BOARD_ANSWER[i.kind];
    expect(want, `ids.json kind ${i.kind}`).toBeDefined();
    expect({ uuid: s.uuid, kind: s.kind, type: s.type }).toEqual({ uuid: i.uuid, kind: want.kind, type: want.type });
  }
  const byUuid = new Map(answer.map((s) => [s.uuid, s]));
  const kinds = [...new Set(answer.map((s) => (s.kind === 'other' ? s.type : s.kind)))];
  measure('board.item.get kinds', kinds.join(', '));
  for (const k of ['footprint', 'track', 'arc', 'via', 'zone', 'text', 'table', 'group', 'rulearea', 'dimension', 'textbox']) expect(kinds).toContain(k);
  // The locked items the locked-item messages need: the footprint R2 and one track.
  expect(byUuid.get('cc0ca4d5-0000-4000-8000-000000000303')).toMatchObject({ kind: 'footprint', ref: 'R2', locked: true });
  expect(byUuid.get('cc0ca4d5-0000-4000-8000-000000000312')).toMatchObject({ kind: 'track', locked: true });
  expect(byUuid.get('cc0ca4d5-0000-4000-8000-000000000302')).toMatchObject({ kind: 'footprint', ref: 'U1', libId: 'Package_SO:SOIC-14_3.9x8.7mm_P1.27mm' });
  const t0 = Date.now();
  const { saved, same } = await saveAndCompare(page);
  measure('project.save, the canvas-kinds board', `${Date.now() - t0} ms`);
  expect(saved).toEqual(PCB_FILES);
  expect(same).toEqual({ 'canvas-kinds.kicad_pcb': true });
});
