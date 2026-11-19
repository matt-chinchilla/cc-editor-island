// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// i-librows (PROTOCOL.md libs.remove, paths.set, project.libs): the run time
// rows of the engine's library tables, the host's side of Setup's Sources and
// Paths. libs.remove takes back a row project.libs added (the engine's
// kicadLibsRemoveEntry), paths.set sets path variables to folders of the
// project (kicadPathVarsSet, then every row naming one reloads), and
// project.libs is widened: `vars` resolves rows `${NAME}/...` into the project
// folder, and a nickname may name a design-block-lib-table row (a
// `.kicad_blocks` folder KiCad's own reader reads, added through the widened
// kicadLibsAddEntry), answered under `block`. Every export is engine run 15's
// and feature detected: on run 14 neither cap is listed and each op answers
// unsupported naming the export. paths.set also takes KiCad 10's 3rd party
// variable (KICAD10_3RD_PARTY, the folder of installed add-ons), the one name
// of KiCad's own it admits, where the engine says it takes that name (its
// marker kicadPathVarsThirdParty): cap addonPaths.
// src/project-libs.ts is read at request time (a dynamic import), never at
// load: the registry loads this file while the loader's constants are still
// being read (src/frames.ts), and src/project-libs.ts reads src/stage.ts,
// whose project folder is one of those constants.
import type { BlockLibrary, ProjectLibs, RowKind } from '../../src/project-libs';
import { fail, hasAll, isObj, ok, onlyKeys, type Answer, type ExtUnit, type ResponderCtx } from './contract';

/** The project libraries' module, once the island has loaded. */
const libsModule = () => import('../../src/project-libs');

/** project.libs's own exports (bridge/responder.ts LIBS_EXPORTS). */
export const LIBS_EXPORTS = ['kicadLibsAddEntry', 'kicadLibsReload', 'kicadCollabBusy'] as const;
/** The run time row exports of engine run 15: removal, and the add widened to design block rows (the same engine unit). */
export const ROW_EXPORTS = ['kicadLibsRemoveEntry', 'kicadLibsAddEntry', 'kicadCollabBusy'] as const;
export const PATH_EXPORTS = ['kicadPathVarsSet', 'kicadCollabBusy'] as const;
/** The engine's marker that kicadPathVarsSet takes KiCad's 3rd party variable (KiCad's own Configure Paths sets its value). */
export const THIRD_PARTY_MARKER = 'kicadPathVarsThirdParty';
export const THIRD_PARTY_EXPORTS = [...PATH_EXPORTS, THIRD_PARTY_MARKER] as const;
export const LIB_ROWS_CAP = 'libRows';
export const PATH_VARS_CAP = 'pathVars';
export const ADDON_PATHS_CAP = 'addonPaths';
/** The engine's word for each kind (pcbjam_libs_reload.h tableTypeOf). */
export const ENGINE_KIND: Readonly<Record<RowKind, string>> = { symbol: 'symbol', footprint: 'footprint', block: 'design_block' };
const KINDS: readonly RowKind[] = ['symbol', 'footprint', 'block'];
/** The engine's apply queue is waited for at most this long when the bridge names no libsMs. */
const LIBS_MS = 10_000;

const libsMs = (ctx: ResponderCtx): number => ctx.timing.libsMs ?? LIBS_MS;

/** The frame's project libraries, made by src/main.ts for the project folder. */
const projectOf = async (ctx: ResponderCtx): Promise<ProjectLibs | null> => (await libsModule()).projectLibsAt(ctx.root);

/** The first export of `names` the engine lacks, null when it has them all. */
const missing = (mod: Record<string, unknown>, names: readonly string[]): string | null => names.find((n) => typeof mod[n] !== 'function') ?? null;

/** A load parked, or a popup menu or a dialog of KiCad's up. */
const busyNow = (ctx: ResponderCtx): boolean => ctx.engineBusy() || ctx.keysBlocked();

/**
 * project.libs widened (PROTOCOL.md): a request with no `vars` whose
 * nicknames name no design block row is the op as it shipped, its answer
 * given `block: []`. Otherwise the checks, in order, every one before any
 * effect: the args (bad_args); the engine (not_ready, unsupported naming the
 * first missing export, kicadLibsRemoveEntry for a block row on an engine
 * that cannot add one); each nickname (not_found for the first that names no
 * library with the variables applied); busy. Then the symbol and footprint
 * libraries go through the op as it shipped (its own checks still apply: a
 * refusal there puts the variables back), and each block row is added (an
 * earlier one taken out first, so KiCad reads its folder again).
 */
export async function projectLibsWidened(args: unknown, ctx: ResponderCtx, next: (args: unknown) => Promise<Answer>): Promise<Answer> {
  const op = 'project.libs';
  if (ctx.frame !== 'sch' && ctx.frame !== 'pcb') return next(args);
  const lib = await libsModule();
  const a = lib.readProjectLibsArgs(args);
  if (a == null) return fail('bad_args', op);
  const project = lib.projectLibsAt(ctx.root);
  const prjmod = lib.prjmodOf(ctx.opened(), ctx.root);
  const blockOf = (nick: string): BlockLibrary | null => project?.findBlock(nick, prjmod) ?? null;
  const withBlock = (r: Answer, block: string[]): Answer => (r.ok ? ok({ symbol: [], footprint: [], ...r.result, block }) : r);
  // Without variables a request naming no block row is the op as it shipped.
  if (a.vars == null && !a.nicks.some((n) => blockOf(n) != null)) return withBlock(await next({ libs: a.nicks }), []);

  const w = ctx.win();
  const mod = ctx.mod();
  if (w == null || mod == null) return fail('not_ready', op);
  const lacking = missing(mod, LIBS_EXPORTS);
  if (lacking != null) return fail('unsupported', lacking);
  if (project == null || ctx.fs() == null) return fail('unsupported', 'project libraries');

  const before = a.vars == null ? null : project.setVars(a.vars);
  const putBack = (r: Answer): Answer => { if (before != null) project.restoreVars(before); return r; };
  const viaOp: string[] = [];
  const blocks: BlockLibrary[] = [];
  for (const nick of a.nicks) {
    const block = blockOf(nick);
    const libs = project.find(nick, prjmod);
    if (block == null && libs.length === 0) return putBack(fail('not_found', nick));
    if (libs.length > 0) viaOp.push(nick);
    if (block != null) blocks.push(block);
  }
  if (blocks.length > 0) {
    const noRows = missing(mod, ROW_EXPORTS);
    if (noRows != null) return putBack(fail('unsupported', noRows));
  }
  if (ctx.closed()) return putBack(fail('island_error', 'the frame closed'));
  if (busyNow(ctx)) return putBack(fail('busy', op));

  let answered: Answer = ok({ symbol: [], footprint: [] });
  if (viaOp.length > 0) {
    answered = await next({ libs: viaOp });
    if (!answered.ok) return putBack(answered);
  }
  if (blocks.length === 0) return withBlock(answered, []);

  const t0 = Date.now();
  try {
    for (const lib of blocks) {
      const abs = `${ctx.root}/${lib.path}`;
      // KiCad's add keeps a row it holds: an earlier row of this nickname is taken out first, so the folder is read again.
      if (project.registeredBlock(lib.nick) != null) await (mod.kicadLibsRemoveEntry as (k: string, n: string) => unknown)(ENGINE_KIND.block, lib.nick);
      await (mod.kicadLibsAddEntry as (k: string, n: string, u: string) => unknown)(ENGINE_KIND.block, lib.nick, abs);
      project.registerBlock(lib);
    }
  } catch (err) {
    return fail('island_error', err instanceof Error ? err.message : String(err));
  }
  if (!(await ctx.applyIdle(libsMs(ctx)))) return fail('island_error', 'the engine did not load the libraries within the time limit');
  ctx.log('[libs]', `project.libs blocks ${blocks.map((b) => b.nick).join(' ')}`, `${Date.now() - t0} ms`);
  return withBlock(answered, a.nicks.filter((n) => blocks.some((b) => b.nick === n)));
}

/**
 * libs.remove (PROTOCOL.md): takes back a row project.libs added at run time.
 * The checks, in order, before any effect: the args (bad_args), the engine
 * (not_ready, unsupported naming the first missing export), busy. Then the
 * engine's kicadLibsRemoveEntry: false (a row the boot made, or none of that
 * nickname) answers not_found; else the island forgets the library and the
 * answer waits for the engine's apply queue to empty.
 */
export async function libsRemove(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const op = 'libs.remove';
  if (!isObj(args) || !onlyKeys(args, ['kind', 'nickname']) || !KINDS.includes(args.kind as RowKind) || !(await libsModule()).isProjectNick(args.nickname)) return fail('bad_args', op);
  const kind = args.kind as RowKind;
  const nick = args.nickname;
  const mod = ctx.mod();
  if (ctx.win() == null || mod == null) return fail('not_ready', op);
  const lacking = missing(mod, ROW_EXPORTS);
  if (lacking != null) return fail('unsupported', lacking);
  if (busyNow(ctx)) return fail('busy', op);
  let removed: unknown;
  try {
    removed = await (mod.kicadLibsRemoveEntry as (k: string, n: string) => unknown)(ENGINE_KIND[kind], nick);
  } catch (err) {
    return fail('island_error', err instanceof Error ? err.message : String(err));
  }
  if (removed !== true) return fail('not_found', nick);
  (await projectOf(ctx))?.unregister(kind, nick);
  if (!(await ctx.applyIdle(libsMs(ctx)))) return fail('island_error', 'the engine did not remove the row within the time limit');
  return ok();
}

/**
 * paths.set (PROTOCOL.md): sets path variables to folders of the project,
 * KiCad's 3rd party variable among them where the engine takes it.
 * The checks, in order, before any effect: the args (bad_args), the engine
 * (not_ready, unsupported naming the first missing export, and the marker
 * when the 3rd party variable is sent), busy. Then the
 * engine's kicadPathVarsSet with each folder made absolute (false answers
 * not_applied), the island's project rows resolve them from now on, and the
 * answer `{ set }` waits for the engine's apply queue to empty.
 */
export async function pathsSet(args: unknown, ctx: ResponderCtx): Promise<Answer> {
  const op = 'paths.set';
  if (!isObj(args) || !onlyKeys(args, ['vars'])) return fail('bad_args', op);
  const lib = await libsModule();
  const vars = lib.readPathVars(args.vars, { thirdParty: true });
  if (vars == null) return fail('bad_args', op);
  const mod = ctx.mod();
  if (ctx.win() == null || mod == null) return fail('not_ready', op);
  const lacking = missing(mod, lib.THIRD_PARTY_VAR in vars ? THIRD_PARTY_EXPORTS : PATH_EXPORTS);
  if (lacking != null) return fail('unsupported', lacking);
  if (busyNow(ctx)) return fail('busy', op);
  const abs = Object.fromEntries(Object.entries(vars).map(([name, folder]) => [name, `${ctx.root}/${folder}`]));
  let queued: unknown;
  try {
    queued = await (mod.kicadPathVarsSet as (json: string) => unknown)(JSON.stringify({ vars: abs }));
  } catch (err) {
    return fail('island_error', err instanceof Error ? err.message : String(err));
  }
  if (queued !== true) return fail('not_applied', op);
  (await projectOf(ctx))?.setVars(vars);
  if (!(await ctx.applyIdle(libsMs(ctx)))) return fail('not_applied', op);
  return ok({ set: Object.keys(vars) });
}

export default {
  unit: 'i-librows',
  frames: ['sch', 'pcb'],
  frameRefusal: 'library rows and path variables change in a sch or a pcb frame',
  capNames: [LIB_ROWS_CAP, PATH_VARS_CAP, ADDON_PATHS_CAP],
  caps: (mod, frame) => {
    if (frame !== 'sch' && frame !== 'pcb') return [];
    const caps: string[] = [];
    if (hasAll(mod, ROW_EXPORTS) && hasAll(mod, LIBS_EXPORTS)) caps.push(LIB_ROWS_CAP);
    if (hasAll(mod, PATH_EXPORTS)) caps.push(PATH_VARS_CAP);
    if (hasAll(mod, THIRD_PARTY_EXPORTS)) caps.push(ADDON_PATHS_CAP);
    return caps;
  },
  ops: {
    'libs.remove': { run: libsRemove },
    'paths.set': { run: pathsSet },
  },
  opsWidened: {
    'project.libs': projectLibsWidened,
  },
} satisfies ExtUnit;
