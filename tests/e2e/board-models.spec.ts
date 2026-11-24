// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// 3d-i4 over the local pair (PROTOCOL.md board.models, board.setModels and
// board.embedModels). On engine run 14 the cap boardModels is absent, each op
// answers unsupported naming kicadBoardModels, and KiCad's Update 3D model
// paths and Embed 3D models are left to KiCad. On engine run 15 (cc25): Glasgow
// reads 272 footprints; a set over 40 of them is one undo step that one undo
// takes back whole; bad args are refused before any change; on
// models3d-small its three lines are kept inside the board (the library line's
// body from the model store, which must be built first into dist/models as
// models3d.spec.ts says), the saved board text then holds (embedded_files and
// three kicad-embed:// lines, and embedding a line again answers bad_args
// naming it. /tmp/cc-embed holds no folder after any answer.
import { expect, test, type Frame, type Page } from '@playwright/test';
import { ISLAND } from './ports';

interface Ev { type: string; phase?: string; caps?: string[]; action?: string; path?: string; bytes?: unknown; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Engine {
  Module: { kicadCollabTestUndoDepth(): number };
  FS: { readdir(p: string): string[]; analyzePath(p: string): { exists: boolean } };
  kicadHostAction?: { onRequest?: (json: unknown) => boolean };
}
interface Line { path: string; offset: number[]; rotate: number[]; scale: number[]; opacity: number; show: boolean; found: string }
interface Footprint { uuid: string; ref: string; models: Line[] }

const RUN15 = 'waits for engine run 15 (unit 3d-e5: kicadBoardModels, kicadBoardSetModels, kicadBoardEmbedModels)';
const MIGRATE = 'pcbnew.GlobalEdit.migrate3DModels';
const COLLECT = 'pcbnew.EditorControl.collect3DModels';
const UNDO = { key: 'z', code: 'KeyZ', ctrl: true };

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
const timed = async (page: Page, op: string, args?: unknown): Promise<{ ms: number; result: Record<string, unknown> }> => {
  const t0 = Date.now();
  const result = await request(page, op, args);
  return { ms: Date.now() - t0, result };
};
const footprints = async (page: Page): Promise<Footprint[]> => (await request(page, 'board.models', {})).footprints as Footprint[];
const withoutFound = (l: Line): Omit<Line, 'found'> => ({ path: l.path, offset: l.offset, rotate: l.rotate, scale: l.scale, opacity: l.opacity, show: l.show });

/** Boots a pcb frame on `fixture` and answers ev.ready's caps and the island frame (null where Playwright cannot reach it). */
async function boot(page: Page, fixture: string): Promise<{ caps: string[]; frame: Frame | null }> {
  await page.goto(`/parent.html?fixture=${fixture}&frame=pcb`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  const caps = (await of(page, 'ev.ready'))[0]?.caps ?? [];
  await expect(page.locator('#state')).toContainText('opened ', { timeout: 120_000 });
  await page.waitForTimeout(1_500);   // ev.edited's baseline
  return { caps, frame: page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null };
}
const undoDepth = (frame: Frame): Promise<number> => frame.evaluate(() => Number((window as unknown as Engine).Module.kicadCollabTestUndoDepth()));
/** The folders left under /tmp/cc-embed. */
const leftOver = (frame: Frame): Promise<string[]> => frame.evaluate(() => {
  const { FS } = window as unknown as Engine;
  return FS.analyzePath('/tmp/cc-embed').exists ? FS.readdir('/tmp/cc-embed').filter((n) => n !== '.' && n !== '..') : [];
});
/** Asks the frame's held slot as the engine does: taken, and the ev.held sent for it. */
async function askHeld(page: Page, frame: Frame, action: string): Promise<{ taken: boolean; sent: string | null }> {
  const n = (await of(page, 'ev.held')).length;
  const taken = await frame.evaluate((a) => (window as unknown as Engine).kicadHostAction?.onRequest?.(JSON.stringify({ action: a })) === true, action);
  await page.waitForTimeout(300);
  const after = await of(page, 'ev.held');
  return { taken, sent: after.length > n ? after.at(-1)?.action ?? null : null };
}
/** The board text the next project.save reports. */
async function savedBoard(page: Page): Promise<string> {
  const n = (await of(page, 'ev.saved')).length;
  await request(page, 'project.save');
  await expect.poll(async () => (await of(page, 'ev.saved')).slice(n).some((e) => e.path?.endsWith('.kicad_pcb')), { timeout: 10_000 }).toBe(true);
  const ev = (await of(page, 'ev.saved')).slice(n).find((e) => e.path?.endsWith('.kicad_pcb'));
  return page.evaluate((b) => new TextDecoder().decode(new Uint8Array(Object.values(b as Record<string, number>))), ev?.bytes as unknown);
}

test('run 14 or 15: boardModels follows the three exports; without them each op answers unsupported naming kicadBoardModels and KiCad keeps its two actions', async ({ page, browserName }) => {
  const { caps, frame } = await boot(page, 'glasgow');
  const has = caps.includes('boardModels');
  if (!has) {
    expect(await refusal(page, 'board.models', {})).toBe('unsupported: kicadBoardModels');
    expect(await refusal(page, 'board.setModels', { label: 'Change models', items: [{ uuid: '3d1a2000-0000-4000-8000-000000000100', models: [] }] })).toBe('unsupported: kicadBoardModels');
    expect(await refusal(page, 'board.embedModels', { items: [{ uuid: '3d1a2000-0000-4000-8000-000000000100', index: 0 }] })).toBe('unsupported: kicadBoardModels');
  }
  expect(await refusal(page, 'board.embedModels', { items: [] })).toBe('bad_args: board.embedModels');
  expect(await refusal(page, 'board.setModels', { label: 'Other', items: [] })).toBe('bad_args: board.setModels');
  test.skip(frame == null, `${browserName}: the island frame is out of Playwright's reach, so its held slot cannot be asked`);
  for (const action of [MIGRATE, COLLECT]) expect(await askHeld(page, frame!, action)).toEqual({ taken: has, sent: has ? action : null });
});

test('run 15: Glasgow reads 272 footprints; a set over 40 is one undo step one undo takes back; bad args change nothing', async ({ page, browserName }) => {
  const { caps, frame } = await boot(page, 'glasgow');
  test.skip(!caps.includes('boardModels'), RUN15);
  test.skip(frame == null, `${browserName}: the island frame is out of Playwright's reach, so the undo depth cannot be read`);
  const read = await timed(page, 'board.models', {});
  const before = read.result.footprints as Footprint[];
  measure('board.models, Glasgow', `${before.length} footprints in ${read.ms} ms`);
  expect(before).toHaveLength(272);
  const chosen = before.filter((f) => f.models.length > 0).slice(0, 40);
  expect(chosen).toHaveLength(40);
  const depth0 = await undoDepth(frame!);
  const edits0 = (await of(page, 'ev.edited')).length;

  const uuid = chosen[0].uuid;
  for (const bad of [
    { label: 'Update model names', items: [{ uuid: uuid.toUpperCase(), models: [] }] },
    { label: 'Update model names', items: [] },
    { label: 'Update model names', items: [{ uuid, models: [{ ...withoutFound(chosen[0].models[0]), found: 'project' }] }] },
  ]) expect(await refusal(page, 'board.setModels', bad)).toBe('bad_args: board.setModels');
  expect(await refusal(page, 'board.embedModels', { items: [{ uuid, index: 64 }] })).toBe('bad_args: board.embedModels');
  expect(await refusal(page, 'board.embedModels', { items: [{ uuid: uuid.toUpperCase(), index: 0 }] })).toBe('bad_args: board.embedModels');
  expect(await refusal(page, 'board.embedModels', { items: [] })).toBe('bad_args: board.embedModels');
  expect(await undoDepth(frame!)).toBe(depth0);
  expect(await footprints(page)).toEqual(before);

  const items = chosen.map((f, i) => ({ uuid: f.uuid, models: f.models.map((l, j) => ({ ...withoutFound(l), path: `\${KIPRJMOD}/renamed-${i}-${j}.step` })) }));
  const set = await timed(page, 'board.setModels', { label: 'Update model names', items });
  measure('board.setModels, 40 footprints', `${set.ms} ms`);
  expect(set.result).toEqual({ changed: 40 });
  expect(await undoDepth(frame!)).toBe(depth0 + 1);
  await expect.poll(async () => (await of(page, 'ev.edited')).length, { timeout: 5_000 }).toBeGreaterThan(edits0);
  const after = new Map((await footprints(page)).map((f) => [f.uuid, f]));
  for (const it of items) expect(after.get(it.uuid)?.models.map((l) => l.path)).toEqual(it.models.map((l) => l.path));

  expect(await request(page, 'key.press', UNDO)).toEqual({});
  await expect.poll(() => undoDepth(frame!), { timeout: 5_000 }).toBe(depth0);
  expect(await footprints(page)).toEqual(before);
});

test('run 15: models3d-small keeps its three lines inside the board; the saved text holds them; a line already inside is refused by name', async ({ page, browserName }) => {
  const { caps, frame } = await boot(page, 'models3d-small');
  test.skip(!caps.includes('boardModels'), RUN15);
  test.skip(frame == null, `${browserName}: the island frame is out of Playwright's reach, so the run folders cannot be read`);
  const fps = await footprints(page);
  const items = fps.flatMap((f) => f.models.map((_, index) => ({ uuid: f.uuid, index })));
  expect(items).toHaveLength(3);
  const embed = await timed(page, 'board.embedModels', { items });
  measure('board.embedModels, models3d-small', `${embed.ms} ms, ${JSON.stringify(embed.result)}`);
  expect(embed.result).toMatchObject({ embedded: 3 });
  expect((embed.result.names as string[])).toHaveLength(3);
  expect(await leftOver(frame!)).toEqual([]);
  const now = await footprints(page);
  expect(now.flatMap((f) => f.models.map((l) => l.found))).toEqual(['embedded', 'embedded', 'embedded']);

  const text = await savedBoard(page);
  expect(text).toContain('(embedded_files');
  expect(text.match(/\(model "kicad-embed:\/\//g) ?? []).toHaveLength(3);

  const again = await refusal(page, 'board.embedModels', { items: [items[0]] });
  const first = now.find((f) => f.uuid === items[0].uuid)!;
  expect(again).toBe(`bad_args: ${first.ref} ${first.models[items[0].index].path}`);
  expect(await leftOver(frame!)).toEqual([]);
});

test('run 15: Glasgow keeps library lines the engine reads missing, their bodies from the model store; a library body the store lacks is refused by name', async ({ page, browserName }) => {
  const { caps, frame } = await boot(page, 'glasgow');
  test.skip(!caps.includes('boardModels'), RUN15);
  test.skip(frame == null, `${browserName}: the island frame is out of Playwright's reach, so the undo depth cannot be read`);
  const LIB_RE = /^\$\{KICAD\d*_3DMODEL_DIR\}\//;
  const before = await footprints(page);
  // A fresh Edit session has staged no library body: the engine reads those lines missing.
  const lib = before.flatMap((f) => f.models.map((l, index) => ({ f, l, index }))).filter((x) => LIB_RE.test(x.l.path) && x.l.found === 'missing');
  test.skip(lib.length < 2, 'no library line reads missing on this engine');
  const picked = [lib[0], lib.find((x) => x.l.path !== lib[0].l.path) ?? lib[1]];
  const depth0 = await undoDepth(frame!);
  const embed = await timed(page, 'board.embedModels', { items: picked.map((x) => ({ uuid: x.f.uuid, index: x.index })) });
  measure('board.embedModels, Glasgow library lines', `${embed.ms} ms, ${JSON.stringify(embed.result)}`);
  expect(embed.result).toMatchObject({ embedded: new Set(picked.map((x) => x.l.path)).size });
  expect(await leftOver(frame!)).toEqual([]);
  const now = new Map((await footprints(page)).map((f) => [f.uuid, f]));
  for (const x of picked) expect(now.get(x.f.uuid)?.models[x.index].found, `${x.f.ref} ${x.l.path}`).toBe('embedded');
  expect(await undoDepth(frame!)).toBe(depth0 + 1);
  expect(await request(page, 'key.press', UNDO)).toEqual({});
  await expect.poll(() => undoDepth(frame!), { timeout: 5_000 }).toBe(depth0);

  // A library path the store does not hold: refused by name, nothing kept.
  const target = lib[0];
  const nope = '${KICAD10_3DMODEL_DIR}/No_Such.3dshapes/no_such_body.step';
  const models = target.f.models.map((l, j) => ({ ...withoutFound(l), path: j === target.index ? nope : l.path }));
  expect(await request(page, 'board.setModels', { label: 'Update model names', items: [{ uuid: target.f.uuid, models }] })).toEqual({ changed: 1 });
  const depth1 = await undoDepth(frame!);
  expect(await refusal(page, 'board.embedModels', { items: [{ uuid: target.f.uuid, index: target.index }] })).toBe(`bad_args: ${target.f.ref} ${nope}`);
  expect(await undoDepth(frame!)).toBe(depth1);
  expect(await leftOver(frame!)).toEqual([]);
});
