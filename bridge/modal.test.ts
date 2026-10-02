// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { describe, expect, it } from 'vitest';
import { openFileInTool } from '../loader/src/wasm/open-flow';
import { dialogUp, isProgressDialog, keysBlocked, menuOpen, plainLabel, visibleDialogs } from './modal';

type El = { id: string; parentId?: string; typeName: string; label?: string; visible?: boolean };

/** A registry over `els`, as wx.js answers findAll: visible:false lists every element. */
function win(els: El[]) {
  const rows = els.map((e) => ({ name: '', label: '', visible: true, ...e }));
  return {
    wxElementRegistry: {
      findAll: (f: { visible?: boolean } = {}) => rows.filter((e) => f.visible === false || e.visible),
      findByLabel: () => [],
    },
    document: { querySelector: () => null },
  } as unknown as ToolWindow;
}

/** KiCad's import progress reporter as the registry shows it (spike 2026-10-02): a plain wxDialog. */
const loadPcb: El[] = [
  { id: 'p', parentId: 'frame', typeName: 'wxDialog' },
  { id: 'p1', parentId: 'p', typeName: 'wxStaticText', label: ' ' },
  { id: 'p2', parentId: 'p', typeName: 'wxGauge' },
  { id: 'p3', parentId: 'p', typeName: 'wxStaticText', label: 'Elapsed time:' },
  { id: 'p4', parentId: 'p', typeName: 'wxButton', label: '&Cancel' },
];
/** The layer-mapping dialog over it: its lists sit inside static boxes, two links down. */
const layerMap: El[] = [
  { id: 'm', parentId: 'frame', typeName: 'wxDialog' },
  { id: 'm1', parentId: 'm', typeName: 'wxStaticBox', label: 'Unmatched Layers' },
  { id: 'm2', parentId: 'm1', typeName: 'wxListCtrl' },
  { id: 'm3', parentId: 'm', typeName: 'wxButton', label: 'Auto-Match Layers' },
  { id: 'm4', parentId: 'm', typeName: 'wxButton', label: '&OK' },
];
const frame: El = { id: 'frame', typeName: 'wxFrame' };

describe('dialogs and progress dialogs', () => {
  it('reads a label as wx shows it', () => {
    expect(plainLabel('&OK')).toBe('OK');
    expect(plainLabel('Save && Close')).toBe('Save & Close');
    expect(plainLabel('Auto-Match Layers')).toBe('Auto-Match Layers');
  });

  it('gives each visible dialog its visible descendants through the parent chain', () => {
    const views = visibleDialogs(win([frame, ...loadPcb, ...layerMap, { id: 'h', parentId: 'm', typeName: 'wxButton', label: 'Hidden', visible: false }]));
    expect(views.map((v) => v.dialog.id)).toEqual(['p', 'm']);
    expect(views[0].parts.map((e) => e.id)).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(views[1].parts.map((e) => e.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
  });

  it('a plain wxDialog with a gauge and only Cancel is a progress dialog: it holds no key back, and ev.menu still counts it', () => {
    const w = win([frame, ...loadPcb]);
    expect(isProgressDialog(visibleDialogs(w)[0])).toBe(true);
    expect(dialogUp(w, false)).toBe(false);
    expect(keysBlocked(w)).toBe(false);
    expect(dialogUp(w, true)).toBe(true);
    expect(menuOpen(w)).toBe(true);
  });

  it('a gauge beside any other button, a dialog over the progress dialog, or a dialog the registry gives no parts are input dialogs', () => {
    const withOk = win([frame, ...loadPcb, { id: 'p5', parentId: 'p', typeName: 'wxButton', label: '&OK' }]);
    expect(isProgressDialog(visibleDialogs(withOk)[0])).toBe(false);
    expect(keysBlocked(withOk)).toBe(true);
    expect(keysBlocked(win([frame, ...loadPcb, ...layerMap]))).toBe(true);
    // No parent links (an older wx.js): only the type can say progress, so it fails closed.
    expect(keysBlocked(win([frame, { id: 'd', typeName: 'wxDialog' }]))).toBe(true);
    expect(keysBlocked(win([frame, { id: 'g', typeName: 'wxGenericProgressDialog' }]))).toBe(false);
  });

  it('a registry that throws counts as no dialog', () => {
    const w = { wxElementRegistry: { findAll: () => { throw new Error('gone'); } } } as unknown as ToolWindow;
    expect(visibleDialogs(w)).toEqual([]);
    expect(dialogUp(w, false)).toBe(false);
    expect(dialogUp(w, true)).toBe(false);
  });
});

describe('the loader\'s open flow under the import\'s progress dialog', () => {
  /** A booted engine whose load stays busy for `busyMs` with `dialog` up all along. */
  function loading(dialog: El[], busyMs: number) {
    const start = Date.now();
    const w = win([frame, ...dialog]) as unknown as ToolWindow & { Module: unknown };
    (w as unknown as { Module: unknown }).Module = {
      kicadOpenFile: () => new Promise(() => undefined),
      kicadOpenFileBusy: () => Date.now() - start < busyMs,
    };
    return w;
  }

  it('keeps waiting while only the progress dialog is up, and goes on once the load settles', async () => {
    const t0 = Date.now();
    expect(await openFileInTool(loading(loadPcb, 450), '/x/board.brd', { log: () => undefined })).toBe('programmatic');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
  });

  it('goes on at once when a dialog waiting for input is up, so the dialog stays answerable', async () => {
    const t0 = Date.now();
    expect(await openFileInTool(loading([...loadPcb, ...layerMap], 5_000), '/x/board.brd', { log: () => undefined })).toBe('programmatic');
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});
