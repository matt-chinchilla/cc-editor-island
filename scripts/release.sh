#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (c) 2026 Chirichella Inc.
#
# Builds the GitHub release of one island (spec D7, D8 and section 13): the
# source tarball of this repository at HEAD, SHA256SUMS over every file ship.sh
# sends, the dependency source archives the recipe pins by sha256, and
# RELEASE_NOTES.md. Everything is assembled in release/<islandId>/ (ignored by
# git); then the tag and the release are published.
#
#   bash scripts/release.sh --dry-run   assemble and verify, print the publish as "DRY: ..."
#   bash scripts/release.sh             assemble, verify, tag and publish
#
# Run it from a clean tree right after `npm run build`, so dist/ is HEAD's build.
set -euo pipefail
cd "$(dirname "$0")/.."

REPO=matt-chinchilla/cc-editor-island
OWNER=matt-chinchilla

DRY=0
case "${1:-}" in
  --dry-run) DRY=1 ;;
  '') ;;
  *) echo "usage: bash scripts/release.sh [--dry-run]" >&2; exit 2 ;;
esac

# Run a side-effecting command, or print it under --dry-run.
run() {
  if [ "$DRY" = 1 ]; then
    printf 'DRY:'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}
refuse() { echo "refused: $*" >&2; exit 1; }

pin() { node -p "require('./PIN.json').$1"; }
ID=$(pin islandId)
[[ "$ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || refuse "PIN.json islandId is not a plain tag name: $ID"
PCBJAM_TAG=$(pin pcbjam.tag)
ROOT_SHA=$(pin pcbjam.root)
KICAD_SHA=$(pin pcbjam.kicad)
WX_SHA=$(pin pcbjam.wxwidgets)
SHARED_SHA=$(pin pcbjam.shared)
REL="dist/r/$ID"
OUT="release/$ID"
SRC="cc-editor-island-$ID-src.tar.gz"
if [ "$DRY" = 1 ]; then echo "dry run: nothing is tagged, pushed or published"; fi

# ---------------------------------------------------------------- preconditions
[ -d "$REL" ] || refuse "there is no build at $REL; run npm run build first"
[ -f dist/island.json ] || refuse "dist/island.json is missing; run npm run build first"
built_id=$(node -p "require('./$REL/island.json').id")
[ "$built_id" = "$ID" ] || refuse "$REL/island.json says $built_id, PIN.json says $ID"
cmp -s dist/island.json "$REL/island.json" || refuse "dist/island.json differs from $REL/island.json"
[ -z "$(git status --porcelain)" ] || refuse "the working tree has changes; the source tarball is HEAD, so commit first"
HEAD_SHA=$(git rev-parse HEAD)
if gh release view "$ID" --repo "$REPO" >/dev/null 2>&1; then
  refuse "the release $ID already exists on $REPO; a release is never replaced, bump the islandId"
fi
echo "no release $ID on $REPO yet (expected)"

mkdir -p "$OUT/deps"
rm -f -- "${OUT:?}/${SRC:?}" "${OUT:?}/SHA256SUMS" "${OUT:?}/RELEASE_NOTES.md"

# ---------------------------------------------------------------- the source tarball
git archive --format=tar.gz --prefix="cc-editor-island-$ID/" -o "$OUT/$SRC" HEAD
echo "source: $OUT/$SRC ($HEAD_SHA)"

# ---------------------------------------------------------------- the dependency archives
# Every versions.sh row pinned by a sha256 has its archive attached, because
# the licence page says so. Rows that carry their own <NAME>_URL take it from
# versions.sh; for the rest the recipe composes the address in a build script,
# copied below from the pinned commit (the file each one comes from is named).
# A sha256 pin that neither covers fails the release until it is added here.
# versions.sh is evaluated in a clean environment: it is plain assignments,
# some with parameter expansions (OCC_URL), so only bash can read it exactly.
VERSIONS_READ='
  set -eu
  . ./notices/versions.sh
  for v in $(compgen -A variable | grep "_SHA256$" | sort); do
    p=${v%_SHA256}
    u="${p}_URL"
    printf "%s\t%s\t%s\n" "$p" "${!v}" "${!u:-}"
  done
'
versions_get() { env -i bash --noprofile --norc -c '. ./notices/versions.sh; printf %s "${!1}"' _ "$1"; }
mapfile -t ROWS < <(env -i bash --noprofile --norc -c "$VERSIONS_READ")
[ "${#ROWS[@]}" -gt 0 ] || refuse "notices/versions.sh pins nothing by sha256"
EMSCRIPTEN_VERSION=$(versions_get EMSCRIPTEN_VERSION)
GLM_VERSION=$(versions_get GLM_VERSION)
BOOST_VERSION=$(versions_get BOOST_VERSION)
CURL_VERSION=$(versions_get CURL_VERSION)
LIBGIT2_VERSION=$(versions_get LIBGIT2_VERSION)
PROTOBUF_VERSION=$(versions_get PROTOBUF_VERSION)
KICAD_RECIPE_COMMIT=$(versions_get KICAD_COMMIT)
RAPIDJSON_COMMIT=$(versions_get RAPIDJSON_COMMIT)

# The addresses the recipe composes, at commit 7ec51c1c (PIN.json pcbjam.root):
#   EMSDK_TARBALL  docker/Dockerfile
#   GLM            scripts/deps/build-glm.sh
#   BOOST          scripts/deps/build-boost.sh
#   CURL           scripts/deps/build-curl-headers.sh
#   LIBGIT2        scripts/deps/build-libgit2-headers.sh
#   PROTOBUF       scripts/deps/build-protobuf.sh
# Each line prints "<address> <file name>".
composed() {
  case "$1" in
    EMSDK_TARBALL) echo "https://github.com/emscripten-core/emsdk/archive/refs/tags/${EMSCRIPTEN_VERSION}.tar.gz emsdk-${EMSCRIPTEN_VERSION}.tar.gz" ;;
    GLM) echo "https://github.com/g-truc/glm/releases/download/${GLM_VERSION}/glm-${GLM_VERSION}.zip glm-${GLM_VERSION}.zip" ;;
    BOOST) echo "https://sourceforge.net/projects/boost/files/boost/${BOOST_VERSION}/boost_${BOOST_VERSION//./_}.tar.gz/download boost_${BOOST_VERSION//./_}.tar.gz" ;;
    CURL) echo "https://curl.se/download/curl-${CURL_VERSION}.tar.gz curl-${CURL_VERSION}.tar.gz" ;;
    LIBGIT2) echo "https://github.com/libgit2/libgit2/archive/refs/tags/v${LIBGIT2_VERSION}.tar.gz libgit2-${LIBGIT2_VERSION}.tar.gz" ;;
    PROTOBUF) echo "https://github.com/protocolbuffers/protobuf/releases/download/v${PROTOBUF_VERSION#3.}/protobuf-cpp-${PROTOBUF_VERSION}.tar.gz protobuf-cpp-${PROTOBUF_VERSION}.tar.gz" ;;
    *) return 1 ;;
  esac
}

KEEP=()
DEP_LINES=()
for row in "${ROWS[@]}"; do
  IFS=$'\t' read -r name sha url <<<"$row"
  [[ "$sha" =~ ^[0-9a-f]{64}$ ]] || refuse "versions.sh pins $name with a sha256 that is not 64 hex digits: $sha"
  if [ -n "$url" ]; then
    file=$(basename "$url")
    lower=$(tr '[:upper:]' '[:lower:]' <<<"$name")
    [[ "$file" == "$lower"* ]] || file="$lower-$file"
    from="versions.sh ${name}_URL"
  elif spec=$(composed "$name"); then
    url=${spec% *}
    file=${spec##* }
    from="the recipe's build script"
  else
    refuse "versions.sh pins ${name}_SHA256 but neither a ${name}_URL nor the composed table in scripts/release.sh gives its address"
  fi
  dst="$OUT/deps/$file"
  if [ -f "$dst" ] && printf '%s  %s\n' "$sha" "$dst" | sha256sum -c --quiet - >/dev/null 2>&1; then
    echo "dep $name: $file (already here, verified)"
  else
    echo "dep $name: fetching $url"
    curl -fsSL --retry 5 --retry-all-errors -o "$dst.part" "$url" || refuse "could not fetch $name from $url"
    mv -f -- "$dst.part" "$dst"
    printf '%s  %s\n' "$sha" "$dst" | sha256sum -c --quiet - \
      || refuse "$name: $file does not match the sha256 versions.sh pins ($sha)"
    echo "dep $name: $file verified"
  fi
  KEEP+=("$file")
  DEP_LINES+=("| $name | \`$file\` | $from | \`$sha\` |")
done
# A file left in deps/ by an older run that this run did not verify is removed,
# so the upload carries exactly the verified set.
for f in "$OUT"/deps/*; do
  [ -e "$f" ] || continue
  b=$(basename "$f")
  keep=0
  for k in "${KEEP[@]}"; do if [ "$k" = "$b" ]; then keep=1; fi; done
  if [ "$keep" = 0 ]; then echo "removing $f (not a verified dependency)"; rm -f -- "${f:?}"; fi
done
echo "deps: ${#KEEP[@]} archives verified against their sha256 pins"

# ---------------------------------------------------------------- SHA256SUMS
# Paths are relative to the repository root, the directory ship.sh checks from.
shopt -s nullglob
SUMMED=("$REL"/wasm/kicad_editor/*/* "$REL"/assets/* "$REL/index.html" "$REL/licenses.html" "$REL/LICENSE.txt" "$REL/NOTICE.txt" "$REL/island.json" dist/island.json)
shopt -u nullglob
for f in "${SUMMED[@]}"; do
  if [ ! -f "$f" ] || [ -L "$f" ]; then refuse "$f is not a regular file"; fi
done
# Everything ship.sh rsyncs must be summed: no file of the release directory may escape the list.
while IFS= read -r -d '' f; do
  hit=0
  for s in "${SUMMED[@]}"; do if [ "$s" = "$f" ]; then hit=1; fi; done
  [ "$hit" = 1 ] || refuse "$f would ship but is not covered by SHA256SUMS"
done < <(find "$REL" \( -type f -o -type l \) -print0)
sha256sum -- "${SUMMED[@]}" > "$OUT/SHA256SUMS"
sha256sum -c --quiet "$OUT/SHA256SUMS" || refuse "SHA256SUMS does not verify against dist"
echo "SHA256SUMS: ${#SUMMED[@]} files"

# ---------------------------------------------------------------- RELEASE_NOTES.md
# The modification list is read from the loader notices, as notices.mjs reads it.
MODIFIED=$(node --input-type=module -e "
import { census } from './scripts/notices.mjs';
const { modified } = census();
for (const f of modified) {
  console.log('- \`' + f.path + '\`');
  for (const n of f.notices) console.log('  - Modified by Circuit Center on ' + n.date + ': ' + n.text);
}
")
[ -n "$MODIFIED" ] || MODIFIED="None: every copied loader file is PCBJam's unchanged."
{
  echo "# Circuit Center editor island $ID"
  echo
  echo "PCBJam's build of KiCad for the browser at PCBJam tag \`$PCBJAM_TAG\`, with our loader, message responder and theme. This repository at tag \`$ID\` (commit \`$HEAD_SHA\`) is the source of the island; the rest of the complete corresponding source is below."
  echo
  echo "## The pinned sources"
  echo
  echo "| What | Upstream | Commit | Our mirror tag |"
  echo "|---|---|---|---|"
  echo "| PCBJam, the recipe and the web sources (tag \`$PCBJAM_TAG\`) | github.com/PCBJam/pcbjam | \`$ROOT_SHA\` | \`cc/$ID\` in github.com/$OWNER/pcbjam |"
  echo "| KiCad as PCBJam builds it | github.com/PCBJam/kicad-source-mirror | \`$KICAD_SHA\` | \`cc/$ID\` in github.com/$OWNER/kicad-source-mirror |"
  echo "| wxWidgets with the WebAssembly port | github.com/PCBJam/wxWidgets | \`$WX_SHA\` | \`cc/$ID\` in github.com/$OWNER/wxWidgets |"
  echo "| pcbjam-shared (MIT, mirrored for completeness, not part of the served build) | github.com/PCBJam/pcbjam-shared | \`$SHARED_SHA\` | \`cc/$ID\` in github.com/$OWNER/pcbjam-shared |"
  echo
  echo "Dependencies the recipe pins by a git commit are reached through those repositories:"
  echo
  echo "- KiCad: the kicad-source-mirror commit above, the gitlink at PCBJam's commit. The recipe's versions.sh also records \`KICAD_COMMIT=$KICAD_RECIPE_COMMIT\`, its own older record; the engine was built from the gitlink."
  echo "- wxWidgets: the wxWidgets commit above, the gitlink at PCBJam's commit."
  echo "- RapidJSON: commit \`$RAPIDJSON_COMMIT\` of github.com/Tencent/rapidjson; the archive of that commit is attached as well, by the sha256 the recipe pins."
  echo
  echo "## Attached"
  echo
  echo "- \`$SRC\`: this repository at \`$HEAD_SHA\`."
  echo "- \`SHA256SUMS\`: the sha256 of every file served from \`r/$ID/\` and of \`island.json\`; ship.sh refuses to ship files that do not match it."
  echo "- The dependency source archives, each verified against the sha256 the recipe pins:"
  echo
  echo "| Row | File | Address from | sha256 |"
  echo "|---|---|---|---|"
  printf '%s\n' "${DEP_LINES[@]}"
  echo
  echo "## Files we changed"
  echo
  echo "The loader is PCBJam's code copied at the pin (the unchanged copies are in \`loader/pristine\`). These copied files differ, each with its dated notices:"
  echo
  echo "$MODIFIED"
} > "$OUT/RELEASE_NOTES.md"
if grep -nP '[\x{2013}\x{2014}]' "$OUT/RELEASE_NOTES.md"; then refuse "RELEASE_NOTES.md carries an en or em dash"; fi
echo "notes: $OUT/RELEASE_NOTES.md"

# ---------------------------------------------------------------- publish
DEPS_FILES=()
for k in "${KEEP[@]}"; do DEPS_FILES+=("$OUT/deps/$k"); done
if tagged=$(git rev-parse -q --verify "refs/tags/$ID^{commit}"); then
  [ "$tagged" = "$HEAD_SHA" ] || refuse "the local tag $ID points at $tagged, not HEAD $HEAD_SHA"
else
  run git tag -a "$ID" -m "Circuit Center editor island $ID" "$HEAD_SHA"
fi
run git push origin "refs/tags/$ID"
run gh release create "$ID" --repo "$REPO" --verify-tag --title "$ID" --notes-file "$OUT/RELEASE_NOTES.md" \
  "$OUT/$SRC" "$OUT/SHA256SUMS" "${DEPS_FILES[@]}"
if [ "$DRY" = 1 ]; then echo "dry run done: $OUT holds what the release would carry"; fi
