// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// bridge/fpedit/common.ts on its own: the closed parsers of the core ops' args,
// the closed readers of the engine's answers, what the island hands the
// engine, and the frame's reads (state, undo depth, selection) over a fake
// module of the fpedit exports.
import { describe, expect, it } from 'vitest';
import {
  FPEDIT_EXPORTS, fpFootprintOpen, fpNewJson, fpOpenJson, fpSelectionRead, fpUndoDepth, makeFpToken,
  parseFpMarkSavedArgs, parseFpNewArgs, parseFpOpenArgs, readFpEditState, readFpItemUuids, readFpSelection, readFpTaken,
} from './common';

const U = '77777777-0000-4000-8000-000000000001';
const STATE = { token: 'f01', open: true, name: 'SOIC-8', lib: 'parts', mode: 'library', modified: false, depth: 2, padCount: 8, type: 'smd', padEditMode: false };
const OPEN = { text: '(footprint "A")', name: 'A', lib: '', mode: 'library', discard: false };

describe('the args', () => {
  it('reads fpedit.open\'s five keys closed', () => {
    expect(parseFpOpenArgs(OPEN)).toEqual(OPEN);
    for (const mode of ['library', 'placed', 'new']) expect(parseFpOpenArgs({ ...OPEN, mode })?.mode).toBe(mode);
    expect(parseFpOpenArgs({ ...OPEN, lib: 'x'.repeat(1024) })).not.toBeNull();
    for (const bad of [
      { ...OPEN, extra: 1 }, { text: OPEN.text, name: 'A', lib: '', mode: 'library' }, { ...OPEN, text: '' }, { ...OPEN, text: 'a\0b' },
      { ...OPEN, text: 'a\ud800' }, { ...OPEN, name: '' }, { ...OPEN, name: 'x'.repeat(1025) }, { ...OPEN, name: 'a\tb' },
      { ...OPEN, lib: 'x'.repeat(1025) }, { ...OPEN, mode: 'board' }, { ...OPEN, discard: 'no' }, null, [], 'x',
    ]) expect(parseFpOpenArgs(bad), JSON.stringify(bad)?.slice(0, 80)).toBeNull();
  });

  it('reads fpedit.new\'s four keys closed', () => {
    const a = { name: 'NEW1', lib: '', type: 'smd', discard: true };
    expect(parseFpNewArgs(a)).toEqual(a);
    for (const type of ['smd', 'through_hole', 'unspecified']) expect(parseFpNewArgs({ ...a, type })?.type).toBe(type);
    for (const bad of [{ ...a, type: 'virtual' }, { ...a, x: 1 }, { name: 'A', lib: '', type: 'smd' }, { ...a, name: '' }, { ...a, discard: 1 }]) expect(parseFpNewArgs(bad)).toBeNull();
  });

  it('reads fpedit.markSaved\'s token closed', () => {
    expect(parseFpMarkSavedArgs({ token: 'f01' })).toEqual({ token: 'f01' });
    for (const bad of [{}, { token: '' }, { token: 'x'.repeat(65) }, { token: 'a\nb' }, { token: 'f01', x: 1 }]) expect(parseFpMarkSavedArgs(bad)).toBeNull();
  });

  it('hands the engine exactly its keys, with the token', () => {
    expect(JSON.parse(fpOpenJson(OPEN as never, 'tok'))).toEqual({ ...OPEN, token: 'tok' });
    expect(Object.keys(JSON.parse(fpNewJson({ name: 'N', lib: '', type: 'smd', discard: false }, 'tok')))).toEqual(['name', 'lib', 'type', 'discard', 'token']);
    expect(makeFpToken()).toMatch(/^[\x20-\x7e]{1,64}$/);
    expect(makeFpToken()).not.toBe(makeFpToken());
  });
});

describe('the engine\'s answers', () => {
  it('reads the state closed', () => {
    expect(readFpEditState(JSON.stringify(STATE))).toEqual(STATE);
    expect(readFpEditState(JSON.stringify({ ...STATE, token: '', open: false, name: '', lib: '' }))?.open).toBe(false);
    for (const bad of [
      { ...STATE, extra: 1 }, { ...STATE, mode: 'board' }, { ...STATE, type: 'virtual' }, { ...STATE, depth: -1 }, { ...STATE, depth: 1.5 },
      { ...STATE, padCount: '8' }, { ...STATE, padEditMode: 0 }, { ...STATE, token: 'a\nb' }, { ...STATE, name: 'x'.repeat(1025) },
    ]) expect(readFpEditState(JSON.stringify(bad))).toBeNull();
    for (const bad of ['', 'nope', '[]', null]) expect(readFpEditState(bad)).toBeNull();
  });

  it('reads a take closed: one (footprint ...) of at most 8 MiB', () => {
    expect(readFpTaken(JSON.stringify({ name: 'A', text: '(footprint "A")\n' }))).toEqual({ name: 'A', text: '(footprint "A")\n' });
    expect(readFpTaken(JSON.stringify({ name: 'A', text: '  \n(footprint\n)' }))).not.toBeNull();
    for (const bad of [{ name: '', text: '(footprint "A")' }, { name: 'A', text: '(kicad_pcb)' }, { name: 'A', text: '' }, { name: 'A', text: '(footprint "A")', x: 1 }]) {
      expect(readFpTaken(JSON.stringify(bad))).toBeNull();
    }
    expect(readFpTaken(JSON.stringify({ name: 'A', text: `(footprint "A" ${'x'.repeat(8 * 1024 * 1024)})` }))).toBeNull();
    expect(readFpTaken('')).toBeNull();
  });

  it('reads a selection as { uuids } or a bare list, and item uuids', () => {
    expect(readFpSelection(JSON.stringify({ uuids: [U] }))).toEqual([U]);
    expect(readFpSelection(JSON.stringify([U]))).toEqual([U]);
    for (const bad of [JSON.stringify({ uuids: ['X'] }), JSON.stringify({ uuids: [U], x: 1 }), '', '{}']) expect(readFpSelection(bad)).toBeNull();
    expect(readFpItemUuids(JSON.stringify({ items: [{ kind: 'pad', uuid: U }] }))).toEqual([U]);
    expect(readFpItemUuids(JSON.stringify({ items: [{ kind: 'pad' }] }))).toBeNull();
  });
});

describe('the frame\'s reads', () => {
  const mod = (state: unknown, selection: unknown = { uuids: [] }) => ({
    ...Object.fromEntries(FPEDIT_EXPORTS.map((n) => [n, () => false])),
    kicadFpEditState: () => JSON.stringify(state),
    kicadFpEditSelection: () => JSON.stringify(selection),
  });

  it('says a footprint is open, its undo depth and its selection, only on an engine with every export', () => {
    expect(fpFootprintOpen(mod(STATE))).toBe(true);
    expect(fpFootprintOpen(mod({ ...STATE, open: false }))).toBe(false);
    expect(fpFootprintOpen({ kicadFpEditState: () => JSON.stringify(STATE) })).toBe(false);
    expect(fpFootprintOpen(null)).toBe(false);
    expect(fpUndoDepth(mod(STATE))).toBe(2);
    expect(fpUndoDepth(mod({ ...STATE, open: false }))).toBeNull();
    expect(fpUndoDepth(mod({ open: true }))).toBeNull();
    expect(fpSelectionRead(mod(STATE, { uuids: [U] }))).toBe(JSON.stringify([U]));
    expect(fpSelectionRead(mod(STATE, { uuids: ['X'] }))).toBe('');
    expect(fpSelectionRead({})).toBe('');
  });
});
