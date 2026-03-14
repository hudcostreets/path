import { ToggleButton, ToggleButtonGroup } from "@mui/material"
import { Arr } from "@rdub/base/arr"
import { useDb } from "@rdub/duckdb-wasm/duckdb"
import { useQuery } from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useRef } from "react"
import { Data, Legend } from "plotly.js"
import Plotly from "plotly.js-dist-min"
import { Plot as PltlyPlot, useLegendHover, useSoloTrace } from "pltly/react"
import { INFERNO, getColorAt } from "pltly"
import { useUrlState, codeParam } from "use-prms"
import { H2, Loading, dark, hovertemplate, url } from "./plot-utils"

type DayType = "weekday" | "weekend"

const dayTypeParam = codeParam<DayType>("weekday", { weekday: "w", weekend: "e" })
const height = 450

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

type MonthlyRow = {
  station: string
  year: number
  cal_month: number
  avg_weekday: number
  avg_weekend: number
}

function highlightTraces(data: Data[], activeTrace: string | null): Data[] {
  if (!activeTrace) return data
  return data.map(trace => {
    const isActive = trace.name === activeTrace
    if (isActive) {
      const y: number[] = Array.isArray((trace as any).y) ? (trace as any).y : []
      return {
        ...trace,
        width: 0.25,
        zorder: 100,
        text: y.map(v => v > 0 ? `<b>${Math.round(v / 1000)}k</b>` : ''),
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

export default function MonthlyPlots({ stations, subtitle, onActiveYearChange }: {
  stations: string[]
  subtitle: string
  onActiveYearChange?: (year: string | null) => void
}) {
  const [dayType, setDayType] = useUrlState<DayType>("d", dayTypeParam)
  const dbConn = useDb()

  const { data: allRows } = useQuery({
    queryKey: ['monthly-by-station', url, dbConn === null],
    refetchOnWindowFocus: false,
    refetchInterval: false,
    queryFn: async () => {
      if (!dbConn) return null
      const { conn } = dbConn
      const query = `
        SELECT
          station,
          CAST(SUBSTR(month, 1, 4) AS INTEGER) as year,
          CAST(SUBSTR(month, 6, 2) AS INTEGER) as cal_month,
          "avg weekday" as avg_weekday,
          "avg weekend" as avg_weekend
        FROM parquet_scan('${url}')
        ORDER BY year, cal_month, station
      `
      const table = await conn.query(query)
      const n = table.numRows
      const stationCol: string[] = Arr(table.getChild("station")!.toArray()) as any
      const yearCol = Arr(table.getChild("year")!.toArray())
      const calMonthCol = Arr(table.getChild("cal_month")!.toArray())
      const weekdayCol = Arr(table.getChild("avg_weekday")!.toArray())
      const weekendCol = Arr(table.getChild("avg_weekend")!.toArray())
      const rows: MonthlyRow[] = []
      for (let i = 0; i < n; i++) {
        rows.push({
          station: stationCol[i],
          year: Number(yearCol[i]),
          cal_month: Number(calMonthCol[i]),
          avg_weekday: weekdayCol[i] as number,
          avg_weekend: weekendCol[i] as number,
        })
      }
      conn.close()
      return rows
    },
  })

  const col = dayType === "weekday" ? "avg_weekday" as const : "avg_weekend" as const

  const plotData = useMemo(() => {
    if (!allRows) return null
    const allStations = [...new Set(allRows.map(r => r.station))]
    const activeStations = stations.length > 0 ? stations : allStations
    const filtered = allRows.filter(r => activeStations.includes(r.station))

    // Group by (year, cal_month) → sum
    const sums = new Map<string, number>()
    for (const r of filtered) {
      const key = `${r.year}-${r.cal_month}`
      sums.set(key, (sums.get(key) ?? 0) + r[col])
    }

    const years = [...new Set(filtered.map(r => r.year))].sort()
    const minYear = Math.min(...years)
    const maxYear = Math.max(...years)
    const range = maxYear - minYear || 1

    const data: Data[] = years.map(year => {
      const ys = Array.from({ length: 12 }, (_, i) => sums.get(`${year}-${i + 1}`) ?? 0)
      if (ys.every(v => v === 0)) return null
      const t = 0.15 + 0.85 * (year - minYear) / range
      const color = getColorAt(INFERNO, t)
      return {
        name: String(year),
        type: "bar",
        x: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        y: ys,
        marker: { color },
        hovertemplate,
      } as Data
    }).filter((d): d is Data => d !== null)

    return data
  }, [allRows, stations, col])

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

  const titleText = `Average ${dayType} rides, by month`

  if (!styledData) {
    return <div className="plot-container">
      <H2 id="monthly">{titleText}</H2>
      {subtitle && <div className="plot-subtitle">{subtitle}</div>}
      <Loading />
    </div>
  }

  return (
    <div className="plot-container">
      <H2 id="monthly">{titleText}</H2>
      {subtitle && <div className="plot-subtitle">{subtitle}</div>}
      <div ref={containerRef}>
      <PltlyPlot
        plotly={Plotly}
        data={styledData}
        disableLegendHover
        onLegendClick={onLegendClick as () => boolean}
        onLegendDoubleClick={onLegendDoubleClick as () => boolean}
        onAfterPlot={attachLegend}
        style={{ width: '100%', height: `${height}px` }}
        layout={{
          autosize: true,
          margin,
          hovermode: "x unified",
          hoverlabel: dark ? { bgcolor: "#2a2a3e", font: { color: "#e4e4e4" } } : undefined,
          barmode: "group",
          xaxis: {
            fixedrange: true,
            tickmode: "array" as const,
            tickvals: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
            ticktext: MONTH_LABELS,
          },
          yaxis: { fixedrange: true },
          legend: { ...legendBase, entrywidth: 60 } as Partial<Legend>,
        }}
      />
      </div>
      <div className="plot-toggles">
        <ToggleButtonGroup
          value={dayType}
          exclusive
          size="small"
          onChange={(_, v) => { if (v) setDayType(v) }}
        >
          <ToggleButton value="weekday">Weekday</ToggleButton>
          <ToggleButton value="weekend">Weekend</ToggleButton>
        </ToggleButtonGroup>
      </div>
    </div>
  )
}
