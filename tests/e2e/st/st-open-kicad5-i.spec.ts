// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-open-kicad5-i over the local pair (PROTOCOL.md project.import, format
// kicad5): a KiCad 5 project opens in a sch frame through the engine's
// kicadImportLegacyProject, saved as KiCad 10 files with no dialog, and
// ev.ready lists importLegacy. The export is engine run 15's: on cc24 (engine
// run 14) the cap is absent and the import answers unsupported naming it (the
// first test); the others run on cc25.
//
// The fixtures: KiCad's legacy demos ecc83 and electric
// (qa/data/pcbnew/plugins/legacy_demos, GPL-3.0-or-later), read from the KiCad
// clone by path at test time and never copied: CC_KICAD_DIR names the clone.
import { expect, test, type Frame, type Page } from '@playwright/test';
import { ISLAND, PAGE } from '../ports';

declare const process: { env: Record<string, string | undefined> };
const KICAD = process.env.CC_KICAD_DIR ?? '/home/matthew/cc-engine/kicad-source-mirror';
const DEMOS = `${KICAD}/qa/data/pcbnew/plugins/legacy_demos`;
const PREFIX = '/st-open-kicad5/';

interface Ev { type: string; phase?: string; path?: string; caps?: string[] }
interface Harness { __events: Ev[]; __saved: Record<string, Uint8Array>; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface ImportResult { opened: string; dropped: string[]; warnings: string[]; chrome: boolean }
interface ToolWindowLike { wxElementRegistry: { findAll(f: object): Array<{ typeName: string }> } }

function measure(type: string, description: string): void {
  test.info().annotations.push({ type, description });
  console.log(`[measure] ${type}: ${description}`);
}
const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const savedText = (page: Page, path: string): Promise<string> =>
  page.evaluate((p) => { const b = (window as unknown as Harness).__saved[p]; return b == null ? '' : new TextDecoder().decode(b); }, path);

/** Boots an empty sch frame; answers the island frame (null where Playwright cannot reach it) and ev.ready's caps. */
async function boot(page: Page): Promise<{ frame: Frame | null; caps: string[] }> {
  await page.route(`${PAGE}${PREFIX}**`, async (route) => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname.slice(PREFIX.length));
    if (!/^(ecc83|electric)\/[\w.-]+$/.test(rel)) return route.fulfill({ status: 404, body: 'not a fixture' });
    return route.fulfill({ path: `${DEMOS}/${rel}`, contentType: 'application/octet-stream' });
  });
  await page.goto('/parent.html?frame=sch');
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  const evs = await events(page);
  expect(evs.filter((e) => e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))).toEqual([]);
  return { frame: page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null, caps: evs.find((e) => e.type === 'ev.ready')?.caps ?? [] };
}

async function expectNoDialog(frame: Frame | null): Promise<void> {
  if (frame == null) { measure('dialogs', 'the island frame is not reachable here; the answer alone is checked'); return; }
  const up = (await frame.evaluate(() => (window as unknown as ToolWindowLike).wxElementRegistry.findAll({ visible: true }).map((e) => e.typeName))).filter((t) => /Dialog/.test(t));
  expect(up).toEqual([]);
}

/** project.import of the demo's files with format kicad5, opening `open`; timed from the request. Rejects with "code: message". */
async function importDemo(page: Page, demo: string, names: readonly string[], open: string): Promise<{ result: ImportResult; seconds: number }> {
  const [result, ms] = await page.evaluate(async ([d, n, o, prefix]) => {
    const files = await Promise.all(n.map(async (name) => {
      const res = await fetch(`${prefix}${d}/${name}`);
      if (!res.ok) throw new Error(`fixture ${d}/${name}: ${res.status}`);
      return { path: name, bytes: new Uint8Array(await res.arrayBuffer()) };
    }));
    const t0 = performance.now();
    const r = await (window as unknown as Harness).__bridge.request('project.import', { name: d, files, open: o, format: 'kicad5' });
    return [r, performance.now() - t0] as const;
  }, [demo, names, open, PREFIX] as const);
  return { result: result as unknown as ImportResult, seconds: ms / 1000 };
}
const refusal = (p: Promise<unknown>): Promise<string> =>
  p.then(() => 'ok', (err: Error) => err.message.split('\n')[0].replace(/^.*?page\.evaluate:\s*/, '').replace(/^Error:\s*/, ''));

const ECC83 = ['ecc83-pp.pro', 'ecc83-pp.sch', 'ecc83-pp.cache.lib'];
const ELECTRIC = ['electric.pro', 'electric.sch', 'electric.cache.lib'];

test.describe('st-open-kicad5-i: a KiCad 5 project opens converted', () => {
  test('on an engine without kicadImportLegacyProject the cap is absent and the import answers unsupported naming it', async ({ page }) => {
    const { caps } = await boot(page);
    test.skip(caps.includes('importLegacy'), 'this engine has kicadImportLegacyProject (engine run 15): the tests below run');
    expect(await refusal(importDemo(page, 'ecc83', ECC83, 'ecc83-pp.pro'))).toBe('unsupported: kicadImportLegacyProject');
    // Nothing was staged or opened: a later request is answered as on a fresh frame.
    expect((await events(page)).some((e) => e.type === 'ev.saved')).toBe(false);
  });

  test('ecc83: saved as KiCad 10 with its rescue symbols and their table row, every part on them, no dialog', async ({ page }) => {
    const { frame, caps } = await boot(page);
    test.skip(!caps.includes('importLegacy'), 'needs engine run 15 (island v0.2.3-cc25)');
    const { result, seconds } = await importDemo(page, 'ecc83', ECC83, 'ecc83-pp.pro');
    measure('import ecc83', `${seconds.toFixed(1)} s, warnings ${JSON.stringify(result.warnings)}`);
    expect(result.opened).toBe('ecc83-pp.kicad_sch');
    expect(result.dropped).toEqual([]);
    expect(result.warnings.every((l) => typeof l === 'string' && l.length <= 200)).toBe(true);
    const saved = (await events(page)).filter((e) => e.type === 'ev.saved').map((e) => e.path);
    for (const p of ['ecc83-pp.kicad_sch', 'ecc83-pp.kicad_pro', 'ecc83-pp-rescue.kicad_sym', 'sym-lib-table']) expect(saved).toContain(p);
    const sheet = await savedText(page, 'ecc83-pp.kicad_sch');
    expect(sheet.startsWith('(kicad_sch')).toBe(true);
    const libIds = [...sheet.matchAll(/^\t\t\(lib_id "([^"]*)"\)/gm)].map((m) => m[1]);
    expect(libIds.length).toBeGreaterThan(0);
    for (const id of libIds) expect(id.startsWith('ecc83-pp-rescue:')).toBe(true);
    expect(await savedText(page, 'sym-lib-table')).toContain('${KIPRJMOD}/ecc83-pp-rescue.kicad_sym');
    expect((await savedText(page, 'ecc83-pp-rescue.kicad_sym')).startsWith('(kicad_symbol_lib')).toBe(true);
    await expectNoDialog(frame);
  });

  test('electric: the same, opened by its root sheet', async ({ page }) => {
    const { frame, caps } = await boot(page);
    test.skip(!caps.includes('importLegacy'), 'needs engine run 15 (island v0.2.3-cc25)');
    const { result, seconds } = await importDemo(page, 'electric', ELECTRIC, 'electric.sch');
    measure('import electric', `${seconds.toFixed(1)} s, warnings ${JSON.stringify(result.warnings)}`);
    expect(result.opened).toBe('electric.kicad_sch');
    const saved = (await events(page)).filter((e) => e.type === 'ev.saved').map((e) => e.path);
    for (const p of ['electric.kicad_sch', 'electric.kicad_pro', 'electric-rescue.kicad_sym']) expect(saved).toContain(p);
    expect((await savedText(page, 'electric.kicad_sch')).startsWith('(kicad_sch')).toBe(true);
    await expectNoDialog(frame);
  });

  test('a request that is no KiCad 5 project answers bad_args, whatever the engine', async ({ page }) => {
    await boot(page);
    expect(await refusal(importDemo(page, 'ecc83', ['ecc83-pp.pro', 'ecc83-pp.cache.lib'], 'ecc83-pp.pro'))).toBe('bad_args: project.import');
    expect(await refusal(importDemo(page, 'ecc83', ECC83, 'ecc83-pp.cache.lib'))).toBe('bad_args: project.import');
  });
});
