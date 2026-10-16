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
//
// A schematic (island v0.2.3-cc8) goes through Module.kicadImportSchematic,
// KiCad's own File > Import path (eeschema files-io.cpp importFile at the pin).
// Measured 2026-10-15 on the engine's fourth build (KiCad's qa eDP adapter
// project, Chromium and Firefox; PROTOCOL.md "Altium on engine"):
// - Its progress reporter is the same plain wxDialog with a gauge and a Cancel
//   button, known by those parts ("Import Schematic" is its title in KiCad's source).
// - When the importer reported anything, DIALOG_HTML_REPORTER shows its lines
//   modal inside the call: a wxDialog titled "Report" holding a wxHtmlWindow and
//   a wxButton (its OK). wxHTML draws the lines on a canvas, so neither the DOM
//   nor the element registry holds their text, and the importer never wxLogs
//   them: the island presses OK and says only that KiCad reported issues
//   (SCHEMATIC_ISSUES_LINE).
// - An IO_ERROR or an exception shows KiCad's error box ("Error", the message
//   over a details pane and OK): the import fails, named by its text (seen on
//   the build before, which refused both eDP sheets with "Header already parsed").
// - The call resolves true only when a converted sheet holds items (KiCad's source).
// An Altium board (.pcbdoc) converts from the engine's fifth build on (kicad
// cc/main 0e0b3f54, measured 2026-10-16); the builds before trapped in KIID's
// string constructor during the component parse, right after the layer mapping.
import { normalizePath } from '../src/stage';
import type { Frame } from '../src/types';
import { isProgressDialog, plainLabel, visibleDialogs, type DialogView, type ModalWindow, type WxElement } from './modal';

/**
 * The extensions the engine's board importers read at the pin (each importer's
 * GetBoardFileDesc): Eagle or Allegro (.brd, told apart by content), CADSTAR,
 * EasyEDA Std and Pro, PADS, P-CAD or gEDA, Fabmaster, and since v0.2.3-cc8
 * Altium Designer, Circuit Maker, Circuit Studio and SolidWorks.
 */
export const IMPORT_EXTENSIONS_PCB = ['.brd', '.cpa', '.json', '.zip', '.asc', '.pcb', '.txt', '.fab', '.pcbdoc', '.cmpcbdoc', '.cspcbdoc', '.swpcbdoc'] as const;
/**
 * The importer each schematic extension names, as KiCad's own type string
 * (SCH_IO_MGR::ShowType, the string kicadImportSchematic reads): Altium,
 * Eagle, CADSTAR, LTspice, EasyEDA Std and EasyEDA Pro.
 */
export const SCHEMATIC_TYPES = Object.freeze({
  '.schdoc': 'Altium',
  '.sch': 'EAGLE',
  '.csa': 'CADSTAR Schematic Archive',
  '.asc': 'LTspice',
  '.json': 'EasyEDA (JLCEDA) Std',
  '.zip': 'EasyEDA (JLCEDA) Pro',
} as const);
/** The extensions a sch frame imports. */
export const IMPORT_EXTENSIONS_SCH = Object.keys(SCHEMATIC_TYPES) as ReadonlyArray<keyof typeof SCHEMATIC_TYPES>;
/** An Altium project's sheets and its project file. */
export const ALTIUM_SHEET = '.schdoc';
export const ALTIUM_PROJECT = '.prjpcb';
/** Each frame's own KiCad document: what project.open opens and an import's converted file. */
export const DOCUMENT_EXTENSION: Readonly<Record<Frame, string>> = Object.freeze({ pcb: '.kicad_pcb', sch: '.kicad_sch' });
/** The answer's warnings: at most this many lines, each at most WARNING_CHARS characters. */
export const MAX_WARNINGS = 40;
export const WARNING_CHARS = 200;
/** The warning a schematic import answers when KiCad showed its issues report ("Report"), whose lines the island cannot read. */
export const SCHEMATIC_ISSUES_LINE = 'KiCad reported issues while importing the schematic; the converted sheets may be incomplete.';

/**
 * KiCad's empty sheet (tests/fixtures/blank/blank.kicad_sch, with `uuid`),
 * which a schematic import opens at its target first: KiCad's import names
 * the converted root after the project loaded, and an open loads
 * <stem>.kicad_pro beside the file. The format version is KiCad 8's on
 * purpose: an older file opens without a prompt (the libs e2e opens this one),
 * a newer one than the engine's raises KiCad's newer-file prompt.
 */
export function emptySheet(uuid: string): string {
  return `(kicad_sch\n\t(version 20231120)\n\t(generator "eeschema")\n\t(generator_version "8.0")\n\t(uuid "${uuid}")\n\t(paper "A4")\n\t(lib_symbols)\n\t(sheet_instances\n\t\t(path "/"\n\t\t\t(page "1")\n\t\t)\n\t)\n)\n`;
}

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

/** The path ends with `ext` (lower case, with its dot), in any case, after a non-empty name. */
export function hasExtension(path: string, ext: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(ext) && lower.length > ext.length && !lower.endsWith(`/${ext}`);
}

/** A source path the engine can import in this frame: one of the frame's extensions, in any case. */
export function importable(path: string, frame: Frame): boolean {
  const exts: readonly string[] = frame === 'pcb' ? IMPORT_EXTENSIONS_PCB : IMPORT_EXTENSIONS_SCH;
  return exts.some((ext) => hasExtension(path, ext));
}

/**
 * Where the converted file is saved: `<stem>.kicad_pcb` beside a board,
 * `<stem>.kicad_sch` beside a schematic or, for an Altium project, beside its
 * `.PrjPcb` (KiCad names the root after the project). Null when the source is
 * none of those, or the path would be no valid one.
 */
export function importTarget(source: string, frame: Frame): string | null {
  const path = normalizePath(source);
  if (path == null) return null;
  if (!importable(path, frame) && !(frame === 'sch' && hasExtension(path, ALTIUM_PROJECT))) return null;
  return normalizePath(`${path.slice(0, path.lastIndexOf('.'))}${DOCUMENT_EXTENSION[frame]}`);
}

/** Compares two paths by code point, as a wxString compares (UTF-16 order differs past U+FFFF). */
function byCodePoint(a: string, b: string): number {
  const x = Array.from(a, (c) => c.codePointAt(0) ?? 0);
  const y = Array.from(b, (c) => c.codePointAt(0) ?? 0);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

/** The engine export an import calls, and its arguments. */
export type ImportCall = { name: 'kicadOpenFile'; args: [path: string] } | { name: 'kicadImportSchematic'; args: [path: string, typeName: string, propsJson: string] };

/**
 * The engine call for a source staged under `root` (paths relative to it): a
 * board through kicadOpenFile; a schematic through kicadImportSchematic with
 * KiCad's type for its extension and no properties; an Altium project through
 * kicadImportSchematic("", "Altium", props), the props as KiCad's own project
 * import builds them (kicad/import_proj.cpp at the pin): `project_file`, the
 * `.PrjPcb`'s absolute path, then `sch0`, `sch1`, ... over every sheet's
 * absolute path, each once, in a std::set's order (code point order).
 */
export function importCall(frame: Frame, root: string, source: string, altium?: { project: string; sheets: readonly string[] }): ImportCall {
  const abs = (p: string): string => `${root}/${p}`;
  if (frame === 'pcb') return { name: 'kicadOpenFile', args: [abs(source)] };
  if (altium != null) {
    const props: Record<string, string> = { project_file: abs(altium.project) };
    [...new Set(altium.sheets.map(abs))].sort(byCodePoint).forEach((p, i) => { props[`sch${i}`] = p; });
    return { name: 'kicadImportSchematic', args: ['', SCHEMATIC_TYPES[ALTIUM_SHEET], JSON.stringify(props)] };
  }
  const ext = IMPORT_EXTENSIONS_SCH.find((e) => hasExtension(source, e));
  return { name: 'kicadImportSchematic', args: [abs(source), ext == null ? '' : SCHEMATIC_TYPES[ext], '{}'] };
}

type DomRect = { left: number; top: number; width: number; height: number };
type DomButton = { textContent: string | null; getBoundingClientRect(): DomRect; click(): void };
type DomWindow = { getBoundingClientRect(): DomRect; querySelector(sel: string): unknown };
type DomDoc = { querySelectorAll?(sel: string): ArrayLike<unknown> };
export type ImportWindow = ModalWindow & { document?: DomDoc; console?: Console; Module?: KicadImportExports };

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

export type DialogKind = 'progress' | 'layers' | 'report' | 'issues' | 'other';

/** The title of KiCad's own error box (DisplayErrorMessage): in a schematic import its details pane never makes it a report. */
const ERROR_TITLE = 'Error';
/** The title of DIALOG_HTML_REPORTER at the pin (its default; importFile sets none). */
const ISSUES_TITLE = 'Report';

/**
 * What a dialog is to the import: the progress reporter (left alone), the
 * layer mapping (Auto-Match Layers, then OK), in a schematic import KiCad's
 * error box ("Error", a failure even with a details pane; a board import keeps
 * the rules it had before), a wxLog report (OK: a collapsible details
 * pane, or a message box titled "<app> Information", "... Warning" or "...
 * Error" with OK alone), a schematic importer's issues report (OK alone, under
 * an HTML box or titled "Report"; only when `schematic`, the board importers
 * show none), or anything else.
 */
export function classify(v: DialogView, title: string, schematic = false): DialogKind {
  if (isProgressDialog(v)) return 'progress';
  if (button(v, 'Auto-Match Layers') != null) return 'layers';
  if (schematic && title === ERROR_TITLE) return 'other';
  const okAlone = buttonsOf(v).length === 1 && button(v, 'OK') != null;
  if (schematic && okAlone && (title === ISSUES_TITLE || v.parts.some((e) => /HtmlWindow/i.test(e.typeName)))) return 'issues';
  if (v.parts.some((e) => /CollapsiblePane/.test(e.typeName))) return 'report';
  if (/\S (Information|Warning|Error)$/.test(title) && okAlone) return 'report';
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

/** `stopped`: the engine call trapped or left its load guard held, so the engine is dead (nothing more may enter it). */
export type DriveResult = { ok: true; warnings: string[] } | { ok: false; message: string; stopped?: true };

/**
 * A WebAssembly trap: the engine's code stopped mid-call (RuntimeError:
 * unreachable, a memory access out of bounds; JSPI's SuspendError). A trap
 * runs no C++ destructor, so the load's guard and its progress dialog are left
 * behind, and the instance's state is not to be trusted. Duck-typed by name
 * too, for an error that crossed a realm.
 */
export function isEngineTrap(err: unknown): boolean {
  if (typeof WebAssembly !== 'undefined' && typeof WebAssembly.RuntimeError === 'function' && err instanceof WebAssembly.RuntimeError) return true;
  const name = err != null && typeof err === 'object' ? (err as { name?: unknown }).name : undefined;
  return name === 'RuntimeError' || name === 'SuspendError';
}

/** An engine error in one line: "RuntimeError: unreachable". */
function errorLine(err: unknown): string {
  try { return String(err).replace(/\s+/g, ' ').trim() || 'unknown error'; } catch { return 'unknown error'; }
}

/**
 * Runs the import's engine call (`call`: kicadOpenFile for a board,
 * kicadImportSchematic for a schematic) and answers its dialogs until the
 * import is over and nothing has shown for timing.importQuietMs, or until
 * `deadline`. On success the warnings are the log report's lines, and
 * SCHEMATIC_ISSUES_LINE when a schematic's issues report ("Report") showed; any other
 * dialog fails the import, named, and is closed; so is every dialog on expiry.
 * A call that rejects as a trap, or that leaves the load guard held, ends the
 * drive at once with `stopped` and no dialog touched: the engine is dead, so
 * nothing more enters it (measured 2026-10-16: the Altium board's KIID trap
 * held its guard forever, and the drive used to wait out its whole bound).
 * `closed()` ends the drive at once (the frame is going away).
 */
export async function driveImport(w: ImportWindow, call: ImportCall, opts: { deadline: number; timing: ImportTiming; closed: () => boolean; engineBusy: () => boolean }): Promise<DriveResult> {
  const t = opts.timing;
  const mod = w.Module;
  const start = call.name === 'kicadOpenFile'
    ? (mod?.kicadOpenFile == null ? null : () => mod.kicadOpenFile?.(...call.args))
    : (mod?.kicadImportSchematic == null ? null : () => mod.kicadImportSchematic?.(...call.args));
  if (start == null || typeof mod?.[call.name] !== 'function') return { ok: false, message: `${call.name} is missing` };
  const tap = tapEngineLog(w);
  /** The call's answer: pending until its Promise settles. */
  // Asserted, not annotated: it is set in the call's callbacks, so the checks below must not narrow it to 'pending'.
  let opened = 'pending' as 'pending' | 'refused' | 'imported' | 'rejected';
  let failure: string | null = null;
  const reported: string[] = [];
  /** A schematic's issues report ("Report") was pressed: its lines are on a canvas, so one line of the island's says so. */
  let issues = false;
  /** Per dialog id: when the island last pressed in it, and the layer mapping's two steps. */
  const pressed = new Map<string, { at: number; auto?: number; ok?: number }>();
  try {
    let ret: unknown;
    try { ret = start(); } catch (err) { return { ok: false, message: `${call.name} threw: ${String(err)}`.slice(0, WARNING_CHARS) }; }
    /** What the call rejected with. */
    let rejection: unknown = null;
    Promise.resolve(ret).then((v) => { opened = v === true ? 'imported' : 'refused'; }, (err: unknown) => { rejection = err; opened = 'rejected'; });

    let quietSince: number | null = null;
    for (;;) {
      if (opts.closed()) return { ok: false, message: 'the frame closed' };
      if (opened === 'rejected' && (isEngineTrap(rejection) || opts.engineBusy())) {
        return { ok: false, message: `the engine stopped: ${errorLine(rejection)}`.slice(0, WARNING_CHARS), stopped: true };
      }
      const now = Date.now();
      if (now >= opts.deadline) break;
      let shown = false;
      for (const v of visibleDialogs(w)) {
        const title = dialogTitle(w, v);
        const kind = classify(v, title, call.name === 'kicadImportSchematic');
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
        if (kind === 'report' || kind === 'issues') {
          reported.push(...textsOf(v));
          if (kind === 'issues') issues = true;
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
          if (opened === 'imported') return { ok: true, warnings: issues ? reportLines([SCHEMATIC_ISSUES_LINE, ...lines]) : lines };
          // A refusal: the first line the engine logged says why, when it logged one;
          // a rejection that left the engine idle (no trap) is named by its error.
          const why = opened === 'rejected' ? `the engine's open failed (${errorLine(rejection)})` : 'the engine could not import the file';
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
