import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
const pin = JSON.parse(readFileSync(new URL('./PIN.json', import.meta.url), 'utf8'));
export default defineConfig({
  base: `/r/${pin.islandId}/`,
  build: { outDir: `dist/r/${pin.islandId}`, emptyOutDir: false, target: 'es2022', sourcemap: false },
  test: { environment: 'node', include: ['src/**/*.test.ts', 'bridge/**/*.test.ts'] },
});
