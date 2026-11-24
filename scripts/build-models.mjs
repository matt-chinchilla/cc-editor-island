// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The model store (LIBRARY.md "The model store"): KiCad's 3D model STEP files
// at the engine's KiCad tag, served from the island origin under
// /models/<tag>/ for the engine's model3d requests (loader/src/wasm/libs/
// model-store.ts). Built from kicad-packages3D's own tree at the tag: the
// tree listing, STEP files only, each fetched once, checked against its git
// blob id, written with a gzip twin beside it, and one index.json.gz per
// folder ({ name: bytes }). Resumable: every fetched file is remembered by
// path, tag and blob id in <out>/.cache/<tag>/, so a run picks up where the
// last one stopped and a dry run that weighed a file never fetches it again.
//
//   node scripts/build-models.mjs <tag> [--dry-run] [--only <p,...>] [--out <dir>]
//   node scripts/build-models.mjs --verify <dir>/<tag>
//   node scripts/build-models.mjs --ship-sums <dir>/<tag>   (what ships, on stdout)
//
// --only takes store paths (Resistor_SMD.3dshapes/R_0603_1608Metric.step),
// model lines as a board writes them (${KICAD10_3DMODEL_DIR}/...), or a
// .kicad_pcb file (its library model lines). A dry run writes nothing but the
// cache: it weighs the set (STEP files, raw and gzipped bytes) and the
// reference board's files. The store is built under <out>/<tag>/ (default
// dist/models, which the local pair serves at /models/); scripts/ship-models.sh
// ships a whole build once per tag and never rewrites it.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzip as gzipCb, constants as zc } from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(gzipCb);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const PROJECT = "kicad/libraries/kicad-packages3D";
export const API = "https://gitlab.com/api/v4";
export const RAW = "https://gitlab.com/kicad/libraries/kicad-packages3D/-/raw";
/** The set's gzipped size past which hosting waits for the owner (the 3D spec's gate 0, step 5). */
export const HOSTING_BOUND = 1.5e9;
/** The board weighed beside the set on every dry run. */
export const REFERENCE_BOARD = "tests/fixtures/glasgow/glasgow.kicad_pcb";
const CONCURRENCY = 8;

export const USAGE = [
  "usage: node scripts/build-models.mjs <tag> [--dry-run] [--only <p,...>] [--out <dir>]",
  "       node scripts/build-models.mjs --verify <dir>/<tag>",
  "       node scripts/build-models.mjs --ship-sums <dir>/<tag>",
].join("\n");

export class Refusal extends Error {}
export class UsageError extends Error {}

const TAG_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;
/** A file of the store: one folder <Lib>.3dshapes, one STEP file in it. */
const STEP_RE = /^([^/\\\u0000-\u001f]+)\.3dshapes\/([^/\\\u0000-\u001f]+)\.(step|stp)$/i;

export function parseArgs(argv) {
  const a = { tag: null, dryRun: false, only: null, out: null, verify: null };
  for (let i = 0; i < argv.length; i++) {
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`${argv[i - 1]} needs a value`);
      return v;
    };
    const arg = argv[i];
    switch (arg) {
      case "--dry-run": a.dryRun = true; break;
      case "--only": a.only = [...(a.only ?? []), ...next().split(",").map((s) => s.trim()).filter(Boolean)]; break;
      case "--out": a.out = next(); break;
      case "--verify": a.verify = next(); break;
      default:
        if (arg.startsWith("--")) throw new UsageError(`unknown arg: ${arg}`);
        if (a.tag !== null) throw new UsageError(`one tag only, got ${a.tag} and ${arg}`);
        a.tag = arg;
    }
  }
  if (a.verify !== null) {
    if (a.tag !== null || a.dryRun || a.only !== null || a.out !== null) throw new UsageError("--verify takes a store directory and nothing else");
    return a;
  }
  if (a.tag === null) throw new UsageError("the tag is required");
  if (!TAG_RE.test(a.tag)) throw new UsageError(`${a.tag} is not a tag`);
  if (a.only !== null && a.only.length === 0) throw new UsageError("--only needs at least one path");
  return a;
}

/**
 * A footprint's model line in the store's relative form, as KiCad's
 * PCBJAM_3D::NormalizeModelRef reads it: "${KICAD*_3DMODEL_DIR}/<lib>.3dshapes/
 * <name>.<ext>" (any vintage, brace or paren, and the old KISYS3DMOD) becomes
 * "<lib>.3dshapes/<name>.<ext>"; a bare relative line passes; an absolute
 * path, ${KIPRJMOD} or a URI is not the store's (null). The loader's twin is
 * normalizeModelRef in loader/src/wasm/libs/model-store.ts.
 */
export function normalizeModelRef(raw) {
  let ref = String(raw).trim();
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

/** The store paths that answer a relative model line, in order: a STEP line itself, a .wrl or .wrz line its STEP siblings; nothing else is the store's. */
export function storeCandidates(rel) {
  if (rel == null || rel.split(/[/\\]/).includes("..")) return [];
  const m = /^(.*)\.([A-Za-z0-9]+)$/.exec(rel);
  if (m == null) return [];
  const ext = m[2].toLowerCase();
  const out = ext === "step" || ext === "stp" ? [rel] : ext === "wrl" || ext === "wrz" ? [`${m[1]}.step`, `${m[1]}.stp`] : [];
  return out.filter((p) => STEP_RE.test(p));
}

/** Every distinct library model line of a board's text, relative ("<lib>.3dshapes/<name>.<ext>"), in first seen order. */
export function boardModelRefs(text) {
  const refs = [];
  const re = /\(\s*model\s+"((?:[^"\\]|\\.)*)"/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const rel = normalizeModelRef(m[1].replace(/\\(.)/g, "$1"));
    if (rel != null && !refs.includes(rel)) refs.push(rel);
  }
  return refs;
}

/** The git blob id of a file's bytes (sha1 over "blob <n>\0" and the bytes): what the tree listing names each file by. */
export function gitBlobId(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/** gzip at level 9; Node writes mtime 0 with no header given. */
export async function gzip9(bytes) {
  return new Uint8Array(await gzipAsync(bytes, { level: zc.Z_BEST_COMPRESSION }));
}

/** One index per folder: { "<Lib>.3dshapes": { "<Name>.step": rawBytes, ... } }, folders and names in code point order. */
export function folderIndexes(entries) {
  const by = new Map();
  for (const { path, raw } of entries) {
    const m = STEP_RE.exec(path);
    if (m == null) throw new Error(`${path} is not a store path`);
    const folder = `${m[1]}.3dshapes`;
    if (!by.has(folder)) by.set(folder, []);
    by.get(folder).push([path.slice(folder.length + 1), raw]);
  }
  const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  return Object.fromEntries([...by.keys()].sort(cmp).map((f) => [f, Object.fromEntries(by.get(f).sort((x, y) => cmp(x[0], y[0])))]));
}

/** The store paths --only names: store paths, model lines, and a board file's library model lines. Lines the set lacks (missing) and lines that are not the store's (a project's own, foreign) are returned apart. */
export function resolveOnly(items, setPaths, readText = (p) => readFileSync(p, "utf8")) {
  const set = new Set(setPaths);
  const picked = [];
  const missing = [];
  const foreign = [];
  const take = (rel, label) => {
    const candidates = storeCandidates(rel);
    if (candidates.length === 0) { if (!foreign.includes(label)) foreign.push(label); return; }
    const hit = candidates.find((c) => set.has(c));
    if (hit == null) { if (!missing.includes(label)) missing.push(label); return; }
    if (!picked.includes(hit)) picked.push(hit);
  };
  for (const item of items) {
    if (/\.kicad_pcb$/i.test(item)) {
      for (const rel of boardModelRefs(readText(item))) take(rel, rel);
      continue;
    }
    const rel = normalizeModelRef(item);
    if (rel == null) { foreign.push(item); continue; }
    take(rel, item);
  }
  return { picked, missing, foreign };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fetch that retries a network error, a 429 or a 5xx (after Retry-After when given), five times. */
export async function fetchRetry(url, init, fetchImpl = fetch, waits = [1000, 3000, 10000, 30000, 60000]) {
  for (let attempt = 0; ; attempt++) {
    let r = null;
    let err = null;
    try {
      r = await fetchImpl(url, init);
    } catch (e) {
      err = e;
    }
    if (r != null && r.status !== 429 && r.status < 500) return r;
    if (attempt >= waits.length) {
      if (r != null) return r;
      throw err;
    }
    const after = Number(r?.headers?.get?.("retry-after"));
    await sleep(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 120000) : waits[attempt]);
  }
}

/** The tag's commit and every STEP file of the tree at the tag ({ path, id }), sorted by path; LICENSE.md's blob id when the tree has it. */
export async function listTree(tag, fetchImpl = fetch) {
  const pid = encodeURIComponent(PROJECT);
  const t = await fetchRetry(`${API}/projects/${pid}/repository/tags/${encodeURIComponent(tag)}`, undefined, fetchImpl);
  if (!t.ok) throw new Refusal(`kicad-packages3D has no tag ${tag} (HTTP ${t.status})`);
  const commit = (await t.json())?.commit?.id;
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) throw new Refusal(`the tag ${tag} names no commit`);
  const files = [];
  let license = null;
  let url = `${API}/projects/${pid}/repository/tree?ref=${commit}&recursive=true&per_page=100&pagination=keyset`;
  while (url) {
    const r = await fetchRetry(url, undefined, fetchImpl);
    if (!r.ok) throw new Error(`tree listing: HTTP ${r.status}`);
    for (const e of await r.json()) {
      if (e.type !== "blob") continue;
      if (e.path === "LICENSE.md") license = e.id;
      else if (STEP_RE.test(e.path)) files.push({ path: e.path, id: e.id });
    }
    const next = /<([^>]+)>;\s*rel="next"/.exec(r.headers.get("link") ?? "");
    url = next ? next[1] : null;
  }
  files.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  return { commit, files, license };
}

/** One file of the tree at the commit, checked against its blob id. */
export async function fetchBlob(commit, path, id, fetchImpl = fetch) {
  const url = `${RAW}/${commit}/${path.split("/").map(encodeURIComponent).join("/")}`;
  const r = await fetchRetry(url, undefined, fetchImpl);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  const got = gitBlobId(bytes);
  if (got !== id) throw new Error(`${path}: blob ${got} is not the listed ${id}`);
  return bytes;
}

/** Runs `fn` over `items`, `n` at a time, in order of start. */
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  }));
}

const fmt = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`);

function writeAtomic(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, path);
}

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

/** Every file under a directory, relative, with forward slashes. */
function walk(dir) {
  const out = [];
  const go = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) go(p);
      else out.push(relative(dir, p).split(sep).join("/"));
    }
  };
  if (existsSync(dir)) go(dir);
  return out.sort();
}

/**
 * Builds (or, with dryRun, weighs) the store. `deps` carries the fetch and the
 * clock for tests. Answers the figures it printed.
 */
export async function run(opts, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const log = deps.log ?? ((m) => console.log(m));
  const root = deps.root ?? ROOT;
  const out = opts.out ?? join(root, "dist", "models");
  const pinTag = deps.pinTag ?? JSON.parse(readFileSync(join(root, "PIN.json"), "utf8")).libs?.tag;
  if (opts.tag !== pinTag) throw new Refusal(`PIN.json pins KiCad's libraries at ${pinTag}, not ${opts.tag}; the model store follows the engine's tag`);
  const cacheDir = join(out, ".cache", opts.tag);
  const treePath = join(cacheDir, "tree.json");
  const memoPath = join(cacheDir, "memo.json");

  // The tag never moves, so its listing is read once and kept.
  let tree = readJson(treePath, null);
  if (tree?.tag !== opts.tag || !Array.isArray(tree?.files)) {
    log(`listing kicad-packages3D at ${opts.tag} ...`);
    tree = { tag: opts.tag, ...(await listTree(opts.tag, fetchImpl)) };
    writeAtomic(treePath, JSON.stringify(tree));
  }
  const idOf = new Map(tree.files.map((f) => [f.path, f.id]));
  const allPaths = tree.files.map((f) => f.path);

  let paths = allPaths;
  if (opts.only != null) {
    const { picked, missing, foreign } = resolveOnly(opts.only.map((p) => (/\.kicad_pcb$/i.test(p) ? join(root, p) : p)), allPaths);
    for (const m of missing) log(`not in the set at ${opts.tag}: ${m}`);
    for (const m of foreign) log(`not a line of the store: ${m}`);
    paths = picked;
  }
  const refBoard = join(root, REFERENCE_BOARD);
  const reference = existsSync(refBoard) ? resolveOnly([refBoard], allPaths) : null;
  const weighed = opts.dryRun ? [...new Set([...paths, ...(reference?.picked ?? [])])] : paths;

  // memo: path -> { id, raw, gz }; kept as files are done, so a stopped run resumes.
  const memo = readJson(memoPath, {});
  let dirty = 0;
  const saveMemo = (force = false) => {
    if (dirty === 0 || (!force && dirty < 50)) return;
    writeAtomic(memoPath, JSON.stringify(memo));
    dirty = 0;
  };
  const tagDir = join(out, opts.tag);
  const failed = [];
  let done = 0;
  await pool(weighed, deps.concurrency ?? CONCURRENCY, async (path) => {
    const id = idOf.get(path);
    const known = memo[path]?.id === id ? memo[path] : null;
    const file = join(tagDir, path);
    const present = known != null && existsSync(file) && existsSync(`${file}.gz`)
      && statSync(file).size === known.raw && statSync(`${file}.gz`).size === known.gz;
    if (opts.dryRun ? known != null : present) { done++; return; }
    try {
      const bytes = await fetchBlob(tree.commit, path, id, fetchImpl);
      const gz = await gzip9(bytes);
      if (!opts.dryRun) { writeAtomic(file, bytes); writeAtomic(`${file}.gz`, gz); }
      memo[path] = { id, raw: bytes.length, gz: gz.length };
      dirty++;
      saveMemo();
    } catch (e) {
      failed.push(path);
      log(`failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (++done % 500 === 0) log(`${done} of ${weighed.length} files`);
  });
  saveMemo(true);
  if (failed.length > 0) throw new Error(`${failed.length} files could not be fetched; run again to resume`);

  const sum = (ps) => ps.reduce((a, p) => ({ raw: a.raw + memo[p].raw, gz: a.gz + memo[p].gz }), { raw: 0, gz: 0 });
  const figures = { tag: opts.tag, commit: tree.commit, setFiles: allPaths.length, files: paths.length, ...sum(paths), reference: null };
  const folders = new Set(paths.map((p) => p.slice(0, p.indexOf("/")))).size;
  log(`${opts.only ? "chosen" : "the set"} at ${opts.tag} (kicad-packages3D ${tree.commit.slice(0, 12)}): ${paths.length} STEP files in ${folders} folders, ${fmt(figures.raw)} raw (${figures.raw} bytes), ${fmt(figures.gz)} gzipped (${figures.gz} bytes)`);
  if (reference != null) {
    const r = sum(reference.picked);
    figures.reference = { named: reference.picked.length + reference.missing.length, files: reference.picked.length, ...r, missing: reference.missing };
    log(`${REFERENCE_BOARD}: ${figures.reference.named} library model lines (${reference.foreign.length} more lines are the project's own), ${reference.picked.length} in the set, ${fmt(r.raw)} raw (${r.raw} bytes), ${fmt(r.gz)} gzipped (${r.gz} bytes)`);
    for (const m of reference.missing) log(`  not in the set: ${m}`);
  }
  if (opts.only == null && figures.gz > HOSTING_BOUND) log(`over the ${fmt(HOSTING_BOUND)} bound: hosting the store waits for the owner (the 3D spec, question 1)`);
  if (opts.dryRun) return figures;

  // The license, the indexes, store.json and SHA256SUMS, written from what the folder holds.
  if (tree.license) {
    const lic = await fetchBlob(tree.commit, "LICENSE.md", tree.license, fetchImpl);
    writeAtomic(join(tagDir, "LICENSE.md"), lic);
    writeAtomic(join(tagDir, "LICENSE.md.gz"), await gzip9(lic));
  }
  const held = walk(tagDir).filter((p) => STEP_RE.test(p));
  for (const p of held) if (idOf.get(p) == null || memo[p]?.id !== idOf.get(p)) throw new Refusal(`${join(tagDir, p)} is not a file of the tree at ${opts.tag}; remove it`);
  const indexes = folderIndexes(held.map((p) => ({ path: p, raw: memo[p].raw })));
  for (const [folder, idx] of Object.entries(indexes)) writeAtomic(join(tagDir, folder, "index.json.gz"), await gzip9(Buffer.from(JSON.stringify(idx))));
  const total = sum(held);
  const store = { schema: 1, tag: opts.tag, commit: tree.commit, full: held.length === allPaths.length, files: held.length, bytes: total.raw, gzBytes: total.gz };
  writeAtomic(join(tagDir, "store.json"), JSON.stringify(store, null, 1) + "\n");
  const sums = walk(tagDir).filter((p) => p !== "SHA256SUMS").map((p) => `${createHash("sha256").update(readFileSync(join(tagDir, p))).digest("hex")}  ${p}`);
  writeAtomic(join(tagDir, "SHA256SUMS"), sums.join("\n") + "\n");
  log(`wrote ${tagDir}: ${held.length} STEP files${store.full ? " (the whole set)" : ` of ${allPaths.length}`}, ${Object.keys(indexes).length} indexes`);
  verifyStore(tagDir, log);
  return { ...figures, store };
}

/**
 * Reads a built store back: every STEP file has its gzip twin and they agree,
 * each folder's index lists exactly its STEP files with their sizes, store.json
 * agrees, nothing else is there, and SHA256SUMS matches every file. Throws a
 * Refusal naming the first fault.
 */
export function verifyStore(tagDir, log = (m) => console.log(m)) {
  const fault = (m) => { throw new Refusal(`${tagDir}: ${m}`); };
  if (!existsSync(join(tagDir, "store.json"))) fault("store.json is missing");
  const store = readJson(join(tagDir, "store.json"), null);
  if (store?.schema !== 1 || typeof store.tag !== "string") fault("store.json is not a store of schema 1");
  const files = walk(tagDir);
  const steps = files.filter((p) => STEP_RE.test(p));
  const allowed = new Set(["store.json", "SHA256SUMS", "LICENSE.md", "LICENSE.md.gz"]);
  const byFolder = new Map();
  for (const p of steps) {
    const f = p.slice(0, p.indexOf("/"));
    if (!byFolder.has(f)) byFolder.set(f, {});
    const raw = readFileSync(join(tagDir, p));
    if (!existsSync(join(tagDir, `${p}.gz`))) fault(`${p} has no gzip twin`);
    if (!Buffer.from(gunzipSync(readFileSync(join(tagDir, `${p}.gz`)))).equals(raw)) fault(`${p}.gz does not hold ${p}`);
    byFolder.get(f)[p.slice(f.length + 1)] = raw.length;
    allowed.add(p).add(`${p}.gz`);
  }
  let bytes = 0;
  for (const [f, want] of byFolder) {
    const ip = `${f}/index.json.gz`;
    if (!existsSync(join(tagDir, ip))) fault(`${ip} is missing`);
    const got = JSON.parse(gunzipSync(readFileSync(join(tagDir, ip))).toString("utf8"));
    if (JSON.stringify(Object.entries(got).sort()) !== JSON.stringify(Object.entries(want).sort())) fault(`${ip} does not list exactly the folder's STEP files and sizes`);
    allowed.add(ip);
    bytes += Object.values(want).reduce((a, b) => a + b, 0);
  }
  for (const p of files) if (!allowed.has(p)) fault(`${p} is not a file of the store`);
  if (store.files !== steps.length || store.bytes !== bytes) fault(`store.json says ${store.files} files and ${store.bytes} bytes, the folder holds ${steps.length} and ${bytes}`);
  const sums = readFileSync(join(tagDir, "SHA256SUMS"), "utf8").trim().split("\n").filter(Boolean);
  const listed = new Set();
  for (const line of sums) {
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (m == null) fault(`SHA256SUMS has a line of another shape: ${line}`);
    if (createHash("sha256").update(readFileSync(join(tagDir, m[2]))).digest("hex") !== m[1]) fault(`${m[2]} does not match SHA256SUMS`);
    listed.add(m[2]);
  }
  for (const p of files) if (p !== "SHA256SUMS" && !listed.has(p)) fault(`SHA256SUMS does not list ${p}`);
  log(`verified ${tagDir} (tag ${store.tag}): ${steps.length} STEP files${store.full ? ", the whole set" : ", a partial store"}`);
  return store;
}

/**
 * The checksum list of what ships: the store's SHA256SUMS lines less every raw
 * STEP file. The edge serves /models/ with gzip_static always (and gunzip for a
 * client that takes no gzip), so a .step address is answered from its .gz twin
 * and the raw file is never read there. Every dropped STEP file must have its
 * twin listed. Read from a store verifyStore has passed; answers the lines in
 * the store's order.
 */
export function shippedSums(tagDir) {
  const lines = readFileSync(join(tagDir, "SHA256SUMS"), "utf8").split("\n").filter(Boolean);
  const paths = new Set(lines.map((l) => l.slice(66)));
  const kept = [];
  for (const line of lines) {
    const p = line.slice(66);
    if (STEP_RE.test(p)) {
      if (!paths.has(`${p}.gz`)) throw new Refusal(`${tagDir}: ${p} has no gzip twin in SHA256SUMS`);
      continue;
    }
    kept.push(line);
  }
  for (const need of ["store.json", "LICENSE.md.gz"]) if (!paths.has(need)) throw new Refusal(`${tagDir}: SHA256SUMS does not list ${need}`);
  return kept;
}

async function main() {
  // --ship-sums <dir>/<tag>: the shipped checksum list on stdout (scripts/ship-models.sh).
  const argv = process.argv.slice(2);
  if (argv[0] === "--ship-sums") {
    if (argv.length !== 2) { console.error(`--ship-sums takes a store directory and nothing else\n${USAGE}`); process.exit(2); }
    try {
      process.stdout.write(shippedSums(argv[1]).join("\n") + "\n");
    } catch (e) {
      console.error(e instanceof Refusal ? `refused: ${e.message}` : e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
    return;
  }
  let a;
  try {
    a = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (e instanceof UsageError) { console.error(`${e.message}\n${USAGE}`); process.exit(2); }
    throw e;
  }
  try {
    if (a.verify !== null) verifyStore(a.verify);
    else await run(a);
  } catch (e) {
    if (e instanceof Refusal) { console.error(`refused: ${e.message}`); process.exit(1); }
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
