// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-open-foreign-i over the local pair (PROTOCOL.md project.import): the
// format names the schematic importer in a sch frame, whatever the extension,
// and the pcb frame opens Allegro and KiCad 4 boards. Each import answers with
// the converted KiCad file saved (ev.saved before the answer) and no dialog up.
// The importers are in engine run 14, so every test runs on cc24 and cc25.
//
// The fixtures: tests/fixtures/st-ltspice-divider and st-cadstar-minimal
// (ours, CC0); KiCad's qa data and the site's foreign format fixtures, read
// from their checkouts by path at test time and never copied (EasyEDA Std's is
// CC BY-NC-SA): CC_KICAD_DIR names the KiCad clone, CC_SITE_DIR the site
// checkout.
import { expect, test, type Frame, type Page } from '@playwright/test';
import { ISLAND, PAGE } from '../ports';

declare const process: { env: Record<string, string | undefined> };
const KICAD = process.env.CC_KICAD_DIR ?? '/home/matthew/cc-engine/kicad-source-mirror';
const SITE = process.env.CC_SITE_DIR ?? '/home/matthew/circuits-com';
const SITE_FORMATS = `${SITE}/frontend/src/public/services/kicad/fixtures/foreign-formats`;

/** Files outside the island checkout, served to the harness page by Playwright from their paths. */
const OUTSIDE: Readonly<Record<string, string>> = {
  'eagle-import-testfile.sch': `${KICAD}/qa/data/eeschema/io/eagle/eagle-import-testfile.sch`,
  'smart-watch.json': `${KICAD}/qa/data/pcbnew/plugins/easyeda/SCH_ESP32-PICO-D4 smart watch_2023-09-02.json`,
  'rects.brd': `${KICAD}/qa/data/pcbnew/plugins/allegro/boards/rects/rects.brd`,
  'ecc83-pp.brd': `${KICAD}/qa/data/pcbnew/plugins/legacy_demos/ecc83/ecc83-pp.brd`,
  'minimal_test.sch': `${SITE_FORMATS}/minimal_test.sch`,
  'parts_schematic.txt': `${KICAD}/qa/data/eeschema/plugins/pads/parts_schematic.txt`,
  'OpenSTM.zip': `${SITE_FORMATS}/Scanning Tunneling Microscope OpenSTM ControlBoard.zip`,
};
const OUTSIDE_PREFIX = '/st-open-foreign/';

interface Ev { type: string; phase?: string; path?: string; at: number }
interface Harness { __events: Ev[]; __saved: Record<string, Uint8Array>; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface ImportResult { opened: string; dropped: string[]; warnings: string[]; chrome: boolean }
interface ToolWindowLike { wxElementRegistry: { findAll(f: object): Array<{ typeName: string }> } }
/** One staged file: `from` a URL the page fetches, staged at `path`. */
interface Staged { from: string; path: string }

function measure(type: string, description: string): void {
  test.info().annotations.push({ type, description });
  console.log(`[measure] ${type}: ${description}`);
}
const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const savedText = (page: Page, path: string): Promise<string> =>
  page.evaluate((p) => { const b = (window as unknown as Harness).__saved[p]; return b == null ? '' : new TextDecoder().decode(b); }, path);
/** The wx dialogs up in the island frame; null where Playwright cannot reach the frame (Firefox: the isolated cross-origin frame). */
const dialogsUp = async (frame: Frame | null): Promise<string[] | null> => frame == null ? null :
  (await frame.evaluate(() => (window as unknown as ToolWindowLike).wxElementRegistry.findAll({ visible: true }).map((e) => e.typeName))).filter((t) => /Dialog/.test(t));

/** Boots an empty frame of `kind` and answers the island frame (null where Playwright cannot reach it). */
async function boot(page: Page, kind: 'sch' | 'pcb'): Promise<Frame | null> {
  await page.route(`${PAGE}${OUTSIDE_PREFIX}**`, async (route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.slice(OUTSIDE_PREFIX.length));
    const path = OUTSIDE[name];
    if (path == null) return route.fulfill({ status: 404, body: 'not a fixture' });
    return route.fulfill({ path, contentType: 'application/octet-stream' });
  });
  await page.goto(`/parent.html?frame=${kind}`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  expect((await events(page)).filter((e) => e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))).toEqual([]);
  return page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null;
}
/** No dialog is up in the island frame, where it can be read. */
async function expectNoDialog(frame: Frame | null): Promise<void> {
  const up = await dialogsUp(frame);
  if (up == null) measure('dialogs', 'the island frame is not reachable here; the answer alone is checked');
  else expect(up).toEqual([]);
}

const outside = (name: string, path = name): Staged => ({ from: `${OUTSIDE_PREFIX}${encodeURIComponent(name)}`, path });
const fixture = (folder: string, name: string): Staged => ({ from: `/fixtures/${folder}/${name}`, path: name });

/** project.import of the staged files, opening `open`, with `format` when given; timed from the request. Rejects with "code: message". */
async function importFiles(page: Page, staged: readonly Staged[], open: string, format?: string): Promise<{ result: ImportResult; seconds: number }> {
  const [result, ms] = await page.evaluate(async ([s, o, f]) => {
    const files = await Promise.all(s.map(async (x) => {
      const res = await fetch(x.from);
      if (!res.ok) throw new Error(`fixture ${x.from}: ${res.status}`);
      return { path: x.path, bytes: new Uint8Array(await res.arrayBuffer()) };
    }));
    const t0 = performance.now();
    const r = await (window as unknown as Harness).__bridge.request('project.import', f == null ? { name: o, files, open: o } : { name: o, files, open: o, format: f });
    return [r, performance.now() - t0] as const;
  }, [staged, open, format ?? null] as const);
  return { result: result as unknown as ImportResult, seconds: ms / 1000 };
}
const importRefusal = (page: Page, staged: readonly Staged[], open: string, format?: string): Promise<string> =>
  importFiles(page, staged, open, format).then(() => 'ok', (err: Error) => err.message.split('\n')[0].replace(/^.*?page\.evaluate:\s*/, '').replace(/^Error:\s*/, ''));

/** The converted file answers as the document, arrived as ev.saved before the answer, parses under its head, and no dialog is up. */
async function expectConverted(page: Page, frame: Frame | null, result: ImportResult, opened: string, head: 'kicad_sch' | 'kicad_pcb'): Promise<string> {
  expect(result.opened).toBe(opened);
  expect(result.dropped).toEqual([]);
  expect(result.warnings.every((l) => typeof l === 'string' && l.length <= 200)).toBe(true);
  expect((await events(page)).some((e) => e.type === 'ev.saved' && e.path === opened)).toBe(true);
  const text = await savedText(page, opened);
  expect(text.startsWith(`(${head}`)).toBe(true);
  await expectNoDialog(frame);
  return text;
}

const symbols = (text: string): number => [...text.matchAll(/^\t\(symbol\n/gm)].length;

test.describe('st-open-foreign-i: a sch frame imports with the format named', () => {
  test('LTspice: the divider (its two symbols beside it) converts with V1, R1 and R2', async ({ page }) => {
    const frame = await boot(page, 'sch');
    const files = ['divider.asc', 'res.asy', 'voltage.asy'].map((n) => fixture('st-ltspice-divider', n));
    const { result, seconds } = await importFiles(page, files, 'divider.asc', 'LTspice');
    measure('import ltspice', `${seconds.toFixed(1)} s, warnings ${JSON.stringify(result.warnings)}`);
    const text = await expectConverted(page, frame, result, 'divider.kicad_sch', 'kicad_sch');
    for (const ref of ['V1', 'R1', 'R2']) expect(text).toContain(`"${ref}"`);
  });

  test('gEDA / Lepton EDA: minimal_test.sch is read by the gEDA importer, not Eagle', async ({ page }) => {
    const frame = await boot(page, 'sch');
    const { result, seconds } = await importFiles(page, [outside('minimal_test.sch')], 'minimal_test.sch', 'gEDA / Lepton EDA');
    measure('import geda', `${seconds.toFixed(1)} s, warnings ${JSON.stringify(result.warnings)}`);
    await expectConverted(page, frame, result, 'minimal_test.kicad_sch', 'kicad_sch');
  });

  test('without a format the same gEDA .sch goes to Eagle (the extension) and is refused, no dialog left up', async ({ page }) => {
    const frame = await boot(page, 'sch');
    expect(await importRefusal(page, [outside('minimal_test.sch')], 'minimal_test.sch')).toMatch(/^import_failed: /);
    await expectNoDialog(frame);
  });

  test('PADS Logic: KiCad\'s parts_schematic, staged as an .asc, is read by the PADS Logic importer, not LTspice', async ({ page }) => {
    // KiCad's PADS Logic importer reads .asc and .txt: with the format named, an .asc goes to it, not LTspice.
    const frame = await boot(page, 'sch');
    const { result, seconds } = await importFiles(page, [outside('parts_schematic.txt', 'parts_schematic.asc')], 'parts_schematic.asc', 'PADS Logic');
    measure('import pads logic', `${seconds.toFixed(1)} s, warnings ${JSON.stringify(result.warnings)}`);
    await expectConverted(page, frame, result, 'parts_schematic.kicad_sch', 'kicad_sch');
  });

  test('PADS Logic: KiCad\'s parts_schematic.txt, sent with no format, is read by the PADS Logic importer by its extension', async ({ page }) => {
    // The site's simple_schematic.txt holds no part, so KiCad's import counts it refused (no sheet holds items).
    const frame = await boot(page, 'sch');
    const { result, seconds } = await importFiles(page, [outside('parts_schematic.txt')], 'parts_schematic.txt');
    measure('import pads logic txt', `${seconds.toFixed(1)} s, warnings ${JSON.stringify(result.warnings)}`);
    await expectConverted(page, frame, result, 'parts_schematic.kicad_sch', 'kicad_sch');
  });

  test('EAGLE: KiCad\'s eagle-import-testfile.sch converts with its parts', async ({ page }) => {
    const frame = await boot(page, 'sch');
    const { result, seconds } = await importFiles(page, [outside('eagle-import-testfile.sch')], 'eagle-import-testfile.sch', 'EAGLE');
    measure('import eagle sch', `${seconds.toFixed(1)} s, warnings ${JSON.stringify(result.warnings)}`);
    const text = await expectConverted(page, frame, result, 'eagle-import-testfile.kicad_sch', 'kicad_sch');
    expect(symbols(text)).toBeGreaterThan(0);
  });

  test('EasyEDA (JLCEDA) Pro: the OpenSTM project zip converts', async ({ page }) => {
    const frame = await boot(page, 'sch');
    const { result, seconds } = await importFiles(page, [outside('OpenSTM.zip')], 'OpenSTM.zip', 'EasyEDA (JLCEDA) Pro');
    measure('import easyeda pro', `${seconds.toFixed(1)} s, warnings ${JSON.stringify(result.warnings)}`);
    await expectConverted(page, frame, result, 'OpenSTM.kicad_sch', 'kicad_sch');
  });

  test('EasyEDA (JLCEDA) Std: KiCad\'s smart watch schematic, read by path, converts', async ({ page }) => {
    const frame = await boot(page, 'sch');
    const { result, seconds } = await importFiles(page, [outside('smart-watch.json')], 'smart-watch.json', 'EasyEDA (JLCEDA) Std');
    measure('import easyeda std', `${seconds.toFixed(1)} s, warnings ${JSON.stringify(result.warnings)}`);
    await expectConverted(page, frame, result, 'smart-watch.kicad_sch', 'kicad_sch');
  });

  test('CADSTAR Schematic Archive: the hand written minimal.csa converts with its two texts', async ({ page }) => {
    const frame = await boot(page, 'sch');
    const { result, seconds } = await importFiles(page, [fixture('st-cadstar-minimal', 'minimal.csa')], 'minimal.csa', 'CADSTAR Schematic Archive');
    measure('import cadstar sch', `${seconds.toFixed(1)} s, warnings ${JSON.stringify(result.warnings)}`);
    const text = await expectConverted(page, frame, result, 'minimal.kicad_sch', 'kicad_sch');
    expect(text).toContain('Divider');
  });
});

test.describe('st-open-foreign-i: a pcb frame opens Allegro and KiCad 4 boards', () => {
  for (const [name, what] of [['rects.brd', 'Allegro'], ['ecc83-pp.brd', 'KiCad 4']] as const) {
    test(`${what}: ${name} converts to a KiCad board`, async ({ page }) => {
      const frame = await boot(page, 'pcb');
      const { result, seconds } = await importFiles(page, [outside(name)], name);
      measure(`import ${what}`, `${seconds.toFixed(1)} s, warnings ${JSON.stringify(result.warnings)}`);
      await expectConverted(page, frame, result, `${name.slice(0, -'.brd'.length)}.kicad_pcb`, 'kicad_pcb');
    });
  }
});
