// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The 3D outputs over the local pair (3D exports spec 8.3, unit 3d-i3):
// project.export's jobs pcb_export_3d (every format, VRML included) and
// pcb_render on Glasgow, each answered by a file of its format; the picture
// of KiCad's own size (RULINGS 19: 784 by 592 for an asked 800 by 600, as
// kicad-cli 10.0 writes); ev.export with exactly its keys and never two within
// 250 ms; the model fixture's ${KIPRJMOD} bodies inside its STEP. island.json
// lists pcb_render on any engine; the runs need engine run 15 (the caps occ
// and render) and are skipped, named, on an engine without them. No build
// through T3 writes the render's lines while it runs (engine fix e11-6), so a
// running phase is not waited for.
import { expect, test, type Page } from '@playwright/test';

import { ISLAND } from './ports';

interface Ev { type: string; phase?: string; caps?: string[]; at: number; [k: string]: unknown }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Made { ok: true; files: Array<{ path: string; bytes: number; head: string; text: string }> }
interface Refused { ok: false; code: string; message: string }

const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const of = async (page: Page, type: string): Promise<Ev[]> => (await events(page)).filter((e) => e.type === type);

/** project.export from the host page: each file's path, size, first bytes as Latin-1 and (for a text file) its STEP entity counts' source. */
const make = (page: Page, args: unknown): Promise<Made | Refused> => page.evaluate(async (a) => {
  try {
    const r = await (window as unknown as Harness).__bridge.request('project.export', a) as { files: Array<{ path: string; bytes: Uint8Array }> };
    const latin = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join('');
    return { ok: true as const, files: r.files.map((f) => ({ path: f.path, bytes: f.bytes.byteLength, head: latin(f.bytes.subarray(0, 84)), text: /\.step$/i.test(f.path) ? new TextDecoder().decode(f.bytes) : '' })) };
  } catch (err) {
    const [code, ...rest] = (err as Error).message.split(': ');
    return { ok: false as const, code, message: rest.join(': ') };
  }
}, args);

async function boot(page: Page, fixture: string): Promise<string[]> {
  await page.goto(`/parent.html?fixture=${fixture}&frame=pcb`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  await expect(page.locator('#state')).toContainText('opened ', { timeout: 120_000 });
  return (await of(page, 'ev.ready'))[0]?.caps ?? [];
}

/** Every ev.export: exactly the keys job, phase and percent (percent optional), a known phase, never two within 250 ms. */
function checkProgress(evs: Ev[]): void {
  for (const e of evs) {
    const keys = Object.keys(e).filter((k) => k !== 'type' && k !== 'at').sort();
    expect(['job,phase', 'job,percent,phase']).toContain(keys.join(','));
    expect(['loading', 'models', 'running']).toContain(e.phase);
    if ('percent' in e) expect(Number.isInteger(e.percent) && (e.percent as number) >= 0 && (e.percent as number) <= 100).toBe(true);
  }
  for (let i = 1; i < evs.length; i++) expect(evs[i].at - evs[i - 1].at).toBeGreaterThanOrEqual(240);
}

/** What each 3D format's file starts with (or, for a binary STL, its size rule). */
function checkFormat(format: string, f: Made['files'][number]): void {
  const starts: Record<string, string> = { glb: 'glTF', ply: 'ply', u3d: 'U3D', pdf: '%PDF', step: 'ISO-10303-21', stpz: '\x1f\x8b', vrml: '#VRML V2.0' };
  if (format in starts) expect(f.head.startsWith(starts[format]), `${format} ${f.path}`).toBe(true);
  if (format === 'stl') {
    // KiCad writes STL through OpenCASCADE's StlAPI_Writer, whose default is ASCII ("solid ..."); a
    // binary STL is 84 bytes and 50 a triangle.
    if (!f.head.startsWith('solid')) {
      const n = f.head.charCodeAt(80) | (f.head.charCodeAt(81) << 8) | (f.head.charCodeAt(82) << 16) | (f.head.charCodeAt(83) << 24);
      expect(f.bytes, f.path).toBe(84 + 50 * n);
    }
  }
  // The engine fails a run that leaves an empty file, and a VRML file of 64 bytes or less (a header alone).
  expect(f.bytes, `${format} ${f.path}`).toBeGreaterThan(format === 'vrml' ? 64 : 0);
}

/** A PNG's width and height from its IHDR (the head holds its first 84 bytes as Latin-1). */
function pngSize(head: string): [number, number] {
  const u32 = (at: number) => ((head.charCodeAt(at) << 24) | (head.charCodeAt(at + 1) << 16) | (head.charCodeAt(at + 2) << 8) | head.charCodeAt(at + 3)) >>> 0;
  expect(head.slice(12, 16)).toBe('IHDR');
  return [u32(16), u32(20)];
}

test('island.json lists pcb_render among the export kinds', async ({ page }) => {
  const res = await page.goto(`${ISLAND}/island.json`);
  const island = JSON.parse(await res!.text()) as { exportKinds: string[] };
  expect(island.exportKinds).toEqual(expect.arrayContaining(['pcb_export_3d', 'pcb_render']));
});

test('the 3D outputs of Glasgow: every format and the render answer a file, ev.export paced and closed', async ({ page }) => {
  test.setTimeout(1_800_000);
  const caps = await boot(page, 'glasgow');
  test.skip(!caps.includes('occ') || !caps.includes('render'), `engine run 15 (caps occ and render) is not served here: caps ${caps.join(' ')}`);
  for (const format of ['step', 'stpz', 'brep', 'xao', 'glb', 'ply', 'stl', 'u3d', 'pdf', 'vrml']) {
    const answer = await make(page, { job: 'pcb_export_3d', settings: { format } });
    expect(answer.ok, `${format}: ${answer.ok ? '' : `${answer.code}: ${answer.message}`}`).toBe(true);
    if (!answer.ok) continue;
    expect(answer.files.length, format).toBeGreaterThan(0);
    for (const f of answer.files) checkFormat(format, f);
  }
  // The picture has KiCad's own size, never the asked one (RULINGS 19): the engine names it in its
  // line "The picture is 784 by 592 pixels.", equal to the file's own header.
  const render = await make(page, { job: 'pcb_render', settings: { format: 'png', width: 800, height: 600, quality: 'basic' } });
  expect(render.ok, render.ok ? '' : `${render.code}: ${render.message}`).toBe(true);
  if (render.ok) {
    const png = render.files.find((f) => f.head.startsWith('\x89PNG'));
    expect(png, 'a PNG').toBeDefined();
    expect(pngSize(png!.head)).toEqual([784, 592]);
  }
  const jpeg = await make(page, { job: 'pcb_render', settings: { format: 'jpeg', width: 800, height: 600, quality: 'basic' } });
  expect(jpeg.ok, jpeg.ok ? '' : `${jpeg.code}: ${jpeg.message}`).toBe(true);
  if (jpeg.ok) expect(jpeg.files.some((f) => f.head.startsWith('\xff\xd8\xff'))).toBe(true);
  checkProgress(await of(page, 'ev.export'));
});

test('the model fixture: its ${KIPRJMOD} body goes into the STEP', async ({ page }) => {
  test.setTimeout(900_000);
  const listed = await page.request.get('/fixtures/models3d-small/files.json').catch(() => null);
  test.skip(listed == null || !listed.ok(), 'the fixture models3d-small (unit 3d-i2) is not served here');
  const caps = await boot(page, 'models3d-small');
  test.skip(!caps.includes('occ'), `engine run 15 (cap occ) is not served here: caps ${caps.join(' ')}`);
  const answer = await make(page, { job: 'pcb_export_3d', settings: { format: 'step' } });
  expect(answer.ok, answer.ok ? '' : `${answer.code}: ${answer.message}`).toBe(true);
  if (!answer.ok) return;
  const step = answer.files.find((f) => /\.step$/i.test(f.path));
  expect(step?.head.startsWith('ISO-10303-21')).toBe(true);
  // The board and the project's two bodies (cube.step, block.wrl's STEP sibling) at least: three solids
  // (the library body adds its own when the local model store holds it). Before the bodies were sent
  // relative to the model root the file held one (fix note e10-2).
  expect((step?.text.match(/MANIFOLD_SOLID_BREP/g) ?? []).length).toBeGreaterThanOrEqual(3);
  checkProgress(await of(page, 'ev.export'));
});
