// Publish the FULL default KiCad symbol + footprint set to the CDN as
// version-pinned r2-idb-sync STATIC ORIGINS (one per lib), which the demo's
// cdnLibsSource opens read-only + IDB-cached (1 bundle cold, 0 warm). See
// docs/features/r2-idb-sync + wasm/libs/cdn-source.ts.
//
//   npx tsx scripts/deploy/publish-libs.ts --lib-tag 10.0.3 \
//     --symbols-src <kicad-symbols checkout> --footprints-src <kicad-footprints> \
//     --driver local --out /tmp/cdn-libs
//   npx tsx scripts/deploy/publish-libs.ts --lib-tag 10.0.3 --symbols-src … \
//     --footprints-src … --driver r2 --bucket pcbjam-cdn --remote
//
// Keyed by the upstream KiCad library tag (libs/kicad/<libTag>/), published ONCE
// per tag: if <prefix>/<libTag>/manifest.json already exists it SKIPS the whole
// run (override with --force) — so it's decoupled from the app/demo deploy.
//
// Per lib `<prefix>/<libTag>/<lib>/`:
//   manifest   SyncManifest { version, entries: { "<kind>/<name>": {hash,size,mtime} } }
//   bundle     encodeBundle(manifest, bodies)  — cold-init payload (all bodies)
// + top `<prefix>/<libTag>/manifest.json` { schema, tag, libs:[{id,name,kind,itemCount}] }
// + `<prefix>/<libTag>/fp-index.json` { schema, tag, libs: { <libId>: [[name, pads], …] } }
//   — the publish-time footprint index: unique electrical pad count per footprint,
//   so the editor's symbol-chooser footprint selector can filter EVERY footprint
//   lib without fat-loading a single body (kicad pcbnew.cpp `filterFootprints`).
// + `<prefix>/<libTag>/sizes.json` { schema, tag, libs: { <libId>: <bundleBytes> } }
//   — per-lib bundle byte counts for the standalone's download-consent dialog
//   (standalone-load-ux 0001). A SEPARATE key (not a manifest.json field) on
//   purpose: manifest.json is stored IMMUTABLE, so re-putting it to add sizes
//   could serve stale from edge caches; a new key can't.
// All immutable (content is pinned by the tag).
// A tag published before fp-index.json / sizes.json existed gets a TOP-UP run:
// bundles/manifests are skipped (immutable + present), only the missing index
// and/or sizes files are computed (pure local work) and put.
// Copied from PCBJam (https://github.com/PCBJam/pcbjam) at tag v0.2.3, commit
// 7ec51c1c55aab45b21cd2956af413b4420520838, scripts/deploy/publish-libs.ts
// (GPL-3.0): the argument parsing, cloneFull and the overall flow (clone,
// extract every library, encode one bundle per library, write the top
// manifest and the footprint index).
// Modified by Circuit Center on 2026-10-07: ported from TypeScript to a plain
// Node script. It writes the island's own layout, LIBRARY.md's ccl1 mirror
// under <out>/<tag>/ (scripts/libs/mirror.mjs), in place of the r2-idb-sync
// static origins described above: no store driver, bucket, prefix, force,
// top-up or sizes.json (the manifest carries each bundle's stored size).
// Modified by Circuit Center on 2026-10-07: the island's pin discipline. The
// tag must be PIN.json libs.tag, and each source checkout must sit at the
// commit PIN.json libs pins, with no local changes, or the build refuses;
// --clone clones the PIN.json repositories at the tag (an existing clone is
// reused and checked the same way).
// Modified by Circuit Center on 2026-10-07: --only <id,...> builds a subset,
// and every build ends by reading its output back (verifyMirror); --verify
// <dir> runs that check alone on a built mirror.
//
//   node scripts/build-libs.mjs --out <dir> [--tag <t>] --clone <dir> [--only <id,...>]
//   node scripts/build-libs.mjs --out <dir> [--tag <t>] --symbols-src <p> --footprints-src <p> [--only <id,...>]
//   node scripts/build-libs.mjs --verify <dir>/<tag>
//
// <out>/<tag>/ is replaced when it holds an earlier local build (nothing but
// *.gz files) and refused otherwise. The box copy is never rewritten:
// scripts/ship-libs.sh ships a tag once.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMirror, verifyMirror } from "./libs/mirror.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = [
  "usage: node scripts/build-libs.mjs --out <dir> [--tag <t>] (--clone <dir> | --symbols-src <p> --footprints-src <p>) [--only <id,...>]",
  "       node scripts/build-libs.mjs --verify <dir>/<tag>",
].join("\n");

class Refusal extends Error {}
class UsageError extends Error {}

function parseArgs(argv) {
  const a = { out: null, tag: null, symbolsSrc: null, footprintsSrc: null, clone: null, only: null, verify: null };
  for (let i = 2; i < argv.length; i++) {
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`${argv[i - 1]} needs a value`);
      return v;
    };
    switch (argv[i]) {
      case "--out": a.out = next(); break;
      case "--tag": a.tag = next(); break;
      case "--symbols-src": a.symbolsSrc = next(); break;
      case "--footprints-src": a.footprintsSrc = next(); break;
      // Clone both upstream repos at the tag into <dir>/{kicad-symbols,
      // kicad-footprints} (full, shallow) and use them as the sources.
      case "--clone": a.clone = next(); break;
      case "--only": a.only = next(); break;
      case "--verify": a.verify = next(); break;
      default: throw new UsageError(`unknown arg: ${argv[i]}`);
    }
  }
  if (a.verify !== null) {
    if (Object.entries(a).some(([k, v]) => k !== "verify" && v !== null)) throw new UsageError("--verify takes a mirror directory and nothing else");
    return a;
  }
  if (!a.out) throw new UsageError("--out <dir> is required");
  if (a.clone && (a.symbolsSrc || a.footprintsSrc)) throw new UsageError("give --clone or the two source paths, not both");
  if (!a.clone && !(a.symbolsSrc && a.footprintsSrc)) throw new UsageError("need --clone <dir>, or both --symbols-src and --footprints-src");
  if (a.only !== null) {
    a.only = a.only.split(",").map((s) => s.trim()).filter(Boolean);
    if (a.only.length === 0) throw new UsageError("--only needs at least one library id");
  }
  return a;
}

/** Shallow full clone of a lib repo at a tag (idempotent: skip if present). */
function cloneFull(url, dest, ref) {
  if (existsSync(dest)) {
    console.log(`clone: ${dest} present, reusing it`);
    return;
  }
  mkdirSync(dirname(dest), { recursive: true });
  console.log(`clone: ${url} @ ${ref} -> ${dest}`);
  execFileSync("git", ["clone", "--depth", "1", "--branch", ref, url, dest], { stdio: "inherit" });
}

/** Refuse a source that is not a checkout of exactly the pinned commit. */
function checkPinned(src, commit, label) {
  if (!existsSync(src)) throw new Refusal(`${src} does not exist`);
  let head;
  try {
    head = execFileSync("git", ["-C", src, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    throw new Refusal(`${src} is not a git checkout, so its commit cannot be checked against PIN.json ${label}`);
  }
  if (head !== commit) throw new Refusal(`${src} is at ${head}, PIN.json ${label} pins ${commit}`);
  const changes = execFileSync("git", ["-C", src, "status", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (changes.trim() !== "") throw new Refusal(`${src} has local changes; the mirror is built from the pinned commit's files only`);
}

const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

function printFigures(f) {
  for (const kind of ["symbol", "footprint"]) {
    const k = f[kind];
    console.log(`${kind} libraries: ${k.libs}, items: ${k.items}, stored: ${k.bytes} bytes (${mb(k.bytes)})`);
  }
  console.log("biggest bundles (stored):");
  for (const b of f.biggest) console.log(`  ${b.id}: ${b.bytes} bytes stored, ${b.raw} bytes raw, ${b.items} items`);
  console.log(`SHA256SUMS.gz sha256 ${f.sumsSha256}`);
}

async function main() {
  const a = parseArgs(process.argv);
  if (a.verify !== null) {
    const figures = verifyMirror(a.verify);
    console.log(`verified ${a.verify} (tag ${figures.tag})`);
    printFigures(figures);
    return;
  }

  const pin = JSON.parse(readFileSync(join(ROOT, "PIN.json"), "utf8")).libs;
  if (!pin?.tag || !pin.symbols?.commit || !pin.footprints?.commit) throw new Refusal("PIN.json has no libs tag and commits");
  const tag = a.tag ?? pin.tag;
  if (tag !== pin.tag) throw new Refusal(`PIN.json pins the libraries at ${pin.tag}; to build ${tag}, bump PIN.json libs (its tag and both commits) first`);

  // Source the full set from upstream when asked; an existing clone is reused
  // and held to the pin like any other checkout.
  if (a.clone) {
    a.symbolsSrc = join(a.clone, "kicad-symbols");
    a.footprintsSrc = join(a.clone, "kicad-footprints");
    cloneFull(pin.symbols.repo, a.symbolsSrc, tag);
    cloneFull(pin.footprints.repo, a.footprintsSrc, tag);
  }
  checkPinned(a.symbolsSrc, pin.symbols.commit, "libs.symbols.commit");
  checkPinned(a.footprintsSrc, pin.footprints.commit, "libs.footprints.commit");

  const started = Date.now();
  console.log(`build-libs: tag ${tag} -> ${join(a.out, tag)}${a.only ? ` (only ${a.only.join(", ")})` : ""}`);
  const built = await buildMirror({
    symbolsSrc: a.symbolsSrc,
    footprintsSrc: a.footprintsSrc,
    out: a.out,
    tag,
    only: a.only,
    provenance: {
      symbols: `${pin.symbols.repo} at tag ${tag}, commit ${pin.symbols.commit}.`,
      footprints: `${pin.footprints.repo} at tag ${tag}, commit ${pin.footprints.commit}.`,
    },
    log: (line) => console.log(line),
  });
  const builtIn = Date.now() - started;
  for (const id of built.skipped) console.log(`left out (no items): ${id}`);
  const figures = verifyMirror(built.dir);
  console.log(`built ${built.dir} in ${(builtIn / 1000).toFixed(1)} s; read back and verified in ${((Date.now() - started - builtIn) / 1000).toFixed(1)} s`);
  printFigures(figures);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    if (err instanceof UsageError) {
      console.error(`build-libs: ${err.message}\n${USAGE}`);
      process.exit(2);
    }
    console.error(err instanceof Refusal ? `refused: ${err.message}` : `build-libs: ${err.message}`);
    process.exit(1);
  });
}
