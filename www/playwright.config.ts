import { defineConfig } from '@playwright/test'

// `PW_PORT` lets a worktree run e2e against its own dev server instead of
// (re)using whatever is listening on the default port.
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
