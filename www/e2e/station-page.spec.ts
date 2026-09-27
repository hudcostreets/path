import { test, expect, Page } from '@playwright/test'

/** Per-station pages: `/station/<slug>` (see `StationPage.tsx`, `stations.ts`). */

// Canonical slugs, NY then NJ. WTC's is `wtc` (derived from the data's
// station name); `world-trade-center` is an alias.
const INDEX_HREFS = [
  'christopher-street', '9th-street', '14th-street', '23rd-street', '33rd-street', 'wtc',
  'newark', 'harrison', 'journal-square', 'grove-street', 'exchange-place', 'newport', 'hoboken',
].map(s => `/station/${s}`)

/** Anchor ids of the plot section headings, in page order. */
async function plotIds(page: Page): Promise<string[]> {
  return page.locator('.heading').evaluateAll(els => els.map(el => el.id || el.querySelector('[id]')?.id || ''))
}

async function waitForPlots(page: Page, n: number) {
  await expect.poll(() => page.locator('.js-plotly-plot').count(), { timeout: 20_000 }).toBe(n)
}

/** `[line label, prev text, next text]` per line row in the header. */
async function lineRows(page: Page): Promise<string[][]> {
  return page.locator('.station-lines li').evaluateAll(lis => lis.map(li => [
    li.querySelector('.line-chip')!.textContent!.trim(),
    ...[...li.querySelectorAll('.line-neighbors > a, .line-neighbors > .terminal')].map(e => e.textContent!.trim()),
  ]))
}

test.describe('station page', () => {
  test('renders header, stats, and all plots', async ({ page }) => {
    await page.goto('/station/grove-street')
    await expect(page.locator('h1')).toHaveText('Grove Street')
    await expect(page).toHaveTitle('Grove Street – PATH Ridership – Hudson County Complete Streets')
    expect(await lineRows(page)).toEqual([
      ['NWK–WTC', '← Journal Square', 'Exchange Place →'],
      ['JSQ–33', '← Journal Square', 'Newport →'],
    ])
    await waitForPlots(page, 5)
    expect(await plotIds(page)).toEqual(['recovery', 'rides', 'rank', 'monthly', 'hourly'])
    await expect(page.locator('.station-stat')).toHaveCount(4)
    // Rank trace: one point per month, all within 1..13.
    const ranks = await page.locator('.js-plotly-plot').nth(2).evaluate(gd => (gd as any)._fullData[0].y as number[])
    expect(ranks.length).toBeGreaterThan(100)
    expect(ranks.filter(r => r < 1 || r > 13)).toEqual([])
  })

  test('line-neighbor links navigate client-side', async ({ page }) => {
    await page.goto('/station/grove-street')
    await page.getByRole('link', { name: 'Exchange Place →' }).click()
    await expect(page).toHaveURL(/\/station\/exchange-place$/)
    await expect(page.locator('h1')).toHaveText('Exchange Place')
    expect(await lineRows(page)).toEqual([
      ['NWK–WTC', '← Grove Street', 'World Trade Center →'],
      ['HOB–WTC', '← Newport', 'World Trade Center →'],
    ])
  })

  test('alias slugs redirect to the canonical slug', async ({ page }) => {
    for (const [alias, canonical, h1] of [
      ['JSQ', 'journal-square', 'Journal Square'],
      ['world-trade-center', 'wtc', 'World Trade Center'],
      ['Hoboken', 'hoboken', 'Hoboken'],
    ]) {
      await page.goto(`/station/${alias}?d=w`)
      await expect(page).toHaveURL(new RegExp(`/station/${canonical}\\?d=w$`))
      await expect(page.locator('h1')).toHaveText(h1)
    }
  })

  test('unknown slug lists all stations', async ({ page }) => {
    await page.goto('/station/nope')
    await expect(page.locator('h1')).toHaveText('Unknown station')
    expect(await page.locator('.station-index a').evaluateAll(as => as.map(a => a.getAttribute('href')))).toEqual(INDEX_HREFS)
  })
})

test.describe('homepage → station pages', () => {
  test('station index links to all 13 pages', async ({ page }) => {
    await page.goto('/')
    expect(await page.locator('.station-index a').evaluateAll(as => as.map(a => a.getAttribute('href')))).toEqual(INDEX_HREFS)
  })

  test('pinned station shows a page link in the rides subtitle', async ({ page }) => {
    await page.goto('/?s=g')
    const link = page.locator('.plot-container').first().locator('.station-page-link')
    await expect(link).toHaveText('Grove Street page →')
    await link.click()
    await expect(page).toHaveURL(/\/station\/grove-street$/)
    await expect(page.locator('h1')).toHaveText('Grove Street')
  })
})
