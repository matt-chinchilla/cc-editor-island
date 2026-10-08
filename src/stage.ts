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
 * Writes the display settings KiCad reads for `open` (DISPLAY_OPACITY, with
 * the schema's meta block) when the host sent none of that name: the user's
 * own settings always stand. Answers the path written, or null. The file is
 * the engine's local display state, not the design: it is not added to
 * `written`, and the island never reports it as saved.
 */
export function stageLocalSettings(win: ToolWindow, staged: StagedProject, open: string): string | null {
  const FS = win.FS;
  const path = localSettingsPath(open);
  if (FS == null || path == null || staged.written.includes(path)) return null;
  const name = path.slice(path.lastIndexOf('/') + 1);
  const json = { board: { opacity: { ...DISPLAY_OPACITY } }, meta: { filename: name, version: LOCAL_SETTINGS_VERSION } };
  try {
    const abs = `${staged.root}/${path}`;
    if (FS.analyzePath(abs).exists) return null;   // a folder of that name; never written over
    FS.writeFile(abs, enc.encode(`${JSON.stringify(json, null, 2)}\n`));
  } catch {
    return null;   // KiCad loads its defaults instead
  }
  return path;
}
