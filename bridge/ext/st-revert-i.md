<!-- Copyright (C) 2026 Circuit Center Inc -->
<!-- SPDX-License-Identifier: MIT -->
<!-- part: section -->
### The File card: KiCad's New, Open, Save As, Save a Copy and Revert held

Island `v0.2.3-cc25`. In a `sch` and a `pcb` frame, while `ev.ready` lists `heldKeys` and a document is open, `common.Control.new` (Ctrl+N), `common.Control.open` (Ctrl+O), `common.Control.saveAs` (Ctrl+Shift+S), `common.Control.saveCopy` and `common.Control.revert` are held: the press is dropped, nothing of KiCad's opens and the frame sends one `ev.held { action }`. The host owns the project's files and answers with its own File card: New and Open open Open another (with Exit's unsaved rule), Save As and Save a Copy open Save a copy, Revert opens Revert to saved (the saved files reopened through `project.open`). A key reaches the rows on every engine with `kicadHostActions`; the menu items reach them where `ev.ready` also lists `heldMenus` (engine run 15). KiCad's table gives Save a Copy and Revert no default chord. Open Recent has no action name in KiCad (a menu range) and is not held here. In a `symedit`, `fpedit` or `ds` frame these rows do not apply (those frames hold their own file actions).
