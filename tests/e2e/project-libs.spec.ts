// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// island v0.2.3-cc12 over the local pair, on the Glasgow example (PROTOCOL.md):
// project.libs serves a library the project folder's own tables name, written
// into a running frame through project.write, to KiCad and to the picker's ops
// without a reboot (a part placed from it, a footprint the engine loads by
// name); footprint.models replaces one footprint's model lines as one undo
// step, read back from the saved board. Neither needs the library mirror: the
// island booted on its example library still answers place.
import { expect, test, type Frame, type Page } from '@playwright/test';

const ISLAND = 'http://editor.localhost:4174';
interface Ev { type: string; phase?: string; depth?: number; caps?: string[]; at: number }
interface Harness { __events: Ev[]; __saved: Record<string, Uint8Array>; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Engine { Module: { kicadLibsTestLoadFootprint(lib: string, name: string): Promise<string> | string } }

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
const savedText = (page: Page, path: string): Promise<string> =>
  page.evaluate((p) => new TextDecoder().decode((window as unknown as Harness).__saved[p]), path);
/** KiCad's own load of a footprint by its lib:name (the engine's probe; Update PCB from Schematic loads through the same adapter): its pads, or '' when none loads. */
const loadFootprint = (frame: Frame, lib: string, name: string): Promise<string> =>
  frame.evaluate(([l, n]) => Promise.resolve((window as unknown as Engine).Module.kicadLibsTestLoadFootprint(l, n)), [lib, name] as const);

/**
 * The page with Glasgow open in a frame of that kind, and the island's frame when
 * Playwright reaches it: since the local pair went cross-site (2026-10-26)
 * Playwright's Firefox lists the island's frame with an empty url and no context
 * to evaluate in, so there the engine's own probes are not read.
 */
async function boot(page: Page, frameName: 'sch' | 'pcb'): Promise<Frame | null> {
  await page.goto(`/parent.html?fixture=glasgow&frame=${frameName}`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  await expect(page.locator('#state')).toContainText(`opened glasgow.kicad_${frameName}`, { timeout: 120_000 });
  return page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null;
}

/** Notes that the island frame was out of Playwright's reach, so KiCad's own probe and a press in the drawing were not exercised. */
const unreached = (): void => { test.info().annotations.push({ type: 'unreached', description: 'the island frame is out of Playwright\'s reach in this browser: KiCad\'s probe and the press that commits a placement were not exercised' }); };

async function clickIn(page: Page, x: number, y: number): Promise<void> {
  const box = await page.locator('iframe').boundingBox();
  if (box == null) throw new Error('no iframe box');
  await page.mouse.move(box.x + x, box.y + y, { steps: 4 });
  await page.mouse.click(box.x + x, box.y + y);
}

/** The pointer goes to (x, y), the part is placed, and a press there commits it (an ev.edited follows). */
async function placeAt(page: Page, args: Record<string, unknown>, [x, y]: [number, number]): Promise<number> {
  const box = await page.locator('iframe').boundingBox();
  if (box == null) throw new Error('no iframe box');
  await page.mouse.move(box.x + x, box.y + y, { steps: 4 });
  const t0 = Date.now();
  expect(await request(page, 'place', args)).toEqual({});
  const ms = Date.now() - t0;
  const before = (await of(page, 'ev.edited')).length;
  await clickIn(page, x + 6, y + 6);
  await expect.poll(async () => (await of(page, 'ev.edited')).length, { timeout: 15_000 }).toBeGreaterThan(before);
  return ms;
}

// The design's own library, as a page writes it after an import (the 3D bodies spec, 7.2).
const SYMBOLS = `(kicad_symbol_lib
\t(version 20241209)
\t(generator "kicad_symbol_editor")
\t(generator_version "9.0")
\t(symbol "ST25DV04K"
\t\t(pin_names (offset 0.254))
\t\t(exclude_from_sim no)
\t\t(in_bom yes)
\t\t(on_board yes)
\t\t(property "Reference" "U" (at 0 5.08 0) (effects (font (size 1.27 1.27))))
\t\t(property "Value" "ST25DV04K" (at 0 -5.08 0) (effects (font (size 1.27 1.27))))
\t\t(property "Footprint" "glasgow_parts:UFDFPN8" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
\t\t(property "Datasheet" "" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
\t\t(property "Description" "NFC tag, 4 Kbit" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
\t\t(symbol "ST25DV04K_0_1"
\t\t\t(rectangle (start -5.08 3.81) (end 5.08 -3.81) (stroke (width 0.254) (type default)) (fill (type background)))
\t\t)
\t\t(symbol "ST25DV04K_1_1"
\t\t\t(pin passive line (at -7.62 1.27 0) (length 2.54) (name "AC0" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
\t\t\t(pin passive line (at -7.62 -1.27 0) (length 2.54) (name "AC1" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))
\t\t)
\t)
)
`;
const FOOTPRINT = `(footprint "UFDFPN8"
\t(version 20241229)
\t(generator "pcbnew")
\t(layer "F.Cu")
\t(property "Reference" "REF**" (at 0 -2 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
\t(property "Value" "UFDFPN8" (at 0 2 0) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))))
\t(attr smd)
\t(fp_rect (start -1.5 -1) (end 1.5 1) (stroke (width 0.05) (type solid)) (fill no) (layer "F.CrtYd"))
\t(pad "1" smd rect (at -0.75 0) (size 0.5 0.8) (layers "F.Cu" "F.Paste" "F.Mask"))
\t(pad "2" smd rect (at 0.75 0) (size 0.5 0.8) (layers "F.Cu" "F.Paste" "F.Mask"))
\t(model "\${KIPRJMOD}/glasgow_parts.3dshapes/UFDFPN8.step" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))
)
`;
const LIBRARY = [
  { path: 'glasgow_parts.kicad_sym', text: SYMBOLS },
  { path: 'glasgow_parts.pretty/UFDFPN8.kicad_mod', text: FOOTPRINT },
  { path: 'sym-lib-table', text: '(sym_lib_table\n  (version 7)\n  (lib (name "glasgow_parts")(type "KiCad")(uri "${KIPRJMOD}/glasgow_parts.kicad_sym")(options "")(descr ""))\n)\n' },
  { path: 'fp-lib-table', text: '(fp_lib_table\n  (version 7)\n  (lib (name "glasgow_parts")(type "KiCad")(uri "${KIPRJMOD}/glasgow_parts.pretty")(options "")(descr ""))\n)\n' },
];

test('project.libs in a schematic: the project library written into the running frame is registered without a reboot, lib.item reads it, and a symbol placed from it saves under its own nickname', async ({ page }) => {
  const frame = await boot(page, 'sch');
  expect((await of(page, 'ev.ready'))[0]?.caps).toEqual(expect.arrayContaining(['projectLibs', 'write']));
  // Not there yet: no table names it.
  expect(await refusal(page, 'project.libs', { libs: ['glasgow_parts'] })).toBe('not_found: glasgow_parts');
  expect(await request(page, 'project.write', { files: LIBRARY })).toEqual({ written: LIBRARY.map((f) => f.path) });
  const t0 = Date.now();
  expect(await request(page, 'project.libs', { libs: ['glasgow_parts'] })).toEqual({ symbol: ['glasgow_parts'], footprint: ['glasgow_parts'] });
  measure('project.libs, schematic', `${Date.now() - t0} ms from the request to the answer`);
  // A nickname the island already serves another way (the mirror's Device, else the example library) is refused whole.
  const served = (await of(page, 'ev.ready'))[0]?.caps?.includes('picker') === true ? 'Device' : 'pcbjam-examples';
  expect(await refusal(page, 'project.libs', { libs: ['glasgow_parts', served] })).toBe(`bad_args: project.libs: ${served} is a library the island already serves`);
  const item = await request(page, 'lib.item', { kind: 'symbol', lib: 'glasgow_parts', name: 'ST25DV04K' });
  expect(String(item.body)).toContain('(symbol "ST25DV04K"');
  expect(await request(page, 'lib.item', { kind: 'footprint', lib: 'glasgow_parts', name: 'UFDFPN8' })).toEqual({ body: FOOTPRINT });
  // The press that commits a placement reaches the frame only where Playwright reaches it (boot).
  if (frame == null) { unreached(); return; }
  const ms = await placeAt(page, { kind: 'symbol', lib: 'glasgow_parts', name: 'ST25DV04K' }, [640, 420]);
  measure('place from the project library', `${ms} ms from the request to the part on the pointer`);
  expect(await request(page, 'project.save')).toMatchObject({ saved: expect.arrayContaining(['glasgow.kicad_sch']) });
  const sheet = await savedText(page, 'glasgow.kicad_sch');
  expect(sheet).toMatch(/\(lib_id "glasgow_parts:ST25DV04K"\)/);
  expect(sheet).toMatch(/\(symbol "glasgow_parts:ST25DV04K"/);   // the sheet's lib_symbols cache
  expect(sheet).toMatch(/\(property "Footprint" "glasgow_parts:UFDFPN8"/);
});

test('project.libs on a board: KiCad loads the project footprint by its nickname, a footprint written later is found on the next call, and a footprint placed from it saves under its own nickname', async ({ page }) => {
  const frame = await boot(page, 'pcb');
  expect((await of(page, 'ev.ready'))[0]?.caps).toContain('projectLibs');
  expect(await request(page, 'project.write', { files: LIBRARY })).toMatchObject({ written: expect.any(Array) });
  // KiCad's own load of a footprint by name (Update PCB from Schematic's): nothing before the call.
  if (frame != null) expect(await loadFootprint(frame, 'glasgow_parts', 'UFDFPN8')).toBe('');
  const t0 = Date.now();
  expect(await request(page, 'project.libs', { libs: ['glasgow_parts'] })).toEqual({ symbol: ['glasgow_parts'], footprint: ['glasgow_parts'] });
  measure('project.libs, board', `${Date.now() - t0} ms from the request to the answer`);
  if (frame != null) expect(await loadFootprint(frame, 'glasgow_parts', 'UFDFPN8')).toBe('1:500000x800000;2:500000x800000;');
  // A second footprint written into the folder: found once the library is registered again.
  await request(page, 'project.write', { files: [{ path: 'glasgow_parts.pretty/UFDFPN8_WIDE.kicad_mod', text: FOOTPRINT.replace('(footprint "UFDFPN8"', '(footprint "UFDFPN8_WIDE"').replace(/\(size 0\.5 0\.8\)/g, '(size 0.6 0.9)') }] });
  const t1 = Date.now();
  expect(await request(page, 'project.libs', { libs: ['glasgow_parts'] })).toMatchObject({ footprint: ['glasgow_parts'] });
  measure('project.libs again, a footprint added', `${Date.now() - t1} ms`);
  if (frame == null) { unreached(); return; }
  expect(await loadFootprint(frame, 'glasgow_parts', 'UFDFPN8_WIDE')).toBe('1:600000x900000;2:600000x900000;');
  await placeAt(page, { kind: 'footprint', lib: 'glasgow_parts', name: 'UFDFPN8' }, [640, 420]);
  expect(await request(page, 'project.save')).toMatchObject({ saved: ['glasgow.kicad_pcb'] });
  const pcb = await savedText(page, 'glasgow.kicad_pcb');
  expect(pcb).toContain('(footprint "glasgow_parts:UFDFPN8"');
  expect(pcb).toContain('(model "${KIPRJMOD}/glasgow_parts.3dshapes/UFDFPN8.step"');
});

// Glasgow's C30 (Capacitor_SMD:C_0402_1005Metric), whose board names KiCad 6's model.
const C30 = '00000000-0000-0000-0000-00005be41647';
const C30_MODEL = '(model "${KICAD6_3DMODEL_DIR}/Capacitor_SMD.3dshapes/C_0402_1005Metric.step"';
/** The model lines of one footprint of a saved board, by its uuid (KiCad 10 writes it as the footprint's uuid). */
function modelLines(board: string, uuid: string): string[] {
  const at = board.indexOf(`(uuid "${uuid}")`);
  if (at < 0) return [];
  const start = board.lastIndexOf('(footprint ', at);
  const end = board.indexOf('\n\t(footprint ', at);
  return [...board.slice(start, end < 0 ? undefined : end).matchAll(/\(model "((?:[^"\\]|\\.)*)"[\s\S]*?\(rotate\s+\(xyz ([^)]*)\)/g)].map((m) => `${m[1]} rotate ${m[2]}`);
}

test('footprint.models replaces C30\'s model lines as one undo step: the saved board names the new model, and Undo takes it back', async ({ page }) => {
  await boot(page, 'pcb');
  const caps = (await of(page, 'ev.ready'))[0]?.caps ?? [];
  if (!caps.includes('models')) {
    // An engine without our kicadFootprintSetModels (engine run 5): no cap, and the op says why.
    expect(await refusal(page, 'footprint.models', { uuid: C30, models: [] })).toBe('unsupported: kicadFootprintSetModels');
    test.info().annotations.push({ type: 'engine', description: 'no kicadFootprintSetModels: the replace was not exercised' });
    return;
  }
  expect(await refusal(page, 'footprint.models', { uuid: 'aaaaaaaa-0000-0000-0000-000000000000', models: [] })).toBe('not_found: aaaaaaaa-0000-0000-0000-000000000000');
  expect(await refusal(page, 'footprint.models', { uuid: C30, models: [{ path: '' }] })).toBe('bad_args: footprint.models');
  await page.waitForTimeout(1_500);   // the open's baseline read
  const edits = (await of(page, 'ev.edited')).length;
  const t0 = Date.now();
  expect(await request(page, 'footprint.models', { uuid: C30, models: [{ path: '${KIPRJMOD}/glasgow_parts.3dshapes/C30.step', offset: [0, 0, 0.1], rotate: [-90, 0, 0] }] })).toEqual({});
  measure('footprint.models', `${Date.now() - t0} ms from the request to the answer`);
  await expect.poll(async () => (await of(page, 'ev.edited')).length, { timeout: 5_000 }).toBe(edits + 1);
  expect(await request(page, 'project.save')).toMatchObject({ saved: ['glasgow.kicad_pcb'] });
  expect(modelLines(await savedText(page, 'glasgow.kicad_pcb'), C30)).toEqual(['${KIPRJMOD}/glasgow_parts.3dshapes/C30.step rotate -90 0 0']);
  // One undo step: KiCad's Undo puts the board's own model back.
  expect(await request(page, 'key.press', { key: 'z', code: 'KeyZ', ctrl: true })).toEqual({});
  await expect.poll(async () => (await of(page, 'ev.edited')).length, { timeout: 5_000 }).toBe(edits + 2);
  expect(await request(page, 'project.save')).toMatchObject({ saved: ['glasgow.kicad_pcb'] });
  const after = await savedText(page, 'glasgow.kicad_pcb');
  expect(after).toContain(C30_MODEL);
  expect(modelLines(after, C30)).toEqual(['${KICAD6_3DMODEL_DIR}/Capacitor_SMD.3dshapes/C_0402_1005Metric.step rotate 0 0 0']);
});

test('footprint.models in a schematic is unsupported', async ({ page }) => {
  await boot(page, 'sch');
  expect(await refusal(page, 'footprint.models', { uuid: C30, models: [] })).toBe('unsupported: a footprint\'s models change in a pcb frame');
});
