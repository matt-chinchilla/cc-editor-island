<!-- Copyright (C) 2026 Circuit Center Inc -->
<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# SY2: a press on the canvas in Firefox, diagnosed

Ledger row SY2: "Firefox only: with P pressed, a press on the canvas never places the pin (island seat; Chromium places it). **Engine.**" Diagnosed on engine run 14 (island cc24) on the local pair, Playwright 1.63 with its own Chromium and Firefox, fixtures `symedit-small` and `fpedit-small`, on 2026-11-19. The spec that holds the measurements is `tests/e2e/firefox-pointer.spec.ts`.

## Verdict

The press is lost before any code of ours or KiCad's sees it: Playwright's Firefox delivers no pointer, mouse or click event into a cross site frame whose top page is cross origin isolated (COOP `same-origin` with COEP), whatever the frame holds. It is not the island's event forwarding (the island forwards no pointer event: the wx port listens on the frame's own canvas), not the wx port's pointer path and not KiCad's tool dispatch. Nothing for the engine: the conditional record `sy2-e` has no cause to build.

## What was measured

1. The pin tool in both browsers (symedit frame, OPAMP2 open). In Chromium: P alone makes the new pin and its host ask (`ev.symedit` pin, isNew) on the key, as KiCad's tool key carries the pointer's place; the next press places it (one undo step, `ev.edited`); a later press starts the next pin. In Firefox: P makes the same ask, so keys reach KiCad and the tool is armed; no press after it does anything (no undo step, no new pin, no window).
2. Presses with no tool. In Chromium a plain press over a pin selects it (`ev.selected`). In Firefox the same press selects nothing; KiCad's cursor stays where it was after a pointer move (screenshot). In a board frame (`fpedit-small`, U1 fitted) a press selects U1 in Chromium and nothing in Firefox. So in Firefox no press and no move reaches the engine at all, in any frame.
3. A bare frame with no engine: a page holding one frame on the island's origin that holds one canvas and posts every event of a press to its parent.
   - Under the pair's own headers (the page COOP `same-origin` and COEP `credentialless`, the frame COOP, COEP `require-corp` and CORP) and the harness's iframe attributes: Chromium gets pointerdown, mousedown, pointerup, mouseup and click; Firefox gets nothing.
   - Narrowed in Firefox: the isolated pair with no iframe attributes, with `sandbox` only, with `allow` only, and with the frame carrying COEP but no COOP: nothing in each. A plain page over the same isolated frame (the top page not isolated): every event. A plain cross site frame under a plain page, and a same origin frame: every event.

The one condition is the top page being cross origin isolated with a cross site frame under it. /viewer is such a page, so the same driver cannot press in the editor frame there either.

## Open

Whether a reader's stock Firefox delivers the press: not measured (no stock Firefox on this machine; Playwright's Firefox is its own patched build driven through its own input path). A stock Firefox check on /viewer (Edit, Schematic, a symbol's editor, P and one press) closes the row; until then the ledger's "Engine" verdict and the comments in `tests/e2e/symedit.spec.ts` and `tests/e2e/fpedit.spec.ts` that call it an engine defect are wrong.

## The spec

`tests/e2e/firefox-pointer.spec.ts` measures first, with the bare isolated frame, whether this browser's presses reach such a frame, and presses only where they do: the pin test asserts the ask on P in every browser, and the press, the placed pin and Ctrl+Z only where presses arrive (Chromium today, Firefox once its driver delivers them). The footprint editor's half needs engine run 15 (the fpedit exports) and is skipped on run 14.
