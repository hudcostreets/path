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

// Per-dim legend-pin URL state, distinct from the dropdown filter (`c=`/`v=`):
//   - Dropdown "Only X"      → `c=l`  (sticky filter; only chip `×` clears it)
//   - Legend-click pin X     → `pc=l` (ephemeral; outside-click clears it)
// Per-dim keys because crossing/vehicle abbrevs collide (`b` = Bayonne AND
// Buses). When a pin is set it also narrows data in the cross-dim view (so
// pinning Lincoln in BY CROSSING and switching to BY VEHICLE still shows
// Lincoln's vehicle breakdown — the original [Image #93] behavior).
const CROSSING_ABBREV_PAIRS: [string, string][] = [
  ["George Washington Bridge", "g"],
  ["Lincoln Tunnel", "l"],
  ["Holland Tunnel", "h"],
  ["Goethals Bridge", "o"],
  ["Outerbridge Crossing", "u"],
  ["Bayonne Bridge", "b"],
]
const VEHICLE_ABBREV_PAIRS: [string, string][] = [
  ["Automobiles", "a"],
  ["Buses", "b"],
  ["Trucks", "t"],
]
const crossingPinParam = {
  encode: (v: string | null) => v ? CROSSING_ABBREV_PAIRS.find(([k]) => k === v)?.[1] : undefined,
  decode: (s: string | undefined): string | null =>
    s ? CROSSING_ABBREV_PAIRS.find(([, c]) => c === s)?.[0] ?? null : null,
}
const vehiclePinParam = {
  encode: (v: string | null) => v ? VEHICLE_ABBREV_PAIRS.find(([k]) => k === v)?.[1] : undefined,
  decode: (s: string | undefined): string | null =>
    s ? VEHICLE_ABBREV_PAIRS.find(([, c]) => c === s)?.[0] ?? null : null,
}

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
  crossingPin, setCrossingPin,
  vehiclePin, setVehiclePin,
  activeYear,
  subtitleNode,
  onEffectiveChange,
}: {
  allRows: TrafficRow[] | null | undefined
  selectedCrossings: string[], setSelectedCrossings: (v: string[]) => void
  selectedTypes: string[], setSelectedTypes: (v: string[]) => void
  crossingPin: string | null, setCrossingPin: (v: string | null) => void
  vehiclePin: string | null, setVehiclePin: (v: string | null) => void
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

  // Dropdown-only "selected or all" — for the dropdown's `selected` display.
  const activeCrossings = useMemo(() =>
    selectedCrossings.length > 0 ? selectedCrossings : [...CROSSINGS],
    [selectedCrossings])
  const activeTypes = useMemo(() =>
    selectedTypes.length > 0 ? selectedTypes : [...VEHICLE_TYPES],
    [selectedTypes])

  // Narrowing = pin (ephemeral, takes precedence) || dropdown filter (sticky).
  // Used for (a) cross-dim data filter, (b) secondary plot brushing, (c) the
  // chip's display string. Same-dim data filter is the dropdown only — the
  // pin shows as a soft-solo via pltly's `soloTrace` instead.
  const narrowedCrossings = useMemo(() =>
    crossingPin ? [crossingPin] : activeCrossings,
    [crossingPin, activeCrossings])
  const narrowedTypes = useMemo(() =>
    vehiclePin ? [vehiclePin] : activeTypes,
    [vehiclePin, activeTypes])

  // Stack-by-aware data filter.
  // - Same-dim: only the dropdown filter applies at the data layer
  //   (pin is visual via `soloTrace` — data still has all dropdown-selected
  //   traces so non-pinned ones can be shown as `visible: 'legendonly'`).
  // - Cross-dim: pin OR dropdown filter narrows the data — pinning Lincoln
  //   and switching to BY VEHICLE shows Lincoln's vehicle breakdown.
  const dataCrossings = useMemo(() =>
    stackBy === "vehicle" ? narrowedCrossings : activeCrossings,
    [stackBy, narrowedCrossings, activeCrossings])
  const dataTypes = useMemo(() =>
    stackBy === "crossing" ? narrowedTypes : activeTypes,
    [stackBy, narrowedTypes, activeTypes])

  const [activeTraceName, setActiveTraceName] = useState<string | null>(null)

  useEffect(() => {
    onEffectiveChange?.({ crossings: narrowedCrossings, types: narrowedTypes })
  }, [narrowedCrossings, narrowedTypes, onEffectiveChange])

  // Controlled `soloTrace` for pltly. In SOLO mode this is the per-dim PIN
  // (`crossingPin` / `vehiclePin`) — pltly soft-solos the pinned trace via
  // `visible: 'legendonly'` on the others. Dropdown "Only X" is a real data
  // filter (handled in `dataCrossings`/`dataTypes`); it doesn't drive
  // `soloTrace` because dropdown-narrowed data has no other traces to solo.
  const soloTrace = useMemo<string | null>(() => {
    if (legendMode === "highlight") return activeTraceName
    if (stackBy === "crossing") return crossingPin ? CROSSING_ABBREV[crossingPin] ?? null : null
    return vehiclePin ? VEHICLE_TYPE_ABBREV[vehiclePin] ?? null : null
  }, [legendMode, stackBy, crossingPin, vehiclePin, activeTraceName])

  const handleSoloTraceChange = useCallback((name: string | null) => {
    if (legendMode === "highlight") {
      setActiveTraceName(name)
      return
    }
    setActiveTraceName(null)
    if (name === null) {
      // Background unpin: clear PINS only (ephemeral). Dropdown filter
      // (`selectedCrossings` / `selectedTypes`) is sticky — chip `×` or the
      // dropdown UI is needed to clear that.
      setCrossingPin(null)
      setVehiclePin(null)
      return
    }
    // Pin gesture: write to the current-stacked dim's pin (NOT the dropdown
    // filter). Cross-dim pin clears so the new pin is unambiguous.
    if (stackBy === "crossing") {
      const full = ABBREV_TO_CROSSING[name]
      if (full) { setCrossingPin(full); setVehiclePin(null) }
    } else {
      const full = ABBREV_TO_TYPE[name]
      if (full) { setVehiclePin(full); setCrossingPin(null) }
    }
  }, [legendMode, stackBy, setCrossingPin, setVehiclePin])

  const plotProps = useMemo(() => {
    if (isEZPass) {
      if (!ezpassRows) return {}
      const traces = buildEZPassTraces(ezpassRows, activeCrossings)
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
      // Opacity/fading is handled by usePinnedLegend's restyleFade (Plotly.restyle)
      const traces = rawTraces
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

    // Traffic mode — `dataCrossings`/`dataTypes` apply the dropdown filter
    // ONLY for the cross-dim (so e.g. pinning Lincoln + switching to BY
    // VEHICLE shows Lincoln's vehicle breakdown). In same-dim, all items
    // are passed so pltly's `soloMode: 'hide'` can mark non-selected as
    // `visible: 'legendonly'` (others stay clickable in the legend).
    const rawTraces = stackBy === "vehicle"
      ? buildStackedByVehicle(allRows, dataCrossings, dataTypes)
      : buildStackedByCrossing(allRows, dataCrossings, dataTypes)

    // Compute stack max so we can pin y-axis range (prevents autorange shifts
    // when the linked avg line changes to a per-trace value).
    const nPoints = rawTraces.length > 0 ? ((rawTraces[0] as any).y as number[]).length : 0
    let stackMax = 0
    for (let i = 0; i < nPoints; i++) {
      let sum = 0
      for (const t of rawTraces) sum += ((t as any).y as number[])[i] ?? 0
      if (sum > stackMax) stackMax = sum
    }

    const yearNum = activeYear ? parseInt(activeYear) : null
    const traces = rawTraces.map(trace => {
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
  }, [allRows, ezpassRows, mode, stackBy, timeRange, activeCrossings, dataCrossings, dataTypes, isEZPass, isVs2019, activeYear, stackedNameMap, legendMode])

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
        {...plotProps as any}
      />
      <div className="plot-toggles" data-pltly-keep-pin>
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
  // filter (sticky), legend click writes to pin (ephemeral, outside-click
  // clears). Pin also narrows data in the cross-dim view, so pinning Lincoln
  // in BY CROSSING and switching to BY VEHICLE shows Lincoln's vehicle
  // breakdown — original [Image #93] behavior, plus ephemeral clearing.
  const [crossingPin, setCrossingPin] = useUrlState<string | null>("pc", crossingPinParam)
  const [vehiclePin, setVehiclePin] = useUrlState<string | null>("pv", vehiclePinParam)
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

  // Chip-style subtitle node, shared between TrafficPlot and BTMonthlyPlot so
  // both surfaces show the same narrowing UI (was: TrafficPlot had chips,
  // BTMonthlyPlot had a plain-text subtitle + `— Autos` title suffix). The
  // `×` button clears both the dropdown filter (sticky) and the pin
  // (ephemeral) for that dim, returning to "all visible, no narrowing".
  const subtitleNode: React.ReactNode = useMemo(() => {
    const badges: React.ReactNode[] = []
    if (subtitle) {
      badges.push(
        <span key="crossings" className="filter-badge">
          {subtitle}
          <span className="clear-filter" onClick={() => { setCrossingPin(null); setSelectedCrossings([...CROSSINGS]) }}>&times;</span>
        </span>
      )
    }
    if (typeSuffix) {
      badges.push(
        <span key="types" className="filter-badge">
          {typeSuffix}
          <span className="clear-filter" onClick={() => { setVehiclePin(null); setSelectedTypes([...VEHICLE_TYPES]) }}>&times;</span>
        </span>
      )
    }
    if (badges.length === 0) return ""
    return <>{badges}</>
  }, [subtitle, typeSuffix, setSelectedCrossings, setSelectedTypes, setCrossingPin, setVehiclePin])
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
      crossingPin={crossingPin} setCrossingPin={setCrossingPin}
      vehiclePin={vehiclePin} setVehiclePin={setVehiclePin}
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
