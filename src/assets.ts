// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
declare const __TOOL_TAG__: string;   // define'd by vite.config.ts from PIN.json
export function engineBase(): string {
  return `${import.meta.env.BASE_URL}wasm/kicad_editor/${__TOOL_TAG__}/`;
}
