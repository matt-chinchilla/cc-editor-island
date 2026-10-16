#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (c) 2026 Chirichella Inc.
#
# One-time: fork the four upstream repositories under the owner's account
# (server-side, no upload). Per island: tag cc/<islandId> at the commits the
# served engine was built from (servedSources in scripts/notices.mjs), so the
# corresponding source of every served build stays reachable even if PCBJam
# force-pushes. Never fetch --prune, never force-push a mirror (a branch moves
# only by a fast-forward), never move a tag that already exists.
#
#   bash scripts/mirrors.sh --dry-run   read GitHub and the local clones, print every write as "DRY: ..."
#   bash scripts/mirrors.sh             fork what is missing, push cc/main (our build) and the four tags
#
# PCBJam's CDN build (no PIN.json engine.build): the tags go at PCBJam's pinned
# commits, which every fork holds. Our own build (engine.build, fetch-engine
# --local): its commits exist only in the local clones the build used
# ($CC_ENGINE_ROOT/<repo>, default /home/matthew/cc-engine), so each fork gets
# the branch <recipe> (cc/main) and the tag pushed from that clone, both at the
# built commit; a clone whose own <recipe> branch has moved past the build is
# refused, so the tag always names the source that was built.
#
# pcbjam, kicad-source-mirror and wxWidgets hold the served build's source (the
# license page names their tags); pcbjam-shared is mirrored for completeness.
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
# The commits the served engine was built from, from their one home.
served() {
  node --input-type=module -e "import { readFileSync } from 'node:fs'; import { servedSources } from './scripts/notices.mjs'; console.log(servedSources(JSON.parse(readFileSync('PIN.json', 'utf8')))['$1'] ?? '')"
}
ID=$(pin islandId)
declare -A SHA
SHA[pcbjam]=$(served pcbjam)
SHA[kicad-source-mirror]=$(served kicad)
SHA[wxWidgets]=$(served wxwidgets)
SHA[pcbjam-shared]=$(served shared)
OURS=$(served ours)
RECIPE=$(served recipe)
ENGINE_ROOT="${CC_ENGINE_ROOT:-/home/matthew/cc-engine}"
for r in "${REPOS[@]}"; do
  [[ "${SHA[$r]}" =~ ^[0-9a-f]{40}$ ]] || { echo "PIN.json holds no full commit for $r: ${SHA[$r]}" >&2; exit 1; }
done
[[ "$ID" =~ ^[a-z0-9][a-z0-9.-]{0,63}$ ]] || { echo "PIN.json islandId does not match the islandId grammar ^[a-z0-9][a-z0-9.-]{0,63}$ (the site's ISLAND_ID_RE): $ID" >&2; exit 1; }
TAG="cc/$ID"
if [ "$OURS" = true ]; then
  [[ "$RECIPE" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] || { echo "PIN.json engine.build recipe is not a branch name: $RECIPE" >&2; exit 1; }
fi
[ "$DRY" = 1 ] && echo "dry run: nothing is forked, tagged or pushed"
if [ "$OURS" = true ]; then
  echo "island $ID (our build, $RECIPE): branch $RECIPE and tag $TAG on $OWNER/{${REPOS[*]}}, pushed from $ENGINE_ROOT/<repo>"
else
  echo "island $ID (PCBJam's build): tag $TAG on $OWNER/{${REPOS[*]}}"
fi

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

# ---------------------------------------------------------------- our build: the branch, from the local clone

# An exact ref read on a fork: prints the sha, or nothing for a 404 (no ref, or no
# fork yet under --dry-run); any other failure stops.
remote_ref() {
  local r=$1 ref=$2 out
  if out=$(gh api "repos/$OWNER/$r/git/ref/$ref" --jq .object.sha 2>&1); then
    printf '%s' "$out"
  elif grep -q '"status":"404"\|HTTP 404\|Not Found' <<<"$out"; then
    :
  else
    echo "could not read $ref on $OWNER/$r: $out" >&2
    exit 1
  fi
}

# The local clone a commit of our build is pushed from: it must hold the commit,
# and its own branch of that name, when it has one, must sit at it.
clone_for() {
  local r=$1 sha=$2 clone="$ENGINE_ROOT/$1" head
  [ -d "$clone/.git" ] || [ -f "$clone/HEAD" ] || { echo "no local clone $clone (our build's commits are pushed from it)" >&2; exit 1; }
  git -C "$clone" cat-file -e "$sha^{commit}" 2>/dev/null || { echo "$clone does not hold $sha" >&2; exit 1; }
  if head=$(git -C "$clone" rev-parse -q --verify "refs/heads/$RECIPE^{commit}"); then
    [ "$head" = "$sha" ] || { echo "refused: $clone's $RECIPE is at $head, not the built $sha; rebuild and fetch-engine --local, or tag by hand" >&2; exit 1; }
  fi
  printf '%s' "$clone"
}

if [ "$OURS" = true ]; then
  for r in "${REPOS[@]}"; do
    sha=${SHA[$r]}
    clone=$(clone_for "$r" "$sha")
    have=$(remote_ref "$r" "heads/$RECIPE")
    if [ "$have" = "$sha" ]; then
      echo "branch $RECIPE on $OWNER/$r already at $sha"
      continue
    fi
    # Not forced: a $RECIPE on the fork that is not an ancestor of the built commit makes git refuse.
    [ -n "$have" ] && echo "branch $RECIPE on $OWNER/$r is at $have: moving it to $sha only if that is a fast-forward"
    run git -C "$clone" push "https://github.com/$OWNER/$r.git" "$sha:refs/heads/$RECIPE"
    [ "$DRY" = 1 ] || echo "pushed $RECIPE to $OWNER/$r at $sha"
  done
fi

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
  # An exact ref read: empty means no tag (or no fork yet).
  have=$(remote_ref "$r" "tags/$TAG")
  if [ "$have" = "$sha" ]; then
    echo "tag $TAG on $OWNER/$r already at $sha"
    continue
  fi
  if [ -n "$have" ]; then
    echo "refused: tag $TAG on $OWNER/$r points at $have, not the served $sha; a mirror tag is never moved" >&2
    exit 1
  fi
  if [ "$OURS" = true ]; then
    # The commit came with the branch above; the tag goes from the same clone, as a new ref.
    clone=$(clone_for "$r" "$sha")
    run git -C "$clone" push "https://github.com/$OWNER/$r.git" "$sha:refs/tags/$TAG"
    [ "$DRY" = 1 ] || echo "tagged $r $TAG at $sha"
    continue
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
