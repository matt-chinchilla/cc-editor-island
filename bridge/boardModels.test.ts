// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The pure parts of board.models, board.setModels and board.embedModels
// (bridge/boardModels.ts): the args read closed, the engine's read read
// closed, the read back rule, the embed plan and its folder names.
import { describe, expect, it } from 'vitest';
import {
  FolderNames, MAX_ITEMS, parseEmbedModelsArgs, parseSetModelsArgs, planEmbed, readBack, readBoardModels, readEmbedAnswer, readModelLine, sameLines,
  type BoardModelsRead, type ModelLine,
} from './boardModels';

const U = (n: number): string => `3d1a2000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const line = (path: string, extra: Partial<ModelLine> = {}): ModelLine => ({ path, offset: [0, 0, 0], rotate: [0, 0, 0], scale: [1, 1, 1], opacity: 1, show: true, ...extra });
const KIND = { smd: true, tht: false, virtual: false, notInPos: false, dnp: false };
const LIB = '${KICAD10_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.step';

const board = (): BoardModelsRead => ({
  footprints: [
    { uuid: U(100), ref: 'R1', kind: KIND, models: [{ ...line(LIB), found: 'staged' }] },
    { uuid: U(200), ref: 'U1', kind: KIND, models: [{ ...line('${KIPRJMOD}/cube.step'), found: 'project' }, { ...line('${KIPRJMOD}/block.wrl'), found: 'project' }, { ...line('kicad-embed://x.step'), found: 'embedded' }, { ...line('/abs/gone.step'), found: 'missing' }] },
  ],
  embedded: [],
});

describe('readModelLine', () => {
  it('reads exactly the six keys, found only when asked', () => {
    expect(readModelLine(line('a.step'))).toEqual(line('a.step'));
    expect(readModelLine({ ...line('a.step'), found: 'project' })).toBeNull();
    expect(readModelLine({ ...line('a.step'), found: 'project' }, true)).toEqual({ ...line('a.step'), found: 'project' });
    expect(readModelLine({ ...line('a.step'), found: 'elsewhere' }, true)).toBeNull();
    const { show: _show, ...noShow } = line('a.step');
    expect(readModelLine(noShow)).toBeNull();
  });
  it('refuses a bad path, vector, opacity or show', () => {
    expect(readModelLine(line(''))).toBeNull();
    expect(readModelLine(line('x'.repeat(1025)))).toBeNull();
    expect(readModelLine(line('a\nb'))).toBeNull();
    expect(readModelLine(line('a', { offset: [0, 0] as unknown as [number, number, number] }))).toBeNull();
    expect(readModelLine(line('a', { scale: [1, Infinity, 1] }))).toBeNull();
    expect(readModelLine(line('a', { opacity: 1.5 }))).toBeNull();
    expect(readModelLine(line('a', { opacity: -0.1 }))).toBeNull();
    expect(readModelLine({ ...line('a'), show: 1 })).toBeNull();
  });
});

describe('parseSetModelsArgs', () => {
  const ok = { label: 'Update model names', items: [{ uuid: U(100), models: [line(LIB)] }] };
  it('reads the closed form', () => {
    expect(parseSetModelsArgs(ok)).toEqual(ok);
    expect(parseSetModelsArgs({ label: 'Change models', items: [{ uuid: U(1), models: [] }] })).not.toBeNull();
  });
  it('refuses another label, extra keys, an empty or oversized list, a twice named or uppercase uuid, 65 lines, a line with found', () => {
    expect(parseSetModelsArgs({ ...ok, label: 'Other' })).toBeNull();
    expect(parseSetModelsArgs({ ...ok, more: 1 })).toBeNull();
    expect(parseSetModelsArgs({ ...ok, items: [] })).toBeNull();
    expect(parseSetModelsArgs({ ...ok, items: Array.from({ length: MAX_ITEMS + 1 }, (_, i) => ({ uuid: U(i), models: [] })) })).toBeNull();
    expect(parseSetModelsArgs({ ...ok, items: Array.from({ length: MAX_ITEMS }, (_, i) => ({ uuid: U(i), models: [] })) })).not.toBeNull();
    expect(parseSetModelsArgs({ ...ok, items: [ok.items[0], ok.items[0]] })).toBeNull();
    expect(parseSetModelsArgs({ ...ok, items: [{ uuid: U(1).toUpperCase(), models: [] }] })).toBeNull();
    expect(parseSetModelsArgs({ ...ok, items: [{ uuid: U(1), models: Array.from({ length: 65 }, () => line('a')) }] })).toBeNull();
    expect(parseSetModelsArgs({ ...ok, items: [{ uuid: U(1), models: [{ ...line('a'), found: 'project' }] }] })).toBeNull();
    expect(parseSetModelsArgs({ ...ok, items: [{ uuid: U(1), models: [], extra: true }] })).toBeNull();
  });
});

describe('parseEmbedModelsArgs', () => {
  it('reads 1 to 4,096 lines, index 0 to 63, each line once', () => {
    expect(parseEmbedModelsArgs({ items: [{ uuid: U(1), index: 0 }, { uuid: U(1), index: 63 }] })).toEqual({ items: [{ uuid: U(1), index: 0 }, { uuid: U(1), index: 63 }] });
    expect(parseEmbedModelsArgs({ items: [] })).toBeNull();
    expect(parseEmbedModelsArgs({ items: [{ uuid: U(1), index: 64 }] })).toBeNull();
    expect(parseEmbedModelsArgs({ items: [{ uuid: U(1), index: -1 }] })).toBeNull();
    expect(parseEmbedModelsArgs({ items: [{ uuid: U(1), index: 1.5 }] })).toBeNull();
    expect(parseEmbedModelsArgs({ items: [{ uuid: U(1).toUpperCase(), index: 0 }] })).toBeNull();
    expect(parseEmbedModelsArgs({ items: [{ uuid: U(1), index: 0 }, { uuid: U(1), index: 0 }] })).toBeNull();
    expect(parseEmbedModelsArgs({ items: [{ uuid: U(1), index: 0, file: 'x' }] })).toBeNull();
    expect(parseEmbedModelsArgs({ items: [{ uuid: U(1), index: 0 }], more: 1 })).toBeNull();
    expect(parseEmbedModelsArgs({ items: Array.from({ length: MAX_ITEMS + 1 }, (_, i) => ({ uuid: U(i), index: 0 })) })).toBeNull();
  });
});

describe('readBoardModels', () => {
  it('reads the engine\'s record and refuses "" and other shapes', () => {
    const b = board();
    expect(readBoardModels(JSON.stringify(b))).toEqual(b);
    expect(readBoardModels('')).toBeNull();
    expect(readBoardModels('{')).toBeNull();
    expect(readBoardModels(JSON.stringify({ footprints: [] }))).toBeNull();
    expect(readBoardModels(JSON.stringify({ footprints: [{ uuid: U(1), ref: 'R1', kind: KIND, models: [line('a')] }], embedded: [] }))).toBeNull();
    expect(readBoardModels(JSON.stringify({ footprints: [], embedded: [3] }))).toBeNull();
  });
});

describe('read back', () => {
  it('compares lines within KiCad\'s short numbers and counts only the footprints changed', () => {
    expect(sameLines([line('a', { offset: [1.0000000001, 0, 0] })], [line('a', { offset: [1, 0, 0] })])).toBe(true);
    expect(sameLines([line('a')], [line('a', { show: false })])).toBe(false);
    expect(sameLines([line('a')], [])).toBe(false);
    const before = board();
    const after = board();
    after.footprints[0].models = [{ ...line(LIB.replace('.step', '.wrl')), found: 'staged' }];
    const items = [{ uuid: U(100), models: [line(LIB.replace('.step', '.wrl'))] }, { uuid: U(200), models: before.footprints[1].models.map(({ found: _f, ...l }) => l) }];
    expect(readBack(before, after, items)).toEqual({ matched: 2, changed: 1 });
    expect(readBack(before, before, items)).toEqual({ matched: 1, changed: 0 });
  });
});

describe('planEmbed', () => {
  const none = (): boolean => false;
  it('plans a library line through the store and a project line from the folder, a VRML line with its STEP sibling', () => {
    const plan = planEmbed(board(), [{ uuid: U(100), index: 0 }, { uuid: U(200), index: 0 }, { uuid: U(200), index: 1 }], (rel) => rel === 'block.step');
    expect(plan).toEqual({ lines: [
      { uuid: U(100), index: 0, ref: 'R1', path: LIB, source: { kind: 'library', ref: LIB } },
      { uuid: U(200), index: 0, ref: 'U1', path: '${KIPRJMOD}/cube.step', source: { kind: 'project', rel: 'cube.step', alt: null } },
      { uuid: U(200), index: 1, ref: 'U1', path: '${KIPRJMOD}/block.wrl', source: { kind: 'project', rel: 'block.wrl', alt: 'block.step' } },
    ] });
    expect(planEmbed(board(), [{ uuid: U(200), index: 1 }], (rel) => rel === 'block.stp')).toMatchObject({ lines: [{ source: { alt: 'block.stp' } }] });
  });
  it('refuses, by name, a line already inside the board, a missing one, one past the footprint\'s lines and an unknown footprint', () => {
    expect(planEmbed(board(), [{ uuid: U(200), index: 2 }], none)).toEqual({ refused: 'U1 kicad-embed://x.step' });
    expect(planEmbed(board(), [{ uuid: U(200), index: 3 }], none)).toEqual({ refused: 'U1 /abs/gone.step' });
    expect(planEmbed(board(), [{ uuid: U(200), index: 9 }], none)).toEqual({ refused: `${U(200)} line 9` });
    expect(planEmbed(board(), [{ uuid: U(999), index: 0 }], none)).toEqual({ refused: `${U(999)} line 0` });
    expect(planEmbed(board(), [{ uuid: U(100), index: 0 }, { uuid: U(200), index: 2 }], none)).toEqual({ refused: 'U1 kicad-embed://x.step' });
  });
  it('refuses a line whose path resolves to nothing even when the engine found it', () => {
    const b = board();
    b.footprints[1].models[3].found = 'project';
    expect(planEmbed(b, [{ uuid: U(200), index: 3 }], none)).toEqual({ refused: 'U1 /abs/gone.step' });
  });
});

describe('FolderNames', () => {
  it('keeps each body\'s own name, a second of the same name numbered, the same body named once', () => {
    const n = new FolderNames();
    expect(n.nameOf('library:A.3dshapes/x.step', 'A.3dshapes/x.step')).toBe('x.step');
    expect(n.nameOf('project:sub/x.step', 'sub/x.step')).toBe('x-2.step');
    expect(n.nameOf('project:X.STEP', 'X.STEP')).toBe('X-3.STEP');
    expect(n.nameOf('library:A.3dshapes/x.step', 'A.3dshapes/x.step')).toBe('x.step');
  });
});

describe('readEmbedAnswer', () => {
  it('reads { embedded, names, bytes } and refuses "" and other shapes', () => {
    expect(readEmbedAnswer(JSON.stringify({ embedded: 3, names: ['a.step'], bytes: 10 }))).toEqual({ embedded: 3, names: ['a.step'], bytes: 10 });
    expect(readEmbedAnswer('')).toBeNull();
    expect(readEmbedAnswer(JSON.stringify({ embedded: 3, names: ['a'], bytes: 10, more: 1 }))).toBeNull();
    expect(readEmbedAnswer(JSON.stringify({ embedded: -1, names: [], bytes: 0 }))).toBeNull();
  });
});
