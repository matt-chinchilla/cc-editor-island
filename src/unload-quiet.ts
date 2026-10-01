// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The engine asks "Leave site?" on beforeunload whenever KiCad holds a
// modified document. When the host is about to reload this frame (a frame
// switch right after the host's own save, or a forget), that prompt is wrong:
// the host already has the bytes or has dropped the document. The responder
// marks those moments, and clears them when a new document is opened; a
// capture-phase listener installed before the engine boots then stops the
// engine's handler from running. It never sets returnValue, so the island
// itself never asks. A user reload with truly unsaved edits outside those
// moments still gets the engine's prompt.
let until = 0;
let forever = false;

/** Quiet for the next `ms` milliseconds (a later, longer window extends it). */
export function quietFor(ms: number, now: number = Date.now()): void {
  until = Math.max(until, now + ms);
}

/** Quiet for the rest of this page's life, or until quietClear. */
export function quietForever(): void {
  forever = true;
}

/**
 * Ends any quiet window and the forever flag: a project.open after a forget
 * or a save puts a new document in the engine, whose edits deserve the prompt.
 */
export function quietClear(): void {
  until = 0;
  forever = false;
}

export function isQuiet(now: number = Date.now()): boolean {
  return forever || now < until;
}

export function resetUnloadQuietForTest(): void {
  quietClear();
}

/**
 * Installs the listener. It must go in before the engine registers its own
 * capture-phase beforeunload handler on window (listeners on one target run in
 * registration order), and after the quit latch, which must still see the unload.
 */
export function installUnloadQuiet(win: Window): void {
  win.addEventListener('beforeunload', (e) => {
    if (isQuiet()) e.stopImmediatePropagation();
  }, { capture: true });
}
