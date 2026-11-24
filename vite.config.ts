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
    __ISLAND_TAG__: JSON.stringify(pin.pcbjam.tag),
    __ENGINE_PCBJAM__: JSON.stringify(pin.engine.build?.pcbjam ?? ''),   // the engine build theme.set reads which frames take its switch from (bridge/ext/theme-i.ts)
    __KICAD_VERSION__: JSON.stringify('10.0'),   // KICAD_VERSION_DIR; refined from the engine's About string in stage 2
    __LIBS_TAG__: JSON.stringify(pin.libs.tag),  // the library mirror's tag (LIBRARY.md): /libs/<tag>/
    // The simulator service's raw wasm size, 0 when PIN.json lists no service (then the island serves none).
    __SIM_WASM_BYTES__: JSON.stringify(pin.engine.files?.['ngspice_service.wasm']?.bytes ?? 0),
    // The 3D service's raw wasm size (src/occ-service.ts, wave unit 3d-i1), 0 when PIN.json lists no service.
    __OCC_WASM_BYTES__: JSON.stringify(pin.engine.files?.['occ_service.wasm']?.bytes ?? 0),
  },
  build: { outDir: `dist/r/${pin.islandId}`, emptyOutDir: false, target: 'es2022', sourcemap: false },
  // Every unit test of the checkout runs here (bridge/ext/seam.test.ts checks it), but
  // scripts/ext/join.test.ts, which runs alone under vitest.join.config.ts at the join.
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'bridge/**/*.test.ts', 'theme/**/*.test.ts', 'loader/**/*.test.ts', 'scripts/*.test.ts'],
  },
});
