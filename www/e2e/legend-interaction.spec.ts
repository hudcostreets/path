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

test.describe('PATH legend interaction', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/?g=s&l=h')
    await waitForLegend(page, 0)
  })

  test('renders 13 station legend items', async ({ page }) => {
    const names = await getLegendNames(page, 0)
    expect(names).toContain('WTC')
    expect(names).toContain('Hoboken')
    expect(names.length).toBe(13)
  })

  test('hover shows station badge', async ({ page }) => {
    await hoverLI(page, 0, 'WTC')
    await page.waitForTimeout(200)
    expect(await stationBadgeCount(page, 0)).toBe(1)
    const sub = await pc(page, 0).locator('.plot-subtitle').textContent()
    expect(sub).toContain('WTC')
  })

  test('hover out removes station badge', async ({ page }) => {
    await hoverLI(page, 0, 'WTC')
    await page.waitForTimeout(100)
    await page.mouse.move(10, 10)
    await page.waitForTimeout(300)
    expect(await stationBadgeCount(page, 0)).toBe(0)
  })

  test('click pins with bold LI, survives hover-out', async ({ page }) => {
    await hoverLI(page, 0, 'WTC')
    await page.waitForTimeout(50)
    await clickLI(page, 0, 'WTC')
    await page.waitForTimeout(100)
    await page.mouse.move(10, 10)
    await page.waitForTimeout(300)
    expect(await stationBadgeCount(page, 0)).toBe(1)
    expect(await getLegendFontWeight(page, 0, 'WTC')).toBe('700')
  })

  test('click pinned LI unpins', async ({ page }) => {
    // Pin
    await hoverLI(page, 0, 'WTC')
    await page.waitForTimeout(50)
    await clickLI(page, 0, 'WTC')
    await page.waitForTimeout(100)
    await page.mouse.move(10, 10)
    await page.waitForTimeout(300)
    // Unpin
    await hoverLI(page, 0, 'WTC')
    await page.waitForTimeout(50)
    await clickLI(page, 0, 'WTC')
    await page.waitForTimeout(100)
    await page.mouse.move(10, 10)
    await page.waitForTimeout(300)
    expect(await stationBadgeCount(page, 0)).toBe(0)
  })

  test('click different LI switches pin', async ({ page }) => {
    await hoverLI(page, 0, 'WTC')
    await page.waitForTimeout(50)
    await clickLI(page, 0, 'WTC')
    await page.waitForTimeout(100)
    await hoverLI(page, 0, 'Hoboken')
    await page.waitForTimeout(50)
    await clickLI(page, 0, 'Hoboken')
    await page.waitForTimeout(200)
    const sub = await pc(page, 0).locator('.plot-subtitle').textContent()
    expect(sub).toContain('Hoboken')
    expect(await getLegendFontWeight(page, 0, 'Hoboken')).toBe('700')
  })

  test('click empty space unpins', async ({ page }) => {
    await hoverLI(page, 0, 'WTC')
    await page.waitForTimeout(50)
    await clickLI(page, 0, 'WTC')
    await page.waitForTimeout(100)
    await pc(page, 0).click({ position: { x: 300, y: 400 } })
    await page.waitForTimeout(300)
    expect(await stationBadgeCount(page, 0)).toBe(0)
  })

  test('badge × clears pin', async ({ page }) => {
    await hoverLI(page, 0, 'WTC')
    await page.waitForTimeout(50)
    await clickLI(page, 0, 'WTC')
    await page.waitForTimeout(100)
    await page.mouse.move(10, 10)
    await page.waitForTimeout(300)
    // Find the station badge's × (not day-type badge)
    const badges = pc(page, 0).locator('.filter-badge')
    const count = await badges.count()
    for (let i = 0; i < count; i++) {
      const text = await badges.nth(i).textContent()
      if (text && !text.match(/Weekday|Weekend|Holiday/i)) {
        await badges.nth(i).locator('.clear-filter').click()
        break
      }
    }
    await page.waitForTimeout(300)
    expect(await stationBadgeCount(page, 0)).toBe(0)
  })

  test('hover while pinned does not change subtitle', async ({ page }) => {
    await hoverLI(page, 0, 'WTC')
    await page.waitForTimeout(50)
    await clickLI(page, 0, 'WTC')
    await page.waitForTimeout(100)
    await hoverLI(page, 0, 'Hoboken')
    await page.waitForTimeout(200)
    const sub = await pc(page, 0).locator('.plot-subtitle').textContent()
    expect(sub).toContain('WTC')
    expect(sub).not.toContain('HOB')
  })

  test('no layout shift on hover', async ({ page }) => {
    const plot = pc(page, 0).locator('.js-plotly-plot')
    const before = await plot.boundingBox()
    await hoverLI(page, 0, 'WTC')
    await page.waitForTimeout(200)
    const after = await plot.boundingBox()
    expect(after!.y).toBe(before!.y)
  })
})

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
