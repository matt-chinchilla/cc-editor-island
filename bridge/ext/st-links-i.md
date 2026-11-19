<!-- Copyright (C) 2026 Circuit Center Inc -->
<!-- SPDX-License-Identifier: MIT -->
<!-- part: section -->
### Show Footprint Associations held

Island `v0.2.3-cc25`. KiCad's Inspect > Show Footprint Associations (`pcbnew.InspectionTool.ShowFootprintAssociations`) opens a window of KiCad's own that the host's Linked to block of the board form replaces (the footprint's source and the schematic part it belongs to, read through `board.footprints`), so the island holds it in a `pcb` frame and the frame sends `ev.held { action }` in its place (from a key, and from KiCad's menus under `heldMenus`); `action.run` of it answers `held`. It is held only while `ev.ready` listed `boardFootprints`, so a host that cannot read the links never has the window taken from it. A `sch` or `symedit` frame never holds it.
