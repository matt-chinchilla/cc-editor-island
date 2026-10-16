// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The frame's fatal state (src/main.ts): the engine failures that end at the
// fatal screen with ev.state fatal, and the one that ends there quietly. An
// import whose engine call trapped (bridge/import.ts isEngineTrap) has already
// told the host through its answer ("import_failed: the engine stopped: ...")
// and answers not_ready from then on, so it emits no fatal event: a host in the
// middle of a hand-off (an Altium project's board step, then its schematic step
// in a rebooted frame) must not be interrupted by one (re-review 2026-10-16).

/**
 * The fatal details the island emits and renders: its own closed words. Engine
 * and loader text (error messages, status lines) goes to the console only.
 */
export type FatalCode = 'memory' | 'crash' | 'boot_failed' | 'engine_timeout' | 'no_container' | 'webgl_lost';

/** Uncaught errors that mean the wasm instance is gone (the loader's fatal-screen set). */
export const TERMINAL = /RuntimeError|\babort(ed)?\b|\bindex out of bounds|indirect call signature|memory access out of bounds|unreachable executed|null function or function signature/i;

export interface FatalGate {
  /** The fatal screen and ev.state fatal `code`, once; never after the teardown started. */
  die(code: FatalCode, raw?: string): void;
  /** An uncaught error: out of memory is `memory`, a TERMINAL one `crash`, anything else nothing. */
  uncaught(text: string): void;
  /** An import's engine call trapped (its answer is out): the fatal screen, no event. */
  importStopped(why: string): void;
  /** Latches the fatal state for a caller that draws its own screen (File > Quit): false when it was latched already. */
  latch(): boolean;
  /** The fatal state is latched. */
  isFatal(): boolean;
}

export function createFatalGate(o: {
  started: () => boolean;
  show: (code?: FatalCode) => void;
  emit: (code: FatalCode) => void;
  oom: (text: string) => boolean;
  log: (raw: string) => void;
}): FatalGate {
  let fatal = false;
  const die = (code: FatalCode, raw?: string): void => {
    if (fatal || o.started()) return;
    fatal = true;
    if (raw != null && raw !== '') o.log(raw);
    o.show(code);
    o.emit(code);
  };
  return {
    die,
    uncaught(text) {
      if (o.started()) return;
      if (o.oom(text)) die('memory', text);
      else if (TERMINAL.test(text)) die('crash', text);
    },
    importStopped(why) {
      if (fatal || o.started()) return;
      fatal = true;
      if (why !== '') o.log(why);
      o.show('crash');
    },
    latch() {
      if (fatal) return false;
      fatal = true;
      return true;
    },
    isFatal: () => fatal,
  };
}
