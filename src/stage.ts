// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The handoff lands here: every path is normalised again on this side, and
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
