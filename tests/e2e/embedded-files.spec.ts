// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// m13-i over the local pair (PROTOCOL.md embedded.get, embedded.set and
// embedded.extract). On engine run 14 neither document frame lists the cap
// designEmbedded and each op answers unsupported naming kicadEmbeddedFilesGet;
// bad args are refused first on any engine. On engine run 15 (cc25), in both
// frames of tests/fixtures/embedded-fonts: KiCad's own Noto Sans is added as a
// font, the fonts turned on, the font listed and extracted with the exact
// bytes of its source, and the saved text holds (embedded_files and
// (embedded_fonts yes); on the board a 1 MB PDF is added as a datasheet and
// removed, and a 26 MB file is refused; KiCad's qa board issue22102 has its
// drawing sheet extracted and removed. /tmp/cc-embed and /tmp/cc-embed-out
// hold no folder after any answer. With CC_M13_FIXTURE_OUT naming a folder,
// the files KiCad saved are written there (the fixture made through the engine).
import { expect, test, type Frame, type Page } from '@playwright/test';
import { ISLAND, PAGE } from './ports';

declare const process: { env: Record<string, string | undefined> };
const KICAD = process.env.CC_KICAD_DIR ?? '/home/matthew/cc-engine/kicad-source-mirror';
const FIXTURE_OUT = process.env.CC_M13_FIXTURE_OUT ?? '';
const OUTSIDE_PREFIX = '/m13-i-outside/';
const OUTSIDE: Record<string, string> = {
  'NotoSans-Regular.ttf': `${KICAD}/qa/resources/fonts/NotoSans-Regular.ttf`,
  'issue22102.kicad_pcb': `${KICAD}/qa/data/pcbnew/issue22102.kicad_pcb`,
};
const FONT = 'NotoSans-Regular.ttf';
const RUN15 = 'waits for engine run 15 (unit m13-e: kicadEmbeddedFilesGet, kicadEmbeddedFilesSet, kicadEmbeddedFileExtract)';
const MB = 1024 * 1024;

interface Ev { type: string; phase?: string; caps?: string[]; path?: string; at: number }
interface Harness { __events: Ev[]; __saved: Record<string, Uint8Array>; __bridge: { request(op: string, args?: unknown): Promise<Record<string, unknown>> } }
interface Engine { FS: { readdir(p: string): string[]; analyzePath(p: string): { exists: boolean } } }
interface EmbeddedFile { name: string; type: string; bytes: number; heldBy: number }
interface EmbeddedRead { owner: string; fontsEmbedded: boolean; files: EmbeddedFile[]; fonts: Array<{ name: string; embedded: boolean }> }
interface FsLike { mkdirSync(p: string, o: { recursive: boolean }): void; writeFileSync(p: string, b: Uint8Array): void }

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
const read = async (page: Page): Promise<EmbeddedRead> => (await request(page, 'embedded.get')) as unknown as EmbeddedRead;

/** embedded.set add of a body the page makes: a URL it fetches, or a PDF of `pdf` bytes, or `zeros` bytes. Rejects with "code: message". */
async function add(page: Page, name: string, type: string, body: { url: string } | { pdf: number } | { zeros: number }): Promise<{ result: EmbeddedRead; ms: number }> {
  const [result, ms] = await page.evaluate(async ([n, t, b]) => {
    let bytes: Uint8Array;
    if ('url' in b) {
      const res = await fetch(b.url);
      if (!res.ok) throw new Error(`fixture ${b.url}: ${res.status}`);
      bytes = new Uint8Array(await res.arrayBuffer());
    } else if ('zeros' in b) {
      bytes = new Uint8Array(b.zeros);
    } else {
      // One page, drawn here: a box and a line of text; the content stream padded with spaces to the size asked.
      const draw = 'BT /F1 24 Tf 72 720 Td (Embedded datasheet) Tj ET 72 72 468 600 re S\n';
      const head = ['%PDF-1.4\n'];
      const objs = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
        '',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      ];
      const fixed = 600;
      const pad = Math.max(0, b.pdf - draw.length - fixed);
      const stream = draw + ' '.repeat(pad);
      objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
      let text = head[0];
      const offsets: number[] = [];
      objs.forEach((o, i) => { offsets.push(text.length); text += `${i + 1} 0 obj\n${o}\nendobj\n`; });
      const xref = text.length;
      text += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((x) => `${String(x).padStart(10, '0')} 00000 n \n`).join('')}`;
      text += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
      bytes = new TextEncoder().encode(text);
    }
    const t0 = performance.now();
    const r = await (window as unknown as Harness).__bridge.request('embedded.set', { op: 'add', name: n, type: t, bytes });
    return [r, performance.now() - t0] as const;
  }, [name, type, body] as const);
  return { result: result as unknown as EmbeddedRead, ms };
}
const addRefusal = (page: Page, name: string, type: string, body: { zeros: number }): Promise<string> =>
  add(page, name, type, body).then(() => 'ok', (err: Error) => err.message.split('\n')[0].replace(/^.*?page\.evaluate:\s*/, '').replace(/^Error:\s*/, ''));

/** embedded.extract of `name`: its length, its sha256, its first characters, and the source's sha256 when `source` is a URL the page fetches. */
const extract = (page: Page, name: string, source?: string): Promise<{ bytes: number; sha: string; head: string; sourceSha: string | null; ms: number }> =>
  page.evaluate(async ([n, s]) => {
    const hex = async (b: Uint8Array): Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(b)))].map((x) => x.toString(16).padStart(2, '0')).join('');
    const t0 = performance.now();
    const r = await (window as unknown as Harness).__bridge.request('embedded.extract', { name: n });
    const ms = performance.now() - t0;
    const b = r.bytes as Uint8Array;
    if (r.name !== n || !(b instanceof Uint8Array)) throw new Error('island_error: the extract answered another shape');
    const src = s == null ? null : new Uint8Array(await (await fetch(s)).arrayBuffer());
    return { bytes: b.byteLength, sha: await hex(b), head: new TextDecoder().decode(b.slice(0, 16)), sourceSha: src == null ? null : await hex(src), ms };
  }, [name, source ?? null] as const);

/** Boots a `frame` frame on `fixture` (or on no fixture) and answers ev.ready's caps and the island frame (null where Playwright cannot reach it). */
async function boot(page: Page, frame: 'sch' | 'pcb', fixture?: string): Promise<{ caps: string[]; island: Frame | null }> {
  await page.route(`${PAGE}${OUTSIDE_PREFIX}**`, async (route) => {
    const path = OUTSIDE[decodeURIComponent(new URL(route.request().url()).pathname.slice(OUTSIDE_PREFIX.length))];
    return path == null ? route.fulfill({ status: 404, body: 'not a fixture' }) : route.fulfill({ path, contentType: 'application/octet-stream' });
  });
  await page.goto(fixture == null ? `/parent.html?frame=${frame}` : `/parent.html?fixture=${fixture}&frame=${frame}`);
  await page.waitForFunction(() => (window as unknown as Harness).__events.some((e) => e.type === 'ev.ready' || (e.type === 'ev.state' && (e.phase === 'blocked' || e.phase === 'fatal'))), null, { timeout: 170_000 });
  const caps = (await of(page, 'ev.ready'))[0]?.caps ?? [];
  if (fixture != null) await expect(page.locator('#state')).toContainText('opened ', { timeout: 120_000 });
  return { caps, island: page.frames().find((f) => f.url().startsWith(`${ISLAND}/`)) ?? null };
}
/** The folders left under the two run roots. */
const leftOver = (island: Frame): Promise<string[]> => island.evaluate(() => {
  const { FS } = window as unknown as Engine;
  return ['/tmp/cc-embed', '/tmp/cc-embed-out'].flatMap((r) => (FS.analyzePath(r).exists ? FS.readdir(r).filter((n) => n !== '.' && n !== '..').map((n) => `${r}/${n}`) : []));
});
const expectNoneLeft = async (island: Frame | null): Promise<void> => { if (island != null) expect(await leftOver(island)).toEqual([]); };
/** The text of the document the next project.save writes (`ext` its extension), and its bytes. */
async function saved(page: Page, ext: string): Promise<{ path: string; text: string; bytes: number[] }> {
  const n = (await of(page, 'ev.saved')).length;
  await request(page, 'project.save');
  await expect.poll(async () => (await of(page, 'ev.saved')).slice(n).some((e) => e.path?.endsWith(ext)), { timeout: 15_000 }).toBe(true);
  const path = (await of(page, 'ev.saved')).slice(n).find((e) => e.path?.endsWith(ext))!.path!;
  const bytes = await page.evaluate((p) => [...((window as unknown as Harness).__saved[p] ?? new Uint8Array())], path);
  return { path, text: new TextDecoder().decode(new Uint8Array(bytes)), bytes };
}

for (const frame of ['sch', 'pcb'] as const) {
  test(`run 14 or 15, ${frame}: designEmbedded follows the engine's exports; without them each op answers unsupported naming kicadEmbeddedFilesGet; bad args first`, async ({ page }) => {
    const { caps } = await boot(page, frame, 'embedded-fonts');
    if (!caps.includes('designEmbedded')) {
      expect(await refusal(page, 'embedded.get')).toBe('unsupported: kicadEmbeddedFilesGet');
      expect(await refusal(page, 'embedded.set', { op: 'fonts', embed: true })).toBe('unsupported: kicadEmbeddedFilesGet');
      expect(await refusal(page, 'embedded.set', { op: 'remove', name: FONT, alsoHeld: false })).toBe('unsupported: kicadEmbeddedFilesGet');
      expect(await refusal(page, 'embedded.extract', { name: FONT })).toBe('unsupported: kicadEmbeddedFilesGet');
    }
    expect(await addRefusal(page, 'big.pdf', 'datasheet', { zeros: 26 * MB })).toBe('bad_args: embedded.set');
    expect(await refusal(page, 'embedded.set', { op: 'add', name: 'a.pdf', type: 'picture', bytes: [1] })).toBe('bad_args: embedded.set');
    expect(await refusal(page, 'embedded.extract', { name: '../a' })).toBe('bad_args: embedded.extract');
    expect(await refusal(page, 'embedded.get', { all: true })).toBe('bad_args: embedded.get');
  });

  test(`run 15, ${frame}: Noto Sans kept inside, fonts on, listed, extracted byte for byte, and the saved text holds it`, async ({ page }) => {
    const { caps, island } = await boot(page, frame, 'embedded-fonts');
    test.skip(!caps.includes('designEmbedded'), RUN15);
    const first = await read(page);
    expect(first.owner).toBe(frame === 'pcb' ? 'board' : 'schematic');
    const put = await add(page, FONT, 'font', { url: `${OUTSIDE_PREFIX}${FONT}` });
    measure(`embedded.set add font, ${frame}`, `${put.ms.toFixed(0)} ms`);
    expect(put.result.files.find((f) => f.name === FONT)).toMatchObject({ type: 'font' });
    const on = (await request(page, 'embedded.set', { op: 'fonts', embed: true })) as unknown as EmbeddedRead;
    expect(on.fontsEmbedded).toBe(true);
    if (frame === 'pcb') {
      const ds = await add(page, 'datasheet.pdf', 'datasheet', { pdf: 4_000 });
      expect(ds.result.files.find((f) => f.name === 'datasheet.pdf')).toMatchObject({ type: 'datasheet' });
    }
    const now = await read(page);
    expect(now.files.some((f) => f.name === FONT && f.type === 'font')).toBe(true);
    measure(`embedded.get, ${frame}`, JSON.stringify(now));
    const x = await extract(page, FONT, `${OUTSIDE_PREFIX}${FONT}`);
    measure(`embedded.extract font, ${frame}`, `${x.bytes} bytes in ${x.ms.toFixed(0)} ms`);
    expect(x.sha).toBe(x.sourceSha);
    await expectNoneLeft(island);
    const doc = await saved(page, frame === 'pcb' ? '.kicad_pcb' : '.kicad_sch');
    expect(doc.text).toContain('(embedded_files');
    expect(doc.text).toContain('(embedded_fonts yes)');
    if (FIXTURE_OUT !== '') {
      const fsName = 'node:fs';
      const fs = (await import(/* @vite-ignore */ fsName)) as FsLike;
      fs.mkdirSync(FIXTURE_OUT, { recursive: true });
      fs.writeFileSync(`${FIXTURE_OUT}/${doc.path.slice(doc.path.lastIndexOf('/') + 1)}`, new Uint8Array(doc.bytes));
    }
  });
}

test('run 15, pcb: a 1 MB PDF added as a datasheet and removed; a 26 MB file and a remove of nothing refused; no folder left', async ({ page }) => {
  const { caps, island } = await boot(page, 'pcb', 'embedded-fonts');
  test.skip(!caps.includes('designEmbedded'), RUN15);
  const before = await read(page);
  const big = await add(page, 'big-datasheet.pdf', 'datasheet', { pdf: MB });
  measure('embedded.set add 1 MB PDF', `${big.ms.toFixed(0)} ms`);
  expect(big.result.files.find((f) => f.name === 'big-datasheet.pdf')).toMatchObject({ type: 'datasheet', heldBy: 0 });
  const x = await extract(page, 'big-datasheet.pdf');
  expect(x.head.startsWith('%PDF-1.4')).toBe(true);
  // The PDF the page makes pads its stream to the size asked less a rounded 600 bytes of frame, so it is a little under 1 MiB.
  expect(x.bytes).toBeGreaterThan(MB - 600);
  expect(x.bytes).toBeLessThanOrEqual(MB);
  const gone = (await request(page, 'embedded.set', { op: 'remove', name: 'big-datasheet.pdf', alsoHeld: false })) as unknown as EmbeddedRead;
  expect(gone.files.map((f) => f.name)).toEqual(before.files.map((f) => f.name));
  expect(await addRefusal(page, 'big.pdf', 'datasheet', { zeros: 26 * MB })).toBe('bad_args: embedded.set');
  expect(await refusal(page, 'embedded.set', { op: 'remove', name: 'big-datasheet.pdf', alsoHeld: false })).toBe('not_found: big-datasheet.pdf');
  expect(await refusal(page, 'embedded.extract', { name: 'big-datasheet.pdf' })).toBe('not_found: big-datasheet.pdf');
  await expectNoneLeft(island);
});

test('run 15, pcb: KiCad\'s qa board issue22102 lists its drawing sheet, extracts it and removes it', async ({ page }) => {
  const { caps, island } = await boot(page, 'pcb');
  test.skip(!caps.includes('designEmbedded'), RUN15);
  await page.evaluate(async (url) => {
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    await (window as unknown as Harness).__bridge.request('project.open', { name: 'issue22102', files: [{ path: 'issue22102.kicad_pcb', bytes }] });
  }, `${OUTSIDE_PREFIX}issue22102.kicad_pcb`);
  const first = await read(page);
  measure('embedded.get, issue22102', JSON.stringify(first));
  const sheet = first.files.find((f) => f.name === 'SchematicTemplate.kicad_wks');
  expect(sheet).toBeDefined();
  const x = await extract(page, 'SchematicTemplate.kicad_wks');
  expect(x.bytes).toBe(sheet!.bytes);
  expect(x.head.startsWith('(kicad_wks')).toBe(true);
  const after = (await request(page, 'embedded.set', { op: 'remove', name: 'SchematicTemplate.kicad_wks', alsoHeld: false })) as unknown as EmbeddedRead;
  expect(after.files.some((f) => f.name === 'SchematicTemplate.kicad_wks')).toBe(false);
  await expectNoneLeft(island);
});
