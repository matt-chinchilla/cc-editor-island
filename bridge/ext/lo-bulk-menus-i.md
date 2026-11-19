<!-- Copyright (C) 2026 Circuit Center Inc -->
<!-- SPDX-License-Identifier: MIT -->
<!-- part: section -->
### Edit in bulk's other doors: the bulk edits of KiCad's menus held

Island `v0.2.3-cc25`. Ten more actions of KiCad's open a window of its own that a tool of the host's Edit in bulk page replaces, so the island holds them and the frame sends `ev.held { action }` in their place (from KiCad's menus under `heldMenus`, and from a key where KiCad gives one); `action.run` of one answers `held`. Each is held only in its frame and only while `ev.ready` listed the cap of the op the host's tool runs, so a host that cannot run the tool never has the window taken from it:

- `pcb`, under `boardEdit` (`board.edit`): `pcbnew.GlobalEdit.editTracksAndVias` (the host opens Tracks and vias), `pcbnew.GlobalEdit.editTextAndGraphics` (Text and lines), `pcbnew.GlobalEdit.editTeardrops` (Teardrops), `pcbnew.GlobalEdit.swapLayers` (Swap layers), `pcbnew.GlobalEdit.globalDeletions` (Delete), and Tidy on the group it names: `pcbnew.GlobalEdit.cleanupTracksAndVias` (Tracks and vias), `pcbnew.GlobalEdit.removeUnusedPads` (Unused pads), `pcbnew.GlobalEdit.cleanupGraphics` (Drawings) and `pcbnew.Control.repairBoard` (Repair).
- `sch`, under `schEdit` (`sch.edit`): `eeschema.InteractiveEdit.editTextAndGraphics` (the host opens Text and lines).

`pcbnew.GlobalEdit.editTextAndGraphics` and `pcbnew.GlobalEdit.cleanupGraphics` are also held in an `fpedit` frame, where the footprint editor answers them with its own doors; a frame takes only the row that names it. None of the ten stands in our context menu, so the doors table (`bridge/ext/contextMenuDoors.json`) has no row for them.
