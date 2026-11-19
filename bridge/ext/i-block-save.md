<!-- Copyright (C) 2026 Circuit Center Inc -->
<!-- SPDX-License-Identifier: MIT -->
<!-- part: requests -->
| `block.save` | `{ scope: "sheet" \| "selection" \| "board" \| "linkedGroup", name: string, sheetPath?: string }` (`sheetPath` with `sheet` only) | `{ files: [{ path: string, text: string }] }` |
<!-- part: codes -->
| `block_failed` | a design block op KiCad refused or could not finish (`block.save`: no sheet at that path, a sheet holding sheets, nothing selected, no single selected group linked to a block); `message` is KiCad's first line. Nothing changed. |
<!-- part: section -->
### block.save

Island `v0.2.3-cc25`, in a `sch` or a `pcb` frame, on an engine with `kicadDesignBlockSave` and `kicadCollabBusy` (engine run 15, unit e-block-save). It writes part of the open design as a design block's file with KiCad's own writers and no KiCad window: no overwrite question, no properties dialog, no library write. The host keeps the file beside the block's description (`<name>.json`, the host's own) in its block folder and adds the library row itself.

- `scope`: in a `sch` frame `sheet` (the sheet at `sheetPath`, in `project.open`'s sheet path form: `/` for the root, then one uuid and a slash per level) or `selection` (the selected items; a single selected sheet saves that sheet, a single selected group its children); in a `pcb` frame `board` (the whole board), `selection` (the selected items with their nets) or `linkedGroup` (the one selected group placed from a design block, as KiCad's Save to Linked Design Block). A scope of the other frame answers `unsupported` ("scope board is saved in a pcb frame"); any other frame answers `unsupported` ("a design block is saved in a sch or pcb frame").
- `name`: 1 to 120 characters, none of `/`, `\`, `:` or a control character, never `.` or `..`.
- The answer is `{ files }`, one file: `<name>.kicad_sch` in a `sch` frame, `<name>.kicad_pcb` in a `pcb` frame, `text` the file as KiCad wrote it (UTF-8). It comes once the engine's apply queue is empty and the run's record is there.
- Nothing in the design changes: no undo step, the modified flag as it was, the selection not grouped, no `ev.edited`.
- The checks, in order, every one before any effect: the args (`bad_args`, `message` the op); the frame and the scope (`unsupported`); the engine (`not_ready` before it is up; `unsupported` naming the first missing export, so on engine run 14 `unsupported` "kicadDesignBlockSave"); a document open (`not_ready`); a load parked, a popup menu, a dialog up or a placed item on the pointer (`busy`). Then `block_failed` with KiCad's first line when KiCad refuses (the root sheet or any sheet holding sheets: "Design blocks with nested sheets are not supported."; a path no sheet has: "No sheet has that path."; nothing selected; `linkedGroup` without exactly one selected group linked to a block), `not_applied` when the engine refuses the call or no record comes within about 60 s, `island_error` for a record or file of another shape.
- The run's folder under `/tmp/cc-blocksave/` is removed after every answer.
