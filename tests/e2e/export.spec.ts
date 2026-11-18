// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// island v0.2.3-cc23 over the local pair, on the Glasgow example (PROTOCOL.md):
// project.export makes one output of the design with no KiCad dialog, through
// our engine's kicadExportBoardOutput (a pcb frame) or kicadExportSchematicOutput
// (a sch frame), engine run 14. Every row of the outputs spec's section 4 is
// made here with the settings its defaults send, each answered by the names
// kicad-cli's jobset runner gives them; nothing in the document changes, and
// the run's folder is gone after.
import { expect, test, type Frame, type Page } from '@playwright/test';
import EXPORT_FACES from '../../bridge/exports.json' with { type: 'json' };

import { ISLAND } from './ports';
interface Ev { type: string; phase?: string; caps?: string[]; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Engine { Module: { kicadCollabTestUndoDepth(): number; kicadOutputJobs(): string }; FS: { readdir(p: string): string[]; analyzePath(p: string): { exists: boolean } } }
interface Made { ok: true; ms: number; files: Array<{ path: string; bytes: number; owned: boolean; head: string }>; notes: string[]; dropped: string[] }
interface Refused { ok: false; ms: number; code: string; message: string }
type Answer = Made | Refused;

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
 * project.export from the host page, its answer read there (the bytes stay in
 * the page): each file's path, size, whether it owns its buffer and its first
 * 64 characters, the notes, the dropped keys and the latency; or the refusal.
 */
const make = (page: Page, args: unknown): Promise<Answer> => page.evaluate(async (a) => {
  const t0 = performance.now();
  try {
    const r = await (window as unknown as Harness).__bridge.request('project.export', a) as { files: Array<{ path: string; bytes: Uint8Array }>; notes: string[]; dropped: string[] };
    const ms = Math.round(performance.now() - t0);
    const dec = new TextDecoder();
    return {
      ok: true as const, ms, notes: r.notes, dropped: r.dropped,
      files: r.files.map((f) => ({
        path: f.path,
        bytes: f.bytes.byteLength,
        owned: f.bytes instanceof Uint8Array && f.bytes.byteOffset === 0 && f.bytes.byteLength === f.bytes.buffer.byteLength,
        head: dec.decode(f.bytes.subarray(0, 64)),
      })),
    };
  } catch (err) {
    const [code, ...rest] = (err as Error).message.split(': ');
    return { ok: false as const, ms: Math.round(performance.now() - t0), code, message: rest.join(': ') };
  }
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
/** What is left under the engine's /tmp/cc-out/ (the run folders), or null when it does not exist. */
const outLeft = (frame: Frame): Promise<string[] | null> => frame.evaluate(() => {
  const { FS } = window as unknown as Engine;
  return FS.analyzePath('/tmp/cc-out').exists ? FS.readdir('/tmp/cc-out').filter((n) => n !== '.' && n !== '..') : null;
});
const unreached = (): void => { test.info().annotations.push({ type: 'unreached', description: 'the island frame is out of Playwright\'s reach in this browser: the undo depth and the engine\'s /tmp/cc-out/ were not read' }); };

/**
 * Section 4's default layers, by the names KiCad's jobs read (the file format's,
 * LSET::Name: F.SilkS, never the shown F.Silkscreen, which the job's layer list
 * leaves out); the files are named by the shown names (glasgow-F_Silkscreen.pdf).
 */
const BOARD_LAYERS = ['F.Cu', 'B.Cu', 'F.SilkS', 'B.SilkS', 'Edge.Cuts'];
/** KiCad's own BOM fields as kicad-cli's sch export bom fills them by default. */
const BOM_FIELDS = {
  fields_ordered: ['Reference', 'Value', 'Footprint', '${QUANTITY}', '${DNP}'],
  fields_labels: ['Refs', 'Value', 'Footprint', 'Qty', 'DNP'],
  fields_group_by: ['Value', 'Footprint'],
};

interface Row { id: string; args: { job: string; settings: Record<string, unknown>; pages?: string[] }; names?: RegExp[]; exact?: string[]; failed?: RegExp }

/** Section 4's board rows (O2 to O23 but O8, O14 to O16 and O24), with the settings their defaults send. */
const BOARD_ROWS: Row[] = [
  { id: 'O2 drill map', args: { job: 'pcb_export_drill', settings: { map_format: 'pdf' } }, exact: ['glasgow-NPTH-drl_map.pdf', 'glasgow-NPTH.drl', 'glasgow-PTH-drl_map.pdf', 'glasgow-PTH.drl'] },
  { id: 'O2 drill map as Gerber', args: { job: 'pcb_export_drill', settings: { map_format: 'gerberx2' } }, exact: ['glasgow-NPTH-drl_map.gbr', 'glasgow-NPTH.drl', 'glasgow-PTH-drl_map.gbr', 'glasgow-PTH.drl'] },
  { id: 'O2 drill map as SVG', args: { job: 'pcb_export_drill', settings: { map_format: 'svg' } }, names: [/^glasgow-PTH-drl_map\.svg$/] },
  { id: 'O2 drill map as DXF', args: { job: 'pcb_export_drill', settings: { map_format: 'dxf' } }, names: [/^glasgow-PTH-drl_map\.dxf$/] },
  { id: 'O2 drill map as PostScript', args: { job: 'pcb_export_drill', settings: { map_format: 'postscript' } }, names: [/^glasgow-PTH-drl_map\.ps$/] },
  { id: 'O2 drill report', args: { job: 'pcb_export_drill', settings: { generate_report: true } }, names: [/^glasgow-drill\.rpt$/] },
  { id: 'O3 IPC-D-356', args: { job: 'pcb_export_ipcd356', settings: {} }, exact: ['glasgow.d356'] },
  { id: 'O4 IPC-2581', args: { job: 'pcb_export_ipc2581', settings: { version: 'C', units: 'mm', compress: false, 'field_bom_map.mfg_pn': 'MPN', 'field_bom_map.mfg': 'Manufacturer' } }, exact: ['glasgow.xml'] },
  { id: 'O4 IPC-2581 compressed', args: { job: 'pcb_export_ipc2581', settings: { compress: true } }, exact: ['glasgow.zip'] },
  { id: 'O5 ODB++', args: { job: 'pcb_export_odb', settings: { units: 'mm' } }, exact: ['glasgow-odb.zip'] },
  { id: 'O6 GenCAD', args: { job: 'pcb_export_gencad', settings: {} }, exact: ['glasgow.cad'] },
  { id: 'O7 placement file', args: { job: 'pcb_export_pos', settings: { format: 'csv', units: 'mm', side: 'both', single_file: true, smd_only: false, exclude_footprints_with_th: false, exclude_dnp: false, use_drill_place_file_origin: false } }, exact: ['glasgow-all-pos.csv'] },
  { id: 'O7 placement file, two sides', args: { job: 'pcb_export_pos', settings: { format: 'ascii', single_file: false } }, exact: ['glasgow-bottom.pos', 'glasgow-top.pos'] },
  { id: 'O7 placement file as Gerber', args: { job: 'pcb_export_pos', settings: { format: 'gerber' } }, exact: ['glasgow-pnp_bottom.gbr', 'glasgow-pnp_top.gbr'] },
  { id: 'O9 footprint report', args: { job: 'cc_footprint_report', settings: { units: 'mm' } }, exact: ['glasgow.rpt'] },
  { id: 'O10 board as PDF, a page per layer', args: { job: 'pcb_export_pdf', settings: { layers: BOARD_LAYERS, pdf_gen_mode: 'one-page-per-layer-one-file', single_document: true } }, exact: ['glasgow.pdf'] },
  { id: 'O10 board as PDF, all layers on one page', args: { job: 'pcb_export_pdf', settings: { layers: BOARD_LAYERS, pdf_gen_mode: 'all-layers-one-file' } }, exact: ['glasgow.pdf'] },
  { id: 'O10 board as PDF, a file per layer', args: { job: 'pcb_export_pdf', settings: { layers: BOARD_LAYERS, pdf_gen_mode: 'one-page-per-layer-one-file', single_document: false } }, exact: ['glasgow-B_Cu.pdf', 'glasgow-B_Silkscreen.pdf', 'glasgow-Edge_Cuts.pdf', 'glasgow-F_Cu.pdf', 'glasgow-F_Silkscreen.pdf'] },
  { id: 'O11 board as SVG', args: { job: 'pcb_export_svg', settings: { layers: BOARD_LAYERS, gen_mode: 'multi', fit_page_to_board: true } }, exact: ['glasgow-B_Cu.svg', 'glasgow-B_Silkscreen.svg', 'glasgow-Edge_Cuts.svg', 'glasgow-F_Cu.svg', 'glasgow-F_Silkscreen.svg'] },
  { id: 'O11 board as SVG, one file', args: { job: 'pcb_export_svg', settings: { layers: BOARD_LAYERS, gen_mode: 'single' } }, exact: ['glasgow.svg'] },
  { id: 'O12 board as DXF', args: { job: 'pcb_export_dxf', settings: { layers: ['F.Cu', 'Edge.Cuts'], gen_mode: 'multi', units: 'mm' } }, exact: ['glasgow-Edge_Cuts.dxf', 'glasgow-F_Cu.dxf'] },
  { id: 'O13 board as PostScript', args: { job: 'pcb_export_ps', settings: { layers: ['F.Cu'], gen_mode: 'multi' } }, exact: ['glasgow-F_Cu.ps'] },
  { id: 'O17 VRML', args: { job: 'pcb_export_3d', settings: { format: 'vrml' } }, exact: ['glasgow.wrl'] },
  { id: 'O18 IDF', args: { job: 'cc_idf', settings: { units: 'mm', include_unspecified: false, include_dnp: false } }, exact: ['glasgow.emn', 'glasgow.emp'] },
  { id: 'O19 Specctra DSN', args: { job: 'cc_specctra_dsn', settings: {} }, failed: /^IO_ERROR: Multiple footprints have the reference designator 'REF\*\*'\./ },
  { id: 'O20 Hyperlynx', args: { job: 'cc_hyperlynx', settings: {} }, exact: ['glasgow.hyp'] },
  { id: 'O21 footprint associations', args: { job: 'cc_footprint_associations', settings: {} }, exact: ['glasgow.cmp'] },
  { id: 'O22 board statistics, text', args: { job: 'pcb_export_stats', settings: { output_format: 0, units: 'mm', exclude_footprints_without_pads: true, subtract_holes_from_board: true, subtract_holes_from_copper: true } }, exact: ['glasgow_statistics.rpt'] },
  { id: 'O22 board statistics, JSON', args: { job: 'pcb_export_stats', settings: { output_format: 1 } }, exact: ['glasgow_statistics.json'] },
  { id: 'O23 the board\'s footprints', args: { job: 'cc_footprints', settings: {} }, names: [/^glasgow\.pretty\/[^/]+\.kicad_mod$/] },
  { id: 'a jobset\'s Gerbers', args: { job: 'pcb_export_gerbers', settings: { layers: ['F.Cu', 'Edge.Cuts'] } }, exact: ['glasgow-Edge_Cuts.gm1', 'glasgow-F_Cu.gtl', 'glasgow-job.gbrjob'] },
];

/** Section 4's schematic rows (O8, O14 to O16, O24). */
const SCHEMATIC_ROWS: Row[] = [
  { id: 'O8 bill of materials, grouped', args: { job: 'sch_export_bom', settings: { ...BOM_FIELDS, group_symbols: true } }, exact: ['glasgow.csv'] },
  { id: 'O8 bill of materials, one row per part', args: { job: 'sch_export_bom', settings: { ...BOM_FIELDS, group_symbols: false, exclude_dnp: true } }, exact: ['glasgow.csv'] },
  { id: 'O14 schematic as PDF, every sheet', args: { job: 'sch_export_plot_pdf', settings: {} }, exact: ['glasgow.pdf'] },
  { id: 'O14 schematic as PDF, this sheet', args: { job: 'sch_export_plot_pdf', settings: { black_and_white: true }, pages: ['1'] }, exact: ['glasgow.pdf'] },
  { id: 'O15 schematic as SVG', args: { job: 'sch_export_plot_svg', settings: {} }, names: [/\.svg$/, /\.svg$/, /\.svg$/, /\.svg$/] },
  { id: 'O15 schematic as SVG, this sheet', args: { job: 'sch_export_plot_svg', settings: {}, pages: ['1'] }, names: [/\.svg$/] },
  { id: 'O15 schematic as DXF', args: { job: 'sch_export_plot_dxf', settings: { plot_drawing_sheet: true } }, names: [/\.dxf$/, /\.dxf$/, /\.dxf$/, /\.dxf$/] },
  { id: 'O15 schematic as PostScript', args: { job: 'sch_export_plot_ps', settings: {} }, names: [/\.ps$/, /\.ps$/, /\.ps$/, /\.ps$/] },
  { id: 'O16 netlist, KiCad', args: { job: 'sch_export_netlist', settings: { format: 'kicad' } }, exact: ['glasgow.net'] },
  { id: 'O16 netlist, KiCad XML', args: { job: 'sch_export_netlist', settings: { format: 'xml' } }, exact: ['glasgow.xml'] },
  { id: 'O16 netlist, OrcadPCB2', args: { job: 'sch_export_netlist', settings: { format: 'orcadpcb2' } }, exact: ['glasgow.net'] },
  { id: 'O16 netlist, CadStar', args: { job: 'sch_export_netlist', settings: { format: 'cadstar' } }, exact: ['glasgow.frp'] },
  { id: 'O16 netlist, Allegro', args: { job: 'sch_export_netlist', settings: { format: 'allegro' } }, names: [/^glasgow/, /^devices\//] },
  { id: 'O16 netlist, PADS', args: { job: 'sch_export_netlist', settings: { format: 'pads' } }, exact: ['glasgow.asc'] },
  { id: 'O16 netlist, SPICE', args: { job: 'sch_export_netlist', settings: { format: 'spice' } }, exact: ['glasgow.cir'] },
  { id: 'O16 netlist, SPICE model', args: { job: 'sch_export_netlist', settings: { format: 'spicemodel' } }, exact: ['glasgow.cir'] },
  { id: 'O24 the design\'s symbols', args: { job: 'cc_symbols', settings: {} }, exact: ['glasgow.kicad_sym'] },
];

/** Runs every row in turn, each answer described; the checks follow, so one row's failure names it beside every other's answer. */
async function runRows(page: Page, rows: Row[]): Promise<Array<{ row: Row; answer: Answer }>> {
  const out: Array<{ row: Row; answer: Answer }> = [];
  for (const row of rows) {
    const answer = await make(page, row.args);
    out.push({ row, answer });
    measure(row.id, answer.ok
      ? `${answer.ms} ms, ${answer.files.length} files, ${answer.files.reduce((n, f) => n + f.bytes, 0)} bytes: ${answer.files.slice(0, 8).map((f) => `${f.path} ${f.bytes}`).join(', ')}${answer.files.length > 8 ? ', ...' : ''}${answer.notes.length > 0 ? `; notes: ${answer.notes.slice(0, 3).join(' | ')}` : ''}${answer.dropped.length > 0 ? `; dropped: ${answer.dropped.join(' ')}` : ''}`
      : `${answer.ms} ms, ${answer.code}: ${answer.message}`);
  }
  return out;
}

function checkRows(results: Array<{ row: Row; answer: Answer }>, known: Readonly<Record<string, RegExp>> = {}): void {
  for (const { row, answer } of results) {
    const failedHere = known[row.id] ?? row.failed;
    if (failedHere != null) {
      expect(answer.ok, row.id).toBe(false);
      if (!answer.ok) { expect(answer.code, row.id).toBe('export_failed'); expect(answer.message, row.id).toMatch(failedHere); }
      continue;
    }
    expect(answer.ok, `${row.id}: ${answer.ok ? '' : `${answer.code}: ${answer.message}`}`).toBe(true);
    if (!answer.ok) continue;
    const names = answer.files.map((f) => f.path);
    expect([...names].sort(), row.id).toEqual(names);
    for (const f of answer.files) { expect(f.owned, `${row.id} ${f.path}`).toBe(true); expect(f.bytes, `${row.id} ${f.path}`).toBeGreaterThan(0); }
    if (row.exact != null) expect(names, row.id).toEqual(row.exact);
    for (const re of row.names ?? []) expect(names.some((n) => re.test(n)), `${row.id}: ${re} in ${names.join(' ')}`).toBe(true);
    if (row.names != null) expect(names.length, `${row.id}: ${names.join(' ')}`).toBeGreaterThanOrEqual(row.names.length);
  }
}

/**
 * Rows the engine run 14 does not make, each with the line it answers: VRML's
 * exporter writes only the VRML header in this engine (BUILD-NOTES-run14.md,
 * pcbjam 44e3e9f), so the engine answers it failed rather than offer an empty
 * scene; Specctra DSN on Glasgow is refused by KiCad's own exporter (two
 * footprints named REF**), as kicad-cli 10.0.4's Python export is.
 */
const KNOWN_FAILED: Readonly<Record<string, RegExp>> = {
  'O17 VRML': /^The VRML exporter wrote no board \(an empty scene\)\.$/,
  // KiCad's drill job names the report <board>-drill.rpt inside the run's folder and then
  // resolves that path against the folder a second time, so GenDrillReportFile fails and the
  // job ends with code 4 (ERR_INVALID_OUTPUT_CONFLICT) and no error line; engine run 14
  // forces report_filename to its empty default, so no setting can avoid it here.
  'O2 drill report': /^the export ended with code 4$/,
};

test('project.export, every board output on Glasgow: each answered by its names, nothing in the board changed, and the run folders gone', async ({ page }) => {
  test.setTimeout(900_000);
  // island.json lists every job the island runs, sorted, as exportKinds.
  const islandRes = await page.goto(`${ISLAND}/island.json`);
  const island = JSON.parse(await islandRes!.text()) as { ops: string[]; exportKinds: string[] };
  expect(island.exportKinds).toEqual(Object.keys(EXPORT_FACES).sort());
  expect(island.ops).toEqual(expect.arrayContaining(['project.export', 'board.rules']));
  const frame = await boot(page, 'pcb');
  const caps = (await of(page, 'ev.ready'))[0]?.caps ?? [];
  expect(caps).toEqual(expect.arrayContaining(['export', 'rules']));
  if (frame != null) {
    // The engine runs exactly the island's jobs, each in its face.
    const jobs = JSON.parse(await frame.evaluate(() => (window as unknown as Engine).Module.kicadOutputJobs())) as { board: Record<string, unknown>; schematic: Record<string, unknown> };
    const faces = EXPORT_FACES as Record<string, string>;
    expect(Object.keys(jobs.board).sort()).toEqual(Object.keys(faces).filter((j) => faces[j] === 'pcb').sort());
    expect(Object.keys(jobs.schematic).sort()).toEqual(Object.keys(faces).filter((j) => faces[j] === 'sch').sort());
  }
  await page.waitForTimeout(1_500);   // the open's baseline read (ev.edited)
  const edits = (await of(page, 'ev.edited')).length;
  const depth = frame == null ? null : await undoDepth(frame);
  const results = await runRows(page, BOARD_ROWS);
  checkRows(results, KNOWN_FAILED);
  // The Specctra refusal is KiCad's own line, the frame's paths taken out.
  const dsn = results.find((r) => r.row.args.job === 'cc_specctra_dsn')?.answer;
  if (dsn != null && !dsn.ok) expect(dsn.message).not.toMatch(/\/tmp\/|\/home\/kicad/);
  // A schematic output in a board frame is refused before anything runs.
  expect(await refusal(page, 'project.export', { job: 'sch_export_bom', settings: {} })).toBe('unsupported: a schematic output runs in a sch frame');
  // Nothing in the board changed: no ev.edited within 2 s, the undo depth as before.
  await page.waitForTimeout(2_000);
  expect((await of(page, 'ev.edited')).length).toBe(edits);
  expect(await of(page, 'ev.menu')).toEqual([]);
  if (frame == null) { unreached(); return; }
  expect(await undoDepth(frame)).toBe(depth);
  expect(await outLeft(frame)).toEqual([]);
});

test('project.export, every schematic output on Glasgow: each answered by its names, pages, nothing in the schematic changed', async ({ page }) => {
  test.setTimeout(900_000);
  const frame = await boot(page, 'sch');
  expect((await of(page, 'ev.ready'))[0]?.caps).toContain('export');
  await page.waitForTimeout(1_500);
  const edits = (await of(page, 'ev.edited')).length;
  const depth = frame == null ? null : await undoDepth(frame);
  const results = await runRows(page, SCHEMATIC_ROWS);
  checkRows(results);
  // Every sheet in one PDF is larger than its first sheet alone.
  const size = (id: string): number => { const a = results.find((r) => r.row.id === id)?.answer; return a?.ok === true ? a.files.reduce((n, f) => n + f.bytes, 0) : 0; };
  expect(size('O14 schematic as PDF, every sheet')).toBeGreaterThan(size('O14 schematic as PDF, this sheet'));
  for (const id of ['O14 schematic as PDF, every sheet', 'O14 schematic as PDF, this sheet']) {
    const a = results.find((r) => r.row.id === id)?.answer;
    if (a?.ok === true) expect(a.files[0].head.startsWith('%PDF'), id).toBe(true);
  }
  // A board output in a schematic frame is refused; pages ride only a schematic plot.
  expect(await refusal(page, 'project.export', { job: 'pcb_export_pos', settings: {} })).toBe('unsupported: a board output runs in a pcb frame');
  expect(await refusal(page, 'project.export', { job: 'sch_export_bom', settings: {}, pages: ['1'] })).toBe('bad_args: project.export');
  await page.waitForTimeout(2_000);
  expect((await of(page, 'ev.edited')).length).toBe(edits);
  expect(await of(page, 'ev.menu')).toEqual([]);
  if (frame == null) { unreached(); return; }
  expect(await undoDepth(frame)).toBe(depth);
  expect(await outLeft(frame)).toEqual([]);
});

test('project.export reads KiCad\'s own settings: unknown keys dropped and named, a known key of another type refused, a 3D format other than VRML failed', async ({ page }) => {
  await boot(page, 'pcb');
  // A desktop jobset written by another KiCad carries keys this one lacks: left out and named.
  const dropped = await make(page, { job: 'pcb_export_ipcd356', settings: { hpgl_page_size: 'A4', output_filename: 'elsewhere.d356' } });
  expect(dropped.ok).toBe(true);
  if (dropped.ok) {
    expect(dropped.dropped).toEqual(['hpgl_page_size']);
    // The output's name is the jobset runner's, whatever was sent.
    expect(dropped.files.map((f) => f.path)).toEqual(['glasgow.d356']);
  }
  expect(await refusal(page, 'project.export', { job: 'pcb_export_pos', settings: { single_file: 'yes' } })).toBe('bad_args: the engine refused the settings');
  expect(await refusal(page, 'project.export', { job: 'cc_footprint_report', settings: { units: 'mm', extra: true } })).toBe('bad_args: the engine refused the settings');
  const step = await make(page, { job: 'pcb_export_3d', settings: { format: 'step' } });
  expect(step).toMatchObject({ ok: false, code: 'export_failed', message: 'Only VRML is made here.' });
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

test('project.export answers busy while a placed part hangs off the pointer, and makes the output once it is dropped', async ({ page }) => {
  await boot(page, 'pcb');
  expect(await request(page, 'project.write', { files: LIBRARY })).toMatchObject({ written: expect.any(Array) });
  expect(await request(page, 'project.libs', { libs: ['glasgow_parts'] })).toMatchObject({ footprint: ['glasgow_parts'] });
  const box = await page.locator('iframe').boundingBox();
  if (box == null) throw new Error('no iframe box');
  await page.mouse.move(box.x + 640, box.y + 420, { steps: 4 });
  expect(await request(page, 'place', { kind: 'footprint', lib: 'glasgow_parts', name: 'UFDFPN8' })).toEqual({});
  expect(await refusal(page, 'project.export', { job: 'pcb_export_ipcd356', settings: {} })).toBe('busy: project.export');
  expect(await request(page, 'key.press', { key: 'Escape', code: 'Escape' })).toEqual({});
  await expect.poll(() => refusal(page, 'project.export', { job: 'pcb_export_ipcd356', settings: {} }), { timeout: 15_000 }).toBe('ok');
});
