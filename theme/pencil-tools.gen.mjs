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
//   node theme/pencil-tools.gen.mjs           write both files, print what it added
//   node theme/pencil-tools.gen.mjs --check   write nothing; exit 1 when either file would change
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TABLE_PATH = 'theme/pencil-tools.json';
export const HOTKEYS_PATH = 'theme/user.hotkeys';
export const DEFAULTS_PATH = 'theme/pencil-tools.defaults.json';
export const LAYOUT_PATHS = { sch: 'theme/toolbars/eeschema-toolbars.json', pcb: 'theme/toolbars/pcbnew-toolbars.json' };

/** The editors, in table order. */
const EDITORS = ['sch', 'pcb'];

/** The strips, in table order within an editor, and the toolbar each one reads. */
const STRIPS = [['right', 'RIGHT'], ['top', 'TOP_MAIN'], ['left', 'LEFT']];

/** The only tools of the top strip the table carries: the page's topbar. */
export const TOP_ACTIONS = {
  sch: ['common.Control.save', 'common.Interactive.undo', 'common.Interactive.redo', 'common.Interactive.find', 'eeschema.EditorControl.annotate', 'eeschema.InspectionTool.runERC'],
  pcb: ['common.Control.save', 'common.Interactive.undo', 'common.Interactive.redo', 'common.Interactive.find', 'common.Control.updatePcbFromSchematic', 'pcbnew.DRCTool.runDRC'],
};

/** Fill All Zones is on no seeded board toolbar; the topbar carries it beside DRC, in DRC's section. */
export const OFF_LAYOUT = { pcb: { action: 'pcbnew.ZoneFiller.zoneFillAll', after: 'pcbnew.DRCTool.runDRC' } };

/** The chord pool, in the order chords are handed out: Ctrl+Alt+digit or letter, then Ctrl+Alt+Shift+letter. */
export const POOL = [
  ...[...'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((c) => `Ctrl+Alt+${c}`),
  ...[...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((c) => `Ctrl+Alt+Shift+${c}`),
];

/** KiCad's two Ctrl+Alt defaults (Find and Replace, Track Corner Mode 90), and their Shift twins kept clear. */
export const BANNED = ['Ctrl+Alt+F', 'Ctrl+Alt+W', 'Ctrl+Alt+Shift+F', 'Ctrl+Alt+Shift+W'];

/** A default key.press can send: KiCad's Alt+` has no code in its grammar. */
const pressable = (key) => key != null && !key.endsWith('`');

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

/**
 * The table and the hotkeys file from their inputs, all as text.
 * @returns {{ table: string, hotkeys: string, rows: object[], added: string[] }}
 */
export function generate({ defaultsJson, layouts, ledger }) {
  const defaults = JSON.parse(defaultsJson);
  const { lines, keys } = parseLedger(ledger);
  // One action keeps one chord across both editors; the ledger's chords are taken as they stand.
  const chord = new Map([...keys].filter(([, k]) => k.startsWith('Ctrl+Alt+')));
  const used = new Set(keys.values());
  const free = POOL.filter((c) => !used.has(c) && !BANNED.includes(c));
  const added = [];
  const rows = [];
  for (const editor of EDITORS) {
    for (const [strip, toolbar] of STRIPS) {
      let items = layoutStrip(layouts[editor], toolbar);
      if (strip === 'top') {
        items = items.filter(([a]) => TOP_ACTIONS[editor].includes(a));
        const got = items.map(([a]) => a).join(' ');
        if (got !== TOP_ACTIONS[editor].join(' ')) throw new Error(`${editor} TOP_MAIN holds ${got}, not the topbar's tools in order`);
        const off = OFF_LAYOUT[editor];
        if (off != null) {
          const at = items.findIndex(([a]) => a === off.after);
          items.splice(at + 1, 0, [off.action, null, items[at][2]]);
        }
      }
      for (const [action, group, section] of items) {
        if (!(action in defaults)) throw new Error(`${action} has no entry in ${DEFAULTS_PATH}`);
        const defaultKey = pressable(defaults[action]) ? defaults[action] : null;
        let seededKey = null;
        if (defaultKey == null) {
          if (!chord.has(action)) {
            const next = free.shift();
            if (next == null) throw new Error(`the chord pool ran out at ${action}`);
            chord.set(action, next);
            added.push(`${action}\t${next}\t`);
          }
          seededKey = chord.get(action);
        }
        rows.push({ editor, strip, action, group, section, defaultKey, seededKey, label: '' });
      }
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
  };
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
