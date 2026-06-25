#!/usr/bin/env node
// Post-build: emit per-route index.html files with route-specific <title>,
// description, and og:* meta. GitHub Pages serves `/bt` as `bt/index.html`
// (when present) before falling back to `404.html`, so this gives social-card
// previews + tab titles that match the page being shared.
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const DIST = join(ROOT, 'dist')
const ORIGIN = 'https://path.hudcostreets.org'

const ROUTES = [
  {
    path: '/bt',
    title: 'PANYNJ Bridge & Tunnel Traffic – Hudson County Complete Streets',
    description: 'Interactive visualizations of monthly vehicle counts at the six PANYNJ bridges and tunnels (GWB, Lincoln, Holland, Bayonne, Goethals, Outerbridge), 2011–present.',
    ogTitle: 'PANYNJ Bridge & Tunnel Traffic',
    ogImage: `${ORIGIN}/og.png`,
  },
  {
    path: '/map',
    title: 'PATH Ridership – Hourly Pie-Map – Hudson County Complete Streets',
    description: 'Interactive map of PATH faregate entries (green) and exits (orange) per station, animated through 24 hours.',
    ogTitle: 'PATH Ridership – Hourly Pie-Map',
    ogImage: `${ORIGIN}/og.png`,
  },
]

function rewrite(html, route) {
  const url = ORIGIN + route.path
  const subs = [
    [/<title>[^<]*<\/title>/, `<title>${route.title}</title>`],
    [/<meta name="description" content="[^"]*"/, `<meta name="description" content="${route.description}"`],
    [/<meta property="og:title" content="[^"]*"/, `<meta property="og:title" content="${route.ogTitle}"`],
    [/<meta property="og:description" content="[^"]*"/, `<meta property="og:description" content="${route.description}"`],
    [/<meta property="og:image" content="[^"]*"/, `<meta property="og:image" content="${route.ogImage}"`],
    [/<meta property="og:url" content="[^"]*"/, `<meta property="og:url" content="${url}"`],
  ]
  let out = html
  for (const [re, replacement] of subs) {
    if (!re.test(out)) throw new Error(`prerender-routes: pattern ${re} not found in dist/index.html`)
    out = out.replace(re, replacement)
  }
  return out
}

const index = await readFile(join(DIST, 'index.html'), 'utf8')
for (const route of ROUTES) {
  const out = join(DIST, route.path.replace(/^\//, ''), 'index.html')
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, rewrite(index, route))
  console.log(`prerender-routes: wrote ${out}`)
}
