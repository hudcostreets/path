import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:8858',
    headless: true,
  },
  webServer: {
    command: process.env.CI ? 'pnpm preview --port 8858' : 'pnpm dev --port 8858',
    port: 8858,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
})
