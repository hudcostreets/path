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
 *  the dropdown sets it directly. */
import { Param } from "use-prms"

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
const CODE_TO_STATION: Record<string, string> = Object.fromEntries(
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
