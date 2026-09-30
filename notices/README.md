<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# notices

The sources of the release's licence page and the census that guards it. `scripts/notices.mjs` reads them; `scripts/build.mjs` runs it after the Vite build, so every release carries `licenses.html`, `LICENSE.txt` and `NOTICE` in `dist/r/<islandId>/`, and a failed census stops the build before `dist/current` moves.

## The sources

| File | What it is | Where it comes from |
|---|---|---|
| `pcbjam-licenses.md` | PCBJam's own licences page, reproduced on ours under the heading "PCBJam's notices, reproduced as theirs" | `site/src/content/legal/licenses.md` at the PCBJam commit in `PIN.json` (copied by `npm run sync-upstream`) |
| `versions.sh` | The dependency versions and sha256 pins of PCBJam's build recipe | `scripts/common/versions.sh` at the same commit (copied by `npm run sync-upstream`) |
| `kicad-LICENSE.README` | KiCad's statement of its licences | `LICENSE.README` at the kicad-source-mirror gitlink in `PIN.json` |
| `phosphor-LICENSE` | The MIT notice of Phosphor Icons, whose Light style the redrawn toolbar glyphs follow | `LICENSE` of `phosphor-icons/core` |

The page also reads `PIN.json` (the islandId, the pinned commits, the engine files and the icon repack) and `LICENSE` (served beside the page as `LICENSE.txt`). Everything the page says of our own is written in `scripts/notices.mjs`; the reproduced texts go in unchanged.

## The page

`licenses.html` is plain HTML with an inline style sheet: no script, nothing loaded, and relative links only (`LICENSE.txt`, `NOTICE`). Every outside address is written as text. It holds:

1. the Appropriate Legal Notices of GPLv3 section 0: our copyright, no warranty, conveyed under GPLv3, the licence beside the page;
2. the section 6(d) directions: the release tag of this repository, the `cc/<islandId>` tags of the pcbjam, kicad-source-mirror and wxWidgets mirrors, the dependency source archives attached to the release, the build instructions, and the served engine files with their sha256;
3. the copied loader files we changed, each with the dated notices quoted from the file;
4. every dependency `versions.sh` names, with its licence, from the `DEPS` table in the script;
5. Phosphor's notice, PCBJam's page and KiCad's `LICENSE.README`, each reproduced as its authors wrote it.

`NOTICE` is the same content as plain text.

## The census

`node scripts/notices.mjs --check` runs it alone (`npm run notices` runs it and writes the page). It exits 1 with the name of what is wrong when:

- **(a)** a `NAME=` in `versions.sh` belongs to no `DEPS` entry. A variable belongs to the entry whose prefix it is or starts with followed by `_` (`OCC_URL` is OCCT's, `EMSDK_TARBALL_SHA256` is Emscripten's). A new dependency in the recipe therefore fails the build until it has a licence entry.
- **(b)** a file in `loader/src` differs from its copy in `loader/pristine` and carries no `Modified by Circuit Center on YYYY-MM-DD:` line, or its newest such line is dated before the pristine copy was taken. That date is the pristine file's last commit date when git holds it unchanged, else its mtime (so a fresh clone, whose files all carry the clone's mtime, does not fail on dates).
- **(c)** a copied file lost its original header. PCBJam's files carry no licence header at the pin, so the header kept is the pristine file's leading comment block, verbatim; a file that starts with code has none to keep. A file in `loader/src` with no pristine counterpart is ours and must carry our SPDX line.

The generator also refuses a page whose own prose has an en or em dash or speaks of a download, and a page that would load anything or link off itself.

## When the pin moves

`npm run sync-upstream` refreshes `loader/pristine` and the first three sources. Re-apply our changes to `loader/src` with fresh dated notices (the census sees the new pristine dates), add any new `versions.sh` dependency to `DEPS` with its real licence, and re-read the reproduced texts for anything our own prose then gets wrong.
