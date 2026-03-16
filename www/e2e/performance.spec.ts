import { test, expect } from '@playwright/test'
import { readdirSync, statSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const budgets = JSON.parse(readFileSync(join(__dirname, 'budgets.json'), 'utf-8'))

// ─── Bundle size (build artifact check) ───

test.describe('Bundle size budgets', () => {
  const assetsDir = join(__dirname, '../dist/assets')

  test('JS bundle size', () => {
    let totalSize = 0
    try {
      const jsFiles = readdirSync(assetsDir).filter(f => f.endsWith('.js'))
      totalSize = jsFiles.reduce((sum, f) => sum + statSync(join(assetsDir, f)).size, 0)
    } catch {
      test.skip(true, 'dist/ not built — run `pnpm build` first')
      return
    }
    const kb = Math.round(totalSize / 1024)
    console.log(`  JS bundle: ${kb}KB (budget: ${budgets.js_bundle_kb}KB)`)
    expect(kb).toBeLessThan(budgets.js_bundle_kb)
  })

  test('CSS bundle size', () => {
    let totalSize = 0
    try {
      const cssFiles = readdirSync(assetsDir).filter(f => f.endsWith('.css'))
      totalSize = cssFiles.reduce((sum, f) => sum + statSync(join(assetsDir, f)).size, 0)
    } catch {
      test.skip(true, 'dist/ not built')
      return
    }
    const kb = Math.round(totalSize / 1024)
    console.log(`  CSS bundle: ${kb}KB (budget: ${budgets.css_bundle_kb}KB)`)
    expect(kb).toBeLessThan(budgets.css_bundle_kb)
  })
})

// ─── Page load performance ───

test.describe('Page load performance', () => {
  test('PATH page renders plot within budget', async ({ page }) => {
    const start = Date.now()
    await page.goto('/')
    await page.waitForSelector('.plot-container .js-plotly-plot .legend .traces', { timeout: 20_000 })
    const elapsed = Date.now() - start
    console.log(`  PATH plot render: ${elapsed}ms (budget: ${budgets.path_load_ms}ms)`)
    expect(elapsed).toBeLessThan(budgets.path_load_ms)
  })

  test('BT page renders plot within budget', async ({ page }) => {
    const start = Date.now()
    await page.goto('/bt')
    try {
      await page.waitForSelector('.plot-container .js-plotly-plot .legend .traces', { timeout: 15_000 })
    } catch {
      // BT data may not be available in preview mode (DVC URLs not resolved)
      test.skip(true, 'BT data not available (likely preview mode without DVC resolution)')
      return
    }
    const elapsed = Date.now() - start
    console.log(`  BT plot render: ${elapsed}ms (budget: ${budgets.bt_load_ms}ms)`)
    expect(elapsed).toBeLessThan(budgets.bt_load_ms)
  })
})

// ─── Network transfer ───

test.describe('Network budgets', () => {
  test('PATH page transfer size and request count', async ({ page }) => {
    let totalBytes = 0
    let requestCount = 0
    page.on('response', async response => {
      try {
        const body = await response.body()
        totalBytes += body.length
      } catch {
        // Some responses (e.g. redirects) may not have a body
      }
    })
    page.on('request', () => requestCount++)

    await page.goto('/')
    await page.waitForSelector('.plot-container .js-plotly-plot .legend .traces', { timeout: 20_000 })
    // Wait a bit for any lazy-loaded resources
    await page.waitForTimeout(2000)

    const kb = Math.round(totalBytes / 1024)
    console.log(`  Transfer: ${kb}KB (budget: ${budgets.transfer_kb}KB)`)
    console.log(`  Requests: ${requestCount} (budget: ${budgets.request_count})`)
    expect(kb).toBeLessThan(budgets.transfer_kb)
    expect(requestCount).toBeLessThan(budgets.request_count)
  })
})
