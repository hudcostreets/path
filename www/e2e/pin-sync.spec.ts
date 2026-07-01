import { test, expect, Page, Locator } from '@playwright/test'

/** Station-pin state is owned by `PathPlots` and threaded to each plot:
 *  RidesPlot/HourlyPlot via `soloStation`, MonthlyPlots via filtered station
 *  list, EntriesVsExitsBars via filtered station list. Click a legend entry on
 *  any participating plot → the rest of the page narrows to that station. */

function plotById(page: Page, id: string): Locator {
  return page.locator(`xpath=(//span[@id='${id}']/ancestor::div[contains(@class, 'plot-container')])[1]`)
}

async function clickLegendByText(page: Page, plotId: string, name: string) {
  const traces = plotById(page, plotId).locator('.legend .traces')
  const count = await traces.count()
  for (let i = 0; i < count; i++) {
    const text = await traces.nth(i).locator('.legendtext').textContent()
    if (text?.trim() === name) return await traces.nth(i).click()
  }
  throw new Error(`Legend item "${name}" not found in #${plotId}`)
}

/** Read EvE's currently-rendered x-axis station list from Plotly's `_fullData`. */
async function eveStations(page: Page): Promise<string[]> {
  return await plotById(page, 'eve-bars').evaluate(el => {
    const plotly = el.querySelector('.js-plotly-plot') as any
    const data = plotly?._fullData
    return data?.[0]?.x ?? []
  })
}

test.describe('station pin propagates page-wide', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    // RidesPlot legend + EvE data populated.
    await plotById(page, 'rides').locator('.legend .traces .legendtext').first()
      .waitFor({ timeout: 20_000 })
    await expect.poll(() => eveStations(page).then(s => s.length), { timeout: 20_000 })
      .toBeGreaterThan(1)
  })

  test('pinning WTC in RidesPlot narrows EvE to just WTC', async ({ page }) => {
    // Pre-pin: EvE has all 13 stations.
    expect((await eveStations(page)).length).toBe(13)

    await clickLegendByText(page, 'rides', 'WTC')

    // Post-pin: EvE narrows to just WTC.
    await expect.poll(() => eveStations(page), { timeout: 5_000 }).toEqual(['WTC'])
  })

  test('unpinning restores EvE to all stations', async ({ page }) => {
    await clickLegendByText(page, 'rides', 'Journal Square')
    await expect.poll(() => eveStations(page), { timeout: 5_000 }).toEqual(['Journal Square'])

    // Click again → unpin (toggle off).
    await clickLegendByText(page, 'rides', 'Journal Square')
    await expect.poll(() => eveStations(page).then(s => s.length), { timeout: 5_000 }).toBe(13)
  })
})
