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
/libs/<tag>/sym-index.json   the picker's symbol search index (below, PICKER.md)
/libs/<tag>/fp-search.json   the picker's footprint search index (below, PICKER.md)
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

## sym-index.json and fp-search.json (the picker's search indexes)

```json
{ "schema": 1, "tag": "10.0.4",
  "fields": ["lib", "name", "desc", "keys", "fp", "pins", "units", "power"],
  "rows": [["Device", "R", "Resistor", "R res resistor", "", 2, 1, 0], ...] }
{ "schema": 1, "tag": "10.0.4", "fields": ["lib", "name", "desc", "tags", "pads"],
  "rows": [["Resistor_SMD", "R_0603_1608Metric", "Resistor SMD 0603 ...", "resistor", 2], ...] }
```

One row per item of every library the mirror holds (a `--only` build: of the libraries it built),
sorted by `lib` then `name` in code point order. `lib` is the nickname, no `sym.`/`fp.` prefix.
Strings are KiCad's text decoded with its lexer rules; absent is `""`, never null.

- **sym-index:** `desc` is the Description property, `keys` the `ki_keywords` property, `fp` the
  Footprint property, each taken from the nearest symbol up the `extends` chain that has it non-empty
  (the symbol itself first). `units` and `power` are the chain ROOT's, as KiCad's
  `LIB_SYMBOL::GetUnitCount` and `IsPower` ask the root of a derived symbol: `units` is the highest
  unit of its `<name>_<unit>_<style>` sub-symbols, at least 1 (the parser's count); `power` is 1 for
  `(power)`, `(power global)` or `(power local)`. `pins` is the number of distinct pin numbers over
  every unit and body style of every symbol of the chain; KiCad 10's stacked numbers
  (`[1,15,38,39]`, `[1-4]`) are expanded the way `ExpandStackedPinNotation` does, and an empty pin
  number (it maps onto no pad) is not counted.
- **fp-search:** `desc` is `(descr …)`, `tags` is `(tags …)`, `pads` the same unique pad count as
  `fp-index.json`.

Measured on the full mirror at 10.0.4: sym-index 22,776 rows, 4.2 MB (0.36 MB stored); fp-search
15,435 rows, 3.7 MB (0.32 MB stored). `JSON.parse` of either takes about 10 ms in Node 22.

## Bundle (`<id>.bin`, format `ccl2`)

```
{"v":2,"id":"sym.Device","kind":"symbol","items":[["C",1043],["R",987],...]}\n<body bytes><body bytes>...
```

One line of JSON (no newline inside it), a `\n`, then every item's body as raw UTF-8, concatenated
in `items` order, `items` sorted by name (code point order). The number is the body's length in
BYTES. A reader slices the bodies out of the buffer and never re-encodes them.

- **Symbol body:** a `kicad_symbol_lib` s-expression holding the symbol ALONE, under the library
  header of KiCad's own file (for a `.kicad_symdir` symbol, its file byte for byte), never its
  `extends` chain. The engine's fat list links every derived symbol to its parent once the whole
  library has merged (`linkExtends` in PCBJam's `SCH_IO_PCBJAM_LIB::fatLoad`), so the chain copies
  ccl1 carried were waste: 351.2 MB decoded for the symbol set on ccl1, 233.2 MB on ccl2 (14.2 MB
  stored on ccl1, 10.5 MB on ccl2). The builder still resolves every chain and refuses a cycle or a
  parent missing from the library. A single-item read is linked only against what it carries
  (`cacheLibDocument`), so the client assembles a derived symbol's chain for it (below).
- **Footprint body:** the `.kicad_mod` file text.

A ccl1 bundle (`"v":1`, the same framing with each symbol body carrying its chain) is refused by the
builder's read-back and by the client like any malformed bundle. Nothing on ccl1 shipped.

## The client

`loader/src/wasm/libs/mirror-source.ts` (with `bundle-store.ts`) is a `LibsSource` over this layout;
`src/libs.ts` chooses it at boot and starts its warm-up.

- **Manifest.** Read once per session from `/libs/<tag>/manifest.json` (`<tag>` is `PIN.json`
  `libs.tag`), with `cache: "no-cache"`. A network error or a 5xx is retried after 250, 750 and
  2000 ms, each attempt bounded at 10 s; a 404, or a manifest whose `schema` is not 1 or whose
  `tag` is not the pinned one, is final. A failure is never kept: the next call reads it again. The
  island reads it beside the browser probe and waits for it before the engine's fetch, because the
  lib tables are written from it. An entry is dropped (and the count logged) unless its id is
  unique and its prefix agrees with its `kind` (`sym.` symbol, `fp.` footprint), its `name` is
  non-empty, and `itemCount` and `bytes` are non-negative integers when present.
- **Fallback.** When the manifest cannot be read the island boots on the built-in example library
  (`static-source.ts`, two symbols), logs one line to the console, and tells the host nothing: no
  event, no state. An island shipped before its library still opens designs.
- **Bundles.** Fetched from `/libs/<tag>/<encodeURIComponent(id)>.bin` at most once: concurrent
  asks share one fetch. The header is checked before anything is kept: `v` is 2, `id` and `kind`
  are the ones the manifest gives, every item is `[name, length]` with a non-empty name seen once
  and a non-negative integer length, and the lengths sum to exactly the bytes after the header
  line. Anything else is a failure, never stored, and the next ask fetches again. Order is not
  checked (the reader looks names up). The client verifies no hash: the browser has already
  undone the gzip, so `SHA256SUMS` (over the stored files) is for the build and the box.
- **Store.** IndexedDB on the island origin: database `cc-libs`, store `bundles`, key
  `<tag>/<id>`, value the bundle's bytes as fetched (decoded). Every later session reads a stored
  bundle from there with no network. On its first open a session deletes every key of another
  tag, so a tag bump does not grow storage. No IndexedDB, an open that fails or takes over 5 s,
  or a write that throws (quota) leaves that bundle in memory for the session: never a failure,
  and still fetched only once. A stored bundle that fails its check is deleted and fetched again.
- **Reads.** `listItems` comes from the header. `getAllItems` (the fat list) returns
  `Uint8Array` views onto the bundle's one buffer: no copy, no `TextDecoder`; the provider frames
  the raw bytes, each symbol alone. `getItemBody` decodes one slice; for a symbol that
  `extends` another (`symbol-body.ts`) it reads the parent's body from the same bundle, and so on
  to the root, and returns one `kicad_symbol_lib` under the symbol's own header with the chain
  root first and the symbol last (the shape `buildSelfContainedLib` writes, so the body is byte for
  byte what ccl1 carried: checked for all 22,776 symbols of the full mirror, 12,244 of them
  derived). A missing parent or a cycle gives the body as it is and logs one line. A library the
  manifest does not name is an empty library and is never fetched. Checked bundles stay in memory
  up to 48 MB (the newest is always kept), since the engine reads a library's names and then its
  bodies back to back; on ccl2 that also holds the picker's quiet warm-up set (ten symbol and six
  footprint libraries, 30.1 MB decoded) with room for the biggest bundle (`sym.MCU_ST_STM32H7`,
  15.5 MB). Past it they are read back from IndexedDB.
- **`getSearchIndex(kind, {priority}?)`** (`"symbol"` reads `sym-index.json`, `"footprint"`
  `fp-search.json`) resolves the raw JSON text, read once per session: from IndexedDB (store
  `bundles`, key `<tag>/index:<kind>`) when a session stored it, else fetched (`priority` passed to
  `fetch`; concurrent asks share one read) and stored. The text is checked before it is kept or
  given (JSON, `schema` 1, the pinned tag, the kind's `fields` in order, a `rows` list); a stored
  copy that fails is deleted and fetched again. Null when the manifest cannot be read (no mirror;
  the index is then not asked for), on a 404, an error or a failed check; a null is never kept, so
  the next ask reads again. It never rejects.
- **`prefetch(id)`** warms one bundle: the same one load as every other ask of that bundle (the
  engine's, a presync's, another prefetch's), fetched with `{priority: "low"}` when the prefetch is
  what starts it (a browser that does not know fetch priority ignores it), read from IndexedDB when
  stored, checked, stored and held in the memory window. A library the manifest does not name is a
  no-op. It never rejects: a failure is logged, nothing is kept, and the bundle loads on demand.
- **`getFpIndex`** passes `fp-index.json` through as text (default HTTP caching: the file is
  immutable at its tag). A 404 or an error answers null and the null is not kept, so the engine's
  next chooser asks again (its `pcbjamFpIndex()` caches only a non-null answer).
- **`presync({kind, concurrency, onProgress, signal})`** fetches the kind's bundles that are not
  stored yet, `concurrency` at a time (default 8), in manifest order; progress is reported per
  library as it completes; a library that fails is logged and skipped (it still loads on
  demand); `signal` stops it between libraries; it never rejects. **`syncState(kind)`** reads only
  the stored keys: `warm` is how many of the kind are stored, `coldBytes` sums the manifest
  `bytes` of the rest, `sizesKnown` is false when an entry has no `bytes`.

### What the engine asks for (measured 2026-10-07, on ccl1)

These measurements predate ccl2 and the picker: they were taken on ccl1 bundles, through KiCad's own
choosers. Measured in Chromium over the local pair (`tests/e2e/libs.spec.ts`) with a mirror of 6 symbol and
5 footprint libraries built by `tests/libs/make-mirror.mjs`, on the Glasgow fixture, counting every
`/libs/` request and every op the provider logs:

| Moment | Requests | Provider ops |
| --- | --- | --- |
| Schematic frame: boot, project open, 3 to 8 s idle | `manifest.json` only | none |
| Board frame: boot, project open, 3 to 8 s idle | `manifest.json` only | none |
| Symbol chooser opened (place symbol, `A`) | each of the 6 symbol bundles once, `fp-index.json` once | 17 `get` (one per symbol placed in the open schematic, for its Already Placed list), then `list bodies` for every symbol library, then one `index` |
| Power chooser opened (place power symbol, `P`) | each of the 6 symbol bundles once | the same `get`s, then `list bodies` for every symbol library; no `index` |
| Footprint chooser opened (place footprint, `A`) | each of the 5 footprint bundles once | `list bodies` for every footprint library |
| Symbol chooser in a new session, same browser | `manifest.json`, `fp-index.json`, no bundle | as above |
| Symbol highlighted in the chooser, with a Footprint property (full mirror) | that footprint's bundle once (e.g. `fp.Package_QFP.bin`) | one `get` from the footprint preview; it starts no warm-up |

Neither frame enumerates a library at boot (the engine's adapters skip enumeration in `AsyncLoad`; a
library loads on first access). A chooser enumerates every library of its kind before it appears,
and the crossings are serial: without the warm-up below, with each bundle held 700 ms by the test,
the requests went out one at a time, 710 to 770 ms apart, and the symbol chooser appeared 5.1 s
after the key (6 bundles), the footprint chooser 4.1 s after it (5 bundles).

So the client stays lazy, and boot fetches nothing but the manifest: no presync after `ev.ready`,
no gate that holds a crossing. Instead the island passes an enumerate gate that holds nothing: the
first enumerate of a kind in a session starts `presync` for that kind, 8 at a time, and resolves at
once. Each serial crossing then waits only for its own bundle, which the warm-up already has in
flight (manifest order is the crossings' order). With each bundle held 400 ms the footprint
chooser appeared 1.0 s after the key, with all 5 bundles in flight together (2.0 s or more one at
a time). A `get` (one item: the Already Placed list, a footprint loaded by name) never starts
the warm-up. The warm-up stops on the `shutdown` op and on `pagehide`. None of this
changes `ev.state` or the protocol: the e2e checks that no `ev.state` follows the project open.

On the full mirror the first chooser of a kind on a browser therefore fetches every bundle of that
kind once, several at a time, before it appears; every later chooser, in that session or a later
one, reads IndexedDB. The engine fires `pcbjam:lib-loading` events on `window` around each fat
list (done and total per kind), which the island does not render yet.

### On the full mirror (measured 2026-10-07 on ccl1, local pair, no throttling)

The symbol chooser appears 15.2 to 15.8 s after the key in a fresh browser, about 70 % of it the engine enumerating
22,776 symbols rather than the network: the next session on the same storage takes 10.8 to 12.0 s with no bundle
request, and a reopen in the same session about 1 s (no enumeration). The footprint chooser takes 8.5 to 12.3 s
cold and 6.0 to 7.0 s in the next session. IndexedDB held 351.2 MB decoded for the ccl1 symbol set (Chromium's
`storage.estimate()` reports 36.3 MB) and 156.6 MB for the footprints (24.9 MB), so the 48 MB memory cap
keeps only the newest bundles and the rest are read back from IndexedDB. The ccl2 symbol set is 233.2 MB
decoded (not yet measured in the browser). The editor shows nothing of this
wait yet (the engine's `pcbjam:lib-loading` events are not rendered).

### The local pair

`LIBS_DIR=<dir> node tests/serve.mjs` (or `LIBS_DIR=<dir> npm run e2e`) serves `<dir>` as the
island's `/libs/`, so `<dir>` holds `<tag>/manifest.json.gz` and the rest, gzip only, sent with
`Content-Encoding: gzip` as nginx's `gzip_static` would. Without it `/libs/` is a 404 and the island
boots on its example library. `node tests/libs/make-mirror.mjs [outDir]` builds a small
mirror (default `tests/libs/out`, gitignored) from KiCad's own files at the tag, fetched from
gitlab and kept in `outDir/.src/<tag>/` as two small checkouts that the builder's own `buildMirror`
turns into a ccl2 mirror with both search indexes (6 symbol libraries, 13 symbols: a symbol's
`extends` chain is fetched with it, so Diode holds 1N4148 and its parent 1N4001; 5 footprint
libraries, 6 footprints), read back by `verifyMirror`; `tests/e2e/libs.spec.ts` runs its mirror
tests only when `LIBS_DIR` is set, and its fallback test always.
