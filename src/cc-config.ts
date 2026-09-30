// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import type { Frame, Theme } from './types';

export const PRODUCT_NAME = 'Circuit Center Editor';

/** The one parent origin per island hostname. Anything else refuses to boot. */
const PARENTS: Record<string, string> = {
  'editor.circuitcenter.ai': 'https://circuitcenter.ai',
  'editor.circuitcenter.localhost': 'http://circuitcenter.localhost',
};

export function parentOriginFor(hostname: string, port: string): string | null {
  if (hostname === 'editor.circuitcenter.localhost' && port !== '' && port !== '80') {
    // Playwright serves the pair on two ports: 4174 (island) and 4173 (page).
    return `http://circuitcenter.localhost:${Number(port) - 1}`;
  }
  return PARENTS[hostname] ?? null;
}

export function parseBoot(search: string): { frame: Frame; theme: Theme } {
  const q = new URLSearchParams(search);
  return { frame: q.get('frame') === 'pcb' ? 'pcb' : 'sch', theme: q.get('theme') === 'night' ? 'night' : 'day' };
}
