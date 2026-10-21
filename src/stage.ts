// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The handoff lands here: every path is normalized again on this side, and
// files are written only under <MEMFS_PROJECTS_DIR>/<id>/ (the directory the
// save hook reports paths against), never near the seeded config under
// /home/kicad/.config.
import { MEMFS_PROJECTS_DIR } from '../loader/src/wasm/constants';
import { openFileInTool } from '../loader/src/wasm/open-flow';

const MAX_PATH_BYTES = 255;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const enc = new TextEncoder();
export const PROJECT_ROOT = MEMFS_PROJECTS_DIR;

export function normalizePath(input: string): string | null {
  if (input.includes('\u0000')) return null;
  let p = input.replace(/\\/g, '/');
  if (p.startsWith('./')) p = p.slice(2);
  if (p.startsWith('/')) return null;
  const segments = p.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
  if (enc.encode(p).byteLength > MAX_PATH_BYTES) return null;
  return p;
}

export interface StagedProject { root: string; written: string[]; dropped: string[] }

export function stageProject(win: ToolWindow, id: string, files: Array<{ path: string; bytes: Uint8Array }>): StagedProject {
  const FS = win.FS;
  if (FS == null) throw new Error('FS is not ready');
  if (!ID.test(id)) throw new Error('bad project id');
  const root = `${PROJECT_ROOT}/${id}`;
  FS.mkdirTree(root);
  const written: string[] = [];
  const dropped: string[] = [];
  for (const f of files) {
    const path = normalizePath(f.path);
    if (path == null) { dropped.push(f.path); continue; }
    try {
      const dir = path.includes('/') ? `${root}/${path.slice(0, path.lastIndexOf('/'))}` : root;
      FS.mkdirTree(dir);
      FS.writeFile(`${root}/${path}`, f.bytes);
    } catch {
      // A path the filesystem refuses (a file where a folder must be, or the reverse).
      dropped.push(f.path);
      continue;
    }
    if (!written.includes(path)) written.push(path);
  }
  return { root, written, dropped };
}

export async function openStaged(win: ToolWindow, staged: StagedProject, open: string, log: (m: string) => void): Promise<'programmatic' | 'ui' | 'failed'> {
  const path = normalizePath(open);
  if (path == null || !staged.written.includes(path)) return 'failed';
  return openFileInTool(win, `${staged.root}/${path}`, { log });
}

/**
 * The display opacities the island stages for KiCad: every item drawn opaque,
 * as the site's viewer (KiCanvas) draws them. KiCad 10 keeps them in the
 * project's local settings (`board.opacity.*` in <name>.kicad_prl,
 * common/project/project_local_settings.cpp at the pin), and its defaults draw
 * zones and images at 0.6, which over the palette's black board turns a green
 * pour olive (measured 2026-10-02).
 */
export const DISPLAY_OPACITY = Object.freeze({ images: 1, pads: 1, shapes: 1, tracks: 1, vias: 1, zones: 1 });
/**
 * The board's visible items, staged as `board.visible_items`: every one of
 * KiCad's user visibility items but `drawing_sheet`, so the board editor draws
 * no page frame (no border, margins or title block), as the site's viewer
 * draws none. KiCad shows exactly the items listed and hides every one
 * omitted, so the list is complete: it is the engine's own names, the
 * VISIBILITY_LAYER enum lowercased (include/settings/layer_settings_utils.h
 * and VisibilityLayerToString at the engine's kicad commit, PIN.json
 * engine.build), in that order; src/stage.test.ts checks it against that
 * source when the engine's clones are on disk. Without the key KiCad shows
 * all of them, the sheet included.
 */
export const VISIBLE_ITEMS: readonly string[] = Object.freeze([
  'tracks', 'vias', 'pads', 'zones', 'shapes', 'bitmaps',
  'footprints_front', 'footprints_back', 'footprint_values', 'footprint_references', 'footprint_text', 'footprint_anchors',
  'ly_points', 'ratsnest', 'drc_warnings', 'drc_errors', 'drc_exclusions',
  'locked_item_shadows', 'conflict_shadows', 'board_outline_area', 'grid',
]);
/** The one visibility item the island leaves out of VISIBLE_ITEMS. */
export const HIDDEN_ITEM = 'drawing_sheet';
/** PROJECT_LOCAL_SETTINGS's schema version at the pin (projectLocalSettingsVersion). */
const LOCAL_SETTINGS_VERSION = 5;

/**
 * Where KiCad reads the local settings of the file it opens: the project is
 * named after that file (pcbnew and eeschema load <stem>.kicad_pro beside it,
 * SETTINGS_MANAGER::LoadProject reads <stem>.kicad_prl from the same folder,
 * a .kicad_pro staged or not). Null when the path is no valid one.
 */
export function localSettingsPath(open: string): string | null {
  const path = normalizePath(open);
  if (path == null) return null;
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  if (dot <= slash + 1) return null;
  return normalizePath(`${path.slice(0, dot)}.kicad_prl`);
}

/**
 * Writes the display settings KiCad reads for `open` (DISPLAY_OPACITY and
 * VISIBLE_ITEMS, with the schema's meta block; the schematic editor reads
 * neither board key) when the host sent none of that name: the user's
 * own settings always stand. Answers the path written, or null. The file is
 * the engine's local display state, not the design: it is not added to
 * `written`, and the island never reports it as saved.
 */
export function stageLocalSettings(win: ToolWindow, staged: StagedProject, open: string): string | null {
  const FS = win.FS;
  const path = localSettingsPath(open);
  if (FS == null || path == null || staged.written.includes(path)) return null;
  const name = path.slice(path.lastIndexOf('/') + 1);
  const json = { board: { opacity: { ...DISPLAY_OPACITY }, visible_items: [...VISIBLE_ITEMS] }, meta: { filename: name, version: LOCAL_SETTINGS_VERSION } };
  try {
    const abs = `${staged.root}/${path}`;
    if (FS.analyzePath(abs).exists) return null;   // a folder of that name; never written over
    FS.writeFile(abs, enc.encode(`${JSON.stringify(json, null, 2)}\n`));
  } catch {
    return null;   // KiCad loads its defaults instead
  }
  return path;
}

/**
 * project.write's file system check (PROTOCOL.md): the first of `paths`
 * (normalized, project-relative, in request order) that cannot be a file under
 * `root`, because it names a folder (on disk, or the folder of an earlier path
 * of the list) or runs through a file (on disk, or an earlier path of the
 * list); null when every one can be written. Run before the first byte is
 * written, so a refused request writes nothing.
 */
export function fileConflict(FS: EmscriptenFS, root: string, paths: readonly string[]): string | null {
  const files = new Set<string>();
  const dirs = new Set<string>();
  const kind = (rel: string): 'dir' | 'file' | null => {
    const abs = `${root}/${rel}`;
    if (!FS.analyzePath(abs).exists) return null;
    return FS.isDir(FS.stat(abs).mode) ? 'dir' : 'file';
  };
  for (const p of paths) {
    const segments = p.split('/');
    for (let i = 1; i < segments.length; i++) {
      const dir = segments.slice(0, i).join('/');
      if (files.has(dir) || (!dirs.has(dir) && kind(dir) === 'file')) return p;
      dirs.add(dir);
    }
    if (dirs.has(p) || (!files.has(p) && kind(p) === 'dir')) return p;
    files.add(p);
  }
  return null;
}

/**
 * Writes each file at <root>/<path>, creating the folders first as
 * stageProject does and replacing a file that is there. The paths are
 * normalized and passed fileConflict; a failure the check could not foresee
 * (MEMFS out of memory) throws, the files before it written.
 */
export function writeProjectFiles(FS: EmscriptenFS, root: string, files: ReadonlyArray<{ path: string; bytes: Uint8Array }>): void {
  FS.mkdirTree(root);
  for (const f of files) {
    const slash = f.path.lastIndexOf('/');
    if (slash >= 0) FS.mkdirTree(`${root}/${f.path.slice(0, slash)}`);
    FS.writeFile(`${root}/${f.path}`, f.bytes);
  }
}
