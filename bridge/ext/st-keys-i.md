<!-- Copyright (C) 2026 Circuit Center Inc -->
<!-- SPDX-License-Identifier: MIT -->
<!-- part: requests -->
| `keys.editor.get` | none | `{ editor: "sch" \| "pcb", actions: [{ action: string, key: string, default: string, label?: string, alt: string }] }` |
| `keys.editor.set` | `{ keys: { [action: string]: string } }` | `{}` |
<!-- part: codes -->
| `taken` | `keys.editor.set`: a key is a chord the island seeds for another tool of the pencil case (`theme/pencil-tools.json`); `message` names the key and that tool's action. Nothing was sent to the engine. |
<!-- part: section -->
### keys.editor.get and keys.editor.set
The editor's own hotkeys, read and set in a `sch` or `pcb` frame (island `v0.2.3-cc25`, on an engine with `kicadHotkeysGet` and `kicadHotkeysSet`, engine run 15; a host gates both on `ev.ready` `caps` listing `hotkeys`, listed by `sch` and `pcb` frames only). No KiCad window opens and no document is needed: the keys are the editor's, not the design's, and they last for the engine's life only, so a host sends its keys again after each `ev.ready`.

`keys.editor.get` takes no args and answers the frame's `editor` and every action of that editor's action manager with a friendly name (KiCad's own hotkey list rule): `eeschema.` actions in a `sch` frame, `pcbnew.` actions in a `pcb` frame, and `common.` actions in both, sorted by name. `key` is the key it holds now, `default` KiCad's default, `alt` its second key, each in KiCad's key grammar (`Ctrl+Shift+M`, `Num Pad 1`), `""` for none; `label` is KiCad's friendly name, left out when KiCad gives none. A read: answered during a `sheet.check` or `board.check`.

`keys.editor.set` takes exactly `{ keys }`: 1 to 2,048 action names, each with a key in KiCad's grammar of at most 32 characters, or `""` for no key. It writes each action's PRIMARY key and keeps its second key, all or nothing, then KiCad rebuilds its key map. It is no edit: no undo step, no modified flag, no `ev.edited`. A key that is a chord the island seeds for another tool answers `taken` and nothing is sent; an action's own seeded chord given back to it is taken.

The checks, in order: the args (`bad_args`); the frame (`unsupported`); the seeded chords (`taken`, a set); the engine (`not_ready` before `ev.ready`, `unsupported` naming `kicadHotkeysGet` or `kicadHotkeysSet`); a load parked, a popup menu or a dialog up (`busy`). The get answers `busy` when the engine answered nothing and `island_error` for an answer of another shape; the set answers `bad_args` "the engine refused the keys" when the engine refused them (an action this editor lacks, a key KiCad cannot read), nothing changed. A set answers `busy` during a check.

KiCad's hotkey list (`common.SuiteControl.listHotKeys`, Ctrl+F1 and its Help menu item) is held in `sch` and `pcb` frames under `heldKeys`: `ev.held { action: "common.SuiteControl.listHotKeys" }` goes to the host, which opens its own keys window, and no KiCad window opens.
