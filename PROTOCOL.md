# cc-editor/1

MIT License. Copyright (c) 2026 Chirichella Inc.

The message protocol between a page (the host) and the editor island (the frame). The island is a cross-origin iframe. All messages are structured-clone objects. File contents travel as `Uint8Array` only, in both directions; the host may transfer the underlying buffer, and the frame always transfers a fresh copy.

The frame's kind is fixed by its URL: `?frame=sch` (the schematic editor, files `.kicad_sch`) or `?frame=pcb` (the board editor, files `.kicad_pcb`); anything else means `sch`. `?theme=night` starts it dark, anything else light.

## Handshake
1. The frame posts `{ type: "cc.hello", proto: 1, nonce: <random string>, island: <islandId> }` to `window.parent` with the host's exact origin as target. It does so before the engine boots.
2. The host answers `{ type: "cc.connect", nonce }` to the frame's window with one transferred `MessagePort`. The frame accepts only the first connect carrying its nonce, from `window.parent`, with no other keys. A reloaded frame posts a new hello with a new nonce.
3. Everything after runs on the port. Events the frame emitted before the connect are queued and sent, in order, once the port arrives.

## Requests (host to frame): `{ id: number, op: string, args?: object }`
Answers: `{ id, ok: true, result: object }` or `{ id, ok: false, error: { code: string, message: string } }`. Every request with a safe integer `id` and a string `op` is answered exactly once; anything else on the port is ignored. The frame handles requests one at a time, in the order they arrive: a request waits until the one before it has been answered.

| op | args | result |
|---|---|---|
| `project.open` | `{ name: string, files: [{ path: string, bytes: Uint8Array }], open?: string }` | `{ opened: string, dropped: string[] }` |
| `project.save` | none | `{ path: string }` |
| `project.forget` | none | `{}` |
| `chrome.show` | `{ on: boolean }` | `{}` |
| `readonly` | `{ on: boolean }` | `{}` |
| `shutdown` | none | `{}` |

"none" means the request carries no `args`, or an empty object.

### project.open
- Every open starts from an empty project folder: the previous project's files are removed first.
- `files` holds at most 4096 entries and `name` at most 255 characters. Each `bytes` must be a `Uint8Array`; a bare `ArrayBuffer`, or any other value, answers `bad_args`.
- Paths are relative, POSIX, no `.` or `..` segments, no empty segment, no leading slash, no NUL, at most 255 bytes in UTF-8. A path the frame rejects, or one the file system refuses, is reported in `dropped` and never written.
- `open`, when given, names the file KiCad opens. It must end with the frame's own extension (`.kicad_sch` in a `sch` frame, `.kicad_pcb` in a `pcb` frame) or the request answers `bad_args`, so a later `project.save` can never write one kind of file into the other. It must be one of the written files, or the open answers `open_failed`.
- Without `open`, the frame opens the file of its own kind that shares the base name of a `.kicad_pro` in `files` (the project's root sheet or board), else the first file of its own kind, else answers `nothing_to_open`.
- `opened` is the normalised path KiCad opened.
- A host never sends `project.open` over a live document: to show another project it reloads the frame (or removes it and makes a new one). If it does send one while the open document holds unsaved edits, KiCad raises its own "Save Changes?" dialog inside the frame; the open may answer before the dialog is closed, and `project.open` and `project.save` answer `busy` until the user closes it.

### project.save
Saves the open document through the engine and answers the project-relative path written; the bytes arrive first, as `ev.saved`. In a schematic, the sheet the editor is showing is saved to that sheet's own file. Only bytes the engine itself wrote count: when the engine writes nothing, the file keeps its previous bytes and the request answers `save_failed`.

### project.forget
Drops the document: the project folder is emptied, and from then on the frame emits no `ev.saved` (a Ctrl+S in the document KiCad still shows is not reported) until the next successful `project.open`. The host reloads or removes the frame afterwards. The answer is `{}`; if emptying the folder fails it is `island_error`, and the document is dropped all the same.

### chrome.show and readonly
`chrome.show { on }` turns KiCad's own window chrome on or off (the engine's `kicadSetChrome`); `readonly { on }` turns read-only mode on or off (`kicadSetReadOnly`). Each answers `{}` only when the engine confirms the change, else `not_applied`.

### shutdown
Releases the engine before the host removes the frame: the document is dropped (no `ev.saved` from here on, and the leave prompt stays quiet), every parked engine activation is unwound, the engine's threads are stopped, its WebGL contexts are released and its globals and window are cleared. The answer `{}` is the last message on the port: the frame then closes the port, answers nothing else (requests sent behind the shutdown included) and emits nothing, `ev.closing` included. The editor is not usable afterwards; the host removes the frame (or reloads it to start again). If the teardown fails the answer is `island_error`, and the port closes all the same. A shutdown sent before `ev.ready` stops the engine at its first park; the host still removes the frame. The host waits for the answer with a timeout (5 s, say) and removes the frame when it expires: in a background tab the browser may throttle the teardown's timers far past that, and the removal's `pagehide` covers the release.

Without the op, removing or navigating the frame runs a shorter teardown from `pagehide`: every parked engine activation is refused and unwinds before the document goes, and the rest (the threads, WebGL, the globals and the window) is left for the browser to release with the document.

### Error codes
`message` is a short explanation for logs, never for display. A host should accept any `code` string; these are the ones the frame answers today.

| code | when |
|---|---|
| `unknown_op` | `op` is not one of the six above; `message` is the op. |
| `bad_args` | the request has a key other than `id`, `op` and `args`, or its args fail the checks above (an unknown key, a wrong type, too many files, a name too long, a non `Uint8Array` file, an `open` of the other kind, args on an op that takes none). |
| `island_error` | the frame failed while handling the request (for example the file system refused to empty the project folder); `message` carries the failure. The next request is still handled. |
| `not_ready` | the engine has not booted yet (before `ev.ready`), or `project.save` with no successfully opened document. |
| `nothing_to_open` | `project.open` named no file and `files` holds none of the frame's kind. |
| `open_failed` | the file to open was not written (dropped, or absent from `files`), or KiCad's load did not settle within the frame's time limit. |
| `unsupported` | the engine build lacks the export the op needs; `message` names it. |
| `not_applied` | `chrome.show` or `readonly`: the engine answered anything but success, or did not answer within 30 s. |
| `busy` | `project.open` or `project.save` while the engine is still loading a file; nothing was changed, and the host may send the request again later. |
| `save_failed` | `project.save`: the engine wrote nothing, or the sheet the editor is showing lies outside the project folder. |

## Events (frame to host): `{ type: string, ... }`
Each event carries exactly the keys listed here.

- `ev.state { phase: string, detail?: string }`; `phase` is one of `preflight`, `booting`, `staging`, `opening`, `blocked`, `fatal`, `popup`. `detail`, when present, is one of the island's own short strings, never engine or loader text:
  - `blocked`: the browser cannot run the engine; `detail` lists the failed capability codes, space separated (`no-sab`, `no-wasm`, `no-threads`, `no-webgl2`).
  - `fatal`: the engine stopped and the frame shows its fatal screen; `detail` is one of `memory` (out of memory), `crash` (the engine aborted), `boot_failed`, `engine_timeout` (no editor window within the boot time limit), `no_container`, `webgl_lost` (the browser lost the editor's WebGL context, for example on a GPU reset). The host reloads the frame to start again.
  - `popup` is informational: `ev.state { phase: "popup", detail: "<n> popup attempts blocked" }` may arrive at any time after `ev.ready`, once for every blocked popup attempt (`<n>` is the running count). It never changes the host's state. Attempts made before `ev.ready` are reported once, as a `booting` detail in the same words.
  - `staging` and `opening` mark a `project.open` in progress.
- `ev.ready { caps: string[], engine: { tag: string, kicad: string } }` once, after the engine booted and its editor window is up, and before any `project.open`: the host opens its project after this event. `caps` are the engine export names found on `Module`. `engine.tag` is the PCBJam release tag the engine was built from; `engine.kicad` is the KiCad version string (for example `10.0`), not a commit.
- `ev.saved { path: string, bytes: Uint8Array }` after every save of a file in the project folder, whether the user pressed Ctrl+S or the host sent `project.save`. One Ctrl+S may emit several (each sheet file of a schematic, the `.kicad_pro` beside a board). A file saved outside the project folder (a Save As elsewhere) is not reported. None is emitted after `project.forget` until the next successful `project.open`.
- `ev.openTool { frame: "sch" | "pcb" }` when the editor's own Switch or Quit menu asks for the other frame; the frame does not navigate.
- `ev.help { topic: string }` when the editor asked to open a KiCad help page; `topic` is the last path segment of the KiCad docs URL, `[a-z0-9_-]{1,64}`.
- `ev.closing {}` on `pagehide`, and when the user chooses File > Quit (the frame then shows its fatal screen and navigates nowhere). Sent at most once, and never after `shutdown` was answered.

Unknown fields are rejected by both sides. An unknown event `type` is ignored by the host; an unknown `op` is answered `unknown_op`.

## Leaving the frame
KiCad asks "Leave site?" when the frame unloads with unsaved edits. The frame keeps that prompt quiet when the host is about to reload it and nothing would be lost:
- for 10 s after a `project.save` that emitted `ev.saved` (the host has the bytes);
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
`proto` is the major. A host that sees a major it does not know ignores the hello. New ops, events, error codes and `island.json` fields are added within a major; removing or changing one bumps it.
