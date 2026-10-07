/**
 * Parsing helpers for KiCad's unpacked symbol-library format (KiCad 10+).
 *
 * A symbol library is a directory `<Name>.kicad_symdir/` holding one
 * `<Symbol>.kicad_sym` file per symbol; each file is a `(kicad_symbol_lib …)`
 * document wrapping exactly one top-level `(symbol "<Name>" …)`. A derived
 * symbol carries `(extends "<Parent>")`, with the parent in a sibling file —
 * so to serve a self-contained symbol we bundle the parent chain into one
 * `kicad_symbol_lib` document.
 *
 * We don't need a full s-expr parser: a brace-matching scanner that respects
 * quoted strings is enough to slice out balanced `(symbol …)` blocks and read
 * top-level `(property "X" "value")` / `(extends "Parent")` fields.
 *
 * Ported from the closed ingest pipeline so the GPL reference backend can build
 * its own example-lib fixtures at dev time (no closed repo needed). The
 * fork-version caps below track the WASM fork that lives in this same repo.
 */
// Copied from PCBJam (https://github.com/PCBJam/pcbjam) at tag v0.2.3, commit
// 7ec51c1c55aab45b21cd2956af413b4420520838, web/backend/src/extract/kicad-symdir.ts
// (GPL-3.0).
// Modified by Circuit Center on 2026-10-07: ported from TypeScript to a plain
// Node module for scripts/build-libs.mjs (LIBRARY.md); no logic is imported
// from PCBJam at run time.
// Modified by Circuit Center on 2026-10-07: parseSymbolFile became
// parseSymbolLib: it walks the root's direct children (a `(symbol "` inside a
// quoted header string is never taken for a symbol), returns every top-level
// symbol (a plain multi-symbol `<Name>.kicad_sym` library reads the same way)
// and the declared format version; the description, keyword and footprint
// filter fields were dropped (the mirror does not carry them).
// Modified by Circuit Center on 2026-10-07: quoted strings are decoded with
// KiCad's own lexer rules (common/dsnlexer.cpp at the engine's pinned KiCad
// commit), in place of the backslash-drops-only unescape.
// Modified by Circuit Center on 2026-10-07: the token stripping and version
// cap are gone. The engine's pinned fork (PIN.json pcbjam.kicad, 48f1e86)
// reads symbol libraries up to 20251024, which is what KiCad 10.0.4 writes, so
// the bodies stay KiCad's text unchanged; a library declaring a newer version
// is refused at build time (assertForkReads) instead of rewritten.
// Modified by Circuit Center on 2026-10-07: buildSelfContainedLib keeps every
// block verbatim (no re-indent), so a symbol with no extends comes out as its
// KiCad file byte for byte; resolveChain moved here from extract-libs.ts and
// reads parents from the library's own name map.

/** Skip from `i` (just after an opening quote) to the index past the close. */
export function endOfString(src, i) {
  // i points at the char after the opening `"`.
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      i += 2; // escaped char
      continue;
    }
    if (c === '"') return i + 1;
    i += 1;
  }
  return i;
}

/**
 * Return [start, end) of the balanced parenthesised block that begins at
 * `open` (which must index a `(`), respecting quoted strings.
 */
export function matchParen(src, open) {
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const c = src[i];
    if (c === '"') {
      i = endOfString(src, i + 1);
      continue;
    }
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return [open, i + 1];
    }
    i += 1;
  }
  throw new Error("unbalanced parentheses in s-expr");
}

/**
 * Every direct child list `(…)` of the list opening at `open`, as [start, end),
 * skipping the list's own atoms and quoted strings.
 */
export function* childForms(src, open) {
  let i = open + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '"') {
      i = endOfString(src, i + 1);
      continue;
    }
    if (c === "(") {
      const [s, e] = matchParen(src, i);
      yield [s, e];
      i = e;
      continue;
    }
    if (c === ")") return;
    i += 1;
  }
  throw new Error("unbalanced parentheses in s-expr");
}

/**
 * The leading atoms of the list opening at `open`, up to its first child list
 * or its close: `(pad "1" smd rect (at …` gives pad, 1, smd, rect. A quoted
 * atom is returned raw (between its quotes, undecoded) with `quoted: true`.
 */
export function headAtoms(src, open) {
  const atoms = [];
  let i = open + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === "(" || c === ")") return atoms;
    if (c === '"') {
      const end = endOfString(src, i + 1);
      atoms.push({ text: src.slice(i + 1, end - 1), quoted: true });
      i = end;
      continue;
    }
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i += 1;
      continue;
    }
    let j = i;
    while (j < src.length && !' \t\n\r()"'.includes(src[j])) j += 1;
    atoms.push({ text: src.slice(i, j), quoted: false });
    i = j;
  }
  return atoms;
}

/**
 * Decode the inside of a quoted string the way KiCad's lexer does
 * (DSNLEXER::NextTok, non-specctra mode): \" \\ \a \b \f \n \r \t \v, \x with
 * one or two hex digits, one to three octal digits; a goofed \x reads as x and
 * a goofed octal escape as a backslash. Escapes yield BYTES, so the result is
 * the decoded UTF-8 byte string.
 */
export function decodeStringBytes(raw) {
  const src = Buffer.from(raw, "utf8");
  const out = [];
  const isHex = (b) => (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66);
  const isOct = (b) => b >= 0x30 && b <= 0x37;
  let i = 0;
  while (i < src.length) {
    const b = src[i];
    if (b !== 0x5c) {
      out.push(b);
      i += 1;
      continue;
    }
    i += 1;
    if (i >= src.length) break; // the lexer throws on an unterminated string
    const e = src[i++];
    const simple = { 0x22: 0x22, 0x5c: 0x5c, 0x61: 0x07, 0x62: 0x08, 0x66: 0x0c, 0x6e: 0x0a, 0x72: 0x0d, 0x74: 0x09, 0x76: 0x0b }[e];
    if (simple !== undefined) {
      out.push(simple);
    } else if (e === 0x78) {
      let n = 0;
      while (n < 2 && i + n < src.length && isHex(src[i + n])) n += 1;
      out.push(n > 0 ? parseInt(src.subarray(i, i + n).toString("latin1"), 16) : 0x78);
      i += n;
    } else {
      i -= 1;
      let n = 0;
      while (n < 3 && i + n < src.length && isOct(src[i + n])) n += 1;
      out.push(n > 0 ? parseInt(src.subarray(i, i + n).toString("latin1"), 8) & 0xff : 0x5c);
      i += n;
    }
  }
  return Buffer.from(out);
}

/** {@link decodeStringBytes} read back as UTF-8 text. */
export function decodeString(raw) {
  return decodeStringBytes(raw).toString("utf8");
}

/** The [start, end) of the root list, checked to be `(<head> …`. */
export function rootForm(src, heads) {
  const open = src.indexOf("(");
  if (open < 0) throw new Error(`no (${heads[0]} …) found`);
  const head = headAtoms(src, open)[0];
  if (!head || head.quoted || !heads.includes(head.text)) {
    throw new Error(`the root is (${head ? head.text : ""} …), not (${heads[0]} …)`);
  }
  return matchParen(src, open);
}

/** The `(version N)` direct child of a list, as a number, or null. */
export function formVersion(src, open) {
  for (const [s] of childForms(src, open)) {
    const atoms = headAtoms(src, s);
    if (atoms[0]?.text === "version" && atoms[1] && !atoms[1].quoted) return Number(atoms[1].text);
  }
  return null;
}

/**
 * Max symbol-lib format version the engine's pinned fork parses
 * (SEXPR_SYMBOL_LIB_FILE_VERSION in eeschema/sch_file_versions.h at the
 * kicad-source-mirror commit PIN.json pcbjam.kicad names). A library declaring
 * a newer version is rejected by the engine with FUTURE_FORMAT_ERROR, so the
 * build refuses it. Bump alongside the engine pin.
 */
export const FORK_MAX_SYMBOL_LIB_VERSION = 20251024;

/** Direct child `(extends "Parent")` of a symbol block, or null. */
function topExtends(block) {
  for (const [s] of childForms(block, 0)) {
    const atoms = headAtoms(block, s);
    if (atoms[0]?.text === "extends" && atoms[1]) {
      return atoms[1].quoted ? decodeString(atoms[1].text) : atoms[1].text;
    }
  }
  return null;
}

/**
 * Parse one `.kicad_sym` document: its header (the root's child forms before
 * the first symbol, see {@link libHeader}), its declared version, and every
 * top-level symbol with its name, `extends` parent and verbatim block.
 */
export function parseSymbolLib(src) {
  const [open] = rootForm(src, ["kicad_symbol_lib"]);
  const symbols = [];
  for (const [s, e] of childForms(src, open)) {
    const atoms = headAtoms(src, s);
    if (atoms[0]?.text !== "symbol") continue;
    if (!atoms[1]) throw new Error("could not read symbol name");
    const block = src.slice(s, e);
    symbols.push({
      name: atoms[1].quoted ? decodeString(atoms[1].text) : atoms[1].text,
      extends: topExtends(block),
      block,
    });
  }
  if (symbols.length === 0) throw new Error("no (symbol …) found");
  return { header: libHeader(src), version: formVersion(src, open), symbols };
}

/** Extract just the `(kicad_symbol_lib …` header forms (version/generator). */
export function libHeader(src) {
  const [open] = rootForm(src, ["kicad_symbol_lib"]);
  // Collect child forms until the first (symbol …).
  const parts = [];
  for (const [s, e] of childForms(src, open)) {
    if (headAtoms(src, s)[0]?.text === "symbol") break;
    parts.push(src.slice(s, e));
  }
  return parts.join("\n\t");
}

/** Refuse a library the engine's pinned fork would reject as a future format. */
export function assertForkReads(version, where) {
  if (version !== null && !(version <= FORK_MAX_SYMBOL_LIB_VERSION)) {
    throw new Error(`${where} declares symbol library version ${version}, newer than the engine's pinned fork reads (${FORK_MAX_SYMBOL_LIB_VERSION})`);
  }
}

/**
 * A symbol's extends chain, root first, from the library's own symbols
 * (`byName`: name to parsed symbol). Refuses a cycle and a missing parent.
 */
export function resolveChain(byName, sym) {
  const chain = [];
  const seen = new Set([sym.name]);
  let cur = sym;
  while (cur.extends) {
    if (seen.has(cur.extends)) throw new Error(`extends cycle at ${cur.extends}`);
    seen.add(cur.extends);
    const parent = byName.get(cur.extends);
    if (!parent) throw new Error(`${cur.name} extends ${cur.extends}, which is not in the library`);
    chain.unshift(parent);
    cur = parent;
  }
  return chain;
}

/**
 * Build a self-contained `kicad_symbol_lib` document from a primary symbol and
 * its resolved parent chain. Parents are emitted before the derived symbol so
 * the on-device parser resolves `extends` within the single document.
 */
export function buildSelfContainedLib(header, parentBlocks, primaryBlock) {
  const body = [...parentBlocks, primaryBlock].join("\n\t");
  return `(kicad_symbol_lib\n\t${header}\n\t${body}\n)\n`;
}
