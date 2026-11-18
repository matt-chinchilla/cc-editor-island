// SPDX-License-Identifier: GPL-3.0-or-later
// Modified by Circuit Center on 2026-11-18: restored for the island's 3D
// service (the island had removed it on 2026-09-30), with these changes.
// (a) The service files' address is the island's asset base (engineBase(),
// passed in as `base`), not PCBJam's delivery lookup, so the wasm-assets
// import is gone.
// (b) The wasm is fetched here with the loader's fetchWasmWithProgress (the
// fetch's own Response, so the browser's compiled code cache is used),
// compiled, and posted to the worker as a module; its progress reaches the
// island's onProgress listeners.
// (c) An export request carries outPath: the parts' model bodies are staged
// through the island's stage hook (setStage) in place of PCBJam's models
// bridge, occExport runs in the worker, and the bytes are written at outPath
// in the engine's file system; the engine hears { ok, report } only, and
// nothing is handed to the browser.
// (d) A loadModel request is PCBJam's, unchanged.
// (e) The worker is released 60 s after its last answer, and at once when the
// island asks (release(), on shutdown); a worker that ends while requests wait
// settles every one with { ok: false, report: "The 3D service stopped." } and
// the next request boots a new one. An end with no error event (a worker that
// closed itself) is heard through the Web Lock the worker holds while it lives.
// installOccService takes one options object and answers a handle.

// The worker-side wrapper as text (vite ?raw): one shared source of truth.
import occWorkerSource from "./occ-worker.js?raw";
import { fetchWasmWithProgress } from "./boot";

/**
 * `globalThis.occService`: the lazy OpenCASCADE 3D service provider.
 *
 * The editor's wasm carries no OCC: its two OCC backed paths suspend through
 * EM_ASYNC_JS bridges (wasm/stubs/{exporter_step,oce_plugin}_stub.cpp) and
 * land here:
 *   { kind: "export", board, jobJson, fileName, outPath }: a STEP, GLB or
 *     other 3D export; the bytes are written at outPath in the engine's file
 *     system and only { ok, report } goes back to the editor.
 *   { kind: "loadModel", bytes, ext }: STEP or IGES parse and tessellation;
 *     answers the SCENEGRAPH serialized in KiCad's binary cache format, which
 *     the C++ stub rebuilds with S3D::ReadCache.
 *
 * The occ_service module (its own emscripten instance, no suspension backend)
 * boots in a dedicated Worker on the FIRST request: a session that never
 * exports and never reads a STEP model never fetches it. A same origin blob
 * wrapper importScripts the glue; the module's own pthread children re-run it.
 */

/** One staged model body: its path under the service's model root, and its bytes. */
export interface OccModelFile {
  path: string;
  bytes: Uint8Array;
}

interface OccExportRequest {
  kind: "export";
  board: Uint8Array;
  jobJson: string;
  fileName: string;
  /** Where the engine reads the file back (its m_outputFile). */
  outPath?: string;
}

interface OccLoadModelRequest {
  kind: "loadModel";
  bytes: Uint8Array;
  ext: string;
}

export type OccRequest = OccExportRequest | OccLoadModelRequest;

export interface OccResponse {
  ok: boolean;
  report?: string;
  fileName?: string;
  bytes?: Uint8Array;
}

/** What the stage hook is given: the export as the engine asked for it. */
export interface OccStageInput {
  board: Uint8Array;
  jobJson: string;
  fileName: string;
  outPath: string;
}

/** What it answers: the bodies to send, and a line for the export's report (skipped files, a bound met). */
export interface OccStaged {
  models: OccModelFile[];
  report?: string;
}

export type OccStage = (input: OccStageInput) => Promise<OccStaged>;

declare global {
  // eslint-disable-next-line no-var
  var occService: { request(req: OccRequest): Promise<OccResponse> } | undefined;
}

/** The answer every waiting request gets when the worker ends under it. */
export const OCC_STOPPED = "The 3D service stopped.";
/** The answer when an export names no file to write (an engine before run 15). */
export const OCC_NO_PATH = "The 3D service was given no file to write.";
/** The answer when the service ran and gave no bytes. */
export const OCC_NO_FILE = "The 3D service made no file.";

/** Assembles the worker blob: the prelude lines, then the shared wrapper source. */
export function occWorkerBlobParts(glueHref: string, lifeLock = ""): string[] {
  return [
    `self.OCC_GLUE_URL = ${JSON.stringify(glueHref)};\n`
      + `self.OCC_LIFE_LOCK = ${JSON.stringify(lifeLock)};\n`,
    occWorkerSource,
  ];
}

export interface OccServiceWatchdogs {
  /** Maximum time from the first request until a new generation announces `ready`. */
  bootTimeoutMs?: number;
  /** Maximum time for any one request in a ready generation to answer. */
  responseTimeoutMs?: number;
  /** Maximum time the stage hook may take; past it the export runs with no bodies, and says so. */
  stageTimeoutMs?: number;
  /** How long an idle worker is kept after its last answer. */
  releaseAfterMs?: number;
}

// These are last resort failure bounds, not normal scheduling deadlines.
export const OCC_BOOT_TIMEOUT_MS = 2 * 60_000;
export const OCC_RESPONSE_TIMEOUT_MS = 30 * 60_000;
export const OCC_STAGE_TIMEOUT_MS = 10 * 60_000;
export const OCC_RELEASE_AFTER_MS = 60_000;

export interface OccServiceOptions {
  /** The island's asset base, with a trailing slash: the service files sit there. */
  base: string;
  /** The wasm's raw size (PIN.json), for the loading percent; 0 when unknown. */
  wasmBytes?: number;
  log: (msg: string) => void;
  /** The engine's file system, read when an export's bytes are written. */
  fs: () => EmscriptenFS | null | undefined;
  watchdogs?: OccServiceWatchdogs;
}

export interface OccServiceHandle {
  request(req: OccRequest): Promise<OccResponse>;
  /** Ends the worker now, if there is one (true), settling what waits; the next request boots a new one. */
  release(): boolean;
  /** Whether a worker is booted or booting. */
  live(): boolean;
  /** Hears the wasm's loading progress (`total` the raw size, 0 when unknown); the answer stops it. */
  onProgress(fn: (loaded: number, total: number) => void): () => void;
  /** The hook that stages an export's model bodies; null for none. */
  setStage(fn: OccStage | null): void;
}

let lockSerial = 0;

/** A boot failure as the report line the engine shows. */
function startFailure(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.startsWith("The 3D service") ? msg : `The 3D service did not start: ${msg}.`;
}

export function installOccService(options: OccServiceOptions): OccServiceHandle | null {
  if (globalThis.occService) return null;
  const { log, watchdogs = {} } = options;
  const bootTimeoutMs = watchdogs.bootTimeoutMs ?? OCC_BOOT_TIMEOUT_MS;
  const responseTimeoutMs = watchdogs.responseTimeoutMs ?? OCC_RESPONSE_TIMEOUT_MS;
  const stageTimeoutMs = watchdogs.stageTimeoutMs ?? OCC_STAGE_TIMEOUT_MS;
  const releaseAfterMs = watchdogs.releaseAfterMs ?? OCC_RELEASE_AFTER_MS;
  const wasmBytes = Number.isSafeInteger(options.wasmBytes) && (options.wasmBytes ?? 0) > 0 ? options.wasmBytes! : 0;

  interface WorkerSlot {
    generation: number;
    worker?: Worker;
    workerUrl?: string;
    failed: boolean;
    ready: Promise<WorkerSlot>;
    bootTimer?: ReturnType<typeof setTimeout>;
    rejectBoot?: (reason?: unknown) => void;
    removeBootListener?: () => void;
    /** Aborts the host's wait on the worker's life lock. */
    lifeWatch?: AbortController;
  }

  interface PendingRequest {
    generation: number;
    resolve: (res: OccResponse) => void;
    timer: ReturnType<typeof setTimeout>;
  }

  let nextId = 1;
  let nextGeneration = 1;
  const pending = new Map<number, PendingRequest>();
  let workerSlot: WorkerSlot | null = null;
  /** Requests between their arrival and their answer (staging included). */
  let inFlight = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let stage: OccStage | null = null;
  const progressListeners = new Set<(loaded: number, total: number) => void>();
  const tellProgress = (loaded: number, total: number): void => {
    for (const fn of [...progressListeners]) {
      try {
        fn(loaded, total);
      } catch (error) {
        log(`[occ] a progress listener failed: ${String(error)}`);
      }
    }
  };

  const clearIdle = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = undefined;
  };

  const failPending = (generation: number, report: string): void => {
    for (const [id, request] of pending) {
      if (request.generation !== generation) continue;
      pending.delete(id);
      clearTimeout(request.timer);
      request.resolve({ ok: false, report });
    }
  };

  const retireWorker = (slot: WorkerSlot, report: string, why: string): void => {
    if (slot.failed) return;
    slot.failed = true;
    log(`[occ] ${why}`);
    if (slot.bootTimer !== undefined) {
      clearTimeout(slot.bootTimer);
      slot.bootTimer = undefined;
    }
    slot.removeBootListener?.();
    slot.removeBootListener = undefined;
    slot.lifeWatch?.abort();
    slot.lifeWatch = undefined;
    failPending(slot.generation, report);
    if (workerSlot === slot) {
      workerSlot = null;
      clearIdle();
    }
    try {
      slot.worker?.terminate();
    } catch {
      /* already gone */
    }
    if (slot.workerUrl) {
      try {
        URL.revokeObjectURL(slot.workerUrl);
      } catch {
        /* URL cleanup must not prevent exact wait settlement */
      }
      slot.workerUrl = undefined;
    }
    const reject = slot.rejectBoot;
    slot.rejectBoot = undefined;
    reject?.(new Error(report));
  };

  /** Hears the worker's end through its life lock: granted to us only once it is gone. */
  const watchLife = (slot: WorkerSlot, name: string): void => {
    const locks = (globalThis.navigator as Navigator | undefined)?.locks;
    if (!locks || slot.failed) return;
    const watch = new AbortController();
    slot.lifeWatch = watch;
    locks.request(name, { signal: watch.signal }, () => {
      if (!slot.failed && workerSlot === slot) retireWorker(slot, OCC_STOPPED, "occ_service worker ended; resetting service");
    }).catch(() => {
      /* aborted: the slot was retired first */
    });
  };

  /** Fetches and compiles the wasm, counting its bytes for the listeners. */
  const compileWasm = async (base: string): Promise<WebAssembly.Module> => {
    const url = new URL(`${base}occ_service.wasm`, window.location.href).href;
    const res = await fetchWasmWithProgress(url, (loaded, total) => tellProgress(loaded, wasmBytes || total), wasmBytes || null);
    try {
      return await WebAssembly.compileStreaming(res);
    } catch (streamError) {
      // A server that names another type: compile from the bytes instead.
      const again = await fetch(url);
      if (!again.ok) throw streamError;
      return WebAssembly.compile(await again.arrayBuffer());
    }
  };

  const ensureWorker = (): Promise<WorkerSlot> => {
    if (!workerSlot) {
      const slot = {
        generation: nextGeneration++,
        failed: false,
      } as WorkerSlot;
      // Publish the generation before its async boot reaches the first await.
      workerSlot = slot;

      const bootDeadline = new Promise<never>((_resolve, reject) => {
        slot.rejectBoot = reject;
        slot.bootTimer = setTimeout(() => {
          if (slot.failed || workerSlot !== slot) return;
          const why = `occ_service boot timed out after ${bootTimeoutMs} ms`;
          retireWorker(slot, `The 3D service did not start: ${why}.`, `${why}; resetting service`);
        }, bootTimeoutMs);
      });

      const boot = (async () => {
        const base = options.base;
        const wasmModule = await compileWasm(base);
        if (slot.failed || workerSlot !== slot) {
          throw new Error("occ_service worker retired while its wasm loaded");
        }
        const glue = new URL(`${base}occ_service.js`, window.location.href).href;
        log(`[occ] booting occ_service from ${base}`);
        const lifeLock = `cc-occ-life-${Date.now().toString(36)}-${++lockSerial}-${slot.generation}`;

        slot.workerUrl = URL.createObjectURL(
          new Blob(occWorkerBlobParts(glue, lifeLock), { type: "text/javascript" }),
        );
        const worker = new Worker(slot.workerUrl);
        slot.worker = worker;

        // A hard OCC or wasm fault must complete every editor wait that depends
        // on this worker. The next request gets a fresh generation; callbacks
        // from this retired worker cannot resolve its requests.
        worker.onerror = (e) => {
          retireWorker(slot, OCC_STOPPED, `worker error: ${e.message || "worker error"}; resetting service`);
        };
        worker.onmessageerror = () => {
          retireWorker(slot, OCC_STOPPED, "worker message decode failed; resetting service");
        };

        worker.onmessage = (e) => {
          if (slot.failed || workerSlot !== slot) return;
          const data = e.data ?? {};
          if (data.alive === true) {
            watchLife(slot, lifeLock);
            return;
          }
          const { id, res } = data;
          if (typeof id !== "number") return;
          const request = pending.get(id);
          if (request?.generation === slot.generation) {
            pending.delete(id);
            clearTimeout(request.timer);
            request.resolve(res as OccResponse);
          }
        };

        await new Promise<void>((resolve) => {
          const onFirst = (e: MessageEvent) => {
            if (e.data?.ready) {
              if (slot.bootTimer !== undefined) {
                clearTimeout(slot.bootTimer);
                slot.bootTimer = undefined;
              }
              slot.removeBootListener?.();
              slot.removeBootListener = undefined;
              slot.rejectBoot = undefined;
              resolve();
            } else if (e.data?.bootError) {
              const why = `occ_service boot failed: ${String(e.data.bootError)}`;
              retireWorker(slot, `The 3D service did not start: ${why}.`, why);
            }
          };
          worker.addEventListener("message", onFirst);
          slot.removeBootListener = () => worker.removeEventListener("message", onFirst);
          worker.postMessage({ wasmModule });
        });

        if (slot.failed || workerSlot !== slot) {
          throw new Error("occ_service worker retired during boot");
        }
        log("[occ] occ_service ready");
        return slot;
      })();

      slot.ready = Promise.race([boot, bootDeadline]).catch((e) => {
        // A late failure from a retired generation must not clear a replacement.
        retireWorker(slot, startFailure(e), `occ_service unavailable: ${String(e)}`);
        throw e;
      });
    }
    return workerSlot.ready;
  };

  const post = (slot: WorkerSlot, req: OccRequest & { models?: OccModelFile[] }): Promise<OccResponse> => {
    const worker = slot.worker;
    if (!worker || slot.failed || workerSlot !== slot) {
      return Promise.resolve({ ok: false, report: OCC_STOPPED });
    }
    const id = nextId++;
    const transfer: Transferable[] =
      req.kind === "export"
        ? [req.board.buffer, ...(req.models ?? []).map((m) => m.bytes.buffer)]
        : [req.bytes.buffer];
    return new Promise<OccResponse>((resolve) => {
      const timer = setTimeout(() => {
        if (pending.get(id)?.generation !== slot.generation) return;
        const why = `occ_service response timed out after ${responseTimeoutMs} ms`;
        retireWorker(slot, OCC_STOPPED, `${why}; resetting service`);
      }, responseTimeoutMs);
      pending.set(id, { generation: slot.generation, resolve, timer });
      try {
        worker.postMessage({ id, req }, [...new Set(transfer)]);
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        resolve({ ok: false, report: `The 3D service could not take the request: ${String(error)}` });
      }
    });
  };

  /** The stage hook's answer, bounded; a failure or the bound runs the export with no bodies, and says so. */
  const staged = async (input: OccStageInput): Promise<OccStaged> => {
    const hook = stage;
    if (!hook) return { models: [] };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<OccStaged>((resolve) => {
      timer = setTimeout(() => resolve({ models: [], report: "The parts' 3D bodies took too long to gather; the file has none." }), stageTimeoutMs);
    });
    try {
      return await Promise.race([
        hook(input).then(
          (s) => (s && Array.isArray(s.models) ? s : { models: [] }),
          (error) => {
            log(`[occ] staging failed: ${String(error)}`);
            return { models: [], report: "The parts' 3D bodies could not be gathered; the file has none." };
          },
        ),
        bound,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  /** Writes an export's bytes where the engine reads them back. */
  const writeOut = (outPath: string, bytes: Uint8Array): string | null => {
    const fs = options.fs();
    if (!fs) return "The 3D service found no file system to write to.";
    try {
      const dir = outPath.slice(0, outPath.lastIndexOf("/"));
      if (dir !== "" && !fs.analyzePath(dir).exists) fs.mkdirTree(dir);
      fs.writeFile(outPath, bytes);
      return null;
    } catch (error) {
      return `The 3D service could not write the file: ${String(error)}`;
    }
  };

  const exportRun = async (req: OccExportRequest): Promise<OccResponse> => {
    // Capture the caller's fields before the first await.
    const { board, jobJson, fileName, outPath } = req;
    if (typeof outPath !== "string" || !outPath.startsWith("/")) return { ok: false, report: OCC_NO_PATH };
    const { models, report: stageNote } = await staged({ board, jobJson, fileName, outPath });
    if (models.length) log(`[occ] sending ${models.length} model bod${models.length === 1 ? "y" : "ies"} with the export`);
    let slot: WorkerSlot;
    try {
      slot = await ensureWorker();
    } catch (e) {
      return { ok: false, report: startFailure(e) };
    }
    const res = await post(slot, { kind: "export", board, jobJson, fileName, models });
    const join = (r?: string): string | undefined => (stageNote ? (r ? `${r}\n${stageNote}` : stageNote) : r);
    if (!res.ok) return { ok: false, report: join(res.report) };
    if (!(res.bytes instanceof Uint8Array) || res.bytes.length === 0) return { ok: false, report: join(res.report ? `${res.report}\n${OCC_NO_FILE}` : OCC_NO_FILE) };
    const wrote = writeOut(outPath, res.bytes);
    if (wrote != null) return { ok: false, report: join(wrote) };
    log(`[occ] export written: ${outPath} (${res.bytes.length} bytes)`);
    return { ok: true, report: join(res.report) };
  };

  const loadModel = async (req: OccLoadModelRequest): Promise<OccResponse> => {
    let slot: WorkerSlot;
    try {
      slot = await ensureWorker();
    } catch (e) {
      return { ok: false, report: startFailure(e) };
    }
    return post(slot, { kind: "loadModel", bytes: req.bytes, ext: req.ext });
  };

  const settled = (): void => {
    inFlight -= 1;
    if (inFlight > 0 || pending.size > 0 || !workerSlot) return;
    clearIdle();
    const slot = workerSlot;
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      if (workerSlot === slot && inFlight === 0 && pending.size === 0) {
        retireWorker(slot, OCC_STOPPED, `occ_service released after ${releaseAfterMs} ms idle`);
      }
    }, releaseAfterMs);
  };

  const request = async (req: OccRequest): Promise<OccResponse> => {
    inFlight += 1;
    clearIdle();
    try {
      if (req?.kind === "export") return await exportRun(req);
      if (req?.kind === "loadModel") return await loadModel(req);
      return { ok: false, report: "The 3D service was asked for something it does not do." };
    } finally {
      settled();
    }
  };

  globalThis.occService = { request };
  log("[occ] occ_service provider installed (lazy)");
  return {
    request,
    release: () => {
      clearIdle();
      const slot = workerSlot;
      if (!slot) return false;
      retireWorker(slot, OCC_STOPPED, "occ_service released");
      return true;
    },
    live: () => workerSlot != null,
    onProgress: (fn) => {
      progressListeners.add(fn);
      return () => { progressListeners.delete(fn); };
    },
    setStage: (fn) => { stage = fn; },
  };
}
