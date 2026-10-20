// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// Selection, both ways (PROTOCOL.md ev.selected and select).
//
// Editor to host: the engine's own selection hook. kicadCollabPresenceStart
// (PCBJam's presence core, collab_presence_core.h at the pin) installs its
// canvas input hooks once, and registers the engine's collab document listener
// once (ensureBridge, on the document of that moment); after each left or right button release, key
// release or wheel on the canvas, and after each document change, it reads the
// selection once the event has been handled (CallAfter) and, when it differs
// from its last emit, calls window.kicadCollab.onSelection with it: a bare uuid
// array from the schematic editor, `{uuids, fpPaths}` from the board editor
// (fpPaths: each selected footprint's schematic path, KIID_PATH::AsString).
// A selection made through a DOM surface (KiCad's clarify-selection menu)
// raises no canvas event, so a short burst of reads follows each pointer or
// key release, as PCBJam's own read-only feed does (local-selection.ts). Every
// emit and read goes through one debounce: a burst is sent once, when it has
// settled, and only when it differs from the last selection sent.
//
// Host to editor: the engine's select by uuid (kicadCollabTestSelectByUuid,
// a PCBJam hook compiled into the release build: it finds the item, the board's
// by ResolveItem and the schematic's among the shown sheet's items, and queues
// the selection tool's AddItemToSel on the editor's loop, answering whether it
// found one) after its clear (kicadCollabTestClearSelection, queued the same
// way, so the two run in order). The request answers once the editor holds
// exactly the items found; with `zoom`, KiCad's Zoom to Selected Objects then
// fits the view to them (the key theme/user.hotkeys seeds for it).
import type { KeyPress } from '../src/keys';
import type { Frame } from '../src/types';

/** ev.selected's payload: the selected items' uuids and, on a board, the selected footprints' schematic paths. */
export interface Selection { uuids: string[]; fpPaths: string[] }

/** select's args, checked: the item uuids, the footprint paths, and whether to fit the view to them. */
export interface SelectArgs { uuids: string[]; fpPaths: string[]; zoom: boolean }

export interface SelectionTiming {
  /** How long a selection must hold before ev.selected sends it (a burst is sent once). Unmeasured. */
  selectSettleMs: number;
  /** The reads after a pointer or key release: at 0 ms, at this, and at three times this. */
  selectPullMs: number;
  /** select: how often the selection is read while the editor takes it, and how long it may take. */
  selectPollMs: number;
  selectMs: number;
  /** The bound on each engine call (the responder's applyMs). */
  applyMs: number;
}

/** The engine window as this module reaches it: the exports, the callback slots and its events. */
export type SelectionWindow = Pick<ToolWindow, 'Module'> & {
  kicadCollab?: Record<string, unknown> & { onSelection?: (json: string) => void };
  addEventListener?: (type: string, h: (e: Event) => void, capture?: boolean) => void;
  removeEventListener?: (type: string, h: (e: Event) => void, capture?: boolean) => void;
};

type SelectionExports = {
  kicadCollabPresenceStart?: () => unknown;
  kicadCollabGetSelection?: () => unknown;
  kicadCollabGetSelectionFull?: () => unknown;
  kicadCollabTestSelectByUuid?: (uuid: string) => unknown;
  kicadCollabTestClearSelection?: () => unknown;
};

/** The exports the select op needs, in the order they are checked. */
export const SELECT_EXPORTS = ['kicadCollabTestClearSelection', 'kicadCollabTestSelectByUuid', 'kicadCollabGetSelection'] as const;

/**
 * KiCad's Zoom to Selected Objects (common.Control.zoomFitSelection), which
 * has no default key: theme/user.hotkeys seeds Ctrl+Shift+Home for it, a key
 * no KiCad action takes at the pin (Home is Zoom to Fit, Ctrl+Home Zoom to Objects).
 */
export const ZOOM_SELECTION_KEY: KeyPress = { key: 'Home', code: 'Home', ctrl: true, shift: true, alt: false };

/** At most this many uuids, and as many paths, in one select. */
export const MAX_SELECT = 4096;
/** A footprint path at most this long (64 sheet levels and the symbol). */
const MAX_PATH = 65 * 37;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** A KiCad uuid as KIID::AsString writes it: lower case. */
const UUID_RE = new RegExp(`^${UUID}$`);
/** A footprint's schematic path as KIID_PATH::AsString writes it: "/<sheet uuid>/.../<symbol uuid>". */
const FP_PATH_RE = new RegExp(`^(/${UUID})+$`);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const keyOf = (s: Selection): string => JSON.stringify([s.uuids, s.fpPaths]);
const EMPTY_KEY = keyOf({ uuids: [], fpPaths: [] });

function withTimeout<T>(value: T | Promise<T>, ms: number): Promise<T | 'timeout'> {
  return Promise.race([Promise.resolve(value), new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))]);
}

/** An array of strings, every one of them, or null. */
function strings(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((s) => typeof s === 'string') ? [...(v as string[])] : null;
}

/**
 * The engine's selection emit or read, either shape: the schematic editor's
 * bare uuid array, the board editor's `{uuids, fpPaths}`. Null when it is not
 * one of them (the last selection then stands).
 */
export function parseSelectionEmit(json: unknown): Selection | null {
  if (typeof json !== 'string') return null;
  let v: unknown;
  try { v = JSON.parse(json); } catch { return null; }
  if (Array.isArray(v)) {
    const uuids = strings(v);
    return uuids == null ? null : { uuids, fpPaths: [] };
  }
  if (!isObj(v)) return null;
  const uuids = strings(v.uuids);
  const fpPaths = v.fpPaths === undefined ? [] : strings(v.fpPaths);
  return uuids == null || fpPaths == null ? null : { uuids, fpPaths };
}

/** A list of at most MAX_SELECT strings of one shape, each kept once in order, or null. */
function idList(v: unknown, re: RegExp, maxLen: number): string[] | null {
  if (!Array.isArray(v) || v.length > MAX_SELECT) return null;
  if (!v.every((s) => typeof s === 'string' && s.length <= maxLen && re.test(s))) return null;
  return [...new Set(v as string[])];
}

/**
 * select's args, closed: `uuids` (required) a list of item uuids and
 * `fpPaths` (optional) a list of footprint paths, each at most MAX_SELECT
 * entries in KiCad's own lower case spelling, and `zoom` (optional) a
 * boolean; any other key, type or shape is null (bad_args). Repeats are kept once.
 */
export function parseSelectArgs(a: unknown): SelectArgs | null {
  if (!isObj(a) || !Object.keys(a).every((k) => k === 'uuids' || k === 'fpPaths' || k === 'zoom')) return null;
  const uuids = idList(a.uuids, UUID_RE, 36);
  if (uuids == null) return null;
  const fpPaths = a.fpPaths === undefined ? [] : idList(a.fpPaths, FP_PATH_RE, MAX_PATH);
  if (fpPaths == null) return null;
  if (a.zoom !== undefined && typeof a.zoom !== 'boolean') return null;
  return { uuids, fpPaths, zoom: a.zoom === true };
}

/** The editor's selection uuids (kicadCollabGetSelection), or null when the export is missing, throws or answers no list. */
export function selectedUuids(w: Pick<ToolWindow, 'Module'>): string[] | null {
  const mod = w.Module as SelectionExports | undefined;
  const read = mod?.kicadCollabGetSelection;
  if (typeof read !== 'function') return null;
  try { return parseSelectionEmit(String(read.call(mod)))?.uuids ?? null; } catch { return null; }
}

/**
 * ev.selected's source: the engine's selection hook, debounced and
 * deduplicated. `live` says whether a selection may be sent now (a document
 * is open); one that settles while it may not is dropped.
 */
export class SelectionFeed {
  /** The selection the host holds: the last one sent, or the empty one a new document starts with. */
  private last = EMPTY_KEY;
  private pending: { sel: Selection; key: string } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pulls: Array<ReturnType<typeof setTimeout>> = [];
  private hook: ((json: string) => void) | null = null;
  private armed = false;
  private stopped = false;
  private readonly onGesture = (): void => { this.burst(); };

  constructor(
    private readonly w: SelectionWindow,
    private readonly opts: {
      timing: Pick<SelectionTiming, 'selectSettleMs' | 'selectPullMs'>;
      /** The frame's kind: when the engine's hook is armed (see arm). */
      frame: Frame;
      live: () => boolean;
      send: (s: Selection) => void;
      log?: (m: string, err?: unknown) => void;
    },
  ) {}

  /**
   * Takes the engine's onSelection slot (a listener already in it is still
   * called) and the frame's pointer and key releases, once, and in a pcb frame
   * arms the engine's hook (arm). False without kicadCollabPresenceStart.
   */
  start(): boolean {
    const mod = this.w.Module as SelectionExports | undefined;
    if (this.hook != null || this.stopped || typeof mod?.kicadCollabPresenceStart !== 'function') return false;
    const prior = this.w.kicadCollab?.onSelection;
    const hook = (json: string): void => {
      this.see(parseSelectionEmit(json));
      try { prior?.(json); } catch (err) { this.opts.log?.('an earlier onSelection listener threw', err); }
    };
    this.hook = hook;
    this.w.kicadCollab = { ...this.w.kicadCollab, onSelection: hook };
    this.w.addEventListener?.('pointerup', this.onGesture, true);
    this.w.addEventListener?.('keyup', this.onGesture, true);
    if (this.opts.frame === 'pcb') this.arm();
    return true;
  }

  /**
   * A new document (an open or an import): the host's selection is empty again,
   * in a sch frame the engine's hook is armed the first time (arm), and the
   * editor's selection is read.
   */
  reset(): void {
    if (this.hook == null || this.stopped) return;
    this.cancel();
    this.last = EMPTY_KEY;
    if (this.opts.frame === 'sch') this.arm();
    this.pull();
  }

  /** Stops for good: nothing more is read or sent, and the hook leaves its slot. */
  stop(): void {
    this.stopped = true;
    this.cancel();
    this.w.removeEventListener?.('pointerup', this.onGesture, true);
    this.w.removeEventListener?.('keyup', this.onGesture, true);
    if (this.hook != null && this.w.kicadCollab?.onSelection === this.hook) delete this.w.kicadCollab.onSelection;
    this.hook = null;
  }

  /**
   * kicadCollabPresenceStart, once; it may answer through a Promise when it
   * queued behind a load. When matters, for the collab document listener it
   * registers (measured 2026-10-20, Chromium, the local pair):
   * - A pcb frame arms at boot. pcbnew replaces its BOARD on every open
   *   (SetBoard deletes the old one), so the listener leaves with the boot's
   *   empty board and is never added again: on a live board it would snapshot
   *   the whole board after every edit (flushDiff), Fill All Zones on Glasgow
   *   taking 3.0 s of main thread instead of 2.6 s. The canvas hooks stay.
   * - A sch frame arms at its first document. eeschema keeps its SCHEMATIC, so
   *   the listener stays; registered at boot it saw a schematic import's every
   *   converted item, after which the imported sheets no longer reported their
   *   switches (sheet.enter's walk answered not_applied on the eDP adapter).
   *   After the document is up it is registered where the island's first
   *   sheet.tree (kicadSheetsGetTree) registered it before, at no new cost.
   */
  private arm(): void {
    if (this.armed) return;
    this.armed = true;
    const mod = this.w.Module as SelectionExports | undefined;
    const startHooks = mod?.kicadCollabPresenceStart;
    if (typeof startHooks !== 'function') return;
    try {
      const r: unknown = startHooks.call(mod);
      if (r instanceof Promise) r.catch((err: unknown) => this.opts.log?.('kicadCollabPresenceStart rejected', err));
    } catch (err) {
      this.opts.log?.('kicadCollabPresenceStart threw', err);
    }
  }

  /**
   * One selection seen (emitted or read): it becomes the pending one, sent once
   * it has held, unless it is then what the host holds (a burst that came back).
   */
  private see(sel: Selection | null): void {
    if (sel == null || this.stopped) return;
    const key = keyOf(sel);
    if (key === (this.pending?.key ?? this.last)) return;   // nothing new: a pending send keeps its time
    this.pending = { sel, key };
    if (this.timer != null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.opts.timing.selectSettleMs);
  }

  private flush(): void {
    this.timer = null;
    const p = this.pending;
    this.pending = null;
    if (p == null || this.stopped || p.key === this.last || !this.opts.live()) return;
    this.last = p.key;
    this.opts.send({ uuids: [...p.sel.uuids], fpPaths: [...p.sel.fpPaths] });
  }

  /** The editor's selection now, in the emit's shape (the board's with its footprint paths). */
  private pull(): void {
    if (this.stopped) return;
    const mod = this.w.Module as SelectionExports | undefined;
    const read = typeof mod?.kicadCollabGetSelectionFull === 'function' ? mod.kicadCollabGetSelectionFull : mod?.kicadCollabGetSelection;
    if (typeof read !== 'function') return;
    let text: unknown;
    try { text = read.call(mod); } catch { return; }   // no editor up yet: the next gesture reads again
    if (typeof text === 'string') this.see(parseSelectionEmit(text));
  }

  /** The reads after a pointer or key release (a selection made outside the canvas raises no emit); a new release starts them again. */
  private burst(): void {
    if (this.stopped) return;
    for (const t of this.pulls) clearTimeout(t);
    const every = this.opts.timing.selectPullMs;
    this.pulls = [0, every, 3 * every].map((ms) => setTimeout(() => this.pull(), ms));
  }

  private clearPending(): void {
    this.pending = null;
    if (this.timer != null) clearTimeout(this.timer);
    this.timer = null;
  }

  private cancel(): void {
    this.clearPending();
    for (const t of this.pulls) clearTimeout(t);
    this.pulls = [];
  }
}

export type SelectOutcome = { ok: true } | { ok: false; code: 'island_error' | 'not_applied'; message: string };

/**
 * The ids select hands the engine: the item uuids, and in a schematic each
 * footprint path's last uuid (the symbol's: the engine's own cross-app
 * mapping), each once. A board has no export that finds a footprint by its
 * path, so its paths select nothing.
 */
export function selectIds(frame: Frame, a: SelectArgs): string[] {
  const symbols = frame === 'sch' ? a.fpPaths.map((p) => p.slice(p.lastIndexOf('/') + 1)) : [];
  return [...new Set([...a.uuids, ...symbols])];
}

/**
 * select's engine half (the responder checked the args, the exports, the
 * document and that nothing is up): the clear, then each id through the
 * engine's select by uuid, then a wait until the editor's selection is
 * exactly the items it found (an id it did not find selects nothing and is
 * no failure), then, with `zoom` and anything found, Zoom to Selected Objects.
 * `not_applied` when the selection does not settle within timing.selectMs or
 * the clear is refused; nothing is zoomed then.
 */
export async function selectItems(w: Pick<ToolWindow, 'Module'>, a: SelectArgs, opts: { frame: Frame; timing: Pick<SelectionTiming, 'selectPollMs' | 'selectMs' | 'applyMs'>; closed: () => boolean; press: (k: KeyPress) => void }): Promise<SelectOutcome> {
  const mod = w.Module as SelectionExports | undefined;
  const clear = mod?.kicadCollabTestClearSelection;
  const add = mod?.kicadCollabTestSelectByUuid;
  if (typeof clear !== 'function' || typeof add !== 'function') return { ok: false, code: 'island_error', message: 'the select exports are gone' };
  let cleared: unknown;
  try { cleared = await withTimeout<unknown>(clear.call(mod), opts.timing.applyMs); } catch { cleared = false; }
  if (cleared !== true) return { ok: false, code: 'not_applied', message: 'the editor did not clear its selection' };
  const found: string[] = [];
  for (const id of selectIds(opts.frame, a)) {
    if (opts.closed()) return { ok: false, code: 'island_error', message: 'the frame closed' };
    let hit: unknown;
    try { hit = await withTimeout<unknown>(add.call(mod, id), opts.timing.applyMs); } catch { hit = false; }
    if (hit === true) found.push(id);
  }
  // The clear and each select run on the editor's loop after their calls answered.
  const want = new Set(found);
  const end = Date.now() + opts.timing.selectMs;
  for (;;) {
    if (opts.closed()) return { ok: false, code: 'island_error', message: 'the frame closed' };
    const now = selectedUuids(w);
    if (now != null && now.length === want.size && now.every((u) => want.has(u))) break;
    if (Date.now() >= end) return { ok: false, code: 'not_applied', message: 'the editor did not take the selection' };
    await sleep(opts.timing.selectPollMs);
  }
  if (a.zoom && found.length > 0) opts.press(ZOOM_SELECTION_KEY);
  return { ok: true };
}
