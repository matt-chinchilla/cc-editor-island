<!-- Copyright (C) 2026 Circuit Center Inc -->
<!-- SPDX-License-Identifier: MIT -->
<!-- part: section -->
### Origins: the section `origins`

Island `v0.2.3-cc25`, on an engine of run 15 or later. `settings.get` and `settings.set` take one more board section, `origins`, in a `pcb` frame: the board's grid origin and its drill and place origin, with no KiCad window. A get answers `{ grid_origin: { x, y }, aux_origin: { x, y } }` in mm (KiCad's own names; `aux_origin` is the drill and place origin). A set's `value` names `grid_origin`, `aux_origin` or both, each exactly `{ x, y }`, finite numbers within 1000 mm of the page origin either way; `{ x: 0, y: 0 }` is KiCad's Reset. Another key, a part of an origin or a number past the bound is `bad_args` before the engine is asked; in a `sch` frame the section answers `unsupported` (`origins is a board setting`). Like every setting, a set makes no undo step; the two origin markers on the canvas move with it.

A host gates the section on `ev.ready` `caps` listing `settings:origins`, listed in a `pcb` frame exactly when the engine's `kicadSettingsSections()` names `origins` in its board half (never on engine run 14). Under that cap, while a document is open, KiCad's three origin actions are held in the `pcb` frame: `common.Control.editGridOrigin` (the grid origin window), `common.Control.gridResetOrigin` and `pcbnew.EditorControl.drillResetOrigin` send `ev.held { action }` and open nothing, and the host opens its own Origins fold instead. The schematic's grid origin reset is not held.
