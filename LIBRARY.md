<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# The KiCad library mirror

The editor's symbol and footprint libraries: KiCad's own libraries, unchanged in content, at the tag
matching the engine's KiCad version (`PIN.json` `libs`). Served from the island origin under
`/libs/<tag>/`, immutable, never rewritten. KiCad's libraries are CC BY-SA 4.0 with the KiCad
libraries exception; `LICENSE.md` ships beside them.

## Why one file per library, not one per item

The engine's library plugins (`SCH_IO_PCBJAM_LIB`, `PCB_IO_PCBJAM_FP` in PCBJam's KiCad fork) read a
library in ONE bridge crossing when they enumerate it (`request("list", uri, "bodies")`, the "fat
list"), and the symbol chooser enumerates every symbol library. Per-item files would turn one
chooser open into tens of thousands of requests. A single item is still asked for with `get` (a
footprint loaded by name, Update PCB from Schematic); that is answered from the same bundle.

## Layout

```
/libs/<tag>/manifest.json    the top index (below)
/libs/<tag>/fp-index.json    the footprint index (below)
/libs/<tag>/<id>.bin         one bundle per library (below)
/libs/<tag>/LICENSE.md       KiCad's library licence, both repositories' files
/libs/<tag>/SHA256SUMS       sha256 of every file above, as stored
```

Every file is stored gzipped ONLY (`<name>.gz`, level 9, `mtime` 0); nginx serves it with
`gzip_static always` (`gunzip on` for a client without gzip), the local test server the same way.
`.json` is `application/json`, `.bin` falls to `application/octet-stream`.

## Library ids

`sym.<nickname>` for a symbol library, `fp.<nickname>` for a footprint library, where `<nickname>`
is KiCad's own library nickname (`Device`, `Resistor_SMD`, `Connector_PinHeader_2.54mm`). The prefix
is needed: `Battery`, `Connector`, `Crystal`, `Fuse` and others exist in both kinds. The id is the
`/mnt/pcbjam/<id>` URI tail; the lib-table row's `name` is the bare nickname, so a project's
`Device:R` and `Resistor_SMD:R_0603_1608Metric` resolve. In a URL the id is `encodeURIComponent`ed.

## manifest.json

```json
{ "schema": 1, "tag": "10.0.4",
  "libs": [ { "id": "sym.Device", "name": "Device", "kind": "symbol", "itemCount": 568, "bytes": 391245,
              "description": "..." } ] }
```

`libs` sorted by `id`. `bytes` is the stored (gzipped) size of the bundle. `description` is the
lib-table description from KiCad's own `sym-lib-table` / `fp-lib-table` at the tag, or absent.

## fp-index.json

```json
{ "schema": 1, "tag": "10.0.4", "libs": { "fp.Resistor_SMD": [["R_0603_1608Metric", 2], ...] } }
```

Keyed by footprint library id (the engine's `pcbjamFpIndex()` keys by the URI tail). Each entry is
the footprint name and its unique electrical pad count (KiCad's
`GetUniquePadCount(DO_NOT_INCLUDE_NPTH)`: distinct pad numbers over pads that are not NPTH and not
unnumbered), so the chooser's footprint filter never loads a body.

## Bundle (`<id>.bin`, format `ccl1`)

```
{"v":1,"id":"sym.Device","kind":"symbol","items":[["C",1043],["R",987],...]}\n<body bytes><body bytes>...
```

One line of JSON (no newline inside it), a `\n`, then every item's body as raw UTF-8, concatenated
in `items` order, `items` sorted by name (code point order). The number is the body's length in
BYTES. A reader slices the bodies out of the buffer and never re-encodes them.

- **Symbol body:** a complete, self-contained `kicad_symbol_lib` s-expression holding the symbol
  and, before it, every symbol of its `extends` chain, root first (the way PCBJam's
  `buildSelfContainedLib` writes it), with the library header of KiCad's own file.
- **Footprint body:** the `.kicad_mod` file text.

## The client

`loader/src/wasm/libs/mirror-source.ts`: a `LibsSource` over this layout. The manifest is read once
per session; a bundle is fetched once, kept in IndexedDB on the island origin keyed by tag and id,
and every later session reads it from there (no network). When the manifest cannot be read the
island boots on the built-in example library instead, so an island shipped before its library still
opens designs.
