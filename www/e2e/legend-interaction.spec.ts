import { test, expect, Page, Locator } from '@playwright/test'

// ─── Helpers ───

function pc(page: Page, n: number): Locator {
  return page.locator('.plot-container').nth(n)
}

async function waitForLegend(page: Page, n: number) {
  await pc(page, n).locator('.legend .traces .legendtext').first().waitFor({ timeout: 20_000 })
}

async function getLegendNames(page: Page, n: number): Promise<string[]> {
  return pc(page, n).locator('.legend .traces .legendtext').allTextContents()
    .then(names => names.map(n => n.trim()))
}

async function getLegendFontWeight(page: Page, n: number, name: string): Promise<string> {
  return pc(page, n).evaluate((el, n) => {
    for (const t of el.querySelectorAll('.legend .traces')) {
      const text = t.querySelector('.legendtext') as SVGTextElement | null
      if (text?.textContent?.trim() === n) return text.style.fontWeight || ''
    }
    return ''
  }, name)
}

async function findLegendItem(page: Page, n: number, name: string): Promise<Locator> {
  const traces = pc(page, n).locator('.legend .traces')
  const count = await traces.count()
  for (let i = 0; i < count; i++) {
    const text = await traces.nth(i).locator('.legendtext').textContent()
    if (text?.trim() === name) return traces.nth(i)
  }
  throw new Error(`Legend item "${name}" not found`)
}

async function hoverLI(page: Page, n: number, name: string) {
  const li = await findLegendItem(page, n, name)
  await li.hover()
}

async function clickLI(page: Page, n: number, name: string) {
  const li = await findLegendItem(page, n, name)
  await li.click()
}

/** Count station/crossing filter badges (ignoring day-type badges) */
async function stationBadgeCount(page: Page, n: number): Promise<number> {
  // Station badges contain station names/abbrevs, not "Weekday"/"Weekend"/"Holiday"
  const badges = pc(page, n).locator('.filter-badge')
  const count = await badges.count()
  let stationCount = 0
  for (let i = 0; i < count; i++) {
    const text = await badges.nth(i).textContent()
    if (text && !text.match(/Weekday|Weekend|Holiday/i)) stationCount++
  }
  return stationCount
}

// ─── PATH ───
// The old `PATH legend interaction` describe block was removed: it navigated
// with `?g=s&l=h`, where `l=h` meant "legend mode = highlight" — a URL param
// that used to live on the PATH page but moved to `/bt` only. The tests have
// been failing silently since roughly that refactor.
//
// The `BT legend interaction` block below covers the same interaction class
// on the page that still uses `l=`. If you want PATH legend coverage back,
// write fresh tests against the current RidesPlot hover/pin semantics.

// ─── BT ───

test.describe('BT legend interaction', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/bt')
    await waitForLegend(page, 0)
  })

  test('renders 6 crossing legend items', async ({ page }) => {
    const names = await getLegendNames(page, 0)
    expect(names).toContain('GWB')
    expect(names).toContain('Holland')
    expect(names.length).toBe(6)
  })

  test('hover shows badge', async ({ page }) => {
    await hoverLI(page, 0, 'Holland')
    await page.waitForTimeout(200)
    const sub = await pc(page, 0).locator('.plot-subtitle').textContent()
    expect(sub).toContain('Holland')
  })

  test('pin and unpin', async ({ page }) => {
    await hoverLI(page, 0, 'GWB')
    await page.waitForTimeout(50)
    await clickLI(page, 0, 'GWB')
    await page.waitForTimeout(100)
    await page.mouse.move(10, 10)
    await page.waitForTimeout(300)
    let sub = await pc(page, 0).locator('.plot-subtitle').textContent()
    expect(sub).toContain('GWB')
    // Unpin
    await hoverLI(page, 0, 'GWB')
    await page.waitForTimeout(50)
    await clickLI(page, 0, 'GWB')
    await page.waitForTimeout(100)
    await page.mouse.move(10, 10)
    await page.waitForTimeout(300)
    expect(await stationBadgeCount(page, 0)).toBe(0)
  })
})

// ─── No render loops ───

test.describe('No render loops', () => {
  for (const [name, url] of [
    ['PATH default', '/'],
    ['PATH recovery by-station', '/?l=h&b=1&m=p&d=weh&g=s'],
    ['PATH by-daytype', '/?g=d'],
    ['BT traffic', '/bt'],
    ['BT vs2019', '/bt?m=v'],
  ] as const) {
    test(`${name}`, async ({ page }) => {
      const errors: string[] = []
      page.on('console', msg => {
        if (msg.type() === 'error' && msg.text().includes('Maximum update depth')) {
          errors.push(msg.text())
        }
      })
      await page.goto(url)
      await page.waitForTimeout(5000)
      expect(errors).toEqual([])
    })
  }
})
