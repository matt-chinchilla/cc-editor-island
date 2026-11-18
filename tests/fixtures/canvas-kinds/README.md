<!-- Copyright (C) 2026 Circuit Center Inc -->
<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# canvas-kinds

One design holding one of every schematic and board item kind, tables and groups, for the canvas command units of wave 2 (M1, M1x, M2, M3, M6, M12: `wave2-plan/addendum-canvas-commands.md` section 11). Maker: unit `m1-fx`.

## Source and license

Written by hand on 2026-11-18 as KiCad text (the schematic in KiCad 10's form, the board in KiCad 9's form with net numbers), then opened and saved once through the run 14 engine (island `v0.2.3-cc24`, `project.save` in a `sch` frame and then in a `pcb` frame), so each file is KiCad's own normalized form. No desktop KiCad and no outside tool wrote them.

- The files are under the island's license, GPL-3.0-or-later.
- The symbols `Device:R` and `74xx:74HC00` (flattened from `74LS00`, which it extends) and the footprints `Resistor_SMD:R_0603_1608Metric` and `Package_SO:SOIC-14_3.9x8.7mm_P1.27mm` are KiCad's own, from its libraries at tag 10.0.4, under CC BY-SA 4.0 with the KiCad libraries exception.
- The image is an 8 by 8 PNG made for this fixture.

`files.json` lists the files a project open reads (`tests/harness/parent.html?fixture=canvas-kinds`); `ids.json` names every fixed uuid below with its file and kind, for tests to read by name.

## What it holds

- `canvas-kinds.kicad_pro`: the project, naming the root and the sheet `child`.
- `canvas-kinds.kicad_sch`, the root: R1 (resistor); U1 (74HC00: KiCad's symbol has five units, the four gates A to D and the power unit E; units A and B are placed); three wires meeting at a junction; a bus with two bus entries, the bus label `D[0..3]` and the labels `D0` and `D1` on the entries' wires; a no-connect on R1 pin 2; one local label (`IN1`, so Increment reads it), one global label (`GOUT`), one hierarchical label (`HIER`) and one directive label; a text; a text box; a 3 by 3 table whose first cell spans two columns; a rectangle, a circle, an arc, a polyline of four corners and a small image; the sheet `child` whose two pins stand B_PIN above A_PIN while its file holds A_PIN above B_PIN; a group of R1 and the text.
- `child.kicad_sch`: the two hierarchical labels A_PIN and B_PIN.
- `canvas-kinds.kicad_pcb`: two copper layers; R1 and U1 (SOIC-14) footprints and a locked footprint R2 (board only); two tracks meeting at a 90 degree corner, a locked track, an arc track and a via (net T); a copper zone on F.Cu, a non copper zone on F.SilkS and a rule area; two overlapping polygons on F.SilkS (merge, subtract, intersect); two lines meeting at a corner and two lines that would meet if extended (fillet, chamfer, dogbone, extend); a rectangle on Edge.Cuts; a dimension; a text; a text box; a 2 by 2 table; a group of two lines; and three unrouted connections (route selected, select unconnected): R1 pad 1 to U1 pad 1 (net A), R1 pad 2 to U1 pad 2 (net B), R2 pad 1 to U1 pad 3 (net C).

## As the engine reads it (run 14)

- `sheet.tree` lists the root `/` (canvas-kinds.kicad_sch, page 1) and `/cc0ca4d5-0000-4000-8000-000000000150/` (child, child.kicad_sch, page 2).
- `board.item.get` answers the kinds `footprint`, `track`, `arc`, `via`, `zone` and `text`, and `other` with the types `rulearea`, `shape`, `dimension`, `textbox`, `table` and `group`. A table cell answers under its own uuid, as `other` with the type `table`. The non copper zone answers `zone` with no net.
- KiCad gives a dimension the uuid of the text inside it, so the dimension's uuid is the one written on its text.
- A second save through the engine writes every file back unchanged (`tests/e2e/m/m1-fx.spec.ts`).

## The uuids

The pads, the properties and the drawings inside the footprints carry the uuids the engine's one save gave them; every item below was fixed by hand.

| uuid | name | kind | file | note |
|---|---|---|---|---|
| `cc0ca4d5-0000-4000-8000-000000000100` | root | `schematic` | canvas-kinds.kicad_sch | the root sheet's own uuid |
| `cc0ca4d5-0000-4000-8000-000000000101` | R1 | `symbol` | canvas-kinds.kicad_sch | R1, Device:R, 10k, footprint Resistor_SMD:R_0603_1608Metric |
| `cc0ca4d5-0000-4000-8000-000000000102` | R1 pin 1 | `pin` | canvas-kinds.kicad_sch | R1 pin 1 |
| `cc0ca4d5-0000-4000-8000-000000000103` | R1 pin 2 | `pin` | canvas-kinds.kicad_sch | R1 pin 2 |
| `cc0ca4d5-0000-4000-8000-000000000104` | U1 unit A | `symbol` | canvas-kinds.kicad_sch | U1 unit A (1), 74xx:74HC00 |
| `cc0ca4d5-0000-4000-8000-000000000105` | U1 unit 1 pin 1 | `pin` | canvas-kinds.kicad_sch | U1 unit 1 pin 1 |
| `cc0ca4d5-0000-4000-8000-000000000106` | U1 unit 1 pin 2 | `pin` | canvas-kinds.kicad_sch | U1 unit 1 pin 2 |
| `cc0ca4d5-0000-4000-8000-000000000107` | U1 unit 1 pin 3 | `pin` | canvas-kinds.kicad_sch | U1 unit 1 pin 3 |
| `cc0ca4d5-0000-4000-8000-000000000108` | U1 unit B | `symbol` | canvas-kinds.kicad_sch | U1 unit B (2), 74xx:74HC00 |
| `cc0ca4d5-0000-4000-8000-000000000109` | U1 unit 2 pin 4 | `pin` | canvas-kinds.kicad_sch | U1 unit 2 pin 4 |
| `cc0ca4d5-0000-4000-8000-00000000010a` | U1 unit 2 pin 5 | `pin` | canvas-kinds.kicad_sch | U1 unit 2 pin 5 |
| `cc0ca4d5-0000-4000-8000-00000000010b` | U1 unit 2 pin 6 | `pin` | canvas-kinds.kicad_sch | U1 unit 2 pin 6 |
| `cc0ca4d5-0000-4000-8000-000000000110` | wire R1 up | `wire` | canvas-kinds.kicad_sch | R1 up |
| `cc0ca4d5-0000-4000-8000-000000000111` | wire left | `wire` | canvas-kinds.kicad_sch | left |
| `cc0ca4d5-0000-4000-8000-000000000112` | wire right | `wire` | canvas-kinds.kicad_sch | right |
| `cc0ca4d5-0000-4000-8000-000000000113` | wire D0 | `wire` | canvas-kinds.kicad_sch | D0 |
| `cc0ca4d5-0000-4000-8000-000000000114` | wire D1 | `wire` | canvas-kinds.kicad_sch | D1 |
| `cc0ca4d5-0000-4000-8000-000000000115` | bus | `bus` | canvas-kinds.kicad_sch | vertical, 127 from 45.72 to 76.2 |
| `cc0ca4d5-0000-4000-8000-000000000116` | bus entry D0 | `bus_entry` | canvas-kinds.kicad_sch | D0 |
| `cc0ca4d5-0000-4000-8000-000000000117` | bus entry D1 | `bus_entry` | canvas-kinds.kicad_sch | D1 |
| `cc0ca4d5-0000-4000-8000-000000000118` | junction | `junction` | canvas-kinds.kicad_sch | at 63.5, 50.8, where three wires meet |
| `cc0ca4d5-0000-4000-8000-000000000119` | no-connect | `no_connect` | canvas-kinds.kicad_sch | on R1 pin 2 |
| `cc0ca4d5-0000-4000-8000-00000000011a` | local label IN1 | `label` | canvas-kinds.kicad_sch | local label IN1 (Increment reads it) |
| `cc0ca4d5-0000-4000-8000-00000000011b` | bus label D[0..3] | `label` | canvas-kinds.kicad_sch | the bus's label D[0..3] |
| `cc0ca4d5-0000-4000-8000-00000000011c` | label D0 | `label` | canvas-kinds.kicad_sch | label D0 |
| `cc0ca4d5-0000-4000-8000-00000000011d` | label D1 | `label` | canvas-kinds.kicad_sch | label D1 |
| `cc0ca4d5-0000-4000-8000-00000000011e` | global label GOUT | `global_label` | canvas-kinds.kicad_sch | GOUT, input |
| `cc0ca4d5-0000-4000-8000-00000000011f` | hierarchical label HIER | `hierarchical_label` | canvas-kinds.kicad_sch | HIER, output, on the root |
| `cc0ca4d5-0000-4000-8000-000000000120` | directive label | `netclass_flag` | canvas-kinds.kicad_sch | a directive label, Netclass Default |
| `cc0ca4d5-0000-4000-8000-000000000121` | text | `text` | canvas-kinds.kicad_sch | "Canvas kinds" |
| `cc0ca4d5-0000-4000-8000-000000000122` | text box | `text_box` | canvas-kinds.kicad_sch | "A text box" |
| `cc0ca4d5-0000-4000-8000-00000000012f` | table | `table` | canvas-kinds.kicad_sch | 3 by 3; row 1 column 1 spans two columns |
| `cc0ca4d5-0000-4000-8000-000000000130` | table cell r0 c0 | `table_cell` | canvas-kinds.kicad_sch | r0 c0 (merged: spans two columns) |
| `cc0ca4d5-0000-4000-8000-000000000131` | table cell r0 c1 | `table_cell` | canvas-kinds.kicad_sch | r0 c1 (covered by the merge) |
| `cc0ca4d5-0000-4000-8000-000000000132` | table cell r0 c2 | `table_cell` | canvas-kinds.kicad_sch | r0 c2 |
| `cc0ca4d5-0000-4000-8000-000000000133` | table cell r1 c0 | `table_cell` | canvas-kinds.kicad_sch | r1 c0 |
| `cc0ca4d5-0000-4000-8000-000000000134` | table cell r1 c1 | `table_cell` | canvas-kinds.kicad_sch | r1 c1 |
| `cc0ca4d5-0000-4000-8000-000000000135` | table cell r1 c2 | `table_cell` | canvas-kinds.kicad_sch | r1 c2 |
| `cc0ca4d5-0000-4000-8000-000000000136` | table cell r2 c0 | `table_cell` | canvas-kinds.kicad_sch | r2 c0 |
| `cc0ca4d5-0000-4000-8000-000000000137` | table cell r2 c1 | `table_cell` | canvas-kinds.kicad_sch | r2 c1 |
| `cc0ca4d5-0000-4000-8000-000000000138` | table cell r2 c2 | `table_cell` | canvas-kinds.kicad_sch | r2 c2 |
| `cc0ca4d5-0000-4000-8000-000000000140` | rectangle | `rectangle` | canvas-kinds.kicad_sch |  |
| `cc0ca4d5-0000-4000-8000-000000000141` | circle | `circle` | canvas-kinds.kicad_sch |  |
| `cc0ca4d5-0000-4000-8000-000000000142` | arc | `arc` | canvas-kinds.kicad_sch |  |
| `cc0ca4d5-0000-4000-8000-000000000143` | polyline | `polyline` | canvas-kinds.kicad_sch | four corners |
| `cc0ca4d5-0000-4000-8000-000000000144` | image | `image` | canvas-kinds.kicad_sch | an 8 by 8 PNG |
| `cc0ca4d5-0000-4000-8000-000000000150` | sheet child | `sheet` | canvas-kinds.kicad_sch | sheet "child" (child.kicad_sch, page 2), pins B_PIN above A_PIN |
| `cc0ca4d5-0000-4000-8000-000000000151` | sheet pin B_PIN | `sheet_pin` | canvas-kinds.kicad_sch | B_PIN |
| `cc0ca4d5-0000-4000-8000-000000000152` | sheet pin A_PIN | `sheet_pin` | canvas-kinds.kicad_sch | A_PIN |
| `cc0ca4d5-0000-4000-8000-000000000160` | group R1 and text | `group` | canvas-kinds.kicad_sch | members R1 and the text |
| `cc0ca4d5-0000-4000-8000-000000000200` | child root | `schematic` | child.kicad_sch | the child file's own uuid |
| `cc0ca4d5-0000-4000-8000-000000000201` | child hierarchical label A_PIN | `hierarchical_label` | child.kicad_sch | A_PIN |
| `cc0ca4d5-0000-4000-8000-000000000202` | child hierarchical label B_PIN | `hierarchical_label` | child.kicad_sch | B_PIN |
| `cc0ca4d5-0000-4000-8000-000000000301` | fp R1 | `footprint` | canvas-kinds.kicad_pcb | R1, Resistor_SMD:R_0603_1608Metric, pads on nets A and B |
| `cc0ca4d5-0000-4000-8000-000000000302` | fp U1 | `footprint` | canvas-kinds.kicad_pcb | U1, Package_SO:SOIC-14_3.9x8.7mm_P1.27mm, pads 1 to 3 on nets A, B, C |
| `cc0ca4d5-0000-4000-8000-000000000303` | fp R2 locked | `footprint` | canvas-kinds.kicad_pcb | R2, locked, board only, pad 1 on net C |
| `cc0ca4d5-0000-4000-8000-000000000310` | track corner a | `track` | canvas-kinds.kicad_pcb | F.Cu, 140,90 to 150,90 (net T) |
| `cc0ca4d5-0000-4000-8000-000000000311` | track corner b | `track` | canvas-kinds.kicad_pcb | F.Cu, 150,90 to 150,100: the 90 degree corner with a |
| `cc0ca4d5-0000-4000-8000-000000000312` | track locked | `track` | canvas-kinds.kicad_pcb | B.Cu, locked |
| `cc0ca4d5-0000-4000-8000-000000000313` | arc track | `arc` | canvas-kinds.kicad_pcb | F.Cu |
| `cc0ca4d5-0000-4000-8000-000000000314` | via | `via` | canvas-kinds.kicad_pcb | through, at 150,100 |
| `cc0ca4d5-0000-4000-8000-000000000320` | copper zone | `zone` | canvas-kinds.kicad_pcb | copper zone on F.Cu, net Z |
| `cc0ca4d5-0000-4000-8000-000000000321` | silk zone | `zone` | canvas-kinds.kicad_pcb | non copper zone on F.SilkS |
| `cc0ca4d5-0000-4000-8000-000000000322` | rule area | `rulearea` | canvas-kinds.kicad_pcb | keep out of tracks, vias and pours on F.Cu |
| `cc0ca4d5-0000-4000-8000-000000000330` | polygon one | `shape` | canvas-kinds.kicad_pcb | polygon on F.SilkS, overlaps polygon two |
| `cc0ca4d5-0000-4000-8000-000000000331` | polygon two | `shape` | canvas-kinds.kicad_pcb | polygon on F.SilkS |
| `cc0ca4d5-0000-4000-8000-000000000332` | corner line a | `shape` | canvas-kinds.kicad_pcb | line, meets corner line b at 145,100 |
| `cc0ca4d5-0000-4000-8000-000000000333` | corner line b | `shape` | canvas-kinds.kicad_pcb | line |
| `cc0ca4d5-0000-4000-8000-000000000334` | open line a | `shape` | canvas-kinds.kicad_pcb | line that meets open line b if extended (165,100) |
| `cc0ca4d5-0000-4000-8000-000000000335` | open line b | `shape` | canvas-kinds.kicad_pcb | line |
| `cc0ca4d5-0000-4000-8000-000000000336` | board outline | `shape` | canvas-kinds.kicad_pcb | rectangle on Edge.Cuts, 95,85 to 175,140 |
| `cc0ca4d5-0000-4000-8000-000000000338` | dimension | `dimension` | canvas-kinds.kicad_pcb | aligned, on Cmts.User |
| `cc0ca4d5-0000-4000-8000-000000000339` | board text | `text` | canvas-kinds.kicad_pcb | "CANVAS" on F.SilkS |
| `cc0ca4d5-0000-4000-8000-00000000033a` | board text box | `textbox` | canvas-kinds.kicad_pcb | on F.SilkS |
| `cc0ca4d5-0000-4000-8000-000000000340` | board table | `table` | canvas-kinds.kicad_pcb | 2 by 2 on F.SilkS |
| `cc0ca4d5-0000-4000-8000-000000000341` | board table cell r0 c0 | `tablecell` | canvas-kinds.kicad_pcb | r0 c0 of the board table |
| `cc0ca4d5-0000-4000-8000-000000000342` | board table cell r0 c1 | `tablecell` | canvas-kinds.kicad_pcb | r0 c1 of the board table |
| `cc0ca4d5-0000-4000-8000-000000000343` | board table cell r1 c0 | `tablecell` | canvas-kinds.kicad_pcb | r1 c0 of the board table |
| `cc0ca4d5-0000-4000-8000-000000000344` | board table cell r1 c1 | `tablecell` | canvas-kinds.kicad_pcb | r1 c1 of the board table |
| `cc0ca4d5-0000-4000-8000-000000000350` | group line a | `shape` | canvas-kinds.kicad_pcb | line, in the board group |
| `cc0ca4d5-0000-4000-8000-000000000351` | group line b | `shape` | canvas-kinds.kicad_pcb | line, in the board group |
| `cc0ca4d5-0000-4000-8000-000000000352` | board group | `group` | canvas-kinds.kicad_pcb | members group line a and b |
