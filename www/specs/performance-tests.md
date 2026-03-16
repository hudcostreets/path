# Performance e2e tests with budgets

## Context

We want to measure and enforce:
- Time to first plot render
- Total network transfer size
- Number of network requests
- Bundle JS/CSS sizes

These should be committed as expected values and verified in CI, so regressions are caught and size increases must be intentional.

## Requirements

### 1. Performance test file

Create `e2e/performance.spec.ts` with tests that measure:

#### Page load timing
```ts
test('PATH page renders plot within budget', async ({ page }) => {
  const start = Date.now()
  await page.goto('/')
  await page.waitForSelector('.js-plotly-plot .legend', { timeout: 15_000 })
  const loadTime = Date.now() - start
  console.log(`Plot render time: ${loadTime}ms`)
  expect(loadTime).toBeLessThan(5000) // 5s budget (generous for CI)
})
```

#### Transfer size
```ts
test('PATH page total transfer < budget', async ({ page }) => {
  let totalBytes = 0
  page.on('response', response => {
    const size = parseInt(response.headers()['content-length'] ?? '0')
    totalBytes += size
  })
  await page.goto('/')
  await page.waitForSelector('.js-plotly-plot .legend', { timeout: 15_000 })
  console.log(`Total transfer: ${(totalBytes / 1024).toFixed(0)}KB`)
  expect(totalBytes).toBeLessThan(3 * 1024 * 1024) // 3MB budget
})
```

#### Request count
```ts
test('PATH page request count < budget', async ({ page }) => {
  let requestCount = 0
  page.on('request', () => requestCount++)
  await page.goto('/')
  await page.waitForSelector('.js-plotly-plot .legend', { timeout: 15_000 })
  console.log(`Request count: ${requestCount}`)
  expect(requestCount).toBeLessThan(30)
})
```

### 2. Bundle size check (build-time)

Add a build step or script that checks `dist/assets/*.js` sizes:

```ts
// e2e/bundle-size.spec.ts
import { test, expect } from '@playwright/test'
import { readdirSync, statSync } from 'fs'
import { join } from 'path'

test('JS bundle size within budget', () => {
  const assetsDir = join(__dirname, '../dist/assets')
  const jsFiles = readdirSync(assetsDir).filter(f => f.endsWith('.js'))
  const totalSize = jsFiles.reduce((sum, f) => sum + statSync(join(assetsDir, f)).size, 0)
  console.log(`Total JS: ${(totalSize / 1024).toFixed(0)}KB`)
  // After hyparquet migration, expect < 1.5MB
  // Before: ~5.7MB
  expect(totalSize).toBeLessThan(6 * 1024 * 1024)
})
```

### 3. Budget file

Create `e2e/budgets.json` with committed expected values:
```json
{
  "js_bundle_kb": 5700,
  "css_bundle_kb": 32,
  "page_load_ms": 5000,
  "transfer_kb": 3000,
  "request_count": 30
}
```

Tests read from this file. When we migrate to hyparquet, we update the budgets and the diff shows the improvement.

### 4. CI integration

These tests run as part of the existing Playwright e2e suite. The `pnpm preview` server serves the prod build, so sizes reflect production.

## Implementation Notes

- Use `page.on('response')` for transfer size (captures gzipped size from network)
- Use `fs` for bundle size (captures uncompressed disk size)
- Budgets should be generous initially (don't want flaky CI), tighten after hyparquet migration
- Print measurements to stdout so CI logs show the numbers even when passing

## Acceptance Criteria

1. Performance tests exist and pass in CI
2. Budget values committed to repo
3. CI fails if bundle/transfer/timing exceeds budget
4. Measurements printed to CI log for visibility
