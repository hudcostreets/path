import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // `e2e/*.spec.ts` is Playwright's; vitest would pick them up otherwise.
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
  },
})
