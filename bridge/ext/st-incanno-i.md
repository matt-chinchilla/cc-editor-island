<!-- Copyright (C) 2026 Circuit Center Inc -->
<!-- SPDX-License-Identifier: MIT -->
<!-- part: requests -->
| `sheet.increment` | `{ first: string, by: number, allSheets: boolean }` | `{ shifted: boolean, depth: number }` |
<!-- part: section -->
### sheet.increment

KiCad's Increment Annotations From with no window (island `v0.2.3-cc25`, on an engine with `kicadSchIncrementAnnotations`, engine run 15; a host gates it on `ev.ready` `caps` listing `incrementAnnotations`, which a `sch` frame lists on such an engine). It is the body of KiCad's own `SCH_EDITOR_CONTROL::IncrementAnnotations` after its dialog: every part whose designator has the prefix of `first` and a number at or above the number of `first` moves up by `by`, on the shown sheet or, with `allSheets`, on every sheet; the other designators are untouched. It is ONE commit, "Increment Annotations": one undo step for the whole shift, and an `ev.edited` follows when the depth moved. A `first` that matches no part changes nothing and still answers, `shifted` false.

- The args are exactly `{ first, by, allSheets }`: `first` a designator of 2 to 64 characters that splits into a prefix ending in a character other than a digit and a number (`R10`, `U3`; `R` or `R?` refuse), no control character and no space at either end; `by` a whole number from 1 to 100,000 (KiCad's dialog spins 1 to 64); `allSheets` a boolean.
- The answer is `{ shifted, depth }`: `depth` the undo depth after the shift, `shifted` true when it moved. The host reads the new designators back (`symbols.get`).
- The checks, in order, every one before any effect: the args (`bad_args`); in any frame but `sch` it answers `unsupported`; then as a schematic op: `not_ready` before `ev.ready`, `unsupported` naming `kicadSchIncrementAnnotations`, `kicadCollabBusy` or `kicadCollabTestUndoDepth` on an engine without it, `not_ready` with no schematic open, `busy` while a load is parked, a popup menu or a dialog is up, or a placed item hangs off the pointer, or during a `sheet.check`. Then the engine's shift: `not_applied` when it refuses (an open in flight), or when its apply queue does not empty within 30 s.
- Held under the cap: `eeschema.EditorControl.incrementAnnotations` (KiCad's Increment Annotations From) in a `sch` frame sends `ev.held { action }` and opens no window; the host's page asks for the three values and sends `sheet.increment`. On an engine without the export the action is KiCad's.
