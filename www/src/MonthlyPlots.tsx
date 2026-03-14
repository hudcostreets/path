import { Arr } from "@rdub/base/arr"
import { useDb } from "@rdub/duckdb-wasm/duckdb"
import { useQuery } from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useRef } from "react"
import { Data, Legend } from "plotly.js"
import Plotly from "plotly.js-dist-min"
import { Plot as PltlyPlot, useLegendHover, useSoloTrace } from "pltly/react"
import { INFERNO, getColorAt } from "pltly"
import { H2, Loading, dark, hovertemplate, url } from "./plot-utils"

const height = 450

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

type MonthlyRow = {
  station: string
  year: number
  cal_month: number
  avg_weekday: number
  avg_weekend: number
  avg_holiday: number
  total_weekday: number
  total_weekend: number
  total_holiday: number
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

export default function MonthlyPlots({ stations, dayTypes, metric = "avg", subtitle, onActiveYearChange }: {
  stations: string[]
  dayTypes: string[]
  metric?: "avg" | "total"
  subtitle: string
  onActiveYearChange?: (year: string | null) => void
}) {
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
          "avg weekend" as avg_weekend,
          "avg holiday" as avg_holiday,
          "total weekday" as total_weekday,
          "total weekend" as total_weekend,
          "total holiday" as total_holiday
        FROM parquet_scan('${url}')
        ORDER BY year, cal_month, station
      `
      const table = await conn.query(query)
      const n = table.numRows
      const stationCol: string[] = Arr(table.getChild("station")!.toArray()) as any
      const yearCol = Arr(table.getChild("year")!.toArray())
      const calMonthCol = Arr(table.getChild("cal_month")!.toArray())
      const avgWeekdayCol = Arr(table.getChild("avg_weekday")!.toArray())
      const avgWeekendCol = Arr(table.getChild("avg_weekend")!.toArray())
      const avgHolidayCol = Arr(table.getChild("avg_holiday")!.toArray())
      const totalWeekdayCol = Arr(table.getChild("total_weekday")!.toArray())
      const totalWeekendCol = Arr(table.getChild("total_weekend")!.toArray())
      const totalHolidayCol = Arr(table.getChild("total_holiday")!.toArray())
      const rows: MonthlyRow[] = []
      for (let i = 0; i < n; i++) {
        rows.push({
          station: stationCol[i],
          year: Number(yearCol[i]),
          cal_month: Number(calMonthCol[i]),
          avg_weekday: (avgWeekdayCol[i] as number) || 0,
          avg_weekend: (avgWeekendCol[i] as number) || 0,
          avg_holiday: (avgHolidayCol[i] as number) || 0,
          total_weekday: (totalWeekdayCol[i] as number) || 0,
          total_weekend: (totalWeekendCol[i] as number) || 0,
          total_holiday: (totalHolidayCol[i] as number) || 0,
        })
      }
      conn.close()
      return rows
    },
  })

  const plotData = useMemo(() => {
    if (!allRows) return null
    const allStations = [...new Set(allRows.map(r => r.station))]
    const activeStations = stations.length > 0 ? stations : allStations
    const filtered = allRows.filter(r => activeStations.includes(r.station))

    // Sum across selected day types for each (year, cal_month)
    const sums = new Map<string, number>()
    for (const r of filtered) {
      const key = `${r.year}-${r.cal_month}`
      let val = 0
      for (const dt of dayTypes) {
        val += r[`${metric}_${dt}` as keyof MonthlyRow] as number
      }
      sums.set(key, (sums.get(key) ?? 0) + val)
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
  }, [allRows, stations, dayTypes, metric])

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

  const DAY_TYPE_NAMES: Record<string, string> = { weekday: "Weekday", weekend: "Weekend", holiday: "Holiday" }
  const allDayTypes = dayTypes.length >= 3
  const excluded = ["weekday", "weekend", "holiday"].filter(dt => !dayTypes.includes(dt))
  const included = dayTypes.map(dt => DAY_TYPE_NAMES[dt] ?? dt).join(" + ")
  const dayTypeSubtitle = allDayTypes
    ? ""
    : excluded.length === 1
      ? `${included} (excl. ${(DAY_TYPE_NAMES[excluded[0]] ?? excluded[0]).toLowerCase()})`
      : included
  const titleText = metric === "avg" ? "Avg daily rides by month" : "Rides by month"

  const fullSubtitle = [subtitle, dayTypeSubtitle].filter(Boolean).join(" · ")

  if (!styledData) {
    return <div className="plot-container">
      <H2 id="monthly">{titleText}</H2>
      {fullSubtitle && <div className="plot-subtitle">{fullSubtitle}</div>}
      <Loading />
    </div>
  }

  return (
    <div className="plot-container">
      <H2 id="monthly">{titleText}</H2>
      {fullSubtitle && <div className="plot-subtitle">{fullSubtitle}</div>}
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
    </div>
  )
}
