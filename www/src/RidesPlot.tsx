import { ToggleButton, ToggleButtonGroup } from "@mui/material"
import ReactJsonView from '@microlink/react-json-view'
import { round } from "@rdub/base/math"
import { useQuery } from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { asyncBufferFromUrl, parquetRead } from "hyparquet"
import { Data, Layout, Legend } from "plotly.js"
import { useActions } from "use-kbd"
import { Param, useUrlState, codeParam } from "use-prms"
import { repelLabels } from "pltly/plotly"
import type { RepelLineObstacle, RepelPoint, RepelRectObstacle } from "pltly/plotly"
import { Plot, blendAvgColor, clean, dark, hovertemplate, hovertemplatePct, rollingAvg, url } from "./plot-utils"
import { StationDropdown } from "./StationDropdown"
import { InfoTip } from "./Tooltip"
import { usePinnedLegend } from "pltly/react"


const STATIONS = [
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

const STATION_COLORS: Record<string, string> = {
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

// Station groups by state
const NY_STATIONS = ["Christopher Street", "9th Street", "14th Street", "23rd Street", "33rd Street", "WTC"] as const
const NJ_STATIONS = ["Newark", "Harrison", "Journal Square", "Grove Street", "Exchange Place", "Newport", "Hoboken"] as const

// Station groups by line (canonical PATH map colors)
const NWK_WTC = ["Newark", "Harrison", "Journal Square", "Grove Street", "Exchange Place", "WTC"] as const
const JSQ_33 = ["Journal Square", "Grove Street", "Exchange Place", "Newport", "Hoboken", "Christopher Street", "9th Street", "14th Street", "23rd Street", "33rd Street"] as const
const HOB_33 = ["Hoboken", "Christopher Street", "9th Street", "14th Street", "23rd Street", "33rd Street"] as const
const HOB_WTC = ["Hoboken", "Newport", "Exchange Place", "WTC"] as const

export type StationGroup = { label: string, color: string, stations: readonly string[] }

const LINE_GROUPS: StationGroup[] = [
  { label: "NWK–WTC", color: "#D93A30", stations: NWK_WTC },
  { label: "JSQ–33", color: "#F0A81C", stations: JSQ_33 },
  { label: "HOB–33", color: "#0082C6", stations: HOB_33 },
  { label: "HOB–WTC", color: "#00A84F", stations: HOB_WTC },
]

const REGION_GROUPS: StationGroup[] = [
  { label: "New York", color: "#aaa", stations: NY_STATIONS },
  { label: "New Jersey", color: "#aaa", stations: NJ_STATIONS },
]

export type Metric = "avg" | "total" | "pct2019"
type GroupBy = "daytype" | "station"
type TimeRange = "all" | "recent"
type LegendMode = "solo" | "highlight"

const metricParam = codeParam<Metric>("avg", { avg: "a", total: "t", pct2019: "p" })
const groupByParam = codeParam<GroupBy>("station", { daytype: "d", station: "s" })
const timeRangeParam = codeParam<TimeRange>("all", { all: "a", recent: "p" })
const legendModeParam = codeParam<LegendMode>("highlight", { solo: "s", highlight: "h" })

type Exclusion = { station: string, month: string }

const DEFAULT_EXCLUSIONS: Exclusion[] = [
  { station: "Christopher Street", month: "2016-08" },
  { station: "Christopher Street", month: "2016-10" },
  { station: "Christopher Street", month: "2018-08" },
  { station: "Christopher Street", month: "2018-10" },
]

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

function formatExclusion(e: Exclusion): string {
  const abbrev = STATION_ABBREVS[e.station] ?? e.station
  const [y, m] = e.month.split('-')
  return `${abbrev} ${MONTH_NAMES[parseInt(m) - 1]} '${y.slice(2)}`
}

function exclusionsEqual(a: Exclusion[], b: Exclusion[]): boolean {
  if (a.length !== b.length) return false
  const setA = new Set(a.map(e => `${e.station}|${e.month}`))
  return b.every(e => setA.has(`${e.station}|${e.month}`))
}

const baselineYearsParam: Param<number> = {
  encode(n: number): string | undefined {
    return n === 3 ? undefined : String(n)
  },
  decode(encoded: string | undefined): number {
    if (encoded === undefined) return 3
    const n = parseInt(encoded)
    return isNaN(n) || n < 1 || n > 8 ? 3 : n
  },
}

const exclusionsParam: Param<Exclusion[]> = {
  encode(excl: Exclusion[]): string | undefined {
    if (exclusionsEqual(excl, DEFAULT_EXCLUSIONS)) return undefined
    if (excl.length === 0) return ''
    return excl.map(e => {
      const code = STATION_CODES[e.station]
      const [y, m] = e.month.split('-')
      return `${code}${y.slice(2)}${m}`
    }).join('')
  },
  decode(encoded: string | undefined): Exclusion[] {
    if (encoded === undefined) return [...DEFAULT_EXCLUSIONS]
    if (encoded === '') return []
    const result: Exclusion[] = []
    for (let i = 0; i + 5 <= encoded.length; i += 5) {
      const station = CODE_TO_STATION[encoded[i]]
      if (!station) continue
      const yy = encoded.slice(i + 1, i + 3)
      const mm = encoded.slice(i + 3, i + 5)
      result.push({ station, month: `20${yy}-${mm}` })
    }
    return result
  },
}

const STATION_ABBREVS: Record<string, string> = {
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

const STATION_CODES: Record<string, string> = {
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

// Custom param with `-` complement mode: `-abc` means "all except a, b, c"
// Max URL length: 7 chars (for 7 of 13 stations) vs 12 without complement
const stationsParam: Param<string[]> = {
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

const DAY_TYPES = ["weekday", "weekend", "holiday"] as const
type DayType = typeof DAY_TYPES[number]

const DAY_TYPE_COLORS: Record<string, string> = {
  weekday: "#ef4444",
  weekend: "#3b82f6",
  holiday: "#10b981",
}
const DAY_TYPE_LABELS: Record<string, string> = {
  weekday: "Weekday",
  weekend: "Weekend",
  holiday: "Holiday",
}

const DAY_TYPE_CODES: Record<string, string> = {
  weekday: "w",
  weekend: "e",
  holiday: "h",
}
const CODE_TO_DAY_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(DAY_TYPE_CODES).map(([k, v]) => [v, k])
)

const dayTypesParam: Param<string[]> = {
  encode(types: string[]): string | undefined {
    if (types.length === 2 && types.includes("weekday") && types.includes("weekend")) return undefined
    if (types.length === 0) return ''
    return types.map(t => DAY_TYPE_CODES[t]).join('')
  },
  decode(encoded: string | undefined): string[] {
    if (encoded === undefined) return ["weekday", "weekend"]
    if (encoded === '') return []
    return encoded.split('').map(c => CODE_TO_DAY_TYPE[c]).filter(Boolean)
  },
}

type StationData = {
  months: Date[]
  avg_weekday: number[]
  avg_weekend: number[]
  avg_holiday: number[]
  total_weekday: number[]
  total_weekend: number[]
  total_holiday: number[]
}

// Per-station baselines: baselines[col][calMonth] = average value over baseline years
type StationBaseline = Record<MetricDayTypeCol, number[]>

type ProcessedData = {
  stations: Map<string, StationData>
  aggregate: StationData
  firstPostBaselineIdx: number
}

type RawRow = {
  month: string
  station: string
  avg_weekday: number
  avg_weekend: number
  avg_holiday: number
  total_weekday: number
  total_weekend: number
  total_holiday: number
}

function processData(rows: RawRow[]): ProcessedData {
  const stationMap = new Map<string, {
    months: string[]
    avg_weekday: number[], avg_weekend: number[], avg_holiday: number[]
    total_weekday: number[], total_weekend: number[], total_holiday: number[]
  }>()
  for (const row of rows) {
    let entry = stationMap.get(row.station)
    if (!entry) {
      entry = {
        months: [],
        avg_weekday: [], avg_weekend: [], avg_holiday: [],
        total_weekday: [], total_weekend: [], total_holiday: [],
      }
      stationMap.set(row.station, entry)
    }
    entry.months.push(row.month)
    entry.avg_weekday.push(row.avg_weekday)
    entry.avg_weekend.push(row.avg_weekend)
    entry.avg_holiday.push(row.avg_holiday)
    entry.total_weekday.push(row.total_weekday)
    entry.total_weekend.push(row.total_weekend)
    entry.total_holiday.push(row.total_holiday)
  }

  // Build aggregate by summing across stations per month
  const monthOrder: string[] = []
  const monthSums = new Map<string, {
    avg_weekday: number, avg_weekend: number, avg_holiday: number,
    total_weekday: number, total_weekend: number, total_holiday: number,
  }>()
  for (const row of rows) {
    let sums = monthSums.get(row.month)
    if (!sums) {
      sums = {
        avg_weekday: 0, avg_weekend: 0, avg_holiday: 0,
        total_weekday: 0, total_weekend: 0, total_holiday: 0,
      }
      monthSums.set(row.month, sums)
      monthOrder.push(row.month)
    }
    sums.avg_weekday += row.avg_weekday
    sums.avg_weekend += row.avg_weekend
    sums.avg_holiday += row.avg_holiday
    sums.total_weekday += row.total_weekday
    sums.total_weekend += row.total_weekend
    sums.total_holiday += row.total_holiday
  }

  const aggData: Omit<StationData, 'months'> & { months: Date[] } = {
    months: [],
    avg_weekday: [], avg_weekend: [], avg_holiday: [],
    total_weekday: [], total_weekend: [], total_holiday: [],
  }

  const parseMonth = (m: string): Date => {
    const [yr, mo] = /^(\d{4})-(\d{2})$/.exec(m)!.slice(1, 3).map(i => parseInt(i))
    return new Date(yr, mo - 1, 1)
  }

  for (const m of monthOrder) {
    const sums = monthSums.get(m)!
    aggData.months.push(parseMonth(m))
    aggData.avg_weekday.push(sums.avg_weekday)
    aggData.avg_weekend.push(sums.avg_weekend)
    aggData.avg_holiday.push(sums.avg_holiday)
    aggData.total_weekday.push(sums.total_weekday)
    aggData.total_weekend.push(sums.total_weekend)
    aggData.total_holiday.push(sums.total_holiday)
  }

  const stations = new Map<string, StationData>()
  for (const [name, data] of stationMap) {
    stations.set(name, {
      months: data.months.map(parseMonth),
      avg_weekday: data.avg_weekday,
      avg_weekend: data.avg_weekend,
      avg_holiday: data.avg_holiday,
      total_weekday: data.total_weekday,
      total_weekend: data.total_weekend,
      total_holiday: data.total_holiday,
    })
  }

  // Find first post-baseline month index (Jan 2020)
  const firstPostBaselineIdx = aggData.months.findIndex(m => m.getFullYear() >= 2020)

  return {
    stations,
    aggregate: aggData,
    firstPostBaselineIdx,
  }
}

const BASELINE_COLS: MetricDayTypeCol[] = ["avg_weekday", "avg_weekend", "avg_holiday", "total_weekday", "total_weekend", "total_holiday"]

function computeBaselines(
  stations: Map<string, StationData>,
  nYears: number,
  exclusions: Exclusion[],
): Map<string, StationBaseline> {
  const startYear = 2019 - nYears + 1
  const excludeSet = new Set(exclusions.map(e => `${e.station}|${e.month}`))
  const baselines = new Map<string, StationBaseline>()
  for (const [name, sd] of stations) {
    const bl = {} as StationBaseline
    for (const col of BASELINE_COLS) {
      const sums = new Array(12).fill(0)
      const counts = new Array(12).fill(0)
      for (let i = 0; i < sd.months.length; i++) {
        const m = sd.months[i]
        const yr = m.getFullYear()
        if (yr < startYear || yr > 2019) continue
        const mm = String(m.getMonth() + 1).padStart(2, '0')
        if (excludeSet.has(`${name}|${yr}-${mm}`)) continue
        const mo = m.getMonth()
        sums[mo] += sd[col][i]
        counts[mo]++
      }
      bl[col] = sums.map((sum, mo) => counts[mo] > 0 ? sum / counts[mo] : 0)
    }
    baselines.set(name, bl)
  }
  return baselines
}

const NUM_STATIONS = STATIONS.length

export function stationSubtitle(stations: string[]): string {
  if (stations.length === 0 || stations.length >= NUM_STATIONS) return ""
  if (stations.length === 1) return stations[0]
  return stations.map(s => STATION_ABBREVS[s] ?? s).join(", ")
}

type MetricDayTypeCol = `${"avg" | "total"}_${DayType}`

function colName(metric: "avg" | "total", dayType: string): MetricDayTypeCol {
  return `${metric}_${dayType}` as MetricDayTypeCol
}

function sumAcrossDayTypes(
  sd: StationData,
  metric: "avg" | "total",
  dayTypes: string[],
  idx: number,
): number {
  let sum = 0
  for (const dt of dayTypes) {
    sum += sd[colName(metric, dt)][idx]
  }
  return sum
}

/** Sort traces by last y-value descending so legend order matches visual trace order */
function sortTracesByLastY(traces: Data[]): Data[] {
  return [...traces].sort((a, b) => {
    const ay = (a as any).y as number[]
    const by = (b as any).y as number[]
    const lastA = ay?.[ay.length - 1] ?? 0
    const lastB = by?.[by.length - 1] ?? 0
    return lastB - lastA
  })
}

const PLOT_HEIGHT = 450
const NARROW_MARGIN = { t: 0, r: 0, b: 50, l: 30 }
const WIDE_MARGIN = { t: 0, r: 0, b: 40, l: 40 }

/** Build repel-aware annotations for line-chart endpoints.
 *  Uses pltly's repel solver with trace line obstacles. */
function endpointAnnotations(
  traces: { label: string, x: Date[], y: number[] }[],
  formatY: (v: number) => string,
  xRange: [number, number],
  legendRect?: RepelRectObstacle,
): Partial<import("plotly.js").Annotations>[] {
  if (traces.length < 2) return []
  const n = traces[0].x.length
  if (n < 2) return []
  const lastMonth = traces[0].x[n - 1]
  let lastMoStr = lastMonth.toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
  lastMoStr = `${lastMoStr.substring(0, lastMoStr.length - 2)}'${lastMoStr.substring(lastMoStr.length - 2)}`

  const points: RepelPoint[] = traces.map(t => ({
    x: t.x[n - 1].getTime(),
    y: t.y[n - 1],
    markerSize: 6,
    text: `${lastMoStr}<br>${formatY(t.y[n - 1])}`,
  }))

  // Line obstacles: last ~8 segments of each trace
  const segStart = Math.max(0, n - 9)
  const lineObstacles: RepelLineObstacle[] = []
  for (const t of traces) {
    for (let i = segStart; i < n - 1; i++) {
      lineObstacles.push({
        x0: t.x[i].getTime(),
        y0: t.y[i],
        x1: t.x[i + 1].getTime(),
        y1: t.y[i + 1],
        buffer: 16,
      })
    }
  }

  // Compute y-range from the visible trace data
  const allY = traces.flatMap(t => t.y.filter(v => v != null && isFinite(v)))
  const yMin = Math.min(...allY)
  const yMax = Math.max(...allY)
  const yPad = (yMax - yMin) * 0.15
  const yRange: [number, number] = [yMin - yPad, yMax + yPad]

  const narrow = typeof window !== 'undefined' && window.innerWidth < 600
  const plotWidth = typeof window !== 'undefined' ? Math.min(window.innerWidth, 1200) : 1000
  const margin = narrow ? NARROW_MARGIN : WIDE_MARGIN

  const rectObstacles: RepelRectObstacle[] = legendRect ? [legendRect] : []

  const { annotations } = repelLabels(points, {
    plotWidth,
    plotHeight: PLOT_HEIGHT,
    xRange,
    yRange,
    margin,
    fontSize: 12,
    standoff: 6,
    textColor: dark ? '#e4e4e4' : '#333',
    connectors: { color: '#888', width: 1 },
    lineObstacles,
    rectObstacles,
    distanceFactors: [1, 1.5, 2, 2.8, 4],
    numCandidates: 24,
  })
  return annotations
}

function buildByStation(
  processed: ProcessedData,
  baselines: Map<string, StationBaseline>,
  metric: Metric,
  dayTypes: string[],
  selectedStations: string[],
  legend: { activeItem: string | null, isAllSelected: boolean, isFaded: (name: string) => boolean },
  legendMode: LegendMode,
  timeRange: TimeRange,
  activeYear: string | null,
): { data: Data[], layout: Partial<Layout> } {
  const { stations, aggregate, firstPostBaselineIdx } = processed
  const { months } = aggregate
  const activeStns = selectedStations.length > 0 ? selectedStations : [...STATIONS] as string[]
  const isRecent = timeRange === "recent"

  const isSolo = legendMode === "solo"

  if (metric === "pct2019") {
    const vs2019Months = months.slice(firstPostBaselineIdx)
    const traces: Data[] = (STATIONS as readonly string[]).map(station => {
        const sd = stations.get(station)
        const bl = baselines.get(station)
        if (!sd || !bl) return null
        const faded = legend.isFaded(station)
        const pcts = vs2019Months.map((m, i) => {
          const idx = firstPostBaselineIdx + i
          const mo = m.getMonth()
          const cur = sumAcrossDayTypes(sd, "total", dayTypes, idx)
          let base = 0
          for (const dt of dayTypes) base += bl[colName("total", dt)][mo]
          return base > 0 ? cur / base : null
        })
        return {
          name: station,
          x: vs2019Months,
          y: pcts,
          type: "scatter",
          mode: "lines",
          line: { color: STATION_COLORS[station], width: !faded && legend.activeItem ? 5 : 2 },
          hovertemplate: hovertemplatePct,
          zorder: faded ? 1 : 100,
          ...(faded && isSolo ? { visible: 'legendonly' as const } : {}),
          ...(faded && !isSolo ? { opacity: 0.4 } : {}),
        } as Data
      }).filter((d): d is Data => d !== null)

    return {
      data: sortTracesByLastY(traces),
      layout: {
        xaxis: {
          dtick: window.innerWidth < 600 ? "M6" : "M3",
          tickformat: "%b '%y",
          tickangle: -45,
          range: [vs2019Months[0], vs2019Months[vs2019Months.length - 1]],
        },
        yaxis: {
          tickformat: ',.0%',
        },
        shapes: [{
          type: 'line' as const,
          xref: 'paper' as const,
          x0: 0, y0: 1, x1: 1, y1: 1,
          line: { color: '#777', width: 1 },
        }],
      },
    }
  }

  if (metric === "total") {
    const isSolo = legendMode === "solo"
    const yearNum = activeYear && !legend.activeItem ? parseInt(activeYear) : null
    const barData: Data[] = (STATIONS as readonly string[]).map(station => {
      const sd = stations.get(station)
      if (!sd) return null
      const faded = legend.isFaded(station)
      const ys = sd.months.map((_, i) => sumAcrossDayTypes(sd, "total", dayTypes, i))
      const yearOpacity = yearNum
        ? sd.months.map(m => m.getFullYear() === yearNum ? 1 : 0.15)
        : undefined
      return {
        name: station,
        type: "bar",
        x: sd.months,
        y: faded && isSolo ? ys.map(() => 0) : ys,
        marker: {
          color: STATION_COLORS[station],
          ...(yearOpacity ? { opacity: yearOpacity } : {}),
        },
        ...(faded && isSolo ? { hoverinfo: "skip" as const } : { hovertemplate }),
        ...(faded ? { opacity: 0.4 } : {}),
      } as Data
    }).filter((d): d is Data => d !== null)

    const activeStation = legend.activeItem
    const avgItems = legend.isAllSelected ? [...STATIONS] as string[] : selectedStations
    const avgSource = activeStation
      ? stations.get(activeStation)?.months.map((_, i) => sumAcrossDayTypes(stations.get(activeStation)!, "total", dayTypes, i)) ?? []
      : months.map((_, i) => {
          let sum = 0
          for (const s of avgItems) {
            const sd = stations.get(s)
            if (sd) sum += sumAcrossDayTypes(sd, "total", dayTypes, i)
          }
          return sum
        })
    const avg12 = rollingAvg(avgSource, 12)
    const avgColor = activeStation
      ? blendAvgColor(STATION_COLORS[activeStation], 0.5)
      : (dark ? "rgba(255,255,255,0.7)" : "rgba(0,0,0,0.7)")
    const avgTrace: Data = {
      name: "12mo avg",
      x: months,
      y: avg12,
      type: "scatter",
      mode: "lines",
      line: { color: avgColor, width: 4 },
      hovertemplate,
      showlegend: false,
      connectgaps: false,
    }

    const allTimeRange = ['2011-12-17', '2025-12-17']
    const recentRange = ['2019-12-17', '2025-12-17']
    return {
      data: [...barData, avgTrace],
      layout: {
        barmode: "relative",
        xaxis: {
          range: isRecent ? recentRange : allTimeRange,
          dtick: isRecent ? "M3" : "M12",
          tickformat: isRecent ? "%b '%y" : "'%y",
          hoverformat: "%b '%y",
          tickangle: -45,
        },
        yaxis: {
          hoverformat: ",.0f",
        },
        legend: { entrywidth: 100, traceorder: "reversed" } as Partial<Legend>,
      },
    }
  }

  // metric === "avg", grouped by station: lines per station
  const traces: Data[] = (STATIONS as readonly string[]).map(station => {
      const sd = stations.get(station)
      if (!sd) return null
      const faded = legend.isFaded(station)
      const ys = sd.months.map((_, i) => sumAcrossDayTypes(sd, "avg", dayTypes, i))
      return {
        name: station,
        x: sd.months,
        y: ys,
        type: "scatter",
        mode: "lines",
        line: { color: STATION_COLORS[station], width: !faded && legend.activeItem ? 5 : 2 },
        hovertemplate,
        zorder: faded ? 1 : 100,
        ...(faded && isSolo ? { visible: 'legendonly' as const } : {}),
        ...(faded && !isSolo ? { opacity: 0.4 } : {}),
      } as Data
    }).filter((d): d is Data => d !== null)

  const allTimeRange = ['2011-12-17', '2025-12-17']
  const recentRange = ['2019-12-17', '2025-12-17']
  return {
    data: sortTracesByLastY(traces),
    layout: {
      xaxis: {
        range: isRecent ? recentRange : allTimeRange,
        dtick: isRecent ? "M3" : "M12",
        tickformat: isRecent ? "%b '%y" : "'%y",
        hoverformat: "%b '%y",
        tickangle: -45,
      },
      legend: { entrywidth: 100 } as Partial<Legend>,
    },
  }
}

function buildByDayType(
  processed: ProcessedData,
  baselines: Map<string, StationBaseline>,
  metric: Metric,
  dayTypes: string[],
  selectedStations: string[],
  legend: { activeItem: string | null, isAllSelected: boolean, isFaded: (name: string) => boolean },
  legendMode: LegendMode,
  timeRange: TimeRange,
  activeYear: string | null,
): { data: Data[], layout: Partial<Layout> } {
  const { stations, aggregate, firstPostBaselineIdx } = processed
  const { months } = aggregate
  const activeStns = selectedStations.length > 0 ? selectedStations : [...STATIONS] as string[]
  const isRecent = timeRange === "recent"
  const baseMetric: "avg" | "total" = metric === "pct2019" ? "avg" : metric
  const isSolo = legendMode === "solo"

  // Aggregate across selected stations for each day type
  function sumForDayType(dayType: string, idx: number): number {
    let sum = 0
    for (const s of activeStns) {
      const sd = stations.get(s)
      if (sd) sum += sd[colName(baseMetric, dayType)][idx]
    }
    return sum
  }

  // Aggregate baseline across selected stations for a day type + calendar month
  function baselineForDayType(dayType: string, calMonth: number): number {
    let sum = 0
    for (const s of activeStns) {
      const bl = baselines.get(s)
      if (bl) sum += bl[colName(baseMetric, dayType)][calMonth]
    }
    return sum
  }

  if (metric === "pct2019") {
    const vs2019Months = months.slice(firstPostBaselineIdx)
    const traceData = dayTypes.map(dt => ({
      label: DAY_TYPE_LABELS[dt],
      x: vs2019Months,
      y: vs2019Months.map((m, i) => {
        const idx = firstPostBaselineIdx + i
        const mo = m.getMonth()
        const cur = sumForDayType(dt, idx)
        const base = baselineForDayType(dt, mo)
        return base > 0 ? cur / base : 0
      }),
    }))
    const traces: Data[] = traceData.map((td, i) => {
      const dt = dayTypes[i]
      const faded = legend.isFaded(td.label)
      return {
        name: td.label,
        x: td.x,
        y: td.y,
        type: "scatter",
        mode: "lines",
        line: { color: DAY_TYPE_COLORS[dt], width: !faded && legend.activeItem ? 5 : 2 },
        hovertemplate: hovertemplatePct,
        zorder: faded ? 1 : 100,
        ...(faded && isSolo ? { visible: 'legendonly' as const } : {}),
        ...(faded && !isSolo ? { opacity: 0.4 } : {}),
      } as Data
    })

    const pctXRange: [number, number] = [vs2019Months[0].getTime(), vs2019Months[vs2019Months.length - 1].getTime()]
    const annotations = traceData.length >= 2
      ? endpointAnnotations(traceData, v => `${round(v * 1000) / 10}%`, pctXRange)
      : []

    return {
      data: sortTracesByLastY(traces),
      layout: {
        xaxis: {
          dtick: window.innerWidth < 600 ? "M6" : "M3",
          tickformat: "%b '%y",
          tickangle: -45,
          range: [vs2019Months[0], vs2019Months[vs2019Months.length - 1]],
        },
        yaxis: {
          tickformat: ',.0%',
        },
        legend: {
          yanchor: "bottom" as const, y: 0.03,
          xanchor: "right" as const, x: 0.99,
        },
        annotations,
        shapes: [{
          type: 'line' as const,
          xref: 'paper' as const,
          x0: 0, y0: 1, x1: 1, y1: 1,
          line: { color: '#777', width: 1 },
        }],
      },
    }
  }

  if (metric === "total") {
    const isSolo = legendMode === "solo"
    const yearNum = activeYear && !legend.activeItem ? parseInt(activeYear) : null
    const barData: Data[] = dayTypes.map(dt => {
      const faded = legend.isFaded(DAY_TYPE_LABELS[dt])
      const ys = months.map((_, i) => sumForDayType(dt, i))
      const yearOpacity = yearNum
        ? months.map(m => m.getFullYear() === yearNum ? 1 : 0.15)
        : undefined
      return {
        name: DAY_TYPE_LABELS[dt],
        type: "bar",
        x: months,
        y: faded && isSolo ? ys.map(() => 0) : ys,
        marker: {
          color: DAY_TYPE_COLORS[dt],
          ...(yearOpacity ? { opacity: yearOpacity } : {}),
        },
        ...(faded && isSolo ? { hoverinfo: "skip" as const } : { hovertemplate }),
        ...(faded ? { opacity: 0.4 } : {}),
      } as Data
    })

    const activeDayType = legend.activeItem
    const activeDt = activeDayType
      ? Object.entries(DAY_TYPE_LABELS).find(([, v]) => v === activeDayType)?.[0]
      : null
    const avgSource = activeDt
      ? months.map((_, i) => sumForDayType(activeDt, i))
      : months.map((_, i) => {
          let sum = 0
          for (const dt of dayTypes) sum += sumForDayType(dt, i)
          return sum
        })
    const avg12 = rollingAvg(avgSource, 12)
    const avgColor = activeDt
      ? blendAvgColor(DAY_TYPE_COLORS[activeDt], 0.5)
      : (dark ? "rgba(255,255,255,0.7)" : "rgba(0,0,0,0.7)")
    const avgTrace: Data = {
      name: "12mo avg",
      x: months,
      y: avg12,
      type: "scatter",
      mode: "lines",
      line: { color: avgColor, width: 4 },
      hovertemplate,
      showlegend: false,
      connectgaps: false,
    }

    const allTimeRange = ['2011-12-17', '2025-12-17']
    const recentRange = ['2019-12-17', '2025-12-17']
    return {
      data: [...barData, avgTrace],
      layout: {
        barmode: "relative",
        xaxis: {
          range: isRecent ? recentRange : allTimeRange,
          dtick: isRecent ? "M3" : "M12",
          tickformat: isRecent ? "%b '%y" : "'%y",
          hoverformat: "%b '%y",
          tickangle: -45,
        },
        yaxis: {
          hoverformat: ",.0f",
        },
        legend: { traceorder: "reversed" } as Partial<Legend>,
      },
    }
  }

  // metric === "avg", grouped by day type: lines per day type
  const n = months.length
  const traceData = dayTypes.map(dt => ({
    label: DAY_TYPE_LABELS[dt],
    x: months,
    y: months.map((_, i) => sumForDayType(dt, i)),
  }))
  const traces: Data[] = traceData.map((td, i) => {
    const dt = dayTypes[i]
    const faded = legend.isFaded(td.label)
    return {
      name: td.label,
      x: td.x,
      y: td.y,
      line: { color: DAY_TYPE_COLORS[dt], width: !faded && legend.activeItem ? 5 : 2 },
      hovertemplate,
      zorder: faded ? 1 : 100,
      ...(faded && isSolo ? { visible: 'legendonly' as const } : {}),
      ...(faded && !isSolo ? { opacity: 0.4 } : {}),
    } as Data
  })

  const avgXRange: [number, number] = isRecent
    ? [new Date(2019, 11, 17).getTime(), new Date(2025, 11, 17).getTime()]
    : [new Date(2011, 11, 17).getTime(), new Date(2025, 11, 17).getTime()]
  const annotations = traceData.length >= 2
    ? endpointAnnotations(traceData, v => round(v).toLocaleString(), avgXRange)
    : []

  return {
    data: sortTracesByLastY(traces),
    layout: {
      xaxis: {
        dtick: isRecent ? "M3" : "M12",
        tickformat: isRecent ? "%b '%y" : "'%y",
        hoverformat: "%b '%y",
        tickangle: -45,
        ...(isRecent ? { range: ['2019-12-17', '2025-12-17'] } : {}),
      },
      legend: {
        yanchor: "top" as const, y: 0.99,
        xanchor: "right" as const, x: 0.99,
      },
      annotations,
    },
  }
}

export default function RidesPlot({ onEffectiveStationsChange, onEffectiveDayTypesChange, onMetricChange, activeYear }: {
  onEffectiveStationsChange?: (stations: string[]) => void
  onEffectiveDayTypesChange?: (dayTypes: string[]) => void
  onMetricChange?: (metric: Metric) => void
  activeYear?: string | null
} = {}) {
  const [metric, setMetric] = useUrlState<Metric>("m", metricParam)
  const [groupBy, setGroupBy] = useUrlState<GroupBy>("g", groupByParam)
  const [timeRange, setTimeRange] = useUrlState<TimeRange>("t", timeRangeParam)
  const [urlStations, setUrlStations] = useUrlState<string[]>("s", stationsParam)
  const [urlDayTypes, setUrlDayTypes] = useUrlState<string[]>("d", dayTypesParam)
  // Immediate local state for UI; URL syncs on a debounce
  const [selectedStations, setSelectedStationsRaw] = useState<string[]>(urlStations)
  const [selectedDayTypes, setSelectedDayTypesRaw] = useState<string[]>(urlDayTypes)
  const stationUrlTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const dayTypeUrlTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const setSelectedStations = useCallback((stations: string[]) => {
    setSelectedStationsRaw(stations)
    clearTimeout(stationUrlTimerRef.current)
    stationUrlTimerRef.current = setTimeout(() => setUrlStations(stations), 300)
  }, [setUrlStations])
  const setSelectedDayTypes = useCallback((dayTypes: string[]) => {
    setSelectedDayTypesRaw(dayTypes)
    clearTimeout(dayTypeUrlTimerRef.current)
    dayTypeUrlTimerRef.current = setTimeout(() => setUrlDayTypes(dayTypes), 300)
  }, [setUrlDayTypes])
  const [legendMode, setLegendMode] = useUrlState<LegendMode>("l", legendModeParam)
  const [baselineYears, setBaselineYears] = useUrlState<number>("b", baselineYearsParam)
  const [exclusions, setExclusions] = useUrlState<Exclusion[]>("x", exclusionsParam)
  // Force time range to recent when pct2019
  const effectiveTimeRange = metric === "pct2019" ? "recent" : timeRange

  // Shared containerRef for both legend instances
  const sharedContainerRef = useRef<HTMLDivElement>(null)

  const stationLegend = usePinnedLegend({
    allItems: STATIONS,
    selectedItems: selectedStations,
    setSelectedItems: setSelectedStations,
    active: groupBy === "station",
    containerRef: sharedContainerRef,
    unpinExcludeSelectors: ['.baseline-controls'],
  })

  const dayTypeLegend = usePinnedLegend({
    allItems: DAY_TYPES as unknown as string[],
    selectedItems: selectedDayTypes,
    setSelectedItems: setSelectedDayTypes,
    nameMap: DAY_TYPE_LABELS,
    active: groupBy === "daytype",
    containerRef: sharedContainerRef,
  })

  const legend = groupBy === "station" ? stationLegend : dayTypeLegend

  const selectGroup = useCallback((group: readonly string[]) => {
    stationLegend.onPickerChange([...group])
  }, [stationLegend.onPickerChange])

  useActions({
    'stations:all': {
      label: 'All stations',
      group: 'Stations',
      defaultBindings: ['s a'],
      handler: () => stationLegend.onPickerChange([...STATIONS]),
    },
    'stations:none': {
      label: 'No stations (aggregate)',
      group: 'Stations',
      defaultBindings: ['s 0'],
      handler: () => stationLegend.onPickerChange([]),
    },
    'stations:ny': {
      label: 'New York stations',
      group: 'Stations',
      keywords: ['manhattan'],
      defaultBindings: ['s y'],
      handler: () => selectGroup(NY_STATIONS),
    },
    'stations:nj': {
      label: 'New Jersey stations',
      group: 'Stations',
      keywords: ['jersey city', 'hoboken', 'newark'],
      defaultBindings: ['s j'],
      handler: () => selectGroup(NJ_STATIONS),
    },
    'stations:nwk-wtc': {
      label: 'NWK\u2013WTC line',
      group: 'Stations',
      keywords: ['newark', 'world trade center'],
      defaultBindings: ['s n'],
      handler: () => selectGroup(NWK_WTC),
    },
    'stations:jsq-33': {
      label: 'JSQ\u201333 line',
      group: 'Stations',
      keywords: ['journal square', '33rd'],
      defaultBindings: ['s q'],
      handler: () => selectGroup(JSQ_33),
    },
    'stations:hob-33': {
      label: 'HOB\u201333 line',
      group: 'Stations',
      keywords: ['hoboken', '33rd'],
      defaultBindings: ['s h'],
      handler: () => selectGroup(HOB_33),
    },
    'stations:hob-wtc': {
      label: 'HOB\u2013WTC line',
      group: 'Stations',
      keywords: ['hoboken', 'world trade center'],
      defaultBindings: ['s w'],
      handler: () => selectGroup(HOB_WTC),
    },
    'metric:avg': {
      label: 'Avg/day metric',
      group: 'Controls',
      defaultBindings: ['m a'],
      handler: () => setMetric("avg"),
    },
    'metric:total': {
      label: 'Total metric',
      group: 'Controls',
      defaultBindings: ['m t'],
      handler: () => setMetric("total"),
    },
    'metric:pct2019': {
      label: '% of 2019 metric',
      group: 'Controls',
      defaultBindings: ['m p'],
      handler: () => setMetric("pct2019"),
    },
    'groupby:daytype': {
      label: 'Group by day type',
      group: 'Controls',
      defaultBindings: ['g d'],
      handler: () => setGroupBy("daytype"),
    },
    'groupby:station': {
      label: 'Group by station',
      group: 'Controls',
      defaultBindings: ['g s'],
      handler: () => setGroupBy("station"),
    },
    'time:all': {
      label: 'All time',
      group: 'Controls',
      defaultBindings: ['t a'],
      handler: () => setTimeRange("all"),
    },
    'time:recent': {
      label: '2020\u2013Present',
      group: 'Controls',
      defaultBindings: ['t r'],
      handler: () => setTimeRange("recent"),
    },
  })

  const { data: processed, isError, error } = useQuery({
    queryKey: ['rides', url],
    refetchOnWindowFocus: false,
    refetchInterval: false,
    queryFn: async () => {
      const file = await asyncBufferFromUrl({ url })
      const raw: Record<string, unknown>[] = []
      await parquetRead({
        file,
        columns: ['month', 'station', 'avg weekday', 'avg weekend', 'avg holiday', 'total weekday', 'total weekend', 'total holiday'],
        rowFormat: 'object',
        onComplete: data => raw.push(...data),
      })
      const rows: RawRow[] = raw
        .map(r => ({
          month: r['month'] as string,
          station: r['station'] as string,
          avg_weekday: (r['avg weekday'] as number) || 0,
          avg_weekend: (r['avg weekend'] as number) || 0,
          avg_holiday: (r['avg holiday'] as number) || 0,
          total_weekday: (r['total weekday'] as number) || 0,
          total_weekend: (r['total weekend'] as number) || 0,
          total_holiday: (r['total holiday'] as number) || 0,
        }))
        .sort((a, b) => a.month.localeCompare(b.month) || a.station.localeCompare(b.station))
      return processData(rows)
    },
  })

  const effectiveStations = stationLegend.effectiveItems
  const effectiveDayTypes = dayTypeLegend.effectiveItems

  useEffect(() => {
    onEffectiveStationsChange?.(effectiveStations)
  }, [effectiveStations, onEffectiveStationsChange])

  useEffect(() => {
    onMetricChange?.(metric)
  }, [metric, onMetricChange])

  useEffect(() => {
    onEffectiveDayTypesChange?.(effectiveDayTypes)
  }, [effectiveDayTypes, onEffectiveDayTypesChange])

  // Subtitle: badge-style facets with individual × clear buttons
  const subtitle = useMemo(() => {
    const badges: React.ReactNode[] = []
    const stSub = stationSubtitle(effectiveStations)
    if (stSub) {
      badges.push(
        <span key="stations" className="filter-badge">
          {stSub}
          <span className="clear-filter" onClick={() => stationLegend.clearPin()}>&times;</span>
        </span>
      )
    }
    if (effectiveDayTypes.length < DAY_TYPES.length && effectiveDayTypes.length > 0) {
      const dtText = effectiveDayTypes.map(dt => DAY_TYPE_LABELS[dt] ?? dt).join(", ")
      badges.push(
        <span key="daytypes" className="filter-badge">
          {dtText}
          <span className="clear-filter" onClick={() => dayTypeLegend.clearPin()}>&times;</span>
        </span>
      )
    }
    if (badges.length === 0) return ""
    return <>{badges}</>
  }, [effectiveStations, effectiveDayTypes, stationLegend.clearPin, dayTypeLegend.clearPin])

  const hasLegend = (groupBy === "station" && selectedStations.length > 0) || groupBy === "daytype"

  const baselines = useMemo(
    () => processed ? computeBaselines(processed.stations, baselineYears, exclusions) : new Map<string, StationBaseline>(),
    [processed, baselineYears, exclusions],
  )

  const plotProps = useMemo(() => {
    if (!processed) return {}
    if (groupBy === "station") {
      return buildByStation(processed, baselines, metric, selectedDayTypes, selectedStations, stationLegend, legendMode, effectiveTimeRange, activeYear ?? null)
    }
    // Pass all day types via snapshot so all traces are built; legend.isFaded handles fading
    const allDayTypes = [...DAY_TYPES] as string[]
    return buildByDayType(processed, baselines, metric, allDayTypes, selectedStations, dayTypeLegend, legendMode, effectiveTimeRange, activeYear ?? null)
  }, [processed, baselines, metric, groupBy, selectedDayTypes, selectedStations, effectiveTimeRange, stationLegend.activeItem, stationLegend.isFaded, stationLegend.isAllSelected, dayTypeLegend.activeItem, dayTypeLegend.isFaded, dayTypeLegend.isAllSelected, activeYear, legendMode])

  const title = useMemo(() => {
    const metricLabel = metric === "avg"
      ? "Avg PATH rides per day"
      : metric === "total"
        ? "Monthly PATH ridership"
        : `PATH ridership (% of ${baselineYears === 1 ? '2019' : `${2019 - baselineYears + 1}–19`} avg)`
    const groupLabel = groupBy === "station" ? "by station" : "by day type"
    return `${metricLabel} ${groupLabel}`
  }, [metric, groupBy, baselineYears])

  return (
    <div className="plot-container" ref={sharedContainerRef} onClick={legend.onContainerClick}>
      {isError ? <div className="error">Error: {error?.toString()}</div> : null}
      <Plot
        id="rides"
        title={title}
        subtitle={subtitle}
        {...(hasLegend ? {
          disableLegendHover: true,
          disableSoloTrace: true,
          onLegendClick: legend.onLegendClick,
          onLegendDoubleClick: legend.onLegendDoubleClick,
          onAfterPlot: legend.onAfterPlot,
          traceNames: legend.traceNames,
        } : {})}
        {...plotProps}
      />
      {!clean && <>
        <div className="plot-toggles">
          <ToggleButtonGroup
            value={metric}
            exclusive
            size="small"
            onChange={(_, v) => { if (v) setMetric(v) }}
          >
            <ToggleButton value="avg">Avg/Day</ToggleButton>
            <ToggleButton value="total">Total</ToggleButton>
            <ToggleButton value="pct2019">Recovery</ToggleButton>
          </ToggleButtonGroup>
          <ToggleButtonGroup
            value={groupBy}
            exclusive
            size="small"
            onChange={(_, v) => { if (v) setGroupBy(v) }}
          >
            <ToggleButton value="daytype">By Day Type</ToggleButton>
            <ToggleButton value="station">By Station</ToggleButton>
          </ToggleButtonGroup>
          {metric !== "pct2019" && (
            <ToggleButtonGroup
              value={effectiveTimeRange}
              exclusive
              size="small"
              onChange={(_, v) => { if (v) setTimeRange(v) }}
            >
              <ToggleButton value="all">All Time</ToggleButton>
              <ToggleButton value="recent">2020–Present</ToggleButton>
            </ToggleButtonGroup>
          )}
          {hasLegend && <>
            <ToggleButtonGroup
              value={legendMode}
              exclusive
              size="small"
              onChange={(_, v) => { if (v) setLegendMode(v) }}
            >
              <ToggleButton value="solo">Solo</ToggleButton>
              <ToggleButton value="highlight">Highlight</ToggleButton>
            </ToggleButtonGroup>
            <InfoTip>
              <strong>Solo</strong>: clicking a legend item hides all others.<br/>
              <strong>Highlight</strong>: clicking fades others but keeps them visible.
            </InfoTip>
          </>}

          <StationDropdown
            stations={[...DAY_TYPES] as string[]}
            colors={DAY_TYPE_COLORS}
            selected={selectedDayTypes}
            onChange={dayTypeLegend.onPickerChange}
            label="Day Types"
            nameMap={DAY_TYPE_LABELS}
          />
          <StationDropdown
            stations={[...STATIONS]}
            colors={STATION_COLORS}
            selected={effectiveStations}
            onChange={stationLegend.onPickerChange}
            lineGroups={LINE_GROUPS}
            regionGroups={REGION_GROUPS}
          />
        </div>
        {metric === "pct2019" && (
          <div className="plot-toggles baseline-controls" style={{ flexWrap: 'wrap', gap: '0.5em', alignItems: 'center' }}>
            <span style={{ fontSize: '0.85em' }}>Baseline:</span>
            <input
              type="number"
              min={1}
              max={8}
              value={baselineYears}
              onChange={e => {
                const n = parseInt(e.target.value)
                if (!isNaN(n) && n >= 1 && n <= 8) setBaselineYears(n)
              }}
              style={{ width: '3em', textAlign: 'center', fontSize: '0.85em' }}
            />
            <span style={{ fontSize: '0.85em' }}>yrs ({baselineYears === 1 ? '2019' : `${2019 - baselineYears + 1}–2019`})</span>
            <InfoTip>Number of pre-COVID years to average for the baseline. More years = smoother baseline, fewer = more sensitive to recent trends.</InfoTip>
            <details className="station-dropdown" style={{ fontSize: '0.85em' }}>
              <summary>{exclusions.length} excluded</summary>
              <div className="station-list">
                {DEFAULT_EXCLUSIONS.map(e => {
                  const key = `${e.station}|${e.month}`
                  const active = exclusions.some(x => x.station === e.station && x.month === e.month)
                  return (
                    <label key={key} style={{ display: 'flex', alignItems: 'center', gap: '0.3em', padding: '0.2em 0.5em', cursor: 'pointer', fontSize: '0.85rem' }}>
                      <input
                        type="checkbox"
                        checked={active}
                        onChange={() => {
                          if (active) {
                            setExclusions(exclusions.filter(x => !(x.station === e.station && x.month === e.month)))
                          } else {
                            setExclusions([...exclusions, e])
                          }
                        }}
                      />
                      {formatExclusion(e)}
                    </label>
                  )
                })}
              </div>
            </details>
            <InfoTip>Station-months excluded from baseline due to anomalous data (e.g. weekend closures).</InfoTip>
          </div>
        )}
        {metric === "pct2019" && groupBy === "daytype" && <p>Weekend ridership has surpassed pre-COVID levels (2017–2019 avg baseline), though service remains degraded.</p>}
        <hr/>
        <div>
          {processed ?
            <details>
              <summary>Plot data</summary>
              <ReactJsonView
                src={processed}
                theme={dark ? "monokai" : "rjv-default"}
                displayDataTypes={false}
                displayArrayKey={true}
                name={false}
                displayObjectSize
                enableClipboard
                quotesOnKeys={false}
              />
            </details>
            : null
          }
        </div>
      </>}
    </div>
  )
}
