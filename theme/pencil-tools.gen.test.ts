// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The pencil-tools generator against the committed files: it rewrites theme/pencil-tools.json
// and theme/user.hotkeys byte for byte, and from the right-hand strip's chords alone it hands
// out the top and left strips' chords exactly as they were committed (existing chords never move).
import { describe, expect, it } from 'vitest';
import { generate, type GenInputs } from './pencil-tools.gen.mjs';
import tableText from './pencil-tools.json?raw';
import hotkeysText from './user.hotkeys?raw';
import defaultsJson from './pencil-tools.defaults.json?raw';
import pcbText from './toolbars/pcbnew-toolbars.json?raw';
import schText from './toolbars/eeschema-toolbars.json?raw';

const inputs = (ledger: string): GenInputs => ({ defaultsJson, layouts: { sch: schText, pcb: pcbText }, ledger });

describe('the pencil-tools generator', () => {
  it('regenerates the committed table and hotkeys byte for byte, adding nothing', () => {
    const out = generate(inputs(hotkeysText));
    expect(out.table).toBe(tableText);
    expect(out.hotkeys).toBe(hotkeysText);
    expect(out.added).toEqual([]);
  });

  it('hands out the top and left strips\' chords as committed, from the right-hand strip\'s ledger alone', () => {
    const right = new Set(generate(inputs(hotkeysText)).rows.filter((r) => r.strip === 'right').map((r) => r.action));
    const lines = hotkeysText.split('\n').filter((l) => l !== '');
    // The ledger before the top and left strips: every line that is not a chord, and the right strip's chords.
    const before = lines.filter((l) => { const [action, key] = l.split('\t'); return !key.startsWith('Ctrl+Alt+') || right.has(action); });
    expect(before.length).toBeLessThan(lines.length);
    const out = generate(inputs(before.map((l) => `${l}\n`).join('')));
    expect(out.added).toEqual(lines.slice(before.length));
    expect(out.hotkeys).toBe(hotkeysText);
    expect(out.table).toBe(tableText);
  });

  it('keeps every ledger line where it stands, even a chord the pool would hand out differently', () => {
    const swapped = hotkeysText.replace('\tCtrl+Alt+1\t', '\tCtrl+Alt+Shift+Z\t');
    const out = generate(inputs(swapped));
    expect(out.hotkeys).toBe(swapped);
    expect(out.rows.find((r) => r.action === 'common.Interactive.selectSetRect')!.seededKey).toBe('Ctrl+Alt+Shift+Z');
  });

  it('refuses a toolbar tool with no entry in the defaults', () => {
    const defaults = JSON.parse(defaultsJson) as Record<string, string | null>;
    delete defaults['common.Interactive.deleteTool'];
    expect(() => generate({ ...inputs(hotkeysText), defaultsJson: JSON.stringify(defaults) })).toThrow(/common\.Interactive\.deleteTool/);
  });
});
