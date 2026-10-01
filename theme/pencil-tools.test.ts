// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The pencil-tools table (theme/pencil-tools.json, the one source the site copies)
// against the seeded toolbars and hotkeys: every tool of KiCad's right-hand
// strip has a key the page can press through key.press, either KiCad's default
// or a seeded Ctrl+Alt chord.
import { describe, expect, it } from 'vitest';
import tableText from './pencil-tools.json?raw';
import hotkeysText from './user.hotkeys?raw';
import pcbText from './toolbars/pcbnew-toolbars.json?raw';
import schText from './toolbars/eeschema-toolbars.json?raw';
import { KEY_CODE_RE } from '../src/keys';

interface Row { editor: 'sch' | 'pcb'; action: string; group: string | null; section: number; defaultKey: string | null; seededKey: string | null; label: string }
interface Item { type: string; name?: string; group_name?: string; group_items?: Item[] }

const table = JSON.parse(tableText) as Row[];

/** The Ctrl+Alt defaults of every action in common/tool/actions.cpp, eeschema/tools/sch_actions.cpp and pcbnew/tools/pcb_actions.cpp at 48f1e865 (the __EMSCRIPTEN__ branches). */
const KICAD_CTRL_ALT_DEFAULTS = ['Ctrl+Alt+F'];

/** The RIGHT strip of a seeded layout, flattened in order, with its group and separator-delimited section. */
function rightStrip(json: string): Array<Pick<Row, 'action' | 'group' | 'section'>> {
  const right = (JSON.parse(json) as { toolbars: Array<{ name: string; contents: Item[] }> }).toolbars.find((t) => t.name === 'RIGHT');
  if (right == null) throw new Error('no RIGHT toolbar');
  const out: Array<Pick<Row, 'action' | 'group' | 'section'>> = [];
  let section = 0;
  for (const it of right.contents) {
    if (it.type === 'SEPARATOR') section++;
    else if (it.type === 'TOOL') out.push({ action: it.name!, group: null, section });
    else for (const g of it.group_items!) out.push({ action: g.name!, group: it.group_name!, section });
  }
  return out;
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

describe('the pencil-tools table', () => {
  it('lists the right-hand strip of both seeded layouts, in their order, groups and sections', () => {
    const strip = (editor: Row['editor']) => table.filter((r) => r.editor === editor).map(({ action, group, section }) => ({ action, group, section }));
    expect(strip('sch')).toEqual(rightStrip(schText));
    expect(strip('pcb')).toEqual(rightStrip(pcbText));
    // The schematic rows first, then the board's.
    expect(table.findIndex((r) => r.editor === 'pcb')).toBe(table.filter((r) => r.editor === 'sch').length);
    expect(table.every((r) => r.label === '')).toBe(true);
  });

  it('gives every tool without a KiCad default a seeded chord, and only those', () => {
    const keys = hotkeys();
    for (const r of table) {
      if (r.defaultKey == null) {
        expect(r.seededKey, r.action).toMatch(/^Ctrl\+Alt\+[A-Z0-9]$/);
        expect(keys.get(r.action), r.action).toBe(r.seededKey);
      } else {
        expect(r.seededKey, r.action).toBeNull();
        // A seeded line for a tool with a default only restates it.
        if (keys.has(r.action)) expect(keys.get(r.action), r.action).toBe(r.defaultKey);
      }
    }
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
    const defaults = new Set([...table.map((r) => r.defaultKey).filter((k): k is string => k != null), ...KICAD_CTRL_ALT_DEFAULTS]);
    for (const chord of chordOwner.keys()) expect(defaults.has(chord), chord).toBe(false);
  });

  it('has every key expressible in the key.press grammar', () => {
    for (const r of table) {
      const key = (r.defaultKey ?? r.seededKey)!;
      const last = key.split('+').at(-1)!;
      const code = /^[0-9]$/.test(last) ? `Digit${last}` : `Key${last}`;
      expect(KEY_CODE_RE.test(code), `${r.action} ${key}`).toBe(true);
    }
  });
});
