import React from "react"
import { ToggleButton, ToggleButtonGroup } from "@mui/material"
import { useQuery } from "@tanstack/react-query"
import { asyncBufferFromUrl, parquetRead } from "hyparquet"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { usePinnedLegend } from "pltly/react"
import { Data, Layout, Legend } from "plotly.js"
import { Plot as PltlyPlot, useLegendHover, useSoloTrace } from "pltly/react"
import { INFERNO, getColorAt } from "pltly"
import { useUrlState, codeParam, codesParam } from "use-prms"
import { resolve as dvcResolve } from 'virtual:dvc-data'
import { Plot, H2, Loading, blendAvgColor, dark, hovertemplate, hovertemplatePct, rollingAvg } from "./plot-utils"
import { StationDropdown } from "./StationDropdown"
import { InfoTip } from "./Tooltip"
import type { StationGroup } from "./RidesPlot"

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

function buildVs2019Traces(rows: TrafficRow[], crossings: string[], types: string[], stackBy: StackBy): Data[] {
  const filtered = filterRows(rows, crossings, types)

  if (stackBy === "vehicle") {
    return buildVs2019ByDimension(
      filtered,
      VEHICLE_TYPES.filter(t => types.includes(t)),
      r => r.type,
      VEHICLE_TYPE_ABBREV,
      VEHICLE_TYPE_COLORS,
    )
  }
  return buildVs2019ByDimension(
    filtered,
    CROSSINGS.filter(c => crossings.includes(c)),
    r => r.crossing,
    CROSSING_ABBREV,
    CROSSING_COLORS,
  )
}

function buildVs2019ByDimension(
  rows: TrafficRow[],
  dimensions: readonly string[],
  getDim: (r: TrafficRow) => string,
  abbrev: Record<string, string>,
  colors: Record<string, string>,
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
    x: [new Date(2020, 0, 1), new Date(2025, 11, 1)],
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
  subtitle,
  typeSuffix,
  onEffectiveChange,
}: {
  allRows: TrafficRow[] | null | undefined
  selectedCrossings: string[], setSelectedCrossings: (v: string[]) => void
  selectedTypes: string[], setSelectedTypes: (v: string[]) => void
  activeYear: string | null
  subtitle: string
  typeSuffix: string
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
  const stackedItems = useMemo(
    () => (stackBy === "crossing" ? [...CROSSINGS] : [...VEHICLE_TYPES]) as string[],
    [stackBy],
  )
  const stackedNameMap = useMemo(
    () => stackBy === "crossing" ? CROSSING_ABBREV : VEHICLE_TYPE_ABBREV,
    [stackBy],
  )
  const stackedSelected = stackBy === "crossing" ? selectedCrossings : selectedTypes
  const setStackedSelected = stackBy === "crossing" ? setSelectedCrossings : setSelectedTypes

  const legend = usePinnedLegend({
    allItems: stackedItems,
    selectedItems: stackedSelected,
    setSelectedItems: setStackedSelected,
    nameMap: stackedNameMap,
    soloMode: legendMode === "solo" ? "hide" : "fade",
  })

  // Effective selections: use legend.effectiveItems for the stacked dimension
  const activeCrossings = selectedCrossings.length > 0 ? selectedCrossings : [...CROSSINGS]
  const activeTypes = selectedTypes.length > 0 ? selectedTypes : [...VEHICLE_TYPES]

  const effectiveCrossings = useMemo(() => {
    return stackBy === "crossing" ? legend.effectiveItems : activeCrossings
  }, [stackBy, legend.effectiveItems, activeCrossings])

  const effectiveTypes = useMemo(() => {
    return stackBy === "vehicle" ? legend.effectiveItems : activeTypes
  }, [stackBy, legend.effectiveItems, activeTypes])

  useEffect(() => {
    onEffectiveChange?.({ crossings: effectiveCrossings, types: effectiveTypes })
  }, [effectiveCrossings, effectiveTypes, onEffectiveChange])

  // Subtitle with filter badges
  const subtitleNode: React.ReactNode = useMemo(() => {
    const badges: React.ReactNode[] = []
    if (subtitle) {
      badges.push(
        <span key="crossings" className="filter-badge">
          {subtitle}
          <span className="clear-filter" onClick={() => {
            if (stackBy === "crossing") {
              legend.clearPin()
            } else {
              setSelectedCrossings([...CROSSINGS])
            }
          }}>&times;</span>
        </span>
      )
    }
    if (typeSuffix) {
      badges.push(
        <span key="types" className="filter-badge">
          {typeSuffix}
          <span className="clear-filter" onClick={() => {
            if (stackBy === "vehicle") {
              legend.clearPin()
            } else {
              setSelectedTypes([...VEHICLE_TYPES])
            }
          }}>&times;</span>
        </span>
      )
    }
    if (badges.length === 0) return ""
    return <>{badges}</>
  }, [subtitle, typeSuffix, stackBy, legend.clearPin, setSelectedCrossings, setSelectedTypes])

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
    const allTimeRange = ['2011-01-01', '2026-01-01']
    const recentRange = ['2019-12-01', '2026-01-01']

    if (isVs2019) {
      const rawTraces = buildVs2019Traces(allRows, [...CROSSINGS], [...VEHICLE_TYPES], stackBy)
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

    // Traffic mode — build ALL traces for stacked dimension, solo or fade non-selected
    const rawTraces = stackBy === "vehicle"
      ? buildStackedByVehicle(allRows, [...CROSSINGS], [...VEHICLE_TYPES])
      : buildStackedByCrossing(allRows, [...CROSSINGS], [...VEHICLE_TYPES])

    const yearNum = activeYear && !legend.activeItem ? parseInt(activeYear) : null
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
        yaxis: { fixedrange: true },
        xaxis: {
          fixedrange: true,
          range: isRecent ? recentRange : allTimeRange,
          dtick: isRecent ? "M3" : "M12",
          tickformat: isRecent ? "%b '%y" : "'%y",
          hoverformat: "%b '%y",
          tickangle: -45,
        },
        legend: { entrywidth: 80, traceorder: "reversed" } as Partial<Legend>,
      } as Partial<Layout>,
    }
  }, [allRows, ezpassRows, mode, stackBy, timeRange, activeCrossings, activeTypes, isEZPass, isVs2019, activeYear, stackedNameMap, legendMode])

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
      : (dark ? "rgba(255,255,255,0.7)" : "rgba(0,0,0,0.7)")
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
  const baseTitle = isEZPass
    ? "E-ZPass adoption by crossing"
    : isVs2019
      ? `% of 2019, by ${stackLabel}`
      : `Monthly traffic by ${stackLabel}`
  const title = typeSuffix ? `${baseTitle} — ${typeSuffix}` : baseTitle

  return (
    <div className="plot-container" ref={legend.containerRef} onClick={legend.onContainerClick}>
      <Plot
        id="bt-traffic"
        title={title}
        subtitle={subtitleNode}
        {...((isTraffic || isVs2019) ? {
          disableLegendHover: true,
          disableSoloTrace: true,
          onLegendClick: legend.onLegendClick,
          onLegendDoubleClick: legend.onLegendDoubleClick,
          onAfterPlot: legend.onAfterPlot,
          traceNames: legend.traceNames,
        } : {
          soloMode: "hide" as const,
        })}
        linkedTraces={buildLinkedTraces}
        {...plotProps}
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
          selected={effectiveCrossings}
          onChange={stackBy === "crossing" ? legend.onPickerChange : setSelectedCrossings}
          regionGroups={REGION_GROUPS}
          label="Crossings"
        />
        {!isEZPass && (
          <StationDropdown
            stations={[...VEHICLE_TYPES]}
            colors={VEHICLE_TYPE_COLORS}
            selected={effectiveTypes}
            onChange={stackBy === "vehicle" ? legend.onPickerChange : setSelectedTypes}
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
        textfont: { color: dark ? '#e4e4e4' : '#333', size: 11 },
        textangle: 0,
        constraintext: 'none',
        cliponaxis: false,
      } as Data
    }
    return { ...trace, opacity: 0.3, zorder: 1 } as Data
  })
}

const monthlyHeight = 450

function BTMonthlyPlot({
  allRows,
  crossings,
  types,
  subtitle,
  typeSuffix,
  onActiveYearChange,
}: {
  allRows: TrafficRow[] | null | undefined
  crossings: string[]
  types: string[]
  subtitle: string
  typeSuffix: string
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

  const traceNames = useMemo(
    () => plotData?.map(d => d.name).filter((n): n is string => !!n) ?? [],
    [plotData],
  )
  const containerRef = useRef<HTMLDivElement>(null)
  const { hoverTrace, handlers: legendHandlers } = useLegendHover(containerRef, traceNames)
  const { soloTrace, onLegendClick, onLegendDoubleClick } = useSoloTrace(traceNames, hoverTrace)
  const attachLegend = useCallback(() => legendHandlers.onUpdate(), [legendHandlers])

  const highlightTarget = soloTrace ?? hoverTrace

  useEffect(() => {
    onActiveYearChange?.(highlightTarget)
  }, [highlightTarget, onActiveYearChange])

  const styledData = useMemo(
    () => plotData ? highlightTraces(plotData, highlightTarget) : null,
    [plotData, highlightTarget],
  )

  const narrow = typeof window !== 'undefined' && window.innerWidth < 600
  const margin = { l: narrow ? 30 : 40, r: 0, t: 0, b: narrow ? 50 : 40 }
  const legendBase: Partial<Legend> = narrow
    ? { orientation: "h", x: 0.5, xanchor: "center", y: -0.08, yanchor: "top" }
    : {}

  if (!styledData) {
    return <div className="plot-container">
      <H2 id="bt-monthly">{typeSuffix ? `Monthly traffic, by month — ${typeSuffix}` : "Monthly traffic, by month"}</H2>
      {subtitle && <div className="plot-subtitle">{subtitle}</div>}
      <Loading />
    </div>
  }

  return (
    <div className="plot-container">
      <H2 id="bt-monthly">{typeSuffix ? `Monthly traffic, by month — ${typeSuffix}` : "Monthly traffic, by month"}</H2>
      {subtitle && <div className="plot-subtitle">{subtitle}</div>}
      <div ref={containerRef}>
        <PltlyPlot
          
          data={styledData}
          disableLegendHover
          onLegendClick={onLegendClick as () => boolean}
          onLegendDoubleClick={onLegendDoubleClick as () => boolean}
          onAfterPlot={attachLegend}
          style={{ width: '100%', height: `${monthlyHeight}px` }}
          layout={{
            autosize: true,
            margin,
            hovermode: "x unified",
            hoverlabel: dark ? { bgcolor: "#2a2a3e", font: { color: "#e4e4e4" } } : undefined,
            barmode: "group",
            xaxis: { fixedrange: true },
            yaxis: { fixedrange: true },
            legend: { ...legendBase, title: undefined, entrywidth: 60 } as Partial<Legend>,
          }}
        />
      </div>
    </div>
  )
}

// --- Page ---

export default function BridgeTunnel() {
  const [urlCrossings, setUrlCrossings] = useUrlState<string[]>("c", crossingsParam)
  const [urlTypes, setUrlTypes] = useUrlState<string[]>("v", vehicleTypesParam)
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

  return <>
    <h1>PANYNJ Bridge &amp; Tunnel Traffic</h1>
    <p style={{ color: "#888", marginTop: "-0.5em" }}>
      Eastbound (tolled direction) vehicle counts, 2011–2025.{" "}
      <a href="/">← PATH ridership</a>
    </p>
    <TrafficPlot
      allRows={allRows}
      selectedCrossings={selectedCrossings} setSelectedCrossings={setSelectedCrossings}
      selectedTypes={selectedTypes} setSelectedTypes={setSelectedTypes}
      activeYear={activeYear}
      subtitle={subtitle}
      typeSuffix={typeSuffix}
      onEffectiveChange={setEffective}
    />
    <BTMonthlyPlot
      allRows={allRows}
      crossings={effective.crossings}
      types={effective.types}
      subtitle={subtitle}
      typeSuffix={typeSuffix}
      onActiveYearChange={setActiveYear}
    />
    <div className="abp-footer">
      <p>
        Data from <a href="https://www.panynj.gov/bridges-tunnels/en/traffic---volume-information---background.html">PANYNJ</a> ·
        Code <a href="https://github.com/hudcostreets/path">on GitHub</a>
      </p>
    </div>
  </>
}
