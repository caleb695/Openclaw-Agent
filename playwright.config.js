import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/browser',
  timeout: 30000,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    headless: true,
    launchOptions: process.env.CHROMIUM_PATH
      ? {
          executablePath: process.env.CHROMIUM_PATH,
          args: ['--no-sandbox', '--disable-dev-shm-usage'],
        }
      : {},
  },
  webServer: [
    {
      command: 'npx vite preview --host 0.0.0.0 --port 4173',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'node tests/fixtures/companion.mjs',
      url: 'http://127.0.0.1:4180/bridge',
      reuseExistingServer: !process.env.CI,
    },
  ],
});
