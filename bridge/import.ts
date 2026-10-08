// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// project.import's engine side (PROTOCOL.md): open a foreign board through the
// engine's own open (each importer's CanReadBoard picks it by extension and
// content), answer the importer's own dialogs, and report what it logged.
//
// Measured on the local pair (spike 2026-10-02, island v0.2.3-cc3):
// - The board editor's progress reporter ("Load PCB") is a plain wxDialog with
//   a gauge and a Cancel button; it stays up under the other dialogs.
// - Eagle, CADSTAR and PADS ask for a layer mapping ("Edit Mapping of Imported
//   Layers"): keys do nothing there, OK is refused while required layers are
//   unmatched; Auto-Match Layers, then OK, lets the load finish.
// - A wxLog report ("KiCad PCB Editor Warning" or "... Information", a
//   collapsible details pane under a multi-line report) follows within about
//   10 ms of the open resolving; OK closes it. Its lines also reach the
//   frame's console as "[wxLog][LEVEL] text", where the island reads them in full.
// - Dialog buttons are DOM <button> elements (wx-dom.js): a click() on one is
//   what a press is, so no pointer is synthesized.
// - Module.kicadOpenFile resolves true on an import and false on a refusal
//   ("File format is not supported", or Cancel on "Save Changes?").
import { normalizePath } from '../src/stage';
import { isProgressDialog, plainLabel, visibleDialogs, type DialogView, type ModalWindow, type WxElement } from './modal';

/** The extensions the engine's board importers read at the pin (each importer's GetBoardFileDesc). */
export const IMPORT_EXTENSIONS = ['.brd', '.cpa', '.json', '.zip', '.asc', '.pcb', '.txt', '.fab'] as const;
/** The answer's warnings: at most this many lines, each at most WARNING_CHARS characters. */
export const MAX_WARNINGS = 40;
export const WARNING_CHARS = 200;

/** The import's waits, in ms (the responder's timing holds them; measured above). */
export interface ImportTiming {
  /** The whole import's bound, from the open call to the converted board's save. */
  importMs: number;
  /** How often the dialogs are read while the import runs. */
  importPollMs: number;
  /** Once the open resolved with nothing up, how long nothing more may show (the log report follows within about 10 ms). */
  importQuietMs: number;
  /** The pause between two presses in one dialog (Auto-Match Layers, then OK), and before a press is tried again. */
  importStepMs: number;
  /** After a press on OK, how long the layer mapping may stay up before it counts as refused. */
  importRefusedMs: number;
  /** On expiry, how long the island goes on closing dialogs before it answers. */
  importCloseMs: number;
}

/** A source path the engine can import: one of IMPORT_EXTENSIONS, in any case. */
export function importable(path: string): boolean {
  const lower = path.toLowerCase();
  return IMPORT_EXTENSIONS.some((ext) => lower.endsWith(ext) && lower.length > ext.length && !lower.endsWith(`/${ext}`));
}

/** Where the converted board is saved: `<stem>.kicad_pcb` beside the source, or null when that is no valid path. */
export function importTarget(source: string): string | null {
  const path = normalizePath(source);
  if (path == null || !importable(path)) return null;
  const dot = path.lastIndexOf('.');
  return normalizePath(`${path.slice(0, dot)}.kicad_pcb`);
}

type DomRect = { left: number; top: number; width: number; height: number };
type DomButton = { textContent: string | null; getBoundingClientRect(): DomRect; click(): void };
type DomWindow = { getBoundingClientRect(): DomRect; querySelector(sel: string): unknown };
type DomDoc = { querySelectorAll?(sel: string): ArrayLike<unknown> };
export type ImportWindow = ModalWindow & { document?: DomDoc; console?: Console; Module?: unknown };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const all = <T>(doc: DomDoc | undefined, sel: string): T[] => {
  try { return Array.from((doc?.querySelectorAll?.(sel) ?? []) as ArrayLike<T>); } catch { return []; }
};
const near = (a: number, b: number, slack: number): boolean => Math.abs(a - b) <= slack;

/** The window div wx.js made for a dialog: its box is the dialog's box. */
function windowOf(w: ImportWindow, d: WxElement): DomWindow | null {
  for (const win of all<DomWindow>(w.document, '[id^="window-"]')) {
    try {
      const r = win.getBoundingClientRect();
      if (near(r.left, d.screenX, 2) && near(r.top, d.screenY, 2) && near(r.width, d.width, 2) && near(r.height, d.height, 2)) return win;
    } catch { /* a window that throws is not this one */ }
  }
  return null;
}

/** The dialog's title as its title bar shows it, or '' when wx drew none. */
export function dialogTitle(w: ImportWindow, v: DialogView): string {
  const t = windowOf(w, v.dialog)?.querySelector('.window-titlebar-text') as { textContent?: string | null } | null | undefined;
  return (t?.textContent ?? '').trim();
}

/** The dialog's visible buttons and static texts, as wx shows them. */
const buttonsOf = (v: DialogView): WxElement[] => v.parts.filter((e) => e.typeName === 'wxButton');
const textsOf = (v: DialogView): string[] => v.parts.filter((e) => e.typeName === 'wxStaticText').map((e) => (e.label ?? '').replace(/\s+/g, ' ').trim()).filter((s) => s !== '');
const button = (v: DialogView, label: string): WxElement | undefined => buttonsOf(v).find((b) => plainLabel(b.label ?? '').trim() === label);

/**
 * Presses a registry button: the DOM <button> wx-dom.js made for it (its text,
 * and its center within 3 px of the registry's) gets a click(), which wx-dom
 * turns into the button's own event. Answers whether one was found.
 */
export function pressButton(w: ImportWindow, b: WxElement): boolean {
  const label = plainLabel(b.label ?? '').trim();
  for (const el of all<DomButton>(w.document, 'button.wx-dom-control')) {
    try {
      if ((el.textContent ?? '').trim() !== label) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || !near(r.left + r.width / 2, b.centerX, 3) || !near(r.top + r.height / 2, b.centerY, 3)) continue;
      el.click();
      return true;
    } catch { /* a button that throws is skipped */ }
  }
  return false;
}

/**
 * Closes a dialog without accepting anything it asks: Cancel, No or Close when
 * it has one, else its only button (a message box's OK), else the close box
 * of its title bar (wx closes a modal dialog as canceled). Never Discard,
 * never Save. Answers whether anything was pressed.
 */
export function closeDialog(w: ImportWindow, v: DialogView): boolean {
  const buttons = buttonsOf(v);
  const pick = ['Cancel', 'No', 'Close'].map((l) => button(v, l)).find((b) => b != null) ?? (buttons.length === 1 ? buttons[0] : undefined);
  if (pick != null && pressButton(w, pick)) return true;
  const close = windowOf(w, v.dialog)?.querySelector('.window-titlebar-close') as { click?: () => void } | null | undefined;
  if (typeof close?.click !== 'function') return false;
  try { close.click(); return true; } catch { return false; }
}

export type DialogKind = 'progress' | 'layers' | 'report' | 'other';

/**
 * What a dialog is to the import: the progress reporter (left alone), the
 * layer mapping (Auto-Match Layers, then OK), a wxLog report (OK: a
 * collapsible details pane, or a message box titled "<app> Information",
 * "... Warning" or "... Error" with OK alone), or anything else.
 */
export function classify(v: DialogView, title: string): DialogKind {
  if (isProgressDialog(v)) return 'progress';
  if (button(v, 'Auto-Match Layers') != null) return 'layers';
  if (v.parts.some((e) => /CollapsiblePane/.test(e.typeName))) return 'report';
  const buttons = buttonsOf(v);
  if (/\S (Information|Warning|Error)$/.test(title) && buttons.length === 1 && button(v, 'OK') != null) return 'report';
  return 'other';
}

/** The wxLog levels a log report lists; DEBUG and TRACE lines are the engine's own chatter. */
const QUIET_LEVELS = new Set(['DEBUG', 'TRACE', 'STATUS', 'PROGRESS']);
const LOG_LINE = /^\[wxLog\]\[([A-Z]+)\] ([\s\S]*)$/;
const CONSOLE_KEYS = ['log', 'info', 'warn', 'error', 'debug'] as const;

/** One report line: whitespace folded, trimmed, at most WARNING_CHARS characters. */
export function reportLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, WARNING_CHARS);
}

/** Report lines, each once, in order, at most MAX_WARNINGS. */
export function reportLines(texts: readonly string[]): string[] {
  const out: string[] = [];
  for (const t of texts) {
    const line = reportLine(t);
    if (line !== '' && !out.includes(line)) out.push(line);
    if (out.length >= MAX_WARNINGS) break;
  }
  return out;
}

/**
 * Listens to the frame's console for the engine's "[wxLog][LEVEL] text" lines
 * (the engine's log target writes each one there before its report shows it)
 * and keeps the ones a log report lists. stop() puts back each console method
 * it replaced, unless something replaced it since.
 */
export function tapEngineLog(w: ImportWindow): { lines(): string[]; stop(): void } {
  const kept: string[] = [];
  const c = w.console as unknown as Record<string, unknown> | undefined;
  const put: Array<{ key: string; orig: unknown; wrap: unknown }> = [];
  if (c != null) {
    for (const key of CONSOLE_KEYS) {
      const orig = c[key];
      if (typeof orig !== 'function') continue;
      const wrap = function (this: unknown, ...args: unknown[]): unknown {
        try {
          const m = typeof args[0] === 'string' ? LOG_LINE.exec(args[0]) : null;
          if (m != null && !QUIET_LEVELS.has(m[1])) kept.push(m[2]);
        } catch { /* the tap never breaks a console call */ }
        return (orig as (...a: unknown[]) => unknown).apply(this, args);
      };
      c[key] = wrap;
      put.push({ key, orig, wrap });
    }
  }
  return {
    lines: () => [...kept],
    stop: () => { if (c != null) for (const p of put) if (c[p.key] === p.wrap) c[p.key] = p.orig; },
  };
}

export type DriveResult = { ok: true; warnings: string[] } | { ok: false; message: string };

/**
 * Opens `abs` through Module.kicadOpenFile and answers the import's dialogs
 * until the load is over and nothing has shown for timing.importQuietMs, or
 * until `deadline`. On success the warnings are the log report's lines; any
 * other dialog fails the import, named, and is closed; so is every dialog on
 * expiry. `closed()` ends the drive at once (the frame is going away).
 */
export async function driveImport(w: ImportWindow, abs: string, opts: { deadline: number; timing: ImportTiming; closed: () => boolean; engineBusy: () => boolean }): Promise<DriveResult> {
  const t = opts.timing;
  const mod = w.Module as { kicadOpenFile?: (p: string) => unknown } | undefined;
  if (typeof mod?.kicadOpenFile !== 'function') return { ok: false, message: 'kicadOpenFile is missing' };
  const tap = tapEngineLog(w);
  /** The open's answer: pending until its Promise settles. */
  let opened: 'pending' | 'refused' | 'imported' | 'rejected' = 'pending';
  let failure: string | null = null;
  const reported: string[] = [];
  /** Per dialog id: when the island last pressed in it, and the layer mapping's two steps. */
  const pressed = new Map<string, { at: number; auto?: number; ok?: number }>();
  try {
    let ret: unknown;
    try { ret = mod.kicadOpenFile(abs); } catch (err) { return { ok: false, message: `kicadOpenFile threw: ${String(err)}`.slice(0, WARNING_CHARS) }; }
    Promise.resolve(ret).then((v) => { opened = v === true ? 'imported' : 'refused'; }, () => { opened = 'rejected'; });

    let quietSince: number | null = null;
    for (;;) {
      if (opts.closed()) return { ok: false, message: 'the frame closed' };
      const now = Date.now();
      if (now >= opts.deadline) break;
      let shown = false;
      for (const v of visibleDialogs(w)) {
        const title = dialogTitle(w, v);
        const kind = classify(v, title);
        if (kind === 'progress') continue;
        shown = true;
        // wx's ids are addresses: a later dialog may reuse one, so the kind is part of the key.
        const id = `${String(v.dialog.id)}:${kind}`;
        const state = pressed.get(id) ?? { at: 0 };
        pressed.set(id, state);
        if (now - state.at < t.importStepMs) continue;   // the last press is still landing
        if (kind === 'layers') {
          const auto = button(v, 'Auto-Match Layers');
          const ok = button(v, 'OK');
          if (state.auto == null && auto != null && pressButton(w, auto)) { state.auto = now; state.at = now; continue; }
          if (state.ok == null && ok != null && pressButton(w, ok)) { state.ok = now; state.at = now; continue; }
          if (state.ok != null && now - state.ok < t.importRefusedMs) continue;
          // OK was refused (a required layer stays unmatched) or never found: a failure, closed.
          failure ??= `the layer mapping was refused (${title || 'layer mapping'})`;
          if (closeDialog(w, v)) state.at = now;
          continue;
        }
        if (kind === 'report') {
          reported.push(...textsOf(v));
          const ok = button(v, 'OK');
          if (ok != null && pressButton(w, ok)) { state.at = now; continue; }
          if (closeDialog(w, v)) state.at = now;
          continue;
        }
        failure ??= `dialog "${title || v.dialog.typeName}"${textsOf(v).length > 0 ? `: ${textsOf(v).join(' ')}` : ''}`.slice(0, WARNING_CHARS);
        if (closeDialog(w, v)) state.at = now;
      }
      if (!shown && opened !== 'pending' && !opts.engineBusy()) {
        quietSince ??= now;
        if (now - quietSince >= t.importQuietMs) {
          if (failure != null) return { ok: false, message: failure };
          const lines = reportLines(tap.lines().length > 0 ? tap.lines() : reported);
          if (opened === 'imported') return { ok: true, warnings: lines };
          // A refusal: the first line the engine logged says why, when it logged one.
          const why = opened === 'rejected' ? 'the engine\'s open failed' : 'the engine could not import the file';
          return { ok: false, message: (lines.length > 0 ? `${why}: ${lines[0]}` : why).slice(0, WARNING_CHARS) };
        }
      } else {
        quietSince = null;
      }
      await sleep(t.importPollMs);
    }

    // Expired: every dialog is closed (the progress reporter's Cancel stops the
    // load), and a dialog that canceling raises is closed too, before the answer.
    const stopBy = Date.now() + t.importCloseMs;
    const tried = new Map<string, number>();
    while (!opts.closed() && Date.now() < stopBy) {
      const up = visibleDialogs(w);
      if (up.length === 0) break;
      const now = Date.now();
      for (const v of up) {
        const id = String(v.dialog.id);
        if (now - (tried.get(id) ?? 0) < t.importStepMs) continue;
        if (closeDialog(w, v)) tried.set(id, now);
      }
      await sleep(t.importPollMs);
    }
    const left = visibleDialogs(w).length;
    const what = failure ?? `the import took longer than ${t.importMs / 1000} s`;
    return { ok: false, message: left > 0 ? `${what}; a dialog stayed up` : what };
  } finally {
    tap.stop();
  }
}
