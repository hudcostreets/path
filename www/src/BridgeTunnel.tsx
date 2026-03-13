import { ToggleButton, ToggleButtonGroup } from "@mui/material"
import { useDb } from "@rdub/duckdb-wasm/duckdb"
import { useQuery } from "@tanstack/react-query"
import { useCallback, useMemo, useRef } from "react"
import { Data, Layout, Legend } from "plotly.js"
import Plotly from "plotly.js-dist-min"
import { Plot as PltlyPlot, useLegendHover, useSoloTrace } from "pltly/react"
import { INFERNO, getColorAt } from "pltly"
import { useUrlState, codeParam, codesParam } from "use-prms"
import { Plot, H2, Loading, dark, hovertemplate, hovertemplatePct } from "./plot-utils"
import { StationDropdown } from "./StationDropdown"
import type { StationGroup } from "./RidesPlot"

// --- Constants ---

const CROSSINGS = [
  "George Washington Bridge",
  "Lincoln Tunnel",
  "Holland Tunnel",
  "Goethals Bridge",
  "Outerbridge Crossing",
  "Bayonne Bridge",
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

const HUDSON_CROSSINGS = ["George Washington Bridge", "Lincoln Tunnel", "Holland Tunnel"] as const
const SI_CROSSINGS = ["Goethals Bridge", "Outerbridge Crossing", "Bayonne Bridge"] as const

const REGION_GROUPS: StationGroup[] = [
  { label: "Hudson River", color: "#aaa", stations: [...HUDSON_CROSSINGS] },
  { label: "Staten Island", color: "#aaa", stations: [...SI_CROSSINGS] },
]

const VEHICLE_TYPES = ["Automobiles", "Buses", "Trucks"] as const

const VEHICLE_TYPE_COLORS: Record<string, string> = {
  "Automobiles": "#636efa",
  "Buses": "#EF553B",
  "Trucks": "#00cc96",
}

const VEHICLE_TYPE_ABBREV: Record<string, string> = {
  "Automobiles": "Auto",
  "Buses": "Bus",
  "Trucks": "Truck",
}

// --- URL params ---

type Mode = "traffic" | "vs2019" | "ezpass"
type StackBy = "crossing" | "vehicle"
type TimeRange = "all" | "recent"

const modeParam = codeParam<Mode>("traffic", { traffic: "t", vs2019: "v", ezpass: "e" })
const stackByParam = codeParam<StackBy>("crossing", { crossing: "c", vehicle: "v" })
const timeRangeParam = codeParam<TimeRange>("all", { all: "a", recent: "r" })

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
  const path = '/bt-traffic.pqt'
  return path.startsWith('/') ? `${window.location.origin}${path}` : path
}

function ezpassUrl(): string {
  const path = '/bt-ezpass.pqt'
  return path.startsWith('/') ? `${window.location.origin}${path}` : path
}

type TrafficRow = { crossing: string, type: string, year: number, month: string, count: number }

function useAllTrafficData() {
  const dbConn = useDb()
  const url = trafficUrl()
  return useQuery({
    queryKey: ['bt-traffic-all', dbConn === null],
    queryFn: async () => {
      if (!dbConn) return null
      const { conn } = dbConn
      const result = await conn.query(`
        SELECT Crossing as crossing, Type as type, Year as year, Month as month, Count as count
        FROM parquet_scan('${url}')
        WHERE Crossing != 'All Crossings'
          AND Type != 'Total Vehicles'
        ORDER BY Year, CASE Month
          WHEN 'Jan' THEN 1 WHEN 'Feb' THEN 2 WHEN 'Mar' THEN 3 WHEN 'Apr' THEN 4
          WHEN 'May' THEN 5 WHEN 'Jun' THEN 6 WHEN 'Jul' THEN 7 WHEN 'Aug' THEN 8
          WHEN 'Sep' THEN 9 WHEN 'Oct' THEN 10 WHEN 'Nov' THEN 11 WHEN 'Dec' THEN 12
        END
      `)
      const rows: TrafficRow[] = []
      for (let i = 0; i < result.numRows; i++) {
        rows.push({
          crossing: result.getChildAt(0)!.get(i),
          type: result.getChildAt(1)!.get(i),
          year: Number(result.getChildAt(2)!.get(i)),
          month: result.getChildAt(3)!.get(i),
          count: Number(result.getChildAt(4)!.get(i)),
        })
      }
      return rows
    },
    enabled: !!dbConn,
  })
}

type EZPassRow = { crossing: string, year: number, pct: number }

function useEZPassData() {
  const dbConn = useDb()
  const url = ezpassUrl()
  return useQuery({
    queryKey: ['bt-ezpass', dbConn === null],
    queryFn: async () => {
      if (!dbConn) return null
      const { conn } = dbConn
      const result = await conn.query(`
        SELECT Crossing as crossing, Year as year, "E-Z Pass Percent" as pct
        FROM parquet_scan('${url}')
        WHERE Month = 'Annual'
        ORDER BY Year
      `)
      const rows: EZPassRow[] = []
      for (let i = 0; i < result.numRows; i++) {
        rows.push({
          crossing: result.getChildAt(0)!.get(i),
          year: Number(result.getChildAt(1)!.get(i)),
          pct: Number(result.getChildAt(2)!.get(i)),
        })
      }
      return rows
    },
    enabled: !!dbConn,
  })
}

// --- Filtering helper ---

function filterRows(rows: TrafficRow[], crossings: string[], types: string[]): TrafficRow[] {
  return rows.filter(r => crossings.includes(r.crossing) && types.includes(r.type))
}

// --- Trace builders ---

function buildStackedByCrossing(rows: TrafficRow[], crossings: string[], types: string[]): Data[] {
  const filtered = filterRows(rows, crossings, types)
  // Sum across selected vehicle types per crossing per month
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
  // Sum across selected crossings per vehicle type per month
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
    // Per vehicle type vs-2019
    return buildVs2019ByDimension(
      filtered,
      VEHICLE_TYPES.filter(t => types.includes(t)),
      r => r.type,
      VEHICLE_TYPE_ABBREV,
      VEHICLE_TYPE_COLORS,
    )
  }
  // Per crossing vs-2019
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
  // Build baseline: sum across other dimensions per dim per month
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

  // Build per-dim data
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

function TrafficPlot() {
  const [mode, setMode] = useUrlState<Mode>("m", modeParam)
  const [stackBy, setStackBy] = useUrlState<StackBy>("g", stackByParam)
  const [timeRange, setTimeRange] = useUrlState<TimeRange>("t", timeRangeParam)
  const [selectedCrossings, setSelectedCrossings] = useUrlState<string[]>("c", crossingsParam)
  const [selectedTypes, setSelectedTypes] = useUrlState<string[]>("v", vehicleTypesParam)
  const { data: allRows } = useAllTrafficData()
  const { data: ezpassRows } = useEZPassData()

  const isEZPass = mode === "ezpass"
  const isVs2019 = mode === "vs2019"
  const activeCrossings = selectedCrossings.length > 0 ? selectedCrossings : [...CROSSINGS]
  const activeTypes = selectedTypes.length > 0 ? selectedTypes : [...VEHICLE_TYPES]

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
      const traces = buildVs2019Traces(allRows, activeCrossings, activeTypes, stackBy)
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

    // Traffic mode
    const traces = stackBy === "vehicle"
      ? buildStackedByVehicle(allRows, activeCrossings, activeTypes)
      : buildStackedByCrossing(allRows, activeCrossings, activeTypes)

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
        legend: { entrywidth: 80 } as Partial<Legend>,
      } as Partial<Layout>,
    }
  }, [allRows, ezpassRows, mode, stackBy, timeRange, activeCrossings, activeTypes, isEZPass, isVs2019])

  const stackLabel = stackBy === "vehicle" ? "vehicle type" : "crossing"
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
        soloMode="hide"
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
        <StationDropdown
          stations={[...CROSSINGS]}
          colors={CROSSING_COLORS}
          selected={selectedCrossings}
          onChange={setSelectedCrossings}
          regionGroups={REGION_GROUPS}
          label="Crossings"
        />
        {!isEZPass && (
          <StationDropdown
            stations={[...VEHICLE_TYPES]}
            colors={VEHICLE_TYPE_COLORS}
            selected={selectedTypes}
            onChange={setSelectedTypes}
            label="Vehicle Types"
          />
        )}
      </div>
    </div>
  )
}

// --- By-month plot (year traces, INFERNO) ---

function useMonthlyData(types: string[]) {
  const dbConn = useDb()
  const url = trafficUrl()
  const typesKey = types.join(',')
  return useQuery({
    queryKey: ['bt-monthly', typesKey, dbConn === null],
    queryFn: async () => {
      if (!dbConn) return null
      const { conn } = dbConn
      const typeList = types.map(t => `'${t}'`).join(', ')
      const result = await conn.query(`
        SELECT Year as year, Month as month, SUM(Count) as count
        FROM parquet_scan('${url}')
        WHERE Type IN (${typeList})
          AND Crossing != 'All Crossings'
        GROUP BY Year, Month
        ORDER BY Year, CASE Month
          WHEN 'Jan' THEN 1 WHEN 'Feb' THEN 2 WHEN 'Mar' THEN 3 WHEN 'Apr' THEN 4
          WHEN 'May' THEN 5 WHEN 'Jun' THEN 6 WHEN 'Jul' THEN 7 WHEN 'Aug' THEN 8
          WHEN 'Sep' THEN 9 WHEN 'Oct' THEN 10 WHEN 'Nov' THEN 11 WHEN 'Dec' THEN 12
        END
      `)
      const yearData = new Map<number, { months: string[], counts: number[] }>()
      for (let i = 0; i < result.numRows; i++) {
        const year = Number(result.getChildAt(0)!.get(i))
        const month = result.getChildAt(1)!.get(i) as string
        const count = Number(result.getChildAt(2)!.get(i))
        let entry = yearData.get(year)
        if (!entry) {
          entry = { months: [], counts: [] }
          yearData.set(year, entry)
        }
        entry.months.push(month)
        entry.counts.push(count)
      }
      const years = [...yearData.keys()].sort()
      const minYear = years[0]
      const maxYear = years[years.length - 1]
      const range = maxYear - minYear || 1
      const data: Data[] = years.map(year => {
        const { months, counts } = yearData.get(year)!
        const t = 0.15 + 0.85 * (year - minYear) / range
        return {
          name: String(year),
          x: months,
          y: counts,
          type: "bar",
          marker: { color: getColorAt(INFERNO, t) },
          hovertemplate,
        } as Data
      })
      return data
    },
    enabled: !!dbConn,
  })
}

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
        textfont: { color: '#e4e4e4', size: 11 },
        textangle: 0,
        constraintext: 'none',
        cliponaxis: false,
      } as Data
    }
    return { ...trace, opacity: 0.3, zorder: 1 } as Data
  })
}

const monthlyHeight = 450

function BTMonthlyPlot() {
  const [selectedTypes, setSelectedTypes] = useUrlState<string[]>("bv", vehicleTypesParam)
  const activeTypes = selectedTypes.length > 0 ? selectedTypes : [...VEHICLE_TYPES]
  const { data: traces } = useMonthlyData(activeTypes)

  const traceNames = useMemo(
    () => traces?.map(d => d.name).filter((n): n is string => !!n) ?? [],
    [traces],
  )
  const containerRef = useRef<HTMLDivElement>(null)
  const { hoverTrace, handlers: legendHandlers } = useLegendHover(containerRef, traceNames)
  const { soloTrace, onLegendClick, onLegendDoubleClick } = useSoloTrace(traceNames, hoverTrace)
  const attachLegend = useCallback(() => legendHandlers.onUpdate(), [legendHandlers])

  const highlightTarget = soloTrace ?? hoverTrace
  const styledData = useMemo(
    () => traces ? highlightTraces(traces, highlightTarget) : null,
    [traces, highlightTarget],
  )

  const narrow = typeof window !== 'undefined' && window.innerWidth < 600
  const margin = { l: narrow ? 30 : 40, r: 0, t: 0, b: narrow ? 50 : 40 }
  const legendBase: Partial<Legend> = narrow
    ? { orientation: "h", x: 0.5, xanchor: "center", y: -0.08, yanchor: "top" }
    : {}

  if (!styledData) {
    return <div className="plot-container">
      <H2 id="bt-monthly">Monthly traffic, by month</H2>
      <Loading />
    </div>
  }

  return (
    <div className="plot-container">
      <H2 id="bt-monthly">Monthly traffic, by month</H2>
      <div ref={containerRef}>
        <PltlyPlot
          plotly={Plotly}
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
      <div className="plot-toggles">
        <StationDropdown
          stations={[...VEHICLE_TYPES]}
          colors={VEHICLE_TYPE_COLORS}
          selected={selectedTypes}
          onChange={setSelectedTypes}
          label="Vehicle Types"
        />
      </div>
    </div>
  )
}

// --- Page ---

export default function BridgeTunnel() {
  return <>
    <h1>PANYNJ Bridge &amp; Tunnel Traffic</h1>
    <p style={{ color: "#888", marginTop: "-0.5em" }}>
      Eastbound (tolled direction) vehicle counts, 2011–2025.{" "}
      <a href="/">← PATH ridership</a>
    </p>
    <TrafficPlot />
    <BTMonthlyPlot />
    <div className="abp-footer">
      <p>
        Data from <a href="https://www.panynj.gov/bridges-tunnels/en/traffic---volume-information---background.html">PANYNJ</a> ·
        Code <a href="https://github.com/hudcostreets/path">on GitHub</a>
      </p>
    </div>
  </>
}
