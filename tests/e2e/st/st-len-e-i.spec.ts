// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-len-e-i over the local pair (PROTOCOL.md board.nets): the board's nets with
// KiCad's own Net Inspector figures, on Glasgow. On engine run 14 the cap
// netReport is absent and board.nets answers unsupported naming kicadNetReport.
// On engine run 15 (cc25): GND reads 254.4734 mm (the inspector's figure, the
// track inside GND's pads trimmed; the plain sum of its segments is 255.8152
// mm, ENGINE-FACTS repair e10-1) with 121 vias, +3V3 54 vias, /SDA 10, /SCL 7,
// each length no longer than its plain segment sum; every net listed without
// names; a name the board lacks left out. In a sch frame the op is unsupported.
import { expect, test, type Page } from '@playwright/test';

interface Ev { type: string; phase?: string; caps?: string[]; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Row { name: string; netClass: string; length: number; byLayer: { layer: string; length: number }[]; vias: number; viaLength: number; pads: number; dieLength: number; delay: number | null }

const RUN15 = 'waits for engine run 15 (pcbjam cc_e10_pcb.inc, unit st-len-e-e: kicadNetReport)';
/** KiCad's Net Inspector length of GND on Glasgow (KiCad 10.0 in the kicad/kicad:10.0 image; ENGINE-FACTS e10-1). */
const GND_LENGTH = 254.4734;
/** The plain sums of the segments (viewing mode's figures) and the via counts. */
const RAW: Record<string, { sum: number; vias: number }> = {
  GND: { sum: 255.8152, vias: 121 },
  '+3V3': { sum: 113.9619, vias: 54 },
  '/SDA': { sum: 166.762, vias: 10 },
  '/SCL': { sum: 165.777, vias: 7 },
};

function measure(type: string, description: string): void {
  test.info().annotations.push({ type, description });
  console.log(`[measure] ${type}: ${description}`);
}
const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const refusal = (page: Page, op: string, args?: unknown): Promise<string> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const)
    .then(() => 'ok', (err: Error) => err.message.split('\n')[0].replace(/^.*?page\.evaluate:\s*/, '').replace(/^Error:\s*/, ''));
/** board.nets, timed. */
const nets = (page: Page, args?: unknown): Promise<{ ms: number; rows: Row[] }> =>
  page.evaluate(async (a) => {
    const t0 = performance.now();
    const r = await (window as unknown as Harness).__bridge.request('board.nets', a);
    return { ms: Math.round((performance.now() - t0) * 100) / 100, rows: (r as { nets: Row[] }).nets };
  }, args);

/** Boots Glasgow in `frame` and answers ev.ready's caps once the document is open. */
async function boot(page: Page, frame: 'pcb' | 'sch'): Promise<string[]> {
  await page.goto(`/parent.html?fixture=glasgow&frame=${frame}`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  const caps = (await events(page)).find((e) => e.type === 'ev.ready')?.caps ?? [];
  await expect(page.locator('#state')).toContainText(`opened glasgow.kicad_${frame}`, { timeout: 120_000 });
  return caps;
}

test('run 14 or 15: netReport follows kicadNetReport; without it board.nets answers unsupported naming the export; bad args first', async ({ page }) => {
  const caps = await boot(page, 'pcb');
  expect(caps.includes('netReport')).toBe(caps.includes('kicadNetReport'));
  if (!caps.includes('netReport')) {
    expect(await refusal(page, 'board.nets')).toBe('unsupported: kicadNetReport');
    expect(await refusal(page, 'board.nets', { nets: ['GND'] })).toBe('unsupported: kicadNetReport');
  }
  expect(await refusal(page, 'board.nets', { nets: [] })).toBe('bad_args: board.nets');
  expect(await refusal(page, 'board.nets', { all: true })).toBe('bad_args: board.nets');
});

test('a sch frame: no netReport cap and board.nets is unsupported', async ({ page }) => {
  const caps = await boot(page, 'sch');
  expect(caps).not.toContain('netReport');
  expect(await refusal(page, 'board.nets')).toBe('unsupported: a board op runs in a pcb frame');
});

test('run 15: Glasgow answers KiCad\'s Net Inspector figures for GND, +3V3, /SDA and /SCL', async ({ page }) => {
  const caps = await boot(page, 'pcb');
  test.skip(!caps.includes('netReport'), RUN15);

  const named = await nets(page, { nets: ['GND', '+3V3', '/SDA', '/SCL', 'NOT_A_NET'] });
  measure('board.nets, four names on Glasgow', `${named.ms} ms`);
  expect(named.rows.map((r) => r.name).sort()).toEqual(['+3V3', '/SCL', '/SDA', 'GND']);
  for (const row of named.rows) {
    const raw = RAW[row.name];
    expect(row.vias, row.name).toBe(raw.vias);
    expect(row.length, row.name).toBeGreaterThan(0);
    expect(row.length, row.name).toBeLessThanOrEqual(raw.sum + 0.001);
    for (const l of row.byLayer) expect(l.length, `${row.name} ${l.layer}`).toBeLessThanOrEqual(row.length + 0.001);
    measure(`board.nets ${row.name}`, `${row.length} mm, ${row.vias} vias, ${row.pads} pads, class ${row.netClass}, segment sum ${raw.sum} mm`);
  }
  const gnd = named.rows.find((r) => r.name === 'GND')!;
  expect(Math.abs(gnd.length - GND_LENGTH)).toBeLessThanOrEqual(0.001);

  const all = await nets(page);
  measure('board.nets, every net on Glasgow', `${all.rows.length} nets in ${all.ms} ms`);
  expect(all.rows.length).toBeGreaterThan(4);
  expect(new Set(all.rows.map((r) => r.name)).size).toBe(all.rows.length);
  expect(all.rows.find((r) => r.name === 'GND')).toEqual(gnd);
});
