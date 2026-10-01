// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { describe, expect, it } from 'vitest';
import { createLicencesController, docName, LICENCES_PAGE, type LicencesState, type LicencesView } from './licences';

function fakeView() {
  const calls: string[] = [];
  const states: LicencesState[] = [];
  const view: LicencesView = {
    show: () => { calls.push('show'); },
    hide: () => { calls.push('hide'); },
    render: (s) => { states.push(s); },
  };
  return { view, calls, states };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('the licences overlay', () => {
  it('opens once, renders the licences page, and Escape closes it', async () => {
    const { view, calls, states } = fakeView();
    const asked: string[] = [];
    const c = createLicencesController(view, async (n) => { asked.push(n); return '<p>text</p>'; });
    expect(c.key('Escape')).toBe(false);   // closed: the key is the editor's
    c.open();
    c.open();
    await settle();
    expect(calls).toEqual(['show']);
    expect(asked).toEqual([LICENCES_PAGE, LICENCES_PAGE]);
    expect(states.at(-1)).toEqual({ kind: 'doc', name: LICENCES_PAGE, doc: 'html', body: '<p>text</p>' });
    expect(c.key('Enter')).toBe(false);
    expect(c.isOpen()).toBe(true);
    expect(c.key('Escape')).toBe(true);
    expect(c.isOpen()).toBe(false);
    expect(calls).toEqual(['show', 'hide']);
    c.close();
    expect(calls).toEqual(['show', 'hide']);
  });

  it('opens a text file beside it as text, and renders the failure note when a load fails', async () => {
    const { view, states } = fakeView();
    const c = createLicencesController(view, async (n) => { if (n === 'NOTICE.txt') return 'plain'; throw new Error('404'); });
    c.open('NOTICE.txt');
    await settle();
    expect(states.at(-1)).toEqual({ kind: 'doc', name: 'NOTICE.txt', doc: 'text', body: 'plain' });
    c.open('LICENSE.txt');
    await settle();
    expect(states.at(-1)).toEqual({ kind: 'failed', name: 'LICENSE.txt' });
  });

  it('drops a load that settles after the overlay closed or after a newer open', async () => {
    const { view, states } = fakeView();
    const pending: Array<(s: string) => void> = [];
    const c = createLicencesController(view, (n) => new Promise((r) => pending.push((s) => r(`${n}:${s}`))));
    c.open();
    c.open('NOTICE.txt');
    pending[0]('late');
    await settle();
    expect(states.filter((s) => s.kind === 'doc')).toEqual([]);
    pending[1]('now');
    await settle();
    expect(states.at(-1)).toMatchObject({ kind: 'doc', name: 'NOTICE.txt' });
    c.open();
    c.close();
    pending[2]('after close');
    await settle();
    expect(states.at(-1)).toMatchObject({ kind: 'loading', name: LICENCES_PAGE });
  });

  it('follows only bare file names beside the licences page', () => {
    expect(docName('LICENSE.txt')).toBe('LICENSE.txt');
    expect(docName('licenses.html')).toBe('licenses.html');
    for (const bad of [null, '', 'https://example.com/a.html', '//example.com/a.txt', '../index.html', 'a/b.txt', 'javascript:alert(1)', 'x.js', 'a.txt?x=1', '#top', '..html']) {
      expect(docName(bad)).toBeNull();
    }
    const { view, calls } = fakeView();
    const c = createLicencesController(view, async () => '');
    c.open('https://example.com/a.html');
    expect(calls).toEqual([]);
  });
});
