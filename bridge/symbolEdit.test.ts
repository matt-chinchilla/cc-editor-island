// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { describe, expect, it } from 'vitest';
import {
  CONVERT_MAX_BYTES, parseConvertArgs, parseForEditorArgs, parseLibUpdateArgs, parsePushArgs, readConverted, readForEditor,
  readLibUpdateDone, readLibUpdateQueued,
} from './symbolEdit';

const U = 'aaaaaaaa-0000-4000-8000-000000000001';
const DOC = '(kicad_symbol_lib (version 20251024) (symbol "R"))';

describe('symbol.forEditor and symbol.push args', () => {
  it('takes exactly a uuid and a sheet path', () => {
    expect(parseForEditorArgs({ uuid: U, sheetPath: '/' })).toEqual({ uuid: U, sheetPath: '/' });
    for (const bad of [{ uuid: U }, { uuid: U, sheetPath: '' }, { uuid: U.toUpperCase(), sheetPath: '/' }, { uuid: U, sheetPath: '/', x: 1 }, { uuid: U, sheetPath: `/${U}` }]) {
      expect(parseForEditorArgs(bad), JSON.stringify(bad)).toBeNull();
    }
  });
  it('a push takes the text, a name and a lib id of both halves or none', () => {
    const PUSH = { uuid: U, sheetPath: '/', text: DOC, name: 'R', libId: '' };
    expect(parsePushArgs(PUSH)).toEqual(PUSH);
    expect(parsePushArgs({ ...PUSH, libId: 'board_parts:R' })).toMatchObject({ libId: 'board_parts:R' });
    for (const b of [{ libId: 'R' }, { libId: ':R' }, { libId: 'a:' }, { libId: 'a:b:c' }, { name: '' }, { name: 'a\nb' }, { text: '' }, { text: 'a\0b' }, { token: 't' }]) {
      expect(parsePushArgs({ ...PUSH, ...b }), JSON.stringify(b)).toBeNull();
    }
  });
});

describe('symbol.convert', () => {
  const bytes = new Uint8Array([1, 2, 3]);
  it('takes a file name and its bytes', () => {
    expect(parseConvertArgs({ name: 'parts.lbr', bytes })).toEqual({ name: 'parts.lbr', bytes });
    for (const bad of [{ name: '', bytes }, { name: '.', bytes }, { name: '..', bytes }, { name: 'a/b.lib', bytes }, { name: 'a\\b.lib', bytes }, { name: 'é'.repeat(128), bytes },
      { name: 'a.lib', bytes: bytes.buffer }, { name: 'a.lib', bytes: new Uint8Array() }, { name: 'a.lib', bytes: new Uint8Array(CONVERT_MAX_BYTES + 1) }, { name: 'a.lib', bytes, x: 1 }]) {
      expect(parseConvertArgs(bad)).toBeNull();
    }
  });
  it('reads the engine\'s three answers closed', () => {
    expect(readConverted(JSON.stringify({ format: 'EAGLE', symbols: [{ name: 'R', text: DOC }] }))).toEqual({ format: 'EAGLE', symbols: [{ name: 'R', text: DOC }] });
    expect(readConverted(JSON.stringify({ error: 'too_large' }))).toEqual({ error: 'too_large' });
    expect(readConverted(JSON.stringify({ error: 'unreadable', message: 'no reader takes this file' }))).toEqual({ error: 'unreadable', message: 'no reader takes this file' });
    for (const bad of ['', '{', JSON.stringify({ format: '', symbols: [] }), JSON.stringify({ format: 'KiCad', symbols: [{ name: 'R' }] }), JSON.stringify({ error: 'other' }),
      JSON.stringify({ format: 'KiCad', symbols: Array.from({ length: 2001 }, () => ({ name: 'R', text: DOC })) })]) {
      expect(readConverted(bad)).toBeNull();
    }
  });
});

describe('symbol.forEditor\'s answer and lib.update', () => {
  it('reads the placed symbol as text', () => {
    expect(readForEditor(JSON.stringify({ name: 'R', libId: 'Device:R', text: DOC }))).toEqual({ name: 'R', libId: 'Device:R', text: DOC });
    expect(readForEditor('')).toBeNull();
    expect(readForEditor(JSON.stringify({ name: 'R', libId: 'Device:R' }))).toBeNull();
  });
  it('takes a nickname and 1 to 64 names, and reads the queue and the done event', () => {
    expect(parseLibUpdateArgs({ lib: 'board_parts', names: ['R'] })).toEqual({ lib: 'board_parts', names: ['R'] });
    for (const bad of [{ lib: 'a:b', names: ['R'] }, { lib: '', names: ['R'] }, { lib: 'a', names: [] }, { lib: 'a', names: ['R', 'R'] }, { lib: 'a', names: Array.from({ length: 65 }, (_, i) => `R${i}`) }, { lib: 'a', names: [''] }]) {
      expect(parseLibUpdateArgs(bad), JSON.stringify(bad).slice(0, 60)).toBeNull();
    }
    expect(readLibUpdateQueued('{"ok":true,"queued":true}')).toBe(true);
    expect(readLibUpdateQueued('{"ok":false,"error":"no schematic frame"}')).toBe(false);
    expect(readLibUpdateDone({ ok: true, updated: 4, missing: [] })).toEqual({ updated: 4, missing: [] });
    expect(readLibUpdateDone({ ok: true, updated: -1, missing: [] })).toBeNull();
    expect(readLibUpdateDone({ ok: true, updated: 1 })).toBeNull();
  });
});
