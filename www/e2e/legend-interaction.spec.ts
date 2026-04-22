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

// ─── Plot stability ───
//
// Hovering or pinning a legend item must NOT shift the plot vertically. A
// ~1px shift historically crept in from the filter-badge having a larger
// box-height than the plain-text placeholder in `.plot-subtitle`.

/** Locate a plot by its H2 id (set via `@rdub/base/heading` renders `id` on an
 *  inner `<span>`, not on the `<h2>` itself). */
function plotById(page: Page, id: string): Locator {
  return page.locator(`xpath=(//span[@id='${id}']/ancestor::div[contains(@class, 'plot-container')])[1]`)
}

async function getLegendNamesById(page: Page, id: string): Promise<string[]> {
  return plotById(page, id).locator('.legend .traces .legendtext').allTextContents()
    .then(names => names.map(n => n.trim()))
}

async function hoverLIById(page: Page, id: string, name: string) {
  const traces = plotById(page, id).locator('.legend .traces')
  const count = await traces.count()
  for (let i = 0; i < count; i++) {
    const text = await traces.nth(i).locator('.legendtext').textContent()
    if (text?.trim() === name) return traces.nth(i).hover()
  }
  throw new Error(`Legend item "${name}" not found in #${id}`)
}

async function clickLIById(page: Page, id: string, name: string) {
  const traces = plotById(page, id).locator('.legend .traces')
  const count = await traces.count()
  for (let i = 0; i < count; i++) {
    const text = await traces.nth(i).locator('.legendtext').textContent()
    if (text?.trim() === name) return traces.nth(i).click()
  }
  throw new Error(`Legend item "${name}" not found in #${id}`)
}

async function plotTopById(page: Page, id: string): Promise<number> {
  return plotById(page, id).evaluate(el => {
    const plot = el.querySelector('.js-plotly-plot')
    if (!plot) return 0
    return plot.getBoundingClientRect().top + window.scrollY
  })
}

test.describe('Plot position stable on hover/pin', () => {
  const cases = [
    { name: '/ plot1 (RidesPlot) hover station', url: '/', origin: 'rides', hover: 'Journal Square', check: ['rides', 'monthly', 'hourly'] },
    { name: '/ plot3 (HourlyPlot) hover station', url: '/', origin: 'hourly', hover: 'Newark', check: ['rides', 'monthly', 'hourly'] },
    { name: '/bt plot1 (TrafficPlot) hover crossing', url: '/bt', origin: 'bt-traffic', hover: 'GWB', check: ['bt-traffic', 'bt-monthly'] },
    { name: '/bt plot2 (BTMonthlyPlot) hover year', url: '/bt', origin: 'bt-monthly', hover: '2020', check: ['bt-traffic', 'bt-monthly'] },
  ] as const

  for (const c of cases) {
    test(c.name, async ({ page }) => {
      await page.goto(c.url)
      // Wait for the specific LI to render (async data loads can lag a tick)
      await expect.poll(async () => {
        const names = await getLegendNamesById(page, c.origin)
        return names.includes(c.hover)
      }, { timeout: 20_000 }).toBe(true)
      // Let all plots render + any pending relayouts settle
      await page.waitForTimeout(500)

      const before: Record<string, number> = {}
      for (const id of c.check) before[id] = await plotTopById(page, id)

      await hoverLIById(page, c.origin, c.hover)
      await page.waitForTimeout(400)
      for (const id of c.check) {
        const after = await plotTopById(page, id)
        expect(after, `#${id} top shifted on hover (before=${before[id]} after=${after})`).toBe(before[id])
      }

      await clickLIById(page, c.origin, c.hover)
      await page.waitForTimeout(200)
      await page.mouse.move(10, 10)
      await page.waitForTimeout(400)
      for (const id of c.check) {
        const after = await plotTopById(page, id)
        expect(after, `#${id} top shifted on pin (before=${before[id]} after=${after})`).toBe(before[id])
      }
    })
  }
})

// ─── Bidirectional pin brushing ───
//
// Pinning a station on `/` plot1 (RidesPlot) or plot3 (HourlyPlot) should
// bold that station's LI on BOTH plots (via pltly's controlled soloTrace)
// AND filter plot2 (MonthlyPlots) to that station.

async function legendFontWeightById(page: Page, id: string, name: string): Promise<string> {
  return plotById(page, id).evaluate((el, n) => {
    for (const t of el.querySelectorAll('.legend .traces')) {
      const text = t.querySelector('.legendtext') as SVGTextElement | null
      if (text?.textContent?.trim() === n) return text.style.fontWeight || ''
    }
    return ''
  }, name)
}

async function clickLIByIdWithWait(page: Page, id: string, name: string) {
  await expect.poll(async () => {
    const names = await plotById(page, id).locator('.legend .traces .legendtext').allTextContents()
    return names.map(s => s.trim()).includes(name)
  }, { timeout: 20_000 }).toBe(true)
  await clickLIById(page, id, name)
}

test.describe('Bidirectional pin brushing on /', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('plot1 pin → plot3 also bolds that station', async ({ page }) => {
    await clickLIByIdWithWait(page, 'rides', 'Newark')
    await page.waitForTimeout(300)
    // Plot1 shows Newark bold. In HourlyPlot, the trace name is identical.
    expect(await legendFontWeightById(page, 'rides', 'Newark')).not.toBe('')
    expect(await legendFontWeightById(page, 'hourly', 'Newark')).not.toBe('')
  })

  test('plot3 pin → plot1 also bolds that station', async ({ page }) => {
    await clickLIByIdWithWait(page, 'hourly', 'Hoboken')
    await page.waitForTimeout(300)
    expect(await legendFontWeightById(page, 'hourly', 'Hoboken')).not.toBe('')
    expect(await legendFontWeightById(page, 'rides', 'Hoboken')).not.toBe('')
  })

  test('plot3 pin → plot2 filters to that station', async ({ page }) => {
    await clickLIByIdWithWait(page, 'hourly', 'WTC')
    await page.waitForTimeout(300)
    const sub = await plotById(page, 'monthly').locator('.plot-subtitle').textContent()
    expect(sub).toContain('WTC')
  })

  test('plot1 pin → plot2 filters and plot3 keeps full legend', async ({ page }) => {
    await clickLIByIdWithWait(page, 'rides', 'Journal Square')
    await page.waitForTimeout(300)
    expect(await legendFontWeightById(page, 'rides', 'Journal Square')).not.toBe('')
    expect(await legendFontWeightById(page, 'hourly', 'Journal Square')).not.toBe('')
    // Plot3 keeps all stations in its legend (data not narrowed by plot1 pin)
    const hourlyNames = await plotById(page, 'hourly').locator('.legend .traces .legendtext').allTextContents()
    expect(hourlyNames.length).toBeGreaterThan(5)
    // Plot2 filters to the pinned station
    const sub = await plotById(page, 'monthly').locator('.plot-subtitle').textContent()
    expect(sub).toContain('Journal Square')
  })
})

// ─── Filter badges on plot1 & plot3 ───
//
// Hovering/pinning a LI on plot1 or plot3 should produce a filter badge in
// that plot's own subtitle (matching plot2's existing behavior on `/bt`).

async function subtitleText(page: Page, id: string): Promise<string> {
  return (await plotById(page, id).locator('.plot-subtitle').textContent()) ?? ''
}

async function hasBadge(page: Page, id: string, text: string): Promise<boolean> {
  const badges = await plotById(page, id).locator('.filter-badge').allTextContents()
  return badges.some(b => b.includes(text))
}

test.describe('Filter badges on /', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/') })

  test('plot1 pin station → plot1 subtitle shows badge', async ({ page }) => {
    await clickLIByIdWithWait(page, 'rides', 'Hoboken')
    await page.waitForTimeout(300)
    expect(await hasBadge(page, 'rides', 'Hoboken')).toBe(true)
  })

  test('plot3 hover station → plot3 subtitle shows badge', async ({ page }) => {
    await expect.poll(async () => (await getLegendNamesById(page, 'hourly')).includes('Newark'),
      { timeout: 20_000 }).toBe(true)
    await hoverLIById(page, 'hourly', 'Newark')
    await page.waitForTimeout(300)
    expect(await hasBadge(page, 'hourly', 'Newark')).toBe(true)
  })

  test('plot3 badge × clears the pin', async ({ page }) => {
    await clickLIByIdWithWait(page, 'hourly', 'WTC')
    await page.waitForTimeout(300)
    expect(await hasBadge(page, 'hourly', 'WTC')).toBe(true)
    // Click × on plot3's subtitle badge
    await plotById(page, 'hourly').locator('.filter-badge', { hasText: 'WTC' }).locator('.clear-filter').click()
    await page.waitForTimeout(300)
    expect(await hasBadge(page, 'hourly', 'WTC')).toBe(false)
    // plot1 should also un-bold
    expect(await legendFontWeightById(page, 'rides', 'WTC')).toBe('')
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
