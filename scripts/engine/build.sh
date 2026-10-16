#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (c) 2026 Chirichella Inc.
#
# Build the engine (kicad_editor) here, with PCBJam's own Docker recipe.
#
#   bash scripts/engine/build.sh pristine   the pinned v0.2.3 commits, unchanged (D7 reproduction)
#   bash scripts/engine/build.sh cc8        our fork branches cc/main (importers + kicadImportSchematic)
#   bash scripts/engine/build.sh cc8 --build-deps   also rerun the recipe's deps stage
#
# Assembles /home/matthew/cc-engine/tree-<name>/ in PCBJam's layout from the four
# local clones (git worktrees; the submodule gitlinks are checked against them),
# runs ./docker/build.sh there, and collects the five served files plus meta.json
# in /home/matthew/cc-engine/out/<name>/. Hours long: run it detached. README.md
# beside this file has the rulings and how to watch a build.
set -euo pipefail

ENGINE_ROOT="${CC_ENGINE_ROOT:-/home/matthew/cc-engine}"

# The v0.2.3 pins (PIN.json "pcbjam" block, taken 2026-09-30).
PCBJAM_PIN=7ec51c1c55aab45b21cd2956af413b4420520838
KICAD_PIN=48f1e865216623283579984110a80210e7ccc789
WX_PIN=8bad5f58e9b51050d3678f5c98cb0dc41b4595b2
SHARED_PIN=7791275bdfbf54e1500e303121dacaa2c3fd7d00

# The recipe's knobs (README "Rulings"). ONE compose project for both trees, so
# the deps built by the first tree are reused by the second.
DOCKER_PROJECT=kicad-wasm-cc-engine
DOCKER_CPUS=8
DOCKER_MEM=44G
JOBS=6

FILES=(kicad_editor.js kicad_editor.wasm wx.js wx-dom.js images.tar.gz)

usage() { echo "usage: bash scripts/engine/build.sh <pristine|cc8> [--build-deps]" >&2; exit 2; }
die() { echo "build.sh: $*" >&2; exit 1; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

NAME="${1:-}"
[ $# -gt 0 ] && shift
FORCE_DEPS=0
for arg in "$@"; do
  case "$arg" in
    --build-deps) FORCE_DEPS=1 ;;
    *) usage ;;
  esac
done

case "$NAME" in
  pristine) ROOT_REF=$PCBJAM_PIN; KICAD_REF=$KICAD_PIN; BUILD_DEPS=1 ;;
  cc8)      ROOT_REF=cc/main;     KICAD_REF=cc/main;    BUILD_DEPS=$FORCE_DEPS ;;
  *) usage ;;
esac

TREE="$ENGINE_ROOT/tree-$NAME"
OUT="$ENGINE_ROOT/out/$NAME"
mkdir -p "$OUT"

# One build at a time across BOTH names: they share the compose project, and the
# recipe's rsync swaps the sources in its volume.
exec 9>"$ENGINE_ROOT/out/.build.lock"
flock -n 9 || die "another engine build holds $ENGINE_ROOT/out/.build.lock (one compose project, one build at a time)"
echo "$$" > "$OUT/build.pid"

sha_of() {
  git -C "$ENGINE_ROOT/$1" rev-parse --verify --quiet "$2^{commit}" \
    || die "$2 is not a commit in $ENGINE_ROOT/$1"
}
ROOT_SHA=$(sha_of pcbjam "$ROOT_REF")
KICAD_SHA=$(sha_of kicad-source-mirror "$KICAD_REF")
WX_SHA=$(sha_of wxWidgets "$WX_PIN")
SHARED_SHA=$(sha_of pcbjam-shared "$SHARED_PIN")

# ensure_worktree <clone> <path> <sha> [branch]: add the worktree, or verify an
# existing one belongs to <clone> and sits at <sha> (a clean one is moved there;
# one with local changes stops the build).
ensure_worktree() {
  local clone="$ENGINE_ROOT/$1" path="$2" sha="$3" branch="${4:-}" common head
  if [ -e "$path/.git" ]; then
    common=$(git -C "$path" rev-parse --path-format=absolute --git-common-dir)
    [ "$common" = "$clone/.git" ] || die "$path is a checkout of $common, not of $clone"
    head=$(git -C "$path" rev-parse HEAD)
    [ "$head" = "$sha" ] && return 0
    [ -z "$(git -C "$path" status --porcelain --untracked-files=no --ignore-submodules=all)" ] \
      || die "$path is at $head with local changes; wanted $sha"
    echo "moving $path from $head to $sha"
    if [ -n "$branch" ]; then
      git -C "$path" checkout -q -B "$branch" "$sha"
    else
      git -C "$path" checkout -q --detach "$sha"
    fi
  else
    git -C "$clone" worktree prune
    if [ -n "$branch" ]; then
      git -C "$clone" worktree add -B "$branch" "$path" "$sha"
    else
      git -C "$clone" worktree add --detach "$path" "$sha"
    fi
  fi
}

# wxWidgets carries its bundled libraries as nested submodules (pcre, png, jpeg,
# expat, tiff, zlib, nanosvg, catch), and a worktree starts with them empty; the
# recipe's wx configure (--with-regex=builtin, builtin image libraries in a cross
# build) needs them. All of them, shallow; a commit a shallow fetch cannot reach
# is fetched whole. A no-op once they sit at the recorded commits.
init_wx_submodules() {
  local wx="$1" sub
  for sub in $(git -C "$wx" config -f .gitmodules --get-regexp '^submodule\..*\.path$' | awk '{ print $2 }'); do
    if ! git -C "$wx" submodule update --init --depth 1 -- "$sub"; then
      echo "shallow fetch of wxwidgets/$sub failed; fetching it whole"
      git -C "$wx" submodule update --init -- "$sub"
    fi
  done
  # Every entry initialized ('-' = not) and at its recorded commit ('+' = not).
  if git -C "$wx" submodule status | grep -q '^[-+U]'; then
    git -C "$wx" submodule status >&2
    die "wxwidgets' nested submodules are not all at their recorded commits"
  fi
}

echo "assembling $TREE"
ensure_worktree pcbjam "$TREE" "$ROOT_SHA" "build/$NAME"
ensure_worktree kicad-source-mirror "$TREE/kicad" "$KICAD_SHA"
ensure_worktree wxWidgets "$TREE/wxwidgets" "$WX_SHA"
init_wx_submodules "$TREE/wxwidgets"
ensure_worktree pcbjam-shared "$TREE/web/pcbjam-shared" "$SHARED_SHA"

# The pcbjam tree's recorded submodule pointers must be exactly the worktrees.
bad=0
for sub in kicad wxwidgets web/pcbjam-shared; do
  want=$(git -C "$TREE" ls-tree HEAD "$sub" | awk '$2 == "commit" { print $3 }')
  got=$(git -C "$TREE/$sub" rev-parse HEAD)
  if [ "$want" != "$got" ]; then
    echo "gitlink mismatch: $TREE records $sub at ${want:-nothing}, its worktree is at $got" >&2
    bad=1
  fi
done
[ "$bad" = 0 ] || die "the pcbjam tree's submodule pointers do not match the worktrees; refusing to build"
echo "gitlinks verified: pcbjam=$ROOT_SHA kicad=$KICAD_SHA wxwidgets=$WX_SHA shared=$SHARED_SHA"

# Files wx's configure asks for: catch a missing nested submodule here, not 25
# minutes into the deps stage (the first pristine run died on the pcre one).
for f in wxwidgets/3rdparty/pcre/pcre2-config.in wxwidgets/src/png/png.h; do
  [ -f "$TREE/$f" ] || die "$TREE/$f is missing: wxwidgets' nested submodules are not checked out"
done
echo "wxwidgets nested submodules present"

# The recipe, exactly: its knobs set, every other recipe variable at its default.
export COMPOSE_PROJECT_NAME=$DOCKER_PROJECT KICAD_DOCKER_CPUS=$DOCKER_CPUS \
  KICAD_DOCKER_MEM=$DOCKER_MEM KICAD_NO_MONITOR=1
unset KICAD_WASM_OPT BUILD_3D_VIEWER KICAD_KEEP_CONTAINER KICAD_LOG_NESTED KICAD_LOG_FILE
RECIPE_ARGS=(kicad_editor)
if [ "$BUILD_DEPS" = 1 ]; then RECIPE_ARGS+=(--build-deps); fi
RECIPE_ARGS+=(-j "$JOBS")

# A clean wxWidgets build on every run, through PCBJam's own trigger: build-wx-wasm.sh
# forces one when build-wasm/wxwidgets/.pcbjam-async-backend is absent. Without it a
# rerun can die in wx's bundled pcre ("No rule to make target .../pcre2_chartables.c",
# cc8 2026-10-16): the container entrypoint's start-up rsync re-touches the sources
# while the build runs, pcre's rule then rm's the TRACKED src/pcre2_chartables.c
# through VPATH, and the dependency files of the earlier wx build still name it.
# The wx build takes about five minutes; the deps stay cached.
WX_CLEAN=0
if docker volume inspect "${DOCKER_PROJECT}_kicad-build-cache" >/dev/null 2>&1; then
  docker run --rm -v "${DOCKER_PROJECT}_kicad-build-cache:/build-wasm" ubuntu:22.04 \
    rm -f /build-wasm/wxwidgets/.pcbjam-async-backend
  WX_CLEAN=1
  echo "wx backend stamp dropped: the recipe rebuilds wxWidgets clean"
fi

# A fresh run owns its out dir: earlier logs are kept under their date, earlier
# outputs are dropped so nothing stale can pass for this build's.
for log in build memory; do
  if [ -e "$OUT/$log.log" ]; then
    mv "$OUT/$log.log" "$OUT/$log.$(date -u -r "$OUT/$log.log" +%Y%m%dT%H%M%SZ).log"
  fi
done
rm -f "$OUT/meta.json" "$OUT/recipe.out" "$OUT/inner-log.path"
for f in "${FILES[@]}"; do rm -f "$OUT/$f"; done
# Our own output/ (Docker would create the bind-mount source root-owned), emptied
# of the five files so a recipe copy that silently skips one is caught.
mkdir -p "$TREE/output"
for f in "${FILES[@]}"; do rm -f "$TREE/output/$f"; done

START_EPOCH=$(date +%s)
START_UPTIME=$(awk '{ print int($1) }' /proc/uptime)
{
  echo "== engine build $NAME, started $(now)"
  echo "tree:    $TREE"
  echo "sources: pcbjam=$ROOT_SHA kicad=$KICAD_SHA wxwidgets=$WX_SHA shared=$SHARED_SHA"
  echo "env:     COMPOSE_PROJECT_NAME=$DOCKER_PROJECT KICAD_DOCKER_CPUS=$DOCKER_CPUS KICAD_DOCKER_MEM=$DOCKER_MEM KICAD_NO_MONITOR=1"
  echo "recipe:  ./docker/build.sh ${RECIPE_ARGS[*]}"
  echo "wx:      $([ "$WX_CLEAN" = 1 ] && echo "clean build (backend stamp dropped)" || echo "first build (empty volume)")"
  echo "== the recipe's own log follows"
} > "$OUT/build.log"
HEADER_BYTES=$(stat -c %s "$OUT/build.log")

# free -g every minute (plus the builder container's own figure while it runs).
watch_memory() {
  local s="" ids
  trap 'kill "$s" 2>/dev/null; exit 0' TERM
  while :; do
    {
      echo "== $(now)"
      free -g
      # Never a bare `docker stats`: with no ids it reports every container here.
      ids=$(docker compose -p "$DOCKER_PROJECT" ps -q 2>/dev/null || true)
      if [ -n "$ids" ]; then
        # shellcheck disable=SC2086 # one id per word
        docker stats --no-stream --format 'builder: {{.Name}} {{.MemUsage}}' $ids 2>/dev/null || true
      fi
    } >> "$OUT/memory.log"
    sleep 60 & s=$!
    wait "$s"
  done
}

WATCH_PID="" TAIL_PID="" RECIPE_PID=""
cleanup() {
  [ -z "$WATCH_PID" ] || kill "$WATCH_PID" 2>/dev/null || true
  [ -z "$TAIL_PID" ] || kill "$TAIL_PID" 2>/dev/null || true
}
# A TERM to this script stops the whole build: the recipe's own trap then stops
# the builder container. Only when we lead our process group (a setsid launch,
# or a terminal job); otherwise the signal reaches us alone.
on_signal() {
  trap '' INT TERM
  echo "build.sh: interrupted, stopping the recipe" >&2
  if [ "$(ps -o pgid= -p $$ | tr -d ' ')" = "$$" ]; then kill -TERM -- "-$$" 2>/dev/null || true; fi
  exit 130
}
trap cleanup EXIT
trap on_signal INT TERM

watch_memory & WATCH_PID=$!

( cd "$TREE" && exec ./docker/build.sh "${RECIPE_ARGS[@]}" ) > "$OUT/recipe.out" 2>&1 &
RECIPE_PID=$!

# The recipe re-execs itself into <tree>/logs/build/<timestamp>.log and prints
# "Logging to: <path>" first; follow that file into build.log.
INNER=""
for _ in $(seq 1 120); do
  INNER=$(sed -n 's/^Logging to: //p' "$OUT/recipe.out" | head -n 1)
  [ -n "$INNER" ] && break
  kill -0 "$RECIPE_PID" 2>/dev/null || break
  sleep 0.5
done
if [ -n "$INNER" ]; then
  echo "$INNER" > "$OUT/inner-log.path"
  echo "recipe log: $INNER"
  echo "build log:  $OUT/build.log"
  tail -n +1 -F --pid="$RECIPE_PID" "$INNER" >> "$OUT/build.log" 2>/dev/null &
  TAIL_PID=$!
else
  echo "build.sh: the recipe printed no 'Logging to:' line" >&2
fi

if wait "$RECIPE_PID"; then RC=0; else RC=$?; fi
END_EPOCH=$(date +%s)
DURATION=$((END_EPOCH - START_EPOCH))
if [ -n "$TAIL_PID" ]; then wait "$TAIL_PID" 2>/dev/null || true; TAIL_PID=""; fi
kill "$WATCH_PID" 2>/dev/null || true
wait "$WATCH_PID" 2>/dev/null || true
WATCH_PID=""

# build.log must hold the recipe log whole: if the follower missed any of it,
# replace what it wrote with the file itself.
if [ -n "$INNER" ] && [ -f "$INNER" ] \
  && ! tail -c +$((HEADER_BYTES + 1)) "$OUT/build.log" | cmp -s - "$INNER"; then
  truncate -s "$HEADER_BYTES" "$OUT/build.log"
  cat "$INNER" >> "$OUT/build.log"
fi
{
  echo "== the recipe's launcher output"
  cat "$OUT/recipe.out"
  echo "== engine build $NAME: recipe exited $RC after ${DURATION}s, $(now)"
} >> "$OUT/build.log"

PEAK=$(awk '$1 == "Mem:" && $3 + 0 > m { m = $3 + 0 } END { print m + 0 }' "$OUT/memory.log" 2>/dev/null || echo 0)

if [ "$RC" != 0 ]; then
  echo "build.sh: the recipe failed (exit $RC) after ${DURATION}s; last 30 lines of $OUT/build.log:" >&2
  tail -n 30 "$OUT/build.log" >&2
  # An OOM kill shows in the kernel log (since this build began) and, when it is
  # the post-link pass, as a wasm-opt line at the end of the build log.
  KERNEL=$(dmesg 2>/dev/null | awk -v t="$START_UPTIME" '{ s = $0; sub(/^\[ */, "", s); if (s + 0 >= t) print }' \
    | grep -i -E 'oom|out of memory|killed process' | tail -n 5 || true)
  AT_OPT=$(tail -n 40 "$OUT/build.log" | grep -c 'wasm-opt' || true)
  KILLED=$(tail -n 40 "$OUT/build.log" | grep -c -E 'Killed|signal 9|exit(ed)? 137|failed 137|Error 137' || true)
  if [ -n "$KERNEL" ]; then
    echo "build.sh: the kernel logged an OOM kill during this build:" >&2
    echo "$KERNEL" >&2
  fi
  if [ -n "$KERNEL" ] && [ "$AT_OPT" -gt 0 ]; then
    echo "build.sh: OOM KILL in the post-link wasm-opt pass (peak used ${PEAK} GB, cap $DOCKER_MEM). See README: the EC2 fallback." >&2
  elif [ -n "$KERNEL" ]; then
    echo "build.sh: OOM KILL during the compile, not wasm-opt (peak used ${PEAK} GB): fewer jobs (-j) may fit." >&2
  elif [ "$AT_OPT" -gt 0 ] && [ "$KILLED" -gt 0 ]; then
    echo "build.sh: wasm-opt was killed (exit 137) though dmesg shows no OOM line: treat it as an OOM kill (peak used ${PEAK} GB)." >&2
  else
    echo "build.sh: no OOM kill detected (dmesg since the start, the log's end)." >&2
  fi
  exit "$RC"
fi

for f in "${FILES[@]}"; do
  [ -s "$TREE/output/$f" ] || die "the recipe exited 0 but $TREE/output/$f is missing"
  cp -f "$TREE/output/$f" "$OUT/$f"
done

files_json='{}'
for f in "${FILES[@]}"; do
  files_json=$(jq -c --arg f "$f" --arg s "$(sha256sum "$OUT/$f" | cut -d' ' -f1)" \
    --argjson b "$(stat -c %s "$OUT/$f")" '. + { ($f): { sha256: $s, bytes: $b } }' <<<"$files_json")
done
jq -n \
  --arg name "$NAME" --arg pcbjam "$ROOT_SHA" --arg kicad "$KICAD_SHA" \
  --arg wx "$WX_SHA" --arg shared "$SHARED_SHA" --argjson files "$files_json" \
  --arg at "$(now)" --argjson dur "$DURATION" --argjson peak "$PEAK" \
  --arg project "$DOCKER_PROJECT" --arg mem "$DOCKER_MEM" --argjson jobs "$JOBS" \
  '{ tool: "kicad_editor", name: $name,
     sources: { pcbjam: $pcbjam, kicad: $kicad, wxwidgets: $wx, shared: $shared },
     recipe: $pcbjam, files: $files, builtAt: $at, durationSeconds: $dur,
     peakMemGbUsed: $peak, dockerProject: $project, dockerMem: $mem, jobs: $jobs }' \
  > "$OUT/meta.json"

echo "engine build $NAME done in ${DURATION}s (peak used ${PEAK} GB): $OUT"
(cd "$OUT" && sha256sum "${FILES[@]}")
