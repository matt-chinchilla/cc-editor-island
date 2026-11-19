<!-- Copyright (C) 2026 Circuit Center Inc -->
<!-- SPDX-License-Identifier: MIT -->
<!-- part: requests -->
| `board.padNets` | none | `{ pads: [{ ref: string, pad: string, net: string }], truncated: boolean }` |
| `sch.renameNets` | `{ preview: boolean, pads: [{ ref: string, pad: string, net: string }] }` | `{ preview: boolean, rows: [{ ref: string, pin: string, from: string, to: string, sheetPath: string, outcome: 'rename' \| 'add' \| 'refused', label?: string }], applied: number, truncated: boolean, depth: number }` |
<!-- part: section -->
### board.padNets
Reads every footprint pad's net in a `pcb` frame with a board open, the facts KiCad's own Update Schematic from PCB takes from the board (island `v0.2.3-cc25`, on an engine with `kicadBoardPadNets`, engine run 15; a host gates it on `ev.ready` `caps` listing `boardPadNets`, listed by `pcb` frames only). No args (absent or `{}`). The checks, in order: the args (`bad_args`); the frame (`unsupported`); the engine (`not_ready`, `unsupported` naming `kicadBoardPadNets`); a board open (`not_ready`); a load parked, a popup or a dialog up, or an item hanging off the pointer (`busy`). A read: answered during a `board.check` or a `sheet.check`, nothing changed, no undo step.

The answer lists `{ ref, pad, net }` per pad: the footprint's reference, the pad's number and its SHORT net name (as the schematic names it), at most 32,768 rows (`truncated` true when the board holds more). Board only footprints, pads with no net and pads with no number are left out. The rows are what `sch.renameNets` takes.

### sch.renameNets
Renames the schematic's nets from the board's, KiCad's own Update Schematic from PCB net name pass alone (no relink, no other field, no swaps), in a `sch` frame with a schematic open (island `v0.2.3-cc25`, on an engine with `kicadSchRenameNets` and `kicadCollabBusy`, engine run 15; a host gates it on `ev.ready` `caps` listing `renameNets`, listed by `sch` frames only). The args are exactly `{ preview, pads }`: a boolean and 1 to 32,768 rows of exactly `{ ref, pad, net }`, each a string of 1 to 1,024 characters with no control character (`board.padNets`'s rows, read in the board's frame and handed over by the host). The checks, in order, before any effect: the args (`bad_args`); the frame (`unsupported` "a schematic edits in a sch frame"); the engine (`not_ready`, `unsupported` naming the first missing export); a schematic open (`not_ready`); `busy` as for every schematic op. During a `board.check`, a `sheet.check` or an import it answers `busy`.

For each pad whose symbol pin (symbols matched by reference, power symbols left out) sits on a net of another name, a row: `ref`, the pin's number `pin`, the schematic's net name `from`, the board's `to`, the sheet path the symbol sits on, and the `outcome`: `rename` (the label that drives the net takes the board's name; `label` its uuid), `add` (no label drives the net, so a label is added at the pin; `label` its uuid when KiCad names it) or `refused` (a power symbol drives the net: nothing changes for it). Pins already on the board's name give no row.

- `preview: true` lists the rows with nothing changed: `applied` 0, `depth` the undo depth as it stands, no undo step.
- `preview: false` makes every rename and every added label as ONE commit "Update net names": one undo step (the reader's Undo takes all of it back), and an `ev.edited` once the depth moved. `applied` counts the rows not refused, `depth` the undo depth after.

The frame queues the run with a fresh `/tmp/cc-renameNets/<n>/` for its record, waits for the apply queue to empty and the record, and removes the folder whatever the answer. `not_applied` when the engine refused the run or no record came within about 60 s; `island_error` for a record of another shape. The fixture `tests/fixtures/rename-nets/` (a label SIG on R1 pin 2 and R2 pin 1, the board naming that net DATA) is read by `tests/e2e/lo/rename-nets.spec.ts` (its run 15 half on cc25).
