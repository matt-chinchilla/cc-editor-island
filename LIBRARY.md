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
  asks share one fetch. The header is checked before anything is kept: `v` is 1, `id` and `kind`
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
  the raw bytes. `getItemBody` decodes one slice. A library the manifest does not name is an
  empty library and is never fetched. Checked bundles stay in memory up to 48 MB (the newest is
  always kept), since the engine reads a library's names and then its bodies back to back; past
  that they are read back from IndexedDB.
- **`getFpIndex`** passes `fp-index.json` through as text (default HTTP caching: the file is
  immutable at its tag). A 404 or an error answers null and the null is not kept, so the engine's
  next chooser asks again (its `pcbjamFpIndex()` caches only a non-null answer).
- **`presync({kind, concurrency, onProgress, signal})`** fetches the kind's bundles that are not
  stored yet, `concurrency` at a time (default 8), in manifest order; progress is reported per
  library as it completes; a library that fails is logged and skipped (it still loads on
  demand); `signal` stops it between libraries; it never rejects. **`syncState(kind)`** reads only
  the stored keys: `warm` is how many of the kind are stored, `coldBytes` sums the manifest
  `bytes` of the rest, `sizesKnown` is false when an entry has no `bytes`.

### What the engine asks for (measured 2026-10-07)

Measured in Chromium over the local pair (`tests/e2e/libs.spec.ts`) with a mirror of 6 symbol and
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

### The local pair

`LIBS_DIR=<dir> node tests/serve.mjs` (or `LIBS_DIR=<dir> npm run e2e`) serves `<dir>` as the
island's `/libs/`, so `<dir>` holds `<tag>/manifest.json.gz` and the rest, gzip only, sent with
`Content-Encoding: gzip` as nginx's `gzip_static` would. Without it `/libs/` is a 404 and the island
boots on its example library. `node tests/libs/make-mirror.mjs [outDir]` builds a small
conformant mirror (default `tests/libs/out`, gitignored) from KiCad's own files at the tag, fetched
from gitlab and kept in `outDir/.src`; `tests/e2e/libs.spec.ts` runs its mirror tests only when
`LIBS_DIR` is set, and its fallback test always.
