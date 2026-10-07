/**
 * Parsing helpers for KiCad's footprint-library format (`.pretty` directories).
 *
 * A footprint library is a directory `<Name>.pretty/` holding one
 * `<Footprint>.kicad_mod` file per footprint; each file is a complete,
 * self-contained `(footprint "<Name>" …)` s-expr document — there is no
 * inheritance (unlike symbols' `extends`), so no parent-bundling step. The
 * library item name is the FILE name (without `.kicad_mod`), which is what
 * KiCad uses as the footprint's lib id.
 *
 * Like symbols, we don't need a full parser: a brace-matching scanner that
 * respects quoted strings (shared with `kicad-symdir`) is enough to walk the
 * footprint's direct children and read `(descr …)`, `(tags …)`, and `(model …)`.
 *
 * Ported from the closed ingest pipeline so the GPL reference backend can build
 * its own example-lib fixtures at dev time. The fork-version cap tracks the
 * WASM fork that lives in this same repo.
 */
// Copied from PCBJam (https://github.com/PCBJam/pcbjam) at tag v0.2.3, commit
// 7ec51c1c55aab45b21cd2956af413b4420520838, web/backend/src/extract/kicad-pretty.ts
// (GPL-3.0).
// Modified by Circuit Center on 2026-10-07: ported from TypeScript to a plain
// Node module for scripts/build-libs.mjs (LIBRARY.md).
// Modified by Circuit Center on 2026-10-07: the version cap is gone. The
// engine's pinned fork (PIN.json pcbjam.kicad, 48f1e86) reads footprints up
// to 20260206, which is what KiCad 10.0.4 writes, so the body is the
// .kicad_mod text unchanged; a newer version is refused at build time
// (assertForkReads) instead of rewritten. parseFootprintFile no longer reads
// descr, tags or model (the mirror does not carry them).
// Modified by Circuit Center on 2026-10-07: countUniquePads reads each pad's
// own head and its direct `(layers …)` child through the shared scanner,
// decodes a quoted number with KiCad's lexer rules, and takes a pad as copper
// exactly when one of its layer names is in the fork's copper set (F.Cu, B.Cu,
// In1.Cu to In30.Cu, *.Cu, *In.Cu, F&B.Cu), in place of a `.Cu` regex over the
// first `(layers` text found anywhere in the pad.

import { childForms, decodeStringBytes, formVersion, headAtoms, rootForm } from "./kicad-symdir.mjs";

/**
 * Max board/footprint file-format version the engine's pinned fork parses
 * (SEXPR_BOARD_FILE_VERSION in pcbnew/pcb_io/kicad_sexpr/pcb_io_kicad_sexpr.h
 * at the kicad-source-mirror commit PIN.json pcbjam.kicad names). A
 * `.kicad_mod` declaring a newer version is rejected by the engine with
 * FUTURE_FORMAT_ERROR, so the build refuses it. Bump alongside the engine pin.
 */
export const FORK_MAX_BOARD_VERSION = 20260206;

/** Refuse a footprint the engine's pinned fork would reject as a future format. */
export function assertForkReads(version, where) {
  if (version !== null && !(version <= FORK_MAX_BOARD_VERSION)) {
    throw new Error(`${where} declares footprint version ${version}, newer than the engine's pinned fork reads (${FORK_MAX_BOARD_VERSION})`);
  }
}

/** Find [start, end) of the top-level `(footprint …)` block (`module` before KiCad 6). */
function findTopFootprint(src) {
  return rootForm(src, ["footprint", "module"]);
}

/**
 * The layer names the fork's PCB parser maps onto a copper layer
 * (PCB_IO_KICAD_SEXPR_PARSER's m_layerMasks: LSET::Name of F_Cu, B_Cu and
 * In1_Cu to In30_Cu, plus the "*.Cu", "*In.Cu" and "F&B.Cu" wildcards). Any
 * other name maps to a non-copper layer or to Rescue.
 */
const COPPER_LAYER = /^(?:F|B|In(?:[1-9]|[12][0-9]|30)|\*|\*In|F&B)\.Cu$/;

/** An atom's text as KiCad's lexer hands it over (quoted strings decoded). */
const atomBytes = (atom) => (atom.quoted ? decodeStringBytes(atom.text) : Buffer.from(atom.text, "utf8"));

/**
 * Unique electrical pad count, mirroring the WASM fork's
 * `FOOTPRINT::GetUniquePadCount( DO_NOT_INCLUDE_NPTH )` (pcbnew/footprint.cpp,
 * `GetUniquePadNumbers`): count DISTINCT pad numbers, skipping pads that are
 * not on any copper layer, pads with an empty number ("mechanical" pads), and
 * NPTH pads. The symbol chooser's footprint selector filters on exactly this
 * value (`filterFootprints`, pcbnew.cpp), so the published index must agree
 * with what the editor would compute from the parsed footprint.
 */
export function countUniquePads(src) {
  const [open] = findTopFootprint(src);
  const numbers = new Set();

  for (const [ps] of childForms(src, open)) {
    // (pad "<number>" <type> <shape> …) — number quoted (modern) or bare (old).
    const head = headAtoms(src, ps);
    if (head[0]?.text !== "pad" || head[0].quoted || head.length < 3) continue;
    // parsePAD: SetNumber( FromUTF8() ) on the token the lexer decoded.
    const number = atomBytes(head[1]);
    // parsePAD: np_thru_hole is PAD_ATTRIB::NPTH.
    const type = head[2].text;
    // parsePAD: each (layers …) child replaces the pad's layer set (the last
    // one wins). With none, the pad keeps PAD's default PTH mask, which holds
    // every copper layer.
    let layers = null;
    for (const [ls] of childForms(src, ps)) {
      const atoms = headAtoms(src, ls);
      if (atoms[0]?.text === "layers" && !atoms[0].quoted) layers = atoms.slice(1);
    }
    const onCopper = layers === null || layers.some((a) => COPPER_LAYER.test(atomBytes(a).toString("utf8")));
    if (number.length !== 0 && type !== "np_thru_hole" && onCopper) {
      numbers.add(number.toString("latin1"));
    }
  }

  return numbers.size;
}

/**
 * Parse one `.kicad_mod` document. `name` is the file-derived item name. The
 * body is the file text unchanged; `version` is its declared format version.
 */
export function parseFootprintFile(src, name) {
  const [open] = findTopFootprint(src);
  return { name, version: formVersion(src, open), body: src };
}
