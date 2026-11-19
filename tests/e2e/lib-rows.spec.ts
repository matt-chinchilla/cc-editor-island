// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// i-librows over the local pair, on the fixture path-vars (a design whose own
// library sits under its path variable MYLIB, and whose block library is
// pv_blocks): project.libs with vars serves the library from mylib/ on any
// engine; libs.remove and paths.set, and a design block row under
// project.libs, are engine run 15's (caps libRows and pathVars). On an engine
// without them each answers unsupported naming its export and neither cap is
// listed; on run 15 a symbol row is added, removed and added again, a block
// row answers under block, and paths.set refuses a built in name. KiCad 10's
// 3rd party variable is the one built in name paths.set takes, under the cap
// addonPaths (the engine's marker kicadPathVarsThirdParty): there the add-on's
// files written under .cc-addons resolve the design's PCM_ccaddon rows; on an
// engine without the marker the name answers unsupported naming it.
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

for (const frame of ['sch', 'pcb'] as const) {
  test(`lib rows in a ${frame} frame: project.libs vars serve the library under MYLIB; libs.remove, paths.set and block rows by the engine's exports`, async ({ page }) => {
    try {
      const caps = await boot(page, frame);
      const run15 = caps.includes('libRows');
      expect(caps.includes('pathVars')).toBe(run15);
      if (!run15) expect(caps).not.toContain('addonPaths');
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

      if (!run15) {
        expect(await refusal(page, 'libs.remove', { kind: 'symbol', nickname: 'MyLib' })).toBe('unsupported: kicadLibsRemoveEntry');
        expect(await refusal(page, 'paths.set', { vars: { MYLIB: 'mylib' } })).toBe('unsupported: kicadPathVarsSet');
        expect(await refusal(page, 'project.libs', { libs: ['pv_blocks'] })).toBe('unsupported: kicadLibsRemoveEntry');
        // The args are still read first.
        expect(await refusal(page, 'paths.set', { vars: { KIPRJMOD: 'mylib' } })).toBe('bad_args: paths.set');
        expect(await refusal(page, 'paths.set', { vars: { KICAD10_3RD_PARTY: '.cc-addons' } })).toBe('unsupported: kicadPathVarsSet');
        return;
      }

      // paths.set: KiCad's own name refused, MYLIB set (the project's own row of that name loads).
      expect(await refusal(page, 'paths.set', { vars: { KIPRJMOD: 'mylib' } })).toBe('bad_args: paths.set');
      t0 = Date.now();
      expect(await request(page, 'paths.set', { vars: { MYLIB: 'mylib' } })).toEqual({ set: ['MYLIB'] });
      measure('paths.set', `${Date.now() - t0} ms`);

      // KiCad 10's 3rd party variable: the one name of KiCad's own paths.set takes, under addonPaths alone.
      expect(await refusal(page, 'paths.set', { vars: { KICAD9_3RD_PARTY: '.cc-addons' } })).toBe('bad_args: paths.set');
      const addon = caps.includes('addonPaths');
      measure('addonPaths', addon ? 'listed: the engine takes KICAD10_3RD_PARTY' : 'not listed: the engine has no kicadPathVarsThirdParty');
      if (!addon) {
        expect(await refusal(page, 'paths.set', { vars: { KICAD10_3RD_PARTY: '.cc-addons' } })).toBe('unsupported: kicadPathVarsThirdParty');
      } else {
        // The add-on's files where the site writes them, as KiCad lays out its 3rd party folder.
        const fetchText = (url: string) => page.evaluate((u) => fetch(u).then((r) => r.text()), url);
        const files = [
          { path: '.cc-addons/symbols/com_example_ccaddon/ccaddon.kicad_sym', text: await fetchText('/fixtures/path-vars/mylib/x.kicad_sym') },
          { path: '.cc-addons/footprints/com_example_ccaddon/ccaddon.pretty/R_MyLib.kicad_mod', text: await fetchText('/fixtures/path-vars/mylib/x.pretty/R_MyLib.kicad_mod') },
        ];
        expect(await request(page, 'project.write', { files })).toEqual({ written: files.map((f) => f.path) });
        expect(await refusal(page, 'project.libs', { libs: ['PCM_ccaddon'] })).toBe('not_found: PCM_ccaddon');
        t0 = Date.now();
        expect(await request(page, 'paths.set', { vars: { KICAD10_3RD_PARTY: '.cc-addons' } })).toEqual({ set: ['KICAD10_3RD_PARTY'] });
        measure('paths.set 3rd party', `${Date.now() - t0} ms`);
        expect(await request(page, 'project.libs', { libs: ['PCM_ccaddon'] })).toEqual({ symbol: ['PCM_ccaddon'], footprint: ['PCM_ccaddon'], block: [] });
        if (frame === 'sch') {
          const item = await request(page, 'lib.item', { kind: 'symbol', lib: 'PCM_ccaddon', name: 'R_MyLib' });
          expect(String(item.body)).toContain('(symbol "R_MyLib"');
        } else {
          const item = await request(page, 'lib.item', { kind: 'footprint', lib: 'PCM_ccaddon', name: 'R_MyLib' });
          expect(String(item.body)).toContain('(footprint "R_MyLib"');
        }
      }

      // Add, remove, add again: the run time row of the frame's own kind (each engine removes only the rows it added
      // since its boot: the schematic engine its symbol row, the board engine its footprint row).
      const own = frame === 'sch' ? 'symbol' : 'footprint';
      t0 = Date.now();
      expect(await request(page, 'libs.remove', { kind: own, nickname: 'MyLib' })).toEqual({});
      measure('libs.remove', `${own} ${Date.now() - t0} ms`);
      expect(await refusal(page, 'libs.remove', { kind: own, nickname: 'MyLib' })).toBe('not_found: MyLib');
      // A board engine never holds a symbol row of the project's (seen on engine build T3).
      if (frame === 'pcb') expect(await refusal(page, 'libs.remove', { kind: 'symbol', nickname: 'MyLib' })).toBe('not_found: MyLib');
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
