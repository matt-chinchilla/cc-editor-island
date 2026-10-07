// Modified by Circuit Center on 2026-10-07: the island's place op builds its
// blob here from a body of the library mirror (bridge/responder.ts), so the
// file panel's parts are removed: the click-to-place path (the viewport, the
// grid snap, the canvas rect, the applyItems envelope), the picked-file types,
// kindForFile and symbolNames.
// Modified by Circuit Center on 2026-10-07: buildSymbolImport takes the item's
// body and the symbol's name, and a derived symbol is flattened onto its
// extends chain (flattenSymbol, as KiCad's LIB_SYMBOL::Flatten does): a
// schematic's lib_symbols takes no derived symbol, and a body holds its chain
// root first, so its first symbol is not the one asked for. The instance
// carries the library's fields at their library positions, as a chooser pick
// does, and the library's exclude_from_sim, in_bom and on_board.
// Modified by Circuit Center on 2026-10-07: buildFootprintImport names the
// footprint by its LIB_ID (nickname:name) and keeps the body's format version:
// the mirror's builder refuses a footprint newer than the pinned engine reads.
// Modified by Circuit Center on 2026-10-07: children skips quoted atoms between
// forms, so a name holding a parenthesis is never read as a form.
// Modified by Circuit Center on 2026-10-07: buildInteractiveImport takes the
// kind, the body, the library nickname and the item name.
/**
 * POC: drop a symbol (`.kicad_sym`) or footprint (`.kicad_mod`) picked from the
 * user's machine straight onto the open eeschema / pcbnew canvas.
 *
 * No new C++: both editors already expose the collab "items" apply bridge
 * (`Module.kicadCollabApplyItems`, wasm/bindings/{eeschema,pcbnew}_embind.cpp),
 * whose blobs go through the editors' own clipboard-paste parsers:
 *   - pcbnew accepts a BARE `(footprint …)` s-expr (makeFromBlob wraps it in a
 *     board envelope, remaps nets, commits it);
 *   - eeschema parses `(lib_symbols …) (symbol …)` clipboard dialect (LoadContent
 *     into a throwaway sheet) and re-links the instance to the blob's own
 *     lib_symbols entry — so a symbol from a library the editor has never seen
 *     can still be placed.
 * This file builds those blobs. Pure string work, unit-tested.
 */

/** Bridge surface the panel needs; every export is in the merged bundle. */
export interface ImportModule {
  kicadCollabApplyItems(json: string): unknown;
  kicadCollabGetViewport?: () => string;
  kicadOpenFileBusy?: () => boolean;
  /** Interactive placement (editor builds since 2026-09-15): the item hangs
   *  off the pointer like a chooser pick, the click commits it through the
   *  editor's own undo + collab path. Absent on older builds. */
  kicadPlaceImportedItem?: (sexpr: string) => string;
}

export function hasInteractivePlacement(
  mod: unknown,
): mod is ImportModule & { kicadPlaceImportedItem: (sexpr: string) => string } {
  return typeof (mod as Partial<ImportModule> | undefined)?.kicadPlaceImportedItem === "function";
}

export type ImportKind = "symbol" | "footprint";

const fmt = (n: number): string => String(Number(n.toFixed(4)));
const esc = (s: string): string => s.replace(/[\\"]/g, (c) => `\\${c}`);
const unesc = (s: string): string => s.replace(/\\(.)/g, "$1");

/** Skip from `i` (just after an opening quote) to the index past the close. */
function endOfString(src: string, i: number): number {
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === '"') return i + 1;
    i += 1;
  }
  return i;
}

/** [start, end) of the balanced form starting at `open` (a `(`), quote-aware. */
function matchParen(src: string, open: number): [number, number] {
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

/** The next `(` at or after `i` that opens a form, skipping quoted atoms; -1 past `end`. */
function nextForm(src: string, i: number, end: number): number {
  while (i < end) {
    const c = src[i];
    if (c === '"') {
      i = endOfString(src, i + 1);
      continue;
    }
    if (c === "(") return i;
    i += 1;
  }
  return -1;
}

/** Direct children of the outermost form. */
function* children(src: string): Generator<string> {
  const open = src.indexOf("(");
  if (open < 0) return;
  const [, outerEnd] = matchParen(src, open);
  let i = nextForm(src, open + 1, outerEnd - 1);
  while (i >= 0) {
    const [s, e] = matchParen(src, i);
    yield src.slice(s, e);
    i = nextForm(src, e, outerEnd - 1);
  }
}

/** `(property "Name" "Value" …)` direct children → name → value. */
function properties(form: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of children(form)) {
    const m = c.match(/^\(\s*property\s+"((?:[^"\\]|\\.)*)"\s+"((?:[^"\\]|\\.)*)"/);
    if (m) out.set(unesc(m[1]!), unesc(m[2]!));
  }
  return out;
}

/** The head token of a form: `symbol` for `(symbol "R" …)`. */
const headOf = (form: string): string => /^\(\s*([^\s()"]+)/.exec(form)?.[1] ?? "";
/** The first quoted atom right after a form's head (a symbol's or a property's name), unescaped. */
function nameOf(form: string): string | null {
  const m = /^\(\s*[^\s()"]+\s+"((?:[^"\\]|\\.)*)"/.exec(form);
  return m ? unesc(m[1]!) : null;
}
/** A property's value (its second quoted atom), unescaped. */
function valueOf(form: string): string | null {
  const m = /^\(\s*property\s+"(?:[^"\\]|\\.)*"\s+"((?:[^"\\]|\\.)*)"/.exec(form);
  return m ? unesc(m[1]!) : null;
}
/** The form with its first quoted atom (its name) replaced. */
const renamed = (form: string, name: string): string =>
  form.replace(/^(\(\s*[^\s()"]+\s+)"(?:[^"\\]|\\.)*"/, (_m, lead: string) => `${lead}"${esc(name)}"`);
/** A symbol's direct `(extends "Parent")`, or null. */
function extendsOf(block: string): string | null {
  for (const c of children(block)) if (headOf(c) === "extends") return nameOf(c);
  return null;
}
/** A symbol flag such as `(in_bom yes)`: true for yes, false for no, null when absent. */
function flagOf(block: string, token: string): boolean | null {
  for (const c of children(block)) {
    if (headOf(c) !== token) continue;
    const m = /^\(\s*[^\s()"]+\s+(yes|no)\s*\)$/.exec(c);
    return m ? m[1] === "yes" : null;
  }
  return null;
}

/**
 * The fields a derived symbol inherits when it leaves them empty (KiCad's
 * mandatory fields, and the keywords and footprint filters, which a library
 * file writes as `ki_` properties). Any other field the derived symbol has
 * replaces its parent's, empty or not; `ki_locked` is the parent's alone.
 */
const INHERITED_WHEN_EMPTY = new Set(["Reference", "Value", "Footprint", "Datasheet", "Description", "ki_keywords", "ki_fp_filters"]);
const PARENT_ONLY = new Set(["ki_locked"]);
/** Library-only properties: never a field of a placed symbol. */
const LIBRARY_ONLY = /^ki_/;

/**
 * One derived symbol laid over its parent, already flat: the parent's flags,
 * graphics and pins (its units renamed after the derived symbol, the unit
 * name's prefix KiCad checks), and the fields merged as above.
 */
function mergeDerived(parent: string, derived: string): string {
  const parentName = nameOf(parent) ?? "";
  const name = nameOf(derived) ?? "";
  const own = new Map<string, string>();
  for (const c of children(derived)) {
    if (headOf(c) !== "property") continue;
    const n = nameOf(c);
    if (n != null && !PARENT_ONLY.has(n)) own.set(n, c);
  }
  const out: string[] = [];
  let lastProperty = -1;
  for (const c of children(parent)) {
    const head = headOf(c);
    if (head === "property") {
      const n = nameOf(c);
      const mine = n == null ? undefined : own.get(n);
      if (n != null && mine !== undefined) {
        own.delete(n);
        out.push(INHERITED_WHEN_EMPTY.has(n) && (valueOf(mine) ?? "") === "" ? c : mine);
      } else out.push(c);
      lastProperty = out.length - 1;
    } else if (head === "symbol") {
      const unit = nameOf(c) ?? "";
      out.push(unit.startsWith(`${parentName}_`) ? renamed(c, name + unit.slice(parentName.length)) : c);
    } else if (head !== "extends") {
      out.push(c);
    }
  }
  // The derived symbol's own fields its parent lacks, after the parent's last field.
  const extra = [...own.entries()].filter(([n, f]) => !(INHERITED_WHEN_EMPTY.has(n) && (valueOf(f) ?? "") === "")).map(([, f]) => f);
  out.splice(lastProperty + 1, 0, ...extra);
  return `(symbol "${esc(name)}"\n\t${out.join("\n\t")}\n)`;
}

/**
 * The symbol `name` of a library body (a `kicad_symbol_lib` holding it and,
 * for a derived symbol, its extends chain), flattened: a plain symbol is
 * returned as its body has it, a derived one as KiCad's Flatten makes it,
 * root first. Throws when the symbol, or a parent of its chain, is missing.
 */
export function flattenSymbol(libText: string, name: string): string {
  const blocks = new Map<string, string>();
  for (const c of children(libText)) {
    if (headOf(c) !== "symbol") continue;
    const n = nameOf(c);
    if (n != null && !blocks.has(n)) blocks.set(n, c);
  }
  const block = blocks.get(name);
  if (block === undefined) throw new Error(`symbol "${name}" not found in the library body`);
  const chain = [block];
  const seen = new Set([name]);
  for (let parent = extendsOf(block); parent != null; parent = extendsOf(chain[chain.length - 1]!)) {
    if (seen.has(parent)) throw new Error(`symbol "${name}": its extends chain loops at "${parent}"`);
    const p = blocks.get(parent);
    if (p === undefined) throw new Error(`symbol "${name}": its parent "${parent}" is not in the library body`);
    seen.add(parent);
    chain.push(p);
  }
  let flat = chain[chain.length - 1]!;
  for (let i = chain.length - 2; i >= 0; i--) flat = mergeDerived(flat, chain[i]!);
  return flat;
}

/**
 * A library field as a placed symbol's field: the same name, value and
 * effects, at the library position moved to (x, y). A library position is
 * y-up and a sheet's y-down, as KiCad's parsers read them.
 */
function instanceField(field: string, x: number, y: number, value: string): string {
  const name = nameOf(field) ?? "";
  const rest: string[] = [];
  let at = `(at ${fmt(x)} ${fmt(y)} 0)`;
  for (const c of children(field)) {
    if (headOf(c) === "at") {
      const m = /^\(\s*at\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)(?:\s+(-?[\d.eE+-]+))?\s*\)$/.exec(c);
      if (m) at = `(at ${fmt(x + Number(m[1]))} ${fmt(y - Number(m[2]))} ${fmt(Number(m[3] ?? 0))})`;
    } else rest.push(c);
  }
  return `(property "${esc(name)}" "${esc(value)}" ${at}${rest.length > 0 ? ` ${rest.join(" ")}` : ""})`;
}

export interface SymbolImport {
  /** The blob for `kicadCollabApplyItems`. */
  sexpr: string;
  uuid: string;
  libId: string;
  reference: string;
}

/**
 * Build the eeschema clipboard-dialect blob that places `symbolName` from the
 * `.kicad_sym` text at (x, y) mm on the shown sheet. `libNick` is the nickname
 * the placed instance will reference (`Nick:Name`) — the file's basename by
 * default; it only has to be stable, the definition travels in the blob.
 */
export function buildSymbolImport(
  libText: string,
  symbolName: string,
  libNick: string,
  x: number,
  y: number,
  uuid: string = crypto.randomUUID(),
): SymbolImport {
  const name = symbolName;
  const block = flattenSymbol(libText, name); // the symbol alone, derived ones flattened

  const libId = `${libNick}:${name}`;
  // Schematic lib_symbols entries are keyed by the FULL lib id; sub-units keep
  // their short "Name_0_1" names (that is what a saved .kicad_sch looks like).
  const libEntry = renamed(block, libId);

  const props = properties(block);
  const refPrefix = props.get("Reference") || "U";
  const reference = refPrefix.endsWith("?") ? refPrefix : `${refPrefix}?`;
  const fields = [...children(block)].filter((c) => headOf(c) === "property" && !LIBRARY_ONLY.test(nameOf(c) ?? "ki_"));
  const field = (n: string): string | undefined => fields.find((c) => nameOf(c) === n);
  const placed = fields.map((c) => instanceField(c, x, y, nameOf(c) === "Reference" ? reference : (valueOf(c) ?? "")));
  // A body with no Reference or Value field still places an annotatable symbol.
  const font = "(effects (font (size 1.27 1.27)) (justify left))";
  if (field("Reference") === undefined) placed.unshift(`(property "Reference" "${esc(reference)}" (at ${fmt(x + 2.54)} ${fmt(y - 1.27)} 0) ${font})`);
  if (field("Value") === undefined) placed.push(`(property "Value" "${esc(name)}" (at ${fmt(x + 2.54)} ${fmt(y + 1.27)} 0) ${font})`);
  const yesNo = (b: boolean): string => (b ? "yes" : "no");

  const sexpr = [
    `(lib_symbols ${libEntry})`,
    `(symbol (lib_id "${esc(libId)}") (at ${fmt(x)} ${fmt(y)} 0) (unit 1)`,
    `  (exclude_from_sim ${yesNo(flagOf(block, "exclude_from_sim") ?? false)}) (in_bom ${yesNo(flagOf(block, "in_bom") ?? true)}) (on_board ${yesNo(flagOf(block, "on_board") ?? true)}) (dnp no)`,
    `  (uuid "${uuid}")`,
    ...placed.map((p) => `  ${p}`),
    `)`,
  ].join("\n");

  return { sexpr, uuid, libId, reference };
}

export interface FootprintImport {
  sexpr: string;
  name: string;
}

/**
 * Build the pcbnew blob that drops the `.kicad_mod` footprint at (x, y) mm on
 * the board: the library body itself with `(at x y)` added (a library
 * footprint has no position), named by its LIB_ID when `libNick` is given.
 */
export function buildFootprintImport(modText: string, x: number, y: number, libNick?: string): FootprintImport {
  const head = modText.match(/^\s*\(\s*footprint\s+"((?:[^"\\]|\\.)*)"/);
  if (!head) throw new Error("not a KiCad footprint file (expected `(footprint \"…\"`)");
  const name = unesc(head[1]!);

  // A placed footprint names its library: `(footprint "Nick:Name" …)`, as a board file has it.
  let body = libNick == null ? modText : modText.replace(/^(\s*\(\s*footprint\s+)"(?:[^"\\]|\\.)*"/, (_m, lead: string) => `${lead}"${esc(`${libNick}:${name}`)}"`);

  // Position goes right after the `(layer "…")` header form every .kicad_mod has;
  // the parser's footprint loop is token-order independent, this just keeps
  // the header shape a human expects. Replace an existing top-level `(at …)`.
  const at = `(at ${fmt(x)} ${fmt(y)})`;
  let placed = false;
  const parts: string[] = [];
  let cursor = 0;
  const open = body.indexOf("(");
  const [, outerEnd] = matchParen(body, open);
  let i = nextForm(body, open + 1, outerEnd - 1);
  while (i >= 0) {
    const [s, e] = matchParen(body, i);
    const form = body.slice(s, e);
    if (/^\(\s*at\b/.test(form)) {
      parts.push(body.slice(cursor, s), at);
      cursor = e;
      placed = true;
    } else if (!placed && /^\(\s*layer\b/.test(form)) {
      parts.push(body.slice(cursor, e), `\n\t${at}`);
      cursor = e;
      placed = true;
    }
    i = nextForm(body, e, outerEnd - 1);
  }
  parts.push(body.slice(cursor));
  body = parts.join("");
  if (!placed) body = body.replace(/^(\s*\(\s*footprint\s+"(?:[^"\\]|\\.)*")/, `$1\n\t${at}`);

  return { sexpr: body, name };
}

/**
 * Build the blob for `kicadPlaceImportedItem`: the same clipboard-dialect
 * text as the click-to-place path, but the position is a placeholder — the
 * editor's placement tool puts the item under the pointer and the click
 * decides where it lands. Returns the blob and a human label for the status.
 */
export function buildInteractiveImport(
  kind: ImportKind,
  body: string,
  libNick: string,
  name: string,
): { sexpr: string; label: string } {
  if (kind === "symbol") {
    const r = buildSymbolImport(body, name, libNick, 0, 0);
    return { sexpr: r.sexpr, label: r.libId };
  }
  const r = buildFootprintImport(body, 0, 0, libNick);
  return { sexpr: r.sexpr, label: `${libNick}:${r.name}` };
}
