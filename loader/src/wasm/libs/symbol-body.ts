// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.

/**
 * A ccl2 symbol body is the symbol ALONE under its library header (LIBRARY.md,
 * PICKER.md section 1): the engine's fat list links every derived symbol to its
 * parent once the whole library has merged, so the bundle never repeats a
 * parent. A single-item read (`get`: the Already Placed list; the picker's
 * `lib.item` and `place`) is parsed and linked against only what it carries,
 * so it must be self-contained: this assembles the body KiCad's own
 * `buildSelfContainedLib` shape would, the `extends` chain root first and the
 * symbol last, in one `kicad_symbol_lib` under the symbol's own header.
 *
 * The scanner matches parentheses and skips quoted strings (a backslash
 * escapes the next character), the same rules as the builder's
 * `scripts/libs/kicad-symdir.mjs`; quoted names are decoded with KiCad's
 * lexer rules (DSNLEXER), so a name with an escape finds its item.
 */

/** One symbol body split: the header forms joined as the builder joins them, the symbol's block, its name and parent. */
export interface SymbolBodyParts {
  header: string;
  name: string;
  parent: string | null;
  block: string;
}

/** Index past the closing quote of a string whose opening quote is at `i - 1`. */
function endOfString(src: string, i: number): number {
  while (i < src.length) {
    const c = src.charCodeAt(i);
    if (c === 0x5c) {
      i += 2;
      continue;
    }
    if (c === 0x22) return i + 1;
    i++;
  }
  return -1;
}

/** Index past the `)` closing the list that opens at `open`, or -1 when it never closes. */
function endOfList(src: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const c = src.charCodeAt(i);
    if (c === 0x22) {
      i = endOfString(src, i + 1);
      if (i < 0) return -1;
      continue;
    }
    if (c === 0x28) depth++;
    else if (c === 0x29 && --depth === 0) return i + 1;
    i++;
  }
  return -1;
}

/** The direct child lists of the list opening at `open`, as [start, end) pairs; null when unbalanced. */
function childLists(src: string, open: number): Array<[number, number]> | null {
  const out: Array<[number, number]> = [];
  let i = open + 1;
  while (i < src.length) {
    const c = src.charCodeAt(i);
    if (c === 0x22) {
      i = endOfString(src, i + 1);
      if (i < 0) return null;
      continue;
    }
    if (c === 0x28) {
      const end = endOfList(src, i);
      if (end < 0) return null;
      out.push([i, end]);
      i = end;
      continue;
    }
    if (c === 0x29) return out;
    i++;
  }
  return null;
}

/** The first two atoms of the list opening at `open` (`(symbol "R"` gives symbol, R), quoted ones decoded. */
function headAtoms(src: string, open: number): string[] {
  const atoms: string[] = [];
  let i = open + 1;
  while (i < src.length && atoms.length < 2) {
    const c = src[i];
    if (c === "(" || c === ")") break;
    if (c === '"') {
      const end = endOfString(src, i + 1);
      if (end < 0) break;
      atoms.push(decodeKicadString(src.slice(i + 1, end - 1)));
      i = end;
      continue;
    }
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    let j = i;
    while (j < src.length && !' \t\n\r()"'.includes(src[j])) j++;
    atoms.push(src.slice(i, j));
    i = j;
  }
  return atoms;
}

const SIMPLE_ESCAPES: Record<string, number> = { '"': 0x22, "\\": 0x5c, a: 0x07, b: 0x08, f: 0x0c, n: 0x0a, r: 0x0d, t: 0x09, v: 0x0b };
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

/**
 * The inside of a quoted string as KiCad's lexer reads it (DSNLEXER::NextTok):
 * \" \\ \a \b \f \n \r \t \v, \x with one or two hex digits, one to three octal
 * digits; a goofed \x reads as x and a goofed octal escape as a backslash.
 * Escapes yield bytes, read back as UTF-8.
 */
export function decodeKicadString(raw: string): string {
  if (!raw.includes("\\")) return raw;
  const src = utf8.encode(raw);
  const out: number[] = [];
  const isHex = (b: number) => (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66);
  const isOct = (b: number) => b >= 0x30 && b <= 0x37;
  let i = 0;
  while (i < src.length) {
    const b = src[i];
    if (b !== 0x5c) {
      out.push(b);
      i++;
      continue;
    }
    i++;
    if (i >= src.length) break;
    const e = src[i++];
    const simple = SIMPLE_ESCAPES[String.fromCharCode(e)];
    if (simple !== undefined) {
      out.push(simple);
    } else if (e === 0x78) {
      let n = 0;
      while (n < 2 && i + n < src.length && isHex(src[i + n])) n++;
      out.push(n > 0 ? parseInt(String.fromCharCode(...src.subarray(i, i + n)), 16) : 0x78);
      i += n;
    } else {
      i--;
      let n = 0;
      while (n < 3 && i + n < src.length && isOct(src[i + n])) n++;
      out.push(n > 0 ? parseInt(String.fromCharCode(...src.subarray(i, i + n)), 8) & 0xff : 0x5c);
      i += n;
    }
  }
  return fromUtf8.decode(new Uint8Array(out));
}

/**
 * Split a ccl2 symbol body: `(kicad_symbol_lib <header forms> (symbol "NAME"
 * … (extends "PARENT") …))`. Null when the text is not one `kicad_symbol_lib`
 * holding exactly one top-level symbol.
 */
export function splitSymbolBody(text: string): SymbolBodyParts | null {
  const open = text.indexOf("(");
  if (open < 0 || headAtoms(text, open)[0] !== "kicad_symbol_lib") return null;
  const children = childLists(text, open);
  if (children === null) return null;
  const header: string[] = [];
  let found: SymbolBodyParts | null = null;
  for (const [s, e] of children) {
    const atoms = headAtoms(text, s);
    if (atoms[0] !== "symbol") {
      if (found === null) header.push(text.slice(s, e));
      continue;
    }
    if (found !== null || atoms[1] === undefined) return null;
    const block = text.slice(s, e);
    let parent: string | null = null;
    for (const [cs] of childLists(block, 0) ?? []) {
      const kid = headAtoms(block, cs);
      if (kid[0] === "extends" && kid[1] !== undefined) {
        parent = kid[1];
        break;
      }
    }
    found = { header: header.join("\n\t"), name: atoms[1], parent, block };
  }
  return found;
}

/**
 * The self-contained body of `name`: its own body when it extends nothing,
 * else its extends chain root first and the symbol last, each block read
 * from `bodyOf` (the same bundle), in one `kicad_symbol_lib` under the
 * symbol's own header (the shape `buildSelfContainedLib` writes, so a
 * derived symbol comes out byte for byte as a ccl1 bundle carried it). Null
 * when `bodyOf` has no `name`. A parent that is missing or unreadable, or a
 * cycle, gives the body as it is (the engine then reads the symbol without
 * its parent's drawing) and one log line.
 */
export function assembleSymbolBody(name: string, bodyOf: (name: string) => string | null, log: (msg: string) => void = () => undefined): string | null {
  const own = bodyOf(name);
  if (own === null) return null;
  // Most symbols extend nothing: no scan for them.
  if (!own.includes("(extends")) return own;
  const self = splitSymbolBody(own);
  if (self === null || self.parent === null) return own;
  const blocks = [self.block];
  const seen = new Set([name, self.name]);
  for (let parent: string | null = self.parent; parent !== null; ) {
    if (seen.has(parent)) {
      log(`[libs] ${name}: extends cycle at ${parent}; the body is given without its chain`);
      return own;
    }
    seen.add(parent);
    const text = bodyOf(parent);
    const parts = text === null ? null : splitSymbolBody(text);
    if (parts === null) {
      log(`[libs] ${name}: its parent ${parent} is ${text === null ? "not in the library" : "unreadable"}; the body is given without its chain`);
      return own;
    }
    blocks.unshift(parts.block);
    parent = parts.parent;
  }
  return `(kicad_symbol_lib\n\t${self.header}\n\t${blocks.join("\n\t")}\n)\n`;
}
