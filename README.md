<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# cc-editor-island

The Circuit Center editor island: the page that runs the KiCad editor in the browser inside a cross-origin iframe on circuitcenter.ai.

It holds PCBJam's KiCad in WebAssembly engine, pinned at PCBJam tag v0.2.3 (root commit and gitlinks in `PIN.json`), our own loader, and the responder for the `cc-editor/1` message protocol.

## Licence

This repository is GPL-3.0-or-later (see `LICENSE`). KiCad and PCBJam are GPL-3.0; the island follows the same licence. Files copied from PCBJam keep their original headers, and any we changed say so. `PROTOCOL.md` alone is MIT, so a host page can speak the protocol under any licence.

## Build

```bash
npm install
npm run sync-upstream   # check out PCBJam at the pin in PIN.json into upstream/
npm run fetch-engine    # download the engine files and verify each sha256
npm run build           # build dist/r/<islandId>/
npm run build:local     # the same build for the local pair
npm test                # unit tests (vitest)
npm run e2e             # browser tests (Playwright)
```

## Source offer

For every build we serve, the complete corresponding source is this repository at the release tagged with that build's `islandId` (for example `v0.2.3-cc1`), together with the `cc/<islandId>` tags on our four mirrors of PCBJam, KiCad, wxWidgets and pcbjam-shared.

## Publishing

Nothing here runs on its own; the owner runs each step, and each script takes `--dry-run` to read GitHub and print every write as `DRY: ...` instead.

1. Create this repository on GitHub (the owner's step, once): `gh repo create matt-chinchilla/cc-editor-island --public --source=. --push`.
2. `bash scripts/mirrors.sh`: forks pcbjam, kicad-source-mirror, wxWidgets and pcbjam-shared under matt-chinchilla once, then tags `cc/<islandId>` on each at the commits in `PIN.json`. A tag that exists at another commit is never moved.
3. `npm run build`, commit, then `bash scripts/release.sh`: assembles `release/<islandId>/` (the source tarball of HEAD, `SHA256SUMS` over every file that ships, the dependency source archives verified against the sha256 pins in `notices/versions.sh`, `RELEASE_NOTES.md`) and publishes the release tagged `<islandId>`.
4. `bash scripts/ship.sh <islandId>`: refuses unless the release `<islandId>` carries a `SHA256SUMS` that every file about to ship matches and the three mirror tags exist; then rsyncs `dist/r/<islandId>/` to the box, copies `island.json`, flips `current` with a rename and keeps two releases. It ships to prod: run `bash scripts/ship.sh --dry-run <islandId>` first.
