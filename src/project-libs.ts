// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The design's own libraries (PROTOCOL.md project.libs, LIBRARY.md "The project
// library"): a library of the project folder that the folder's own lib tables
// name, a KiCad row of a ${KIPRJMOD} path, served to the engine and to the
// picker's reads from the folder itself, so a part the host writes into a
// running frame is placed, listed by KiCad's choosers and found by Update PCB
// from Schematic without a reboot.
//
// The road (spike, 2026-10-27, PROTOCOL.md): KiCad reads a project's lib
// tables once, when it loads the project, and no engine export reloads them,
// so the engine's own reload over the project's tables finds nothing on a live
// engine. Instead each registered library is a row the frame adds to the
// engine's table at run time (kicadLibsAddEntry), whose uri is the island's
// mount (/mnt/pcbjam/prj.sym.<nickname>, prj.fp.<nickname>), and the
// provider (loader/src/wasm/libs/source.ts) asks this source for its items:
// read from the folder at every ask, so nothing here holds a copy and a part
// written since is found on the next reload (kicadLibsReload).
import { assembleSymbolBody, splitSymbolLib, symbolBody } from '../loader/src/wasm/libs/symbol-body';
import type { LibInfo, LibItemInfo, LibsSource } from '../loader/src/wasm/libs/source';
import { libUri } from '../loader/src/wasm/libs/uri';
import { headOf, listsOf, readSexpr, valueOf } from './sexpr';
import { normalizePath } from './stage';

export type LibKind = 'symbol' | 'footprint';
export const LIB_KINDS: readonly LibKind[] = ['symbol', 'footprint'];
/**
 * A kind of library row the engine adds at run time (i-librows): a design
 * block library besides the two. A block library is a folder KiCad's own
 * reader reads, never served through the island's mount.
 */
export type RowKind = LibKind | 'block';
export const ROW_KINDS: readonly RowKind[] = ['symbol', 'footprint', 'block'];
/** The project's design block table, beside the other two, as KiCad names it. */
export const BLOCK_TABLE_FILE = 'design-block-lib-table';

/** project.libs names at most this many libraries at once. */
export const MAX_PROJECT_LIBS = 16;
/** The project's own lib table of each kind, at the folder's root, as KiCad names them. */
export const TABLE_FILE: Readonly<Record<LibKind, string>> = { symbol: 'sym-lib-table', footprint: 'fp-lib-table' };
const TABLE_HEAD: Readonly<Record<RowKind, string>> = { symbol: 'sym_lib_table', footprint: 'fp_lib_table', block: 'design_block_lib_table' };
/** What a project library's path names: a symbol library file, a footprint library folder, a design block library folder. */
const LIB_EXT: Readonly<Record<RowKind, string>> = { symbol: '.kicad_sym', footprint: '.pretty', block: '.kicad_blocks' };
const ID_PREFIX: Readonly<Record<LibKind, string>> = { symbol: 'prj.sym.', footprint: 'prj.fp.' };
const KIPRJMOD = '${KIPRJMOD}/';
const FOOTPRINT_EXT = '.kicad_mod';
/**
 * A project library's nickname: a library nickname as the picker's ops take one
 * (1 to 255 characters, no control character), and none of / \ : (the nickname
 * is the tail of the engine's library uri, and KiCad's LIB_ID splits on the colon).
 */
const NICK_RE = /^[^\u0000-\u001f\u007f/\\:]{1,255}$/;
export const isProjectNick = (v: unknown): v is string => typeof v === 'string' && NICK_RE.test(v);

/** A path variable's name as the host sets one (paths.set, project.libs vars): KiCad's form, upper case. */
export const PATH_VAR_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
/** paths.set and project.libs name at most this many path variables at once. */
export const MAX_PATH_VARS = 64;
/** KiCad's own variables (ENV_VAR's predefined list, the versioned ones of KiCad 6 to 10, and the block folder): never set by a host. */
const BUILTIN_VARS = new Set(['KIPRJMOD', 'KICAD_USER_TEMPLATE_DIR', 'KICAD_PTEMPLATES']);
const BUILTIN_VERSIONED_RE = /^KICAD(?:[6-9]|10)_(?:SYMBOL_DIR|FOOTPRINT_DIR|3DMODEL_DIR|TEMPLATE_DIR|3RD_PARTY|DESIGN_BLOCK_DIR)$/;
export const isBuiltinPathVar = (name: string): boolean => BUILTIN_VARS.has(name) || BUILTIN_VERSIONED_RE.test(name);
/**
 * KiCad 10's folder of installed add-ons (the engine's KiCad is 10): the one
 * name of KiCad's own a host may set, through paths.set alone and only where
 * the engine takes it (cap addonPaths), so the rows a design names under it
 * resolve to the add-on files the host wrote into the project.
 */
export const THIRD_PARTY_VAR = 'KICAD10_3RD_PARTY';
/**
 * The path variables of a request, checked closed: an object of 1 to 64
 * entries, each name in KiCad's form and none of KiCad's own (but
 * THIRD_PARTY_VAR with `thirdParty`), each value a folder of the project in
 * project.open's normal form. Null for anything else.
 */
export function readPathVars(v: unknown, opts: { thirdParty?: boolean } = {}): Record<string, string> | null {
  if (typeof v !== 'object' || v == null || Array.isArray(v)) return null;
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_PATH_VARS) return null;
  const out: Record<string, string> = {};
  for (const [name, folder] of entries) {
    if (!PATH_VAR_RE.test(name) || (isBuiltinPathVar(name) && !(opts.thirdParty === true && name === THIRD_PARTY_VAR))) return null;
    if (typeof folder !== 'string' || folder === '' || normalizePath(folder) !== folder) return null;
    out[name] = folder;
  }
  return out;
}

/**
 * The args of project.libs as i-librows widens them: `{ libs, vars? }`,
 * checked closed (libs as the op takes them, a repeat counting once; vars as
 * readPathVars takes them); null for anything else.
 */
export function readProjectLibsArgs(args: unknown): { nicks: string[]; vars: Record<string, string> | null } | null {
  if (typeof args !== 'object' || args == null || Array.isArray(args)) return null;
  const a = args as Record<string, unknown>;
  if (!Object.keys(a).every((k) => k === 'libs' || k === 'vars')) return null;
  const libs = a.libs;
  if (!Array.isArray(libs) || libs.length === 0 || libs.length > MAX_PROJECT_LIBS || !libs.every(isProjectNick)) return null;
  let vars: Record<string, string> | null = null;
  if ('vars' in a) {
    vars = readPathVars(a.vars);
    if (vars == null) return null;
  }
  return { nicks: [...new Set(libs as string[])], vars };
}

/**
 * ${KIPRJMOD} as a path in the project folder `root`, as the built in
 * project.libs reads it: the folder of the open document (a path in the
 * folder, or an absolute one under it), the root ('') while none is open.
 */
export function prjmodOf(opened: string | null, root: string): string {
  if (opened == null) return '';
  const rel = opened.startsWith(`${root}/`) ? opened.slice(root.length + 1) : opened;
  if (normalizePath(rel) !== rel || !rel.includes('/')) return '';
  return rel.slice(0, rel.lastIndexOf('/'));
}

/** A row's uri as `${NAME}/` and a path in its normal form ending in `ext` (not the bare extension); null for any other uri. */
function varPath(uri: string, ext: string): { name: string; rel: string } | null {
  const m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}\/(.*)$/.exec(uri);
  if (m == null) return null;
  const rel = m[2];
  if (normalizePath(rel) !== rel || !rel.endsWith(ext) || rel === ext) return null;
  return { name: m[1], rel };
}

/** The file system calls this reads with (Emscripten's FS). */
export type ProjectFs = Pick<EmscriptenFS, 'readFile' | 'readdir' | 'analyzePath' | 'stat' | 'isDir'>;

/** A library of the project folder: its nickname, its kind, its path in the project folder (${KIPRJMOD} resolved) and the id the engine's uri carries. */
export interface ProjectLibrary { kind: LibKind; nick: string; path: string; id: string }

/** A row of a lib table: `(lib (name "...") (type "...") (uri "..."))`. */
export interface LibRow { name: string; type: string; uri: string }

/** The rows of a lib table's text, in order; [] when the text is not that table. */
export function parseLibTable(text: string, kind: RowKind): LibRow[] {
  const tree = readSexpr(text);
  if (tree == null || headOf(tree) !== TABLE_HEAD[kind]) return [];
  const rows: LibRow[] = [];
  for (const lib of listsOf(tree, 'lib')) {
    const name = valueOf(lib, 'name');
    const type = valueOf(lib, 'type');
    const uri = valueOf(lib, 'uri');
    if (name != null && type != null && uri != null) rows.push({ name, type, uri });
  }
  return rows;
}

/**
 * The folder path a row names when it is a project library row of `kind`: type
 * KiCad (in any case, as KiCad's plugin lookup reads it), a uri of
 * ${KIPRJMOD}/ and a path in its normal form ending in the kind's extension.
 * Null for any other row.
 */
export function projectPath(row: LibRow, kind: RowKind): string | null {
  if (row.type.toLowerCase() !== 'kicad' || !row.uri.startsWith(KIPRJMOD)) return null;
  const at = varPath(row.uri, LIB_EXT[kind]);
  return at == null || at.name !== 'KIPRJMOD' ? null : at.rel;
}

/**
 * The path in the project folder a project row of `kind` names: a
 * ${KIPRJMOD} row from `prjmod` (the project file's folder, '' for the
 * root), a row of a path variable the host set (`vars`, each a folder of the
 * project) from that folder. Null for any other row, or a path that leaves
 * the project folder.
 */
export function rowPath(row: LibRow, kind: RowKind, prjmod: string, vars: Readonly<Record<string, string>>): string | null {
  if (row.type.toLowerCase() !== 'kicad') return null;
  const at = varPath(row.uri, LIB_EXT[kind]);
  if (at == null) return null;
  const base = at.name === 'KIPRJMOD' ? prjmod : Object.prototype.hasOwnProperty.call(vars, at.name) ? vars[at.name] : null;
  if (base == null) return null;
  const path = base === '' ? at.rel : `${base}/${at.rel}`;
  return normalizePath(path) === path ? path : null;
}

/** The engine's library id of a project library (the tail of its /mnt/pcbjam uri). */
export const projectId = (kind: LibKind, nick: string): string => `${ID_PREFIX[kind]}${nick}`;

const textOf = (raw: unknown): string | null =>
  typeof raw === 'string' ? raw : raw instanceof Uint8Array ? new TextDecoder().decode(raw) : null;

/** A design block library of the project folder: its nickname and its folder's path in the project folder. */
export interface BlockLibrary { nick: string; path: string }

export interface ProjectLibs {
  /** The project folder these libraries are read from. */
  readonly root: string;
  /**
   * Sets path variables (paths.set, project.libs vars), each to a folder of
   * the project: from now on a row `${NAME}/...` of the project's tables
   * names a library there. Merged over those set before; answers the
   * variables as they stood before the call.
   */
  setVars(vars: Readonly<Record<string, string>>): Record<string, string>;
  /** Puts the variables back as `setVars` answered them. */
  restoreVars(vars: Readonly<Record<string, string>>): void;
  /** The path variables set now. */
  vars(): Record<string, string>;
  /**
   * The design block library the project's design-block-lib-table in
   * `prjmod` names `nick` as, whose folder is there; null when there is none.
   */
  findBlock(nick: string, prjmod?: string): BlockLibrary | null;
  /** From now on `lib` is a design block row the engine holds. */
  registerBlock(lib: BlockLibrary): void;
  /** The registered design block library of that nickname. */
  registeredBlock(nick: string): BlockLibrary | null;
  /** Forgets a registered library of that kind and nickname (libs.remove): the next project.libs adds its row again. */
  unregister(kind: RowKind, nick: string): void;
  /**
   * The project libraries the project's own tables name `nick` as, at most one
   * per kind, each whose file (a symbol library) or folder (a footprint
   * library) is there. `prjmod` is ${KIPRJMOD}, the folder of the project
   * file, as a path in the project folder ('' for its root): the tables are
   * read there and a row's path is taken from there. Read from the folder now;
   * [] when there is none.
   */
  find(nick: string, prjmod?: string): ProjectLibrary[];
  /** From now on `lib` is served (its items read from the folder at every ask). */
  register(lib: ProjectLibrary): void;
  /** The registered library of that kind and nickname. */
  registered(kind: LibKind, nick: string): ProjectLibrary | null;
  /** The engine uri of a project library: the island's mount and its id. */
  uri(lib: ProjectLibrary): string;
  /** The registered libraries of a kind, as LibInfo rows, in the order registered. */
  libInfos(kind?: string): LibInfo[];
  /** Whether a library id is a project library's (served here, never by the mirror). */
  owns(id: string): boolean;
  listItems(id: string): Promise<LibItemInfo[]>;
  getItemBody(id: string, kind: string, name: string): Promise<string | null>;
  getAllItems(id: string): Promise<Array<{ kind: string; name: string; body: Uint8Array }>>;
}

/** The frame's project libraries by project folder: the last made for a folder stands. */
const AT_ROOT = new Map<string, ProjectLibs>();

/**
 * The project libraries the frame made for `root` (createProjectLibs), null
 * when none: how a wave unit's file (bridge/ext/i-librows.ts) reaches the
 * frame's own, which src/main.ts hands the responder.
 */
export const projectLibsAt = (root: string): ProjectLibs | null => AT_ROOT.get(root) ?? null;

/**
 * The project libraries of one frame, over the project folder `root` as the
 * engine's file system holds it (`fs` is read at every ask: the engine's FS
 * exists only once it booted).
 */
export function createProjectLibs(opts: { root: string; fs: () => ProjectFs | null | undefined; log?: (msg: string) => void }): ProjectLibs {
  const { root } = opts;
  const log = opts.log ?? (() => undefined);
  const byId = new Map<string, ProjectLibrary>();
  const blocks = new Map<string, BlockLibrary>();
  let pathVars: Record<string, string> = {};
  const enc = new TextEncoder();

  const fs = (): ProjectFs | null => opts.fs() ?? null;
  const exists = (FS: ProjectFs, abs: string): 'file' | 'dir' | null => {
    try {
      if (!FS.analyzePath(abs).exists) return null;
      return FS.isDir(FS.stat(abs).mode) ? 'dir' : 'file';
    } catch {
      return null;
    }
  };
  const read = (FS: ProjectFs, abs: string): string | null => {
    try { return textOf(FS.readFile(abs, { encoding: 'utf8' })); } catch { return null; }
  };

  /** A symbol library's items, split from its file: name to the symbol alone under the file's header. */
  function symbols(lib: ProjectLibrary): Map<string, string> {
    const out = new Map<string, string>();
    const FS = fs();
    const text = FS == null ? null : read(FS, `${root}/${lib.path}`);
    if (text == null) return out;
    const split = splitSymbolLib(text);
    if (split == null) {
      log(`[libs] project library ${lib.nick}: ${lib.path} is not a symbol library`);
      return out;
    }
    // A name twice in one file: the first stands, as the fat list takes it.
    for (const s of split.symbols) if (!out.has(s.name)) out.set(s.name, symbolBody(split.header, s.block));
    return out;
  }

  /** A footprint library's item names: its folder's .kicad_mod files, each by its stem, in code point order. */
  function footprints(lib: ProjectLibrary): string[] {
    const FS = fs();
    if (FS == null) return [];
    try {
      return FS.readdir(`${root}/${lib.path}`)
        .filter((n) => n.endsWith(FOOTPRINT_EXT) && n.length > FOOTPRINT_EXT.length && exists(FS, `${root}/${lib.path}/${n}`) === 'file')
        .map((n) => n.slice(0, -FOOTPRINT_EXT.length))
        .sort();
    } catch {
      return [];
    }
  }

  function footprint(lib: ProjectLibrary, name: string): string | null {
    const FS = fs();
    if (FS == null || !footprints(lib).includes(name)) return null;
    return read(FS, `${root}/${lib.path}/${name}${FOOTPRINT_EXT}`);
  }

  /** The path in the project folder of the row the project's `kind` table in `prjmod` names `nick` as, and whether it is there as a file or a folder. */
  function rowOf(FS: ProjectFs, kind: RowKind, nick: string, prjmod: string): { path: string; is: 'file' | 'dir' | null } | null {
    if (!isProjectNick(nick)) return null;
    if (prjmod !== '' && normalizePath(prjmod) !== prjmod) return null;
    const file = kind === 'block' ? BLOCK_TABLE_FILE : TABLE_FILE[kind];
    const table = read(FS, `${root}/${prjmod === '' ? file : `${prjmod}/${file}`}`);
    if (table == null) return null;
    // The first row of that nickname is the one KiCad takes.
    const row = parseLibTable(table, kind).find((r) => r.name === nick);
    // ${KIPRJMOD} is the project file's folder; a path variable, the folder the host set.
    const path = row == null ? null : rowPath(row, kind, prjmod, pathVars);
    return path == null ? null : { path, is: exists(FS, `${root}/${path}`) };
  }

  const libs: ProjectLibs = {
    root,
    setVars(vars) {
      const before = { ...pathVars };
      pathVars = { ...pathVars, ...vars };
      return before;
    },
    restoreVars(vars) {
      pathVars = { ...vars };
    },
    vars() {
      return { ...pathVars };
    },
    find(nick, prjmod = '') {
      const FS = fs();
      if (FS == null) return [];
      const found: ProjectLibrary[] = [];
      for (const kind of LIB_KINDS) {
        const at = rowOf(FS, kind, nick, prjmod);
        if (at == null || at.is !== (kind === 'symbol' ? 'file' : 'dir')) continue;
        found.push({ kind, nick, path: at.path, id: projectId(kind, nick) });
      }
      return found;
    },
    findBlock(nick, prjmod = '') {
      const FS = fs();
      if (FS == null) return null;
      const at = rowOf(FS, 'block', nick, prjmod);
      return at == null || at.is !== 'dir' ? null : { nick, path: at.path };
    },
    registerBlock(lib) {
      blocks.set(lib.nick, { ...lib });
    },
    registeredBlock(nick) {
      return blocks.get(nick) ?? null;
    },
    unregister(kind, nick) {
      if (kind === 'block') blocks.delete(nick);
      else byId.delete(projectId(kind, nick));
    },
    register(lib) {
      byId.set(lib.id, { ...lib });
    },
    registered(kind, nick) {
      return byId.get(projectId(kind, nick)) ?? null;
    },
    uri(lib) {
      return libUri(lib.id);
    },
    libInfos(kind) {
      return [...byId.values()]
        .filter((l) => kind == null || l.kind === kind)
        .map((l) => ({ id: l.id, name: l.nick, description: 'This design\'s own library', type: 'project' }));
    },
    owns(id) {
      return byId.has(id);
    },
    async listItems(id) {
      const lib = byId.get(id);
      if (lib == null) return [];
      return lib.kind === 'symbol'
        ? [...symbols(lib).keys()].map((name) => ({ kind: 'symbol', name }))
        : footprints(lib).map((name) => ({ kind: 'footprint', name }));
    },
    async getItemBody(id, kind, name) {
      const lib = byId.get(id);
      if (lib == null || kind !== lib.kind) return null;
      if (lib.kind === 'footprint') return footprint(lib, name);
      // A derived symbol is given with its extends chain from the same file, as lib.item gives a mirror's.
      const items = symbols(lib);
      return assembleSymbolBody(name, (n) => items.get(n) ?? null, log);
    },
    async getAllItems(id) {
      const lib = byId.get(id);
      if (lib == null) return [];
      if (lib.kind === 'symbol') return [...symbols(lib)].map(([name, body]) => ({ kind: 'symbol', name, body: enc.encode(body) }));
      return footprints(lib).flatMap((name) => {
        const body = footprint(lib, name);
        return body == null ? [] : [{ kind: 'footprint', name, body: enc.encode(body) }];
      });
    },
  };
  AT_ROOT.set(root, libs);
  return libs;
}

/**
 * The source the island boots with: the project libraries first, by id, and
 * everything else from `base` (the mirror, or the example library), whose
 * optional parts (presync, the footprint index, ...) pass through unchanged.
 */
export function withProjectLibs(base: LibsSource, project: ProjectLibs): LibsSource {
  const out: LibsSource = {
    async listLibs(kind) {
      return [...project.libInfos(kind), ...(await base.listLibs(kind))];
    },
    listItems: (id) => (project.owns(id) ? project.listItems(id) : base.listItems(id)),
    getItemBody: (id, kind, name) => (project.owns(id) ? project.getItemBody(id, kind, name) : base.getItemBody(id, kind, name)),
    async getAllItems(id) {
      if (project.owns(id)) return project.getAllItems(id);
      if (base.getAllItems != null) return base.getAllItems(id);
      // A source without a bulk read (the example library): its items one by one, as the provider's own fallback reads them.
      const enc = new TextEncoder();
      const items = await base.listItems(id);
      const bodies = await Promise.all(items.map((it) => base.getItemBody(id, it.kind, it.name).catch(() => null)));
      return items.flatMap((it, i) => {
        const body = bodies[i];
        return body == null ? [] : [{ kind: it.kind, name: it.name, body: enc.encode(body) }];
      });
    },
  };
  if (base.presync != null) out.presync = (o) => base.presync!(o);
  if (base.syncState != null) out.syncState = (kind) => base.syncState!(kind);
  if (base.saveItemBody != null) out.saveItemBody = (id, kind, name, body) => (project.owns(id) ? Promise.resolve(false) : base.saveItemBody!(id, kind, name, body));
  if (base.createLib != null) out.createLib = (name) => base.createLib!(name);
  if (base.getFpIndex != null) out.getFpIndex = () => base.getFpIndex!();
  if (base.dispose != null) out.dispose = () => base.dispose!();
  if (base.enableRealtime != null) out.enableRealtime = (names) => base.enableRealtime!(names);
  return out;
}
