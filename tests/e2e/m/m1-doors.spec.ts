// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The doors table on the real engine (unit m1-i): every action of
// bridge/ext/contextMenuDoors.json whose door is run, pressed through
// action.run on the canvas-kinds fixture with a fitting selection, opens no
// window of KiCad's (no visible dialog, ev.menu never open). On engine run 14
// action.run has no engine export: each answers unsupported naming it and
// opens nothing either. The presses wait for engine run 15 (kicadRunAction).
import { expect, test, type Frame, type Page } from '@playwright/test';

import { ISLAND } from '../ports';
import TABLE from '../../../bridge/ext/contextMenuDoors.json' with { type: 'json' };

interface Ev { type: string; open?: boolean; caps?: string[]; phase?: string; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Row { action: string; door: string; menus: string[] }
type Answer = { error?: { code: string; message: string } } & Record<string, unknown>;

const FIXTURE = 'canvas-kinds';
const RUN15 = 'waits for the engine export kicadRunAction (engine run 15, kicad cc/main K-MENU)';
const ROWS = (TABLE as { rows: Row[] }).rows.filter((r) => r.door === 'run');
/** The frame a row's menus belong to, and the selection that fits it. */
const SELECTION: Record<string, string[]> = {
  sch: ['cc0ca4d5-0000-4000-8000-000000000101'],
  pcb: [],
};
const frameOf = (r: Row): 'sch' | 'pcb' | null =>
  r.menus.some((m) => m.startsWith('eeschema/')) ? 'sch' : r.menus.some((m) => m.startsWith('pcbnew/')) ? 'pcb' : null;

const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const request = (page: Page, op: string, args?: unknown): Promise<Answer> =>
  page.evaluate(async ([o, a]) => {
    try { return await (window as unknown as Harness).__bridge.request(o as string, a); } catch (e) {
      // The harness rejects with "<code>: <message>".
      const m = /^([a-z_]+): ([\s\S]*)$/.exec(String((e as { message?: string }).message ?? e));
      return { error: { code: m?.[1] ?? 'thrown', message: m?.[2] ?? String(e) } };
    }
  }, [op, args] as const);
const islandFrame = (page: Page): Frame | null => page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null;
/** KiCad's visible dialogs in the frame. */
const dialogs = (frame: Frame): Promise<string[]> => frame.evaluate(() =>
  ((window as unknown as { wxElementRegistry?: { findAll(f: object): Array<{ typeName: string; name: string }> } }).wxElementRegistry?.findAll({ visible: true }) ?? [])
    .filter((e) => /Dialog/.test(e.typeName)).map((e) => `${e.typeName}:${e.name}`));

async function open(page: Page, frame: 'sch' | 'pcb'): Promise<string[]> {
  await page.goto(`/parent.html?frame=${frame}&fixture=${FIXTURE}`);
  await page.waitForFunction(() => /opened |open failed|state (blocked|fatal)/.test(document.getElementById('state')?.textContent ?? ''), null, { timeout: 170_000 });
  expect(await page.textContent('#state')).toContain(`opened ${FIXTURE}.kicad_${frame}`);
  await page.waitForTimeout(1_500);
  return (await events(page)).find((e) => e.type === 'ev.ready')?.caps ?? [];
}

/** Presses every run row of the frame's kind through action.run and checks nothing of KiCad's showed. */
async function pressAll(page: Page, kind: 'sch' | 'pcb', run15: boolean): Promise<void> {
  const frame = islandFrame(page)!;
  for (const r of ROWS.filter((x) => frameOf(x) === kind || frameOf(x) == null)) {
    if (SELECTION[kind].length > 0) await request(page, 'select', { uuids: SELECTION[kind] });
    const menus = (await events(page)).filter((e) => e.type === 'ev.menu').length;
    const answer = await request(page, 'action.run', { name: r.action });
    if (!run15) expect(answer, r.action).toEqual({ error: { code: 'unsupported', message: 'kicadRunAction' } });
    else expect(answer.error, r.action).toBeUndefined();
    await page.waitForTimeout(run15 ? 800 : 100);
    expect(await dialogs(frame), r.action).toEqual([]);
    expect((await events(page)).filter((e) => e.type === 'ev.menu').slice(menus).some((e) => e.open === true), r.action).toBe(false);
    // An interactive tool a run row starts (a junction's placement) is left as Escape leaves it.
    if (run15) await request(page, 'key.press', { key: 'Escape', code: 'Escape' });
  }
}

for (const kind of ['sch', 'pcb'] as const) {
  test(`engine run 14: every run door of a ${kind} frame answers unsupported and opens nothing`, async ({ page }) => {
    const caps = await open(page, kind);
    test.skip(caps.includes('contextMenu'), 'this engine has kicadRunAction: the run 15 test presses each door');
    await pressAll(page, kind, false);
  });

  test(`engine run 15: every run door of a ${kind} frame, pressed through action.run, opens no window of KiCad's`, async ({ page }) => {
    const caps = await open(page, kind);
    test.skip(!caps.includes('contextMenu'), RUN15);
    await pressAll(page, kind, true);
  });
}
