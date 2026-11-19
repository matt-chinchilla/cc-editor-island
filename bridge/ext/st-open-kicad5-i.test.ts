// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-open-kicad5-i: project.import { format: 'kicad5' } widened, the cap
// importLegacy feature detected, and the record's warnings in the answer.
import { describe, expect, it, vi } from 'vitest';
import { importCall } from '../import';
import { LEGACY_RECORD } from './st-open-kicad5-i/legacy';
import { fail, ok, type Answer, type ResponderCtx } from './contract';
import { buildRegistry } from './registry';
import unit, { widenImport } from './st-open-kicad5-i';

const ROOT = '/home/web_user/.local/share/kicad/10.0/projects/cc';
const FILES = ['ecc83-pp.pro', 'ecc83-pp.sch', 'ecc83-pp.cache.lib'].map((path) => ({ path, bytes: new Uint8Array([1]) }));
const REQ = { name: 'ecc83', files: FILES, open: 'ecc83-pp.pro', format: 'kicad5' };

/** A ctx of this test's own with only what the widening reads; the engine module and its file system are plain maps. */
function ctxOf(over: Partial<Record<string, unknown>> = {}, record?: unknown) {
  const mod: Record<string, unknown> = { kicadImportLegacyProject: async () => true, kicadImportSchematic: async () => true };
  const dropped: string[] = [];
  const emitted: Array<Record<string, unknown>> = [];
  let runs = 0;
  const ctx = {
    frame: 'sch', root: ROOT,
    mod: () => mod, has: (names: readonly string[]) => names.every((n) => typeof mod[n] === 'function'),
    fs: () => ({}),
    freshRunFolder: (root: string) => `${root}/${++runs}`,
    dropRunFolder: (d: string) => { dropped.push(d); },
    readBytes: (abs: string) => (abs.endsWith(`/${LEGACY_RECORD}`) ? (record === undefined ? null : new TextEncoder().encode(JSON.stringify(record))) : abs.startsWith(`${ROOT}/`) && !abs.endsWith('gone.kicad_sym') ? new TextEncoder().encode(abs) : null),
    emit: (ev: Record<string, unknown>) => { emitted.push(ev); },
    ...over,
  } as unknown as ResponderCtx;
  return { ctx, mod, dropped, emitted };
}

const RECORD = {
  opened: true, saved: true,
  files: [`${ROOT}/ecc83-pp.kicad_sch`, `${ROOT}/ecc83-pp.kicad_pro`, `${ROOT}/sym-lib-table`, `${ROOT}/ecc83-pp-rescue.kicad_sym`, `${ROOT}/gone.kicad_sym`, '/tmp/elsewhere.kicad_sym', `${ROOT}/../x.kicad_sym`],
  lines: [
    { severity: 'warning', text: 'The following libraries were not found:\n  power' },
    { severity: 'action', text: 'Rescue ECC83 as ecc83-pp-rescue:ECC83' },
    { severity: 'info', text: 'Loaded the cache.' },
    { severity: 'error', text: 'Load Without Cache File' },
  ],
};

describe('st-open-kicad5-i in the registry', () => {
  it('loads with no problem, widens project.import and claims the cap importLegacy', () => {
    const reg = buildRegistry({ './st-open-kicad5-i.ts': { default: unit } }, {}, {});
    expect(reg.problems).toEqual([]);
    expect(reg.ops.size).toBe(0);
    expect(reg.widen.has('project.import')).toBe(true);
  });

  it('lists importLegacy only in a sch frame whose engine has kicadImportLegacyProject (engine run 15)', () => {
    const run15 = { kicadImportLegacyProject: () => true, kicadHostLegacy: () => true };
    expect(unit.caps(run15, 'sch')).toEqual(['importLegacy']);
    expect(unit.caps(run15, 'pcb')).toEqual([]);
    expect(unit.caps({ kicadImportSchematic: () => true }, 'sch')).toEqual([]);
  });
});

describe('project.import widened for kicad5', () => {
  it('passes every other format, and any format in a pcb frame, to the op unchanged', async () => {
    const { ctx } = ctxOf();
    const done = ok({ opened: 'x.kicad_sch' });
    for (const args of [{ ...REQ, format: 'EAGLE', open: 'x.sch' }, { ...REQ, format: undefined }, null, 'x']) {
      const next = vi.fn(async (): Promise<Answer> => done);
      expect(await widenImport(args, ctx, next)).toBe(done);
      expect(next).toHaveBeenCalledWith(args);
    }
    const pcb = ctxOf({ frame: 'pcb' }).ctx;
    const next = vi.fn(async (): Promise<Answer> => fail('bad_args', 'project.import'));
    await widenImport(REQ, pcb, next);
    expect(next).toHaveBeenCalledWith(REQ);
  });

  it('opens the root sheet for a .pro and for the sheet itself, with the run folder armed for the engine call', async () => {
    for (const open of ['ecc83-pp.pro', 'ecc83-pp.sch']) {
      const { ctx, dropped, emitted } = ctxOf({}, RECORD);
      let call: unknown = null;
      const next = vi.fn(async (a: unknown): Promise<Answer> => {
        call = importCall('sch', ROOT, (a as { open: string }).open, undefined, 'kicad5');
        return ok({ opened: 'ecc83-pp.kicad_sch', dropped: [], warnings: [], chrome: false });
      });
      const a = await widenImport({ ...REQ, open }, ctx, next);
      expect(next).toHaveBeenCalledWith({ ...REQ, open: 'ecc83-pp.sch' });
      expect(call).toEqual({ name: 'kicadImportLegacyProject', args: [JSON.stringify({ path: `${ROOT}/ecc83-pp.pro`, run: 1, dir: '/tmp/cc-legacy/1' })] });
      expect(a).toEqual(ok({
        opened: 'ecc83-pp.kicad_sch', dropped: [], chrome: false,
        warnings: ['The following libraries were not found: power', 'Load Without Cache File'],
      }));
      expect(dropped).toEqual(['/tmp/cc-legacy/1']);
      // The tables only the engine wrote, before the answer; the sheets and the project file are the frame's Save's to report.
      expect(emitted.map((e) => [e.type, e.path, new TextDecoder().decode(e.bytes as Uint8Array)])).toEqual([
        ['ev.saved', 'sym-lib-table', `${ROOT}/sym-lib-table`],
        ['ev.saved', 'ecc83-pp-rescue.kicad_sym', `${ROOT}/ecc83-pp-rescue.kicad_sym`],
      ]);
      // The folder is taken once: a later call outside the widening writes no record.
      expect(importCall('sch', ROOT, 'ecc83-pp.sch', undefined, 'kicad5')).toEqual({ name: 'kicadImportLegacyProject', args: [JSON.stringify({ path: `${ROOT}/ecc83-pp.pro` })] });
    }
  });

  it('keeps the answer as the op gave it when the record names no warning, or is missing or of another shape', async () => {
    for (const record of [undefined, { ...RECORD, lines: [] }, { ...RECORD, extra: 1 }, { opened: 'yes' }]) {
      const { ctx } = ctxOf({}, record);
      const done = ok({ opened: 'ecc83-pp.kicad_sch', dropped: [], warnings: ['w'], chrome: false });
      expect(await widenImport(REQ, ctx, async () => done)).toBe(done);
    }
  });

  it("names a refusal by the engine's first warning line, and leaves every other failure alone", async () => {
    const { ctx, emitted } = ctxOf({}, { ...RECORD, opened: false, saved: false });
    expect(await widenImport(REQ, ctx, async () => fail('import_failed', 'the engine could not import the file')))
      .toEqual(fail('import_failed', 'the engine could not import the file: The following libraries were not found: power'));
    expect(emitted).toEqual([]);
    const busy = fail('busy', 'project.import');
    expect(await widenImport(REQ, ctxOf({}, RECORD).ctx, async () => busy)).toBe(busy);
  });

  it('refuses a request that is no KiCad 5 project with bad_args, before the engine is read', async () => {
    const { ctx } = ctxOf({ mod: () => null });
    const next = vi.fn(async (): Promise<Answer> => ok());
    const bad = [
      { ...REQ, open: 'ecc83-pp.kicad_pro' },
      { ...REQ, open: 'ecc83-pp.PRO' },
      { ...REQ, open: '.pro' },
      { ...REQ, open: 7 },
      { ...REQ, files: FILES.filter((f) => f.path !== 'ecc83-pp.sch') },
      { ...REQ, files: FILES.filter((f) => f.path !== 'ecc83-pp.pro') },
      { ...REQ, files: 'x' },
      { ...REQ, sheets: ['ecc83-pp.sch'] },
      { ...REQ, project: 'ecc83-pp.pro' },
      { ...REQ, extra: true },
    ];
    for (const args of bad) expect(await widenImport(args, ctx, next)).toEqual(fail('bad_args', 'project.import'));
    expect(next).not.toHaveBeenCalled();
  });

  it('answers not_ready with no engine and unsupported naming the export on engine run 14, calling nothing', async () => {
    const next = vi.fn(async (): Promise<Answer> => ok());
    expect(await widenImport(REQ, ctxOf({ mod: () => null }).ctx, next)).toEqual(fail('not_ready', 'project.import'));
    const run14 = { kicadImportSchematic: async () => true };
    const { ctx } = ctxOf({ mod: () => run14, has: (n: readonly string[]) => n.every((x) => x in run14) });
    expect(await widenImport(REQ, ctx, next)).toEqual(fail('unsupported', 'kicadImportLegacyProject'));
    expect(next).not.toHaveBeenCalled();
  });

  it('a project in a folder keeps its folder', async () => {
    const files = FILES.map((f) => ({ ...f, path: `demos/${f.path}` }));
    const { ctx } = ctxOf();
    let call: unknown = null;
    await widenImport({ ...REQ, files, open: 'demos/ecc83-pp.pro' }, ctx, async (a) => {
      call = importCall('sch', ROOT, (a as { open: string }).open, undefined, 'kicad5');
      return ok({});
    });
    expect(call).toEqual({ name: 'kicadImportLegacyProject', args: [JSON.stringify({ path: `${ROOT}/demos/ecc83-pp.pro`, run: 1, dir: '/tmp/cc-legacy/1' })] });
  });
});
