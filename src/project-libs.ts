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

/** project.libs names at most this many libraries at once. */
export const MAX_PROJECT_LIBS = 16;
/** The project's own lib table of each kind, at the folder's root, as KiCad names them. */
export const TABLE_FILE: Readonly<Record<LibKind, string>> = { symbol: 'sym-lib-table', footprint: 'fp-lib-table' };
const TABLE_HEAD: Readonly<Record<LibKind, string>> = { symbol: 'sym_lib_table', footprint: 'fp_lib_table' };
/** What a project library's path names: a symbol library file, a footprint library folder. */
const LIB_EXT: Readonly<Record<LibKind, string>> = { symbol: '.kicad_sym', footprint: '.pretty' };
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

/** The file system calls this reads with (Emscripten's FS). */
export type ProjectFs = Pick<EmscriptenFS, 'readFile' | 'readdir' | 'analyzePath' | 'stat' | 'isDir'>;

/** A library of the project folder: its nickname, its kind, its path in the project folder (${KIPRJMOD} resolved) and the id the engine's uri carries. */
export interface ProjectLibrary { kind: LibKind; nick: string; path: string; id: string }

/** A row of a lib table: `(lib (name "...") (type "...") (uri "..."))`. */
export interface LibRow { name: string; type: string; uri: string }

/** The rows of a lib table's text, in order; [] when the text is not that table. */
export function parseLibTable(text: string, kind: LibKind): LibRow[] {
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
export function projectPath(row: LibRow, kind: LibKind): string | null {
  if (row.type.toLowerCase() !== 'kicad' || !row.uri.startsWith(KIPRJMOD)) return null;
  const path = row.uri.slice(KIPRJMOD.length);
  if (normalizePath(path) !== path || !path.endsWith(LIB_EXT[kind]) || path === LIB_EXT[kind]) return null;
  return path;
}

/** The engine's library id of a project library (the tail of its /mnt/pcbjam uri). */
export const projectId = (kind: LibKind, nick: string): string => `${ID_PREFIX[kind]}${nick}`;

const textOf = (raw: unknown): string | null =>
  typeof raw === 'string' ? raw : raw instanceof Uint8Array ? new TextDecoder().decode(raw) : null;

export interface ProjectLibs {
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

/**
 * The project libraries of one frame, over the project folder `root` as the
 * engine's file system holds it (`fs` is read at every ask: the engine's FS
 * exists only once it booted).
 */
export function createProjectLibs(opts: { root: string; fs: () => ProjectFs | null | undefined; log?: (msg: string) => void }): ProjectLibs {
  const { root } = opts;
  const log = opts.log ?? (() => undefined);
  const byId = new Map<string, ProjectLibrary>();
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

  return {
    find(nick, prjmod = '') {
      const FS = fs();
      if (FS == null || !isProjectNick(nick)) return [];
      if (prjmod !== '' && normalizePath(prjmod) !== prjmod) return [];
      const at = (rel: string): string => (prjmod === '' ? rel : `${prjmod}/${rel}`);
      const found: ProjectLibrary[] = [];
      for (const kind of LIB_KINDS) {
        const table = read(FS, `${root}/${at(TABLE_FILE[kind])}`);
        if (table == null) continue;
        // The first row of that nickname is the one KiCad takes.
        const row = parseLibTable(table, kind).find((r) => r.name === nick);
        const rel = row == null ? null : projectPath(row, kind);
        if (rel == null) continue;
        // The library's path in the project folder: ${KIPRJMOD} is the project file's folder.
        const path = at(rel);
        if (exists(FS, `${root}/${path}`) !== (kind === 'symbol' ? 'file' : 'dir')) continue;
        found.push({ kind, nick, path, id: projectId(kind, nick) });
      }
      return found;
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
