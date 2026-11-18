// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// Writes bridge/ext/contextMenuDoors.json, the doors table of our context menu
// (unit m1-i, the canvas commands addendum 3.6): every action any canvas menu
// of KiCad's can show that opens a window of KiCad's own, with its door.
//
// Read from the KiCad tree at the engine's pin (PIN.json engine.build.kicad,
// through `git show`, never the working tree): every action a tool's context
// menu adds (CONDITIONAL_MENU AddItem and AddCheckItem, an ACTION_MENU's Add),
// its name from its TOOL_ACTION declaration, and the handler its tool binds to
// it (setTransitions' Go). A handler whose body raises a window (a dialog, a
// message box, a file chooser, a layer chooser) is a candidate; REVIEWED below
// gives each candidate its door, read by hand against the addendum sections 4
// to 8 and RULINGS.md item 6. A candidate with no review is written `none`
// with the reason `not reviewed`, so the join test (bridge/ext/m1-doors.test.ts)
// fails until someone reads it.
//
//   node scripts/context-menu-doors.mjs            writes the table
//   node scripts/context-menu-doors.mjs --check    exits 1 when the table on disk differs
//
// CC_KICAD_DIR names the KiCad clone (default /home/matthew/cc-engine/kicad-source-mirror).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'bridge/ext/contextMenuDoors.json');
const KICAD = process.env.CC_KICAD_DIR ?? '/home/matthew/cc-engine/kicad-source-mirror';
const PIN = JSON.parse(readFileSync(join(ROOT, 'PIN.json'), 'utf8')).engine.build.kicad;

/** The trees whose tools build canvas menus (gerbview and the 3D viewer are not frames of ours). */
const MENU_DIRS = ['common/tool/', 'include/tool/', 'eeschema/tools/', 'pcbnew/tools/', 'pcbnew/router/', 'pagelayout_editor/tools/'];
/**
 * Tools whose menu is a PANEL's (the library tree's, the design block
 * panel's: lib_tree.cpp shows the tool's own menu), never the canvas's. The
 * canvas-only editor never shows those panels (showLibraryTree is held).
 */
const PANEL_MENU_FILES = new Set([
  'common/tool/design_block_control.cpp',
  'common/tool/library_editor_control.cpp',
  'eeschema/tools/sch_design_block_control.cpp',
  'eeschema/tools/symbol_editor_control.cpp',
  'pcbnew/tools/footprint_editor_control.cpp',
  'pcbnew/tools/pcb_design_block_control.cpp',
]);
/** The files declaring tool actions. */
const ACTION_FILES = ['common/tool/actions.cpp', 'eeschema/tools/sch_actions.cpp', 'pcbnew/tools/pcb_actions.cpp', 'pagelayout_editor/tools/pl_actions.cpp'];
/** A handler body that raises a window of KiCad's. */
const WINDOW_RE = /\b(?:DIALOG_[A-Z0-9_]+|KIDIALOG|WX_[A-Z_]+_DIALOG|wxMessageBox|wxFileDialog|wxDirDialog|DisplayError|DisplayErrorMessage|DisplayInfoMessage|IsOK|OKOrCancelDialog|SelectOneLayer|SelectSingleOption|ShowModal|ShowQuasiModal|InvokeDialog[A-Za-z]*|PCB_ONE_LAYER_SELECTOR|ShowFindDialog|ShowFindReplaceDialog|ShowReplaceDialog)\b/;

const git = (...args) => execFileSync('git', ['-C', KICAD, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const show = (path) => git('show', `${PIN}:${path}`);

/** `PCB_ACTIONS::moveExact` to `pcbnew.InteractiveEdit.moveExact`, from every declaration file. */
function actionNames(sources) {
  const names = new Map();
  for (const src of [...ACTION_FILES.map(show), ...sources.values()]) {
    // A class member (PCB_ACTIONS::moveExact) or a file's own static action (the router's ACT_SelLayerAndPlaceThroughVia).
    const re = /TOOL_ACTION\s+(?:([A-Z_]*ACTIONS)::(\w+)|(ACT_\w+))\s*\(\s*(?:TOOL_ACTION_ARGS\(\)[\s\S]*?\.Name\(\s*"([^"]+)"|"([^"]+)")/g;
    for (const m of src.matchAll(re)) names.set(keyOf(m[1], m[2], m[3]), m[4] ?? m[5]);
  }
  return names;
}

/** One key per C++ action: `PCB_ACTIONS::moveExact`, or `ACT::ACT_X` for a file's static action. */
const keyOf = (cls, member, act) => (act != null ? `ACT::${act}` : `${cls}::${member}`);

/** Every C++ action a menu in `src` adds. */
function menuActions(src) {
  const found = new Set();
  for (const m of src.matchAll(/\b(?:AddItem|AddCheckItem|Add)\(\s*(?:([A-Z_]*ACTIONS)::(\w+)|(ACT_\w+))\b/g)) found.add(keyOf(m[1], m[2], m[3]));
  return found;
}

/** The body of `CLASS::fn( ... )` in `src`, braces matched, or null. */
function bodyOf(src, cls, fn) {
  const head = new RegExp(`\\b${cls}::${fn}\\s*\\([^)]*\\)\\s*(?:const\\s*)?\\{`);
  const m = head.exec(src);
  if (m == null) return null;
  let depth = 0;
  for (let i = m.index + m[0].length - 1; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(m.index, i + 1);
  }
  return null;
}

function main() {
  const files = git('ls-tree', '-r', '--name-only', PIN, '--', ...MENU_DIRS).split('\n').filter((p) => /\.(cpp|h)$/.test(p));
  const sources = new Map(files.map((p) => [p, show(p)]));
  const names = actionNames(sources);
  // A tool's actions class inherits ACTIONS: SCH_ACTIONS::excludeMarker is ACTIONS::excludeMarker.
  const nameOf = (cpp) => names.get(cpp) ?? names.get(`ACTIONS::${cpp.split('::')[1]}`);
  // A handler is bound under either spelling of the class: one key, the declared one.
  const canon = (cpp) => (names.has(cpp) || cpp.startsWith('ACT::') ? cpp : names.has(`ACTIONS::${cpp.split('::')[1]}`) ? `ACTIONS::${cpp.split('::')[1]}` : cpp);
  // Which menus show each action, and which handlers each action is bound to.
  const menus = new Map();
  const bound = new Map();
  for (const [path, src] of sources) {
    for (const a of PANEL_MENU_FILES.has(path) ? [] : menuActions(src)) {
      const k = canon(a);
      if (!menus.has(k)) menus.set(k, new Set());
      menus.get(k).add(path);
    }
    for (const m of src.matchAll(/Go\(\s*&\s*(\w+)::(\w+)\s*,\s*(?:([A-Z_]*ACTIONS)::(\w+)|(ACT_\w+))\.MakeEvent\(\)/g)) {
      const key = canon(keyOf(m[3], m[4], m[5]));
      if (!bound.has(key)) bound.set(key, []);
      bound.get(key).push({ cls: m[1], fn: m[2] });
    }
  }
  const rows = [];
  const unnamed = [];
  for (const [cpp, shownIn] of menus) {
    const action = nameOf(cpp);
    if (action == null) { unnamed.push(cpp); continue; }
    let opens = null;
    for (const { cls, fn } of bound.get(cpp) ?? []) {
      for (const src of sources.values()) {
        const body = bodyOf(src, cls, fn);
        const hit = body != null ? WINDOW_RE.exec(body) : null;
        if (hit != null) { opens = hit[0]; break; }
      }
      if (opens != null) break;
    }
    const review = REVIEWED[action];
    if (opens == null && review == null) continue;
    rows.push({
      action,
      door: review?.door ?? 'none',
      opens: opens ?? review?.opens ?? '',
      menus: [...shownIn].sort(),
      why: review?.why ?? 'not reviewed',
    });
  }
  // A reviewed action the menus no longer show is a stale review: said, never kept.
  const stale = Object.keys(REVIEWED).filter((a) => !rows.some((r) => r.action === a));
  rows.sort((a, b) => (a.action < b.action ? -1 : a.action > b.action ? 1 : 0));
  return { table: { kicad: PIN, generator: 'scripts/context-menu-doors.mjs', rows }, unnamed, stale };
}

/**
 * The hand review: each action's door. `held` reads the held union at run
 * time (bridge/held.ts and every unit's heldRows: the unit named in `why`
 * holds it); `prompt:<ask>` is an ev.prompt ask (addendum 4, M3, M6, M12);
 * `form:<cap>` is an action whose window the engine hands to the host as a
 * form of ours while the cap is listed (the properties forms); `run` is an
 * action that raises no window of KiCad's in the menu's case (the reason
 * says why); `none` has no door.
 */
const REVIEWED = {
  // Addendum 4.2: the generic asks (m1x-i).
  'pcbnew.InteractiveEdit.filletTracks': { door: 'prompt:entry', why: 'addendum 4.2: WX_UNIT_ENTRY_DIALOG' },
  'pcbnew.InteractiveEdit.filletLines': { door: 'prompt:entry', why: 'addendum 4.2: WX_UNIT_ENTRY_DIALOG' },
  'pcbnew.InteractiveEdit.chamferLines': { door: 'prompt:entry', why: 'addendum 4.2: WX_UNIT_ENTRY_DIALOG' },
  'pcbnew.InteractiveEdit.simplifyPolygons': { door: 'prompt:entry', why: 'addendum 4.2: WX_UNIT_ENTRY_DIALOG' },
  'pcbnew.InteractiveEdit.healShapes': { door: 'prompt:entry', why: 'addendum 4.2: WX_UNIT_ENTRY_DIALOG' },
  'pcbnew.InteractiveEdit.dogboneCorners': { door: 'prompt:entry', why: 'addendum 4.2: WX_MULTI_ENTRY_DIALOG' },
  'pcbnew.InteractiveEdit.moveCorner': { door: 'prompt:entry', why: 'addendum 4.2: WX_PT_ENTRY_DIALOG' },
  'pcbnew.InteractiveEdit.moveMidpoint': { door: 'prompt:entry', why: 'addendum 4.2: WX_PT_ENTRY_DIALOG' },
  'pcbnew.InteractiveRouter.BreakTrack': { door: 'prompt:message', why: 'addendum 6: the locked-item confirmation only' },
  'pcbnew.InteractiveRouter.Drag45Degree': { door: 'prompt:message', why: 'addendum 6: the locked-item confirmation only' },
  'pcbnew.InteractiveRouter.DragFreeAngle': { door: 'prompt:message', why: 'addendum 6: the locked-item confirmation only' },
  'pcbnew.InteractiveRouter.SelLayerAndPlaceVia': { door: 'prompt:layer', why: 'addendum 4.2: PCB_ONE_LAYER_SELECTOR' },
  'pcbnew.InteractiveRouter.SelLayerAndPlaceBlindVia': { door: 'prompt:layer', why: 'addendum 4.2: PCB_ONE_LAYER_SELECTOR' },
  'pcbnew.InteractiveRouter.SelLayerAndPlaceMicroVia': { door: 'prompt:layer', why: 'addendum 4.2: PCB_ONE_LAYER_SELECTOR' },
  'pcbnew.Convert.convertToTracks': { door: 'prompt:layer', why: 'addendum 6: SelectOneLayer, only from a non copper layer' },
  // Addendum 6: the board's own asks (m3-i).
  'pcbnew.Convert.convertToPoly': { door: 'prompt:convert', why: 'addendum 6: DIALOG_CONVERT_SETTINGS' },
  'pcbnew.Convert.convertToZone': { door: 'prompt:convert', why: 'addendum 6: DIALOG_CONVERT_SETTINGS, then the zone settings' },
  'pcbnew.Convert.convertToKeepout': { door: 'prompt:convert', why: 'addendum 6: DIALOG_CONVERT_SETTINGS, then the rule area settings' },
  'pcbnew.Convert.convertToLines': { door: 'prompt:convert', why: 'addendum 6: DIALOG_CONVERT_SETTINGS' },
  'pcbnew.Convert.outsetItems': { door: 'prompt:outset', why: 'addendum 6: DIALOG_OUTSET_ITEMS' },
  'pcbnew.EditorControl.zoneDuplicate': { door: 'prompt:zoneSettings', why: 'addendum 6: the zone settings, purpose duplicate' },
  'pcbnew.InteractiveEdit.editVertices': { door: 'held', why: 'addendum 6: held by m3-i under vertices, the board form\'s Corners block' },
  // Addendum 7: placement cards and the selection filter (m6-i).
  'pcbnew.InteractiveEdit.moveExact': { door: 'prompt:moveExact', why: 'addendum 7: DIALOG_MOVE_EXACT' },
  'pcbnew.InteractiveEdit.FindMove': { door: 'prompt:findFootprint', why: 'addendum 7: Get and Move Footprint' },
  'pcbnew.Array.createArray': { door: 'prompt:array', why: 'addendum 7: DIALOG_CREATE_ARRAY (modeless)' },
  'pcbnew.PositionRelative.positionRelative': { door: 'prompt:positionRelative', why: 'addendum 7: DIALOG_POSITION_RELATIVE (modeless)' },
  'pcbnew.PositionRelative.interactiveOffsetTool': { door: 'prompt:offset', why: 'addendum 7: the offset entry after the two clicks' },
  'pcbnew.InteractiveSelection.FilterSelection': { door: 'prompt:filterSelection', why: 'addendum 7: DIALOG_FILTER_SELECTION' },
  // Addendum 8: tables (m12-i).
  'pcbnew.TableEditor.editTable': { door: 'prompt:table', why: 'addendum 8: DIALOG_TABLE_PROPERTIES' },
  'common.TableEditor.exportTableCSV': { door: 'held', why: 'addendum 8: held by m12-i under tableCsv, table.csv' },
  // RULINGS.md item 6: Edit in bulk (lo-bulk-i holds them; lo-l1-s and lo-l3c-s answer ev.held with their pages).
  'eeschema.InteractiveEdit.changeSymbol': { door: 'held', why: 'RULINGS 6: lo-bulk-i, Edit in bulk' },
  'eeschema.InteractiveEdit.changeSymbols': { door: 'held', why: 'RULINGS 6: lo-bulk-i, Edit in bulk' },
  'eeschema.InteractiveEdit.updateSymbol': { door: 'held', why: 'RULINGS 6: lo-bulk-i, Edit in bulk' },
  'eeschema.InteractiveEdit.updateSymbols': { door: 'held', why: 'RULINGS 6: lo-bulk-i, Edit in bulk' },
  'pcbnew.GlobalEdit.changeFootprint': { door: 'held', why: 'RULINGS 6: lo-bulk-i, Edit in bulk' },
  'pcbnew.GlobalEdit.changeFootprints': { door: 'held', why: 'RULINGS 6: lo-bulk-i, Edit in bulk' },
  'pcbnew.GlobalEdit.updateFootprint': { door: 'held', why: 'RULINGS 6: lo-bulk-i, Edit in bulk' },
  'pcbnew.GlobalEdit.updateFootprints': { door: 'held', why: 'RULINGS 6: lo-bulk-i, Edit in bulk' },
  'pcbnew.Control.zonesManager': { door: 'held', why: 'RULINGS 6: lo-bulk-i, Edit in bulk' },
  // Read by hand from the handlers the generator found (KiCad at the pin).
  'common.Checker.excludeMarker': { door: 'run', why: 'updates KiCad\'s ERC window only while it is shown, and runERC is held (check)' },
  'common.Control.editGridOrigin': { door: 'prompt:entry', why: 'addendum 4.2: WX_PT_ENTRY_DIALOG; in a pcb frame st-origins-i holds it (settings:origins), the union read first' },
  'common.Interactive.copy': { door: 'run', why: 'a message box only when writing the clipboard fails (pl_edit_tool.cpp)' },
  'common.Interactive.paste': { door: 'prompt:message', why: 'IsOK (confirm.cpp), the message ask' },
  'common.Interactive.pasteSpecial': { door: 'held', why: 'st-paste-i holds it (pasteSpecial)' },
  'eeschema.EditorControl.editPageNumber': { door: 'prompt:entry', why: 'WX_TEXT_ENTRY_DIALOG, the entry ask' },
  'eeschema.InteractiveDrawing.placeJunction': { door: 'run', why: 'TwoClickPlace\'s windows are a label\'s and a sheet\'s, never a junction\'s' },
  'eeschema.InteractiveEdit.assignNetclass': { door: 'prompt:assignNetclass', why: 'addendum 4.2: DIALOG_ASSIGN_NETCLASS' },
  'pcbnew.EditorControl.assignNetclass': { door: 'prompt:assignNetclass', why: 'addendum 4.2: DIALOG_ASSIGN_NETCLASS' },
  'eeschema.InteractiveEdit.cleanupSheetPins': { door: 'prompt:message', why: 'IsOK (confirm.cpp), the message ask' },
  'eeschema.InteractiveEdit.pinTable': { door: 'held', why: 'held in a symedit frame by the built in rows (symedit)' },
  'eeschema.InteractiveEdit.properties': { door: 'form:schItem', why: 'the engine hands every item\'s properties to the host (ev.properties for a symbol, ev.schItem for the other kinds, m5-i)' },
  'pcbnew.InteractiveEdit.properties': { door: 'form:boardItemKinds', why: 'the engine hands every item\'s properties to the host (the board form, ev.boardItem, m4-i)' },
  'pcbnew.InteractiveDrawing.applyDesignBlockLayout': { door: 'form:blockLayouts', why: 'i-block-layout: the layout of a design block applied through the host (board.preview, board.update)' },
  'pcbnew.InteractiveRouter.SettingsDialog': { door: 'held', why: 'st-routing-i holds it (settings:router)' },
  'pcbnew.ModuleEditor.padTable': { door: 'held', why: 'fp-i6 holds it in a fpedit frame (fpedit)' },
  'pcbnew.PadTool.PushPadSettings': { door: 'held', why: 'fp-i6 holds it in a fpedit frame (fpedit)' },
};

const { table, unnamed, stale } = main();
const text = `${JSON.stringify(table, null, 2)}\n`;
if (unnamed.length > 0) process.stderr.write(`menu actions with no declaration read: ${unnamed.join(', ')}\n`);
if (stale.length > 0) process.stderr.write(`reviewed actions no menu shows: ${stale.join(', ')}\n`);
if (process.argv.includes('--check')) {
  let disk = '';
  try { disk = readFileSync(OUT, 'utf8'); } catch { /* absent */ }
  if (disk !== text) { process.stderr.write('bridge/ext/contextMenuDoors.json differs from the generator\'s table\n'); process.exit(1); }
} else {
  writeFileSync(OUT, text);
  const counts = {};
  for (const r of table.rows) { const k = r.door.split(':')[0]; counts[k] = (counts[k] ?? 0) + 1; }
  process.stdout.write(`${table.rows.length} rows ${JSON.stringify(counts)}\n`);
}
