// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// fp-i6: the footprint editor's held actions in an fpedit frame under fpedit,
// and the board's three footprint doors in a pcb frame under footprintEdit,
// each in the held union once, taken only in its frame under its cap, and in
// an fpedit frame sent as ev.held only after ev.ready with a footprint open.
// The engine here is this test's own module of exports, at the protocol
// boundary; the real engine is the e2e's (tests/e2e/fpedit-held.spec.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startResponder } from '../responder';
import { HELD_ACTIONS, heldTaken } from '../held';
import type { ExtUnit } from './contract';
import { buildRegistry, heldActions, REGISTRY } from './registry';
import { FPEDIT_EXPORTS } from '../fpedit/common';
import fpI1 from './fp-i1';
import fpI4, { FOOTPRINT_EDIT_CAP } from './fp-i4';
import unit, { BOARD_FOOTPRINT_DOORS, FP_I6_ROWS, FPEDIT_HELD_ACTIONS } from './fp-i6';
import PENCIL from '../../theme/pencil-tools.json';

const PARENT = 'http://localhost';
const SOIC = '(footprint "SOIC-8_3.9x4.9mm_P1.27mm")';
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const mods = (...units: ExtUnit[]): Record<string, unknown> => Object.fromEntries(units.map((u) => [`./${u.unit}.ts`, { default: u }]));

/** The unit record's held entries, letter for letter (wave 2 manifest, fp-i6). */
const RECORD: Array<[string, 'fpedit' | 'pcb', string]> = [
  ...['common.Control.save', 'common.Control.saveAs', 'common.Control.revert', 'common.Control.print', 'common.Control.quit',
    'common.Interactive.find', 'common.Control.showDatasheet', 'common.Control.showProperties', 'common.Control.showLibraryTree',
    'common.Control.show3DViewer', 'common.Control.showFootprintBrowser', 'common.Control.newLibrary', 'common.Control.addLibrary',
    'pcbnew.ModuleEditor.newFootprint', 'pcbnew.ModuleEditor.createFootprint', 'pcbnew.ModuleEditor.editFootprint',
    'pcbnew.ModuleEditor.duplicateFootprint', 'pcbnew.ModuleEditor.renameFootprint', 'pcbnew.ModuleEditor.deleteFootprint',
    'pcbnew.ModuleEditor.cutFootprint', 'pcbnew.ModuleEditor.copyFootprint', 'pcbnew.ModuleEditor.pasteFootprint',
    'pcbnew.ModuleEditor.importFootprint', 'pcbnew.ModuleEditor.exportFootprint', 'pcbnew.ModuleEditor.footprintProperties',
    'pcbnew.ModuleEditor.padTable', 'pcbnew.ModuleEditor.checkFootprint', 'pcbnew.ModuleEditor.loadFootprintFromBoard',
    'pcbnew.ModuleEditor.saveFootprintToBoard', 'pcbnew.ModuleEditor.repairFootprint', 'pcbnew.EditorControl.EditLibFpInFpEditor',
    'pcbnew.Control.previousFootprint', 'pcbnew.Control.nextFootprint', 'pcbnew.PadTool.defaultPadProperties',
    'pcbnew.PadTool.enumeratePads', 'pcbnew.PadTool.PushPadSettings', 'pcbnew.GlobalEdit.cleanupGraphics',
    'pcbnew.GlobalEdit.editTextAndGraphics', 'pcbnew.InteractiveDrawing.placeImportedGraphics',
    'pcbnew.InteractiveDrawing.placeReferenceImage', 'pcbnew.FpWizard.showWizards',
  ].map((a): [string, 'fpedit', string] => [a, 'fpedit', 'fpedit']),
  ['pcbnew.EditorControl.EditFpInFpEditor', 'pcb', 'footprintEdit'],
  ['pcbnew.EditorControl.EditLibFpInFpEditor', 'pcb', 'footprintEdit'],
  ['common.Control.showFootprintEditor', 'pcb', 'footprintEdit'],
];
/** The two held actions whose pencil press opens a door of the host's (the manifest's note: fp-s6 Add a picture, fp-s13 Import a drawing). */
const PENCIL_DOORS = ['pcbnew.InteractiveDrawing.placeImportedGraphics', 'pcbnew.InteractiveDrawing.placeReferenceImage'];

beforeEach(() => {
  vi.stubGlobal('KeyboardEvent', class extends Event {
    constructor(type: string, init: Record<string, unknown> = {}) {
      const { bubbles, cancelable, composed, ...rest } = init as EventInit & Record<string, unknown>;
      super(type, { bubbles, cancelable, composed });
      Object.assign(this, rest);
    }
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

/** The fake engine's fpedit exports over one footprint, with the held keys' marker. */
function fakeFp() {
  const st = { token: '', open: false, name: '', lib: '', mode: 'library', modified: false, depth: 0, padCount: 0, type: 'unspecified', padEditMode: false };
  const exports: Record<string, unknown> = {
    ...Object.fromEntries(FPEDIT_EXPORTS.map((n) => [n, () => false])),
    kicadHostActions: () => true,
    kicadFpEditOpen: (j: string) => {
      const a = JSON.parse(j) as { name: string; lib: string; mode: string; token: string };
      Object.assign(st, { token: a.token, open: true, name: a.name, lib: a.lib, mode: a.mode, modified: false, depth: 0, padCount: 8, type: 'smd' });
      return true;
    },
    kicadFpEditState: () => JSON.stringify(st),
    kicadFpEditSelection: () => JSON.stringify({ uuids: [] }),
    kicadCollabBusy: () => false,
  };
  return { st, exports };
}

function fakePage(search: string) {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const parent = { postMessage: vi.fn() };
  const page = {
    parent,
    top: {},
    location: { search },
    addEventListener: (t: string, h: (e: unknown) => void) => { const s = listeners.get(t) ?? new Set(); s.add(h); listeners.set(t, s); },
    removeEventListener: (t: string, h: (e: unknown) => void) => listeners.get(t)?.delete(h),
    dispatch: (t: string, e: unknown) => { for (const h of listeners.get(t) ?? []) h(e); },
  };
  return { page: page as unknown as Window & { dispatch: (t: string, e: unknown) => void }, parent };
}

/** A responder with fp-i1, fp-i4 and this unit, booted in `frame` on an engine with `exports`. */
async function boot(frame: string, exports: Record<string, unknown>) {
  const reg = buildRegistry(mods(fpI1, fpI4, unit));
  expect(reg.problems).toEqual([]);
  const { page, parent } = fakePage(`?frame=${frame}&theme=day`);
  const r = startResponder({ parentOrigin: PARENT, page, ext: reg });
  const ch = new MessageChannel();
  const got: Array<Record<string, unknown>> = [];
  ch.port1.onmessage = (m) => got.push(m.data);
  page.dispatch('message', { origin: PARENT, source: page.parent, data: { type: 'cc.connect', nonce: parent.postMessage.mock.calls[0][0].nonce }, ports: [ch.port2] });
  const win = {
    FS: { analyzePath: () => ({ exists: false }), mkdirTree: () => {}, readdir: () => [], readFile: () => { throw new Error('ENOENT'); } },
    Module: { kicadOpenFileBusy: () => false, ...exports },
    wxElementRegistry: { findAll: () => [{ id: 'frame', typeName: 'FOOTPRINT_EDIT_FRAME', name: 'FootprintEditor', visible: true }], findByLabel: () => [] },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    dispatchEvent: () => true,
  } as unknown as ToolWindow & { kicadHostAction?: { onRequest?: (json: unknown) => boolean } };
  r.engineReady(win, { tag: 't', kicad: '10.0' }, { attempts: () => 0 });
  await settle();
  let next = 1;
  const ask = async (op: string, args?: unknown) => {
    const id = next++;
    ch.port1.postMessage(args === undefined ? { id, op } : { id, op, args });
    for (let i = 0; i < 40 && got.find((m) => m.id === id) == null; i++) await settle(10);
    return got.find((m) => m.id === id);
  };
  const slot = (action: string) => win.kicadHostAction?.onRequest?.(JSON.stringify({ action })) === true;
  const ready = got.find((m) => m.type === 'ev.ready') as { caps: string[] } | undefined;
  return { r, got, win, ask, slot, caps: ready?.caps ?? [] };
}

describe('the unit in the registry', () => {
  it('loads in this checkout with nothing broken, its rows in the union after the built ins', () => {
    expect(REGISTRY.problems).toEqual([]);
    expect(REGISTRY.units.map((u) => u.unit)).toContain('fp-i6');
    const union = heldActions();
    for (const row of FP_I6_ROWS) expect(union).toContainEqual(row);
    expect(union.slice(0, HELD_ACTIONS.length)).toEqual([...HELD_ACTIONS]);
    // Each row is held once in its frame: no built in row and no other unit holds it there.
    for (const r of FP_I6_ROWS) for (const f of r.frames) expect(union.filter((h) => h.action === r.action && (h.frames as readonly string[]).includes(f)), `${r.action} ${f}`).toHaveLength(1);
  });

  it('holds exactly the record\'s 44 entries, each in its frame under its cap', () => {
    expect(FP_I6_ROWS.map((r) => [r.action, [...r.frames], r.cap])).toEqual(RECORD.map(([a, f, c]) => [a, [f], c]));
    expect([...FPEDIT_HELD_ACTIONS, ...BOARD_FOOTPRINT_DOORS]).toEqual(RECORD.map(([a]) => a));
    expect(unit.held).toEqual([...new Set(RECORD.map(([a]) => a))]);
    expect(unit.held).toHaveLength(43);
    expect(FOOTPRINT_EDIT_CAP).toBe('footprintEdit');
    expect(Object.isFrozen(FP_I6_ROWS)).toBe(true);
    for (const r of FP_I6_ROWS) { expect(Object.isFrozen(r)).toBe(true); expect(Object.isFrozen(r.frames)).toBe(true); }
  });

  it('declares no op, cap, event, ask, frame, export job or install: the caps it waits on are fp-i1\'s and fp-i4\'s', () => {
    const u = unit as ExtUnit;
    expect(u.ops ?? {}).toEqual({});
    expect(u.opsWidened ?? {}).toEqual({});
    expect(u.capNames ?? []).toEqual([]);
    expect(u.caps).toBeUndefined();
    expect(u.events ?? {}).toEqual({});
    expect(u.asks ?? []).toEqual([]);
    expect(u.exportJobs ?? {}).toEqual({});
    expect(u.defineFrames ?? {}).toEqual({});
    expect(u.install).toBeUndefined();
    expect(REGISTRY.capNames.get('fpedit')).toBe('fp-i1');
    expect(REGISTRY.capNames.get('footprintEdit')).toBe('fp-i4');
  });
});

describe('the rows as the responder takes them (bridge/held.ts heldTaken over the union)', () => {
  const union = heldActions(buildRegistry(mods(fpI1, fpI4, unit)));
  const take = (a: string, f: string, caps: string[]) => heldTaken(a, f as never, caps, union);
  const ALL = ['heldKeys', 'fpedit', 'footprintEdit'];

  it('takes the footprint editor\'s actions in an fpedit frame under fpedit only', () => {
    for (const a of FPEDIT_HELD_ACTIONS) {
      expect(take(a, 'fpedit', ['heldKeys', 'fpedit']), a).toBe(true);
      expect(take(a, 'fpedit', ['heldKeys', 'footprintEdit']), a).toBe(false);
      expect(take(a, 'symedit', ALL), a).toBe(false);
    }
  });

  it('takes the board\'s three doors in a pcb frame under footprintEdit only', () => {
    for (const a of BOARD_FOOTPRINT_DOORS) {
      expect(take(a, 'pcb', ['heldKeys', 'footprintEdit']), a).toBe(true);
      expect(take(a, 'pcb', ['heldKeys', 'fpedit']), a).toBe(false);
      expect(take(a, 'sch', ALL), a).toBe(false);
    }
    expect(take('pcbnew.EditorControl.EditFpInFpEditor', 'fpedit', ALL)).toBe(false);
    expect(take('common.Control.showFootprintEditor', 'fpedit', ALL)).toBe(false);
  });

  it('leaves the board\'s own rows as they ship: a pcb frame takes no footprint editor action', () => {
    for (const a of FPEDIT_HELD_ACTIONS.filter((x) => !BOARD_FOOTPRINT_DOORS.includes(x) && !HELD_ACTIONS.some((h) => h.action === x && h.frames.includes('pcb')))) {
      expect(take(a, 'pcb', ALL), a).toBe(false);
    }
    // KiCad's 3D viewer and the properties pane stay the built in pcb rows under heldKeys.
    expect(take('common.Control.show3DViewer', 'pcb', ['heldKeys'])).toBe(true);
    expect(take('pcbnew.InteractiveDrawing.placePad', 'fpedit', ALL)).toBe(false);
  });
});

describe('an fpedit frame\'s slot', () => {
  it('on an engine with the fpedit exports: holds nothing before a footprint is open, then sends ev.held once per press', async () => {
    const t = await boot('fpedit', fakeFp().exports);
    expect(t.caps).toContain('fpedit');
    expect(t.caps).toContain('heldKeys');
    for (const a of FPEDIT_HELD_ACTIONS) expect(t.slot(a), a).toBe(false);
    expect(t.got.filter((m) => m.type === 'ev.held')).toEqual([]);
    expect(await t.ask('fpedit.open', { text: SOIC, name: 'SOIC-8_3.9x4.9mm_P1.27mm', lib: 'fpedit-small_parts', mode: 'library', discard: false })).toMatchObject({ ok: true });
    for (const a of FPEDIT_HELD_ACTIONS) expect(t.slot(a), a).toBe(true);
    for (const a of BOARD_FOOTPRINT_DOORS.filter((x) => !FPEDIT_HELD_ACTIONS.includes(x))) expect(t.slot(a), a).toBe(false);
    expect(t.slot('pcbnew.InteractiveDrawing.placePad')).toBe(false);
    await settle();
    expect(t.got.filter((m) => m.type === 'ev.held')).toEqual(FPEDIT_HELD_ACTIONS.map((action) => ({ type: 'ev.held', action })));
    t.r.close();
  });

  it('on an engine without the fpedit exports (engine run 14) lists no fpedit cap and lets KiCad run every action', async () => {
    const t = await boot('fpedit', { kicadHostActions: () => true });
    expect(t.caps).not.toContain('fpedit');
    for (const a of FPEDIT_HELD_ACTIONS) expect(t.slot(a), a).toBe(false);
    expect(t.got.filter((m) => m.type === 'ev.held')).toEqual([]);
    t.r.close();
  });

  it('a pcb frame with no board open lets KiCad run the three doors (admit stands first)', async () => {
    const t = await boot('pcb', { kicadHostActions: () => true });
    for (const a of BOARD_FOOTPRINT_DOORS) expect(t.slot(a), a).toBe(false);
    expect(t.got.filter((m) => m.type === 'ev.held')).toEqual([]);
    t.r.close();
  });
});

describe('the seeded keys (theme/user.hotkeys, theme/symedit.hotkeys, theme/hotkeys/*.hotkeys)', () => {
  // Every file theme/seeds.ts seeds the engine's hotkeys from.
  const files = import.meta.glob(['../../theme/user.hotkeys', '../../theme/symedit.hotkeys', '../../theme/hotkeys/*.hotkeys'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
  const seeded = Object.values(files).flatMap((t) => t.split('\n')).map((l) => l.split('\t')).filter((c) => c.length >= 2 && c[1] !== '').map((c) => c[0]);

  it('no seeded key is a held action\'s but the two pencil doors and the panes the built in rows hold already', () => {
    expect(seeded.length).toBeGreaterThan(0);
    const held = new Set(FP_I6_ROWS.map((r) => r.action));
    // A seeded key whose action the built in table holds in a board or a schematic (the properties
    // pane's Ctrl+Alt+Shift+J) is already the host's door there, and is held the same way here.
    const builtin = new Set(HELD_ACTIONS.filter((h) => h.frames.some((f) => f === 'pcb' || f === 'sch')).map((h) => h.action));
    expect(seeded.filter((a) => held.has(a) && !PENCIL_DOORS.includes(a) && !builtin.has(a))).toEqual([]);
  });

  it('no fpedit pencil row with a seeded key runs a held action but the two pencil doors', () => {
    const rows = PENCIL as Array<{ editor: string; action: string; seededKey: string | null }>;
    const held = new Set(FP_I6_ROWS.filter((r) => r.frames.includes('fpedit' as never)).map((r) => r.action));
    expect(rows.filter((r) => r.editor === 'fpedit' && r.seededKey != null && held.has(r.action) && !PENCIL_DOORS.includes(r.action)).map((r) => r.action)).toEqual([]);
  });
});

