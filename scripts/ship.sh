#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (c) 2026 Chirichella Inc.
#
# Ships one built island to prod. Refuses without the GitHub release whose
# SHA256SUMS match the files about to ship, and without the three mirror tags
# the licence page names (spec section 13). rsync into a versioned directory,
# copy island.json, then flip `current` with a rename; keep two releases.
#
#   bash scripts/ship.sh --dry-run <islandId>   run every check, print the ship as "DRY: ..."
#   bash scripts/ship.sh <islandId>             check, then ship
set -euo pipefail
cd "$(dirname "$0")/.."

# PROD. These name the live box: the circuitcenter.ai EC2 instance, its login
# and the directory nginx serves editor.circuitcenter.ai from.
HOST=ec2-user@100.55.235.167
DEST=/opt/circuits-com/editor
INSTANCE_ID=i-0d456bd12719e2176
OS_USER=ec2-user

REPO=matt-chinchilla/cc-editor-island
OWNER=matt-chinchilla
MIRRORS=(pcbjam kicad-source-mirror wxWidgets)

DRY=0
if [ "${1:-}" = --dry-run ]; then DRY=1; shift; fi
ID=${1:-}
if [ -z "$ID" ] || [ "$#" -ne 1 ]; then
  echo "usage: bash scripts/ship.sh [--dry-run] <islandId>" >&2
  exit 2
fi
# The id lands in paths here and on the box, and the site accepts only its own grammar.
[[ "$ID" =~ ^[a-z0-9][a-z0-9.-]{0,63}$ ]] || { echo "refused: $ID does not match the islandId grammar ^[a-z0-9][a-z0-9.-]{0,63}$ (the site's ISLAND_ID_RE)" >&2; exit 1; }
REL="dist/r/$ID"

# Run a side-effecting command, or print it under --dry-run.
run() {
  if [ "$DRY" = 1 ]; then
    printf 'DRY:'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}
if [ "$DRY" = 1 ]; then echo "dry run: nothing is pushed to the box"; fi

[ -d "$REL" ] || { echo "refused: there is no build at $REL" >&2; exit 1; }
[ -f dist/island.json ] || { echo "refused: dist/island.json is missing" >&2; exit 1; }

WORK=$(mktemp -d)
trap 'rm -rf -- "${WORK:?}"' EXIT

# ---------------------------------------------------------------- the checks
# Every check runs and every missing item is named, before anything ships.
MISSING=()

# The verifying SHA256SUMS: the published one, read from the release.
SUMS=
if names=$(gh release view "$ID" --repo "$REPO" --json assets --jq '.assets[].name' 2>/dev/null) \
  && grep -qx SHA256SUMS <<<"$names"; then
  gh release download "$ID" --repo "$REPO" --pattern SHA256SUMS --dir "$WORK" --clobber
  SUMS="$WORK/SHA256SUMS"
  echo "release $ID on $REPO carries SHA256SUMS"
else
  MISSING+=("the release $ID on $REPO with a SHA256SUMS asset")
fi

# The files about to ship: everything under $REL and dist/island.json, each
# listed in SHA256SUMS and matching it.
# A sha256sum line is 64 hex digits, two spaces, the path: match the path exactly.
listed() { awk -v f="$1" 'substr($0, 67) == f { found = 1 } END { exit !found }' "$2"; }
check_sums() {
  local sums=$1 label=$2 f
  if ! sha256sum -c --quiet "$sums"; then
    MISSING+=("dist matching $label (sha256sum -c failed)")
    return
  fi
  while IFS= read -r -d '' f; do
    if [ -L "$f" ]; then MISSING+=("$f is a symlink; a release ships regular files only"); continue; fi
    listed "$f" "$sums" || MISSING+=("$f in $label (it would ship unchecked)")
  done < <(find "$REL" \( -type f -o -type l \) -print0)
  listed dist/island.json "$sums" || MISSING+=("dist/island.json in $label")
  echo "dist matches $label"
}
if [ -n "$SUMS" ]; then
  check_sums "$SUMS" "the release's SHA256SUMS"
elif [ "$DRY" = 1 ] && [ -f "release/$ID/SHA256SUMS" ]; then
  # Informational only: the local file release.sh wrote is not the published one.
  echo "(dry run) checking dist against the local release/$ID/SHA256SUMS that release.sh wrote:"
  check_sums "release/$ID/SHA256SUMS" "the local release/$ID/SHA256SUMS"
fi

# The three mirror tags the licence page promises, at the commits PIN.json pins
# when this is the pinned island.
PIN_ID=$(node -p "require('./PIN.json').islandId")
declare -A WANT=()
if [ "$PIN_ID" = "$ID" ]; then
  WANT[pcbjam]=$(node -p "require('./PIN.json').pcbjam.root")
  WANT[kicad-source-mirror]=$(node -p "require('./PIN.json').pcbjam.kicad")
  WANT[wxWidgets]=$(node -p "require('./PIN.json').pcbjam.wxwidgets")
fi
for r in "${MIRRORS[@]}"; do
  if sha=$(gh api "repos/$OWNER/$r/git/ref/tags/cc/$ID" --jq .object.sha 2>/dev/null); then
    if [ -n "${WANT[$r]:-}" ] && [ "$sha" != "${WANT[$r]}" ]; then
      MISSING+=("the tag cc/$ID on $OWNER/$r at ${WANT[$r]} (it points at $sha)")
    else
      echo "mirror tag cc/$ID on $OWNER/$r at $sha"
    fi
  else
    MISSING+=("the mirror tag cc/$ID on $OWNER/$r")
  fi
done

if [ "${#MISSING[@]}" -gt 0 ]; then
  for m in "${MISSING[@]}"; do echo "refused: missing $m" >&2; done
  if [ "$DRY" = 0 ]; then exit 1; fi
  echo "(dry run) the ship above would refuse; the plan a passing check runs follows"
fi

# ---------------------------------------------------------------- the ship
# The instance connect key lives 60 seconds, so it is pushed before each connection.
push_key() {
  if [ "$DRY" = 1 ]; then
    run aws ec2-instance-connect send-ssh-public-key --instance-id "$INSTANCE_ID" \
      --instance-os-user "$OS_USER" --ssh-public-key "file://$HOME/.ssh/id_ed25519.pub"
  else
    aws ec2-instance-connect send-ssh-public-key --instance-id "$INSTANCE_ID" \
      --instance-os-user "$OS_USER" --ssh-public-key "file://$HOME/.ssh/id_ed25519.pub" >/dev/null
  fi
}

# 1. The release directory, complete. --delete acts inside r/<id>/ alone.
push_key
run ssh "$HOST" mkdir -p "$DEST/r"
push_key
run rsync -a --delete "$REL/" "$HOST:$DEST/r/$ID/"

# 2. island.json, after the release directory is complete and before the flip
#    (rsync writes a temporary file and renames it into place).
push_key
run rsync -a dist/island.json "$HOST:$DEST/island.json"

# 3. The flip and the prune, on the box. The script travels on stdin; the
#    directory and the id are its arguments.
REMOTE=$(cat <<'BOX'
set -euo pipefail
dest=$1
id=$2
cd "$dest"
[ -f "r/$id/index.html" ] || { echo "r/$id/index.html is missing on the box; not flipping" >&2; exit 1; }
prev=$(readlink current 2>/dev/null || true)
prev=${prev%/}
prev=${prev#"$dest"/}
prev=${prev#./}
ln -sfn "r/$id" current.tmp
mv -T current.tmp current
# Keep two releases: the one now served and the one served before it (or, when
# that is unknown, the newest other one). Nothing is pruned below three.
count=$(find r -mindepth 1 -maxdepth 1 -type d | wc -l)
if [ "$count" -ge 3 ]; then
  if [[ "$prev" != r/* ]] || [ "$prev" = "r/$id" ] || [ ! -d "$prev" ]; then
    prev=$(ls -1dt -- r/*/ | sed 's:/$::' | grep -vxF "r/$id" | head -n 1 || true)
  fi
  [ -n "$prev" ] || { echo "no previous release found; nothing pruned" >&2; ls -la current; exit 0; }
  find r -mindepth 1 -maxdepth 1 -type d -print0 | while IFS= read -r -d '' d; do
    if [ "$d" = "r/$id" ] || [ "$d" = "$prev" ]; then continue; fi
    echo "pruning $d"
    rm -rf -- "${d:?}"
  done
fi
ls -la current
BOX
)
push_key
if [ "$DRY" = 1 ]; then
  run ssh "$HOST" bash -s -- "$DEST" "$ID"
  echo "  (its stdin, the script run on the box:)"
  sed 's/^/  | /' <<<"$REMOTE"
else
  ssh "$HOST" bash -s -- "$DEST" "$ID" <<<"$REMOTE"
fi

# 4. What the world now sees.
run curl -sI https://editor.circuitcenter.ai/island.json
if [ "$DRY" = 1 ]; then
  echo "dry run done"
  if [ "${#MISSING[@]}" -gt 0 ]; then exit 1; fi
fi
