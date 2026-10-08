# cc-editor/1

MIT License. Copyright (c) 2026 Chirichella Inc.

The message protocol between a page (the host) and the editor island (the frame). The island is a cross-origin iframe. All messages are structured-clone objects. File contents travel as `Uint8Array` only, in both directions; the host may transfer the underlying buffer, and the frame always transfers a fresh copy.

The frame's kind is fixed by its URL: `?frame=sch` (the schematic editor, files `.kicad_sch`) or `?frame=pcb` (the board editor, files `.kicad_pcb`); anything else means `sch`. `?theme=night` starts it dark, anything else light.

## Handshake
1. The frame posts `{ type: "cc.hello", proto: 1, nonce: <random string>, island: <islandId> }` to `window.parent` with the host's exact origin as target. It does so before the engine boots.
2. The host answers `{ type: "cc.connect", nonce }` to the frame's window with one transferred `MessagePort`. The frame accepts only the first connect carrying its nonce, from `window.parent`, with no other keys. A reloaded frame posts a new hello with a new nonce.
3. Everything after runs on the port. Events the frame emitted before the connect are queued and sent, in order, once the port arrives.

## Requests (host to frame): `{ id: number, op: string, args?: object }`
Answers: `{ id, ok: true, result: object }` or `{ id, ok: false, error: { code: string, message: string } }`. Every request with a safe integer `id` and a string `op` is answered exactly once; anything else on the port is ignored. The frame handles requests one at a time, in the order they arrive: a request waits until the one before it has been answered. The library reads `lib.index`, `lib.item` and `lib.prefetch` are the exception: they never touch the engine, so each is answered as soon as its read is, outside that queue (a `lib.item` waiting on a bundle holds up no `key.press`, `view.fit` or `place` sent after it, and none waits for them), and their answers may overtake earlier requests' answers. The one exception is a running `project.import`: the requests that arrive while it runs are answered at once (`busy`, or a `shutdown`'s own answer), before the import's answer.

| op | args | result |
|---|---|---|
| `project.open` | `{ name: string, files: [{ path: string, bytes: Uint8Array }], open?: string }` | `{ opened: string, dropped: string[], chrome: boolean }` |
| `project.import` | `{ name: string, files: [{ path: string, bytes: Uint8Array }], open: string, format?: string }` | `{ opened: string, dropped: string[], warnings: string[], chrome: boolean }` |
| `project.save` | none | `{ path: string, saved: string[] }` |
| `project.forget` | none | `{}` |
| `chrome.show` | `{ on: boolean }` | `{}` |
| `readonly` | `{ on: boolean }` | `{}` |
| `shutdown` | none | `{}` |
| `key.press` | `{ key: string, code: string, ctrl?: boolean, shift?: boolean, alt?: boolean }` | `{}` |
| `view.fit` | none | `{}` |
| `sheet.tree` | none | `{ current: string, sheets: [{ path: string, name: string, page: string, depth: number, parent: string, file: string }] }` |
| `sheet.enter` | `{ path: string }` | `{}` |
| `layers.get` | none | `{ active: number, layers: [{ id: number, name: string, canonical: string, color: string, visible: boolean, copper: boolean }] }` |
| `layers.visible` | `{ id: number, visible: boolean }` | `{}` |
| `layers.active` | `{ id: number }` | `{}` |
| `lib.index` | `{ kind: "symbol" \| "footprint" }` | `{ text: string \| null }` |
| `lib.item` | `{ kind: "symbol" \| "footprint", lib: string, name: string }` | `{ body: string \| null }` |
| `lib.prefetch` | `{ kind: "symbol" \| "footprint", libs: string[] }` | `{}` |
| `place` | `{ kind: "symbol" \| "footprint", lib: string, name: string }` | `{}` |

"none" means the request carries no `args`, or an empty object.

### project.open
- Every open starts from an empty project folder: the previous project's files are removed first.
- `files` holds at most 4096 entries and `name` at most 255 characters. Each `bytes` must be a `Uint8Array`; a bare `ArrayBuffer`, or any other value, answers `bad_args`.
- Paths are relative, POSIX, no `.` or `..` segments, no empty segment, no leading slash, no NUL, at most 255 bytes in UTF-8. A path the frame rejects, or one the file system refuses, is reported in `dropped` and never written.
- `open`, when given, names the file KiCad opens. It must end with the frame's own extension (`.kicad_sch` in a `sch` frame, `.kicad_pcb` in a `pcb` frame) or the request answers `bad_args`, so a later `project.save` can never write one kind of file into the other. It must be one of the written files, or the open answers `open_failed`.
- Without `open`, the frame opens the file of its own kind that shares the base name of a `.kicad_pro` in `files` (the project's root sheet or board), else the first file of its own kind, else answers `nothing_to_open`.
- `opened` is the normalised path KiCad opened.
- Before the load the frame writes KiCad's local display settings, `<stem>.kicad_prl` beside the file it opens (KiCad loads the project named after that file, settings included), with every display opacity at 1 (`board.opacity` zones, pads, tracks, vias, images and shapes), so the board draws as the site's viewer draws it: KiCad's own defaults draw zones and images at 0.6. A `.kicad_prl` of that path in `files` is kept as sent. The file is the engine's display state, not the design: no answer names it, and a save of it is never an `ev.saved` or listed in `saved`.
- `chrome` says whether any of KiCad's own window chrome (its menu bar, toolbars, status bar or infobar) is still visible when the open answers. While the chrome is meant hidden, the frame hides it again after the load and then watches it for about 1.5 s, hiding it each time KiCad shows it again, before answering; so the answer comes about 1.5 s after the load. `true` then means the engine would not hide it: a host that wants the chrome hidden sends `chrome.show { on: false }` again. After `chrome.show { on: true }`, `chrome` is simply whether it is visible. An older island answers without the field; a host treats it as unknown.
- A host never sends `project.open` over a live document: to show another project it reloads the frame (or removes it and makes a new one). If it does send one while the open document holds unsaved edits, KiCad raises its own "Save Changes?" dialog inside the frame; the open may answer before the dialog is closed, and `project.open` and `project.save` answer `busy` until the user closes it.

### project.import
Converts a board drawn in another EDA tool into a KiCad board through the engine's own importers, and makes it the frame's document.

- Accepted in a `pcb` frame only: a request that passes the checks below answers `unsupported` in a `sch` frame (the engine build has no schematic importer).
- `name` and `files` follow `project.open`'s rules: the same limits, the same `dropped`, and the project folder starts empty (the previous project's files are removed first). The display settings are staged as for `project.open`, as `<stem>.kicad_prl` beside the source. KiCad's importers leave pours unfilled; once the reader fills them (`B`, Fill All Zones), they draw opaque.
- `open` names the foreign board among `files`. It must end, in any case and after a non-empty name, with one of `.brd` (Eagle), `.cpa` (CADSTAR), `.json` (EasyEDA Std), `.zip` (EasyEDA Std or Pro), `.asc` (PADS ASCII), `.pcb` (P-CAD or gEDA; the engine tells them apart by content), `.txt` or `.fab` (Fabmaster), or the request answers `bad_args`. It must be one of the written files, or the import answers `open_failed`. `format`, when given, is a string of at most 64 characters: a hint the island may ignore (today it does; the engine picks the importer).
- The frame opens the file through the engine's own open and answers the importer's own dialogs: the layer mapping (Eagle, CADSTAR, PADS) gets Auto-Match Layers, then OK; the log report the engine shows after some imports gets OK. Any other dialog fails the import with `import_failed`, its `message` naming the dialog, and is closed without accepting anything it asks (its Cancel, No or Close, else a lone OK, else its close box; never Save or Discard). A file the engine refuses answers `import_failed` too. No dialog is left up when the import answers, unless one refused to close past the time limit (below).
- The converted board is then saved through the engine as `<stem>.kicad_pcb` beside the source (`boards/aht20.brd` becomes `boards/aht20.kicad_pcb`; a staged file of that name is replaced). It arrives as `ev.saved` before the answer, and `opened` names it. A save that writes nothing answers `import_failed`.
- `warnings` are the lines of the engine's log report: what its importer logged (its debug lines left out), each line once, in order, whitespace folded, at most 40 lines of at most 200 characters each; `[]` when it logged nothing. They are KiCad's own English sentences, as its report shows them.
- `chrome` is as for `project.open`: the hidden chrome is put back and watched after the import, so the answer comes about 1.5 s after the save.
- Then the frame fits the converted board itself: once the drawing's size (and the surface the engine draws into) has held for about 0.3 s, it presses Zoom to Fit (`Home`), and it answers once the board is painted (the view holds, and two small readbacks of the drawing in a row agree and show more than one color). A size that changes meanwhile starts the fit over. Past about 10 s it answers all the same, and the fit is made once the size holds (see `view.fit`). From the answer on, the fit holds as after a `view.fit`.
- The whole import, from the open to the save, is bounded by about 60 s. Past it, the frame cancels the load, closes every dialog (and any its cancelling raised), then answers `import_failed`; if a dialog is still up about 5 s later, the `message` ends "a dialog stayed up", and the host reloads the frame.
- While an import runs, the frame answers every request but `shutdown` at once with `busy`: `key.press`, `view.fit`, `layers.*`, `project.save` and the other document ops, a second `project.import` included. A `shutdown` ends the import; its answer is then never sent. A `project.import` sent while a load is parked, or while a dialog or a popup menu is up, answers `busy` and changes nothing.
- After a successful import the converted board is the frame's document exactly as after `project.open`: `project.save` writes `<stem>.kicad_pcb`, a Ctrl+S reaches the host as `ev.saved`, and `layers.*`, `view.fit` and `key.press` work on it. The board is fitted to the view when the answer comes, and stays fitted through the host's own layout (a frame resized after the answer) until the reader steers; a `view.fit` sent with the answer changes nothing and repaints nothing.
- The engine still counts the converted board as modified (a save to a path keeps its modified flag), so the host reloads the frame before another `project.open` or `project.import`. An import sent anyway meets KiCad's "Save Changes?" and answers `import_failed` naming it, the dialog cancelled. After a failed import the frame holds no document (`project.save` answers `not_ready`), as after `open_failed`; the host reloads the frame before it tries again.

### project.save
Saves the project through the engine's own Save and answers once every file it wrote has arrived as `ev.saved`; the answer is never sent before them.

- In a `sch` frame it is KiCad's Save, the same path as Ctrl+S in the editor: every sheet file of the hierarchy and the project file (`.kicad_pro`), whichever sheet the editor is showing and whichever sheets hold edits. The frame waits until every sheet file the engine's sheet tree names (and the root's `.kicad_pro`, when one was staged) has arrived, then a short pause with nothing more; without a sheet tree, until about 2 s pass with nothing more.
- In a `pcb` frame it is the board: the board file the frame opened.

`saved` lists the project-relative paths written, in the order they arrived, each once; `path` names the document the editor is showing (in a schematic, the file of the sheet on screen; the opened file when that sheet is outside the project), kept for hosts older than `saved`. Only bytes the engine itself wrote count: when it writes nothing (in a `sch` frame, no file within about 8 s), the request answers `save_failed` and, in a `pcb` frame, the file keeps its previous bytes. In a `sch` frame the save is a key press. A popup menu (a context menu, KiCad's clarify-selection menu) holds no edits, so the frame first closes it as a press of Escape does and then saves; it answers `busy`, and nothing is pressed, while a dialog is up (as for `key.press`) or a menu bar popup is open (it takes no Escape).

A host applies every `ev.saved` to its copy of the project, and resolves its save on the answer, never on the first `ev.saved`. An answer without `saved` comes from an older island: what it wrote is unknown, and only the answer says the save is over.

### project.forget
Drops the document: the project folder is emptied, and from then on the frame emits no `ev.saved` (a Ctrl+S in the document KiCad still shows is not reported) until the next successful `project.open`. The host reloads or removes the frame afterwards. The answer is `{}`; if emptying the folder fails it is `island_error`, and the document is dropped all the same.

### chrome.show and readonly
`chrome.show { on }` turns KiCad's own window chrome on or off (the engine's `kicadSetChrome`); `readonly { on }` turns read-only mode on or off (`kicadSetReadOnly`). Each answers `{}` only when the engine confirms the change, else `not_applied`.

The frame boots with KiCad's chrome hidden (`kicadSetChrome(false)`); `chrome.show { on: true }` brings it back for that boot only. Loading a file shows KiCad's menu bar again (and an infobar for a file from an older KiCad), so while the chrome is hidden each `project.open` that reached the load (`open_failed` included) hides it again and watches it before it answers; the successful answer's `chrome` says whether it stayed hidden.

### key.press
Fires one KiCad hotkey: the frame dispatches a `keydown` and then a `keyup` carrying `key`, `code` and the three modifiers on its window, where KiCad reads its hotkeys, and answers `{}`. KiCad's place keys are the exception when `ev.ready` listed `picker` (see `ev.pick`): a `key.press` of `a` (or `A`), and of `p` in a `sch` frame, with no modifier, while nothing of KiCad's own is over its canvas, presses nothing, emits `ev.pick` and answers `{}`. A key may zoom, pan or start a tool, so it ends a fit that was holding (see `view.fit`). Keyboard focus is put on the drawing once at boot, so the first key is not lost; the op itself never clicks. `code` is one of `KeyA` to `KeyZ`, `Digit0` to `Digit9`, `F1` to `F12`, `Escape`, `Home`, `Delete`, `Backspace`, `Enter` or `Space`; `key` is one character, or one of `F1` to `F12`, `Escape`, `Home`, `Delete`, `Backspace` or `Enter`; each modifier, when given, is a boolean (absent means not held). Anything else answers `bad_args`. While a popup menu (a context menu, KiCad's clarify-selection menu) or a dialog (any wx type whose name contains `Dialog`, except a progress dialog) is up, the key is refused with `busy` rather than landing in it. A progress dialog is a wx type whose name contains `Progress`, or a dialog that shows a gauge and no button but Cancel (or Skip), as KiCad's own progress reporter does; it takes no keys.

A real press anywhere in the frame (a pointer down, or a touch's pointer up) gives the frame the browser's keyboard focus when it does not have it, so the user's own keys reach KiCad and not the host page; this also blurs the host's window. The boot's own focus click never takes the browser's focus.

### view.fit
Fits the drawing to the view: the frame presses KiCad's Zoom to Fit hotkey (`Home`) exactly as `key.press { key: "Home", code: "Home" }` would, and answers `{}`. While a popup menu or a dialog is up (as for `key.press`) it answers `busy` and nothing is pressed.

The fit then holds. KiCad keeps its scale when the drawing is resized, so while it holds the frame watches the drawing's size and the surface the engine draws into (the largest GL canvas wx.js shows, or the root canvas the engine's software renderer draws into once its GL canvas is gone, as after a lost GPU process). Once either has changed and held for about 0.3 s, with no popup menu or dialog up, the frame presses `Home` again. A `view.fit` while the fit holds at the same size presses nothing (the view is already fitted; on a software GPU a repaint of a large board took seconds). The fit stops holding when the reader steers: a real wheel, pointer press or key in the frame, or any `key.press` from the host. `project.open`, `project.import` and `project.forget` end it too; a successful `project.import` starts it again with its own fit.

### sheet.tree and sheet.enter
`sheet.tree` answers the schematic's sheet hierarchy as the engine reports it. `current` is the path of the sheet the editor is showing. Each row of `sheets` carries the sheet's `path` (`/` for the root, then one lower case UUID and a slash per level), its `name`, its page number as a string (`page`), its `depth` below the root, the path of its `parent` (empty for the root) and the base name of its file (`file`, for example `io_banks.kicad_sch`; never a path, and empty when the engine gives none). A row the engine reports without a string `path` or `name` is left out. In a `pcb` frame the engine has no sheet tree and the request answers `unsupported`.

`sheet.enter { path }` shows the sheet at `path`. `path` must match `/` followed by zero or more `<uuid>/` segments, the UUIDs in lower case hexadecimal (`8-4-4-4-12` digits), or the request answers `bad_args`. The answer is `{}` when the engine accepts the path, else `not_applied` (an unknown sheet, or no answer within 30 s). The editor switches sheets shortly after the answer: a host that needs to see the change polls `sheet.tree` until `current` follows.

### layers.get, layers.visible and layers.active
`layers.get` answers the board's layers as the engine reports them: `active` is the id of the active layer, and each row of `layers` carries the layer's `id` (an integer `0` to `127`), its `name` as the board names it, its `canonical` KiCad name (for example `F.Cu`), its `color` as a CSS color string (empty when the engine gives none), whether it is `visible`, and whether it is a `copper` layer. A row without a valid `id`, a string `name` or a string `canonical` is left out. In a `sch` frame the engine has no layers and the request answers `unsupported`.

`layers.visible { id, visible }` shows or hides a layer, and `layers.active { id }` makes a layer the active one. `id` is an integer `0` to `127` and `visible` a boolean, or the request answers `bad_args`. Each answers `{}` when the engine confirms the change, else `not_applied` (a layer the board does not have, or no answer within 30 s). The engine applies the change shortly after it answers.

### lib.index, lib.item and lib.prefetch
The fast part picker's library reads (the host's picker, `PICKER.md`). They read KiCad's library mirror on the island origin (`LIBRARY.md`) and never ask the engine to enumerate a library. Either kind is read in either frame (a `sch` frame answers footprint reads too). Each is answered outside the request queue (above), a running `project.import` included, and before `ev.ready` answers `not_ready`.

- `kind` is `symbol` or `footprint`. `lib` is a library's nickname as a lib table names it (`Device`, `Package_QFP`), `name` an item's name; each is a string of 1 to 255 characters with no control character. `libs` is an array of at most 16 such nicknames. Anything else, or any other key, answers `bad_args`.
- `lib.index { kind }` answers the mirror's search index of that kind (`sym-index.json` or `fp-search.json`, `LIBRARY.md`) as its JSON text, the same bytes on every answer of a session; `text` is null when the island has no mirror (it booted on its example library) or the mirror has no index.
- `lib.item { kind, lib, name }` answers the item's body: for a symbol a self-contained `kicad_symbol_lib` holding the symbol and, for a derived one, its `extends` chain root first; for a footprint the `.kicad_mod` text. `body` is null when the library or the item is not there. The first read of a library fetches its bundle (a few hundred milliseconds cold; afterwards it is read from the browser's storage).
- `lib.prefetch { kind, libs }` answers `{}` at once and warms the named libraries' bundles in the background at low priority, each once; a nickname the mirror lacks is passed over, and without a mirror nothing is warmed.

### place
Puts a library item on the pointer, as KiCad's own chooser would after a pick: the item follows the pointer, KiCad's keys act on it (R rotates it), a press in the drawing commits it (one undo step, then an `ev.edited`) and Escape drops it. The answer `{}` comes once the item hangs off the pointer.

- The args are `lib.item`'s. The checks, in order: the args (`bad_args`); the frame's kind and the engine (`unsupported`: a symbol in a `pcb` frame, a footprint in a `sch` frame, or an engine without `kicadPlaceImportedItem` or `kicadCollabGetSelection`, which `message` names); an engine up with a document opened by `project.open` or `project.import` (`not_ready`); no load parked, no popup menu and no dialog up, as for `key.press` (`busy`, nothing changed); the item (`not_found`, `message` naming `lib:name`).
- The frame builds the editor's clipboard text from the body and hands it to the engine's `kicadPlaceImportedItem`. A symbol is placed as `lib:name` (its lib table's nickname, so it resolves against the project's libraries as a chooser pick does), its definition cached in the sheet's `lib_symbols` flattened (a derived symbol carries its parents' graphics and pins under its own name, its fields merged as KiCad's own flatten merges them) and its instance carrying the library's fields at their library positions; KiCad annotates it (`R1`, `#PWR01`). A footprint is placed as `lib:name` with its pads on no net.
- The answer waits until the editor holds the item (its selection names a new item): `busy` when the engine reports a load in flight or never takes the item within about 10 s (a placement of KiCad's own already under way), `island_error` when it refuses the text it was given.
- One item at a time: a `place` while the previous one still hangs off the pointer drops that one first, as Escape would. When the reader drops a schematic item with Escape (or Undo), the frame also leaves KiCad's placement tool, whose next press in the drawing would otherwise open KiCad's own chooser.
- Keyboard focus stays where it is: after the answer, the host gives the frame the focus (`iframe.focus()`) when the reader should be able to rotate the item before the press.
- A host uses `place` (and opens its picker on `ev.pick`) only when `ev.ready` `caps` lists `picker`. The pinned engine has had `kicadPlaceImportedItem` since PCBJam v0.2.3, so an older island lists that export too and answers `unknown_op`; `picker` is the island's own word. `place` still answers on the example library (it is not refused without the cap), but no `ev.pick` is sent there.

### shutdown
Releases the engine before the host removes the frame: the document is dropped (no `ev.saved` from here on, and the leave prompt stays quiet), every parked engine activation is unwound, the engine's threads are stopped, its WebGL contexts are released and its globals and window are cleared. The answer `{}` is the last message on the port: the frame then closes the port, answers nothing else (requests sent behind the shutdown included) and emits nothing, `ev.closing` included. The editor is not usable afterwards; the host removes the frame (or reloads it to start again). If the teardown fails the answer is `island_error`, and the port closes all the same. A shutdown sent before `ev.ready` stops the engine at its first park; the host still removes the frame. The host waits for the answer with a timeout (5 s, say) and removes the frame when it expires: in a background tab the browser may throttle the teardown's timers far past that, and the removal's `pagehide` covers the release.

Without the op, removing or navigating the frame runs a shorter teardown from `pagehide`: every parked engine activation is refused and unwinds before the document goes, and the rest (the threads, WebGL, the globals and the window) is left for the browser to release with the document.

### Error codes
`message` is a short explanation for logs, never for display. A host should accept any `code` string; these are the ones the frame answers today.

| code | when |
|---|---|
| `unknown_op` | `op` is not one of the eighteen above; `message` is the op. |
| `bad_args` | the request has a key other than `id`, `op` and `args`, or its args fail the checks above (an unknown key, a wrong type, too many files, a name too long, a non `Uint8Array` file, an `open` of the other kind, an import `open` the engine cannot import, args on an op that takes none). |
| `island_error` | the frame failed while handling the request (for example the file system refused to empty the project folder, `sheet.tree` or `layers.get` got no answer from the engine within 30 s, or the engine refused the text `place` gave it); `message` carries the failure. The next request is still handled. |
| `not_ready` | the engine has not booted yet (before `ev.ready`), or `project.save` or `place` with no successfully opened document. |
| `not_found` | `place`: the mirror has no such library, or the library no such item; `message` is `lib:name`. |
| `nothing_to_open` | `project.open` named no file and `files` holds none of the frame's kind. |
| `open_failed` | the file to open or import was not written (dropped, or absent from `files`), or KiCad's load did not settle within the frame's time limit, or an import's `<stem>.kicad_pcb` would be no valid path (over 255 bytes). |
| `import_failed` | `project.import`: the engine refused the file, a dialog other than the importer's own came up (`message` names it), the layer mapping was refused, the converted board's save wrote nothing, or the import passed its time limit; the dialogs were closed first. |
| `unsupported` | the engine build lacks the export the op needs, or the export answers nothing in this frame's kind (`sheet.tree` in a `pcb` frame, `layers.get` in a `sch` frame), or `project.import` in a `sch` frame, or `place` of a symbol in a `pcb` frame or a footprint in a `sch` frame; `message` names the export, or says why. |
| `not_applied` | `chrome.show`, `readonly`, `sheet.enter`, `layers.visible` or `layers.active`: the engine answered anything but success, or did not answer within 30 s. |
| `busy` | `project.open`, `project.import` or `project.save` while the engine is still loading a file, or `key.press`, `view.fit` or `project.import` while a popup menu or a dialog is up, or a schematic's `project.save` while a dialog or a menu bar popup is up, or any request but `shutdown` and the library reads while a `project.import` runs, or `place` while a load is parked, a popup menu or a dialog is up, or the editor does not take the item; nothing was changed, and the host may send the request again later. |
| `save_failed` | `project.save`: the engine wrote nothing (in a `sch` frame, no file arrived within about 8 s; in a `pcb` frame, also when the board save gave no answer within 30 s). |

## Events (frame to host): `{ type: string, ... }`
Each event carries exactly the keys listed here.

- `ev.state { phase: string, detail?: string }`; `phase` is one of `preflight`, `booting`, `staging`, `opening`, `blocked`, `fatal`, `popup`. `detail`, when present, is one of the island's own short strings, never engine or loader text:
  - `blocked`: the browser cannot run the engine; `detail` lists the failed capability codes, space separated (`no-sab`, `no-wasm`, `no-threads`, `no-webgl2`).
  - `fatal`: the engine stopped and the frame shows its fatal screen; `detail` is one of `memory` (out of memory), `crash` (the engine aborted), `boot_failed`, `engine_timeout` (no editor window within the boot time limit), `no_container`, `webgl_lost` (the browser lost the editor's WebGL context, for example on a GPU reset). The host reloads the frame to start again.
  - `popup` is informational: `ev.state { phase: "popup", detail: "<n> popup attempts blocked" }` may arrive at any time after `ev.ready`, once for every blocked popup attempt (`<n>` is the running count). It never changes the host's state. Attempts made before `ev.ready` are reported once, as a `booting` detail in the same words.
  - `booting`: while the engine's files load, `booting` repeats at most once every 2 s with `detail` the whole percent loaded, digits only (`0` to `100`), so a host that bounds the boot by inactivity sees it is still moving. Neither the first nor the 100 percent tick is promised.
  - `staging` and `opening` mark a `project.open` or a `project.import` in progress.
- `ev.ready { caps: string[], engine: { tag: string, kicad: string } }` once, after the engine booted and its editor window is up, and before any `project.open`: the host opens its project after this event. `caps` are the engine export names found on `Module`, sorted, and the pseudo-cap `picker` exactly when the fast part picker is live (`lib.index`, `lib.item`, `lib.prefetch`, `place` and `ev.pick`): the island's library mirror loaded and the engine has `kicadPlaceImportedItem` and `kicadCollabGetSelection`. On the example library (no mirror) `picker` is absent, the place keys stay KiCad's and no `ev.pick` is sent. A host gates its picker on `picker` (with `kicadPlaceImportedItem`), never on the export alone, which older islands list too. `engine.tag` is the PCBJam release tag the engine was built from; `engine.kicad` is the KiCad version string (for example `10.0`), not a commit.
- `ev.saved { path: string, bytes: Uint8Array }` after every save of a file in the project folder, whether the user pressed Ctrl+S or the host sent `project.save` (or `project.import`, for its converted board). One Ctrl+S, and one `project.save` in a schematic, emits several (each sheet file of a schematic and its `.kicad_pro`; a board's Ctrl+S, the `.kicad_pro` beside the board). A file saved outside the project folder (a Save As elsewhere) is not reported. None is emitted after `project.forget` until the next successful `project.open`.
- `ev.openTool { frame: "sch" | "pcb" }` when the editor's own Switch or Quit menu asks for the other frame; the frame does not navigate.
- `ev.help { topic: string }` when the editor asked to open a KiCad help page; `topic` is the last path segment of the KiCad docs URL, `[a-z0-9_-]{1,64}`.
- `ev.menu { open: boolean }` when something of KiCad's own is drawn over its canvas: `open: true` when a popup menu (a context menu, KiCad's clarify-selection menu) or any dialog (a wx type whose name contains `Dialog`, progress dialogs included: an import's dialogs report it too) shows while none was up, `open: false` when the last of them closes. A host hides what it draws over the frame while it is open, so the menu or dialog is not covered. A popup menu is reported at once, a dialog within about 100 ms. Nothing is sent while nothing is up, nor after `shutdown` was answered or the frame went away.
- `ev.edited { depth: number }` when the open document's undo depth changes. The frame reads KiCad's undo command count every 500 ms while a document is open (from a successful `project.open` or `project.import` until `project.forget` or the next open), no dialog is up (progress dialogs included), no load is parked and no request is in flight (from its arrival to its answer, the whole of a `project.import` included), and sends it when it differs from the last value read. `depth` is a whole number of at least 0: an edit raises it, an undo lowers it, a redo raises it again. A host reads any `ev.edited` as "the document changed" and never as a promise that unsaved changes exist: KiCad's undo list stops growing at its limit, and a save leaves it as it is. Each read is compared with the last one only, so an undo followed by a new edit inside one read interval leaves the depth unchanged and is not sent, as is an edit made once the list has stopped growing: a host keeps a periodic save as well. The first value read after an open or an import is the baseline and is not sent (opening a document is no edit); when the open answers while its load is still parked on a KiCad dialog (the file-version confirm on an older file), the baseline is the first value read once that load has settled, never one read while it was parked; a change made while a request was in flight is sent after that request's answer. An engine without the `kicadCollabTestUndoDepth` export (absent from `ev.ready` `caps`) sends none, and nothing is sent after `shutdown` was answered or the frame went away. Added in island `v0.2.3-cc6`.
- `ev.pick { kind: "symbol" | "footprint", power?: true }` when the reader pressed KiCad's place key inside the frame: `A` in a `sch` frame (`kind: "symbol"`), `P` in a `sch` frame (`kind: "symbol", power: true`), `A` in a `pcb` frame (`kind: "footprint"`). The key counts by the character it types, in either case, with no Ctrl, Alt, Shift or Meta held, only while nothing of KiCad's own is over its canvas (no popup menu, no dialog but a progress dialog, no other window of KiCad's such as its footprint chooser), no text field has the keyboard focus and no `project.import` runs, and only when `ev.ready` listed `picker` (without the mirror the keys are KiCad's, as before). The frame takes the key from KiCad (its keydown, keypress and keyup), so KiCad's chooser never opens, and sends one `ev.pick` per press (a held key's repeats send none); the host opens its own picker and places with `place`. A `key.press` of those keys from the host does the same. `power` is present only when true. KiCad's own choosers stay reachable through its menus (`chrome.show`). Added in island `v0.2.3-cc7`.
- `ev.closing {}` on `pagehide`, and when the user chooses File > Quit (the frame then shows its fatal screen and navigates nowhere). Sent at most once, and never after `shutdown` was answered.

Unknown fields are rejected by both sides. An unknown event `type` is ignored by the host; an unknown `op` is answered `unknown_op`.

## Leaving the frame
KiCad asks "Leave site?" when the frame unloads with unsaved edits. The frame keeps that prompt quiet when the host is about to reload it and nothing would be lost:
- for 10 s after a `project.save` that emitted `ev.saved`, or a successful `project.import` (the host has the bytes);
- from `project.forget` until the next successful `project.open`, whatever the forget answered (`island_error` included).

A Ctrl+S in the editor does not quiet it, and outside these windows a reload with unsaved edits still gets the prompt.

## island.json
Each island release serves `island.json` beside its page, and the island host serves the current one at `/island.json`:

| field | meaning |
|---|---|
| `id` | the islandId, `^[a-z0-9][a-z0-9.-]{0,63}$`; the release's path is `/r/<id>/` and its source is the release tagged `<id>` |
| `tag` | the PCBJam release tag the engine was built from (the same value as `ev.ready` `engine.tag`) |
| `kicadCommit` | the KiCad source commit the engine was built from (a full SHA), not a version string |
| `source` | the address of this release's source |

A host needs only `id`.

## Versioning
`proto` is the major. A host that sees a major it does not know ignores the hello. New ops, events, error codes and `island.json` fields are added within a major; removing or changing one bumps it. `ev.edited` (island `v0.2.3-cc6`) is such an addition: a host that does not know it ignores it, and a host facing an older island never receives it. So are `ev.pick`, `lib.index`, `lib.item`, `lib.prefetch`, `place` and `not_found`, with one change an older host does meet: the island takes KiCad's place keys (`A`, and `P` in a schematic) for `ev.pick`, which an older host ignores, so the reader's `A` does nothing there. The host that handles `ev.pick` ships before the island that sends it; it finds an older island by the absent `picker` cap and keeps pressing KiCad's keys for it.
