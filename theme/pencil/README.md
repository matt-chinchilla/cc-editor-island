<!-- Copyright (C) 2026 Circuit Center Inc -->
<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# The wave units' pencil rows and chords

One file per unit, written ONLY by the ST-PRESS run (one generator run for every cluster), never by a unit seat:

- `theme/pencil/<unit>.json`: the unit's pencil rows, an array of `{ editor, strip, action, group?, section?, defaultKey?, press?, label? }`. `editor` is the editor's table (`sch`, `pcb`, or a frame a unit defines), `strip` the strip (`right`, `top`, `left`), `action` KiCad's action name, `defaultKey` KiCad's default key when `theme/pencil-tools.defaults.json` does not list the action, `press: "run"` for a row pressed by action name through `action.run` (no chord is seeded for it).
- `theme/hotkeys/<unit>.hotkeys`: chords of the unit's own frame in KiCad's hotkeys format (`action<TAB>primary<TAB>secondary`), as `theme/symedit.hotkeys` is for the symbol editor. `theme/seeds.ts` seeds every such file after the ledger, in file name order.

`node theme/pencil-tools.gen.mjs` reads every `theme/pencil/*.json` (`readUnitRows`) and appends its rows after the built in rows, in unit id order and then the file's order. A row with no pressable default takes the ledger's chord for its action, else the next free chord of the pool, appended to `theme/user.hotkeys`, so a chord never moves once handed out. A row already in the table is refused. With no unit file the table and the ledger stay byte for byte as they are (`theme/pencil-units.test.ts`).

Each file carries its notice in a `<file>.license` sidecar (JSON and the hotkeys format have no comments): `Copyright (C) 2026 Circuit Center Inc`, then the SPDX line.
