<!-- Copyright (C) 2026 Circuit Center Inc -->
<!-- SPDX-License-Identifier: MIT -->
<!-- part: requests -->
| `sim.command` | `{ analysis: SimAnalysis, options: SimOptions }` | `{ commands: string[] }` |
<!-- part: section -->
### sim.command

The lines a KiCad simulator workbook (`.wbk`) carries for one setup, so the host can write a workbook KiCad reads (island `v0.2.3-cc25`, in a `sch` frame whose engine has the simulator; a host gates it on `ev.ready` `caps` listing `simCommand`). `analysis` and `options` are read closed exactly as `sim.run` reads them; a number outside the SPICE grammar, a key not listed or a value of another type answers `bad_args`.

- `commands[0]` is the analysis line the island writes with its own writer, the line `sim.run` sends for the same analysis (`.tran 1u 5m`, `.ac dec 10 1 1meg`, `.noise v(/out) V1 dec 5 10 100k`). An FFT gives its own lines (`set specwindow=...` when a window is asked, `linearize ...`, `fft ...`), its signals written as given: pass KiCad's signal names (`V(/out)`). `{ kind: "sheet" }` writes no analysis line (the schematic's own directive stands).
- Then the option lines KiCad's workbook writes, in its order: `.save all` (voltages), `.probe alli` (currents), `.probe allp` (dissipations), `.kicad esavenone` (events not kept). Never `.kicad adjustpaths`: the model paths are the design's own. KiCad's defaults for a new tab (voltages, currents and events kept) give `.save all` and `.probe alli`.
- A read: no engine call, no document needed, answered during a check. The names of a DC sweep or a noise analysis are not checked against the netlist (`sim.run` checks them when the workbook runs); a DC sweep source that is not a V, I or R element, or a noise source that is not a V or I element, answers `bad_args` (`sim.command: C1 is not a source`), as `sim.run` refuses it.
- Outside a `sch` frame: `unsupported` (`the simulator runs in a sch frame`); an engine without the simulator's run exports: `unsupported` naming the first missing one.
