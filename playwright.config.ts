import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against demo mode with fixtures and a fixed demo clock,
 * in their own data directory and build directory. Tests share one database
 * and change it (watchlist, rules), so they run serially.
 */
const PORT = 3100;
const env = { FINN_DATA_MODE: 'fixture', FINN_DATA_DIR: '.e2e-data', FINN_NEXT_DIST_DIR: '.next-e2e' };

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }, testIgnore: /mobile\.spec/ },
    { name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 375, height: 812 } }, testMatch: /mobile\.spec/ },
  ],
  webServer: {
    // A production build: what a reviewer would run, without the dev overlay.
    command: `node e2e/seed.mjs && npx next build && npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/watchlist`,
    timeout: 420_000,
    reuseExistingServer: false,
    env,
  },
});
