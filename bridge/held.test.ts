// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { describe, expect, it, vi } from 'vitest';
import { HELD_ACTIONS, heldTaken, installHeld, readHeldRequest, type HeldWindow } from './held';

const ALL_CAPS = ['boardUpdate', 'drc', 'check', 'annotate', 'heldKeys'];
const req = (action: string) => JSON.stringify({ action });

describe('the held actions', () => {
  it('names the nine actions, each with its frames and the cap it waits on', () => {
    expect(HELD_ACTIONS).toEqual([
      { action: 'common.Control.updatePcbFromSchematic', frames: ['sch', 'pcb'], cap: 'boardUpdate' },
      { action: 'pcbnew.DRCTool.runDRC', frames: ['pcb'], cap: 'drc' },
      { action: 'eeschema.InspectionTool.runERC', frames: ['sch'], cap: 'check' },
      { action: 'eeschema.EditorControl.annotate', frames: ['sch'], cap: 'annotate' },
      { action: 'common.Control.show3DViewer', frames: ['pcb'], cap: 'heldKeys' },
      { action: 'eeschema.EditorTool.showHierarchy', frames: ['sch'], cap: 'heldKeys' },
      { action: 'pcbnew.Control.showLayersManager', frames: ['pcb'], cap: 'heldKeys' },
      { action: 'common.Control.showProperties', frames: ['sch', 'pcb'], cap: 'heldKeys' },
      { action: 'common.Control.showDatasheet', frames: ['sch'], cap: 'heldKeys' },
    ]);
  });

  it('takes an action only in its frames and only while the island lists its cap', () => {
    for (const h of HELD_ACTIONS) {
      for (const frame of ['sch', 'pcb'] as const) {
        expect(heldTaken(h.action, frame, ALL_CAPS), `${h.action} ${frame}`).toBe(h.frames.includes(frame));
        expect(heldTaken(h.action, frame, ALL_CAPS.filter((c) => c !== h.cap)), `${h.action} ${frame} without ${h.cap}`).toBe(false);
      }
    }
    expect(heldTaken('pcbnew.InteractiveEdit.FindMove', 'pcb', ALL_CAPS)).toBe(false);
    expect(heldTaken('common.Control.find', 'sch', ALL_CAPS)).toBe(false);
  });

  it('reads the engine\'s request closed: a JSON string with exactly one action name', () => {
    expect(readHeldRequest(req('pcbnew.DRCTool.runDRC'))).toBe('pcbnew.DRCTool.runDRC');
    for (const bad of [undefined, 3, { action: 'x' }, '', '{', '[]', '{"action":1}', '{"action":"a.b","x":1}', req(''), req('a b'), req('a'.repeat(200)), 'x'.repeat(10_000)]) {
      expect(readHeldRequest(bad)).toBeNull();
    }
  });
});

describe('installHeld', () => {
  function setup(o: { frame?: 'sch' | 'pcb'; caps?: string[]; admit?: boolean; repeating?: boolean; send?: (a: string) => void } = {}) {
    const w: HeldWindow = {};
    const sent: string[] = [];
    const gate = { admit: o.admit ?? true, repeating: o.repeating ?? false };
    installHeld(w, { frame: o.frame ?? 'pcb', caps: o.caps ?? ALL_CAPS, admit: () => gate.admit, repeating: () => gate.repeating, send: o.send ?? ((a) => sent.push(a)) });
    return { ask: (json: unknown) => w.kicadHostAction!.onRequest!(json), sent, gate };
  }

  it('answers true and sends the action once for a held key the gate admits', () => {
    const s = setup();
    expect(s.ask(req('pcbnew.DRCTool.runDRC'))).toBe(true);
    expect(s.ask(req('common.Control.show3DViewer'))).toBe(true);
    expect(s.sent).toEqual(['pcbnew.DRCTool.runDRC', 'common.Control.show3DViewer']);
  });

  it('takes a held key\'s auto repeats with no event: KiCad never opens the window, and the host hears one press', () => {
    const s = setup();
    expect(s.ask(req('common.Control.updatePcbFromSchematic'))).toBe(true);
    s.gate.repeating = true;
    expect(s.ask(req('common.Control.updatePcbFromSchematic'))).toBe(true);
    expect(s.ask(req('common.Control.updatePcbFromSchematic'))).toBe(true);
    expect(s.sent).toEqual(['common.Control.updatePcbFromSchematic']);
  });

  it('answers false, sending nothing, for any other action, another frame\'s action, a cap not listed, a closed gate or a throw', () => {
    expect(setup().ask(req('pcbnew.InteractiveEdit.FindMove'))).toBe(false);
    expect(setup({ frame: 'pcb' }).ask(req('eeschema.InspectionTool.runERC'))).toBe(false);
    expect(setup({ caps: ['heldKeys'] }).ask(req('pcbnew.DRCTool.runDRC'))).toBe(false);
    const shut = setup({ admit: false });
    expect(shut.ask(req('pcbnew.DRCTool.runDRC'))).toBe(false);
    expect(shut.sent).toEqual([]);
    expect(setup().ask('{')).toBe(false);
    const thrower = setup({ send: vi.fn(() => { throw new Error('port gone'); }) });
    expect(thrower.ask(req('pcbnew.DRCTool.runDRC'))).toBe(false);
  });
});
