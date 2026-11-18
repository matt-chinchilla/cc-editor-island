// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// i-librows over the local pair, on the fixture path-vars (a design whose own
// library sits under its path variable MYLIB): project.libs with vars serves
// the library from mylib/ on any engine; libs.remove and paths.set, and a
// design block row under project.libs, are engine run 15's (caps libRows and
// pathVars). On an engine without them each answers unsupported naming its
// export and neither cap is listed; on run 15 a symbol row is added, removed
// and added again, a block row answers under block, and paths.set refuses a
// built in name.
import { expect, test, type Page } from '@playwright/test';

interface Ev { type: string; phase?: string; caps?: string[] }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }

function measure(type: string, description: string): void {
  test.info().annotations.push({ type, description });
  console.log(`[measure] ${type}: ${description}`);
}

const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const request = (page: Page, op: string, args?: unknown): Promise<Record<string, unknown>> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const);
/** A request's refusal as "code: message", or "ok". */
const refusal = (page: Page, op: string, args?: unknown): Promise<string> =>
  request(page, op, args).then(() => 'ok', (err: Error) => err.message.split('\n')[0].replace(/^.*?page\.evaluate:\s*/, '').replace(/^Error:\s*/, ''));

/** The page with path-vars open in a frame of that kind; ev.ready's caps. */
async function boot(page: Page, frame: 'sch' | 'pcb'): Promise<string[]> {
  await page.goto(`/parent.html?fixture=path-vars&frame=${frame}`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  await expect(page.locator('#state')).toContainText(`opened path-vars.kicad_${frame}`, { timeout: 120_000 });
  return (await events(page)).find((e) => e.type === 'ev.ready')?.caps ?? [];
}

// A design block library of the design's own, written into the running frame (KiCad's block folder form).
const BLOCKS = [
  { path: 'design-block-lib-table', text: '(design_block_lib_table\n  (version 7)\n  (lib (name "pv_blocks")(type "KiCad")(uri "${KIPRJMOD}/pv_blocks.kicad_blocks")(options "")(descr ""))\n)\n' },
  { path: 'pv_blocks.kicad_blocks/RC.kicad_block/RC.kicad_sch', text: '(kicad_sch\n\t(version 20231120)\n\t(generator "eeschema")\n\t(generator_version "8.0")\n\t(uuid "0b8c2f4e-6a1d-4e3b-8c5f-1d2e3f4a5b6c")\n\t(paper "A4")\n\t(lib_symbols)\n\t(sheet_instances\n\t\t(path "/"\n\t\t\t(page "1")\n\t\t)\n\t)\n)\n' },
  { path: 'pv_blocks.kicad_blocks/RC.kicad_block/RC.json', text: '{\n  "description": "An empty block",\n  "keywords": "",\n  "fields": {}\n}\n' },
];

for (const frame of ['sch', 'pcb'] as const) {
  test(`lib rows in a ${frame} frame: project.libs vars serve the library under MYLIB; libs.remove, paths.set and block rows by the engine's exports`, async ({ page }) => {
    try {
      const caps = await boot(page, frame);
      const run15 = caps.includes('libRows');
      expect(caps.includes('pathVars')).toBe(run15);
      measure('engine', run15 ? 'run 15 exports: libRows and pathVars listed' : 'no run 15 exports: neither cap listed');

      // Before MYLIB names a folder, the rows name nothing the island serves.
      expect(await refusal(page, 'project.libs', { libs: ['MyLib'] })).toBe('not_found: MyLib');
      let t0 = Date.now();
      const libs = await request(page, 'project.libs', { libs: ['MyLib'], vars: { MYLIB: 'mylib' } });
      measure('project.libs vars', `${Date.now() - t0} ms`);
      expect(libs).toEqual({ symbol: ['MyLib'], footprint: ['MyLib'], block: [] });
      if (frame === 'sch') {
        const item = await request(page, 'lib.item', { kind: 'symbol', lib: 'MyLib', name: 'R_MyLib' });
        expect(String(item.body)).toContain('(symbol "R_MyLib"');
      } else {
        const item = await request(page, 'lib.item', { kind: 'footprint', lib: 'MyLib', name: 'R_MyLib' });
        expect(String(item.body)).toContain('(footprint "R_MyLib"');
      }

      expect(await request(page, 'project.write', { files: BLOCKS })).toMatchObject({ written: BLOCKS.map((f) => f.path) });

      if (!run15) {
        expect(await refusal(page, 'libs.remove', { kind: 'symbol', nickname: 'MyLib' })).toBe('unsupported: kicadLibsRemoveEntry');
        expect(await refusal(page, 'paths.set', { vars: { MYLIB: 'mylib' } })).toBe('unsupported: kicadPathVarsSet');
        expect(await refusal(page, 'project.libs', { libs: ['pv_blocks'] })).toBe('unsupported: kicadLibsRemoveEntry');
        // The args are still read first.
        expect(await refusal(page, 'paths.set', { vars: { KIPRJMOD: 'mylib' } })).toBe('bad_args: paths.set');
        return;
      }

      // paths.set: KiCad's own name refused, MYLIB set (the project's own row of that name loads).
      expect(await refusal(page, 'paths.set', { vars: { KIPRJMOD: 'mylib' } })).toBe('bad_args: paths.set');
      t0 = Date.now();
      expect(await request(page, 'paths.set', { vars: { MYLIB: 'mylib' } })).toEqual({ set: ['MYLIB'] });
      measure('paths.set', `${Date.now() - t0} ms`);

      // Add, remove, add again: the run time row of the symbol library.
      t0 = Date.now();
      expect(await request(page, 'libs.remove', { kind: 'symbol', nickname: 'MyLib' })).toEqual({});
      measure('libs.remove', `${Date.now() - t0} ms`);
      expect(await refusal(page, 'libs.remove', { kind: 'symbol', nickname: 'MyLib' })).toBe('not_found: MyLib');
      expect(await request(page, 'project.libs', { libs: ['MyLib'] })).toEqual({ symbol: ['MyLib'], footprint: ['MyLib'], block: [] });

      // A block row answers under block, and comes off again.
      t0 = Date.now();
      expect(await request(page, 'project.libs', { libs: ['pv_blocks'] })).toEqual({ symbol: [], footprint: [], block: ['pv_blocks'] });
      measure('project.libs block', `${Date.now() - t0} ms`);
      expect(await request(page, 'libs.remove', { kind: 'block', nickname: 'pv_blocks' })).toEqual({});
    } finally {
      await page.close();
    }
  });
}
