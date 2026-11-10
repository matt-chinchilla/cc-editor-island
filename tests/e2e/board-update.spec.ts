// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// island v0.2.3-cc18 over the local pair (PROTOCOL.md board.preview and
// board.update): our engine's kicadUpdateBoardFromSchematic (engine run 12)
// runs KiCad's Update PCB from Schematic through the hidden schematic
// editor's netlist with no KiCad dialog and answers its changes as records.
// first-board is the Update spec's fixture: R1 and D1 in series on a
// schematic, an empty outlined board (tests/fixtures/first-board/SOURCE).
import { expect, test, type Page } from '@playwright/test';

interface Ev { type: string; phase?: string; depth?: number; open?: boolean; caps?: string[]; uuids?: string[]; path?: string; text?: string; at: number }
interface Harness { __events: Ev[]; __saved: Record<string, Uint8Array>; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Change { kind: string; ref?: string; footprint?: string; pins?: Array<{ pin: string; net: string; pad: boolean }>; extraPads?: string[]; sameName?: boolean; net?: string; code?: string; severity?: string; message: string }
interface Preview { token: string; blocked: string; sheets: string[]; changes: Change[]; warnings: number; errors: number; truncated: boolean; unmapped: number }
interface Update { changes: Change[]; added: string[]; warnings: number; errors: number; truncated: boolean; unmapped: number }

const OPTS = { replaceFootprints: true, deleteExtra: false, relinkByReference: false };

function measure(type: string, description: string): void {
  test.info().annotations.push({ type, description });
  console.log(`[measure] ${type}: ${description}`);
}
const events = (page: Page): Promise<Ev[]> => page.evaluate(() => (window as unknown as Harness).__events);
const of = async (page: Page, type: string): Promise<Ev[]> => (await events(page)).filter((e) => e.type === type);
const request = (page: Page, op: string, args?: unknown): Promise<Record<string, unknown>> =>
  page.evaluate(([o, a]) => (window as unknown as Harness).__bridge.request(o as string, a), [op, args] as const);
const refusal = (page: Page, op: string, args?: unknown): Promise<string> =>
  request(page, op, args).then(() => 'ok', (err: Error) => err.message.split('\n')[0].replace(/^.*?page\.evaluate:\s*/, '').replace(/^Error:\s*/, ''));
const timed = (page: Page, op: string, args: unknown): Promise<{ ms: number; result: Record<string, unknown> }> => page.evaluate(async ([o, a]) => {
  const t0 = performance.now();
  const result = await (window as unknown as Harness).__bridge.request(o as string, a);
  return { ms: Math.round(performance.now() - t0), result };
}, [op, args] as const);
const lastDepth = async (page: Page): Promise<number | undefined> => (await of(page, 'ev.edited')).at(-1)?.depth;
const withoutMessages = (cs: Change[]): Array<Omit<Change, 'message'>> => cs.map(({ message, ...rest }) => { void message; return rest; });

async function ready(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
}

/** A fixture's files opened in a board frame, each passed through `edit` (null leaves a file out). */
async function openFixture(page: Page, fixture: string, names: string[], edit: Record<string, [string, string] | null> = {}): Promise<void> {
  await ready(page, '/parent.html?frame=pcb');
  expect((await of(page, 'ev.ready'))[0]?.caps).toEqual(expect.arrayContaining(['boardUpdate']));
  const answer = await page.evaluate(async ([fx, ns, ed]) => {
    const enc = new TextEncoder();
    const files: Array<{ path: string; bytes: Uint8Array }> = [];
    for (const path of ns) {
      const e = (ed as Record<string, [string, string] | null>)[path];
      if (e === null) continue;
      let text = await (await fetch(`/fixtures/${fx}/${path}`)).text();
      if (e !== undefined) text = text.split(e[0]).join(e[1]);
      files.push({ path, bytes: enc.encode(text) });
    }
    return (window as unknown as Harness).__bridge.request('project.open', { name: fx, files });
  }, [fixture, names, edit] as const);
  expect(answer).toMatchObject({ opened: expect.stringMatching(/\.kicad_pcb$/) });
  await page.waitForTimeout(1_500);   // the open's baseline read
}
const FIRST = ['first-board.kicad_pro', 'first-board.kicad_sch', 'first-board.kicad_pcb'];

test('first-board: the preview lists R1 and D1 coming onto the board with their pins and nets; the update brings them beside the outline, one undo step, saved with their nets', async ({ page }) => {
  await openFixture(page, 'first-board', FIRST);
  const times: number[] = [];
  let preview = {} as Preview;
  for (let i = 0; i < 3; i++) {
    const t = await timed(page, 'board.preview', OPTS);
    times.push(t.ms);
    preview = t.result as unknown as Preview;
  }
  measure('board.preview, first-board, three in a row', `${times.join(', ')} ms`);
  // The footprints come from the library mirror (LIBS_DIR=dist/libs for serve.mjs): without it, KiCad says so for each part.
  if (!((await of(page, 'ev.ready'))[0]?.caps ?? []).includes('picker')) {
    test.info().annotations.push({ type: 'no mirror', description: 'the pair serves no library mirror: the preview answered footprint_not_found for each part, and no update was applied' });
    expect(withoutMessages(preview.changes)).toEqual([
      { kind: 'problem', code: 'footprint_not_found', severity: 'error', ref: 'D1', pin: '', footprint: 'LED_SMD:LED_0603_1608Metric', net: '', name: '' },
      { kind: 'problem', code: 'footprint_not_found', severity: 'error', ref: 'R1', pin: '', footprint: 'Resistor_SMD:R_0603_1608Metric', net: '', name: '' },
    ]);
    expect(preview).toMatchObject({ blocked: '', errors: 2, unmapped: 0 });
    return;
  }
  expect(preview).toMatchObject({ blocked: '', sheets: ['first-board.kicad_sch'], truncated: false, unmapped: 0, errors: 0 });
  expect(preview.token.length).toBeGreaterThan(0);
  const adds = preview.changes.filter((c) => c.kind === 'add');
  // Pins in KiCad's netlist order: compared by number.
  for (const a of adds) a.pins?.sort((x, y) => x.pin.localeCompare(y.pin));
  expect(withoutMessages(adds)).toEqual([
    { kind: 'add', ref: 'D1', footprint: 'LED_SMD:LED_0603_1608Metric', pins: [{ pin: '1', net: 'GND', pad: true }, { pin: '2', net: 'Net-(D1-A)', pad: true }], extraPads: [], sameName: false },
    { kind: 'add', ref: 'R1', footprint: 'Resistor_SMD:R_0603_1608Metric', pins: [{ pin: '1', net: 'VIN', pad: true }, { pin: '2', net: 'Net-(D1-A)', pad: true }], extraPads: [], sameName: false },
  ]);
  expect(await of(page, 'ev.menu')).toEqual([]);
  expect(await of(page, 'ev.edited')).toEqual([]);

  const depth0 = (await lastDepth(page)) ?? 0;
  const applied = await timed(page, 'board.update', { ...OPTS, token: preview.token });
  const update = applied.result as unknown as Update;
  measure('board.update, first-board', `${applied.ms} ms`);
  expect([...update.added].sort()).toEqual(['D1', 'R1']);
  expect(update).toMatchObject({ truncated: false, unmapped: 0, errors: 0 });
  // Applied, KiCad adds the three nets and connects the four pads.
  expect(update.changes.filter((c) => c.kind === 'net').map((c) => c.net).sort()).toEqual(['GND', 'Net-(D1-A)', 'VIN']);
  expect(update.changes.filter((c) => c.kind === 'connect')).toHaveLength(4);
  await expect.poll(() => lastDepth(page), { timeout: 5_000 }).toBe(depth0 + 1);
  // The new parts stay selected: an ev.selected names them.
  await expect.poll(async () => (await of(page, 'ev.selected')).at(-1)?.uuids?.length ?? 0, { timeout: 5_000 }).toBe(2);
  const selected = (await of(page, 'ev.selected')).at(-1)?.uuids ?? [];
  expect(selected).toHaveLength(2);
  const items = ((await request(page, 'board.item.get', { uuids: selected })) as { items: Array<{ ref: string; x: number }> }).items;
  expect(items.map((i) => i.ref).sort()).toEqual(['D1', 'R1']);
  // Beside the outline: right of its right edge at x = 130 mm.
  for (const it of items) expect(it.x).toBeGreaterThan(130);
  // Undo takes the whole update back in one step, and redo brings it again.
  // Keys reach KiCad after the run (the island gives the drawing its keyboard focus back).
  expect(await request(page, 'key.press', { key: 'z', code: 'KeyZ', ctrl: true })).toEqual({});
  await expect.poll(() => lastDepth(page), { timeout: 5_000 }).toBe(depth0);
  expect(((await request(page, 'board.item.get', { uuids: selected })) as { items: unknown[] }).items).toEqual([]);
  expect(await request(page, 'key.press', { key: 'y', code: 'KeyY', ctrl: true })).toEqual({});
  await expect.poll(() => lastDepth(page), { timeout: 5_000 }).toBe(depth0 + 1);
  expect(((await request(page, 'board.item.get', { uuids: selected })) as { items: unknown[] }).items).toHaveLength(2);
  // Saved, the board holds both with their pads' nets.
  expect(await request(page, 'project.save')).toMatchObject({ path: 'first-board.kicad_pcb' });
  const board = await page.evaluate(() => new TextDecoder().decode((window as unknown as Harness).__saved['first-board.kicad_pcb']));
  for (const fp of ['Resistor_SMD:R_0603_1608Metric', 'LED_SMD:LED_0603_1608Metric']) expect(board).toContain(`(footprint "${fp}"`);
  for (const net of ['"VIN"', '"GND"', '"Net-(D1-A)"']) expect(board).toContain(net);
  // A second preview has nothing to add, and the board changed since the first token: stale.
  const again = await request(page, 'board.preview', OPTS) as unknown as Preview;
  expect(again.changes.filter((c) => c.kind === 'add')).toEqual([]);
  expect(await refusal(page, 'board.update', { ...OPTS, token: preview.token })).toMatch(/^stale: /);
  expect(await of(page, 'ev.menu')).toEqual([]);
});

test('parts not numbered answer the preview blocked with their problems and refuse the update', async ({ page }) => {
  await openFixture(page, 'first-board', FIRST, { 'first-board.kicad_sch': ['(reference "R1")', '(reference "R?")'] });
  const blocked = await request(page, 'board.preview', OPTS) as unknown as Preview;
  console.log('[blocked]', JSON.stringify(blocked));
  expect(blocked.blocked).toBe('not_annotated');
  expect(blocked.changes.some((c) => c.kind === 'problem' && c.code === 'unannotated')).toBe(true);
  expect(await refusal(page, 'board.update', { ...OPTS, token: blocked.token || 't' })).toMatch(/^not_annotated: /);
  expect(await of(page, 'ev.menu')).toEqual([]);
});

test('no schematic beside the board answers no_schematic naming it', async ({ page }) => {
  await openFixture(page, 'first-board', FIRST, { 'first-board.kicad_sch': null });
  expect(await refusal(page, 'board.preview', OPTS)).toBe('no_schematic: first-board.kicad_sch');
  expect(await refusal(page, 'board.update', { ...OPTS, token: 't' })).toBe('no_schematic: first-board.kicad_sch');
});

test('the extra footprint is listed for removal only when asked', async ({ page }) => {
  await openFixture(page, 'drc-small', ['drc-small.kicad_pro', 'drc-small.kicad_sch', 'drc-small.kicad_pcb', 'drc-small.kicad_dru']);
  const keep = await request(page, 'board.preview', OPTS) as unknown as Preview;
  const drop = await request(page, 'board.preview', { ...OPTS, deleteExtra: true }) as unknown as Preview;
  console.log('[drc-small]', JSON.stringify(keep.changes.map((c) => [c.kind, c.ref ?? c.net ?? c.code])), JSON.stringify(drop.changes.map((c) => [c.kind, c.ref ?? c.net ?? c.code])));
  expect(keep.changes.filter((c) => c.kind === 'remove')).toEqual([]);
  expect(withoutMessages(drop.changes.filter((c) => c.kind === 'remove'))).toEqual([{ kind: 'remove', ref: 'R2', footprint: 'Resistor_SMD:R_0603_1608Metric' }]);
  expect(drop.unmapped).toBe(0);
});

test('Glasgow: three previews in a row with no KiCad window, every line mapped', async ({ page }) => {
  test.setTimeout(300_000);
  await ready(page, '/parent.html?fixture=glasgow&frame=pcb');
  await expect(page.locator('#state')).toContainText('opened glasgow.kicad_pcb', { timeout: 120_000 });
  await page.waitForTimeout(1_500);
  const times: number[] = [];
  let last = {} as Preview;
  for (let i = 0; i < 3; i++) {
    const t = await timed(page, 'board.preview', OPTS);
    times.push(t.ms);
    last = t.result as unknown as Preview;
  }
  const kinds = [...new Set(last.changes.map((c) => c.kind))].join(' ');
  measure('board.preview, Glasgow, three in a row', `${times.join(', ')} ms; ${last.changes.length} records (${kinds}), ${last.warnings} warnings, ${last.errors} errors, sheets ${last.sheets.join(' ')}`);
  expect(last.unmapped).toBe(0);
  expect(last.sheets).toEqual(['glasgow.kicad_sch']);
  expect(await of(page, 'ev.menu')).toEqual([]);
  // The board frame still answers its other ops after the previews.
  expect(await refusal(page, 'select', { uuids: ['00000000-0000-0000-0000-00005befb37d'] })).toBe('ok');
});

test('board.preview in a schematic is unsupported', async ({ page }) => {
  await ready(page, '/parent.html?fixture=first-board&frame=sch');
  await expect(page.locator('#state')).toContainText('opened first-board.kicad_sch', { timeout: 120_000 });
  expect(await refusal(page, 'board.preview', OPTS)).toBe('unsupported: a board op runs in a pcb frame');
});
