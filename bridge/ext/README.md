<!-- Copyright (C) 2026 Circuit Center Inc -->
<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# The island seam: a wave unit's files

Every wave 2 island unit adds ONLY new files, each named by its unit id (RULINGS.md item 16: the unit id is the file stem or a path segment). It never edits `bridge/responder.ts`, `bridge/ops.json`, `bridge/exports.json`, `bridge/held.ts`'s table, `PROTOCOL.md`, `src/types.ts`, `src/main.ts`, `theme/pencil-tools.json`, `theme/user.hotkeys` or any other unit's file. A unit that the manifest lets edit one bridge file it alone owns (`src/project-libs.ts` for i-librows, `bridge/boardUpdate.ts` for i-block-layout, `bridge/place.ts` for i-placebody, `bridge/import.ts` for the import units, `bridge/sim.ts` for lo-e2-i) edits it as its `mq.py owned` list says.

## What a unit adds, file by file

| the unit's | the file | read by |
|---|---|---|
| ops, widened ops, caps, held rows, events, asks, export jobs, frames, install | `bridge/ext/<unit>.ts`, its default export one `ExtUnit` (`bridge/ext/contract.ts`) | `bridge/ext/registry.ts` by glob, then the responder, `src/frames.ts`, the generator |
| unit tests | `bridge/ext/<unit>.test.ts` (and more as `bridge/ext/<unit>/*.test.ts`) | `npx vitest run bridge/ext/<unit>.test.ts` |
| helper modules | `bridge/ext/<unit>/*.ts` (a folder of the unit's own; the glob reads only `bridge/ext/*.ts`) | the unit's file |
| its PROTOCOL.md part | `bridge/ext/<unit>.md` (below) | `node scripts/ext/gen.mjs` at the join |
| its e2e spec | the path the manifest's `e2e` names (`mq.py field e2e`) | Playwright, on its own port pair |
| fixtures | the paths the manifest's `fixtures` name, each with its source and license | its e2e spec |
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
  install(ctx) { ...; return () => { ... } },   // once at engineReady, before ev.ready; the stop runs at close
} satisfies ExtUnit;
```

The registry checks each rule and reports any break in `problems` (the unit is left out of what it broke): the stem, an op that ships already (widen it), an op or event or job or cap or ask another unit owns, a held row already held in that frame, a frame no one defines, a `held` name with no row, `caps` without `capNames`. `bridge/ext/seam.test.ts` pins the rules; `npx vitest run bridge/ext` must stay green with your file in.

### New ops

`run(args, ctx)` gets the request's `args` unchecked: check them closed (every key known, every type) and answer `bad_args` with the op as message. It runs on the request queue (one at a time, after the request before it), so read and write the engine directly. A throw answers `island_error`. An op with `now: true` is answered as it arrives, off the queue (keys.claim's way): for `contextMenu.choose`, `prompt.answer` and the others that must reach an engine parked in a menu or a prompt; it must never wait on the engine's apply queue. During a `sheet.check` or `board.check` every op answers `busy` but the reads, and an op that says `passesCheck: true`.

The manifest's ops answer `unsupported` with the message `seam placeholder: <op> waits for unit <unit>` until the unit's file lands; they are never listed in `island.json`.

### Widening an op that ships (the manifest's `opsWidened`)

`opsWidened: { '<op>': hook }`. The hook is called in place of the op with its args, the ctx and `next`, the op as it stood before the hook: answer your own form of the args yourself, and `return next(args)` for every form the op already takes (rewrite the args first if your form maps onto one). Hooks chain in unit id order, the first wrapping the op. A hook of `project.import`, `sheet.check` or `board.check` runs off the queue as those runs do: call `next` before awaiting anything of the engine. Today's widenings: `board.item.get` and `board.item.set` (m4-i), `settings.get` and `settings.set` (m7-i, lo-e3-i), `project.import` (st-open-foreign-i, st-open-kicad5-i), `board.preview` and `board.update` (i-block-layout), `project.libs` (i-librows), `place` (i-placebody), `sim.run`, `sim.stop`, `sim.result`, `sim.netlist` (lo-e2-i, si1-i).

### Caps

`caps(mod, frame)` answers the caps to list now. Feature detect: `hasAll(mod, ['kicadXGet', 'kicadCollabBusy'])`, never a flag. Only names in `capNames` are listed.

### Held rows

`heldRows` join the built in table (`bridge/held.ts`) as one union, read at run time (`heldActions()` in `bridge/ext/registry.ts`, which m1-i's doors table reads); the responder takes a row's action only in its frames while `ev.ready` listed its cap and a document is open, and sends `ev.held { action }`.

### Events

A new event goes out through `ctx.emitExt('ev.x', { uuid, kind }, transfer?)`: only the keys declared in `events['ev.x']` leave, `undefined` ones left out. A widened built in event (`ev.held`, `ev.edited`, `ev.selected`, `ev.openTool`, `ev.saved`) goes out through `ctx.emit({ type: 'ev.held', action })`, rebuilt with exactly its protocol keys. `ctx.emitExt` of an undeclared type and `ctx.emit` of a non built in type throw.

### A new frame

`defineFrames: { fpedit: { token, tool, toolNames?, document, extension, unitsPerMm, pickKind, picker, refuses, refusal, caps?, selection?, undoDepth?, documentOpen? } }`, and in the same file `declare module '../../src/types' { interface ExtFrames { fpedit: true } }` (and `ExtTools` for a tool of its own, such as `pl_editor`). From then on `?frame=fpedit` boots it (`src/frames.ts`: `bootFrame`, `frameToken`, `frameTool`, the loader's `toolArgv0` and the others), KiCad's Switch items naming one of `toolNames` send `ev.openTool { frame }`, every op in `refuses` answers `unsupported` with `refusal`, `ev.ready` lists only the pseudo-caps in `caps` (the engine's export names always), `ev.selected` and `ev.edited` read the descriptor's `selection` and `undoDepth`, and the picker warms only when `picker` is true. The e2e harness passes any frame name (`tests/harness/parent.html?frame=fpedit`).

## ResponderCtx (bridge/ext/contract.ts)

Read state when called; nothing is cached.

- `frame`, `root` (the project folder), `timing` (the bridge's waits, shortened by the unit tests)
- the engine: `win()`, `mod()`, `fs()`, `has(names)`, `ready()` (ev.ready went out), `closed()`, `caps()` (ev.ready's caps)
- the document: `opened()`, `staged()`, `hasDocument()`, `admit()` (a held action or a properties request reaches the host now)
- the engine's state: `engineBusy()` (a load parked), `keysBlocked()` (a popup menu or a dialog up), `placeHanging()`, `importing()`, `checking()`, `inFlight()`
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

The parts are `requests` (rows of the request table), `codes` (rows of the error codes table), `events` (items of the events list, `- \`ev.x { ... }\` ...`) and `section` (the op's own section). `node scripts/ext/gen.mjs` puts them in PROTOCOL.md at the join, each row tagged with the unit; a unit never edits PROTOCOL.md.

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
- at the join only: `npm run gen:ext` (writes `bridge/ops.json`, `bridge/exports.json` and PROTOCOL.md's parts) then `npm run test:join` (fails while any manifest name is missing or any manifest op still answers the seam placeholder; `CC_W2_MANIFEST` names the manifest).
