// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The island's own screens, plain DOM into #screen (createElement and
// textContent only). Preflight and loading are ONE quiet animation: a small
// mark and a thin bar that sweeps until progress arrives, then fills, and
// sweeps again once the fill is complete (compile and engine start report no
// progress, and a full static bar reads as stalled). No
// progress sentence, no dialog, no button (owner ruling R15).
// Every screen carries the "Licences and source" link.
export type ScreenKind = 'preflight' | 'loading' | 'blocked' | 'fatal' | 'toplevel';

export const SCREEN_COPY = {
  toplevel: 'This page is the editor engine. Open it from circuitcenter.ai.',
  blocked: 'This browser cannot run the editor yet.',
  fatal: 'The editor stopped. Reload the page to start again.',
  licences: 'Licences and source',
} as const;

const LOADER_LABEL = 'Starting the editor';
const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_DETAIL = 240;

/** Strings from the engine or the loader may carry dashes; the island renders none. */
export function cleanDetail(text: string): string {
  const one = text.replace(/[\u2013\u2014]/g, ',').replace(/\s+/g, ' ').trim();
  return one.length > MAX_DETAIL ? `${one.slice(0, MAX_DETAIL - 1)}…` : one;
}

let current: ScreenKind | null = null;
let bar: HTMLElement | null = null;
let fill: HTMLElement | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function licencesLink(): HTMLAnchorElement {
  const a = el('a', 'cc-licences', SCREEN_COPY.licences);
  a.href = `${import.meta.env.BASE_URL}licenses.html`;
  return a;
}

/** A via: the ring and the drill, drawn in the silk ink. */
function mark(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'cc-mark');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const ring = document.createElementNS(SVG_NS, 'circle');
  for (const [k, v] of [['cx', '12'], ['cy', '12'], ['r', '8.5'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '2']]) ring.setAttribute(k, v);
  const drill = document.createElementNS(SVG_NS, 'circle');
  for (const [k, v] of [['cx', '12'], ['cy', '12'], ['r', '3.5'], ['fill', 'currentColor']]) drill.setAttribute(k, v);
  svg.append(ring, drill);
  return svg;
}

export type BarMode = 'sweep' | 'fill' | 'settle';

/** No number yet: sweep. A fraction below 1: fill to it. Complete: sweep again until hideScreens. */
export function barMode(progress?: number): BarMode {
  if (progress == null || !Number.isFinite(progress)) return 'sweep';
  return progress >= 1 ? 'settle' : 'fill';
}

function setProgress(progress?: number): void {
  if (bar == null || fill == null) return;
  const mode = barMode(progress);
  bar.classList.toggle('is-determinate', mode === 'fill');
  bar.classList.toggle('is-settling', mode === 'settle');   // reduced motion: stays full
  if (mode === 'fill') fill.style.transform = `scaleX(${Math.max(0, progress as number)})`;
  else fill.style.removeProperty('transform');
}

function buildLoader(root: HTMLElement): void {
  const status = el('div', 'cc-loader');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-label', LOADER_LABEL);
  bar = el('div', 'cc-bar');
  bar.setAttribute('aria-hidden', 'true');
  fill = el('div', 'cc-bar-fill');
  bar.append(fill);
  status.append(mark(), bar);
  root.append(status, licencesLink());
}

function buildMessage(root: HTMLElement, kind: 'blocked' | 'fatal' | 'toplevel', detail?: string): void {
  const card = el('div', 'cc-card');
  if (kind !== 'toplevel') card.setAttribute('role', 'alert');
  card.append(el('p', 'cc-copy', SCREEN_COPY[kind]));
  if (detail != null && detail !== '') card.append(el('p', 'cc-detail', cleanDetail(detail)));
  card.append(licencesLink());
  root.append(card);
}

export function showScreen(kind: ScreenKind, detail?: string, progress?: number): void {
  const root = document.getElementById('screen');
  if (root == null) return;
  const quiet = kind === 'preflight' || kind === 'loading';
  // Preflight to loading, and every progress tick, keep the same animation running.
  if (quiet && (current === 'preflight' || current === 'loading') && bar != null) {
    current = kind;
    setProgress(progress);
    return;
  }
  root.replaceChildren();
  bar = null;
  fill = null;
  root.className = `cc-screen cc-screen-${quiet ? 'loading' : kind}`;
  if (quiet) {
    buildLoader(root);
    setProgress(progress);
  } else {
    buildMessage(root, kind, detail);
  }
  root.hidden = false;
  current = kind;
}

export function hideScreens(): void {
  const root = document.getElementById('screen');
  if (root == null) return;
  root.hidden = true;
  root.replaceChildren();
  bar = null;
  fill = null;
  current = null;
}
