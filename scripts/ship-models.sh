#!/usr/bin/env bash
# Copyright (C) 2026 Circuit Center Inc
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Ships one built model store to prod: dist/models/<tag>/ (npm run build:models
# <tag>) to /opt/circuits-com/editor/models/<tag>/ on the box, which the editor
# origin serves under /models/<tag>/ (LIBRARY.md "The model store"). The
# owner's, run by hand, --dry-run first. A store is immutable: this refuses
# when the box already has models/<tag>, uploads into models/.incoming-<tag>
# beside it, checks every file there against SHA256SUMS, then renames it into
# place. Nothing on the box is ever deleted or rewritten; a refused or broken
# ship leaves models/.incoming-<tag> for the owner to look at (a later run
# uploads into it again and checks it the same way). Only a whole set ships
# (store.json full), and a set over the 1.5 GB hosting bound ships only with
# --over-bound, the owner's word on hosting it.
#
#   bash scripts/ship-models.sh <tag> --dry-run   run every local check, print the ship as "DRY: ..."
#   bash scripts/ship-models.sh <tag>             check, then ship
set -euo pipefail
cd "$(dirname "$0")/.."

# PROD. These name the live box: the circuitcenter.ai EC2 instance, its login
# and the directory the editor origin serves /models/ from (scripts/ship-libs.sh
# ships the library mirror beside it).
HOST=ec2-user@100.55.235.167
DEST=/opt/circuits-com/editor/models
INSTANCE_ID=i-0d456bd12719e2176
OS_USER=ec2-user
BOUND=1500000000

USAGE="usage: bash scripts/ship-models.sh <tag> [--dry-run] [--over-bound]"
DRY=0
OVER=0
TAG=
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --over-bound) OVER=1 ;;
    -*) echo "$USAGE" >&2; exit 2 ;;
    *) if [ -n "$TAG" ]; then echo "$USAGE" >&2; exit 2; fi; TAG=$arg ;;
  esac
done
if [ -z "$TAG" ]; then
  echo "$USAGE" >&2
  exit 2
fi
refuse() { echo "refused: $*" >&2; exit 1; }
[[ "$TAG" =~ ^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$ ]] || refuse "$TAG is not a tag ([0-9A-Za-z][0-9A-Za-z._+-]{0,63})"
SRC="dist/models/$TAG"

run() {
  if [ "$DRY" = 1 ]; then
    printf 'DRY:'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}
if [ "$DRY" = 1 ]; then echo "dry run: nothing is pushed to the box"; fi

# ---------------------------------------------------------------- the checks
# Everything here is local and read only, and runs under --dry-run too.
PIN_TAG=$(node -p "require('./PIN.json').libs.tag")
[ "$TAG" = "$PIN_TAG" ] || refuse "PIN.json pins KiCad's libraries at $PIN_TAG, not $TAG; the model store follows the engine's tag"
[ -d "$SRC" ] || refuse "there is no build at $SRC; run npm run build:models $TAG first"

# Regular files only: no symlink, no device, nothing but files and folders.
[ -z "$(find "$SRC" -mindepth 1 ! -type f ! -type d -print -quit)" ] || refuse "$SRC holds something that is not a regular file or a folder"

# The deep check: gzip twins, the indexes, store.json and SHA256SUMS.
node scripts/build-models.mjs --verify "$SRC" || refuse "$SRC does not verify (node scripts/build-models.mjs --verify $SRC)"
FULL=$(node -p "require('./$SRC/store.json').full")
[ "$FULL" = "true" ] || refuse "$SRC is a partial store (an --only build); only the whole set ships"
STORE_TAG=$(node -p "require('./$SRC/store.json').tag")
[ "$STORE_TAG" = "$TAG" ] || refuse "$SRC/store.json names the tag $STORE_TAG"
GZ=$(node -p "require('./$SRC/store.json').gzBytes")
echo "$SRC: $(node -p "require('./$SRC/store.json').files") STEP files, $GZ bytes gzipped"
if [ "$GZ" -gt "$BOUND" ] && [ "$OVER" != 1 ]; then
  refuse "the set is $GZ bytes gzipped, over the $BOUND bound; hosting it is the owner's call (--over-bound)"
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

on_box() {
  local script=$1
  if [ "$DRY" = 1 ]; then
    run ssh "$HOST" bash -s -- "$DEST" "$TAG"
    echo "  (its stdin, the script run on the box:)"
    sed 's/^/  | /' <<<"$script"
  else
    ssh "$HOST" bash -s -- "$DEST" "$TAG" <<<"$script"
  fi
}

# 1. Refuse a tag the box already holds, then make the staging directory.
PREPARE=$(cat <<'BOX'
set -euo pipefail
dest=$1
tag=$2
if [ -e "$dest/$tag" ]; then
  echo "refused: $dest/$tag already exists on the box; a model store is never rewritten" >&2
  exit 1
fi
if [ -e "$dest/.incoming-$tag" ]; then
  echo "$dest/.incoming-$tag is left from an earlier ship; uploading into it again"
fi
mkdir -p "$dest/.incoming-$tag"
BOX
)
push_key
on_box "$PREPARE"

# 2. The files, into the staging directory. No --delete: nothing on the box is
#    removed; a stray file there makes step 3 refuse.
push_key
run rsync -a --chmod=D755,F644 "$SRC/" "$HOST:$DEST/.incoming-$TAG/"

# 3. Check the staged copy against its own SHA256SUMS, then rename it into
#    place. mv -T --no-clobber never replaces a directory that appeared since step 1.
FINISH=$(cat <<'BOX'
set -euo pipefail
dest=$1
tag=$2
stage="$dest/.incoming-$tag"
final="$dest/$tag"
refuse() { echo "refused: $*; $stage is left in place" >&2; exit 1; }
[ ! -e "$final" ] || refuse "$final already exists; a model store is never rewritten"
cd "$stage"
[ -f SHA256SUMS ] || refuse "SHA256SUMS is missing from the upload"
sha256sum -c --quiet --strict SHA256SUMS || refuse "the upload does not match its SHA256SUMS"
listed=$(cut -c67- SHA256SUMS | LC_ALL=C sort)
present=$(find . -mindepth 1 -type f -printf '%P\n' | grep -vx 'SHA256SUMS' | LC_ALL=C sort)
[ "$listed" = "$present" ] || refuse "the upload holds files SHA256SUMS does not list, or misses one it does"
[ -z "$(find . -mindepth 1 ! -type f ! -type d -print -quit)" ] || refuse "the upload holds something that is not a regular file or a folder"
cd "$dest"
mv -T --no-clobber "$stage" "$final" || true
[ ! -e "$stage" ] || refuse "the rename into $final did not happen (it may have appeared while shipping); nothing was replaced"
echo "shipped $final: $(printf '%s\n' "$listed" | wc -l) files and SHA256SUMS"
BOX
)
push_key
on_box "$FINISH"

# 4. What the world now sees.
run curl -sI "https://editor.circuitcenter.ai/models/$TAG/Resistor_SMD.3dshapes/index.json"
if [ "$DRY" = 1 ]; then echo "dry run done"; fi
