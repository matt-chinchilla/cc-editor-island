// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The model store (LIBRARY.md "The model store") over the local pair, on the
// fixture tests/fixtures/models3d-small. The store must be built first into
// dist/models (which tests/serve.mjs serves at /models/):
//   npm run build:models 10.0.4 -- --only tests/fixtures/models3d-small/models3d-small.kicad_pcb
// The engine's own ask (PCBJam's EnsureModelFile, in the engine since run 13)
// is kicadLibs.request("ensure", "", <ref>, "model3d"); the first two tests
// make that same request in the island frame, as the engine does, and read the
// file it wrote in the engine's file system. The third makes a STEP of the
// fixture: on an engine with the 3D service (the occ cap, engine run 15) it
// holds every body of the three model lines; before it the engine refuses
// every 3D format but VRML, and the test checks that refusal stands.
import { expect, test, type BrowserContext, type Frame, type Page } from '@playwright/test';
import pin from '../../PIN.json' with { type: 'json' };
import { ISLAND } from './ports';

const TAG = pin.libs.tag;
const FIXTURE = 'models3d-small';
const R0603 = 'Resistor_SMD.3dshapes/R_0603_1608Metric.step';
const ROOT = '/pcbjam/3dmodels';
interface Ev { type: string; phase?: string; caps?: string[]; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface IslandWindow {
  kicadLibs: { request(op: string, lib: string, arg: string, kind?: string): Promise<string | null> };
  FS: { readFile(p: string): Uint8Array; analyzePath(p: string): { exists: boolean } };
}

/** Every request the island makes under /models/, by its path below the tag. */
function modelsWatch(context: BrowserContext): string[] {
  const asked: string[] = [];
  context.on('request', (r) => {
    const u = new URL(r.url());
    if (u.origin === ISLAND && u.pathname.startsWith('/models/')) asked.push(decodeURIComponent(u.pathname.replace(/^\/models\/[^/]+\//, '')));
  });
  return asked;
}

const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);

async function boot(page: Page): Promise<Frame> {
  await page.goto(`/parent.html?fixture=${FIXTURE}&frame=pcb`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  expect((await events(page)).filter((e) => e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))).toEqual([]);
  await expect(page.locator('#state')).toContainText(`opened ${FIXTURE}.kicad_pcb`, { timeout: 120_000 });
  const frame = page.frames().find((f) => f.url().startsWith(`${ISLAND}/`));
  if (frame == null) throw new Error('no island frame');
  return frame;
}

/** The engine's own model request, made in the island frame. */
const ensure = (frame: Frame, ref: string): Promise<string | null> =>
  frame.evaluate((r) => (window as unknown as IslandWindow).kicadLibs.request('ensure', '', r, 'model3d'), ref);

/** A file of the engine's file system: its size and its first bytes as text. */
const engineFile = (frame: Frame, path: string): Promise<{ size: number; head: string } | null> =>
  frame.evaluate((p) => {
    const fs = (window as unknown as IslandWindow).FS;
    if (!fs.analyzePath(p).exists) return null;
    const b = fs.readFile(p);
    return { size: b.length, head: new TextDecoder().decode(b.subarray(0, 13)) };
  }, path);

/** The store's own index of a folder, read from the island origin. */
async function storeIndex(page: Page, folder: string): Promise<Record<string, number>> {
  const r = await page.request.get(`${ISLAND}/models/${TAG}/${folder}/index.json`);
  expect(r.ok(), `the local store has no ${folder}; build it first (the comment at the top)`).toBe(true);
  return (await r.json()) as Record<string, number>;
}

test.describe.configure({ mode: 'serial' });

test('the engine\'s model request is answered from the store, the file written under the model root', async ({ page, context }) => {
  const idx = await storeIndex(page, 'Resistor_SMD.3dshapes');
  const asked = modelsWatch(context);
  const frame = await boot(page);
  const at = `${ROOT}/${R0603}`;

  expect(await ensure(frame, `\${KICAD10_3DMODEL_DIR}/${R0603}`)).toBe(at);
  expect(await engineFile(frame, at)).toEqual({ size: idx['R_0603_1608Metric.step'], head: 'ISO-10303-21;' });
  // a .wrl line in any vintage of the variable is answered by its STEP sibling
  expect(await ensure(frame, '${KICAD6_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.wrl')).toBe(at);
  expect(await ensure(frame, `$(KISYS3DMOD)/${R0603}`)).toBe(at);
  // what the store does not hold, and what is not the store's, answer null
  expect(await ensure(frame, 'Resistor_SMD.3dshapes/R_0000_No_Such_Model.step')).toBeNull();
  expect(await ensure(frame, '${KIPRJMOD}/cube.step')).toBeNull();
  expect(await frame.evaluate(() => (window as unknown as IslandWindow).kicadLibs.request('list', '', 'x', 'model3d'))).toBeNull();
  // one index and one file fetched, whatever was asked
  expect(asked.sort()).toEqual(['Resistor_SMD.3dshapes/R_0603_1608Metric.step', 'Resistor_SMD.3dshapes/index.json']);
});

test('a later session reads the store from IndexedDB with no request under /models/', async ({ page, context }) => {
  // Same context, a fresh page: the island origin's IndexedDB is kept.
  const first = await boot(page);
  expect(await ensure(first, R0603)).toBe(`${ROOT}/${R0603}`);
  await page.close();

  const again = await context.newPage();
  const asked = modelsWatch(context);
  const frame = await boot(again);
  expect(await ensure(frame, `\${KICAD10_3DMODEL_DIR}/${R0603}`)).toBe(`${ROOT}/${R0603}`);
  expect((await engineFile(frame, `${ROOT}/${R0603}`))?.head).toBe('ISO-10303-21;');
  expect(await ensure(frame, 'Resistor_SMD.3dshapes/R_0000_No_Such_Model.step')).toBeNull();
  expect(asked).toEqual([]);
  await again.close();
});

test('a STEP of the fixture: every body of its three model lines with the 3D service, the engine\'s refusal before it', async ({ page }) => {
  const r = await page.request.get(`${ISLAND}/models/${TAG}/${R0603}`);
  expect(r.ok()).toBe(true);
  const solids = (text: string): number => (text.match(/MANIFOLD_SOLID_BREP/g) ?? []).length;
  const r0603 = solids(await r.text());
  await boot(page);
  const ready = (await events(page)).find((e) => e.type === 'ev.ready');
  const settings = { format: 'step', export_board_body: false, export_components: true };
  // The bytes stay in the page: only the STEP's name, its head and its solid count come back.
  const out = await page.evaluate((s) => (window as unknown as Harness).__bridge.request('project.export', { job: 'pcb_export_3d', settings: s })
    .then((a) => {
      const files = (a as { files: Array<{ path: string; bytes: Uint8Array }> }).files;
      const step = files.find((f) => /\.step$/i.test(f.path));
      const text = step == null ? '' : new TextDecoder().decode(step.bytes);
      return { ok: true as const, step: step?.path ?? null, head: text.slice(0, 13), solids: (text.match(/MANIFOLD_SOLID_BREP/g) ?? []).length };
    }, (e: Error) => ({ ok: false as const, message: e.message })), settings);
  if (!(ready?.caps ?? []).includes('occ')) {
    // engine run 14: OpenCASCADE is not in the engine, so only VRML is made
    expect(out).toEqual({ ok: false, message: 'export_failed: Only VRML is made here.' });
    return;
  }
  expect(out).toMatchObject({ ok: true, head: 'ISO-10303-21;' });
  expect((out as { step: string | null }).step, 'a STEP file').not.toBeNull();
  // R1's library body (from the store) and U1's two: cube.step and block.wrl's STEP sibling, one solid each
  expect((out as { solids: number }).solids).toBe(r0603 + 2);
});
