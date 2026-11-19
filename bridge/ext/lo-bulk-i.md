<!-- Copyright (C) 2026 Circuit Center Inc -->
<!-- SPDX-License-Identifier: MIT -->
<!-- part: section -->
### Edit in bulk's doors: Change, Update and the Zone manager held

Island `v0.2.3-cc25`. Nine actions of KiCad's open a window of its own that the host's Edit in bulk pages replace, so the island holds them and the frame sends `ev.held { action }` in their place (from a key, from KiCad's menus under `heldMenus`, and from a choice of our context menu, whose item carries `door: "held"`); `action.run` of one answers `held`. Each is held only in its frame and only while `ev.ready` listed the cap of the op the host's page runs, so a host that cannot run the page never has the window taken from it:

- `sch`, under `symbolExchange` (`symbols.exchange`): `eeschema.InteractiveEdit.changeSymbol`, `changeSymbols`, `updateSymbol` and `updateSymbols` (KiCad's Change and Update Symbols window). The host opens Edit in bulk on Refresh and swap.
- `pcb`, under `footprintExchange` (`footprints.exchange`): `pcbnew.GlobalEdit.changeFootprint`, `changeFootprints`, `updateFootprint` and `updateFootprints` (KiCad's Change and Update Footprints window). The host opens Edit in bulk on Refresh and swap.
- `pcb`, under `boardEdit` (`board.edit`): `pcbnew.Control.zonesManager` (KiCad's Zone manager). The host opens Edit in bulk on Copper areas.

The singular action names the selection, the plural one the whole design: the host reads its own selection when it opens the page. The doors table (`bridge/ext/contextMenuDoors.json`) names all nine `held`.
