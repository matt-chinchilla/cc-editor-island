// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// m1x-i over the local pair (PROTOCOL.md, Prompts) on the canvas-kinds
// fixture (unit m1-fx). On engine run 14 the engine has none of K-PROMPT's
// exports: the cap prompts is absent, the three ops are listed in
// island.json and answer unsupported naming the export, the frame's slot
// declines every ask, and KiCad's two resolution reports are held under the
// rules cap. The recipe's run 15 steps wait for engine run 15 (kicad cc/main
// K-PROMPT, pcbjam kicadHostPrompts) and are skipped here with the exports
// they wait for.
import { expect, test, type Frame, type Page } from '@playwright/test';

import { ISLAND } from '../ports';

interface Ev { type: string; caps?: string[]; token?: number; ask?: string; modal?: boolean; frame?: string; reason?: string; record?: Record<string, unknown>; depth?: number; action?: string; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
type Answer = { ok?: boolean; error?: { code: string; message: string } } & Record<string, unknown>;

const FIXTURE = 'canvas-kinds';
const FP_R1 = 'cc0ca4d5-0000-4000-8000-000000000301';
const TRACK_A = 'cc0ca4d5-0000-4000-8000-000000000310';
const TRACK_B = 'cc0ca4d5-0000-4000-8000-000000000311';
const TRACK_LOCKED = 'cc0ca4d5-0000-4000-8000-000000000312';
const LINE_A = 'cc0ca4d5-0000-4000-8000-000000000332';
const LINE_B = 'cc0ca4d5-0000-4000-8000-000000000333';
const RUN15 = 'waits for the engine exports kicadHostPrompts, kicadPromptAnswer, kicadPromptCancel and kicadPromptPick (engine run 15, kicad cc/main K-PROMPT) and kicadRunAction (K-MENU)';
const OPS = ['prompt.answer', 'prompt.cancel', 'prompt.pick'];
const HELD = ['pcbnew.InspectionTool.InspectClearance', 'pcbnew.InspectionTool.InspectConstraints'];

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

async function open(page: Page, frame: 'sch' | 'pcb'): Promise<string[]> {
  await page.goto(`/parent.html?frame=${frame}&fixture=${FIXTURE}`);
  await page.waitForFunction(() => /opened |open failed|state (blocked|fatal)/.test(document.getElementById('state')?.textContent ?? ''), null, { timeout: 170_000 });
  expect(await page.textContent('#state')).toContain(`opened ${FIXTURE}.kicad_${frame}`);
  await page.waitForTimeout(1_500);
  return (await of(page, 'ev.ready'))[0]?.caps ?? [];
}

/** Selects `uuids`, runs `action` and waits for its one ev.prompt. */
async function ask(page: Page, uuids: string[], action: string): Promise<Ev> {
  const before = (await of(page, 'ev.prompt')).length;
  expect(await request(page, 'select', { uuids, zoom: true })).toEqual({});
  await page.waitForTimeout(600);
  expect(await request(page, 'action.run', { name: action })).toEqual({});
  await expect.poll(async () => (await of(page, 'ev.prompt')).length - before, { timeout: 10_000 }).toBe(1);
  return (await of(page, 'ev.prompt')).at(-1)!;
}

test.describe('engine run 14: the ops are listed and refuse cleanly, the reports are held', () => {
  test('island.json lists the three ops', async ({ page }) => {
    const res = await page.goto(`${ISLAND}/island.json`);
    const island = (await res!.json()) as { ops?: string[] };
    for (const op of OPS) expect(island.ops ?? []).toContain(op);
  });

  test('a pcb frame: no prompts cap, the ops answer unsupported, the slot declines', async ({ page }) => {
    const caps = await open(page, 'pcb');
    test.skip(caps.includes('prompts'), 'this engine has K-PROMPT: the run 15 tests below cover it');
    expect(await request(page, 'prompt.answer', { token: 1, values: { value: 1 } })).toEqual({ error: { code: 'unsupported', message: 'kicadPromptAnswer' } });
    expect(await request(page, 'prompt.cancel', { token: 1 })).toEqual({ error: { code: 'unsupported', message: 'kicadPromptCancel' } });
    expect(await request(page, 'prompt.pick', { token: 1, kind: 'point' })).toEqual({ error: { code: 'unsupported', message: 'kicadPromptPick' } });
    expect(await request(page, 'prompt.cancel', { token: 'x' })).toEqual({ error: { code: 'bad_args', message: 'prompt.cancel' } });
    const frame = islandFrame(page);
    const record = { title: 'Fillet Tracks', fields: [{ key: 'value', label: 'Radius:', kind: 'length', value: 1, tip: '' }] };
    expect(await frame!.evaluate((r) => (window as unknown as { kicadHostPrompt?: { onAsk?: (j: unknown) => boolean } }).kicadHostPrompt?.onAsk?.(JSON.stringify({ token: 1, ask: 'entry', modal: true, record: r })), record)).toBe(false);
    expect(await of(page, 'ev.prompt')).toEqual([]);
    expect(await request(page, 'key.press', { key: 'Home', code: 'Home' })).toEqual({});
  });

  test('a pcb frame: KiCad\'s Clearance and Constraints reports are held under the rules cap', async ({ page }) => {
    const caps = await open(page, 'pcb');
    test.skip(!caps.includes('rules'), 'this engine lists no rules cap: the reports are not held here');
    // action.run refuses a held action before the engine (m1-i): the host opens its own door.
    for (const name of HELD) expect(await request(page, 'action.run', { name })).toEqual({ error: { code: 'held', message: name } });
  });
});

test.describe('engine run 15: prompts', () => {
  test('Fillet Tracks asks entry: a cancel edits nothing, an answer edits once, key.press is busy meanwhile', async ({ page }) => {
    const caps = await open(page, 'pcb');
    test.skip(!caps.includes('prompts') || !caps.includes('contextMenu'), RUN15);
    const first = await ask(page, [TRACK_A, TRACK_B], 'pcbnew.InteractiveEdit.filletTracks');
    expect(first).toMatchObject({ ask: 'entry', modal: true, frame: 'pcb' });
    const fields = (first.record as { fields: Array<{ key: string; kind: string }> }).fields;
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ key: 'value', kind: 'length' });
    expect(await request(page, 'key.press', { key: 'Home', code: 'Home' })).toEqual({ error: { code: 'busy', message: 'key.press' } });
    const before = (await of(page, 'ev.edited')).length;
    expect(await request(page, 'prompt.cancel', { token: first.token })).toEqual({});
    await page.waitForTimeout(1_500);
    expect((await of(page, 'ev.edited')).length).toBe(before);
    expect(await of(page, 'ev.promptEnd')).toEqual([]);
    expect(await request(page, 'prompt.cancel', { token: first.token })).toEqual({ error: { code: 'stale', message: 'prompt.cancel' } });
    const second = await ask(page, [TRACK_A, TRACK_B], 'pcbnew.InteractiveEdit.filletTracks');
    expect(await request(page, 'prompt.answer', { token: second.token, values: { value: 1 } })).toEqual({ accepted: true });
    await expect.poll(async () => (await of(page, 'ev.edited')).length - before, { timeout: 10_000 }).toBe(1);
    expect(await of(page, 'ev.promptEnd')).toEqual([]);
    expect(await request(page, 'prompt.answer', { token: second.token, values: { value: 1 } })).toEqual({ error: { code: 'stale', message: 'prompt.answer' } });
    expect(await request(page, 'key.press', { key: 'Home', code: 'Home' })).toEqual({});
  });

  test('a refusal keeps the prompt up with KiCad\'s field and message; project.forget ends it gone', async ({ page }) => {
    const caps = await open(page, 'pcb');
    test.skip(!caps.includes('prompts') || !caps.includes('contextMenu'), RUN15);
    const p = await ask(page, [LINE_A, LINE_B], 'pcbnew.InteractiveEdit.dogboneCorners');
    expect(p).toMatchObject({ ask: 'entry', modal: true });
    const fields = (p.record as { fields: Array<{ key: string; kind: string }> }).fields;
    expect(fields[0]).toMatchObject({ key: 'f0', kind: 'length' });
    const refused = await request(page, 'prompt.answer', { token: p.token, values: { f0: -1 } });
    expect(refused.accepted).toBe(false);
    expect(typeof refused.field).toBe('string');
    expect(typeof refused.message).toBe('string');
    expect(refused.message).not.toBe('');
    // Still parked: the frame is busy, and project.forget ends it for the host.
    expect(await request(page, 'key.press', { key: 'Home', code: 'Home' })).toEqual({ error: { code: 'busy', message: 'key.press' } });
    expect(await request(page, 'project.forget')).toEqual({});
    const ends = await of(page, 'ev.promptEnd');
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ token: p.token, reason: 'gone' });
  });

  test('D on a locked track asks message with ok and cancel; a cancel leaves the track', async ({ page }) => {
    const caps = await open(page, 'pcb');
    test.skip(!caps.includes('prompts'), RUN15);
    expect(await request(page, 'select', { uuids: [TRACK_LOCKED], zoom: true })).toEqual({});
    await page.waitForTimeout(600);
    const before = (await of(page, 'ev.edited')).length;
    expect(await request(page, 'key.press', { key: 'd', code: 'KeyD' })).toEqual({});
    await expect.poll(async () => (await of(page, 'ev.prompt')).length, { timeout: 10_000 }).toBe(1);
    const [m] = await of(page, 'ev.prompt');
    expect(m.ask).toBe('message');
    const ids = (m.record as { buttons: Array<{ id: string }> }).buttons.map((b) => b.id);
    expect(ids).toEqual(expect.arrayContaining(['ok', 'cancel']));
    expect(await request(page, 'prompt.answer', { token: m.token, button: 'maybe' })).toEqual({ accepted: false, field: 'button', message: '' });
    expect(await request(page, 'prompt.cancel', { token: m.token })).toEqual({});
    await request(page, 'key.press', { key: 'Escape', code: 'Escape' });
    await page.waitForTimeout(1_500);
    expect((await of(page, 'ev.edited')).length).toBe(before);
  });

  test('Inspect Constraints with R1 selected: held, no window', async ({ page }) => {
    const caps = await open(page, 'pcb');
    test.skip(!caps.includes('prompts') || !caps.includes('rules'), RUN15);
    expect(await request(page, 'select', { uuids: [FP_R1], zoom: true })).toEqual({});
    expect(await request(page, 'action.run', { name: 'pcbnew.InspectionTool.InspectConstraints' })).toEqual({ error: { code: 'held', message: 'pcbnew.InspectionTool.InspectConstraints' } });
    await page.waitForTimeout(1_000);
    expect(await of(page, 'ev.menu')).toEqual(expect.not.arrayContaining([expect.objectContaining({ open: true })]));
  });
});
