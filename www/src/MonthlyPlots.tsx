import { useQuery } from "@tanstack/react-query"
import { asyncBufferFromUrl, parquetRead } from "hyparquet"
import { useEffect, useMemo, useState } from "react"
import { Data, Legend } from "plotly.js"
import { INFERNO, getColorAt } from "pltly"
import { Plot, dark, hovertemplate, url } from "./plot-utils"

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
  const { data: allRows } = useQuery({
    queryKey: ['monthly-by-station', url],
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
      return raw.map(r => {
        const month = r['month'] as string
        return {
          station: r['station'] as string,
          year: parseInt(month.substring(0, 4)),
          cal_month: parseInt(month.substring(5, 7)),
          avg_weekday: (r['avg weekday'] as number) || 0,
          avg_weekend: (r['avg weekend'] as number) || 0,
          avg_holiday: (r['avg holiday'] as number) || 0,
          total_weekday: (r['total weekday'] as number) || 0,
          total_weekend: (r['total weekend'] as number) || 0,
          total_holiday: (r['total holiday'] as number) || 0,
        }
      })
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

  const [activeYear, setActiveYear] = useState<string | null>(null)

  useEffect(() => {
    onActiveYearChange?.(activeYear)
  }, [activeYear, onActiveYearChange])

  const styledData = useMemo(
    () => plotData ? highlightTraces(plotData, activeYear) : null,
    [plotData, activeYear],
  )

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

  return (
    <div className="plot-container">
      <Plot
        id="monthly"
        title={titleText}
        subtitle={fullSubtitle}
        data={styledData ?? undefined}
        disableLegendHover
        disableSoloTrace
        onActiveTraceChange={setActiveYear}
        layout={{
          barmode: "group",
          xaxis: {
            tickmode: "array" as const,
            tickvals: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
            ticktext: MONTH_LABELS,
          },
          legend: { entrywidth: 60 } as Partial<Legend>,
        }}
      />
    </div>
  )
}
