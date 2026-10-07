// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.

/**
 * Where the library mirror's bundles are kept between sessions: IndexedDB on
 * the island origin (LIBRARY.md "The client"), database `cc-libs`, object
 * store `bundles`, key `<tag>/<id>`, value the bundle's bytes as fetched (the
 * gzip already undone by the browser).
 *
 * The store is best-effort by contract: a browser with no IndexedDB, an open
 * that fails, or any operation that throws leaves the caller on memory alone.
 * Nothing here rejects; a failed read is a miss and a failed write is reported
 * as `false` so the caller can keep the bytes itself.
 */
export interface BundleStore {
  /** The stored bytes, or null when absent (or the read failed). */
  get(key: string): Promise<Uint8Array | null>;
  /** True when the bytes were stored. */
  put(key: string, bytes: Uint8Array): Promise<boolean>;
  /** Every stored key (empty when the listing failed). */
  keys(): Promise<string[]>;
  /** Removes these keys; failures are ignored. */
  delete(keys: string[]): Promise<void>;
}

export const IDB_NAME = "cc-libs";
export const IDB_STORE = "bundles";
const IDB_VERSION = 1;
/** How long an IndexedDB open may take before the session runs on memory alone. */
const IDB_OPEN_TIMEOUT_MS = 5000;

/** A store that lives as long as the page: the fallback when IndexedDB is missing, and the tests' store. */
export function memoryBundleStore(): BundleStore & { readonly map: Map<string, Uint8Array> } {
  const map = new Map<string, Uint8Array>();
  return {
    map,
    async get(key) {
      return map.get(key) ?? null;
    },
    async put(key, bytes) {
      map.set(key, bytes);
      return true;
    },
    async keys() {
      return [...map.keys()];
    },
    async delete(keys) {
      for (const k of keys) map.delete(k);
    },
  };
}

/** One IDB request as a promise. */
function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

/** Resolves when the transaction commits, rejects when it aborts or errors. */
function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
  });
}

/**
 * Opens the IndexedDB store, or resolves null when the browser has none or the
 * open fails (a private window, blocked storage, a sandbox without
 * allow-same-origin). The connection closes itself when another context
 * upgrades the database, so a later island never waits on this one.
 */
export async function openIdbBundleStore(
  factory: IDBFactory | undefined = typeof indexedDB === "undefined" ? undefined : indexedDB,
  timeoutMs = IDB_OPEN_TIMEOUT_MS,
): Promise<BundleStore | null> {
  if (!factory) return null;
  let db: IDBDatabase;
  try {
    const req = factory.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE);
    };
    // An open that never settles (storage stuck behind another context) must
    // not hold the libraries up: past the bound the session runs on memory, and
    // a connection that arrives late is closed.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
    const opened = await Promise.race([done(req), late]).finally(() => clearTimeout(timer));
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
        const v = await done(db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).get(key));
        return v instanceof Uint8Array ? v : null;
      } catch {
        return null;
      }
    },
    async put(key, bytes) {
      try {
        const tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).put(bytes, key);
        await committed(tx);
        return true;
      } catch {
        return false;
      }
    },
    async keys() {
      try {
        const ks = await done(db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).getAllKeys());
        return ks.filter((k): k is string => typeof k === "string");
      } catch {
        return [];
      }
    },
    async delete(keys) {
      if (keys.length === 0) return;
      try {
        const tx = db.transaction(IDB_STORE, "readwrite");
        const os = tx.objectStore(IDB_STORE);
        for (const k of keys) os.delete(k);
        await committed(tx);
      } catch {
        // A key left behind is retried on the next session's first open.
      }
    },
  };
}
