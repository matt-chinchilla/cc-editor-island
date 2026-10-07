// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { asyncMap } from "../../lib/async-map";
import { openIdbBundleStore, type BundleStore } from "./bundle-store";
import type { LibInfo, LibItemInfo, LibPresyncProgress, LibsSource, LibsSyncState } from "./source";

/**
 * A read-only `LibsSource` over KiCad's library mirror on the island origin
 * (LIBRARY.md): `/libs/<tag>/manifest.json`, `fp-index.json` and one bundle
 * per library, `<id>.bin` in format `ccl1`.
 *
 * - The manifest is read once per session, retried with backoff; a failure is
 *   never kept, so the next call reads it again.
 * - A bundle is fetched at most once: concurrent asks share one fetch, the
 *   header is checked strictly before anything is kept, and the bytes go to
 *   IndexedDB (`bundle-store.ts`), from where every later session reads them
 *   with no network. Keys of any other tag are deleted on the first open.
 * - With no IndexedDB (or one that throws) the bundles stay in memory for the
 *   session; that is never a failure.
 * - Bodies are handed over as views onto the one buffer of their bundle: the
 *   provider frames raw bytes, so nothing is copied or decoded on the bulk
 *   path. Only `getItemBody` decodes, one slice.
 */

export interface MirrorLibEntry {
  id: string;
  name: string;
  kind: "symbol" | "footprint";
  itemCount?: number;
  /** The bundle's stored (gzipped) size. */
  bytes?: number;
  description?: string | null;
}

export interface MirrorManifest {
  schema: 1;
  tag: string;
  libs: MirrorLibEntry[];
}

/** A bundle whose header passed every check: names and byte ranges over `bytes`. */
export interface ParsedBundle {
  id: string;
  kind: "symbol" | "footprint";
  names: string[];
  offsets: number[];
  lengths: number[];
  /** Name to position in `names`. */
  index: Map<string, number>;
  bytes: Uint8Array;
}

export interface MirrorSourceOptions {
  /** The tag directory, ending with a slash: `/libs/<tag>/`. */
  base: string;
  /** The tag the manifest must carry; also the store's key prefix. */
  tag: string;
  /** Test seam: the network. */
  fetchImpl?: typeof fetch;
  /** Test seam: the durable store (default IndexedDB; null means memory only). */
  storeFactory?: () => Promise<BundleStore | null>;
  log?: (msg: string) => void;
  /** Waits before the manifest's second, third and fourth attempts. */
  retryDelaysMs?: readonly number[];
  /** How long one manifest attempt may take. */
  manifestTimeoutMs?: number;
  /** Bytes of checked bundles kept in memory between reads (the newest one is always kept). */
  memoryBytes?: number;
}

const MANIFEST_RETRY_MS = [250, 750, 2000] as const;
const MANIFEST_TIMEOUT_MS = 10_000;
/** The symbol plugin asks for a library's names and then its bodies back to back; this keeps both reads off IndexedDB. */
const MEMORY_BYTES = 48 * 1024 * 1024;
const PREFIX: Record<MirrorLibEntry["kind"], string> = { symbol: "sym.", footprint: "fp." };

/** A failure no retry can mend (a 404, a manifest of another schema or tag). */
class Definitive extends Error {}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The manifest's shape, checked; entries that do not fit are dropped and counted. */
export function checkManifest(raw: unknown, tag: string): { manifest: MirrorManifest; dropped: number } {
  if (!isRecord(raw) || raw.schema !== 1) throw new Definitive("manifest: not schema 1");
  if (raw.tag !== tag) throw new Definitive(`manifest: tag ${JSON.stringify(raw.tag)}, expected ${JSON.stringify(tag)}`);
  if (!Array.isArray(raw.libs)) throw new Definitive("manifest: no libs");
  const libs: MirrorLibEntry[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const l of raw.libs) {
    const ok =
      isRecord(l) &&
      typeof l.id === "string" &&
      typeof l.name === "string" &&
      l.name !== "" &&
      (l.kind === "symbol" || l.kind === "footprint") &&
      l.id.startsWith(PREFIX[l.kind]) &&
      l.id.length > PREFIX[l.kind].length &&
      !seen.has(l.id) &&
      (l.itemCount === undefined || (Number.isSafeInteger(l.itemCount) && (l.itemCount as number) >= 0)) &&
      (l.bytes === undefined || (Number.isSafeInteger(l.bytes) && (l.bytes as number) >= 0)) &&
      (l.description === undefined || l.description === null || typeof l.description === "string");
    if (!ok) {
      dropped++;
      continue;
    }
    seen.add(l.id as string);
    libs.push({
      id: l.id as string,
      name: l.name as string,
      kind: l.kind as MirrorLibEntry["kind"],
      itemCount: l.itemCount as number | undefined,
      bytes: l.bytes as number | undefined,
      description: (l.description as string | null | undefined) ?? null,
    });
  }
  return { manifest: { schema: 1, tag, libs }, dropped };
}

/**
 * Reads a `ccl1` bundle: one line of JSON `{"v":1,"id","kind","items":[[name,
 * byteLength],...]}`, a newline, then the bodies concatenated in `items` order.
 * Throws unless v is 1, the id and kind are the ones asked for, every item is a
 * non-empty unique name with a non-negative integer length, and the lengths sum
 * to exactly the bytes after the header line.
 */
export function parseBundle(bytes: Uint8Array, id: string, kind: MirrorLibEntry["kind"]): ParsedBundle {
  const nl = bytes.indexOf(0x0a);
  if (nl < 0) throw new Error(`bundle ${id}: no header line`);
  let header: unknown;
  try {
    header = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, nl)));
  } catch {
    throw new Error(`bundle ${id}: the header is not JSON`);
  }
  if (!isRecord(header) || header.v !== 1) throw new Error(`bundle ${id}: not version 1`);
  if (header.id !== id) throw new Error(`bundle ${id}: the header names ${JSON.stringify(header.id)}`);
  if (header.kind !== kind) throw new Error(`bundle ${id}: kind ${JSON.stringify(header.kind)}, expected ${kind}`);
  if (!Array.isArray(header.items)) throw new Error(`bundle ${id}: no items`);
  const n = header.items.length;
  const names: string[] = new Array(n);
  const offsets: number[] = new Array(n);
  const lengths: number[] = new Array(n);
  const index = new Map<string, number>();
  let off = nl + 1;
  for (let i = 0; i < n; i++) {
    const it: unknown = header.items[i];
    if (!Array.isArray(it) || it.length !== 2) throw new Error(`bundle ${id}: item ${i} is not [name, length]`);
    const [name, len] = it as [unknown, unknown];
    if (typeof name !== "string" || name === "") throw new Error(`bundle ${id}: item ${i} has no name`);
    if (typeof len !== "number" || !Number.isSafeInteger(len) || len < 0) throw new Error(`bundle ${id}: item ${name} has a bad length`);
    if (index.has(name)) throw new Error(`bundle ${id}: ${name} appears twice`);
    index.set(name, i);
    names[i] = name;
    offsets[i] = off;
    lengths[i] = len;
    off += len;
    if (off > bytes.length) throw new Error(`bundle ${id}: the lengths run past the end`);
  }
  if (off !== bytes.length) throw new Error(`bundle ${id}: the lengths sum to ${off - nl - 1} bytes, the bundle carries ${bytes.length - nl - 1}`);
  return { id, kind, names, offsets, lengths, index, bytes };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The source plus `ready()`, which boot uses to choose between the mirror and the fallback. */
export interface MirrorLibsSource extends LibsSource {
  /** Resolves once the manifest is read; rejects when it cannot be (after its retries). */
  ready(): Promise<void>;
}

export function mirrorLibsSource(opts: MirrorSourceOptions): MirrorLibsSource {
  const { base, tag } = opts;
  const fetchImpl = opts.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const log = opts.log ?? (() => undefined);
  const delays = opts.retryDelaysMs ?? MANIFEST_RETRY_MS;
  const timeoutMs = opts.manifestTimeoutMs ?? MANIFEST_TIMEOUT_MS;
  const memoryCap = opts.memoryBytes ?? MEMORY_BYTES;
  const keyOf = (id: string) => `${tag}/${id}`;

  // ---- the manifest: once per session, a rejection never kept
  type Loaded = MirrorManifest & { byId: Map<string, MirrorLibEntry> };
  let manifestP: Promise<Loaded> | null = null;
  const fetchManifest = async (): Promise<Loaded> => {
    const url = `${base}manifest.json`;
    for (let attempt = 0; ; attempt++) {
      if (attempt > 0) await sleep(delays[attempt - 1]);
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const r = await fetchImpl(url, { cache: "no-cache", signal: ctl.signal });
        if (r.status === 404) throw new Definitive(`manifest: 404 at ${url}`);
        if (!r.ok) throw new Error(`manifest: HTTP ${r.status} at ${url}`);
        const { manifest, dropped } = checkManifest(await r.json(), tag);
        if (dropped > 0) log(`[libs] mirror manifest: ${dropped} entr${dropped === 1 ? "y" : "ies"} malformed and skipped`);
        log(`[libs] mirror ${tag}: ${manifest.libs.length} libraries`);
        return { ...manifest, byId: new Map(manifest.libs.map((l) => [l.id, l])) };
      } catch (e) {
        if (e instanceof Definitive || attempt >= delays.length) throw e;
      } finally {
        clearTimeout(timer);
      }
    }
  };
  const loadManifest = (): Promise<Loaded> => {
    if (!manifestP) {
      manifestP = fetchManifest().catch((e: unknown) => {
        manifestP = null;
        throw e;
      });
    }
    return manifestP;
  };

  // ---- the store: IndexedDB when it opens, the page's memory for whatever it cannot hold
  interface Tiered {
    get(key: string): Promise<Uint8Array | null>;
    put(key: string, bytes: Uint8Array): Promise<void>;
    delete(key: string): Promise<void>;
    keySet(): Promise<Set<string>>;
  }
  let storeP: Promise<Tiered> | null = null;
  const store = (): Promise<Tiered> => {
    storeP ??= (async () => {
      let durable: BundleStore | null = null;
      try {
        durable = await (opts.storeFactory ?? (() => openIdbBundleStore()))();
      } catch {
        durable = null;
      }
      const memory = new Map<string, Uint8Array>();
      const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
        try {
          return await fn();
        } catch {
          return fallback;
        }
      };
      if (durable) {
        // A tag bump must not grow storage forever: everything not of this tag goes.
        const d = durable;
        const stale = (await safe(() => d.keys(), [] as string[])).filter((k) => !k.startsWith(`${tag}/`));
        if (stale.length > 0) {
          await safe(() => d.delete(stale), undefined);
          log(`[libs] removed ${stale.length} stored bundle(s) of other tags`);
        }
      } else {
        log("[libs] no IndexedDB: library bundles are kept in memory for this session");
      }
      return {
        async get(key) {
          const m = memory.get(key);
          if (m) return m;
          return durable ? safe(() => durable!.get(key), null) : null;
        },
        async put(key, bytes) {
          const kept = durable ? await safe(() => durable!.put(key, bytes), false) : false;
          // Not stored durably (no IndexedDB, quota, an error): memory keeps it, so it is never fetched twice.
          if (!kept) memory.set(key, bytes);
        },
        async delete(key) {
          memory.delete(key);
          if (durable) await safe(() => durable!.delete([key]), undefined);
        },
        async keySet() {
          const ks = new Set(memory.keys());
          if (durable) for (const k of await safe(() => durable!.keys(), [] as string[])) ks.add(k);
          return ks;
        },
      };
    })();
    return storeP;
  };

  // ---- checked bundles: a small memory window, and one load in flight per id
  const recent = new Map<string, ParsedBundle>();
  let recentBytes = 0;
  const remember = (b: ParsedBundle): void => {
    const old = recent.get(b.id);
    if (old) recentBytes -= old.bytes.length;
    recent.delete(b.id);
    recent.set(b.id, b);
    recentBytes += b.bytes.length;
    for (const [id, x] of recent) {
      if (recentBytes <= memoryCap || recent.size <= 1) break;
      recent.delete(id);
      recentBytes -= x.bytes.length;
    }
  };
  const loading = new Map<string, Promise<ParsedBundle | null>>();

  const fetchBundle = async (id: string): Promise<Uint8Array> => {
    const r = await fetchImpl(`${base}${encodeURIComponent(id)}.bin`);
    if (!r.ok) throw new Error(`bundle ${id}: HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  };

  /** The checked bundle, or null when the mirror has no such library. Rejects when it cannot be read now. */
  const bundle = (id: string): Promise<ParsedBundle | null> => {
    const hit = recent.get(id);
    if (hit) {
      remember(hit);
      return Promise.resolve(hit);
    }
    const inFlight = loading.get(id);
    if (inFlight) return inFlight;
    const p = (async (): Promise<ParsedBundle | null> => {
      const entry = (await loadManifest()).byId.get(id);
      if (!entry) return null;
      const st = await store();
      const key = keyOf(id);
      const kept = await st.get(key);
      if (kept) {
        try {
          const b = parseBundle(kept, id, entry.kind);
          remember(b);
          return b;
        } catch (e) {
          log(`[libs] stored ${id} fails its check, fetching it again: ${String(e)}`);
          await st.delete(key);
        }
      }
      const bytes = await fetchBundle(id);
      const b = parseBundle(bytes, id, entry.kind); // throws: nothing is kept
      await st.put(key, bytes);
      remember(b);
      return b;
    })().finally(() => loading.delete(id));
    loading.set(id, p);
    return p;
  };

  let fpIndexP: Promise<string | null> | null = null;
  const decoder = new TextDecoder();

  return {
    async ready() {
      await loadManifest();
    },
    async listLibs(kind?: string): Promise<LibInfo[]> {
      const m = await loadManifest();
      return m.libs
        .filter((l) => !kind || l.kind === kind)
        .map((l) => ({
          id: l.id,
          name: l.name,
          description: l.description ?? null,
          type: "origin",
          ...(l.itemCount !== undefined ? { itemCount: l.itemCount } : {}),
        }));
    },
    async listItems(libId: string): Promise<LibItemInfo[]> {
      const b = await bundle(libId);
      return b ? b.names.map((name) => ({ kind: b.kind, name })) : [];
    },
    async getAllItems(libId: string): Promise<Array<{ kind: string; name: string; body: Uint8Array }>> {
      const b = await bundle(libId);
      if (!b) return [];
      return b.names.map((name, i) => ({
        kind: b.kind,
        name,
        body: b.bytes.subarray(b.offsets[i], b.offsets[i] + b.lengths[i]),
      }));
    },
    async getItemBody(libId: string, kind: string, name: string): Promise<string | null> {
      const b = await bundle(libId);
      if (!b || b.kind !== kind) return null;
      const i = b.index.get(name);
      if (i === undefined) return null;
      return decoder.decode(b.bytes.subarray(b.offsets[i], b.offsets[i] + b.lengths[i]));
    },
    async getFpIndex(): Promise<string | null> {
      // Passed through as text (the engine parses it once). A null is never
      // kept: a 404 or an error is asked again on the next use. Immutable at
      // its tag, so the browser's HTTP cache may answer it in a later session.
      fpIndexP ??= (async () => {
        try {
          const r = await fetchImpl(`${base}fp-index.json`);
          if (!r.ok) {
            log(`[libs] fp-index: HTTP ${r.status}`);
            return null;
          }
          return await r.text();
        } catch (e) {
          log(`[libs] fp-index: ${String(e)}`);
          return null;
        }
      })().then((text) => {
        if (text === null) fpIndexP = null;
        return text;
      });
      return fpIndexP;
    },
    async syncState(kind?: string): Promise<LibsSyncState> {
      const m = await loadManifest();
      const libs = m.libs.filter((l) => !kind || l.kind === kind);
      const have = await (await store()).keySet();
      let warm = 0;
      let coldBytes = 0;
      let sizesKnown = true;
      for (const l of libs) {
        if (have.has(keyOf(l.id))) warm++;
        else if (l.bytes === undefined) sizesKnown = false;
        else coldBytes += l.bytes;
      }
      return { total: libs.length, warm, coldBytes, sizesKnown };
    },
    async presync(p?: {
      kind?: string;
      concurrency?: number;
      onProgress?: (p: LibPresyncProgress) => void;
      signal?: AbortSignal;
    }): Promise<void> {
      const { kind, concurrency = 8, onProgress, signal } = p ?? {};
      let m: Loaded;
      try {
        m = await loadManifest();
      } catch {
        return; // best-effort: the libraries still load lazily
      }
      const libs = m.libs.filter((l) => !kind || l.kind === kind);
      const have = await (await store()).keySet();
      const total = libs.length;
      let done = 0;
      onProgress?.({ done, total, current: "" });
      await asyncMap(
        libs,
        async (lib) => {
          if (signal?.aborted) return;
          // A stored bundle is warm already: nothing is read or parsed for it.
          if (!have.has(keyOf(lib.id))) {
            try {
              await bundle(lib.id);
            } catch (e) {
              log(`[libs] presync ${lib.id}: ${String(e)}`);
            }
          }
          if (signal?.aborted) return;
          onProgress?.({ done: ++done, total, current: lib.name });
        },
        Math.max(1, concurrency),
      );
    },
  };
}
