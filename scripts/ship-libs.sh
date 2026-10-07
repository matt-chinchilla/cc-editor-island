#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (c) 2026 Chirichella Inc.
#
# Ships one built library mirror to prod: dist/libs/<tag>/ (npm run build:libs)
# to /opt/circuits-com/editor/libs/<tag>/ on the box, which the editor origin
# serves under /libs/<tag>/ (LIBRARY.md). A mirror is immutable: this refuses
# when the box already has libs/<tag>, uploads into libs/.incoming-<tag>
# beside it, checks every file there against SHA256SUMS, then renames it into
# place. Nothing on the box is ever deleted or rewritten; a refused or broken
# ship leaves libs/.incoming-<tag> for the owner to look at (a later run
# uploads into it again and checks it the same way).
#
#   bash scripts/ship-libs.sh <tag> --dry-run   run every local check, print the ship as "DRY: ..."
#   bash scripts/ship-libs.sh <tag>             check, then ship
set -euo pipefail
cd "$(dirname "$0")/.."

# PROD. These name the live box: the circuitcenter.ai EC2 instance, its login
# and the directory the editor origin serves /libs/ from (scripts/ship.sh
# ships the island beside it).
HOST=ec2-user@100.55.235.167
DEST=/opt/circuits-com/editor/libs
INSTANCE_ID=i-0d456bd12719e2176
OS_USER=ec2-user

DRY=0
TAG=
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    -*) echo "usage: bash scripts/ship-libs.sh <tag> [--dry-run]" >&2; exit 2 ;;
    *) if [ -n "$TAG" ]; then echo "usage: bash scripts/ship-libs.sh <tag> [--dry-run]" >&2; exit 2; fi; TAG=$arg ;;
  esac
done
if [ -z "$TAG" ]; then
  echo "usage: bash scripts/ship-libs.sh <tag> [--dry-run]" >&2
  exit 2
fi
refuse() { echo "refused: $*" >&2; exit 1; }
# The tag lands in paths here and on the box: the grammar scripts/libs/mirror.mjs builds with.
[[ "$TAG" =~ ^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$ ]] || refuse "$TAG is not a library tag ([0-9A-Za-z][0-9A-Za-z._+-]{0,63})"
SRC="dist/libs/$TAG"

# Run a side-effecting command, or print it under --dry-run.
run() {
  if [ "$DRY" = 1 ]; then
    printf 'DRY:'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}
if [ "$DRY" = 1 ]; then echo "dry run: nothing is pushed to the box"; fi

WORK=$(mktemp -d)
trap 'rm -rf -- "${WORK:?}"' EXIT

# ---------------------------------------------------------------- the checks
# Everything here is local and read only, and runs under --dry-run too.
PIN_TAG=$(node -p "require('./PIN.json').libs.tag")
[ "$TAG" = "$PIN_TAG" ] || refuse "PIN.json pins the libraries at $PIN_TAG, not $TAG"
[ -d "$SRC" ] || refuse "there is no build at $SRC; run npm run build:libs first"

# Regular *.gz files only: no symlink, no directory, nothing uncompressed.
while IFS= read -r -d '' f; do
  name=${f#"$SRC"/}
  [ -f "$f" ] && [ ! -L "$f" ] || refuse "$f is not a regular file; a mirror ships regular files only"
  [[ "$name" == *.gz ]] || refuse "$f is not stored gzipped"
done < <(find "$SRC" -mindepth 1 -print0)

# SHA256SUMS lists exactly the other files, and every one matches it.
[ -f "$SRC/SHA256SUMS.gz" ] || refuse "$SRC/SHA256SUMS.gz is missing"
gunzip -c "$SRC/SHA256SUMS.gz" > "$WORK/SHA256SUMS"
(cd "$SRC" && sha256sum -c --quiet --strict "$WORK/SHA256SUMS") || refuse "$SRC does not match its SHA256SUMS"
cut -c67- "$WORK/SHA256SUMS" | LC_ALL=C sort > "$WORK/listed"
(cd "$SRC" && find . -mindepth 1 -maxdepth 1 -printf '%P\n') | grep -vx 'SHA256SUMS.gz' | LC_ALL=C sort > "$WORK/present"
cmp -s "$WORK/listed" "$WORK/present" || refuse "$SRC holds files SHA256SUMS does not list, or misses one it does: $(LC_ALL=C comm -3 "$WORK/listed" "$WORK/present" | tr -d '\t' | tr '\n' ' ')"

# The deep check: every bundle decodes, the manifest, fp-index and the two
# search indexes agree with the bundles, and the manifest names this tag.
node scripts/build-libs.mjs --verify "$SRC" > "$WORK/verify" || refuse "$SRC does not verify (node scripts/build-libs.mjs --verify $SRC)"
grep -qxF "verified $SRC (tag $TAG)" "$WORK/verify" || refuse "$SRC/manifest.json does not name the tag $TAG"
sed 's/^/  /' "$WORK/verify"
echo "$SRC: $(wc -l < "$WORK/listed") files match SHA256SUMS"

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

# Run a script on the box: the script travels on stdin, the directory and the
# tag are its arguments. Under --dry-run it is printed, not run.
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
  echo "refused: $dest/$tag already exists on the box; a library mirror is never rewritten" >&2
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
#    place. mv -T --no-clobber never replaces a directory that appeared since
#    step 1; the staging directory still being there afterwards means it did not move.
FINISH=$(cat <<'BOX'
set -euo pipefail
dest=$1
tag=$2
stage="$dest/.incoming-$tag"
final="$dest/$tag"
refuse() { echo "refused: $*; $stage is left in place" >&2; exit 1; }
[ ! -e "$final" ] || refuse "$final already exists; a library mirror is never rewritten"
cd "$stage"
[ -f SHA256SUMS.gz ] || refuse "SHA256SUMS.gz is missing from the upload"
gunzip -c SHA256SUMS.gz | sha256sum -c --quiet --strict - || refuse "the upload does not match its SHA256SUMS"
listed=$(gunzip -c SHA256SUMS.gz | cut -c67- | LC_ALL=C sort)
present=$(find . -mindepth 1 -maxdepth 1 -printf '%P\n' | grep -vx 'SHA256SUMS.gz' | LC_ALL=C sort)
[ "$listed" = "$present" ] || refuse "the upload holds files SHA256SUMS does not list, or misses one it does"
[ -z "$(find . -mindepth 1 ! -type f -print -quit)" ] || refuse "the upload holds something that is not a regular file"
cd "$dest"
mv -T --no-clobber "$stage" "$final" || true
[ ! -e "$stage" ] || refuse "the rename into $final did not happen (it may have appeared while shipping); nothing was replaced"
echo "shipped $final: $(printf '%s\n' "$listed" | wc -l) files and SHA256SUMS"
BOX
)
push_key
on_box "$FINISH"

# 4. What the world now sees.
run curl -sI "https://editor.circuitcenter.ai/libs/$TAG/manifest.json"
if [ "$DRY" = 1 ]; then echo "dry run done"; fi
