<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# cc-editor-island

The Circuit Center editor island: the page that runs the KiCad editor in the browser inside a cross-origin iframe on circuitcenter.ai.

It holds PCBJam's KiCad in WebAssembly engine, pinned at PCBJam tag v0.2.3 (root commit and gitlinks in `PIN.json`), our own loader, and the responder for the `cc-editor/1` message protocol.

## Licence

This repository is GPL-3.0-or-later (see `LICENSE`). KiCad and PCBJam are GPL-3.0; the island follows the same licence. Files copied from PCBJam keep their original headers, and any we changed say so. `PROTOCOL.md` alone is MIT, so a host page can speak the protocol under any licence.

## Build

A fresh clone builds with Node (22 is what the island is built with) and network access to cdn.pcbjam.com, where `fetch-engine` reads the pinned engine files:

```bash
npm ci                              # the pinned dependencies from package-lock.json
npx playwright install chromium     # the browser the icon rasteriser uses (add firefox for the full e2e)
npm run fetch-engine                # fetch PCBJam's engine files for the pin and verify each sha256 against PIN.json
npm run build                       # build dist/r/<islandId>/, dist/island.json and dist/current
```

Then `npm test` runs the unit tests (vitest), `npm run typecheck` the type check, and `npm run e2e` the browser tests over the local pair (Playwright, Chromium and Firefox).

`npm run build` refuses unless every engine file hashes to its row in `PIN.json`, the stock icon archive hashes to `PIN.json` `icons.stockArchiveSha256`, and every glyph source in `theme/icons/src` hashes to its row in `icons.inputs`. It then rasterises the glyphs through Playwright's Chromium (`theme/icons/rasterise.mjs`) and repacks the icon archive (`theme/icons/repack.mjs`) on every build. The repacked archive's sha256 is an output, not a pin: PNG bytes differ between Chromium builds, so the build records it in `icons.repackedSha256` (a clone on another machine may see `PIN.json` change there) and never refuses on it. The release's `SHA256SUMS` pins the bytes that ship. After a reviewed glyph change, `node theme/icons/inputs.mjs --pin` records the new sources.

`loader/` (our copy of PCBJam's loader, `loader/pristine` beside it) and `notices/` are committed, so a build needs neither `upstream/` nor the GitHub CLI. `npm run sync-upstream` checks PCBJam out at the pin into `upstream/`; it is a step for bumping the pin only, and it needs `gh` signed in.

## Memory

The engine parks its main loop and its tool coroutines on suspended WebAssembly stacks, and a suspended stack keeps its frame's whole realm alive. Before the teardown (`src/teardown.ts`), every removed editor frame kept its document and its engine for the life of the page: ten boots and removals kept about 3.6 GB of renderer memory in Chrome. The island now releases the engine on the `shutdown` op and on `pagehide` (`PROTOCOL.md`). Measured in Chrome 154 over ten boots and removals, with the op or with removal alone: documents, DOM nodes, listeners and the JS heap return to their pre-boot values after every removal, and the renderer ends 96 to 161 MB above where it started. That residual, 7 to 14 MB per boot, sits in Chrome's own allocator (PartitionAlloc), outside the engine's realm. Firefox was not measured.

## Source offer

For every build we serve, the complete corresponding source is this repository at the release tagged with that build's `islandId` (for example `v0.2.3-cc1`), together with the `cc/<islandId>` tags on our four mirrors of PCBJam, KiCad, wxWidgets and pcbjam-shared.

## Publishing

Publishing is the owner's: nothing here runs on its own, the owner runs each step below, and each script takes `--dry-run` to read GitHub and print every write as `DRY: ...` instead.

1. Create this repository on GitHub (the owner's step, once): `gh repo create matt-chinchilla/cc-editor-island --public --source=. --push`.
2. `bash scripts/mirrors.sh`: forks pcbjam, kicad-source-mirror, wxWidgets and pcbjam-shared under matt-chinchilla once, then tags `cc/<islandId>` on each at the commits in `PIN.json`. A tag that exists at another commit is never moved.
3. `npm run build`, commit, then `bash scripts/release.sh`: assembles `release/<islandId>/` (the source tarball of HEAD, `SHA256SUMS` over every file that ships, the dependency source archives verified against the sha256 pins in `notices/versions.sh`, `RELEASE_NOTES.md`) and publishes the release tagged `<islandId>`.
4. `bash scripts/ship.sh <islandId>`: refuses unless the release `<islandId>` carries a `SHA256SUMS` that every file about to ship matches and the three mirror tags exist; then rsyncs `dist/r/<islandId>/` to the box, copies `island.json`, flips `current` with a rename and keeps two releases. It ships to prod: run `bash scripts/ship.sh --dry-run <islandId>` first.
