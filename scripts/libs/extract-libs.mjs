// Copied from PCBJam (https://github.com/PCBJam/pcbjam) at tag v0.2.3, commit
// 7ec51c1c55aab45b21cd2956af413b4420520838, web/backend/src/extract/extract-libs.ts
// (GPL-3.0): the full-set half (extractAllLibs) and readSymbol; the curated
// example half (SYMBOL_MANIFEST, FOOTPRINT_MANIFEST, extractAll, main) was not
// copied.
// Modified by Circuit Center on 2026-10-07: ported from TypeScript to a plain
// Node module for scripts/build-libs.mjs (LIBRARY.md); synchronous reads.
// Modified by Circuit Center on 2026-10-07: extractAllLibs became listLibs
// (every library under the sources, with its id `sym.<nick>` or `fp.<nick>`,
// sorted in code point order) and extractLib (one library's items), so the
// builder holds one library at a time and can filter by id; a plain
// `<Nick>.kicad_sym` file beside the `.kicad_symdir` directories is read as a
// library too, and an id found twice is refused.
// Modified by Circuit Center on 2026-10-07: a symbol's parents come from the
// library's own name map (resolveChain in kicad-symdir.mjs), not by reading
// `<parent>.kicad_sym`; items are sorted in code point order; a footprint
// item carries its unique pad count; a file declaring a format version newer
// than the engine's pinned fork reads is refused.
// Modified by Circuit Center on 2026-10-07: readLibTable reads the lib-table
// descriptions (KiCad's own sym-lib-table and fp-lib-table).
// Modified by Circuit Center on 2026-10-07: format ccl2 (PICKER.md): a symbol
// body is the symbol alone under its file's library header, never its extends
// chain (the engine links a derived symbol to its parent once the whole
// library has merged); the chain is still resolved, so a cycle or a missing
// parent is refused as before. Every item carries its search index row
// (search-index.mjs), with desc, keys and fp inherited down the chain.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { compareNames } from "./bundle.mjs";
import {
  assertForkReads as assertSymbolVersion,
  buildSelfContainedLib,
  childForms,
  decodeString,
  headAtoms,
  parseSymbolLib,
  resolveChain,
  rootForm,
} from "./kicad-symdir.mjs";
import { assertForkReads as assertFootprintVersion, countUniquePads, parseFootprintFile } from "./kicad-pretty.mjs";
import { footprintFacts, symbolFacts, symbolRow } from "./search-index.mjs";

/* ----------------------------------------------------- full-set extraction --
 * The CURATED extractAll above provisions a small example tree on disk. For the
 * demo CDN we instead want EVERY lib, in memory, to publish as r2-idb-sync
 * snapshots (see scripts/deploy/publish-libs.ts) — same per-item parse/extends
 * resolution, no on-disk serve tree.
 */

/** A nickname the mirror can store as a file name and name in SHA256SUMS. */
const NICKNAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

const SYMDIR = ".kicad_symdir";
const SYMFILE = ".kicad_sym";
const PRETTY = ".pretty";
const MOD = ".kicad_mod";

function readSymbol(file) {
  try {
    return parseSymbolLib(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${file}: ${err.message}`);
  }
}

/**
 * The lib-table descriptions: KiCad's `sym-lib-table` / `fp-lib-table`, as a
 * map of nickname to `descr` (an empty `descr` is left out). A missing file is
 * an empty map.
 */
export function readLibTable(file) {
  const out = new Map();
  if (!existsSync(file)) return out;
  const src = readFileSync(file, "utf8");
  const [open] = rootForm(src, ["sym_lib_table", "fp_lib_table"]);
  for (const [s] of childForms(src, open)) {
    if (headAtoms(src, s)[0]?.text !== "lib") continue;
    let name = null;
    let descr = null;
    for (const [fs] of childForms(src, s)) {
      const [key, value] = headAtoms(src, fs);
      if (!value) continue;
      const text = value.quoted ? decodeString(value.text) : value.text;
      if (key.text === "name") name = text;
      else if (key.text === "descr") descr = text;
    }
    if (name !== null && descr) out.set(name, descr);
  }
  return out;
}

/**
 * Every library under the sources: `<Nick>.kicad_symdir/` directories and
 * plain `<Nick>.kicad_sym` files under `symbolsSrc`, `<Nick>.pretty/`
 * directories under `footprintsSrc`. Sorted by id in code point order.
 */
export function listLibs({ symbolsSrc, footprintsSrc }) {
  const libs = [];
  const add = (kind, nick, where, layout) => {
    if (!NICKNAME.test(nick)) throw new Error(`the library nickname ${JSON.stringify(nick)} (${where}) is not one the mirror can store as a file name`);
    libs.push({ id: `${kind === "symbol" ? "sym" : "fp"}.${nick}`, nick, kind, path: where, layout });
  };
  if (symbolsSrc) {
    for (const name of readdirSync(symbolsSrc).sort(compareNames)) {
      const where = path.join(symbolsSrc, name);
      if (name.endsWith(SYMDIR) && statSync(where).isDirectory()) add("symbol", name.slice(0, -SYMDIR.length), where, "symdir");
      else if (name.endsWith(SYMFILE) && statSync(where).isFile()) add("symbol", name.slice(0, -SYMFILE.length), where, "symfile");
    }
  }
  if (footprintsSrc) {
    for (const name of readdirSync(footprintsSrc).sort(compareNames)) {
      const where = path.join(footprintsSrc, name);
      if (name.endsWith(PRETTY) && statSync(where).isDirectory()) add("footprint", name.slice(0, -PRETTY.length), where, "pretty");
    }
  }
  libs.sort((a, b) => compareNames(a.id, b.id));
  for (let i = 1; i < libs.length; i += 1) {
    if (libs[i - 1].id === libs[i].id) throw new Error(`${libs[i].id} is both ${libs[i - 1].path} and ${libs[i].path}`);
  }
  return libs;
}

/**
 * One library's items as { id, nick, kind, items: [{ name, body, row, pads? }] },
 * items sorted by name in code point order. A symbol body is a `kicad_symbol_lib`
 * holding the symbol alone under its file's header (format ccl2); a footprint
 * body is the `.kicad_mod` text, with its unique pad count beside it. `row` is
 * the item's search index row: sym-index.json's for a symbol, fp-search.json's
 * for a footprint.
 */
export function extractLib(lib) {
  const items = [];
  if (lib.kind === "symbol") {
    const files = lib.layout === "symdir"
      ? readdirSync(lib.path).filter((f) => f.endsWith(SYMFILE)).sort(compareNames).map((f) => path.join(lib.path, f))
      : [lib.path];
    const byName = new Map();
    for (const file of files) {
      const parsed = readSymbol(file);
      assertSymbolVersion(parsed.version, file);
      for (const sym of parsed.symbols) {
        if (byName.has(sym.name)) throw new Error(`${lib.id}: two symbols are named ${JSON.stringify(sym.name)}`);
        byName.set(sym.name, { ...sym, header: parsed.header });
      }
    }
    const facts = new Map();
    const factsOf = (sym) => {
      if (!facts.has(sym.name)) {
        try {
          facts.set(sym.name, symbolFacts(sym.block));
        } catch (err) {
          throw new Error(`${lib.id}: ${sym.name}: ${err.message}`);
        }
      }
      return facts.get(sym.name);
    };
    for (const sym of byName.values()) {
      let parents;
      try {
        parents = resolveChain(byName, sym);
      } catch (err) {
        throw new Error(`${lib.id}: ${err.message}`);
      }
      items.push({
        name: sym.name,
        body: buildSelfContainedLib(sym.header, [], sym.block),
        row: symbolRow(lib.nick, [...parents, sym].map(factsOf)),
      });
    }
  } else {
    for (const file of readdirSync(lib.path).filter((f) => f.endsWith(MOD)).sort(compareNames)) {
      const where = path.join(lib.path, file);
      const src = readFileSync(where, "utf8");
      let fp;
      let pads;
      let text;
      try {
        fp = parseFootprintFile(src, file.slice(0, -MOD.length));
        pads = countUniquePads(src);
        text = footprintFacts(src);
      } catch (err) {
        throw new Error(`${where}: ${err.message}`);
      }
      assertFootprintVersion(fp.version, where);
      items.push({ name: fp.name, body: fp.body, pads, row: [lib.nick, fp.name, text.desc, text.tags, pads] });
    }
  }
  items.sort((a, b) => compareNames(a.name, b.name));
  return { id: lib.id, nick: lib.nick, kind: lib.kind, items };
}
