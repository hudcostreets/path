import React from "react"
import { ToggleButton, ToggleButtonGroup } from "@mui/material"
import { useQuery } from "@tanstack/react-query"
import { asyncBufferFromUrl, parquetRead } from "hyparquet"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Data, Layout, Legend } from "plotly.js"
import { Plot as PltlyPlot } from "pltly/react"
import { INFERNO, getColorAt } from "pltly"
import { useUrlState, codeParam, codesParam } from "use-prms"
import { resolve as dvcResolve } from 'virtual:dvc-data'
import { Plot, blendAvgColor, hovertemplate, hovertemplatePct, isDark, rollingAvg, useDark } from "./plot-utils"
import { StationDropdown } from "./StationDropdown"
import { InfoTip } from "./Tooltip"
import type { StationGroup } from "./RidesPlot"
import BTFlowMap from "./BTFlowMap"

// --- Constants ---

// Ordered smallest → largest for stacking (smallest at bottom)
const CROSSINGS = [
  "Bayonne Bridge",
  "Outerbridge Crossing",
  "Goethals Bridge",
  "Holland Tunnel",
  "Lincoln Tunnel",
  "George Washington Bridge",
] as const

const CROSSING_COLORS: Record<string, string> = {
  "George Washington Bridge": "#636efa",
  "Lincoln Tunnel": "#EF553B",
  "Holland Tunnel": "#00cc96",
  "Goethals Bridge": "#ab63fa",
  "Outerbridge Crossing": "#FFA15A",
  "Bayonne Bridge": "#19d3f3",
}

const CROSSING_ABBREV: Record<string, string> = {
  "George Washington Bridge": "GWB",
  "Lincoln Tunnel": "Lincoln",
  "Holland Tunnel": "Holland",
  "Goethals Bridge": "Goethals",
  "Outerbridge Crossing": "Outerbridge",
  "Bayonne Bridge": "Bayonne",
}

const ABBREV_TO_CROSSING: Record<string, string> = Object.fromEntries(
  Object.entries(CROSSING_ABBREV).map(([k, v]) => [v, k])
)

const HUDSON_CROSSINGS = ["Holland Tunnel", "Lincoln Tunnel", "George Washington Bridge"] as const
const SI_CROSSINGS = ["Bayonne Bridge", "Outerbridge Crossing", "Goethals Bridge"] as const

const REGION_GROUPS: StationGroup[] = [
  { label: "Hudson River", color: "#aaa", stations: [...HUDSON_CROSSINGS] },
  { label: "Staten Island", color: "#aaa", stations: [...SI_CROSSINGS] },
]

// Ordered smallest → largest for stacking
const VEHICLE_TYPES = ["Buses", "Trucks", "Automobiles"] as const

const VEHICLE_TYPE_COLORS: Record<string, string> = {
  "Automobiles": "#636efa",
  "Buses": "#EF553B",
  "Trucks": "#00cc96",
}

const VEHICLE_TYPE_ABBREV: Record<string, string> = {
  "Automobiles": "Autos",
  "Buses": "Buses",
  "Trucks": "Trucks",
}

const ABBREV_TO_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(VEHICLE_TYPE_ABBREV).map(([k, v]) => [v, k])
)

// --- Subtitle helper ---

function btCrossingSubtitle(crossings: string[]): string {
  if (crossings.length > 0 && crossings.length < CROSSINGS.length) {
    return crossings.map(c => CROSSING_ABBREV[c] ?? c).join(", ")
  }
  return ""
}

function btTypeSuffix(types: string[]): string {
  if (types.length > 0 && types.length < VEHICLE_TYPES.length) {
    return types.map(t => VEHICLE_TYPE_ABBREV[t] ?? t).join(", ")
  }
  return ""
}

// --- URL params ---

type Mode = "traffic" | "vs2019" | "ezpass"
type StackBy = "crossing" | "vehicle"
type TimeRange = "all" | "recent"
type LegendMode = "solo" | "highlight"
const modeParam = codeParam<Mode>("traffic", { traffic: "t", vs2019: "v", ezpass: "e" })
const stackByParam = codeParam<StackBy>("crossing", { crossing: "c", vehicle: "v" })
const timeRangeParam = codeParam<TimeRange>("all", { all: "a", recent: "r" })
const legendModeParam = codeParam<LegendMode>("solo", { solo: "s", highlight: "h" })

const crossingsParam = codesParam<string>(
  [...CROSSINGS],
  {
    "George Washington Bridge": "g",
    "Lincoln Tunnel": "l",
    "Holland Tunnel": "h",
    "Goethals Bridge": "o",
    "Outerbridge Crossing": "u",
    "Bayonne Bridge": "b",
  },
)

const vehicleTypesParam = codesParam<string>(
  [...VEHICLE_TYPES],
  {
    "Automobiles": "a",
    "Buses": "b",
    "Trucks": "t",
  },
)

// --- Data hooks ---

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

function trafficUrl(): string {
  const resolved = dvcResolve('bt-traffic.pqt')
  return resolved.startsWith('/') ? `${window.location.origin}${resolved}` : resolved
}

function ezpassUrl(): string {
  const resolved = dvcResolve('bt-ezpass.pqt')
  return resolved.startsWith('/') ? `${window.location.origin}${resolved}` : resolved
}

type TrafficRow = { crossing: string, type: string, year: number, month: string, count: number }

const MONTH_ORDER: Record<string, number> = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 }

function useAllTrafficData() {
  const url = trafficUrl()
  return useQuery({
    queryKey: ['bt-traffic-all', url],
    queryFn: async () => {
      const file = await asyncBufferFromUrl({ url })
      const raw: Record<string, unknown>[] = []
      await parquetRead({ file, rowFormat: 'object', onComplete: data => raw.push(...data) })
      return raw
        .filter(r => r['Crossing'] !== 'All Crossings' && r['Type'] !== 'Total Vehicles')
        .map(r => ({
          crossing: r['Crossing'] as string,
          type: r['Type'] as string,
          year: Number(r['Year']),
          month: r['Month'] as string,
          count: Number(r['Count']),
        }))
        .sort((a, b) => a.year - b.year || (MONTH_ORDER[a.month] ?? 0) - (MONTH_ORDER[b.month] ?? 0))
    },
  })
}

type EZPassRow = { crossing: string, year: number, pct: number }

function useEZPassData() {
  const url = ezpassUrl()
  return useQuery({
    queryKey: ['bt-ezpass', url],
    queryFn: async () => {
      const file = await asyncBufferFromUrl({ url })
      const raw: Record<string, unknown>[] = []
      await parquetRead({ file, rowFormat: 'object', onComplete: data => raw.push(...data) })
      return raw
        .filter(r => r['Month'] === 'Annual')
        .map(r => ({
          crossing: r['Crossing'] as string,
          year: Number(r['Year']),
          pct: Number(r['E-Z Pass Percent']),
        }))
        .sort((a, b) => a.year - b.year)
    },
  })
}

// --- Filtering helper ---

function filterRows(rows: TrafficRow[], crossings: string[], types: string[]): TrafficRow[] {
  return rows.filter(r => crossings.includes(r.crossing) && types.includes(r.type))
}

// Hide non-selected same-dim traces via `visible: 'legendonly'` — bars
// disappear from the chart but LIs stay in the legend (so the legend doesn't
// reflow on every selection change). `showlegend: false` traces (like the
// vs2019 baseline) are passed through unchanged.
function bakeSameDimVisibility<T extends Data>(
  traces: T[],
  selected: string[],
  all: readonly string[],
  abbrev: Record<string, string>,
): T[] {
  if (selected.length === 0 || selected.length === all.length) return traces
  const selectedAbbrevs = new Set(selected.map(s => abbrev[s]))
  return traces.map(t => {
    if ((t as any).showlegend === false) return t
    const tname = (t as any).name as string
    if (selectedAbbrevs.has(tname)) return t
    return { ...t, visible: 'legendonly' as const }
  })
}


// --- Trace builders ---

function buildStackedByCrossing(rows: TrafficRow[], crossings: string[], types: string[]): Data[] {
  const filtered = filterRows(rows, crossings, types)
  const crossingData = new Map<string, Map<string, number>>()
  for (const row of filtered) {
    let monthMap = crossingData.get(row.crossing)
    if (!monthMap) {
      monthMap = new Map()
      crossingData.set(row.crossing, monthMap)
    }
    const key = `${row.year}-${row.month}`
    monthMap.set(key, (monthMap.get(key) ?? 0) + row.count)
  }

  return CROSSINGS
    .filter(c => crossings.includes(c))
    .map(crossing => {
      const monthMap = crossingData.get(crossing)
      if (!monthMap) return null
      const entries = [...monthMap.entries()]
        .map(([key, count]) => {
          const [yearStr, month] = key.split('-')
          return { date: new Date(parseInt(yearStr), MONTHS.indexOf(month), 1), count }
        })
        .sort((a, b) => a.date.getTime() - b.date.getTime())
      return {
        name: CROSSING_ABBREV[crossing],
        x: entries.map(e => e.date),
        y: entries.map(e => e.count),
        type: "bar",
        marker: { color: CROSSING_COLORS[crossing] },
        hovertemplate,
      } as Data
    }).filter((d): d is Data => d !== null)
}

function buildStackedByVehicle(rows: TrafficRow[], crossings: string[], types: string[]): Data[] {
  const filtered = filterRows(rows, crossings, types)
  const typeData = new Map<string, Map<string, number>>()
  for (const row of filtered) {
    let monthMap = typeData.get(row.type)
    if (!monthMap) {
      monthMap = new Map()
      typeData.set(row.type, monthMap)
    }
    const key = `${row.year}-${row.month}`
    monthMap.set(key, (monthMap.get(key) ?? 0) + row.count)
  }

  return VEHICLE_TYPES
    .filter(t => types.includes(t))
    .map(type => {
      const monthMap = typeData.get(type)
      if (!monthMap) return null
      const entries = [...monthMap.entries()]
        .map(([key, count]) => {
          const [yearStr, month] = key.split('-')
          return { date: new Date(parseInt(yearStr), MONTHS.indexOf(month), 1), count }
        })
        .sort((a, b) => a.date.getTime() - b.date.getTime())
      return {
        name: VEHICLE_TYPE_ABBREV[type],
        x: entries.map(e => e.date),
        y: entries.map(e => e.count),
        type: "bar",
        marker: { color: VEHICLE_TYPE_COLORS[type] },
        hovertemplate,
      } as Data
    }).filter((d): d is Data => d !== null)
}

function buildVs2019Traces(rows: TrafficRow[], crossings: string[], types: string[], stackBy: StackBy, baselineEnd: Date): Data[] {
  const filtered = filterRows(rows, crossings, types)

  if (stackBy === "vehicle") {
    return buildVs2019ByDimension(
      filtered,
      VEHICLE_TYPES.filter(t => types.includes(t)),
      r => r.type,
      VEHICLE_TYPE_ABBREV,
      VEHICLE_TYPE_COLORS,
      baselineEnd,
    )
  }
  return buildVs2019ByDimension(
    filtered,
    CROSSINGS.filter(c => crossings.includes(c)),
    r => r.crossing,
    CROSSING_ABBREV,
    CROSSING_COLORS,
    baselineEnd,
  )
}

function buildVs2019ByDimension(
  rows: TrafficRow[],
  dimensions: readonly string[],
  getDim: (r: TrafficRow) => string,
  abbrev: Record<string, string>,
  colors: Record<string, string>,
  baselineEnd: Date,
): Data[] {
  const baseline = new Map<string, Map<string, number>>()
  for (const row of rows) {
    if (row.year !== 2019) continue
    const dim = getDim(row)
    let monthMap = baseline.get(dim)
    if (!monthMap) {
      monthMap = new Map()
      baseline.set(dim, monthMap)
    }
    monthMap.set(row.month, (monthMap.get(row.month) ?? 0) + row.count)
  }

  const dimData = new Map<string, Map<string, number>>()
  for (const row of rows) {
    if (row.year < 2020) continue
    const dim = getDim(row)
    let monthMap = dimData.get(dim)
    if (!monthMap) {
      monthMap = new Map()
      dimData.set(dim, monthMap)
    }
    const key = `${row.year}-${row.month}`
    monthMap.set(key, (monthMap.get(key) ?? 0) + row.count)
  }

  const traces: Data[] = dimensions.map(dim => {
    const monthMap = dimData.get(dim)
    const baseMap = baseline.get(dim)
    if (!monthMap || !baseMap) return null
    const points: { date: Date, pct: number }[] = []
    for (const [key, total] of monthMap) {
      const [yearStr, month] = key.split('-')
      const base = baseMap.get(month)
      if (!base || base === 0) continue
      points.push({
        date: new Date(parseInt(yearStr), MONTHS.indexOf(month), 1),
        pct: total / base,
      })
    }
    points.sort((a, b) => a.date.getTime() - b.date.getTime())
    return {
      name: abbrev[dim] ?? dim,
      x: points.map(p => p.date),
      y: points.map(p => p.pct),
      type: "scatter",
      mode: "lines",
      line: { color: colors[dim], width: 2 },
      hovertemplate: hovertemplatePct,
    } as Data
  }).filter((d): d is Data => d !== null)

  traces.push({
    name: "2019 baseline",
    x: [new Date(2020, 0, 1), baselineEnd],
    y: [1, 1],
    type: "scatter",
    mode: "lines",
    line: { color: "#888", width: 1, dash: "dash" },
    showlegend: false,
    hoverinfo: "skip",
  } as Data)

  return traces
}

function buildEZPassTraces(rows: EZPassRow[], crossings: string[]): Data[] {
  const crossingData = new Map<string, { years: number[], pcts: number[] }>()
  for (const row of rows) {
    if (row.crossing === "All Crossings") continue
    if (!crossings.includes(row.crossing)) continue
    let entry = crossingData.get(row.crossing)
    if (!entry) {
      entry = { years: [], pcts: [] }
      crossingData.set(row.crossing, entry)
    }
    entry.years.push(row.year)
    entry.pcts.push(row.pct / 100)
  }

  return CROSSINGS
    .filter(c => crossings.includes(c))
    .map(crossing => {
      const data = crossingData.get(crossing)
      if (!data) return null
      return {
        name: CROSSING_ABBREV[crossing],
        x: data.years,
        y: data.pcts,
        type: "scatter",
        mode: "lines+markers",
        line: { color: CROSSING_COLORS[crossing], width: 2 },
        marker: { color: CROSSING_COLORS[crossing], size: 4 },
        hovertemplate: hovertemplatePct,
      } as Data
    }).filter((d): d is Data => d !== null)
}

// --- Main traffic plot ---

function TrafficPlot({
  allRows,
  selectedCrossings, setSelectedCrossings,
  selectedTypes, setSelectedTypes,
  activeYear,
  subtitleNode,
  onEffectiveChange,
}: {
  allRows: TrafficRow[] | null | undefined
  selectedCrossings: string[], setSelectedCrossings: (v: string[]) => void
  selectedTypes: string[], setSelectedTypes: (v: string[]) => void
  activeYear: string | null
  subtitleNode: React.ReactNode
  onEffectiveChange?: (eff: { crossings: string[], types: string[] }) => void
}) {
  const [mode, setMode] = useUrlState<Mode>("m", modeParam)
  const [stackBy, setStackBy] = useUrlState<StackBy>("g", stackByParam)
  const [timeRange, setTimeRange] = useUrlState<TimeRange>("t", timeRangeParam)
  const [legendMode, setLegendMode] = useUrlState<LegendMode>("l", legendModeParam)
  const { data: ezpassRows } = useEZPassData()

  const isEZPass = mode === "ezpass"
  const isVs2019 = mode === "vs2019"
  const isTraffic = mode === "traffic"

  // Unified legend: click → URL state, hover → transient highlight
  // Hook manages whichever dimension is currently stacked by
  const stackedNameMap = useMemo(
    () => stackBy === "crossing" ? CROSSING_ABBREV : VEHICLE_TYPE_ABBREV,
    [stackBy],
  )

  // `selected` is the URL-bound canonical state for each dim; `active` is
  // "what to actually use" (falls back to all when nothing is selected).
  const activeCrossings = useMemo(() =>
    selectedCrossings.length > 0 ? selectedCrossings : [...CROSSINGS],
    [selectedCrossings])
  const activeTypes = useMemo(() =>
    selectedTypes.length > 0 ? selectedTypes : [...VEHICLE_TYPES],
    [selectedTypes])

  // Stack-by-aware trace builder inputs:
  // - Same-dim: build traces for ALL items (visibility narrowing is then
  //   applied per-trace via `visible: 'legendonly'` below — so non-selected
  //   stay in the legend, just no bars).
  // - Cross-dim: filter data to selected items — pinning Lincoln and
  //   switching to BY VEHICLE shows Lincoln's vehicle breakdown.
  const dataCrossings = useMemo(() =>
    stackBy === "vehicle" ? activeCrossings : [...CROSSINGS],
    [stackBy, activeCrossings])
  const dataTypes = useMemo(() =>
    stackBy === "crossing" ? activeTypes : [...VEHICLE_TYPES],
    [stackBy, activeTypes])

  // Hover (transient, both modes) + HIGHLIGHT-mode click (sticky in
  // HIGHLIGHT only). In SOLO mode, click writes URL via setSelectedCrossings
  // — activeTraceName stays for hover only.
  const [hoverTraceName, setHoverTraceName] = useState<string | null>(null)
  const [activeTraceName, setActiveTraceName] = useState<string | null>(null)

  // "Effective" narrowing for plot2 brushing + the subtitle badges: includes
  // transient hover (so hovering Holland LI brushes plot2 to Holland) on top
  // of the URL-bound `selectedCrossings`/`selectedTypes` filter.
  const transientTraceName = hoverTraceName ?? activeTraceName
  const effectiveCrossings = useMemo(() => {
    if (transientTraceName && stackBy === "crossing") {
      const full = ABBREV_TO_CROSSING[transientTraceName]
      if (full) return [full]
    }
    return activeCrossings
  }, [transientTraceName, stackBy, activeCrossings])
  const effectiveTypes = useMemo(() => {
    if (transientTraceName && stackBy === "vehicle") {
      const full = ABBREV_TO_TYPE[transientTraceName]
      if (full) return [full]
    }
    return activeTypes
  }, [transientTraceName, stackBy, activeTypes])

  useEffect(() => {
    onEffectiveChange?.({ crossings: effectiveCrossings, types: effectiveTypes })
  }, [effectiveCrossings, effectiveTypes, onEffectiveChange])

  // SOLO mode: drive pltly's solo from selectedCrossings when narrowed to
  //   one item (legend-click and dropdown "Only" produce the same state).
  //   For 2+ selected, we don't use pltly's solo — visibility is baked at
  //   the data layer below.
  // HIGHLIGHT mode: pltly's solo follows transient activeTraceName.
  const soloTrace = useMemo<string | null>(() => {
    if (legendMode === "highlight") return activeTraceName
    if (stackBy === "crossing") {
      return selectedCrossings.length === 1
        ? CROSSING_ABBREV[selectedCrossings[0]] ?? null
        : null
    }
    return selectedTypes.length === 1
      ? VEHICLE_TYPE_ABBREV[selectedTypes[0]] ?? null
      : null
  }, [legendMode, stackBy, selectedCrossings, selectedTypes, activeTraceName])

  const handleSoloTraceChange = useCallback((name: string | null) => {
    if (legendMode === "highlight") {
      setActiveTraceName(name)
      return
    }
    setActiveTraceName(null)
    // SOLO mode: legend-click writes to selectedCrossings/Types — same URL
    // state as dropdown "Only X" / dropdown checkbox. Re-clicking the
    // currently-solo'd LI clears the narrowing (pltly emits `null`).
    if (name === null) {
      if (stackBy === "crossing") setSelectedCrossings([...CROSSINGS])
      else setSelectedTypes([...VEHICLE_TYPES])
      return
    }
    if (stackBy === "crossing") {
      const full = ABBREV_TO_CROSSING[name]
      if (full) setSelectedCrossings([full])
    } else {
      const full = ABBREV_TO_TYPE[name]
      if (full) setSelectedTypes([full])
    }
  }, [legendMode, stackBy, setSelectedCrossings, setSelectedTypes])

  const plotProps = useMemo(() => {
    if (isEZPass) {
      if (!ezpassRows) return {}
      // Build traces for ALL crossings; narrowing applied via `legendonly`
      // so non-selected crossings stay in the legend (consistent with bar
      // modes; LIs don't reflow on selection change).
      const rawTraces = buildEZPassTraces(ezpassRows, [...CROSSINGS])
      const traces = bakeSameDimVisibility(rawTraces, activeCrossings, CROSSINGS, CROSSING_ABBREV)
      return {
        data: traces,
        layout: {
          yaxis: { tickformat: ".0%", fixedrange: true },
          xaxis: { fixedrange: true, dtick: 1 },
        } as Partial<Layout>,
      }
    }

    if (!allRows) return {}
    const isRecent = timeRange === "recent"
    // Right edge = first of the month AFTER the latest data month, so the
    // newest bar has visual room (was hardcoded `2026-01-01`, which cropped
    // Jan/Feb '26 to a sliver/off-screen on initial render).
    let maxY = 0, maxMi = -1
    for (const r of allRows) {
      if (r.count <= 0) continue
      const mi = MONTH_ORDER[r.month] - 1
      if (r.year > maxY || (r.year === maxY && mi > maxMi)) { maxY = r.year; maxMi = mi }
    }
    const rightEdge = maxMi >= 0
      ? new Date(maxMi === 11 ? maxY + 1 : maxY, (maxMi + 1) % 12, 1)
      : new Date(2026, 0, 1)
    const allTimeRange: [Date, Date] = [new Date(2011, 0, 1), rightEdge]
    const recentRange: [Date, Date] = [new Date(2019, 11, 1), rightEdge]

    if (isVs2019) {
      // Baseline runs from 2020 to the latest data month (was clipped at Dec '25).
      const rawTraces = buildVs2019Traces(allRows, dataCrossings, dataTypes, stackBy, rightEdge)
      const traces = stackBy === "crossing"
        ? bakeSameDimVisibility(rawTraces, activeCrossings, CROSSINGS, CROSSING_ABBREV)
        : bakeSameDimVisibility(rawTraces, activeTypes, VEHICLE_TYPES, VEHICLE_TYPE_ABBREV)
      return {
        data: traces,
        layout: {
          yaxis: { tickformat: ".0%", fixedrange: true },
          xaxis: {
            fixedrange: true,
            dtick: "M6",
            tickformat: "%b '%y",
            tickangle: -45,
          },
        } as Partial<Layout>,
      }
    }

    // Traffic mode — `dataCrossings`/`dataTypes` filter only the cross-dim
    // (same-dim gets all items so non-selected stay in the legend as
    // `visible: 'legendonly'` from `bakeSameDimVisibility`). Pinning Lincoln
    // in BY CROSSING + switching to BY VEHICLE still shows Lincoln's vehicle
    // breakdown via the cross-dim filter.
    const rawTraces = stackBy === "vehicle"
      ? buildStackedByVehicle(allRows, dataCrossings, dataTypes)
      : buildStackedByCrossing(allRows, dataCrossings, dataTypes)
    const bakedTraces = stackBy === "crossing"
      ? bakeSameDimVisibility(rawTraces, activeCrossings, CROSSINGS, CROSSING_ABBREV)
      : bakeSameDimVisibility(rawTraces, activeTypes, VEHICLE_TYPES, VEHICLE_TYPE_ABBREV)

    // Compute stack max from VISIBLE traces only — narrowing should refit
    // the y-axis to the displayed data (otherwise a sole Lincoln bar in BY
    // CROSSING looks tiny against the all-crossings stack max).
    const visibleTraces = bakedTraces.filter(t => (t as any).visible !== 'legendonly')
    const nPoints = visibleTraces.length > 0 ? ((visibleTraces[0] as any).y as number[]).length : 0
    let stackMax = 0
    for (let i = 0; i < nPoints; i++) {
      let sum = 0
      for (const t of visibleTraces) sum += ((t as any).y as number[])[i] ?? 0
      if (sum > stackMax) stackMax = sum
    }

    const yearNum = activeYear ? parseInt(activeYear) : null
    const traces = bakedTraces.map(trace => {
      const dates = (trace as any).x as Date[]
      const yearOpacity = yearNum
        ? dates.map(d => d.getFullYear() === yearNum ? 1 : 0.15)
        : undefined
      return {
        ...trace,
        marker: {
          ...(trace as any).marker,
          ...(yearOpacity ? { opacity: yearOpacity } : {}),
        },
      } as Data
    })

    return {
      data: traces,
      layout: {
        barmode: "stack",
        yaxis: { fixedrange: true, automargin: false, autorange: false, range: [0, stackMax * 1.05] },
        xaxis: {
          fixedrange: true,
          range: isRecent ? recentRange : allTimeRange,
          dtick: isRecent ? "M3" : "M12",
          tickformat: isRecent ? "%b '%y" : "'%y",
          hoverformat: "%b '%y",
          tickangle: -45,
          automargin: false,
        },
        legend: { entrywidth: 80, traceorder: "reversed" } as Partial<Legend>,
      } as Partial<Layout>,
    }
  }, [allRows, ezpassRows, mode, stackBy, timeRange, activeCrossings, activeTypes, dataCrossings, dataTypes, isEZPass, isVs2019, activeYear, stackedNameMap, legendMode])

  const colors = stackBy === "crossing" ? CROSSING_COLORS : VEHICLE_TYPE_COLORS
  const buildLinkedTraces = useCallback((active: Data | null, all: Data[]): Data[] => {
    if (isEZPass) return []
    const allDates: Date[] = all.length > 0 ? (all[0] as any).x : []
    if (!allDates.length) return []
    const avgSource: number[] = active
      ? ((active as any).y as number[])
      : allDates.map((_, i) => {
          let sum = 0
          for (const t of all) sum += ((t as any).y as number[])[i] ?? 0
          return sum
        })
    const avg12 = rollingAvg(avgSource, 12)
    const avgColor = active
      ? blendAvgColor((active as any).marker?.color ?? '#888', 0.5)
      : (isDark() ? "rgba(255,255,255,0.7)" : "rgba(0,0,0,0.7)")
    return [{
      name: "12mo avg",
      x: allDates,
      y: avg12,
      type: "scatter",
      mode: "lines",
      line: { color: avgColor, width: 4 },
      hovertemplate,
      showlegend: false,
      connectgaps: false,
    } as Data]
  }, [isEZPass])

  const stackLabel = stackBy === "vehicle" ? "vehicle type" : "crossing"
  // Title shows only the chart type; narrowing is in the chip-style
  // `subtitleNode` so it's consistent with the by-month plot below.
  const title = isEZPass
    ? "E-ZPass adoption by crossing"
    : isVs2019
      ? `% of 2019, by ${stackLabel}`
      : `Monthly traffic by ${stackLabel}`

  return (
    <div className="plot-container">
      <Plot
        id="bt-traffic"
        title={title}
        subtitle={subtitleNode}
        soloMode={legendMode === "solo" ? "hide" : "fade"}
        fadeOpacity={0.4}
        linkedTraces={buildLinkedTraces}
        soloTrace={soloTrace}
        onSoloTraceChange={handleSoloTraceChange}
        onHoverTraceChange={setHoverTraceName}
        disableSoloDismiss
        {...plotProps as any}
      />
      <div className="plot-toggles">
        <ToggleButtonGroup
          value={mode}
          exclusive
          size="small"
          onChange={(_, v) => { if (v) setMode(v) }}
        >
          <ToggleButton value="traffic">Traffic</ToggleButton>
          <ToggleButton value="vs2019">vs. 2019</ToggleButton>
          <ToggleButton value="ezpass">E-ZPass</ToggleButton>
        </ToggleButtonGroup>
        {!isEZPass && (
          <ToggleButtonGroup
            value={stackBy}
            exclusive
            size="small"
            onChange={(_, v) => { if (v) setStackBy(v) }}
          >
            <ToggleButton value="crossing">By Crossing</ToggleButton>
            <ToggleButton value="vehicle">By Vehicle</ToggleButton>
          </ToggleButtonGroup>
        )}
        {!isVs2019 && !isEZPass && (
          <ToggleButtonGroup
            value={timeRange}
            exclusive
            size="small"
            onChange={(_, v) => { if (v) setTimeRange(v) }}
          >
            <ToggleButton value="all">All Time</ToggleButton>
            <ToggleButton value="recent">2020–Present</ToggleButton>
          </ToggleButtonGroup>
        )}
        {(isTraffic || isVs2019) && <>
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
          stations={[...CROSSINGS]}
          colors={CROSSING_COLORS}
          selected={activeCrossings}
          onChange={setSelectedCrossings}
          regionGroups={REGION_GROUPS}
          label="Crossings"
        />
        {!isEZPass && (
          <StationDropdown
            stations={[...VEHICLE_TYPES]}
            colors={VEHICLE_TYPE_COLORS}
            selected={activeTypes}
            onChange={setSelectedTypes}
            label="Vehicle Types"
          />
        )}
      </div>
    </div>
  )
}

// --- By-month plot (year traces, INFERNO) ---

function highlightTraces(data: Data[], activeTrace: string | null): Data[] {
  if (!activeTrace) return data
  return data.map(trace => {
    const isActive = trace.name === activeTrace
    if (isActive) {
      const yRaw = (trace as any).y
      const y: number[] = Array.isArray(yRaw) ? yRaw : Object.values(yRaw).filter((v): v is number => typeof v === 'number')
      return {
        ...trace,
        width: 0.25,
        zorder: 100,
        text: y.map(v => {
          if (v <= 0) return ''
          if (v >= 1_000_000) return `<b>${(v / 1_000_000).toFixed(1)}M</b>`
          return `<b>${Math.round(v / 1000)}k</b>`
        }),
        textposition: 'outside',
        textfont: { color: isDark() ? '#e4e4e4' : '#333', size: 11 },
        textangle: 0,
        constraintext: 'none',
        cliponaxis: false,
      } as Data
    }
    return { ...trace, opacity: 0.3, zorder: 1 } as Data
  })
}

function BTMonthlyPlot({
  allRows,
  crossings,
  types,
  subtitleNode,
  onActiveYearChange,
}: {
  allRows: TrafficRow[] | null | undefined
  crossings: string[]
  types: string[]
  subtitleNode: React.ReactNode
  onActiveYearChange?: (year: string | null) => void
}) {
  // Aggregate allRows by year + calendar month, filtered by crossings/types
  const plotData = useMemo(() => {
    if (!allRows) return null
    const activeCrossings = crossings.length > 0 ? crossings : [...CROSSINGS]
    const activeTypes = types.length > 0 ? types : [...VEHICLE_TYPES]
    const filtered = allRows.filter(r => activeCrossings.includes(r.crossing) && activeTypes.includes(r.type))

    // Group by (year, month) → sum
    const sums = new Map<string, number>()
    for (const r of filtered) {
      const key = `${r.year}-${r.month}`
      sums.set(key, (sums.get(key) ?? 0) + r.count)
    }

    const years = [...new Set(filtered.map(r => r.year))].sort()
    if (years.length === 0) return null
    const minYear = Math.min(...years)
    const maxYear = Math.max(...years)
    const range = maxYear - minYear || 1

    const data: Data[] = years.map(year => {
      const ys = MONTHS.map(m => sums.get(`${year}-${m}`) ?? 0)
      if (ys.every(v => v === 0)) return null
      const t = 0.15 + 0.85 * (year - minYear) / range
      return {
        name: String(year),
        type: "bar",
        x: MONTHS,
        y: ys,
        marker: { color: getColorAt(INFERNO, t) },
        hovertemplate,
      } as Data
    }).filter((d): d is Data => d !== null)

    return data
  }, [allRows, crossings, types])

  const [activeYear, setActiveYear] = useState<string | null>(null)

  useEffect(() => {
    onActiveYearChange?.(activeYear)
  }, [activeYear, onActiveYearChange])

  const styledData = useMemo(
    () => plotData ? highlightTraces(plotData, activeYear) : null,
    [plotData, activeYear],
  )

  return (
    <div className="plot-container">
      <Plot
        id="bt-monthly"
        title="Monthly traffic, by month"
        subtitle={subtitleNode}
        data={styledData ?? undefined}
        disableLegendHover
        disableSoloTrace
        onActiveTraceChange={setActiveYear}
        layout={{
          barmode: "group",
          legend: { title: undefined, entrywidth: 60 } as Partial<Legend>,
        }}
      />
    </div>
  )
}

// --- Page ---

export default function BridgeTunnel() {
  useDark()  // subscribe so the component re-renders when theme changes
  const [urlCrossings, setUrlCrossings] = useUrlState<string[]>("c", crossingsParam)
  const [urlTypes, setUrlTypes] = useUrlState<string[]>("v", vehicleTypesParam)
  // Per-dim legend-pin URL state. Coexists with `c=`/`v=`: dropdown writes to
  // Immediate local state; URL syncs on debounce
  const [selectedCrossings, setSelectedCrossingsRaw] = useState<string[]>(urlCrossings)
  const [selectedTypes, setSelectedTypesRaw] = useState<string[]>(urlTypes)
  const crossingUrlTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const typeUrlTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const setSelectedCrossings = useCallback((crossings: string[]) => {
    setSelectedCrossingsRaw(crossings)
    clearTimeout(crossingUrlTimerRef.current)
    crossingUrlTimerRef.current = setTimeout(() => setUrlCrossings(crossings), 300)
  }, [setUrlCrossings])
  const setSelectedTypes = useCallback((types: string[]) => {
    setSelectedTypesRaw(types)
    clearTimeout(typeUrlTimerRef.current)
    typeUrlTimerRef.current = setTimeout(() => setUrlTypes(types), 300)
  }, [setUrlTypes])
  const { data: allRows } = useAllTrafficData()
  const [activeYear, setActiveYear] = useState<string | null>(null)
  const [effective, setEffective] = useState<{ crossings: string[], types: string[] }>({
    crossings: [], types: [],
  })
  const subtitle = btCrossingSubtitle(effective.crossings)
  const typeSuffix = btTypeSuffix(effective.types)

  // Chip-style subtitle, shared between TrafficPlot and BTMonthlyPlot so both
  // surfaces show the same narrowing UI. `×` clears that dim's selection.
  const subtitleNode: React.ReactNode = useMemo(() => {
    const badges: React.ReactNode[] = []
    if (subtitle) {
      badges.push(
        <span key="crossings" className="filter-badge">
          {subtitle}
          <span className="clear-filter" onClick={() => setSelectedCrossings([...CROSSINGS])}>&times;</span>
        </span>
      )
    }
    if (typeSuffix) {
      badges.push(
        <span key="types" className="filter-badge">
          {typeSuffix}
          <span className="clear-filter" onClick={() => setSelectedTypes([...VEHICLE_TYPES])}>&times;</span>
        </span>
      )
    }
    if (badges.length === 0) return ""
    return <>{badges}</>
  }, [subtitle, typeSuffix, setSelectedCrossings, setSelectedTypes])
  // Derive the data range from the parquet so the subtitle advances when
  // a new month lands (was hardcoded "2011–2025" → stale 5 months after
  // the Feb '26 data shipped).
  const dataRange = useMemo(() => {
    if (!allRows?.length) return null
    const positive = allRows.filter(r => r.count > 0)
    if (!positive.length) return null
    const minYear = Math.min(...positive.map(r => r.year))
    const maxYear = Math.max(...positive.map(r => r.year))
    const lastMonthIdx = Math.max(
      ...positive.filter(r => r.year === maxYear).map(r => MONTH_ORDER[r.month] - 1)
    )
    return `${minYear}–${MONTHS[lastMonthIdx]} ${maxYear}`
  }, [allRows])

  return <>
    <h1>PANYNJ Bridge &amp; Tunnel Traffic</h1>
    <p style={{ color: "#888", marginTop: "-0.5em" }}>
      Eastbound (tolled direction) vehicle counts, {dataRange ?? "2011–present"}.{" "}
      <a href="/">← PATH ridership</a>
    </p>
    <TrafficPlot
      allRows={allRows}
      selectedCrossings={selectedCrossings} setSelectedCrossings={setSelectedCrossings}
      selectedTypes={selectedTypes} setSelectedTypes={setSelectedTypes}
      activeYear={activeYear}
      subtitleNode={subtitleNode}
      onEffectiveChange={setEffective}
    />
    <BTMonthlyPlot
      allRows={allRows}
      crossings={effective.crossings}
      types={effective.types}
      subtitleNode={subtitleNode}
      onActiveYearChange={setActiveYear}
    />
    {allRows && <BTFlowMap rows={allRows} />}
    <div className="abp-footer">
      <p>
        Data from <a href="https://www.panynj.gov/bridges-tunnels/en/traffic---volume-information---b-t.html">PANYNJ</a> ·
        Code <a href="https://github.com/hudcostreets/path">on GitHub</a>
      </p>
    </div>
  </>
}
