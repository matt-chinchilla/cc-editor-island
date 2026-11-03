// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// island v0.2.3-cc13 over the local pair, on the Glasgow example (PROTOCOL.md):
// project.plot plots the board the pcb frame holds with no KiCad dialog, through
// our engine's kicadPlotBoard (pcbjam cc/main 924d67c; engine run 8). The fab
// preset is a board house set (4 copper layers on Glasgow, both masks, pastes
// and silkscreens, the outline, the PTH and NPTH drill files and the job file,
// X2 on, .gbr names); the board preset plots what Glasgow's own plot settings
// select. Nothing in the board changes, and the plot's folder is gone after.
import { expect, test, type Frame, type Page } from '@playwright/test';

const ISLAND = 'http://editor.localhost:4174';
interface Ev { type: string; phase?: string; depth?: number; caps?: string[]; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Engine { Module: { kicadCollabTestUndoDepth(): number }; FS: { readdir(p: string): string[]; analyzePath(p: string): { exists: boolean } } }
interface PlottedFile { path: string; bytes: number; owned: boolean; head: string; x2: boolean; x2Comment: boolean; text: string | null }
interface Plotted { ms: number; files: PlottedFile[]; notes: string[] }

function measure(type: string, description: string): void {
  test.info().annotations.push({ type, description });
  console.log(`[measure] ${type}: ${description}`);
}

const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const of = async (page: Page, type: string): Promise<Ev[]> => (await events(page)).filter((e) => e.type === type);
const request = (page: Page, op: string, args?: unknown): Promise<Record<string, unknown>> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const);
/** A request's refusal as "code: message", or "ok" (Playwright's own prefix stripped, as picker.spec.ts does). */
const refusal = (page: Page, op: string, args?: unknown): Promise<string> =>
  request(page, op, args).then(() => 'ok', (err: Error) => err.message.split('\n')[0].replace(/^.*?page\.evaluate:\s*/, '').replace(/^Error:\s*/, ''));

/**
 * project.plot from the host page, its answer read there (the bytes stay in the
 * page): each file's name, size, first line and whether it carries the X2
 * FileFunction attribute (or the same attribute as a G04 comment, X2 off), the
 * job file's text, the notes, and the latency from the request to the answer.
 */
const plot = (page: Page, args: unknown): Promise<Plotted> => page.evaluate(async (a) => {
  const t0 = performance.now();
  const r = await (window as unknown as Harness).__bridge.request('project.plot', a) as { files: Array<{ path: string; bytes: Uint8Array }>; notes: string[] };
  const ms = Math.round(performance.now() - t0);
  const dec = new TextDecoder();
  return {
    ms,
    notes: r.notes,
    files: r.files.map((f) => {
      const text = dec.decode(f.bytes);
      return {
        path: f.path,
        bytes: f.bytes.byteLength,
        owned: f.bytes instanceof Uint8Array && f.bytes.byteOffset === 0 && f.bytes.byteLength === f.bytes.buffer.byteLength,
        head: text.split('\n')[0],
        x2: text.includes('%TF.FileFunction'),
        x2Comment: text.includes('G04 #@! TF.FileFunction'),
        text: f.path.endsWith('.gbrjob') ? text : null,
      };
    }),
  };
}, args);

/**
 * The page with Glasgow open in a frame of that kind, and the island's frame when
 * Playwright reaches it (Playwright's Firefox lists the cross-site island frame
 * with no context to evaluate in: there the engine's own probes are not read).
 */
async function boot(page: Page, frameName: 'sch' | 'pcb'): Promise<Frame | null> {
  await page.goto(`/parent.html?fixture=glasgow&frame=${frameName}`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  await expect(page.locator('#state')).toContainText(`opened glasgow.kicad_${frameName}`, { timeout: 120_000 });
  return page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null;
}

const undoDepth = (frame: Frame): Promise<number> => frame.evaluate(() => Number((window as unknown as Engine).Module.kicadCollabTestUndoDepth()));
/** What is left under the engine's /tmp/cc-plot/ (the plot folders), or null when it does not exist. */
const plotLeft = (frame: Frame): Promise<string[] | null> => frame.evaluate(() => {
  const { FS } = window as unknown as Engine;
  return FS.analyzePath('/tmp/cc-plot').exists ? FS.readdir('/tmp/cc-plot').filter((n) => n !== '.' && n !== '..') : null;
});
const unreached = (): void => { test.info().annotations.push({ type: 'unreached', description: 'the island frame is out of Playwright\'s reach in this browser: the undo depth and the engine\'s /tmp/cc-plot/ were not read' }); };

/** Glasgow's fab plot: its four copper layers, both masks, pastes and silkscreens, the outline, two drill files and the job file. */
const FAB_NAMES = [
  'glasgow-B_Cu.gbr', 'glasgow-B_Mask.gbr', 'glasgow-B_Paste.gbr', 'glasgow-B_Silkscreen.gbr',
  'glasgow-Edge_Cuts.gbr',
  'glasgow-F_Cu.gbr', 'glasgow-F_Mask.gbr', 'glasgow-F_Paste.gbr', 'glasgow-F_Silkscreen.gbr',
  'glasgow-In1_Cu.gbr', 'glasgow-In2_Cu.gbr',
  'glasgow-NPTH.drl', 'glasgow-PTH.drl',
  'glasgow-job.gbrjob',
];

test('project.plot, fab preset, on Glasgow: a board house set with X2, nothing in the board changed, and the plot folder gone', async ({ page }) => {
  const frame = await boot(page, 'pcb');
  expect((await of(page, 'ev.ready'))[0]?.caps).toContain('plot');
  await page.waitForTimeout(1_500);   // the open's baseline read (ev.edited)
  const edits = (await of(page, 'ev.edited')).length;
  const depth = frame == null ? null : await undoDepth(frame);
  const fab = await plot(page, { preset: 'fab', drill: true, job: true });
  measure('project.plot fab, Glasgow', `${fab.ms} ms from the request to the answer, ${fab.files.length} files, ${fab.files.reduce((n, f) => n + f.bytes, 0)} bytes`);
  expect(fab.files.map((f) => f.path)).toEqual(FAB_NAMES);
  expect(fab.files.every((f) => f.owned && f.bytes > 0)).toBe(true);
  // Every Gerber names its function in X2; no Protel extension; the drill files are Excellon.
  for (const f of fab.files.filter((g) => g.path.endsWith('.gbr'))) expect(f.x2, f.path).toBe(true);
  expect(fab.files.some((f) => /\.g[a-z0-9]{2}$/.test(f.path) && !f.path.endsWith('.gbr'))).toBe(false);
  for (const f of fab.files.filter((g) => g.path.endsWith('.drl'))) expect(f.head, f.path).toBe('M48');
  const job = JSON.parse(fab.files.find((f) => f.path === 'glasgow-job.gbrjob')?.text ?? '{}') as { Header?: unknown; FilesAttributes?: Array<{ Path: string }> };
  expect(job.Header).toBeDefined();
  expect((job.FilesAttributes ?? []).map((a) => a.Path).sort()).toEqual(FAB_NAMES.filter((n) => n.endsWith('.gbr')));
  measure('project.plot fab notes', fab.notes.length === 0 ? 'none' : fab.notes.join(' | '));
  // Nothing in the board changed: no ev.edited within 2 s, the undo depth as before.
  await page.waitForTimeout(2_000);
  expect((await of(page, 'ev.edited')).length).toBe(edits);
  if (frame == null) { unreached(); return; }
  expect(await undoDepth(frame)).toBe(depth);
  expect(await plotLeft(frame)).toEqual([]);
});

test('project.plot, board preset, on Glasgow: the layers and options Glasgow\'s own plot settings select', async ({ page }) => {
  const frame = await boot(page, 'pcb');
  const board = await plot(page, { preset: 'board', drill: true, job: true });
  measure('project.plot board, Glasgow', `${board.ms} ms from the request to the answer, ${board.files.length} files, ${board.files.reduce((n, f) => n + f.bytes, 0)} bytes`);
  const names = board.files.map((f) => f.path);
  measure('project.plot board files', names.join(' '));
  // Glasgow's plot settings: Protel extensions on, X2 off, the
  // layer selection 4 copper layers, both pastes, silkscreens and masks, the outline, both
  // courtyards and both fab layers; the drill and job files as asked.
  expect(names).toEqual(expect.arrayContaining(['glasgow-F_Cu.gtl', 'glasgow-B_Cu.gbl', 'glasgow-F_Mask.gts', 'glasgow-B_Mask.gbs', 'glasgow-F_Paste.gtp', 'glasgow-B_Paste.gbp', 'glasgow-F_Silkscreen.gto', 'glasgow-B_Silkscreen.gbo', 'glasgow-Edge_Cuts.gm1', 'glasgow-PTH.drl', 'glasgow-NPTH.drl', 'glasgow-job.gbrjob']));
  expect(names.filter((n) => /In[12]_Cu/.test(n))).toHaveLength(2);
  expect(names.filter((n) => /Courtyard|CrtYd/.test(n))).toHaveLength(2);
  expect(names.filter((n) => /_Fab\./.test(n))).toHaveLength(2);
  expect(names).toHaveLength(18);
  const gerbers = board.files.filter((f) => !f.path.endsWith('.drl') && !f.path.endsWith('.gbrjob'));
  for (const f of gerbers) expect(f.x2, f.path).toBe(false);
  // No drill and no job file when neither is asked for.
  const bare = await plot(page, { preset: 'board', drill: false, job: false });
  expect(bare.files.map((f) => f.path).filter((n) => n.endsWith('.drl') || n.endsWith('.gbrjob'))).toEqual([]);
  expect(bare.files).toHaveLength(15);
  if (frame == null) { unreached(); return; }
  expect(await plotLeft(frame)).toEqual([]);
});

test('project.plot in a schematic is unsupported', async ({ page }) => {
  await boot(page, 'sch');
  expect((await of(page, 'ev.ready'))[0]?.caps).toContain('plot');
  expect(await refusal(page, 'project.plot', { preset: 'fab', drill: true, job: true })).toBe('unsupported: a board plots in a pcb frame');
});

// A project footprint the island places with no library mirror (project-libs.spec.ts writes the same one).
const FOOTPRINT = `(footprint "UFDFPN8"
\t(version 20241229)
\t(generator "pcbnew")
\t(layer "F.Cu")
\t(property "Reference" "REF**" (at 0 -2 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
\t(property "Value" "UFDFPN8" (at 0 2 0) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))))
\t(attr smd)
\t(pad "1" smd rect (at -0.75 0) (size 0.5 0.8) (layers "F.Cu" "F.Paste" "F.Mask"))
\t(pad "2" smd rect (at 0.75 0) (size 0.5 0.8) (layers "F.Cu" "F.Paste" "F.Mask"))
)
`;
const LIBRARY = [
  { path: 'glasgow_parts.pretty/UFDFPN8.kicad_mod', text: FOOTPRINT },
  { path: 'fp-lib-table', text: '(fp_lib_table\n  (version 7)\n  (lib (name "glasgow_parts")(type "KiCad")(uri "${KIPRJMOD}/glasgow_parts.pretty")(options "")(descr ""))\n)\n' },
];

test('project.plot answers busy while a placed part hangs off the pointer, and plots once it is dropped', async ({ page }) => {
  await boot(page, 'pcb');
  expect(await request(page, 'project.write', { files: LIBRARY })).toMatchObject({ written: expect.any(Array) });
  expect(await request(page, 'project.libs', { libs: ['glasgow_parts'] })).toMatchObject({ footprint: ['glasgow_parts'] });
  const box = await page.locator('iframe').boundingBox();
  if (box == null) throw new Error('no iframe box');
  await page.mouse.move(box.x + 640, box.y + 420, { steps: 4 });
  expect(await request(page, 'place', { kind: 'footprint', lib: 'glasgow_parts', name: 'UFDFPN8' })).toEqual({});
  expect(await refusal(page, 'project.plot', { preset: 'fab', drill: true, job: true })).toBe('busy: project.plot');
  expect(await request(page, 'key.press', { key: 'Escape', code: 'Escape' })).toEqual({});
  await expect.poll(() => refusal(page, 'project.plot', { preset: 'fab', drill: false, job: false }), { timeout: 15_000 }).toBe('ok');
});
