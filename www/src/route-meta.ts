/** Per-route `<title>` / description / `og:*` metadata: the single source of
 *  truth for both
 *  - build time: `routeMetaPlugin` (`../vite-route-meta.ts`) emits a
 *    `dist/<route>.html` copy of `index.html` per entry, so crawlers (which
 *    don't run JS) see route-specific tags; Cloudflare Pages serves
 *    `/bt` from `bt.html` with a 200 (and 308s `/bt/`, `/bt.html` → `/bt`),
 *  - run time: `useRouteMeta` keeps `document.title` + meta tags in sync on
 *    client-side navigation.
 *
 *  Pure data (no React / DOM imports): it's also loaded by `vite.config.ts`. */
import { STATIONS } from "./stations"

export const ORIGIN = 'https://pa.hccs.dev'
const SITE_SUFFIX = ' – Hudson County Complete Streets'

export type RouteMeta = {
  path: string
  title: string
  description: string
  ogTitle: string
  ogImage: string
}

export const HOME: RouteMeta = {
  path: '/',
  title: `PATH Ridership Data${SITE_SUFFIX}`,
  description: 'Interactive plots of PATH ridership: daily/monthly/hourly per station, from PANYNJ monthly reports.',
  ogTitle: 'PATH Ridership Data',
  // Plotly-rendered by the `path-data months` DVX stage (1200×630), so it
  // stays fresh as new monthly data lands.
  ogImage: `${ORIGIN}/og.png`,
}

/** Lowercase-kebab slug for `/station/<slug>` (e.g. "Grove Street" →
 *  `grove-street`, "WTC" → `wtc`). */
export function stationSlug(station: string): string {
  return station.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/** Templated metadata for a per-station page. No per-station image yet, so
 *  these fall back to the homepage's all-stations plot. */
export function stationMeta(station: string): RouteMeta {
  return {
    path: `/station/${stationSlug(station)}`,
    title: `${station} – PATH Ridership${SITE_SUFFIX}`,
    description: `PATH ridership at ${station}: monthly weekday/weekend averages and recovery vs. pre-COVID, from PANYNJ monthly reports.`,
    ogTitle: `${station} PATH Station Ridership`,
    ogImage: HOME.ogImage,
  }
}

export const ROUTE_METAS: RouteMeta[] = [
  HOME,
  {
    path: '/bt',
    title: `PANYNJ Bridge & Tunnel Traffic${SITE_SUFFIX}`,
    description: 'Interactive visualizations of monthly vehicle counts at the six PANYNJ bridges and tunnels (GWB, Lincoln, Holland, Bayonne, Goethals, Outerbridge), 2011–present.',
    ogTitle: 'PANYNJ Bridge & Tunnel Traffic',
    // Dedicated dark-mode preview (`scripts/capture-og.ts`, DVX-tracked as
    // `og-bt.png`). PNG beats JPG here — the plot is dominated by flat
    // stacked-bar regions that compress well as PNG (~55 KB vs ~220 KB JPG).
    ogImage: `${ORIGIN}/og-bt.png`,
  },
  {
    path: '/map',
    title: `PATH Ridership – Hourly Pie-Map${SITE_SUFFIX}`,
    description: 'Interactive map of PATH faregate entries (green) and exits (orange) per station, animated through 24 hours.',
    ogTitle: 'PATH Ridership – Hourly Pie-Map',
    // Dedicated preview with map tiles + station pies at 8-9am peak. JPG here
    // — the photo-like tile imagery dominates and cuts the file in half
    // vs. PNG (~244 KB vs ~522 KB).
    ogImage: `${ORIGIN}/og-map.jpg`,
  },
  {
    path: '/airports',
    title: `PANYNJ Airport Traffic${SITE_SUFFIX}`,
    description: 'Monthly passenger, flight, and for-hire-vehicle traffic at the PANYNJ airports (JFK, EWR, LGA, SWF), from PANYNJ Airport Traffic reports.',
    ogTitle: 'PANYNJ Airport Traffic',
    ogImage: HOME.ogImage,
  },
  ...STATIONS.map(stationMeta),
]

const BY_PATH = new Map(ROUTE_METAS.map(m => [m.path, m]))

/** Metadata for a pathname (trailing slash ignored); unknown paths (incl.
 *  `/banner`) get the homepage's. */
export function routeMeta(pathname: string): RouteMeta {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  return BY_PATH.get(path) ?? HOME
}

/** `og:url`: canonical, trailing-slash-free URL. */
export function ogUrl(meta: RouteMeta): string {
  return ORIGIN + meta.path
}
