import { test, expect, Page } from '@playwright/test'

/**
 * `useScrollAnchor` (see `src/useScrollAnchor.ts`) does two things:
 *   1. On mount: if URL has a hash, scroll the matching `#id` element to the
 *      top of the viewport (and keep re-scrolling while DOM mutates, up to 5s).
 *   2. On user scroll: debounced 150ms, update the URL hash to the nearest
 *      `h2`/`h3` whose top is above the upper third of the viewport.
 *
 * `@rdub/base` H2/H3 render as `<hN><span id="…" style="top:-4em"/><a>…`, so
 * `#id` refers to the sentinel span, not the h2 itself. Scrolling to the span
 * lands the visual heading ~4em down the viewport (deliberate sticky-nav offset).
 */

const HOME_ANCHORS = ['rides', 'monthly', 'hourly', 'eve', 'eve-bars'] as const
const BT_ANCHORS = ['traffic', 'monthly', 'flow-map'] as const

async function waitForHeaders(page: Page, ids: readonly string[]) {
  // Anchor spans are `position:absolute; top:-4em` sentinels (see @rdub/base
  // `Heading`) — 0 x 0 dimensions, so Playwright's default `visible` gate
  // never passes. Wait for DOM attachment instead.
  for (const id of ids) {
    await page.locator(`#${id}`).waitFor({ state: 'attached', timeout: 15_000 })
  }
}

async function anchorRect(page: Page, id: string) {
  return await page.evaluate((id) => {
    const el = document.getElementById(id)!
    const r = el.getBoundingClientRect()
    return { top: r.top, absY: r.top + window.scrollY }
  }, id)
}

test.describe('useScrollAnchor', () => {
  test('/ exposes all expected section anchors as `h2|h3` [id]', async ({ page }) => {
    await page.goto('/')
    await waitForHeaders(page, HOME_ANCHORS)
    const ids = await page.$$eval('h2, h3', hs =>
      hs.map(h => (h as HTMLElement).id || h.querySelector<HTMLElement>('[id]')?.id).filter(Boolean)
    )
    expect(ids).toEqual([...HOME_ANCHORS])
  })

  test('/bt exposes all expected section anchors as `h2` [id]', async ({ page }) => {
    await page.goto('/bt')
    await waitForHeaders(page, BT_ANCHORS)
    const ids = await page.$$eval('h2', hs =>
      hs.map(h => (h as HTMLElement).id || h.querySelector<HTMLElement>('[id]')?.id).filter(Boolean)
    )
    expect(ids).toEqual([...BT_ANCHORS])
  })

  for (const id of ['hourly', 'eve', 'eve-bars'] as const) {
    test(`hash \`#${id}\` on load scrolls the matching anchor to viewport top`, async ({ page }) => {
      await page.goto(`/#${id}`)
      await waitForHeaders(page, HOME_ANCHORS)
      // The hook rescrolls for up to 5s via MutationObserver as data loads
      // shift the layout — poll until the anchor lands near the top rather
      // than fixed-wait.
      await expect(async () => {
        const { top } = await anchorRect(page, id)
        expect(Math.abs(top)).toBeLessThan(50)
      }).toPass({ timeout: 8_000, intervals: [300, 500, 800] })
    })
  }

  test('scrolling past an h2 into its h3 sub-section flips the hash', async ({ page }) => {
    await page.goto('/')
    await waitForHeaders(page, HOME_ANCHORS)
    // Wait for the EvE bars plot to actually render — until then, the h3's
    // abs y-position drifts as sibling plots load, and pre-measured scroll
    // targets can end up too low relative to the settled layout.
    await page.locator('xpath=(//span[@id="eve-bars"]/ancestor::div[contains(@class,"plot-container")])[1]//*[contains(@class,"js-plotly-plot")]')
      .waitFor({ timeout: 15_000 })
    // Programmatic scroll doesn't reliably fire scroll events in headless
    // Chrome, so drive the debounced updater explicitly. The listener itself
    // is what shipped in the hook; only the trigger is synthetic.
    async function scrollAndSync(id: string) {
      await page.evaluate(id => {
        const anchor = document.getElementById(id)!.parentElement!
        const y = anchor.getBoundingClientRect().top + window.scrollY + 50
        window.scrollTo({ top: y })
        window.dispatchEvent(new Event('scroll'))
      }, id)
      await page.waitForTimeout(300)
      return await page.evaluate(() => location.hash)
    }

    expect(await scrollAndSync('rides')).toBe('#rides')
    expect(await scrollAndSync('eve')).toBe('#eve')
    // The whole point of tracking h3s: scrolling past the h2 into the h3
    // sub-section flips to the h3, doesn't stick on the h2 above it.
    expect(await scrollAndSync('eve-bars')).toBe('#eve-bars')
  })

  test('reveals `<html>` after scroll-restore even when hash is unknown', async ({ page }) => {
    await page.goto('/#no-such-section')
    // Max wait for the 5s safety timeout in the hook + margin.
    await page.waitForTimeout(6000)
    const visibility = await page.evaluate(() => document.documentElement.style.visibility)
    expect(visibility).toBe('')
  })
})
