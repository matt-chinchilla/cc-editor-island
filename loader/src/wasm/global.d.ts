export {};
// Modified by Circuit Center on 2026-09-30: EmscriptenFS declares readdir, stat,
// isDir and rmdir (Emscripten's FS has them; the responder removes the
// project folder with them).
// Modified by Circuit Center on 2026-10-15: KicadImportExports declares the
// engine exports project.import calls, kicadImportSchematic among them.

declare global {
  interface EmscriptenFS {
    mkdirTree(path: string): void;
    writeFile(path: string, data: Uint8Array | string): void;
    readFile(path: string, opts?: { encoding?: "binary" | "utf8" }): unknown;
    analyzePath(path: string): { exists: boolean };
    unlink(path: string): void;
    readdir(path: string): string[];
    stat(path: string): { mode: number };
    isDir(mode: number): boolean;
    rmdir(path: string): void;
  }

  // Loose shape of the wxWidgets-WASM element registry exposed by wx.js.
  interface WxElementInfo {
    id: string;
    typeName: string;
    name: string;
    label: string;
    visible: boolean;
    enabled: boolean;
    screenX: number;
    screenY: number;
    centerX: number;
    centerY: number;
    width: number;
    height: number;
  }

  interface WxElementRegistry {
    findAll(filter?: {
      visible?: boolean;
      enabled?: boolean;
      type?: string;
      label?: string;
      name?: string;
    }): WxElementInfo[];
    findByLabel(label: string, options?: Record<string, unknown>): WxElementInfo[];
    findRenderedByLabel?(
      label: string,
      options?: Record<string, unknown>,
    ): WxElementInfo[];
  }

  /**
   * The engine exports project.import calls (bridge/import.ts), declared where
   * the bridge reads them; Module itself stays `any`. kicadImportSchematic is
   * our engine build's (island v0.2.3-cc8): KiCad's File > Import of a
   * non-KiCad schematic, or of an Altium project when `path` is "" and
   * `propsJson` names project_file and sch0, sch1, ...; it parks like
   * kicadOpenFile (kicadOpenFileBusy covers both) and resolves true only when
   * a converted sheet holds items.
   */
  interface KicadImportExports {
    kicadOpenFile?: (path: string) => unknown;
    kicadOpenFileBusy?: () => boolean;
    kicadSaveBoard?: (path: string) => unknown;
    kicadImportSchematic?: (path: string, typeName: string, propsJson: string) => unknown;
  }

  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Module?: any;
    FS?: EmscriptenFS;
    wxElementRegistry?: WxElementRegistry;
    kicadWebOpenTool?: (toolName: string, fileName: string) => boolean;
    /** wx wasm port → page: the app's main frame was destroyed (File→Quit). */
    wxAppTopWindowClosed?: () => void;
    /** File System Access API (Chromium): writable local-folder sessions. */
    showDirectoryPicker?(options?: {
      mode?: "read" | "readwrite";
      id?: string;
    }): Promise<FileSystemDirectoryHandle>;
  }

  // The browsing-context window the tool runs in — now the top-level `window`
  // (the WASM boots in-document, not in an iframe). The Window interface PLUS the
  // global declarations (console, PointerEvent, document, …) that live on
  // `typeof globalThis`, not on the bare Window interface.
  type ToolWindow = Window & typeof globalThis;
}
