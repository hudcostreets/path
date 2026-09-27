/** Shared canonical station model + URL param (`?s=`).
 *
 *  `STATIONS` (full names like "Christopher Street") is the canonical form.
 *  Plots that prefer abbreviations ("Christopher St.") translate via
 *  `displayName` for chart/legend labels; the underlying data + URL state
 *  always speak the canonical form.
 *
 *  `activeStations` lives at the page level (see `PathPlots`) and is the
 *  single source of truth for station filtering: empty → all stations,
 *  non-empty subset → filter to those. Legend pins set it to `[clicked]`;
 *  the dropdown sets it directly.
 *
 *  Per-station pages (`/station/<slug>`) are keyed by `STATION_INFO`, which is
 *  also the source of truth for slugs + page titles (e.g. for prerendered
 *  per-route meta / OG images). This module has no runtime imports, so Node
 *  (≥23, type-stripping) can import it directly from build scripts. */
import type { Param } from "use-prms"

export const STATIONS = [
  "Christopher Street",
  "9th Street",
  "14th Street",
  "23rd Street",
  "33rd Street",
  "WTC",
  "Newark",
  "Harrison",
  "Journal Square",
  "Grove Street",
  "Exchange Place",
  "Newport",
  "Hoboken",
] as const
export type Station = typeof STATIONS[number]

export const STATION_COLORS: Record<string, string> = {
  "Christopher Street": "#636efa",
  "9th Street": "#EF553B",
  "14th Street": "#00cc96",
  "23rd Street": "#ab63fa",
  "33rd Street": "#FFA15A",
  "WTC": "#19d3f3",
  "Newark": "#FF6692",
  "Harrison": "#B6E880",
  "Journal Square": "#FF97FF",
  "Grove Street": "#FECB52",
  "Exchange Place": "#636efa",
  "Newport": "#EF553B",
  "Hoboken": "#00cc96",
}

/** Three-letter-ish abbreviations (PATH signage style), used in compact
 *  subtitles / badges. */
export const STATION_ABBREVS: Record<string, string> = {
  "Christopher Street": "CHR",
  "9th Street": "9TH",
  "14th Street": "14TH",
  "23rd Street": "23RD",
  "33rd Street": "33RD",
  "WTC": "WTC",
  "Newark": "NWK",
  "Harrison": "HAR",
  "Journal Square": "JSQ",
  "Grove Street": "GRO",
  "Exchange Place": "EXP",
  "Newport": "NPT",
  "Hoboken": "HOB",
}

// Station groups by state
export const NY_STATIONS = ["Christopher Street", "9th Street", "14th Street", "23rd Street", "33rd Street", "WTC"] as const
export const NJ_STATIONS = ["Newark", "Harrison", "Journal Square", "Grove Street", "Exchange Place", "Newport", "Hoboken"] as const

// Station groups by line (canonical PATH map colors). Used as filter presets
// on the homepage; membership is a superset of weekday stops (e.g. JSQ–33
// includes its nights/weekends "via HOB" stops). See `LINE_ROUTES` for the
// ordered weekday stop sequences.
export const NWK_WTC = ["Newark", "Harrison", "Journal Square", "Grove Street", "Exchange Place", "WTC"] as const
export const JSQ_33 = ["Journal Square", "Grove Street", "Exchange Place", "Newport", "Hoboken", "Christopher Street", "9th Street", "14th Street", "23rd Street", "33rd Street"] as const
export const HOB_33 = ["Hoboken", "Christopher Street", "9th Street", "14th Street", "23rd Street", "33rd Street"] as const
export const HOB_WTC = ["Hoboken", "Newport", "Exchange Place", "WTC"] as const

export type StationGroup = { label: string, color: string, stations: readonly string[] }

export const LINE_GROUPS: StationGroup[] = [
  { label: "NWK–WTC", color: "#D93A30", stations: NWK_WTC },
  { label: "JSQ–33", color: "#F0A81C", stations: JSQ_33 },
  { label: "HOB–33", color: "#0082C6", stations: HOB_33 },
  { label: "HOB–WTC", color: "#00A84F", stations: HOB_WTC },
]

export const REGION_GROUPS: StationGroup[] = [
  { label: "New York", color: "#aaa", stations: NY_STATIONS },
  { label: "New Jersey", color: "#aaa", stations: NJ_STATIONS },
]

/** Ordered weekday stop sequences per PATH line (west/north → east/south),
 *  used for per-station "line neighbors" links + line chips. */
export type LineRoute = { label: string, name: string, color: string, stops: readonly Station[] }
export const LINE_ROUTES: LineRoute[] = [
  { label: "NWK–WTC", name: "Newark – World Trade Center", color: "#D93A30", stops: ["Newark", "Harrison", "Journal Square", "Grove Street", "Exchange Place", "WTC"] },
  { label: "JSQ–33", name: "Journal Square – 33rd Street", color: "#F0A81C", stops: ["Journal Square", "Grove Street", "Newport", "Christopher Street", "9th Street", "14th Street", "23rd Street", "33rd Street"] },
  { label: "HOB–33", name: "Hoboken – 33rd Street", color: "#0082C6", stops: ["Hoboken", "Christopher Street", "9th Street", "14th Street", "23rd Street", "33rd Street"] },
  { label: "HOB–WTC", name: "Hoboken – World Trade Center", color: "#00A84F", stops: ["Hoboken", "Newport", "Exchange Place", "WTC"] },
]

export type StationInfo = {
  /** Canonical name (matches `all.pqt`'s `station` column). */
  station: Station
  /** URL slug: `/station/<slug>`. */
  slug: string
  /** Long-form human name (e.g. "World Trade Center" for "WTC"). */
  title: string
  /** Neighborhood / city blurb. */
  area: string
  state: "NY" | "NJ"
}

/** lowercase-kebab slug from a canonical station name. */
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

const TITLES: Partial<Record<Station, string>> = {
  "WTC": "World Trade Center",
}

const AREAS: Record<Station, string> = {
  "Christopher Street": "West Village, Manhattan",
  "9th Street": "Greenwich Village, Manhattan",
  "14th Street": "Chelsea / Greenwich Village, Manhattan",
  "23rd Street": "Flatiron / Chelsea, Manhattan",
  "33rd Street": "Herald Square, Manhattan",
  "WTC": "Financial District, Manhattan",
  "Newark": "Newark Penn Station, Newark, NJ",
  "Harrison": "Harrison, NJ",
  "Journal Square": "Journal Square, Jersey City, NJ",
  "Grove Street": "Downtown Jersey City, NJ",
  "Exchange Place": "Downtown Jersey City (waterfront), NJ",
  "Newport": "Newport, Jersey City, NJ",
  "Hoboken": "Hoboken Terminal, Hoboken, NJ",
}

export const STATION_INFO: StationInfo[] = STATIONS.map(station => ({
  station,
  slug: slugify(station),
  title: TITLES[station] ?? station,
  area: AREAS[station],
  state: (NY_STATIONS as readonly string[]).includes(station) ? "NY" : "NJ",
}))

const INFO_BY_STATION = new Map<string, StationInfo>(STATION_INFO.map(i => [i.station, i]))
const INFO_BY_SLUG = new Map<string, StationInfo>(STATION_INFO.map(i => [i.slug, i]))

/** Alternate slugs that redirect to the canonical one (abbreviations, and
 *  "world-trade-center"). */
export const SLUG_ALIASES: Record<string, string> = {
  ...Object.fromEntries(STATION_INFO.map(i => [STATION_ABBREVS[i.station].toLowerCase(), i.slug])),
  ...Object.fromEntries(STATION_INFO.filter(i => i.title !== i.station).map(i => [slugify(i.title), i.slug])),
}

export function stationInfo(station: string): StationInfo | undefined {
  return INFO_BY_STATION.get(station)
}

/** Canonical station → `/station/<slug>` path. */
export function stationPath(station: string): string | undefined {
  const info = INFO_BY_STATION.get(station)
  return info ? `/station/${info.slug}` : undefined
}

/** Resolve a URL slug: `{ info }` for a canonical slug, `{ redirect }` (the
 *  canonical slug) for an alias, `{}` for unknown. Case-insensitive. */
export function resolveSlug(slug: string): { info?: StationInfo, redirect?: string } {
  const s = slug.toLowerCase()
  const info = INFO_BY_SLUG.get(s)
  if (info) return s === slug ? { info } : { redirect: s }
  const alias = SLUG_ALIASES[s]
  if (alias) return { redirect: alias }
  return {}
}

/** Lines (weekday routes) serving a station, with the adjacent stops on each. */
export function stationLines(station: string): { line: LineRoute, prev?: Station, next?: Station }[] {
  return LINE_ROUTES.flatMap(line => {
    const i = line.stops.indexOf(station as Station)
    if (i < 0) return []
    return [{ line, prev: line.stops[i - 1], next: line.stops[i + 1] }]
  })
}

/** Short labels shown in chart legends / hovers (some stations abbreviate). */
const STATION_DISPLAY: Record<string, string> = {
  "Christopher Street": "Christopher St",
}
export function displayName(station: string): string {
  return STATION_DISPLAY[station] ?? station
}
export const STATION_FROM_DISPLAY: Record<string, string> = {
  ...Object.fromEntries((STATIONS as readonly string[]).map(s => [s, s])),
  ...Object.fromEntries(Object.entries(STATION_DISPLAY).map(([k, v]) => [v, k])),
}

/** Single-character URL codes per station, so `?s=` stays short. */
export const STATION_CODES: Record<string, string> = {
  "Christopher Street": "c",
  "9th Street": "9",
  "14th Street": "1",
  "23rd Street": "2",
  "33rd Street": "3",
  "WTC": "w",
  "Newark": "n",
  "Harrison": "h",
  "Journal Square": "j",
  "Grove Street": "g",
  "Exchange Place": "x",
  "Newport": "p",
  "Hoboken": "o",
}
export const CODE_TO_STATION: Record<string, string> = Object.fromEntries(
  Object.entries(STATION_CODES).map(([k, v]) => [v, k])
)

/** `?s=` encoding: full-set → omitted, empty-set → `?s=`, subset → codes
 *  (with `-` complement mode when fewer to exclude than include). */
export const stationsParam: Param<string[]> = {
  encode(stations: string[]): string | undefined {
    if (stations.length >= STATIONS.length) return undefined
    if (stations.length === 0) return ''
    const included = stations.map(s => STATION_CODES[s] ?? '').join('')
    const excluded = STATIONS.filter(s => !stations.includes(s)).map(s => STATION_CODES[s]).join('')
    if (excluded.length + 1 < included.length) return `-${excluded}`
    return included
  },
  decode(encoded: string | undefined): string[] {
    if (encoded === undefined) return [...STATIONS]
    if (encoded === '') return []
    if (encoded.startsWith('-')) {
      const excludedCodes = new Set(encoded.slice(1).split(''))
      return STATIONS.filter(s => !excludedCodes.has(STATION_CODES[s]))
    }
    return encoded.split('').map(c => CODE_TO_STATION[c]).filter(Boolean)
  },
}

/** EvE + HourlyPlot + StationsMap use "Christopher St." (period); RidesPlot
 *  uses "Christopher Street". This maps any input to the abbreviated form. */
export function toShortName(station: string | null | undefined): string | null {
  if (!station) return null
  if (station === "Christopher Street") return "Christopher St."
  return station
}

/** Inverse of `toShortName`: "Christopher St." → "Christopher Street". */
export function fromShortName(station: string): string {
  return station === "Christopher St." ? "Christopher Street" : station
}
