// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// island v0.2.3-cc23 over the local pair (PROTOCOL.md symbol.forEditor,
// symbol.push, lib.update and symbol.convert): the schematic side of the
// symbol editor, in a sch frame on tests/fixtures/symedit-small. A placed part
// goes to the symbol editor as text (KiCad's Edit with Symbol Editor) and
// comes back as one undo step (KiCad's save to the schematic), relinked or
// not; placed parts take a library's new drawing through KiCad's Update
// Symbols from Library; KiCad's Ctrl+E is held for the host.
import { expect, test, type Page } from '@playwright/test';

interface Ev { type: string; phase?: string; depth?: number; caps?: string[]; action?: string; uuids?: string[]; at: number }
interface Harness { __events: Ev[]; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }

/** symedit-small's U1, unit A and unit B, on the root sheet (tests/fixtures/symedit-small/SOURCE). */
const U1A = '5e1ec700-0000-4000-8000-000000000101';
const U1B = '5e1ec700-0000-4000-8000-000000000102';
const LIB = 'symedit-small_parts';
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
const timed = (page: Page, op: string, args?: unknown): Promise<{ ms: number; result: Record<string, unknown> }> => page.evaluate(async ([o, a]) => {
  const t0 = performance.now();
  const result = await (window as unknown as Harness).__bridge.request(o as string, a);
  return { ms: Math.round((performance.now() - t0) * 100) / 100, result };
}, [op, args] as const);

async function boot(page: Page): Promise<void> {
  await page.goto('/parent.html?fixture=symedit-small&frame=sch');
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  await expect(page.locator('#state')).toContainText('opened symedit-small.kicad_sch', { timeout: 120_000 });
  await page.waitForTimeout(1_500);   // ev.edited's baseline
}

test('a sch frame lists symbolEdit, symbolConvert and libUpdate, never symedit; the symedit ops are unsupported there', async ({ page }) => {
  await boot(page);
  const caps = (await of(page, 'ev.ready'))[0]?.caps ?? [];
  expect(caps).toEqual(expect.arrayContaining(['symbolEdit', 'symbolConvert', 'libUpdate', 'symbol', 'heldKeys']));
  expect(caps).not.toContain('symedit');
  expect(caps).not.toContain('symeditHeld');
  expect(await refusal(page, 'symedit.state')).toBe('unsupported: a symbol edits in a symedit frame');
});

test('symbol.forEditor, then symbol.push without and with a lib id: one undo step each, Ctrl+Z takes it back', async ({ page }) => {
  await boot(page);
  const t = await timed(page, 'symbol.forEditor', { uuid: U1A, sheetPath: '/' });
  const got = t.result as { name: string; libId: string; text: string };
  expect(got).toMatchObject({ name: 'OPAMP2', libId: `${LIB}:OPAMP2` });
  expect(got.text).toMatch(/\(symbol "OPAMP2"/);
  measure('symbol.forEditor, U1', `${t.ms} ms, ${got.text.length} characters`);
  expect(await refusal(page, 'symbol.forEditor', { uuid: '5e1ec700-0000-4000-8000-0000000009ff', sheetPath: '/' })).toBe('not_found: 5e1ec700-0000-4000-8000-0000000009ff');
  const edits0 = (await of(page, 'ev.edited')).length;
  const edited = got.text.replace('(name "+"', '(name "INP"');
  expect(edited).not.toBe(got.text);
  const pushed = await timed(page, 'symbol.push', { uuid: U1A, sheetPath: '/', text: edited, name: 'OPAMP2', libId: '' });
  expect(pushed.result).toMatchObject({ uuid: U1A, libId: `${LIB}:OPAMP2`, ref: 'U1' });
  measure('symbol.push, U1', `${pushed.ms} ms`);
  await expect.poll(async () => (await of(page, 'ev.edited')).length, { timeout: 5_000 }).toBe(edits0 + 1);
  // Every unit of the part took it (KiCad's SaveSymbolToSchematic), so unit B reads the same drawing.
  expect(((await request(page, 'symbol.forEditor', { uuid: U1B, sheetPath: '/' })) as { text: string }).text).toContain('(name "INP"');
  const relinked = await request(page, 'symbol.push', { uuid: U1A, sheetPath: '/', text: edited, name: 'OPAMP2', libId: `${LIB}:OPAMP2_EDIT` });
  expect(relinked).toMatchObject({ libId: `${LIB}:OPAMP2_EDIT` });
  await expect.poll(async () => (await of(page, 'ev.edited')).length, { timeout: 5_000 }).toBe(edits0 + 2);
  expect(await request(page, 'key.press', UNDO)).toEqual({});
  await expect.poll(async () => (await request(page, 'symbol.get', { uuid: U1A, sheetPath: '/' })).libId, { timeout: 5_000 }).toBe(`${LIB}:OPAMP2`);
  expect(await refusal(page, 'symbol.push', { uuid: U1A, sheetPath: '/', text: edited, name: 'NOSUCH', libId: '' })).toBe('bad_args: symbol.push: the text holds no symbol NOSUCH KiCad reads');
});

test('lib.update: the design\'s symbols written and registered, the placed parts take the new drawing', async ({ page }) => {
  await boot(page);
  const file = await page.evaluate(async () => (await fetch('/fixtures/symedit-small/symedit-small_parts.kicad_sym')).text());
  const changed = file.replace('(name "-" (effects (font (size 1.27 1.27)))) (number "2"', '(name "INN" (effects (font (size 1.27 1.27)))) (number "2"');
  expect(changed).not.toBe(file);
  expect(await request(page, 'project.write', { files: [{ path: `${LIB}.kicad_sym`, text: changed }] })).toEqual({ written: [`${LIB}.kicad_sym`] });
  expect(await request(page, 'project.libs', { libs: [LIB] })).toMatchObject({ symbol: [LIB] });
  const t = await timed(page, 'lib.update', { lib: LIB, names: ['OPAMP2'] });
  expect(t.result).toMatchObject({ missing: [] });
  expect((t.result as { updated: number }).updated).toBeGreaterThanOrEqual(2);
  measure('lib.update, OPAMP2', `${JSON.stringify(t.result)} in ${t.ms} ms`);
  await expect.poll(async () => ((await request(page, 'symbol.forEditor', { uuid: U1A, sheetPath: '/' })) as { text: string }).text.includes('(name "INN"'), { timeout: 5_000 }).toBe(true);
  expect(await refusal(page, 'lib.update', { lib: 'a:b', names: ['OPAMP2'] })).toBe('bad_args: lib.update');
});

test('Ctrl+E on a placed part is held as ev.held, no KiCad window; symbol.convert reads a file in a sch frame', async ({ page }) => {
  await boot(page);
  expect(await request(page, 'select', { uuids: [U1A] })).toEqual({});
  await expect.poll(async () => (await of(page, 'ev.selected')).at(-1)?.uuids, { timeout: 5_000 }).toEqual([U1A]);
  const n = (await of(page, 'ev.held')).length;
  const menus = (await of(page, 'ev.menu')).length;
  expect(await request(page, 'key.press', { key: 'e', code: 'KeyE', ctrl: true })).toEqual({});
  await expect.poll(async () => (await of(page, 'ev.held')).length, { timeout: 5_000 }).toBe(n + 1);
  expect((await of(page, 'ev.held')).at(-1)?.action).toBe('eeschema.EditorControl.editWithSymbolEditor');
  await page.waitForTimeout(1_000);
  expect((await of(page, 'ev.menu')).length).toBe(menus);
  const bytes = await page.evaluate(async () => [...new Uint8Array(await (await fetch('/fixtures/symedit-small/legacy.lib')).arrayBuffer())]);
  const out = await page.evaluate((b) => (window as unknown as Harness).__bridge.request('symbol.convert', { name: 'legacy.lib', bytes: new Uint8Array(b) }), bytes) as { format: string; symbols: Array<{ name: string }> };
  expect(out.symbols.map((s) => s.name)).toEqual(['LEGACY_R']);
});
