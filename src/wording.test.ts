// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// Owner rulings R15 and I7: nothing the island renders or emits speaks of a
// download, and ev.state.detail never carries loader or engine status text.
import { describe, expect, it } from 'vitest';

const raw = (m: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [k, String(v)]));

// theme.css is left out: vitest's CSS handling hands a raw import back empty,
// and the stylesheet carries no text of its own (no content: strings).
const sources: Record<string, string> = {
  ...raw(import.meta.glob(['./*.ts', '!./*.test.ts'], { query: '?raw', import: 'default', eager: true })),
  ...raw(import.meta.glob(['../bridge/*.ts', '!../bridge/*.test.ts'], { query: '?raw', import: 'default', eager: true })),
  ...raw(import.meta.glob(['../index.html', '../PROTOCOL.md'], { query: '?raw', import: 'default', eager: true })),
};

describe('the island wording', () => {
  it('reads every island source', () => {
    for (const f of ['./main.ts', './screens.ts', './window-open.ts', '../bridge/responder.ts', '../index.html', '../PROTOCOL.md']) {
      expect(sources[f]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('has no download wording in any of its own sources', () => {
    expect(Object.keys(sources).filter((f) => /download/i.test(sources[f]))).toEqual([]);
  });

  it('never forwards the loader status line to the host', () => {
    const onStatus = sources['./main.ts'].split('\n').filter((l) => /\bonStatus\s*:/.test(l));
    expect(onStatus).toHaveLength(1);
    expect(onStatus[0]).not.toMatch(/emit|showScreen/);
  });
});
