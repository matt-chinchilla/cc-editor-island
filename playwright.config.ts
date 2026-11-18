// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// The local pair (tests/serve.mjs) with the real headers, driven on Chromium
// and Firefox. The first boot of each test fetches about 22 MB and compiles
// the engine, so the timeout is generous and the tests run one at a time.
import { defineConfig, devices } from '@playwright/test';
import { PAGE, PAGE_PORT } from './tests/e2e/ports';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 180_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  webServer: { command: 'node tests/serve.mjs', port: PAGE_PORT, reuseExistingServer: false },
  use: { baseURL: PAGE, trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1320, height: 900 } } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'], viewport: { width: 1320, height: 900 } } },
  ],
});
