<!-- Copyright (C) 2026 Circuit Center Inc -->
<!-- SPDX-License-Identifier: MIT -->
<!-- part: requests -->
| `sheet.reload` | none | `{}` |
<!-- part: section -->
### sheet.reload

The open schematic or board reads its drawing sheet again (island `v0.2.3-cc25`, on an engine with `kicadDrawingSheetReload`; a host gates it on `ev.ready` `caps` listing `sheetReload`, which a `sch` and a `pcb` frame list on such an engine). It is KiCad's own reload of the `.kicad_wks` the document names, with no window of KiCad's. A host sends it after `project.write` of that `.kicad_wks` (the drawing sheet editor's Save, a text save of the file), so every plot and print from then on carries the new sheet; a board's plot carries the old sheet until the reload. A sheet that does not read gives KiCad's default sheet, with no message; a sheet file that is missing still answers `{}`.

It is no edit: no undo step, the modified flag unchanged, no `ev.edited`.

The checks, in order, every one before any effect: args other than none or `{}` answer `bad_args`; in any frame but `sch` and `pcb` it answers `unsupported`; then as a schematic op in a `sch` frame and a board op in a `pcb` frame: `not_ready` before `ev.ready`, `unsupported` naming `kicadDrawingSheetReload` or `kicadCollabBusy` on an engine without it, `not_ready` with no document opened, `busy` while a load is parked, a popup menu or a dialog is up, or a placed item hangs off the pointer. Then the engine's reload: `not_applied` when it refuses (it refuses while an open is in flight), or when its apply queue does not empty within 30 s; else `{}` once it has.
