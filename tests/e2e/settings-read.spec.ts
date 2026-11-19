// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// m8-i over the local pair (PROTOCOL.md settings.read). On engine run 14 the
// cap settingsRead is absent and the op answers unsupported naming
// kicadSettingsRead. On engine run 15 (cc25), with settings-to open:
// settings.read of settings-from's project, board and rules file answers
// every section of the properties addendum's 6.1 with settings-from's values
// in a pcb frame and in a sch frame (each frame its own sections, the other's
// in missing); the run folder is gone after every answer; two project files
// answer bad_args; a truncated board answers unreadable with no run folder in
// its message, and a good read after it still works; the open design's own
// settings.get answers, its undo depth and its edited events are unchanged by
// any read.
import { expect, test, type Frame, type Page } from '@playwright/test';
import { ISLAND } from './ports';

interface Ev { type: string; phase?: string; caps?: string[]; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Engine {
  Module: { kicadCollabTestUndoDepth(): number };
  FS: { readdir(p: string): string[]; analyzePath(p: string): { exists: boolean } };
}
interface Read { sections: Record<string, unknown>; missing: string[] }

const RUN15 = 'waits for engine run 15 (pcbjam cc_e12_dispatch.inc, unit m8-e: kicadSettingsRead)';
const FROM = '/fixtures/settings-from';
const BOARD = ['layers', 'stackup', 'finish', 'zoneHatchOffsets', 'textDefaults', 'zoneDefaults', 'boardFormatting', 'constraints', 'predefinedSizes',
  'teardrops', 'tuningPatterns', 'netClasses', 'componentClasses', 'tuningProfiles', 'customRules', 'checkSeverities'];
const SCH = ['schFormatting', 'annotation', 'fieldTemplates', 'bomPresets', 'ercSeverities', 'pinMap', 'netClasses', 'busAliases', 'textVariables'];
/**
 * KiCad 10's own board reader puts a board file's zone_defaults into the
 * default zone settings, never into the board's hatch offsets its writer
 * writes, so settings-from's offset on In1.Cu may read as the default: this
 * section is read and compared, never required to differ.
 */
const MAY_READ_DEFAULT = ['zoneHatchOffsets'];

function measure(type: string, description: string): void {
  test.info().annotations.push({ type, description });
  console.log(`[measure] ${type}: ${description}`);
}
const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const of = async (page: Page, type: string): Promise<Ev[]> => (await events(page)).filter((e) => e.type === type);
const request = (page: Page, op: string, args?: unknown): Promise<Record<string, unknown>> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const);
const refusal = (page: Page, op: string, args?: unknown): Promise<string> =>
  request(page, op, args).then(() => 'ok', (err: Error) => err.message.split('\n')[0].replace(/^.*?page\.evaluate:\s*/, '').replace(/^Error:\s*/, ''));

/**
 * settings.read with settings-from's files fetched by the page (`names`, each
 * optionally replaced by `over`), timed; the answer or the refusal line.
 */
function readFrom(page: Page, names: string[], sections: string[], over: Record<string, string> = {}): Promise<{ ms: number; result: Read | null; refusal: string | null }> {
  return page.evaluate(async ([base, ns, ss, ov]) => {
    const files = await Promise.all((ns as string[]).map(async (name) => {
      const text = (ov as Record<string, string>)[name];
      const bytes = text != null ? new TextEncoder().encode(text) : new Uint8Array(await (await fetch(`${base as string}/${name}`)).arrayBuffer());
      return { name, bytes };
    }));
    const t0 = performance.now();
    try {
      const result = await (window as unknown as Harness).__bridge.request('settings.read', { files, sections: ss });
      return { ms: Math.round(performance.now() - t0), result: result as unknown as Read, refusal: null };
    } catch (err) {
      return { ms: Math.round(performance.now() - t0), result: null, refusal: (err as Error).message.split('\n')[0] };
    }
  }, [FROM, names, sections, over] as const);
}

/** Boots `frame` on settings-to and answers ev.ready's caps and the island frame (null where Playwright cannot reach it). */
async function boot(page: Page, frame: 'pcb' | 'sch'): Promise<{ caps: string[]; island: Frame | null }> {
  await page.goto(`/parent.html?fixture=settings-to&frame=${frame}`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  const caps = (await of(page, 'ev.ready'))[0]?.caps ?? [];
  await expect(page.locator('#state')).toContainText(`opened settings-to.kicad_${frame}`, { timeout: 120_000 });
  await page.waitForTimeout(1_500);   // ev.edited's baseline
  return { caps, island: page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null };
}
const undoDepth = (island: Frame): Promise<number> => island.evaluate(() => Number((window as unknown as Engine).Module.kicadCollabTestUndoDepth()));
const leftOver = (island: Frame): Promise<string[]> => island.evaluate(() => {
  const { FS } = window as unknown as Engine;
  return FS.analyzePath('/tmp/cc-settings-read').exists ? FS.readdir('/tmp/cc-settings-read').filter((n) => n !== '.' && n !== '..') : [];
});
/** The open design's own settings.get answer for each section. */
async function openSettings(page: Page, sections: string[]): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const s of sections) out[s] = await request(page, 'settings.get', { section: s });
  return out;
}

for (const frame of ['pcb', 'sch'] as const) {
  test(`run 14 or 15, ${frame}: the cap follows the export; without it the op answers unsupported naming kicadSettingsRead; bad args first`, async ({ page }) => {
    const { caps } = await boot(page, frame);
    const run15 = ['kicadSettingsRead', 'kicadCollabBusy'].every((e) => caps.includes(e));
    expect(caps.includes('settingsRead')).toBe(run15);
    if (!caps.includes('kicadSettingsRead')) {
      const r = await readFrom(page, ['settings-from.kicad_pro'], ['netClasses']);
      expect(r.refusal).toBe('unsupported: kicadSettingsRead');
    }
    expect(await refusal(page, 'settings.read', { files: [], sections: ['netClasses'] })).toBe('bad_args: settings.read');
    expect(await refusal(page, 'settings.read', { files: [{ name: 'x.kicad_pro', bytes: [1] }], sections: ['netClasses'] })).toBe('bad_args: settings.read');
  });
}

test('run 15, pcb: every board section read with settings-from\'s values; nothing of the open design changes; the folder gone', async ({ page }) => {
  const { caps, island } = await boot(page, 'pcb');
  test.skip(!caps.includes('settingsRead'), RUN15);
  const before = await openSettings(page, BOARD);
  const depth = island == null ? null : await undoDepth(island);
  const edited = (await of(page, 'ev.edited')).length;

  const r = await readFrom(page, ['settings-from.kicad_pro', 'settings-from.kicad_pcb', 'settings-from.kicad_dru'], BOARD);
  measure('settings.read, 16 board sections', `${r.ms} ms`);
  expect(r.refusal).toBeNull();
  const read = r.result!;
  expect(read.missing).toEqual([]);
  expect(Object.keys(read.sections).sort()).toEqual([...BOARD].sort());
  for (const s of BOARD) {
    if (MAY_READ_DEFAULT.includes(s)) continue;
    expect(read.sections[s], `${s} reads settings-from's values`).not.toEqual(before[s]);
  }
  const hatch = JSON.stringify(read.sections.zoneHatchOffsets);
  measure('zoneHatchOffsets read from settings-from', hatch.slice(0, 300));
  expect(JSON.stringify(read.sections.netClasses)).toContain('"HV"');
  expect(JSON.stringify(read.sections.layers)).toContain('In4.Cu');
  expect(JSON.stringify(read.sections.customRules)).toContain('HV spacing');
  expect(JSON.stringify(read.sections.componentClasses)).toContain('POWER');
  expect(JSON.stringify(read.sections.tuningProfiles)).toContain('USB 90R');
  expect(JSON.stringify(read.sections.finish)).toContain('ENIG');
  if (island != null) expect(await leftOver(island)).toEqual([]);

  expect(await openSettings(page, BOARD)).toEqual(before);
  if (island != null) expect(await undoDepth(island)).toBe(depth);
  await page.waitForTimeout(1_000);
  expect((await of(page, 'ev.edited')).length).toBe(edited);

  // No rules file: customRules is missing, the rest still read.
  const noRules = await readFrom(page, ['settings-from.kicad_pro', 'settings-from.kicad_pcb'], ['customRules', 'netClasses']);
  expect(noRules.refusal).toBeNull();
  expect(noRules.result!.missing).toEqual(['customRules']);
  expect(Object.keys(noRules.result!.sections)).toEqual(['netClasses']);
  // No board: the board's own sections are missing, the project's read.
  const noBoard = await readFrom(page, ['settings-from.kicad_pro'], ['layers', 'netClasses', 'tuningProfiles']);
  expect(noBoard.refusal).toBeNull();
  expect(noBoard.result!.missing).toEqual(['layers']);
  if (island != null) expect(await leftOver(island)).toEqual([]);
});

test('run 15, sch: every schematic section read with settings-from\'s values, a board section missing; nothing of the open design changes', async ({ page }) => {
  const { caps, island } = await boot(page, 'sch');
  test.skip(!caps.includes('settingsRead'), RUN15);
  const before = await openSettings(page, SCH);
  const depth = island == null ? null : await undoDepth(island);
  const edited = (await of(page, 'ev.edited')).length;

  const r = await readFrom(page, ['settings-from.kicad_pro', 'settings-from.kicad_pcb', 'settings-from.kicad_dru'], [...SCH, 'layers']);
  measure('settings.read, 9 schematic sections', `${r.ms} ms`);
  expect(r.refusal).toBeNull();
  const read = r.result!;
  expect(read.missing).toEqual(['layers']);
  expect(Object.keys(read.sections).sort()).toEqual([...SCH].sort());
  for (const s of SCH) expect(read.sections[s], `${s} reads settings-from's values`).not.toEqual(before[s]);
  expect(JSON.stringify(read.sections.annotation)).toContain('100');
  expect(JSON.stringify(read.sections.bomPresets)).toContain('Assembly');
  expect(JSON.stringify(read.sections.busAliases)).toContain('ADDR');
  expect(read.sections.textVariables).toMatchObject({ REV: 'C' });
  expect(JSON.stringify(read.sections.fieldTemplates)).toContain('Supplier');
  if (island != null) expect(await leftOver(island)).toEqual([]);

  expect(await openSettings(page, SCH)).toEqual(before);
  if (island != null) expect(await undoDepth(island)).toBe(depth);
  await page.waitForTimeout(1_000);
  expect((await of(page, 'ev.edited')).length).toBe(edited);
});

test('run 15: two project files are bad_args; a truncated board is unreadable with no run folder in the message; a good read follows', async ({ page }) => {
  const { caps, island } = await boot(page, 'pcb');
  test.skip(!caps.includes('settingsRead'), RUN15);
  const two = await page.evaluate(async (base) => {
    const bytes = new Uint8Array(await (await fetch(`${base}/settings-from.kicad_pro`)).arrayBuffer());
    try {
      await (window as unknown as Harness).__bridge.request('settings.read', { files: [{ name: 'a.kicad_pro', bytes }, { name: 'b.kicad_pro', bytes }], sections: ['netClasses'] });
      return 'ok';
    } catch (err) { return (err as Error).message.split('\n')[0]; }
  }, FROM);
  expect(two).toBe('bad_args: settings.read');

  const board = await page.evaluate(async (base) => (await fetch(`${base}/settings-from.kicad_pcb`)).text(), FROM);
  const bad = await readFrom(page, ['settings-from.kicad_pro', 'settings-from.kicad_pcb'], ['layers'], { 'settings-from.kicad_pcb': board.slice(0, Math.floor(board.length / 3)) });
  measure('settings.read, truncated board', `${bad.ms} ms: ${bad.refusal ?? 'answered'}`);
  expect(bad.refusal).toMatch(/^unreadable: /);
  expect(bad.refusal).not.toContain('/tmp/cc-settings-read');
  if (island != null) expect(await leftOver(island)).toEqual([]);

  const good = await readFrom(page, ['settings-from.kicad_pro', 'settings-from.kicad_pcb'], ['layers']);
  expect(good.refusal).toBeNull();
  expect(JSON.stringify(good.result!.sections.layers)).toContain('In4.Cu');
});
