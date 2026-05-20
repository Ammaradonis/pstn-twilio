import { defineConfig, devices } from '@playwright/test';

/**
 * The Phase 10 E2E suite hits a real Vite preview server but mocks every API
 * response with `page.route(...)` so the suite is hermetic — no Twilio, no
 * Postgres, no Redis required. CI runs `pnpm --filter @pstn-twilio/web build`
 * once and starts the preview via `webServer` below.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'html',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:4173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'pnpm preview',
        port: 4173,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
