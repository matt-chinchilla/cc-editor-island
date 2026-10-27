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
  -> Enter / click: place {kind, lib, name, value?, footprint?}
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
| `place` | `{ kind, lib: string, name: string, value?: string, footprint?: string, mpn?: string, manufacturer?: string }` | `{}` once the item hangs off the pointer |

`lib` and `name` are strings of 1 to 255 characters with no control character; anything else, or an
extra key, is `bad_args`. `place`'s `value` and `footprint` (2026-10-26, the `fields` cap below) are
optional strings of 1 to 200 characters with no control character, else `bad_args`; a footprint takes
`value` alone, and a footprint's `footprint` is `bad_args`. `mpn` and `manufacturer` (2026-10-26, the
`identity` cap below) follow the same rules, a symbol's alone: a footprint's `mpn` or `manufacturer`
is `bad_args`. All four answer `not_ready` before `ev.ready`. The three library reads
answer either kind in either frame, outside the responder's serial request queue (they never touch
the engine: a `lib.item` waiting on a bundle holds up no `key.press`, `view.fit` or `place` sent
after it); `place` stays queued and frame-bound. `lib.item` answers a body
for an unknown library or item as null, not as an error. `lib.prefetch` passes unknown nicknames
over, and warms nothing when the island booted on its example library (no mirror).

`place` refusals, in the order they are checked: `bad_args` (a footprint's `footprint`, `mpn` or `manufacturer` among them,
before the frame's kind is read); `unsupported` (a symbol in a `pcb`
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
- `value` and `footprint` (2026-10-26) are written on the PLACED INSTANCE's Value and Footprint
  fields, at the library field's position and with its effects (the Footprint stays hidden); the
  definition the sheet's `lib_symbols` caches keeps the library's own Value and Footprint, so two
  instances of one symbol with different values share one entry. An absent one leaves the library's;
  a body with no Footprint field gets one, hidden. For a derived symbol they replace the flattened
  (inherited) fields on the instance alone.
- `mpn` and `manufacturer` (2026-10-26) are the part's identity, written on the PLACED INSTANCE as the
  fields `MPN` and `Manufacturer`, hidden (`(hide yes)`, at the symbol's origin, as an added Footprint
  is), after the library's fields, MPN first; never on the `lib_symbols` entry. A library field of that
  name takes the value at its own position with its own effects instead (no second field). Why: a
  sheet whose part number sits in Value alone is matched by a BOM reader as a part number read from
  a value (approximate), and the site's BOM keys on `MPN`/`Manufacturer` for an exact match.
- A footprint is named `lib:name` (a `.kicad_mod` names itself without its library), its format
  version as the body has it (the builder refuses one newer than the engine reads). `value` replaces
  its Value text (its `(property "Value" ...)`, or an older body's `(fp_text value ...)`); a body with
  neither gets the property on F.Fab. The footprint keeps its own name: that is the `lib:name` placed.
- One item at a time: a `place` while the previous item still hangs drops it first. When the reader
  drops a schematic item with Escape (or Undo), the island sends KiCad a second Escape: KiCad's
  placement tool stays armed after the first, and its next press would open KiCad's own chooser.
- The keyboard focus stays with the page: after the answer the page gives the frame the focus
  (`iframe.focus()`) so R rotates the item before the press.

**Which islands have the picker.** `ev.ready` `caps` lists the pseudo-cap `picker` (sorted in with the
engine exports) exactly when the ops and `ev.pick` are live: the library mirror loaded and the engine
has `kicadPlaceImportedItem` and `kicadCollabGetSelection`. The page requires both `picker` and
`kicadPlaceImportedItem`; the export alone proves nothing (the pinned engine has had it since PCBJam
v0.2.3, so islands without these ops list it too). On the example library (no mirror) there is no
`picker`: the island swallows no key, sends no `ev.pick`, and KiCad's own chooser works as before.
Ship order: the page that handles `ev.pick` first, then the island (an older page ignores `ev.pick`,
so the reader's A would do nothing).

**Which islands write the fields.** `ev.ready` `caps` lists the pseudo-cap `fields` (sorted in) exactly
when it lists `picker`, on islands whose `place` takes `value` and `footprint`. An older island's
`place` answers `bad_args` to them (its args are closed), so a host sends them only under `fields`,
and without it places as before and asks the reader to set the Value and the Footprint in the editor.

**Which islands write the identity.** `ev.ready` `caps` lists the pseudo-cap `identity` (sorted in)
exactly when it lists `picker` and `fields`, on islands whose `place` takes `mpn` and `manufacturer`.
An island that lists `fields` without `identity` answers `bad_args` to the whole `place` when either
is sent (its args are closed), so a host sends them only under `identity`, and without it places with
the Value and Footprint alone.

**Event `ev.pick { kind: "symbol" | "footprint", power?: true }`** (only with the `picker` cap): the
reader pressed the frame's place key inside the frame (`A` in a `sch` frame: symbol; `P` in a `sch` frame: power symbol, with
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

## 4. The design's own library (arriving with v0.2.3-cc12)

A part the reader brings from another library joins the design as its PROJECT LIBRARY, the KiCad
way: `<stem>_parts.kicad_sym`, `<stem>_parts.pretty/<footprint>.kicad_mod` and a row of each in the
project's own `sym-lib-table` and `fp-lib-table` (type `KiCad`, uri `${KIPRJMOD}/...`), all beside the
project file (`${KIPRJMOD}`: the folder of the document the frame opened). The page
writes them into each frame through `project.write`, then sends `project.libs { libs:
["<stem>_parts"] }` (PROTOCOL.md; the `projectLibs` cap), and from the answer on, with no reboot:

- `lib.item { kind, lib: "<stem>_parts", name }` reads the item from the project folder, a derived
  symbol with its chain from the same file, as for a mirror library; `place` puts it down as
  `<stem>_parts:<name>`, with `value`, `footprint`, `mpn` and `manufacturer` under the `fields` and
  `identity` caps as before. A registered nickname is read from the folder ahead of the mirror (the
  island refuses a project nickname its mirror already serves, so the two never meet).
- KiCad finds it too: its own choosers list it, a footprint loads by its `lib:name`, and Update PCB
  from Schematic (pressed through `key.press` as today) finds the symbol's `<stem>_parts:<footprint>`
  in the board frame's project library.
- `lib.index` stays the mirror's: it holds no project library. The page builds its "In this design"
  rows from the files it holds and merges them first; `lib.prefetch` of a project nickname warms
  nothing (the folder is read at every ask).
- Without the cap (an older island) the files are still written and saved with the design, and
  KiCad reads the project's own tables when the frame next opens the design: the part can be placed
  then.
