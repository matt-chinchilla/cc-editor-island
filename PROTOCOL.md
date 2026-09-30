# cc-editor/1

MIT License. Copyright (c) 2026 Chirichella Inc.

The message protocol between a page (the host) and the editor island (the frame). The island is a cross-origin iframe. All messages are structured-clone objects; files travel as transferred ArrayBuffers or Uint8Arrays.

## Handshake
1. The frame posts `{ type: "cc.hello", proto: 1, nonce: <random string>, island: <islandId> }` to `window.parent` with the host's exact origin as target.
2. The host answers `{ type: "cc.connect", nonce }` to the frame's window with one transferred `MessagePort`. The frame accepts only the first connect carrying its nonce, from `window.parent`.
3. Everything after runs on the port.

## Requests (host to frame): `{ id: number, op: string, args?: object }`
Answers: `{ id, ok: true, result?: any }` or `{ id, ok: false, error: { code: string, message: string } }`.

| op | args | result |
|---|---|---|
| `project.open` | `{ name: string, files: [{ path: string, bytes: Uint8Array }], open?: string }` | `{ opened: string, dropped: string[] }` |
| `project.save` | none | `{ path: string }` |
| `project.forget` | none | `{}` |
| `chrome.show` | `{ on: boolean }` | `{}` |
| `readonly` | `{ on: boolean }` | `{}` |

Paths are relative, POSIX, no `.` or `..` segments, no leading slash, no NUL, at most 255 bytes; a rejected path is reported in `dropped`, never written.

## Events (frame to host): `{ type: string, ... }`
- `ev.state { phase: string, detail?: string }` during boot; `phase` is one of `preflight`, `booting`, `staging`, `opening`, `blocked`, `fatal`, `popup`. `detail`, when present, is one of the island's own short strings (a capability code, `memory`, a popup count), never engine or loader text.
  - `popup` is informational: `ev.state { phase: "popup", detail: "<n> popup attempts blocked" }` may arrive at any time, including after `ev.ready`, once for every blocked popup attempt (`<n>` is the running count). It never changes the host's state. Attempts made before `ev.ready` are reported once, as a `booting` detail in the same words.
- `ev.ready { caps: string[], engine: { tag: string, kicad: string } }` once the engine booted and the first open settled. `caps` are the engine export names found on `Module`.
- `ev.saved { path: string, bytes: Uint8Array }` after every save, whether the user pressed Ctrl+S or the host sent `project.save`.
- `ev.openTool { frame: "sch" | "pcb" }` when the editor's own Switch or Quit menu asks for the other frame; the frame does not navigate.
- `ev.help { topic: string }` when the editor asked to open a KiCad help page; `topic` is the last path segment of the KiCad docs URL, `[a-z0-9_-]{1,64}`.
- `ev.closing {}` on `pagehide`.

Unknown fields are rejected by both sides; an unknown `type` or `op` is ignored (`op`: answered `{ ok: false, error: { code: "unknown_op" } }`).

## Versioning
`proto` is the major. A host that sees a major it does not know ignores the hello. New ops and events are added within a major; removing or changing one bumps it.
