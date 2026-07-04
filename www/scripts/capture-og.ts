#!/usr/bin/env -S npx tsx
/**
 * Capture 1200×630 `og:image` PNGs by screenshotting live routes at
 * `?clean` (chrome hidden). Writes to `www/public/og-<slug>.png`; each
 * output is DVX-tracked and referenced from `scripts/prerender-routes.mjs`.
 *
 * Playwright-based (vs. plotly-Python for `og.png`) because the target
 * routes render maps + Leaflet tiles + station pies — nontrivial to
 * reproduce server-side.
 *
 * Usage:
 *   npx tsx scripts/capture-og.ts               # default: /bt and /map
 *   npx tsx scripts/capture-og.ts --port 8858
 *   npx tsx scripts/capture-og.ts --route /bt   # single route
 */
import { chromium } from '@playwright/test'
import { mkdirSync } from 'fs'
import { join, resolve } from 'path'

const args = process.argv.slice(2)
const arg = (name: string, fallback: string) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const PORT = parseInt(arg('--port', '8858'))
const OUT = resolve(arg('--out', 'public'))
const routeArg = args.indexOf('--route') >= 0 ? args[args.indexOf('--route') + 1] : null
const WIDTH = 1200
const HEIGHT = 630

type RouteSpec = {
  path: string
  slug: string  // og-<slug>.png
  // Selector to wait for before screenshotting — ensures the plot is rendered.
  readySelector: string
  // Additional wait after readiness so tiles + tweens settle.
  settleMs: number
  // Optional extra URL params (`?clean` is always included).
  extraParams?: string
}

const ROUTES: RouteSpec[] = [
  {
    path: '/bt',
    slug: 'bt',
    // BTFlowMap uses Leaflet; wait for at least one crossing SVG to render.
    readySelector: '.leaflet-container',
    settleMs: 2500,
  },
  {
    path: '/map',
    slug: 'map',
    // Pie-map uses Leaflet + station-pie divIcons; wait for pies + tiles.
    readySelector: '.station-pie',
    settleMs: 2500,
    extraParams: '&ym=25-01,25-12',  // freeze the range so the preview is stable
  },
]

const selected = routeArg
  ? ROUTES.filter(r => r.path === routeArg)
  : ROUTES

if (selected.length === 0) {
  console.error(`No route matched --route=${routeArg}. Options: ${ROUTES.map(r => r.path).join(', ')}`)
  process.exit(1)
}

mkdirSync(OUT, { recursive: true })

async function capture(spec: RouteSpec) {
  const url = `http://localhost:${PORT}${spec.path}?clean${spec.extraParams ?? ''}`
  console.log(`[${spec.slug}] ${url}`)
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({
      viewport: { width: WIDTH, height: HEIGHT },
      colorScheme: 'dark',
    })
    await page.goto(url, { waitUntil: 'load' })
    await page.waitForSelector(spec.readySelector, { timeout: 20_000 })
    await page.waitForTimeout(spec.settleMs)
    const out = join(OUT, `og-${spec.slug}.png`)
    await page.screenshot({ path: out, fullPage: false })
    console.log(`  → ${out}`)
  } finally {
    await browser.close()
  }
}

for (const spec of selected) {
  await capture(spec)
}
