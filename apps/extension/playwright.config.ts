import { defineConfig } from '@playwright/test'

/** The extension's e2e (plan B12): Chromium with the unpacked e2e build, against a stub Yoda. */
export default defineConfig({
  testDir: 'e2e',
  testMatch: /.*\.spec\.ts/,
  timeout: 120_000,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'retain-on-failure' },
})
