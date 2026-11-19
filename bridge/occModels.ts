// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The 3D models a board's 3D outputs read (3D exports spec 8.2), staged in the
// engine's file system before project.export runs pcb_export_3d or pcb_render.
// KiCad's resolver in our engine (PCBJAM_3D::FindStagedModel) reads every body
// under MODELS_ROOT: a library line at <Lib>.3dshapes/<Name>, as the model
// store writes it, and a project line (${KIPRJMOD}/x, $(KIPRJMOD)/x or a bare
// relative path) at kiprjmod/<relative path> (engine run 15, K-3D1). An
// embedded line (kicad-embed://) needs nothing; an absolute path, another
// variable or a path leaving the project resolves to nothing, and KiCad's own
// warning names it in the run's notes. The pure parts are read alone by the
// tests; stageModels is the one that writes.
import { readSexpr, type SNode } from '../src/sexpr';

/** The engine's model root (PCBJAM_3D::MODELS_MEMFS_ROOT). */
export const MODELS_ROOT = '/pcbjam/3dmodels';
/** Where a project line's file is staged (K-3D1). */
export const PROJECT_MODELS = `${MODELS_ROOT}/kiprjmod`;
/** At most this many files and this many bytes staged for one run; past them the rest are skipped. */
export const MAX_STAGED_FILES = 2000;
export const MAX_STAGED_BYTES = 512 * 1024 * 1024;
/** A model line's path past this length is not read (models.ts MAX_MODEL_PATH). */
const MAX_REF = 1024;

/** One model line, by where its body comes from. */
export type ModelSource =
  | { kind: 'library'; ref: string; rel: string }
  | { kind: 'project'; ref: string; rel: string }
  | { kind: 'embedded'; ref: string }
  | { kind: 'none'; ref: string };

/** The index past the list that opens at `start` (a '('), strings and their escapes skipped; -1 when it never closes. */
function listEnd(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i + 1;
  }
  return -1;
}

/** Whether a model list is hidden: KiCad 8 and later `(hide yes)`, earlier a bare `hide`. */
function hidden(model: SNode[]): boolean {
  return model.slice(2).some((n) => n === 'hide' || (Array.isArray(n) && n[0] === 'hide' && n[1] === 'yes'));
}

/**
 * Every shown model line of a board's text (or a footprint's), in order, as
 * its path; a line hidden in KiCad's 3D view is left out (KiCad's exporters
 * leave it out too). Each `(model ...)` list is cut out of the text and read
 * alone, so a large board is never read whole as a tree.
 */
export function boardModelRefs(text: string): string[] {
  const out: string[] = [];
  const re = /\(model[\s"]/g;
  for (let m = re.exec(text); m != null; m = re.exec(text)) {
    const end = listEnd(text, m.index);
    if (end < 0) break;
    const model = readSexpr(text.slice(m.index, end));
    re.lastIndex = end;
    if (model == null || model[0] !== 'model' || typeof model[1] !== 'string') continue;
    const ref = model[1].trim();
    if (ref === '' || ref.length > MAX_REF || hidden(model)) continue;
    out.push(ref);
  }
  return out;
}

/** A project relative path with `.` and `..` resolved and `\` read as `/`; null when it leaves the project or names nothing. */
export function projectRelative(path: string): string | null {
  const parts: string[] = [];
  for (const p of path.replace(/\\/g, '/').split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') { if (parts.length === 0) return null; parts.pop(); continue; }
    parts.push(p);
  }
  return parts.length === 0 ? null : parts.join('/');
}

/**
 * Where a model line's body comes from: a ${KICAD*_3DMODEL_DIR} line (any
 * vintage, brace or parenthesis, and the legacy KISYS3DMOD) is the model
 * store's (`rel` as NormalizeModelRef reads it); a ${KIPRJMOD} or bare
 * relative line is the project's (`rel` inside the project, or none when it
 * leaves it); kicad-embed:// is embedded; anything else resolves to nothing.
 */
export function modelSource(ref: string): ModelSource {
  const r = ref.trim();
  if (r.startsWith('kicad-embed://')) return { kind: 'embedded', ref };
  const v = /^\$([{(])([A-Za-z0-9_]+)([})])(.*)$/s.exec(r);
  if (v != null) {
    if ((v[1] === '{') !== (v[3] === '}')) return { kind: 'none', ref };
    const name = v[2];
    const rest = v[4];
    if (name.includes('3DMODEL_DIR') || name === 'KISYS3DMOD') {
      const rel = rest.replace(/^[/\\]+/, '');
      return rel === '' ? { kind: 'none', ref } : { kind: 'library', ref, rel };
    }
    if (name === 'KIPRJMOD') {
      const rel = projectRelative(rest);
      return rel == null ? { kind: 'none', ref } : { kind: 'project', ref, rel };
    }
    return { kind: 'none', ref };
  }
  if (r.startsWith('/') || r.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(r) || r.includes('://') || r.startsWith('$')) return { kind: 'none', ref };
  const rel = projectRelative(r);
  return rel == null ? { kind: 'none', ref } : { kind: 'project', ref, rel };
}

/**
 * A model store's ensure as stageModels reads it: the body's absolute path in
 * the engine's file system, or null. The store may answer that path itself
 * (it wrote the body under MODELS_ROOT), or the store file's path relative to
 * MODELS_ROOT with its bytes (`{ path, bytes }`, written here at
 * MODELS_ROOT/<path> when not there yet). Any other answer, a path outside
 * MODELS_ROOT or one with a `..` part, and a throw read as null.
 */
export function ensureWriting(ensure: (ref: string) => Promise<unknown>, fs: EmscriptenFS): (ref: string) => Promise<string | null> {
  return async (ref) => {
    let got: unknown;
    try { got = await ensure(ref); } catch { return null; }
    if (typeof got === 'string') {
      const rel = got.startsWith(`${MODELS_ROOT}/`) ? projectRelative(got.slice(MODELS_ROOT.length + 1)) : null;
      return rel != null && `${MODELS_ROOT}/${rel}` === got ? got : null;
    }
    if (got == null || typeof got !== 'object') return null;
    const { path, bytes } = got as { path?: unknown; bytes?: unknown };
    if (typeof path !== 'string' || !(bytes instanceof Uint8Array)) return null;
    const rel = projectRelative(path);
    if (rel == null || rel !== path) return null;
    const at = `${MODELS_ROOT}/${rel}`;
    try {
      if (!fs.analyzePath(at).exists) {
        fs.mkdirTree(dirOf(at));
        fs.writeFile(at, bytes);
      }
    } catch {
      return null;
    }
    return at;
  };
}

/** What a staging did: the files written (absolute), the lines past the bounds, the lines whose body was not found, the bytes written. */
export interface StageReport { staged: string[]; skipped: string[]; missing: string[]; bytes: number }

export interface StageDeps {
  /** The engine's file system. */
  fs: EmscriptenFS;
  /** The project folder: a project line's file is read under it. */
  projectDir: string;
  /** The model store's ensure (3d-i2): a library line's absolute path once written, null for a name it does not hold. Absent: library lines are left to the engine's own fetch. */
  ensure: ((ref: string) => Promise<string | null>) | null;
  /** After each body, with the count done and the count to do. */
  onFile?: (done: number, total: number) => void;
  /** The bounds (a test lowers them). */
  limits?: { files: number; bytes: number };
}

/** A file of `fs` as bytes, null when absent or a folder. */
function readFileBytes(fs: EmscriptenFS, abs: string): Uint8Array | null {
  try {
    if (!fs.analyzePath(abs).exists || fs.isDir(fs.stat(abs).mode)) return null;
    const b = fs.readFile(abs, { encoding: 'binary' });
    return b instanceof Uint8Array ? b : null;
  } catch {
    return null;
  }
}

/** A staged file's size: its bytes' length, 0 when it cannot be read. */
function sizeOf(fs: EmscriptenFS, abs: string): number {
  return readFileBytes(fs, abs)?.byteLength ?? 0;
}

const dirOf = (abs: string): string => abs.slice(0, abs.lastIndexOf('/')) || '/';

/**
 * Stages the bodies `refs` name, each distinct body once: a project line's
 * file copied from the project folder to kiprjmod/<relative path>, a library
 * line through the model store's ensure. Past MAX_STAGED_FILES files or
 * MAX_STAGED_BYTES bytes the rest are skipped (named in `skipped`). Never
 * throws for a body: a line whose body is not found is named in `missing`.
 */
export async function stageModels(refs: readonly string[], deps: StageDeps): Promise<StageReport> {
  const limits = deps.limits ?? { files: MAX_STAGED_FILES, bytes: MAX_STAGED_BYTES };
  const seen = new Set<string>();
  const todo: ModelSource[] = [];
  for (const ref of refs) {
    const s = modelSource(ref);
    if (s.kind === 'embedded' || s.kind === 'none') continue;
    if (s.kind === 'library' && deps.ensure == null) continue;
    const key = `${s.kind}:${s.rel}`;
    if (seen.has(key)) continue;
    seen.add(key);
    todo.push(s);
  }
  const report: StageReport = { staged: [], skipped: [], missing: [], bytes: 0 };
  const projectDir = deps.projectDir.replace(/\/+$/, '');
  for (let i = 0; i < todo.length; i++) {
    const s = todo[i] as Extract<ModelSource, { rel: string }>;
    if (report.staged.length >= limits.files || report.bytes >= limits.bytes) {
      report.skipped.push(...todo.slice(i).map((t) => t.ref));
      break;
    }
    if (s.kind === 'project') {
      const bytes = readFileBytes(deps.fs, `${projectDir}/${s.rel}`);
      if (bytes == null) {
        report.missing.push(s.ref);
      } else if (report.bytes + bytes.byteLength > limits.bytes) {
        report.skipped.push(...todo.slice(i).map((t) => t.ref));
        break;
      } else {
        const to = `${PROJECT_MODELS}/${s.rel}`;
        deps.fs.mkdirTree(dirOf(to));
        deps.fs.writeFile(to, bytes);
        report.staged.push(to);
        report.bytes += bytes.byteLength;
      }
    } else {
      let at: string | null = null;
      try { at = await (deps.ensure as (ref: string) => Promise<string | null>)(s.ref); } catch { at = null; }
      if (at == null) {
        report.missing.push(s.ref);
      } else {
        report.staged.push(at);
        report.bytes += sizeOf(deps.fs, at);
      }
    }
    deps.onFile?.(i + 1, todo.length);
  }
  return report;
}

/**
 * A staged file's path as the 3D service reads it: relative to MODELS_ROOT
 * (`kiprjmod/<relative path>`, `<Lib>.3dshapes/<Name>.<ext>`), null for a
 * path outside it. The service has a file system of its own: its
 * stageModelFiles writes each body under its own MODELS_MEMFS_ROOT and skips
 * any path that starts with a slash or holds `..` (engine run 15, fix note
 * e10-2: absolute paths put no body into the file).
 */
export function serviceModelPath(abs: string): string | null {
  if (!abs.startsWith(`${MODELS_ROOT}/`)) return null;
  const rel = projectRelative(abs.slice(MODELS_ROOT.length + 1));
  return rel != null && `${MODELS_ROOT}/${rel}` === abs ? rel : null;
}

/**
 * The bodies a 3D export carries to the 3D service (occExport's `models`):
 * each staged file as `{ path, bytes }` read back from the engine's file
 * system, its path relative to the model root (serviceModelPath), the one the
 * service stages and its resolver reads. A staged path outside the root is
 * left out.
 */
export function stagedModels(report: StageReport, fs: EmscriptenFS): Array<{ path: string; bytes: Uint8Array }> {
  const out: Array<{ path: string; bytes: Uint8Array }> = [];
  for (const abs of report.staged) {
    const path = serviceModelPath(abs);
    if (path == null) continue;
    const bytes = readFileBytes(fs, abs);
    if (bytes != null) out.push({ path, bytes });
  }
  return out;
}

/**
 * The staging of one board's text for the 3D service's export request (the
 * board text the engine's STEP stub sends): its model lines staged, then the
 * bodies read back.
 */
export async function stageBoardModels(board: string, deps: StageDeps): Promise<{ models: Array<{ path: string; bytes: Uint8Array }>; report: StageReport }> {
  const report = await stageModels(boardModelRefs(board), deps);
  return { models: stagedModels(report, deps.fs), report };
}

// The 3D service's loading (3d-i1): the service hands its wasm's progress to
// noteOccLoading, and project.export's progress reads it as ev.export's
// loading phase.
let occLoading: { loaded: number; total: number } | null = null;

/** The 3D service's files: `loaded` of `total` bytes so far; once loaded (loaded >= total), nothing is loading. */
export function noteOccLoading(loaded: number, total: number): void {
  occLoading = Number.isFinite(loaded) && Number.isFinite(total) && total > 0 && loaded < total ? { loaded: Math.max(0, loaded), total } : null;
}

/** The 3D service's loading as a whole percent, null while nothing is loading. */
export function occLoadingPercent(): number | null {
  return occLoading == null ? null : Math.max(0, Math.min(100, Math.floor((occLoading.loaded / occLoading.total) * 100)));
}
