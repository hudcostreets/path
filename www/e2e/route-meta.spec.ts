import { test, expect, type Page } from '@playwright/test'
import { HOME, ROUTE_METAS, ogUrl, type RouteMeta } from '../src/route-meta'

/**
 * Per-route `<title>` / description / `og:*` tags (see `src/route-meta.ts`).
 * Crawlers don't run JS, so the tags must be in the HTML served for each
 * route: in CI this hits `vite preview` (the built `dist/<route>.html`
 * files), locally the dev server (`transformIndexHtml` per request URL).
 */

type HeadMeta = {
  title: string
  description: string
  'og:title': string
  'og:description': string
  'og:image': string
  'og:url': string
  'og:type': string
  'og:site_name': string
  'twitter:card': string
  viewport: string
}

function unescape(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

/** Parse the served HTML's `<title>` + `<meta>` tags; throws on duplicates. */
function parseHead(html: string): Record<string, string> {
  const out: Record<string, string> = {}
  const set = (k: string, v: string) => {
    if (k in out) throw new Error(`duplicate head tag: ${k}`)
    out[k] = unescape(v)
  }
  const title = html.match(/<title>([^<]*)<\/title>/)
  if (title) set('title', title[1])
  for (const [, key, content] of html.matchAll(/<meta (?:name|property)="([^"]+)" content="([^"]*)"/g)) {
    set(key, content)
  }
  return out
}

const COMMON = {
  viewport: 'width=device-width, initial-scale=1.0',
  'og:type': 'website',
  'og:site_name': 'Hudson County Complete Streets',
  'twitter:card': 'summary_large_image',
}

function expected(meta: RouteMeta): HeadMeta {
  return {
    title: meta.title,
    description: meta.description,
    'og:title': meta.ogTitle,
    'og:description': meta.description,
    'og:image': meta.ogImage,
    'og:url': ogUrl(meta),
    ...COMMON,
  }
}

async function domHead(page: Page): Promise<Record<string, string>> {
  return await page.evaluate(() => {
    const out: Record<string, string> = { title: document.title }
    for (const m of document.head.querySelectorAll('meta[name][content], meta[property][content]')) {
      out[m.getAttribute('name') ?? m.getAttribute('property')!] = m.getAttribute('content')!
    }
    return out
  })
}

test.describe('served HTML has per-route meta', () => {
  test('/', async ({ request }) => {
    const html = await (await request.get('/')).text()
    expect(parseHead(html)).toEqual({
      title: 'PATH Ridership Data – Hudson County Complete Streets',
      description: 'Interactive plots of PATH ridership: daily/monthly/hourly per station, from PANYNJ monthly reports.',
      'og:title': 'PATH Ridership Data',
      'og:description': 'Interactive plots of PATH ridership: daily/monthly/hourly per station, from PANYNJ monthly reports.',
      'og:image': 'https://pa.hccs.dev/og.png',
      'og:url': 'https://pa.hccs.dev/',
      ...COMMON,
    })
  })

  test('/bt', async ({ request }) => {
    const html = await (await request.get('/bt')).text()
    expect(parseHead(html)).toEqual({
      title: 'PANYNJ Bridge & Tunnel Traffic – Hudson County Complete Streets',
      description: 'Interactive visualizations of monthly vehicle counts at the six PANYNJ bridges and tunnels (GWB, Lincoln, Holland, Bayonne, Goethals, Outerbridge), 2011–present.',
      'og:title': 'PANYNJ Bridge & Tunnel Traffic',
      'og:description': 'Interactive visualizations of monthly vehicle counts at the six PANYNJ bridges and tunnels (GWB, Lincoln, Holland, Bayonne, Goethals, Outerbridge), 2011–present.',
      'og:image': 'https://pa.hccs.dev/og-bt.png',
      'og:url': 'https://pa.hccs.dev/bt',
      ...COMMON,
    })
  })

  test('/station/grove-street', async ({ request }) => {
    const html = await (await request.get('/station/grove-street')).text()
    expect(parseHead(html)).toEqual({
      title: 'Grove Street – PATH Ridership – Hudson County Complete Streets',
      description: 'PATH ridership at Grove Street: monthly weekday/weekend averages and recovery vs. pre-COVID, from PANYNJ monthly reports.',
      'og:title': 'Grove Street PATH Station Ridership',
      'og:description': 'PATH ridership at Grove Street: monthly weekday/weekend averages and recovery vs. pre-COVID, from PANYNJ monthly reports.',
      'og:image': 'https://pa.hccs.dev/og.png',
      'og:url': 'https://pa.hccs.dev/station/grove-street',
      ...COMMON,
    })
  })

  test('every ROUTE_METAS entry', async ({ request }) => {
    const actual: Record<string, Record<string, string>> = {}
    for (const meta of ROUTE_METAS) {
      actual[meta.path] = parseHead(await (await request.get(meta.path)).text())
    }
    expect(actual).toEqual(Object.fromEntries(ROUTE_METAS.map(m => [m.path, expected(m)])))
  })

  test('unknown routes get the homepage meta', async ({ request }) => {
    const html = await (await request.get('/banner')).text()
    expect(parseHead(html)).toEqual(expected(HOME))
  })

  test('each OG image is served', async ({ request }) => {
    const images = [...new Set(ROUTE_METAS.map(m => new URL(m.ogImage).pathname))]
    const results = []
    for (const path of images) {
      const res = await request.get(path)
      results.push([path, res.status(), res.headers()['content-type']])
    }
    expect(results).toEqual([
      ['/og.png', 200, 'image/png'],
      ['/og-bt.png', 200, 'image/png'],
      ['/og-map.jpg', 200, 'image/jpeg'],
    ])
  })
})

test('client-side navigation keeps title + meta in sync', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveTitle(HOME.title)
  // `BrowserRouter` listens for `popstate`; this navigates without a reload.
  const navigate = (path: string) => page.evaluate((path) => {
    history.pushState({}, '', path)
    dispatchEvent(new PopStateEvent('popstate'))
  }, path)
  const bt = ROUTE_METAS.find(m => m.path === '/bt')!
  await navigate('/bt')
  await expect(page).toHaveTitle(bt.title)
  expect(await domHead(page)).toEqual(expected(bt))
  await navigate('/')
  await expect(page).toHaveTitle(HOME.title)
  expect(await domHead(page)).toEqual(expected(HOME))
})
