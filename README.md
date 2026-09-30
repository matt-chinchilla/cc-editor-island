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
