// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
const pin = JSON.parse(readFileSync(new URL('./PIN.json', import.meta.url), 'utf8'));
export default defineConfig({
  base: `/r/${pin.islandId}/`,
  define: {
    __TOOL_TAG__: JSON.stringify(pin.engine.toolTag),
    __ISLAND_ID__: JSON.stringify(pin.islandId),
  },
  build: { outDir: `dist/r/${pin.islandId}`, emptyOutDir: false, target: 'es2022', sourcemap: false },
  test: { environment: 'node', include: ['src/**/*.test.ts', 'bridge/**/*.test.ts'] },
});
