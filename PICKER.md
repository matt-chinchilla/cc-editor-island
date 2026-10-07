<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# The fast part picker (contract, 2026-10-07)

The owner's rule: placing a part must be fast, and the reader must not KNOW a library is loading;
libraries load when they are needed. KiCad's own symbol chooser enumerates all 222 symbol libraries
(22,776 symbols) before it opens, 11 to 15 s; our picker never asks the engine to enumerate.

```
reader presses A (or the pencil case's Add a part)
  -> the island swallows the key, sends ev.pick {kind}          (KiCad's chooser never opens)
  -> the page opens ITS picker; the search index is already in   (prefetched while the reader worked)
  -> typing filters 22,776 rows in the page, per keystroke        (no request)
  -> a highlighted row: lib.prefetch its library, lib.item draws its preview
  -> Enter / click: place {kind, lib, name}
  -> the island builds the clipboard blob from the cached bundle and calls the engine's
     kicadPlaceImportedItem: the part hangs off the pointer, the click commits it (undo, ev.edited)
```

KiCad's chooser stays reachable through KiCad's own menus (Show KiCad's menus); that path is
unchanged and still enumerates.

## 1. Library data (LIBRARY.md changes)

**Bundle format `ccl2` (replaces `ccl1`; nothing has shipped yet).** Header `"v":2`. A symbol body is
the symbol ALONE with KiCad's library header, never its `extends` chain: the engine's fat list links
every derived symbol to its parent once the whole library has merged (`linkExtends`, which "resolves
against the full m_cache after every body of the library has merged"), so the chain copies were 118 MB
of waste (351 MB bundled, 233 MB unique). A single-item read (`getItemBody`, `lib.item`, `place`)
assembles the self-contained body: the client reads `(extends "X")` from the body, prepends X's body
from the same bundle, repeats root first, and wraps them in one `kicad_symbol_lib` (the shape
`buildSelfContainedLib` writes). Footprint bodies are unchanged.

**`sym-index.json`** (gz-only like every file):

```json
{ "schema": 1, "tag": "10.0.4",
  "fields": ["lib", "name", "desc", "keys", "fp", "pins", "units", "power"],
  "rows": [["Device", "R", "Resistor", "R res resistor", "", 2, 1, 0], ...] }
```

One row per symbol, sorted by lib then name (code point). `lib` is the nickname (no `sym.` prefix).
`desc` = the symbol's Description property, `keys` = `ki_keywords`, `fp` = the Footprint property;
each inherited from the `extends` chain when the derived symbol leaves it empty or absent. `pins` =
distinct pin numbers over all units including inherited ones; `units` = unit count; `power` = 1 for a
power symbol (`(power)`), else 0. Empty strings, never null.

**`fp-search.json`**:

```json
{ "schema": 1, "tag": "10.0.4", "fields": ["lib", "name", "desc", "tags", "pads"],
  "rows": [["Resistor_SMD", "R_0603_1608Metric", "Resistor SMD 0603 ...", "resistor", 2], ...] }
```

`desc` = `(descr ...)`, `tags` = `(tags ...)`, `pads` = the same unique pad count as `fp-index.json`.

**Client additions** (`mirror-source.ts`):
- `getSearchIndex(kind: "symbol" | "footprint"): Promise<string | null>`: the raw JSON text, fetched
  once, kept in IndexedDB under `<tag>/index:<kind>`, null when the mirror is unavailable.
- `prefetch(id: string): Promise<void>`: warm one bundle at low fetch priority; never rejects.
- `getItemBody` for a symbol returns the assembled self-contained body (above).

## 2. Protocol additions (cc-editor/1, PROTOCOL.md)

| op | args | result |
| --- | --- | --- |
| `lib.index` | `{ kind: "symbol" \| "footprint" }` | `{ text: string \| null }` (the index JSON text; null without a mirror) |
| `lib.item` | `{ kind, lib: string, name: string }` | `{ body: string \| null }` (self-contained symbol lib, or the footprint text; null when absent) |
| `lib.prefetch` | `{ kind, libs: string[] }` (nicknames, at most 16) | `{}` at once; the bundles warm in the background |
| `place` | `{ kind, lib: string, name: string }` | `{}` once the item hangs off the pointer |

`place` refusals: `unsupported` (no `kicadPlaceImportedItem`, or a symbol in a `pcb` frame / a
footprint in a `sch` frame), `not_found` (no such item), `busy` (a dialog, a popup or a load is up),
`not_ready`, `island_error`. `place` is a new op the host may only send when `ev.ready` `caps` lists
`kicadPlaceImportedItem`.

**Event `ev.pick { kind: "symbol" | "footprint", power?: true }`**: the reader pressed the frame's
place key inside the frame (`A` in a `sch` frame: symbol; `P` in a `sch` frame: power symbol, with
`power: true`; `A` in a `pcb` frame: footprint), with no modifier, no KiCad dialog or popup up and no
text field focused. The island swallowed the key (KiCad's chooser does not open) and the host opens
its picker. A `key.press` of those keys from the host is swallowed the same way (the host opens its
picker directly instead of pressing them).

**Quiet warm-up (no event, no state):** once `ev.ready` has gone and the frame has been idle for a
moment, the island fetches the frame's search index (`sch` symbol, `pcb` footprint) and a short list
of common libraries at low priority: symbols `Device`, `power`, `Connector`, `Connector_Generic`,
`Switch`, `LED`, `Diode`, `Transistor_FET`, `Transistor_BJT`, `Regulator_Linear`; footprints
`Resistor_SMD`, `Capacitor_SMD`, `LED_SMD`, `Diode_SMD`, `Package_TO_SOT_SMD`,
`Connector_PinHeader_2.54mm`. It stops on `shutdown` and `pagehide`. Nothing is shown.

## 3. The page's picker (circuits-com `/viewer`, Edit mode)

- Opens on `ev.pick`, on the pencil case's Add a part (schematic), Place a part (board) and the power
  tool; never presses KiCad's key for them while the `place` cap is present (older islands: the key,
  as today).
- Search runs in the page over the index rows, per keystroke, no request, ranked: exact name, name
  prefix, name substring, keyword, description; ties by shorter name. Top 100 rendered.
- The highlighted row prefetches its library and draws a preview from `lib.item` (symbol: body
  graphics and pins of unit 1; footprint: pads and courtyard/fab outline), in the viewer's own tokens,
  day and night. No "loading libraries" words anywhere: a row's preview fades in when its body
  arrives; a place that waits for its bundle waits silently (the pointer shows the part when it lands).
- Esc closes, Enter places the highlighted row, arrows move, the field keeps its text for the
  session.
