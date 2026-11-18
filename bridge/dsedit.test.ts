// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The drawing sheet editor's parsers and readers (bridge/dsedit.ts): every
// parser refuses one key, type and bound at a time, every reader any other shape.
import { describe, expect, it } from 'vitest';
import {
  DS_HELD, DS_TEXT_MAX_BYTES, DS_WORKS, DSEDIT_EXPORTS, dsOpenJson, dsSelectionRead, dsSheetOpen, dsShows, dsUndoDepth, makeDsToken,
  parseDsMarkSavedArgs, parseDsOpenArgs, parseDsShowArgs, readDsItemUuids, readDsOpenAnswer, readDsSelection, readDsState, readDsTaken,
  type DsEditState,
} from './dsedit';
import { ACTION_RE } from './held';

const U1 = '22222222-0000-4000-8000-000000000001';
const U2 = '22222222-0000-4000-8000-000000000002';
const WKS = '(kicad_wks (version 20231118) (generator "pl_editor"))';
const STATE: DsEditState = { token: 'd01', open: true, name: 'sheets/custom.kicad_wks', modified: false, depth: 0, page: 1, values: true, items: 4 };
const json = (v: unknown) => JSON.stringify(v);
const without = (o: Record<string, unknown>, k: string) => { const c = { ...o }; delete c[k]; return c; };

describe('dsedit.open args', () => {
  const TEXT = { source: 'text', text: WKS, name: 'custom.kicad_wks', discard: false };
  it('takes a text open, a default open and an empty open', () => {
    expect(parseDsOpenArgs(TEXT)).toEqual(TEXT);
    expect(parseDsOpenArgs({ source: 'default', name: 'new.kicad_wks', discard: true })).toEqual({ source: 'default', text: '', name: 'new.kicad_wks', discard: true });
    expect(parseDsOpenArgs({ source: 'empty', name: 'n', discard: false })).toEqual({ source: 'empty', text: '', name: 'n', discard: false });
  });
  it('refuses one key, type or bound at a time', () => {
    expect(parseDsOpenArgs(undefined)).toBeNull();
    expect(parseDsOpenArgs([TEXT])).toBeNull();
    expect(parseDsOpenArgs({ ...TEXT, extra: 1 })).toBeNull();
    for (const k of ['source', 'name', 'discard', 'text']) expect(parseDsOpenArgs(without(TEXT, k)), k).toBeNull();
    expect(parseDsOpenArgs({ ...TEXT, source: 'file' })).toBeNull();
    expect(parseDsOpenArgs({ ...TEXT, text: '' })).toBeNull();
    expect(parseDsOpenArgs({ ...TEXT, text: 3 })).toBeNull();
    expect(parseDsOpenArgs({ ...TEXT, text: 'a\0b' })).toBeNull();
    expect(parseDsOpenArgs({ ...TEXT, name: '' })).toBeNull();
    expect(parseDsOpenArgs({ ...TEXT, name: 'x'.repeat(1025) })).toBeNull();
    expect(parseDsOpenArgs({ ...TEXT, name: 'a\nb' })).toBeNull();
    expect(parseDsOpenArgs({ ...TEXT, discard: 'no' })).toBeNull();
    // text belongs to a text open only
    expect(parseDsOpenArgs({ source: 'default', text: WKS, name: 'n', discard: false })).toBeNull();
  });
  it('sends the engine exactly its keys, the text only for a text open', () => {
    expect(JSON.parse(dsOpenJson(parseDsOpenArgs(TEXT)!, 'tok'))).toEqual({ ...TEXT, token: 'tok' });
    expect(JSON.parse(dsOpenJson(parseDsOpenArgs({ source: 'empty', name: 'n', discard: true })!, 'tok'))).toEqual({ source: 'empty', name: 'n', discard: true, token: 'tok' });
  });
});

describe('dsedit.markSaved and dsedit.show args', () => {
  it('takes exactly a token', () => {
    expect(parseDsMarkSavedArgs({ token: 'd01' })).toEqual({ token: 'd01' });
    for (const bad of [undefined, {}, { token: '' }, { token: 'x'.repeat(65) }, { token: 'a\tb' }, { token: 3 }, { token: 'd01', more: 1 }]) expect(parseDsMarkSavedArgs(bad)).toBeNull();
  });
  it('takes exactly a page 1 or 2 and values', () => {
    expect(parseDsShowArgs({ page: 2, values: false })).toEqual({ page: 2, values: false });
    for (const bad of [undefined, {}, { page: 2 }, { values: true }, { page: 3, values: true }, { page: 0, values: true }, { page: '1', values: true }, { page: 1, values: 1 }, { page: 1, values: true, zoom: true }]) {
      expect(parseDsShowArgs(bad), json(bad)).toBeNull();
    }
  });
});

describe('the engine answers', () => {
  it('reads the state closed', () => {
    expect(readDsState(json(STATE))).toEqual(STATE);
    expect(readDsState(json({ ...STATE, token: '', open: false, name: '' }))).toEqual({ ...STATE, token: '', open: false, name: '' });
    expect(readDsState('')).toBeNull();
    expect(readDsState('{')).toBeNull();
    expect(readDsState(json({ ...STATE, extra: 1 }))).toBeNull();
    for (const k of Object.keys(STATE)) expect(readDsState(json(without(STATE as unknown as Record<string, unknown>, k))), k).toBeNull();
    for (const [k, v] of [['page', 3], ['depth', -1], ['depth', 1.5], ['items', -2], ['open', 1], ['values', 'yes'], ['modified', null], ['name', 'x'.repeat(1025)], ['token', 'x'.repeat(65)]] as const) {
      expect(readDsState(json({ ...STATE, [k]: v })), `${k} ${String(v)}`).toBeNull();
    }
  });
  it('reads an open answer: taken, or why not with KiCad\'s line', () => {
    expect(readDsOpenAnswer('{"error":""}')).toEqual({ error: '', message: '' });
    expect(readDsOpenAnswer(json({ error: 'unreadable', message: 'Expecting ) in line 7' }))).toEqual({ error: 'unreadable', message: 'Expecting ) in line 7' });
    expect(readDsOpenAnswer('{"error":"held_edits"}')).toEqual({ error: 'held_edits', message: '' });
    expect(readDsOpenAnswer('{"error":"too_large"}')).toEqual({ error: 'too_large', message: '' });
    for (const bad of ['', 'false', '{}', '{"error":"nope"}', '{"error":"","x":1}', json({ error: 'unreadable', message: 3 }), json({ error: 'unreadable', message: 'x'.repeat(4097) })]) {
      expect(readDsOpenAnswer(bad), bad).toBeNull();
    }
  });
  it('reads a take closed', () => {
    expect(readDsTaken(json({ name: 'a.kicad_wks', text: WKS }))).toEqual({ name: 'a.kicad_wks', text: WKS });
    for (const bad of ['', json({ name: 'a', text: '' }), json({ name: 'a' }), json({ name: 'a', text: WKS, parent: '' }), json({ name: 4, text: WKS })]) expect(readDsTaken(bad), bad).toBeNull();
    expect(readDsTaken(json({ name: 'a', text: 'x'.repeat(DS_TEXT_MAX_BYTES + 1) }))).toBeNull();
  });
  it('reads the selection in the house shape or as a bare list', () => {
    expect(readDsSelection(json({ uuids: [U1, U2] }))).toEqual([U1, U2]);
    expect(readDsSelection(json([U2]))).toEqual([U2]);
    expect(readDsSelection(json({ uuids: [] }))).toEqual([]);
    for (const bad of ['', json({ uuids: ['nope'] }), json({ uuids: [U1], more: 1 }), json({ uuids: ['AAAAAAAA-0000-4000-8000-00000000000A'] }), '7']) expect(readDsSelection(bad), bad).toBeNull();
    expect(readDsItemUuids(json({ items: [{ kind: 'line', uuid: U1 }, { kind: 'text', uuid: U2 }] }))).toEqual([U1, U2]);
    expect(readDsItemUuids(json({ items: [{ kind: 'line' }] }))).toBeNull();
    expect(readDsItemUuids('')).toBeNull();
  });
  it('says when the state shows a show', () => {
    expect(dsShows(STATE, { page: 1, values: true })).toBe(true);
    expect(dsShows(STATE, { page: 2, values: true })).toBe(false);
    expect(dsShows(STATE, { page: 1, values: false })).toBe(false);
  });
});

describe('the frame reads', () => {
  const engine = (state: unknown, selection: unknown = { uuids: [] }) => ({
    ...Object.fromEntries(DSEDIT_EXPORTS.map((n) => [n, () => false])),
    kicadDsEditState: () => json(state),
    kicadDsEditSelection: () => json(selection),
  }) as Record<string, unknown>;
  it('opens, reads the depth and the selection only on an engine with every export', () => {
    expect(dsSheetOpen(engine(STATE))).toBe(true);
    expect(dsSheetOpen(engine({ ...STATE, open: false }))).toBe(false);
    expect(dsSheetOpen({ kicadDsEditState: () => json(STATE) })).toBe(false);
    expect(dsSheetOpen(null)).toBe(false);
    expect(dsUndoDepth(engine({ ...STATE, depth: 3 }))).toBe(3);
    expect(dsUndoDepth(engine({ ...STATE, open: false, depth: 3 }))).toBeNull();
    expect(dsUndoDepth({})).toBeNull();
    expect(dsSelectionRead(engine(STATE, { uuids: [U1] }))).toBe(json([U1]));
    expect(dsSelectionRead(engine(STATE, 'nope'))).toBe('');
    expect(dsSelectionRead({})).toBe('');
  });
  it('holds KiCad action names only, never twice', () => {
    expect(DS_HELD).toHaveLength(12);
    expect(new Set(DS_HELD).size).toBe(DS_HELD.length);
    expect(DS_HELD.every((a) => ACTION_RE.test(a))).toBe(true);
    expect(DS_WORKS).toEqual(['key.press', 'keys.claim', 'chrome.show', 'view.fit', 'select', 'shutdown']);
  });
  it('makes a token the state can carry', () => {
    const t = makeDsToken();
    expect(t).toMatch(/^[\x20-\x7e]{1,64}$/);
    expect(makeDsToken()).not.toBe(t);
  });
});
