import { test, expect, Page } from '@playwright/test'

/**
 * The date-range picker (`?ym=YY-MM,YY-MM`) is shared page state consumed by
 * `StationsMap` (pie-map) and `EntriesVsExitsBars`. On `/`, only EvE bars
 * renders its own picker (pie-map suppresses its footer YM inputs when
 * `embedded` to avoid a duplicate row) — so the home page exposes exactly
 * 2 `YmInput`s (`placeholder="YY-MM"`), from/to.
 *
 * DOM order:
 *   inputs[0], inputs[1]  — EvE bars from/to
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
  test('/?ym=20-01,22-06 → both YmInputs read 20-01 / 22-06', async ({ page }) => {
    await page.goto('/?ym=20-01,22-06')
    // 2 inputs (EvE bars from/to) — wait for the mount.
    await expect(page.locator('input[placeholder="YY-MM"]')).toHaveCount(2, { timeout: 15_000 })
    const values = await ymInputValues(page)
    expect(values).toEqual(['20-01', '22-06'])
    // EvE bars renders 13 stations regardless of range (empty date range still
    // gets a row per station).
    await expect(async () => {
      const stations = await eveBarsStations(page)
      expect(stations.length).toBe(13)
    }).toPass({ timeout: 15_000 })
  })

  test('editing EvE bars from-picker writes URL', async ({ page }) => {
    await page.goto('/?ym=20-01,22-06')
    await expect(page.locator('input[placeholder="YY-MM"]')).toHaveCount(2, { timeout: 15_000 })
    const eveFrom = page.locator('input[placeholder="YY-MM"]').nth(0)
    await eveFrom.fill('21-03')
    await eveFrom.blur()
    // useUrlState commits synchronously on blur → URL should reflect the new
    // range on the next tick.
    await expect(async () => {
      const url = new URL(page.url())
      expect(url.searchParams.get('ym')).toBe('21-03,22-06')
    }).toPass({ timeout: 5_000 })
    const values = await ymInputValues(page)
    // Both inputs read the new range.
    expect(values).toEqual(['21-03', '22-06'])
  })

  test('bad-YM edit falls back to previous value (no URL update)', async ({ page }) => {
    await page.goto('/?ym=20-01,22-06')
    await expect(page.locator('input[placeholder="YY-MM"]')).toHaveCount(2, { timeout: 15_000 })
    const eveFrom = page.locator('input[placeholder="YY-MM"]').nth(0)
    await eveFrom.fill('99-13')
    await eveFrom.blur()
    await page.waitForTimeout(300)
    const url = new URL(page.url())
    // Rejected: URL still shows the original range.
    expect(url.searchParams.get('ym')).toBe('20-01,22-06')
    const values = await ymInputValues(page)
    expect(values[0]).toBe('20-01')
  })
})
