// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The pencil-tools generator: theme/pencil-tools.json (the tool table the site copies)
// and theme/user.hotkeys (the seeded chords) from the seeded toolbar layouts and
// KiCad's default hotkeys at the pin (theme/pencil-tools.defaults.json).
//
// user.hotkeys is the chord LEDGER: every line already in it stays, byte for byte and
// in its place, so an existing chord never moves. A tool that has no pressable KiCad
// default and no line yet takes the next free chord of the pool, appended at the end.
// Running it twice changes nothing.
//
// The pool is per editor (the small tools spec 6.3): a chord is free for an action
// when no action of an editor that runs it holds it. KiCad's ACTION_MANAGER::RunHotKey
// runs, of the actions bound to a key, the one whose tool THIS frame holds (a context
// action), else tries the global ones in turn until one is handled, so an eeschema
// action and a pcbnew action may share a chord; a common action runs everywhere and
// takes its chord from every pool.
//   node theme/pencil-tools.gen.mjs           write both files, print what it added
//   node theme/pencil-tools.gen.mjs --check   write nothing; exit 1 when either file would change
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TABLE_PATH = 'theme/pencil-tools.json';
export const HOTKEYS_PATH = 'theme/user.hotkeys';
export const DEFAULTS_PATH = 'theme/pencil-tools.defaults.json';
export const LAYOUT_PATHS = { sch: 'theme/toolbars/eeschema-toolbars.json', pcb: 'theme/toolbars/pcbnew-toolbars.json' };
/**
 * The wave units' pencil rows, one file per unit (theme/pencil/<unit>.json, its
 * shape in theme/pencil/README.md), written by the ST-PRESS run only. Each row
 * is appended after the built in rows of its editor and strip, in unit id order
 * then file order; a row with no pressable default takes its chord as a built
 * in row does (the ledger's, else the next free one), except a row pressed by
 * action name (`press: "run"`, chord ""). No unit file today: the table and the
 * ledger are byte for byte what they were.
 */
export const UNIT_ROWS_DIR = 'theme/pencil';

/** The editors, in table order: the two with a seeded toolbar layout, then the footprint editor and the drawing sheet editor, whose rows are all OFF_LAYOUT's. */
export const EDITORS = ['sch', 'pcb', 'fpedit', 'ds'];

/**
 * The pools an action's chord is taken from, by the editor that runs it: eeschema
 * actions (the symbol editor's too) the schematic's, pcbnew actions (the footprint
 * editor's too) the board's, plEditor actions the drawing sheet editor's, and any
 * other (common) every pool.
 */
export const POOLS = ['sch', 'pcb', 'ds'];
export function poolsOf(action) {
  const head = action.split('.')[0];
  if (head === 'eeschema') return ['sch'];
  if (head === 'pcbnew') return ['pcb'];
  if (head === 'plEditor') return ['ds'];
  return POOLS;
}

/** The strips, in table order within an editor, and the toolbar each one reads. */
const STRIPS = [['right', 'RIGHT'], ['top', 'TOP_MAIN'], ['left', 'LEFT']];

/** The only tools of the top strip the table carries: the page's topbar. */
export const TOP_ACTIONS = {
  sch: ['common.Control.save', 'common.Interactive.undo', 'common.Interactive.redo', 'common.Interactive.find', 'eeschema.EditorControl.annotate', 'eeschema.InspectionTool.runERC'],
  pcb: ['common.Control.save', 'common.Interactive.undo', 'common.Interactive.redo', 'common.Interactive.find', 'common.Control.updatePcbFromSchematic', 'pcbnew.DRCTool.runDRC'],
};

/**
 * The rows on no seeded toolbar, in order. A row with `after` sits right after that
 * action of its strip, in its section (Fill All Zones beside DRC, Unfill beside Fill);
 * any other row follows its strip's toolbar tools, in a section of its own past the
 * toolbar's last. `group` is the row's group on the page, `press: 'run'` a row the
 * page presses by name through action.run (no chord). After Fill All Zones come the
 * rows of wave 2 (the ST-PRESS run): the small tools cluster's own, then every other
 * cluster's (the drawing sheet editor ds, the footprint editor fpedit, the board and
 * schematic canvas commands), as the wave manifest names them.
 */
export const OFF_LAYOUT = [
  { editor: 'pcb', strip: 'top', action: 'pcbnew.ZoneFiller.zoneFillAll', after: 'pcbnew.DRCTool.runDRC' },
  { editor: 'pcb', strip: 'left', action: 'pcbnew.Control.flipBoard', group: 'Display' },
  { editor: 'pcb', strip: 'left', action: 'pcbnew.Control.graphicOutlines', group: 'Display' },
  { editor: 'pcb', strip: 'left', action: 'pcbnew.Control.textOutlines', group: 'Display' },
  { editor: 'pcb', strip: 'left', action: 'common.Control.highContrastModeCycle', group: 'Display' },
  { editor: 'pcb', strip: 'left', action: 'pcbnew.Control.layerAlphaDec', group: 'Display' },
  { editor: 'pcb', strip: 'left', action: 'pcbnew.Control.layerAlphaInc', group: 'Display' },
  { editor: 'pcb', strip: 'right', action: 'pcbnew.MicrowaveTool.createLine', group: 'Microwave' },
  { editor: 'pcb', strip: 'right', action: 'pcbnew.MicrowaveTool.createGap', group: 'Microwave' },
  { editor: 'pcb', strip: 'right', action: 'pcbnew.MicrowaveTool.createStub', group: 'Microwave' },
  { editor: 'pcb', strip: 'right', action: 'pcbnew.MicrowaveTool.createStubArc', group: 'Microwave' },
  { editor: 'pcb', strip: 'right', action: 'pcbnew.MicrowaveTool.createFunctionShape', group: 'Microwave' },
  { editor: 'pcb', strip: 'right', action: 'pcbnew.InteractiveDrawing.placeCharacteristics' },
  { editor: 'pcb', strip: 'right', action: 'pcbnew.InteractiveDrawing.placeStackup' },
  { editor: 'pcb', strip: 'right', action: 'pcbnew.Autoplacer.autoplaceOffboard', group: 'Auto-place' },
  { editor: 'pcb', strip: 'right', action: 'pcbnew.Autoplacer.autoplaceSelected', group: 'Auto-place' },
  { editor: 'pcb', strip: 'right', action: 'pcbnew.Generator.regenerateAllTuning' },
  { editor: 'pcb', strip: 'top', action: 'pcbnew.ZoneFiller.zoneUnfillAll', after: 'pcbnew.ZoneFiller.zoneFillAll' },
  { editor: 'sch', strip: 'left', action: 'eeschema.EditorControl.showHiddenFields', group: 'Show' },
  { editor: 'sch', strip: 'left', action: 'eeschema.EditorControl.showDirectiveLabels', group: 'Show' },
  { editor: 'sch', strip: 'left', action: 'eeschema.EditorControl.showERCErrors', group: 'Show' },
  { editor: 'sch', strip: 'left', action: 'eeschema.EditorControl.showERCWarnings', group: 'Show' },
  { editor: 'sch', strip: 'left', action: 'eeschema.EditorControl.showERCExclusions', group: 'Show' },
  { editor: 'sch', strip: 'left', action: 'eeschema.EditorControl.togglePinAltIcons', group: 'Show' },
  { editor: 'sch', strip: 'left', action: 'eeschema.EditorControl.markSimExclusions', group: 'Show' },
  { editor: 'ds', strip: 'right', action: 'plEditor.InteractiveDrawing.drawLine' },
  { editor: 'ds', strip: 'right', action: 'plEditor.InteractiveDrawing.drawRectangle' },
  { editor: 'ds', strip: 'right', action: 'plEditor.InteractiveDrawing.placeText' },
  { editor: 'ds', strip: 'right', action: 'plEditor.InteractiveDrawing.placeImage' },
  { editor: 'ds', strip: 'right', action: 'plEditor.InteractiveMove.move' },
  { editor: 'ds', strip: 'right', action: 'common.Interactive.deleteTool' },
  { editor: 'ds', strip: 'top', action: 'common.Interactive.undo' },
  { editor: 'ds', strip: 'top', action: 'common.Interactive.redo' },
  { editor: 'fpedit', strip: 'right', action: 'common.Control.gridSetOrigin' },
  { editor: 'fpedit', strip: 'left', action: 'common.Control.highContrastMode' },
  { editor: 'fpedit', strip: 'right', action: 'common.Interactive.deleteTool' },
  { editor: 'fpedit', strip: 'right', action: 'common.Interactive.group' },
  { editor: 'fpedit', strip: 'right', action: 'common.Interactive.measureTool' },
  { editor: 'fpedit', strip: 'right', action: 'common.Interactive.ungroup' },
  { editor: 'fpedit', strip: 'left', action: 'pcbnew.Control.graphicOutlines' },
  { editor: 'fpedit', strip: 'left', action: 'pcbnew.Control.padDisplayMode' },
  { editor: 'fpedit', strip: 'left', action: 'pcbnew.Control.textOutlines' },
  { editor: 'fpedit', strip: 'right', action: 'pcbnew.InteractiveDrawing.alignedDimension' },
  { editor: 'fpedit', strip: 'right', action: 'pcbnew.InteractiveDrawing.arc' },
  { editor: 'fpedit', strip: 'right', action: 'pcbnew.InteractiveDrawing.barcode' },
  { editor: 'fpedit', strip: 'right', action: 'pcbnew.InteractiveDrawing.bezier' },
  { editor: 'fpedit', strip: 'right', action: 'pcbnew.InteractiveDrawing.centerDimension' },
  { editor: 'fpedit', strip: 'right', action: 'pcbnew.InteractiveDrawing.circle' },
  { editor: 'fpedit', strip: 'right', action: 'pcbnew.InteractiveDrawing.drawTable' },
  { editor: 'fpedit', strip: 'right', action: 'pcbnew.InteractiveDrawing.graphicPolygon' },
  { editor: 'fpedit', strip: 'right', action: 'pcbnew.InteractiveDrawing.leader' },
  { editor: 'fpedit', strip: 'right', action: 'pcbnew.InteractiveDrawing.line' },
  { editor: 'fpedit', strip: 'right', action: 'pcbnew.InteractiveDrawing.orthogonalDimension' },
  { editor: 'fpedit', strip: 'right', action: 'pcbnew.InteractiveDrawing.placePoint' },
  { editor: 'fpedit', strip: 'right', action: 'pcbnew.InteractiveDrawing.placeReferenceImage' },
  { editor: 'fpedit', strip: 'right', action: 'pcbnew.InteractiveDrawing.radialDimension' },
  { editor: 'fpedit', strip: 'right', action: 'pcbnew.InteractiveDrawing.rectangle' },
  { editor: 'fpedit', strip: 'right', action: 'pcbnew.InteractiveDrawing.ruleArea' },
  { editor: 'fpedit', strip: 'right', action: 'pcbnew.InteractiveDrawing.setAnchor' },
  { editor: 'fpedit', strip: 'right', action: 'pcbnew.InteractiveDrawing.text' },
  { editor: 'fpedit', strip: 'right', action: 'pcbnew.InteractiveDrawing.textbox' },
  { editor: 'fpedit', strip: 'right', action: 'pcbnew.InteractiveEdit.mirrorHoriontally' },
  { editor: 'fpedit', strip: 'right', action: 'pcbnew.InteractiveEdit.mirrorVertically' },
  { editor: 'fpedit', strip: 'right', action: 'pcbnew.InteractiveEdit.rotateCcw' },
  { editor: 'fpedit', strip: 'right', action: 'pcbnew.InteractiveEdit.rotateCw' },
  { editor: 'fpedit', strip: 'right', action: 'pcbnew.PadTool.explodePad' },
  { editor: 'fpedit', strip: 'right', action: 'pcbnew.PadTool.placePad' },
  { editor: 'fpedit', strip: 'right', action: 'pcbnew.PadTool.recombinePad' },
  { editor: 'fpedit', strip: 'left', action: 'pcbnew.PointEditor.arcKeepCenter' },
  { editor: 'fpedit', strip: 'left', action: 'pcbnew.PointEditor.arcKeepEndpoint' },
  { editor: 'fpedit', strip: 'left', action: 'pcbnew.PointEditor.arcKeepRadius' },
  { editor: 'pcb', strip: 'right', action: 'common.Interactive.group', group: 'Group', press: 'run' },
  { editor: 'pcb', strip: 'right', action: 'common.Interactive.ungroup', group: 'Group', press: 'run' },
  { editor: 'pcb', strip: 'right', action: 'pcbnew.EditorControl.lock', group: 'Lock', press: 'run' },
  { editor: 'pcb', strip: 'right', action: 'pcbnew.EditorControl.unlock', group: 'Lock', press: 'run' },
  { editor: 'pcb', strip: 'right', action: 'pcbnew.InteractiveEdit.flip', group: 'Arrange', press: 'run' },
  { editor: 'pcb', strip: 'right', action: 'pcbnew.InteractiveEdit.mirrorHoriontally', group: 'Arrange', press: 'run' },
  { editor: 'pcb', strip: 'right', action: 'pcbnew.InteractiveEdit.mirrorVertically', group: 'Arrange', press: 'run' },
  { editor: 'pcb', strip: 'right', action: 'pcbnew.InteractiveEdit.rotateCcw', group: 'Arrange', press: 'run' },
  { editor: 'pcb', strip: 'right', action: 'pcbnew.InteractiveEdit.rotateCw', group: 'Arrange', press: 'run' },
  { editor: 'pcb', strip: 'left', action: 'pcbnew.PointEditor.arcKeepCenter', group: 'Arc editing', press: 'run' },
  { editor: 'pcb', strip: 'left', action: 'pcbnew.PointEditor.arcKeepEndpoint', group: 'Arc editing', press: 'run' },
  { editor: 'pcb', strip: 'left', action: 'pcbnew.PointEditor.arcKeepRadius', group: 'Arc editing', press: 'run' },
  { editor: 'sch', strip: 'right', action: 'common.Interactive.group', group: 'Group', press: 'run' },
  { editor: 'sch', strip: 'right', action: 'common.Interactive.ungroup', group: 'Group', press: 'run' },
  { editor: 'sch', strip: 'right', action: 'eeschema.InteractiveEdit.mirrorH', group: 'Arrange', press: 'run' },
  { editor: 'sch', strip: 'right', action: 'eeschema.InteractiveEdit.mirrorV', group: 'Arrange', press: 'run' },
  { editor: 'sch', strip: 'right', action: 'eeschema.InteractiveEdit.rotateCCW', group: 'Arrange', press: 'run' },
  { editor: 'sch', strip: 'right', action: 'eeschema.InteractiveEdit.rotateCW', group: 'Arrange', press: 'run' },
];

/**
 * The chord pool, in the order chords are handed out: Ctrl+Alt+digit or letter, then
 * Ctrl+Alt+Shift+letter, then (wave 2) Ctrl+Alt+Shift+digit (the symbol editor's in the
 * schematic, free in the other pools), Ctrl+Alt+F1 to F12 and Ctrl+Alt+Shift+F1 to F12,
 * none of them a KiCad default.
 */
export const POOL = [
  ...[...'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((c) => `Ctrl+Alt+${c}`),
  ...[...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((c) => `Ctrl+Alt+Shift+${c}`),
  ...[...'0123456789'].map((c) => `Ctrl+Alt+Shift+${c}`),
  ...Array.from({ length: 12 }, (_, i) => `Ctrl+Alt+F${i + 1}`),
  ...Array.from({ length: 12 }, (_, i) => `Ctrl+Alt+Shift+F${i + 1}`),
];

/** KiCad's two Ctrl+Alt defaults (Find and Replace, Track Corner Mode 90), and their Shift twins kept clear. */
export const BANNED = ['Ctrl+Alt+F', 'Ctrl+Alt+W', 'Ctrl+Alt+Shift+F', 'Ctrl+Alt+Shift+W'];

/**
 * Actions whose KiCad default a common action takes first in every frame that
 * holds them, so a press of the default never runs them: each takes a chord of
 * its own (KiCad's default kept as its second key). Measured on engine build T4
 * (run 15) through key.press, in a pcb frame on Glasgow and in an fpedit frame with
 * a footprint open: Ctrl+Shift+C tries common.Interactive.copyAsText alone (the circle
 * tool never tried), Ctrl+Shift+A common.Interactive.unselectAll alone (the arc tool).
 */
export const SHADOWED_DEFAULTS = ['pcbnew.InteractiveDrawing.circle', 'pcbnew.InteractiveDrawing.arc'];

/**
 * A default key.press can send: modifiers Ctrl, Alt and Shift, and a key its code
 * grammar holds (src/keys.ts KEY_CODE_RE: KiCad's Alt+` and the opacity keys { and }
 * have none). A Shift and a letter alone is not one either: a host's key.press of it
 * never reaches KiCad's action (measured for the symbol editor's Shift+R, island cc23).
 */
export function pressable(key) {
  if (key == null) return false;
  const parts = key.split('+');
  const last = parts.pop();
  if (!parts.every((m) => m === 'Ctrl' || m === 'Alt' || m === 'Shift')) return false;
  if (!/^([A-Z0-9]|F([1-9]|1[0-2])|Escape|Home|Delete|Backspace|Enter|Space)$/.test(last)) return false;
  return !(parts.length === 1 && parts[0] === 'Shift' && /^[A-Z]$/.test(last));
}

/** One strip of a seeded layout, flattened in order, as [action, group, section]. */
function layoutStrip(layoutJson, toolbar) {
  const bar = JSON.parse(layoutJson).toolbars.find((t) => t.name === toolbar);
  if (bar == null) throw new Error(`no ${toolbar} toolbar`);
  const out = [];
  let section = 0;
  for (const it of bar.contents) {
    if (it.type === 'SEPARATOR') section++;
    else if (it.type === 'TOOL') out.push([it.name, null, section]);
    else if (it.type === 'TB_GROUP') for (const g of it.group_items) out.push([g.name, it.group_name, section]);
  }
  return out;
}

/** The ledger's lines (`action<TAB>primary<TAB>secondary`), as KiCad reads user.hotkeys. */
function parseLedger(text) {
  const lines = text.split('\n').filter((l) => l !== '');
  const keys = new Map();
  for (const line of lines) {
    const [action, primary] = line.split('\t');
    if (keys.has(action)) throw new Error(`user.hotkeys binds ${action} twice`);
    keys.set(action, primary);
  }
  return { lines, keys };
}

/** A flat object as Python's json.dumps writes it (the table's original serializer): ", " and ": ", ASCII only. */
function pyDumps(obj) {
  const str = (v) => JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `{${Object.entries(obj).map(([k, v]) => `${str(k)}: ${str(v)}`).join(', ')}}`;
}

/** The hotkeys lines of other files the engine is seeded with (theme/symedit.hotkeys, theme/hotkeys/*.hotkeys): read, never written. */
function parseExtra(text) {
  const keys = new Map();
  for (const line of text.split('\n').filter((l) => l !== '')) {
    const [action, primary, secondary] = line.split('\t');
    keys.set(action, [primary, secondary ?? '']);
  }
  return keys;
}

/**
 * The table and the hotkeys file from their inputs, all as text. `extraHotkeys` is
 * what the engine is seeded with after the ledger (the symbol editor's chords and the
 * units' own): their chords are taken in their pools and never handed out again.
 * `shadowed` lists the actions whose KiCad default never runs them (SHADOWED_DEFAULTS).
 * @returns {{ table: string, hotkeys: string, rows: object[], added: string[] }}
 */
export function generate({ defaultsJson, layouts, ledger, unitRows = [], extraHotkeys = '', shadowed = SHADOWED_DEFAULTS }) {
  const defaults = JSON.parse(defaultsJson);
  const { lines, keys } = parseLedger(ledger);
  const extra = parseExtra(extraHotkeys);
  // One action keeps one chord in every editor; the ledger's chords are taken as they stand.
  const chord = new Map([...keys].filter(([, k]) => k.startsWith('Ctrl+Alt+')));
  for (const [action, [k]] of extra) if (!chord.has(action) && k.startsWith('Ctrl+Alt+')) chord.set(action, k);
  // Every key bound now, per pool: KiCad's defaults, the ledger's and the extra files' keys.
  const taken = Object.fromEntries(POOLS.map((p) => [p, new Set()]));
  const take = (action, key) => { if (key) for (const p of poolsOf(action)) taken[p].add(key); };
  for (const [action, key] of Object.entries(defaults)) take(action, key);
  for (const [action, key] of keys) take(action, key);
  for (const [action, [k, k2]] of extra) { take(action, k); take(action, k2); }
  const added = [];
  const chordFor = (action) => {
    if (!chord.has(action)) {
      const next = POOL.find((c) => !BANNED.includes(c) && poolsOf(action).every((p) => !taken[p].has(c)));
      if (next == null) throw new Error(`the chord pool ran out at ${action}`);
      chord.set(action, next);
      take(action, next);
      // KiCad's own default stays as the second key, so a keyboard press of it still runs the action.
      added.push(`${action}\t${next}\t${defaults[action] ?? ''}`);
    }
    return chord.get(action);
  };
  const rowOf = (editor, strip, action, group, section, press) => {
    const known = action in defaults ? defaults[action] : null;
    const defaultKey = pressable(known) && !shadowed.includes(action) ? known : null;
    const seededKey = press === 'run' ? '' : defaultKey == null ? chordFor(action) : null;
    const row = { editor, strip, action, group, section, defaultKey, seededKey, label: '' };
    return press === 'run' ? { ...row, press: 'run' } : row;
  };
  const rows = [];
  for (const editor of EDITORS) {
    for (const [strip, toolbar] of STRIPS) {
      let items = editor in layouts ? layoutStrip(layouts[editor], toolbar) : [];
      if (strip === 'top' && editor in TOP_ACTIONS) {
        items = items.filter(([a]) => TOP_ACTIONS[editor].includes(a));
        const got = items.map(([a]) => a).join(' ');
        if (got !== TOP_ACTIONS[editor].join(' ')) throw new Error(`${editor} TOP_MAIN holds ${got}, not the topbar's tools in order`);
      }
      const own = items.length === 0 ? 0 : items.at(-1)[2] + 1;
      for (const off of OFF_LAYOUT.filter((o) => o.editor === editor && o.strip === strip)) {
        if (items.some(([a]) => a === off.action)) throw new Error(`${off.action} is in the ${editor} ${strip} strip twice`);
        if (off.after != null) {
          const at = items.findIndex(([a]) => a === off.after);
          if (at < 0) throw new Error(`${off.action} goes after ${off.after}, which the ${editor} ${strip} strip does not hold`);
          items.splice(at + 1, 0, [off.action, off.group ?? null, items[at][2], off.press]);
        } else {
          items.push([off.action, off.group ?? null, own, off.press]);
        }
      }
      for (const [action, group, section, press] of items) {
        if (!(action in defaults)) throw new Error(`${action} has no entry in ${DEFAULTS_PATH}`);
        rows.push(rowOf(editor, strip, action, group, section, press));
      }
    }
  }
  // The wave units' rows (UNIT_ROWS_DIR), after the built ins, in the order given.
  const unitKeys = new Set(rows.map((r) => `${r.editor} ${r.action}`));
  for (const { unit, rows: own } of [...unitRows].sort((a, b) => (a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0))) {
    for (const r of own) {
      if (typeof r.editor !== 'string' || !/^[a-z]+$/.test(r.editor) || typeof r.strip !== 'string' || typeof r.action !== 'string') throw new Error(`${UNIT_ROWS_DIR}/${unit}.json: a row needs editor, strip and action`);
      if (unitKeys.has(`${r.editor} ${r.action}`)) throw new Error(`${UNIT_ROWS_DIR}/${unit}.json: ${r.action} is in the ${r.editor} table already`);
      unitKeys.add(`${r.editor} ${r.action}`);
      const known = r.action in defaults ? defaults[r.action] : (r.defaultKey ?? null);
      const defaultKey = pressable(known) && !shadowed.includes(r.action) ? known : null;
      const seededKey = r.press === 'run' ? '' : defaultKey == null ? chordFor(r.action) : null;
      const row = { editor: r.editor, strip: r.strip, action: r.action, group: r.group ?? null, section: r.section ?? 0, defaultKey, seededKey, label: r.label ?? '' };
      rows.push(r.press === 'run' ? { ...row, press: 'run' } : row);
    }
  }
  return {
    table: `[\n${rows.map((r) => `  ${pyDumps(r)}`).join(',\n')}\n]\n`,
    hotkeys: [...lines, ...added].map((l) => `${l}\n`).join(''),
    rows,
    added,
  };
}

/** The inputs as they stand in the worktree (run from the repository root). */
export function readInputs() {
  return {
    defaultsJson: readFileSync(DEFAULTS_PATH, 'utf8'),
    layouts: { sch: readFileSync(LAYOUT_PATHS.sch, 'utf8'), pcb: readFileSync(LAYOUT_PATHS.pcb, 'utf8') },
    ledger: readFileSync(HOTKEYS_PATH, 'utf8'),
    unitRows: readUnitRows(),
    extraHotkeys: readExtraHotkeys(),
  };
}

/** The hotkeys files seeded after the ledger (theme/seeds.ts): the symbol editor's, then every unit's in file name order. */
export const EXTRA_HOTKEYS_PATHS = ['theme/symedit.hotkeys'];
export const UNIT_HOTKEYS_DIR = 'theme/hotkeys';
export function readExtraHotkeys() {
  const unit = existsSync(UNIT_HOTKEYS_DIR) ? readdirSync(UNIT_HOTKEYS_DIR).filter((f) => f.endsWith('.hotkeys')).sort().map((f) => `${UNIT_HOTKEYS_DIR}/${f}`) : [];
  return [...EXTRA_HOTKEYS_PATHS, ...unit].map((p) => { const t = readFileSync(p, 'utf8'); return t.endsWith('\n') || t === '' ? t : `${t}\n`; }).join('');
}

/** Every unit's rows file (UNIT_ROWS_DIR/<unit>.json, an array of rows), by unit id. */
export function readUnitRows(dir = UNIT_ROWS_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => {
    const rows = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
    if (!Array.isArray(rows)) throw new Error(`${dir}/${f} must be an array of rows`);
    return { unit: f.slice(0, -'.json'.length), rows };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = generate(readInputs());
  const stale = [[TABLE_PATH, out.table], [HOTKEYS_PATH, out.hotkeys]].filter(([p, text]) => readFileSync(p, 'utf8') !== text);
  if (process.argv.includes('--check')) {
    for (const [p] of stale) console.error(`${p} differs from what the generator writes`);
    process.exit(stale.length > 0 ? 1 : 0);
  }
  writeFileSync(TABLE_PATH, out.table);
  writeFileSync(HOTKEYS_PATH, out.hotkeys);
  console.log(`${out.rows.length} rows; ${out.added.length} new chords; ${stale.length === 0 ? 'nothing changed' : `rewrote ${stale.map(([p]) => p).join(' and ')}`}`);
  for (const l of out.added) console.log(l);
}
