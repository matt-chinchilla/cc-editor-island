// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// i-sheetreload over the local pair, on the fixture ds-basic (KiCad's own
// basic_test, whose schematic and board both name custom_ds.kicad_wks as
// their drawing sheet) with the sheet tests/fixtures/ds-small/every-item.kicad_wks
// written over it by project.write. sheet.reload is engine run 15's
// (kicadDrawingSheetReload, cap sheetReload). On an engine without it the op
// answers unsupported naming the export and the cap is not listed, and a
// board's PDF plot keeps the old sheet after the write. On run 15 the board's
// plot carries the new sheet only after sheet.reload, the reload is no edit
// (no ev.edited), and a sheet that does not read still answers {}. A
// schematic plot reads the sheet file itself, so it proves nothing of the
// reload: in a sch frame the op's answer and the quiet are checked.
import { expect, test, type Page } from '@playwright/test';

interface Ev { type: string; phase?: string; caps?: string[] }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }

const SHEET = 'custom_ds.kicad_wks';
const NEW_SHEET = '/fixtures/ds-small/every-item.kicad_wks';
const BROKEN_SHEET = '/fixtures/ds-small/broken.kicad_wks';
/** A board PDF with the drawing sheet plotted: one page, the outline layer alone, so the sheet is most of what it draws. */
const BOARD_PDF = { job: 'pcb_export_pdf', settings: { layers: ['Edge.Cuts'], plot_drawing_sheet: true, pdf_gen_mode: 'all-layers-one-file' } };
/** The same plot without the drawing sheet: it must differ, or the digest would prove nothing of the sheet. */
const BOARD_PDF_NO_SHEET = { ...BOARD_PDF, settings: { ...BOARD_PDF.settings, plot_drawing_sheet: false } };

function measure(type: string, description: string): void {
  test.info().annotations.push({ type, description });
  console.log(`[measure] ${type}: ${description}`);
}

const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const edits = async (page: Page): Promise<number> => (await events(page)).filter((e) => e.type === 'ev.edited').length;
const request = (page: Page, op: string, args?: unknown): Promise<Record<string, unknown>> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const);
/** A request's refusal as "code: message", or "ok". */
const refusal = (page: Page, op: string, args?: unknown): Promise<string> =>
  request(page, op, args).then(() => 'ok', (err: Error) => err.message.split('\n')[0].replace(/^.*?page\.evaluate:\s*/, '').replace(/^Error:\s*/, ''));

/** Writes the text served at `url` over the design's drawing sheet by project.write. */
async function writeSheet(page: Page, url: string): Promise<void> {
  const text = await page.evaluate(async (u) => (await fetch(u)).text(), url);
  expect(await request(page, 'project.write', { files: [{ path: SHEET, text }] })).toEqual({ written: [SHEET] });
}

/**
 * The board's PDF plot, read in the page: every stream of the file inflated
 * (FlateDecode by the browser's own DecompressionStream; a stream that does
 * not inflate is taken as it is) and joined, so the dates of the file's info
 * dictionary never count; answers the SHA-256 of that and the PDF's size.
 */
const boardPlot = (page: Page, job: typeof BOARD_PDF = BOARD_PDF): Promise<{ digest: string; bytes: number; streams: number }> => page.evaluate(async (args) => {
  const r = await (window as unknown as Harness).__bridge.request('project.export', args) as { files: Array<{ path: string; bytes: Uint8Array }> };
  const pdf = r.files.find((f) => f.path.endsWith('.pdf'));
  if (pdf == null) throw new Error(`no pdf among ${r.files.map((f) => f.path).join(', ')}`);
  const b = pdf.bytes;
  let s = '';
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  const inflate = async (raw: Uint8Array): Promise<Uint8Array> => {
    try {
      const out = new Response(new Blob([new Uint8Array(raw)]).stream().pipeThrough(new DecompressionStream('deflate')));
      return new Uint8Array(await out.arrayBuffer());
    } catch { return raw; }
  };
  const parts: Uint8Array[] = [];
  let at = 0;
  for (;;) {
    const open = s.indexOf('stream', at);
    if (open < 0) break;
    if (s.slice(open - 3, open) === 'end') { at = open + 6; continue; }
    let start = open + 6;
    if (s[start] === '\r') start += 1;
    if (s[start] === '\n') start += 1;
    let end = s.indexOf('endstream', start);
    if (end < 0) break;
    at = end + 9;
    if (s[end - 1] === '\n') end -= 1;
    if (s[end - 1] === '\r') end -= 1;
    parts.push(await inflate(b.subarray(start, end)));
  }
  const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { joined.set(p, o); o += p.length; }
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', joined));
  return { digest: [...hash].map((x) => x.toString(16).padStart(2, '0')).join(''), bytes: b.length, streams: parts.length };
}, job);

/** The page with ds-basic open in a frame of that kind; ev.ready's caps. */
async function boot(page: Page, frame: 'sch' | 'pcb'): Promise<string[]> {
  await page.goto(`/parent.html?fixture=ds-basic&frame=${frame}`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  await expect(page.locator('#state')).toContainText(`opened basic_test.kicad_${frame}`, { timeout: 120_000 });
  return (await events(page)).find((e) => e.type === 'ev.ready')?.caps ?? [];
}

for (const frame of ['sch', 'pcb'] as const) {
  test(`sheet.reload in a ${frame} frame: the drawing sheet read again by the engine's export, no edit`, async ({ page }) => {
    try {
      const caps = await boot(page, frame);
      const run15 = caps.includes('sheetReload');
      measure('engine', run15 ? 'run 15 export: sheetReload listed' : 'no run 15 export: sheetReload not listed');

      // The args are read first on any engine.
      expect(await refusal(page, 'sheet.reload', { all: true })).toBe('bad_args: sheet.reload');

      let before: Awaited<ReturnType<typeof boardPlot>> | null = null;
      if (frame === 'pcb') {
        const first = await boardPlot(page);
        const again = await boardPlot(page);
        measure('plot', `${first.bytes} bytes, ${first.streams} streams`);
        // The digest reads the plot, not the run: two plots of one design agree.
        expect(again.digest).toBe(first.digest);
        // The plot carries the drawing sheet: without it the plot reads otherwise.
        expect((await boardPlot(page, BOARD_PDF_NO_SHEET)).digest).not.toBe(first.digest);
        before = first;
      }
      await writeSheet(page, NEW_SHEET);
      if (before != null) {
        // A board's plot keeps the sheet the board read until the reload.
        expect((await boardPlot(page)).digest).toBe(before.digest);
      }

      if (!run15) {
        expect(await refusal(page, 'sheet.reload')).toBe('unsupported: kicadDrawingSheetReload');
        expect(await refusal(page, 'sheet.reload', {})).toBe('unsupported: kicadDrawingSheetReload');
        return;
      }

      const edited = await edits(page);
      let t0 = Date.now();
      expect(await request(page, 'sheet.reload')).toEqual({});
      measure('sheet.reload', `${Date.now() - t0} ms`);
      if (before != null) {
        const after = await boardPlot(page);
        measure('plot after the reload', `${after.bytes} bytes, ${after.streams} streams`);
        expect(after.digest).not.toBe(before.digest);
      }

      // A sheet that does not read: KiCad's default sheet, still {}; and the reload again with an empty object.
      await writeSheet(page, BROKEN_SHEET);
      t0 = Date.now();
      expect(await request(page, 'sheet.reload', {})).toEqual({});
      measure('sheet.reload of a sheet that does not read', `${Date.now() - t0} ms`);

      // No edit: no ev.edited came (given a moment to arrive).
      await page.waitForTimeout(500);
      expect(await edits(page)).toBe(edited);
    } finally {
      await page.close();
    }
  });
}
