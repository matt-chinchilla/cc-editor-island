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
  -> the island builds the clipboard blob from the item's body (a derived symbol flattened) and
     calls the engine's kicadPlaceImportedItem; it answers once the editor holds the part: the
     part hangs off the pointer, the click commits it (undo, ev.edited), Escape drops it
```

Measured on the local pair (2026-10-07, Chromium, no throttling), from the host's `place` to its
answer: 230 to 610 ms for a symbol whose bundle was not yet fetched (`MCU_ST_STM32F1`, 86 KB
gzipped), 115 to 280 ms once it is held; 310 to 530 ms cold and 220 to 430 ms warm for the LQFP-48 on
a board. The quiet warm-up fetched the full mirror's symbol index and 10 common libraries in 0.6 s.

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
| `lib.index` | `{ kind: "symbol" \| "footprint" }` | `{ text: string \| null }` (the index JSON text; null without a mirror or an index) |
| `lib.item` | `{ kind, lib: string, name: string }` | `{ body: string \| null }` (self-contained symbol lib, or the footprint text; null when absent) |
| `lib.prefetch` | `{ kind, libs: string[] }` (nicknames, at most 16) | `{}` at once; the bundles warm in the background |
| `place` | `{ kind, lib: string, name: string }` | `{}` once the item hangs off the pointer |

`lib` and `name` are strings of 1 to 255 characters with no control character; anything else, or an
extra key, is `bad_args`. All four answer `not_ready` before `ev.ready`. `lib.item` answers a body
for an unknown library or item as null, not as an error. `lib.prefetch` passes unknown nicknames
over, and warms nothing when the island booted on its example library (no mirror).

`place` refusals, in the order they are checked: `bad_args`; `unsupported` (a symbol in a `pcb`
frame or a footprint in a `sch` frame, or no `kicadPlaceImportedItem` / `kicadCollabGetSelection`);
`not_ready` (no engine, or no document opened by `project.open` / `project.import`); `busy` (a load,
a dialog or a popup menu is up; also when the engine says a load is in flight, or never takes the
item within about 10 s because a placement of KiCad's own is under way); `not_found` (no such
library or item, `message` `lib:name`); `island_error` (the engine refused the blob). The answer
waits for the editor's selection to hold the new item: `kicadPlaceImportedItem` answers `{ok:true}`
when it has only queued the blob, and logs a blob it cannot parse.

What `place` puts down (decided while building, 2026-10-07):
- A symbol is `lib:name` against the project's lib table. The sheet's `lib_symbols` takes no derived
  symbol (KiCad's schematic parser keeps no parent map there): with an `extends` entry the engine
  placed an STM32F103C8Tx with no pins. So a derived symbol is FLATTENED as KiCad's
  `LIB_SYMBOL::Flatten` does: the parents' flags, graphics and pins under the symbol's own name (the
  units renamed `<name>_<unit>_<style>`, the prefix KiCad's parser checks), a filled mandatory field,
  `ki_keywords` or `ki_fp_filters` of the child wins and an empty one inherits, any other field of
  the child replaces its parent's. The instance carries every library field (not the `ki_` ones) at
  its library position, as a chooser pick does, and the library's `exclude_from_sim`, `in_bom` and
  `on_board`; KiCad annotates it (`U1`, `#PWR01`).
- A footprint is named `lib:name` (a `.kicad_mod` names itself without its library), its format
  version as the body has it (the builder refuses one newer than the engine reads).
- One item at a time: a `place` while the previous item still hangs drops it first. When the reader
  drops a schematic item with Escape (or Undo), the island sends KiCad a second Escape: KiCad's
  placement tool stays armed after the first, and its next press would open KiCad's own chooser.
- The keyboard focus stays with the page: after the answer the page gives the frame the focus
  (`iframe.focus()`) so R rotates the item before the press.

**Which islands have `place`.** The pinned engine has exported `kicadPlaceImportedItem` since PCBJam
v0.2.3, so `ev.ready` `caps` lists it on islands without these ops too (they answer `unknown_op`).
The page sends `lib.index` once after `ev.ready` (it wants the index early anyway): `unknown_op`
means an older island, and the page keeps pressing KiCad's keys for it. Ship order: the page that
handles `ev.pick` first, then the island (an older page ignores `ev.pick`, so the reader's A would do
nothing).

**Event `ev.pick { kind: "symbol" | "footprint", power?: true }`**: the reader pressed the frame's
place key inside the frame (`A` in a `sch` frame: symbol; `P` in a `sch` frame: power symbol, with
`power: true`; `A` in a `pcb` frame: footprint), with no modifier, nothing of KiCad's over its
canvas (no popup menu, no dialog but a progress dialog, no other KiCad window such as its footprint
chooser frame) and no text field focused. The key counts by the character it types (the key that
types `a` on AZERTY; Caps Lock's `A` too). The island swallowed the keydown, keypress and keyup
(capture listeners installed before the engine's scripts load), so KiCad's chooser does not open, and
sends one `ev.pick` per press (repeats of a held key send none); the host opens its picker. A
`key.press` of those keys from the host is swallowed the same way and answers `{}` (the host opens
its picker directly instead of pressing them).

**Quiet warm-up (no event, no state):** once `ev.ready` has gone and no request has been in flight
for 1.5 s (so after the project's open), on the browser's next idle moment (at most 2 s later), the
island fetches the frame's search index (`sch` symbol, `pcb` footprint) at low priority, then the
common libraries of its kind that the mirror holds, one at a time through the mirror's `prefetch`:
symbols `Device`, `power`, `Connector`, `Connector_Generic`, `Switch`, `LED`, `Diode`,
`Transistor_FET`, `Transistor_BJT`, `Regulator_Linear`; footprints `Resistor_SMD`, `Capacitor_SMD`,
`LED_SMD`, `Diode_SMD`, `Package_TO_SOT_SMD`, `Connector_PinHeader_2.54mm`. It stops on `shutdown`
and `pagehide`, and never runs on the example library. Nothing is shown.

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
