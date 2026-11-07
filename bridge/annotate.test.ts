// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { describe, expect, it } from 'vitest';
import { annotateJson, MAX_KEEP, MAX_NOTE_CHARS, MAX_NOTES, parseAnnotateArgs, readAnnotateDone, runNotes, runText } from './annotate';

const DIR = '/tmp/cc-annotate/4';
const R = 'ca2704bd-cd2e-427d-8825-1d89e09f5ad7';
const enc = (s: string) => new TextEncoder().encode(s);
const uuid = (i: number) => `00000000-0000-0000-0000-${i.toString(16).padStart(12, '0')}`;

describe('sheet.annotate args', () => {
  it('takes exactly a scope, an order, reset and the kept uuids, a uuid kept twice counted once', () => {
    expect(parseAnnotateArgs({ scope: 'all', order: 'x', reset: false, keep: [] })).toEqual({ scope: 'all', order: 'x', reset: false, keep: [] });
    expect(parseAnnotateArgs({ keep: [R, R], reset: true, order: 'y', scope: 'sheet' })).toEqual({ scope: 'sheet', order: 'y', reset: true, keep: [R] });
    expect(parseAnnotateArgs({ scope: 'all', order: 'x', reset: false, keep: Array.from({ length: MAX_KEEP }, (_, i) => uuid(i)) })?.keep).toHaveLength(4096);
  });

  it('refuses anything else, one key at a time', () => {
    const a = { scope: 'all', order: 'x', reset: false, keep: [] };
    for (const bad of [
      undefined, null, [], {},
      { scope: 'all', order: 'x', reset: false }, { ...a, extra: 1 },
      { ...a, scope: 'design' }, { ...a, scope: 'ALL' }, { ...a, order: 'z' }, { ...a, order: 1 },
      { ...a, reset: 'no' }, { ...a, keep: R }, { ...a, keep: [R.toUpperCase()] }, { ...a, keep: [1] }, { ...a, keep: [`${R}x`] },
      { ...a, keep: Array.from({ length: MAX_KEEP + 1 }, (_, i) => uuid(i)) },
    ]) expect(parseAnnotateArgs(bad), JSON.stringify(bad)?.slice(0, 60)).toBeNull();
  });

  it('hands kicadAnnotate the run, its folder and the args', () => {
    expect(JSON.parse(annotateJson(4, DIR, { scope: 'sheet', order: 'y', reset: true, keep: [R] }))).toEqual({ run: 4, dir: DIR, scope: 'sheet', order: 'y', reset: true, keep: [R] });
  });
});

describe('the run\'s record', () => {
  /** What engine run 10 wrote numbering Glasgow with one new "R?" (2026-11-07). */
  const done = { changes: [{ from: 'R?', sheetPath: '/', to: 'R61', uuid: R }], lines: [{ severity: 'error', text: 'Duplicate items U30E' }] };

  it('reads the record the engine writes, and nothing else', () => {
    expect(readAnnotateDone(enc(JSON.stringify(done)))).toEqual({ changes: [{ uuid: R, sheetPath: '/', from: 'R?', to: 'R61' }], lines: done.lines });
    expect(readAnnotateDone(enc(JSON.stringify({ changes: [], lines: [] })))).toEqual({ changes: [], lines: [] });
    const c = done.changes[0];
    for (const bad of [
      null, enc('{'), enc('[]'), enc(JSON.stringify({ changes: [] })), enc(JSON.stringify({ lines: [] })),
      enc(JSON.stringify({ ...done, changes: [{ ...c, uuid: 'R1' }] })),
      enc(JSON.stringify({ ...done, changes: [{ ...c, sheetPath: 'root' }] })),
      enc(JSON.stringify({ ...done, changes: [{ ...c, to: '' }] })),
      enc(JSON.stringify({ ...done, changes: [{ ...c, to: 'R'.repeat(65) }] })),
      enc(JSON.stringify({ ...done, changes: [{ ...c, from: 1 }] })),
      enc(JSON.stringify({ ...done, lines: [{ severity: 'loud', text: 'x' }] })),
    ]) expect(readAnnotateDone(bad)).toBeNull();
  });

  it('notes the warning and error lines in order, the folder never named, bounded', () => {
    const lines = [
      { severity: 'action' as const, text: 'Updated R? to R61' },
      { severity: 'warning' as const, text: `Wrote ${DIR}/x` },
      { severity: 'info' as const, text: 'Done' },
      { severity: 'error' as const, text: 'Duplicate items U30E' },
    ];
    expect(runText(`a ${DIR}/b ${DIR}`, DIR)).toBe('a b ');
    expect(runNotes(lines, DIR)).toEqual(['Wrote x', 'Duplicate items U30E']);
    const many = Array.from({ length: MAX_NOTES + 5 }, () => ({ severity: 'warning' as const, text: 'w'.repeat(MAX_NOTE_CHARS + 10) }));
    const notes = runNotes(many, DIR);
    expect(notes).toHaveLength(MAX_NOTES);
    expect(notes.every((n) => n.length === MAX_NOTE_CHARS)).toBe(true);
  });
});
