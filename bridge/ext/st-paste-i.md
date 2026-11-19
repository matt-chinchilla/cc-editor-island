<!-- Copyright (C) 2026 Circuit Center Inc -->
<!-- SPDX-License-Identifier: MIT -->
<!-- part: requests -->
| `paste.special` | `{ mode: "unique" \| "keep" \| "remove", clearNets?: boolean }` | `{}` once the items hang off the pointer |
<!-- part: section -->
### paste.special
KiCad's own Paste Special with the host's choice and no window of KiCad's (island `v0.2.3-cc25`, on an engine with `kicadPasteSpecial` and `kicadCollabGetSelection`, engine run 15; a host gates it on `ev.ready` `caps` listing `pasteSpecial`, listed by a `sch` and a `pcb` frame on such an engine). What KiCad's clipboard holds (a Ctrl+C or Ctrl+X pressed through `key.press`, or text the frame received) is pasted as KiCad's Paste Special pastes it.

- `mode`: the designators of the pasted parts. `"unique"` gives each a new designator (KiCad's next free number), `"keep"` keeps the copied ones (the checker then flags the duplicates), `"remove"` clears them (`R?`).
- `clearNets` (optional, false when absent): a board only. True pastes a board clip with no net names; on copper KiCad still gives a track the net it lands on. True in a `sch` frame answers `bad_args` "paste.special: clearNets is a board choice".

Any other key or type answers `bad_args` "paste.special". The checks, in order, before any effect: the args (`bad_args`); the frame (any frame but `sch` and `pcb` answers `unsupported` "a paste runs in a sch or pcb frame"); the engine (`not_ready`, `unsupported` naming the first missing export, so on engine run 14 `unsupported` "kicadPasteSpecial"); a document open (`not_ready`); a load parked, a popup or a dialog up, or an item hanging off the pointer (`busy`).

The answer `{}` comes once the items hang off the pointer, read as `place` reads its item (the selection holds a uuid it did not hold before) within the same bound. A click lands them as ONE commit, one undo step and an `ev.edited`; Esc leaves nothing and no undo step. The hanging paste is joined to `place`'s watch: every gate answers `busy` until it ends, and a later `place` cancels it first. `busy` "paste.special: the editor cannot paste now" when the engine refuses the call; `not_applied` when KiCad put nothing on the pointer within about 10 s (the clipboard holds nothing it pastes).

KiCad's own Paste Special (Ctrl+Shift+V and its menu item) opens nothing: under `pasteSpecial` a `sch` and a `pcb` frame hold `common.Interactive.pasteSpecial`, which sends `ev.held { action }`; the host opens its own choices.
