#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (c) 2026 Chirichella Inc.
#
# One-time: fork the four upstream repositories under the owner's account
# (server-side, no upload). Per island: tag cc/<islandId> at the pinned SHAs
# so the corresponding source of every served build stays reachable even if
# PCBJam force-pushes. Never fetch --prune, never force-push a mirror, never
# move a tag that already exists.
#
#   bash scripts/mirrors.sh --dry-run   read GitHub, print every write as "DRY: ..."
#   bash scripts/mirrors.sh             fork what is missing and push the four tags
#
# pcbjam, kicad-source-mirror and wxWidgets hold the served build's source (the
# licence page names their tags); pcbjam-shared is mirrored for completeness.
set -euo pipefail
cd "$(dirname "$0")/.."

OWNER=matt-chinchilla
UPSTREAM=PCBJam
REPOS=(pcbjam kicad-source-mirror wxWidgets pcbjam-shared)

DRY=0
case "${1:-}" in
  --dry-run) DRY=1 ;;
  '') ;;
  *) echo "usage: bash scripts/mirrors.sh [--dry-run]" >&2; exit 2 ;;
esac

# Run a side-effecting command, or print it under --dry-run.
run() {
  if [ "$DRY" = 1 ]; then
    printf 'DRY:'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}

pin() { node -p "require('./PIN.json').$1"; }
ID=$(pin islandId)
declare -A SHA
SHA[pcbjam]=$(pin pcbjam.root)
SHA[kicad-source-mirror]=$(pin pcbjam.kicad)
SHA[wxWidgets]=$(pin pcbjam.wxwidgets)
SHA[pcbjam-shared]=$(pin pcbjam.shared)
for r in "${REPOS[@]}"; do
  [[ "${SHA[$r]}" =~ ^[0-9a-f]{40}$ ]] || { echo "PIN.json holds no full commit for $r: ${SHA[$r]}" >&2; exit 1; }
done
[[ "$ID" =~ ^[a-z0-9][a-z0-9.-]{0,63}$ ]] || { echo "PIN.json islandId does not match the islandId grammar ^[a-z0-9][a-z0-9.-]{0,63}$ (the site's ISLAND_ID_RE): $ID" >&2; exit 1; }
TAG="cc/$ID"
[ "$DRY" = 1 ] && echo "dry run: nothing is forked, tagged or pushed"
echo "island $ID, tag $TAG on $OWNER/{${REPOS[*]}}"

# ---------------------------------------------------------------- the forks
for r in "${REPOS[@]}"; do
  if gh repo view "$OWNER/$r" >/dev/null 2>&1; then
    echo "fork $OWNER/$r exists"
    continue
  fi
  echo "no fork $OWNER/$r yet: forking $UPSTREAM/$r"
  run gh repo fork "$UPSTREAM/$r" --clone=false --default-branch-only=false
  if [ "$DRY" = 0 ]; then
    # GitHub creates a fork asynchronously; wait until it answers.
    for _ in $(seq 1 30); do
      gh repo view "$OWNER/$r" >/dev/null 2>&1 && break
      sleep 2
    done
    gh repo view "$OWNER/$r" >/dev/null 2>&1 || { echo "the fork $OWNER/$r did not appear" >&2; exit 1; }
  fi
done

# ---------------------------------------------------------------- the tags

# The 422 fallback. A fork holds every object of the upstream history at fork
# time, so the pinned SHAs exist there; when a POST answers 422 "Object does
# not exist", the fork predates the SHA: fetch that commit into a scratch bare
# clone and push the tag from there (a new ref, never a forced one).
tag_by_push() {
  local r=$1 sha=$2 work
  if [ "$DRY" = 1 ]; then
    work=SCRATCH_DIR
  else
    work=$(mktemp -d)
  fi
  run git init -q --bare "$work"
  run git -C "$work" fetch --no-tags "https://github.com/$UPSTREAM/$r.git" "$sha"
  run git -C "$work" push "https://github.com/$OWNER/$r.git" "$sha:refs/tags/$TAG"
  if [ "$DRY" = 0 ]; then rm -rf -- "$work"; fi
}

for r in "${REPOS[@]}"; do
  sha=${SHA[$r]}
  # An exact ref read: 404 means no tag (or no fork yet); any other failure stops.
  if out=$(gh api "repos/$OWNER/$r/git/ref/tags/$TAG" --jq .object.sha 2>&1); then
    have=$out
  elif grep -q '"status":"404"\|HTTP 404\|Not Found' <<<"$out"; then
    have=
  else
    echo "could not read $TAG on $OWNER/$r: $out" >&2
    exit 1
  fi
  if [ "$have" = "$sha" ]; then
    echo "tag $TAG on $OWNER/$r already at $sha"
    continue
  fi
  if [ -n "$have" ]; then
    echo "refused: tag $TAG on $OWNER/$r points at $have, not the pinned $sha; a mirror tag is never moved" >&2
    exit 1
  fi
  if [ "$DRY" = 1 ]; then
    run gh api -X POST "repos/$OWNER/$r/git/refs" -f "ref=refs/tags/$TAG" -f "sha=$sha"
    echo "  (on a 422 \"Object does not exist\" the fallback runs instead:)"
    tag_by_push "$r" "$sha" | sed 's/^/  /'
    continue
  fi
  if out=$(gh api -X POST "repos/$OWNER/$r/git/refs" -f "ref=refs/tags/$TAG" -f "sha=$sha" 2>&1); then
    echo "tagged $r $TAG at $sha"
  elif grep -q 'Object does not exist' <<<"$out"; then
    echo "$OWNER/$r predates $sha: tagging from a scratch clone"
    tag_by_push "$r" "$sha"
    echo "tagged $r $TAG at $sha"
  else
    echo "tagging $OWNER/$r failed: $out" >&2
    exit 1
  fi
done
