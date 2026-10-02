// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// What the engine shows over its own canvas: wx popup menus and dialogs. A
// popup menu (a context menu, KiCad's clarify-selection menu) is a DOM
// element wx-dom.js appends to the body (.wx-menu-popup) and never a wxWindow
// in the element registry; a dialog is a wxWindow whose type names a Dialog
// (wxDialog, wxGenericMessageDialog, wxFileDialog, wxTextEntryDialog, ...).
// key.press refuses while either is up (a key would land in it), a schematic
// project.save closes a popup menu first and refuses only under a dialog, and
// ev.menu tells the host, so it can hide what it draws over the frame.

/** The class wx-dom.js gives every popup menu it shows. */
export const POPUP_SELECTOR = '.wx-menu-popup';
/** How often the watch re-reads the element registry for a dialog. */
export const WATCH_MS = 100;

type ModalWindow = Pick<ToolWindow, 'wxElementRegistry'> & { document?: { querySelector(selectors: string): unknown; body?: Node | null } };

/** A popup menu is in the frame's document. */
export function popupUp(w: ModalWindow): boolean {
  try { return w.document?.querySelector(POPUP_SELECTOR) != null; } catch { return false; }
}

/**
 * A visible wx dialog in the registry. `progress` decides whether a progress
 * dialog counts: it takes no keys (key.press ignores it, as the loader's open
 * flow does), but it is still drawn over the canvas (ev.menu counts it). A
 * registry that throws counts as none.
 */
export function dialogUp(w: ModalWindow, progress: boolean): boolean {
  try {
    return (w.wxElementRegistry?.findAll({ visible: true }) ?? []).some((e) => /Dialog/.test(e.typeName) && (progress || !/Progress/i.test(e.typeName)));
  } catch { return false; }
}

/** A key would land in a popup menu or a dialog: key.press, view.fit and project.save answer busy. */
export function keysBlocked(w: ModalWindow): boolean {
  return popupUp(w) || dialogUp(w, false);
}

/**
 * Closes the popup menus in the frame's document as a press of Escape does:
 * a keydown Escape dispatched on the popup reaches the capture listener
 * wx-dom.js's context menu keeps on the document, which settles the menu as
 * cancelled (-1). A menu holds no edits, so a host save may close it rather
 * than refuse. A menu bar's popup (only with KiCad's menus shown) takes no
 * Escape and stays. Answers whether anything was dismissed.
 */
export function dismissPopups(w: ModalWindow): boolean {
  let dismissed = false;
  try {
    // One popup at a time (a context menu supersedes a menu bar popup); the bound only stops a loop.
    for (let i = 0; i < 4; i++) {
      const pop = w.document?.querySelector(POPUP_SELECTOR) as { dispatchEvent?: (e: Event) => boolean } | null | undefined;
      if (pop == null || typeof pop.dispatchEvent !== 'function') break;
      pop.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
      if (w.document?.querySelector(POPUP_SELECTOR) === pop) break;   // Escape did not close it
      dismissed = true;
    }
  } catch { /* a document that throws: the caller re-reads keysBlocked */ }
  return dismissed;
}

/** Something of the engine's own is drawn over its canvas: ev.menu { open: true }. */
export function menuOpen(w: ModalWindow): boolean {
  return popupUp(w) || dialogUp(w, true);
}

/**
 * Calls `onChange(open)` each time menuOpen flips: true when the first popup
 * menu or dialog shows, false when the last one goes. Starts closed (nothing
 * is reported for a frame with nothing up). A popup menu is seen at once (a
 * MutationObserver on the body, where wx-dom.js puts it); a dialog within
 * WATCH_MS (the registry has no change event). Answers the stop function.
 */
export function watchMenus(w: ModalWindow, onChange: (open: boolean) => void): () => void {
  let open = false;
  // wx.js bumps the registry's version on every register, update and
  // unregister: the scan for a dialog runs only after a change.
  let seen: unknown = undefined;
  let dialog = false;
  const check = (): void => {
    const version = (w.wxElementRegistry as { version?: unknown } | undefined)?.version;
    if (typeof version !== 'number' || version !== seen) {
      seen = version;
      dialog = dialogUp(w, true);
    }
    const now = dialog || popupUp(w);
    if (now === open) return;
    open = now;
    onChange(now);
  };
  const timer = setInterval(check, WATCH_MS);
  let observer: MutationObserver | null = null;
  const body = w.document?.body;
  if (typeof MutationObserver === 'function' && body != null) {
    observer = new MutationObserver(check);
    observer.observe(body, { childList: true });
  }
  return () => {
    clearInterval(timer);
    observer?.disconnect();
  };
}
