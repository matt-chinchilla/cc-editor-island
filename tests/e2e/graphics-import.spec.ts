// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// fp-i5 over the local pair (PROTOCOL.md graphics.import): a DXF and an SVG
// drawing brought into the open document of a sch, pcb, symedit and fpedit
// frame by KiCad's own importer with no window of KiCad's, as ONE undo step
// at a point, or hanging on the pointer (a click places it, Esc leaves
// nothing); KiCad's own Import Graphics (Ctrl+Shift+F) held in a sch and a
// pcb frame as ev.held; a file that is neither drawing answers not_a_drawing.
// The drawings are tests/fixtures/drawings (written by hand, CC0), the
// documents fpedit-small's board and SOIC and symedit-small's schematic and
// symbol.
//
// The first test runs on every engine: before engine run 15 no frame lists
// importGraphics and graphics.import answers unsupported naming
// kicadImportGraphics. Every other test needs run 15 (kicadImportGraphics,
// unit fp-e8) and is skipped on an engine whose frame lists no importGraphics.
import { expect, test, type Page } from '@playwright/test';

interface Ev { type: string; phase?: string; caps?: string[]; action?: string; depth?: number; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Key { key: string; code: string; ctrl?: boolean; shift?: boolean; alt?: boolean }
interface Imported { items: number; uuids: string[]; warnings: string[] }

const RUN15 = 'waits for engine run 15 (kicadImportGraphics, unit fp-e8)';
const DRAWINGS = ['/fixtures/drawings/outline.dxf', '/fixtures/drawings/logo.svg'] as const;
const FP_LIB = 'fpedit-small_parts';
const SOIC = 'SOIC-8_3.9x4.9mm_P1.27mm';
const SYM_LIB = 'symedit-small_parts';
const UNDO: Key = { key: 'z', code: 'KeyZ', ctrl: true };
const ESC: Key = { key: 'Escape', code: 'Escape' };
const IMPORT_KEY: Key = { key: 'F', code: 'KeyF', ctrl: true, shift: true };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The frames, each with the fixture it opens and KiCad's Import Graphics action it holds (null: held elsewhere or asked). */
const FRAMES = [
  { frame: 'pcb', fixture: 'fpedit-small', doc: 'fpedit-small.kicad_pcb', held: 'pcbnew.InteractiveDrawing.placeImportedGraphics', layer: 'Dwgs.User' },
  { frame: 'sch', fixture: 'symedit-small', doc: 'symedit-small.kicad_sch', held: 'eeschema.EditorControl.importGraphics', layer: null },
  { frame: 'symedit', fixture: null, doc: '', held: null, layer: null },
  { frame: 'fpedit', fixture: null, doc: '', held: null, layer: 'F.SilkS' },
] as const;
type FrameRow = typeof FRAMES[number];

const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const of = async (page: Page, type: string): Promise<Ev[]> => (await events(page)).filter((e) => e.type === type);
const request = (page: Page, op: string, args?: unknown): Promise<Record<string, unknown>> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const);
const text = (page: Page, path: string): Promise<string> => page.evaluate(async (p) => (await fetch(p)).text(), path);
/** graphics.import of a fixture's bytes (fetched in the page) with `args`; a refusal reads as "code: message". */
const importFile = (page: Page, path: string, args: Record<string, unknown>): Promise<Imported | string> =>
  page.evaluate(async ([p, a]) => {
    const bytes = new Uint8Array(await (await fetch(p as string)).arrayBuffer());
    const name = (p as string).split('/').pop() as string;
    return (window as unknown as Harness).__bridge.request('graphics.import', { ...(a as Record<string, unknown>), name, bytes })
      .then((r) => r as unknown as Imported, (e: Error) => e.message.replace(/^Error:\s*/, ''));
  }, [path, args] as const);
const importBytes = (page: Page, name: string, body: string, args: Record<string, unknown>): Promise<Imported | string> =>
  page.evaluate(([n, b, a]) => (window as unknown as Harness).__bridge.request('graphics.import', { ...(a as Record<string, unknown>), name: n, bytes: new TextEncoder().encode(b as string) })
    .then((r) => r as unknown as Imported, (e: Error) => e.message.replace(/^Error:\s*/, '')), [name, body, args] as const);

async function boot(page: Page, row: FrameRow): Promise<string[]> {
  await page.goto(row.fixture == null ? `/parent.html?frame=${row.frame}` : `/parent.html?fixture=${row.fixture}&frame=${row.frame}`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  expect((await of(page, 'ev.state')).filter((e) => e.phase === 'fatal' || e.phase === 'blocked')).toEqual([]);
  if (row.doc !== '') await expect(page.locator('#state')).toContainText(`opened ${row.doc}`, { timeout: 120_000 });
  return (await of(page, 'ev.ready'))[0]?.caps ?? [];
}

/** Boots `row`'s frame and opens its document, skipping on an engine without the import. */
async function bootImporting(page: Page, row: FrameRow): Promise<void> {
  if (row.frame === 'symedit' || row.frame === 'fpedit') {
    // A symbol or footprint editor on an older engine never reaches ev.ready: a schematic frame reads the export first.
    test.skip(!(await boot(page, FRAMES[1])).includes('kicadImportGraphics'), RUN15);
  }
  const caps = await boot(page, row);
  test.skip(!caps.includes('importGraphics'), RUN15);
  if (row.frame === 'fpedit') {
    await request(page, 'fpedit.open', { text: await text(page, `/fixtures/fpedit-small/${FP_LIB}.pretty/${SOIC}.kicad_mod`), name: SOIC, lib: FP_LIB, mode: 'library', discard: true });
  } else if (row.frame === 'symedit') {
    await request(page, 'symedit.open', { text: await text(page, `/fixtures/symedit-small/${SYM_LIB}.kicad_sym`), name: 'OPAMP2', lib: SYM_LIB, mode: 'library', discard: true });
  }
  await page.waitForTimeout(1_000);
}

/** The open document's undo depth: the editor's own state, or (sch, pcb) the last ev.edited, waiting for `after` more of them. */
async function depthAfter(page: Page, row: FrameRow, edits: number, after: number): Promise<number> {
  if (row.frame === 'fpedit') return (await request(page, 'fpedit.state')).depth as number;
  if (row.frame === 'symedit') return (await request(page, 'symedit.state')).depth as number;
  await expect.poll(async () => (await of(page, 'ev.edited')).length, { timeout: 5_000 }).toBeGreaterThanOrEqual(edits + after);
  return (await of(page, 'ev.edited')).at(-1)?.depth ?? -1;
}

test('run 14 or 15: a pcb and a sch frame without kicadImportGraphics list no importGraphics and answer unsupported naming it', async ({ page }) => {
  for (const row of FRAMES.slice(0, 2)) {
    const caps = await boot(page, row);
    if (caps.includes('kicadImportGraphics')) {
      expect(caps, row.frame).toContain('importGraphics');
      continue;
    }
    expect(caps, row.frame).not.toContain('importGraphics');
    expect(await importFile(page, DRAWINGS[0], { place: 'at' }), row.frame).toBe('unsupported: kicadImportGraphics');
    expect(await importFile(page, DRAWINGS[0], { place: 'here' }), row.frame).toBe('bad_args: graphics.import');
  }
});

for (const row of FRAMES) {
  test(`run 15: both drawings import "at" in a ${row.frame} frame as one undo step each, taken back whole by one Ctrl+Z`, async ({ page }) => {
    await bootImporting(page, row);
    for (const path of DRAWINGS) {
      const menus = (await of(page, 'ev.menu')).length;
      const edits = (await of(page, 'ev.edited')).length;
      const d0 = row.frame === 'fpedit' || row.frame === 'symedit' ? await depthAfter(page, row, edits, 0) : null;
      const args: Record<string, unknown> = { place: 'at', origin: [10, 10] };
      if (row.layer != null) args.layer = row.layer;
      if (path.endsWith('.dxf')) args.dxfUnits = 'mm';
      const got = await importFile(page, path, args);
      expect(typeof got, `${row.frame} ${path}: ${String(got)}`).toBe('object');
      const imp = got as Imported;
      expect(imp.items, path).toBeGreaterThan(0);
      expect(imp.uuids.length, path).toBe(Math.min(imp.items, 4096));
      expect(imp.uuids.every((u) => UUID.test(u)), path).toBe(true);
      const d1 = await depthAfter(page, row, edits, 1);
      if (d0 != null) expect(d1, `${path}: one undo step`).toBe(d0 + 1);
      if (row.frame === 'fpedit') {
        const items = (await request(page, 'fpedit.items.get', { uuids: imp.uuids })).items as unknown[];
        expect(items.length, `${path}: the items join the footprint`).toBe(imp.uuids.length);
      }
      expect(await request(page, 'key.press', UNDO)).toEqual({});
      const d2 = await depthAfter(page, row, edits + 1, 1);
      expect(d2, `${path}: one Ctrl+Z takes it back`).toBe(d1 - 1);
      if (row.frame === 'fpedit') expect(((await request(page, 'fpedit.items.get', { uuids: imp.uuids })).items as unknown[]).length, path).toBe(0);
      expect((await of(page, 'ev.menu')).length, `${path}: no KiCad window`).toBe(menus);
    }
  });
}

test('run 15: "pointer" in a pcb frame hangs the drawing on the pointer; Esc leaves nothing, a click places it as one undo step', async ({ page }) => {
  const row = FRAMES[0];
  await bootImporting(page, row);
  const edits = (await of(page, 'ev.edited')).length;
  const first = await importFile(page, DRAWINGS[0], { place: 'pointer', layer: 'Dwgs.User', dxfUnits: 'mm' });
  expect(typeof first, String(first)).toBe('object');
  expect((first as Imported).items).toBeGreaterThan(0);
  // While it hangs every gate answers busy.
  expect(await importFile(page, DRAWINGS[1], { place: 'at' })).toBe('busy: graphics.import');
  expect(await request(page, 'key.press', ESC)).toEqual({});
  await page.waitForTimeout(1_500);
  expect((await of(page, 'ev.edited')).length, 'Esc leaves no undo step').toBe(edits);
  const second = await importFile(page, DRAWINGS[1], { place: 'pointer', layer: 'Dwgs.User' });
  expect(typeof second, String(second)).toBe('object');
  const box = await page.locator('iframe').boundingBox();
  expect(box).not.toBeNull();
  if (box == null) return;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2 + 20);
  await page.mouse.click(box.x + box.width / 2 + 20, box.y + box.height / 2 + 20);
  const d1 = await depthAfter(page, row, edits, 1);
  expect(await request(page, 'key.press', UNDO)).toEqual({});
  expect(await depthAfter(page, row, edits + 1, 1), 'one Ctrl+Z takes the placed drawing back').toBe(d1 - 1);
});

for (const row of FRAMES.slice(0, 2)) {
  test(`run 15: Ctrl+Shift+F in a ${row.frame} frame sends ev.held and opens nothing; a file that is no drawing answers not_a_drawing`, async ({ page }) => {
    await bootImporting(page, row);
    const n = (await of(page, 'ev.held')).length;
    const menus = (await of(page, 'ev.menu')).length;
    expect(await request(page, 'key.press', IMPORT_KEY)).toEqual({});
    await expect.poll(async () => (await of(page, 'ev.held')).length, { timeout: 5_000 }).toBe(n + 1);
    expect((await of(page, 'ev.held')).at(-1)?.action).toBe(row.held);
    await page.waitForTimeout(1_000);
    expect((await of(page, 'ev.menu')).length, 'no KiCad window').toBe(menus);
    expect(await importBytes(page, 'outline.dxf', 'this is a note, not a drawing', { place: 'at' })).toMatch(/^not_a_drawing: /);
    expect(await importBytes(page, 'page.svg', '<html><svg></svg></html>', { place: 'at' })).toMatch(/^not_a_drawing: /);
  });
}
