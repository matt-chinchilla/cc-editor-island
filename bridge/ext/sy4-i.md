<!-- Copyright (C) 2026 Circuit Center Inc -->
<!-- SPDX-License-Identifier: MIT -->
<!-- part: notes symbol.forEditor -->
- On engine run 15 (island `v0.2.3-cc25`) a placed part's text opened with `symedit.open` `mode` `placed` reads the designator prefix alone: `symedit.symbol.get` answers `refPrefix` `"U"` for U1, never `"U1"`, so `symedit.check` finds no `reference_prefix_digit` for it, and a `refPrefix` set there keeps the number (`IC` makes the Reference field `IC1`). Engine run 14 read the whole designator. `tests/e2e/symedit-faults.spec.ts`.
- On engine run 15 a `symedit.new` with `bodyStyles` `demorgan` makes a symbol with two body styles: its state and `symedit.symbol.get` read `bodyStyles.mode` `demorgan` and `symedit.show` steps to body style 2 (engine run 14 made one). `tests/e2e/symedit-faults.spec.ts`.
