<!-- Copyright (C) 2026 Circuit Center Inc -->
<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# The island seam: a wave unit's files

Every wave 2 island unit adds ONLY new files, each named by its unit id (RULINGS.md item 16: the unit id is the file stem or a path segment). It never edits `bridge/responder.ts`, `bridge/ops.json`, `bridge/exports.json`, `bridge/held.ts`'s table, `PROTOCOL.md`, `src/types.ts`, `src/main.ts`, `theme/pencil-tools.json`, `theme/user.hotkeys` or any other unit's file. A unit that the manifest lets edit one bridge file it alone owns (`src/project-libs.ts` for i-librows, `bridge/boardUpdate.ts` for i-block-layout, `bridge/place.ts` for i-placebody, `bridge/import.ts` for the import units, `bridge/sim.ts` for lo-e2-i) edits it as its `mq.py owned` list says.

## What a unit adds, file by file

| the unit's | the file | read by |
|---|---|---|
| ops, widened ops, caps, held rows, events, asks, export jobs, frames, install | `bridge/ext/<unit>.ts`, its default export one `ExtUnit` (`bridge/ext/contract.ts`) | `bridge/ext/registry.ts` by glob, then the responder, `src/frames.ts`, the generator |
| unit tests | `bridge/ext/<unit>.test.ts` (and more as `bridge/ext/<unit>/*.test.ts`), or the path the manifest's owned list names under `src/`, `loader/` or `scripts/` (top level) | `npx vitest run <the file>`; `npm test` runs them all (`vite.config.ts` `test.include`: `src`, `bridge`, `theme`, `loader` and the top of `scripts`), and `bridge/ext/seam.test.ts` fails on a test file outside it, the join test alone excepted |
| helper modules | `bridge/ext/<unit>/*.ts` (a folder of the unit's own; the glob reads only `bridge/ext/*.ts`) | the unit's file |
| its PROTOCOL.md part | `bridge/ext/<unit>.md` (below) | `node scripts/ext/gen.mjs` at the join |
| its e2e spec | the path the manifest's `e2e` names (`mq.py field e2e`) | Playwright, on its own port pair |
| fixtures | the paths the manifest's `fixtures` name, each with its source and license, and a `files.json` listing the files a project fixture opens (`["x.kicad_pro", "x.kicad_pcb"]`) | its e2e spec through `tests/harness/parent.html?fixture=<folder>` (a folder not in the harness's own table is read from its `files.json`) |
| pencil rows and chords | NOT the unit's: the ST-PRESS run writes `theme/pencil/<unit>.json` and `theme/hotkeys/<unit>.hotkeys` (`theme/pencil/README.md`) | `theme/pencil-tools.gen.mjs`, `theme/seeds.ts` |

Never written by a unit: `bridge/ops.json` and `bridge/exports.json` (generated at the join from `bridge/ops.builtin.json`, `bridge/exports.builtin.json` and every unit's file), `island.json`'s `ops` and `exportKinds` (`scripts/build.mjs` reads them through the registry), `ev.ready`'s caps (the built ins and every unit's `caps`, at run time), `bridge/ext/pending.json` (the seam's, from the manifest).

Every new file starts with the notice in its comment syntax, `Copyright (C) 2026 Circuit Center Inc` then `SPDX-License-Identifier: GPL-3.0-or-later` (a `bridge/ext/<unit>.md` part says `SPDX-License-Identifier: MIT`, as PROTOCOL.md is MIT); a JSON or other comment-less file carries the two lines in a `<file>.license` beside it. No file names an agent, a tool, a model or a session. `src/new-files.test.ts` (and the build's census, `scripts/notices.mjs`) fails otherwise.

## The contract: `ExtUnit`

```ts
export default {
  unit: 'x-i',                       // the file stem, exactly
  ops: { 'x.get': { run(args, ctx) { ... } } },    // new ops; `now: true` answers off the queue; `passesCheck: true` runs during a check
  frames: ['pcb'],                   // the frames its ops answer in; elsewhere: unsupported, frameRefusal
  frameRefusal: 'x runs in a pcb frame',
  opsWidened: { 'settings.set': async (args, ctx, next) => ... },   // widen an op that ships
  capNames: ['xThing'],              // every cap it may list (static)
  caps: (mod, frame) => (frame === 'pcb' && hasAll(mod, ['kicadXGet']) ? ['xThing'] : []),
  held: ['pcbnew.X.dialog'],         // the KiCad actions it holds
  heldRows: [{ action: 'pcbnew.X.dialog', frames: ['pcb'], cap: 'xThing' }],
  events: { 'ev.x': ['uuid', 'kind'] },   // new events, exactly these keys
  asks: [],                          // ev.prompt ask names it declares (m1x-i's grammar)
  exportJobs: { pcb_x: 'pcb' },      // new project.export jobs and their face
  defineFrames: {},                  // a new frame (fp-i1: fpedit, ds-i1: ds): FrameKind
  askReaders: {},                    // each declared ask's closed record reader (ctx.readAsk)
  exportHooks: {},                   // its part in project.export: msFor, before, tick, after
  settingsSections: {},              // new settings sections (settings.get, settings.set, cap settings:<section>)
  hostTools: {},                     // a KiCad tool that boots no frame: { pcb_calculator: 'calculator' } (ev.openTool)
  eventGuards: {},                   // guards on built in events: { 'ev.sim': (ev, ctx) => keep }
  install(ctx) { ...; return () => { ... } },   // once at engineReady, before ev.ready; the stop runs at close
} satisfies ExtUnit;
```

The registry checks each rule and reports any break in `problems` (the unit is left out of what it broke): the stem, an op that ships already (widen it), an op or event or job or cap or ask another unit owns, a held row already held in that frame, a frame no one defines, a `held` name with no row, `caps` without `capNames`. `bridge/ext/seam.test.ts` pins the rules; `npx vitest run bridge/ext` must stay green with your file in.

### New ops

`run(args, ctx)` gets the request's `args` unchecked: check them closed (every key known, every type) and answer `bad_args` with the op as message. It runs on the request queue (one at a time, after the request before it), so read and write the engine directly. A throw answers `island_error`. An op with `now: true` is answered as it arrives, off the queue (keys.claim's way): for `contextMenu.choose`, `prompt.answer` and the others that must reach an engine parked in a menu or a prompt; it must never wait on the engine's apply queue. During a `sheet.check` or `board.check` every op answers `busy` but the reads, and an op that says `passesCheck: true`.

The manifest's ops answer `unsupported` with the message `seam placeholder: <op> waits for unit <unit>` until the unit's file lands; they are never listed in `island.json`.

### Widening an op that ships (the manifest's `opsWidened`)

`opsWidened: { '<op>': hook }`. The hook is called in place of the op with its args, the ctx and `next`, the op as it stood before the hook: answer your own form of the args yourself, and `return next(args)` for every form the op already takes (rewrite the args first if your form maps onto one). Hooks chain in unit id order, the first wrapping the op. A hook of `project.import`, `sheet.check` or `board.check` runs off the queue as those runs do: call `next` before awaiting anything of the engine. Today's widenings: `board.item.get` and `board.item.set` (m4-i), `settings.get` and `settings.set` (m7-i, lo-e3-i), `project.import` (st-open-foreign-i, st-open-kicad5-i), `board.preview` and `board.update` (i-block-layout), `project.libs` (i-librows), `place` (i-placebody), `sim.run`, `sim.stop`, `sim.result`, `sim.netlist` (lo-e2-i, si1-i).

`sim.stop` and `sim.release` are widened the same way and still answered off the queue (lo-e2-i). A unit that edits a bridge file it alone owns may widen there instead; the join test takes that only from the unit the manifest names. `select` in a frame a unit defines (fp-i1's `fpedit`) is widened from that unit's file: `opsWidened: { select: (args, ctx, next) => ctx.frame === 'fpedit' ? ... : next(args) }`.

A failure answer carries `code` and `message` only (PROTOCOL.md): a state the host must read (st-compare-i's no source) is a code of its own or a field of a success answer, never an extra key of a failure.

### Frames named before they land

`frames`, `heldRows[].frames` and the ops' frames may name `fpedit` and `ds` before fp-i1 and ds-i1 land (`bridge/ext/pending-frames.json`, written by `npm run ext:pending` from the manifest). A pending frame never matches the running frame, so what a unit gives it waits; once its unit lands the name is a defined frame. In TypeScript the frames are `FrameName` (any frame name), so no `declare module` of another unit is needed.

### Caps

`caps(mod, frame)` answers the caps to list now. Feature detect: `hasAll(mod, ['kicadXGet', 'kicadCollabBusy'])`, never a flag. Only names in `capNames` are listed. A frame descriptor's `caps` list (fp-i1, ds-i1) governs the BUILT IN pseudo-caps of that frame (and `heldKeys`); a unit's own caps are its own `caps(mod, frame)` answer for that frame and are never filtered by the descriptor, so m1-i lists `contextMenu` in `fpedit` with no edit of fp-i1's file.

### Settings sections

`settingsSections: { router: { frames: ['pcb'], projectFile?, pcbReadOnly?, check?(value) } }` adds a section to settings.get and settings.set (bridge/settings.ts takes the registry's sections beside the built ins): the built in op reads it with `kicadSettingsGet`, sets it with `kicadSettingsSet` in its fresh folder and reads the record back, and `documentGate` answers `router is a board setting` in a `sch` frame. The unit lists the cap `settings:router` in `capNames` and from `caps` when its engine reads the section. No hook of settings.get or settings.set is needed for a plain section.

### project.export: jobs and hooks

`exportJobs` reach project.export (its parse and its face) and island.json `exportKinds`. `exportHooks` (3d-i3): `msFor(job)` names the run's bound in ms (the longest named wins over the bridge's exportMs), `before(run, ctx)` runs after the checks with the run's fresh folder (`run.dir`) and stages what the run reads, answering `{ settings }` to run with (cc_occ false), null, or a refusal; `tick(run, ctx)` is called every 250 ms while the run goes (progress: `ctx.emitExt('ev.export', ...)`); `after(run, ctx)` once, whatever the outcome.

### The 3D service (3d-i1, 3d-i2)

`src/main.ts` installs `src/occ-service.ts`'s `installOccService({ base, wasmBytes, log })` in a `pcb` frame when that file exists (read by glob, the sim service's twin), with `__OCC_WASM_BYTES__` from PIN.json's `occ_service.wasm` (vite.config.ts). `npm run build:models` runs `scripts/build-models.mjs`, `npm run ship:models` runs `scripts/ship-models.sh`. A file restored from PCBJam under `loader/src/` keeps PCBJam's own header, a GPL SPDX line and our dated `Modified by Circuit Center on YYYY-MM-DD:` notice: the census takes it in place of our copyright line.

### Host tools

`hostTools: { pcb_calculator: 'calculator' }`: KiCad's Switch item asking for that tool sends `ev.openTool { frame: 'calculator' }` and boots nothing (src/frames.ts hostToolFor; st-calc-i writes no line of src/main.ts).

### Held rows

`heldRows` join the built in table (`bridge/held.ts`) as one union, read at run time (`heldActions()` in `bridge/ext/registry.ts`, which m1-i's doors table reads); the responder takes a row's action only in its frames while `ev.ready` listed its cap and a document is open, and sends `ev.held { action }`.

### Events

A built in event a unit must keep quiet in some state takes a guard: `eventGuards: { 'ev.sim': (ev, ctx) => ev.run === ctx.simRun() || ... }` (false drops it; every unit's guard must pass). A new event goes out through `ctx.emitExt('ev.x', { uuid, kind }, transfer?)`: only the keys declared in `events['ev.x']` leave, `undefined` ones left out. A widened built in event (`ev.held`, `ev.edited`, `ev.selected`, `ev.openTool`, `ev.saved`) goes out through `ctx.emit({ type: 'ev.held', action })`, rebuilt with exactly its protocol keys. `ctx.emitExt` of an undeclared type and `ctx.emit` of a non built in type throw.

### A new frame

`defineFrames: { fpedit: { token, tool, toolNames?, document, extension, unitsPerMm, pickKind, picker, refuses, refusal, caps?, selection?, undoDepth?, documentOpen? } }`, and in the same file `declare module '../../src/types' { interface ExtFrames { fpedit: true } }` (and `ExtTools` for a tool of its own, such as `pl_editor`). From then on `?frame=fpedit` boots it (`src/frames.ts`: `bootFrame`, `frameToken`, `frameTool`, the loader's `toolArgv0` and the others), KiCad's Switch items naming one of `toolNames` send `ev.openTool { frame }`, every op in `refuses` answers `unsupported` with `refusal` (the ops answered off the queue too: `lib.index`, `lib.item`, `lib.prefetch`, `keys.claim`, `sim.stop` and `sim.release` read the frame's refusal right after their closed key check), `ev.ready` lists only the pseudo-caps in `caps` (the engine's export names always), `ev.selected` and `ev.edited` read the descriptor's `selection` and `undoDepth`, and the picker warms only when `picker` is true. The e2e harness passes any frame name (`tests/harness/parent.html?frame=fpedit`).

A tool of the frame's own (`ToolKind`: `name`, `bundle`, `argv0`, `needsConfigSeed`, `libKind`, `appearanceFiles?`) whose KiCad frame reads its own settings file names it in `appearanceFiles` (`['pl_editor.json']` for ds-i1): with `needsConfigSeed`, `loader/src/wasm/boot.ts` seeds each such file before main() with the viewer's appearance (the color theme, the toolbar layouts, the cursor), exactly as `eeschema.json` and `pcbnew.json`, so the frame draws in the viewer's palette (`toolAppearanceFiles` in `loader/src/wasm/constants.ts`). The registry refuses a name that is a path, `kicad_common.json`, `eeschema.json` or `pcbnew.json`, or a tool without `needsConfigSeed`.

## ResponderCtx (bridge/ext/contract.ts)

Read state when called; nothing is cached.

- `frame`, `root` (the project folder), `timing` (the bridge's waits, shortened by the unit tests)
- the engine: `win()`, `mod()`, `fs()`, `has(names)`, `ready()` (ev.ready went out), `closed()`, `caps()` (ev.ready's caps)
- the document: `opened()`, `staged()`, `hasDocument()`, `admit()` (a held action or a properties request reaches the host now)
- the engine's state: `engineBusy()` (a load parked), `keysBlocked()` (a popup menu or a dialog up), `placeHanging()`, `importing()`, `checking()`, `simRun()` (the live simulator run, or null), `inFlight()`
- the tables: `heldRows()` (the held union read now, built ins and every unit's: m1-i's doors table), `readAsk(ask, record)` (the declaring unit's closed reader, null for no reader or another shape: m1x-i reads m3-i's, m6-i's and m12-i's asks this way)
- the place watch: `placeStart(uuid)` joins a unit placement to the responder's watch (busy everywhere while it hangs, a later place cancels it first), `placeCancel()` cancels the hanging one; `holdMenus(on)` keeps ev.menu and the coords chip's cover quiet while a unit parks KiCad's menu under its own
- the built in gates, same checks same order: `boardGate(op, exports)`, `schematicGate(op, exports)`, `documentGate(op, exports, section)`; each answers a refusal (`refused(g)`) or `{ w, mod }`
- doing things: `pressKey(k)`, `emit(ev)`, `emitExt(type, payload, transfer?)`, `withTimeout(value, ms)`, `applyIdle(ms)`, `freshRunFolder(rootDir)`, `dropRunFolder(dir)`, `queuedRun(op, dir, ms, call, record)`, `watchedRun(...)` (closes dialogs met), `closeRunDialogs()`, `readBytes(abs)`, `refocus()`, `log(...)`

Helpers: `ok`, `fail`, `isObj`, `onlyKeys`, `noArgs`, `hasAll`, `refused` from `bridge/ext/contract.ts`. A unit imports anything of `bridge/` and `src/` but `bridge/responder.ts`, `bridge/ext/registry.ts` and `src/frames.ts` (they load the units: the import would be a cycle).

## A worked example: a small unit

`bridge/ext/st-len-e-i.ts` (the manifest: op `board.nets`, cap `netReport`, frame `pcb`, engine export `kicadBoardNets`):

```ts
// Copyright (C) 2026 Circuit Center Inc
// SPDX-License-Identifier: GPL-3.0-or-later
// board.nets (PROTOCOL.md): every net of the board with its length, read by our
// engine's kicadBoardNets with no KiCad window.
import { fail, hasAll, isObj, noArgs, ok, refused, type ExtUnit } from './contract';

const EXPORTS = ['kicadBoardNets'] as const;

export default {
  unit: 'st-len-e-i',
  frames: ['pcb'],
  frameRefusal: 'a board op runs in a pcb frame',
  capNames: ['netReport'],
  caps: (mod, frame) => (frame === 'pcb' && hasAll(mod, EXPORTS) ? ['netReport'] : []),
  ops: {
    'board.nets': {
      passesCheck: true,   // a read
      run(args, ctx) {
        if (!noArgs(args)) return fail('bad_args', 'board.nets');
        const g = ctx.boardGate('board.nets', EXPORTS);   // on run 14 this answers unsupported kicadBoardNets
        if (refused(g)) return g;
        let read: unknown;
        try { read = JSON.parse(String((g.mod.kicadBoardNets as () => unknown)())); } catch { read = null; }
        if (!isObj(read) || !Array.isArray(read.nets)) return fail('island_error', 'the engine answered nets of another shape');
        return ok({ nets: read.nets });
      },
    },
  },
} satisfies ExtUnit;
```

`bridge/ext/st-len-e-i.md`:

```md
<!-- Copyright (C) 2026 Circuit Center Inc -->
<!-- SPDX-License-Identifier: MIT -->
<!-- part: requests -->
| `board.nets` | none | `{ nets: [{ name: string, length: number }] }` |
<!-- part: section -->
### board.nets
Every net of the board ... (island `v0.2.3-cc25`, on an engine with `kicadBoardNets`; a host gates it on `ev.ready` `caps` listing `netReport`).
```

The parts are `requests` (rows of the request table), `codes` (rows of the error codes table; a code the table holds already, or an earlier unit gave, is added once: the first row stands), `events` (items of the events list, `- \`ev.x { ... }\` ...`), `section` (the op's own section) and `notes <op>` (list items added at the end of the section of an op that ships: `<!-- part: notes sim.run -->`, under its own heading or its family's, as `sim.run` is under the simulator's). `node scripts/ext/gen.mjs` puts them in PROTOCOL.md at the join, each row tagged with the unit; a unit never edits PROTOCOL.md.

`bridge/ext/st-len-e-i.test.ts`: the unit's own checks through `buildRegistry` and `startResponder({ ..., ext: buildRegistry({ './st-len-e-i.ts': { default: unit } }) })`, as `bridge/ext/seam.test.ts` does, with a fake engine module in the test file only.

## Today's engine (cc24, engine run 14) and its e2e

Your engine export does not exist before engine run 15 (cc25). Feature detect it, in `caps` and in the op (the gate's export list): on run 14 the cap is not listed and the op answers `unsupported` naming the export. Never a fake engine, never a flag, never a stand in: a fake module lives only in a `*.test.ts` file. Your e2e spec runs on the real engine: on run 14 it proves the op answers `unsupported` and the cap is absent; its run 15 half runs at the join on cc25.

Run your e2e alone on your own port pair (the page on the port, the island on the next):

```bash
cd <your island worktree>
npm run build                                   # through the gate: /home/matthew/cc-wave2/bin/gate.sh npm run build
CC_E2E_PORT=$(/home/matthew/cc-wave2/bin/port.sh <your seat>) /home/matthew/cc-wave2/bin/gate.sh npx playwright test <your spec> --project=chromium
```

## Checks for a unit

- `npx tsc --noEmit -p .`
- `npx vitest run bridge/ext/<unit>.test.ts bridge/ext/seam.test.ts src/new-files.test.ts src/wording.test.ts`
- your e2e as above
- at the join only: `npm run ext:pending` (when the manifest changed or a unit was dropped from the wave: its ops and frames leave the pending lists), then `npm run gen:ext` (writes `bridge/ops.json`, `bridge/exports.json` and PROTOCOL.md's parts) then `npm run test:join` (fails while any manifest name is missing or any manifest op still answers the seam placeholder; `CC_W2_MANIFEST` names the manifest).
