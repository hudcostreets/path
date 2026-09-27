import { defineConfig } from '@playwright/test'

// `PW_PORT` overrides, e.g. to avoid reusing another checkout's dev server.
const port = Number(process.env.PW_PORT ?? 8858)

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: {
    baseURL: `http://localhost:${port}`,
    headless: true,
  },
  webServer: {
    command: process.env.CI ? `pnpm preview --port ${port}` : `pnpm dev --port ${port}`,
    port,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
})
