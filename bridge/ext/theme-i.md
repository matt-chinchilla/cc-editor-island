<!-- Copyright (C) 2026 Circuit Center Inc -->
<!-- SPDX-License-Identifier: MIT -->
<!-- part: requests -->
| `theme.set` | `{ colors: KiCadColorTheme \| null }` | `{ ok: true }` |
<!-- part: codes -->
| `theme_frame` | `theme.set` in a frame whose editor the engine's color switch does not reach (on engine build T18b every frame but `sch` and `pcb`): nothing changes and nothing is kept; that frame boots in the kept colors the next time it opens. |
<!-- part: section -->
### theme.set

The running frame repaints in the canvas colors the host sends, live: no reload of the document, the view kept, KiCad's chrome still hidden (island after `v0.2.3-cc26`, on any engine with `kicadSetColorTheme`; a host gates it on `ev.ready` `caps` listing `theme`, which a `sch` and a `pcb` frame list on such an engine). `colors` is a whole KiCad color theme, the shape of the island's `theme/colors/circuitcenter.json` (`meta`, `schematic`, `board`, `3d_viewer`, `gerbview`): a key it leaves out takes KiCad's default for that key. `null` brings back the island's own palette (`circuitcenter`); `null` while the palette shows changes nothing and answers `{ ok: true }`.

The island writes the theme as a file of its own in the engine's colors folder, under a fresh name for every set, and switches to it through `kicadSetColorTheme`, the path of KiCad's own Preferences dialog (the frame's color theme setting, then its settings changed, which reloads the colors into the painter and recaches the view). The answer, `{ ok: true }`, comes once the engine's apply queue is empty and a frame has painted.

Every set that applied is kept on the island's own origin (localStorage, key `cc.island.theme`, partitioned by the page's site, so every island frame of one page reads it), and `null` forgets it, also when nothing was applied. Every frame of every kind boots in the kept colors in place of the palette (the drawing sheet editor with its sheet color laid over them, as over the palette), with no flash; a kept value that does not read as a theme is removed and the palette drawn. A host that sends its current theme at every `ev.ready`, `null` included, so corrects stale kept colors.

Only the schematic and board editors take the switch on engine build T18b: in a `symedit`, `fpedit` or `ds` frame the op answers `theme_frame` and no cap is listed (the engine's switch reaches only the top window as KiCad's schematic or board editor). A theme change while one of those editors is open reaches it the next time it opens.

A burst is coalesced: the op is answered off the request queue, a set that arrives while another waits replaces it, and the island runs one switch at a time, always the newest set waiting; every set is answered with the outcome of the switch that carried it. A set waits for the requests on the queue that came before it.

The checks, in order: args other than `{ colors }` with `colors` null or a plain object of at least one section, every section a plain object of strings, finite numbers, booleans and nested objects (at most 4 deep, no arrays or null, at most 256 KiB of JSON) answer `bad_args`; `not_ready` before `ev.ready`; `unsupported` naming `kicadSetColorTheme` or `kicadCollabBusy` on an engine without it; `theme_frame` in a frame the switch does not reach. Then, at its turn: `busy` when a request on the queue stays in flight past 15 s, while a load is parked, an import or a check runs, or a popup menu or a dialog is up; `not_applied` when the engine's apply queue does not empty within 15 s; `island_error` when the theme file cannot be written or the switch throws.

The engine's switch sets KiCad's chrome to its dark appearance for any theme (pcbjam `pcbjam_theme.h`: dark unless the theme is `_builtin_default`), so by day, after a set, KiCad's own panes draw dark once `chrome.show { on: true }` brings them back. The canvas is not affected, and a boot in the kept colors calls no switch.
