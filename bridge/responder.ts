// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The island side of cc-editor/1 (PROTOCOL.md). Hello goes to the one
// parent origin; only the first connect from window.parent with our nonce
// is accepted; every request and its args pass a closed check; events carry
// exactly the keys PROTOCOL.md lists; the engine is reached only through
// the exports the loader's global.d.ts declares (Module) and MEMFS.
import { buildInteractiveImport } from '../loader/src/wasm/import-item';
import { registerSaveHook, SAVE_COMMITTED, type SaveHookHandle } from '../loader/src/wasm/save-flow';
import { parseBoot } from '../src/cc-config';
import { focusCanvas, focusCanvasQuietly, parseKeyPress, pressKey, type KeyPress } from '../src/keys';
import { installHostKeys, parseKeysClaim } from '../src/host-keys';
import { installPickKeys, kindOf, libIds, parseIndexArgs, parseItemArgs, parsePlaceArgs, parsePrefetchArgs, pickFor, takesText, warmLibrary, type KeyPick, type PickerLibs, type PickKind } from '../src/picker';
import { fileConflict, normalizePath, openStaged, PROJECT_ROOT, stageLocalSettings, stageProject, writeProjectFiles, type StagedProject } from '../src/stage';
import type { Frame } from '../src/types';
import { isProjectNick, MAX_PROJECT_LIBS, type ProjectLibrary, type ProjectLibs } from '../src/project-libs';
import { quietClear, quietFor, quietForever } from '../src/unload-quiet';
import { ALTIUM_PROJECT, ALTIUM_SHEET, closeDialog, dialogTitle, DOCUMENT_EXTENSION as EXT, driveImport, emptySheet, hasExtension, importable, importCall, importTarget } from './import';
import { dialogUp, dismissPopups, isProgressDialog, keysBlocked, visibleDialogs, watchMenus } from './modal';
import { BOARD_CHECK_DONE, BOARD_CHECK_EXPORTS, BOARD_CHECK_REPORT, BOARD_CHECK_ROOT, boardCheckJson, EXPLAIN_EXPORTS, parseBoardCheckArgs, parseExplainArgs, readBoardCheckDone, readDrcReport, readExplain, type BoardCheckArgs, type BoardCheckDone } from './boardCheck';
import { BOARD_ITEM_EXPORTS, boardItemSetJson, parseBoardItemGetArgs, parseBoardItemSetArgs, readBoardItems, setMisfit, showsBoardSet, type BoardItemSheet } from './boardItem';
import { CoordsChip, type CoordsWindow } from './coords';
import { BOARD_UPDATE_DONE, BOARD_UPDATE_EXPORTS, BOARD_UPDATE_REPORT, BOARD_UPDATE_ROOT, boardUpdateJson, parseBoardPreviewArgs, parseBoardUpdateArgs, previewAnswer, readBoardReport, readBoardUpdateDone, schematicBeside, updateAnswer, type BoardOptions, type BoardUpdateDone } from './boardUpdate';
import { HELD_EXPORT, HELD_KEYS_CAP, installHeld, type HeldWindow } from './held';
import { ANNOTATE_DONE, ANNOTATE_EXPORTS, ANNOTATE_ROOT, annotateJson, MAX_CHANGES, parseAnnotateArgs, readAnnotateDone, runNotes, runText, type AnnotateDone } from './annotate';
import { CHECK_DONE, CHECK_EXPORTS, CHECK_REPORT, CHECK_ROOT, readCheckDone, readCheckReport, type CheckDone } from './check';
import { MODEL_EXPORTS, modelsJson, parseModelsArgs, readModels, sameModels } from './models';
import REQUEST_OPS from './ops.json';
import { parsePlotArgs, plotFailure, plotJson, plotNotes, PLOT_DONE, PLOT_EXPORTS, PLOT_ROOT, readPlotDone, readPlotFolder, type PlotDone } from './plot';
import { placeBlob, PlacementWatch } from './place';
import { BOARD_PROPERTIES_CAP, BOARD_PROPERTIES_EXPORT, installProperties, PROPERTIES_CAP, PROPERTIES_EXPORT, type BoardPropertiesKind, type PropertiesWindow } from './properties';
import { misfit, parseSymbolGetArgs, parseSymbolSetArgs, readSymbolSheet, showsSet, SYMBOL_EXPORTS, symbolSetJson, type SymbolSheet } from './symbol';
import { parseSelectArgs, SELECT_EXPORTS, selectItems, SelectionFeed, type Selection, type SelectionWindow } from './selection';
import { installSymEditAsk, type SymEditAsk, type SymEditAskWindow } from './properties';
import {
  itemSetMisfit, makeToken, newJson, openJson, parseItemsAddArgs, parseItemsGetArgs, parseItemsRemoveArgs, parseItemsSetArgs, parseMarkSavedArgs,
  parseNewArgs, parseOpenArgs, parseShowArgs, parseSymbolSetArgs as parseSymEditSymbolSetArgs, readFindings, readItems, readSelection, readState,
  readSvgDone, readSymbolProps, readTaken, showsItemSet, showsSymbolSet, SVG_DONE, SVG_FILE, SVG_MAX_BYTES, SVG_ROOT, SYMEDIT_ASK_EXPORT,
  SYMEDIT_CAP, SYMEDIT_EXPORTS, SYMEDIT_HELD_CAP, type SymEditState, type SymItem,
} from './symedit';
import {
  CONVERT_CAP, CONVERT_EXPORTS, CONVERT_ROOT, LIB_UPDATE_CAP, LIB_UPDATE_EVENT, LIB_UPDATE_EXPORTS, parseConvertArgs, parseForEditorArgs,
  parseLibUpdateArgs, parsePushArgs, readConverted, readForEditor, readLibUpdateDone, readLibUpdateQueued, SYMBOL_EDIT_CAP, SYMBOL_EDIT_EXPORTS,
} from './symbolEdit';
import { FitWatch, sampleDrawing, settleView, surfaceKey } from './view';
import {
  commandOf, fftLines, MAX_VECTOR_BYTES, namesOf, parseCatalogArgs, parseFileArgs, parseModelGetArgs, parseModelSetArgs, parseNetlistArgs,
  parseOpOnSheetArgs, parseResultArgs, parseRunArgs, parseVectorsArgs, PROGRESS_MS, qualifiedVector, readAccepted, readCatalog,
  readCatalogEntry, readModelSheet, readNetlist, readSimDone, readSimFile, readSimResult, runJson, showsModelSet, SIM_ACCEPTED, SIM_CAP,
  SIM_DONE, SIM_FRAME_ONLY, SIM_MODEL_CAP, SIM_MODEL_EXPORTS, SIM_RESULT, SIM_ROOT, SIM_RUN_EXPORTS, splitVector, statPercent, vectorBytes,
  vectorsOf, type NetNames, type SimDone, type SimKind, type SimResult,
} from './sim';
import type { SimService } from '../src/sim-service';
import { ChromeWatch } from './chromeWatch';
import { EXPORT_DONE, EXPORT_EXPORTS, EXPORT_ROOT, exportFace, exportFailure, exportJson, parseExportArgs, readExportDone, readExportFolder, type ExportDone } from './export';
import { parseRulesArgs, readRules, RULES_EXPORTS, rulesJson } from './rules';
import {
  instanceKey, parseSymbolsGetArgs, parseSymbolsSetArgs, readRunError, readSymbolsRecord, readSymbolTable, symbolsGetJson, symbolsSetJson,
  SYMBOLS_DONE, SYMBOLS_ERRORS, SYMBOLS_EXPORTS, SYMBOLS_REPORT, SYMBOLS_ROOT, type RunError, type SymbolTable,
} from './symbols';
import {
  EXCHANGE_DONE, EXCHANGE_REPORT, EXCHANGE_ROOT, FOOTPRINT_EXCHANGE_EXPORTS, footprintExchangeJson, parseFootprintExchangeArgs,
  parseSymbolExchangeArgs, readExchangeReport, SYMBOL_EXCHANGE_EXPORTS, symbolExchangeJson,
} from './exchange';
import { BOARD_EDIT_EXPORTS, BOARD_OPS, EDIT_DONE, EDIT_ERRORS, EDIT_REPORT, EDIT_ROOT, editJson, parseEditArgs, readEditReport, SCH_EDIT_EXPORTS, SCH_OPS, type EditArgs } from './edit';
import { FOOTPRINTS_EXPORTS, readBoardFootprints } from './footprints';
import {
  parseSettingsGetArgs, parseSettingsSetArgs, PCB_READ_ONLY, readSection, readSettingsRecord, rulesPathOf, sectionFrames, SETTINGS_DONE,
  SETTINGS_ERRORS, SETTINGS_EXPORTS, SETTINGS_REPORT, SETTINGS_ROOT, settingsSetJson,
} from './settings';

declare const __ISLAND_ID__: string;   // define'd by vite.config.ts from PIN.json

export type IslandEvent =
  | { type: 'ev.state'; phase: string; detail?: string }
  | { type: 'ev.ready'; caps: string[]; engine: { tag: string; kicad: string } }
  | { type: 'ev.saved'; path: string; bytes: Uint8Array }
  | { type: 'ev.openTool'; frame: Frame }
  | { type: 'ev.help'; topic: string }
  | { type: 'ev.menu'; open: boolean }
  | { type: 'ev.chrome'; shown: boolean }
  | { type: 'ev.edited'; depth: number }
  | { type: 'ev.pick'; kind: PickKind; power?: true }
  | ({ type: 'ev.selected' } & Selection)
  | { type: 'ev.properties'; uuids: string[]; sheetPath: string; field?: string }
  | { type: 'ev.boardProperties'; uuid: string; kind: BoardPropertiesKind }
  | { type: 'ev.held'; action: string }
  | ({ type: 'ev.symedit' } & SymEditAsk)
  | { type: 'ev.key'; code: string; shift: boolean }
  | { type: 'ev.sim'; run: number; phase: SimPhase; percent?: number; code?: string }
  | { type: 'ev.closing' };

/** ev.sim's phases (PROTOCOL.md): the service loading, the run going, and its one end. */
export type SimPhase = 'loading' | 'running' | 'done' | 'stopped' | 'failed';

export interface Responder {
  emit(ev: IslandEvent): void;
  /**
   * The engine is up: ev.ready goes out. `libs` is what the picker's ops read
   * (src/libs.ts LibsChoice: the source boot chose, and the mirror when there
   * is one), null for none.
   */
  engineReady(win: ToolWindow, engine: { tag: string; kicad: string }, help: { attempts(): number }, libs?: PickerLibs | null): void;
  /** A request is in flight (received and not yet answered, an import included): the quiet warm-up waits. */
  busy(): boolean;
  /** A window.open the wrapper refused; after ev.ready each one is reported as ev.state popup. */
  popupBlocked(attempts: number): void;
  /**
   * The bridge's part of the teardown (the frame is going away): the save hook
   * stops, the leave prompt stays quiet, the port closes and nothing else is
   * answered or emitted. Idempotent.
   */
  close(): void;
}

/** An answer; `transfer` lists the buffers of fresh copies the result carries (project.plot's files). */
type Answer = { ok: true; result: Record<string, unknown>; transfer?: ArrayBuffer[] } | { ok: false; code: string; message: string };

/**
 * The engine window with the callback slots the fork calls: the save one
 * (save-flow.ts's SaveHookWindow), and the schematic editor's sheet pushes
 * (eeschema_embind.cpp): onSheetChanged(absPath) once KiCad shows another
 * sheet, onSheetsState(json) whenever the sheet panel's state is pushed.
 */
/** The engine's chrome report slot (pcbjam kicad_editor_embind.cpp reportChrome). */
type ChromeWindow = ToolWindow & { kicadChrome?: { onChange?: (shown: boolean) => void } };
type CollabWindow = ToolWindow & { kicadCollab?: { onSave?: (absPath: string) => void; onSheetChanged?: (absPath: string) => void; onSheetsState?: (json: string) => void } };
/** A project.import that passed its checks: the source, the files, and an Altium project's sheets and project file (sch frame). */
type CheckedImport = { w: ToolWindow; FS: EmscriptenFS; open: string; files: Array<{ path: string; bytes: Uint8Array }>; altium?: { project: string; sheets: string[] } };

/** MEMFS's errno for a busy directory (the engine's working directory). */
const EBUSY = 10;
/** MEMFS's errno for removing a directory that still holds an entry. */
const ENOTEMPTY = 55;
/** How long after a host-driven save the engine's leave prompt stays quiet (the host reloads the frame next). */
const SAVE_QUIET_MS = 10_000;
/** The one project slug: the save hook reports paths relative to memfsProjectDir(SLUG). */
const SLUG = 'cc';
/** The project folder every frame stages its project in (the island's own project slug under KiCad's projects folder). */
export const PROJECT_FOLDER = `${PROJECT_ROOT}/${SLUG}`;
const MAX_QUEUED = 256;
const MAX_FILES = 4096;
const MAX_NAME = 255;
/** project.import's format hint: a short string the island may ignore. */
const MAX_FORMAT = 64;
/** project.write's bound: the UTF-8 bytes of every text of one request together (32 MiB). */
export const MAX_WRITE_BYTES = 32 * 1024 * 1024;
/**
 * The bridge's waits, in ms: the bound on each engine call (so no call can
 * hold the serial request chain, shutdown included), the chrome watch that
 * runs on behind an open's answer (bridge/chromeWatch.ts; no answer waits for
 * it) and project.save's save-all. Measured on the local pair (2026-10-01): a Ctrl+S in the Glasgow
 * schematic reported its first file 20 to 160 ms after the key and its last
 * (four files, 1.3 MB) within 110 ms of the first. The unit tests shorten them.
 */
export const timing = {
  /** How long an engine call may take before it counts as unanswered (not_applied, save_failed, island_error). */
  applyMs: 30_000,
  /**
   * After an open, how long the chrome is watched for KiCad showing it again,
   * behind the answer, and how often it is read. Only for an engine that does
   * not hold its own hidden chrome (see settleChrome).
   */
  chromeSettleMs: 1_500,
  chromePollMs: 100,
  /** A save-all that reported no file by then failed (the key never reached the editor). */
  firstSaveMs: 8_000,
  /** Once every expected file is in, how long no further file may arrive. */
  saveSettleMs: 150,
  /** Without the full expected set, how long a pause ends the save-all. */
  saveQuietMs: 2_000,
  /** The save-all's ceiling, whatever arrives. */
  saveAllMs: 20_000,
  savePollMs: 25,
  /** After a save closed a popup menu, the pause before its key (the menu's opener resumes first). Unmeasured. */
  dismissMs: 100,
  /**
   * project.import (bridge/import.ts): the whole import's bound, from the open
   * call to the converted board's save; how often its dialogs are read; how long
   * nothing may show once the open resolved (the log report followed within
   * about 10 ms, spike 2026-10-02); the pause between two presses in one dialog;
   * how long the layer mapping may stay up after OK before it counts as refused;
   * and, on expiry, how long dialogs are closed before the answer.
   */
  importMs: 60_000,
  importPollMs: 100,
  importQuietMs: 500,
  importStepMs: 250,
  importRefusedMs: 2_000,
  importCloseMs: 5_000,
  /**
   * The view (bridge/view.ts): how often the drawing is read; how long its
   * size must hold before a fit (the host lays its page out again after an
   * import answers); how long an import waits for its fitted board to be
   * painted before it answers all the same (a large board's repaint took 4 s
   * of the main thread on the site, SwiftShader, 2026-10-02).
   */
  viewPollMs: 200,
  viewStableMs: 300,
  viewSettleMs: 10_000,
  /**
   * ev.edited (PROTOCOL.md): how often the open document's undo depth is read,
   * while no dialog is up, no load is parked and no request is in flight.
   */
  editPollMs: 500,
  /**
   * place (bridge/place.ts): how often the selection is read while the editor
   * takes the item (it held the item 50 to 125 ms after the call on the local
   * pair, 2026-10-07), and how long it may take before the request answers
   * busy; how often a hanging placement is read, and how long dropping one
   * before the next place may take.
   */
  placePollMs: 25,
  placeMs: 10_000,
  placeWatchMs: 100,
  placeCancelMs: 1_000,
  /**
   * sheet.enter with a file: how long each step waits for KiCad to show the
   * next sheet. The engine reported the switch 50 to 125 ms after the enter or
   * the key (Chromium and Firefox, local pair, 2026-10-15).
   */
  sheetStepMs: 5_000,
  /**
   * Selection (bridge/selection.ts): how long a selection must hold before
   * ev.selected sends it (a burst of emits is sent once); the reads after a
   * pointer or key release (at 0 ms, this, and three times this; PCBJam's own
   * feed reads at 0, 200 and 600 ms); and, for select, how often the selection
   * is read while the editor takes it and how long it may take. Unmeasured.
   */
  selectSettleMs: 150,
  selectPullMs: 200,
  selectPollMs: 25,
  selectMs: 2_000,
  /**
   * project.libs and footprint.models: how often the engine's apply queue is
   * read while their edit runs on it, how long project.libs may wait for its
   * libraries to load (measured 13 to 40 ms on Glasgow, 2026-10-27), and how
   * long footprint.models may wait for the model lines to read back.
   */
  applyPollMs: 10,
  libsMs: 10_000,
  modelsMs: 5_000,
  /**
   * project.plot: how long the plot may take, from the export's call to its
   * record in the folder (a 6-layer board with pours; Glasgow measured in
   * tests/e2e/plot.spec.ts). Its queue and record are read every applyPollMs.
   */
  plotMs: 120_000,
  /**
   * symbol.set: how long the symbol may take to read back as set, from the
   * export's call (one commit; measured about 210 ms on Glasgow,
   * tests/e2e/symbol.spec.ts). sheet.annotate and sheet.check: how long the
   * run may take to its record (the numbering 355 to 570 ms on Glasgow; the
   * check 15.6 to 21 s there in engine run 10, a debug build of KiCad's ERC).
   */
  symbolMs: 5_000,
  annotateMs: 60_000,
  checkMs: 60_000,
  /**
   * Engine run A (island v0.2.3-cc18): how long a board.check may take to its
   * record (five times gate 0's steady Glasgow time, at least 60 s, at most
   * 300 s: KiCad's own checker in this engine took 3.7 to 4.2 s on Glasgow
   * with the refill, 2.2 s without, gate 0 2026-11-10; the e2e's Glasgow check
   * 3.0 to 5.0 s), a board.item.set to read back (11 to 42 ms measured), and a
   * board.preview or board.update to its record (five times the slowest
   * measured case, at least 30 s, at most 120 s: Glasgow's first preview took
   * 0.9 s, tests/e2e/board-update.spec.ts).
   */
  boardCheckMs: 60_000,
  boardItemMs: 5_000,
  boardUpdateMs: 30_000,
  /**
   * The symbol editor (island v0.2.3-cc23): how long an open, a new symbol, a
   * change or a show may take to read back (the engine run's own probe:
   * STM32F405RGTx opened in 11 ms, a pin set in 34 ms); how long a symedit.svg
   * may take to its record; how long a symbol.push and a lib.update may take
   * in the schematic engine.
   */
  symeditMs: 5_000,
  svgMs: 30_000,
  symbolPushMs: 5_000,
  libUpdateMs: 30_000,
  /**
   * The simulator (island v0.2.3-cc23): how often a live run's folder is read
   * for its acceptance and its record; how long sim.run may wait for the run to
   * be accepted (the service's first load included: about 5 MB); how long after
   * the service's worker died the run's record may take before the island ends
   * the run itself; how long a sim.model.set and a sim.opOnSheet may take to
   * read back.
   */
  simPollMs: 50,
  simAcceptMs: 60_000,
  simDeathMs: 5_000,
  simModelMs: 5_000,
  /**
   * Outputs (island v0.2.3-cc23): how long a project.export may take, from the
   * export's call to its record in the folder (five times the slowest Glasgow
   * row measured, at least 30 s, at most 300 s: ODB++ of Glasgow took 6.0 to
   * 8.4 s over the local pair, tests/e2e/export.spec.ts, 2026-11-17).
   */
  exportMs: 45_000,
  /**
   * Properties, numbering and rules (island v0.2.3-cc23): how long a
   * symbols.set, a symbols.exchange or footprints.exchange, a sch.edit or
   * board.edit and a settings.set may take, from the export's call to its
   * record in the folder (five times the slowest case measured, at least 30 s,
   * at most 120 s: properties spec 6; tests/e2e/properties-rules.spec.ts).
   */
  symbolsMs: 30_000,
  exchangeMs: 30_000,
  editMs: 30_000,
  settingsMs: 30_000,
};
/** KiCad's Next Sheet (eeschema's PgDn, by virtual page number, the top-level sheets included). */
const NEXT_SHEET_KEY: KeyPress = { key: 'PageDown', code: 'PageDown', ctrl: false, shift: false, alt: false };
/** A sheet file's base name, as sheet.tree reports it. */
const SHEET_FILE_RE = /^[^/\0]{1,255}\.kicad_sch$/;
/** KiCad's Zoom to Fit. */
const HOME_KEY: KeyPress = { key: 'Home', code: 'Home', ctrl: false, shift: false, alt: false };
/** A real one of these in the frame is the reader steering the view: a fit no longer holds. */
const STEER_EVENTS = ['wheel', 'pointerdown', 'keydown'] as const;
/** KiCad's own Save (eeschema's Ctrl+S): every sheet of the schematic and the project file. */
const SAVE_KEY: KeyPress = { key: 's', code: 'KeyS', ctrl: true, shift: false, alt: false };
/** KiCad's window chrome as the element registry names it (measured with chrome.show on, 2026-10-01). */
const CHROME_RE = /^wx(MenuBar|AuiToolBar|ToolBar|StatusBar)$|InfoBar/i;
/**
 * The request ops this island answers, from bridge/ops.json: the one list, which
 * scripts/build.mjs also writes into island.json as `ops` (sorted), so a host
 * learns what a release answers before any engine boots.
 */
const OPS: ReadonlySet<string> = new Set(REQUEST_OPS);
/**
 * The picker's library reads: answered as they arrive, off the request queue
 * (they never touch the engine), so a read waiting on a bundle never holds up
 * a key.press, a view.fit or a place sent after it.
 */
const LIB_OPS = new Set(['lib.index', 'lib.item', 'lib.prefetch']);
/**
 * keys.claim: answered as it arrives, off the request queue as well (it changes
 * only which keys the frame hands to the host, never the engine), so a claim
 * is never held up by an import, a check or a slow save.
 */
const KEYS_CLAIM_OP = 'keys.claim';
/**
 * The pseudo-cap ev.ready lists for keys.claim and ev.key (island
 * v0.2.3-cc17): the op needs nothing of the engine, so every island that
 * knows it lists it. A host gates its claim on this word.
 */
export const HOST_KEYS_CAP = 'hostKeys';
/** The pseudo-cap ev.ready lists when the picker is available: the place op, ev.pick and a library mirror. */
export const PICKER_CAP = 'picker';
/**
 * The pseudo-cap ev.ready lists with `picker` when place takes `value` and
 * `footprint` (PICKER.md "What place puts down"). An older island's place
 * refuses them as bad_args, so a host gates them on this word.
 */
export const FIELDS_CAP = 'fields';
/**
 * The pseudo-cap ev.ready lists with `picker` and `fields` when place takes
 * `mpn` and `manufacturer` (PICKER.md "What place puts down"): written on the
 * placed symbol as its MPN and Manufacturer fields, hidden. An island that
 * lists `fields` alone refuses them as bad_args (its args are closed), so a
 * host gates them on this word.
 */
export const IDENTITY_CAP = 'identity';
/**
 * The pseudo-cap ev.ready lists when selection runs both ways: ev.selected is
 * armed (the engine's kicadCollabPresenceStart) and select has its exports.
 * Older islands list those exports too, so a host gates on this word.
 */
export const SELECTION_CAP = 'selection';
/**
 * The pseudo-cap ev.ready lists for project.write (island v0.2.3-cc10): the op
 * needs nothing of the engine but its file system, so every island that knows
 * the op lists it. A host gates its writes on this word.
 */
export const WRITE_CAP = 'write';
/**
 * The pseudo-cap ev.ready lists for project.libs (island v0.2.3-cc12): the
 * engine adds and reloads a library row at run time (kicadLibsAddEntry,
 * kicadLibsReload) and reports its apply queue (kicadCollabBusy). Every engine
 * since PCBJam v0.2.3 has those exports, so a host gates on this word.
 */
export const PROJECT_LIBS_CAP = 'projectLibs';
/** The engine exports project.libs needs. */
export const LIBS_EXPORTS = ['kicadLibsAddEntry', 'kicadLibsReload', 'kicadCollabBusy'] as const;
/**
 * The pseudo-cap ev.ready lists for footprint.models (island v0.2.3-cc12): the
 * engine has our kicadFootprintSetModels (pcbjam cc/main 466a85a) and the read
 * back. An island on an engine without it lists no `models`.
 */
export const MODELS_CAP = 'models';
/**
 * The pseudo-cap ev.ready lists for project.plot (island v0.2.3-cc13): the
 * engine has our kicadPlotBoard (pcbjam cc/main 924d67c; engine run 8) and the
 * apply queue probe, in either frame's kind (a sch frame answers unsupported).
 */
export const PLOT_CAP = 'plot';
/**
 * The pseudo-caps ev.ready lists for the Editing window's ops (island
 * v0.2.3-cc15), in either frame's kind (a pcb frame answers unsupported):
 * `symbol` for symbol.get and symbol.set (our engine's kicadSymbolGet and
 * kicadSymbolSet, pcbjam cc/main e8b2abe; engine run 10), `annotate` for
 * sheet.annotate (kicadAnnotate) and `check` for sheet.check (kicadCheckSheet),
 * each with the apply queue probe.
 */
export const SYMBOL_CAP = 'symbol';
export const ANNOTATE_CAP = 'annotate';
export const CHECK_CAP = 'check';
/**
 * The pseudo-caps ev.ready lists for engine run A's ops (island
 * v0.2.3-cc18), in either frame's kind (a sch frame answers the board ops
 * unsupported): `boardUpdate` for board.preview and board.update (our
 * engine's kicadUpdateBoardFromSchematic), `drc` for board.check
 * (kicadCheckBoard), `explain` for board.explain (kicadExplainViolation),
 * `boardItem` for board.item.get and board.item.set (kicadBoardItemGet and
 * kicadBoardItemSet), the board's ops with the apply queue probe;
 * `boardProperties` (bridge/properties.ts) and `heldKeys` (bridge/held.ts)
 * from the engine's markers.
 */
export const BOARD_UPDATE_CAP = 'boardUpdate';
export const DRC_CAP = 'drc';
export const EXPLAIN_CAP = 'explain';
export const BOARD_ITEM_CAP = 'boardItem';
/**
 * The pseudo-caps ev.ready lists for the outputs (island v0.2.3-cc23):
 * `export` for project.export (the frame's own kind's export,
 * kicadExportBoardOutput in a pcb frame or kicadExportSchematicOutput in a sch
 * frame, with the apply queue probe; engine run 14), `rules` for board.rules
 * (kicadResolveRules, in either frame's kind: a sch frame answers it
 * unsupported). A symedit frame lists neither.
 */
export const EXPORT_CAP = 'export';
export const RULES_CAP = 'rules';
/**
 * The pseudo-caps ev.ready lists for properties, numbering and rules (island
 * v0.2.3-cc23, engine run 14), each in its own frame's kind only, with the
 * apply queue probe: a sch frame `symbols` (symbols.get and symbols.set,
 * kicadSymbolsGet and kicadSymbolsSet), `symbolExchange` (symbols.exchange,
 * kicadSymbolsExchange) and `schEdit` (sch.edit, kicadSchEdit); a pcb frame
 * `boardFootprints` (board.footprints, kicadBoardFootprints), `boardEdit`
 * (board.edit, kicadBoardEdit) and `footprintExchange` (footprints.exchange,
 * kicadFootprintsExchange); either `settings` (settings.get and settings.set,
 * kicadSettingsGet and kicadSettingsSet). A symedit frame lists none.
 */
export const SYMBOLS_CAP = 'symbols';
export const SYMBOL_EXCHANGE_CAP = 'symbolExchange';
export const SCH_EDIT_CAP = 'schEdit';
export const BOARD_FOOTPRINTS_CAP = 'boardFootprints';
export const BOARD_EDIT_CAP = 'boardEdit';
export const FOOTPRINT_EXCHANGE_CAP = 'footprintExchange';
export const SETTINGS_CAP = 'settings';
/** What a board op answers in a sch frame. */
const BOARD_FRAME_ONLY = 'a board op runs in a pcb frame';
/** What a symbol editor op answers in a sch or a pcb frame. */
const SYMEDIT_FRAME_ONLY = 'a symbol edits in a symedit frame';
/**
 * The ops a symedit frame answers unsupported, whatever their args: it opens
 * symbols, never a document, so nothing that reads, saves or edits one runs
 * there. Every other op (project.write, project.libs, project.forget, the
 * library reads, key.press, keys.claim, chrome.show, readonly, view.fit,
 * select, shutdown and its own) runs as in any frame.
 */
const SYMEDIT_REFUSES: ReadonlySet<string> = new Set([
  'project.open', 'project.import', 'project.save', 'sheet.tree', 'sheet.enter', 'layers.get', 'layers.visible', 'layers.active',
  'place', 'footprint.models', 'project.plot', 'symbol.get', 'symbol.set', 'symbol.forEditor', 'symbol.push', 'lib.update',
  'sheet.annotate', 'sheet.check', 'board.preview', 'board.update', 'board.check', 'board.explain', 'board.item.get', 'board.item.set',
  'project.export', 'board.rules',
  'symbols.get', 'symbols.set', 'symbols.exchange', 'sch.edit', 'board.footprints', 'board.edit', 'footprints.exchange', 'settings.get', 'settings.set',
]);
const SYMEDIT_REFUSAL = 'a symbol editor opens symbols, not documents';
/**
 * While a sheet.check or a board.check runs (its run holds the editor for
 * seconds: KiCad's checker on the apply coroutine), every op that would change
 * the document, its view or the editor's state answers busy at once instead of
 * queueing behind it. Only these still run: the reads, and shutdown.
 */
const CHECK_PASSES: ReadonlySet<string> = new Set([
  'symbol.get', 'sheet.tree', 'layers.get', 'board.item.get', 'board.explain', 'board.rules', 'symbols.get', 'board.footprints', 'settings.get', 'shutdown',
]);
/** A wx top-level window: the editor's own frame, or another window of KiCad's (its footprint chooser is a frame, not a dialog). */
const FRAME_TYPE_RE = /Frame/;
/**
 * The document kind a frame holds, lowercased: project.write refuses every
 * file of it (open_document), compared in any case. A sch frame holds the
 * whole sheet hierarchy, so every sheet; a pcb frame its board.
 */
const OWN_DOCUMENT: Readonly<Record<Frame, string | null>> = { sch: '.kicad_sch', pcb: '.kicad_pcb', symedit: null };
/** A sheet path as the engine reports it: "/" then one UUID and a slash per level. */
const SHEET_PATH_RE = /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/)*$/;

const popupNote = (n: number): string => `${n} popup attempts blocked`;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(o).every((k) => allowed.includes(k));
const ok = (result: Record<string, unknown> = {}): Answer => ({ ok: true, result });
const fail = (code: string, message: string): Answer => ({ ok: false, code, message });
/** A request with no args: absent, or an empty object. */
const noArgs = (args: unknown): boolean => args === undefined || (isObj(args) && Object.keys(args).length === 0);
/** A KiCad layer id: an integer 0 to 127. */
const isLayerId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 127;
/** The last segment of a MEMFS path: the engine's absolute paths never leave the frame. */
const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** A text cut to `max` code points. */
const cut = (s: string, max: number): string => (s.length <= max ? s : [...s].slice(0, max).join(''));

function randomNonce(): string {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (x) => x.toString(16).padStart(2, '0')).join('');
}

function withTimeout<T>(value: T | Promise<T>, ms: number): Promise<T | 'timeout'> {
  return Promise.race([Promise.resolve(value), new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))]);
}

/**
 * Removes everything under a MEMFS directory, then the directory itself when
 * MEMFS allows it. KiCad changes into the opened project's folder (or the
 * subfolder of it the opened file sits in), and MEMFS refuses to remove its
 * working directory (EBUSY); that folder stays, empty, and so does each folder
 * above it, which then refuses with ENOTEMPTY. Answers whether such a busy
 * folder was kept at or below `dir`; any other MEMFS failure is thrown.
 */
function removeTree(FS: EmscriptenFS, dir: string): boolean {
  if (!FS.analyzePath(dir).exists) return false;
  let keptBusy = false;
  for (const name of FS.readdir(dir)) {
    if (name === '.' || name === '..') continue;
    const p = `${dir}/${name}`;
    if (FS.isDir(FS.stat(p).mode)) keptBusy = removeTree(FS, p) || keptBusy; else FS.unlink(p);
  }
  try {
    FS.rmdir(dir);
  } catch (err) {
    const errno = isObj(err) ? err.errno : undefined;
    if (errno === EBUSY) return true;
    // Not empty only because a busy folder below it was kept: that is expected.
    if (errno === ENOTEMPTY && keptBusy) return true;
    throw err;
  }
  return keptBusy;
}

/**
 * A thrown value as an island_error message. MEMFS throws ErrnoError objects
 * that are not Errors (name "ErrnoError", a numeric errno, sometimes a code);
 * they read as "<code or name> errno <n>" rather than "[object Object]".
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (isObj(err) && typeof err.errno === 'number') {
    const label = typeof err.code === 'string' && err.code !== '' ? err.code : typeof err.name === 'string' && err.name !== '' ? err.name : null;
    return label == null ? `errno ${err.errno}` : `${label} errno ${err.errno}`;
  }
  return String(err);
}

/** A MEMFS file's bytes, or null when it is absent or unreadable. */
function readBytes(FS: EmscriptenFS, abs: string): Uint8Array | null {
  try {
    if (!FS.analyzePath(abs).exists) return null;
    const b = FS.readFile(abs, { encoding: 'binary' });
    return b instanceof Uint8Array ? b : null;
  } catch { return null; }
}

/** The file KiCad should open when the host names none: the project's root sheet or board. */
function defaultOpen(written: string[], frame: Frame): string | undefined {
  const pro = written.find((p) => p.endsWith('.kicad_pro'));
  if (pro != null) {
    const twin = `${pro.slice(0, -'.kicad_pro'.length)}${EXT[frame]}`;
    if (written.includes(twin)) return twin;
  }
  return written.find((p) => p.endsWith(EXT[frame]));
}

export function startResponder(opts: {
  parentOrigin: string;
  page: Window;
  /** The engine's teardown, run by the shutdown op before it answers (src/teardown.ts). */
  onShutdown?: () => Promise<void>;
  /**
   * An import's engine call stopped the engine (a trap, bridge/import.ts
   * isEngineTrap): called once, after that import's answer went out, with the
   * answer's message. src/main.ts shows the fatal screen and emits NO ev.state
   * fatal (src/fatal.ts importStopped): the answer and the not_ready gate tell the
   * host, and a host mid hand-off must not be interrupted.
   */
  onEngineStopped?: (why: string) => void;
  /**
   * The frame's project libraries (src/project-libs.ts), served from the
   * project folder by the source boot was given: project.libs registers them,
   * lib.item and place read them first. Without it project.libs is unsupported.
   */
  projectLibs?: ProjectLibs;
  /**
   * The simulator service (src/sim-service.ts), installed when the island
   * serves its files: sim.run needs it, sim.vectors reads it, sim.release ends
   * its worker. Without it the runs are unsupported.
   */
  sim?: SimService | null;
}): Responder {
  const { parentOrigin, page, onShutdown, onEngineStopped, projectLibs } = opts;
  const simService = opts.sim ?? null;
  const nonce = randomNonce();
  const root = PROJECT_FOLDER;
  let port: MessagePort | null = null;
  let chain: Promise<void> = Promise.resolve();
  const queued: IslandEvent[] = [];
  let win: ToolWindow | null = null;
  const frame: Frame = parseBoot(page.location.search).frame;
  let staged: StagedProject | null = null;
  let opened: string | null = null;
  /**
   * The display settings the island staged beside the document (src/stage.ts
   * stageLocalSettings): engine state, not the design, so a save of it is never
   * reported. Null when the host sent its own.
   */
  let displaySettings: string | null = null;
  /** The Ctrl+S hook: live only between a successful project.open and the next open or forget. */
  let saveHook: { handle: SaveHookHandle; filter: (absPath: string) => void } | null = null;
  /**
   * Whether KiCad's chrome is meant to show. The frame boots with it hidden
   * (src/main.ts, spec D16); chrome.show changes it for this boot.
   */
  let chromeOn = false;
  /** Reads the engine's chrome state and sends ev.chrome when it differs from the last one sent; set by engineReady. */
  let chromeSay: (() => void) | null = null;
  /** The chrome watch running now was started by the import running now (settleChrome); false once another import starts. */
  let watchOfImport = false;

  /** While a host save-all runs: every path its ev.saved carried, in order, with when it arrived. */
  let collecting: Array<{ path: string; at: number }> | null = null;
  /** Stops the popup menu and dialog watch (ev.menu); set by engineReady. */
  let stopMenus: (() => void) | null = null;
  /** The pointer's place, printed bottom left over the drawing (bridge/coords.ts); set by engineReady. */
  let coords: CoordsChip | null = null;
  /** Keeps a fitted view fitted until the reader steers (bridge/view.ts); set by engineReady. */
  let fitWatch: FitWatch | null = null;
  /** Stops the fit watch's reads and its steering listeners; set by engineReady. */
  let stopFitWatch: (() => void) | null = null;

  /** Set by the shutdown op or close(): from then on nothing is answered or emitted. */
  let closed = false;
  /**
   * Why the engine stopped (an import's call trapped): from then on every
   * request but shutdown and the library reads answers not_ready at once, and
   * nothing enters the engine. Null while it runs.
   */
  let stopped: string | null = null;
  /** onEngineStopped was called (once). */
  let stopSignaled = false;
  /** A project.import is running: every request but shutdown answers busy until it answers. */
  let importing = false;
  /** A sheet.check is running: every op that would change the document answers busy until it answers (CHECK_PASSES). */
  let checking = false;
  /** A shutdown request passed its checks: the port closes once it is answered. */
  let shutdownStarted = false;
  /** Requests received and not yet answered: the chain's queue and the one it runs (ev.edited reads nothing meanwhile). */
  let inFlight = 0;
  /**
   * ev.edited's last value: the open document's undo depth as last read, or
   * null until the first read after an open, an import or a forget. That first
   * read is the baseline and is never sent: opening a document is no edit.
   */
  let editDepth: number | null = null;
  /** Stops the undo depth poll (ev.edited); set by engineReady when the engine has the export. */
  let stopEdits: (() => void) | null = null;
  /** The libraries the picker's ops read (the source boot chose, and the mirror when there is one); set by engineReady. */
  let libs: PickerLibs | null = null;
  /** Library nicknames to the source's ids (src/picker.ts libIds). */
  let idOf: ((kind: PickKind, nick: string) => Promise<string | null>) | null = null;
  /** The placement the place op started, watched until it is committed or canceled (bridge/place.ts). */
  let placeWatch: PlacementWatch | null = null;
  /** ev.selected's source, the engine's selection hook (bridge/selection.ts); set by engineReady. */
  let selectionFeed: SelectionFeed | null = null;
  /** The names of the editor's own frames, read at ev.ready: any other visible frame is another window of KiCad's. */
  let ownFrames = new Set<string>();
  /**
   * The picker is available (ev.ready's `picker` cap): the island has a
   * library mirror and the engine places items. Without it the place keys
   * stay KiCad's and no ev.pick is sent. Set by engineReady.
   */
  let pickerOn = false;
  /**
   * The base name of the file of the sheet KiCad shows, read while a document
   * is open (`opened`): the root when the document opens or is imported (KiCad
   * shows it first), then each sheet KiCad reports showing (onSheetChanged).
   * KiCad 10 reports every top-level sheet at the path "/": this tells them apart.
   */
  let sheetFile: string | null = null;
  /** The sheet pushes counted so far, and the waits for the next switch. */
  let sheetChanges = 0;
  let sheetStates = 0;
  const sheetWaiters = new Set<() => void>();

  /** Rebuilds each event with exactly its protocol keys; saved bytes travel as a transferred copy. */
  const emit = (ev: IslandEvent): void => {
    if (closed) return;
    if (port == null) {
      if (queued.length >= MAX_QUEUED) queued.shift();
      queued.push(ev);
      return;
    }
    switch (ev.type) {
      case 'ev.state':
        port.postMessage(typeof ev.detail === 'string' ? { type: ev.type, phase: ev.phase, detail: ev.detail } : { type: ev.type, phase: ev.phase });
        return;
      case 'ev.ready':
        port.postMessage({ type: ev.type, caps: [...ev.caps], engine: { tag: ev.engine.tag, kicad: ev.engine.kicad } });
        return;
      case 'ev.saved': {
        const bytes = ev.bytes.slice();   // never detach a buffer the engine or the save hook still holds
        port.postMessage({ type: ev.type, path: ev.path, bytes }, [bytes.buffer]);
        return;
      }
      case 'ev.openTool':
        port.postMessage({ type: ev.type, frame: ev.frame });
        return;
      case 'ev.help':
        port.postMessage({ type: ev.type, topic: ev.topic });
        return;
      case 'ev.menu':
        port.postMessage({ type: ev.type, open: ev.open });
        return;
      case 'ev.chrome':
        port.postMessage({ type: ev.type, shown: ev.shown });
        return;
      case 'ev.edited':
        port.postMessage({ type: ev.type, depth: ev.depth });
        return;
      case 'ev.pick':
        port.postMessage(ev.power === true ? { type: ev.type, kind: ev.kind, power: true } : { type: ev.type, kind: ev.kind });
        return;
      case 'ev.selected':
        port.postMessage({ type: ev.type, uuids: [...ev.uuids], fpPaths: [...ev.fpPaths] });
        return;
      case 'ev.properties':
        port.postMessage(typeof ev.field === 'string'
          ? { type: ev.type, uuids: [...ev.uuids], sheetPath: ev.sheetPath, field: ev.field }
          : { type: ev.type, uuids: [...ev.uuids], sheetPath: ev.sheetPath });
        return;
      case 'ev.boardProperties':
        port.postMessage({ type: ev.type, uuid: ev.uuid, kind: ev.kind });
        return;
      case 'ev.held':
        port.postMessage({ type: ev.type, action: ev.action });
        return;
      case 'ev.symedit':
        port.postMessage({ type: ev.type, ask: ev.ask, uuid: ev.uuid, isNew: ev.isNew });
        return;
      case 'ev.key':
        port.postMessage({ type: ev.type, code: ev.code, shift: ev.shift });
        return;
      case 'ev.sim': {
        const out: Record<string, unknown> = { type: ev.type, run: ev.run, phase: ev.phase };
        if (typeof ev.percent === 'number') out.percent = ev.percent;
        if (typeof ev.code === 'string') out.code = ev.code;
        port.postMessage(out);
        return;
      }
      case 'ev.closing':
        port.postMessage({ type: ev.type });
        return;
    }
  };

  const reply = (id: number, a: Answer): void => {
    if (closed) return;
    if (a.ok && a.transfer != null) port?.postMessage({ id, ok: true, result: a.result }, a.transfer);
    else port?.postMessage(a.ok ? { id, ok: true, result: a.result } : { id, ok: false, error: { code: a.code, message: a.message } });
  };

  const onConnect = (e: MessageEvent): void => {
    if (closed || port != null || e.origin !== parentOrigin || e.source !== page.parent) return;
    const d: unknown = e.data;
    if (!isObj(d) || !onlyKeys(d, ['type', 'nonce']) || d.type !== 'cc.connect' || d.nonce !== nonce) return;
    const p = e.ports?.[0];
    if (p == null) return;
    port = p;
    page.removeEventListener('message', onConnect);
    port.onmessage = (m) => {
      // The library reads skip the queue: they are answered when their read
      // is, whatever runs on the queue (an import, a slow save, a place).
      if (isLibRead(m.data)) {
        void handleLib(m.data).catch((err: unknown) => answerIslandError(m.data, err));
        return;
      }
      // So does a key claim: it is answered at once, whatever runs on the queue.
      if (isKeysClaim(m.data)) {
        try { keysClaim(m.data); } catch (err) { answerIslandError(m.data, err); }
        return;
      }
      // And sim.stop and sim.release: Stop never waits behind a request.
      if (isSimNow(m.data)) {
        try { simNow(m.data); } catch (err) { answerIslandError(m.data, err); }
        return;
      }
      // A handler that rejects answers island_error for its own request; the
      // chain itself never rejects, so every later request is still answered.
      // A request is in flight from its arrival to its answer (ev.edited waits).
      inFlight += 1;
      const next = (): Promise<void> => handle(m.data)
        .catch((err: unknown) => answerIslandError(m.data, err))
        .finally(() => { inFlight -= 1; });
      chain = chain.then(next, next);
    };
    for (const ev of queued.splice(0)) emit(ev);
  };
  page.addEventListener('message', onConnect);
  page.parent.postMessage({ type: 'cc.hello', proto: 1, nonce, island: __ISLAND_ID__ }, parentOrigin);
  // The host's Alt chords become ev.key (PROTOCOL.md keys.claim): installed now,
  // before the engine's scripts load and before the place keys, so these
  // capture listeners on the window run before any of KiCad's own (src/host-keys.ts).
  const hostKeys = installHostKeys(page, { onKey: (c) => { if (!closed) emit({ type: 'ev.key', code: c.code, shift: c.shift }); } });
  // KiCad's place keys become ev.pick (PICKER.md): installed now, before the
  // engine's scripts load, so these capture listeners run before KiCad's own.
  installPickKeys(page, {
    frame,
    open: () => win != null && pickOpen(win),
    focused: () => { try { return page.document?.activeElement ?? null; } catch { return null; } },
    onPick: (pick) => emitPick(pick),
  });

  // Whether the last key down in the frame was an auto repeat: a held key's
  // repeats are taken with no ev.held (bridge/held.ts), so the host hears one press.
  let keyRepeat = false;
  page.addEventListener('keydown', (e: Event) => { keyRepeat = (e as KeyboardEvent).repeat === true; }, true);

  /** A well-formed request for one of the library reads. */
  function isLibRead(data: unknown): data is { id: number; op: string; args?: unknown } {
    return isObj(data) && typeof data.id === 'number' && Number.isSafeInteger(data.id) && typeof data.op === 'string' && LIB_OPS.has(data.op);
  }

  /** One library read, off the queue: the same closed checks as any request, then its answer. */
  async function handleLib(data: { id: number; op: string; args?: unknown }): Promise<void> {
    if (closed) return;
    const { id, op } = data;
    if (!onlyKeys(data as unknown as Record<string, unknown>, ['id', 'op', 'args'])) return reply(id, fail('bad_args', op));
    const a = op === 'lib.index' ? libIndex(data.args) : op === 'lib.item' ? libItem(data.args) : Promise.resolve(libPrefetch(data.args));
    reply(id, await a.catch((err: unknown) => fail('island_error', describeError(err))));
  }

  /** A well-formed request for keys.claim. */
  function isKeysClaim(data: unknown): data is { id: number; op: string; args?: unknown } {
    return isObj(data) && typeof data.id === 'number' && Number.isSafeInteger(data.id) && data.op === KEYS_CLAIM_OP;
  }

  /** keys.claim (PROTOCOL.md): the whole claimed set replaced; KiCad's own Alt chords answered back as refused. */
  function keysClaim(data: { id: number; op: string; args?: unknown }): void {
    if (closed) return;
    const { id, op } = data;
    const chords = onlyKeys(data as unknown as Record<string, unknown>, ['id', 'op', 'args']) ? parseKeysClaim(data.args) : null;
    if (chords == null) return reply(id, fail('bad_args', op));
    const { claimed, refused } = hostKeys.claim(chords);
    reply(id, ok({ claimed: claimed.length, refused: refused.map((c) => ({ code: c.code, shift: c.shift })) }));
  }

  function answerIslandError(data: unknown, err: unknown): void {
    if (!isObj(data) || typeof data.id !== 'number' || !Number.isSafeInteger(data.id)) return;
    try { reply(data.id, fail('island_error', describeError(err))); } catch { /* the port is gone */ }
  }

  async function handle(data: unknown): Promise<void> {
    if (closed) return;
    if (!isObj(data) || typeof data.id !== 'number' || !Number.isSafeInteger(data.id) || typeof data.op !== 'string') return;
    const { id, op } = data;
    if (!OPS.has(op)) return reply(id, fail('unknown_op', op));
    if (!onlyKeys(data, ['id', 'op', 'args'])) return reply(id, fail('bad_args', op));
    // An import runs off the request chain (it may take a minute): what arrives
    // meanwhile is answered at once, busy, except a shutdown, which ends it.
    if (importing && op !== 'shutdown') return reply(id, fail('busy', op));
    // A check runs off the request chain as well (it holds the editor for seconds).
    if (checking && !CHECK_PASSES.has(op)) return reply(id, fail('busy', op));
    // A stopped engine is never entered again: the host reloads the frame.
    if (stopped != null && op !== 'shutdown') return reply(id, fail('not_ready', 'the engine stopped'));
    if (frame === 'symedit' && SYMEDIT_REFUSES.has(op)) return reply(id, fail('unsupported', SYMEDIT_REFUSAL));
    if (op === 'project.import') return startImport(id, data.args);
    if (op === 'sheet.check') return startCheck(id, data.args);
    if (op === 'board.check') return startBoardCheck(id, data.args);
    try {
      reply(id, await run(op, data.args));
    } catch (err) {
      reply(id, fail('island_error', describeError(err)));
    }
    // The shutdown answer is the last message on the port, whatever the teardown answered.
    if (shutdownStarted) close();
  }

  /** The host's picker opens: ev.pick, while the bridge is live. */
  function emitPick(pick: KeyPick): void {
    if (closed || !ready) return;
    emit(pick.power === true ? { type: 'ev.pick', kind: pick.kind, power: true } : { type: 'ev.pick', kind: pick.kind });
  }

  /**
   * A place key may become ev.pick: nothing of KiCad's own is over its canvas
   * (no popup menu, no dialog but a progress dialog, as for key.press, and no
   * other window of KiCad's such as its footprint chooser), and no import runs.
   */
  function pickOpen(w: ToolWindow): boolean {
    if (!pickerOn || closed || importing || keysBlocked(w)) return false;
    try {
      return !(w.wxElementRegistry?.findAll({ visible: true }) ?? []).some((e) => FRAME_TYPE_RE.test(e.typeName) && !ownFrames.has(e.name));
    } catch { return false; }
  }

  /** The document and the save hook are dropped and the engine's leave prompt is stopped for good. */
  function stopBridge(): void {
    placeWatch?.stop();
    selectionFeed?.stop();
    selectionFeed = null;
    stopEdits?.();
    stopEdits = null;
    editDepth = null;
    stopMenus?.();
    stopMenus = null;
    coords?.stop();
    coords = null;
    stopFitWatch?.();
    stopFitWatch = null;
    fitWatch = null;
    staged = null;
    opened = null;
    displaySettings = null;
    stopSaveHook();
    quietForever();
  }

  function close(): void {
    if (closed) return;
    stopBridge();
    closed = true;
    hostKeys.stop();   // every key is KiCad's again
    queued.length = 0;
    page.removeEventListener('message', onConnect);
    if (port != null) {
      port.onmessage = null;
      port.close();
    }
  }

  /**
   * The engine is still loading a file (open_gate.h's counter, the probe the
   * loader's open flow polls). A second open or a save sent then would queue
   * behind the parked load, so both answer busy and the host retries.
   */
  function engineBusy(): boolean {
    const mod = win?.Module as { kicadOpenFileBusy?: () => unknown } | undefined;
    const probe = mod?.kicadOpenFileBusy;
    if (typeof probe !== 'function') return false;
    try { return probe.call(mod) === true; } catch { return false; }
  }

  /**
   * The open document's undo depth (KiCad's undo command count, read through
   * the engine's kicadCollabTestUndoDepth): null when the export is missing,
   * throws, or answers anything but a whole number of at least 0 (it answers
   * -1 while no editor frame is up).
   */
  function undoDepth(w: ToolWindow): number | null {
    const mod = w.Module as { kicadCollabTestUndoDepth?: () => unknown } | undefined;
    const read = mod?.kicadCollabTestUndoDepth;
    if (typeof read !== 'function') return null;
    try {
      const depth = read.call(mod);
      return typeof depth === 'number' && Number.isSafeInteger(depth) && depth >= 0 ? depth : null;
    } catch { return null; }
  }

  /**
   * ev.edited's baseline after a load: the depth it left, read only when the
   * poll runs. A load still parked on a KiCad dialog (the file-version confirm
   * on an older file: the open answers while kicadOpenFileBusy holds) has not
   * reset the undo list yet, so no baseline is read then: null, and the first
   * read that passes the poll's busy and dialog gates takes it.
   */
  function editBaseline(w: ToolWindow): number | null {
    if (stopEdits == null || engineBusy() || dialogUp(w, true)) return null;
    return undoDepth(w);
  }

  /**
   * One ev.edited read (PROTOCOL.md): only while a document is open, no
   * request is in flight (an import included), no load is parked and no dialog
   * is up, progress dialogs included. The first read after an open, an import
   * or a forget is the baseline; a later read that differs is sent.
   */
  function pollEdits(w: ToolWindow): void {
    if (closed || opened == null || staged == null || importing || checking || inFlight > 0 || collecting != null) return;
    if (engineBusy() || dialogUp(w, true)) return;
    const depth = undoDepth(w);
    if (depth == null) return;
    if (editDepth == null) { editDepth = depth; return; }
    if (depth === editDepth) return;
    editDepth = depth;
    emit({ type: 'ev.edited', depth });
  }

  /**
   * ev.edited in a symedit frame: the symbol editor's undo depth
   * (kicadSymEditState), read while a symbol is open and on the same gates as
   * pollEdits; the first read after an open or a new symbol is the baseline.
   */
  function pollSymEdits(mod: Record<string, unknown>): void {
    if (closed || importing || inFlight > 0 || win == null) return;
    if (engineBusy() || dialogUp(win, true)) return;
    const state = symState(mod);
    if (state == null || !state.open) return;
    if (editDepth == null) { editDepth = state.depth; return; }
    if (state.depth === editDepth) return;
    editDepth = state.depth;
    emit({ type: 'ev.edited', depth: state.depth });
  }

  async function run(op: string, args: unknown): Promise<Answer> {
    if ((op === 'project.open' || op === 'project.save') && engineBusy()) return fail('busy', 'the engine is busy');
    switch (op) {
      case 'project.open': return projectOpen(args);
      case 'project.save': return noArgs(args) ? projectSave() : fail('bad_args', op);
      case 'project.write': return projectWrite(args);
      case 'project.forget': {
        if (!noArgs(args)) return fail('bad_args', op);
        // The host dropped the document whatever the wipe below answers: the
        // bridge forgets it first, and no leave prompt is raised for it again
        // until the next successful project.open.
        staged = null;
        opened = null;
        forgetSim();
        displaySettings = null;
        editDepth = null;   // the next document's first read is its baseline
        fitWatch?.disarm();
        placeWatch?.stop();   // a placement of the previous document is no longer watched
        stopSaveHook();   // a Ctrl+S in the still-shown document emits nothing from here on
        quietForever();
        if (win?.FS != null) removeTree(win.FS, root);
        return ok();
      }
      case 'shutdown': {
        if (!noArgs(args)) return fail('bad_args', op);
        shutdownStarted = true;
        stopBridge();
        await onShutdown?.();
        return ok();
      }
      case 'chrome.show': return toggle(op, args, 'kicadSetChrome');
      case 'readonly': return toggle(op, args, 'kicadSetReadOnly');
      case 'key.press': return keyPress(args);
      // KiCad's Zoom to Fit is its Home hotkey; through keyPress, so a dialog that is up answers busy.
      case 'view.fit': return noArgs(args) ? keyPress({ key: 'Home', code: 'Home' }, op) : fail('bad_args', op);
      case 'sheet.tree': return noArgs(args) ? sheetTree() : fail('bad_args', op);
      case 'sheet.enter': return sheetEnter(args);
      case 'layers.get': return noArgs(args) ? layersGet() : fail('bad_args', op);
      case 'layers.visible': return layersVisible(args);
      case 'layers.active': return layersActive(args);
      case 'place': return placeItem(args);
      case 'select': return selectOp(args);
      case 'project.libs': return projectLibsOp(args);
      case 'footprint.models': return footprintModels(args);
      case 'project.plot': return projectPlot(args);
      case 'project.export': return projectExport(args);
      case 'board.rules': return boardRules(args);
      case 'symbols.get': return symbolsGet(args);
      case 'symbols.set': return symbolsSet(args);
      case 'symbols.exchange': return symbolsExchange(args);
      case 'sch.edit': return globalEdit('sch.edit', args);
      case 'board.footprints': return boardFootprints(args);
      case 'board.edit': return globalEdit('board.edit', args);
      case 'footprints.exchange': return footprintsExchange(args);
      case 'settings.get': return settingsGet(args);
      case 'settings.set': return settingsSet(args);
      case 'symbol.get': return symbolGet(args);
      case 'symbol.set': return symbolSet(args);
      case 'board.explain': return boardExplain(args);
      case 'board.item.get': return boardItemGet(args);
      case 'board.item.set': return boardItemSet(args);
      case 'board.preview': return boardUpdate(op, args);
      case 'board.update': return boardUpdate(op, args);
      case 'sheet.annotate': return sheetAnnotate(args);
      case 'symedit.open': return symEditOpen(args);
      case 'symedit.new': return symEditNew(args);
      case 'symedit.state': return symEditStateOp(args);
      case 'symedit.take': return symEditTake(args);
      case 'symedit.markSaved': return symEditMarkSaved(args);
      case 'symedit.items.get': return symEditItemsGet(args);
      case 'symedit.items.set': return symEditItemsSet(args);
      case 'symedit.items.add': return symEditItemsAdd(args);
      case 'symedit.items.remove': return symEditItemsRemove(args);
      case 'symedit.symbol.get': return symEditSymbolGet(args);
      case 'symedit.symbol.set': return symEditSymbolSet(args);
      case 'symedit.show': return symEditShow(args);
      case 'symedit.check': return symEditCheck(args);
      case 'symedit.svg': return symEditSvg(args);
      case 'symbol.convert': return symbolConvert(args);
      case 'symbol.forEditor': return symbolForEditor(args);
      case 'symbol.push': return symbolPush(args);
      case 'lib.update': return libUpdate(args);
      case 'sim.catalog': return simCatalog(args);
      case 'sim.model.get': return simModelGet(args);
      case 'sim.model.set': return simModelSet(args);
      case 'sim.file': return simFile(args);
      case 'sim.netlist': return simNetlist(args);
      case 'sim.run': return simRun(args);
      case 'sim.result': return simResultOp(args);
      case 'sim.vectors': return simVectors(args);
      case 'sim.opOnSheet': return simOpOnSheet(args);
    }
    return fail('unknown_op', op);
  }

  async function projectOpen(a: unknown): Promise<Answer> {
    const op = 'project.open';
    if (!isObj(a) || !onlyKeys(a, ['name', 'files', 'open'])) return fail('bad_args', op);
    if (typeof a.name !== 'string' || a.name.length > MAX_NAME || !Array.isArray(a.files) || a.files.length > MAX_FILES) return fail('bad_args', op);
    // The explicit target must be this frame's own kind: a .kicad_sch opened in
    // the pcb frame would have project.save write a board into it.
    if (a.open !== undefined && (typeof a.open !== 'string' || !a.open.endsWith(EXT[frame]))) return fail('bad_args', op);
    const files: Array<{ path: string; bytes: Uint8Array }> = [];
    for (const f of a.files as unknown[]) {
      if (!isObj(f) || !onlyKeys(f, ['path', 'bytes']) || typeof f.path !== 'string' || !(f.bytes instanceof Uint8Array)) return fail('bad_args', op);
      files.push({ path: f.path, bytes: f.bytes });
    }
    if (win?.FS == null) return fail('not_ready', op);
    emit({ type: 'ev.state', phase: 'staging' });
    // The previous project is gone from here on, even if the wipe below fails.
    staged = null;
    opened = null;
    forgetSim();
    displaySettings = null;
    editDepth = null;
    fitWatch?.disarm();
    placeWatch?.stop();   // a placement of the previous document is no longer watched
    stopSaveHook();
    removeTree(win.FS, root);   // every open starts from an empty project folder
    staged = stageProject(win, SLUG, files);
    const target = typeof a.open === 'string' ? a.open : defaultOpen(staged.written, frame);
    if (target == null) return fail('nothing_to_open', `no ${EXT[frame]} file`);
    // Before the load, which reads them: KiCad draws the board as the viewer does.
    displaySettings = stageLocalSettings(win, staged, target);
    emit({ type: 'ev.state', phase: 'opening' });
    const w = win;
    const how = await openStaged(w, staged, target, (m) => console.debug('[open]', m));
    if (how === 'failed') {
      // A load that did not settle may still have shown the menu bar.
      await settleChrome(w);
      return fail('open_failed', target);
    }
    opened = normalizePath(target);
    sheetFile = opened == null ? null : baseName(opened);   // KiCad shows the root first (measured 2026-10-15)
    startSaveHook(w);   // a fresh hook lifetime for this document
    selectionFeed?.reset();   // a new document: the host's selection is empty again
    editDepth = editBaseline(w);   // the depth the load left (null while it is parked): ev.edited's baseline, never sent
    quietClear();   // a new document: the engine's leave prompt guards it again
    // Loading a file shows the menu bar again, and an infobar when the file is
    // from an older KiCad (e2e 2026-10-01): the hidden chrome is put back
    // before the answer. KiCad could show it again after the load settled (a
    // menu bar in 2 of 14 e2e runs then), which our engine now hides itself
    // and which the watch behind the answer hides for any other. A refusal
    // leaves the chrome up and the open stands: the answer's chrome says so,
    // and the host sends chrome.show again.
    const chrome = await settleChrome(w);
    return ok({ opened, dropped: staged.dropped, chrome });
  }

  /**
   * project.write (PROTOCOL.md): text files written into the running engine's
   * project folder, each replacing what is there; the engine is never told, so
   * KiCad reads a file the next time it opens it (Update PCB from Schematic, a
   * sheet re-opened, a project reloaded). Two engines on one page keep each
   * other's files current this way, never rebooting. The checks, in order, all
   * before the first byte is written, so a refused request writes nothing: the
   * args (bad_args: an empty or oversized list, a path that is not a plain
   * relative one, a text that is not a string, more than MAX_WRITE_BYTES of
   * UTF-8), the frame's own documents (open_document: every .kicad_sch in a
   * sch frame, which holds the whole sheet hierarchy, the .kicad_pcb in a pcb
   * frame), the engine up (not_ready before ev.ready), then the file system
   * (bad_args: a path that names a folder or runs through a file). Needs no
   * document: the file system exists from boot on.
   */
  function projectWrite(a: unknown): Answer {
    const op = 'project.write';
    if (!isObj(a) || !onlyKeys(a, ['files']) || !Array.isArray(a.files) || a.files.length === 0 || a.files.length > MAX_FILES) return fail('bad_args', op);
    const rows: Array<{ path: string; text: string }> = [];
    let chars = 0;
    for (const f of a.files as unknown[]) {
      if (!isObj(f) || !onlyKeys(f, ['path', 'text']) || typeof f.path !== 'string' || typeof f.text !== 'string') return fail('bad_args', op);
      // A plain path only: exactly its own normal form, so the answer names the paths the host sent.
      if (normalizePath(f.path) !== f.path) return fail('bad_args', op);
      chars += f.text.length;
      rows.push({ path: f.path, text: f.text });
    }
    // UTF-8 never takes fewer bytes than UTF-16 code units: a request over the bound in units is over it in bytes.
    if (chars > MAX_WRITE_BYTES) return fail('bad_args', op);
    const encoder = new TextEncoder();
    let bytes = 0;
    const files = rows.map((r) => {
      const encoded = encoder.encode(r.text);
      bytes += encoded.byteLength;
      return { path: r.path, bytes: encoded };
    });
    if (bytes > MAX_WRITE_BYTES) return fail('bad_args', op);
    const own = OWN_DOCUMENT[frame];
    // A symedit frame holds no document (its symbol lives in the engine): every file is taken.
    const held = own == null ? undefined : files.find((f) => f.path.toLowerCase().endsWith(own));
    if (held != null) return fail('open_document', held.path);
    const FS = win?.FS;
    if (FS == null) return fail('not_ready', op);
    const conflict = fileConflict(FS, root, files.map((f) => f.path));
    if (conflict != null) return fail('bad_args', `${op}: ${conflict} names a folder or runs through a file`);
    writeProjectFiles(FS, root, files);
    const written: string[] = [];
    for (const f of files) if (!written.includes(f.path)) written.push(f.path);
    return ok({ written });
  }

  /**
   * project.import's checks, in order: the args (bad_args: an `open` of the
   * frame's own importable kinds; `sheets` and `project`, an Altium project's,
   * only in a sch frame, only together, `open` one of the sheets), the engine
   * (not_ready; unsupported without the frame's import call, and in a pcb frame
   * the board save), then busy while a load is parked or a dialog or a popup
   * menu is up (nothing is changed). Answers the checked request, or the refusal.
   */
  function importCheck(a: unknown): Answer | CheckedImport {
    const op = 'project.import';
    if (!isObj(a) || !onlyKeys(a, ['name', 'files', 'open', 'format', 'sheets', 'project'])) return fail('bad_args', op);
    if (typeof a.name !== 'string' || a.name.length > MAX_NAME || !Array.isArray(a.files) || a.files.length > MAX_FILES) return fail('bad_args', op);
    if (typeof a.open !== 'string' || !importable(a.open, frame)) return fail('bad_args', op);
    if (a.format !== undefined && (typeof a.format !== 'string' || a.format.length > MAX_FORMAT)) return fail('bad_args', op);
    let altium: CheckedImport['altium'];
    if (a.sheets !== undefined || a.project !== undefined) {
      if (frame !== 'sch' || !Array.isArray(a.sheets) || a.sheets.length === 0 || a.sheets.length > MAX_FILES) return fail('bad_args', op);
      const sheets = a.sheets as unknown[];
      if (!sheets.every((s): s is string => typeof s === 'string' && hasExtension(s, ALTIUM_SHEET)) || !sheets.includes(a.open)) return fail('bad_args', op);
      if (typeof a.project !== 'string' || !hasExtension(a.project, ALTIUM_PROJECT)) return fail('bad_args', op);
      altium = { project: a.project, sheets };
    }
    const files: Array<{ path: string; bytes: Uint8Array }> = [];
    for (const f of a.files as unknown[]) {
      if (!isObj(f) || !onlyKeys(f, ['path', 'bytes']) || typeof f.path !== 'string' || !(f.bytes instanceof Uint8Array)) return fail('bad_args', op);
      files.push({ path: f.path, bytes: f.bytes });
    }
    const w = win;
    if (w?.FS == null) return fail('not_ready', op);
    const needs = frame === 'pcb' ? ['kicadOpenFile', 'kicadSaveBoard'] as const : ['kicadImportSchematic'] as const;
    const mod: KicadImportExports | undefined = w.Module;
    for (const name of needs) if (typeof mod?.[name] !== 'function') return fail('unsupported', name);
    if (engineBusy() || keysBlocked(w)) return fail('busy', op);
    return { w, FS: w.FS, open: a.open, files, altium };
  }

  /** Starts a checked import off the request chain; its answer is sent when it ends. */
  function startImport(id: number, args: unknown): void {
    const checked = importCheck(args);
    if ('ok' in checked) return reply(id, checked);
    watchOfImport = false;   // a watch left from an open keeps out of this import
    importing = true;
    void projectImport(checked)
      .catch((err: unknown) => fail('island_error', describeError(err)))
      .then((a) => {
        importing = false;
        reply(id, a);
        // The answer first, then the frame's fatal screen (no event; the host closes or reboots the frame).
        if (stopped != null && !stopSignaled) {
          stopSignaled = true;
          try { onEngineStopped?.(stopped); } catch (err) { console.debug('[import] onEngineStopped', err); }
        }
      });
  }

  /**
   * The engine stopped inside an import's call (a trap): remembered, so no
   * request enters it again, and the scheduler's terminal gate is latched as
   * boot's onAbort latches it (no parked activation resumes into the damaged
   * module; src/teardown.ts's shutdown skips the unwinding of a terminal one).
   */
  function stopEngine(w: ToolWindow, why: string): void {
    stopped = why;
    const s = (w as { __wxScheduler?: { terminalize?: (site: string, e?: unknown) => void } }).__wxScheduler;
    try { s?.terminalize?.('island import', why); } catch (err) { console.debug('[import] terminalize', err); }
  }

  /**
   * A foreign board or schematic, converted (PROTOCOL.md project.import):
   * staged as project.open stages, imported through the engine's own importer
   * with its dialogs answered (bridge/import.ts: kicadOpenFile for a board,
   * kicadImportSchematic for a schematic or an Altium project), then saved
   * through the engine as <stem>.kicad_pcb or <stem>.kicad_sch (an Altium
   * project's root: <project stem>.kicad_sch), which becomes the frame's document.
   */
  async function projectImport(a: CheckedImport): Promise<Answer> {
    const { w, FS } = a;
    const deadline = Date.now() + timing.importMs;
    emit({ type: 'ev.state', phase: 'staging' });
    // The previous project is gone from here on, as for project.open.
    staged = null;
    opened = null;
    forgetSim();
    displaySettings = null;
    editDepth = null;
    fitWatch?.disarm();
    placeWatch?.stop();   // a placement of the previous document is no longer watched
    stopSaveHook();
    removeTree(FS, root);
    const project = stageProject(w, SLUG, a.files);
    staged = project;
    const written = (p: string): string | null => { const n = normalizePath(p); return n != null && project.written.includes(n) ? n : null; };
    const source = written(a.open);
    if (source == null) return fail('open_failed', a.open);
    let altium: { project: string; sheets: string[] } | undefined;
    if (a.altium != null) {
      const sheets: string[] = [];
      for (const p of a.altium.sheets) {
        const n = written(p);
        if (n == null) return fail('open_failed', p);
        sheets.push(n);
      }
      const pro = written(a.altium.project);
      if (pro == null) return fail('open_failed', a.altium.project);
      altium = { project: pro, sheets };
    }
    const target = importTarget(altium?.project ?? source, frame);
    const kind = frame === 'pcb' ? 'board' : 'schematic';
    if (target == null) return fail('open_failed', `no path for the converted ${kind} of ${source}`);
    // KiCad loads the project named after the file it opens (a board's source;
    // a schematic's converted root), its display settings included.
    displaySettings = stageLocalSettings(w, project, frame === 'pcb' ? source : target);
    emit({ type: 'ev.state', phase: 'opening' });
    if (frame === 'sch' && !(await openStub(w, FS, project, target, deadline))) {
      await settleChrome(w);   // a load that ran may have shown the menu bar, as after project.open's failure
      return fail('open_failed', target);
    }
    if (closed) return fail('import_failed', 'the frame closed');
    const drove = await driveImport(w, importCall(frame, root, source, altium), { deadline, timing, closed: () => closed, engineBusy });
    if (closed) return fail('import_failed', 'the frame closed');
    if (!drove.ok) {
      // A stopped engine is not called again, not even to settle the chrome
      // (its mutators would queue behind the held load guard for good).
      if (drove.stopped === true) {
        stopEngine(w, drove.message);
        return fail('import_failed', drove.message);
      }
      await settleChrome(w);   // a load that ran may have shown the menu bar
      return fail('import_failed', drove.message);
    }
    // A new document: the leave prompt guards it again, until the save below
    // hands the host its bytes (each save quiets it for SAVE_QUIET_MS).
    quietClear();
    const saved = await saveConverted(w, FS, target, deadline - Date.now());
    if (closed) return fail('import_failed', 'the frame closed');
    if (!saved) {
      stopSaveHook();
      await settleChrome(w);
      return fail('import_failed', `the converted ${kind} was not saved (${target})`);
    }
    opened = target;
    sheetFile = baseName(target);   // the converted root, which KiCad shows first (measured 2026-10-15)
    if (saveHook == null) startSaveHook(w);   // from here on the converted file is the document, as after project.open
    selectionFeed?.reset();   // a new document: the host's selection is empty again
    editDepth = editBaseline(w);   // the converted document's depth: ev.edited's baseline, never sent
    const chrome = await settleChrome(w);
    // The importer's dialogs took wx's keyboard focus and left it off the
    // drawing (e2e 2026-10-02: key.press F1 no longer zoomed): the boot's own
    // synthetic focus click puts it back. It never takes the browser's focus.
    if (!closed && !keysBlocked(w)) {
      try { focusCanvas(w.document); } catch { /* the user's next press in the drawing focuses it */ }
    }
    // The answer waits for the converted board fitted at the drawing's settled
    // size and painted, so a fit the host sends with it changes nothing; the
    // watch keeps it fitted through the host's own layout after the answer.
    const t0 = Date.now();
    const view = await settleView(w, {
      timing,
      ready: () => !engineBusy() && !keysBlocked(w),
      fit: () => pressKey(w, HOME_KEY),
      closed: () => closed,
      sample: () => sampleDrawing(w.document),
      surface: () => surfaceKey(w.document),
    });
    if (closed) return fail('import_failed', 'the frame closed');
    console.debug('[import] view', view, `${Date.now() - t0} ms`);
    if (view !== 'unsupported') fitWatch?.arm(view === 'painted' || view === 'fitted');
    return ok({ opened: target, dropped: project.dropped, warnings: drove.warnings, chrome });
  }

  /**
   * A schematic import's first step: KiCad's import names the converted root
   * after the project loaded (Prj(), files-io.cpp importFile at the pin), and
   * a blank frame has none. So KiCad's empty sheet is written at the target (a
   * staged file of that name is replaced) and opened through project.open's
   * own open, which loads <target stem>.kicad_pro beside it (the host's, or
   * KiCad's defaults when none was staged, as for a board). Answers whether
   * the load settled within the import's time with nothing of KiCad's left up.
   */
  async function openStub(w: ToolWindow, FS: EmscriptenFS, project: StagedProject, target: string, deadline: number): Promise<boolean> {
    try {
      const slash = target.lastIndexOf('/');
      if (slash > 0) FS.mkdirTree(`${root}/${target.slice(0, slash)}`);
      FS.writeFile(`${root}/${target}`, new TextEncoder().encode(emptySheet(crypto.randomUUID())));
    } catch {
      return false;
    }
    if (!project.written.includes(target)) project.written.push(target);
    const how = await withTimeout(openStaged(w, project, target, (m) => console.debug('[import] stub', m)), Math.max(0, deadline - Date.now()));
    if (closed || how === 'failed' || how === 'timeout') return false;
    // A load parked on a KiCad dialog would take the import's call into it.
    return !engineBusy() && !keysBlocked(w);
  }

  /**
   * The converted document's first save, which hands the host its bytes, within
   * what is left of the import's time (`left` ms): a board through
   * kicadSaveBoard; a schematic through KiCad's own Save with the save hook
   * live, every sheet file and the project file reported, the root among them.
   */
  async function saveConverted(w: ToolWindow, FS: EmscriptenFS, target: string, left: number): Promise<boolean> {
    if (left <= 0) return false;
    if (frame === 'pcb') return (await saveBoard(w, FS, target, Math.min(timing.applyMs, left))).ok;
    startSaveHook(w);
    const saved = await saveSchematic(w, target);
    return saved.ok && Array.isArray(saved.result.saved) && saved.result.saved.includes(target);
  }

  /** Any of KiCad's window chrome is on screen. */
  function chromeVisible(w: ToolWindow): boolean {
    try { return (w.wxElementRegistry?.findAll({ visible: true }) ?? []).some((e) => CHROME_RE.test(e.typeName)); } catch { return false; }
  }

  /**
   * The engine holds its own hidden chrome: our engine from run 9 hides again
   * whatever a load, a save or a pane toggle brought back, inside the call
   * that showed it and before a frame is drawn, and says each real flip
   * (PIN.json engine.build, pcbjam cc/main 27d82c2; kicadChromeShown arrived
   * with it and is the test). Measured 2026-11-13 on engine run 13: over 20
   * opens and ten saves read on every drawn frame the chrome never showed and
   * the watch of the time never had to hide anything, and over 107 more boots
   * the engine reported no flip.
   */
  function holdsChrome(w: ToolWindow): boolean {
    return typeof w.Module?.kicadChromeShown === 'function';
  }

  /**
   * An engine call the island makes on its own, run in the request chain's
   * order after what is queued, so it never runs beside a request's own call.
   * Resolves when it ran; never rejects.
   */
  function inTurn(task: () => Promise<void>): Promise<void> {
    const run = (): Promise<void> => task().catch((err: unknown) => { console.debug('[chrome] watch', describeError(err)); });
    const turn = chain.then(run, run);
    chain = turn;
    return turn;
  }

  /**
   * The watch behind an open's answer (bridge/chromeWatch.ts), for an engine
   * that does not hold its own hidden chrome: one for the frame, ended by the
   * frame closing, by chrome.show turning the chrome on and by a stopped
   * engine (which is never entered again). Its hide takes its turn in the
   * request chain. An import and a check run off that chain: the hide steps
   * aside for a check, and for an import unless that import's own end started
   * the watch (watchOfImport), as its settle always hid while it ran.
   */
  const chromeWatch = new ChromeWatch({
    visible: () => win != null && chromeVisible(win),
    hide: () => inTurn(async () => {
      const w = win;
      if (w == null || closed || chromeOn || stopped != null || checking || (importing && !watchOfImport)) return;
      if (chromeVisible(w)) await withTimeout<unknown>(callChrome(w, false), timing.applyMs);
    }),
    ended: () => closed || chromeOn || stopped != null,
    settleMs: () => timing.chromeSettleMs,
    pollMs: () => timing.chromePollMs,
    sleep,
    now: () => Date.now(),
  });

  /**
   * After a load, while the chrome is meant hidden: hides it once and answers
   * whether any of it is still visible then (with the chrome meant shown,
   * whether it is). The answer never waits for a watch. An engine that holds
   * its own hidden chrome needs none; for any other, the watch starts here and
   * runs on behind the answer for timing.chromeSettleMs, hiding the chrome
   * each time KiCad shows it again.
   */
  async function settleChrome(w: ToolWindow): Promise<boolean> {
    if (chromeOn) return chromeVisible(w);
    await withTimeout<unknown>(callChrome(w, false), timing.applyMs);
    if (!holdsChrome(w)) {
      watchOfImport = importing;
      chromeWatch.start();
    }
    return chromeVisible(w);
  }

  /**
   * Ctrl+S inside the editor: the fork's save chokepoints call
   * window.kicadCollab.onSave(absPath) after the bytes hit MEMFS; the loader's
   * hook reads them back and hands us the project-relative path. The hook also
   * takes a bare file in the projects home (a blank editor's Save-As) as part
   * of the project; the island does not: only a path under the staged root
   * reaches the hook, anything else is logged and ignored.
   */
  function startSaveHook(tool: ToolWindow): void {
    stopSaveHook();
    const w = tool as CollabWindow;
    const handle = registerSaveHook(w, {
      slug: SLUG,
      log: (m) => console.debug('[save]', m),
      onStatus: () => undefined,
      saveBytes: async (relPath, bytes) => {
        const path = normalizePath(relPath);
        if (staged == null || path == null) return { kind: 'not-committed' };
        emit({ type: 'ev.saved', path, bytes });
        collecting?.push({ path, at: Date.now() });
        return SAVE_COMMITTED;
      },
    });
    const inner = w.kicadCollab?.onSave;
    const filter = (absPath: string): void => {
      if (typeof absPath !== 'string' || !absPath.startsWith(`${root}/`) || staged == null) {
        console.debug('[save] ignoring a save outside the project folder', absPath);
        return;
      }
      if (displaySettings != null && absPath === `${root}/${displaySettings}`) {
        console.debug('[save] ignoring the display settings the island staged', absPath);
        return;
      }
      inner?.(absPath);
    };
    w.kicadCollab = { ...w.kicadCollab, onSave: filter };
    saveHook = { handle, filter };
  }

  /** Ends the hook's lifetime: its queued saves are dropped and the engine's save callback is removed. */
  function stopSaveHook(): void {
    if (saveHook == null) return;
    const { handle, filter } = saveHook;
    saveHook = null;
    handle.stop();
    const w = win as CollabWindow | null;
    if (w?.kicadCollab?.onSave === filter) delete w.kicadCollab.onSave;
  }

  /** A MEMFS path inside the project folder as a project-relative path, else null. */
  function relInRoot(abs: string): string | null {
    return abs.startsWith(`${root}/`) ? normalizePath(abs.slice(root.length + 1)) : null;
  }

  /**
   * The engine's sheet tree for a schematic save, read once: null without the
   * export (an older build), when it never answers within timing.applyMs, or
   * when it is not a tree.
   */
  async function readSheetTree(w: ToolWindow): Promise<{ current: unknown; sheets: unknown[] } | null> {
    const tree = w.Module?.kicadSheetsGetTree;
    if (typeof tree !== 'function') return null;
    let state: unknown;
    try {
      const text = await withTimeout<unknown>(tree(), timing.applyMs);
      if (text === 'timeout') return null;
      state = JSON.parse(String(text || 'null'));
    } catch { return null; }
    if (!isObj(state) || !Array.isArray(state.sheets)) return null;
    return { current: state.current, sheets: state.sheets as unknown[] };
  }

  /**
   * The file of the sheet the editor is SHOWING (the current sheet): the
   * project.save answer's `path`. Without the sheet tree (an older build) the
   * opened file; null when the shown sheet lies outside the project.
   */
  function schematicTarget(state: { current: unknown; sheets: unknown[] } | null, fallback: string): string | null {
    if (state == null || typeof state.current !== 'string') return fallback;
    const row = state.sheets.find((s) => isObj(s) && s.path === state.current);
    if (!isObj(row) || typeof row.file !== 'string' || row.file === '') return fallback;
    return relInRoot(row.file);
  }

  async function projectSave(): Promise<Answer> {
    const op = 'project.save';
    const w = win;
    if (w?.FS == null || staged == null || opened == null) return fail('not_ready', op);
    return frame === 'pcb' ? saveBoard(w, w.FS, opened) : saveSchematic(w, opened);
  }

  /** The board through kicadSaveBoard: the one file the frame shows. `ms` bounds the engine call. */
  async function saveBoard(w: ToolWindow, FS: EmscriptenFS, target: string, ms = timing.applyMs): Promise<Answer> {
    const save = w.Module?.kicadSaveBoard;
    if (typeof save !== 'function') return fail('unsupported', 'kicadSaveBoard');
    const abs = `${root}/${target}`;
    // The save exports swallow every failure and write nothing, and the target
    // already holds the staged bytes. So the file is taken away first (its path
    // stays the one the engine holds) and only bytes the engine wrote back count;
    // a save that wrote nothing puts the previous bytes back and fails. A save
    // that never answers is judged the same way after timing.applyMs, so the
    // request chain moves on.
    const before = readBytes(FS, abs);
    try { if (before != null) FS.unlink(abs); } catch { return fail('save_failed', target); }
    try { await withTimeout<unknown>(save(abs), ms); } catch { /* judged by the file below */ }
    const bytes = readBytes(FS, abs);
    if (bytes == null || bytes.byteLength === 0) {
      try { if (before != null) FS.writeFile(abs, before); } catch { /* the answer is save_failed either way */ }
      return fail('save_failed', target);
    }
    emit({ type: 'ev.saved', path: target, bytes });
    quietFor(SAVE_QUIET_MS);   // the host has the bytes and may reload the frame now
    return ok({ path: target, saved: [target] });
  }

  /**
   * The schematic through KiCad's own Save, the Ctrl+S path: it writes every
   * sheet file of the hierarchy and the project file, each reported by the
   * save hook as ev.saved (kicadSaveSchematic writes only the sheet on screen,
   * so edits on any other sheet would be lost). The answer waits until every
   * sheet file and the project file are in, then a short pause with nothing
   * more; without the sheet list it waits for a longer pause. `path` names the
   * sheet the editor is showing, for hosts older than `saved`.
   */
  async function saveSchematic(w: ToolWindow, fallback: string): Promise<Answer> {
    const op = 'project.save';
    // A dialog refuses first, and nothing is pressed while one is up (the
    // protocol's promise): a popup over a dialog stays as it is. Otherwise a
    // popup menu holds no edits: it is closed as Escape closes it, and the
    // parked chain that opened it is let go before the key. A menu bar popup
    // takes no Escape and refuses like a dialog: the key would land in it.
    if (dialogUp(w, false)) return fail('busy', op);
    if (dismissPopups(w)) await sleep(timing.dismissMs);
    if (keysBlocked(w)) return fail('busy', op);
    const tree = await readSheetTree(w);
    const shown = schematicTarget(tree, fallback) ?? fallback;
    const expected = expectedSaves(tree, fallback);
    const got: Array<{ path: string; at: number }> = [];
    collecting = got;
    const start = Date.now();
    try {
      pressKey(w, SAVE_KEY);
      for (;;) {
        await sleep(timing.savePollMs);
        const now = Date.now();
        if (closed || now - start >= timing.saveAllMs) break;
        if (got.length === 0) {
          if (now - start >= timing.firstSaveMs) break;
          continue;
        }
        const idle = now - got[got.length - 1].at;
        const all = expected != null && [...expected].every((p) => got.some((g) => g.path === p));
        if (idle >= (all ? timing.saveSettleMs : timing.saveQuietMs)) break;
      }
      // The hook hands a file saved twice in a row over a microtask later: drain it.
      await sleep(0);
    } finally {
      collecting = null;
    }
    const saved = [...new Set(got.map((g) => g.path))];
    if (saved.length === 0) return fail('save_failed', 'the editor saved nothing');
    quietFor(SAVE_QUIET_MS);   // the host has the bytes and may reload the frame now
    return ok({ path: shown, saved });
  }

  /**
   * The files KiCad's Save writes: every sheet file the engine's sheet tree
   * names (inside the project) and the root's .kicad_pro when it was staged.
   * Null without a usable sheet tree.
   */
  function expectedSaves(state: { current: unknown; sheets: unknown[] } | null, fallback: string): Set<string> | null {
    if (state == null) return null;
    const files = new Set<string>();
    let rootFile = fallback;
    for (const row of state.sheets) {
      if (!isObj(row) || typeof row.file !== 'string') continue;
      const rel = relInRoot(row.file);
      if (rel == null) continue;
      files.add(rel);
      if (row.path === '/') rootFile = rel;
    }
    if (files.size === 0) return null;
    const pro = `${rootFile.slice(0, -'.kicad_sch'.length)}.kicad_pro`;
    if (rootFile.endsWith('.kicad_sch') && staged?.written.includes(pro)) files.add(pro);
    return files;
  }

  async function toggle(op: string, args: unknown, name: 'kicadSetChrome' | 'kicadSetReadOnly'): Promise<Answer> {
    if (!isObj(args) || !onlyKeys(args, ['on']) || typeof args.on !== 'boolean') return fail('bad_args', op);
    if (win == null) return fail('not_ready', op);
    const fn = win.Module?.[name];
    if (typeof fn !== 'function') return fail('unsupported', name);
    // The binding answers false until the frame exists, and may answer through a
    // Promise when it queued behind a live open. Anything but true fails closed.
    const applied = await withTimeout<unknown>(fn(args.on), timing.applyMs);
    if (applied !== true) return fail('not_applied', op);
    if (name === 'kicadSetChrome') chromeOn = args.on;
    return ok();
  }

  /** kicadSetChrome's own answer, or undefined when the export is missing, throws or rejects. */
  async function callChrome(w: ToolWindow, on: boolean): Promise<unknown> {
    const fn = w.Module?.kicadSetChrome;
    if (typeof fn !== 'function') return undefined;
    try { return await fn(on); } catch { return undefined; }
  }

  /**
   * A KiCad hotkey from the host (spec D16). Refused while a popup menu or a
   * dialog is up: the key would land in it. Never clicks: the boot put wx keyboard focus on the
   * canvas once (src/main.ts), and a click in a drawing tool would place a point.
   */
  function keyPress(args: unknown, op = 'key.press'): Answer {
    const k = parseKeyPress(args);
    if (k == null) return fail('bad_args', op);
    const w = win;
    if (w == null) return fail('not_ready', op);
    if (keysBlocked(w)) return fail('busy', op);
    // A place key from the host takes the reader's own key's path (PICKER.md):
    // KiCad's chooser never opens, ev.pick goes out, and nothing is pressed.
    const pick = op === 'key.press' ? pickFor(frame, { key: k.key, ctrlKey: k.ctrl, shiftKey: k.shift, altKey: k.alt }) : null;
    if (pick != null && pickOpen(w) && !takesText(w.document?.activeElement)) {
      emitPick(pick);
      return ok();
    }
    if (op !== 'view.fit') {
      // A host's key may zoom, pan or start a tool: the reader is steering.
      fitWatch?.disarm();
      pressKey(w, k);
      return ok();
    }
    // Fitted already at this size (the island's own fit after an import, or a
    // fit the watch kept): pressing again would only repaint the same view.
    if (fitWatch?.holds() !== true) pressKey(w, k);
    fitWatch?.arm();
    return ok();
  }

  /**
   * The engine's JSON export, parsed. 'unsupported' when the export is missing
   * or answers nothing (the other frame's kind: a pcb frame has no sheet tree,
   * a sch frame no layers); null when it throws or answers something unparsable.
   */
  async function engineJson(name: 'kicadSheetsGetTree' | 'kicadLayersGetState'): Promise<Record<string, unknown> | null | 'unsupported'> {
    const fn = win?.Module?.[name];
    if (typeof fn !== 'function') return 'unsupported';
    let text: unknown;
    try { text = await withTimeout<unknown>(fn(), timing.applyMs); } catch { return null; }
    if (text === 'timeout') return null;
    if (typeof text !== 'string' || text === '') return 'unsupported';
    try { const v: unknown = JSON.parse(text); return isObj(v) ? v : null; } catch { return null; }
  }

  /** The schematic's sheets, each with its file's base name (the engine's absolute path stays here). */
  async function sheetTree(): Promise<Answer> {
    const op = 'sheet.tree';
    if (win == null) return fail('not_ready', op);
    const state = await engineJson('kicadSheetsGetTree');
    if (state === 'unsupported') return fail('unsupported', 'kicadSheetsGetTree');
    if (state == null || typeof state.current !== 'string' || !Array.isArray(state.sheets)) return fail('island_error', op);
    const sheets = (state.sheets as unknown[]).flatMap((s) => {
      if (!isObj(s) || typeof s.path !== 'string' || typeof s.name !== 'string') return [];
      return [{
        path: s.path,
        name: s.name,
        page: String(s.page ?? ''),
        depth: typeof s.depth === 'number' ? s.depth : 0,
        parent: typeof s.parent === 'string' ? s.parent : '',
        file: typeof s.file === 'string' ? baseName(s.file) : '',
      }];
    });
    return ok({ current: state.current, currentFile: (opened != null ? sheetFile : null) ?? '', sheets });
  }

  /** Resolves true at the first sheet switch KiCad reports after the `since`th, false after `ms`. */
  function sheetSwitch(since: number, ms: number): Promise<boolean> {
    if (sheetChanges > since) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (v: boolean): void => { sheetWaiters.delete(seen); clearTimeout(timer); resolve(v); };
      const seen = (): void => { if (sheetChanges > since) done(true); };
      const timer = setTimeout(() => done(false), ms);
      sheetWaiters.add(seen);
    });
  }

  async function sheetEnter(args: unknown): Promise<Answer> {
    const op = 'sheet.enter';
    if (!isObj(args) || !onlyKeys(args, ['path', 'file']) || typeof args.path !== 'string' || !SHEET_PATH_RE.test(args.path)) return fail('bad_args', op);
    if (args.file !== undefined && (typeof args.file !== 'string' || !SHEET_FILE_RE.test(args.file))) return fail('bad_args', op);
    if (win == null) return fail('not_ready', op);
    const w = win;
    const fn = w.Module?.kicadSheetsEnter;
    if (typeof fn !== 'function') return fail('unsupported', 'kicadSheetsEnter');
    if (args.file === undefined) {
      const applied = await withTimeout<unknown>(fn(args.path), timing.applyMs);
      return applied === true ? ok() : fail('not_applied', op);
    }
    const path = args.path;
    const file = args.file;
    // The sheets at that path. KiCad 10 reports every top-level sheet at "/", and
    // kicadSheetsEnter reaches only the first of them; `file` picks one.
    const state = await engineJson('kicadSheetsGetTree');
    if (state === 'unsupported') return fail('unsupported', 'kicadSheetsGetTree');
    if (state == null || !Array.isArray(state.sheets)) return fail('island_error', op);
    const rows = (state.sheets as unknown[]).filter((s): s is Record<string, unknown> => isObj(s) && s.path === path);
    if (rows.length === 0) return fail('not_applied', op);
    if (!rows.some((s) => typeof s.file === 'string' && baseName(s.file) === file)) return fail('bad_args', op);
    const here = (): boolean => opened != null && sheetFile === file;
    if (state.current === path && here()) return ok();
    /** KiCad shows the file, at the path (a sheet below may use the same file). */
    const arrived = async (): Promise<boolean> => {
      if (!here()) return false;
      const now = await engineJson('kicadSheetsGetTree');
      return now !== 'unsupported' && now != null && now.current === path;
    };
    // To the first sheet at the path, then KiCad's Next Sheet until KiCad shows
    // the file: Next Sheet goes by virtual page number through every sheet
    // (eeschema's navigate tool), so the walk takes at most one step per row.
    if (keysBlocked(w)) return fail('busy', op);
    const changes = sheetChanges;
    const states = sheetStates;
    const applied = await withTimeout<unknown>(fn(path), timing.applyMs);
    if (applied !== true) return fail('not_applied', op);
    // On the first sheet already, the engine pushes its state inside the call and
    // switches nothing; otherwise the switch follows on the editor's coroutine.
    if (!(sheetStates > states && sheetChanges === changes) && !(await sheetSwitch(changes, timing.sheetStepMs))) return fail('not_applied', op);
    for (let step = 0; !(await arrived()); step++) {
      if (closed || step >= (state.sheets as unknown[]).length) return fail('not_applied', op);
      if (keysBlocked(w)) return fail('busy', op);
      const before = sheetChanges;
      pressKey(w, NEXT_SHEET_KEY);
      if (!(await sheetSwitch(before, timing.sheetStepMs))) return fail('not_applied', op);
    }
    return ok();
  }

  async function layersGet(): Promise<Answer> {
    const op = 'layers.get';
    if (win == null) return fail('not_ready', op);
    const state = await engineJson('kicadLayersGetState');
    if (state === 'unsupported') return fail('unsupported', 'kicadLayersGetState');
    if (state == null || typeof state.active !== 'number' || !Array.isArray(state.layers)) return fail('island_error', op);
    const layers = (state.layers as unknown[]).flatMap((l) => {
      if (!isObj(l) || !isLayerId(l.id) || typeof l.name !== 'string' || typeof l.canonical !== 'string') return [];
      return [{ id: l.id, name: l.name, canonical: l.canonical, color: typeof l.color === 'string' ? l.color : '', visible: l.visible === true, copper: l.copper === true }];
    });
    return ok({ active: state.active, layers });
  }

  /** A layer setter: answers {} only when the engine confirms, like chrome.show. */
  async function layerCall(op: string, name: 'kicadLayersSetVisible' | 'kicadLayersSetActive', call: (fn: (...a: unknown[]) => unknown) => unknown): Promise<Answer> {
    if (win == null) return fail('not_ready', op);
    const fn = win.Module?.[name];
    if (typeof fn !== 'function') return fail('unsupported', name);
    const applied = await withTimeout<unknown>(call(fn as (...a: unknown[]) => unknown), timing.applyMs);
    return applied === true ? ok() : fail('not_applied', op);
  }

  function layersVisible(args: unknown): Promise<Answer> {
    const op = 'layers.visible';
    if (!isObj(args) || !onlyKeys(args, ['id', 'visible']) || !isLayerId(args.id) || typeof args.visible !== 'boolean') return Promise.resolve(fail('bad_args', op));
    return layerCall(op, 'kicadLayersSetVisible', (fn) => fn(args.id, args.visible));
  }

  function layersActive(args: unknown): Promise<Answer> {
    const op = 'layers.active';
    if (!isObj(args) || !onlyKeys(args, ['id']) || !isLayerId(args.id)) return Promise.resolve(fail('bad_args', op));
    return layerCall(op, 'kicadLayersSetActive', (fn) => fn(args.id));
  }

  /** The picker's library reads: the source, else not_ready (before ev.ready) or an answer of nothing. */
  async function libIndex(args: unknown): Promise<Answer> {
    const op = 'lib.index';
    const a = parseIndexArgs(args);
    if (a == null) return fail('bad_args', op);
    if (!ready) return fail('not_ready', op);
    const mirror = libs?.mirror;
    if (mirror == null) return ok({ text: null });
    const text = await mirror.getSearchIndex(a.kind);
    return ok({ text: typeof text === 'string' ? text : null });
  }

  /** One item's body as the source holds it: a self-contained symbol library, or the footprint's text. */
  async function readItem(kind: PickKind, lib: string, name: string): Promise<string | null> {
    if (libs == null || idOf == null) return null;
    const id = await idOf(kind, lib);
    if (id == null) return null;
    const body = await libs.source.getItemBody(id, kind, name);
    return typeof body === 'string' ? body : null;
  }

  async function libItem(args: unknown): Promise<Answer> {
    const op = 'lib.item';
    const a = parseItemArgs(args);
    if (a == null) return fail('bad_args', op);
    if (!ready) return fail('not_ready', op);
    return ok({ body: await readItem(a.kind, a.lib, a.name) });
  }

  /** Answers at once; the named libraries' bundles warm in the background, an unknown name is passed over. */
  function libPrefetch(args: unknown): Answer {
    const op = 'lib.prefetch';
    const a = parsePrefetchArgs(args);
    if (a == null) return fail('bad_args', op);
    if (!ready) return fail('not_ready', op);
    // The mirror's own ids (sym.<nick>, fp.<nick>); without a mirror there is nothing to warm.
    const mirror = libs?.mirror;
    if (mirror != null) {
      const ids = libIds(mirror);
      for (const nick of new Set(a.libs)) {
        void ids(a.kind, nick).then((id) => (id == null ? undefined : warmLibrary(mirror, id)), () => undefined);
      }
    }
    return ok();
  }

  /**
   * place (PICKER.md): the item's body from the source, built into the
   * clipboard blob (loader/src/wasm/import-item.ts, a derived symbol
   * flattened), handed to the engine; answered once the item hangs off the
   * pointer (bridge/place.ts). The checks, in order: the args (bad_args, a
   * footprint's `footprint`, `mpn` or `manufacturer` among them), the frame's
   * kind and the export (unsupported), a document (not_ready), a load, a
   * dialog or a popup menu (busy), the item (not_found). `value`,
   * `footprint`, `mpn` and `manufacturer` are written on the placed item,
   * never on the library entry the sheet caches.
   */
  async function placeItem(args: unknown): Promise<Answer> {
    const op = 'place';
    const a = parsePlaceArgs(args);
    if (a == null) return fail('bad_args', op);
    if (a.kind !== kindOf(frame)) return fail('unsupported', `a ${a.kind} does not place in a ${frame} frame`);
    const w = win;
    if (w == null) return fail('not_ready', op);
    if (typeof w.Module?.kicadPlaceImportedItem !== 'function') return fail('unsupported', 'kicadPlaceImportedItem');
    if (typeof w.Module?.kicadCollabGetSelection !== 'function') return fail('unsupported', 'kicadCollabGetSelection');
    if (staged == null || opened == null) return fail('not_ready', op);
    if (engineBusy() || keysBlocked(w)) return fail('busy', op);
    const body = await readItem(a.kind, a.lib, a.name);
    if (body == null) return fail('not_found', `${a.lib}:${a.name}`);
    let sexpr: string;
    try {
      sexpr = buildInteractiveImport(a.kind, body, a.lib, a.name, { value: a.value, footprint: a.footprint, mpn: a.mpn, manufacturer: a.manufacturer }).sexpr;
    } catch (err) {
      return fail('island_error', describeError(err));
    }
    // The body may have taken a while: the document and the editor are read again.
    if (closed) return fail('island_error', 'the frame closed');
    if (staged == null || opened == null) return fail('not_ready', op);
    if (engineBusy() || keysBlocked(w)) return fail('busy', op);
    // The editor places one item at a time: one of ours still hanging is dropped first.
    if (placeWatch != null && !(await placeWatch.cancel())) return fail('busy', 'the previous item still hangs off the pointer');
    const t0 = Date.now();
    const placed = await placeBlob(w, sexpr, { timing, closed: () => closed });
    if (!placed.ok) return fail(placed.code, placed.message);
    console.debug('[place]', `${a.lib}:${a.name}`, `${Date.now() - t0} ms`);
    placeWatch?.start(placed.uuid);
    return ok();
  }

  /**
   * select (PROTOCOL.md): the checks, in order: the args (bad_args), the engine
   * up (not_ready), its exports (unsupported), a document (not_ready), then busy
   * while a load is parked, a popup menu or a dialog is up, or an item placed by
   * `place` still hangs off the pointer (clearing the selection would drop it).
   * Then bridge/selection.ts selects, and with `zoom` fits the view to the items.
   */
  async function selectOp(args: unknown): Promise<Answer> {
    const op = 'select';
    const a = parseSelectArgs(args);
    if (a == null) return fail('bad_args', op);
    if (frame === 'symedit') return symEditSelect(a);
    const w = win;
    if (w == null) return fail('not_ready', op);
    const mod = (w.Module ?? {}) as Record<string, unknown>;
    for (const name of SELECT_EXPORTS) if (typeof mod[name] !== 'function') return fail('unsupported', name);
    if (staged == null || opened == null) return fail('not_ready', op);
    if (engineBusy() || keysBlocked(w) || placeWatch?.hanging() === true) return fail('busy', op);
    const done = await selectItems(w, a, {
      frame,
      timing,
      closed: () => closed,
      // A zoom is the view steered: a fit no longer holds. Nothing is pressed while a dialog came up meanwhile.
      press: (k) => { if (keysBlocked(w)) return; fitWatch?.disarm(); pressKey(w, k); },
    });
    return done.ok ? ok() : fail(done.code, done.message);
  }

  /** Waits until the engine's apply queue is empty (kicadCollabBusy), at most `ms`: false when it is still busy. */
  async function applyIdle(w: ToolWindow, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    for (;;) {
      if (closed) return false;
      let busy = true;
      try { busy = w.Module?.kicadCollabBusy?.() === true; } catch { busy = true; }
      if (!busy) return true;
      if (Date.now() >= deadline) return false;
      await sleep(timing.applyPollMs);
    }
  }

  /** The library nicknames the source boot was given serves (the mirror's, or the example library's), project libraries left out. */
  async function servedNames(): Promise<Set<string>> {
    if (libs == null) return new Set();
    const all = await libs.source.listLibs();
    return new Set(all.filter((l) => !(projectLibs?.owns(l.id) ?? false)).map((l) => l.name));
  }

  /**
   * project.libs (PROTOCOL.md): every check before any effect, in order: the
   * args (bad_args), the engine (not_ready, unsupported), each nickname in
   * order (bad_args for one the island serves another way, not_found for one
   * the folder's tables do not name as a project library), then busy while a
   * load is parked or a popup menu or a dialog is up. Then each library is
   * served from the folder (src/project-libs.ts), its row added to the
   * engine's table on its first registration (kicadLibsAddEntry, which also
   * loads it) and reloaded (kicadLibsReload: the folder read again, and a
   * KiCad project row of that name, staged by project.open, refreshed), and
   * the answer waits for the engine's apply queue to empty.
   */
  async function projectLibsOp(args: unknown): Promise<Answer> {
    const op = 'project.libs';
    if (!isObj(args) || !onlyKeys(args, ['libs']) || !Array.isArray(args.libs) || args.libs.length === 0 || args.libs.length > MAX_PROJECT_LIBS || !args.libs.every(isProjectNick)) return fail('bad_args', op);
    const nicks = [...new Set(args.libs as string[])];
    const w = win;
    if (w == null) return fail('not_ready', op);
    const mod = (w.Module ?? {}) as Record<string, unknown>;
    for (const name of LIBS_EXPORTS) if (typeof mod[name] !== 'function') return fail('unsupported', name);
    const project = projectLibs;
    const FS = w.FS;
    if (project == null || FS == null) return fail('unsupported', 'project libraries');
    const taken = await servedNames();
    // ${KIPRJMOD}: the folder of the project KiCad loaded, the open document's (KiCad loads the
    // project named after the file it opens, beside it); the project folder's root with none open.
    const prjmod = opened != null && opened.includes('/') ? opened.slice(0, opened.lastIndexOf('/')) : '';
    const found: ProjectLibrary[] = [];
    for (const nick of nicks) {
      if (taken.has(nick)) return fail('bad_args', `${op}: ${nick} is a library the island already serves`);
      const libsOf = project.find(nick, prjmod);
      if (libsOf.length === 0) return fail('not_found', nick);
      found.push(...libsOf);
    }
    if (closed) return fail('island_error', 'the frame closed');
    if (engineBusy() || keysBlocked(w)) return fail('busy', op);
    const t0 = Date.now();
    try {
      for (const lib of found) {
        const first = project.registered(lib.kind, lib.nick) == null;
        project.register(lib);
        const uri = project.uri(lib);
        if (first) {
          // An empty file at the uri, as boot writes one for every library: the editor's save path stats it.
          if (!FS.analyzePath(uri).exists) {
            FS.mkdirTree(uri.slice(0, uri.lastIndexOf('/')));
            FS.writeFile(uri, '');
          }
          await (mod.kicadLibsAddEntry as (k: string, n: string, u: string) => unknown)(lib.kind, lib.nick, uri);
        }
        await (mod.kicadLibsReload as (k: string, n: string) => unknown)(lib.kind, lib.nick);
      }
    } catch (err) {
      return fail('island_error', describeError(err));
    }
    if (!(await applyIdle(w, timing.libsMs))) return fail('island_error', 'the engine did not load the libraries within the time limit');
    console.debug('[libs]', `project.libs ${nicks.join(' ')}`, `${Date.now() - t0} ms`);
    return ok({
      symbol: nicks.filter((n) => found.some((l) => l.kind === 'symbol' && l.nick === n)),
      footprint: nicks.filter((n) => found.some((l) => l.kind === 'footprint' && l.nick === n)),
    });
  }

  /**
   * footprint.models (PROTOCOL.md, bridge/models.ts): the checks, in order: the
   * args (bad_args), the frame's kind (unsupported in a sch frame), the engine
   * (not_ready, unsupported), a board (not_ready), busy as for select, the
   * footprint (not_found). Then our engine's kicadFootprintSetModels queues
   * the commit, and the answer waits for the apply queue to empty and the
   * footprint's model lines to read back as sent.
   */
  async function footprintModels(args: unknown): Promise<Answer> {
    const op = 'footprint.models';
    const a = parseModelsArgs(args);
    if (a == null) return fail('bad_args', op);
    if (frame !== 'pcb') return fail('unsupported', 'a footprint\'s models change in a pcb frame');
    const w = win;
    if (w == null) return fail('not_ready', op);
    const mod = (w.Module ?? {}) as Record<string, unknown>;
    for (const name of MODEL_EXPORTS) if (typeof mod[name] !== 'function') return fail('unsupported', name);
    if (staged == null || opened == null) return fail('not_ready', op);
    if (engineBusy() || keysBlocked(w) || placeWatch?.hanging() === true) return fail('busy', op);
    const blobOf = (): string => {
      try { return String((mod.kicadCollabTestItemBlob as (id: string) => unknown)(a.uuid) ?? ''); } catch { return ''; }
    };
    if (readModels(blobOf()) == null) return fail('not_found', a.uuid);
    const t0 = Date.now();
    let queued: unknown;
    try {
      queued = await (mod.kicadFootprintSetModels as (id: string, json: string) => unknown)(a.uuid, modelsJson(a.models));
    } catch (err) {
      return fail('island_error', describeError(err));
    }
    if (queued !== true) return fail('not_applied', op);
    const deadline = Date.now() + timing.modelsMs;
    for (;;) {
      if (closed) return fail('island_error', 'the frame closed');
      if (await applyIdle(w, Math.max(0, deadline - Date.now()))) {
        const got = readModels(blobOf());
        if (got != null && sameModels(got, a.models)) break;
      }
      if (Date.now() >= deadline) return fail('not_applied', op);
      await sleep(timing.applyPollMs);
    }
    console.debug('[models]', a.uuid, `${Date.now() - t0} ms`);
    return ok();
  }

  /** The plots this frame ran: each takes the next folder under PLOT_ROOT. */
  let plotRuns = 0;

  /** Removes a plot folder and anything in it; a failure here never changes an answer. */
  function dropPlotFolder(FS: EmscriptenFS, dir: string): void {
    try { removeTree(FS, dir); } catch (err) { console.debug('[plot]', 'could not remove', dir, describeError(err)); }
  }

  /**
   * project.plot (PROTOCOL.md, bridge/plot.ts): the checks, in order, every one
   * before any effect: the args (bad_args), the frame's kind (unsupported in a
   * sch frame), the engine (not_ready, unsupported), a board (not_ready), busy
   * as for footprint.models. Then our engine's kicadPlotBoard queues the plot
   * into a fresh folder outside the project folder, and the answer waits for
   * the apply queue to empty and the run's record (.cc-plot.json, written
   * last), reads every file, removes the folder and answers. Nothing in the
   * board changes: KiCad's plot reads the board the editor holds.
   */
  async function projectPlot(args: unknown): Promise<Answer> {
    const op = 'project.plot';
    const a = parsePlotArgs(args);
    if (a == null) return fail('bad_args', op);
    if (frame !== 'pcb') return fail('unsupported', 'a board plots in a pcb frame');
    const w = win;
    if (w == null) return fail('not_ready', op);
    const mod = (w.Module ?? {}) as Record<string, unknown>;
    for (const name of PLOT_EXPORTS) if (typeof mod[name] !== 'function') return fail('unsupported', name);
    if (staged == null || opened == null) return fail('not_ready', op);
    if (engineBusy() || keysBlocked(w) || placeWatch?.hanging() === true) return fail('busy', op);
    const FS = w.FS;
    if (FS == null) return fail('island_error', 'the engine has no file system');
    plotRuns += 1;
    const dir = `${PLOT_ROOT}/${plotRuns}`;
    try {
      // A fresh folder: an earlier run that outlived its answer leaves nothing behind.
      if (FS.analyzePath(PLOT_ROOT).exists) {
        for (const name of FS.readdir(PLOT_ROOT)) {
          if (name === '.' || name === '..') continue;
          const stale = `${PLOT_ROOT}/${name}`;
          if (FS.isDir(FS.stat(stale).mode)) removeTree(FS, stale); else FS.unlink(stale);
        }
      }
      FS.mkdirTree(dir);
    } catch (err) {
      return fail('island_error', describeError(err));
    }
    const t0 = Date.now();
    let queued: unknown;
    try {
      queued = await (mod.kicadPlotBoard as (json: string) => unknown)(plotJson(dir, a));
    } catch (err) {
      dropPlotFolder(FS, dir);
      return fail('island_error', describeError(err));
    }
    if (queued !== true) {
      dropPlotFolder(FS, dir);
      return fail('not_applied', op);
    }
    const deadline = Date.now() + timing.plotMs;
    let done: PlotDone | null = null;
    for (;;) {
      if (closed) return fail('island_error', 'the frame closed');
      if (await applyIdle(w, Math.max(0, deadline - Date.now()))) {
        done = readPlotDone(readBytes(FS, `${dir}/${PLOT_DONE}`));
        if (done != null) break;
      }
      if (Date.now() >= deadline) {
        dropPlotFolder(FS, dir);
        return fail('not_applied', op);
      }
      await sleep(timing.applyPollMs);
    }
    const failure = plotFailure(done, a, dir);
    if (failure != null) {
      dropPlotFolder(FS, dir);
      return fail('plot_failed', failure);
    }
    let read: ReturnType<typeof readPlotFolder>;
    try {
      read = readPlotFolder(FS, dir);
    } catch (err) {
      dropPlotFolder(FS, dir);
      return fail('island_error', describeError(err));
    }
    dropPlotFolder(FS, dir);
    if ('error' in read) return fail('island_error', 'the plot wrote more than the protocol carries');
    const notes = plotNotes(done, dir);
    console.debug('[plot]', a.preset, `${read.files.length} files`, `${Date.now() - t0} ms`);
    return {
      ok: true,
      result: { files: read.files.map((f) => ({ path: f.path, bytes: f.bytes })), notes },
      transfer: read.files.map((f) => f.bytes.buffer as ArrayBuffer),
    };
  }


  /**
   * The checks every Editing window op makes, in order, every one before any
   * effect, after its args: the frame's kind (unsupported in a pcb frame), the
   * engine (not_ready before ev.ready; unsupported naming a missing export), a
   * schematic opened by project.open or project.import (not_ready), and busy
   * while a load is parked, a popup menu or a dialog is up, or an item placed
   * by place hangs off the pointer.
   */
  function schematicGate(op: string, exports: readonly string[]): Answer | { w: ToolWindow; mod: Record<string, unknown> } {
    if (frame !== 'sch') return fail('unsupported', 'a schematic edits in a sch frame');
    const w = win;
    if (w == null) return fail('not_ready', op);
    const mod = (w.Module ?? {}) as Record<string, unknown>;
    for (const name of exports) if (typeof mod[name] !== 'function') return fail('unsupported', name);
    if (staged == null || opened == null) return fail('not_ready', op);
    if (engineBusy() || keysBlocked(w) || placeWatch?.hanging() === true) return fail('busy', op);
    return { w, mod };
  }

  /** kicadSymbolGet's raw answer: '' for no such symbol; a throw reads as ''. */
  function symbolText(mod: Record<string, unknown>, uuid: string, sheetPath: string): string {
    try { return String((mod.kicadSymbolGet as (u: string, p: string) => unknown)(uuid, sheetPath) ?? ''); } catch { return ''; }
  }

  /**
   * symbol.get (PROTOCOL.md, bridge/symbol.ts): the checks (bad_args, then
   * schematicGate), then the engine's synchronous read of the symbol: on the
   * asked sheet path when it holds it, else on the sheet the editor shows,
   * else on the first path holding it. not_found when no sheet holds it.
   */
  function symbolGet(args: unknown): Answer {
    const op = 'symbol.get';
    const a = parseSymbolGetArgs(args);
    if (a == null) return fail('bad_args', op);
    const gate = schematicGate(op, SYMBOL_EXPORTS);
    if ('ok' in gate) return gate;
    const raw = symbolText(gate.mod, a.uuid, a.sheetPath ?? '');
    if (raw === '') return fail('not_found', a.uuid);
    const sheet = readSymbolSheet(raw);
    if (sheet == null) return fail('island_error', 'the engine answered a symbol of another shape');
    return ok(sheet as unknown as Record<string, unknown>);
  }

  /**
   * symbol.set (PROTOCOL.md, bridge/symbol.ts): the checks (bad_args, then
   * schematicGate), the symbol on that sheet path (not_found), the bounds the
   * symbol sets (bad_args: a field it lacks, a unit past its units). Then our
   * engine's kicadSymbolSet queues ONE commit (one undo step), and the answer
   * is the symbol read back once the apply queue is empty and it shows the
   * change; not_applied when the engine refuses the set or the read back does
   * not show it within timing.symbolMs. An ev.edited follows the answer.
   */
  async function symbolSet(args: unknown): Promise<Answer> {
    const op = 'symbol.set';
    const a = parseSymbolSetArgs(args);
    if (a == null) return fail('bad_args', op);
    const gate = schematicGate(op, SYMBOL_EXPORTS);
    if ('ok' in gate) return gate;
    const { w, mod } = gate;
    const raw = symbolText(mod, a.uuid, a.sheetPath);
    if (raw === '') return fail('not_found', a.uuid);
    const before = readSymbolSheet(raw);
    if (before == null) return fail('island_error', 'the engine answered a symbol of another shape');
    // The engine falls back to another sheet when the asked one does not hold the symbol: the asked instance is not there.
    if (before.sheetPath !== a.sheetPath) return fail('not_found', `${a.uuid} on ${a.sheetPath}`);
    const why = misfit(a.set, before);
    if (why != null) return fail('bad_args', `${op}: ${why}`);
    const t0 = Date.now();
    let queued: unknown;
    try {
      queued = (mod.kicadSymbolSet as (json: string) => unknown)(symbolSetJson(a));
    } catch (err) {
      return fail('island_error', describeError(err));
    }
    if (queued !== true) return fail('not_applied', op);
    const deadline = Date.now() + timing.symbolMs;
    let after: SymbolSheet | null = null;
    for (;;) {
      if (closed) return fail('island_error', 'the frame closed');
      if (await applyIdle(w, Math.max(0, deadline - Date.now()))) {
        after = readSymbolSheet(symbolText(mod, a.uuid, a.sheetPath));
        if (after != null && showsSet(a.set, before, after)) break;
      }
      if (Date.now() >= deadline) return fail('not_applied', op);
      await sleep(timing.applyPollMs);
    }
    console.debug('[symbol]', a.uuid, Object.keys(a.set).join(' '), `${Date.now() - t0} ms`);
    return ok(after as unknown as Record<string, unknown>);
  }

  // ---------------------------------------------------------------- the simulator (PROTOCOL.md sim.*)

  /** A run the island started: from its sim.run past the checks until its record. */
  interface LiveSim {
    run: number;
    dir: string;
    kind: SimKind;
    accepted: boolean;
    /** The service's worker died during the run: its end is service_failed. */
    died: boolean;
    /** The last loading or running event and its percent: at most one each PROGRESS_MS. */
    lastAt: number;
    lastPhase: 'loading' | 'running' | null;
    lastPercent: number | null;
    /** A progress event held back by the 250 ms rule, sent when its turn comes (if the run has not ended). */
    held: { phase: 'loading' | 'running'; percent: number | null } | null;
    heldTimer: ReturnType<typeof setTimeout> | null;
  }
  /** The runs started so far: each run takes the next number and folder. */
  let simRuns = 0;
  /** The run live now, if any (one at a time). */
  let simLive: LiveSim | null = null;
  /** The ended runs' results, and the service's life each was read in. */
  const simResults = new Map<number, { result: SimResult; life: number }>();
  /** The latest run of each analysis kind: an earlier one of its kind is gone from the service. */
  const simLatest = new Map<SimKind, number>();
  /** The service's life: one more each time its worker ends (released or died), so its vectors are gone. */
  let simLife = 0;
  /** The netlist's names, from the last netlist read (sim.netlist, or the island's own read for a run). */
  let simNames: NetNames | null = null;

  /** What the service says: the wasm's loading and the run's progress lines become ev.sim; its end ends the vectors. */
  simService?.listen((n) => {
    if (closed) return;
    if (n.type === 'died' || n.type === 'released') {
      simLife += 1;
      if (n.type === 'died' && simLive != null) {
        const live = simLive;
        live.died = true;
        // The engine finishes a run whose service died (the provider's own
        // closing event); if no record comes in time, the island stops it.
        setTimeout(() => { if (simLive === live && !closed) simStopCall(); }, timing.simDeathMs);
      }
      return;
    }
    const live = simLive;
    if (live == null) return;
    if (n.type === 'progress') {
      if (live.accepted) return;
      const percent = n.total > 0 ? Math.max(0, Math.min(100, Math.floor((n.loaded / n.total) * 100))) : null;
      simProgress(live, 'loading', percent);
      return;
    }
    if (n.type === 'event' && n.evt.kind === 'stat' && Array.isArray(n.evt.lines)) {
      let percent: number | null = null;
      for (const line of n.evt.lines) {
        const p = typeof line === 'string' ? statPercent(line) : null;
        if (p != null) percent = p;
      }
      if (percent != null) simProgress(live, 'running', percent);
    }
  });

  /**
   * A loading or running event, at most one each PROGRESS_MS for the same
   * phase: one that comes sooner is held and sent when its turn comes, the
   * latest held one only, and never after the run's end (a new phase goes out
   * at once). The same phase and percent again is not sent.
   */
  function simProgress(live: LiveSim, phase: 'loading' | 'running', percent: number | null, force = false): void {
    if (simLive !== live || closed) return;
    const now = Date.now();
    if (live.lastPhase === phase && live.lastPercent === percent) { live.held = null; return; }
    const wait = live.lastAt + PROGRESS_MS - now;
    if (!force && live.lastPhase === phase && wait > 0) {
      live.held = { phase, percent };
      live.heldTimer ??= setTimeout(() => {
        live.heldTimer = null;
        const held = live.held;
        live.held = null;
        if (held != null) simProgress(live, held.phase, held.percent);
      }, wait);
      return;
    }
    live.held = null;
    live.lastAt = now;
    live.lastPhase = phase;
    live.lastPercent = percent;
    emit(percent == null ? { type: 'ev.sim', run: live.run, phase } : { type: 'ev.sim', run: live.run, phase, percent });
  }

  /** The checks every sim op makes after its args: a sch frame, the engine and its exports, the service, an open document, nothing held up. */
  function simGate(op: string, exports: readonly string[], opts2: { service?: boolean; held?: boolean } = {}): Answer | { w: ToolWindow; mod: Record<string, unknown> } {
    if (frame !== 'sch') return fail('unsupported', SIM_FRAME_ONLY);
    const w = win;
    if (w == null) return fail('not_ready', op);
    const mod = (w.Module ?? {}) as Record<string, unknown>;
    for (const name of exports) if (typeof mod[name] !== 'function') return fail('unsupported', name);
    if (opts2.service === true && simService == null) return fail('unsupported', 'ngspice_service.wasm');
    if (staged == null || opened == null) return fail('not_ready', op);
    if (opts2.held !== false && (engineBusy() || keysBlocked(w) || placeWatch?.hanging() === true)) return fail('busy', op);
    return { w, mod };
  }

  /** A well-formed request for sim.stop or sim.release, answered off the queue. */
  function isSimNow(data: unknown): data is { id: number; op: string; args?: unknown } {
    return isObj(data) && typeof data.id === 'number' && Number.isSafeInteger(data.id) && (data.op === 'sim.stop' || data.op === 'sim.release');
  }

  /** kicadSimStop: the live run halted (its record then says stopped); a throw reads as false. */
  function simStopCall(): boolean {
    const stop = (win?.Module as Record<string, unknown> | undefined)?.kicadSimStop;
    if (typeof stop !== 'function') return false;
    try { return (stop as () => unknown)() === true; } catch { return false; }
  }

  /**
   * sim.stop and sim.release (PROTOCOL.md), answered as they arrive: Stop asks
   * the engine to halt the live run (answered {} with no run live too: nothing
   * to stop); release ends the service's worker when no run is live (busy while
   * one is), and the next run boots it again.
   */
  function simNow(data: { id: number; op: string; args?: unknown }): void {
    if (closed) return;
    const { id, op } = data;
    if (!onlyKeys(data as unknown as Record<string, unknown>, ['id', 'op', 'args']) || !noArgs(data.args)) return reply(id, fail('bad_args', op));
    if (stopped != null) return reply(id, fail('not_ready', 'the engine stopped'));
    const gate = simGate(op, SIM_RUN_EXPORTS, { service: true, held: false });
    if ('ok' in gate) return reply(id, gate);
    if (op === 'sim.stop') {
      if (simLive != null) simStopCall();
      return reply(id, ok());
    }
    if (simLive != null) return reply(id, fail('busy', 'a run is live'));
    simService?.release();
    return reply(id, ok());
  }

  /** kicadSimNetlist's raw answer ('' when it refused); it may answer a Promise (it waits on the service for an IBIS part). */
  async function netlistText(mod: Record<string, unknown>, command: string, options: unknown): Promise<string> {
    try { return String(await (mod.kicadSimNetlist as (json: string) => unknown)(JSON.stringify({ command, options })) ?? ''); } catch { return ''; }
  }

  /** The netlist's names, read again from the engine (an analysis line that names nothing). */
  async function refreshNames(mod: Record<string, unknown>): Promise<NetNames | null> {
    const read = readNetlist(await netlistText(mod, '.op', { voltages: true, currents: true, dissipations: false, events: false }));
    if (read != null) simNames = namesOf(read.netlist);
    return read == null ? null : simNames;
  }

  /** The analysis line for a run or a netlist: each name the netlist's, read again once when one is not. */
  async function analysisLine(mod: Record<string, unknown>, a: Parameters<typeof commandOf>[0]): Promise<{ command: string } | Answer> {
    const empty: NetNames = { nodes: new Set(), sources: new Set() };
    let line = commandOf(a, simNames ?? empty);
    if ('unknown' in line) {
      const names = await refreshNames(mod);
      if (names != null) line = commandOf(a, names);
    }
    if ('unknown' in line) return fail('bad_args', `the netlist names no ${line.unknown}`);
    return line;
  }

  /** sim.catalog: KiCad's model tables, every device's types, or one type's pins and parameters. */
  function simCatalog(args: unknown): Answer {
    const op = 'sim.catalog';
    const a = parseCatalogArgs(args);
    if (a == null) return fail('bad_args', op);
    const gate = simGate(op, SIM_MODEL_EXPORTS, { held: false });
    if ('ok' in gate) return gate;
    let raw = '';
    try { raw = String((gate.mod.kicadSimModelCatalog as (json: string) => unknown)(JSON.stringify(a)) ?? ''); } catch { raw = ''; }
    if (a.type != null) {
      if (raw === '') return fail('bad_args', `no model type ${a.type}`);
      const entry = readCatalogEntry(raw);
      return entry == null ? fail('island_error', 'the engine answered a catalog of another shape') : ok(entry as unknown as Record<string, unknown>);
    }
    const all = readCatalog(raw);
    return all == null ? fail('island_error', 'the engine answered a catalog of another shape') : ok(all as unknown as Record<string, unknown>);
  }

  /** kicadSimModelGet's raw answer: '' for no such symbol; a throw reads as ''. */
  function modelText(mod: Record<string, unknown>, uuid: string, sheetPath: string): string {
    try { return String((mod.kicadSimModelGet as (json: string) => unknown)(JSON.stringify({ uuid, sheetPath })) ?? ''); } catch { return ''; }
  }

  /** sim.model.get: one symbol's model as KiCad resolves it for the netlist. */
  function simModelGet(args: unknown): Answer {
    const op = 'sim.model.get';
    const a = parseModelGetArgs(args);
    if (a == null) return fail('bad_args', op);
    const gate = simGate(op, SIM_MODEL_EXPORTS, { held: false });
    if ('ok' in gate) return gate;
    const raw = modelText(gate.mod, a.uuid, a.sheetPath);
    if (raw === '') return fail('not_found', a.uuid);
    const sheet = readModelSheet(raw);
    return sheet == null ? fail('island_error', 'the engine answered a model of another shape') : ok(sheet as unknown as Record<string, unknown>);
  }

  /**
   * sim.model.set: the model checked whole by the engine on a scratch model,
   * then ONE commit (one undo step); the answer is the model read back once
   * the apply queue is empty and it shows the set.
   */
  async function simModelSet(args: unknown): Promise<Answer> {
    const op = 'sim.model.set';
    const a = parseModelSetArgs(args);
    if (a == null) return fail('bad_args', op);
    const gate = simGate(op, SIM_MODEL_EXPORTS);
    if ('ok' in gate) return gate;
    const { w, mod } = gate;
    const before = readModelSheet(modelText(mod, a.uuid, a.sheetPath));
    if (before == null) return fail('not_found', a.uuid);
    // The engine falls back to another sheet when the asked one does not hold the symbol.
    if (before.sheetPath !== a.sheetPath) return fail('not_found', `${a.uuid} on ${a.sheetPath}`);
    let queued: unknown;
    try {
      queued = (mod.kicadSimModelSet as (json: string) => unknown)(JSON.stringify({ uuid: a.uuid, sheetPath: a.sheetPath, model: a.model }));
    } catch (err) {
      return fail('island_error', describeError(err));
    }
    if (queued !== true) return fail('model_invalid', `${op}: the engine refused the model`);
    const deadline = Date.now() + timing.simModelMs;
    for (;;) {
      if (closed) return fail('island_error', 'the frame closed');
      if (await applyIdle(w, Math.max(0, deadline - Date.now()))) {
        const after = readModelSheet(modelText(mod, a.uuid, a.sheetPath));
        if (after != null && showsModelSet(a.model, after)) return ok(after as unknown as Record<string, unknown>);
      }
      if (Date.now() >= deadline) return fail('not_applied', op);
      await sleep(timing.applyPollMs);
    }
  }

  /** sim.file: the models of a SPICE or IBIS file in the project folder. */
  function simFile(args: unknown): Answer {
    const op = 'sim.file';
    const a = parseFileArgs(args);
    if (a == null) return fail('bad_args', op);
    const gate = simGate(op, SIM_MODEL_EXPORTS, { held: false });
    if ('ok' in gate) return gate;
    let raw = '';
    try { raw = String((gate.mod.kicadSimFileRead as (json: string) => unknown)(JSON.stringify(a)) ?? ''); } catch { raw = ''; }
    if (raw === '') return fail('bad_args', `${op}: the engine refused the path`);
    const file = readSimFile(raw);
    return file == null ? fail('island_error', 'the engine answered a model file of another shape') : ok(file as unknown as Record<string, unknown>);
  }

  /** sim.netlist: KiCad's SPICE netlist of the whole schematic with the island's analysis line, and its problems. */
  async function simNetlist(args: unknown): Promise<Answer> {
    const op = 'sim.netlist';
    const a = parseNetlistArgs(args);
    if (a == null) return fail('bad_args', op);
    const gate = simGate(op, SIM_RUN_EXPORTS);
    if ('ok' in gate) return gate;
    if (simLive != null) return fail('busy', 'a run is live');
    const line = await analysisLine(gate.mod, a.analysis);
    if (!('command' in line)) return line;
    const raw = await netlistText(gate.mod, line.command, a.options);
    const read = readNetlist(raw);
    if (read == null) return simLive != null ? fail('busy', 'a run is live') : fail('island_error', 'the engine answered no netlist');
    simNames = namesOf(read.netlist);
    return ok(read as unknown as Record<string, unknown>);
  }

  /** A fresh folder for run n under SIM_ROOT: what ended runs left there is removed first. */
  function simFolder(FS: EmscriptenFS, n: number): string {
    if (FS.analyzePath(SIM_ROOT).exists) {
      for (const name of FS.readdir(SIM_ROOT)) {
        if (name === '.' || name === '..') continue;
        const stale = `${SIM_ROOT}/${name}`;
        if (FS.isDir(FS.stat(stale).mode)) removeTree(FS, stale); else FS.unlink(stale);
      }
    }
    const dir = `${SIM_ROOT}/${n}`;
    FS.mkdirTree(dir);
    return dir;
  }

  /**
   * sim.run: the analysis line written by the island, the run queued in the
   * engine, answered once ngspice accepted it (accepted.json), or with the
   * record's error when it ended first; not_applied when neither came within
   * timing.simAcceptMs. The run goes on off the queue until its record, which
   * sends its one end event; the editor is not held meanwhile.
   */
  async function simRun(args: unknown): Promise<Answer> {
    const op = 'sim.run';
    const a = parseRunArgs(args);
    if (a == null) return fail('bad_args', op);
    const gate = simGate(op, SIM_RUN_EXPORTS, { service: true });
    if ('ok' in gate) return gate;
    const { w, mod } = gate;
    if (simLive != null) return fail('busy', 'a run is live');
    const FS = w.FS;
    if (FS == null) return fail('island_error', 'the engine has no file system');
    let command: string;
    let fftOf: number | null = null;
    if (a.analysis.kind === 'fft') {
      const source = simResults.get(a.analysis.of);
      if (source == null || source.result.kind !== 'tran' || simLatest.get('tran') !== a.analysis.of || source.life !== simLife) return fail('no_simulation', `run ${a.analysis.of}`);
      const line = fftLines(a.analysis, source.result.plots.flatMap((p) => p.vectors));
      if ('unknown' in line) return fail('bad_args', `the transient has no ${line.unknown}`);
      command = line.command;
      fftOf = a.analysis.of;
    } else {
      const line = await analysisLine(mod, a.analysis);
      if (!('command' in line)) return line;
      command = line.command;
    }
    const kind: SimKind = a.analysis.kind === 'sheet' ? 'op' : a.analysis.kind;
    simRuns += 1;
    const n = simRuns;
    let dir: string;
    try { dir = simFolder(FS, n); } catch (err) { return fail('island_error', describeError(err)); }
    const live: LiveSim = { run: n, dir, kind, accepted: false, died: false, lastAt: 0, lastPhase: null, lastPercent: null, held: null, heldTimer: null };
    simLive = live;
    let queued: unknown;
    try {
      queued = (mod.kicadSimRun as (json: string) => unknown)(runJson(n, dir, command, a.options, a.overrides, fftOf));
    } catch (err) {
      simLive = null;
      dropRunFolder(FS, dir);
      return fail('island_error', describeError(err));
    }
    if (queued !== true) { simLive = null; dropRunFolder(FS, dir); return fail('not_applied', op); }
    // The run's kind as the island wrote it ("sheet" reads its own directive: the record says which).
    if (a.analysis.kind !== 'sheet') simLatest.set(kind, n);
    const answer = new Promise<Answer>((resolve) => { void watchSim(live, FS, resolve); });
    return answer;
  }

  /**
   * Watches a live run's folder: answers sim.run at its acceptance (or with the
   * record's error when it ended first), then, with no time limit, ends the
   * run at its record: the result kept, the one end event sent, the folder removed.
   */
  async function watchSim(live: LiveSim, FS: EmscriptenFS, answer: (a: Answer) => void): Promise<void> {
    const t0 = Date.now();
    let answered = false;
    const say = (a: Answer): void => { if (!answered) { answered = true; answer(a); } };
    for (;;) {
      if (closed) { say(fail('island_error', 'the frame closed')); return; }
      if (!live.accepted) {
        const accepted = readAccepted(readBytes(FS, `${live.dir}/${SIM_ACCEPTED}`));
        if (accepted != null && accepted.run === live.run) {
          live.accepted = true;
          simProgress(live, 'running', null, true);
          say(ok({ run: live.run, problems: accepted.problems }));
        }
      }
      const done = readSimDone(readBytes(FS, `${live.dir}/${SIM_DONE}`));
      if (done != null && done.run === live.run) {
        if (!live.accepted) {
          const first = done.problems.find((p) => p.severity === 'error');
          say(fail(done.error === '' ? 'sim_failed' : done.error, cut(first?.text ?? done.message ?? done.error, 1024)));
        }
        endSim(live, FS, done);
        return;
      }
      if (!answered && Date.now() - t0 >= timing.simAcceptMs) {
        // Never accepted (the service did not load, or the engine never ran it): the
        // run is stopped, so its record still comes and ends it.
        say(fail('not_applied', 'sim.run'));
        simStopCall();
      }
      await sleep(timing.simPollMs);
    }
  }

  /** A run's end: its result read and kept (the latest of its kind), its one end event, its folder removed. */
  function endSim(live: LiveSim, FS: EmscriptenFS, done: SimDone): void {
    const result = readSimResult(readBytes(FS, `${live.dir}/${SIM_RESULT}`));
    dropRunFolder(FS, live.dir);
    if (simLive === live) simLive = null;
    live.held = null;
    if (live.heldTimer != null) { clearTimeout(live.heldTimer); live.heldTimer = null; }
    if (result != null && result.run === live.run) {
      simResults.set(live.run, { result, life: simLife });
      simLatest.set(result.kind, live.run);
      // Only the latest of each kind is held by the service: the rest are dropped.
      for (const [run, kept] of [...simResults]) if (simLatest.get(kept.result.kind) !== run) simResults.delete(run);
    }
    if (live.died) emit({ type: 'ev.sim', run: live.run, phase: 'failed', code: 'service_failed' });
    else if (done.error === '') emit({ type: 'ev.sim', run: live.run, phase: 'done' });
    else if (done.error === 'stopped') emit({ type: 'ev.sim', run: live.run, phase: 'stopped' });
    else emit({ type: 'ev.sim', run: live.run, phase: 'failed', code: done.error });
    console.debug('[sim]', `run ${live.run}`, done.error === '' ? 'done' : done.error);
  }

  /** The ended run asked: its result, or no_simulation for a run the service no longer holds. */
  function simEnded(op: string, run: number): Answer | SimResult {
    if (simLive?.run === run) return fail('busy', `run ${run} has not ended`);
    const kept = simResults.get(run);
    if (kept == null || simLatest.get(kept.result.kind) !== run) return fail('no_simulation', `run ${run}`);
    return kept.result;
  }

  /** sim.result: an ended run's result. */
  function simResultOp(args: unknown): Answer {
    const op = 'sim.result';
    const a = parseResultArgs(args);
    if (a == null) return fail('bad_args', op);
    const gate = simGate(op, SIM_RUN_EXPORTS, { service: true, held: false });
    if ('ok' in gate) return gate;
    const got = simEnded(op, a.run);
    return 'ok' in got ? got : ok(got as unknown as Record<string, unknown>);
  }

  /**
   * sim.vectors: the named vectors of an ended run, read from the service
   * directly (the engine is not involved), each a fresh array, transferred.
   */
  async function simVectors(args: unknown): Promise<Answer> {
    const op = 'sim.vectors';
    const a = parseVectorsArgs(args);
    if (a == null) return fail('bad_args', op);
    const gate = simGate(op, SIM_RUN_EXPORTS, { service: true, held: false });
    if ('ok' in gate) return gate;
    if (simLive != null) return fail('busy', 'a run is live');
    const got = simEnded(op, a.run);
    if ('ok' in got) return got;
    if (simResults.get(a.run)?.life !== simLife) return fail('no_simulation', `run ${a.run}: the simulator was released`);
    const wanted = vectorsOf(got, a.names);
    if ('missing' in wanted) return fail('bad_args', `run ${a.run} has no ${wanted.missing}`);
    if (vectorBytes(wanted.found) > MAX_VECTOR_BYTES) return fail('island_error', 'the vectors are more than the protocol carries');
    const vectors: Array<{ name: string; real: Float64Array; imag: Float64Array | null }> = [];
    const transfer: ArrayBuffer[] = [];
    for (const want of wanted.found) {
      const res = await simService!.request({ kind: 'get_vec_info', name: qualifiedVector(want.plot, want.name) });
      const split = splitVector(res);
      if (split == null) return fail('no_simulation', `run ${a.run}: the simulator holds no ${want.name}`);
      vectors.push({ name: want.name, real: split.real, imag: split.imag });
      transfer.push(split.real.buffer as ArrayBuffer);
      if (split.imag != null) transfer.push(split.imag.buffer as ArrayBuffer);
    }
    return { ok: true, result: { vectors }, transfer };
  }

  /** sim.opOnSheet: KiCad's own operating point labels on the drawing, from the last operating point. */
  async function simOpOnSheet(args: unknown): Promise<Answer> {
    const op = 'sim.opOnSheet';
    const a = parseOpOnSheetArgs(args);
    if (a == null) return fail('bad_args', op);
    const gate = simGate(op, SIM_RUN_EXPORTS);
    if ('ok' in gate) return gate;
    let queued: unknown;
    try { queued = (gate.mod.kicadSimOpOnSheet as (json: string) => unknown)(JSON.stringify(a)); } catch (err) { return fail('island_error', describeError(err)); }
    if (queued !== true) return fail('not_applied', op);
    return (await applyIdle(gate.w, timing.simModelMs)) ? ok() : fail('not_applied', op);
  }

  /** A new document: the last one's runs, results and names are not its own. */
  function forgetSim(): void {
    simResults.clear();
    simLatest.clear();
    simNames = null;
  }

  /** The runs this frame made: each takes the next folder under its root. */
  let runs = 0;

  /** A fresh folder under `rootDir` for the next run: what an earlier run left there is removed first. */
  function freshRunFolder(FS: EmscriptenFS, rootDir: string): string {
    if (FS.analyzePath(rootDir).exists) {
      for (const name of FS.readdir(rootDir)) {
        if (name === '.' || name === '..') continue;
        const stale = `${rootDir}/${name}`;
        if (FS.isDir(FS.stat(stale).mode)) removeTree(FS, stale); else FS.unlink(stale);
      }
    }
    runs += 1;
    const dir = `${rootDir}/${runs}`;
    FS.mkdirTree(dir);
    return dir;
  }

  /** Removes a run's folder and anything in it; a failure here never changes an answer. */
  function dropRunFolder(FS: EmscriptenFS, dir: string): void {
    try { removeTree(FS, dir); } catch (err) { console.debug('[run]', 'could not remove', dir, describeError(err)); }
  }

  /**
   * One queued run of the engine (sheet.annotate, sheet.check): `call` queues
   * it with the folder it writes in, and its record is read once the apply
   * queue is empty and the record is there. not_applied when the engine
   * refused the run or no record came within `ms` (the folder then removed).
   */
  async function queuedRun<T>(op: string, w: ToolWindow, FS: EmscriptenFS, dir: string, ms: number, call: () => unknown, record: () => T | null): Promise<{ done: T } | Answer> {
    let queued: unknown;
    try {
      queued = await call();
    } catch (err) {
      dropRunFolder(FS, dir);
      return fail('island_error', describeError(err));
    }
    if (queued !== true) { dropRunFolder(FS, dir); return fail('not_applied', op); }
    const deadline = Date.now() + ms;
    for (;;) {
      if (closed) return fail('island_error', 'the frame closed');
      if (await applyIdle(w, Math.max(0, deadline - Date.now()))) {
        const done = record();
        if (done != null) return { done };
      }
      if (Date.now() >= deadline) { dropRunFolder(FS, dir); return fail('not_applied', op); }
      await sleep(timing.applyPollMs);
    }
  }

  /**
   * sheet.annotate (PROTOCOL.md, bridge/annotate.ts): the checks (bad_args,
   * then schematicGate). Then our engine's kicadAnnotate numbers the parts in
   * a fresh folder under /tmp/cc-annotate/ as ONE commit (none when nothing
   * moved), and the answer is every designator that moved and the warning and
   * error lines, once its record (.cc-annotate.json) is there; the folder is
   * removed. An ev.edited follows when anything moved.
   */
  async function sheetAnnotate(args: unknown): Promise<Answer> {
    const op = 'sheet.annotate';
    const a = parseAnnotateArgs(args);
    if (a == null) return fail('bad_args', op);
    const gate = schematicGate(op, ANNOTATE_EXPORTS);
    if ('ok' in gate) return gate;
    const { w, mod } = gate;
    const FS = w.FS;
    if (FS == null) return fail('island_error', 'the engine has no file system');
    let dir: string;
    try { dir = freshRunFolder(FS, ANNOTATE_ROOT); } catch (err) { return fail('island_error', describeError(err)); }
    const t0 = Date.now();
    const run = await queuedRun<AnnotateDone>(op, w, FS, dir, timing.annotateMs,
      () => (mod.kicadAnnotate as (json: string) => unknown)(annotateJson(runs, dir, a)),
      () => readAnnotateDone(readBytes(FS, `${dir}/${ANNOTATE_DONE}`)));
    if (!('done' in run)) return run;
    dropRunFolder(FS, dir);
    if (run.done.changes.length > MAX_CHANGES) return fail('island_error', 'the numbering changed more than the protocol carries');
    console.debug('[annotate]', `${run.done.changes.length} changes`, `${Date.now() - t0} ms`);
    return ok({ changes: run.done.changes, notes: runNotes(run.done.lines, dir) });
  }

  /** Starts a checked sheet.check off the request chain; its answer is sent when it ends. */
  function startCheck(id: number, args: unknown): void {
    const op = 'sheet.check';
    if (!noArgs(args)) return reply(id, fail('bad_args', op));
    const gate = schematicGate(op, CHECK_EXPORTS);
    if ('ok' in gate) return reply(id, gate);
    checking = true;
    void sheetCheck(gate.w, gate.mod)
      .catch((err: unknown) => fail('island_error', describeError(err)))
      .then((a) => { checking = false; reply(id, a); });
  }

  /**
   * sheet.check (PROTOCOL.md, bridge/check.ts), past its checks (startCheck):
   * our engine's kicadCheckSheet runs KiCad's ERC in a fresh folder under
   * /tmp/cc-erc/, and once its record (.cc-erc.json) is there the answer is
   * KiCad's report (erc.json) read into sheets and findings; the folder is
   * removed. Nothing in the document changes (no undo step, no ev.edited);
   * KiCad's own marks stay on the drawing.
   */
  async function sheetCheck(w: ToolWindow, mod: Record<string, unknown>): Promise<Answer> {
    const op = 'sheet.check';
    const FS = w.FS;
    if (FS == null) return fail('island_error', 'the engine has no file system');
    let dir: string;
    try { dir = freshRunFolder(FS, CHECK_ROOT); } catch (err) { return fail('island_error', describeError(err)); }
    const t0 = Date.now();
    const run = await queuedRun<CheckDone>(op, w, FS, dir, timing.checkMs,
      () => (mod.kicadCheckSheet as (json: string) => unknown)(JSON.stringify({ run: runs, dir })),
      () => readCheckDone(readBytes(FS, `${dir}/${CHECK_DONE}`)));
    if (!('done' in run)) return run;
    const report = readCheckReport(readBytes(FS, `${dir}/${CHECK_REPORT}`));
    dropRunFolder(FS, dir);
    if (run.done.code !== 0) {
      const first = run.done.lines.find((l) => l.severity === 'error');
      return fail('island_error', first != null ? runText(first.text, dir) : `the check ended with code ${run.done.code}`);
    }
    if (report == null) return fail('island_error', 'the check report was of another shape');
    console.debug('[check]', `${report.errors} errors ${report.warnings} warnings`, `${Date.now() - t0} ms`);
    return ok(report as unknown as Record<string, unknown>);
  }

  /**
   * The checks every board op makes after its args, in order, every one
   * before any effect: the frame's kind (unsupported in a sch frame), the
   * engine (not_ready before ev.ready; unsupported naming a missing export), a
   * board opened by project.open or project.import (not_ready), and busy while
   * a load is parked, a popup menu or a dialog is up, or an item placed by
   * place hangs off the pointer.
   */
  function boardGate(op: string, exports: readonly string[]): Answer | { w: ToolWindow; mod: Record<string, unknown> } {
    if (frame !== 'pcb') return fail('unsupported', BOARD_FRAME_ONLY);
    const w = win;
    if (w == null) return fail('not_ready', op);
    const mod = (w.Module ?? {}) as Record<string, unknown>;
    for (const name of exports) if (typeof mod[name] !== 'function') return fail('unsupported', name);
    if (staged == null || opened == null) return fail('not_ready', op);
    if (engineBusy() || keysBlocked(w) || placeWatch?.hanging() === true) return fail('busy', op);
    return { w, mod };
  }

  /**
   * Closes every dialog up but a progress dialog without accepting anything it
   * asks (bridge/import.ts closeDialog: Cancel, No or Close, else a lone OK,
   * else its close box). Answers the first one's title, or null when none was up.
   */
  function closeRunDialogs(w: ToolWindow): string | null {
    let first: string | null = null;
    for (const v of visibleDialogs(w)) {
      if (isProgressDialog(v)) continue;
      const title = dialogTitle(w, v);
      first ??= title === '' ? 'a KiCad dialog' : title;
      closeDialog(w, v);
    }
    return first;
  }

  /**
   * One queued run of a board op (board.check, board.preview, board.update):
   * as queuedRun, and while it runs every dialog met is closed without
   * accepting it, the first one's title answered beside the record. The queue
   * is read in short steps so a dialog is seen while the engine waits on it.
   */
  async function watchedRun<T>(op: string, w: ToolWindow, FS: EmscriptenFS, dir: string, ms: number, call: () => unknown, record: () => T | null): Promise<{ done: T; dialog: string | null } | Answer> {
    let queued: unknown;
    try {
      queued = await call();
    } catch (err) {
      dropRunFolder(FS, dir);
      return fail('island_error', describeError(err));
    }
    if (queued !== true) { dropRunFolder(FS, dir); return fail('not_applied', op); }
    const deadline = Date.now() + ms;
    let dialog: string | null = null;
    for (;;) {
      if (closed) return fail('island_error', 'the frame closed');
      const met = closeRunDialogs(w);
      dialog ??= met;
      let busy = true;
      try { busy = w.Module?.kicadCollabBusy?.() === true; } catch { busy = true; }
      if (!busy) {
        const done = record();
        if (done != null) return { done, dialog };
      }
      if (Date.now() >= deadline) { closeRunDialogs(w); dropRunFolder(FS, dir); return fail('not_applied', op); }
      await sleep(timing.applyPollMs);
    }
  }

  /**
   * Gives the drawing wx's keyboard focus back after a run that opened the
   * hidden schematic editor (a check's comparison, a preview, an update): its
   * open takes the focus, and every later key went unread (engine run 12,
   * measured on the local pair). A middle press, so the selection the run left
   * stays (focusCanvasQuietly).
   */
  function refocus(w: ToolWindow): void {
    try { focusCanvasQuietly(w.document); } catch { /* the reader's next press in the drawing focuses it */ }
  }

  /** Starts a checked board.check off the request chain; its answer is sent when it ends. */
  function startBoardCheck(id: number, args: unknown): void {
    const op = 'board.check';
    const a = parseBoardCheckArgs(args);
    if (a == null) return reply(id, fail('bad_args', op));
    const gate = boardGate(op, BOARD_CHECK_EXPORTS);
    if ('ok' in gate) return reply(id, gate);
    checking = true;
    void boardCheck(gate.w, gate.mod, a)
      .catch((err: unknown) => fail('island_error', describeError(err)))
      .then((answer) => { checking = false; reply(id, answer); });
  }

  /**
   * board.check (PROTOCOL.md, bridge/boardCheck.ts), past its checks
   * (startBoardCheck): our engine's kicadCheckBoard runs KiCad's design rules
   * check in a fresh folder under /tmp/cc-drc/, and once its record
   * (.cc-drc.json) is there the answer is its report (drc.json) read closed;
   * the folder is removed. A dialog met meanwhile is closed without accepting
   * it and the answer is island_error naming it. KiCad's own marks stay on the
   * board; only the fill, when asked, makes an undo step.
   */
  async function boardCheck(w: ToolWindow, mod: Record<string, unknown>, a: BoardCheckArgs): Promise<Answer> {
    const op = 'board.check';
    const FS = w.FS;
    if (FS == null) return fail('island_error', 'the engine has no file system');
    let dir: string;
    try { dir = freshRunFolder(FS, BOARD_CHECK_ROOT); } catch (err) { return fail('island_error', describeError(err)); }
    const run = runs;
    const t0 = Date.now();
    const result = await watchedRun<BoardCheckDone>(op, w, FS, dir, timing.boardCheckMs,
      () => (mod.kicadCheckBoard as (json: string) => unknown)(boardCheckJson(run, dir, a)),
      () => readBoardCheckDone(readBytes(FS, `${dir}/${BOARD_CHECK_DONE}`)));
    if (a.parity) refocus(w);
    if (!('done' in result)) return result;
    const report = readDrcReport(readBytes(FS, `${dir}/${BOARD_CHECK_REPORT}`));
    dropRunFolder(FS, dir);
    if (result.dialog != null) return fail('island_error', result.dialog);
    const { done } = result;
    // KiCad's parse message: its first line, the frame's project folder taken out.
    if (done.error === 'rules_invalid') return fail('rules_invalid', runText(done.message.split('\n')[0], dir).split(`${root}/`).join('') || op);
    if (done.code !== 0) {
      const first = done.lines.find((l) => l.severity === 'error');
      return fail('island_error', first != null ? runText(first.text, dir) : `the check ended with code ${done.code}`);
    }
    if (report == null) return fail('island_error', 'the check report was of another shape');
    console.debug('[board-check]', `${report.errors} errors ${report.warnings} warnings`, `${Date.now() - t0} ms`);
    return ok(report as unknown as Record<string, unknown>);
  }

  /**
   * board.explain (PROTOCOL.md, bridge/boardCheck.ts): the checks (bad_args,
   * then boardGate), then the engine's synchronous read of the rule behind one
   * mark: not_found when no mark of the board has the uuid, no_rule when KiCad
   * names no single rule for its code, rules_invalid when the board's custom
   * rules do not compile.
   */
  function boardExplain(args: unknown): Answer {
    const op = 'board.explain';
    const a = parseExplainArgs(args);
    if (a == null) return fail('bad_args', op);
    const gate = boardGate(op, EXPLAIN_EXPORTS);
    if ('ok' in gate) return gate;
    let raw: unknown;
    try { raw = (gate.mod.kicadExplainViolation as (m: string) => unknown)(a.marker); } catch (err) { return fail('island_error', describeError(err)); }
    if (raw === '' || raw == null) return fail('not_found', a.marker);
    const read = readExplain(raw);
    if (read == null) return fail('island_error', 'the engine answered a rule of another shape');
    if ('none' in read) return read.rulesInvalid === true ? fail('rules_invalid', op) : fail('no_rule', a.marker);
    return ok(read.rule as unknown as Record<string, unknown>);
  }

  /**
   * board.rules (PROTOCOL.md, bridge/rules.ts): the checks (bad_args, then
   * boardGate), then the engine's synchronous read of KiCad's Constraints
   * Resolution for one item or its Clearance Resolution for two: not_found
   * when the board holds neither uuid, rules_invalid when the board's custom
   * rules do not compile, no_rule when KiCad applies none.
   */
  function boardRules(args: unknown): Answer {
    const op = 'board.rules';
    const a = parseRulesArgs(args);
    if (a == null) return fail('bad_args', op);
    const gate = boardGate(op, RULES_EXPORTS);
    if ('ok' in gate) return gate;
    const named = a.b === undefined ? a.a : `${a.a} ${a.b}`;
    let raw: unknown;
    try { raw = (gate.mod.kicadResolveRules as (json: string) => unknown)(rulesJson(a)); } catch (err) { return fail('island_error', describeError(err)); }
    if (raw === '' || raw == null) return fail('island_error', 'the engine refused the rules read');
    const read = readRules(raw);
    if (read == null) return fail('island_error', 'the engine answered rules of another shape');
    if ('error' in read) return read.error === 'not_found' ? fail('not_found', named) : fail('rules_invalid', op);
    if (read.rules.length === 0) return fail('no_rule', named);
    return ok({ rules: read.rules, notes: read.notes });
  }

  /**
   * project.export (PROTOCOL.md, bridge/export.ts): the checks, in order,
   * every one before any effect: the args (bad_args), the frame's kind against
   * the job's face (unsupported), the engine (not_ready, unsupported naming the
   * export), a document (not_ready), busy as for project.plot. Then our
   * engine's kicadExportBoardOutput or kicadExportSchematicOutput queues the
   * job into a fresh folder under /tmp/cc-out/, and the answer waits for the
   * apply queue to empty and the run's record (.cc-export.json, written last),
   * closing any dialog met meanwhile without accepting it; then every file the
   * run wrote is read with its path relative to the folder, and the folder
   * removed. Nothing in the document changes: no undo step, no ev.edited.
   */
  async function projectExport(args: unknown): Promise<Answer> {
    const op = 'project.export';
    const a = parseExportArgs(args);
    if (a == null) return fail('bad_args', op);
    const face = exportFace(a.job);
    if (face !== frame) return fail('unsupported', face === 'pcb' ? 'a board output runs in a pcb frame' : 'a schematic output runs in a sch frame');
    const w = win;
    if (w == null) return fail('not_ready', op);
    const mod = (w.Module ?? {}) as Record<string, unknown>;
    const exports = EXPORT_EXPORTS[face];
    for (const name of exports) if (typeof mod[name] !== 'function') return fail('unsupported', name);
    if (staged == null || opened == null) return fail('not_ready', op);
    if (engineBusy() || keysBlocked(w) || placeWatch?.hanging() === true) return fail('busy', op);
    const FS = w.FS;
    if (FS == null) return fail('island_error', 'the engine has no file system');
    let dir: string;
    try { dir = freshRunFolder(FS, EXPORT_ROOT); } catch (err) { return fail('island_error', describeError(err)); }
    const run = runs;
    const t0 = Date.now();
    // The export answers false at once for settings it refuses (a known key of another
    // JSON type, a cc_* output's key it does not take): that is the request's fault.
    let refused = false;
    const result = await watchedRun<ExportDone>(op, w, FS, dir, timing.exportMs,
      async () => {
        const queued = await (mod[exports[0]] as (json: string) => unknown)(exportJson(run, dir, a));
        refused = queued !== true;
        return queued;
      },
      () => readExportDone(readBytes(FS, `${dir}/${EXPORT_DONE}`)));
    if (!('done' in result)) return refused ? fail('bad_args', 'the engine refused the settings') : result;
    if (result.dialog != null) { dropRunFolder(FS, dir); return fail('island_error', result.dialog); }
    const { done } = result;
    const paths = (text: string): string => runText(text, dir).split(`${root}/`).join('');
    const failure = exportFailure(done, dir);
    if (failure != null) { dropRunFolder(FS, dir); return fail('export_failed', paths(failure)); }
    let read: ReturnType<typeof readExportFolder>;
    try {
      read = readExportFolder(FS, dir);
    } catch (err) {
      dropRunFolder(FS, dir);
      return fail('island_error', describeError(err));
    }
    dropRunFolder(FS, dir);
    if ('error' in read) {
      return fail('island_error', read.error === 'too_large' ? 'the export wrote more than the protocol carries'
        : read.error === 'link' ? 'the export wrote a link' : 'the export wrote a folder inside a folder');
    }
    const notes = runNotes(done.lines, dir).map((n) => n.split(`${root}/`).join(''));
    console.debug('[export]', a.job, `${read.files.length} files`, `${Date.now() - t0} ms`);
    return {
      ok: true,
      result: { files: read.files.map((f) => ({ path: f.path, bytes: f.bytes })), notes, dropped: done.dropped },
      transfer: read.files.map((f) => f.bytes.buffer as ArrayBuffer),
    };
  }

  /**
   * The checks a settings op makes after its args, in order, every one before
   * any effect: the frame's kind against the section (unsupported when the
   * frame does not hold it), then as schematicGate and boardGate: the engine
   * (not_ready, unsupported naming a missing export), a document opened
   * (not_ready), busy.
   */
  function documentGate(op: string, exports: readonly string[], section: string): Answer | { w: ToolWindow; mod: Record<string, unknown> } {
    if (frame !== 'sch' && frame !== 'pcb') return fail('unsupported', SYMEDIT_REFUSAL);
    if (!(sectionFrames(section) as string[]).includes(frame)) return fail('unsupported', `${section} is a ${frame === 'sch' ? 'board' : 'schematic'} setting`);
    const w = win;
    if (w == null) return fail('not_ready', op);
    const mod = (w.Module ?? {}) as Record<string, unknown>;
    for (const name of exports) if (typeof mod[name] !== 'function') return fail('unsupported', name);
    if (staged == null || opened == null) return fail('not_ready', op);
    if (engineBusy() || keysBlocked(w) || placeWatch?.hanging() === true) return fail('busy', op);
    return { w, mod };
  }

  /**
   * One recorded write of properties spec 5 (symbols.set, an exchange, an
   * edit, settings.set): a fresh folder under `rootDir`, the export called
   * with it, and once the apply queue is empty and the run's last file is
   * there, that file (`{ error, message }`) and the run's report. bad_args
   * when the export refuses the args at once (nothing queued), not_applied
   * past `ms` (the folder removed), island_error for a dialog met meanwhile,
   * closed without accepting it. The folder is removed in every case.
   * `doneName` is the run's last file, `.cc-<name>.json`.
   */
  async function recordedRun<T>(op: string, w: ToolWindow, rootDir: string, doneName: string, ms: number, codes: readonly string[], refusal: string,
    call: (run: number, dir: string) => unknown, report: (FS: EmscriptenFS, dir: string) => T | null): Promise<{ done: RunError; report: T | null } | Answer> {
    const FS = w.FS;
    if (FS == null) return fail('island_error', 'the engine has no file system');
    let dir: string;
    try { dir = freshRunFolder(FS, rootDir); } catch (err) { return fail('island_error', describeError(err)); }
    const run = runs;
    let refused = false;
    const result = await watchedRun<RunError>(op, w, FS, dir, ms,
      async () => {
        const queued = await call(run, dir);
        refused = queued !== true;
        return queued;
      },
      () => readRunError(readBytes(FS, `${dir}/${doneName}`), codes));
    if (!('done' in result)) return refused ? fail('bad_args', refusal) : result;
    const read = report(FS, dir);
    dropRunFolder(FS, dir);
    if (result.dialog != null) return fail('island_error', result.dialog);
    return { done: result.done, report: read };
  }

  /** The table kicadSymbolsGet answers for these args, or null for an empty answer or another shape (a throw included). */
  function symbolTable(mod: Record<string, unknown>, json: string): SymbolTable | null {
    try { return readSymbolTable((mod.kicadSymbolsGet as (j: string) => unknown)(json)); } catch { return null; }
  }

  /**
   * symbols.get (PROTOCOL.md, bridge/symbols.ts): the checks (bad_args, then
   * schematicGate), then the engine's synchronous read of every part's fields
   * and flags (or those asked) under the variant. no_variant when the design
   * has no such variant (the engine answers nothing; a read under the default
   * variant says which it has).
   */
  function symbolsGet(args: unknown): Answer {
    const op = 'symbols.get';
    const a = parseSymbolsGetArgs(args);
    if (a == null) return fail('bad_args', op);
    const gate = schematicGate(op, ['kicadSymbolsGet']);
    if ('ok' in gate) return gate;
    const t0 = Date.now();
    const table = symbolTable(gate.mod, symbolsGetJson(a));
    if (table == null) {
      if (a.variant !== '') {
        const plain = symbolTable(gate.mod, symbolsGetJson({ ...a, variant: '' }));
        if (plain != null && !plain.variants.includes(a.variant)) return fail('no_variant', a.variant);
      }
      return fail('island_error', 'the engine answered a table of another shape');
    }
    console.debug('[symbols]', `${table.rows.length} rows`, `${Date.now() - t0} ms`);
    return ok(table as unknown as Record<string, unknown>);
  }

  /**
   * symbols.set (PROTOCOL.md, bridge/symbols.ts): the checks (bad_args, then
   * schematicGate), then a read of the instances asked: no_variant when the
   * design has no such variant, not_found when an instance is not in it. Then
   * our engine's kicadSymbolsSet queues ONE commit "Edit fields" (one undo
   * step) in a fresh folder under /tmp/cc-symbols/; the answer is the record,
   * `{ applied, depth }`. An ev.edited follows when the depth moved.
   */
  async function symbolsSet(args: unknown): Promise<Answer> {
    const op = 'symbols.set';
    const a = parseSymbolsSetArgs(args);
    if (a == null) return fail('bad_args', op);
    const gate = schematicGate(op, SYMBOLS_EXPORTS);
    if ('ok' in gate) return gate;
    const { w, mod } = gate;
    const asked = a.changes.map((c) => ({ uuid: c.uuid, sheetPath: c.sheetPath }));
    const held = symbolTable(mod, symbolsGetJson({ variant: '', items: asked }));
    if (held == null) return fail('island_error', 'the engine answered a table of another shape');
    if (a.variant !== '' && !held.variants.includes(a.variant)) return fail('no_variant', a.variant);
    const missing = asked.length - held.rows.length - held.power;
    if (missing > 0) {
      const listed = new Set(held.rows.map((r) => instanceKey(r)));
      const first = held.power === 0 ? asked.find((i) => !listed.has(instanceKey(i))) : undefined;
      return fail('not_found', first != null ? `${first.uuid} on ${first.sheetPath}` : `${missing} of the instances asked are not in the design`);
    }
    const t0 = Date.now();
    const run = await recordedRun(op, w, SYMBOLS_ROOT, SYMBOLS_DONE, timing.symbolsMs, SYMBOLS_ERRORS, 'the engine refused the set',
      (n, dir) => (mod.kicadSymbolsSet as (json: string) => unknown)(symbolsSetJson(n, dir, a)),
      (FS, dir) => readSymbolsRecord(readBytes(FS, `${dir}/${SYMBOLS_REPORT}`)));
    if (!('done' in run)) return run;
    if (run.done.error !== '') return fail(run.done.error, run.done.error === 'no_variant' ? a.variant : run.done.message || op);
    if (run.report == null || run.report.depth < 0) return fail('island_error', 'the set report was of another shape');
    console.debug('[symbols]', `${run.report.applied} set`, `${Date.now() - t0} ms`);
    return ok({ applied: run.report.applied, depth: run.report.depth });
  }

  /**
   * symbols.exchange (PROTOCOL.md, bridge/exchange.ts): the checks (bad_args,
   * then schematicGate). Then our engine's kicadSymbolsExchange runs KiCad's
   * Change Symbols or Update Symbols from Library in a fresh folder under
   * /tmp/cc-exchange/: a preview lists the rows and changes nothing, an apply
   * is ONE commit. The answer is its report (exchange.json).
   */
  async function symbolsExchange(args: unknown): Promise<Answer> {
    const op = 'symbols.exchange';
    const a = parseSymbolExchangeArgs(args);
    if (a == null) return fail('bad_args', op);
    const gate = schematicGate(op, SYMBOL_EXCHANGE_EXPORTS);
    if ('ok' in gate) return gate;
    const t0 = Date.now();
    const run = await recordedRun(op, gate.w, EXCHANGE_ROOT, EXCHANGE_DONE, timing.exchangeMs, ['island_error'], 'the engine refused the exchange',
      (n, dir) => (gate.mod.kicadSymbolsExchange as (json: string) => unknown)(symbolExchangeJson(n, dir, a)),
      (FS, dir) => readExchangeReport(readBytes(FS, `${dir}/${EXCHANGE_REPORT}`), 'sch'));
    if (!('done' in run)) return run;
    if (run.done.error !== '') return fail(run.done.error, run.done.message || op);
    if (run.report == null || run.report.preview !== a.preview) return fail('island_error', 'the exchange report was of another shape');
    console.debug('[exchange]', a.mode, a.preview ? 'preview' : 'apply', `${run.report.rows.length} rows`, `${Date.now() - t0} ms`);
    return ok(run.report as unknown as Record<string, unknown>);
  }

  /**
   * footprints.exchange (PROTOCOL.md, bridge/exchange.ts): the checks
   * (bad_args, then boardGate). Then our engine's kicadFootprintsExchange runs
   * KiCad's Change Footprints or Update Footprints from Library over the
   * footprints matched, in a fresh folder under /tmp/cc-exchange/: a preview
   * changes nothing, an apply is ONE commit. The answer is its report.
   */
  async function footprintsExchange(args: unknown): Promise<Answer> {
    const op = 'footprints.exchange';
    const a = parseFootprintExchangeArgs(args);
    if (a == null) return fail('bad_args', op);
    const gate = boardGate(op, FOOTPRINT_EXCHANGE_EXPORTS);
    if ('ok' in gate) return gate;
    const t0 = Date.now();
    const run = await recordedRun(op, gate.w, EXCHANGE_ROOT, EXCHANGE_DONE, timing.exchangeMs, ['island_error'], 'the engine refused the exchange',
      (n, dir) => (gate.mod.kicadFootprintsExchange as (json: string) => unknown)(footprintExchangeJson(n, dir, a)),
      (FS, dir) => readExchangeReport(readBytes(FS, `${dir}/${EXCHANGE_REPORT}`), 'pcb'));
    if (!('done' in run)) return run;
    if (run.done.error !== '') return fail(run.done.error, run.done.message || op);
    if (run.report == null || run.report.preview !== a.preview) return fail('island_error', 'the exchange report was of another shape');
    console.debug('[exchange]', a.mode, a.preview ? 'preview' : 'apply', `${run.report.rows.length} rows`, `${Date.now() - t0} ms`);
    return ok(run.report as unknown as Record<string, unknown>);
  }

  /**
   * sch.edit and board.edit (PROTOCOL.md, bridge/edit.ts): the checks
   * (bad_args, then schematicGate or boardGate). Then our engine's
   * kicadSchEdit or kicadBoardEdit runs the global edit in a fresh folder
   * under /tmp/cc-edit/: a preview lists the rows and changes nothing, an
   * apply is ONE commit named for the op. The answer is its report
   * (edit.json); duplicate_designator when a board's numbering would give two
   * parts one designator (nothing changed).
   */
  async function globalEdit(op: 'sch.edit' | 'board.edit', args: unknown): Promise<Answer> {
    const board = op === 'board.edit';
    const a: EditArgs | null = parseEditArgs(args, board ? BOARD_OPS : SCH_OPS);
    if (a == null) return fail('bad_args', op);
    const gate = board ? boardGate(op, BOARD_EDIT_EXPORTS) : schematicGate(op, SCH_EDIT_EXPORTS);
    if ('ok' in gate) return gate;
    const t0 = Date.now();
    const exportName = board ? 'kicadBoardEdit' : 'kicadSchEdit';
    const run = await recordedRun(op, gate.w, EDIT_ROOT, EDIT_DONE, timing.editMs, EDIT_ERRORS, 'the engine refused the edit',
      (n, dir) => (gate.mod[exportName] as (json: string) => unknown)(editJson(n, dir, a)),
      (FS, dir) => readEditReport(readBytes(FS, `${dir}/${EDIT_REPORT}`), board ? 'pcb' : 'sch', a));
    if (!('done' in run)) return run;
    if (run.done.error !== '') return fail(run.done.error, run.done.message || op);
    if (run.report == null) return fail('island_error', 'the edit report was of another shape');
    console.debug('[edit]', op, a.op, a.preview ? 'preview' : 'apply', `${run.report.count} rows`, `${Date.now() - t0} ms`);
    return ok(run.report as unknown as Record<string, unknown>);
  }

  /**
   * board.footprints (PROTOCOL.md, bridge/footprints.ts): no args, then
   * boardGate, then the engine's synchronous read of every footprint under
   * the board's current variant.
   */
  function boardFootprints(args: unknown): Answer {
    const op = 'board.footprints';
    if (!noArgs(args)) return fail('bad_args', op);
    const gate = boardGate(op, FOOTPRINTS_EXPORTS);
    if ('ok' in gate) return gate;
    let read: ReturnType<typeof readBoardFootprints>;
    try { read = readBoardFootprints((gate.mod.kicadBoardFootprints as () => unknown)()); } catch { read = null; }
    if (read == null) return fail('island_error', 'the engine answered footprints of another shape');
    return ok(read as unknown as Record<string, unknown>);
  }

  /**
   * settings.get (PROTOCOL.md, bridge/settings.ts): the checks (bad_args, then
   * documentGate), then the engine's synchronous read of the section from the
   * editor's memory (unsaved changes included).
   */
  function settingsGet(args: unknown): Answer {
    const op = 'settings.get';
    const a = parseSettingsGetArgs(args);
    if (a == null) return fail('bad_args', op);
    const gate = documentGate(op, ['kicadSettingsGet'], a.section);
    if ('ok' in gate) return gate;
    let section: Record<string, unknown> | null;
    try { section = readSection((gate.mod.kicadSettingsGet as (s: string) => unknown)(a.section)); } catch { section = null; }
    if (section == null) return fail('island_error', 'the engine answered a section of another shape');
    return ok(section);
  }

  /**
   * settings.set (PROTOCOL.md, bridge/settings.ts): the checks (bad_args, then
   * documentGate; a pcb frame's variants answer unsupported). Then our
   * engine's kicadSettingsSet applies the patch (or the action) in memory with
   * the frame's own sync, in a fresh folder under /tmp/cc-settings/; the answer
   * is the record: the section read back, a dry run's rule errors or the items
   * a removed layer holds. No undo step (KiCad's rule; removing a layer that
   * holds items clears the undo list, as Board Setup does). A custom rules
   * file written (no dry run) is sent as ev.saved before the answer.
   */
  async function settingsSet(args: unknown): Promise<Answer> {
    const op = 'settings.set';
    const a = parseSettingsSetArgs(args);
    if (a == null) return fail('bad_args', op);
    if (frame === 'pcb' && PCB_READ_ONLY.includes(a.section)) return fail('unsupported', 'the board takes variants through Update the board');
    const gate = documentGate(op, SETTINGS_EXPORTS, a.section);
    if ('ok' in gate) return gate;
    const { w, mod } = gate;
    const t0 = Date.now();
    const run = await recordedRun(op, w, SETTINGS_ROOT, SETTINGS_DONE, timing.settingsMs, SETTINGS_ERRORS, 'the engine refused the setting',
      (n, dir) => (mod.kicadSettingsSet as (json: string) => unknown)(settingsSetJson(n, dir, a)),
      (FS, dir) => readSettingsRecord(readBytes(FS, `${dir}/${SETTINGS_REPORT}`)));
    if (!('done' in run)) return run;
    if (run.done.error !== '') return fail(run.done.error, run.done.message || op);
    if (run.report == null) return fail('island_error', 'the settings record was of another shape');
    if (a.section === 'customRules' && a.dryRun !== true && opened != null && w.FS != null) {
      const path = rulesPathOf(opened);
      const bytes = path == null ? null : readBytes(w.FS, `${root}/${path}`);
      if (path != null && bytes != null) emit({ type: 'ev.saved', path, bytes });
    }
    console.debug('[settings]', a.section, a.dryRun === true ? 'dry run' : 'set', `${Date.now() - t0} ms`);
    return ok(run.report as unknown as Record<string, unknown>);
  }

  /** kicadBoardItemGet's answer read: the items, or null for an answer of another shape (a throw included). */
  function boardItems(mod: Record<string, unknown>, uuids: readonly string[]): BoardItemSheet[] | null {
    try { return readBoardItems((mod.kicadBoardItemGet as (json: string) => unknown)(JSON.stringify(uuids))); } catch { return null; }
  }

  /**
   * board.item.get (PROTOCOL.md, bridge/boardItem.ts): the checks (bad_args,
   * then boardGate), then the engine's synchronous read of the items, in the
   * order asked; an empty list is an answer (the items are gone).
   */
  function boardItemGet(args: unknown): Answer {
    const op = 'board.item.get';
    const a = parseBoardItemGetArgs(args);
    if (a == null) return fail('bad_args', op);
    const gate = boardGate(op, BOARD_ITEM_EXPORTS);
    if ('ok' in gate) return gate;
    const items = boardItems(gate.mod, a.uuids);
    if (items == null) return fail('island_error', 'the engine answered items of another shape');
    return ok({ items });
  }

  /**
   * board.item.set (PROTOCOL.md, bridge/boardItem.ts): the checks (bad_args,
   * then boardGate), the item (not_found when the board does not hold it), the
   * item's own refusals (bad_args). Then our engine's kicadBoardItemSet queues
   * ONE commit (one undo step); bad_args when it refuses the set (a layer the
   * board does not use, a bound KiCad keeps). The answer is the item read back
   * once the apply queue is empty and it shows the change; not_applied when it
   * does not within timing.boardItemMs. An ev.edited follows the answer.
   */
  async function boardItemSet(args: unknown): Promise<Answer> {
    const op = 'board.item.set';
    const a = parseBoardItemSetArgs(args);
    if (a == null) return fail('bad_args', op);
    const gate = boardGate(op, BOARD_ITEM_EXPORTS);
    if ('ok' in gate) return gate;
    const { w, mod } = gate;
    const before = boardItems(mod, [a.uuid]);
    if (before == null) return fail('island_error', 'the engine answered items of another shape');
    if (before.length === 0) return fail('not_found', a.uuid);
    const why = setMisfit(a.set, before[0]);
    if (why != null) return fail('bad_args', `${op}: ${why}`);
    const t0 = Date.now();
    let queued: unknown;
    try { queued = (mod.kicadBoardItemSet as (json: string) => unknown)(boardItemSetJson(a)); } catch (err) { return fail('island_error', describeError(err)); }
    if (queued !== true) return fail('bad_args', op);
    const deadline = Date.now() + timing.boardItemMs;
    for (;;) {
      if (closed) return fail('island_error', 'the frame closed');
      if (await applyIdle(w, Math.max(0, deadline - Date.now()))) {
        const after = boardItems(mod, [a.uuid]);
        if (after != null && after.length > 0 && showsBoardSet(a.set, after[0])) {
          console.debug('[board-item]', a.uuid, Object.keys(a.set).join(' '), `${Date.now() - t0} ms`);
          return ok({ item: after[0] });
        }
      }
      if (Date.now() >= deadline) return fail('not_applied', op);
      await sleep(timing.applyPollMs);
    }
  }

  /**
   * board.preview and board.update (PROTOCOL.md, bridge/boardUpdate.ts): the
   * checks (bad_args, then boardGate, then no_schematic when no schematic sits
   * beside the opened board with its stem). Then our engine's
   * kicadUpdateBoardFromSchematic runs KiCad's Update PCB from Schematic (a
   * dry run for a preview) in a fresh folder under /tmp/cc-update/, and once
   * its record (.cc-update.json) is there the answer is its report
   * (report.json) read closed, the sheets as project paths; the folder is
   * removed. A dialog met meanwhile is closed without accepting it and the
   * answer is schematic_unreadable naming it. The engine's stale,
   * not_annotated, schematic_unreadable and island_error pass through; a
   * preview whose parts are not numbered answers its report, `blocked` saying so.
   */
  async function boardUpdate(op: 'board.preview' | 'board.update', args: unknown): Promise<Answer> {
    const a: (BoardOptions & { token?: string }) | null = op === 'board.preview' ? parseBoardPreviewArgs(args) : parseBoardUpdateArgs(args);
    if (a == null) return fail('bad_args', op);
    const gate = boardGate(op, BOARD_UPDATE_EXPORTS);
    if ('ok' in gate) return gate;
    const { w, mod } = gate;
    const FS = w.FS;
    if (FS == null) return fail('island_error', 'the engine has no file system');
    const sch = schematicBeside(opened as string);
    if (!FS.analyzePath(`${root}/${sch}`).exists) return fail('no_schematic', sch);
    let dir: string;
    try { dir = freshRunFolder(FS, BOARD_UPDATE_ROOT); } catch (err) { return fail('island_error', describeError(err)); }
    const run = runs;
    const t0 = Date.now();
    const result = await watchedRun<BoardUpdateDone>(op, w, FS, dir, timing.boardUpdateMs,
      () => (mod.kicadUpdateBoardFromSchematic as (json: string) => unknown)(boardUpdateJson(run, dir, a, op === 'board.update' ? (a.token as string) : null)),
      () => readBoardUpdateDone(readBytes(FS, `${dir}/${BOARD_UPDATE_DONE}`)));
    refocus(w);
    if (!('done' in result)) return result;
    const report = readBoardReport(readBytes(FS, `${dir}/${BOARD_UPDATE_REPORT}`), run, relInRoot);
    dropRunFolder(FS, dir);
    if (result.dialog != null) return fail('schematic_unreadable', result.dialog);
    const { done } = result;
    const previewBlocked = op === 'board.preview' && done.error === 'not_annotated' && report?.blocked === 'not_annotated';
    if (done.error !== '' && !previewBlocked) return fail(done.error, runText(done.message, dir) || op);
    if (report == null) return fail('island_error', 'the update report was of another shape');
    console.debug('[board-update]', op, `${report.changes.length} changes`, `${Date.now() - t0} ms`);
    // The engine selects the new parts with no selection emit: read it, so an ev.selected follows the answer.
    if (op === 'board.update') selectionFeed?.nudge();
    return ok(op === 'board.preview' ? previewAnswer(report) : updateAnswer(report));
  }

  // ── The symbol editor (island v0.2.3-cc23, bridge/symedit.ts) ─────────────────────────

  /**
   * Whether a symbol is open in a symedit frame, as last read (every state
   * read keeps it): the engine's requests (ev.symedit, ev.held) arrive inside
   * an engine call, where the island calls nothing back into the engine, so
   * their gate reads this.
   */
  let symbolOpenSeen = false;

  /** The engine's state read (kicadSymEditState), or null when it is missing, throws or answers another shape. */
  function symState(mod: Record<string, unknown>): SymEditState | null {
    let state: SymEditState | null;
    try { state = readState((mod.kicadSymEditState as () => unknown)()); } catch { state = null; }
    if (state != null) symbolOpenSeen = state.open;
    return state;
  }

  /**
   * The checks every symedit op makes after its args, in order, every one
   * before any effect: the frame's kind (unsupported in a sch or a pcb frame),
   * the engine (not_ready before ev.ready; unsupported naming a missing
   * export), busy while a load is parked or a popup menu or a dialog is up,
   * then (with `open`) a symbol open (no_symbol).
   */
  function symEditGate(op: string, open: boolean): Answer | { w: ToolWindow; mod: Record<string, unknown>; state: SymEditState } {
    if (frame !== 'symedit') return fail('unsupported', SYMEDIT_FRAME_ONLY);
    const w = win;
    if (w == null) return fail('not_ready', op);
    const mod = (w.Module ?? {}) as Record<string, unknown>;
    for (const name of SYMEDIT_EXPORTS) if (typeof mod[name] !== 'function') return fail('unsupported', name);
    if (engineBusy() || keysBlocked(w)) return fail('busy', op);
    const state = symState(mod);
    if (state == null) return fail('island_error', 'the engine answered a state of another shape');
    if (open && !state.open) return fail('no_symbol', op);
    return { w, mod, state };
  }

  /** One engine call that answers a string or a boolean; a throw reads as the refusal ("" or false). */
  function callText(mod: Record<string, unknown>, name: string, ...args: unknown[]): string {
    try { return String((mod[name] as (...a: unknown[]) => unknown)(...args) ?? ''); } catch { return ''; }
  }
  function callBool(mod: Record<string, unknown>, name: string, ...args: unknown[]): boolean {
    try { return (mod[name] as (...a: unknown[]) => unknown)(...args) === true; } catch { return false; }
  }

  /**
   * Waits for a queued symedit change: the apply queue empty and `read` giving
   * a value (it answers null until the change shows), at most `ms`. Null when
   * it never did (not_applied for the caller).
   */
  async function readBack<T>(w: ToolWindow, ms: number, read: () => T | null): Promise<T | null> {
    const deadline = Date.now() + ms;
    for (;;) {
      if (closed) return null;
      if (await applyIdle(w, Math.max(0, deadline - Date.now()))) {
        const got = read();
        if (got != null) return got;
      }
      if (Date.now() >= deadline) return null;
      await sleep(timing.applyPollMs);
    }
  }

  /** The symbol's items by uuid, every unit and body style (null for an answer of another shape). */
  function symItems(mod: Record<string, unknown>, uuids?: string[]): SymItem[] | null {
    const args = uuids == null ? { unit: 0, bodyStyle: 0 } : { uuids, unit: 0, bodyStyle: 0 };
    return readItems(callText(mod, 'kicadSymEditItemsGet', JSON.stringify(args)));
  }

  /** A new symbol is open: ev.edited's baseline and the host's selection start again. */
  function symbolOpened(): void {
    editDepth = null;
    selectionFeed?.reset();
  }

  /**
   * symedit.open and symedit.new: past the gate, held_edits when the open
   * symbol holds changes and `discard` is false; then the engine's call with a
   * fresh token, bad_args when it refuses the text (no symbol of that name
   * KiCad reads, or a parent it cannot read), and the answer is the state once
   * the engine shows the token open.
   */
  async function symEditOpening(op: string, discard: boolean, call: (mod: Record<string, unknown>, token: string) => boolean, why: string): Promise<Answer> {
    const gate = symEditGate(op, false);
    if ('ok' in gate) return gate;
    const { w, mod, state } = gate;
    if (state.open && state.modified && !discard) return fail('held_edits', op);
    const token = makeToken();
    const t0 = Date.now();
    if (!call(mod, token)) return fail('bad_args', `${op}: ${why}`);
    const after = await readBack(w, timing.symeditMs, () => {
      const now = symState(mod);
      return now != null && now.open && now.token === token ? now : null;
    });
    if (after == null) return fail('not_applied', op);
    symbolOpened();
    console.debug('[symedit]', op, after.name, `${Date.now() - t0} ms`);
    return ok(after as unknown as Record<string, unknown>);
  }

  function symEditOpen(args: unknown): Promise<Answer> {
    const a = parseOpenArgs(args);
    if (a == null) return Promise.resolve(fail('bad_args', 'symedit.open'));
    return symEditOpening('symedit.open', a.discard, (mod, token) => callBool(mod, 'kicadSymEditOpen', openJson(a, token)),
      `the text holds no symbol ${a.name} KiCad reads`);
  }

  function symEditNew(args: unknown): Promise<Answer> {
    const a = parseNewArgs(args);
    if (a == null) return Promise.resolve(fail('bad_args', 'symedit.new'));
    return symEditOpening('symedit.new', a.discard, (mod, token) => callBool(mod, 'kicadSymEditNew', newJson(a, token)),
      a.parent === '' ? 'KiCad refused the new symbol' : `the parent text holds no symbol ${a.parent} KiCad reads`);
  }

  function symEditStateOp(args: unknown): Answer {
    if (!noArgs(args)) return fail('bad_args', 'symedit.state');
    const gate = symEditGate('symedit.state', false);
    return 'ok' in gate ? gate : ok(gate.state as unknown as Record<string, unknown>);
  }

  function symEditTake(args: unknown): Answer {
    const op = 'symedit.take';
    if (!noArgs(args)) return fail('bad_args', op);
    const gate = symEditGate(op, true);
    if ('ok' in gate) return gate;
    const taken = readTaken(callText(gate.mod, 'kicadSymEditTake'));
    if (taken == null) return fail('island_error', 'the engine answered a symbol of another shape');
    return ok({ name: taken.name, text: taken.text, parent: taken.parent });
  }

  function symEditMarkSaved(args: unknown): Answer {
    const op = 'symedit.markSaved';
    const a = parseMarkSavedArgs(args);
    if (a == null) return fail('bad_args', op);
    const gate = symEditGate(op, true);
    if ('ok' in gate) return gate;
    if (gate.state.token !== a.token) return fail('bad_args', `${op}: the token is not the open symbol's`);
    if (!callBool(gate.mod, 'kicadSymEditMarkSaved', a.token)) return fail('not_applied', op);
    const after = symState(gate.mod);
    return after == null ? fail('island_error', 'the engine answered a state of another shape') : ok(after as unknown as Record<string, unknown>);
  }

  function symEditItemsGet(args: unknown): Answer {
    const op = 'symedit.items.get';
    const a = parseItemsGetArgs(args);
    if (a == null) return fail('bad_args', op);
    const gate = symEditGate(op, true);
    if ('ok' in gate) return gate;
    const items = readItems(callText(gate.mod, 'kicadSymEditItemsGet', JSON.stringify(a)));
    return items == null ? fail('island_error', 'the engine answered items of another shape') : ok({ items });
  }

  /** The items asked, every one of them, or the refusal: not_found naming the first the symbol does not hold. */
  function heldItems(op: string, mod: Record<string, unknown>, uuids: string[]): SymItem[] | Answer {
    const items = symItems(mod, uuids);
    if (items == null) return fail('island_error', 'the engine answered items of another shape');
    const missing = uuids.find((u) => !items.some((i) => i.uuid === u));
    return missing != null ? fail('not_found', missing) : items;
  }

  async function symEditItemsSet(args: unknown): Promise<Answer> {
    const op = 'symedit.items.set';
    const a = parseItemsSetArgs(args);
    if (a == null) return fail('bad_args', op);
    const gate = symEditGate(op, true);
    if ('ok' in gate) return gate;
    const { w, mod } = gate;
    const before = heldItems(op, mod, a.uuids);
    if (!Array.isArray(before)) return before;
    const why = itemSetMisfit(a.set, before);
    if (why != null) return fail('bad_args', `${op}: ${why}`);
    const t0 = Date.now();
    // The engine refuses what only the symbol bounds (a unit past its units, a field's name another field holds).
    if (!callBool(mod, 'kicadSymEditItemsSet', JSON.stringify({ uuids: a.uuids, set: a.set }))) return fail('bad_args', op);
    const after = await readBack(w, timing.symeditMs, () => {
      const items = symItems(mod, a.uuids);
      // KiCad's synced pins rule may drop a twin pin: the ones still there show the set.
      return items != null && items.length > 0 && items.every((i) => showsItemSet(a.set, i)) ? items : null;
    });
    if (after == null) return fail('not_applied', op);
    console.debug('[symedit]', op, Object.keys(a.set).join(' '), `${Date.now() - t0} ms`);
    return ok({ items: after });
  }

  async function symEditItemsAdd(args: unknown): Promise<Answer> {
    const op = 'symedit.items.add';
    const a = parseItemsAddArgs(args);
    if (a == null) return fail('bad_args', op);
    const gate = symEditGate(op, true);
    if ('ok' in gate) return gate;
    const { w, mod } = gate;
    const all = symItems(mod);
    if (all == null) return fail('island_error', 'the engine answered items of another shape');
    const taken = a.items.find((n) => all.some((i) => i.uuid === n.uuid));
    if (taken != null) return fail('bad_args', `${op}: ${taken.uuid} is taken`);
    const uuids = a.items.map((n) => n.uuid);
    if (!callBool(mod, 'kicadSymEditItemsAdd', JSON.stringify({ items: a.items }))) return fail('bad_args', op);
    const after = await readBack(w, timing.symeditMs, () => {
      const items = symItems(mod, uuids);
      return items != null && items.length === uuids.length ? items : null;
    });
    return after == null ? fail('not_applied', op) : ok({ items: after });
  }

  async function symEditItemsRemove(args: unknown): Promise<Answer> {
    const op = 'symedit.items.remove';
    const a = parseItemsRemoveArgs(args);
    if (a == null) return fail('bad_args', op);
    const gate = symEditGate(op, true);
    if ('ok' in gate) return gate;
    const { w, mod } = gate;
    const before = heldItems(op, mod, a.uuids);
    if (!Array.isArray(before)) return before;
    const mandatory = before.find((i) => i.kind === 'field' && ['Reference', 'Value', 'Footprint', 'Datasheet', 'Description'].includes(i.name));
    if (mandatory != null && mandatory.kind === 'field') return fail('bad_args', `${op}: ${mandatory.name} is one of the five fields every symbol keeps`);
    if (!callBool(mod, 'kicadSymEditItemsRemove', JSON.stringify({ uuids: a.uuids }))) return fail('bad_args', op);
    const gone = await readBack(w, timing.symeditMs, () => {
      const items = symItems(mod, a.uuids);
      return items != null && items.length === 0 ? true : null;
    });
    return gone == null ? fail('not_applied', op) : ok({ removed: a.uuids });
  }

  function symEditSymbolGet(args: unknown): Answer {
    const op = 'symedit.symbol.get';
    if (!noArgs(args)) return fail('bad_args', op);
    const gate = symEditGate(op, true);
    if ('ok' in gate) return gate;
    const props = readSymbolProps(callText(gate.mod, 'kicadSymEditSymbolGet'));
    return props == null ? fail('island_error', 'the engine answered a symbol of another shape') : ok(props as unknown as Record<string, unknown>);
  }

  async function symEditSymbolSet(args: unknown): Promise<Answer> {
    const op = 'symedit.symbol.set';
    const a = parseSymEditSymbolSetArgs(args);
    if (a == null) return fail('bad_args', op);
    const gate = symEditGate(op, true);
    if ('ok' in gate) return gate;
    const { w, mod } = gate;
    const t0 = Date.now();
    // The engine refuses what only the symbol bounds (a field it lacks, a taken name, a parent's fields on a root symbol).
    if (!callBool(mod, 'kicadSymEditSymbolSet', JSON.stringify({ set: a.set }))) return fail('bad_args', op);
    const after = await readBack(w, timing.symeditMs, () => {
      const p = readSymbolProps(callText(mod, 'kicadSymEditSymbolGet'));
      return p != null && showsSymbolSet(a.set, p) ? p : null;
    });
    if (after == null) return fail('not_applied', op);
    console.debug('[symedit]', op, Object.keys(a.set).join(' '), `${Date.now() - t0} ms`);
    return ok(after as unknown as Record<string, unknown>);
  }

  async function symEditShow(args: unknown): Promise<Answer> {
    const op = 'symedit.show';
    const a = parseShowArgs(args);
    if (a == null) return fail('bad_args', op);
    const gate = symEditGate(op, true);
    if ('ok' in gate) return gate;
    const { w, mod, state } = gate;
    if (a.unit > state.unitCount) return fail('bad_args', `${op}: the symbol has ${state.unitCount} units`);
    // The body style count is the engine's to bound: a new symbol with a De Morgan
    // drawing reads `one` in the state's bodyStyles (engine run 14) and still has two.
    if (!callBool(mod, 'kicadSymEditShow', JSON.stringify(a))) return fail('bad_args', `${op}: the symbol has no body style ${a.bodyStyle}`);
    const after = await readBack(w, timing.symeditMs, () => {
      const now = symState(mod);
      return now != null && now.unit === a.unit && now.bodyStyle === a.bodyStyle ? now : null;
    });
    return after == null ? fail('not_applied', op) : ok(after as unknown as Record<string, unknown>);
  }

  function symEditCheck(args: unknown): Answer {
    const op = 'symedit.check';
    if (!noArgs(args)) return fail('bad_args', op);
    const gate = symEditGate(op, true);
    if ('ok' in gate) return gate;
    const found = readFindings(callText(gate.mod, 'kicadSymEditCheck'));
    return found == null ? fail('island_error', 'the engine answered findings of another shape') : ok({ grid: found.grid, findings: found.findings });
  }

  /**
   * symedit.svg: KiCad's own SVG plot of the shown unit and body style
   * (SYMBOL_EDIT_FRAME::SVGPlotSymbol) in a fresh folder under /tmp/cc-svg/,
   * its record (.cc-svg.json) written last; the answer is the file's bytes,
   * the folder removed.
   */
  async function symEditSvg(args: unknown): Promise<Answer> {
    const op = 'symedit.svg';
    if (!noArgs(args)) return fail('bad_args', op);
    const gate = symEditGate(op, true);
    if ('ok' in gate) return gate;
    const { w, mod } = gate;
    const FS = w.FS;
    if (FS == null) return fail('island_error', 'the engine has no file system');
    let dir: string;
    try { dir = freshRunFolder(FS, SVG_ROOT); } catch (err) { return fail('island_error', describeError(err)); }
    const t0 = Date.now();
    const run = await queuedRun(op, w, FS, dir, timing.svgMs,
      () => (mod.kicadSymEditPlotSvg as (json: string) => unknown)(JSON.stringify({ dir })),
      () => readSvgDone(readBytes(FS, `${dir}/${SVG_DONE}`)));
    if (!('done' in run)) return run;
    const bytes = readBytes(FS, `${dir}/${SVG_FILE}`);
    dropRunFolder(FS, dir);
    if (run.done.error !== '' || bytes == null || bytes.byteLength === 0) return fail('plot_failed', 'KiCad wrote no SVG');
    if (bytes.byteLength > SVG_MAX_BYTES) return fail('island_error', 'the SVG is larger than the protocol carries');
    const own = bytes.slice();
    console.debug('[symedit]', op, `${own.byteLength} bytes`, `${Date.now() - t0} ms`);
    return { ok: true, result: { bytes: own }, transfer: [own.buffer as ArrayBuffer] };
  }

  /**
   * select in a symedit frame (PROTOCOL.md select): the symbol's own items by
   * uuid (footprint paths select nothing), an id the symbol does not hold
   * selecting nothing; the answer once the editor holds exactly the items found.
   */
  async function symEditSelect(a: { uuids: string[]; fpPaths: string[]; zoom: boolean }): Promise<Answer> {
    const op = 'select';
    const gate = symEditGate(op, true);
    if ('ok' in gate) return gate;
    const { w, mod } = gate;
    const held = a.uuids.length === 0 ? [] : symItems(mod, a.uuids);
    if (held == null) return fail('island_error', 'the engine answered items of another shape');
    const found = a.uuids.filter((u) => held.some((i) => i.uuid === u));
    if (!callBool(mod, 'kicadSymEditSelect', JSON.stringify({ uuids: found, zoom: a.zoom && found.length > 0 }))) return fail('not_applied', op);
    if (a.zoom && found.length > 0) fitWatch?.disarm();
    const want = new Set(found);
    const done = await readBack(w, timing.selectMs, () => {
      const now = readSelection(callText(mod, 'kicadSymEditSelection'));
      return now != null && now.length === want.size && now.every((u) => want.has(u)) ? true : null;
    });
    return done == null ? fail('not_applied', op) : ok();
  }

  /**
   * symbol.convert (a sch or a symedit frame): the file is written under a
   * fresh /tmp/cc-import/<n>/, read by the engine's KiCad readers, and the
   * folder removed. unreadable when no reader takes it (message KiCad's),
   * too_large past 2,000 symbols or 4 MiB of text.
   */
  function symbolConvert(args: unknown): Answer {
    const op = 'symbol.convert';
    const a = parseConvertArgs(args);
    if (a == null) return fail('bad_args', op);
    if (frame === 'pcb') return fail('unsupported', 'symbols are read in a sch or a symedit frame');
    const w = win;
    if (w == null) return fail('not_ready', op);
    const mod = (w.Module ?? {}) as Record<string, unknown>;
    for (const name of CONVERT_EXPORTS) if (typeof mod[name] !== 'function') return fail('unsupported', name);
    if (engineBusy() || keysBlocked(w)) return fail('busy', op);
    const FS = w.FS;
    if (FS == null) return fail('island_error', 'the engine has no file system');
    let dir: string;
    try {
      dir = freshRunFolder(FS, CONVERT_ROOT);
      FS.writeFile(`${dir}/${a.name}`, a.bytes);
    } catch (err) { return fail('island_error', describeError(err)); }
    const t0 = Date.now();
    const raw = callText(mod, 'kicadSymbolLibConvert', JSON.stringify({ path: `${dir}/${a.name}` }));
    dropRunFolder(FS, dir);
    const out = readConverted(raw);
    if (out == null) return fail('island_error', 'the engine answered a reading of another shape');
    if ('error' in out) return out.error === 'too_large' ? fail('too_large', op) : fail('unreadable', out.message);
    console.debug('[symedit]', op, out.format, `${out.symbols.length} symbols`, `${Date.now() - t0} ms`);
    return ok({ format: out.format, symbols: out.symbols });
  }

  /** symbol.forEditor (a sch frame): the placed symbol as KiCad's Edit with Symbol Editor builds it, as text. */
  function symbolForEditor(args: unknown): Answer {
    const op = 'symbol.forEditor';
    const a = parseForEditorArgs(args);
    if (a == null) return fail('bad_args', op);
    const gate = schematicGate(op, SYMBOL_EDIT_EXPORTS);
    if ('ok' in gate) return gate;
    const got = readForEditor(callText(gate.mod, 'kicadSymbolForEditor', JSON.stringify(a)));
    return got == null ? fail('not_found', a.uuid) : ok({ name: got.name, libId: got.libId, text: got.text });
  }

  /**
   * symbol.push (a sch frame): KiCad's save of an edited symbol to the
   * schematic (every unit of the part, one commit "Edit symbol"), `libId`
   * relinking the part in the same commit. The answer is the symbol sheet read
   * back once the apply queue is empty (and, with a libId, the part names it).
   */
  async function symbolPush(args: unknown): Promise<Answer> {
    const op = 'symbol.push';
    const a = parsePushArgs(args);
    if (a == null) return fail('bad_args', op);
    const gate = schematicGate(op, SYMBOL_EDIT_EXPORTS);
    if ('ok' in gate) return gate;
    const { w, mod } = gate;
    const before = readSymbolSheet(symbolText(mod, a.uuid, a.sheetPath));
    if (before == null || before.sheetPath !== a.sheetPath) return fail('not_found', `${a.uuid} on ${a.sheetPath}`);
    const t0 = Date.now();
    if (!callBool(mod, 'kicadSymbolPushToSchematic', JSON.stringify({ ...a, token: makeToken() }))) return fail('bad_args', `${op}: the text holds no symbol ${a.name} KiCad reads`);
    const after = await readBack(w, timing.symbolPushMs, () => {
      const sheet = readSymbolSheet(symbolText(mod, a.uuid, a.sheetPath));
      return sheet != null && (a.libId === '' || sheet.libId === a.libId) ? sheet : null;
    });
    if (after == null) return fail('not_applied', op);
    console.debug('[symedit]', op, a.uuid, `${Date.now() - t0} ms`);
    return ok(after as unknown as Record<string, unknown>);
  }

  /**
   * lib.update (a sch frame): KiCad's Update Symbols from Library for the
   * named symbols of one library (the engine's kicadUpdateFromLibrary, the
   * dialog's defaults), one commit; the answer is its pcbjam:lib-update-done
   * event: how many placed parts took the new drawing, and what was missing.
   */
  async function libUpdate(args: unknown): Promise<Answer> {
    const op = 'lib.update';
    const a = parseLibUpdateArgs(args);
    if (a == null) return fail('bad_args', op);
    const gate = schematicGate(op, LIB_UPDATE_EXPORTS);
    if ('ok' in gate) return gate;
    const { w, mod } = gate;
    if (typeof w.addEventListener !== 'function') return fail('island_error', 'the engine window takes no listener');
    let resolve: (d: unknown) => void = () => {};
    const done = new Promise<unknown>((r) => { resolve = r; });
    const listen = (e: Event): void => resolve((e as CustomEvent).detail);
    w.addEventListener(LIB_UPDATE_EVENT, listen);
    try {
      if (!readLibUpdateQueued(callText(mod, 'kicadUpdateFromLibrary', 'symbol', a.lib, JSON.stringify(a.names)))) return fail('not_applied', op);
      const detail = await withTimeout(done, timing.libUpdateMs);
      if (detail === 'timeout') return fail('not_applied', op);
      const r = readLibUpdateDone(detail);
      return r == null ? fail('island_error', 'the update answered another shape') : ok({ updated: r.updated, missing: r.missing });
    } finally {
      w.removeEventListener(LIB_UPDATE_EVENT, listen);
    }
  }

  let ready = false;
  /** ev.ready went out: only then does a properties request reach the host. */
  let readySent = false;
  return {
    emit,
    engineReady(w, engine, help, source) {
      if (ready) return;
      ready = true;
      win = w;
      libs = source ?? null;
      // A registered project library first (project.libs), then the source's own list.
      const sourceIds = libs == null ? null : libIds(libs.source);
      idOf = async (kind, nick) => projectLibs?.registered(kind, nick)?.id ?? (sourceIds == null ? null : sourceIds(kind, nick));
      // The editor's own frame, so any other window of KiCad's holds the place keys back.
      try { ownFrames = new Set((w.wxElementRegistry?.findAll({ visible: true }) ?? []).filter((e) => FRAME_TYPE_RE.test(e.typeName)).map((e) => e.name)); } catch { ownFrames = new Set(); }
      placeWatch = new PlacementWatch(w, { frame, timing, depth: () => undoDepth(w), blocked: () => keysBlocked(w), press: (k) => pressKey(w, k) });
      // The sheet KiCad shows (sheetFile), from the schematic editor's own pushes;
      // a listener already in the slots is still called.
      const cw = w as CollabWindow;
      const prior = cw.kicadCollab;
      const changed = prior?.onSheetChanged;
      const pushed = prior?.onSheetsState;
      cw.kicadCollab = {
        ...prior,
        onSheetChanged: (absPath: string) => {
          if (typeof absPath === 'string' && opened != null) sheetFile = baseName(absPath);
          sheetChanges++;
          for (const seen of [...sheetWaiters]) seen();
          changed?.(absPath);
        },
        onSheetsState: (json: string) => { sheetStates++; pushed?.(json); },
      };
      // Popup menus and dialogs over the canvas: the host hides what it draws there.
      // The pointer's place over the drawing, where the host's viewing drawing prints
      // it; it reads the viewport only while no import or save runs, as the fit watch does.
      const chip = new CoordsChip(w as unknown as CoordsWindow, { frame, live: () => !closed && !importing && collecting == null });
      if (chip.start()) coords = chip;
      stopMenus = watchMenus(w, (open) => { coords?.cover(open); emit({ type: 'ev.menu', open }); });
      // KiCad's own chrome as the engine says it is (our engine from run 9:
      // window.kicadChrome.onChange each time it flips), so the host's menus
      // control tells the truth. An engine without kicadChromeShown says nothing.
      if (typeof w.Module?.kicadChromeShown === 'function') {
        let shown: boolean | null = null;
        const say = (now: unknown): void => {
          if (typeof now !== 'boolean' || now === shown) return;
          shown = now;
          coords?.chromeShown(now);
          if (ready) emit({ type: 'ev.chrome', shown: now });
        };
        (w as ChromeWindow).kicadChrome = { onChange: say };
        chromeSay = () => { try { say(w.Module?.kicadChromeShown?.()); } catch { /* the next flip says it */ } };
      }
      // A fitted view stays fitted through resizes and a replaced drawing
      // surface until the reader steers (bridge/view.ts). The fit watch reads
      // nothing while an import or a save runs (the import fits for itself).
      const watch = new FitWatch(w, { timing, ready: () => !engineBusy() && !keysBlocked(w), fit: () => pressKey(w, HOME_KEY), surface: () => surfaceKey(w.document) });
      fitWatch = watch;
      const timer = setInterval(() => { if (!closed && !importing && collecting == null) watch.tick(); }, timing.viewPollMs);
      const steer = (e: Event): void => { if (e.isTrusted) watch.disarm(); };
      const listens = typeof w.addEventListener === 'function';
      if (listens) for (const t of STEER_EVENTS) w.addEventListener(t, steer, true);
      stopFitWatch = () => {
        clearInterval(timer);
        if (listens) for (const t of STEER_EVENTS) w.removeEventListener(t, steer, true);
      };
      // The Ctrl+S hook is registered by each successful project.open (startSaveHook).
      const mod: Record<string, unknown> = w.Module ?? {};
      const caps = Object.keys(mod).filter((k) => /^kicad[A-Za-z0-9]*$/.test(k) && typeof mod[k] === 'function').sort();
      // The picker (PICKER.md) needs the mirror (the example library has no index to search) and the
      // engine's place and selection exports; ev.ready says so with the pseudo-cap `picker`, and
      // with `fields` that its place writes the placed item's Value and Footprint.
      // A symedit frame places nothing (place is unsupported there): its keys stay KiCad's.
      pickerOn = frame !== 'symedit' && libs?.mirror != null && typeof mod.kicadPlaceImportedItem === 'function' && typeof mod.kicadCollabGetSelection === 'function';
      if (pickerOn) { caps.push(PICKER_CAP, FIELDS_CAP, IDENTITY_CAP); caps.sort(); }
      // ev.selected from the engine's own selection hook: its slot taken here, the hook
      // armed here in a pcb frame and by the first document in a sch frame (SelectionFeed.arm);
      // sent only while a document is open.
      // In a symedit frame the selection is the symbol editor's own (kicadSymEditSelection),
      // sent while a symbol is open; its select is the symedit cap's.
      const symedit = frame === 'symedit';
      const symeditOn = symedit && SYMEDIT_EXPORTS.every((name) => typeof mod[name] === 'function');
      const symbolOpen = (): boolean => symeditOn && symState(mod)?.open === true;
      const feed = new SelectionFeed(w as unknown as SelectionWindow, {
        timing,
        frame,
        live: () => !closed && !importing && (symedit ? symbolOpen() : staged != null && opened != null),
        send: (s) => emit({ type: 'ev.selected', uuids: s.uuids, fpPaths: s.fpPaths }),
        log: (m, err) => console.debug('[select]', m, err),
        ...(symedit ? { read: () => (symeditOn ? (mod.kicadSymEditSelection as () => unknown)() : '') } : {}),
      });
      if ((!symedit || symeditOn) && feed.start()) {
        selectionFeed = feed;
        if (!symedit && SELECT_EXPORTS.every((name) => typeof mod[name] === 'function')) { caps.push(SELECTION_CAP); caps.sort(); }
      }
      // project.write needs only the file system, which is up by now.
      caps.push(WRITE_CAP);
      // keys.claim and ev.key need nothing of the engine.
      caps.push(HOST_KEYS_CAP);
      // project.libs: the run time library rows; footprint.models: our engine's export.
      if (projectLibs != null && LIBS_EXPORTS.every((name) => typeof mod[name] === 'function')) caps.push(PROJECT_LIBS_CAP);
      // The symbol editor's caps (island v0.2.3-cc23), each frame its own kind's only: a
      // symedit frame lists none of the document frames' pseudo-caps, and they none of its.
      const hasAll = (names: readonly string[]): boolean => names.every((name) => typeof mod[name] === 'function');
      if (frame !== 'pcb' && hasAll(CONVERT_EXPORTS)) caps.push(CONVERT_CAP);
      if (symedit) {
        if (symeditOn) caps.push(SYMEDIT_CAP);
        if (symeditOn && typeof mod[SYMEDIT_ASK_EXPORT] === 'function') {
          caps.push(SYMEDIT_HELD_CAP);
          // ev.symedit: the symbol editor asks the page before its pin, field, text,
          // text box, shape and symbol dialogs; taken after ev.ready with a symbol open.
          installSymEditAsk(w as unknown as SymEditAskWindow, {
            admit: () => readySent && !closed && symbolOpenSeen,
            send: (a) => emit({ type: 'ev.symedit', ask: a.ask, uuid: a.uuid, isNew: a.isNew }),
          });
        }
      }
      if (frame === 'sch' && hasAll(SYMBOL_EDIT_EXPORTS)) caps.push(SYMBOL_EDIT_CAP);
      if (frame === 'sch' && hasAll(LIB_UPDATE_EXPORTS)) caps.push(LIB_UPDATE_CAP);
      // Whether a request of KiCad's (a properties dialog, a held key) reaches the host
      // now: after ev.ready, while a document is open (a symbol in a symedit frame).
      const admit = (): boolean => readySent && !closed && !importing && (symedit ? symbolOpenSeen : staged != null && opened != null);
      // A symedit frame lists none of the document frames' pseudo-caps (spec 3.3).
      if (!symedit) {
        if (MODEL_EXPORTS.every((name) => typeof mod[name] === 'function')) caps.push(MODELS_CAP);
        // project.plot: our engine's kicadPlotBoard.
        if (PLOT_EXPORTS.every((name) => typeof mod[name] === 'function')) caps.push(PLOT_CAP);
        // The Editing window's ops: our engine's symbol, numbering and check exports.
        if (SYMBOL_EXPORTS.every((name) => typeof mod[name] === 'function')) caps.push(SYMBOL_CAP);
        if (ANNOTATE_EXPORTS.every((name) => typeof mod[name] === 'function')) caps.push(ANNOTATE_CAP);
        if (CHECK_EXPORTS.every((name) => typeof mod[name] === 'function')) caps.push(CHECK_CAP);
        // Engine run A: the board's update, check, rule and item exports.
        if (BOARD_UPDATE_EXPORTS.every((name) => typeof mod[name] === 'function')) caps.push(BOARD_UPDATE_CAP);
        if (BOARD_CHECK_EXPORTS.every((name) => typeof mod[name] === 'function')) caps.push(DRC_CAP);
        if (EXPLAIN_EXPORTS.every((name) => typeof mod[name] === 'function')) caps.push(EXPLAIN_CAP);
        if (BOARD_ITEM_EXPORTS.every((name) => typeof mod[name] === 'function')) caps.push(BOARD_ITEM_CAP);
        // The outputs (island v0.2.3-cc23): this frame's own kind's export, and the rules read.
        if (hasAll(EXPORT_EXPORTS[frame])) caps.push(EXPORT_CAP);
        if (hasAll(RULES_EXPORTS)) caps.push(RULES_CAP);
        // Properties, numbering and rules (island v0.2.3-cc23): each frame its own kind's.
        if (frame === 'sch' && hasAll(SYMBOLS_EXPORTS)) caps.push(SYMBOLS_CAP);
        if (frame === 'sch' && hasAll(SYMBOL_EXCHANGE_EXPORTS)) caps.push(SYMBOL_EXCHANGE_CAP);
        if (frame === 'sch' && hasAll(SCH_EDIT_EXPORTS)) caps.push(SCH_EDIT_CAP);
        if (frame === 'pcb' && hasAll([...FOOTPRINTS_EXPORTS, 'kicadCollabBusy'])) caps.push(BOARD_FOOTPRINTS_CAP);
        if (frame === 'pcb' && hasAll(BOARD_EDIT_EXPORTS)) caps.push(BOARD_EDIT_CAP);
        if (frame === 'pcb' && hasAll(FOOTPRINT_EXCHANGE_EXPORTS)) caps.push(FOOTPRINT_EXCHANGE_CAP);
        if (hasAll(SETTINGS_EXPORTS)) caps.push(SETTINGS_CAP);
        // The simulator (island v0.2.3-cc23): a sch frame only (it lives in the schematic
        // engine); `simModel` with the four model exports, `sim` with the four run exports
        // and the service the island serves.
        if (frame === 'sch' && hasAll(SIM_MODEL_EXPORTS)) caps.push(SIM_MODEL_CAP);
        if (frame === 'sch' && simService != null && hasAll(SIM_RUN_EXPORTS)) caps.push(SIM_CAP);
        if (typeof mod[BOARD_PROPERTIES_EXPORT] === 'function') caps.push(BOARD_PROPERTIES_CAP);
        // ev.properties and ev.boardProperties: our engine asks the page before
        // KiCad's properties dialogs open (the schematic's from run 11, the
        // board's from run 12); each frame takes its own kind's request while a
        // document is open, so the host's own window edits that item instead.
        if (frame === 'sch' && typeof mod[PROPERTIES_EXPORT] === 'function') caps.push(PROPERTIES_CAP);
        if ((frame === 'sch' && typeof mod[PROPERTIES_EXPORT] === 'function') || (frame === 'pcb' && typeof mod[BOARD_PROPERTIES_EXPORT] === 'function')) {
          installProperties(w as unknown as PropertiesWindow, {
            frame,
            admit,
            send: (req) => {
              if (req.type === 'board') emit({ type: 'ev.boardProperties', uuid: req.uuid, kind: req.kind });
              else emit(req.field === undefined ? { type: 'ev.properties', uuids: [req.uuid], sheetPath: req.sheetPath } : { type: 'ev.properties', uuids: [req.uuid], sheetPath: req.sheetPath, field: req.field });
            },
          });
        }
      }
      caps.sort();
      // ev.held: our engine (run 12) asks the page before a hotkey's action;
      // the frame holds the actions whose windows the host replaces, each only
      // under the cap its replacement needs (bridge/held.ts).
      if (typeof mod[HELD_EXPORT] === 'function') {
        caps.push(HELD_KEYS_CAP);
        caps.sort();
        installHeld(w as unknown as HeldWindow, {
          frame,
          caps,
          admit,
          repeating: () => keyRepeat,
          send: (action) => emit({ type: 'ev.held', action }),
        });
      }
      // ev.edited: polled only when the engine has the undo depth export at
      // boot; an older build is never polled and nothing is said about it.
      // In a symedit frame the depth is the symbol editor's own (kicadSymEditState), read while a symbol is open.
      if (symedit ? symeditOn : typeof mod.kicadCollabTestUndoDepth === 'function') {
        const edits = setInterval(() => (symedit ? pollSymEdits(mod) : pollEdits(w)), timing.editPollMs);
        stopEdits = () => clearInterval(edits);
      }
      const n = help.attempts();
      if (n > 0) emit({ type: 'ev.state', phase: 'booting', detail: popupNote(n) });
      emit({ type: 'ev.ready', caps, engine });
      readySent = true;
      // The boot hid the chrome before the listener was there: its state now.
      chromeSay?.();
    },
    busy() {
      return inFlight > 0 || importing || checking;
    },
    popupBlocked(attempts) {
      // Before ev.ready the count travels once, in the booting note above.
      if (ready) emit({ type: 'ev.state', phase: 'popup', detail: popupNote(attempts) });
    },
    close,
  };
}
