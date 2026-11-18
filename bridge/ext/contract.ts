// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// The contract between the responder (bridge/responder.ts) and a wave unit's
// file, bridge/ext/<unit>.ts (bridge/ext/README.md). A unit's file exports one
// ExtUnit as its default; the registry (bridge/ext/registry.ts) loads every
// such file by glob, checks it and merges it with the built ins. A unit never
// imports bridge/responder.ts or the registry: everything of the responder it
// may use reaches it through ResponderCtx.
import type { KeyPress } from '../../src/keys';
import type { StagedProject } from '../../src/stage';
import type { BuiltinTool, Frame } from '../../src/types';
import type { HeldAction } from '../held';

/** An answer to one request: `transfer` lists the buffers of fresh copies the result carries. */
export type Answer = { ok: true; result: Record<string, unknown>; transfer?: ArrayBuffer[] } | { ok: false; code: string; message: string };

/** What a gate answers: a refusal, or the engine window and its module. */
export type Gated = Answer | { w: ToolWindow; mod: Record<string, unknown> };

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const onlyKeys = (o: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(o).every((k) => allowed.includes(k));
export const ok = (result: Record<string, unknown> = {}): Answer => ({ ok: true, result });
export const fail = (code: string, message: string): Answer => ({ ok: false, code, message });
/** A request with no args: absent, or an empty object. */
export const noArgs = (args: unknown): boolean => args === undefined || (isObj(args) && Object.keys(args).length === 0);
/** Whether a gate refused (the answer to send) or passed (the window and module). */
export const refused = (g: Gated): g is Answer => 'ok' in g;
/** Every name is a function on the module: how a unit feature detects its engine exports. */
export const hasAll = (mod: Record<string, unknown> | null | undefined, names: readonly string[]): boolean =>
  mod != null && names.every((name) => typeof mod[name] === 'function');

/**
 * The one object a unit's handlers receive. Built once per responder; every
 * member reads the responder's state at the moment it is called.
 */
export interface ResponderCtx {
  /** The frame's kind (src/types.ts Frame). */
  readonly frame: Frame;
  /** The project folder every frame stages its project in. */
  readonly root: string;
  /** The bridge's waits in ms (bridge/responder.ts timing; the unit tests shorten them). */
  readonly timing: Readonly<Record<string, number>>;

  // The engine.
  /** The engine window, null before engineReady. */
  win(): ToolWindow | null;
  /** The engine module (`Module`), null before engineReady. */
  mod(): Record<string, unknown> | null;
  /** The engine's MEMFS, null before engineReady. */
  fs(): EmscriptenFS | null;
  /** Every name is a function on the module now (false before engineReady). */
  has(names: readonly string[]): boolean;
  /** ev.ready went out. */
  ready(): boolean;
  /** The bridge closed (shutdown or teardown): answer and emit nothing more. */
  closed(): boolean;
  /** ev.ready's caps as sent, empty before. */
  caps(): readonly string[];

  // The document.
  /** The opened document's absolute path, null while none is open. */
  opened(): string | null;
  /** The staged project, null while none is open. */
  staged(): StagedProject | null;
  /** A document is open: a project, or a symbol in a symedit frame. */
  hasDocument(): boolean;
  /** A held action or a properties request of KiCad's reaches the host now (after ev.ready, a document open, no import). */
  admit(): boolean;

  // The engine's state.
  /** The engine is still loading a file (kicadOpenFileBusy). */
  engineBusy(): boolean;
  /** A popup menu or a dialog of KiCad's is up (key presses would go to it). */
  keysBlocked(): boolean;
  /** An item placed by place still hangs off the pointer. */
  placeHanging(): boolean;
  /** An import runs (every queued request but shutdown answers busy). */
  importing(): boolean;
  /** A sheet.check or a board.check runs. */
  checking(): boolean;
  /** Requests received and not yet answered. */
  inFlight(): number;

  // The gates of the built in ops, the same checks in the same order.
  /** A board op's checks (a pcb frame, the exports, a board open, not busy). */
  boardGate(op: string, exports: readonly string[]): Gated;
  /** A schematic op's checks (a sch frame, the exports, a schematic open, not busy). */
  schematicGate(op: string, exports: readonly string[]): Gated;
  /** A settings op's checks for one section (bridge/settings.ts sectionFrames). */
  documentGate(op: string, exports: readonly string[], section: string): Gated;

  // Doing things.
  /** Presses one key in the engine as a reader would (bridge/keys.ts). */
  pressKey(k: KeyPress): void;
  /** Sends a built in event (bridge/responder.ts IslandEvent), with exactly its protocol keys. */
  emit(ev: { type: string } & Record<string, unknown>): void;
  /** Sends one of the unit's own events: `type` must be declared in its `events`, the payload carries exactly the keys declared there. */
  emitExt(type: string, payload: Record<string, unknown>, transfer?: ArrayBuffer[]): void;
  /** Bounds a call: resolves 'timeout' after `ms` (the engine may never answer). */
  withTimeout<T>(value: T | Promise<T>, ms: number): Promise<T | 'timeout'>;
  /** Waits until the engine's apply queue is empty (kicadCollabBusy), at most `ms`: false when it is still busy. */
  applyIdle(ms: number): Promise<boolean>;
  /** A fresh folder under `rootDir` for the next run (what an earlier run left there is removed). */
  freshRunFolder(rootDir: string): string;
  /** Removes a run's folder; never throws. */
  dropRunFolder(dir: string): void;
  /**
   * One queued run of the engine: `call` queues it (answers true), and the
   * record is read once the apply queue is empty and `record` answers non null.
   * not_applied when refused or past `ms`.
   */
  queuedRun<T>(op: string, dir: string, ms: number, call: () => unknown, record: () => T | null): Promise<{ done: T } | Answer>;
  /** As queuedRun, closing every dialog met meanwhile (the first one's title answered beside the record). */
  watchedRun<T>(op: string, dir: string, ms: number, call: () => unknown, record: () => T | null): Promise<{ done: T; dialog: string | null } | Answer>;
  /** Closes every dialog up but a progress dialog without accepting it; the first one's title, or null. */
  closeRunDialogs(): string | null;
  /** A file of MEMFS as bytes, null when absent. */
  readBytes(abs: string): Uint8Array | null;
  /** Gives the drawing wx's keyboard focus back after a run that took it. */
  refocus(): void;
  /** A short debug line in the frame's console (never sent to the host). */
  log(...parts: unknown[]): void;
}

/** One new request op of a unit. */
export interface ExtOp {
  /**
   * The handler: args are the request's `args` (unchecked: check them closed).
   * Throwing answers island_error.
   */
  run(args: unknown, ctx: ResponderCtx): Answer | Promise<Answer>;
  /**
   * Answered as it arrives, off the request queue (as keys.claim and sim.stop
   * are): for an op that must reach an engine parked in a menu or a prompt
   * (contextMenu.choose, prompt.answer). It never waits behind the request
   * running, and nothing on the queue waits for it.
   */
  now?: true;
  /** Still answered while a sheet.check or a board.check runs (a read). */
  passesCheck?: true;
}

/**
 * Widens an op that ships (the manifest's opsWidened): called in place of the
 * op with its args and `next`, the op as it stood before this hook (the built
 * in, or the hook registered before). Answer null-free: return `next(args)` to
 * leave the request to the op, or an answer of the unit's own.
 */
export type Widen = (args: unknown, ctx: ResponderCtx, next: (args: unknown) => Promise<Answer>) => Promise<Answer>;

/** A tool a new frame boots, when it is not one of the built in tools (loader/src/wasm/constants.ts). */
export interface ToolKind {
  /** The tool's name (src/types.ts ExtTools key). */
  name: string;
  /** The deployed bundle that backs it: the one merged editor. */
  bundle: 'kicad_editor';
  /** argv[0] KiCad's DEBUG check expects. */
  argv0: string;
  /** A KiCad config is seeded before main(). */
  needsConfigSeed: boolean;
  /** The library kind it consumes, null for none. */
  libKind: 'symbol' | 'footprint' | null;
}

/** A frame a unit's file adds (the footprint editor fpedit, the drawing sheet editor ds). */
export interface FrameKind {
  /** The --frame= token single_top.cpp parses. */
  token: string;
  /** The tool it boots: a built in tool's name, or a tool of its own. */
  tool: BuiltinTool | ToolKind;
  /** kicadWebOpenTool's names (KiCad's Switch items) that ask for this frame; none for a frame KiCad never switches to. */
  toolNames?: readonly string[];
  /** The document kind project.write refuses in this frame (lowercased extension), null for none. */
  document: string | null;
  /** The file extension the frame opens (bridge/import.ts DOCUMENT_EXTENSION). */
  extension: string;
  /** Internal units per millimeter of its drawing (bridge/coords.ts). */
  unitsPerMm: number;
  /** The picker's kind in this frame (src/picker.ts kindOf). */
  pickKind: 'symbol' | 'footprint';
  /** Places through the host's picker (ev.pick) and warms the library quietly. */
  picker: boolean;
  /** The built in ops this frame answers unsupported, whatever their args. */
  refuses: readonly string[];
  /** The message of that answer. */
  refusal: string;
  /** The pseudo-caps ev.ready may list in this frame (engine export names are always kept); absent lists every one found. */
  caps?: readonly string[];
  /** ev.selected's read in this frame (else KiCad's collab selection), and whether a selection is live. */
  selection?: { read(mod: Record<string, unknown>): unknown; live(ctx: ResponderCtx): boolean };
  /** Whether the frame's own document is open (a footprint, a drawing sheet): ResponderCtx.hasDocument and admit read it. */
  documentOpen?: (mod: Record<string, unknown>) => boolean;
  /** ev.edited's undo depth in this frame (else kicadCollabTestUndoDepth while a document is open), null when unknown. */
  undoDepth?: (mod: Record<string, unknown>, ctx: ResponderCtx) => number | null;
}

/** The row of a held action (bridge/held.ts HeldAction). */
export type HeldRow = HeldAction;

/** One unit's file: its default export. Every field but `unit` is optional. */
export interface ExtUnit {
  /** The unit id, the file's stem (RULINGS.md item 16). */
  unit: string;
  /** New request ops, by name. Never a name that ships (widen it instead). */
  ops?: Readonly<Record<string, ExtOp>>;
  /** The frames this unit's ops answer in; elsewhere the seam answers them unsupported with `frameRefusal`. Absent: every frame. */
  frames?: readonly Frame[];
  /** The message of that answer. */
  frameRefusal?: string;
  /** Ops that ship, widened from this file (see Widen). */
  opsWidened?: Readonly<Record<string, Widen>>;
  /** The pseudo-caps this unit may list (static, for the docs and the join test). */
  capNames?: readonly string[];
  /** The pseudo-caps it lists now: feature detect the engine exports, never a flag. */
  caps?: (mod: Record<string, unknown>, frame: Frame) => readonly string[];
  /** The KiCad action names this unit holds (its heldRows' actions). */
  held?: readonly string[];
  /** Its held actions, each in its frames under its cap (bridge/held.ts). */
  heldRows?: readonly HeldRow[];
  /** New events, by type, each with exactly its keys. */
  events?: Readonly<Record<string, readonly string[]>>;
  /** The ev.prompt ask names whose closed record shape this unit declares. */
  asks?: readonly string[];
  /** New project.export jobs, each with its face. */
  exportJobs?: Readonly<Record<string, 'pcb' | 'sch'>>;
  /** New frames, by name (src/types.ts ExtFrames). */
  defineFrames?: Readonly<Record<string, FrameKind>>;
  /**
   * Runs once at engineReady, before ev.ready (window slot listeners, a
   * service): answers a stop, called when the bridge closes. A throw is logged
   * and the unit's install is skipped; nothing else changes.
   */
  install?: (ctx: ResponderCtx) => void | (() => void);
}

/** A unit id: lowercase words and digits joined by dashes (the manifest's ids). */
export const UNIT_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A request op: dotted words. */
export const OP_RE = /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)*$/;
/** An event type. */
export const EVENT_RE = /^ev\.[a-z][A-Za-z0-9]*$/;
/** A pseudo-cap: a word, or a settings section cap `settings:<section>`. */
export const CAP_RE = /^[a-z][A-Za-z0-9]*(?::[a-z][A-Za-z0-9]*)?$/;
/** An export job. */
export const JOB_RE = /^[a-z][a-z0-9_]*$/;
/** A frame name. */
export const FRAME_RE = /^[a-z][a-z0-9]{0,15}$/;

/** What the seam answers for an op the manifest names whose unit has not landed (message prefix; the code is unsupported). */
export const SEAM_PLACEHOLDER = 'seam placeholder';
