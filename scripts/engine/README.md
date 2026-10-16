# The engine build

`build.sh` builds the engine (`kicad_editor`: `kicad_editor.js`, `kicad_editor.wasm`,
`wx.js`, `wx-dom.js`, `images.tar.gz`) on this machine with PCBJam's own recipe
(`docker/build.sh` in the pcbjam repository), instead of taking the files from
PCBJam's CDN.

## What it does

1. Assembles `/home/matthew/cc-engine/tree-<name>/` in PCBJam's layout from the four
   local clones in `/home/matthew/cc-engine/` (`pcbjam`, `kicad-source-mirror`,
   `wxWidgets`, `pcbjam-shared`) with `git worktree add`: the pcbjam root on a branch
   `build/<name>`, then `kicad/`, `wxwidgets/` and `web/pcbjam-shared/` inside it as
   detached worktrees of the other three clones. The wxWidgets worktree also needs its
   own nested submodules (the bundled pcre, png, jpeg, expat, tiff, zlib, nanosvg and
   catch: the recipe's wx configure uses `--with-regex=builtin` and the builtin image
   libraries), and a worktree starts with them empty, so the script initializes all
   eight shallowly (a commit a shallow fetch cannot reach is fetched whole), checks
   they sit at their recorded commits, and checks that `3rdparty/pcre/pcre2-config.in`
   and `src/png/png.h` exist before it launches anything. Only wxWidgets has nested
   submodules; kicad and pcbjam-shared have none.
2. Checks that the pcbjam tree's recorded submodule pointers
   (`git ls-tree HEAD kicad wxwidgets web/pcbjam-shared`) are exactly the three
   worktrees' `HEAD`s, and refuses to build otherwise. Rerunning with the trees present
   verifies them and continues. `cc/main` is resolved at every launch, so **a rerun of
   `cc8` always builds the current `cc/main`**: an existing worktree at another commit is
   moved to it (`checkout -B build/cc8 <sha>` for the root, a detached checkout for
   kicad) and the gitlinks are checked again; a worktree with local changes to tracked
   files stops the build instead of being moved.
3. Forces a clean wxWidgets build when the cache volume already exists, through
   PCBJam's own trigger: it deletes `build-wasm/wxwidgets/.pcbjam-async-backend` from
   the `kicad-build-cache` volume (`build-wx-wasm.sh` rebuilds wx clean when that stamp
   is absent). About five minutes per build; the deps stay cached. Notes say why.
4. Runs the recipe in the tree with its knobs set (below), every other recipe variable
   at its default (`KICAD_WASM_OPT` unset, so the post-link pass is `-O2`).
5. Logs `free -g` every minute while it runs, then copies the five files from the
   tree's `output/` and writes `meta.json` beside them.

Only one engine build runs at a time (`/home/matthew/cc-engine/out/.build.lock`): both
trees share one compose project and its volumes.

## The two invocations

```bash
bash scripts/engine/build.sh pristine   # the pinned v0.2.3 commits, unchanged; runs the deps stage
bash scripts/engine/build.sh cc8        # cc/main of pcbjam and kicad-source-mirror (wx, shared: the pins)
bash scripts/engine/build.sh cc8 --build-deps   # cc8, rerunning the deps stage too
```

| tree       | pcbjam                       | kicad                        | wxwidgets  | pcbjam-shared | recipe args                         |
|------------|------------------------------|------------------------------|------------|---------------|-------------------------------------|
| `pristine` | `7ec51c1c55aab45b21cd2956af413b4420520838` | `48f1e865216623283579984110a80210e7ccc789` | `8bad5f58e9b51050d3678f5c98cb0dc41b4595b2` | `7791275bdfbf54e1500e303121dacaa2c3fd7d00` | `kicad_editor --build-deps -j 6` |
| `cc8`      | `cc/main`                    | `cc/main`                    | the pin    | the pin       | `kicad_editor -j 6`                 |

Long: about 54 minutes for the first tree on empty volumes (it builds the Docker image
and the deps, OpenCASCADE among them), then about 25 minutes for each later build (a
clean wx build, a full KiCad recompile served by ccache, the link, `wasm-opt`). Launch
it detached:

```bash
mkdir -p /home/matthew/cc-engine/out/pristine
nohup setsid bash scripts/engine/build.sh pristine \
  > /home/matthew/cc-engine/out/pristine/launcher.log 2>&1 &
```

## Where the outputs land

`/home/matthew/cc-engine/out/<name>/`:

| file | what |
|------|------|
| the five files | copied from `tree-<name>/output/` after the recipe exits 0 |
| `meta.json` | `tool`, `name`, `sources` (the four worktree shas), `recipe` (the pcbjam sha), `files` (sha256 and bytes of each), `builtAt`, `durationSeconds`, `peakMemGbUsed`, `dockerProject`, `dockerMem`, `jobs` |
| `build.log` | the whole record: our header, the recipe's own log (followed live), the recipe launcher's lines, the exit line |
| `memory.log` | `free -g` each minute, plus the builder container's own figure while it runs |
| `build.pid` | the script's PID |
| `inner-log.path` | the recipe's own log, `tree-<name>/logs/build/<timestamp>.log` |
| `launcher.log` | the script's own output (assembly, paths, the result) |

A new run moves the previous `build.log` and `memory.log` aside under their date and
drops the previous outputs and `meta.json`.

## Rulings

- **One compose project for both trees**, `COMPOSE_PROJECT_NAME=kicad-wasm-cc-engine`
  (the recipe honors a preset name). The pristine tree builds first on empty volumes,
  so `--build-deps` (wxWidgets + OpenCASCADE, hours) runs once; the cc8 build reuses
  the `kicad-build-cache` and `workspace-src` volumes, and the recipe's own
  `rsync --delete --checksum` swaps the sources in. The Docker image is built once
  for the project.
- **`KICAD_DOCKER_MEM=44G`, `KICAD_DOCKER_CPUS=8`**: the recipe's default cap is 32G,
  and the post-link `wasm-opt -O2` pass was expected to peak near 40 GB (measured here:
  about 11 GiB, see the reproduction record). WSL here has 47 GB and 8 CPUs.
- **`-j 6`** for the compile, below the 8 CPUs, to leave the machine usable.
- **`KICAD_NO_MONITOR=1`**: no TTY dashboard (the build runs detached).

## Watching a build

```bash
tail -f /home/matthew/cc-engine/out/pristine/build.log
tail -f /home/matthew/cc-engine/out/pristine/memory.log
grep '@KW@' /home/matthew/cc-engine/out/pristine/build.log | tail -n 3   # the recipe's stage markers
docker compose -p kicad-wasm-cc-engine ps
```

Stop one with `kill $(cat /home/matthew/cc-engine/out/<name>/build.pid)`: a detached
(setsid) run stops the recipe too, and the recipe stops its builder container.

If the recipe fails, the script prints the last 30 lines of `build.log` and says
whether the kernel logged an OOM kill since the build began, and whether it hit the
post-link `wasm-opt`.

**Alternative if the local run is OOM-killed** (`dmesg | grep -i oom`, or `build.log`
ending in a killed `wasm-opt`): a temporary EC2 `r6i.2xlarge` (64 GB) in the owner's
account running the same script, created and terminated by hand, on the owner's word;
nothing else in the plan changes.

## Reproduction record (D7)

The pristine build (2026-10-15, finished 2026-10-16T00:00:42Z) compared with the CDN
files the island serves today (`engine/kicad_editor/v0.2.3/`, fetched by
`scripts/fetch-engine.mjs`, whose sha256s are `PIN.json`'s `engine.files`):

| file | built here (pristine) | PCBJam CDN (`PIN.json`) | bytes (here / CDN) | result |
|------|------|------|------|------|
| `kicad_editor.js` | `39e41c2233a1e139be74e4a8b408380ec7c05ec7c1418d3e336deb3dd600d9b0` | `39e41c2233a1e139be74e4a8b408380ec7c05ec7c1418d3e336deb3dd600d9b0` | 488,056 / 488,056 | byte-equal |
| `kicad_editor.wasm` | `9cc2400964558d694d83bee5ff7e6341b1901592becf32c2ac09d4b9ae4c0a62` | `a80fd1f7004d1571aa2344ae7a195187fff31ee31e74ca5eff7adc42c98812f9` | 60,823,287 / 60,823,287 | 19 bytes differ, every one inside a compiled-in date or time string |
| `wx.js` | `42d6b547f9a024f187f1b7812b64a3f76ca322d35393531340cb316ff88da351` | `42d6b547f9a024f187f1b7812b64a3f76ca322d35393531340cb316ff88da351` | 79,808 / 79,808 | byte-equal |
| `wx-dom.js` | `7edabd5571c9f2fd0ea1acf7005fb3628f2e3cf6b8f430f8e473c328fb042a10` | `7edabd5571c9f2fd0ea1acf7005fb3628f2e3cf6b8f430f8e473c328fb042a10` | 68,699 / 68,699 | byte-equal |
| `images.tar.gz` | `072fb17434be5c928e3e8d229ade4d889c9916a85c55a8c624c536896bbaa2e3` | `bc24c8db9b9050af2093305e0e42694812297ff4f465f45b0d30b0303dde6477` | 5,369,401 / 5,373,919 | same members and contents, different archive metadata |

**`kicad_editor.wasm`, measured:** the files have the same length, and `cmp -l` reports
19 differing bytes at two places. Each place is a `__DATE__` `__TIME__` pair compiled in
as UTF-32 (`wchar_t`) text, and every differing byte is one character of that date or
time (differences closer than 8 bytes are merged into one run):

| run (file offsets) | differing bytes | here | CDN |
|---|---|---|---|
| `0x03347b8b`-`0x03347b93` | 3 | `Oct` | `Sep` |
| `0x03347b9f` | 1 | `15` (day) | `16` |
| `0x03347bbb`-`0x03347bbf` | 2 | `23` (hour) | `18` |
| `0x03347bcb`-`0x03347bd7` | 3 | `41:01` | `45:13` |
| `0x033bef9b`-`0x033befa3` | 3 | `Oct` | `Sep` |
| `0x033befaf` | 1 | `15` (day) | `16` |
| `0x033befcb`-`0x033befe7` | 6 | `23:35:41` | `18:43:33` |

The decoded text at the two places:

- `0x03347b8b`, KiCad's build-version string: `%s` `10.0.4` `%s %s` `Oct 15 2026` `23:41:01` here,
  `Sep 16 2026` `18:45:13` on the CDN. The `10.0.4` beside it is KiCad's fallback version: git
  is unreachable inside the builder on both sides (the CDN file also carries the all-zero
  commit hash).
- `0x033bef9b`, wxWidgets' build information: `…de from wxMessageDialog` `Oct 15 2026`
  `23:35:41` `wxWidgets informati…` here, `Sep 16 2026` `18:43:33` on the CDN.

The ASCII `Aug  5 2026` in the module is a source literal: it sits at the same offset
(51,585,074) in both files. The recipe passes no `SOURCE_DATE_EPOCH` into the container,
so these two pairs are the build's only time-dependent bytes. Apart from those two
compile timestamps, this build reproduces the CDN engine exactly.

**`images.tar.gz`, measured** (`tar -tzvf` listings, then every member's sha256):
both hold the same 5,116 members (`./` and 5,115 PNGs) with identical names, sizes,
modes and contents; both uncompressed tars are 9,338,880 bytes; both gzip headers carry
mtime 0. What differs is archive metadata only:

- member order: the build filesystem's directory read order;
- member mtimes: here 2026-10-15T23:03:57Z to 23:33:12Z, on the CDN 2026-09-16T18:38:52Z to 18:42:06Z;
- owner: uid/gid 1000/1000 here (the host user, carried by the entrypoint's `rsync -a`), 1001/1001 on the CDN (PCBJam's runner).

The reordered stream compresses to a different size (5,369,401 against 5,373,919 bytes).

**Build facts:**

- toolchain: emsdk/Emscripten 6.0.6 (`scripts/common/versions.sh`, tarball sha256-pinned in `docker/Dockerfile`, image on `ubuntu:22.04`);
- build type and flags: the recipe's default Debug build (`-g -O1`, separate DWARF), the same as PCBJam's CI, then the post-link `wasm-opt -O2`;
- 3D viewer: ON (the recipe's default);
- parallelism and cap: compose project `kicad-wasm-cc-engine`, `-j 6`, 8 CPUs, the 44G cap;
- timing: the successful run took 1,659 s (wx configure 23:33:07Z, wx compile 23:34:10Z, KiCad configure 23:38:13Z, KiCad compile 23:46:45Z, bitmaps 23:59:40Z, `wasm-opt` 23:59:42Z to 00:00:36Z, done 00:00:42Z);
- the earlier attempt: it built the Docker image and the other deps (boost, cairo, freetype, harfbuzz, OpenCASCADE, pixman, protobuf, zstd and the rest) in 1,594 s before it stopped at wx configure (the missing nested submodules, since fixed). A first tree from empty volumes is about 54 minutes here;
- memory: the peak "used" in `free -g` was 10 GB. The builder container's own figure was 10.91 GiB in the sample taken during `wasm-opt` (00:00:32Z). The sampler runs every 60 s, so a shorter peak could be missed, but nothing came near the cap and nothing was killed.

### The cc8 build (2026-10-16)

Sources: pcbjam `c9752f8d3fa22d5164c9924b02ea20f76370d7de` (`cc/main`), kicad
`90898109c74ce5143fda09e21e36d280f02f68c4` (`cc/main`), wxwidgets and pcbjam-shared at
the pins. Finished 2026-10-16T00:41:40Z after 1,493 s; peak 13 GB host "used", builder
11.01 GiB.

| file | sha256 | bytes | against pristine |
|------|--------|-------|------------------|
| `kicad_editor.js` | `6384c3dfa5d763fbb6de307f8a22839b3047e4727c61ae68f061662e9d693308` | 488,429 | +373 (the `kicadImportSchematic` export: 3 mentions, 0 in pristine) |
| `kicad_editor.wasm` | `e8bd84e9123f3a67233b1336e9cb5ca8d88ce9f4a1075a7e0cfd87201e2e508a` | 63,211,699 | +2,388,412 (+3.9 %), the importers |
| `wx.js` | `42d6b547f9a024f187f1b7812b64a3f76ca322d35393531340cb316ff88da351` | 79,808 | equal |
| `wx-dom.js` | `7edabd5571c9f2fd0ea1acf7005fb3628f2e3cf6b8f430f8e473c328fb042a10` | 68,699 | equal |
| `images.tar.gz` | `4ee189c32c796adf0d8b1c61cfa69b10c9c91d43d5327722a3a507c34af39be5` | 5,369,575 | same 5,116 members, names, sizes and contents (archive metadata only) |

The importers are in. `strings kicad_editor.wasm | grep -c "Altium Designer"` is 2 here and 0 in pristine and in the CDN build.

The full counts, `grep -c` over `strings` (ASCII) and over `strings -e L` (the UTF-32 `wxT()` text):

| term | pristine ASCII | cc8 ASCII | pristine UTF-32 | cc8 UTF-32 |
|------|------|------|------|------|
| `Altium Designer` | 0 | 2 | 0 | 2 |
| `Solidworks PCB` (the plugin's registered name, `pcb_io_mgr.cpp`; `SolidWorks` with a capital W is 0 in both) | 0 | 1 | 0 | 2 |
| `Allegro` | 2 | 16 | 2 | 5 |
| `CADSTAR` | 144 | 200 | 12 | 16 |
| `EasyEDA` | 3 | 5 | 7 | 9 |
| `LTspice` | 0 | 5 | 1 | 2 |
| `kicadImportSchematic` | 0 | 1 | 0 | 0 |

PCBJam's build already carried some board importers (CADSTAR, EasyEDA), hence their nonzero pristine counts. The importer class names `PCB_IO_ALTIUM_DESIGNER`, `PCB_IO_ALLEGRO`, `PCB_IO_SOLIDWORKS`, `SCH_IO_ALTIUM`, `SCH_IO_CADSTAR_ARCHIVE`, `SCH_IO_EAGLE`, `SCH_IO_EASYEDA` and `SCH_IO_LTSPICE` each appear in this module and in none of pristine's.

Stages:
- clean wx build: 00:16:52Z to 00:21:23Z;
- KiCad configure and the `pcbcommon` pre-build: 00:21:24Z to 00:28:22Z;
- KiCad compile: 00:28:22Z to 00:40:35Z (all 1,854 objects, served by ccache, though only `wasm/kiplatform/io.cpp` changed since the build before; this is the entrypoint re-touch in Notes);
- `wasm-opt`: 00:40:36Z to 00:41:34Z.

To repeat the comparison:

```bash
cmp -l /home/matthew/cc-engine/out/pristine/kicad_editor.wasm engine/kicad_editor/v0.2.3/kicad_editor.wasm | wc -l   # 19
diff <(tar -tzvf /home/matthew/cc-engine/out/pristine/images.tar.gz | awk '{print $3, $6}' | sort) \
     <(tar -tzvf engine/kicad_editor/v0.2.3/images.tar.gz | awk '{print $3, $6}' | sort)                 # empty
```

## Notes

- The `KICAD_SYM_CONVERTER_WASM` / `KICAD_PCB_CONVERTER_WASM` converter trees now compile every importer too (bigger, slower, no behavior change).
- The Altium parsers compile under Emscripten because PCBJam's `scripts/kicad/build-kicad-target.sh` force-includes `wasm/stubs/char_traits_uint16_workaround.h` into every TU; KiCad's own `eeschema/CMakeLists.txt` comment on `cc/main` says so.
- The Allegro board importer is built since kicad `cc/main` `90898109`. It is KiCad's one user of `KIPLATFORM::IO::MAPPED_FILE`, whose constructor and destructor live only in `libs/kiplatform/os/unix/io.cpp` and `os/windows/io.cpp`. An Emscripten build compiles PCBJam's `wasm/kiplatform/io.cpp` in their place, so the first cc8 build (2026-10-15) compiled every source and then failed at the final `wasm-ld` link with those two symbols undefined. pcbjam `cc/main` `c9752f8` adds them to the wasm layer: the constructor reads the file whole through the shared `readIntoBuffer` (`os/common/io.cpp`; the browser's file system is in memory), and the destructor has nothing to unmap.
- The wxWidgets fork carries its bundled libraries as nested submodules; a worktree starts without them, and the first pristine build (2026-10-15) stopped at wx configure (`3rdparty/pcre/pcre2-config.in couldn't be found`). The script now initializes them (see "What it does").
- Why every build rebuilds wxWidgets clean. The second cc8 build (2026-10-16) died in wx's bundled pcre: `No rule to make target '/workspace/wxwidgets/3rdparty/pcre/src/pcre2_chartables.c'`, the failure the header of PCBJam's `scripts/build-wx-wasm.sh` describes for its CI cache.
  - **The trigger is the recipe's `docker/entrypoint.sh`, not our worktrees.** On every container start it runs `rsync -ai --delete /workspace-host/ /workspace/`, an archive copy that compares mtimes, and then `touch`es each file it transferred. The touch leaves the volume's mtime different from the host's, so the next start transfers and touches the same files again: every file it ever copied gets a new mtime at every start, whatever its content.
  - `docker compose up -d` returns before the entrypoint finishes, so the touching runs WHILE the build runs. Measured on the third cc8 build: the volume's `wxwidgets/configure.in` got 00:17:02Z, after the wx stage began at 00:16:50Z, and `kicad/common/eda_item.cpp` got 00:16:49Z while its host copy kept 00:01:45Z.
  - Whether wx's mtime test (`configure.in -nt` the build Makefile) fires therefore depends on a race. The first cc8 build checked before the touch reached wx ("Already configured"); the second found `configure.in` newer and re-configured inside the existing wx build dir.
  - There pcre's `src/pcre2_chartables.c` rule ran `rm -f $@`. Through VPATH that deleted the TRACKED source copy in `/workspace`, while the dependency files of the earlier wx build still named that path.

  A clean wx build (`rm -rf build-wasm/wxwidgets`, which the recipe does itself when the stamp is absent) regenerates those dependency files, so it is forced on every run.

  The rule on our side: a rerun leaves a worktree whose commit is unchanged untouched. `ensure_worktree` returns before any git command, and `submodule update` is a no-op at the recorded commits; the wx and shared reflogs keep their single worktree-add entry. Because the entrypoint re-touches every source, expect KiCad to recompile from ccache on every build.
