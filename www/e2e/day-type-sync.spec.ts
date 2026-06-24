import { test, expect, Page } from '@playwright/test'

/**
 * Day-type filter state is shared between `RidesPlot` (top of page) and
 * `EntriesVsExitsBars` (bottom of page) via the URL param `?d=`. Clicking
 * a chip in either updates the other; URL drives both as source of truth.
 *
 * Encoding (see `www/src/dayTypes.ts#dayTypesParam`):
 *   ["weekday", "weekend"]              ↔  no param (default)
 *   ["weekday", "weekend", "holiday"]   ↔  ?d=weh
 *   ["holiday"]                         ↔  ?d=h
 *   []                                  ↔  ?d=
 */

const PICKER_ITEMS = ['Weekday', 'Weekend', 'Holiday'] as const
type PickerItem = typeof PICKER_ITEMS[number]

/** EvE chips are <button> with `aria-pressed`. Scoped to the EvE chips container
 *  (class `eve-day-chips`) so we don't collide with same-named legend entries. */
function eveChip(page: Page, name: PickerItem) {
  return page.locator('.eve-day-chips').getByRole('button', { name, exact: true })
}

async function eveActive(page: Page, name: PickerItem): Promise<boolean> {
  return (await eveChip(page, name).getAttribute('aria-pressed')) === 'true'
}

/** A plot's day-type filter pill (RidesPlot, HourlyPlot, etc.) — present when
 *  fewer than all 3 day-types are selected, hidden when all are on. */
function dayTypeFilterPill(page: Page, plotId: 'rides' | 'hourly') {
  return page.locator(`xpath=(//span[@id='${plotId}']/ancestor::div[contains(@class, 'plot-container')])[1]`)
    .locator('.filter-badge')
    .filter({ hasText: /Weekday|Weekend|Holiday/ })
}

test.describe('day-type filter sync across plots', () => {
  test('default URL → EvE chips show [Weekday, Weekend] active, Holiday inactive', async ({ page }) => {
    await page.goto('/')
    // Wait for EvE controls to mount.
    await eveChip(page, 'Weekday').waitFor({ timeout: 10_000 })
    expect(await eveActive(page, 'Weekday')).toBe(true)
    expect(await eveActive(page, 'Weekend')).toBe(true)
    expect(await eveActive(page, 'Holiday')).toBe(false)
  })

  test('URL ?d=weh → EvE chips show all 3 active', async ({ page }) => {
    await page.goto('/?d=weh')
    await eveChip(page, 'Weekday').waitFor({ timeout: 10_000 })
    expect(await eveActive(page, 'Weekday')).toBe(true)
    expect(await eveActive(page, 'Weekend')).toBe(true)
    expect(await eveActive(page, 'Holiday')).toBe(true)
  })

  test('URL ?d=h → only Holiday active', async ({ page }) => {
    await page.goto('/?d=h')
    await eveChip(page, 'Holiday').waitFor({ timeout: 10_000 })
    expect(await eveActive(page, 'Weekday')).toBe(false)
    expect(await eveActive(page, 'Weekend')).toBe(false)
    expect(await eveActive(page, 'Holiday')).toBe(true)
  })

  test('clicking EvE Holiday writes ?d=weh and clears RidesPlot filter pill', async ({ page }) => {
    await page.goto('/')
    // Default has 2 of 3 selected → RidesPlot shows a "Weekday, Weekend" pill.
    await dayTypeFilterPill(page, 'rides').first().waitFor({ timeout: 10_000 })
    expect(await dayTypeFilterPill(page, 'rides').count()).toBe(1)

    await eveChip(page, 'Holiday').click()

    // URL update + ride-plot reaction take a couple frames + the EvE→URL
    // write is synchronous but RidesPlot's URL→state sync runs in useEffect.
    await expect.poll(() => page.url(), { timeout: 5_000 }).toContain('d=weh')
    await expect.poll(async () => await dayTypeFilterPill(page, 'rides').count(), { timeout: 5_000 }).toBe(0)
  })

  test('clicking EvE Holiday also clears HourlyPlot filter pill', async ({ page }) => {
    await page.goto('/')
    await dayTypeFilterPill(page, 'hourly').first().waitFor({ timeout: 10_000 })
    expect(await dayTypeFilterPill(page, 'hourly').count()).toBe(1)

    await eveChip(page, 'Holiday').click()

    await expect.poll(async () => await dayTypeFilterPill(page, 'hourly').count(), { timeout: 5_000 }).toBe(0)
  })

  test('URL ?d=h → HourlyPlot picker also shows only Holiday', async ({ page }) => {
    await page.goto('/?d=h')
    // HourlyPlot's filter pill text reflects the URL.
    await expect.poll(async () => {
      const t = await dayTypeFilterPill(page, 'hourly').first().textContent({ timeout: 1000 }).catch(() => '')
      return (t || '').replace('×', '').trim()
    }, { timeout: 10_000 }).toBe('Holiday')
  })

  test('clicking RidesPlot legend day-type entry propagates to EvE', async ({ page }) => {
    await page.goto('/?d=weh')
    await eveChip(page, 'Holiday').waitFor({ timeout: 10_000 })
    expect(await eveActive(page, 'Holiday')).toBe(true)

    // Open RidesPlot's "Day Types" dropdown and toggle Holiday off.
    // StationDropdown renders a <summary>-style trigger with the dropdown label.
    const dayTypesDropdown = page.locator('xpath=(//span[@id=\'rides\']/ancestor::div[contains(@class, \'plot-container\')])[1]')
      .locator('.station-dropdown')
      .filter({ hasText: 'Day Types' })
    await dayTypesDropdown.locator('summary').click()
    await dayTypesDropdown.getByLabel('Holiday').uncheck()

    // EvE chip flips off; URL's d= param (if present) no longer contains 'h'.
    await expect.poll(() => eveActive(page, 'Holiday'), { timeout: 5_000 }).toBe(false)
    await expect.poll(() => new URL(page.url()).searchParams.get('d') ?? '', { timeout: 5_000 })
      .not.toContain('h')
  })
})
