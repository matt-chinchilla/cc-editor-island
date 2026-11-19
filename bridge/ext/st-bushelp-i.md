<!-- Copyright (C) 2026 Circuit Center Inc -->
<!-- SPDX-License-Identifier: MIT -->
<!-- part: section -->
### Show Bus Syntax Help, held

Island `v0.2.3-cc25`. In a `sch` frame KiCad's `eeschema.InspectionTool.showBusSyntaxHelp` (Inspect > Show Bus Syntax Help) is held under `heldKeys`: with a document open the press is dropped, no window of KiCad's opens, and the frame sends one `ev.held { action: "eeschema.InspectionTool.showBusSyntaxHelp" }`. The host answers it with its own card on how bus names are written. A key bound to the action reaches the row on every engine that asks the page (run 12 on); the menu item reaches it where `ev.ready` also lists `heldMenus` (engine run 15). In every other frame the action is KiCad's.
