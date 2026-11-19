// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// st-open-kicad5-i: project.import { format: 'kicad5' } in a sch frame opens a
// KiCad 5 project (`<stem>.pro` with its root sheet `<stem>.sch` and whatever
// else the project carried: `<stem>-cache.lib`, `<stem>-rescue.lib`,
// `sym-lib-table`) through engine run 15's kicadImportLegacyProject, which
// remaps and rescues every symbol with no window and saves the project as
// KiCad 10 files. The call itself is bridge/import.ts importCall's (the file
// the import units own); this widening checks the request, names the run
// folder the engine writes its record in, sends the tables only the engine
// wrote (sym-lib-table, the rescue symbols) as ev.saved, and reads the
// record's warnings into the answer. Cap importLegacy, feature detected: on engine run 14 it is
// not listed and the import answers unsupported naming the export. The pieces
// both files read are st-open-kicad5-i/legacy.ts, which imports nothing: a unit
// that loaded bridge/import.ts would load the frame registry inside its own load.
import { fail, hasAll, isObj, ok, onlyKeys, type Answer, type ExtUnit, type ResponderCtx, type Widen } from './contract';
import { armLegacyRun, foldLines, LEGACY_EXPORT, LEGACY_FORMAT, LEGACY_LINE_CHARS, LEGACY_RECORD, LEGACY_RUN_ROOT, legacyProjectOf, legacySheetOf, legacyTableFiles, legacyWarnings, readLegacyRecord, type LegacyRecord } from './st-open-kicad5-i/legacy';

const OP = 'project.import';
/** The refusal's message when the engine refused the project and its record names why. */
const REFUSED = 'the engine could not import the file';

/** The paths of a request's files as sent, or null when `files` is not a list of `{ path }` (the op checks the rest). */
function filePaths(files: unknown): string[] | null {
  if (!Array.isArray(files)) return null;
  const out: string[] = [];
  for (const f of files as unknown[]) {
    if (!isObj(f) || typeof f.path !== 'string') return null;
    out.push(f.path);
  }
  return out;
}

/** The answer with the record's warnings first, or a refusal named by the record's first warning. */
function withRecord(a: Answer, record: LegacyRecord | null): Answer {
  const lines = legacyWarnings(record);
  if (a.ok) {
    const before = Array.isArray(a.result.warnings) ? (a.result.warnings as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    return lines.length === 0 ? a : ok({ ...a.result, warnings: foldLines([...lines, ...before]) });
  }
  if (a.code === 'import_failed' && a.message === REFUSED && lines.length > 0) return fail(a.code, `${REFUSED}: ${lines[0]}`.slice(0, LEGACY_LINE_CHARS));
  return a;
}

/**
 * project.import widened. Any other format, and any frame but sch (a pcb frame
 * reads no format), goes on as before. A KiCad 5 request: `open` names the
 * project's `<stem>.pro` or its root sheet `<stem>.sch`, both among `files`,
 * and no `sheets` or `project` (bad_args otherwise); then not_ready with no
 * engine, unsupported naming kicadImportLegacyProject without it. The import
 * then runs as any schematic import, with `open` its root sheet.
 */
export const widenImport: Widen = async (args, ctx: ResponderCtx, next) => {
  if (!isObj(args) || args.format !== LEGACY_FORMAT || ctx.frame !== 'sch') return next(args);
  if (!onlyKeys(args, ['name', 'files', 'open', 'format']) || typeof args.open !== 'string') return fail('bad_args', OP);
  const sheet = legacySheetOf(args.open);
  const paths = filePaths(args.files);
  if (sheet == null || paths == null || !paths.includes(sheet) || !paths.includes(legacyProjectOf(sheet))) return fail('bad_args', OP);
  if (ctx.mod() == null) return fail('not_ready', OP);
  if (!ctx.has([LEGACY_EXPORT])) return fail('unsupported', LEGACY_EXPORT);
  const dir = ctx.fs() == null ? null : ctx.freshRunFolder(LEGACY_RUN_ROOT);
  armLegacyRun(dir);
  let a: Answer;
  try {
    a = await next({ ...args, open: sheet });
  } finally {
    armLegacyRun(null);
  }
  if (dir == null) return a;
  const record = readLegacyRecord(ctx.readBytes(`${dir}/${LEGACY_RECORD}`));
  ctx.dropRunFolder(dir);
  // The tables the engine wrote reach the host as ev.saved before the answer, as the sheets the frame's Save reported did.
  if (a.ok) {
    for (const path of legacyTableFiles(record, ctx.root)) {
      const bytes = ctx.readBytes(`${ctx.root}/${path}`);
      if (bytes != null) ctx.emit({ type: 'ev.saved', path, bytes });
    }
  }
  return withRecord(a, record);
};

export default {
  unit: 'st-open-kicad5-i',
  capNames: ['importLegacy'],
  caps: (mod, frame) => (frame === 'sch' && hasAll(mod, [LEGACY_EXPORT]) ? ['importLegacy'] : []),
  opsWidened: { [OP]: widenImport },
} satisfies ExtUnit;
