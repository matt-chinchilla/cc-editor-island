// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The pencil-tools generator against the committed files: it rewrites theme/pencil-tools.json
// and theme/user.hotkeys byte for byte, the wave 2 run hands out exactly the committed chords
// from the ledger as it stood before it (existing chords never move), and the pool is per
// editor: a chord is free for an action when no action of an editor that runs it holds it.
import { describe, expect, it } from 'vitest';
import { OFF_LAYOUT, POOL, BANNED, SHADOWED_DEFAULTS, generate, poolsOf, pressable, type GenInputs } from './pencil-tools.gen.mjs';
import tableText from './pencil-tools.json?raw';
import hotkeysText from './user.hotkeys?raw';
import symeditText from './symedit.hotkeys?raw';
import defaultsJson from './pencil-tools.defaults.json?raw';
import pcbText from './toolbars/pcbnew-toolbars.json?raw';
import schText from './toolbars/eeschema-toolbars.json?raw';

const inputs = (ledger: string, unitRows: GenInputs['unitRows'] = []): GenInputs => ({ defaultsJson, layouts: { sch: schText, pcb: pcbText }, ledger, unitRows, extraHotkeys: symeditText });
const lines = (text: string): string[] => text.split('\n').filter((l) => l !== '');
const defaults = JSON.parse(defaultsJson) as Record<string, string | null>;
/** The ledger's length before the wave 2 run (the small tools spec 6.3): every line after it is that run's, then the recheck's. */
const BEFORE_WAVE2 = 60;
/** The lines the recheck on engine build T4 added after the run: the circle and arc tools' own chords (SHADOWED_DEFAULTS). */
const AFTER_RUN = 2;
/** The arc tool's chord, the second the recheck handed out. */
const ARC_CHORD = 'Ctrl+Alt+Shift+4';

/** The first chord of the pool no action of `action`'s pools holds, read from the ledger, the symbol editor's chords and KiCad's defaults. */
function firstFree(ledger: string, action: string): string | undefined {
  const taken = new Set<string>();
  const bind = (a: string, k: string | null | undefined): void => { if (k && poolsOf(a).some((p) => poolsOf(action).includes(p))) taken.add(k); };
  for (const [a, k] of Object.entries(defaults)) bind(a, k);
  for (const l of [...lines(ledger), ...lines(symeditText)]) { const [a, k, k2] = l.split('\t'); bind(a, k); bind(a, k2); }
  return POOL.find((c) => !BANNED.includes(c) && !taken.has(c));
}

describe('the pencil-tools generator', () => {
  it('regenerates the committed table and hotkeys byte for byte, adding nothing', () => {
    const out = generate(inputs(hotkeysText));
    expect(out.table).toBe(tableText);
    expect(out.hotkeys).toBe(hotkeysText);
    expect(out.added).toEqual([]);
  });

  it('hands out the wave 2 run\'s chords as committed, from the ledger as it stood before the run, then the recheck\'s', () => {
    const all = lines(hotkeysText);
    const text = (ls: string[]): string => ls.map((l) => `${l}\n`).join('');
    const run = generate({ ...inputs(text(all.slice(0, BEFORE_WAVE2))), shadowed: [] });
    expect(run.added).toEqual(all.slice(BEFORE_WAVE2, all.length - AFTER_RUN));
    const recheck = generate(inputs(run.hotkeys));
    expect(recheck.added).toEqual(all.slice(all.length - AFTER_RUN));
    expect(recheck.hotkeys).toBe(hotkeysText);
    expect(recheck.table).toBe(tableText);
  });

  it('gives an action whose KiCad default a common action takes first a chord of its own, the default kept as its second key', () => {
    expect(SHADOWED_DEFAULTS).toEqual(['pcbnew.InteractiveDrawing.circle', 'pcbnew.InteractiveDrawing.arc']);
    const out = generate(inputs(hotkeysText));
    for (const [action, chord, kicad] of [['pcbnew.InteractiveDrawing.circle', 'Ctrl+Alt+Shift+3', 'Ctrl+Shift+C'], ['pcbnew.InteractiveDrawing.arc', ARC_CHORD, 'Ctrl+Shift+A']]) {
      for (const editor of ['pcb', 'fpedit']) {
        expect(out.rows.find((r) => r.editor === editor && r.action === action), `${editor} ${action}`).toMatchObject({ defaultKey: null, seededKey: chord });
      }
      expect(lines(hotkeysText)).toContain(`${action}\t${chord}\t${kicad}`);
    }
  });

  it('keeps every ledger line where it stands, even a chord the pool would hand out differently', () => {
    const free = firstFree(hotkeysText, 'common.Interactive.selectSetRect')!;
    expect(free).toBeDefined();
    const swapped = hotkeysText.replace('\tCtrl+Alt+1\t', `\t${free}\t`);
    const out = generate(inputs(swapped));
    expect(out.hotkeys).toBe(swapped);
    expect(out.rows.find((r) => r.action === 'common.Interactive.selectSetRect')!.seededKey).toBe(free);
  });

  it('refuses a toolbar tool with no entry in the defaults', () => {
    const d = JSON.parse(defaultsJson) as Record<string, string | null>;
    delete d['common.Interactive.deleteTool'];
    expect(() => generate({ ...inputs(hotkeysText), defaultsJson: JSON.stringify(d) })).toThrow(/common\.Interactive\.deleteTool/);
  });

  it('takes an action\'s chord from the pools of the editors that run it', () => {
    expect(poolsOf('eeschema.EditorControl.showHiddenFields')).toEqual(['sch']);
    expect(poolsOf('eeschema.SymbolDrawing.placeSymbolText')).toEqual(['sch']);
    expect(poolsOf('pcbnew.PadTool.placePad')).toEqual(['pcb']);
    expect(poolsOf('plEditor.InteractiveDrawing.drawLine')).toEqual(['ds']);
    expect(poolsOf('common.Interactive.group')).toEqual(['sch', 'pcb', 'ds']);
    const rows = [
      { editor: 'sch', strip: 'left', action: 'eeschema.Test.a' },
      { editor: 'pcb', strip: 'left', action: 'pcbnew.Test.b' },
      { editor: 'ds', strip: 'right', action: 'plEditor.Test.c' },
      { editor: 'pcb', strip: 'right', action: 'common.Test.d' },
    ];
    const out = generate(inputs(hotkeysText, [{ unit: 't-i', rows }]));
    const got = Object.fromEntries(out.added.map((l) => l.split('\t')).map(([a, k]) => [a, k]));
    // Each takes the first chord its own pools leave free, in turn.
    let ledger = hotkeysText;
    for (const { action } of rows) {
      expect(got[action], action).toBe(firstFree(ledger, action));
      ledger += `${action}\t${got[action]}\t\n`;
    }
    // A schematic chord already held by board actions is free for the schematic, and the other way round.
    const holders = (chord: string): string[] => lines(hotkeysText).map((l) => l.split('\t')).filter(([, k]) => k === chord).map(([a]) => a);
    expect(holders(got['eeschema.Test.a']).some((a) => a.startsWith('pcbnew.'))).toBe(true);
    expect(holders(got['eeschema.Test.a']).some((a) => !a.startsWith('pcbnew.') && !a.startsWith('plEditor.'))).toBe(false);
  });

  it('runs out loudly when no chord is free', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ editor: 'pcb', strip: 'left', action: `common.Test.r${i}` }));
    expect(() => generate(inputs(hotkeysText, [{ unit: 't-i', rows }]))).toThrow(/the chord pool ran out at common\.Test\.r/);
  });

  it('seeds a chord for a default key.press cannot send, and keeps the default as the second key', () => {
    for (const key of ['R', '7', 'Ctrl+B', 'Ctrl+Shift+R', 'Ctrl+Alt+Shift+Z', 'Shift+F9', 'F8', 'Ctrl+Alt+F1']) expect(pressable(key), key).toBe(true);
    for (const key of [null, '{', '}', 'Alt+`', 'Shift+R', 'Meta+A', 'Ctrl+Tab', 'Ctrl+<']) expect(pressable(key), String(key)).toBe(false);
    const line = (action: string): string[] => lines(hotkeysText).map((l) => l.split('\t')).find(([a]) => a === action)!;
    expect(line('pcbnew.Control.layerAlphaDec')[2]).toBe('{');
    expect(line('pcbnew.Control.layerAlphaInc')[2]).toBe('}');
    expect(line('pcbnew.InteractiveEdit.rotateCw')[2]).toBe('Shift+R');
    expect(line('pcbnew.Control.flipBoard')[2]).toBe('');
  });

  it('puts a row after the action it names, in that action\'s section, and the others past the toolbar\'s last section', () => {
    const out = generate(inputs(hotkeysText));
    const at = (editor: string, action: string) => out.rows.findIndex((r) => r.editor === editor && r.action === action);
    const fill = out.rows[at('pcb', 'pcbnew.ZoneFiller.zoneFillAll')];
    const unfill = out.rows[at('pcb', 'pcbnew.ZoneFiller.zoneUnfillAll')];
    expect(at('pcb', 'pcbnew.ZoneFiller.zoneFillAll')).toBe(at('pcb', 'pcbnew.DRCTool.runDRC') + 1);
    expect(at('pcb', 'pcbnew.ZoneFiller.zoneUnfillAll')).toBe(at('pcb', 'pcbnew.ZoneFiller.zoneFillAll') + 1);
    expect([unfill.strip, unfill.section, unfill.defaultKey, unfill.seededKey]).toEqual(['top', fill.section, 'Ctrl+B', null]);
    for (const off of OFF_LAYOUT.filter((o) => o.after == null)) {
      const row = out.rows[at(off.editor, off.action)];
      const toolbar = out.rows.filter((r) => r.editor === off.editor && r.strip === off.strip && !OFF_LAYOUT.some((o) => o.editor === r.editor && o.action === r.action));
      expect(row.section, `${off.editor} ${off.action}`).toBe(toolbar.length === 0 ? 0 : Math.max(...toolbar.map((r) => r.section)) + 1);
      expect(row.group, off.action).toBe(off.group ?? null);
      if (off.press === 'run') expect([row.seededKey, row.press], off.action).toEqual(['', 'run']);
    }
  });
});
