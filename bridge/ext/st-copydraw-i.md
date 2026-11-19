<!-- Copyright (C) 2026 Circuit Center Inc -->
<!-- SPDX-License-Identifier: MIT -->
<!-- part: section -->
### Copy the drawing: KiCad's Export Drawing to Clipboard held

Island `v0.2.3-cc25`. In a `sch` frame, while `ev.ready` lists `heldKeys` and a document is open, `eeschema.EditorControl.drawSheetOnClipboard` (KiCad's File > Export > Drawing to Clipboard) is held: the press is dropped, nothing of KiCad's opens and the frame sends one `ev.held { action }`. KiCad would copy through its own clipboard, which never reaches the browser's; the host answers with its own Copy the drawing (`project.export` `sch_export_plot_svg` for the sheet on screen). A key reaches the row on every engine with `kicadHostActions`; the menu item reaches it where `ev.ready` also lists `heldMenus` (engine run 15). KiCad's table gives the action no default chord. In a `pcb` or `symedit` frame the action is not held.
