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
import symeditText from './symedit.hotkeys?raw';
import defaultsJson from './pencil-tools.defaults.json?raw';
import { OFF_LAYOUT, poolsOf } from './pencil-tools.gen.mjs';
import { KEY_CODE_RE } from '../src/keys';
import { SYMEDIT_HELD } from '../bridge/held';
import { heldActions } from '../bridge/ext/registry';

type Strip = 'right' | 'top' | 'left';
type Editor = 'sch' | 'pcb' | 'fpedit' | 'ds';
interface Row { editor: Editor; strip: Strip; action: string; group: string | null; section: number; defaultKey: string | null; seededKey: string | null; label: string; press?: 'run' }
interface Item { type: string; name?: string; group_name?: string; group_items?: Item[] }
type Place = Pick<Row, 'action' | 'group' | 'section'>;

const table = JSON.parse(tableText) as Row[];
const DEFAULTS = JSON.parse(defaultsJson) as Record<string, string | null>;
/** The rows on no seeded toolbar: Fill All Zones, then the wave 2 run's (the small tools spec 6.3). */
const offRows = (editor: Editor, strip: Strip): Place[] =>
  OFF_LAYOUT.filter((o) => o.editor === editor && o.strip === strip && o.after == null).map((o) => ({ action: o.action, group: o.group ?? null, section: -1 }));
/** The pool a table's frame takes its chords from: the footprint editor runs the board's actions. */
const POOL_OF: Record<Editor, 'sch' | 'pcb' | 'ds'> = { sch: 'sch', pcb: 'pcb', fpedit: 'pcb', ds: 'ds' };
const LAYOUT = { sch: schText, pcb: pcbText };
const TOOLBAR: Record<Strip, string> = { right: 'RIGHT', top: 'TOP_MAIN', left: 'LEFT' };

/**
 * The Ctrl+Alt defaults of every action in common/tool/actions.cpp, eeschema/tools/sch_actions.cpp,
 * pcbnew/tools/pcb_actions.cpp and pcbnew/router/router_tool.cpp at 48f1e865 (the __EMSCRIPTEN__
 * branches): Find and Replace, and the router's Track Corner Mode 90.
 */
const KICAD_CTRL_ALT_DEFAULTS = ['Ctrl+Alt+F', 'Ctrl+Alt+W'];

/** The only tools of the top strip the table carries: the page's topbar. */
const TOP_ACTIONS: Record<'sch' | 'pcb', string[]> = {
  sch: ['common.Control.save', 'common.Interactive.undo', 'common.Interactive.redo', 'common.Interactive.find', 'eeschema.EditorControl.annotate', 'eeschema.InspectionTool.runERC'],
  pcb: ['common.Control.save', 'common.Interactive.undo', 'common.Interactive.redo', 'common.Interactive.find', 'common.Control.updatePcbFromSchematic', 'pcbnew.DRCTool.runDRC'],
};

/** Fill All Zones is on no seeded board toolbar; the topbar carries it beside DRC, in DRC's section, and Unfill All Zones beside it (wave 2). */
const FILL = { action: 'pcbnew.ZoneFiller.zoneFillAll', after: 'pcbnew.DRCTool.runDRC', defaultKey: 'B' };
const UNFILL = { action: 'pcbnew.ZoneFiller.zoneUnfillAll', after: FILL.action, defaultKey: 'Ctrl+B' };

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

/** What the table should hold for one strip of a seeded layout, before the rows on no toolbar that follow it. */
function expected(editor: 'sch' | 'pcb', strip: Strip): Place[] {
  const all = layoutStrip(LAYOUT[editor], strip);
  if (strip !== 'top') return all;
  const top = all.filter((p) => TOP_ACTIONS[editor].includes(p.action));
  expect(top.map((p) => p.action), `${editor} TOP_MAIN`).toEqual(TOP_ACTIONS[editor]);
  if (editor === 'pcb') {
    const at = top.findIndex((p) => p.action === FILL.after);
    top.splice(at + 1, 0, { action: FILL.action, group: null, section: top[at].section }, { action: UNFILL.action, group: null, section: top[at].section });
  }
  return top;
}

/**
 * user.hotkeys as KiCad reads it: one `action<TAB>primary<TAB>secondary` per line. A
 * line's second key is empty, or (a wave 2 line) the action's own KiCad default kept
 * beside a chord seeded because key.press cannot send that default.
 */
function hotkeys(): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of hotkeysText.split('\n').filter((l) => l !== '')) {
    const [action, primary, secondary, ...rest] = line.split('\t');
    expect(rest).toEqual([]);
    expect(['', DEFAULTS[action]], action).toContain(secondary);
    expect(map.has(action)).toBe(false);
    map.set(action, primary);
  }
  return map;
}

/** Every key each action is bound to as the engine is seeded: a seeded line's keys (the ledger, then the symbol editor's), else KiCad's default. */
function bindings(): Map<string, Array<{ key: string; seeded: boolean }>> {
  const map = new Map<string, Array<{ key: string; seeded: boolean }>>();
  for (const [action, key] of Object.entries(DEFAULTS)) if (key != null) map.set(action, [{ key, seeded: false }]);
  for (const line of [...hotkeysText.split('\n'), ...symeditText.split('\n')].filter((l) => l !== '')) {
    const [action, primary, secondary] = line.split('\t');
    map.set(action, [{ key: primary, seeded: true }, ...(secondary ? [{ key: secondary, seeded: DEFAULTS[action] !== secondary }] : [])]);
  }
  return map;
}

/** The actions of one frame's pool bound to `key`, beside `action`. */
function others(frame: Editor, key: string, action: string): Array<{ action: string; seeded: boolean }> {
  const out: Array<{ action: string; seeded: boolean }> = [];
  for (const [a, keys] of bindings()) {
    if (a === action || !poolsOf(a).includes(POOL_OF[frame])) continue;
    for (const k of keys) if (k.key === key) out.push({ action: a, seeded: k.seeded });
  }
  return out;
}

/** The chord a row is pressed with: KiCad's default, or the seeded chord; none for a row pressed by name. */
const keyOf = (r: Row): string | null => (r.press === 'run' ? null : (r.defaultKey ?? r.seededKey));

const rows = (editor: Editor, strip: Strip): Place[] =>
  table.filter((r) => r.editor === editor && r.strip === strip).map(({ action, group, section }) => ({ action, group, section }));

describe('the pencil-tools table', () => {
  it('keeps the right-hand strip of task F1 as it was: 28 schematic and 33 board tools, first in each editor', () => {
    expect(rows('sch', 'right').slice(0, 28)).toEqual(expected('sch', 'right'));
    expect(rows('pcb', 'right').slice(0, 33)).toEqual(expected('pcb', 'right'));
    expect(rows('sch', 'right')[0].action).toBe('common.Interactive.selectSetRect');
    expect(rows('sch', 'right')[27].action).toBe('common.Interactive.deleteTool');
    expect(rows('pcb', 'right')[2].action).toBe('pcbnew.EditorControl.placeFootprint');
    expect(rows('pcb', 'right')[32].action).toBe('common.Interactive.deleteTool');
  });

  it.each(['right', 'top', 'left'] as const)('lists the %s strip of both seeded layouts, in their order, groups and sections, then the rows on no toolbar', (strip) => {
    for (const editor of ['sch', 'pcb'] as const) {
      const own = expected(editor, strip);
      const got = rows(editor, strip);
      expect(got.slice(0, own.length), `${editor} ${strip}`).toEqual(own);
      // The rows on no toolbar follow, in OFF_LAYOUT's order, in a section of their own past the toolbar's last.
      const past = own.length === 0 ? 0 : Math.max(...own.map((p) => p.section)) + 1;
      expect(got.slice(own.length), `${editor} ${strip}`).toEqual(offRows(editor, strip).map((p) => ({ ...p, section: past })));
    }
  });

  it('holds the footprint editor\'s and the drawing sheet editor\'s rows, OFF_LAYOUT\'s alone, in section 0', () => {
    for (const editor of ['fpedit', 'ds'] as const) {
      for (const strip of ['right', 'top', 'left'] as const) expect(rows(editor, strip), `${editor} ${strip}`).toEqual(offRows(editor, strip).map((p) => ({ ...p, section: 0 })));
    }
  });

  it('carries the wave 2 run\'s 88 rows: 13 schematic, 29 board, 38 footprint editor and 8 drawing sheet editor', () => {
    const wave = OFF_LAYOUT.slice(1);
    expect(OFF_LAYOUT[0]).toEqual({ editor: 'pcb', strip: 'top', action: FILL.action, after: FILL.after });
    expect(wave).toHaveLength(88);
    const count = (editor: Editor) => wave.filter((o) => o.editor === editor).length;
    expect([count('sch'), count('pcb'), count('fpedit'), count('ds')]).toEqual([13, 29, 38, 8]);
    for (const o of wave) expect(table.filter((r) => r.editor === o.editor && r.action === o.action), `${o.editor} ${o.action}`).toHaveLength(1);
    expect(table.find((r) => r.editor === 'pcb' && r.action === UNFILL.action)?.defaultKey).toBe(UNFILL.defaultKey);
    expect(table.find((r) => r.editor === 'pcb' && r.action === 'common.Control.highContrastModeCycle')?.defaultKey).toBe('H');
  });

  it('holds the schematic rows first, then the board\'s, the footprint editor\'s and the drawing sheet editor\'s, each editor right, top, then left, and nothing else', () => {
    const order = table.map((r) => `${r.editor} ${r.strip}`).filter((k, i, a) => a.indexOf(k) === i);
    expect(order).toEqual(['sch right', 'sch top', 'sch left', 'pcb right', 'pcb top', 'pcb left', 'fpedit right', 'fpedit left', 'ds right', 'ds top']);
    // Each editor's rows sit together, and each strip's rows too.
    for (const key of order) {
      const at = table.map((r, i) => (`${r.editor} ${r.strip}` === key ? i : -1)).filter((i) => i >= 0);
      expect(at.at(-1)! - at[0] + 1, key).toBe(at.length);
    }
    expect(table.every((r) => r.label === '')).toBe(true);
    expect(new Set(table.map((r) => `${r.editor} ${r.action}`)).size).toBe(table.length);
  });

  it('gives every tool without a pressable KiCad default a seeded chord, and only those; a row pressed by name has none', () => {
    const keys = hotkeys();
    for (const r of table) {
      if (r.press === 'run') {
        expect(r.seededKey, r.action).toBe('');
        continue;
      }
      expect(r.press, r.action).toBeUndefined();
      if (r.defaultKey == null) {
        expect(r.seededKey, r.action).toMatch(/^Ctrl\+Alt\+(Shift\+)?([A-Z0-9]|F([1-9]|1[0-2]))$/);
        expect(keys.get(r.action), r.action).toBe(r.seededKey);
      } else {
        expect(r.seededKey, r.action).toBeNull();
        expect(Object.keys(UNPRESSABLE_DEFAULTS)).not.toContain(r.action);
        // A seeded line for a tool with a default only restates it.
        if (keys.has(r.action)) expect(keys.get(r.action), r.action).toBe(r.defaultKey);
      }
    }
    for (const action of Object.keys(UNPRESSABLE_DEFAULTS)) expect(table.find((r) => r.action === action)?.seededKey, action).toBeTruthy();
    // KiCad's defaults key.press cannot send take a chord: the opacity keys, a Shift and a letter.
    for (const [action, kicad] of [['pcbnew.Control.layerAlphaDec', '{'], ['pcbnew.Control.layerAlphaInc', '}'], ['pcbnew.InteractiveEdit.rotateCw', 'Shift+R']]) {
      expect(DEFAULTS[action], action).toBe(kicad);
      expect(table.filter((r) => r.action === action && r.press !== 'run').every((r) => r.defaultKey == null && r.seededKey != null), action).toBe(true);
    }
    // The topbar's defaults, as KiCad ships them at the pin.
    const top = (editor: Editor, action: string) => table.find((r) => r.editor === editor && r.strip === 'top' && r.action === action)!.defaultKey;
    for (const editor of ['sch', 'pcb'] as const) {
      expect([top(editor, 'common.Control.save'), top(editor, 'common.Interactive.undo'), top(editor, 'common.Interactive.redo'), top(editor, 'common.Interactive.find')]).toEqual(['Ctrl+S', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+F']);
    }
    expect([top('ds', 'common.Interactive.undo'), top('ds', 'common.Interactive.redo')]).toEqual(['Ctrl+Z', 'Ctrl+Y']);
    expect(top('pcb', 'common.Control.updatePcbFromSchematic')).toBe('F8');
    expect(top('pcb', FILL.action)).toBe(FILL.defaultKey);
  });

  it('gives one action the same chord in every editor, and never one chord to two actions an editor runs', () => {
    const chordOf = new Map<string, string>();
    for (const r of table.filter((x) => x.seededKey != null && x.seededKey !== '')) {
      expect(chordOf.get(r.action) ?? r.seededKey, r.action).toBe(r.seededKey);
      chordOf.set(r.action, r.seededKey!);
    }
    for (const pool of ['sch', 'pcb', 'ds'] as const) {
      const owner = new Map<string, string>();
      for (const [action, chord] of chordOf) {
        if (!poolsOf(action).includes(pool)) continue;
        expect(owner.get(chord) ?? action, `${pool} ${chord}`).toBe(action);
        owner.set(chord, action);
      }
    }
  });

  it('never uses a chord twice in one pool, nor one KiCad already binds there', () => {
    const keys = hotkeys();
    const seeded = [...keys].filter(([, key]) => key.startsWith('Ctrl+Alt+'));
    expect(seeded.length).toBe(new Set(table.filter((r) => r.seededKey).map((r) => r.action)).size);
    for (const pool of ['sch', 'pcb', 'ds'] as const) {
      const chordOwner = new Map<string, string>();
      const mine = [...seeded, ...symeditText.split('\n').filter((l) => l !== '').map((l) => l.split('\t') as [string, string])].filter(([a]) => poolsOf(a).includes(pool));
      for (const [action, key] of mine) {
        expect(chordOwner.get(key) ?? action, `${pool} ${key}`).toBe(action);
        chordOwner.set(key, action);
      }
      const defaults = new Set([...Object.entries(DEFAULTS).filter(([a, k]) => k != null && poolsOf(a).includes(pool)).map(([, k]) => k!), ...KICAD_CTRL_ALT_DEFAULTS]);
      for (const chord of chordOwner.keys()) {
        expect(defaults.has(chord), `${pool} ${chord}`).toBe(false);
        // Nor the Shift twin of KiCad's own Ctrl+Alt chords.
        expect(KICAD_CTRL_ALT_DEFAULTS.map((k) => k.replace('Ctrl+Alt+', 'Ctrl+Alt+Shift+'))).not.toContain(chord);
      }
    }
  });

  it('presses no chord that is two actions\' in one frame, but where KiCad\'s own defaults share it', () => {
    let shared = 0;
    for (const r of table) {
      const key = keyOf(r);
      if (key == null) continue;
      const rest = others(r.editor, key, r.action);
      // A chord we seed is one action's in every frame that presses it.
      if (r.seededKey != null) expect(rest, `${r.editor} ${r.action} ${key}`).toEqual([]);
      // A default shared with another action's default is KiCad's own binding, as it ships.
      else expect(rest.filter((o) => o.seeded), `${r.editor} ${r.action} ${key}`).toEqual([]);
      if (rest.length > 0) shared++;
    }
    // The rows whose KiCad default KiCad itself gives a second action too: Ctrl+L, H, P and Ctrl+S in the
    // schematic, Ctrl+E twice in the footprint editor. The circle and arc tools' Ctrl+Shift+C and Ctrl+Shift+A are
    // no longer pressed: KiCad's common copy as text and unselect all take them first (SHADOWED_DEFAULTS).
    expect(shared).toBe(6);
  });

  it('presses no chord that a held action of the same frame is bound to', () => {
    const held = [...heldActions(), ...SYMEDIT_HELD.map((action) => ({ action, frames: ['symedit'], cap: 'symedit' }))];
    const keys = bindings();
    for (const r of table) {
      const key = keyOf(r);
      if (key == null) continue;
      for (const h of held.filter((x) => x.action !== r.action && (x.frames as readonly string[]).includes(r.editor))) {
        expect((keys.get(h.action) ?? []).map((k) => k.key), `${r.editor} ${r.action} ${key} against ${h.action}`).not.toContain(key);
      }
    }
  });

  it('has every key expressible in the key.press grammar', () => {
    for (const r of table) {
      const key = keyOf(r);
      if (key == null) continue;
      const last = key.split('+').at(-1)!;
      const code = /^[0-9]$/.test(last) ? `Digit${last}` : /^[A-Z]$/.test(last) ? `Key${last}` : last;
      expect(KEY_CODE_RE.test(code), `${r.action} ${key}`).toBe(true);
    }
  });
});
