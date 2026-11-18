// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The local pair's ports for the e2e suite. CC_E2E_PORT names the page's port
// (default 4173); the island is on the next one, as src/cc-config.ts
// parentOriginFor expects. Two checkouts can run their suites side by side on
// different ports (CC_E2E_PORT=4183 npx playwright test). tests/serve.mjs reads
// the same variable with the same rule.
// The suite runs in Node (Playwright), but the tsconfig carries no Node types.
declare const process: { env: Record<string, string | undefined> };

function pagePort(): number {
  const raw = process.env.CC_E2E_PORT ?? '4173';
  const n = Number(raw);
  if (!/^[0-9]+$/.test(raw) || n < 1024 || n > 65534) throw new Error(`CC_E2E_PORT must be a port from 1024 to 65534, got '${raw}'`);
  return n;
}

export const PAGE_PORT = pagePort();
export const ISLAND_PORT = PAGE_PORT + 1;
export const PAGE = `http://localhost:${PAGE_PORT}`;
export const ISLAND = `http://editor.localhost:${ISLAND_PORT}`;
/** The island server by address: Node does not resolve *.localhost. */
export const ISLAND_ADDR = `http://127.0.0.1:${ISLAND_PORT}`;
