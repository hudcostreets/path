import { test, expect, Page } from '@playwright/test'

/**
 * The date-range picker (`?ym=YY-MM,YY-MM`) is shared page state consumed by
 * `StationsMap` (pie-map) and `EntriesVsExitsBars` — both render two
 * `YmInput` inputs (`placeholder="YY-MM"`, monospace, plain `<input>`),
 * so 4 total on the home page.
 *
 * DOM order:
 *   inputs[0], inputs[1]  — pie-map from/to
 *   inputs[2], inputs[3]  — EvE bars from/to
 */

async function ymInputValues(page: Page): Promise<string[]> {
  return await page.locator('input[placeholder="YY-MM"]').evaluateAll(
    els => els.map(e => (e as HTMLInputElement).value)
  )
}

async function eveBarsStations(page: Page): Promise<string[]> {
  return await page.locator('xpath=(//span[@id="eve-bars"]/ancestor::div[contains(@class, "plot-container")])[1]')
    .evaluate(el => {
      const plot = el.querySelector('.js-plotly-plot') as any
      return plot?._fullData?.[0]?.x ?? []
    })
}

test.describe('shared ?ym= URL state', () => {
  test('/?ym=20-01,22-06 → all 4 YmInputs read 20-01 / 22-06', async ({ page }) => {
    await page.goto('/?ym=20-01,22-06')
    // 4 inputs (2 pie-map + 2 EvE) — wait for the mount.
    await expect(page.locator('input[placeholder="YY-MM"]')).toHaveCount(4, { timeout: 15_000 })
    const values = await ymInputValues(page)
    expect(values).toEqual(['20-01', '22-06', '20-01', '22-06'])
    // EvE bars renders 13 stations regardless of range (empty date range still
    // gets a row per station).
    await expect(async () => {
      const stations = await eveBarsStations(page)
      expect(stations.length).toBe(13)
    }).toPass({ timeout: 15_000 })
  })

  test('editing EvE bars from-picker writes URL and syncs pie-map input', async ({ page }) => {
    await page.goto('/?ym=20-01,22-06')
    await expect(page.locator('input[placeholder="YY-MM"]')).toHaveCount(4, { timeout: 15_000 })
    // EvE from-input is inputs[2].
    const eveFrom = page.locator('input[placeholder="YY-MM"]').nth(2)
    await eveFrom.fill('21-03')
    await eveFrom.blur()
    // useUrlState commits synchronously on blur → URL should reflect the new
    // range on the next tick.
    await expect(async () => {
      const url = new URL(page.url())
      expect(url.searchParams.get('ym')).toBe('21-03,22-06')
    }).toPass({ timeout: 5_000 })
    const values = await ymInputValues(page)
    // Pie-map from-input (inputs[0]) mirrors the change.
    expect(values[0]).toBe('21-03')
    expect(values[2]).toBe('21-03')
    // to-inputs unchanged.
    expect(values[1]).toBe('22-06')
    expect(values[3]).toBe('22-06')
  })

  test('bad-YM edit falls back to previous value (no URL update)', async ({ page }) => {
    await page.goto('/?ym=20-01,22-06')
    await expect(page.locator('input[placeholder="YY-MM"]')).toHaveCount(4, { timeout: 15_000 })
    const eveFrom = page.locator('input[placeholder="YY-MM"]').nth(2)
    await eveFrom.fill('99-13')
    await eveFrom.blur()
    await page.waitForTimeout(300)
    const url = new URL(page.url())
    // Rejected: URL still shows the original range.
    expect(url.searchParams.get('ym')).toBe('20-01,22-06')
    const values = await ymInputValues(page)
    expect(values[2]).toBe('20-01')
  })
})
