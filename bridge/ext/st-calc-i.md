<!-- Copyright (C) 2026 Circuit Center Inc -->
<!-- SPDX-License-Identifier: MIT -->
<!-- part: events -->
- `ev.openTool { frame: "calculator" }`: in a `sch` or `pcb` frame (island `v0.2.3-cc25`, cap `openCalculator`), KiCad's Tools > Calculator Tools asked for its PCB Calculator; the frame starts nothing and opens no window, and the host opens its own calculator.
<!-- part: section -->
### Calculator Tools (`openCalculator`)

Island `v0.2.3-cc25`. KiCad's PCB Calculator is a program of its own that the browser build cannot start: KiCad's Tools > Calculator Tools hands its name, `pcb_calculator`, to the frame, which sends `ev.openTool { frame: "calculator" }` and opens nothing (no window, no error). A key bound to the action `common.Control.showCalculatorTools` (it has no default key) is held as every held row is and sends `ev.held { action: "common.Control.showCalculatorTools" }`; on an engine whose menus ask the frame (`heldMenus`) the menu item is held the same way and sends `ev.held` in place of `ev.openTool`. A host answers both by opening its calculator. `ev.ready` lists `openCalculator` in a `sch` or `pcb` frame exactly when the engine has `kicadHostActions` (engine run 12 and later).
