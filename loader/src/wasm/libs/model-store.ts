// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The model store's client (LIBRARY.md "The model store"): KiCad's 3D model
 * STEP files at the engine's tag, served by the island origin at
 * `/models/<tag>/<Lib>.3dshapes/<Name>.step` with one `index.json` per folder
 * (`{ name: bytes }`), built by scripts/build-models.mjs.
 *
 * - The engine asks through `kicadLibs.request("ensure", "", <ref>, "model3d")`
 *   (PCBJAM_3D::EnsureModelFile, after KiCad's own resolver found nothing):
 *   the reference is normalized as NormalizeModelRef does, a `.wrl` line is
 *   answered by its STEP sibling, the file is written under
 *   `/pcbjam/3dmodels/<Lib>.3dshapes/` in the engine's file system and its
 *   absolute path answered. A reference the store does not hold answers null,
 *   and KiCad's own warning follows.
 * - `ensureModel(ref)` answers the bytes alone, for the export staging and the
 *   board's embedded models (3D units 3d-i3 and 3d-i4), with nothing written.
 * - IndexedDB first: database `cc-models`, store `files`, key `<tag>/<path>`
 *   (a folder's index under `<tag>/<folder>/index.json`); a later session reads
 *   every file it has seen with no network. Keys of another tag are deleted on
 *   the first open. With no IndexedDB the store reads the network each time
 *   (the files are immutable, so the browser's cache still answers).
 * - Every file is checked against its folder's index before it is kept or
 *   given: a size that differs is a miss, never stored.
 * - Nothing here rejects: any failure is a miss, logged once per reference.
 */

/** The engine's model root (pcbjam_model_fetch.h `MODELS_MEMFS_ROOT`). */
export const MODELS_ROOT = "/pcbjam/3dmodels";
export const MODELS_IDB_NAME = "cc-models";
export const MODELS_IDB_STORE = "files";
const IDB_VERSION = 1;
const IDB_OPEN_TIMEOUT_MS = 5000;

/** The store's tag directory on the island origin. */
export function modelsBase(tag: string): string {
  return `/models/${encodeURIComponent(tag)}/`;
}

/** One store path: a `<Lib>.3dshapes` folder and one STEP file in it. */
const STEP_RE = /^([^/\\\u0000-\u001f]+)\.3dshapes\/([^/\\\u0000-\u001f]+)\.(step|stp)$/i;

/**
 * A footprint's model line in the store's relative form, as KiCad's
 * PCBJAM_3D::NormalizeModelRef reads it: `${KICAD*_3DMODEL_DIR}/<lib>.3dshapes/
 * <name>.<ext>` (any vintage, brace or paren, and the old KISYS3DMOD) becomes
 * `<lib>.3dshapes/<name>.<ext>`; a bare relative line passes; an absolute
 * path, `${KIPRJMOD}` or a URI is not the store's (null). The build's twin is
 * normalizeModelRef in scripts/build-models.mjs.
 */
export function normalizeModelRef(raw: string): string | null {
  let ref = raw.trim();
  if (!ref) return null;
  if (ref.startsWith("${") || ref.startsWith("$(")) {
    const end = ref.indexOf(ref[1] === "{" ? "}" : ")");
    if (end < 0) return null;
    const v = ref.slice(2, end);
    if (!v.includes("3DMODEL_DIR") && v !== "KISYS3DMOD") return null;
    ref = ref.slice(end + 1).replace(/^[/\\]+/, "");
    return ref || null;
  }
  if (ref.startsWith("/") || ref.includes("://")) return null;
  return ref;
}

/** The store paths that answer a relative model line, in order: a STEP line itself, a `.wrl` or `.wrz` line its STEP siblings; nothing else is the store's. */
export function storeCandidates(rel: string | null): string[] {
  if (rel == null || rel.split(/[/\\]/).includes("..")) return [];
  const m = /^(.*)\.([A-Za-z0-9]+)$/.exec(rel);
  if (m == null) return [];
  const ext = m[2]!.toLowerCase();
  const out = ext === "step" || ext === "stp" ? [rel] : ext === "wrl" || ext === "wrz" ? [`${m[1]}.step`, `${m[1]}.stp`] : [];
  return out.filter((p) => STEP_RE.test(p));
}

/** Where a model's bytes are kept between sessions; best effort, never rejects. */
export interface ModelFileStore {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): Promise<boolean>;
  keys(): Promise<string[]>;
  delete(keys: string[]): Promise<void>;
}

/** A store that lives as long as the page (the tests' store). */
export function memoryModelFileStore(): ModelFileStore & { readonly map: Map<string, Uint8Array> } {
  const map = new Map<string, Uint8Array>();
  return {
    map,
    async get(key) { return map.get(key) ?? null; },
    async put(key, bytes) { map.set(key, bytes); return true; },
    async keys() { return [...map.keys()]; },
    async delete(keys) { for (const k of keys) map.delete(k); },
  };
}

function idbDone<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function idbCommitted(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
  });
}

/** IndexedDB on the island origin, or null when the browser has none, the open fails, or it takes over 5 s. */
export async function openIdbModelFileStore(
  factory: IDBFactory | undefined = typeof indexedDB === "undefined" ? undefined : indexedDB,
  timeoutMs = IDB_OPEN_TIMEOUT_MS,
): Promise<ModelFileStore | null> {
  if (!factory) return null;
  let db: IDBDatabase;
  try {
    const req = factory.open(MODELS_IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(MODELS_IDB_STORE)) req.result.createObjectStore(MODELS_IDB_STORE);
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
    const opened = await Promise.race([idbDone(req), late]).finally(() => clearTimeout(timer));
    if (opened == null) {
      req.onsuccess = () => req.result.close();
      return null;
    }
    db = opened;
  } catch {
    return null;
  }
  db.onversionchange = () => db.close();
  return {
    async get(key) {
      try {
        const v = await idbDone(db.transaction(MODELS_IDB_STORE, "readonly").objectStore(MODELS_IDB_STORE).get(key));
        return v instanceof Uint8Array ? v : null;
      } catch {
        return null;
      }
    },
    async put(key, bytes) {
      try {
        const tx = db.transaction(MODELS_IDB_STORE, "readwrite");
        tx.objectStore(MODELS_IDB_STORE).put(bytes, key);
        await idbCommitted(tx);
        return true;
      } catch {
        return false;
      }
    },
    async keys() {
      try {
        const ks = await idbDone(db.transaction(MODELS_IDB_STORE, "readonly").objectStore(MODELS_IDB_STORE).getAllKeys());
        return ks.filter((k): k is string => typeof k === "string");
      } catch {
        return [];
      }
    },
    async delete(keys) {
      if (keys.length === 0) return;
      try {
        const tx = db.transaction(MODELS_IDB_STORE, "readwrite");
        const os = tx.objectStore(MODELS_IDB_STORE);
        for (const k of keys) os.delete(k);
        await idbCommitted(tx);
      } catch {
        // left for the next session's first open
      }
    },
  };
}

/** A model the store answered: the store path that served it (its real extension) and its bytes. */
export interface ModelBytes {
  path: string;
  bytes: Uint8Array;
}

export interface ModelStore {
  /** The bytes of the file that answers a model line, or null when the store has none. Never writes the engine's files. */
  ensureModel(ref: string): Promise<ModelBytes | null>;
  /** The model written under MODELS_ROOT in the engine's file system: its absolute path, or null. */
  ensureModelFile(ref: string): Promise<string | null>;
}

type ModelFS = Pick<EmscriptenFS, "mkdirTree" | "writeFile" | "analyzePath">;

export interface ModelStoreOptions {
  tag: string;
  /** The tag directory (default `modelsBase(tag)`). */
  base?: string;
  fetchImpl?: typeof fetch;
  /** The durable store (default IndexedDB; a null answer means none). */
  storeFactory?: () => Promise<ModelFileStore | null>;
  /** The engine's file system (default `window.FS`). */
  fs?: () => ModelFS | null;
  log?: (msg: string) => void;
}

type Index = Record<string, number>;

/** An index as the build writes it: names to non-negative integer sizes, nothing else. */
function readIndex(text: string): Index | null {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (v == null || typeof v !== "object" || Array.isArray(v)) return null;
  for (const n of Object.values(v as Record<string, unknown>)) if (typeof n !== "number" || !Number.isInteger(n) || n < 0) return null;
  return v as Index;
}

const folderOf = (path: string): string => path.slice(0, path.indexOf("/"));
const urlOf = (base: string, path: string): string => `${base}${path.split("/").map(encodeURIComponent).join("/")}`;

export function createModelStore(opts: ModelStoreOptions): ModelStore {
  const { tag } = opts;
  const base = opts.base ?? modelsBase(tag);
  const fetchImpl = opts.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const log = opts.log ?? (() => {});
  const fsOf = opts.fs ?? (() => {
    const fs = typeof window === "undefined" ? undefined : (window as ToolWindow).FS;
    return fs && typeof fs.writeFile === "function" ? fs : null;
  });

  let storeP: Promise<ModelFileStore | null> | null = null;
  const store = (): Promise<ModelFileStore | null> => {
    if (storeP == null) {
      storeP = (async () => {
        const s = await (opts.storeFactory ?? (() => openIdbModelFileStore()))().catch(() => null);
        if (s != null) {
          const stale = (await s.keys().catch(() => [] as string[])).filter((k) => !k.startsWith(`${tag}/`));
          if (stale.length > 0) await s.delete(stale).catch(() => undefined);
        }
        return s;
      })();
    }
    return storeP;
  };

  // A folder's index: kept for the session once read, a 404 too (the store has no such folder at this tag).
  const indexes = new Map<string, Promise<Index | null>>();
  const indexOf = (folder: string): Promise<Index | null> => {
    let p = indexes.get(folder);
    if (p == null) {
      p = (async (): Promise<Index | null> => {
        const s = await store();
        const key = `${tag}/${folder}/index.json`;
        const kept = await s?.get(key);
        if (kept != null) {
          const idx = readIndex(new TextDecoder().decode(kept));
          if (idx != null) return idx;
          await s?.delete([key]);
        }
        const r = await fetchImpl(urlOf(base, `${folder}/index.json`));
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(`${folder} index: HTTP ${r.status}`);
        const bytes = new Uint8Array(await r.arrayBuffer());
        const idx = readIndex(new TextDecoder().decode(bytes));
        if (idx == null) throw new Error(`${folder} index is not an index`);
        await s?.put(key, bytes);
        return idx;
      })();
      p.catch(() => indexes.delete(folder));
      indexes.set(folder, p);
    }
    return p;
  };

  const loading = new Map<string, Promise<ModelBytes | null>>();
  const failedOnce = new Set<string>();

  const load = async (rel: string): Promise<ModelBytes | null> => {
    const candidates = storeCandidates(rel);
    if (candidates.length === 0) return null;
    const s = await store();
    for (const path of candidates) {
      const kept = await s?.get(`${tag}/${path}`);
      if (kept != null) return { path, bytes: kept };
    }
    const idx = await indexOf(folderOf(candidates[0]!));
    if (idx == null) return null;
    const path = candidates.find((c) => idx[c.slice(c.indexOf("/") + 1)] !== undefined);
    if (path == null) return null;
    const r = await fetchImpl(urlOf(base, path));
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    const want = idx[path.slice(path.indexOf("/") + 1)];
    if (bytes.length !== want) throw new Error(`${path}: ${bytes.length} bytes, the index says ${want}`);
    await s?.put(`${tag}/${path}`, bytes);
    log(`[3d] fetched ${path} (${bytes.length} bytes)`);
    return { path, bytes };
  };

  const ensureModel = (ref: string): Promise<ModelBytes | null> => {
    const rel = normalizeModelRef(ref);
    if (rel == null) return Promise.resolve(null);
    let p = loading.get(rel);
    if (p == null) {
      p = load(rel)
        .catch((e: unknown) => {
          if (!failedOnce.has(rel)) {
            failedOnce.add(rel);
            log(`[3d] the model store could not answer ${rel}: ${e instanceof Error ? e.message : String(e)}`);
          }
          return null;
        })
        .finally(() => loading.delete(rel));
      loading.set(rel, p);
    }
    return p;
  };

  const written = new Map<string, string>();
  const ensureModelFile = async (ref: string): Promise<string | null> => {
    const rel = normalizeModelRef(ref);
    if (rel == null) return null;
    const known = written.get(rel);
    if (known != null) return known;
    const fs = fsOf();
    if (fs == null) return null;
    const got = await ensureModel(rel);
    if (got == null) return null;
    const target = `${MODELS_ROOT}/${got.path}`;
    try {
      if (!fs.analyzePath(target).exists) {
        fs.mkdirTree(target.slice(0, target.lastIndexOf("/")));
        fs.writeFile(target, got.bytes);
      }
    } catch (e) {
      log(`[3d] could not write ${target}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
    written.set(rel, target);
    return target;
  };

  return { ensureModel, ensureModelFile };
}

declare const __LIBS_TAG__: string;

let island: ModelStore | null = null;
let islandLog: (msg: string) => void = () => {};

/**
 * The island's one model store, at `PIN.json` `libs.tag` (the engine's KiCad
 * version, the same tag as the library mirror), made on first use. Null where
 * the tag is not defined (a test without the build's defines).
 */
export function islandModelStore(log?: (msg: string) => void): ModelStore | null {
  if (log != null) islandLog = log;
  if (island == null) {
    const tag = typeof __LIBS_TAG__ === "string" ? __LIBS_TAG__ : null;
    if (tag == null) return null;
    island = createModelStore({ tag, log: (m) => islandLog(m) });
  }
  return island;
}

/** The bytes of the store file that answers a model line (3d-i3's export staging, 3d-i4's embedding), or null. */
export function ensureModel(ref: string): Promise<ModelBytes | null> {
  return islandModelStore()?.ensureModel(ref) ?? Promise.resolve(null);
}

/**
 * The provider's answer to the engine's `model3d` requests (installLibsProvider
 * in source.ts): op `ensure` writes the model into the engine's file system and
 * answers its absolute path; every other op, and a miss, answers null.
 */
export async function handleModel3dRequest(
  op: string,
  arg: string,
  log: (msg: string) => void,
  store: ModelStore | null = islandModelStore(log),
): Promise<string | null> {
  if (op !== "ensure" || store == null) return null;
  try {
    return await store.ensureModelFile(arg);
  } catch (e) {
    log(`[3d] ensure failed for ${arg}: ${String(e)}`);
    return null;
  }
}
