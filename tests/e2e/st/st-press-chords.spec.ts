// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The chord ledger of wave 2 (theme/pencil-tools.gen.mjs, the small tools spec 6.3)
// over the local pair. Gate 0.1: the pool is per editor, so a schematic action and a
// board action may share a chord; KiCad's ACTION_MANAGER::RunHotKey asks the page
// (window.kicadHostAction.onRequest, our engine run 12) before each RunAction it
// tries, so a probe around that slot records which actions a press tried and which
// ran: the frame's own action is the last one asked, a foreign one only before it
// (tried, not handled). Gate 0.2: every new row's key pressed once in its frame on
// Glasgow opens no window but the five the spec expects (the three microwave value
// entries, the microwave shape dialog, the auto-place progress box), each recorded
// by title and wx type and closed; no press is held (ev.held) and no popup menu
// comes (ev.menu). The footprint editor's and the drawing sheet editor's rows run
// in their own frames once those frames exist (fp-i1, ds-i1: ev.ready lists
// fpedit, dsedit); before that they are skipped.
import { expect, test, type Frame, type Page } from '@playwright/test';

import tableJson from '../../../theme/pencil-tools.json' with { type: 'json' };
import defaultsJson from '../../../theme/pencil-tools.defaults.json' with { type: 'json' };
import { OFF_LAYOUT, poolsOf } from '../../../theme/pencil-tools.gen.mjs';
import { HELD_ACTIONS } from '../../../bridge/held';
import { ISLAND } from '../ports';

interface Ev { type: string; phase?: string; open?: boolean; caps?: string[]; action?: string; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Row { editor: string; strip: string; action: string; defaultKey: string | null; seededKey: string | null; press?: 'run' }
interface Key { key: string; code: string; ctrl?: boolean; shift?: boolean; alt?: boolean }
interface Wx { typeName: string; label: string; x: number; y: number }
type ProbeWindow = Window & { __asked?: string[]; kicadHostAction?: { onRequest(json: unknown): boolean } };
type ToolWindowLike = Window & { wxElementRegistry: { findAll(f: object): Array<{ typeName: string; label: string; centerX: number; centerY: number }> } };

const TABLE = tableJson as Row[];
const DEFAULTS = defaultsJson as Record<string, string | null>;
/** The rows the wave 2 run added (OFF_LAYOUT after Fill All Zones), by editor. */
const WAVE = OFF_LAYOUT.slice(1);
const keyOf = (r: Row): string | null => (r.press === 'run' ? null : (r.defaultKey ?? r.seededKey));
const waveRows = (editor: string): Row[] => WAVE.filter((o) => o.editor === editor).map((o) => TABLE.find((r) => r.editor === editor && r.action === o.action)!).filter((r) => keyOf(r) != null);
/** The actions whose press may open a window on an engine before run 15 (gate 0.2): st-mw-e and st-ap-e close them on run 15. */
const MAY_OPEN = new Set(['pcbnew.MicrowaveTool.createGap', 'pcbnew.MicrowaveTool.createStub', 'pcbnew.MicrowaveTool.createStubArc', 'pcbnew.MicrowaveTool.createFunctionShape', 'pcbnew.Autoplacer.autoplaceOffboard', 'pcbnew.Autoplacer.autoplaceSelected']);
/** Rows whose action is always enabled (display toggles): their press must run them, the strict half of gate 0.1. */
const ALWAYS_ON = new Set(['pcbnew.Control.flipBoard', 'pcbnew.Control.graphicOutlines', 'pcbnew.Control.textOutlines', 'common.Control.highContrastModeCycle', 'pcbnew.Control.layerAlphaDec', 'pcbnew.Control.layerAlphaInc', 'eeschema.EditorControl.showHiddenFields', 'eeschema.EditorControl.showDirectiveLabels', 'eeschema.EditorControl.showERCErrors', 'eeschema.EditorControl.showERCWarnings', 'eeschema.EditorControl.showERCExclusions', 'eeschema.EditorControl.togglePinAltIcons', 'eeschema.EditorControl.markSimExclusions']);

const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const of = async (page: Page, type: string): Promise<Ev[]> => (await events(page)).filter((e) => e.type === type);
const request = (page: Page, op: string, args?: unknown): Promise<Record<string, unknown>> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const);

/** A measurement the report quotes: kept as an annotation and printed by the list reporter. */
function measure(type: string, description: string): void {
  test.info().annotations.push({ type, description });
  console.log(`[measure] ${type}: ${description}`);
}

/** A chord as key.press sends it: KiCad's name ("Ctrl+Alt+Shift+K", "H", "Ctrl+Alt+F1") to its key, code and modifiers. */
function keyArgs(chord: string): Key {
  const parts = chord.split('+');
  const last = parts.pop()!;
  const code = /^[0-9]$/.test(last) ? `Digit${last}` : /^[A-Z]$/.test(last) ? `Key${last}` : last;
  const shift = parts.includes('Shift');
  const key = /^[A-Z]$/.test(last) && !shift ? last.toLowerCase() : last;
  return { key, code, ctrl: parts.includes('Ctrl'), shift, alt: parts.includes('Alt') };
}

async function boot(page: Page, query: string, opened: string | null): Promise<Frame> {
  await page.goto(`/parent.html?${query}`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  expect((await of(page, 'ev.state')).filter((e) => e.phase === 'blocked' || e.phase === 'fatal')).toEqual([]);
  if (opened != null) await expect(page.locator('#state')).toContainText(`opened ${opened}`, { timeout: 120_000 });
  await page.waitForTimeout(1_500);
  const frame = page.frames().find((f) => f.url().startsWith(`${ISLAND}/`));
  if (frame == null) throw new Error('no island frame');
  // The probe around the engine's slot: every action a hotkey tries, in order; the island's answer stands.
  await frame.evaluate(() => {
    const w = window as unknown as ProbeWindow;
    const slot = w.kicadHostAction;
    if (slot == null) throw new Error('no kicadHostAction slot: this engine asks nothing before a hotkey');
    w.__asked = [];
    const orig = slot.onRequest.bind(slot);
    slot.onRequest = (json: unknown): boolean => {
      try { w.__asked!.push(String(JSON.parse(String(json)).action)); } catch { w.__asked!.push('?'); }
      return orig(json);
    };
  });
  return frame;
}

const asked = (frame: Frame): Promise<string[]> => frame.evaluate(() => (window as unknown as ProbeWindow).__asked!.splice(0));
const dialogs = (frame: Frame): Promise<Wx[]> =>
  frame.evaluate(() => (window as unknown as ToolWindowLike).wxElementRegistry.findAll({ visible: true }).filter((e) => /Dialog/.test(e.typeName)).map((e) => ({ typeName: e.typeName, label: e.label, x: e.centerX, y: e.centerY })));
const buttons = (frame: Frame, label: string): Promise<Wx[]> =>
  frame.evaluate((l) => (window as unknown as ToolWindowLike).wxElementRegistry.findAll({ visible: true, label: l }).map((e) => ({ typeName: e.typeName, label: e.label, x: e.centerX, y: e.centerY })), label);

async function clickIn(page: Page, x: number, y: number): Promise<void> {
  const box = await page.locator('iframe').boundingBox();
  if (box == null) throw new Error('no iframe box');
  await page.mouse.click(box.x + x, box.y + y);
}

/** Closes every KiCad window up (its Cancel), at most four in turn, then leaves any tool the press started. */
async function settle(page: Page, frame: Frame): Promise<void> {
  for (let i = 0; i < 4 && (await dialogs(frame)).length > 0; i++) {
    const [cancel] = (await Promise.all(['Cancel', '&Cancel', 'Close', '&Close'].map((l) => buttons(frame, l)))).flat();
    if (cancel == null) break;
    await clickIn(page, cancel.x, cancel.y);
    await page.waitForTimeout(800);
  }
  expect(await dialogs(frame), 'every window closed').toEqual([]);
  for (let i = 0; i < 2; i++) expect(await request(page, 'key.press', { key: 'Escape', code: 'Escape' })).toEqual({});
  await page.waitForTimeout(300);
  await asked(frame);
}

interface Outcome { action: string; chord: string; asked: string[]; windows: string[] }

/** One press of a row's chord in its frame: what it tried, what opened, then everything closed again. */
async function pressRow(page: Page, frame: Frame, editor: string, action: string, chord: string): Promise<Outcome> {
  const held = (await of(page, 'ev.held')).length;
  const menus = (await of(page, 'ev.menu')).filter((e) => e.open === true).length;
  const box = await page.locator('iframe').boundingBox();
  await page.mouse.move(box!.x + 900, box!.y + 600, { steps: 2 });
  await asked(frame);
  expect(await request(page, 'key.press', keyArgs(chord)), `${editor} ${action} ${chord}`).toEqual({});
  // Sampled while the press settles, so a window that comes and goes is named too.
  const seen = new Set<string>();
  for (let t = 0; t < 12; t++) {
    for (const d of await dialogs(frame)) seen.add(`${d.typeName} "${d.label}"`);
    if (await frame.evaluate(() => document.querySelector('.wx-menu-popup') != null)) seen.add('a popup menu');
    await page.waitForTimeout(100);
  }
  const tried = await asked(frame);
  const windows = [...seen];
  // A progress box comes and goes: ev.menu counts it while up.
  const menusAfter = (await of(page, 'ev.menu')).filter((e) => e.open === true).length;
  if (menusAfter > menus && windows.length === 0) windows.push('a window that came and went (ev.menu)');
  expect((await of(page, 'ev.held')).length, `${editor} ${action} ${chord} is held by nothing`).toBe(held);
  await settle(page, frame);
  return { action, chord, asked: tried, windows };
}

/** Gate 0.1 and 0.2 for one frame's rows; then the chords those rows share with the other editor, pressed here. */
async function pressAll(page: Page, frame: Frame, editor: string, rows: Row[]): Promise<void> {
  const out: Outcome[] = [];
  for (const r of rows) out.push(await pressRow(page, frame, editor, r.action, keyOf(r)!));
  for (const o of out) measure(`${editor} ${o.chord}`, `${o.action}: asked ${o.asked.join(', ') || 'nothing'}${o.windows.length > 0 ? `; window ${o.windows.join(', ')}` : ''}`);
  for (const o of out) {
    // Gate 0.2: a window only where the spec expects one (every press is reported before the first finding).
    if (o.windows.length > 0) expect.soft(MAY_OPEN.has(o.action), `${o.action} opened ${o.windows.join(', ')}`).toBe(true);
    // Gate 0.1: the frame's own action is the last one tried, every foreign one before it; a display toggle always runs.
    // Rows of this frame that share KiCad's one default chord are a context pair (Explode Pad and Recombine Pad on
    // Ctrl+E: KiCad runs the one its state allows), so either of them may be the frame's own action tried.
    const pair = new Set([o.action, ...rows.filter((r) => keyOf(r) === o.chord).map((r) => r.action)]);
    const at = Math.max(...[...pair].map((a) => o.asked.lastIndexOf(a)));
    if (ALWAYS_ON.has(o.action)) expect.soft(o.asked.indexOf(o.action), `${o.action} ran on ${o.chord}`).toBe(o.asked.length - 1);
    if (o.asked.length > 0 && at < 0) expect.soft(o.asked.every((a) => !poolsOf(a).includes(poolOf(editor))), `${o.chord} ran another ${editor} action: ${o.asked.join(', ')}`).toBe(true);
  }
}

const poolOf = (editor: string): 'sch' | 'pcb' | 'ds' => (editor === 'sch' ? 'sch' : editor === 'ds' ? 'ds' : 'pcb');

/** The rows of this editor (built in or new) whose seeded chord a new row of the other editor's pool shares. */
function sharedWithOther(editor: 'sch' | 'pcb'): Row[] {
  const other = editor === 'sch' ? 'pcb' : 'sch';
  const fresh = new Set(waveRows(other).map((r) => r.seededKey).filter((k): k is string => k != null));
  const mine = TABLE.filter((r) => r.editor === editor && r.seededKey != null && fresh.has(r.seededKey));
  return mine.filter((r, i) => mine.findIndex((x) => x.action === r.action) === i && !WAVE.some((o) => o.editor === editor && o.action === r.action) && !OPENS_A_CHOOSER.has(r.action));
}
/**
 * Built in rows whose press opens a window of KiCad's own before the wave (a file chooser
 * out of the registry's reach, the sheet pin sync dialog, measured 2026-11-18 on engine
 * run 14): not pressed here, as no wave chord is theirs.
 */
const OPENS_A_CHOOSER = new Set(['eeschema.InteractiveDrawing.placeImage', 'pcbnew.InteractiveDrawing.placeReferenceImage', 'eeschema.InteractiveDrawing.syncAllSheetsPins']);

test.describe('the wave 2 chord ledger', () => {
  test('no chord is two actions\' in one frame, and no new row\'s chord is a held action\'s key', () => {
    for (const editor of ['sch', 'pcb', 'fpedit', 'ds']) {
      const owner = new Map<string, string>();
      for (const r of TABLE.filter((x) => x.editor === editor && x.seededKey)) {
        expect(owner.get(r.seededKey!) ?? r.action, `${editor} ${r.seededKey}`).toBe(r.action);
        owner.set(r.seededKey!, r.action);
      }
      const held = HELD_ACTIONS.filter((h) => (h.frames as readonly string[]).includes(editor));
      for (const r of waveRows(editor)) {
        for (const h of held.filter((x) => x.action !== r.action)) {
          const theirs = [DEFAULTS[h.action], TABLE.find((x) => x.action === h.action && x.seededKey)?.seededKey].filter((k) => k != null);
          expect(theirs, `${editor} ${r.action} against ${h.action}`).not.toContain(keyOf(r));
        }
      }
    }
    expect(WAVE).toHaveLength(88);
  });

  for (const editor of ['sch', 'pcb'] as const) {
    test(`${editor === 'sch' ? 'the schematic' : 'the board'} on Glasgow: each new chord runs its own action and opens no window but the expected`, async ({ page, browserName }) => {
      // Playwright's Firefox reaches no context in the cross-site island frame since the local pair moved (2026-10-26), and the probe lives there.
      test.skip(browserName === 'firefox', 'Playwright Firefox reaches no context in the cross-site island frame');
      test.setTimeout(480_000);
      const frame = await boot(page, `fixture=glasgow&frame=${editor}`, `glasgow.kicad_${editor}`);
      expect((await of(page, 'ev.ready'))[0]?.caps).toContain('heldKeys');
      const rows = waveRows(editor);
      expect(rows.length).toBe(editor === 'sch' ? 7 : 17);
      // The other half of gate 0.1 first: this editor's own chords that a new row of the other editor now shares still run here.
      const shared = sharedWithOther(editor);
      measure(`${editor} shared chords`, shared.map((r) => `${r.seededKey} ${r.action}`).join(', '));
      for (const r of shared) {
        const isHeld = HELD_ACTIONS.some((h) => h.action === r.action && (h.frames as readonly string[]).includes(editor));
        const before = (await of(page, 'ev.held')).length;
        await asked(frame);
        expect(await request(page, 'key.press', keyArgs(r.seededKey!))).toEqual({});
        await page.waitForTimeout(1_200);
        const tried = await asked(frame);
        measure(`${editor} ${r.seededKey}`, `${r.action}: asked ${tried.join(', ') || 'nothing'}`);
        // A held action of this frame is handed to the host, as before the run; any other runs, last.
        if (isHeld) expect((await of(page, 'ev.held')).at(-1)?.action, r.seededKey!).toBe(r.action);
        else expect((await of(page, 'ev.held')).length).toBe(before);
        // Nothing asked: the action is disabled now (no selection); else the last one tried is this frame's own.
        if (tried.length > 0) expect.soft(tried.at(-1), `${r.seededKey} in ${editor}`).toBe(r.action);
        await settle(page, frame);
      }
      // Then the new rows, the ones that may open a window last.
      await pressAll(page, frame, editor, [...rows.filter((r) => !MAY_OPEN.has(r.action)), ...rows.filter((r) => MAY_OPEN.has(r.action))]);
      // Whether the keys still reach KiCad after them: a display toggle pressed once more is tried.
      const toggle = rows.find((r) => ALWAYS_ON.has(r.action))!;
      await asked(frame);
      expect(await request(page, 'key.press', keyArgs(keyOf(toggle)!))).toEqual({});
      await page.waitForTimeout(1_200);
      const after = await asked(frame);
      measure(`${editor} keys after every press`, `${keyOf(toggle)} asked ${after.join(', ') || 'nothing'}`);
      // On engine run 14 Place Off-Board Footprints leaves the board frame deaf to keys with no window in
      // sight (KiCad's progress reporter, measured 2026-11-18); K-AP (st-ap-e, cap autoplace) runs it with none.
      const autoplace = ((await of(page, 'ev.ready'))[0]?.caps ?? []).includes('autoplace');
      if (editor === 'sch' || autoplace) expect.soft(after.at(-1), 'the keys still reach KiCad after every new row was pressed').toBe(toggle.action);
    });
  }

  // Each frame's first export of engine run 15 (the footprint editor's and the drawing sheet editor's kifaces join the merged image there).
  for (const [editor, cap, marker] of [['fpedit', 'fpedit', 'kicadFpEditOpen'], ['ds', 'dsedit', 'kicadDsEditOpen']] as const) {
    test(`the ${editor === 'fpedit' ? 'footprint editor' : 'drawing sheet editor'}: each chord runs its own action and opens no window`, async ({ page, browserName }) => {
      test.skip(browserName === 'firefox', 'Playwright Firefox reaches no context in the cross-site island frame');
      test.setTimeout(480_000);
      // A schematic frame lists the engine's export names: an engine without this editor's never boots its frame.
      await boot(page, 'frame=sch', null);
      test.skip(!((await of(page, 'ev.ready'))[0]?.caps ?? []).includes(marker), `this engine has no ${marker} (engine run 15)`);
      const frame = await boot(page, `frame=${editor}`, null);
      // An island without this frame boots a schematic frame in its place: nothing of this editor to press yet.
      test.skip(!((await of(page, 'ev.ready'))[0]?.caps ?? []).includes(cap), `no ${editor} frame on this island (its unit lands with engine run 15)`);
      // A footprint open, as the board and the schematic halves open Glasgow: with none, KiCad tries no edit tool (rotate, explode).
      if (editor === 'fpedit') {
        const soic = await page.evaluate(async (p) => (await fetch(p)).text(), '/fixtures/fpedit-small/fpedit-small_parts.pretty/SOIC-8_3.9x4.9mm_P1.27mm.kicad_mod');
        expect(await request(page, 'fpedit.open', { text: soic, name: 'SOIC-8_3.9x4.9mm_P1.27mm', lib: 'fpedit-small_parts', mode: 'library', discard: true })).toMatchObject({ open: true });
      }
      const rows = waveRows(editor);
      expect(rows.length).toBe(editor === 'fpedit' ? 38 : 8);
      await pressAll(page, frame, editor, rows);
    });
  }
});
