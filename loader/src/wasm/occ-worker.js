// SPDX-License-Identifier: GPL-3.0-or-later
// Modified by Circuit Center on 2026-11-18: restored for the island's 3D
// service (the island had removed it on 2026-09-30). The prelude also names
// OCC_LIFE_LOCK: the top realm holds that Web Lock for as long as it lives and
// says so with { alive: true }, so the host learns of an end that sends no
// error event (a worker that closed itself).
// Modified by Circuit Center on 2026-11-18: the module's wasm is no longer
// fetched here. The host fetches it with the loader's fetchWasmWithProgress
// (its progress, the browser's compiled code cache), compiles it and posts the
// WebAssembly.Module as { wasmModule } before any request; instantiateWasm
// waits for it. The pthread child realm is unchanged.
// Modified by Circuit Center on 2026-11-18: an export answers its bytes to the
// host, which writes them where the engine asked (outPath); nothing else of the
// answer changes.
// Modified by Circuit Center on 2026-11-19: PCBJam's leading comment below is
// kept as PCBJam wrote it. In this copy the provider alone reads this file
// (there is no e2e harness stub), the prelude also names OCC_LIFE_LOCK, and the
// host posts { wasmModule } before any request, as the notices above say.

/*
 * Worker-side wrapper for the occ_service MODULARIZE module — the SINGLE
 * source of truth for the worker boot, shared verbatim by:
 *   - the standalone app provider (occ-service.ts, vite `?raw` import), and
 *   - the e2e harness stub (tests/kicad/utils/occ-service.ts, read off disk).
 *
 * The host prepends one prelude line to the blob before this file's content:
 *   self.OCC_GLUE_URL = "<absolute URL of occ_service.js>";
 *
 * Protocol: the host posts { id, req } (req = { kind: "export" | "loadModel",
 * … }); the worker answers { id, res } with the result bytes transferred. A
 * one-shot { ready: true } / { bootError } message reports module boot.
 */
const GLUE = self.OCC_GLUE_URL;

// PTHREAD CHILD REALM (emscripten 6): the glue spawns its pthread workers from
// `_scriptName` = self.location.href, which, for a blob-booted service, is
// THIS wrapper blob (`Module.mainScriptUrlOrBlob` was removed upstream). Each
// child therefore re-executes this file. Detect the em-pthread realm, load the
// glue (its tail self-instantiates into pthread-child mode and installs its own
// onmessage for the wasmModule/wasmMemory handshake) and get out of the way:
// running the wrapper's own boot here would recursively spawn whole new
// services and clobber the pthread handshake handler (observed: occ_service
// boot hanging forever in a worker-spawn storm while the pool never fills).
if (globalThis.name === "em-pthread") {
  importScripts(GLUE);
} else {

self.addEventListener("error", (e) =>
  console.error("[occ_service] worker error:", e.message, e.filename, e.lineno));
self.addEventListener("unhandledrejection", (e) =>
  console.error("[occ_service] unhandled rejection:", e.reason));

// The life lock: held until this realm ends, however it ends.
const LIFE = self.OCC_LIFE_LOCK;
if (typeof LIFE === "string" && LIFE !== "" && self.navigator && self.navigator.locks) {
  self.navigator.locks.request(LIFE, () => {
    postMessage({ alive: true });
    return new Promise(() => {});
  }).catch(() => {});
}

// The compiled module, posted by the host before any request.
let gotModule;
const moduleP = new Promise((resolve) => { gotModule = resolve; });
self.addEventListener("message", (e) => {
  const m = e.data && e.data.wasmModule;
  if (m) gotModule(m);
});

importScripts(GLUE);

// wx boot logs a "Debug:" line per image handler etc., pure noise in the page
// console (and in the captured test logs); real problems don't carry the marker.
const noise = (s) => /(^|: )Debug: /.test(String(s));

const modP = OccService({
  instantiateWasm: (imports, receive) => {
    moduleP
      .then((m) => WebAssembly.instantiate(m, imports).then((inst) => receive(inst, m)))
      .catch((e) => postMessage({ bootError: String(e) }));
    return {};
  },
  onAbort: (what) => console.error("[occ_service] ABORT:", what),
  // A blob: worker has no http base URL: every asset path must be absolutized
  // against the glue's own URL.
  locateFile: (f) => new URL(f, GLUE).href,
  print: (s) => { if (!noise(s)) console.log("[occ_service]", s); },
  printErr: (s) => { if (!noise(s)) console.warn("[occ_service]", s); },
});

modP.then(() => postMessage({ ready: true }),
          (e) => postMessage({ bootError: String(e) }));

onmessage = async (e) => {
  const { id, req } = e.data || {};
  if (typeof id !== "number") return;
  let res;
  try {
    const mod = await modP;
    if (req.kind === "export") {
      const board = new TextDecoder().decode(req.board);
      // models: the host's staged [{ path, bytes }] model bodies, written by
      // the module under its MEMFS model root for the exporter's probe.
      res = mod.occExport(board, req.jobJson, req.models ?? []);
    } else if (req.kind === "loadModel") {
      res = mod.occLoadModel(req.bytes, req.ext);
    } else {
      res = { ok: false, report: "occ_service: unknown request kind " + req.kind };
    }
  } catch (err) {
    res = { ok: false, report: "occ_service worker: " + err };
  }
  const out = {
    ok: !!(res && res.ok),
    report: res && res.report,
    fileName: res && res.fileName,
    bytes: res && res.bytes,
  };
  postMessage({ id, res: out }, out.bytes ? [out.bytes.buffer] : []);
};

} // end non-pthread (top service) realm
