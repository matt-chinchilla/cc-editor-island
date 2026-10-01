// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The pencil-tools table (theme/pencil-tools.json, the one source the site copies)
// against the seeded toolbars and hotkeys: every tool of KiCad's right-hand and
// left-hand strips, and the chosen tools of its top strip, has a key the page can
// press through key.press, either KiCad's default or a seeded Ctrl+Alt chord.
import { describe, expect, it } from 'vitest';
import tableText from './pencil-tools.json?raw';
import hotkeysText from './user.hotkeys?raw';
import pcbText from './toolbars/pcbnew-toolbars.json?raw';
import schText from './toolbars/eeschema-toolbars.json?raw';
import { KEY_CODE_RE } from '../src/keys';

type Strip = 'right' | 'top' | 'left';
interface Row { editor: 'sch' | 'pcb'; strip: Strip; action: string; group: string | null; section: number; defaultKey: string | null; seededKey: string | null; label: string }
interface Item { type: string; name?: string; group_name?: string; group_items?: Item[] }
type Place = Pick<Row, 'action' | 'group' | 'section'>;

const table = JSON.parse(tableText) as Row[];
const LAYOUT = { sch: schText, pcb: pcbText };
const TOOLBAR: Record<Strip, string> = { right: 'RIGHT', top: 'TOP_MAIN', left: 'LEFT' };

/**
 * The Ctrl+Alt defaults of every action in common/tool/actions.cpp, eeschema/tools/sch_actions.cpp,
 * pcbnew/tools/pcb_actions.cpp and pcbnew/router/router_tool.cpp at 48f1e865 (the __EMSCRIPTEN__
 * branches): Find and Replace, and the router's Track Corner Mode 90.
 */
const KICAD_CTRL_ALT_DEFAULTS = ['Ctrl+Alt+F', 'Ctrl+Alt+W'];

/** The only tools of the top strip the table carries: the page's topbar. */
const TOP_ACTIONS: Record<Row['editor'], string[]> = {
  sch: ['common.Control.save', 'common.Interactive.undo', 'common.Interactive.redo', 'common.Interactive.find', 'eeschema.EditorControl.annotate', 'eeschema.InspectionTool.runERC'],
  pcb: ['common.Control.save', 'common.Interactive.undo', 'common.Interactive.redo', 'common.Interactive.find', 'common.Control.updatePcbFromSchematic', 'pcbnew.DRCTool.runDRC'],
};

/** Fill All Zones is on no seeded board toolbar; the topbar carries it beside DRC, in DRC's section. */
const OFF_LAYOUT = { action: 'pcbnew.ZoneFiller.zoneFillAll', after: 'pcbnew.DRCTool.runDRC', defaultKey: 'B' };

/** KiCad defaults the key.press grammar cannot express (Alt+` has no code there): the table seeds a chord instead. */
const UNPRESSABLE_DEFAULTS: Record<string, string> = { 'pcbnew.EditorControl.toggleNetHighlight': 'Alt+`' };

/** One strip of a seeded layout, flattened in order, with its group and separator-delimited section. */
function layoutStrip(json: string, strip: Strip): Place[] {
  const bar = (JSON.parse(json) as { toolbars: Array<{ name: string; contents: Item[] }> }).toolbars.find((t) => t.name === TOOLBAR[strip]);
  if (bar == null) throw new Error(`no ${TOOLBAR[strip]} toolbar`);
  const out: Place[] = [];
  let section = 0;
  for (const it of bar.contents) {
    if (it.type === 'SEPARATOR') section++;
    else if (it.type === 'TOOL') out.push({ action: it.name!, group: null, section });
    else if (it.type === 'TB_GROUP') for (const g of it.group_items!) out.push({ action: g.name!, group: it.group_name!, section });
  }
  return out;
}

/** What the table should hold for one strip of one editor. */
function expected(editor: Row['editor'], strip: Strip): Place[] {
  const all = layoutStrip(LAYOUT[editor], strip);
  if (strip !== 'top') return all;
  const top = all.filter((p) => TOP_ACTIONS[editor].includes(p.action));
  expect(top.map((p) => p.action), `${editor} TOP_MAIN`).toEqual(TOP_ACTIONS[editor]);
  if (editor === 'pcb') {
    const at = top.findIndex((p) => p.action === OFF_LAYOUT.after);
    top.splice(at + 1, 0, { action: OFF_LAYOUT.action, group: null, section: top[at].section });
  }
  return top;
}

/** user.hotkeys as KiCad reads it: one `action<TAB>primary<TAB>secondary` per line. */
function hotkeys(): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of hotkeysText.split('\n').filter((l) => l !== '')) {
    const [action, primary, secondary, ...rest] = line.split('\t');
    expect(rest).toEqual([]);
    expect(secondary).toBe('');
    expect(map.has(action)).toBe(false);
    map.set(action, primary);
  }
  return map;
}

const rows = (editor: Row['editor'], strip: Strip): Place[] =>
  table.filter((r) => r.editor === editor && r.strip === strip).map(({ action, group, section }) => ({ action, group, section }));

describe('the pencil-tools table', () => {
  it('keeps the right-hand strip of task F1 as it was: 28 schematic and 33 board tools, first in each editor', () => {
    expect(rows('sch', 'right')).toHaveLength(28);
    expect(rows('pcb', 'right')).toHaveLength(33);
    expect(rows('sch', 'right')[0].action).toBe('common.Interactive.selectSetRect');
    expect(rows('sch', 'right').at(-1)!.action).toBe('common.Interactive.deleteTool');
    expect(rows('pcb', 'right')[2].action).toBe('pcbnew.EditorControl.placeFootprint');
    expect(rows('pcb', 'right').at(-1)!.action).toBe('common.Interactive.deleteTool');
  });

  it.each(['right', 'top', 'left'] as const)('lists the %s strip of both seeded layouts, in their order, groups and sections', (strip) => {
    expect(rows('sch', strip)).toEqual(expected('sch', strip));
    expect(rows('pcb', strip)).toEqual(expected('pcb', strip));
  });

  it('holds the schematic rows first, then the board\'s, each editor right, top, then left, and nothing else', () => {
    const order = table.map((r) => `${r.editor} ${r.strip}`).filter((k, i, a) => a.indexOf(k) === i);
    expect(order).toEqual(['sch right', 'sch top', 'sch left', 'pcb right', 'pcb top', 'pcb left']);
    // Each editor's rows sit together, and each strip's rows too.
    for (const key of order) {
      const at = table.map((r, i) => (`${r.editor} ${r.strip}` === key ? i : -1)).filter((i) => i >= 0);
      expect(at.at(-1)! - at[0] + 1, key).toBe(at.length);
    }
    expect(table.every((r) => r.label === '')).toBe(true);
  });

  it('gives every tool without a pressable KiCad default a seeded chord, and only those', () => {
    const keys = hotkeys();
    for (const r of table) {
      if (r.defaultKey == null) {
        expect(r.seededKey, r.action).toMatch(/^Ctrl\+Alt\+(Shift\+[A-Z]|[A-Z0-9])$/);
        expect(keys.get(r.action), r.action).toBe(r.seededKey);
      } else {
        expect(r.seededKey, r.action).toBeNull();
        expect(Object.keys(UNPRESSABLE_DEFAULTS)).not.toContain(r.action);
        // A seeded line for a tool with a default only restates it.
        if (keys.has(r.action)) expect(keys.get(r.action), r.action).toBe(r.defaultKey);
      }
    }
    for (const action of Object.keys(UNPRESSABLE_DEFAULTS)) expect(table.find((r) => r.action === action)?.seededKey, action).toBeTruthy();
    // The topbar's defaults, as KiCad ships them at the pin.
    const top = (editor: Row['editor'], action: string) => table.find((r) => r.editor === editor && r.strip === 'top' && r.action === action)!.defaultKey;
    for (const editor of ['sch', 'pcb'] as const) {
      expect([top(editor, 'common.Control.save'), top(editor, 'common.Interactive.undo'), top(editor, 'common.Interactive.redo'), top(editor, 'common.Interactive.find')]).toEqual(['Ctrl+S', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+F']);
    }
    expect(top('pcb', 'common.Control.updatePcbFromSchematic')).toBe('F8');
    expect(top('pcb', OFF_LAYOUT.action)).toBe(OFF_LAYOUT.defaultKey);
  });

  it('gives one action the same chord in both editors, and never one chord to two actions', () => {
    const chordOf = new Map<string, string>();
    for (const r of table.filter((x) => x.seededKey != null)) {
      expect(chordOf.get(r.action) ?? r.seededKey, r.action).toBe(r.seededKey);
      chordOf.set(r.action, r.seededKey!);
    }
    expect(new Set(chordOf.values()).size).toBe(chordOf.size);
  });

  it('never uses a chord twice, nor one KiCad already binds', () => {
    const keys = hotkeys();
    const chordOwner = new Map<string, string>();
    for (const [action, key] of keys) {
      if (!key.startsWith('Ctrl+Alt+')) continue;
      expect(chordOwner.get(key) ?? action, key).toBe(action);
      chordOwner.set(key, action);
    }
    expect(chordOwner.size).toBe(new Set(table.filter((r) => r.seededKey != null).map((r) => r.action)).size);
    const defaults = new Set([...table.map((r) => r.defaultKey).filter((k): k is string => k != null), ...Object.values(UNPRESSABLE_DEFAULTS), ...KICAD_CTRL_ALT_DEFAULTS]);
    for (const chord of chordOwner.keys()) {
      expect(defaults.has(chord), chord).toBe(false);
      // Nor the Shift twin of KiCad's own Ctrl+Alt chords.
      expect(KICAD_CTRL_ALT_DEFAULTS.map((k) => k.replace('Ctrl+Alt+', 'Ctrl+Alt+Shift+'))).not.toContain(chord);
    }
  });

  it('has every key expressible in the key.press grammar', () => {
    for (const r of table) {
      const key = (r.defaultKey ?? r.seededKey)!;
      const last = key.split('+').at(-1)!;
      const code = /^[0-9]$/.test(last) ? `Digit${last}` : /^[A-Z]$/.test(last) ? `Key${last}` : last;
      expect(KEY_CODE_RE.test(code), `${r.action} ${key}`).toBe(true);
    }
  });
});
