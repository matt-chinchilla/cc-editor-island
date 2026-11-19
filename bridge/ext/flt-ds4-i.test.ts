// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// flt-ds4-i: a board whose design carries its own .kicad_prl showing the
// drawing sheet (KiCad writes it so beside every new project) drew the whole
// page in a pcb frame, around an empty board most of all, because the island
// staged its own settings only when the host sent none. The staging now takes
// the drawing sheet out of the host's own list, in every schema KiCad wrote,
// and keeps everything else the user set.
import { describe, expect, it } from 'vitest';
import { HIDDEN_ITEM, PROJECT_ROOT, stageLocalSettings, stageProject, VISIBLE_ITEMS, withoutDrawingSheet } from '../../src/stage';

function fakeFs() {
  const dirs = new Set<string>(['/']);
  const files = new Map<string, Uint8Array>();
  const FS = {
    mkdirTree(p: string) { let acc = ''; for (const s of p.split('/').filter(Boolean)) { acc += `/${s}`; dirs.add(acc); } },
    writeFile(p: string, data: Uint8Array | string) {
      const parent = p.slice(0, p.lastIndexOf('/')) || '/';
      if (!dirs.has(parent)) throw new Error(`ENOENT ${parent}`);
      if (dirs.has(p)) throw new Error(`EISDIR ${p}`);
      files.set(p, typeof data === 'string' ? new TextEncoder().encode(data) : data.slice());
    },
    readFile(p: string) { const f = files.get(p); if (!f) throw new Error(`ENOENT ${p}`); return f.slice(); },
    analyzePath(p: string) { return { exists: files.has(p) || dirs.has(p) }; },
    unlink(p: string) { files.delete(p); },
  };
  return { FS, dirs, files };
}

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | undefined) => new TextDecoder().decode(b);
const root = `${PROJECT_ROOT}/cc`;
/** Every visibility item, the drawing sheet among them, as KiCad 10 writes a new project's list. */
const ALL_NAMED = [...VISIBLE_ITEMS.slice(0, 20), HIDDEN_ITEM, ...VISIBLE_ITEMS.slice(20)];
const prl = (visible: unknown, version: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ board: { active_layer: 2, visible_items: visible, visible_layers: '00ff', ...extra }, meta: { filename: 'b.kicad_prl', version } });

describe('withoutDrawingSheet', () => {
  it('takes the drawing sheet out of a named list (schema 5) and keeps every other key and entry', () => {
    const out = JSON.parse(withoutDrawingSheet(prl(ALL_NAMED, 5, { opacity: { zones: 0.4 } }))!);
    expect(out).toEqual({ board: { active_layer: 2, visible_items: [...VISIBLE_ITEMS], visible_layers: '00ff', opacity: { zones: 0.4 } }, meta: { filename: 'b.kicad_prl', version: 5 } });
  });

  it('reads a later schema by name too', () => {
    expect(JSON.parse(withoutDrawingSheet(prl(['tracks', 'drawing_sheet'], 6))!).board.visible_items).toEqual(['tracks']);
  });

  it('takes the sheet\'s offset out of a numbered list: 24 from schema 3, 29 before it, as KiCad\'s migrations read them', () => {
    expect(JSON.parse(withoutDrawingSheet(prl([0, 19, 24, 29], 3))!)).toMatchObject({ board: { visible_items: [0, 19, 29] }, meta: { version: 3 } });
    expect(JSON.parse(withoutDrawingSheet(prl([0, 19, 24, 29], 4))!).board.visible_items).toEqual([0, 19, 29]);
    expect(JSON.parse(withoutDrawingSheet(prl([0, 19, 24, 29], 2))!).board.visible_items).toEqual([0, 19, 24]);
    expect(JSON.parse(withoutDrawingSheet(prl([0, 29], 1))!).board.visible_items).toEqual([0]);
  });

  it('changes nothing when the list does not show the sheet', () => {
    expect(withoutDrawingSheet(prl([...VISIBLE_ITEMS], 5))).toBeNull();
    expect(withoutDrawingSheet(prl(['none'], 5))).toBeNull();
    expect(withoutDrawingSheet(prl([0, 19, 29], 3))).toBeNull();
    expect(withoutDrawingSheet(prl([0, 24], 2))).toBeNull();
  });

  it('writes KiCad\'s own "none" marker at schema 5 when nothing readable would be left, never an empty list (KiCad shows every item for one)', () => {
    expect(JSON.parse(withoutDrawingSheet(prl(['drawing_sheet'], 5))!)).toMatchObject({ board: { visible_items: ['none'] }, meta: { filename: 'b.kicad_prl', version: 5 } });
    expect(JSON.parse(withoutDrawingSheet(prl(['drawing_sheet', 'not_an_item'], 5))!).board.visible_items).toEqual(['none']);
    expect(JSON.parse(withoutDrawingSheet(prl([24, 'x'], 3))!)).toMatchObject({ board: { visible_items: ['none'], active_layer: 2 }, meta: { version: 5 } });
    expect(JSON.parse(withoutDrawingSheet(JSON.stringify({ board: { visible_items: ['drawing_sheet'] } }))!)).toEqual({ board: { visible_items: ['none'] }, meta: { version: 5 } });
  });

  it('leaves alone a text that is no settings file with a list: not JSON, not an object, no board, no list', () => {
    for (const text of ['', 'not json', '[1]', '{"host":true}', '{"board":[]}', '{"board":{}}', '{"board":{"visible_items":"all"}}']) {
      expect(withoutDrawingSheet(text)).toBeNull();
    }
  });

  it('reads a file that starts with a byte order mark', () => {
    expect(JSON.parse(withoutDrawingSheet(`﻿${prl(['tracks', 'drawing_sheet'], 5)}`)!).board.visible_items).toEqual(['tracks']);
  });
});

describe('stageLocalSettings with the host\'s own settings', () => {
  it('takes the drawing sheet out of the host\'s file beside a board and answers its path, so its saves are not reported', () => {
    const { FS, files } = fakeFs();
    const win = { FS } as unknown as ToolWindow;
    const staged = stageProject(win, 'cc', [{ path: 'b.kicad_pcb', bytes: enc('(kicad_pcb)') }, { path: 'b.kicad_prl', bytes: enc(prl(ALL_NAMED, 5)) }]);
    expect(stageLocalSettings(win, staged, 'b.kicad_pcb')).toBe('b.kicad_prl');
    const read = JSON.parse(dec(files.get(`${root}/b.kicad_prl`)));
    expect(read.board.visible_items).toEqual([...VISIBLE_ITEMS]);
    expect(read.board.active_layer).toBe(2);
    expect(read.board.visible_layers).toBe('00ff');
    expect(read.board.opacity).toBeUndefined();   // the user's file gains nothing of the island's own
    expect(staged.written).toEqual(['b.kicad_pcb', 'b.kicad_prl']);
  });

  it('does the same beside a foreign board an import opens', () => {
    const { FS, files } = fakeFs();
    const win = { FS } as unknown as ToolWindow;
    const staged = stageProject(win, 'cc', [{ path: 'x/b.brd', bytes: enc('<eagle/>') }, { path: 'x/b.kicad_prl', bytes: enc(prl([0, 24], 3)) }]);
    expect(stageLocalSettings(win, staged, 'x/b.brd')).toBe('x/b.kicad_prl');
    expect(JSON.parse(dec(files.get(`${root}/x/b.kicad_prl`))).board.visible_items).toEqual([0]);
  });

  it('leaves the host\'s file byte for byte when it does not show the sheet, beside a schematic, or is no settings file', () => {
    for (const [open, text] of [['b.kicad_pcb', prl([...VISIBLE_ITEMS], 5)], ['b.kicad_sch', prl(ALL_NAMED, 5)], ['b.kicad_pcb', '{"host":true}'], ['b.kicad_pcb', 'garbage']] as const) {
      const { FS, files } = fakeFs();
      const win = { FS } as unknown as ToolWindow;
      const staged = stageProject(win, 'cc', [{ path: open, bytes: enc('x') }, { path: 'b.kicad_prl', bytes: enc(text) }]);
      expect(stageLocalSettings(win, staged, open)).toBeNull();
      expect(dec(files.get(`${root}/b.kicad_prl`))).toBe(text);
    }
  });

  it('still writes its own file when the host sent none', () => {
    const { FS, files } = fakeFs();
    const win = { FS } as unknown as ToolWindow;
    const staged = stageProject(win, 'cc', [{ path: 'b.kicad_pcb', bytes: enc('(kicad_pcb)') }]);
    expect(stageLocalSettings(win, staged, 'b.kicad_pcb')).toBe('b.kicad_prl');
    expect(JSON.parse(dec(files.get(`${root}/b.kicad_prl`))).board.visible_items).toEqual([...VISIBLE_ITEMS]);
  });
});
