// Modified by Circuit Center on 2026-09-30: Tool is imported from the island's
// own types (no PCBJam package is imported).
// Modified by Circuit Center on 2026-09-30: the per-tool tables keep only the
// island's two tools (pcbnew, eeschema); the OCC and ngspice service bundles
// and the 3D model root and env vars are removed.
import type { Tool } from "../../../src/types";

/**
 * KiCad config/version dir baked into the WASM build. The File→Open dialog
 * starts in MEMFS_PROJECTS_DIR; we mirror each project under a subfolder of it.
 *
 * NOTE (spec §11.1): this path is KiCad-version dependent and confirmed by
 * tests/kicad/load-pcb-probe.spec.ts. If the build's version dir changes, this
 * must change too — a candidate for reading from the module at runtime later.
 * It MUST match KiCad's GetMajorMinorVersion() (== PATHS::GetUserSettingsPath()'s
 * version subdir); otherwise the seeded sym-lib-table/config is written to a dir
 * the WASM never reads and the symbol/footprint choosers come up empty. The
 * KiCad 10.0.4 rebase bumped this from "9.99" to "10.0".
 */
export const KICAD_VERSION_DIR = "10.0";
export const MEMFS_PROJECTS_DIR = `/home/kicad/documents/kicad/${KICAD_VERSION_DIR}/projects`;

/** Where KiCad expects images.tar.gz (compiled-in KICAD_DATA path). */
export const RESOURCE_PATH =
  "/workspace/build-wasm/sysroot/share/kicad/resources";

/**
 * argv[0] each tool's DEBUG check expects. These MUST match the values the
 * proven harness HTMLs set as `Module.thisProgram` (tests/apps/kicad/<tool>.html)
 * — notably the calculator binary is `pcb_calculator`, not `calculator`.
 */
export const TOOL_ARGV0: Record<Tool, string> = {
  pcbnew: "/usr/bin/pcbnew",
  eeschema: "/usr/bin/eeschema",
};

/**
 * A deployed WASM bundle (CDN folder + `<bundle>.{wasm,js}` basenames). NOT the same
 * space as `Tool`: since editor-unification Part 2 the four editor TOOLS (pcbnew,
 * eeschema, footprint_editor, symbol_editor) are all served by the ONE merged
 * `kicad_editor` bundle — two engines (kifaces) statically linked, the frame chosen
 * at runtime (`TOOL_FRAME`). Deliberately not part of the `TOOLS` enum: a bundle is
 * a delivery artifact, not a user-facing tool/route.
 */
export type Bundle =
  | "kicad_editor"
  | "calculator"
  | "pl_editor"
  | "gerbview";

/**
 * Which deployed WASM bundle actually backs each tool. The four editors share the
 * merged `kicad_editor` engine image (editor-unification Part 2); the remaining
 * tools are genuinely separate engines and back their own bundles. Used to resolve
 * the CDN asset folder and the `<bundle>.{wasm,js}` filenames.
 */
export const TOOL_BUNDLE: Record<Tool, Bundle> = {
  pcbnew: "kicad_editor",
  eeschema: "kicad_editor",
};

/**
 * The frame token passed to the WASM launcher via `Module.arguments`
 * (`--frame=<token>`, parsed in `kicad/common/single_top.cpp`) so a shared bundle
 * opens a specific editor frame. Tools whose bundle already defaults to the right
 * frame need no token (`undefined`). Tokens mirror `kicad/kicad.cpp`'s `--frame`
 * parser, plus `symedit` for the symbol editor (which upstream's CLI lacks).
 * The merged bundle's build-time default is the PCB editor, so every editor tool
 * passes its token explicitly (pcbnew included — cheap insurance over relying on
 * the default).
 */
export const TOOL_FRAME: Record<Tool, string | undefined> = {
  pcbnew: "pcb",
  eeschema: "sch",
};

/**
 * Every standalone tool here boots through common/single_top.cpp, which runs
 * STARTWIZARD::CheckAndRun() — the first-run "KiCad Setup" wizard. It shows
 * whenever any provider (SETTINGS / LIBRARIES / PRIVACY) reports
 * NeedsUserInput() — always true on our ephemeral MEMFS with no config, where
 * the wizard's modal loop is unsupported (nothing it writes survives a reload,
 * so it would re-run every boot). So for all of them we seed a default
 * KiCad config before main() (kicad_common.json privacy flags + the lib-tables
 * the providers check) so NeedsUserInput() is false and the wizard is skipped.
 */
export const TOOL_NEEDS_CONFIG_SEED: Record<Tool, boolean> = {
  pcbnew: true,
  eeschema: true,
};

/**
 * The library kind a tool PRIMARILY consumes — drives the IDB presync warm-up
 * (WasmTool) and which lib-table boot populates for single-engine bundles. The
 * merged kicad_editor bundle seeds BOTH tables regardless of this (cross-face
 * features like the symbol chooser's footprint selector read the other kind;
 * see `libKinds` in boot.ts) — only its presync stays per-frame. A user lib is
 * a kind-agnostic container, so the same lib id can land in both tables.
 * `null` = the tool uses no libraries.
 */
export const TOOL_LIB_KIND: Record<Tool, "symbol" | "footprint" | null> = {
  pcbnew: "footprint",
  eeschema: "symbol",
};

/** KiCad user settings dir for this build (PATHS::GetUserSettingsPath()). */
export const KICAD_CONFIG_DIR = `/home/kicad/.config/kicad/kicad/${KICAD_VERSION_DIR}`;

export function memfsProjectDir(slug: string): string {
  return `${MEMFS_PROJECTS_DIR}/${slug}`;
}

export function memfsFilePath(slug: string, relPath: string): string {
  return `${memfsProjectDir(slug)}/${relPath}`;
}
